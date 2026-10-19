// The chain's gates must ask about the folder the agent actually works in.
//
// Regression (2026-09-30): the gates asked about the project root while a
// thread with its own worktree wrote its discovery document in that
// worktree's `flow/`, so every such chain stopped after discovery. The CLI is
// faked as a table keyed by argv that THROWS on anything else (allowed-pattern
// #24), so these cases assert the question asked, not just the answer.

import type { CliRunResult } from '../agent/learn-session'
import { makeRiskCheck, makeStageCheck } from './chain-gates'
import { STAGE_UNCHECKED } from './stage-gate'

const PROJECT = '/projects/app'
const WORKTREE = '/threads/worktree/fix-it'
const CHAIN = 'chain-abc'
const FEATURE = 'keep-going-bx8h0q'

type Thread = { projectRoot: string; worktreePath: string | null }

function fakeCli(answers: Record<string, CliRunResult>) {
  const calls: Array<{ cwd: string; args: readonly string[] }> = []
  const runCli = async (cwd: string, args: readonly string[]): Promise<CliRunResult> => {
    calls.push({ cwd, args })
    const target = args[args.indexOf('--target') + 1] ?? ''
    const answer = answers[target]
    if (answer === undefined) throw new Error(`unexpected CLI call for target ${target}: ${args.join(' ')}`)
    return answer
  }
  return { calls, runCli }
}

const satisfied = (): CliRunResult =>
  ({
    ok: true,
    stdout: JSON.stringify({ stage: { satisfied: true, chain: CHAIN, feature: FEATURE } }),
    stderr: '',
  }) as CliRunResult

const missing = (): CliRunResult =>
  ({
    ok: false,
    stdout: JSON.stringify({ refused: 'predecessor-missing', message: 'discovery has left no proof' }),
    stderr: '',
  }) as CliRunResult

const edge = { threadId: 't1', chainId: CHAIN, feature: FEATURE, stage: 'create-plan', previous: 'discovery' } as const

describe('stage gate — where it looks', () => {
  let warn: jest.SpyInstance
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => warn.mockRestore())

  it("checks the thread's own worktree, where its discovery document is", async () => {
    // The live shape: the project root has NO proof, the worktree does.
    const cli = fakeCli({ [PROJECT]: missing(), [WORKTREE]: satisfied() })
    const thread: Thread = { projectRoot: PROJECT, worktreePath: WORKTREE }

    const verdict = await makeStageCheck({ getThread: () => thread, runCli: cli.runCli })(edge)

    expect(verdict.ok).toBe(true)
    expect(cli.calls).toEqual([{ cwd: WORKTREE, args: expect.arrayContaining(['--target', WORKTREE]) }])
  })

  it('checks the project itself for a thread without a worktree (unchanged)', async () => {
    const cli = fakeCli({ [PROJECT]: satisfied() })
    const thread: Thread = { projectRoot: PROJECT, worktreePath: null }

    const verdict = await makeStageCheck({ getThread: () => thread, runCli: cli.runCli })(edge)

    expect(verdict.ok).toBe(true)
    expect(cli.calls[0]?.cwd).toBe(PROJECT)
  })

  it('still refuses, in words, when the worktree really has no proof', async () => {
    const cli = fakeCli({ [WORKTREE]: missing() })
    const thread: Thread = { projectRoot: PROJECT, worktreePath: WORKTREE }

    const verdict = await makeStageCheck({ getThread: () => thread, runCli: cli.runCli })(edge)

    expect(cli.calls).toHaveLength(1)
    expect(verdict).toEqual({ ok: false, detail: expect.stringMatching(/left nothing behind/) })
    expect(verdict.detail).not.toMatch(/discovery_|flow\/|--/)
  })

  it("refuses a clearance that names another run's chain", async () => {
    const other = { ok: true, stdout: JSON.stringify({ stage: { satisfied: true, chain: 'x', feature: FEATURE } }), stderr: '' }
    const cli = fakeCli({ [WORKTREE]: other as CliRunResult })
    const thread: Thread = { projectRoot: PROJECT, worktreePath: WORKTREE }

    const verdict = await makeStageCheck({ getThread: () => thread, runCli: cli.runCli })(edge)

    expect(verdict).toEqual({ ok: false, detail: STAGE_UNCHECKED })
  })
})

describe('publish gate — where it looks', () => {
  it("reads the risk record in the thread's own worktree", async () => {
    const cleared = { ok: true, stdout: JSON.stringify({ risk: { satisfied: true, chain: CHAIN } }), stderr: '' }
    const unrecorded = { ok: false, stdout: JSON.stringify({ refused: 'risk-missing' }), stderr: '' }
    const cli = fakeCli({ [PROJECT]: unrecorded as CliRunResult, [WORKTREE]: cleared as CliRunResult })
    const thread: Thread = { projectRoot: PROJECT, worktreePath: WORKTREE }

    const verdict = await makeRiskCheck({ getThread: () => thread, runCli: cli.runCli })({
      threadId: 't1',
      chainId: CHAIN,
      since: '2026-09-30T00:00:00.000Z',
    })

    expect(verdict.ok).toBe(true)
    expect(cli.calls).toEqual([{ cwd: WORKTREE, args: expect.arrayContaining(['--target', WORKTREE]) }])
  })
})
