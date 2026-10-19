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
