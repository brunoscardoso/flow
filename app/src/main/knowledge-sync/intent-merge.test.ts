/**
 * settleIntentAsks — the agent merge of a pause made only of intent documents.
 * The agent and the CLI resolve are fakes that record what they were asked.
 */

import type { EngineTimers } from './sync-timing'
import {
  CANNOT_MERGE,
  allAgentMergeable,
  documentTitle,
  intentKindOf,
  intentMergePrompt,
  settleIntentAsks,
  usableMergedText,
  type IntentItem,
  type IntentMergeDeps,
  type IntentMergeInput,
} from './intent-merge'
import type { WorkspaceSyncAsk, WorkspaceSyncReview } from '../../shared/workspaces-contract'

const DECISION = 'projects/api/brain/decisions/queue.md'
const PLAN = 'projects/api/plans/plan_queue_v1.md'

const ASK: WorkspaceSyncAsk = {
  id: 'ask-1',
  kind: 'decision',
  topic: 'api/decisions/queue',
  path: DECISION,
  existingPath: DECISION,
  existing: '# Queue\n\nSQS.\n',
  incoming: '# Queue\n\nKafka.\n',
  merged: null,
  agentMergeable: true,
  base: '# Queue\n\nNone.\n',
  theirAuthor: 'Bea',
  truncated: false,
  options: ['ours', 'theirs', 'file'],
}

const REVIEW: WorkspaceSyncReview = {
  id: 'review-1',
  kind: 'conflict',
  path: PLAN,
  base: '# Plan\n',
  existing: '# Plan\n\nPhase B.\n',
  incoming: '# Plan\n\nPhase A.\n',
  conflicted: null,
  agentMergeable: true,
  theirAuthor: null,
  truncated: false,
  options: ['ours', 'theirs', 'file'],
}

/** Timers that never fire on their own; `fire()` runs every armed one (a timeout). */
class ManualTimers implements EngineTimers {
  readonly armed = new Map<number, () => void>()
  private seq = 0
  setTimeout(callback: () => void): unknown {
    this.seq += 1
    this.armed.set(this.seq, callback)
    return this.seq
  }
  clearTimeout(handle: unknown): void {
    this.armed.delete(handle as number)
  }
  fire(): void {
    for (const [id, callback] of [...this.armed]) {
      this.armed.delete(id)
      callback()
    }
  }
}

function harness(answers: Array<string | null | Error | 'hang'>, resolveAnswers: boolean[] = []) {
  const timers = new ManualTimers()
  const asked: IntentMergeInput[] = []
  const resolved: Array<{ id: string; text: string }> = []
  const deps: IntentMergeDeps = {
    merge: async (input) => {
      asked.push(input)
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      if (answer === 'hang') return new Promise<string | null>(() => undefined)
      return answer ?? null
    },
    resolve: async (item, text) => {
      resolved.push({ id: item.id, text })
      return resolveAnswers.shift() ?? true
    },
    timers,
    timeoutMs: 1000,
    log: () => undefined,
  }
  return { deps, timers, asked, resolved }
}

