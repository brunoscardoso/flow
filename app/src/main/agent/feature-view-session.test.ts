// Tests for the feature-view generation pass.
//
// The load-bearing one is `fillCodeExcerpts`: the model names a file and a line
// range, and the executor reads those lines. A drawer showing code that was
// never in the file is the worst failure this surface can have, because it
// looks exactly like proof — so the model's own text must never survive.

import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { BundledCli } from '../blueprint/derive-runner'
import {
  buildFeatureViewPrompt,
  fillCodeExcerpts,
  parseFeatureViewOutput,
  derivePartsFromView,
  resolvePartFiles,
  runFeatureViewPass,
  refusalIsAboutPorts,
  stripViewPorts,
  VIEW_NODE_MAX,
} from './feature-view-session'
import { PORTS_EXAMPLE_LINE } from '../../shared/feature-view-ports-prompt'

const FAKE_CLI: BundledCli = { execPath: '/bin/electron', cliPath: '/app/planflow-ai.mjs' }
const FILES = [{ path: 'src/chat/stream.ts', size: 100 }]

function repoWith(file: string, contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'fv-session-'))
  writeFileSync(join(root, file), contents, 'utf-8')
  return root
}

describe('buildFeatureViewPrompt', () => {
  it('demands human titles and labelled connections', () => {
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    expect(prompt).toContain('never a directory path')
    expect(prompt).toContain('EVERY connection needs a label')
    expect(prompt).toContain(String(VIEW_NODE_MAX))
  })

  it('draws a feature WITHOUT a plan as its parts, not as a change', () => {
    // A feature has no plan, so its brief otherwise falls back to the anchor
    // subgraph: isolated cards named after directories with nothing in them.
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    expect(prompt).toContain('THERE IS NO PLAN FOR THIS FEATURE')
    expect(prompt).toContain('what the feature is')
  })

  it('does NOT say that when a plan was supplied', () => {
    const prompt = buildFeatureViewPrompt({
      featureName: 'Chats',
      rankedFiles: FILES,
      planDocs: ['flow/plans/plan_x_v1.md'],
    })
    expect(prompt).not.toContain('THERE IS NO PLAN FOR THIS FEATURE')
  })

  it('caps the title so it fits on a card, and pushes detail to the sub line', () => {
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    expect(prompt).toContain('AT MOST FOUR WORDS')
    expect(prompt).toContain('drawn ON the wire')
  })

  it('asks for the rollout phases and nested levels the board can navigate', () => {
    // Without these the phase ladder and the drill are dead features: the board
    // renders them from the artifact, and the artifact never carried them.
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    expect(prompt).toContain('`phases` array')
    expect(prompt).toContain('a door onto a wall')
  })

  it('tells the model NOT to quote code — line numbers only', () => {
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    expect(prompt).toContain('Do NOT quote the')
    expect(prompt).toContain('invented evidence')
  })

  it('puts the plan and discovery first, and says the code wins', () => {
    const prompt = buildFeatureViewPrompt({
      featureName: 'Chats',
      rankedFiles: FILES,
      planDocs: ['flow/plans/plan_chat_session_cache_rework_v1.md'],
    })
    expect(prompt).toContain('READ THESE FIRST')
    expect(prompt).toContain('flow/plans/plan_chat_session_cache_rework_v1.md')
    expect(prompt).toContain('the CODE is right')
  })
})

describe('buildFeatureViewPrompt — entries and exits', () => {
  it('asks for each level\'s ports in the CLI\'s own words, after the rules', () => {
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    expect(prompt).toContain('ENTRIES AND EXITS')
    expect(prompt.indexOf('ENTRIES AND EXITS')).toBeGreaterThan(prompt.indexOf('RULES'))
    expect(prompt).toContain('NEVER invent a file or a function')
  })

  it('carries a ports line on the root level of the JSON example', () => {
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    const root = prompt.indexOf('"root": {')
    const ports = prompt.indexOf(PORTS_EXAMPLE_LINE)
    expect(ports).toBeGreaterThan(root)
    expect(ports).toBeLessThan(prompt.indexOf('"nodes": ['))
  })
})

