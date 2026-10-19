// The id-addressed reconcile model (thread-tasklist, Phase 3b).
//
// THE TEST THAT MATTERS IS THE DELETION CASE, and it is written to fail loudly:
// an explicit deletion removes a card and NOTHING ELSE DOES — not a completion,
// not a change that stopped naming a task, not an unreadable payload. Every other
// block exists to stop some cheaper mistake from making that one pass by
// accident: an id read off the wrong half of the call, a state guessed, a change
// to a task nobody saw silently inventing a card named after a number.
//
// The deletion block is mutation-checked. Making a completion remove its card
// turns it red naming the work that went missing.
//
// THE PAYLOADS ARE REAL. Every fixture in the first block is copied verbatim out
// of recorded traffic, because the SDK's declared answer for a creation and the
// answer the live harness actually records are DIFFERENT SHAPES, and a parser
// tested only against the declared one mirrors nothing at all.

import {
  CHANGE_REFUSED,
  NO_TASK_IDENTITY,
  NO_TASK_NAMED,
  parseTaskCreate,
  parseTaskUpdate,
  reconcileAgentTask,
  taskIdFromAnswer,
  TASK_NEVER_SEEN,
  type MirroredTaskCard,
} from './agent-task-reconcile'
import { NOT_READABLE, NOTHING_TO_READ, NO_WORDING, UNKNOWN_STATE } from './todo-reconcile'

/** A creation payload and the sentence the live harness answers it with. */
const REAL_CREATE_INPUT =
  '{"subject":"Assess local env health (app/engine/auth/flags)","description":"Confirm local app :3000 renders, engine :8000 has the migration endpoints, Keycloak auth is usable, and which CHAT_* flags are active — determines what e2e can actually exercise.","activeForm":"Assessing local environment health"}'
const REAL_CREATE_OUTPUT =
  '"Task #1 created successfully: Assess local env health (app/engine/auth/flags)"'
/** A subject that itself contains a hash — the first one must still win. */
const REAL_CREATE_OUTPUT_HASHED =
  '"Task #7 created successfully: Fix #2: escape purge LIKE metacharacters"'
const REAL_UPDATE_INPUT = '{"taskId":"1","status":"in_progress"}'
const REAL_UPDATE_OUTPUT = '"Updated task #1 status"'

function card(taskId: string, over: Partial<MirroredTaskCard> = {}): MirroredTaskCard {
  return { id: `card-${taskId}`, title: `Task ${taskId}`, lane: 'todo', taskId, ...over }
}

const created = (inputJson: string | null, outputJson: string | null) =>
  reconcileAgentTask({ cards: [], call: { kind: 'create', inputJson, outputJson } })

const changed = (
  cards: MirroredTaskCard[],
  inputJson: string | null,
  outputJson: string | null = null,
) => reconcileAgentTask({ cards, call: { kind: 'update', inputJson, outputJson } })

