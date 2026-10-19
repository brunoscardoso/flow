// Blueprint parsing/folding — pure helpers of the observer (no fs, no
// Electron). The folding must mirror the CLI store's readAnnotations:
// last status event per fingerprint wins.

import { createHash } from 'crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync, cpSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  clearBlueprintFileCache,
  enrichCrossLinks,
  BlueprintObserver,
  BLUEPRINT_CHANGED_EVENT,
  GRAPHIFY_LANDED_EVENT,
  INVESTIGATIONS_CAP,
  WATCHED_FILES,
  annotationFingerprint,
  buildInvestigations,
  foldActiveInvestigations,
  foldAnnotationStream,
  foldProposalStream,
  investigationFingerprint,
  parseDriftReport,
  parseGraphContent,
  parseStoryContent,
  parseTierSummary,
  parseTierFiles,
  readCorpusIndexFile,
  type DriftObserverDeps,
} from './blueprint-observer'

// ── CLI ↔ app investigation fold parity ─────────────────────────────────────
//
// SYNC NOTE: this fixture and its expected ACTIVE fingerprints are DUPLICATED
// in src/cli/blueprint/investigation-store.test.ts ("app fold parity fixture")
// — the CLI side asserts readInvestigations yields the SAME active notes from
// the SAME lines. The CLI store is the fold AUTHORITY; the app mirror is
// minimal (plain supersede drop, no cycle rescue / heat). Cycle-free by
// design so both folds must agree. When either side changes, update both.
export const INVESTIGATION_PARITY_LINES = [
  '{"kind":"note","ts":"2026-07-15T00:00:00.000Z","runId":"r","anchors":[{"kind":"file","ref":"src/a.ts"}],"text":"note A","provenance":"observe-cli","status":"observed","hashStamps":[]}',
  '{"kind":"note","ts":"2026-07-15T01:00:00.000Z","runId":"r","anchors":[{"kind":"file","ref":"src/b.ts"}],"text":"note B","provenance":"observe-cli","status":"observed","hashStamps":[]}',
  '{"kind":"note","ts":"2026-07-15T02:00:00.000Z","runId":"r","anchors":[{"kind":"file","ref":"src/c.ts"}],"text":"note C","provenance":"observe-cli","status":"observed","hashStamps":[],"supersedes":"note A+[\\"src/a.ts\\"]"}',
  'not json — skipped by both folds',
  '{"kind":"heat","ts":"2026-07-15T02:30:00.000Z","anchorRef":"src/a.ts","visitor":"agent"}',
  '{"kind":"note","ts":"2026-07-15T03:00:00.000Z","runId":"r","anchors":[{"kind":"module","ref":"mod/x"}],"text":"note D","provenance":"observe-cli","status":"observed","hashStamps":[]}',
] as const

// Active fingerprints after the fold (A superseded by C), sorted ts asc.
export const INVESTIGATION_PARITY_ACTIVE_FINGERPRINTS = [
  'note B+["src/b.ts"]',
  'note C+["src/c.ts"]',
  'note D+["mod/x"]',
]

describe('read() graph-location resilience (#69)', () => {
  let dir: string
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }
  const graphJson = JSON.stringify({ nodes: [{ id: 'a' }], edges: [] })
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('reads the graph from the new flow/brain/.structure location', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(join(dir, 'flow/brain/.structure/graph.json'), graphJson)
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.graph?.nodes).toHaveLength(1)
  })

  it('falls back to legacy flow/.blueprint when a stale CLI wrote there', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/.blueprint'), { recursive: true })
    writeFileSync(join(dir, 'flow/.blueprint/graph.json'), graphJson)
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.graph?.nodes).toHaveLength(1) // found despite the new dir being absent
  })

  it('prefers the new location when both exist', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    mkdirSync(join(dir, 'flow/.blueprint'), { recursive: true })
    writeFileSync(join(dir, 'flow/brain/.structure/graph.json'), JSON.stringify({ nodes: [{ id: 'new' }], edges: [] }))
    writeFileSync(join(dir, 'flow/.blueprint/graph.json'), JSON.stringify({ nodes: [{ id: 'old' }, { id: 'old2' }], edges: [] }))
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.graph?.nodes).toEqual([{ id: 'new' }])
  })

  it('returns an empty graph when neither location has one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.graph).toBeNull()
  })
})

// #535: when graphify's background build lands graph.json, the observer fires
// GRAPHIFY_LANDED so the channel layer can re-derive. Real chokidar over a temp
// dir — the behavior under test IS the file watch, so it isn't mocked away.
describe('graphify build landing (#535)', () => {
  let dir: string
  let observer: BlueprintObserver | null = null
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }

  afterEach(async () => {
    await observer?.dispose()
    observer = null
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('emits GRAPHIFY_LANDED when graphify-out/graph.json first appears', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-gfy-'))
    // Pre-create the watched dir so chokidar is watching an existing target; the
    // graph file is added AFTER the watcher initializes so it fires `add`.
    mkdirSync(join(dir, 'graphify-out'), { recursive: true })
    observer = new BlueprintObserver(roots)
    observer.start()

    const landed = new Promise<{ rootId: string }>((resolve) => {
      observer?.once(GRAPHIFY_LANDED_EVENT, resolve)
    })
    // Give chokidar a beat to initialize before writing (ignoreInitial: true).
    await new Promise((r) => setTimeout(r, 500))
    writeFileSync(join(dir, 'graphify-out', 'graph.json'), JSON.stringify({ nodes: [], edges: [] }))

    const event = await landed
    expect(event.rootId).toBe(dir)
  }, 10_000)
})

describe('a flow/ replaced by a link under a running watcher (Workspace migration)', () => {
  let dir: string
  let home: string
  let observer: BlueprintObserver | null = null
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }

  afterEach(async () => {
    await observer?.dispose()
    observer = null
    for (const path of [dir, home]) if (path) rmSync(path, { recursive: true, force: true })
  })

  /** Collect change events for `ms`. */
  async function eventsWithin(ms: number, act: () => void): Promise<number> {
    let count = 0
    const onChanged = (): void => {
      count += 1
    }
    observer?.on(BLUEPRINT_CHANGED_EVENT, onChanged)
    act()
    await new Promise((r) => setTimeout(r, ms))
    observer?.off(BLUEPRINT_CHANGED_EVENT, onChanged)
    return count
  }

  it('hears structure writes behind the new link once re-aimed', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-link-'))
    home = mkdtempSync(join(tmpdir(), 'bp-obs-ws-'))
    mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
    observer = new BlueprintObserver(roots)
    observer.start()
    await new Promise((r) => setTimeout(r, 500))

    // The migration: copy the knowledge into the Workspace, keep the original
    // as the backup, and put a link where `flow/` was.
    const workspaceCopy = join(home, 'projects', 'p')
    mkdirSync(join(home, 'projects'), { recursive: true })
    cpSync(join(dir, 'flow'), workspaceCopy, { recursive: true })
    renameSync(join(dir, 'flow'), join(dir, 'flow.pre-workspace-20261009'))
    symlinkSync(workspaceCopy, join(dir, 'flow'))

    observer.rewatchMovedRoots()
    await new Promise((r) => setTimeout(r, 800)) // the re-aim announces itself; let it pass
    const heard = await eventsWithin(1_500, () =>
      writeFileSync(join(dir, 'flow', 'brain', '.structure', 'learning-state.jsonl'), '{"module":"src","status":"learned"}\n'),
    )
    expect(heard).toBeGreaterThan(0)
  }, 15_000)

  it('aims through the link even at a directory that does not exist yet', async () => {
    // A fresh Workspace project: `flow/` is a link, and nothing has derived
    // into it, so `brain/.structure` is not there. The watcher must still be
    // handed the PHYSICAL path — the through-the-link form is the one FSEvents
    // never reports, so the first derive would go unheard.
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-fresh-'))
    home = mkdtempSync(join(tmpdir(), 'bp-obs-ws-'))
    const workspaceCopy = join(home, 'projects', 'p')
    mkdirSync(workspaceCopy, { recursive: true })
    symlinkSync(workspaceCopy, join(dir, 'flow'))
    observer = new BlueprintObserver(roots)
    observer.start()

    const watched = observer.watchedDirsOf(dir) ?? []
    const physical = join(realpathSync(workspaceCopy), 'brain', '.structure')
    expect(watched).toContain(physical)
    expect(watched).not.toContain(join(dir, 'flow', 'brain', '.structure'))
  }, 10_000)

  it('leaves a watcher whose directories did not move alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-still-'))
    home = ''
    mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
    observer = new BlueprintObserver(roots)
    observer.start()
    await new Promise((r) => setTimeout(r, 300))
    // Nothing moved → no re-aim, and so no announcement of a change.
    const announced = await eventsWithin(700, () => observer?.rewatchMovedRoots())
    expect(announced).toBe(0)
  }, 10_000)
})

