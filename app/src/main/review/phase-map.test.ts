// PhaseMap — the review panel's file→phase attribution. Pure classification
// (exact path / directory prefix / glob) plus two file readers (wave-context
// progress log and plan `**Files**:` declarations). No DB, no DOM — node env.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bodyFilePaths,
  featureSlug,
  isConcreteFile,
  matchesGlobToken,
  mergePhaseMap,
  normalizeRel,
  parsePlanPhases,
  qualifyPhase,
  readPhaseMap,
  readPlanPhaseMap,
  readRoundsPhaseMap,
  waveContextPath,
  type FileToPhases,
} from './phase-map'

describe('normalizeRel', () => {
  it('converts backslashes, strips a ./ prefix and leading slashes', () => {
    expect(normalizeRel('app\\src\\a.ts')).toBe('app/src/a.ts')
    expect(normalizeRel('./app/src/a.ts')).toBe('app/src/a.ts')
    expect(normalizeRel('/app/src/a.ts')).toBe('app/src/a.ts')
    expect(normalizeRel('///a.ts')).toBe('a.ts')
  })

  it('leaves an already-relative path untouched', () => {
    expect(normalizeRel('app/src/a.ts')).toBe('app/src/a.ts')
  })
})

describe('featureSlug', () => {
  it('strips plan_ prefix, _vN.md suffix, and hyphenates underscores', () => {
    expect(featureSlug('plan_rainbow_theme_v1.md')).toBe('rainbow-theme')
    expect(featureSlug('plan_user_auth_v10.md')).toBe('user-auth')
  })

  it('handles a version-less plan filename', () => {
    expect(featureSlug('plan_darkmode.md')).toBe('darkmode')
  })
})

describe('qualifyPhase (#144)', () => {
  it('composes a plan-scoped, round-trippable key with a # that a slug never contains', () => {
    const key = qualifyPhase('rainbow-theme', 'phase-2')
    expect(key).toBe('rainbow-theme#phase-2')
    // the # is unambiguous: exactly one, splitting feature from phase
    const [feature, phase] = key.split('#')
    expect(feature).toBe('rainbow-theme')
    expect(phase).toBe('phase-2')
    expect(featureSlug('plan_rainbow_theme_v1.md')).not.toContain('#')
  })
})

describe('matchesGlobToken (#251 directory anchor)', () => {
  it('anchors on the prefix before the first * and the suffix after the last *', () => {
    expect(matchesGlobToken('app/src/review/*.ts', 'app/src/review/x.ts')).toBe(true)
    expect(matchesGlobToken('app/src/review/*.ts', 'app/other/x.ts')).toBe(false) // wrong dir
    expect(matchesGlobToken('app/src/review/*.ts', 'app/src/review/x.tsx')).toBe(false) // wrong suffix
  })

  it('treats a leading-* token as a pure suffix match', () => {
    expect(matchesGlobToken('*.test.ts', 'app/src/a.test.ts')).toBe(true)
    expect(matchesGlobToken('*.test.ts', 'app/src/a.ts')).toBe(false)
  })

  it('length guard rejects a no-middle-segment path for a middle-* token', () => {
    // `app/src/*/index.ts` needs SOMETHING between the slashes — the prefix and
    // suffix must not overlap, so `app/src/index.ts` (which satisfies both ends)
    // is rejected by the length guard.
    expect(matchesGlobToken('app/src/*/index.ts', 'app/src/a/index.ts')).toBe(true)
    expect(matchesGlobToken('app/src/*/index.ts', 'app/src/index.ts')).toBe(false)
  })
})