describe('agent-task-reconcile', () => {
  // ── The real protocol, as it is actually recorded ─────────────────────

  describe('the payloads the live harness emits', () => {
    it('reads a creation from what was sent AND what came back', () => {
      const result = created(REAL_CREATE_INPUT, REAL_CREATE_OUTPUT)
      expect(result.reason).toBeNull()
      expect(result.decision).toEqual({
        action: 'add',
        taskId: '1',
        title: 'Assess local env health (app/engine/auth/flags)',
        lane: 'todo',
        description: expect.stringContaining('Confirm local app'),
      })
    })

    it('takes the first hash, so a subject containing one cannot become the id', () => {
      expect(taskIdFromAnswer(REAL_CREATE_OUTPUT_HASHED)).toBe('7')
    })

    it('also reads the answer the SDK declares, which the harness does not send', () => {
      // Declared first, observed second (allowed-pattern #11): reading only the
      // documented shape mirrors nothing today, and reading only the observed
      // one breaks the day the tool keeps its own promise.
      expect(taskIdFromAnswer('{"task":{"id":"abc-123","subject":"x"}}')).toBe('abc-123')
    })

    it('reads an answer delivered as content blocks', () => {
      expect(
        taskIdFromAnswer('[{"type":"text","text":"Task #4 created successfully: Do it"}]'),
      ).toBe('4')
    })

    it('reads a change addressed to an id', () => {
      const result = changed([card('1')], REAL_UPDATE_INPUT, REAL_UPDATE_OUTPUT)
      expect(result.decision).toMatchObject({
        action: 'update',
        taskId: '1',
        cardId: 'card-1',
        lane: 'doing',
        changed: true,
      })
    })
  })

  // ── A create then an update moves the right card ──────────────────────

  describe('a creation followed by a change', () => {
    it('moves the card the change named, and only that one', () => {
      const cards = [card('1'), card('2'), card('3')]
      const result = changed(cards, '{"taskId":"2","status":"in_progress"}')
      expect(result.decision).toMatchObject({ action: 'update', cardId: 'card-2', lane: 'doing' })
      // A call names ONE task. The others are not reported at all — unlike the
      // whole-list model, where saying nothing about a card is itself a
      // statement about it.
      expect(Array.isArray(result.decision)).toBe(false)
    })

    it('a change carrying only a state keeps the wording it already had', () => {
      const result = changed([card('1', { title: 'Ship the thing' })], REAL_UPDATE_INPUT)
      expect(result.decision).toMatchObject({ title: 'Ship the thing', lane: 'doing' })
    })

    it('a change carrying only wording leaves the lane where it is', () => {
      const result = changed(
        [card('1', { title: 'Old', lane: 'doing' })],
        '{"taskId":"1","subject":"New"}',
      )
      expect(result.decision).toMatchObject({ title: 'New', lane: 'doing', changed: true })
    })

    it('a change that says nothing new is reported unchanged', () => {
      const result = changed(
        [card('1', { title: 'Ship it', lane: 'done' })],
        '{"taskId":"1","subject":"Ship it","status":"completed"}',
      )
      expect(result.decision).toMatchObject({ action: 'update', changed: false })
    })

    it('the same creation seen twice updates rather than adding a second card', () => {
      const result = reconcileAgentTask({
        cards: [card('1', { title: 'Old wording' })],
        call: { kind: 'create', inputJson: REAL_CREATE_INPUT, outputJson: REAL_CREATE_OUTPUT },
      })
      expect(result.decision?.action).toBe('update')
    })
  })

  // ── Lanes: Done exists, Blocked does not ──────────────────────────────

  describe('the lanes a state means', () => {
    it.each([
      ['pending', 'todo'],
      ['in_progress', 'doing'],
      ['completed', 'done'],
    ])('%s means %s', (status, lane) => {
      const result = changed([card('1')], `{"taskId":"1","status":"${status}"}`)
      expect(result.decision).toMatchObject({ lane })
    })

    it('a completed task lands in Done and is NOT removed', () => {
      const result = changed([card('1')], '{"taskId":"1","status":"completed"}')
      // Done is a column, not an exit. Deleting a finished task would erase the
      // only evidence the work existed.
      expect(result.decision?.action).toBe('update')
      expect(result.decision).toMatchObject({ lane: 'done' })
    })

    it('NOTHING an assistant can say reaches Blocked', () => {
      for (const status of ['pending', 'in_progress', 'completed']) {
        const result = changed([card('1')], `{"taskId":"1","status":"${status}"}`)
        expect(result.decision).not.toMatchObject({ lane: 'blocked' })
      }
      // And a creation cannot either — amber belongs to the approval gate,
      // and an assistant knows nothing about it.
      expect(created(REAL_CREATE_INPUT, REAL_CREATE_OUTPUT).decision).toMatchObject({
        lane: 'todo',
      })
    })

    it('reports a blocked card back as changed, leaving the conflict to the store layer', () => {
      const result = changed([card('1', { lane: 'blocked' })], '{"taskId":"1","status":"completed"}')
      // It REPORTS both sides and resolves neither — who wins is owned by the
      // layer that owns rows.
      expect(result.decision).toMatchObject({ previousLane: 'blocked', lane: 'done' })
    })
  })

  // ── THE DELETION RULE ─────────────────────────────────────────────────

  describe('a card leaves only when somebody says so', () => {
    it('an explicit deletion removes it', () => {
      const result = changed([card('1', { title: 'Abandoned work' })], '{"taskId":"1","status":"deleted"}')
      expect(result.decision).toEqual({
        action: 'remove',
        taskId: '1',
        cardId: 'card-1',
        title: 'Abandoned work',
      })
    })

    it.each([
      ['a completion', '{"taskId":"1","status":"completed"}'],
      ['a start', '{"taskId":"1","status":"in_progress"}'],
      ['a return to pending', '{"taskId":"1","status":"pending"}'],
      ['a rename', '{"taskId":"1","subject":"Something else"}'],
      ['a change with no state at all', '{"taskId":"1"}'],
    ])('and NOTHING ELSE does: %s', (_label, payload) => {
      // THE ASSERTION THE WHOLE PHASE RESTS ON. Mutating the model to remove a
      // card on completion turns this red naming the work that went missing.
      const result = changed([card('1', { title: 'Abandoned work' })], payload)
      expect(result.decision?.action).not.toBe('remove')
    })

    it('a task the assistant simply stopped naming is not reported at all', () => {
      const result = changed([card('1'), card('2')], '{"taskId":"1","status":"completed"}')
      // Silence is still not news. Card 2 gets no decision — and crucially, no
      // removal — because this call said nothing whatsoever about it.
      expect(result.decision).toMatchObject({ cardId: 'card-1' })
    })

    it('a deletion for a task nobody saw created removes nothing', () => {
      const result = changed([card('1')], '{"taskId":"99","status":"deleted"}')
      expect(result.decision).toEqual({
        action: 'ignore',
        taskId: '99',
        reason: TASK_NEVER_SEEN,
      })
    })
  })

  // ── A change to an id nobody saw created ──────────────────────────────

  describe('a change addressed to a task this board never saw', () => {
    it('is ignored when it carries only a state — a card named after a number is scratch', () => {
      const result = changed([], '{"taskId":"4","status":"in_progress"}')
      expect(result.decision).toEqual({ action: 'ignore', taskId: '4', reason: TASK_NEVER_SEEN })
    })

    it('is adopted when it brought its own wording, in the lane it named', () => {
      // Normal, not an error: the app may have started recording partway
      // through a conversation. Wording is the whole test — it is what makes a
      // card readable by a person.
      const result = changed([], '{"taskId":"4","subject":"Rebuild the index","status":"completed"}')
      expect(result.decision).toEqual({
        action: 'add',
        taskId: '4',
        title: 'Rebuild the index',
        lane: 'done',
        description: null,
      })
    })
  })

  // ── A malformed payload produces nothing ──────────────────────────────

  describe('a payload nobody could read', () => {
    it.each([
      ['nothing at all', null, NOTHING_TO_READ],
      ['not JSON', '{oops', NOT_READABLE],
      ['JSON that is not an object', '[1,2,3]', NOT_READABLE],
      ['no task named', '{"status":"completed"}', NO_TASK_NAMED],
      ['a state this board has no column for', '{"taskId":"1","status":"cancelled"}', UNKNOWN_STATE],
      ['a rename to nothing', '{"taskId":"1","subject":"   "}', NO_WORDING],
    ])('refuses a change: %s', (_label, payload, reason) => {
      const result = changed([card('1')], payload)
      expect(result.decision).toBeNull()
      expect(result.reason).toBe(reason)
    })

    it.each([
      ['nothing at all', null, REAL_CREATE_OUTPUT, NOTHING_TO_READ],
      ['not JSON', '{oops', REAL_CREATE_OUTPUT, NOT_READABLE],
      ['no subject', '{"description":"x"}', REAL_CREATE_OUTPUT, NO_WORDING],
      ['an answer with no identity in it', REAL_CREATE_INPUT, '"Created."', NO_TASK_IDENTITY],
      ['no answer at all', REAL_CREATE_INPUT, null, NO_TASK_IDENTITY],
    ])('refuses a creation: %s', (_label, input, output, reason) => {
      const result = created(input, output)
      expect(result.decision).toBeNull()
      expect(result.reason).toBe(reason)
    })

    it('refuses a change the tool said it did not make', () => {
      const result = changed(
        [card('1')],
        REAL_UPDATE_INPUT,
        '{"success":false,"taskId":"1","updatedFields":[],"error":"gone"}',
      )
      expect(result.decision).toBeNull()
      expect(result.reason).toBe(CHANGE_REFUSED)
    })

    it('an unreadable payload removes nothing and reports no card', () => {
      const result = changed([card('1')], '{oops')
      expect(result.decision).toBeNull()
      // The card survives — nothing in this model can remove one without an
      // explicit deletion, least of all a payload it never read.
      expect(result.reason).toBe(NOT_READABLE)
    })
  })

  // ── The parsers, directly ─────────────────────────────────────────────

  describe('the parsers', () => {
    it('keeps the assistant\'s own wording verbatim, trimmed', () => {
      const parsed = parseTaskCreate('{"subject":"  Ship It  ","description":" why "}', REAL_CREATE_OUTPUT)
      expect(parsed).toEqual({
        ok: true,
        value: { taskId: '1', title: 'Ship It', description: 'why' },
      })
    })

    it('reads a deletion as a deletion and not as a state', () => {
      expect(parseTaskUpdate('{"taskId":"9","status":"deleted"}')).toEqual({
        ok: true,
        value: { taskId: '9', title: null, lane: null, deleted: true },
      })
    })

    it('carries a change that named no state at all', () => {
      expect(parseTaskUpdate('{"taskId":"9","owner":"someone"}')).toEqual({
        ok: true,
        value: { taskId: '9', title: null, lane: null, deleted: false },
      })
    })
  })
})
