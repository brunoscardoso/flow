import type { ThreadWorktreeResult } from '../../shared/ipc-contract'
import type { CarryAnswer, CarryQuestion } from './new-thread-branch'
import { prepareThreadWorktree, type PrepareWorktreeAsk } from './prepare-worktree-flow'

type Call = PrepareWorktreeAsk & { carry?: string }

function harness(results: ThreadWorktreeResult[], answer: CarryAnswer) {
  const calls: Call[] = []
  const asked: CarryQuestion[] = []
  const deps = {
    prepare: (request: Call): Promise<ThreadWorktreeResult> => {
      calls.push(request)
      const next = results[calls.length - 1]
      if (next === undefined) throw new Error('prepare called more times than the test expected')
      return Promise.resolve(next)
    },
    askCarry: (question: CarryQuestion): Promise<CarryAnswer> => {
      asked.push(question)
      return Promise.resolve(answer)
    },
  }
  return { calls, asked, deps }
}

const NEEDS: ThreadWorktreeResult = {
  status: 'needs-choice',
  changedFiles: 3,
  baseBranch: 'main',
}
const CREATED: ThreadWorktreeResult = { status: 'created' }

describe('prepareThreadWorktree', () => {
  it('asks nothing and calls once when main did not ask', () => {
    const { calls, asked, deps } = harness([CREATED], 'commit')
    return prepareThreadWorktree(deps, { threadId: 't1' }).then((outcome) => {
      expect(outcome).toEqual({ kind: 'settled', result: CREATED })
      expect(calls).toEqual([{ threadId: 't1' }])
      expect(asked).toEqual([])
    })
  })

  it('relays every non-choice status untouched, including the refusals', () => {
    const refused: ThreadWorktreeResult = { status: 'refused', detail: 'no commits yet' }
    const { deps } = harness([refused], null)
    return prepareThreadWorktree(deps, { threadId: 't1' }).then((outcome) => {
      expect(outcome).toEqual({ kind: 'settled', result: refused })
    })
  })

  it('puts the question on screen and sends back what was pressed', () => {
    const { calls, asked, deps } = harness([NEEDS, CREATED], 'clean')
    return prepareThreadWorktree(deps, { threadId: 't1', requested: true }).then((outcome) => {
      expect(outcome).toEqual({ kind: 'settled', result: CREATED })
      // TWO ANSWERS. The question is "bring your work or not", and it used to
      // offer a third — stash — which is a different outcome, a place to
      // remember and a thing to undo later.
      expect(asked[0]?.rungs.map((rung) => rung.id)).toEqual(['commit', 'clean'])
      expect(calls[1]).toEqual({ threadId: 't1', requested: true, carry: 'clean' })
    })
  })

  it('carries the ask through to the second call, so the branch is not lost', () => {
    const { calls, deps } = harness([NEEDS, CREATED], 'commit')
    const ask: PrepareWorktreeAsk = {
      threadId: 't1',
      requested: true,
      branch: 'thread/parser',
      start: { kind: 'branch', branch: 'develop' },
    }
    return prepareThreadWorktree(deps, ask).then(() => {
      expect(calls[1]).toEqual({ ...ask, carry: 'commit' })
    })
  })

  it('makes NOTHING when the question is dismissed — no second call at all', () => {
    const { calls, deps } = harness([NEEDS], null)
    return prepareThreadWorktree(deps, { threadId: 't1' }).then((outcome) => {
      expect(outcome).toEqual({ kind: 'dismissed' })
      expect(calls).toHaveLength(1)
      expect(calls.some((call) => call.carry !== undefined)).toBe(false)
    })
  })

  it('takes the answer that moves nothing when main asks about work it cannot describe', () => {
    const { calls, asked, deps } = harness([{ status: 'needs-choice', changedFiles: 0 }, CREATED], null)
    return prepareThreadWorktree(deps, { threadId: 't1' }).then((outcome) => {
      expect(outcome).toEqual({ kind: 'settled', result: CREATED })
      // Nobody was shown an empty menu; the only carry chosen without a person
      // is the one that moves none of their files.
      expect(asked).toEqual([])
      expect(calls[1]).toEqual({ threadId: 't1', carry: 'clean' })
    })
  })
})