describe('parseFeatureViewOutput', () => {
  it('accepts the agreed shape', () => {
    const parsed = parseFeatureViewOutput('{"views":{"root":{"title":"T","nodes":[],"edges":[]}}}')
    expect(parsed).not.toBeNull()
  })

  it('rejects output with no views — that is not an answer', () => {
    expect(parseFeatureViewOutput('{"meta":{"title":"T"}}')).toBeNull()
    expect(parseFeatureViewOutput('sorry, I could not')).toBeNull()
  })
})

describe('fillCodeExcerpts — the anti-fabrication rule', () => {
  const viewWith = (code: unknown): Record<string, unknown> => ({
    views: { root: { title: 'T', nodes: [{ id: 'a', code }], edges: [] } },
  })
  const codeOf = (view: Record<string, unknown>): Record<string, unknown> | undefined => {
    const nodes = (
      (view['views'] as Record<string, Record<string, unknown>>)['root']['nodes'] as Array<
        Record<string, unknown>
      >
    )[0]
    return nodes['code'] as Record<string, unknown> | undefined
  }

  it('replaces the model text with the REAL lines from disk', () => {
    const root = repoWith('a.ts', 'one\ntwo\nthree\nfour\n')
    const view = viewWith({ file: 'a.ts', from: 2, to: 3, note: 'why', text: 'TOTALLY INVENTED' })

    expect(fillCodeExcerpts(view, root)).toEqual({ dropped: 0 })
    expect(codeOf(view)?.text).toBe('two\nthree')
  })

  it('drops an excerpt whose file does not exist, keeping the component', () => {
    const root = repoWith('a.ts', 'one\n')
    const view = viewWith({ file: 'ghost.ts', from: 1, to: 1, note: 'why', text: 'x' })

    expect(fillCodeExcerpts(view, root)).toEqual({ dropped: 1 })
    expect(codeOf(view)).toBeUndefined()
    // the component survives — it loses a snippet, not its prose
    expect(
      ((view['views'] as Record<string, Record<string, unknown>>)['root']['nodes'] as unknown[]).length,
    ).toBe(1)
  })

  it('drops an excerpt claiming lines past the end of the file', () => {
    const root = repoWith('a.ts', 'one\ntwo\n')
    const view = viewWith({ file: 'a.ts', from: 1, to: 99, note: 'why', text: 'x' })

    expect(fillCodeExcerpts(view, root)).toEqual({ dropped: 1 })
    expect(codeOf(view)).toBeUndefined()
  })

  it('drops a malformed excerpt rather than passing it to the validator', () => {
    const root = repoWith('a.ts', 'one\n')
    const view = viewWith({ file: 'a.ts', note: 'no range' })
    expect(fillCodeExcerpts(view, root)).toEqual({ dropped: 1 })
  })

  it('leaves a view with no excerpts alone', () => {
    const root = repoWith('a.ts', 'one\n')
    const view: Record<string, unknown> = {
      views: { root: { title: 'T', nodes: [{ id: 'a' }], edges: [] } },
    }
    expect(fillCodeExcerpts(view, root)).toEqual({ dropped: 0 })
  })
})

