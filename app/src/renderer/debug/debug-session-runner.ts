/**
 * WHO OWNS THE SESSION, now that the button does not.
 *
 * The control moved into the BROWSER TOOLBAR, beside Inspect, because that is
 * where a person is standing when they decide to record something. But a
 * session is global — it records the terminals too, and it outlives any one
 * browser tab, which the chrome that draws the button does not.
 *
 * So the two are split:
 *
 *   this runner   owns start/stop, the poll while live, and the outcome
 *                 message. Mounted ONCE by the shell.
 *   the button    dispatches `flow:debug-toggle` and redraws on
 *                 `flow:debug-state`. It can be created and destroyed with its
 *                 tab without the session noticing.
 *
 * Document events rather than a shared object because the browser chrome is
 * built by the editor's tab system, not by the shell — the same reason
 * `flow:show-terminal` and `flow:open-thread` are events here.
 */

import type { DebugSessionSummary, DebugStopResult } from '../../shared/debug-session-ipc'
import { outcomeOf } from './debug-outcome'

/** Anyone may ask to start or finish a session. */
export const DEBUG_TOGGLE_EVENT = 'flow:debug-toggle'
/** The runner says what is live now; null means nothing is. */
export const DEBUG_STATE_EVENT = 'flow:debug-state'

/** How often a live session is asked how it is doing. */
const POLL_MS = 1000

interface DebugApi {
  start(request: { threadId: string | null }): Promise<DebugSessionSummary>
  stop(request: Record<string, never>): Promise<DebugStopResult | null>
  status(request: Record<string, never>): Promise<DebugSessionSummary | null>
}

/**
 * Hand a finished session to the person and to the agent.
 *
 * A RECORDING IS A REFERENCE, NOT A TRANSCRIPT. The summary used to be appended
 * as a system message; a real session's — 3,720 records, twelve failures —
 * filled the conversation with a wall nobody could read. It becomes a context
 * CHIP instead, the same affordance a terminal selection uses: a labelled thing
 * sitting above the composer that the next message carries, and that the reader
 * can remove if they did not want it.
 *
 * And the file OPENS, because 2.8 MB nobody can reach is not a record.
 */
function handOff(result: DebugStopResult): void {
  if (result.timelinePath !== null) {
    // REVEAL THE SURFACE FIRST — the lesson #1057 (editor), #1071 (chat) and
    // #1313 (terminal split) each bought separately. Opening a file into a
    // hidden editor puts it somewhere nobody is looking, which is
    // indistinguishable from not opening it.
    document.dispatchEvent(new CustomEvent('flow:show-editor'))
    // After the reveal: the surface mounts in this same task, so the open runs
    // once that has settled.
    setTimeout(() => {
      document.dispatchEvent(
        new CustomEvent('flow:open-file-path', {
          detail: { path: result.timelinePath, rootPath: result.projectRoot ?? undefined },
        }),
      )
    }, 0)
  }
  document.dispatchEvent(
    new CustomEvent('flow:add-to-chat', {
      detail: {
        source: 'file',
        // Named by what it IS and what it found, so the chip reads as evidence
        // rather than as a path.
        label:
          result.records === 0
            ? 'Debug session — nothing recorded'
            : `Debug session — ${result.records} records`,
        text: result.summary,
      },
    }),
  )
}

export interface DebugSessionRunner {
  dispose(): void
}

export function createDebugSessionRunner(deps: {
  api: DebugApi
  /** The conversation a session belongs to, asked when Debug is pressed. */
  activeThreadId: () => string | null
  /** Say something short — a session's outcome, or why it could not start. */
  notify: (message: string) => void
}): DebugSessionRunner {
  let live: DebugSessionSummary | null = null
  let busy = false
  let timer: ReturnType<typeof setInterval> | null = null

  /** Tell every button, wherever it currently exists. */
  function announce(): void {
    document.dispatchEvent(
      new CustomEvent(DEBUG_STATE_EVENT, { detail: { session: live } }),
    )
  }

  function poll(on: boolean): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    // ONLY WHILE RECORDING (allowed-pattern #17). Idle, this asks main nothing
    // at all, which is the state it is in almost always.
    if (!on) return
    timer = setInterval(() => {
      void (async () => {
        try {
          const status = await deps.api.status({})
          if (status === null && live !== null) {
            // A session that outlived its ceiling stops itself when asked.
            live = null
            poll(false)
            deps.notify('The debug session reached its limit and stopped itself.')
          } else if (status !== null) {
            live = status
          }
          announce()
        } catch {
          // A failed status read is not a reason to throw away a live session.
        }
      })()
    }, POLL_MS)
  }

  async function toggle(): Promise<void> {
    if (busy) return
    busy = true
    try {
      if (live === null) {
        live = await deps.api.start({ threadId: deps.activeThreadId() })
        poll(true)
      } else {
        const result = await deps.api.stop({})
        live = null
        poll(false)
        if (result !== null) {
          handOff(result)
          deps.notify(outcomeOf(result))
        }
      }
    } catch (error) {
      deps.notify('The debug session could not be started.')
      console.warn('flow: debug session', error)
      live = null
      poll(false)
    } finally {
      busy = false
      announce()
    }
  }

  const onToggle = (): void => void toggle()
  document.addEventListener(DEBUG_TOGGLE_EVENT, onToggle)

  // A button created AFTER a session started must not draw itself idle, so a
  // fresh one asks and the runner answers.
  const onAsk = (): void => announce()
  document.addEventListener('flow:debug-ask', onAsk)

  return {
    dispose(): void {
      poll(false)
      document.removeEventListener(DEBUG_TOGGLE_EVENT, onToggle)
      document.removeEventListener('flow:debug-ask', onAsk)
    },
  }
}
