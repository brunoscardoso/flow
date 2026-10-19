/**
 * Diff review composition (Phase 8) — wires the inline diff controller over
 * the EditorApi.
 *
 * The coordinator calls `initDiffReview(editorApi, surfaces)` once after
 * `initEditor(surfaces)`:
 *   - inline hunks: rendered into the shared Monaco instance
 *   - state: editor:pendingChanges snapshot + editor:pendingChangesUpdated
 *
 * The verdict on a FILE is Source Control's (its review panel reviews files as
 * whole files, with the confirms that act deserves); the inline widget resolves
 * ONE hunk where a reader can see it. That single intent funnels into
 * editor:resolveHunk. (The pending-changes strip that used to sit above the
 * tab strip is gone — Source Control lists what is pending.)
 */
import type { PendingFileChange } from '../../shared/ipc-contract'
import type { ShellSurfaces } from '../shell'
import type { EditorApi } from './index'
import {
  hunkResolveFailedToast,
  hunkScopeConfirmText,
  hunkStaleToast,
  type EditorToast,
} from './editor-feedback'
import { InlineDiffController } from './inline-diff'
import { filterByActiveThread } from './pending-changes-filter'

/** Main-side convention (edit-tracker ALL_HUNKS): resolves a whole file. */
const ALL_HUNKS = '*'

export function initDiffReview(editorApi: EditorApi, _surfaces: ShellSurfaces): void {
  /** Every thread's pending changes for the active root (from main). */
  let allChanges: PendingFileChange[] = []
  /** The subset shown/reviewed — scoped to the active thread. */
  let changes: PendingFileChange[] = []
  /** The thread the user is looking at; review is scoped to it. */
  let activeThreadId: string | null = null

  // ── Inline hunks ────────────────────────────────────────────────────────

  const inlineDiff = new InlineDiffController(editorApi, (change, hunk, action) => {
    void resolve(change, hunk.hunkId, action)
  })
  void inlineDiff.init().catch((error) => {
    console.error('flow: failed to initialize inline diff review', error)
  })

  // ── State ───────────────────────────────────────────────────────────────

  function applyChanges(next: PendingFileChange[]): void {
    allChanges = next
    render()
  }

  /** Re-derive the reviewed set from the full change list + the active thread. */
  function render(): void {
    changes = filterByActiveThread(allChanges, activeThreadId)
    inlineDiff.setChanges(changes)
  }

  window.flow.editor.onPendingChangesUpdated((next) => {
    applyChanges(next)
  })
  void window.flow.editor
    .pendingChanges({})
    .then((initial) => applyChanges(initial))
    .catch((error) => {
      console.error('flow: failed to load pending changes', error)
    })

  // #1290/#1291: the review went stale the moment the file changed outside the
  // tracker — nothing re-broadcast, so the review kept claiming "1 pending hunk"
  // while two were in scope, and the inline widget detached from its own hunk.
  // Re-derive on any change to a file we are reviewing; the pull is cheap and
  // coalesced, and a stale review is what made the destructive action
  // misrepresent itself.
  let refreshQueued = false
  function refreshPendingChanges(): void {
    if (refreshQueued) return
    refreshQueued = true
    setTimeout(() => {
      refreshQueued = false
      void window.flow.editor
        .pendingChanges({})
        .then((next) => applyChanges(next))
        .catch(() => undefined) // informational chrome — never load-bearing
    }, 150)
  }
  window.flow.project.onFileChanged?.((event) => {
    // The event carries ABSOLUTE paths for one root; pending changes are
    // repo-relative. Match on the root plus a path suffix.
    const touched = event.changes.map((change) => change.path.split('\\').join('/'))
    const reviewing = allChanges.some(
      (change) =>
        change.rootId === event.rootPath &&
        touched.some((path) => path.endsWith(`/${change.filePath}`) || path === change.filePath),
    )
    if (reviewing) refreshPendingChanges()
  })

  // Follow the active thread — the review shows only that thread's edits, and
  // re-renders when the user switches threads (see threads/index selectThread).
  document.addEventListener('flow:active-thread', (event) => {
    const detail = (event as CustomEvent<{ threadId: string | null }>).detail
    activeThreadId = detail?.threadId ?? null
    render()
  })

  // ── Intents ─────────────────────────────────────────────────────────────

  /** A resolve that failed because the file moved on, not because anything
   *  is broken — the ids embed position + content hash (#1291). */
  function isStaleHunk(error: unknown): boolean {
    return /Unknown or already-resolved hunk/.test(
      error instanceof Error ? error.message : String(error),
    )
  }

  /** Surface a review failure the way every sibling surface does (#1291) —
   *  the channel #195 added for exactly this. */
  function notify(toast: EditorToast): void {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '',
          title: toast.title,
          body: toast.body,
          timestamp: new Date().toISOString(),
          level: toast.level,
        },
      }),
    )
  }

  async function resolve(
    change: PendingFileChange,
    hunkId: string,
    action: 'accept' | 'reject',
    options: { confirmed?: boolean } = {},
  ): Promise<void> {
    const fileName = change.filePath.split('/').pop() ?? change.filePath
    try {
      // threadId scopes the resolve to THIS thread's pending entry — two
      // threads can have pending changes on the same file (LOG-4).
      const outcome = await window.flow.editor.resolveHunk({
        rootId: change.rootId,
        filePath: change.filePath,
        threadId: change.threadId,
        hunkId,
        action,
        // #1290: tell main what this click believes it covers. A whole-file
        // action means the file's whole hunk list AS SHOWN; a single hunk
        // means one. Omitted once the user has confirmed the wider scope.
        ...(options.confirmed === true
          ? {}
          : { expectedHunks: hunkId === ALL_HUNKS ? change.hunks.length : 1 }),
      })
      if (outcome?.status === 'scope-changed') {
        // Nothing was written. The file drifted, and for a reject that drift
        // is the user's own uncommitted work — never destroy it silently.
        const proceed = window.confirm(
          hunkScopeConfirmText(fileName, action, outcome.hunks, outcome.expected),
        )
        if (proceed) await resolve(change, hunkId, action, { confirmed: true })
        return
      }
    } catch (error) {
      console.error('flow: failed to resolve hunk', { change: change.filePath, action, error })
      // #1291: SAY SO. Swallowing this left a widget offering Accept/Reject
      // that could never succeed — the user clicked, nothing moved, and the
      // app never explained why. A stale hunk id (the file moved on) reads
      // differently from a hard failure, so it gets its own wording.
      notify(isStaleHunk(error) ? hunkStaleToast(fileName) : hunkResolveFailedToast(fileName, error))
      // …and re-derive, so the dead widget is replaced by the real state.
      refreshPendingChanges()
    }
  }

}
