// UserDialogBroker tests — AskUserQuestion round-trip. The real SDK-mode channel
// is canUseTool → askForToolInput, which returns an `answers` map keyed by
// question text; createOnUserDialog is the fallback for builds that route via
// request_user_dialog.

import type { UserDialogRequest } from '@anthropic-ai/claude-agent-sdk'

import type { UserQuestionRequest } from '../../shared/ipc-contract'
import {
  UserDialogBroker,
  DIALOG_REQUEST_EVENT,
  DIALOG_CANCEL_EVENT,
  ASK_USER_QUESTION_KINDS,
  type DialogCancel,
} from './dialogs'

const TOOL_INPUT = {
  questions: [
    {
      question: 'Where does the INSERT happen?',
      header: 'Insert sites',
      multiSelect: false,
      options: [
        { label: 'One place', description: 'A single function owns it.' },
        { label: 'Multiple', description: 'Several call sites.' },
      ],
    },
  ],
}

/**
 * Register the capture BEFORE the (synchronous) emit, and return a getter for
 * the captured request. `askQuestions` emits DIALOG_REQUEST_EVENT during the
 * caller's synchronous run, so a listener attached afterwards would miss it.
 */
function capture(broker: UserDialogBroker): () => UserQuestionRequest {
  let captured: UserQuestionRequest | undefined
  broker.once(DIALOG_REQUEST_EVENT, (r: UserQuestionRequest) => (captured = r))
  return () => {
    if (!captured) throw new Error('no question request was emitted')
    return captured
  }
}