describe('parseGraphContent', () => {
  it('parses a valid graph', () => {
    const graph = parseGraphContent(
      JSON.stringify({
        version: 1,
        derivedAt: '2026-07-09T00:00:00Z',
        coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: [], graphifyEnriched: false },
        nodes: [],
        edges: [],
      }),
    )
    expect(graph?.version).toBe(1)
  })

  it('yields null for empty, corrupt, or shape-invalid content', () => {
    expect(parseGraphContent('')).toBeNull()
    expect(parseGraphContent('not json')).toBeNull()
    expect(parseGraphContent('{"nodes": "nope"}')).toBeNull()
  })
})

describe('parseStoryContent', () => {
  const validStep = {
    id: 'wire-up-the-api',
    title: 'Wire up the API',
    kicker: 'Phase 2',
    body: 'Connects the client to the new endpoint.',
    anchors: [{ kind: 'file', ref: 'src/api/client.ts' }],
    flow: ['module:api'],
    phases: [2],
    decisions: ['use fetch over axios'],
    rejected: ['a bespoke http client'],
    questions: [],
    source: 'flow/plans/plan_story_v1.md',
    unresolvedAnchors: [],
    draft: false,
  }
  const validStory = {
    plan: 'story',
    sourcePath: 'flow/plans/plan_story_v1.md',
    mode: 'strict',
    steps: [validStep],
    warnings: [],
  }

  it('parses a valid story', () => {
    const story = parseStoryContent(JSON.stringify(validStory))
    expect(story).toEqual(validStory)
  })

  it('yields undefined for a missing file (raw === null)', () => {
    expect(parseStoryContent(null)).toBeUndefined()
  })

  it('yields undefined for empty content', () => {
    expect(parseStoryContent('')).toBeUndefined()
    expect(parseStoryContent('   \n  ')).toBeUndefined()
  })

  it('yields undefined for corrupt JSON', () => {
    expect(parseStoryContent('{not valid json')).toBeUndefined()
  })

  it('yields undefined for non-object content', () => {
    expect(parseStoryContent('42')).toBeUndefined()
    expect(parseStoryContent('"a string"')).toBeUndefined()
    expect(parseStoryContent('[1,2,3]')).toBeUndefined()
  })

  it('yields undefined for the wrong shape (missing/invalid required fields)', () => {
    expect(parseStoryContent(JSON.stringify({ ...validStory, plan: 42 }))).toBeUndefined()
    expect(parseStoryContent(JSON.stringify({ ...validStory, mode: 'lenient' }))).toBeUndefined()
    expect(parseStoryContent(JSON.stringify({ sourcePath: 'x', mode: 'draft', steps: [], warnings: [] }))).toBeUndefined()
  })

  it('yields undefined when steps is not an array', () => {
    expect(parseStoryContent(JSON.stringify({ ...validStory, steps: 'nope' }))).toBeUndefined()
    expect(parseStoryContent(JSON.stringify({ ...validStory, steps: { 0: validStep } }))).toBeUndefined()
  })

  it('yields undefined when a step in the array is malformed', () => {
    const badStep = { ...validStep, anchors: 'not-an-array' }
    expect(parseStoryContent(JSON.stringify({ ...validStory, steps: [badStep] }))).toBeUndefined()

    const missingDraft = { ...validStep, draft: undefined }
    expect(parseStoryContent(JSON.stringify({ ...validStory, steps: [missingDraft] }))).toBeUndefined()
  })

  it('accepts steps without the optional kicker/source fields', () => {
    const minimalStep = { ...validStep }
    delete (minimalStep as { kicker?: string }).kicker
    delete (minimalStep as { source?: string }).source
    const story = parseStoryContent(JSON.stringify({ ...validStory, steps: [minimalStep] }))
    expect(story?.steps[0].kicker).toBeUndefined()
    expect(story?.steps[0].source).toBeUndefined()
  })
})

describe('story.json is wired into the watcher filename filter', () => {
  it('is included in WATCHED_FILES so a story.json change pushes blueprint:changed', () => {
    expect(WATCHED_FILES.has('story.json')).toBe(true)
  })

  it('watches learning-state.jsonl and investigations.jsonl too', () => {
    expect(WATCHED_FILES.has('learning-state.jsonl')).toBe(true)
    expect(WATCHED_FILES.has('investigations.jsonl')).toBe(true)
  })

  it('watches file-tiers.json so a re-derive/adjudicate refreshes the board', () => {
    expect(WATCHED_FILES.has('file-tiers.json')).toBe(true)
  })
})

// ── Trust-tier tallies (trust-tiers Phase 4) ────────────────────────────────

function tierEntry(
  path: string,
  tier: string,
  verdict?: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { path, tier }
  if (verdict !== undefined) {
    entry.verdict = { verdict, docHash: 'h', verifiedAgainst: [], ts: '2026-07-22T00:00:00Z' }
  }
  return entry
}

function tierStore(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify({ derivedAt: '2026-07-22T00:00:00Z', entries })
}

