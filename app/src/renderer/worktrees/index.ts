/**
 * MOUNTING THE WORKTREE PANEL — the only place the panel meets the app.
 *
 * WHAT LIVES HERE. The panel decides what to show and what may be pressed; this
 * file owns the two things it cannot do for itself — make a worktree, release
 * one — plus keeping it told which project and which conversation it is
 * looking at. The panel never calls IPC directly, which is
 * what lets its decisions be tested without a preload.
 *
 * EVERY VERB IS THREAD-KEYED, which is why the panel is too. `prepareWorktree`
 * and `releaseWorktree` both take a thread, and neither needed a new channel.
 * Branch renaming is deliberately NOT here: a branch is not a worktree, and it
 * already has a door in the Changes toolbar.
 *
 * THE VISIBILITY SIGNAL IS THE PERFORMANCE STORY. Opening the popover is the
 * only thing that lets the panel spend an inventory read (allowed-pattern #17),
 * and it never subscribes to `git:changed` or `threads:updated`.
 */

import type { ThreadSummary, ThreadWorktreeResult } from '../../shared/ipc-contract'
import { prepareThreadWorktree } from '../threads/prepare-worktree-flow'
import { WorktreePanel } from './worktree-panel'

/** The slice of the preload API this needs. */
interface WorktreeApi {
  project: {
    active: () => Promise<{ rootPath: string } | null>
    onActiveChanged: (listener: (context: { rootPath: string } | null) => void) => void
  }
  threads: {
    get?: (request: { threadId: string }) => Promise<ThreadSummary | null>
    worktreeBranches?: (request: {
      rootPath: string
    }) => Promise<{ branches: Array<{ name: string }> }>
    prepareWorktree?: (request: {
      threadId: string
      branch?: string
      requested?: boolean
      carry?: 'commit' | 'stash' | 'clean'
    }) => Promise<ThreadWorktreeResult>
    releaseWorktree?: (request: {
      threadId: string
      confirmed?: boolean
      /** The second say-so — only the panel's second question ever sends it. */
      allowUnlanded?: boolean
    }) => Promise<
      | {
          status: string
          detail: string
          /** What the refusal found, when it refused for holding work. */
          changedFiles?: number
          aheadCommits?: number
        }
      | undefined
    >
  }
  git?: {
    status?: (request: { rootId: string }) => Promise<{ branch?: string } | null>
  }
}