describe('runFeatureViewPass', () => {
  const base = {
    rootPath: '/repo',
    featureRef: 'chats',
    featureName: 'Chats',
    files: FILES,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-08-04T10:00:00.000Z'),
  }
  const good = JSON.stringify({
    meta: { title: 'Chat persistence' },
    brief: {},
    views: {
      root: {
        title: 'Chat persistence',
        nodes: [{ id: 'bff', kind: 'endpoint', title: 'Gateway BFF', delta: 'stable' }],
        edges: [],
      },
    },
  })

  it('writes the view through the CLI, stamping provenance and date', async () => {
    const calls: string[][] = []
    const result = await runFeatureViewPass(
      { ...base, provenance: 'plan:chat_session_cache_rework_v1' },
      {
        runSession: () => Promise.resolve(good),
        runCli: (_cli, _cwd, args) => {
          calls.push([...args])
          return Promise.resolve({ ok: true, stdout: 'features: Chats — view written' })
        },
      },
    )

    expect(result.ok).toBe(true)
    expect(result.components).toBe(1)
    expect(calls[0].slice(0, 5)).toEqual(['blueprint', 'features', 'view', '--feature', 'chats'])
    const written = JSON.parse(calls[0][6]) as Record<string, string>
    expect(written.provenance).toBe('plan:chat_session_cache_rework_v1')
    expect(written.generatedAt).toBe('2026-08-04')
  })

  it('surfaces a contract refusal verbatim — nothing half-drawn reaches the board', async () => {
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(good),
      runCli: () =>
        Promise.resolve({
          ok: false,
          stdout: '',
          error: "features refused: level 'root' has a connection from 'ghost'",
        }),
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("connection from 'ghost'")
  })

  it('retries once when the model does not answer in the agreed shape', async () => {
    let attempt = 0
    const result = await runFeatureViewPass(base, {
      runSession: () => {
        attempt += 1
        return Promise.resolve(attempt === 1 ? 'here you go:' : good)
      },
      runCli: () => Promise.resolve({ ok: true, stdout: '' }),
    })
    expect(attempt).toBe(2)
    expect(result.ok).toBe(true)
  })

  it('fails cleanly when there is nothing to read', async () => {
    const result = await runFeatureViewPass(
      { ...base, files: [] },
      { runSession: () => Promise.resolve(good), runCli: () => Promise.resolve({ ok: true, stdout: '' }) },
    )
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no readable files or documents')
  })
})

/**
 * ONE PASS, BOTH ARTIFACTS — the collapse of the Learn/Draw pair.
 *
 * The picture and the prose came from two independent caged sessions over the
 * SAME ranked files. They come from one read now, and the two writes are
 * independent, so every combination of "which half landed" has to be reportable.
 */