describe('UserDialogBroker', () => {
  it('declares permission_ask_user_question as the primary dialog kind', () => {
    expect(ASK_USER_QUESTION_KINDS[0]).toBe('permission_ask_user_question')
  })

  describe('askForToolInput (canUseTool path)', () => {
    it('parks the picker and returns answers keyed by question text', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      expect(req().questions[0].header).toBe('Insert sites')

      broker.respond(req().requestId, [{ header: 'Insert sites', selected: ['One place'] }])
      expect(await pending).toEqual({ 'Where does the INSERT happen?': 'One place' })
    })

    it('joins multi-select labels for a question', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      broker.respond(req().requestId, [{ header: 'Insert sites', selected: ['One place', 'Multiple'] }])
      expect(await pending).toEqual({ 'Where does the INSERT happen?': 'One place, Multiple' })
    })

    it('returns null when the user selects nothing', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      broker.respond(req().requestId, [{ header: 'Insert sites', selected: [] }])
      expect(await pending).toBeNull()
    })

    it('returns null (no picker) for a payload without questions', async () => {
      const broker = new UserDialogBroker()
      let emitted = false
      broker.once(DIALOG_REQUEST_EVENT, () => (emitted = true))
      expect(await broker.askForToolInput('t1', { foo: 'bar' }, new AbortController().signal)).toBeNull()
      expect(emitted).toBe(false)
    })

    it('resolves null when the thread is disposed mid-question', async () => {
      const broker = new UserDialogBroker()
      capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      broker.disposeThread('t1')
      expect(await pending).toBeNull()
    })

    it('resolves null when the abort signal fires', async () => {
      const broker = new UserDialogBroker()
      capture(broker)
      const controller = new AbortController()
      const pending = broker.askForToolInput('t1', TOOL_INPUT, controller.signal)
      controller.abort()
      expect(await pending).toBeNull()
    })
  })

  describe('respond delivery signal (#290)', () => {
    it('returns true when the answer reaches a pending dialog', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      const delivered = broker.respond(req().requestId, [{ header: 'Insert sites', selected: ['One place'] }])
      expect(delivered).toBe(true)
      await pending // drain the parked promise
    })

    it('returns false for an unknown / already-disposed requestId — so the caller can surface the miss', () => {
      const broker = new UserDialogBroker()
      // No dialog was ever parked (mirrors a crashed session that disposed it).
      expect(broker.respond('gone', [{ header: 'x', selected: ['y'] }])).toBe(false)
    })

    it('returns false on a SECOND respond after the dialog was disposed mid-question', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      const requestId = req().requestId
      broker.disposeThread('t1') // session crash resolves the parked dialog with null
      expect(await pending).toBeNull()
      // The user submits the stale card AFTER disposal → miss, not a silent success.
      expect(broker.respond(requestId, [{ header: 'Insert sites', selected: ['One place'] }])).toBe(false)
    })
  })

  describe('cancelThreadQuestions — user moved on (#692)', () => {
    it('resolves the parked promise null and emits DIALOG_CANCEL_EVENT with the requestId', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      const requestId = req().requestId

      let cancel: DialogCancel | undefined
      broker.once(DIALOG_CANCEL_EVENT, (c: DialogCancel) => (cancel = c))
      broker.cancelThreadQuestions('t1')

      // Agent unblocks with the "no answer" default (null → tool proceeds).
      expect(await pending).toBeNull()
      // Renderer is told which cards to drop so the never-drop queue stops re-showing.
      expect(cancel).toEqual({ threadId: 't1', requestIds: [requestId] })
    })

    it('is a no-op (no event) when the thread has no parked question', () => {
      const broker = new UserDialogBroker()
      let emitted = false
      broker.once(DIALOG_CANCEL_EVENT, () => (emitted = true))
      broker.cancelThreadQuestions('t1')
      expect(emitted).toBe(false)
    })

    it('cancels only the target thread, leaving another thread’s question parked', async () => {
      const broker = new UserDialogBroker()
      const a = capture(broker)
      const pendingA = broker.askForToolInput('tA', TOOL_INPUT, new AbortController().signal)
      a() // force-capture A before B overwrites the once-listener
      const b = capture(broker)
      const pendingB = broker.askForToolInput('tB', TOOL_INPUT, new AbortController().signal)

      broker.cancelThreadQuestions('tA')
      expect(await pendingA).toBeNull()
      // tB is untouched — answering it still delivers.
      expect(broker.respond(b().requestId, [{ header: 'Insert sites', selected: ['One place'] }])).toBe(true)
      await pendingB
    })

    it('a respond AFTER cancel is a miss (the dialog is gone) — #290 parity', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      const requestId = req().requestId
      broker.cancelThreadQuestions('t1')
      expect(await pending).toBeNull()
      expect(broker.respond(requestId, [{ header: 'Insert sites', selected: ['One place'] }])).toBe(false)
    })
  })

  // The hang this fixes: main parks on `canUseTool` with NO timeout, so a
  // question whose only copy was the renderer's in-memory queue became
  // unrecoverable the moment that copy died (a reload, a window recreate).
  // Measured live: a thread sat at `needs-decision` for 7h13m with nothing to
  // click. `listPending` is what a rebuilt renderer reads back.
  describe('listPending — what main still holds', () => {
    const answer = [{ header: 'Insert sites', selected: ['One place'] }]

    it('lists a parked question — as the SAME payload that was emitted', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)

      const listed = broker.listPending('t1')
      expect(listed).toHaveLength(1)
      // Not merely equal: the object the renderer missed IS the object it reads
      // back, so a re-drawn card carries the requestId `respond` answers to.
      expect(listed[0]).toBe(req())
      expect(listed[0]?.requestId).toBe(req().requestId)
      expect(listed[0]?.threadId).toBe('t1')
      expect(listed[0]?.questions).toEqual(req().questions)

      broker.respond(req().requestId, answer)
      await pending
    })

    it('stops listing a question once it is answered', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      // Positive first (allowed-pattern #28): it WAS listed, and the answer
      // reached a real parked dialog…
      expect(broker.listPending('t1').map((r) => r.requestId)).toEqual([req().requestId])
      expect(broker.respond(req().requestId, answer)).toBe(true)
      await pending
      // …so the empty list is evidence of the answer, not of an empty broker.
      expect(broker.listPending('t1')).toEqual([])
    })

    it('stops listing a question once the user moves on and it is cancelled', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      expect(broker.listPending('t1').map((r) => r.requestId)).toEqual([req().requestId])

      broker.cancelThreadQuestions('t1')
      expect(await pending).toBeNull()
      expect(broker.listPending('t1')).toEqual([])
    })

    it('stops listing a question once its thread is disposed (session crash)', async () => {
      const broker = new UserDialogBroker()
      const req = capture(broker)
      const pending = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      expect(broker.listPending('t1').map((r) => r.requestId)).toEqual([req().requestId])

      broker.disposeThread('t1')
      expect(await pending).toBeNull()
      expect(broker.listPending('t1')).toEqual([])
    })

    it('keeps two threads apart — neither leaks into the other', async () => {
      const broker = new UserDialogBroker()
      const a = capture(broker)
      const pendingA = broker.askForToolInput('tA', TOOL_INPUT, new AbortController().signal)
      a() // force-capture A before B overwrites the once-listener
      const b = capture(broker)
      const pendingB = broker.askForToolInput('tB', TOOL_INPUT, new AbortController().signal)

      expect(broker.listPending('tA').map((r) => r.requestId)).toEqual([a().requestId])
      expect(broker.listPending('tB').map((r) => r.requestId)).toEqual([b().requestId])
      expect(broker.listPending('tC')).toEqual([])

      // Answering tA leaves tB listed — a re-sync of one thread cannot clear another.
      expect(broker.respond(a().requestId, answer)).toBe(true)
      await pendingA
      expect(broker.listPending('tA')).toEqual([])
      expect(broker.listPending('tB').map((r) => r.requestId)).toEqual([b().requestId])

      broker.respond(b().requestId, answer)
      await pendingB
    })

    it('lists every question a thread has parked, in park order', async () => {
      const broker = new UserDialogBroker()
      const first = capture(broker)
      const pendingFirst = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)
      first()
      const second = capture(broker)
      const pendingSecond = broker.askForToolInput('t1', TOOL_INPUT, new AbortController().signal)

      expect(broker.listPending('t1').map((r) => r.requestId)).toEqual([
        first().requestId,
        second().requestId,
      ])
      // The count the status gate reads agrees with the list the renderer reads.
      expect(broker.pendingDialogs('t1')).toBe(2)

      broker.respond(first().requestId, answer)
      broker.respond(second().requestId, answer)
      await Promise.all([pendingFirst, pendingSecond])
    })

    it('lists nothing for a thread that never asked', () => {
      const broker = new UserDialogBroker()
      expect(broker.listPending('never-asked')).toEqual([])
    })
  })

  describe('createOnUserDialog (fallback)', () => {
    it('resolves an allow result carrying the answers on updatedInput', async () => {
      const broker = new UserDialogBroker()
      const handler = broker.createOnUserDialog('t1')
      const req = { dialogKind: 'permission_ask_user_question', payload: TOOL_INPUT } as UserDialogRequest
      const getReq = capture(broker)
      const result = handler(req, { signal: new AbortController().signal, requestId: 'sdk-req-1' })
      broker.respond(getReq().requestId, [{ header: 'Insert sites', selected: ['One place'] }])
      const resolved = (await result) as {
        behavior: string
        result?: { behavior: string; updatedInput: { answers: Record<string, string> } }
      }
      expect(resolved.behavior).toBe('completed')
      expect(resolved.result?.behavior).toBe('allow')
      expect(resolved.result?.updatedInput.answers).toEqual({
        'Where does the INSERT happen?': 'One place',
      })
    })

    it('cancels a non-question payload', async () => {
      const broker = new UserDialogBroker()
      const handler = broker.createOnUserDialog('t1')
      const req = { dialogKind: 'other', payload: { foo: 'bar' } } as UserDialogRequest
      expect(await handler(req, { signal: new AbortController().signal, requestId: 'sdk-req-1' })).toEqual({
        behavior: 'cancelled',
      })
    })
  })
})
