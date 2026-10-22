// Learn writes the role (plan `feature-type-icons`, Phase 3, FR-3 / FR-5).
//
// One more field in the SAME reply, never a second model call; written through
// the one learnedRole verb, after the learnings; and an unusable role never
// costs the pass anything — not the facts, not the picture.

import type { BundledCli } from '../blueprint/derive-runner'
import {
  buildFeatureLearnPrompt,
  buildLearnedRoleArgs,
  parseFeatureLearnRole,
  runFeatureLearnPass,
  type CliRunResult,
} from './learn-session'
import { featureRolePromptLines, normaliseFeatureRole } from './feature-role-prompt'
import {
  buildFeatureViewPrompt,
  derivePartsFromView,
  runFeatureViewPass,
  sanitizeViewRoles,
} from './feature-view-session'
import { FEATURE_ROLES } from '../../shared/feature-role'

const FAKE_CLI: BundledCli = { execPath: '/bin/electron', cliPath: '/app/planflow-ai.mjs' }
const FILES = [{ path: 'src/chat/stream.ts', size: 100 }]

function recordingCli(answer: (args: readonly string[]) => CliRunResult = () => ({ ok: true, stdout: '' })): {
  calls: string[][]
  runCli: (cli: BundledCli, cwd: string, args: readonly string[]) => Promise<CliRunResult>
} {
  const calls: string[][] = []
  return {
    calls,
    runCli: (_cli, _cwd, args) => {
      calls.push([...args])
      return Promise.resolve(answer(args))
    },
  }
}

const isRoleWrite = (args: readonly string[]): boolean => args[0] === 'blueprint' && args[1] === 'features' && args[2] === 'role'

describe('the role ask', () => {
  it('lists every role and says how to choose', () => {
    const lines = featureRolePromptLines('this feature').join('\n')
    for (const role of FEATURE_ROLES) expect(lines).toContain(`- ${role}:`)
    expect(lines).toContain('what it IS')
    expect(lines).toContain('"neutral"')
  })

  it('is in the feature learn prompt, inside the same JSON reply', () => {
    const prompt = buildFeatureLearnPrompt({ featureName: 'Chats', rankedFiles: FILES })
    for (const role of FEATURE_ROLES) expect(prompt).toContain(`- ${role}:`)
    expect(prompt).toMatch(/\{ "learnings": \[[^\n]*"role": "<one word from the role list>"/)
  })

  it('is in the feature-view prompt — once for the feature, optionally per component', () => {
    const prompt = buildFeatureViewPrompt({ featureName: 'Chats', rankedFiles: FILES })
    for (const role of FEATURE_ROLES) expect(prompt).toContain(`- ${role}:`)
    expect(prompt).toContain('"role": "<one word from the role list — the feature as a whole>"')
    expect(prompt).toContain('"sub": "streamTurn", "role": "api"')
    expect(prompt).toContain('Give each component its own optional "role"')
  })
})

describe('parseFeatureLearnRole', () => {
  it('reads a role on the list', () => {
    expect(parseFeatureLearnRole('{"learnings":[],"role":"api"}')).toBe('api')
  })

  it('normalises case and whitespace', () => {
    expect(parseFeatureLearnRole('{"role":"  UI "}')).toBe('ui')
    expect(normaliseFeatureRole('Data')).toBe('data')
  })

  it('reads a role off the list as none', () => {
    expect(parseFeatureLearnRole('{"role":"frontend"}')).toBeNull()
    expect(parseFeatureLearnRole('{"role":7}')).toBeNull()
  })

  it('reads a missing role, or no JSON, as none', () => {
    expect(parseFeatureLearnRole('{"learnings":["x"]}')).toBeNull()
    expect(parseFeatureLearnRole('no json here')).toBeNull()
    expect(parseFeatureLearnRole('')).toBeNull()
  })
})

describe('buildLearnedRoleArgs', () => {
  it('names the verb, the feature and the role', () => {
    expect(buildLearnedRoleArgs('chats', 'api')).toEqual([
      'blueprint', 'features', 'role', '--feature', 'chats', '--learned', 'api', '--json',
    ])
  })
  it('adds --part only when given one', () => {
    expect(buildLearnedRoleArgs('chats', 'ui', 'SSE stream')).toContain('--part')
  })
})

describe('runFeatureLearnPass — the role', () => {
  const base = {
    rootPath: '/repo',
    featureRef: 'chats',
    featureName: 'Chats',
    files: FILES,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-10-22T10:00:00.000Z'),
  }

  it('writes the role through the verb AFTER the learnings', async () => {
    const cli = recordingCli()
    const result = await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":["a fact"],"role":"API"}'),
      runCli: cli.runCli,
    })
    expect(result.ok).toBe(true)
    expect(result.role).toBe('api')
    expect(result.roleWritten).toBe(true)
    expect(cli.calls).toHaveLength(2)
    expect(cli.calls[0].slice(0, 3)).toEqual(['blueprint', 'features', 'learned'])
    expect(cli.calls[1]).toEqual(buildLearnedRoleArgs('chats', 'api'))
  })

  it('writes NOTHING for a role off the list, and the learnings still land', async () => {
    const cli = recordingCli()
    const result = await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":["a fact"],"role":"frontend"}'),
      runCli: cli.runCli,
    })
    expect(result.ok).toBe(true)
    expect(result.role).toBeUndefined()
    expect(cli.calls.some(isRoleWrite)).toBe(false)
    expect(cli.calls).toHaveLength(1)
  })

  it('writes nothing when the reply names no role', async () => {
    const cli = recordingCli()
    await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":["a fact"]}'),
      runCli: cli.runCli,
    })
    expect(cli.calls.some(isRoleWrite)).toBe(false)
  })

  it('a refused role never fails the pass', async () => {
    const cli = recordingCli((args) => (isRoleWrite(args) ? { ok: false, stdout: '', error: 'features refused: role' } : { ok: true, stdout: '' }))
    const result = await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":["a fact"],"role":"data"}'),
      runCli: cli.runCli,
    })
    expect(result.ok).toBe(true)
    expect(result.learnings).toEqual(['a fact'])
    expect(result.roleWritten).toBe(false)
  })

  it('still records the role when there is nothing non-obvious to learn', async () => {
    const cli = recordingCli()
    const result = await runFeatureLearnPass(base, {
      runSession: () => Promise.resolve('{"learnings":[],"role":"config"}'),
      runCli: cli.runCli,
    })
    expect(result.ok).toBe(true)
    expect(cli.calls).toEqual([buildLearnedRoleArgs('chats', 'config')])
  })

  it('a PART pass (collect-only) returns its role and writes nothing — the parts write carries it', async () => {
    const cli = recordingCli()
    const result = await runFeatureLearnPass(
      { ...base, collectOnly: true },
      { runSession: () => Promise.resolve('{"learnings":["a fact"],"role":"jobs"}'), runCli: cli.runCli },
    )
    expect(result.role).toBe('jobs')
    expect(cli.calls).toEqual([])
  })
})