describe('runFeatureViewPass — the prose half', () => {
  const base = {
    rootPath: '/repo',
    featureRef: 'chats',
    featureName: 'Chats',
    files: FILES,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-08-04T10:00:00.000Z'),
  }
  const view = {
    meta: { title: 'Chat persistence' },
    brief: {},
    views: {
      root: {
        title: 'Chat persistence',
        nodes: [{ id: 'bff', kind: 'endpoint', title: 'Gateway BFF', delta: 'stable' }],
        edges: [],
      },
    },
  }
  const withLearnings = JSON.stringify({
    ...view,
    learnings: ['Offsets commit once per poll batch.', 'Reload can duplicate a completed turn.'],
  })
  const noLearnings = JSON.stringify(view)

  /** Every CLI invocation the pass made, in order. */
  const capture = (): { calls: string[][]; runCli: (c: unknown, d: unknown, a: readonly string[]) => Promise<{ ok: boolean; stdout: string }> } => {
    const calls: string[][] = []
    return {
      calls,
      runCli: (_cli, _cwd, args) => {
        calls.push([...args])
        return Promise.resolve({ ok: true, stdout: '' })
      },
    }
  }

  it('writes BOTH artifacts from one session', async () => {
    const { calls, runCli } = capture()
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(withLearnings),
      runCli: runCli as never,
    })

    expect(result.ok).toBe(true)
    expect(result.components).toBe(1)
    expect(result.learnings).toBe(2)
    // ONE session for two writes — the waste the collapse removed.
    expect(calls).toHaveLength(2)
    expect(calls[0].slice(0, 3)).toEqual(['blueprint', 'features', 'view'])
    expect(calls[1].slice(0, 5)).toEqual([
      'blueprint',
      'features',
      'learned',
      '--feature',
      'chats',
    ])
    const entries = calls[1].filter((_arg, i) => calls[1][i - 1] === '--entry').map(
      (raw) => JSON.parse(raw) as { text: string; provenance: string; date: string },
    )
    expect(entries.map((e) => e.text)).toEqual([
      'Offsets commit once per poll batch.',
      'Reload can duplicate a completed turn.',
    ])
    expect(entries[0].date).toBe('2026-08-04')
    expect(entries[0].provenance).toBe('code')
  })

  it('never lets the learnings ride along inside the stored artifact', async () => {
    const { calls, runCli } = capture()
    await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(withLearnings),
      runCli: runCli as never,
    })
    const written = JSON.parse(calls[0][6]) as Record<string, unknown>
    expect(written.learnings).toBeUndefined()
  })

  it('writes nothing to `## Learned` when the pass found nothing non-obvious', async () => {
    const { calls, runCli } = capture()
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(noLearnings),
      runCli: runCli as never,
    })
    expect(result.ok).toBe(true)
    expect(result.learnings).toBe(0)
    expect(result.learningsFailed).toBeUndefined()
    // The section keeps whatever it had rather than being emptied by a quiet pass.
    expect(calls).toHaveLength(1)
  })

  // PARTIAL, HALF ONE: the picture landed and the prose was refused. Reported on
  // the SUCCESS path — the board lights up either way now, so a silent refusal
  // here would be invisible forever.
  it('reports a refused learnings write even though the drawing landed', async () => {
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(withLearnings),
      runCli: (_cli, _cwd, args) =>
        args[2] === 'learned'
          ? Promise.resolve({ ok: false, stdout: '', error: 'ambiguous ## Learned boundary' })
          : Promise.resolve({ ok: true, stdout: '' }),
    })
    expect(result.ok).toBe(true)
    expect(result.components).toBe(1)
    expect(result.learnings).toBe(0)
    expect(result.learningsFailed).toBe(true)
    expect(result.reason).toContain('the drawing landed, but the learnings were refused')
    expect(result.reason).toContain('ambiguous ## Learned boundary')
  })

  // PARTIAL, HALF TWO: the validator refused the picture and the prose survived.
  // "could not write the view" alone would leave a user believing the whole pass
  // produced nothing while their `## Learned` section had just grown.
  it('names what survived when the drawing is refused', async () => {
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(withLearnings),
      runCli: (_cli, _cwd, args) =>
        args[2] === 'view'
          ? Promise.resolve({ ok: false, stdout: '', error: "connection from 'ghost'" })
          : Promise.resolve({ ok: true, stdout: '' }),
    })
    expect(result.ok).toBe(false)
    expect(result.learnings).toBe(2)
    expect(result.reason).toContain("connection from 'ghost'")
    expect(result.reason).toContain('2 learning(s) were still written')
  })

  it('names BOTH refusals when neither half landed', async () => {
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(withLearnings),
      runCli: () => Promise.resolve({ ok: false, stdout: '', error: 'the CLI exploded' }),
    })
    expect(result.ok).toBe(false)
    expect(result.learnings).toBe(0)
    expect(result.learningsFailed).toBe(true)
    expect(result.reason).toContain('could not write the view')
    expect(result.reason).toContain('the learnings were refused too')
  })
})