export function initWorktrees(): void {
  const maybe = (window as unknown as { flow?: WorktreeApi }).flow
  if (maybe === undefined) return
  // Bound to a const the hoisted helpers below can see narrowed — a function
  // declaration does not inherit the narrowing from the guard above it.
  const api: WorktreeApi = maybe

  /** The conversation on screen, as the panel last knew it. */
  let threadId: string | null = null

  const panel = new WorktreePanel({
    listBranches: async () => {
      const root = (await api.project.active())?.rootPath ?? null
      if (root === null) return []
      const listed = await api.threads.worktreeBranches?.({ rootPath: root })
      return (listed?.branches ?? []).map((entry) => entry.name)
    },
    create: async (id, branch, worktreeName, takeExisting) => {
      // THE WHOLE FLOW ALREADY EXISTED. `prepareThreadWorktree` is the one code
      // path that calls the channel, and when main answers `needs-choice` — its
      // refusal to decide what happens to somebody's uncommitted work — it puts
      // that question on screen and calls again with the answer. Calling the raw
      // channel underneath it, as this did, meant a dirty project tree returned
      // `needs-choice` to nobody and the press did nothing at all.
      //
      // NO BRANCH IS PASSED. Omitting it is what makes the checkout detached and
      // named later from the conversation's title — the behaviour every
      // worktree has had, and the reason several worktrees can be cut from one
      // branch without anybody naming three variants of it up front.
      const outcome = await prepareThreadWorktree(
        {
          prepare: (request) =>
            api.threads.prepareWorktree?.(request) ??
            Promise.resolve({ status: 'unavailable' } as ThreadWorktreeResult),
          // INTO THIS PANEL, not a menu of its own. The panel is already in an
          // anchored popover; a second one nested inside closes the first and
          // takes the question with it. Same words, one container.
          askCarry: (question) => panel.askCarry(question),
        },
        // THE NAME THE PERSON TYPED, or none at all — omitting it is what makes
        // the checkout detached and named later from the title, which is still
        // the answer for anyone who leaves the field empty.
        {
          threadId: id,
          requested: true,
          // TAKEN OR MADE — a branch that already exists is checked out, and
          // one that does not is created. Asking git to create a ref twice is
          // a refusal, not a no-op, so this is the difference between working
          // and a red sentence.
          ...(branch === undefined
            ? {}
            : takeExisting === true
              ? { start: { kind: 'checkout' as const, branch } }
              : { branch }),
          // THE FOLDER'S NAME, beside the branch's and never derived from it.
          ...(worktreeName === undefined ? {} : { worktreeName }),
        },
      )
      await reloadThread(id)
      // Walking away from the question is not a failure and says nothing.
      if (outcome.kind === 'dismissed') return { ok: true, detail: null }
      return { ok: madeIt(outcome.result.status), detail: whyNot(outcome.result) }
    },
    remove: async (id, discard) => {
      // `confirmed: true` is the press. `allowUnlanded` is the SECOND press, and
      // it is only ever sent by the panel's second question — a checkout holding
      // uncommitted work is refused first, with what it holds, so the ask that
      // follows can say what would go. That is why this panel no longer
      // pre-computes any of it: the only authority answers here, in one call.
      const result = await api.threads.releaseWorktree?.({
        threadId: id,
        confirmed: true,
        ...(discard === true ? { allowUnlanded: true } : {}),
      })
      await reloadThread(id)
      const status = result?.status
      return {
        ok: status === 'pruned' || status === 'absent',
        detail: result?.detail ?? 'Flow couldn’t remove it. Everything is where it was.',
        // THE REFUSAL'S OWN NUMBERS, carried rather than re-derived. Only
        // `holds-work` can be escalated; every other refusal (a turn in flight,
        // a repository that said no) is a fact about now, and offering to
        // override it would be offering the wrong thing.
        ...(status === 'holds-work'
          ? {
              holds: {
                changedFiles: result?.changedFiles ?? 0,
                aheadCommits: result?.aheadCommits ?? 0,
              },
            }
          : {}),
      }
    },
  })

  /** Re-read one conversation after something changed its worktree. */
  async function reloadThread(id: string): Promise<void> {
    try {
      const thread = await api.threads.get?.({ threadId: id })
      if (id === threadId) {
        panel.setThread(thread ?? null)
        syncDock()
      }
    } catch {
      // The panel keeps what it had; the inventory refresh still runs.
    }
  }

  // IT DOCKS IN THE EXPLORER; IT DOES NOT FLOAT OVER IT.
  //
  // This was an anchored popover, and a popover is a promise about COORDINATES:
  // a class with no CSS behind it left the panel statically positioned and it
  // rendered off the bottom of the window; an overlay can be covered; a watcher
  // can close it a frame after it opens. Each failure looks identical to the
  // reader — a control that does nothing — and three of them happened in a row
  // (user, 2026-09-17: "I just asked to move UI to another place and the ui is
  // not showing").
  //
  // A panel that lives INSIDE the files pane has no coordinates to get wrong.
  // It is in the pane's normal flow, above the tree, and it is either in the
  // document or it is not. That is also what was asked for: the worktree
  // configuration living with the project, in the explorer.
  injectDockStyles()
  const dock = document.createElement('div')
  dock.className = 'fl-wt-dock'
  dock.hidden = true
  dock.appendChild(panel.element)

  /** Put the dock at the top of the files pane, once the pane exists. */
  function mountDock(): boolean {
    if (dock.isConnected) return true
    const pane = document.querySelector<HTMLElement>('.fl-sidebar-files')
    if (pane === null) return false
    pane.insertBefore(dock, pane.firstChild)
    return true
  }

  /**
   * ON SCREEN WITHOUT BEING ASKED FOR.
   *
   * Nobody presses anything to see this any more (user, 2026-09-17: "the user
   * should not have to click, lets always show it … but should be always
   * available"). So its presence is not a mode somebody toggles — it follows
   * the only fact that matters: whether there is a conversation and a project
   * for it to speak about. The panel's own empty states are a fine answer to a
   * press and a poor thing to park permanently above a file tree.
   */
  function syncDock(): void {
    // THE RAIL IS TOLD, NOT ASKED. Whether this conversation works in a copy is
    // decided in exactly one place — the panel's own state — and the Files item
    // in the rail needs the same answer to draw the same glyph the thread row
    // does. An event keeps the fact single-owner: the rail paints, it does not
    // re-derive (allowed-pattern #14).
    document.dispatchEvent(
      new CustomEvent('flow:files-are-copy', { detail: { isCopy: panel.isOwnCopy() } }),
    )
    if (!mountDock()) return
    const show = panel.hasSubject()
    dock.hidden = !show
    panel.setVisible(show)
  }
  syncDock()
  // The pane is built during boot and this module mounts after it, but a
  // rebuilt sidebar would drop the dock — re-mounting is idempotent and cheap.
  document.addEventListener('flow:reveal-sidebar', () => syncDock())

  document.addEventListener('flow:active-thread', (event) => {
    const next = (event as CustomEvent<{ threadId: string | null }>).detail?.threadId ?? null
    threadId = next
    if (next === null) {
      panel.setThread(null)
      syncDock()
      return
    }
    void reloadThread(next)
  })

  /**
   * The project's OWN branch, read rather than assumed.
   *
   * It used to be passed as `null`, so a conversation working in the project was
   * told so without being told WHERE — the one fact that line is for.
   */
  async function project(rootPath: string | null): Promise<void> {
    if (rootPath === null) {
      panel.setProject(null, null)
      syncDock()
      return
    }
    panel.setProject(rootPath, null)
    syncDock()
    try {
      const status = await api.git?.status?.({ rootId: rootPath })
      const branch = status?.branch?.trim()
      if (branch !== undefined && branch !== '') {
        panel.setProject(rootPath, branch)
        syncDock()
      }
    } catch {
      // Not a repository, or git could not answer. The panel stands without it.
    }
  }

  api.project.onActiveChanged((context) => {
    void project(context?.rootPath ?? null)
  })
  void api.project
    .active()
    .then((context) => project(context?.rootPath ?? null))
    .catch(() => undefined)
}

