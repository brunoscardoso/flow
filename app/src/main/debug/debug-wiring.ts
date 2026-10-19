/**
 * THE SESSION, CONNECTED TO THE REAL APP.
 *
 * `debug-session.ts` is deliberately ignorant — it takes its sources as
 * functions so the window's behaviour can be tested with plain objects and a
 * fake clock. This is the one place that hands it the real ones, and the only
 * place that knows a terminal manager or a browser controller exists.
 *
 * Keeping the two apart is what let the window's rules — starting twice, a
 * terminal out of scope, an evicted browser buffer, an untimed pre-roll — be
 * covered by ten fast unit tests instead of an Electron harness.
 */

import type { BrowserCapture, BrowserCaptureKind } from '../../shared/browser-capture-types'
import type { DebugTerminalRef } from '../../shared/debug-session-types'
import type { StampedTerminalChunk } from '../../shared/terminal-stamp'
import type { DebugSessionDeps } from './debug-session'

/** The slice of the terminal manager a session needs. */
export interface TerminalSource {
  observeOutput(observer: (chunk: StampedTerminalChunk) => void): () => void
  listTerminals(): { terminalId: string; projectRoot?: string | undefined; title?: string }[]
  getScrollback(terminalId: string): string | null
}

/** The slice of the browser controller a session needs. */
export interface BrowserSource {
  bufferSlice(kind: BrowserCaptureKind, selector: { mode: 'last-n'; n: number }): BrowserCapture[]
}

/**
 * Which project roots a session should listen to.
 *
 * A FUNCTION RETURNING ROOTS, not a store to interrogate. The first cut asked a
 * thread record for `projectRoot` and `additionalRoots` — neither of which
 * exists on it: a thread carries `projectRoot`, and the multi-root SCOPE is
 * owned by `ThreadScopeManager`, which is the thing that actually knows what a
 * conversation spans. Taking the answer instead of the source keeps that
 * knowledge in one place and this module ignorant of both.
 */
export type ScopeRoots = (threadId: string | null) => readonly string[]

/** Everything a session reads, when nothing narrows it further. */
const BUFFER_SWEEP = 1000

/** The last N lines of a string, for the pre-roll. */
function tailLines(text: string, lines: number): string {
  const all = text.split('\n')
  return all.length <= lines ? text : all.slice(all.length - lines).join('\n')
}

/**
 * A terminal's name, as the artifact should print it.
 *
 * The PROJECT rather than the tab's title: a session spans several projects by
 * definition — the backend in one, the app in another — and "which project
 * printed this" is the question a reader has. Two tabs both called "zsh" would
 * make the timeline unreadable.
 */
function labelFor(terminal: { projectRoot?: string | undefined; title?: string }): string {
  const root = terminal.projectRoot
  if (root !== undefined && root !== '') {
    const base = root.split('/').filter(Boolean).pop()
    if (base !== undefined && base !== '') return base
  }
  return terminal.title ?? 'terminal'
}

export function makeDebugSessionDeps(sources: {
  /**
   * The terminal manager, LATE-BOUND.
   *
   * An accessor rather than the instance because the manager is constructed
   * after the IPC handlers are registered — passing the value would capture
   * `null` for the life of the app. It stays REQUIRED (allowed-pattern #26):
   * a caller must say something about terminals, and a session whose accessor
   * returns null records the browser alone AND SAYS SO in its artifact, rather
   * than claiming a silence it never listened for.
   */
  terminals: () => TerminalSource | null
  browser: BrowserSource
  scopeRoots: ScopeRoots
  /** The project in front of the person, when the scope says nothing. */
  activeProjectRoot: () => string | null
}): DebugSessionDeps {
  return {
    observeTerminalOutput: (observer) =>
      sources.terminals()?.observeOutput(observer) ?? (() => undefined),

    terminalsInScope: (threadId): DebugTerminalRef[] => {
      // THE THREAD'S SCOPE, which is a set of roots and not one root: a
      // conversation spanning two projects has terminals in both, and the
      // decision taken in discovery was to record all of them rather than ask
      // at the moment somebody is about to reproduce a bug.
      const roots = new Set<string>(sources.scopeRoots(threadId))
      if (roots.size === 0) {
        const active = sources.activeProjectRoot()
        if (active !== null) roots.add(active)
      }
      const matched = (sources.terminals()?.listTerminals() ?? []).filter(
        (terminal) => terminal.projectRoot !== undefined && roots.has(terminal.projectRoot),
      )
      // TELL TWO SHELLS IN ONE PROJECT APART.
      //
      // Three terminals in the same checkout all answered to the project's
      // name, so the artifact read "Captured the browser and X, X, X" and every
      // quoted line was attributed to the same X (user, 2026-09-21). A name
      // that does not distinguish is worse than a number: the reader believes
      // it does.
      const counts = new Map<string, number>()
      for (const terminal of matched) {
        const base = labelFor(terminal)
        counts.set(base, (counts.get(base) ?? 0) + 1)
      }
      const seen = new Map<string, number>()
      return matched.map((terminal) => {
        const base = labelFor(terminal)
        const total = counts.get(base) ?? 1
        if (total === 1) {
          return { terminalId: terminal.terminalId, label: base, projectRoot: terminal.projectRoot }
        }
        const nth = (seen.get(base) ?? 0) + 1
        seen.set(base, nth)
        return {
          terminalId: terminal.terminalId,
          label: `${base} #${nth}`,
          projectRoot: terminal.projectRoot,
        }
      })
    },

    scrollbackTail: (terminalId, lines) =>
      tailLines(sources.terminals()?.getScrollback(terminalId) ?? '', lines),

    browserCaptures: (): BrowserCapture[] => {
      // Both kinds, in one list — the session filters by its own window and
      // sorts everything onto one timeline, so there is nothing to separate.
      const selector = { mode: 'last-n' as const, n: BUFFER_SWEEP }
      try {
        return [
          ...sources.browser.bufferSlice('console', selector),
          ...sources.browser.bufferSlice('network', selector),
        ]
      } catch {
        // No browser tab has ever been opened, so there is no buffer. A session
        // recording only terminals is a real session, not a failed one.
        return []
      }
    },

    now: () => Date.now(),
  }
}