describe('fillCodeExcerpts — a code excerpt must be code', () => {
  it('drops an excerpt citing a plan or discovery document', () => {
    // The pass reads those documents for the WHY, and the model cites them as
    // evidence. The lines are real, but a code box rendering prose presents an
    // argument as an implementation.
    const root = mkdtempSync(join(tmpdir(), 'fv-doc-'))
    writeFileSync(join(root, 'discovery_x_v1.md'), 'line one\nline two\n', 'utf-8')
    const view: Record<string, unknown> = {
      views: {
        root: {
          title: 'T',
          nodes: [{ id: 'a', code: { file: 'discovery_x_v1.md', from: 1, to: 2, note: 'why', text: 'x' } }],
          edges: [],
        },
      },
    }
    expect(fillCodeExcerpts(view, root)).toEqual({ dropped: 1 })
    const node = (view['views'] as Record<string, Record<string, unknown>>)['root']['nodes'] as Array<
      Record<string, unknown>
    >
    expect(node[0]['code']).toBeUndefined()
    expect(node[0]['id']).toBe('a') // the component survives
  })
})

describe('derivePartsFromView', () => {
  const viewWith = (nodes: unknown[]): unknown => ({ views: { root: { title: 'T', nodes, edges: [] } } })

  it('turns a component into a part, taking its anchors from what it CITED', () => {
    const parts = derivePartsFromView(
      viewWith([
        {
          id: 'sse',
          title: 'Live events SSE',
          doc: 'The reconnect channel. It replays buffered deltas.',
          code: { file: 'src/app/api/chat/events/route.ts', from: 1, to: 4, note: 'n', text: 'x' },
          refs: [['src/lib/redis/stream.ts', 'the buffer'], ['publishChatEvent', 'a symbol']],
        },
      ]),
    )
    expect(parts).toHaveLength(1)
    expect(parts[0].name).toBe('Live events SSE')
    expect(parts[0].anchors).toEqual(['src/app/api/chat/events/route.ts', 'src/lib/redis/stream.ts'])
    // A symbol is prose — it cannot be read from disk, so it is not an anchor.
    expect(parts[0].anchors).not.toContain('publishChatEvent')
  })

  it('takes ONE clause as the summary, not the whole paragraph', () => {
    const parts = derivePartsFromView(
      viewWith([
        { id: 'a', title: 'A', doc: 'First clause. Second clause.', code: { file: 'a.ts', from: 1, to: 1, note: 'n', text: 'x' } },
      ]),
    )
    expect(parts[0].summary).toBe('First clause.')
  })

  it('DROPS a component that cited nothing — a part nobody can check is worse than no part', () => {
    const parts = derivePartsFromView(viewWith([{ id: 'a', title: 'Vague thing', doc: 'words' }]))
    expect(parts).toEqual([])
  })

  it('never guesses anchors from a name', () => {
    const parts = derivePartsFromView(viewWith([{ id: 'sse', title: 'src/app/api/chat' }]))
    expect(parts).toEqual([])
  })

  it('claims nothing for a missing or malformed view', () => {
    expect(derivePartsFromView(null)).toEqual([])
    expect(derivePartsFromView({})).toEqual([])
    expect(derivePartsFromView({ views: { root: { nodes: 'nope' } } })).toEqual([])
  })
})