describe('parseTierSummary', () => {
  it('tallies claim docs by verdict, counting verdict-less claims as unadjudicated', () => {
    const raw = tierStore([
      tierEntry('src/a.ts', 'code'),
      tierEntry('flow/plans/p.md', 'own'),
      tierEntry('docs/api.md', 'claim', 'corroborated'),
      tierEntry('docs/arch.md', 'claim', 'corroborated'),
      tierEntry('docs/old.md', 'claim', 'contradicted'),
      tierEntry('docs/vague.md', 'claim', 'unverifiable'),
      tierEntry('docs/new.md', 'claim'),
      tierEntry('LICENSE', 'other'),
    ])
    expect(parseTierSummary(raw)).toEqual({
      claimTotal: 5,
      corroborated: 2,
      contradicted: 1,
      unverifiable: 1,
      unadjudicated: 1,
    })
  })

  it('returns undefined for missing, empty, corrupt, or shape-invalid content', () => {
    expect(parseTierSummary(null)).toBeUndefined()
    expect(parseTierSummary('')).toBeUndefined()
    expect(parseTierSummary('   \n')).toBeUndefined()
    expect(parseTierSummary('not json')).toBeUndefined()
    expect(parseTierSummary('[]')).toBeUndefined()
    expect(parseTierSummary('{"derivedAt":"x"}')).toBeUndefined() // no entries array
    expect(parseTierSummary('{"entries":"nope"}')).toBeUndefined()
  })

  it('drops shape-invalid entries and treats a malformed verdict as unadjudicated', () => {
    const raw = tierStore([
      { path: 'docs/a.md' }, // no tier — dropped
      { tier: 'claim' }, // no path — dropped
      tierEntry('docs/weird.md', 'mystery'), // unknown tier — dropped
      { path: 'docs/b.md', tier: 'claim', verdict: { verdict: 'maybe' } }, // bad kind
      { path: 'docs/c.md', tier: 'claim', verdict: 'corroborated' }, // non-object verdict
      tierEntry('docs/d.md', 'claim', 'contradicted'),
    ])
    expect(parseTierSummary(raw)).toEqual({
      claimTotal: 3,
      corroborated: 0,
      contradicted: 1,
      unverifiable: 0,
      unadjudicated: 2,
    })
  })

  it('yields zero tallies for a store with no claim entries', () => {
    const raw = tierStore([tierEntry('src/a.ts', 'code'), tierEntry('LICENSE', 'other')])
    expect(parseTierSummary(raw)).toEqual({
      claimTotal: 0,
      corroborated: 0,
      contradicted: 0,
      unverifiable: 0,
      unadjudicated: 0,
    })
  })
})

describe('read() surfaces tier tallies', () => {
  let dir: string
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('parses file-tiers.json into snapshot.tiers', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/file-tiers.json'),
      tierStore([
        tierEntry('docs/api.md', 'claim', 'corroborated'),
        tierEntry('docs/new.md', 'claim'),
        tierEntry('src/a.ts', 'code'),
      ]),
    )
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.tiers).toEqual({
      claimTotal: 2,
      corroborated: 1,
      contradicted: 0,
      unverifiable: 0,
      unadjudicated: 1,
    })
  })

  it('leaves snapshot.tiers undefined when the sidecar is absent or corrupt', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    expect((await new BlueprintObserver(roots).read(dir)).tiers).toBeUndefined()
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(join(dir, 'flow/brain/.structure/file-tiers.json'), '{corrupt')
    expect((await new BlueprintObserver(roots).read(dir)).tiers).toBeUndefined()
  })
})

describe('read() surfaces learning-state', () => {
  let dir: string
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('parses learning-state.jsonl into snapshot.learning (deduped, sorted)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/learning-state.jsonl'),
      [
        JSON.stringify({ module: 'src/b', status: 'learning', notedAt: '2026-07-15T00:00:00Z' }),
        JSON.stringify({ module: 'src/a', status: 'learned', notedAt: '2026-07-15T00:00:00Z' }),
        JSON.stringify({ module: 'src/b', status: 'stale', notedAt: '2026-07-15T02:00:00Z' }),
      ].join('\n'),
    )
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.learning).toEqual([
      { module: 'src/a', status: 'learned', notedAt: '2026-07-15T00:00:00Z' },
      { module: 'src/b', status: 'stale', notedAt: '2026-07-15T02:00:00Z' },
    ])
  })

  it('leaves snapshot.learning undefined when the store is absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.learning).toBeUndefined()
  })
})

describe('foldAnnotationStream', () => {
  const entry = {
    ts: '2026-07-09T00:00:00Z',
    runId: 'run-1',
    type: 'decision',
    text: 'use sqlite',
    anchors: [{ kind: 'file', ref: 'src/db.ts' }],
    provenance: 'test',
    status: 'active',
  }

  it('returns entries with their as-written status when no events exist', () => {
    const [folded] = foldAnnotationStream(JSON.stringify(entry), '')
    expect(folded.status).toBe('active')
    expect(folded.text).toBe('use sqlite')
  })

  it('folds status events — the LAST event per fingerprint wins', () => {
    const fingerprint = annotationFingerprint({
      type: 'decision',
      text: 'use sqlite',
      anchors: [{ kind: 'file', ref: 'src/db.ts' }],
    })
    const events = [
      { ts: '1', targetFingerprint: fingerprint, status: 'stale', reason: 'anchor lost' },
      { ts: '2', targetFingerprint: fingerprint, status: 'active', reason: 'recovered' },
      { ts: '3', targetFingerprint: fingerprint, status: 'stale', reason: 'lost again' },
    ]
    const [folded] = foldAnnotationStream(
      JSON.stringify(entry),
      events.map((event) => JSON.stringify(event)).join('\n'),
    )
    expect(folded.status).toBe('stale')
  })

  it('ignores events targeting a different fingerprint', () => {
    const [folded] = foldAnnotationStream(
      JSON.stringify(entry),
      JSON.stringify({ targetFingerprint: 'other+x+[]', status: 'stale', reason: 'n/a' }),
    )
    expect(folded.status).toBe('active')
  })

  it('skips corrupt lines and entries, keeping valid siblings', () => {
    const folded = foldAnnotationStream(
      `not json\n${JSON.stringify(entry)}\n{"type":"decision"}`,
      'also not json',
    )
    expect(folded).toHaveLength(1)
  })

  it('uses the CLI fingerprint shape: <type>+<text>+<JSON sorted refs>', () => {
    expect(
      annotationFingerprint({
        type: 'rule',
        text: 't',
        anchors: [
          { kind: 'file', ref: 'b' },
          { kind: 'symbol', ref: 'a' },
        ],
      }),
    ).toBe('rule+t+["a","b"]')
  })
})

