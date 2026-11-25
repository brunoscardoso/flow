/**
 * decideConflicts — the agent decides every item of a waiting merge. The fast
 * model, the capable model and the recorded reasons are fakes that record what
 * they were asked.
 */

import type { EngineTimers } from './sync-timing'
import {
  CANNOT_MERGE,
  FAST_SIDE_LIMIT,
  decideConflicts,
  decideWithoutModel,
  documentTitle,
  fastDecidePrompt,
  intentKindOf,
  intentMergePrompt,
  parseFastAnswer,
  projectOf,
  usableMergedText,
  type DeciderDeps,
  type FastDecideInput,
  type IntentItem,
  type IntentMergeInput,
} from './intent-merge'
import type { WorkspaceSyncAsk, WorkspaceSyncReview } from '../../shared/workspaces-contract'

const DECISION = 'projects/api/brain/decisions/queue.md'
const PLAN = 'projects/api/plans/plan_queue_v1.md'
const NOTE = 'projects/api/notes.md'

const DECISION_ASK: WorkspaceSyncAsk = {
  id: 'ask-decision',
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

const PLAN_REVIEW: WorkspaceSyncReview = {
  id: 'review-plan',
  kind: 'conflict',
  path: PLAN,
  base: '# Plan\n',
  existing: '# Plan\n\nPhase B.\n',
  incoming: '# Plan\n\nPhase A.\n',
  conflicted: null,
  truncated: false,
  options: ['ours', 'theirs', 'file'],
}

const NOTE_REVIEW: WorkspaceSyncReview = {
  id: 'review-note',
  kind: 'conflict',
  path: NOTE,
  base: 'a\n',
  existing: 'a\nb\n',
  incoming: 'a\n',
  conflicted: null,
  truncated: false,
  options: ['ours', 'theirs', 'file'],
}

const ANCHORS_ASK: WorkspaceSyncAsk = {
  id: 'ask-anchors',
  kind: 'overlapping-anchors',
  topic: 'api: src/queue.ts',
  path: 'projects/api/brain/features/queue-retry.md',
  existingPath: 'projects/api/brain/features/queue-dlq.md',
  existing: '# DLQ\n',
  incoming: '# Retry\n',
  merged: '# Retry\n',
  agentMergeable: true,
  base: null,
  theirAuthor: null,
  suggested: 'both',
  truncated: false,
  options: ['ours', 'theirs', 'merged', 'file'],
}

const DELETION: WorkspaceSyncReview = {
  id: 'review-deleted',
  kind: 'modify-delete',
  path: 'projects/api/brain/features/old.md',
  base: '# Old\n',
  existing: null,
  incoming: '# Old\n\nmore\n',
  conflicted: null,
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

type FastAnswer = string | null | Error | ((prompt: string) => string)
type MergeAnswer = string | null | Error

function harness(options: { fast?: FastAnswer[]; merge?: MergeAnswer[]; reasons?: string[]; maxMerges?: number } = {}) {
  const timers = new ManualTimers()
  const fastPrompts: FastDecideInput[] = []
  const mergeInputs: IntentMergeInput[] = []
  const reasonCalls: Array<[string, string | null]> = []
  const fastAnswers = [...(options.fast ?? [])]
  const mergeAnswers = [...(options.merge ?? [])]
  const deps: DeciderDeps = {
    decideFast: async (input) => {
      fastPrompts.push(input)
      const answer = fastAnswers.shift()
      if (answer instanceof Error) throw answer
      if (typeof answer === 'function') return answer(input.prompt)
      return answer ?? null
    },
    merge: async (input) => {
      mergeInputs.push(input)
      const answer = mergeAnswers.shift()
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
    reasonsFor: async (kind, project) => {
      reasonCalls.push([kind, project])
      return options.reasons ?? []
    },
    timers,
    timeoutMs: 1000,
    fastTimeoutMs: 1000,
    ...(options.maxMerges === undefined ? {} : { maxMerges: options.maxMerges }),
    log: () => undefined,
  }
  return { deps, timers, fastPrompts, mergeInputs, reasonCalls }
}

/** The labels a batch prompt gave its items, in order. */
function labelsIn(prompt: string): string[] {
  return [...prompt.matchAll(/<item label="([^"]+)"/g)].map((match) => match[1])
}

describe('decideConflicts — no model for what needs none', () => {
  it('two different notes on the same code keep both, and two identical sides take either — no call at all', async () => {
    const h = harness()
    const identical: WorkspaceSyncReview = { ...NOTE_REVIEW, id: 'review-same', existing: 'x\n', incoming: 'x\n' }
    const outcome = await decideConflicts('acme', [ANCHORS_ASK, identical], h.deps)
    expect(outcome).toEqual({
      decisions: [
        { id: 'ask-anchors', take: 'ours', group: 'kept-both', reason: expect.any(String) },
        { id: 'review-same', take: 'ours', group: 'identical', reason: expect.any(String) },
      ],
      needsYou: [],
    })
    expect(h.fastPrompts).toEqual([])
    expect(h.mergeInputs).toEqual([])
    expect(h.reasonCalls).toEqual([])
  })

  it('identical but truncated sides prove nothing: never decided blind', async () => {
    const h = harness()
    const cut: WorkspaceSyncReview = { ...NOTE_REVIEW, existing: 'x', incoming: 'x', truncated: true }
    expect(decideWithoutModel(cut)).toBeNull()
    expect(await decideConflicts('acme', [cut], h.deps)).toEqual({ decisions: [], needsYou: [{ id: 'review-note', reason: 'truncated' }] })
    expect(h.fastPrompts).toEqual([])
  })

  it('an item with a side missing (not a deletion) is never decided, and asks no model', async () => {
    const h = harness()
    const oneSided: WorkspaceSyncReview = { ...NOTE_REVIEW, kind: 'add-add', existing: null }
    expect(await decideConflicts('acme', [oneSided], h.deps)).toEqual({ decisions: [], needsYou: [{ id: 'review-note', reason: 'one-sided' }] })
    expect(h.fastPrompts).toEqual([])
  })
})

describe('decideConflicts — the fast model sorts', () => {
  it('reads one line per item, maps verdicts to takes, and sends merges to the capable model', async () => {
    const theirsItem: WorkspaceSyncReview = { ...NOTE_REVIEW, id: 'review-theirs' }
    const oursItem: WorkspaceSyncReview = { ...NOTE_REVIEW, id: 'review-ours', path: 'projects/api/other.md' }
    const h = harness({
      fast: [
        (prompt) => {
          const [a, b, c] = labelsIn(prompt)
          return [`${a} theirs it already holds the new line`, `- ${b}: ours mine is newer`, `${c} merge both added phases`].join('\n')
        },
      ],
      merge: ['# Plan\n\nPhase A, then B.'],
    })
    const outcome = await decideConflicts('acme', [theirsItem, oursItem, PLAN_REVIEW], h.deps)
    // Positive first: ONE fast call for the three, ONE merge for the one it said to merge.
    expect(h.fastPrompts).toHaveLength(1)
    expect(h.mergeInputs.map((input) => [input.kind, input.title, input.ours, input.theirs, input.base])).toEqual([
      ['plan', 'Plan', PLAN_REVIEW.incoming, PLAN_REVIEW.existing, PLAN_REVIEW.base],
    ])
    expect(outcome).toEqual({
      decisions: [
        { id: 'review-theirs', take: 'theirs', group: 'took-theirs', reason: 'it already holds the new line' },
        { id: 'review-ours', take: 'ours', group: 'kept-mine', reason: 'mine is newer' },
        { id: 'review-plan', take: 'file', content: '# Plan\n\nPhase A, then B.\n', group: 'merged', reason: 'both added phases' },
      ],
      needsYou: [],
    })
    expect(h.timers.armed.size).toBe(0)
  })

  it('a missing or unreadable line leaves only that item for a person', async () => {
    const other: WorkspaceSyncReview = { ...NOTE_REVIEW, id: 'review-other' }
    const h = harness({
      fast: [
        (prompt) => {
          const [a, b] = labelsIn(prompt)
          return [`${a} theirs fine`, `${b} perhaps-ours who knows`, 'i99 ours not an item'].join('\n')
        },
      ],
    })
    const outcome = await decideConflicts('acme', [NOTE_REVIEW, other], h.deps)
    expect(outcome.decisions.map((decision) => decision.id)).toEqual(['review-note'])
    expect(outcome.needsYou).toEqual([{ id: 'review-other', reason: 'unreadable-answer' }])
    expect(h.mergeInputs).toEqual([])
  })

  it('unsure and a take the item does not accept wait for a person, with the agent\'s suggestion', async () => {
    const noTheirs: WorkspaceSyncReview = { ...NOTE_REVIEW, id: 'review-no-theirs', options: ['ours', 'file'] }
    const h = harness({
      fast: [(prompt) => labelsIn(prompt).map((label, index) => `${label} ${index === 0 ? 'unsure' : 'theirs'} hard to say`).join('\n')],
    })
    const outcome = await decideConflicts('acme', [NOTE_REVIEW, noTheirs], h.deps)
    expect(outcome).toEqual({
      decisions: [],
      needsYou: [
        { id: 'review-note', reason: 'unsure', suggestion: { verdict: 'unsure', reason: 'hard to say' } },
        { id: 'review-no-theirs', reason: 'not-offered', suggestion: { verdict: 'theirs', reason: 'hard to say' } },
      ],
    })
  })

  it('"both" on two files keeps both; "both" on one file is a merge', async () => {
    const twoFiles: WorkspaceSyncAsk = { ...ANCHORS_ASK, id: 'ask-two', kind: 'same-feature', suggested: undefined }
    const h = harness({ fast: [(prompt) => labelsIn(prompt).map((label) => `${label} both different things`).join('\n')], merge: ['# Plan\n\nAB'] })
    const outcome = await decideConflicts('acme', [twoFiles, PLAN_REVIEW], h.deps)
    expect(outcome.decisions).toEqual([
      { id: 'ask-two', take: 'ours', group: 'kept-both', reason: 'different things' },
      { id: 'review-plan', take: 'file', content: '# Plan\n\nAB\n', group: 'merged', reason: 'different things' },
    ])
  })

  it('splits a large pause into batches of at most 40 items', async () => {
    const many = Array.from({ length: 85 }, (_, index): WorkspaceSyncReview => ({ ...NOTE_REVIEW, id: `r${index}` }))
    const answer = (prompt: string): string => labelsIn(prompt).map((label) => `${label} theirs ok`).join('\n')
    const h = harness({ fast: [answer, answer, answer] })
    const outcome = await decideConflicts('acme', many, h.deps)
    expect(h.fastPrompts.map((input) => labelsIn(input.prompt).length)).toEqual([40, 40, 5])
    expect(outcome.decisions).toHaveLength(85)
    expect(outcome.needsYou).toEqual([])
  })
})

describe('decideConflicts — never alone on a deletion or a decision document', () => {
  it('a decision document and a deletion are only suggested on — even when the agent is sure', async () => {
    const h = harness({ fast: [(prompt) => labelsIn(prompt).map((label) => `${label} theirs keep the teammate's`).join('\n')] })
    const outcome = await decideConflicts('acme', [DECISION_ASK, DELETION], h.deps)
    // Positive first: the agent WAS asked about both…
    expect(labelsIn(h.fastPrompts[0]?.prompt ?? '')).toHaveLength(2)
    // …and decided neither.
    expect(outcome).toEqual({
      decisions: [],
      needsYou: [
        { id: 'ask-decision', reason: 'decision-document', suggestion: { verdict: 'theirs', reason: "keep the teammate's" } },
        { id: 'review-deleted', reason: 'deletion', suggestion: { verdict: 'theirs', reason: "keep the teammate's" } },
      ],
    })
  })

  it('a decision document the agent says to merge gets a DRAFT as its suggestion, never applied', async () => {
    const h = harness({ fast: [(prompt) => `${labelsIn(prompt)[0]} merge both queues matter`], merge: ['# Queue\n\nSQS and Kafka.'] })
    const outcome = await decideConflicts('acme', [DECISION_ASK], h.deps)
    expect(h.mergeInputs).toHaveLength(1)
    expect(outcome).toEqual({
      decisions: [],
      needsYou: [
        { id: 'ask-decision', reason: 'decision-document', suggestion: { verdict: 'merge', reason: 'both queues matter', content: '# Queue\n\nSQS and Kafka.\n' } },
      ],
    })
  })
})

describe('decideConflicts — limits and failures', () => {
  it('a truncated item is never shown to a model', async () => {
    const h = harness()
    const cut: WorkspaceSyncReview = { ...PLAN_REVIEW, truncated: true }
    expect(await decideConflicts('acme', [cut], h.deps)).toEqual({ decisions: [], needsYou: [{ id: 'review-plan', reason: 'truncated' }] })
    expect(h.fastPrompts).toEqual([])
    expect(h.mergeInputs).toEqual([])
  })

  it('past the run\'s cap, merges wait for a person', async () => {
    const plans = [1, 2, 3].map((n): WorkspaceSyncReview => ({ ...PLAN_REVIEW, id: `plan-${n}`, path: `projects/api/plans/plan_${n}_v1.md` }))
    const h = harness({
      fast: [(prompt) => labelsIn(prompt).map((label) => `${label} merge both`).join('\n')],
      merge: ['# One', '# Two', '# Three'],
      maxMerges: 2,
    })
    const outcome = await decideConflicts('acme', plans, h.deps)
    expect(h.mergeInputs).toHaveLength(2)
    expect(outcome.decisions.map((decision) => decision.id)).toEqual(['plan-1', 'plan-2'])
    expect(outcome.needsYou).toEqual([{ id: 'plan-3', reason: 'cap', suggestion: { verdict: 'merge', reason: 'both' } }])
  })

  it.each([
    ['throws', new Error('model down')],
    ['answers nothing', null],
    ['answers blank', '   '],
  ])('the fast model that %s → EVERY item waits for a person, the free ones too', async (_label, answer) => {
    const h = harness({ fast: [answer as FastAnswer] })
    const outcome = await decideConflicts('acme', [ANCHORS_ASK, NOTE_REVIEW, DECISION_ASK], h.deps)
    expect(h.fastPrompts).toHaveLength(1)
    expect(outcome).toEqual({
      decisions: [],
      needsYou: [
        { id: 'ask-anchors', reason: 'agent-unavailable' },
        { id: 'review-note', reason: 'agent-unavailable' },
        { id: 'ask-decision', reason: 'agent-unavailable' },
      ],
    })
    expect(h.mergeInputs).toEqual([])
  })

  it('a fast model that never answers is cut off by its timeout → every item waits for a person', async () => {
    const h = harness()
    h.deps.decideFast = () => new Promise<string | null>(() => undefined)
    const pending = decideConflicts('acme', [NOTE_REVIEW], h.deps)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    h.timers.fire()
    expect(await pending).toEqual({ decisions: [], needsYou: [{ id: 'review-note', reason: 'agent-unavailable' }] })
  })

  it.each([
    ['fails', new Error('model down')],
    ['cannot merge', CANNOT_MERGE],
    ['answers conflict lines', '<<<<<<< mine\na\n=======\nb\n>>>>>>> theirs'],
  ])('a merge the capable model %s leaves that item for a person, the rest decided', async (_label, answer) => {
    const h = harness({ fast: [(prompt) => labelsIn(prompt).map((label, index) => `${label} ${index === 0 ? 'merge' : 'theirs'} why`).join('\n')], merge: [answer] })
    const outcome = await decideConflicts('acme', [PLAN_REVIEW, NOTE_REVIEW], h.deps)
    expect(outcome.decisions.map((decision) => decision.id)).toEqual(['review-note'])
    expect(outcome.needsYou).toEqual([{ id: 'review-plan', reason: 'could-not-merge', suggestion: { verdict: 'merge', reason: 'why' } }])
  })

  it('a document too long to show the fast model goes straight to the merge step', async () => {
    const long = 'x'.repeat(FAST_SIDE_LIMIT + 1)
    const big: WorkspaceSyncReview = { ...PLAN_REVIEW, incoming: `# Plan\n${long}`, existing: `# Plan\n${long}y` }
    const h = harness({ merge: ['# Plan\n\nmerged'] })
    const outcome = await decideConflicts('acme', [big], h.deps)
    expect(h.fastPrompts).toEqual([])
    expect(h.mergeInputs).toHaveLength(1)
    expect(outcome.decisions).toEqual([expect.objectContaining({ id: 'review-plan', take: 'file', group: 'merged' })])
  })
})

describe('decideConflicts — recorded reasons are guidance', () => {
  it('reasons for the item\'s kind and project reach both prompts, stated as guidance, at most five', async () => {
    const reasons = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']
    const h = harness({ fast: [(prompt) => `${labelsIn(prompt)[0]} merge both`], merge: ['# Plan\n\nmerged'], reasons })
    await decideConflicts('acme', [PLAN_REVIEW], h.deps)
    // Asked once for this kind and project — not once per prompt.
    expect(h.reasonCalls).toEqual([['conflict', 'api']])
    const fast = h.fastPrompts[0]?.prompt ?? ''
    expect(fast).toContain('not rules')
    expect(fast).toContain('- r5')
    expect(fast).not.toContain('- r6')
    expect(h.mergeInputs[0]?.reasons).toEqual(['r1', 'r2', 'r3', 'r4', 'r5'])
    expect(intentMergePrompt({ kind: 'plan', title: 'Plan', base: null, ours: 'a', theirs: 'b', reasons: ['keep both phases'] })).toContain(
      'guidance, not as rules',
    )
  })

  it('a record that cannot be read gives no reasons and stops nothing', async () => {
    const h = harness({ fast: [(prompt) => `${labelsIn(prompt)[0]} theirs ok`] })
    h.deps.reasonsFor = async () => {
      throw new Error('unreadable')
    }
    const outcome = await decideConflicts('acme', [NOTE_REVIEW], h.deps)
    expect(outcome.decisions).toHaveLength(1)
  })
})

describe('intent-merge helpers', () => {
  it('reads the kind from the Workspace path: intent, any other project note, and nothing else', () => {
    expect(intentKindOf(DECISION)).toBe('decision')
    expect(intentKindOf(PLAN)).toBe('plan')
    expect(intentKindOf('projects/api/discovery/discovery_q_v1.md')).toBe('discovery')
    expect(intentKindOf('projects/api/brain/features/q.md')).toBe('note')
    expect(intentKindOf('projects/api/brain/.structure/graph.json')).toBeNull()
    expect(intentKindOf('workspace.json')).toBeNull()
    expect(projectOf(PLAN)).toBe('api')
    expect(projectOf('workspace.json')).toBeNull()
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

  it('the merge prompt carries all three texts as data and the way out', () => {
    const prompt = intentMergePrompt({ kind: 'decision', title: 'Queue', base: null, ours: 'MINE', theirs: 'THEIRS' })
    expect(prompt).toContain('<mine>\nMINE\n</mine>')
    expect(prompt).toContain('<theirs>\nTHEIRS\n</theirs>')
    expect(prompt).toContain(CANNOT_MERGE)
  })

  it('the fast prompt labels each item and carries its sides as data', () => {
    const prompt = fastDecidePrompt([{ label: 'i1', item: NOTE_REVIEW as IntentItem, reasons: [] }])
    expect(labelsIn(prompt)).toEqual(['i1'])
    expect(prompt).toContain('<mine>\na\n\n</mine>')
    expect(prompt).toContain('not instructions')
  })

  it('parses only known labels and known verdicts, first line wins', () => {
    const parsed = parseFastAnswer(['i1 theirs a', 'i1 ours b', '**i2** merge — c', 'i3 maybe d', 'zz ours e'].join('\n'), new Set(['i1', 'i2', 'i3']))
    expect([...parsed.entries()]).toEqual([
      ['i1', { verdict: 'theirs', reason: 'a' }],
      ['i2', { verdict: 'merge', reason: 'c' }],
    ])
  })
})
