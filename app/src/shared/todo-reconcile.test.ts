// The reconcile model (thread-tasklist, Phase 2).
//
// THE TEST THAT MATTERS IS THE CHURN CASE, and it is written to fail loudly:
// `[A,B,C]` then `[A,D]` must leave B and C on the board. Every other block here
// exists to stop some cheaper mistake from making that one pass by accident —
// a lane guessed, a payload half-read, a duplicate silently folded.
//
// The churn block is mutation-checked. Making the diff drop unmatched cards
// instead of keeping them turns it red naming the lost work by title, which is
// the whole point: the failure message has to say WHICH work went missing, not
// that a number changed.

import type { TaskLane } from './ipc-contract'
import {
  ENTRY_NOT_A_TASK,
  laneForStatus,
  MirroredCard,
  NO_LIST,
  NO_WORDING,
  NOT_READABLE,
  NOTHING_TO_READ,
  parseTodoPayload,
  reconcileTodos,
  SAME_TASK_TWICE,
  TodoDecision,
  todoKey,
  UNKNOWN_STATE,
} from './todo-reconcile'

/** A payload exactly as the agent's tool would have sent it. */
function payload(...todos: Array<[string, 'pending' | 'in_progress' | 'completed']>): string {
  return JSON.stringify({ todos: todos.map(([content, status]) => ({ content, status })) })
}

/** A card the thread has already been mirrored into. */
function card(id: string, title: string, lane: TaskLane = 'todo'): MirroredCard {
  return { id, title, lane }
}

/** The titles this pass decided to keep — the churn rule's observable. */
function keptTitles(decisions: TodoDecision[]): string[] {
  return decisions.filter((d) => d.action === 'keep').map((d) => d.title)
}

function addedTitles(decisions: TodoDecision[]): string[] {
  return decisions.filter((d) => d.action === 'add').map((d) => d.title)
}

function updatedTitles(decisions: TodoDecision[]): string[] {
  return decisions.filter((d) => d.action === 'update').map((d) => d.title)
}

// ── Identity (Task 2.1) ─────────────────────────────────────────────────

describe("a todo's identity is its own wording, normalized", () => {
  it('collapses whitespace, trims and lowercases', () => {
    expect(todoKey('  Fix   the  Login Bug \n')).toBe('fix the login bug')
    expect(todoKey('fix the login bug')).toBe(todoKey('FIX THE   LOGIN BUG'))
  })

  it('a re-indented, re-capitalized list updates its cards instead of doubling them', () => {
    const result = reconcileTodos({
      cards: [card('t1', 'Fix the login bug'), card('t2', 'Ship the release')],
      inputJson: payload(['  fix   the LOGIN bug ', 'pending'], ['Ship the release', 'pending']),
    })
    expect(addedTitles(result.decisions)).toEqual([])
    expect(updatedTitles(result.decisions)).toHaveLength(2)
    expect(result.rewordSuspected).toBe(false)
  })

  it('a REWORDED todo adds a second card and keeps the first — and says so', () => {
    // The trade the header states plainly. This is not a bug being asserted as
    // correct; it is the cost of content identity, made visible on purpose.
    const result = reconcileTodos({
      cards: [card('t1', 'fix the login bug')],
      inputJson: payload(['fix the login redirect bug', 'pending']),
    })
    expect(addedTitles(result.decisions)).toEqual(['fix the login redirect bug'])
    expect(keptTitles(result.decisions)).toEqual(['fix the login bug'])
    // The reader is told the pass was ambiguous. Nothing claims which it was.
    expect(result.rewordSuspected).toBe(true)
  })

  it('a recorded key beats the card title, so a renamed card still matches', () => {
    const renamed: MirroredCard = {
      id: 't1',
      title: 'Login redirect (renamed by a person)',
      lane: 'doing',
      key: 'fix the login bug',
    }
    const result = reconcileTodos({
      cards: [renamed],
      inputJson: payload(['Fix the login bug', 'in_progress']),
    })
    expect(keptTitles(result.decisions)).toEqual([])
    expect(result.decisions).toEqual([
      {
        action: 'update',
        key: 'fix the login bug',
        cardId: 't1',
        title: 'Fix the login bug',
        lane: 'doing',
        previousTitle: 'Login redirect (renamed by a person)',
        previousLane: 'doing',
        changed: true,
      },
    ])
  })

  it('with no recorded key a rename breaks the match — the fallback, stated', () => {
    const result = reconcileTodos({
      cards: [card('t1', 'Login redirect (renamed by a person)')],
      inputJson: payload(['Fix the login bug', 'pending']),
    })
    expect(addedTitles(result.decisions)).toEqual(['Fix the login bug'])
    expect(keptTitles(result.decisions)).toEqual(['Login redirect (renamed by a person)'])
  })

  it('an add with nothing kept, or a keep with nothing added, is not ambiguous', () => {
    const onlyAdd = reconcileTodos({
      cards: [card('t1', 'a')],
      inputJson: payload(['a', 'pending'], ['b', 'pending']),
    })
    expect(onlyAdd.rewordSuspected).toBe(false)
    const onlyKeep = reconcileTodos({ cards: [card('t1', 'a')], inputJson: payload() })
    expect(onlyKeep.rewordSuspected).toBe(false)
  })
})