// Must mirror the CLI store's foldProposalEvents (source of truth:
// src/cli/blueprint/proposal-store.ts).
describe('foldProposalStream', () => {
  const proposed = {
    ts: '2026-07-10T00:00:00Z',
    plan: 'plan_a',
    phase: 2,
    predictedNodeId: 'integration:stripe',
    kind: 'integration',
    label: 'Stripe SDK',
    detail: 'billing integration',
    anchors: [{ kind: 'file', ref: 'src/pay/stripe.ts' }],
    event: 'proposed',
    provenance: 'cli:propose',
  }

  const lines = (...records: unknown[]): string =>
    records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n')

  it('folds a lone proposed event with its payload', () => {
    const [folded] = foldProposalStream(lines(proposed))
    expect(folded).toEqual({
      fingerprint: 'plan_a+integration:stripe',
      plan: 'plan_a',
      phase: 2,
      predictedNodeId: 'integration:stripe',
      kind: 'integration',
      label: 'Stripe SDK',
      detail: 'billing integration',
      anchors: [{ kind: 'file', ref: 'src/pay/stripe.ts' }],
      state: 'proposed',
      provenance: 'cli:propose',
      proposedAt: '2026-07-10T00:00:00Z',
    })
  })

  it('the LAST event per fingerprint wins; payload stays from the FIRST proposed', () => {
    const accepted = {
      ...proposed,
      ts: '2026-07-10T01:00:00Z',
      label: 'RE-CARRIED (ignored)',
      event: 'accepted',
      provenance: 'cli:decide',
    }
    const [folded] = foldProposalStream(lines(proposed, accepted))
    expect(folded.state).toBe('accepted')
    expect(folded.label).toBe('Stripe SDK')
    expect(folded.provenance).toBe('cli:propose')
    expect(folded.decidedAt).toBe('2026-07-10T01:00:00Z')
  })

  it('records confirmedAt and sorts by proposedAt then fingerprint', () => {
    const other = {
      ...proposed,
      ts: '2026-07-09T00:00:00Z',
      plan: 'plan_b',
      predictedNodeId: 'datastore:cache',
      kind: 'datastore',
      label: 'Cache',
    }
    const confirmed = { ...proposed, ts: '2026-07-10T02:00:00Z', event: 'confirmed' }
    const folded = foldProposalStream(lines(proposed, other, confirmed))
    expect(folded.map((entry) => entry.fingerprint)).toEqual([
      'plan_b+datastore:cache',
      'plan_a+integration:stripe',
    ])
    expect(folded[1].state).toBe('confirmed')
    expect(folded[1].confirmedAt).toBe('2026-07-10T02:00:00Z')
  })

  it('ties on ts break by file order (a later line wins)', () => {
    const rejectedSameTs = { ...proposed, event: 'rejected' }
    const [folded] = foldProposalStream(lines(proposed, rejectedSameTs))
    expect(folded.state).toBe('rejected')
  })

  it('drops fingerprints without a proposed event, skips corrupt lines', () => {
    const orphanDecision = { ...proposed, predictedNodeId: 'integration:other', event: 'accepted' }
    const folded = foldProposalStream(
      lines('not json', orphanDecision, proposed, { plan: 'x', event: 'proposed' }),
    )
    expect(folded).toHaveLength(1)
    expect(folded[0].predictedNodeId).toBe('integration:stripe')
  })

  it('yields empty for missing/blank content', () => {
    expect(foldProposalStream('')).toEqual([])
    expect(foldProposalStream('\n\n')).toEqual([])
  })
})

// ── CLI ↔ app fold parity ──────────────────────────────────────────────────
//
// SYNC NOTE: this fixture and its expected fold are DUPLICATED in
// src/cli/blueprint/proposal-store.test.ts ("fold parity fixture") — the CLI
// side asserts readEffectiveProposals produces the SAME effective proposals
// from the SAME lines (the fixture was CLI-generated: proposed/decide lines
// via `blueprint propose`, confirm via derive, stale via sweep, then a
// re-propose). When either side changes, update both.
describe('CLI fold parity', () => {
  const PARITY_FIXTURE_LINES = [
    '{"ts":"2026-07-10T00:00:00.000Z","plan":"plan_pay","phase":2,"predictedNodeId":"integration:stripe","kind":"integration","label":"Stripe SDK","detail":"billing integration","anchors":[{"kind":"file","ref":"src/pay/stripe.ts"}],"event":"proposed","provenance":"cli:propose"}',
    '{"ts":"2026-07-10T01:00:00.000Z","plan":"plan_pay","predictedNodeId":"datastore:cache","kind":"datastore","label":"Cache","event":"proposed","provenance":"cli:propose"}',
    '{"ts":"2026-07-10T02:00:00.000Z","plan":"plan_pay","predictedNodeId":"integration:stripe","kind":"integration","label":"RE-CARRIED (ignored)","event":"accepted","provenance":"cli:propose"}',
    'not json — must be skipped by both folds',
    '{"ts":"2026-07-10T03:00:00.000Z","plan":"plan_pay","predictedNodeId":"endpoint:GET /ghost","kind":"endpoint","label":"Orphan decision","event":"accepted","provenance":"cli:propose"}',
    '{"ts":"2026-07-10T04:00:00.000Z","plan":"plan_pay","phase":2,"predictedNodeId":"integration:stripe","kind":"integration","label":"Stripe SDK","event":"confirmed","provenance":"derive:confirm"}',
    '{"ts":"2026-07-10T05:00:00.000Z","plan":"plan_pay","predictedNodeId":"datastore:cache","kind":"datastore","label":"Cache","event":"stale","provenance":"cli:sweep"}',
    '{"ts":"2026-07-10T06:00:00.000Z","plan":"plan_pay","predictedNodeId":"datastore:cache","kind":"datastore","label":"Cache v2 (ignored)","event":"proposed","provenance":"cli:propose"}',
  ] as const

  // Expected output copied verbatim from the CLI fold of the same lines
  // (EXPECTED_PARITY_FOLD in src/cli/blueprint/proposal-store.test.ts).
  const EXPECTED_PARITY_FOLD = [
    {
      fingerprint: 'plan_pay+integration:stripe',
      plan: 'plan_pay',
      predictedNodeId: 'integration:stripe',
      kind: 'integration',
      label: 'Stripe SDK',
      anchors: [{ kind: 'file', ref: 'src/pay/stripe.ts' }],
      state: 'confirmed',
      provenance: 'cli:propose',
      proposedAt: '2026-07-10T00:00:00.000Z',
      phase: 2,
      detail: 'billing integration',
      decidedAt: '2026-07-10T02:00:00.000Z',
      confirmedAt: '2026-07-10T04:00:00.000Z',
    },
    {
      fingerprint: 'plan_pay+datastore:cache',
      plan: 'plan_pay',
      predictedNodeId: 'datastore:cache',
      kind: 'datastore',
      label: 'Cache',
      anchors: [],
      state: 'proposed', // re-proposed after the sweep — state resets
      provenance: 'cli:propose',
      proposedAt: '2026-07-10T01:00:00.000Z',
    },
  ]

  it('folds the shared parity fixture identically to the CLI store', () => {
    expect(foldProposalStream(PARITY_FIXTURE_LINES.join('\n'))).toEqual(EXPECTED_PARITY_FOLD)
  })
})

// ── Investigation fold (mirror of the CLI investigation-store) ───────────────

describe('investigationFingerprint', () => {
  it('is <text>+<JSON array of sorted anchor refs> (matches the CLI)', () => {
    expect(
      investigationFingerprint({
        text: 't',
        anchors: [
          { kind: 'file', ref: 'b' },
          { kind: 'symbol', ref: 'a' },
        ],
      }),
    ).toBe('t+["a","b"]')
  })
})

describe('foldActiveInvestigations', () => {
  it('drops superseded notes, sorts active by ts then fingerprint', () => {
    const active = foldActiveInvestigations(INVESTIGATION_PARITY_LINES.join('\n'))
    expect(active.map((note) => investigationFingerprint(note))).toEqual(
      INVESTIGATION_PARITY_ACTIVE_FINGERPRINTS,
    )
  })

  it('skips corrupt lines, non-note kinds, and notes without text', () => {
    const content = [
      'not json',
      '{"kind":"heat","anchorRef":"x","visitor":"agent"}',
      '{"kind":"note","anchors":[],"provenance":"p"}',
      '{"kind":"note","ts":"1","anchors":[{"kind":"file","ref":"z"}],"text":"keep","provenance":"p"}',
    ].join('\n')
    const active = foldActiveInvestigations(content)
    expect(active).toHaveLength(1)
    expect(active[0].text).toBe('keep')
  })

  it('yields empty for blank content', () => {
    expect(foldActiveInvestigations('')).toEqual([])
    expect(foldActiveInvestigations('\n\n')).toEqual([])
  })
})

