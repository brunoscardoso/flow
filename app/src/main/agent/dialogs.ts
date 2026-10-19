// UserDialog pipeline — bridges the SDK's onUserDialog control channel to the
// renderer's inline question card, so AskUserQuestion actually renders in Flow
// instead of auto-cancelling.
//
// Why this exists: the Claude Agent SDK only emits a `request_user_dialog` for
// a `dialogKind` the host DECLARES in `dialogKinds` AND provides `onUserDialog`
// for. With neither, the CLI applies the dialog's "no-dialog" default — for
// AskUserQuestion that is "the user did not answer the questions", so the agent
// silently proceeds with defaults. Declaring 'askUserQuestion' + this handler
// reroutes the dialog to the Flow UI.
//
// Flow: onUserDialog parks on a promise, emits DIALOG_REQUEST_EVENT (the IPC
// layer broadcasts it), and resolves when the renderer answers via respond().
// An aborted/disposed dialog resolves to `{behavior:'cancelled'}` — the CLI
// then applies its default, exactly as before.

import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'

import type { OnUserDialog } from '@anthropic-ai/claude-agent-sdk'

import type { UserQuestion, UserQuestionAnswer, UserQuestionRequest } from '../../shared/ipc-contract'

/** Emitted when the agent asks a question. Payload: UserQuestionRequest. */
export const DIALOG_REQUEST_EVENT = 'dialog-request'

/**
 * Emitted when parked questions are cancelled because the user moved on — sent a
 * new chat message instead of answering (#692). Payload: `{ threadId, requestIds }`.
 * The renderer drops the matching cards so the never-drop queue stops re-showing
 * them on every feed rebuild.
 */
export const DIALOG_CANCEL_EVENT = 'dialog-cancel'

/** Payload for {@link DIALOG_CANCEL_EVENT}. */
export interface DialogCancel {
  threadId: string
  requestIds: string[]
}

/**
 * Dialog kinds that carry an AskUserQuestion payload. The embedded CLI models
 * AskUserQuestion as a PERMISSION dialog: `dialog_kind = 'permission_ask_user_question'`,
 * payload `{requestId, toolName, permissionResult, questions}`, and the result
 * must be a permission result (`{behavior:'allow'|'deny'|'cancelled'}`). This
 * exact kind was confirmed from the bundled CLI's dialog descriptor
 * (`dS({kind:"permission_ask_user_question", …})`); `askUserQuestion` is kept as
 * a legacy fallback for other builds. The handler is payload-driven, so an
 * unrelated kind that ever matched simply falls back to the CLI default.
 */
export const ASK_USER_QUESTION_KINDS = ['permission_ask_user_question', 'askUserQuestion'] as const

/** @deprecated Use ASK_USER_QUESTION_KINDS. Kept for existing imports. */
export const ASK_USER_QUESTION_KIND = ASK_USER_QUESTION_KINDS[0]

interface PendingDialog {
  threadId: string
  /** Resolves with the user's answers, or null on cancel / dispose / abort. */
  resolve: (answers: UserQuestionAnswer[] | null) => void
  cleanup: () => void
}

export class UserDialogBroker extends EventEmitter {
  private readonly pending = new Map<string, PendingDialog>()