describe('runFeatureViewPass — the role', () => {
  const base = {
    rootPath: '/repo',
    featureRef: 'chats',
    featureName: 'Chats',
    files: FILES,
    bundledCli: FAKE_CLI,
    now: () => new Date('2026-10-22T10:00:00.000Z'),
  }
  const reply = (patch: Record<string, unknown>, nodes: unknown[]): string =>
    JSON.stringify({
      meta: { title: 'Chats' },
      brief: {},
      learnings: ['a fact'],
      views: { root: { title: 'Chats', nodes, edges: [] } },
      ...patch,
    })

  it("writes the feature's role through the verb, and never stores it in the view", async () => {
    const cli = recordingCli()
    const result = await runFeatureViewPass(base, {
      runSession: () =>
        Promise.resolve(reply({ role: 'service' }, [{ id: 'bff', kind: 'endpoint', title: 'BFF', delta: 'stable', role: 'API' }])),
      runCli: cli.runCli,
    })
    expect(result.ok).toBe(true)
    expect(result.role).toBe('service')
    expect(result.roleWritten).toBe(true)
    expect(cli.calls.map((args) => args[2])).toEqual(['view', 'learned', 'role'])
    expect(cli.calls[2]).toEqual(buildLearnedRoleArgs('chats', 'service'))
    const written = JSON.parse(cli.calls[0][cli.calls[0].indexOf('--write') + 1]) as {
      role?: unknown
      views: { root: { nodes: Array<{ role?: unknown }> } }
    }
    expect(written.role).toBeUndefined()
    // The component's role is normalised and kept.
    expect(written.views.root.nodes[0].role).toBe('api')
  })

  it("drops a component's off-list role instead of losing the picture to the validator", async () => {
    const cli = recordingCli()
    await runFeatureViewPass(base, {
      runSession: () =>
        Promise.resolve(reply({}, [{ id: 'bff', kind: 'endpoint', title: 'BFF', delta: 'stable', role: 'frontend' }])),
      runCli: cli.runCli,
    })
    const written = JSON.parse(cli.calls[0][cli.calls[0].indexOf('--write') + 1]) as {
      views: { root: { nodes: Array<Record<string, unknown>> } }
    }
    expect('role' in written.views.root.nodes[0]).toBe(false)
    expect(cli.calls.some(isRoleWrite)).toBe(false)
  })

  it('sanitizeViewRoles normalises every level and counts what it dropped', () => {
    const view: Record<string, unknown> = {
      views: {
        root: { nodes: [{ id: 'a', role: 'UI' }, { id: 'b', role: 'nope' }, { id: 'c' }] },
        inner: { nodes: [{ id: 'd', role: 3 }] },
      },
    }
    expect(sanitizeViewRoles(view)).toBe(2)
    const views = view['views'] as Record<string, { nodes: Array<Record<string, unknown>> }>
    expect(views['root'].nodes.map((node) => node['role'])).toEqual(['ui', undefined, undefined])
    expect('role' in views['inner'].nodes[0]).toBe(false)
  })
})

describe('derivePartsFromView — the role', () => {
  const viewWith = (nodes: unknown[]): unknown => ({ views: { root: { title: 'T', nodes, edges: [] } } })
  const code = { file: 'src/a.ts', from: 1, to: 1, note: 'n', text: 'x' }

  it("carries the component's role as the part's learnedRole", () => {
    const parts = derivePartsFromView(viewWith([{ id: 'a', title: 'History store', code, role: 'data' }]))
    expect(parts[0].learnedRole).toBe('data')
  })

  it('carries no learnedRole for a component with none, or one off the list', () => {
    const parts = derivePartsFromView(
      viewWith([
        { id: 'a', title: 'A', code },
        { id: 'b', title: 'B', code, role: 'frontend' },
      ]),
    )
    expect(parts.map((part) => 'learnedRole' in part)).toEqual([false, false])
  })
})