describe('buildInvestigations', () => {
  it('projects active notes with truncated summary, anchorRefs, and fingerprint', () => {
    const { investigations, truncated } = buildInvestigations(
      INVESTIGATION_PARITY_LINES.join('\n'),
      new Set(),
    )
    expect(truncated).toBe(false)
    expect(investigations.map((entry) => entry.fingerprint)).toEqual(
      INVESTIGATION_PARITY_ACTIVE_FINGERPRINTS,
    )
    expect(investigations[0]).toEqual({
      anchorRefs: ['src/b.ts'],
      summary: 'note B',
      provenance: 'observe-cli',
      ts: '2026-07-15T01:00:00.000Z',
      fingerprint: 'note B+["src/b.ts"]',
    })
  })

  it('flags stale when an anchor ref names a stale module (cheap name join)', () => {
    const { investigations } = buildInvestigations(
      INVESTIGATION_PARITY_LINES.join('\n'),
      new Set(['mod/x']),
    )
    const noteD = investigations.find((entry) => entry.anchorRefs.includes('mod/x'))
    expect(noteD?.stale).toBe(true)
    const noteB = investigations.find((entry) => entry.fingerprint === 'note B+["src/b.ts"]')
    expect(noteB?.stale).toBeUndefined()
  })

  it('summary is the first line, truncated to 200 chars', () => {
    const long = 'x'.repeat(250)
    const content = JSON.stringify({
      kind: 'note',
      ts: '1',
      anchors: [{ kind: 'file', ref: 'f' }],
      text: `${long}\nsecond line`,
      provenance: 'p',
    })
    const { investigations } = buildInvestigations(content, new Set())
    expect(investigations[0].summary).toHaveLength(200)
    expect(investigations[0].summary).not.toContain('second line')
  })

  it('caps at INVESTIGATIONS_CAP and sets the truncation flag', () => {
    const lines = Array.from({ length: INVESTIGATIONS_CAP + 5 }, (_unused, index) =>
      JSON.stringify({
        kind: 'note',
        ts: `2026-07-15T00:00:${String(index).padStart(2, '0')}.000Z`,
        anchors: [{ kind: 'file', ref: `src/f${index}.ts` }],
        text: `note ${index}`,
        provenance: 'p',
      }),
    ).join('\n')
    const { investigations, truncated } = buildInvestigations(lines, new Set())
    expect(investigations).toHaveLength(INVESTIGATIONS_CAP)
    expect(truncated).toBe(true)
  })
})

describe('read() surfaces investigations', () => {
  let dir: string
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('folds investigations.jsonl and joins stale modules from learning-state', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/investigations.jsonl'),
      INVESTIGATION_PARITY_LINES.join('\n'),
    )
    writeFileSync(
      join(dir, 'flow/brain/.structure/learning-state.jsonl'),
      JSON.stringify({ module: 'mod/x', status: 'stale', notedAt: '2026-07-15T04:00:00Z' }),
    )
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.investigations?.map((entry) => entry.fingerprint)).toEqual(
      INVESTIGATION_PARITY_ACTIVE_FINGERPRINTS,
    )
    expect(snap.investigations?.find((entry) => entry.anchorRefs.includes('mod/x'))?.stale).toBe(true)
    expect(snap.investigationsTruncated).toBeUndefined()
  })

  it('leaves investigations undefined when the store is absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.investigations).toBeUndefined()
    expect(snap.investigationsTruncated).toBeUndefined()
  })
})

// ── Drift (Phase 4) ──────────────────────────────────────────────────────────

describe('enrichCrossLinks (federation evidence join)', () => {
  const link = (over: Record<string, unknown> = {}) => ({
    provider: 'orbit-core',
    endpoint: 'POST /api/v1/agents/stream',
    status: 'proposed' as const,
    confidence: 'high' as const,
    files: ['src/datasources/EngineAPI.ts'],
    surfaceDerivedAt: 'v',
    ...over,
  })
  const outboundRaw = JSON.stringify({
    version: 1,
    calls: [
      { base: 'ORBIT_ENGINE_API_URL', baseIsEnv: true, path: '/v1/agents/stream', file: 'src/datasources/EngineAPI.ts' },
      { base: 'other', baseIsEnv: false, path: '/unrelated', file: 'src/x.ts' },
    ],
    graphqlOperations: [{ operation: 'query', name: 'GetTenants', file: 'src/queries.ts' }],
  })
  const providerGraphRaw = JSON.stringify({
    nodes: [
      {
        id: 'endpoint:POST /api/v1/agents/stream',
        kind: 'endpoint',
        label: 'POST /api/v1/agents/stream',
        sourceFile: 'orbit_core/web/api/v1/agents/views.py',
      },
    ],
  })

  it('joins consumer call sites (suffix rule) and the provider source file', () => {
    const [enriched] = enrichCrossLinks([link()], outboundRaw, new Map([['orbit-core', providerGraphRaw]]))
    expect(enriched.calls).toEqual([
      { base: 'ORBIT_ENGINE_API_URL', baseIsEnv: true, path: '/v1/agents/stream', file: 'src/datasources/EngineAPI.ts' },
    ])
    expect(enriched.providerFile).toBe('orbit_core/web/api/v1/agents/views.py')
  })

  it('joins GraphQL links by operation+name', () => {
    const [enriched] = enrichCrossLinks(
      [link({ endpoint: 'query GetTenants' })],
      outboundRaw,
      new Map(),
    )
    expect(enriched.calls?.[0]).toMatchObject({ file: 'src/queries.ts', base: 'query document' })
    expect(enriched.providerFile).toBeUndefined()
  })

  it('fail-soft: corrupt outbound and missing provider graphs pass links through unchanged', () => {
    const [enriched] = enrichCrossLinks([link()], '{not json', new Map([['orbit-core', null]]))
    expect(enriched.calls).toBeUndefined()
    expect(enriched.providerFile).toBeUndefined()
    expect(enriched.endpoint).toBe('POST /api/v1/agents/stream')
  })
})

describe('parseDriftReport', () => {
  it('parses a valid report, keeping optional fields', () => {
    const report = parseDriftReport(
      JSON.stringify({
        baselineAt: '2026-07-20T00:00:00.000Z',
        entries: [
          { path: 'src/a.ts', kind: 'changed', nodeId: 'n' },
          { path: 'src/b.ts', kind: 'renamed', renamedFrom: 'src/old.ts' },
        ],
      }),
    )
    expect(report?.baselineAt).toBe('2026-07-20T00:00:00.000Z')
    expect(report?.entries).toEqual([
      { path: 'src/a.ts', kind: 'changed', nodeId: 'n' },
      { path: 'src/b.ts', kind: 'renamed', renamedFrom: 'src/old.ts' },
    ])
  })

  it('drops malformed entries (bad kind / missing path) but keeps siblings', () => {
    const report = parseDriftReport(
      JSON.stringify({
        baselineAt: null,
        entries: [{ kind: 'changed' }, { path: 'x', kind: 'bogus' }, { path: 'ok.ts', kind: 'added' }],
      }),
    )
    expect(report?.entries).toEqual([{ path: 'ok.ts', kind: 'added' }])
  })

  it('returns null for a stale CLI ("unknown action") / non-JSON / no entries array', () => {
    expect(parseDriftReport('Unknown blueprint action: "drift-check"')).toBeNull()
    expect(parseDriftReport('not json')).toBeNull()
    expect(parseDriftReport(JSON.stringify({ baselineAt: null }))).toBeNull()
  })
})