describe('resolvePartFiles — a file anchor and a directory anchor differ', () => {
  const enumerate = jest.fn(async (_root: string, dir: string) => ({
    files: [{ path: `${dir}/a.ts`, size: 10 }, { path: `${dir}/b.ts`, size: 20 }],
  }))
  const stat = (map: Record<string, { isFile: boolean; size: number }>) => (abs: string) => {
    for (const [key, value] of Object.entries(map)) if (abs.endsWith(key)) return value
    return null
  }

  it('reads a FILE anchor directly — the case the drawing produces most', () => {
    // REGRESSION. File anchors were handed to a directory walker, so ten parts
    // were learned from ten empty file lists: ten model passes, zero findings,
    // and nothing anywhere saying so.
    return resolvePartFiles('/repo', ['src/chat/stream.ts'], {
      stat: stat({ 'src/chat/stream.ts': { isFile: true, size: 42 } }),
      enumerate,
    }).then((result) => {
      expect(result.files).toEqual([{ path: 'src/chat/stream.ts', size: 42 }])
      expect(result.missing).toEqual([])
    })
  })

  it('walks a DIRECTORY anchor', async () => {
    const result = await resolvePartFiles('/repo', ['src/chat'], {
      stat: stat({ 'src/chat': { isFile: false, size: 0 } }),
      enumerate,
    })
    expect(result.files.map((f) => f.path)).toEqual(['src/chat/a.ts', 'src/chat/b.ts'])
  })

  it('mixes both, without reading a file twice', async () => {
    const result = await resolvePartFiles('/repo', ['src/chat', 'src/chat/a.ts'], {
      stat: stat({ 'src/chat/a.ts': { isFile: true, size: 10 }, 'src/chat': { isFile: false, size: 0 } }),
      enumerate,
    })
    expect(result.files.map((f) => f.path)).toEqual(['src/chat/a.ts', 'src/chat/b.ts'])
  })

  it('SKIPS an anchor that no longer exists and names it, rather than failing', async () => {
    const result = await resolvePartFiles('/repo', ['gone.ts', 'src/chat/a.ts'], {
      stat: stat({ 'src/chat/a.ts': { isFile: true, size: 10 } }),
      enumerate,
    })
    expect(result.missing).toEqual(['gone.ts'])
    expect(result.files).toHaveLength(1)
  })

  it('reports nothing readable when no anchor resolves', async () => {
    const result = await resolvePartFiles('/repo', ['gone.ts'], { stat: () => null, enumerate })
    expect(result.files).toEqual([])
    expect(result.missing).toEqual(['gone.ts'])
  })
})

// ── The relationship half (file-based-brain phase 2) ────────────────────────
//
// This is the pass that actually learns a feature in the IDE, so it is the one
// that has to be able to name the other side — and to write the mechanism down
// while it is still looking at it.

describe('runFeatureViewPass — relationships', () => {
  const base = {
    rootPath: '/repo',
    featureRef: 'playbooks',
    featureName: 'Playbooks',
    files: FILES,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-08-11T10:00:00.000Z'),
  }
  const ROSTER = [
    { id: 'feature:skills', name: 'Skills', kind: 'core' as const, summary: 'a reusable instruction set' },
    { id: 'feature:playbooks', name: 'Playbooks', kind: 'core' as const, summary: '' },
  ]
  const view = {
    meta: { title: 'Playbooks' },
    views: { root: { title: 'Playbooks', nodes: [{ id: 'a', kind: 'module', title: 'Binder', delta: 'stable' }], edges: [] } },
  }
  const reply = JSON.stringify({
    ...view,
    learnings: ['A playbook step is bound at authoring time.'],
    relates: [
      {
        target: 'feature:skills',
        via: 'src/playbooks/binder.ts',
        note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
      },
    ],
  })

  it('carries the roster into the prompt and never the feature itself', async () => {
    let prompt = ''
    await runFeatureViewPass(
      { ...base, roster: ROSTER },
      {
        runSession: (params) => {
          prompt = params.prompt
          return Promise.resolve(reply)
        },
        runCli: (() => Promise.resolve({ ok: true, stdout: '' })) as never,
      },
    )
    expect(prompt).toContain('- feature:skills — Skills')
    expect(prompt).not.toContain('- feature:playbooks — Playbooks')
    expect(prompt).toContain('"relates"')
  })

  it('writes the edges on the SAME learned write, and never into the artifact', async () => {
    const calls: string[][] = []
    const result = await runFeatureViewPass(
      { ...base, roster: ROSTER },
      {
        runSession: () => Promise.resolve(reply),
        runCli: ((_cli: unknown, _cwd: unknown, args: readonly string[]) => {
          calls.push([...args])
          return Promise.resolve({ ok: true, stdout: '' })
        }) as never,
      },
    )
    expect(result.ok).toBe(true)
    const learnedCall = calls.find((args) => args[2] === 'learned') ?? []
    const relatesIndex = learnedCall.indexOf('--relates')
    expect(relatesIndex).toBeGreaterThan(-1)
    expect(JSON.parse(learnedCall[relatesIndex + 1])).toEqual([
      {
        target: 'feature:skills',
        via: 'src/playbooks/binder.ts',
        note: 'a playbook step names a skill by slug; the binder resolves it at authoring time',
      },
    ])
    // The picture is validated as a picture — a stray `relates` key riding
    // along in it would be a second, unvalidated place the edge lives.
    const written = JSON.parse((calls.find((args) => args[2] === 'view') ?? [])[6]) as Record<string, unknown>
    expect(written.relates).toBeUndefined()
  })

  it('asks for no relationship when the project has no other feature to name', async () => {
    let prompt = ''
    await runFeatureViewPass(base, {
      runSession: (params) => {
        prompt = params.prompt
        return Promise.resolve(JSON.stringify(view))
      },
      runCli: (() => Promise.resolve({ ok: true, stdout: '' })) as never,
    })
    expect(prompt).not.toContain('"relates"')
  })
})


