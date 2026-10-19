/**
 * SHELL PERSISTENCE — which user shells each scope had open, written by main.
 *
 * Each conversation is its own context, and the shells a person opens belong
 * to the conversation (or project view) they were opened in. What has to
 * survive a restart is enough to re-spawn them there: their title and the
 * directory they were opened in, per (project, thread). The title saved is the
 * person's name for the tab when they gave one — a renamed tab comes back
 * under that name — else the automatic folder name.
 *
 * MAIN WRITES THIS, NOT THE RENDERER, because only main can tell a person
 * closing a shell from housekeeping. Quit disposes every terminal; removing a
 * project or deleting a thread disposes theirs. Read naively, each of those
 * would save an empty set and nothing would ever come back. So a scope's set is
 * re-saved on exactly these signals:
 *
 *   - a shell opened in it                  (TERMINAL_CREATED_EVENT)
 *   - an unowned shell was adopted by it    (TERMINAL_OWNER_SET_EVENT)
 *   - a person renamed one of its shells    (TERMINAL_RENAMED_EVENT)
 *   - a person closed one of its shells     (TERMINAL_CLOSED_BY_USER_EVENT)
 *   - one of its shells exited while still registered (TERMINAL_EXIT_EVENT —
 *     a shell disposed for quit is already unregistered when its exit lands,
 *     so it never counts)
 *
 * and each save is the scope's CURRENT live shells, recomputed from the
 * manager — never an append, so a missed event cannot accumulate ghosts.
 */
import type { SavedTerminalRef, TerminalInfo, TerminalOwner } from '../../shared/ipc-contract'
import {
  TERMINAL_CLOSED_BY_USER_EVENT,
  TERMINAL_CREATED_EVENT,
  TERMINAL_EXIT_EVENT,
  TERMINAL_OWNER_SET_EVENT,
  TERMINAL_RENAMED_EVENT,
  type TerminalExitEvent,
  type TerminalManager,
} from './index'

/** Where a scope's shells are written (the project context, in the app). */
export interface ShellPersistenceSink {
  saveScopeTerminals(rootPath: string, threadId: string | null, terminals: SavedTerminalRef[]): void
}

/** The live user shells `owner` holds, in creation order, as saved refs. */
export function ownedShellRefs(
  terminals: readonly TerminalInfo[],
  owner: TerminalOwner,
): SavedTerminalRef[] {
  return terminals
    .filter(
      (info) =>
        info.kind === 'user' &&
        info.exited !== true &&
        info.owner !== undefined &&
        info.owner.rootPath === owner.rootPath &&
        info.owner.threadId === owner.threadId,
    )
    .map((info) => ({ title: info.customTitle ?? info.title, cwd: info.cwd }))
}

/** Wire the signals above to `sink`. Returns the unsubscribe. */
export function wireShellPersistence(
  manager: Pick<TerminalManager, 'on' | 'off' | 'listTerminals' | 'getTerminal'>,
  sink: ShellPersistenceSink,
): () => void {
  const persist = (owner: TerminalOwner): void => {
    try {
      sink.saveScopeTerminals(
        owner.rootPath,
        owner.threadId,
        ownedShellRefs(manager.listTerminals(), owner),
      )
    } catch (error) {
      // A failed write loses a restart's restore, never a running shell.
      console.warn('[Terminal] failed to persist a scope’s shells', error)
    }
  }
  const onCreated = (info: TerminalInfo): void => {
    if (info.kind === 'user' && info.owner !== undefined) persist(info.owner)
  }
  const onClosed = (info: TerminalInfo): void => {
    if (info.kind === 'user' && info.owner !== undefined) persist(info.owner)
  }
  const onExit = ({ terminalId }: TerminalExitEvent): void => {
    const info = manager.getTerminal(terminalId)
    if (info === null) return // disposed (quit / removal) — housekeeping, not a choice
    if (info.kind === 'user' && info.owner !== undefined) persist(info.owner)
  }
  manager.on(TERMINAL_CREATED_EVENT, onCreated)
  manager.on(TERMINAL_OWNER_SET_EVENT, onCreated)
  manager.on(TERMINAL_RENAMED_EVENT, onCreated)
  manager.on(TERMINAL_CLOSED_BY_USER_EVENT, onClosed)
  manager.on(TERMINAL_EXIT_EVENT, onExit)
  return () => {
    manager.off(TERMINAL_CREATED_EVENT, onCreated)
    manager.off(TERMINAL_OWNER_SET_EVENT, onCreated)
    manager.off(TERMINAL_RENAMED_EVENT, onCreated)
    manager.off(TERMINAL_CLOSED_BY_USER_EVENT, onClosed)
    manager.off(TERMINAL_EXIT_EVENT, onExit)
  }
}