describe('read() surfaces drift (fail-soft)', () => {
  let dir: string
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  /** A drift-deps stub whose drift-check outcome is injected per test. */
  function stubDeps(runDriftCheck: DriftObserverDeps['runDriftCheck']): DriftObserverDeps {
    return {
      runDriftCheck,
      fileAuthors: async () => new Map(),
      dirtyPaths: async () => new Set(['src/a.ts']),
      currentUserEmail: async () => 'me@here.com',
      isNodeInPlay: () => false,
      readAcks: async () => [],
    }
  }

  it('omits drift when the deps are never wired (backward compatible)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    const snap = await new BlueprintObserver(roots).read(dir)
    expect(snap.drift).toBeUndefined()
  })

  it('returns a valid snapshot with drift undefined when drift-check fails (stale bundle)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/graph.json'),
      JSON.stringify({ version: 1, nodes: [{ id: 'n' }], edges: [] }),
    )
    const observer = new BlueprintObserver(roots)
    // A stale CLI can't run drift-check → runner resolves null. read() must still
    // return a valid snapshot (graph present) with drift simply omitted.
    observer.setDriftDeps(stubDeps(async () => null))
    const snap = await observer.read(dir)
    expect(snap.graph).not.toBeNull()
    expect(snap.drift).toBeUndefined()
  })

  it('never throws even when the drift runner itself rejects', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    const observer = new BlueprintObserver(roots)
    observer.setDriftDeps(
      stubDeps(async () => {
        throw new Error('boom')
      }),
    )
    const snap = await observer.read(dir)
    expect(snap.drift).toBeUndefined()
    expect(snap.annotations).toEqual([])
  })

  it('never waits for a drift assembly that is still running', async () => {
    // The first read was already allowed to answer without drift. Every read
    // AFTER it awaited the cached promise — so a slow assembly blocked the
    // board on a projection it had agreed to live without. Measured on this
    // repo: `blueprint:read answered in 5,695ms` with every internal stage
    // under a millisecond.
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/graph.json'),
      JSON.stringify({ version: 1, nodes: [{ id: 'n' }], edges: [] }),
    )
    const observer = new BlueprintObserver(roots)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    observer.setDriftDeps(
      stubDeps(async () => {
        await held // the assembly is in flight and going nowhere
        return null
      }),
    )

    await observer.read(dir) // starts the assembly
    const startedAt = Date.now()
    const second = await observer.read(dir)
    const elapsed = Date.now() - startedAt

    expect(second.graph).not.toBeNull()
    expect(second.drift).toBeUndefined()
    // The real assertion: it came back rather than waiting on `held`.
    expect(elapsed).toBeLessThan(500)
    release()
  })

  it('assembles drift from a valid report + injected git/run/ack facts', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/graph.json'),
      JSON.stringify({
        version: 1,
        nodes: [{ id: 'module:src/auth', kind: 'module', label: 'auth', sourceFile: 'src/auth' }],
        edges: [],
      }),
    )
    const observer = new BlueprintObserver(roots)
    observer.setDriftDeps(
      stubDeps(async () => ({
        baselineAt: '2026-07-20T00:00:00.000Z',
        entries: [{ path: 'src/auth/a.ts', kind: 'changed', nodeId: 'module:src/auth' }],
      })),
    )
    // THE FIRST READ DOES NOT WAIT FOR IT. Drift spawns the bundled CLI, and
    // that read measured 2,343 ms of main-process time — with every other IPC
    // queued behind it, which is what "the app hangs at open" was. The first
    // read starts the work and answers without it.
    const first = await observer.read(dir)
    expect(first.drift).toBeUndefined()

    // …and once it lands, the next read carries it (the board re-reads on the
    // blueprint:changed push the observer emits).
    await new Promise((resolve) => setTimeout(resolve, 0))
    const snap = await observer.read(dir)
    expect(snap.drift?.nodes).toHaveLength(1)
    expect(snap.drift?.nodes[0].nodeId).toBe('module:src/auth')
    expect(snap.drift?.nodes[0].label).toBe('auth')
    // Committed (not dirty, not in play), author unknown but identity known →
    // a committed change we can't attribute to someone else reads as 'yours'.
    expect(snap.drift?.nodes[0].origin).toBe('yours')
    expect(snap.drift?.shown).toBe(1)
  })
})

describe('tier parsing excludes images (#1130)', () => {
  const raw = JSON.stringify({
    entries: [
      { path: 'docs/guide.md', tier: 'claim', verdict: { verdict: 'corroborated' } },
      { path: 'assets/diagram.png', tier: 'claim', verdict: { verdict: 'unverifiable' } },
      { path: 'logo.svg', tier: 'claim' },
      { path: 'src/index.ts', tier: 'code' },
    ],
  })

  it('drops image rows from the Docs list', () => {
    // They could only ever read "unverified", and their Verify button did
    // nothing — a text-only agent cannot adjudicate an image.
    expect(parseTierFiles(raw)?.map((file) => file.path)).toEqual(['docs/guide.md'])
  })

  it('keeps the tab COUNT matching the rows under it', () => {
    expect(parseTierSummary(raw)?.claimTotal).toBe(1)
  })

  it('cleans up an existing project on the next read, with no re-learn', () => {
    // The filter is on READ, so a file-tiers.json already full of image entries
    // stops producing rows immediately.
    const allImages = JSON.stringify({
      entries: [
        { path: 'a.png', tier: 'claim', verdict: { verdict: 'unverifiable' } },
        { path: 'b.svg', tier: 'claim', verdict: { verdict: 'unverifiable' } },
      ],
    })
    // An empty result surfaces as undefined (pre-existing shape) — the point is
    // that not one image row survives.
    expect(parseTierFiles(allImages) ?? []).toEqual([])
    expect(parseTierSummary(allImages)?.claimTotal).toBe(0)
  })
})