/** The two statuses that mean this conversation now has a worktree. */
function madeIt(status: ThreadWorktreeResult['status']): boolean {
  return status === 'created' || status === 'ready'
}

/**
 * Why it did not happen, or null when it did.
 *
 * MAIN'S OWN SENTENCE WHERE THERE IS ONE. Each of these refusals is a different
 * fact and a reader who pressed a switch that did nothing deserves to be told
 * which — "worktrees are switched off for this project" and "a turn is running"
 * are not the same problem, and neither is silence.
 */
function whyNot(result: ThreadWorktreeResult): string | null {
  if (madeIt(result.status)) return null
  if (typeof result.detail === 'string' && result.detail.trim() !== '') return result.detail
  switch (result.status) {
    case 'disabled':
      return 'Separate copies are switched off for this project.'
    case 'busy':
      return 'This conversation is in the middle of a turn.'
    case 'unavailable':
      return 'Flow can’t set one up for this conversation.'
    default:
      return 'Flow couldn’t make it. Nothing has changed.'
  }
}

/**
 * The dock's own styling — the panel brings its own inner rules.
 *
 * Injected here rather than in the shell's stylesheet because the dock exists
 * only when this module is mounted, and a rule for an element nobody creates is
 * a rule nobody can check.
 */
let dockStylesInjected = false
function injectDockStyles(): void {
  if (dockStylesInjected) return
  dockStylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    /* THE PANE IS A COLUMN ON ITS OWN NOW (shell.ts), because the search box
       sits between this dock and the tree. This used to make it one, and only
       while the dock was showing — a rule that was right when the dock and the
       tree were the only two things in the pane, and would fight the one that
       replaced it. */
    /* NO SLAB. It had a raised background, which drew a grey block across the
       top of the explorer and made the panel look like a thing stuck on rather
       than part of the pane (user, 2026-09-17: "remove that grey thing"). The
       pane's own ground, one hairline, and the space do the separating. */
    '.fl-wt-dock {',
    '  flex: none;',
    '  max-height: 60%;',
    '  overflow-y: auto;',
    '  border-bottom: 1px solid var(--fl-color-separator, #232529);',
    '}',
    '.fl-wt-dock[hidden] { display: none; }',
    /* The panel was drawn for a 268px popover; docked, it takes the pane. */
    '.fl-wt-dock .fl-wt { width: auto; max-height: none; }',
  ].join('\n')
  document.head.appendChild(style)
}
