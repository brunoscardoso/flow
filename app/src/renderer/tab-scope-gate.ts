/**
 * OPENS WAIT FOR THE SET THEY WERE ASKED IN — the pure half of filing a press
 * into the right conversation's tab set.
 *
 * Selecting a conversation switches the chat pane at once, but the editor keeps
 * showing the outgoing set until main has answered `loadTabSet` and the incoming
 * set is rebuilt. A press of Open artifact, Blueprint, Browser, Changes or a
 * file chip in that window used to open straight into the OUTGOING set — it was
 * captured into the old thread's row a moment later, and the thread the person
 * was actually reading never got it.
 *
 * So a press made while the editor is not showing the set that was asked for is
 * QUEUED here, bound to the set wanted at the moment of the press, and replayed
 * once that set is on screen. A press bound to a set that is abandoned before it
 * ever shows (the person moved on again) is dropped rather than filed into a
 * conversation they did not press it in.
 *
 * A conversation selection may need a round trip to main before anyone knows
 * which set it means (`threadProject`); while such a signal is unresolved a
 * press is queued UNBOUND and bound to whatever the signal settles on.
 *
 * DOM-free: the coordinator (`project-context.ts`) drives it, and the surfaces
 * that open views call `runInWantedScope`.
 */
import { sameScope, type TabScopeKey } from './tab-scope-model'

interface QueuedOpen {
  /** The set the press belongs to; `undefined` while a signal is unresolved. */
  scope: TabScopeKey | null | undefined
  run: () => void
  drop: () => void
}

export class TabScopeGate {
  #shown: TabScopeKey | null = null
  #wanted: TabScopeKey | null = null
  /** Conversation signals still finding out which set they mean. */
  #unresolvedSignals = 0
  #queue: QueuedOpen[] = []

  /** The set on screen. */
  get shown(): TabScopeKey | null {
    return this.#shown
  }

  /** The set last asked for — where a press made NOW belongs. */
  get wanted(): TabScopeKey | null {
    return this.#wanted
  }

  /** True while a press could land in a set other than the one it was made in. */
  get unsettled(): boolean {
    return this.#unresolvedSignals > 0 || !sameScope(this.#shown, this.#wanted)
  }

  /** How many presses are waiting (for tests and diagnostics). */
  get queued(): number {
    return this.#queue.length
  }

  /**
   * Run `open` in the set it was pressed in: now, when that set is on screen,
   * or once it is. Resolves with `open`'s result, or `undefined` when the press
   * was dropped because its set was abandoned before it showed.
   */
  run<T>(open: () => T | Promise<T>): Promise<T | undefined> {
    if (!this.unsettled) {
      try {
        return Promise.resolve(open())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    return new Promise<T | undefined>((resolve, reject) => {
      this.#queue.push({
        scope: this.#unresolvedSignals > 0 ? undefined : this.#wanted,
        run: () => {
          try {
            resolve(open())
          } catch (error) {
            reject(error)
          }
        },
        drop: () => resolve(undefined),
      })
    })
  }

  /** A set was asked for. Presses bound to any other not-yet-shown set are dropped. */
  want(next: TabScopeKey | null): void {
    this.#wanted = next
    this.#queue = this.#queue.filter((entry) => {
      if (entry.scope === undefined || sameScope(entry.scope, next)) return true
      entry.drop()
      return false
    })
    this.#drain()
  }

  /** A conversation signal arrived whose set is not known yet. */
  holdSignal(): void {
    this.#unresolvedSignals += 1
  }

  /** That signal resolved (it may or may not have asked for a set). */
  releaseSignal(): void {
    this.#unresolvedSignals = Math.max(0, this.#unresolvedSignals - 1)
    if (this.#unresolvedSignals > 0) return
    // Every press made while nobody knew is now known to belong to the set
    // the signals settled on.
    for (const entry of this.#queue) {
      if (entry.scope === undefined) entry.scope = this.#wanted
    }
    this.#drain()
  }

  /** The editor now shows `scope`. Presses made for it run. */
  settled(scope: TabScopeKey | null): void {
    this.#shown = scope
    this.#drain()
  }

  /** Run every press bound to the set on screen; keep the rest waiting. */
  #drain(): void {
    const ready: QueuedOpen[] = []
    this.#queue = this.#queue.filter((entry) => {
      if (entry.scope === undefined || !sameScope(entry.scope, this.#shown)) return true
      // A press bound to the shown set is only replayed once no unresolved
      // signal could still move the editor somewhere else first.
      if (this.#unresolvedSignals > 0 && !sameScope(this.#wanted, this.#shown)) return true
      ready.push(entry)
      return false
    })
    for (const entry of ready) entry.run()
  }
}

/** The window's one gate — driven by the project-context coordinator. */
export const tabScopeGate = new TabScopeGate()

/**
 * Open something in the conversation the person pressed it in. Every door that
 * opens a view or file into the tab set (a person's press, never a tab-set
 * restore) goes through here.
 */
export function runInWantedScope<T>(open: () => T | Promise<T>): Promise<T | undefined> {
  return tabScopeGate.run(open)
}
