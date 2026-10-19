/**
 * Bringing a conversation's saved shells back after a restart — DOM-free, so
 * the ordering rules are unit-testable apart from the panel.
 *
 * Two rules, each a bug when broken:
 *
 *  - ONCE PER SCOPE PER WINDOW, AND FIRST. The auto-start and an explicit +
 *    await the same restore. Main re-saves a scope's live shells whenever one
 *    opens, so a + that spawned before the restore ran would save a set of one
 *    over the shells it was about to bring back — and they would be gone.
 *
 *  - THE TREES ARE FIXED WHEN THE RESTORE STARTS. Spawning is one await per
 *    shell; a person switching conversations mid-restore changes the scope on
 *    screen, and re-reading it per shell put thread A's shells in thread B's
 *    checkout (or the project's own tree). Each shell still joins under its
 *    own conversation, hidden if that is no longer the one on screen.
 */
import type { SavedTerminalRef, TerminalOwner } from '../../shared/ipc-contract'
import { ownerSpawnOverride, restoreSpawnRoot, type TerminalScopeState } from './terminal-scope'

/** One scope's key — a project and a thread, or the project view. */
export function ownerKey(owner: TerminalOwner): string {
  return `${owner.rootPath}\n${owner.threadId ?? ''}`
}

export interface ScopeRestoreDeps {
  /** The shells `owner` had open when the app last closed. */
  load(owner: TerminalOwner): Promise<SavedTerminalRef[]>
  /**
   * The user shells `owner` holds RIGHT NOW (live, in main). Main saves a
   * scope's live set every time a shell opens, so a shell that opened in this
   * scope before its restore ran — the boot auto-start racing the scope's
   * arrival — is already IN the saved set, and re-spawning it was the
   * duplicate shell (one + made three tabs). Optional: without it every saved
   * shell is spawned, which is only right on a true cold start.
   */
  live?(owner: TerminalOwner): Promise<SavedTerminalRef[]>
  /** Re-spawn one of them in `rootPath`, owned by `owner`. */
  spawn(rootPath: string | undefined, ref: SavedTerminalRef, owner: TerminalOwner): Promise<void>
}

export class ScopeRestorer {
  readonly #deps: ScopeRestoreDeps
  readonly #runs = new Map<string, Promise<number>>()

  constructor(deps: ScopeRestoreDeps) {
    this.#deps = deps
  }

  /** Whether `owner`'s restore has started (it may still be running). */
  started(owner: TerminalOwner): boolean {
    return this.#runs.has(ownerKey(owner))
  }

  /**
   * Restore the scope on screen — `state.ownerScope` — once, resolving to how
   * many shells came back. Null when it cannot run yet: no conversation on
   * screen, or the scope roots still belong to another one (spawning now would
   * use the wrong checkout). A refused call is not remembered, so the next
   * arrival runs it.
   */
  restore(state: TerminalScopeState): Promise<number> | null {
    const owner = state.ownerScope
    if (owner === undefined || owner === null) return null
    const key = ownerKey(owner)
    const running = this.#runs.get(key)
    if (running !== undefined) return running
    const override = ownerSpawnOverride(state)
    if (override !== null && 'wait' in override) return null
    const captured: TerminalScopeState = { ...state }
    const fixedOwner: TerminalOwner = { rootPath: owner.rootPath, threadId: owner.threadId }
    const run = this.#run(fixedOwner, captured)
    this.#runs.set(key, run)
    return run
  }

  async #run(owner: TerminalOwner, state: TerminalScopeState): Promise<number> {
    let saved: SavedTerminalRef[] = []
    try {
      saved = await this.#deps.load(owner)
    } catch (error) {
      console.warn('flow: could not read the conversation’s saved terminals', error)
    }
    if (saved.length > 0 && this.#deps.live !== undefined) {
      try {
        saved = notYetLive(saved, await this.#deps.live(owner))
      } catch (error) {
        // Unknown is not "none live": spawning blind is the duplicate this
        // guards against, so a failed read restores nothing.
        console.warn('flow: could not read the conversation’s live terminals', error)
        saved = []
      }
    }
    for (const ref of saved) {
      try {
        await this.#deps.spawn(restoreSpawnRoot(ref.cwd, state), ref, owner)
      } catch (error) {
        // One shell that cannot come back must not keep the others away.
        console.warn('flow: could not restore a saved terminal', error)
      }
    }
    return saved.length
  }
}

/**
 * The saved shells that are not already running — matched by directory, one
 * live shell cancelling one saved shell (a scope may hold two in one tree).
 * The title is not compared: a shell's title follows what runs in it, so the
 * live one rarely still reads what was saved.
 */
export function notYetLive(
  saved: readonly SavedTerminalRef[],
  live: readonly SavedTerminalRef[],
): SavedTerminalRef[] {
  const running = new Map<string, number>()
  for (const ref of live) running.set(ref.cwd, (running.get(ref.cwd) ?? 0) + 1)
  const out: SavedTerminalRef[] = []
  for (const ref of saved) {
    const left = running.get(ref.cwd) ?? 0
    if (left > 0) running.set(ref.cwd, left - 1)
    else out.push(ref)
  }
  return out
}