describe('settleIntentAsks', () => {
  it('every item agent-mergeable → one merged text each, every one resolved, and what Undo needs returned', async () => {
    const h = harness(['# Queue\n\nSQS and Kafka.', '# Plan\n\nPhase A, then B.\n'])
    const outcome = await settleIntentAsks('acme', [ASK, REVIEW], h.deps)
    // Positive first: the agent saw both sides and the base.
    expect(h.asked.map((input) => [input.kind, input.title, input.ours, input.theirs, input.base])).toEqual([
      ['decision', 'Queue', ASK.incoming, ASK.existing, ASK.base],
      ['plan', 'Plan', REVIEW.incoming, REVIEW.existing, REVIEW.base],
    ])
    expect(h.resolved).toEqual([
      { id: 'ask-1', text: '# Queue\n\nSQS and Kafka.\n' },
      { id: 'review-1', text: '# Plan\n\nPhase A, then B.\n' },
    ])
    expect(outcome).toEqual({
      kind: 'settled',
      documents: [
        { id: 'ask-1', path: DECISION, kind: 'decision', title: 'Queue', theirName: 'Bea', ours: ASK.incoming, theirs: ASK.existing, base: ASK.base, merged: '# Queue\n\nSQS and Kafka.\n', current: 'merged' },
        { id: 'review-1', path: PLAN, kind: 'plan', title: 'Plan', theirName: null, ours: REVIEW.incoming, theirs: REVIEW.existing, base: REVIEW.base, merged: '# Plan\n\nPhase A, then B.\n', current: 'merged' },
      ],
    })
    expect(h.timers.armed.size).toBe(0)
  })

  it.each([
    ['the agent fails', [new Error('model down')]],
    ['the agent cannot merge', [CANNOT_MERGE]],
    ['the agent says nothing', [null]],
    ['the agent answers conflict lines', ['<<<<<<< mine\na\n=======\nb\n>>>>>>> theirs']],
  ])('one item where %s → NOTHING is resolved, not even the items already merged', async (_label, second) => {
    const h = harness(['# Queue\n\nmerged\n', ...second])
    const outcome = await settleIntentAsks('acme', [ASK, REVIEW], h.deps)
    // Positive first: the first item WAS merged by the agent…
    expect(h.asked).toHaveLength(2)
    // …and still nothing was resolved.
    expect(h.resolved).toEqual([])
    expect(outcome).toEqual({ kind: 'left', reason: 'agent-failed' })
  })

  it('an agent that never answers is cut off by the timeout, and nothing is resolved', async () => {
    const h = harness(['hang'])
    const pending = settleIntentAsks('acme', [ASK], h.deps)
    await new Promise((resolve) => setImmediate(resolve))
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0]?.signal.aborted).toBe(false)
    h.timers.fire()
    expect(await pending).toEqual({ kind: 'left', reason: 'agent-failed' })
    expect(h.asked[0]?.signal.aborted).toBe(true)
    expect(h.resolved).toEqual([])
  })

  it('a non-mergeable item present → the agent is never called', async () => {
    const feature: WorkspaceSyncAsk = { ...ASK, id: 'ask-2', kind: 'same-feature', path: 'projects/api/brain/features/q.md', existingPath: 'projects/api/brain/features/q.md', agentMergeable: undefined }
    for (const items of [
      [ASK, feature],
      [{ ...ASK, truncated: true }],
      [{ ...ASK, existingPath: 'projects/api/discovery/discovery_q_v2.md' }],
      [{ ...REVIEW, kind: 'modify-delete' as const, existing: null }],
      [] as IntentItem[],
    ]) {
      const h = harness(['merged'])
      expect(await settleIntentAsks('acme', items, h.deps)).toEqual({ kind: 'left', reason: 'not-mergeable' })
      expect(h.asked).toEqual([])
      expect(h.resolved).toEqual([])
    }
    // Positive control: the same ASK alone is mergeable.
    expect(allAgentMergeable([ASK])).toBe(true)
  })

  it('a resolve the CLI refuses stops there and says so', async () => {
    const h = harness(['a', 'b'], [false])
    expect(await settleIntentAsks('acme', [ASK, REVIEW], h.deps)).toEqual({ kind: 'left', reason: 'resolve-failed' })
    expect(h.resolved.map((entry) => entry.id)).toEqual(['ask-1'])
  })
})

describe('intent-merge helpers', () => {
  it('reads the kind from the Workspace path, and nothing else is intent', () => {
    expect(intentKindOf(DECISION)).toBe('decision')
    expect(intentKindOf(PLAN)).toBe('plan')
    expect(intentKindOf('projects/api/discovery/discovery_q_v1.md')).toBe('discovery')
    expect(intentKindOf('projects/api/brain/features/q.md')).toBeNull()
  })

  it('titles a document by its heading, else its file name in words', () => {
    expect(documentTitle(DECISION, '# Use one queue\n\ntext')).toBe('Use one queue')
    expect(documentTitle('projects/api/discovery/discovery_payment_retry_v2.md', 'no heading')).toBe('payment retry')
  })

  it('a fenced answer is the document inside; empty and over-long answers are not usable', () => {
    expect(usableMergedText('```markdown\n# A\n\nb\n```')).toBe('# A\n\nb\n')
    expect(usableMergedText('   ')).toBeNull()
    expect(usableMergedText(`${CANNOT_MERGE} — they disagree`)).toBeNull()
  })

  it('the prompt carries all three texts as data and the way out', () => {
    const prompt = intentMergePrompt({ kind: 'decision', title: 'Queue', base: null, ours: 'MINE', theirs: 'THEIRS' })
    expect(prompt).toContain('<mine>\nMINE\n</mine>')
    expect(prompt).toContain('<theirs>\nTHEIRS\n</theirs>')
    expect(prompt).toContain(CANNOT_MERGE)
  })
})