  /**
   * Park a set of questions for the renderer's inline QuestionCard and resolve
   * with the user's answers (or null if cancelled/disposed/aborted). Shared by
   * both the canUseTool AskUserQuestion path (the real channel in SDK mode) and
   * the onUserDialog fallback.
   */
  askQuestions(
    threadId: string,
    questions: UserQuestion[],
    signal?: AbortSignal,
  ): Promise<UserQuestionAnswer[] | null> {
    if (questions.length === 0 || signal?.aborted) return Promise.resolve(null)
    const requestId = randomUUID()
    return new Promise<UserQuestionAnswer[] | null>((resolve) => {
      const onAbort = (): void => {
        this.pending.delete(requestId)
        resolve(null)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        threadId,
        resolve,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      })
      const payload: UserQuestionRequest = { requestId, threadId, questions }
      this.emit(DIALOG_REQUEST_EVENT, payload)
    })
  }

  /**
   * canUseTool AskUserQuestion path: parse the tool input's questions, park the
   * picker, and return an `answers` map keyed by QUESTION TEXT with the selected
   * option label(s) joined — the exact shape the AskUserQuestion tool reads from
   * its `answers` input field (confirmed from the bundled CLI). Returns null when
   * there are no questions or the user made no selection.
   */
  async askForToolInput(
    threadId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, string> | null> {
    const questions = parseQuestions(input)
    console.log(`[Dialog] AskUserQuestion questions=${questions.length}`)
    if (questions.length === 0) return null
    const answers = await this.askQuestions(threadId, questions, signal)
    if (!answers) return null
    const map = answersToInputMap(questions, answers)
    console.log(`[Dialog] AskUserQuestion answers=${safePreview(map)}`)
    return Object.keys(map).length > 0 ? map : null
  }

  /**
   * SDK onUserDialog fallback (kept in case a build routes AskUserQuestion via
   * request_user_dialog instead of canUseTool). Returns a permission-shaped
   * result carrying the answers on the tool input.
   */
  createOnUserDialog(threadId: string): OnUserDialog {
    return async (request, options) => {
      console.log(
        `[Dialog] request kind=${request.dialogKind} payload=${safePreview(request.payload)}`,
      )
      const questions = parseQuestions(request.payload)
      if (questions.length === 0 || options.signal.aborted) return { behavior: 'cancelled' }
      const answers = await this.askQuestions(threadId, questions, options.signal)
      if (!answers) return { behavior: 'cancelled' }
      const map = answersToInputMap(questions, answers)
      if (Object.keys(map).length === 0) return { behavior: 'cancelled' }
      const updatedInput = { ...request.payload, answers: map }
      return { behavior: 'completed', result: { behavior: 'allow', updatedInput } }
    }
  }

  /**
   * Renderer answer for a pending question — resolves the parked promise.
   * Returns `false` when NO dialog is pending for `requestId` (already disposed
   * by a crashed/torn-down session, #290). A silent no-op here would let the
   * renderer's respondDialog resolve as success, so the QuestionCard would flip
   * to "Answered" while the answer was thrown away; the caller surfaces the miss
   * so the card rolls back and shows its "Failed to send" error instead.
   */
  respond(requestId: string, answers: UserQuestionAnswer[]): boolean {
    const pending = this.pending.get(requestId)
    if (!pending) return false
    this.pending.delete(requestId)
    pending.cleanup()
    pending.resolve(answers)
    return true
  }

  /** The thread a still-parked request belongs to, or null once it has been
   *  answered/disposed. Callers read it BEFORE {@link respond} removes the entry. */
  threadOf(requestId: string): string | null {
    return this.pending.get(requestId)?.threadId ?? null
  }

  /** How many questions are parked for a thread. The status-restore gate reads
   *  this alongside the permission broker's count so a thread only leaves
   *  `needs-decision` once NO ask of any kind remains (permission or dialog). */
  pendingDialogs(threadId: string): number {
    let count = 0
    for (const pending of this.pending.values()) {
      if (pending.threadId === threadId) count += 1
    }
    return count
  }

  /** Cancel every question parked for a thread (session ended/crashed). Silent —
   *  the renderer surface is being torn down anyway on these paths. */
  disposeThread(threadId: string): void {
    this.#cancelForThread(threadId)
  }

  /**
   * Cancel a thread's parked questions because the user moved on — sent a new
   * message instead of answering (#692). Same resolution as disposeThread (each
   * promise resolves null → the AskUserQuestion tool proceeds with its "no answer"
   * default, so the agent unblocks), but ALSO emits DIALOG_CANCEL_EVENT so the
   * renderer removes the stale card. Without this the never-drop queue re-buffers
   * the unanswered card and re-renders it on every feed rebuild. No-op (no event)
   * when nothing is parked for the thread.
   */
  cancelThreadQuestions(threadId: string): void {
    const requestIds = this.#cancelForThread(threadId)
    if (requestIds.length > 0) {
      this.emit(DIALOG_CANCEL_EVENT, { threadId, requestIds } satisfies DialogCancel)
    }
  }

  /** Resolve+remove every pending dialog for a thread; returns their requestIds. */
  #cancelForThread(threadId: string): string[] {
    const cancelled: string[] = []
    for (const [requestId, pending] of this.pending) {
      if (pending.threadId !== threadId) continue
      this.pending.delete(requestId)
      pending.cleanup()
      pending.resolve(null)
      cancelled.push(requestId)
    }
    return cancelled
  }
}

/**
 * Map answers (keyed by header, from the QuestionCard) to the tool's `answers`
 * input shape: `{ [questionText]: "Label A, Label B" }`. Questions with no
 * selection are omitted.
 */
function answersToInputMap(
  questions: UserQuestion[],
  answers: UserQuestionAnswer[],
): Record<string, string> {
  const map: Record<string, string> = {}
  for (const question of questions) {
    const answer = answers.find((a) => a.header === question.header)
    const selected = answer?.selected ?? []
    if (selected.length > 0) map[question.question] = selected.join(', ')
  }
  return map
}

/** Parse the AskUserQuestion dialog payload (`{questions:[...]}`) defensively. */
function parseQuestions(payload: Record<string, unknown>): UserQuestion[] {
  const raw = (payload as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  const questions: UserQuestion[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const options = Array.isArray(record.options)
      ? record.options
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({
            label: String(o.label ?? ''),
            description: typeof o.description === 'string' ? o.description : '',
          }))
      : []
    questions.push({
      question: String(record.question ?? ''),
      header: String(record.header ?? ''),
      multiSelect: record.multiSelect === true,
      options,
    })
  }
  return questions
}

function safePreview(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 600)
  } catch {
    return '[unserializable]'
  }
}