/**
 * A BAD PORT MUST NOT COST THE PICTURE. The validator refuses the whole view
 * over one port; the pass strips the ports and writes once more.
 */
describe('runFeatureViewPass — port refusals', () => {
  const base = {
    rootPath: '/repo',
    featureRef: 'chats',
    featureName: 'Chats',
    files: FILES,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-08-04T10:00:00.000Z'),
  }
  const withPorts = JSON.stringify({
    meta: { title: 'Chats' },
    brief: {},
    views: {
      root: {
        title: 'Chats',
        nodes: [{ id: 'bff', kind: 'endpoint', title: 'BFF', delta: 'stable' }],
        edges: [],
        ports: { in: [{ crosses: 'chat request', node: 'ghost', far: { feature: 'x' } }] },
      },
    },
  })

  it('recognises the validator\'s port wording, and nothing else', () => {
    expect(refusalIsAboutPorts({ error: "features refused: level 'root' in-port 1 touches 'ghost', which is not a component here" })).toBe(true)
    expect(refusalIsAboutPorts({ error: 'x', stderr: "features refused: level 'root' ports.out is not a list" })).toBe(true)
    expect(refusalIsAboutPorts({ error: "features refused: level 'root' has a connection from 'ghost'" })).toBe(false)
  })

  it('strips ports from every level and counts them', () => {
    const view = JSON.parse(withPorts) as Record<string, unknown>
    expect(stripViewPorts(view)).toBe(1)
    expect(JSON.stringify(view)).not.toContain('ports')
  })

  it('writes the view again without ports when the refusal is about ports, and reports the drop', async () => {
    const writes: string[] = []
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(withPorts),
      runCli: (_cli, _cwd, args) => {
        if (args[2] !== 'view') return Promise.resolve({ ok: true, stdout: '' })
        writes.push(args[6])
        return Promise.resolve(
          writes.length === 1
            ? { ok: false, stdout: '', error: "features refused: level 'root' in-port 1 touches 'ghost', which is not a component here" }
            : { ok: true, stdout: '' },
        )
      },
    })
    expect(writes).toHaveLength(2)
    expect(writes[0]).toContain('"ports"')
    expect(writes[1]).not.toContain('"ports"')
    expect(result.ok).toBe(true)
    expect(result.reason).toContain('1 entry/exit port(s) dropped')
  })

  it('does not retry a refusal that is not about ports', async () => {
    let writes = 0
    const result = await runFeatureViewPass(base, {
      runSession: () => Promise.resolve(withPorts),
      runCli: (_cli, _cwd, args) => {
        if (args[2] !== 'view') return Promise.resolve({ ok: true, stdout: '' })
        writes += 1
        return Promise.resolve({ ok: false, stdout: '', error: "features refused: level 'root' has a connection from 'ghost'" })
      },
    })
    expect(writes).toBe(1)
    expect(result.ok).toBe(false)
  })
})