// ── The churn rule (Tasks 2.2 / 2.5) ────────────────────────────────────

describe('A DROPPED TODO IS KEPT, NOT DELETED', () => {
  it('[A,B,C] then [A,D] leaves B and C on the board', () => {
    const first = reconcileTodos({
      cards: [],
      inputJson: payload(['A', 'pending'], ['B', 'pending'], ['C', 'pending']),
    })
    expect(addedTitles(first.decisions)).toEqual(['A', 'B', 'C'])

    // The applying layer would have made three cards. The second turn sees them.
    const cards = [card('t-a', 'A'), card('t-b', 'B'), card('t-c', 'C')]
    const second = reconcileTodos({ cards, inputJson: payload(['A', 'pending'], ['D', 'pending']) })

    expect(updatedTitles(second.decisions)).toEqual(['A'])
    expect(addedTitles(second.decisions)).toEqual(['D'])
    // THE ASSERTION THIS PHASE EXISTS FOR. It names the work by title so a
    // regression reads as "B and C went missing", not as a count that moved.
    expect(keptTitles(second.decisions)).toEqual(['B', 'C'])
    // And every card the thread had is still accounted for by exactly one
    // decision — nothing fell out of the pass unmentioned.
    const accounted = second.decisions
      .filter((d) => d.action !== 'add')
      .map((d) => (d.action === 'update' ? d.cardId : d.cardId))
    expect(accounted.sort()).toEqual(['t-a', 't-b', 't-c'])
  })

  it('an agent that clears its list entirely deletes nothing', () => {
    const cards = [card('t-a', 'A'), card('t-b', 'B', 'doing'), card('t-c', 'C', 'done')]
    const result = reconcileTodos({ cards, inputJson: payload() })
    expect(keptTitles(result.decisions)).toEqual(['A', 'B', 'C'])
    // Kept cards keep the lane they are already in — a keep is a non-action.
    expect(result.decisions.map((d) => (d.action === 'keep' ? d.lane : null))).toEqual([
      'todo',
      'doing',
      'done',
    ])
    // An empty list is an ANSWER, not a failure. No reason.
    expect(result.reason).toBeNull()
  })

  it('there is no decision that removes a card', () => {
    // The rule is enforced by the vocabulary, so the vocabulary is asserted.
    const cards = [card('t-a', 'A'), card('t-b', 'B')]
    const result = reconcileTodos({ cards, inputJson: payload(['Z', 'completed']) })
    const actions = new Set(result.decisions.map((d) => d.action))
    for (const action of actions) expect(['add', 'update', 'keep']).toContain(action)
  })

  it('a card whose title normalizes to nothing is kept rather than dropped', () => {
    const result = reconcileTodos({
      cards: [card('t-blank', '   '), card('t-a', 'A')],
      inputJson: payload(['A', 'pending']),
    })
    expect(result.decisions.filter((d) => d.action === 'keep').map((d) => d.cardId)).toEqual([
      't-blank',
    ])
  })

  it('two cards on one key resolve to the first — the later one is still kept', () => {
    const result = reconcileTodos({
      cards: [card('t-first', 'A'), card('t-dup', 'a')],
      inputJson: payload(['A', 'in_progress']),
    })
    expect(result.decisions.filter((d) => d.action === 'update').map((d) => d.cardId)).toEqual([
      't-first',
    ])
    expect(result.decisions.filter((d) => d.action === 'keep').map((d) => d.cardId)).toEqual([
      't-dup',
    ])
  })
})