describe('tier parsing carries the WHY, not just the counts (#1131)', () => {
  // Shape is the CLI's TierVerdict (src/cli/blueprint/file-tiers.ts) — the
  // single writer: `ts`, `verifiedAgainst[].path`, and VerdictClaim's
  // `claim`/`note`. Reading any other field names would silently find nothing.
  const verdict = {
    verdict: 'contradicted',
    docHash: 'a'.repeat(64),
    ts: '2026-08-01T09:00:00.000Z',
    provenance: 'verify-agent',
    evidence: 'The doc documents a v1 endpoint the router no longer serves.',
    verifiedAgainst: [
      { path: 'src/api/router.ts', contentHash: 'b'.repeat(64) },
      { path: 'src/api/handlers.ts', contentHash: 'c'.repeat(64) },
    ],
    claims: [
      { claim: 'POST /v1/login returns a session token', outcome: 'contradicted', witnesses: ['src/api/router.ts'], note: 'router.ts mounts /v2/login only' },
      { claim: 'Tokens expire after 24h', outcome: 'corroborated', witnesses: ['src/api/handlers.ts'] },
    ],
  }
  const raw = JSON.stringify({ entries: [{ path: 'docs/api.md', tier: 'claim', verdict }] })

  it('carries when it was decided and what it was checked against', () => {
    // "Contradicted by what?" was unanswerable: the snapshot kept only counts.
    const file = parseTierFiles(raw)?.[0]
    expect(file?.verifiedAt).toBe('2026-08-01T09:00:00.000Z')
    expect(file?.witnesses).toEqual(['src/api/router.ts', 'src/api/handlers.ts'])
    expect(file?.evidence).toContain('no longer serves')
  })

  it('carries each claim with its own outcome and note', () => {
    const details = parseTierFiles(raw)?.[0]?.claimDetails
    expect(details).toHaveLength(2)
    expect(details?.[0]).toEqual({
      text: 'POST /v1/login returns a session token',
      outcome: 'contradicted',
      evidence: 'router.ts mounts /v2/login only',
    })
    // A claim without a note keeps its text and outcome.
    expect(details?.[1]?.evidence).toBeUndefined()
    expect(details?.[1]?.outcome).toBe('corroborated')
  })

  it('still tallies the rollup counts it always did', () => {
    expect(parseTierFiles(raw)?.[0]?.claims).toEqual({
      corroborated: 1,
      contradicted: 1,
      unverifiable: 0,
    })
  })

  it('drops a malformed claim alone, never sinking the file row', () => {
    const damaged = JSON.stringify({
      entries: [
        {
          path: 'docs/api.md',
          tier: 'claim',
          verdict: {
            ...verdict,
            claims: [{ claim: 'good one', outcome: 'corroborated', witnesses: [] }, { outcome: 'corroborated' }, null],
          },
        },
      ],
    })
    const file = parseTierFiles(damaged)?.[0]
    expect(file?.path).toBe('docs/api.md')
    expect(file?.claimDetails).toHaveLength(1)
  })

  it('caps claims and witnesses so a pathological file cannot bloat the payload', () => {
    const many = JSON.stringify({
      entries: [
        {
          path: 'docs/big.md',
          tier: 'claim',
          verdict: {
            ...verdict,
            verifiedAgainst: Array.from({ length: 40 }, (_unused, i) => ({ path: `src/f${i}.ts` })),
            claims: Array.from({ length: 60 }, (_unused, i) => ({
              claim: `claim ${i}`,
              outcome: 'corroborated',
              witnesses: [],
            })),
          },
        },
      ],
    })
    const file = parseTierFiles(many)?.[0]
    expect(file?.witnesses).toHaveLength(10)
    expect(file?.claimDetails).toHaveLength(20)
    // The COUNTS stay complete even though the detail list is capped.
    expect(file?.claims?.corroborated).toBe(60)
  })

  it('leaves legacy verdicts (no ts, no claims) exactly as they were', () => {
    const legacy = JSON.stringify({
      entries: [{ path: 'docs/old.md', tier: 'claim', verdict: { verdict: 'corroborated' } }],
    })
    const file = parseTierFiles(legacy)?.[0]
    expect(file?.verdict).toBe('corroborated')
    expect(file?.verifiedAt).toBeUndefined()
    expect(file?.claimDetails).toBeUndefined()
    expect(file?.witnesses).toBeUndefined()
  })
})

// ── corpus index read (changes-discovery-view #1532) ────────────────────────
//
// A plain file read of flow/brain/.derived/corpus-index.json — fail-soft by
// contract: every degenerate state is an EMPTY index (indexedAt: null), never
// a throw across IPC. The CLI's discover pass owns writing the file.
describe('readCorpusIndexFile — fail-soft corpus index read (#1532)', () => {
  let dir: string
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  const indexPath = () => join(dir, 'flow', 'brain', '.derived', 'corpus-index.json')
  const writeIndex = (content: string) => {
    mkdirSync(join(dir, 'flow', 'brain', '.derived'), { recursive: true })
    writeFileSync(indexPath(), content)
  }
  const entry = {
    path: 'flow/plans/plan_auth_v1.md',
    kind: 'change',
    featureSlug: 'auth',
    name: 'Auth Hardening',
    created: '2026-08-01T00:00:00.000Z',
    indexed: '2026-08-10T00:00:00.000Z',
    archived: false,
  }

  it('reads a missing file as an empty list with indexedAt null — no index yet', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-corpus-'))
    expect(await readCorpusIndexFile(dir)).toEqual({ indexedAt: null, entries: [] })
  })

  it('reads a written index back whole', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-corpus-'))
    writeIndex(JSON.stringify({ indexedAt: '2026-08-10T00:00:00.000Z', entries: [entry] }))
    const result = await readCorpusIndexFile(dir)
    expect(result.indexedAt).toBe('2026-08-10T00:00:00.000Z')
    expect(result.entries).toEqual([entry])
  })

  it('passes legacy entries WITHOUT dates through — created/indexed are optional', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-corpus-'))
    const legacy = {
      path: 'flow/archive/plan_old_v1.md',
      kind: 'change',
      featureSlug: null,
      name: 'Old Plan',
      archived: true,
    }
    writeIndex(JSON.stringify({ indexedAt: '2026-08-10T00:00:00.000Z', entries: [legacy] }))
    const result = await readCorpusIndexFile(dir)
    expect(result.entries).toEqual([legacy])
  })

  it('drops entries without a path but keeps the rest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-corpus-'))
    writeIndex(JSON.stringify({ indexedAt: '2026-08-10T00:00:00.000Z', entries: [{ name: 'pathless' }, entry] }))
    const result = await readCorpusIndexFile(dir)
    expect(result.entries).toEqual([entry])
  })

  it('reads unparsable JSON as empty, never a throw', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-corpus-'))
    writeIndex('{not json')
    expect(await readCorpusIndexFile(dir)).toEqual({ indexedAt: null, entries: [] })
  })

  it('reads a shape-invalid envelope as empty', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bp-corpus-'))
    writeIndex(JSON.stringify({ entries: 'nope' }))
    expect(await readCorpusIndexFile(dir)).toEqual({ indexedAt: null, entries: [] })
  })
})