describe('parsePlanPhases', () => {
  it('parses headings + collects Files tokens same-line and as a bulleted list', () => {
    const text = [
      '## Phase 1 — Types',
      '',
      '**Files**: `app/src/types.ts`',
      '',
      '## Phase 2: Content & markup',
      '',
      '**Files**:',
      '- `app/src/a.ts`',
      '- `app/src/b.ts`',
      '',
      '**Tasks**:',
      '- do the `app/src/UNRELATED.ts` thing', // AFTER the Files boundary → not a file token
    ].join('\n')

    const phases = parsePlanPhases(text)
    const byId = new Map(phases.map((p) => [p.phase, p]))

    expect(byId.get('phase-1')?.title).toBe('Types')
    expect(byId.get('phase-1')?.fileTokens).toEqual(['app/src/types.ts'])

    expect(byId.get('phase-2')?.title).toBe('Content & markup')
    expect(byId.get('phase-2')?.fileTokens).toEqual(['app/src/a.ts', 'app/src/b.ts'])
    // The Tasks-section mention is NEVER a file token (would mis-attribute)…
    expect(byId.get('phase-2')?.fileTokens).not.toContain('app/src/UNRELATED.ts')
    // …but it IS in the body-token superset (feature view only).
    expect(byId.get('phase-2')?.bodyTokens).toContain('app/src/UNRELATED.ts')
  })

  it('accepts the colon-inside variant `**Files:**` that newer plans write (#783)', () => {
    // The exact shape /create-plan generates (seen in plan_drift_v1.md):
    // `### Phase N — Title` + `**Files:** \`a\`, \`b\` (new \`c\`)` on one line.
    const text = [
      '### Phase 1 — Full-graph stamp store + drift-check core (CLI)',
      '**Complexity:** 6',
      '**Dependencies:** none',
      '**Files:** `src/cli/blueprint/` (new `file-stamps.ts`), `src/cli/commands/blueprint.ts`',
      '',
      'The disposable baseline + the broadened detector.',
    ].join('\n')
    const [p] = parsePlanPhases(text)
    expect(p.phase).toBe('phase-1')
    expect(p.fileTokens).toContain('src/cli/blueprint/')
    expect(p.fileTokens).toContain('src/cli/commands/blueprint.ts')
  })

  it('a bold section (**Tasks**) ends the Files section even when indented', () => {
    const text = ['## Phase 3 — X', '**Files**:', '- `keep.ts`', '  **Tasks**:', '- `drop.ts`'].join('\n')
    const [p] = parsePlanPhases(text)
    expect(p.fileTokens).toEqual(['keep.ts'])
  })

  it('merges duplicate phase headings: first title wins, Files tokens accumulate', () => {
    const text = [
      '## Phase 2 — First',
      '**Files**: `a.ts`',
      '## Phase 2 — Second',
      '**Files**: `b.ts`',
    ].join('\n')
    const phases = parsePlanPhases(text)
    expect(phases).toHaveLength(1)
    expect(phases[0].title).toBe('First')
    expect(phases[0].fileTokens).toEqual(['a.ts', 'b.ts'])
  })
})

describe('mergePhaseMap', () => {
  it('unions phases per file, never dropping an earlier run’s attribution', () => {
    const into: FileToPhases = new Map([['a.ts', new Set(['x#phase-1'])]])
    const from: FileToPhases = new Map([
      ['a.ts', new Set(['x#phase-2'])],
      ['b.ts', new Set(['x#phase-3'])],
    ])
    mergePhaseMap(into, from)
    expect([...(into.get('a.ts') ?? [])].sort()).toEqual(['x#phase-1', 'x#phase-2'])
    expect([...(into.get('b.ts') ?? [])]).toEqual(['x#phase-3'])
  })
})