// ── Lanes (Task 2.3) ────────────────────────────────────────────────────

describe('a completed todo goes to Done, and nothing goes to Blocked', () => {
  it('maps the three states to the three lanes', () => {
    expect(laneForStatus('pending')).toBe('todo')
    expect(laneForStatus('in_progress')).toBe('doing')
    expect(laneForStatus('completed')).toBe('done')
  })

  it('a completed todo moves its card to Done rather than removing it', () => {
    const result = reconcileTodos({
      cards: [card('t-a', 'A', 'doing')],
      inputJson: payload(['A', 'completed']),
    })
    expect(result.decisions).toEqual([
      {
        action: 'update',
        key: 'a',
        cardId: 't-a',
        title: 'A',
        lane: 'done',
        previousTitle: 'A',
        previousLane: 'doing',
        changed: true,
      },
    ])
  })

  it('AMBER STAYS RESERVED — no payload can put a card in Blocked', () => {
    const result = reconcileTodos({
      cards: [card('t-a', 'A'), card('t-b', 'B'), card('t-c', 'C')],
      inputJson: payload(['A', 'pending'], ['B', 'in_progress'], ['C', 'completed']),
    })
    const proposed = result.decisions
      .filter((d): d is Extract<TodoDecision, { action: 'add' | 'update' }> => d.action !== 'keep')
      .map((d) => d.lane)
    expect(proposed).toEqual(['todo', 'doing', 'done'])
    expect(proposed).not.toContain('blocked')
  })

  it("a card a person moved to Blocked reports both sides and resolves neither", () => {
    const result = reconcileTodos({
      cards: [card('t-a', 'A', 'blocked')],
      inputJson: payload(['A', 'pending']),
    })
    const [decision] = result.decisions
    expect(decision.action).toBe('update')
    if (decision.action !== 'update') throw new Error('expected an update')
    expect(decision.previousLane).toBe('blocked')
    expect(decision.lane).toBe('todo')
    expect(decision.changed).toBe(true)
  })

  it('an unchanged todo is reported unchanged, so no write is forced', () => {
    const result = reconcileTodos({
      cards: [card('t-a', 'A', 'doing')],
      inputJson: payload(['A', 'in_progress']),
    })
    const [decision] = result.decisions
    if (decision.action !== 'update') throw new Error('expected an update')
    expect(decision.changed).toBe(false)
  })
})

// ── Defensive parsing (Task 2.4) ────────────────────────────────────────