// ── Stale-tier hash caching (#1653) ─────────────────────────────────────────
//
// read() sync-hashes every adjudicated doc + witness on the main process; the
// sweep is cached per root (like driftCache) so a board refresh with an
// unchanged tree re-hashes nothing. Real fs over a temp dir — the behavior
// under test IS whether the files get re-read.
describe('stale-tier hash caching (#1653)', () => {
  let dir: string
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  const sha256 = (content: string): string => createHash('sha256').update(content).digest('hex')
  const tiersPath = (): string => join(dir, 'flow/brain/.structure/file-tiers.json')
  const tiersFor = (docHash: string): string =>
    JSON.stringify({
      entries: [
        {
          path: 'docs/api.md',
          tier: 'claim',
          verdict: { verdict: 'corroborated', docHash, verifiedAgainst: [], ts: '2026-08-17T00:00:00Z' },
        },
      ],
    })
  const seed = (): void => {
    dir = mkdtempSync(join(tmpdir(), 'bp-obs-tiers-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs/api.md'), 'original')
    writeFileSync(tiersPath(), tiersFor(sha256('original')))
  }
  const staleOf = async (observer: BlueprintObserver): Promise<boolean | undefined> =>
    (await observer.read(dir)).tierFiles?.find((file) => file.path === 'docs/api.md')?.stale

  it('serves repeated reads from the cache — no invalidation means no re-hash', async () => {
    seed()
    const observer = new BlueprintObserver(roots)
    expect(await staleOf(observer)).toBeUndefined()
    // Mutate the doc on disk. Nothing invalidated the cache, so the second
    // read must serve the cached sweep instead of re-hashing — the changed
    // bytes stay invisible until an invalidation arrives.
    writeFileSync(join(dir, 'docs/api.md'), 'changed bytes')
    expect(await staleOf(observer)).toBeUndefined()
  })

  it('a changed doc flips stale on the read after invalidation', async () => {
    seed()
    const observer = new BlueprintObserver(roots)
    await observer.read(dir)
    writeFileSync(join(dir, 'docs/api.md'), 'changed bytes')
    observer.invalidateDriftCache(dir) // the git-changed / structure-changed path
    expect(await staleOf(observer)).toBe(true)
  })

  it('a rewritten file-tiers.json bypasses the cache without any event', async () => {
    seed()
    const observer = new BlueprintObserver(roots)
    await observer.read(dir)
    // Re-adjudication rewrites the store; the cache is keyed on the raw
    // content, so the sweep recomputes even when the watcher event races the
    // read — the stale docHash makes the recompute observable.
    writeFileSync(join(dir, 'docs/api.md'), 'changed bytes')
    writeFileSync(tiersPath(), tiersFor(sha256('original')) + '\n')
    expect(await staleOf(observer)).toBe(true)
  })
})

describe('the sibling sweep is not on the read path', () => {
  let dir = ''
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('answers a read without scanning the vault, then carries the sweep', async () => {
    // ~/plan-flow/brain/projects grows by one directory per project ever
    // opened — 4,764 of them on the machine this was written on — and
    // readSiblings opens a file in each, sequentially. Measured at ~2.5s of
    // main-process time PER READ, with the board and the conversation pane
    // firing several at open.
    dir = mkdtempSync(join(tmpdir(), 'bp-sib-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    const observer = new BlueprintObserver(roots)
    const started = Date.now()
    const snap = await observer.read(dir)
    // Whatever the vault holds, the read did not wait for it.
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(snap.siblings === undefined || Array.isArray(snap.siblings)).toBe(true)
  })
})

describe('concurrent reads are one read', () => {
  it('shares a pass rather than repeating it', async () => {
    // Measured live, mid-learn: five reads of the same root, each reported at
    // ~30 s, for one write to one small file — every surface answering the same
    // blueprint:changed with the same work.
    const dir = mkdtempSync(join(tmpdir(), 'bp-share-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/graph.json'),
      JSON.stringify({ version: 1, nodes: [{ id: 'module:src', kind: 'module', label: 'src' }], edges: [] }),
    )
    const observer = new BlueprintObserver({
      getRoots: () => [{ rootPath: dir }],
      onRootsChanged: () => () => undefined,
    })
    try {
      const [a, b, c] = await Promise.all([observer.read(dir), observer.read(dir), observer.read(dir)])
      // The same object, because it was the same pass.
      expect(a).toBe(b)
      expect(b).toBe(c)
      // …and a later read is free to be its own.
      const later = await observer.read(dir)
      expect(later.graph?.nodes).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('a learn run is not a structure change', () => {
  it('marks a burst that only touched learning-state, and reads it cheaply', async () => {
    // The renderer's own stack showed where the full snapshot lands on every
    // one of these: v8::ValueSerializer, deserializing megabytes of graph while
    // the user was doing nothing. A learn run does this hundreds of times.
    const dir = mkdtempSync(join(tmpdir(), 'bp-learnonly-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    writeFileSync(
      join(dir, 'flow/brain/.structure/learning-state.jsonl'),
      `${JSON.stringify({ module: 'src', status: 'learned', notedAt: '2026-08-20T10:00:00.000Z' })}\n`,
    )
    const observer = new BlueprintObserver({
      getRoots: () => [{ rootPath: dir }],
      onRootsChanged: () => () => undefined,
    })
    try {
      // The cheap read answers with the rows and nothing else.
      const learning = await observer.readLearning(dir)
      expect(learning).toHaveLength(1)
      expect(learning?.[0]?.module).toBe('src')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The board's files are read from memory while they have not moved.
 *
 * On a real profile the stage timings put those reads at tens of milliseconds
 * each (`graph:read 71ms`, `learning 61ms`, `crossLinks:providerGraphs 83ms`),
 * re-paid on every refresh — and during a learn run a neighbour of theirs is
 * rewritten hundreds of times, so every refresh re-read all ten. A stat is a
 * fraction of a millisecond and answers the only question that matters.
 *
 * What must never happen: a stale answer. These pin that.
 */
describe('the board read serves cached files, and notices when they change', () => {
  let dir: string
  const roots = {
    getRoots: () => [{ rootPath: dir }],
    onRootsChanged: () => () => undefined,
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bp-cache-'))
    mkdirSync(join(dir, 'flow/brain/.structure'), { recursive: true })
    clearBlueprintFileCache()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const writeGraph = (label: string): void => {
    writeFileSync(
      join(dir, 'flow/brain/.structure/graph.json'),
      JSON.stringify({
        version: 1,
        nodes: [{ id: 'module:one', kind: 'module', label }],
        edges: [],
      }),
    )
  }

  it('reads a story without touching the graph beside it', async () => {
    // The conversation pane wants one field. The full read touches ten files
    // and ships the graph — 1.1 MB on this repository — to hand it over.
    const observer = new BlueprintObserver(roots)
    writeGraph('a graph nobody asked for')
    writeFileSync(
      join(dir, 'flow/brain/.structure/story.json'),
      JSON.stringify({
        plan: 'a-plan',
        sourcePath: 'flow/plans/plan_a_v1.md',
        mode: 'strict',
        steps: [
          {
            id: 'step-1',
            title: 'Step one',
            body: 'what happens',
            anchors: [],
            flow: [],
            phases: [],
            decisions: [],
            rejected: [],
            questions: [],
            unresolvedAnchors: [],
            draft: false,
          },
        ],
        warnings: [],
      }),
    )
    const story = await observer.readStory(dir)
    expect(story?.plan).toBe('a-plan')
  })

  it('answers with nothing when there is no story, rather than failing', async () => {
    const observer = new BlueprintObserver(roots)
    await expect(observer.readStory(dir)).resolves.toBeUndefined()
  })

  it('re-reads a file whose content changed', async () => {
    const observer = new BlueprintObserver(roots)
    writeGraph('before')
    expect((await observer.read(dir)).graph?.nodes[0]?.label).toBe('before')
    // A different size and a later mtime — the ordinary case.
    writeGraph('after-the-edit')
    expect((await observer.read(dir)).graph?.nodes[0]?.label).toBe('after-the-edit')
  })

  it('notices a file that was deleted', async () => {
    const observer = new BlueprintObserver(roots)
    writeGraph('before')
    expect((await observer.read(dir)).graph).not.toBeNull()
    rmSync(join(dir, 'flow/brain/.structure/graph.json'))
    expect((await observer.read(dir)).graph).toBeNull()
  })
})