describe('readPhaseMap (wave-context progress attribution)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phasemap-'))
    await mkdir(join(dir, 'flow'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns an empty map when the file is absent', async () => {
    expect((await readPhaseMap(dir)).size).toBe(0)
  })

  it('attributes files by phase, skips non-progress + malformed lines, unions across phases', async () => {
    const lines = [
      JSON.stringify({ type: 'progress', agent: 'phase-1', data: { files_modified: ['./app/a.ts', 'app/b.ts'] } }),
      JSON.stringify({ type: 'decision', agent: 'phase-1', data: { files_modified: ['app/IGNORED.ts'] } }), // not progress
      'not json at all',
      JSON.stringify({ type: 'progress', agent: 'phase-2', data: { files_modified: ['app\\a.ts'] } }), // same file, other phase
      JSON.stringify({ type: 'progress', data: { files_modified: ['app/c.ts'] } }), // no agent → skipped
    ].join('\n')
    await writeFile(waveContextPath(dir), lines, 'utf8')

    const map = await readPhaseMap(dir)
    expect([...(map.get('app/a.ts') ?? [])].sort()).toEqual(['phase-1', 'phase-2']) // normalized + unioned
    expect([...(map.get('app/b.ts') ?? [])]).toEqual(['phase-1'])
    expect(map.has('app/IGNORED.ts')).toBe(false)
    expect(map.has('app/c.ts')).toBe(false)
  })
})