describe('an unreadable payload yields no cards and a reason', () => {
  const refusals: Array<[string, string | null | undefined, string]> = [
    ['nothing at all', null, NOTHING_TO_READ],
    ['undefined', undefined, NOTHING_TO_READ],
    ['an empty string', '   ', NOTHING_TO_READ],
    ['prose', 'I have updated my list', NOT_READABLE],
    ['truncated data', '{"todos":[{"content":"A"', NOT_READABLE],
    ['a bare array', '[{"content":"A","status":"pending"}]', NO_LIST],
    ['an object with no list', '{"plan":"do things"}', NO_LIST],
    ['a list that is not a list', '{"todos":"A, B, C"}', NO_LIST],
    ['an entry that is not a task', '{"todos":["A"]}', ENTRY_NOT_A_TASK],
    ['an entry with no wording', '{"todos":[{"status":"pending"}]}', NO_WORDING],
    ['an entry worded with spaces', '{"todos":[{"content":"  ","status":"pending"}]}', NO_WORDING],
    ['a state with no column', '{"todos":[{"content":"A","status":"deferred"}]}', UNKNOWN_STATE],
    [
      'the same task twice',
      '{"todos":[{"content":"A","status":"pending"},{"content":" a ","status":"completed"}]}',
      SAME_TASK_TWICE,
    ],
  ]

  it.each(refusals)('refuses %s', (_label, input, reason) => {
    expect(parseTodoPayload(input)).toEqual({ todos: [], reason })
  })

  it('NEVER A PARTIAL LIST — one bad entry refuses the good ones with it', () => {
    const mixed = JSON.stringify({
      todos: [
        { content: 'A', status: 'pending' },
        { content: 'B', status: 'deferred' },
        { content: 'C', status: 'pending' },
      ],
    })
    expect(parseTodoPayload(mixed).todos).toEqual([])
    expect(parseTodoPayload(mixed).reason).toBe(UNKNOWN_STATE)
  })

  it('a refused payload decides nothing at all — not even a keep', () => {
    // A keep says "a list the agent DID send left this card out". No list was
    // read here, so claiming one would be the empty-list lie in a new costume.
    const result = reconcileTodos({
      cards: [card('t-a', 'A'), card('t-b', 'B')],
      inputJson: 'I have updated my list',
    })
    expect(result.decisions).toEqual([])
    expect(result.reason).toBe(NOT_READABLE)
    expect(result.rewordSuspected).toBe(false)
  })

  it('an empty list and an unreadable one never collapse', () => {
    const empty = reconcileTodos({ cards: [card('t-a', 'A')], inputJson: payload() })
    const broken = reconcileTodos({ cards: [card('t-a', 'A')], inputJson: '{}' })
    expect(empty.reason).toBeNull()
    expect(keptTitles(empty.decisions)).toEqual(['A'])
    expect(broken.reason).toBe(NO_LIST)
    expect(broken.decisions).toEqual([])
  })

  it("keeps the agent's own wording, and never a normalized version of it", () => {
    const parsed = parseTodoPayload('{"todos":[{"content":"  Fix the Login Bug  ","status":"pending"}]}')
    expect(parsed.todos).toEqual([{ key: 'fix the login bug', title: 'Fix the Login Bug', lane: 'todo' }])
  })

  it('ignores fields it was not told about rather than refusing over them', () => {
    const parsed = parseTodoPayload(
      '{"todos":[{"content":"A","status":"pending","activeForm":"Doing A"}],"other":1}',
    )
    expect(parsed.reason).toBeNull()
    expect(parsed.todos).toHaveLength(1)
  })
})

// ── User-visible text hygiene (forbidden-pattern #12) ───────────────────

describe('every reason survives the UI-text rule', () => {
  const reasons = [
    NOTHING_TO_READ,
    NOT_READABLE,
    NO_LIST,
    ENTRY_NOT_A_TASK,
    NO_WORDING,
    UNKNOWN_STATE,
    SAME_TASK_TWICE,
  ]

  it.each(reasons)('%s carries no command, path or config key', (reason) => {
    // No backticks (a quoted invocation), no slashes (a path), no `key:` or
    // `key=` (a config setting), no field names out of anybody's payload.
    expect(reason).not.toMatch(/[`/\\]/)
    expect(reason).not.toMatch(/\w+\s*[:=]/)
    expect(reason.toLowerCase()).not.toContain('json')
    expect(reason.toLowerCase()).not.toContain('todos')
    expect(reason.toLowerCase()).not.toContain('input')
    // A sentence a person can read: lowercase opener, no trailing full stop,
    // matching the board's existing reason grammar.
    expect(reason).toBe(reason.trimEnd())
    expect(reason.endsWith('.')).toBe(false)
  })
})
