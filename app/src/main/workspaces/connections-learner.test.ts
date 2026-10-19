/**
 * The app's half of connections learning: which pairs it checks, when it asks
 * the model, what it hands back to the CLI, and how runs fold together. The
 * CLI and the model are fakes — no process, no network.
 */
import { createConnectionsLearner, parsePairFound, parsePlan, type PlannedPair } from './connections-learner'
import type { ConnectionsLearningStatus } from '../../shared/ipc-contract'

type Call = readonly string[]

function planOut(pairs: PlannedPair[]): string {
  return `${JSON.stringify({ action: 'learn-connections', mode: 'plan', pairs })}\n`
}

function pairOut(code: number, model: number): string {
  return `${JSON.stringify({ action: 'learn-connections', mode: 'pair', code: { recorded: code }, model: { recorded: model } })}\n`
}

function harness(pairs: PlannedPair[], options: { answer?: string | null; automatic?: boolean; workspace?: string | null } = {}) {
  const calls: Call[] = []
  const prompts: string[] = []
  const answers: string[] = []
  const statuses: ConnectionsLearningStatus[] = []
  const learner = createConnectionsLearner({
    runCli: async (_cwd, args) => {
      calls.push(args)
      if (!args.includes('--pair')) return { ok: true, stdout: planOut(pairs) }
      return { ok: true, stdout: pairOut(1, args.includes('--answer') ? 2 : 0) }
    },
    askModel: async ({ prompt }) => {
      prompts.push(prompt)
      return options.answer === undefined ? '{"links":[]}' : options.answer
    },
    workspaceOfRoot: async () => (options.workspace === undefined ? 'team' : options.workspace),
    automatic: () => options.automatic ?? true,
    onStatus: (status) => statuses.push(status),
    writeAnswer: async (text) => {
      answers.push(text)
      return { path: '/tmp/answer.txt', dispose: async () => undefined }
    },
  })
  return { learner, calls, prompts, answers, statuses }
}

const pair = (a: string, b: string, state: PlannedPair['state'], dossier: string | null = null): PlannedPair => ({ pair: [a, b], state, dossier })

describe('connections learner', () => {
  it('checks only pending pairs: the model only where there is a dossier, no-signal elsewhere', async () => {
    const h = harness([pair('app', 'core', 'pending', 'DOSSIER-1'), pair('app', 'mobile', 'pending'), pair('core', 'mobile', 'learned'), pair('a', 'b', 'blocked')])
    const status = await h.learner.learn('/repo/app', 'person')
    expect(h.prompts).toEqual(['DOSSIER-1'])
    expect(h.answers).toEqual(['{"links":[]}'])
    const pairCalls = h.calls.filter((args) => args.includes('--pair'))
    expect(pairCalls.map((args) => args[args.indexOf('--pair') + 1])).toEqual(['app,core', 'app,mobile'])
    expect(pairCalls[0]).toContain('--answer')
    expect(pairCalls[1]).toEqual(expect.arrayContaining(['--model', 'no-signal']))
    expect(status).toEqual({ workspace: 'team', running: false, done: 2, total: 2, found: 4, error: null, current: null })
    // Said at once (before the plan is read), then each pair as it starts and ends, then the end.
    expect(h.statuses.map((s) => `${String(s.running)}:${String(s.done)}:${s.current?.join('+') ?? '-'}`)).toEqual([
      'true:0:-',
      'true:0:-',
      'true:0:app+core',
      'true:1:app+core',
      'true:1:app+mobile',
      'true:2:app+mobile',
      'false:2:-',
    ])
  })

  it('a model that answers nothing is a failed check — recorded, never retried in the same run', async () => {
    const h = harness([pair('app', 'core', 'pending', 'D')], { answer: null })
    await h.learner.learn('/repo/app', 'person')
    const pairCalls = h.calls.filter((args) => args.includes('--pair'))
    expect(pairCalls).toHaveLength(1)
    expect(pairCalls[0]).toEqual(expect.arrayContaining(['--model', 'failed']))
    expect(h.answers).toEqual([])
  })

  it('an automatic run honours the automatic-learning setting; a person’s does not', async () => {
    const off = harness([pair('app', 'core', 'pending')], { automatic: false })
    expect(await off.learner.learn('/repo/app', 'automatic')).toBeNull()
    expect(off.calls).toEqual([])
    expect(await off.learner.learn('/repo/app', 'person')).toMatchObject({ done: 1 })
  })

  it('does nothing for a project in no Workspace', async () => {
    const h = harness([], { workspace: null })
    expect(await h.learner.learn('/repo/app', 'person')).toBeNull()
    expect(h.calls).toEqual([])
  })

  it('folds a second ask into the run in flight — and a person’s ask re-runs once it ends', async () => {
    const h = harness([pair('app', 'core', 'pending')])
    const first = h.learner.learn('/repo/app', 'automatic')
    const joined = h.learner.learn('/repo/core', 'automatic')
    const asked = h.learner.learn('/repo/core', 'person')
    await Promise.all([first, joined, asked])
    // One plan for the run, one for the person's re-run.
    expect(h.calls.filter((args) => !args.includes('--pair'))).toHaveLength(2)
    expect(h.learner.status('team')).toMatchObject({ running: false })
  })

  it('says so when the plan cannot be read', async () => {
    const learner = createConnectionsLearner({
      runCli: async () => ({ ok: false, stdout: '', error: 'boom' }),
      askModel: async () => null,
      workspaceOfRoot: async () => 'team',
      automatic: () => true,
    })
    expect(await learner.learn('/repo/app', 'person')).toMatchObject({ running: false, error: "Flow couldn't read this Workspace's projects." })
  })

  it('narrows the CLI answers', () => {
    expect(parsePlan('noise\n' + planOut([pair('a', 'b', 'pending', 'x'), { pair: ['only'], state: 'pending' } as unknown as PlannedPair]))).toEqual([
      pair('a', 'b', 'pending', 'x'),
    ])
    expect(parsePlan('{"refused":"no-workspace"}')).toBeNull()
    expect(parsePairFound(pairOut(2, 3))).toBe(5)
    expect(parsePairFound('{}')).toBeNull()
  })
})