describe('readPlanPhaseMap (plan Files declarations → exact + patterns + meta)', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'planmap-'))
    await mkdir(join(dir, 'flow', 'plans'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('classifies exact files, directory prefixes and globs, scoped by feature (#144)', async () => {
    const plan = [
      '## Phase 1 — Core',
      '**Files**: `app/src/core.ts`, `app/src/legacy/`, `app/src/review/*.ts`',
    ].join('\n')
    await writeFile(join(dir, 'flow', 'plans', 'plan_widget_v1.md'), plan, 'utf8')

    const { exact, patterns, meta } = await readPlanPhaseMap(dir)
    const key = qualifyPhase('widget', 'phase-1')

    // exact path → scoped key in the exact map
    expect([...(exact.get('app/src/core.ts') ?? [])]).toEqual([key])
    // directory prefix and glob → patterns that recognize their members
    expect(patterns.some((p) => p.phase === key && p.test('app/src/legacy/deep/x.ts'))).toBe(true)
    expect(patterns.some((p) => p.phase === key && p.test('app/src/review/panel.ts'))).toBe(true)
    // …and reject non-members
    expect(patterns.some((p) => p.test('app/src/other/x.ts'))).toBe(false)
    // meta carries the phase title + feature slug for commit suggestions
    expect(meta.get(key)).toEqual({ title: 'Core', feature: 'widget' })
  })

  it('two plans with the same bare phase id stay distinct (no #144 collision)', async () => {
    await writeFile(
      join(dir, 'flow', 'plans', 'plan_alpha_v1.md'),
      '## Phase 1 — Alpha\n**Files**: `shared.ts`',
      'utf8',
    )
    await writeFile(
      join(dir, 'flow', 'plans', 'plan_beta_v1.md'),
      '## Phase 1 — Beta\n**Files**: `shared.ts`',
      'utf8',
    )

    const { exact, meta } = await readPlanPhaseMap(dir)
    expect([...(exact.get('shared.ts') ?? [])].sort()).toEqual(['alpha#phase-1', 'beta#phase-1'])
    expect(meta.get('alpha#phase-1')?.title).toBe('Alpha')
    expect(meta.get('beta#phase-1')?.title).toBe('Beta')
  })

  it('returns empty structures when the plans directory does not exist', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'noplans-'))
    try {
      const { exact, patterns, meta } = await readPlanPhaseMap(empty)
      expect(exact.size).toBe(0)
      expect(patterns).toEqual([])
      expect(meta.size).toBe(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('bodyFilePaths (attribution for phases that declare no **Files**:)', () => {
  it('keeps paths a phase’s prose names', () => {
    expect(bodyFilePaths(['app/src/renderer/git/index.ts', 'src/main/review/ipc.ts'])).toEqual([
      'app/src/renderer/git/index.ts',
      'src/main/review/ipc.ts',
    ])
  })

  it('drops a bare basename — a mention in prose is not a declaration', () => {
    // Measured on this repo: rename sentences ("beat-log.ts → run-log.ts")
    // supplied most of the junk, and none of it is path-shaped.
    expect(bodyFilePaths(['run-log.ts', 'loop.md', 'index.ts'])).toEqual([])
  })

  it('drops directories and globs — attribution must not sweep a tree', () => {
    expect(bodyFilePaths(['app/src/renderer/', 'flow/', 'app/src/**/*.ts'])).toEqual([])
  })

  it('drops prose and code that merely looks path-ish', () => {
    expect(bodyFilePaths(['npx tsc --noEmit', 'document.title', 'a/b.unknownext'])).toEqual([])
  })

  it('de-dupes and normalizes', () => {
    expect(bodyFilePaths(['./a/b.ts', 'a/b.ts', 'a\\b.ts'])).toEqual(['a/b.ts'])
  })
})

describe('isConcreteFile', () => {
  it('accepts allowlisted extensions and rejects everything else', () => {
    expect(isConcreteFile('a/b.ts')).toBe(true)
    expect(isConcreteFile('a/b.md')).toBe(true)
    expect(isConcreteFile('a/b/')).toBe(false)
    expect(isConcreteFile('a/*.ts')).toBe(false)
    expect(isConcreteFile('tsc --noEmit')).toBe(false)
    expect(isConcreteFile('document.title')).toBe(false)
  })
})

describe('readPlanPhaseMap — the body-token fallback', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'planbody-'))
    await mkdir(join(dir, 'flow', 'plans'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('attributes a phase that names its files in Tasks instead of **Files**:', async () => {
    // THE REPORTED SHAPE: the plan template emits Scope/Complexity/Dependencies
    // and no Files section, so this phase produced NO attribution at all and
    // every change fell into "Other changes".
    const plan = [
      '### Phase 1: Landing controls',
      '',
      '**Scope**: move the bar into its group',
      '**Complexity**: 4/10',
      '**Dependencies**: None',
      '',
      '- [ ] Move the controls in `app/src/renderer/git/index.ts`',
      '- [ ] Style the band in `app/src/renderer/git/git-panel-styles.ts`',
    ].join('\n')
    await writeFile(join(dir, 'flow', 'plans', 'plan_landing_v1.md'), plan, 'utf8')

    const { exact, meta } = await readPlanPhaseMap(dir)
    const key = qualifyPhase('landing', 'phase-1')
    expect([...(exact.get('app/src/renderer/git/index.ts') ?? [])]).toEqual([key])
    expect([...(exact.get('app/src/renderer/git/git-panel-styles.ts') ?? [])]).toEqual([key])
    expect(meta.get(key)?.title).toBe('Landing controls')
  })

  it('a declared **Files**: wins — its phase never consults its own prose', async () => {
    const plan = [
      '### Phase 1: Declared',
      '**Files**: `app/declared.ts`',
      '',
      '- [ ] Mention `app/mentioned.ts` only as background reading',
    ].join('\n')
    await writeFile(join(dir, 'flow', 'plans', 'plan_decl_v1.md'), plan, 'utf8')

    const { exact } = await readPlanPhaseMap(dir)
    expect(exact.has('app/declared.ts')).toBe(true)
    expect(exact.has('app/mentioned.ts')).toBe(false)
  })

  it('the fallback never contributes a directory rule', async () => {
    const plan = [
      '### Phase 1: Broad',
      '',
      '- [ ] Touch things under `app/src/renderer/` and `flow/`',
    ].join('\n')
    await writeFile(join(dir, 'flow', 'plans', 'plan_broad_v1.md'), plan, 'utf8')

    const { exact, patterns } = await readPlanPhaseMap(dir)
    expect(patterns).toHaveLength(0)
    expect(exact.size).toBe(0)
  })
})

describe('readRoundsPhaseMap — attribution from the execution record', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rounds-map-'))
    await mkdir(join(dir, 'flow', 'archive'), { recursive: true })
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const round = (entry: Record<string, unknown>): string => JSON.stringify(entry)

  it('maps a phase_result\'s file anchors to that plan\'s phase', async () => {
    await writeFile(
      join(dir, 'flow', '.rounds.jsonl'),
      [
        round({ type: 'phase_result', plan: 'refunds', phase: 1, name: 'Branch grammar', anchors: ['app/src/a.ts'] }),
        round({ type: 'phase_result', plan: 'refunds', phase: 2, name: 'The create contract', anchors: ['app/src/b.ts', 'app/src/c.ts'] }),
      ].join('\n'),
      'utf8',
    )
    const { exact, meta } = await readRoundsPhaseMap(dir)
    expect([...(exact.get('app/src/a.ts') ?? [])]).toEqual([qualifyPhase('refunds', 'phase-1')])
    expect([...(exact.get('app/src/b.ts') ?? [])]).toEqual([qualifyPhase('refunds', 'phase-2')])
    expect(meta.get(qualifyPhase('refunds', 'phase-2'))?.title).toBe('The create contract')
  })

  it('reads the ARCHIVED per-plan record too — a finished plan is the whole point', async () => {
    await writeFile(
      join(dir, 'flow', 'archive', 'rounds_refunds.jsonl'),
      round({ type: 'phase_result', plan: 'refunds', phase: 3, name: 'Wiring', anchors: ['app/src/d.ts'] }),
      'utf8',
    )
    const { exact } = await readRoundsPhaseMap(dir)
    expect([...(exact.get('app/src/d.ts') ?? [])]).toEqual([qualifyPhase('refunds', 'phase-3')])
  })

  it('ignores anchors that are module ids rather than paths', async () => {
    // A module anchor would otherwise claim every change under a directory.
    await writeFile(
      join(dir, 'flow', '.rounds.jsonl'),
      round({
        type: 'phase_result',
        plan: 'p',
        phase: 1,
        // A module id, a nested module id, a nested file, and a file at the
        // repository ROOT — which an earlier "must contain a slash" rule threw
        // away, reintroducing the very bug this reader fixes.
        anchors: ['threads', 'renderer/git', 'app/src/a.ts', 'package.json'],
      }),
      'utf8',
    )
    const { exact } = await readRoundsPhaseMap(dir)
    expect([...exact.keys()].sort()).toEqual(['app/src/a.ts', 'package.json'])
  })

  it('survives a torn last line, a non-phase entry and a missing file', async () => {
    await writeFile(
      join(dir, 'flow', '.rounds.jsonl'),
      [
        round({ type: 'risk', plan: 'p', phase: null }),
        round({ type: 'phase_result', plan: 'p', phase: 1, anchors: ['app/ok.ts'] }),
        '{"type":"phase_result","plan":"p","pha', // an append-only log can end mid-write
      ].join('\n'),
      'utf8',
    )
    const { exact } = await readRoundsPhaseMap(dir)
    expect([...exact.keys()]).toEqual(['app/ok.ts'])
    await expect(readRoundsPhaseMap(join(dir, 'nope'))).resolves.toEqual({
      exact: new Map(),
      patterns: [],
      meta: new Map(),
    })
  })

  it('a phase_result with no anchors contributes nothing, and does not throw', async () => {
    // Exactly the shape every real run wrote before this: plan/phase/name/
    // status/summary and no anchors at all.
    await writeFile(
      join(dir, 'flow', '.rounds.jsonl'),
      round({ type: 'phase_result', plan: 'p', phase: 1, name: 'X', status: 'success', summary: 'done' }),
      'utf8',
    )
    const { exact, meta } = await readRoundsPhaseMap(dir)
    expect(exact.size).toBe(0)
    // The phase is still NAMED, so a suggested commit message can use it if the
    // file lands in that group by another source.
    expect(meta.get(qualifyPhase('p', 'phase-1'))?.title).toBe('X')
  })
})
