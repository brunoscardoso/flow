/**
 * The Changes tab — the review, in the editor area, beside Code / Tasks /
 * Blueprint.
 *
 * WHERE IT LIVES has been argued three times, and the tab is the answer. It
 * shipped in the chat column (#1906), between the transcript and the composer,
 * where a thread with four changed files permanently gave up a band of the
 * reading column and put a scrolling list of files inside a scrolling list of
 * messages. It moved here, which was right, and then failed for a different
 * reason: nothing on screen said a thread had changes, so the tab could only be
 * reached by someone who already knew to ask the palette for it. Briefly it was
 * a panel of its own on the right — and the user's call, seeing it: "that should
 * not be a separated tab, should live where we have the other tabs, like code,
 * tasks, blueprint."
 *
 * So the placement is unchanged and the MISSING PIECE is elsewhere: the strip
 * above the composer (`changes-strip.ts`), which carries the +/− counts the way
 * Cursor does and opens this tab when pressed. That is the whole of what was
 * wrong — the review was never unreachable, it was unannounced.
 *
 * IT STILL DOES NOT OPEN ITSELF on a change. A tab that appeared whenever an
 * agent touched a file would take the editor away mid-sentence, every turn —
 * the same interrupt-by-default that put it in the chat column to begin with.
 * Opening it is a person's move, from the strip, the palette, or the status
 * bar — and that move is then REMEMBERED against the conversation it was made
 * in (see below), which is the only reason the tab ever appears on its own.
 */
import type { GitMergeState } from '../../shared/ipc-contract'
import type { EditorApi } from '../editor'
import { ChangeReviewCard } from './change-review-card'
import { runInWantedScope } from '../tab-scope-gate'
import {
  nextRequest,
  sourceControlTab,
  type SourceControlMode,
  type SourceControlRequest,
} from './source-control-mode'

/** The tab's identity — one tab, reopened rather than duplicated. */
export const CHANGE_REVIEW_TAB_ID = 'view:changes'
/** The persisted identity of the Changes tab in a conversation's tab set. */
const CHANGE_REVIEW_VIEW_KIND = 'changes'

export function initChangeReview(editorApi: EditorApi): void {
  // The card owns its own root. This host is where that root lives — detached
  // from the document until the tab is opened, so an unopened review costs a
  // subscription and no layout.
  const host = document.createElement('div')
  host.style.cssText = 'height:100%;min-height:0;display:flex;flex-direction:column;'

  // Monaco arrives through the editor's loader, never a static import: the
  // review renders each file's diff INLINE with the same engine the editor
  // uses, which is what the collapsed context bands in the reference are.
  const card = new ChangeReviewCard(host, () => editorApi.monaco())
  card.mount()

  /**
   * THE TAB IS REMEMBERED PER CONVERSATION, not left lying across them.
   *
   * The card follows the active thread, so leaving the tab open across a switch
   * "worked": it simply became the other thread's review. In practice that is a
   * tab you did not ask for on a conversation you may have opened to read
   * rather than to review — and usually an EMPTY one, since the odds that both
   * threads have uncommitted work are low. Reported after exactly that, with
   * the rule stated plainly — "all the tabs and things opened should be
   * remembered according to the thread" (user, 2026-09-10).
   *
   * That rule now holds for EVERY editor tab: each conversation has its own tab
   * set, persisted per (project, thread) and swapped on a switch
   * (`project-context.ts`). This tab is one view in it — `persist` puts it in
   * the set, the restorer below rebuilds it when its conversation comes back.
   * Leave a thread with Changes open and it goes away with the thread; come
   * back and it is there again; close it yourself and it stays closed for that
   * thread. Unlike before, that memory now survives a restart.
   */
  editorApi.registerViewRestorer(CHANGE_REVIEW_VIEW_KIND, () => {
    openTab(false)
    return CHANGE_REVIEW_TAB_ID
  })

  /**
   * THE TAB RENAMES ITSELF, because the label IS the state.
   *
   * This one tab does three jobs — the working list, a stopped merge, and what
   * has already landed — and the word on it is how a reader knows which. Mode
   * and label are therefore decided by ONE function (`sourceControlTab`): if
   * they were decided separately, the only symptom of their drifting apart
   * would be a tab that says one thing and shows another, which no test fails
   * on and nobody reports as a bug.
   *
   * A LIVE CONFLICT TAKES THE TAB and gives it back. The reader is not browsing
   * when a merge has stopped; they are stuck. `nextRequest` is what remembers
   * where they were, so resolving returns them there rather than to Changes.
   *
   * NOTHING FEEDS `merge` YET, and the code says so instead of pretending. It
   * used to listen to `flow:conflict-resolve-state` through a cast that read a
   * `mergeState` field off it — a field that event (`ConflictResolveStateDetail`:
   * `phase`, `threadId`) has never carried. The cast turned "this cannot
   * compile" into a silent `undefined ?? null`, so the tab LOOKED wired to
   * conflicts while no code path could ever reach them. Which repository's
   * merge state counts, for a conversation with several roots, is a product
   * decision still to be made; until it is, the tab is honestly never
   * Conflicts.
   */
  const merge: GitMergeState | null = null
  let requested: SourceControlRequest = 'changes'

  function tabFace(): { mode: SourceControlMode; label: string } {
    return sourceControlTab(merge, requested)
  }

  function openTab(reveal = true): void {
    // Reveal the editor host first, exactly as the board does: opening a tab
    // into a hidden editor shows nothing and reads as a dead command. A
    // tab-set restore is not a press, and reveals nothing.
    if (reveal) document.dispatchEvent(new CustomEvent('flow:show-editor'))
    editorApi.openView({
      id: CHANGE_REVIEW_TAB_ID,
      label: tabFace().label,
      // No diff glyph in the set; `pencil` is the honest one — this tab is
      // what the agent EDITED, waiting on a keep-or-reject.
      icon: 'pencil',
      element: host,
      // In the conversation's tab set; the review itself follows the thread.
      persist: { kind: CHANGE_REVIEW_VIEW_KIND, state: () => ({}) },
    })
  }

  /** Re-label an OPEN tab. A closed one takes its name when it next opens. */
  function relabel(): void {
    if (!editorApi.hasTab(CHANGE_REVIEW_TAB_ID)) return
    openTab()
  }

  /** The reader asked for a different job. A conflict may still override it. */
  function request(mode: SourceControlMode): void {
    requested = nextRequest(requested, mode)
    relabel()
  }

  // Programmatic reveals name the job they want. History is only ever entered
  // by asking — nothing about a repository's state means "show me the past".
  //
  // The doors that OPEN the tab wait for the conversation they were pressed in
  // (`tab-scope-gate.ts`): pressed while a switch is still loading, they used to
  // open into the conversation being left.
  document.addEventListener('flow:show-history', () => {
    void runInWantedScope(() => {
      request('history')
      if (!editorApi.hasTab(CHANGE_REVIEW_TAB_ID)) openTab()
    })
  })
  document.addEventListener('flow:show-git', () => {
    request('changes')
  })

  document.addEventListener('flow:open-change-review', () => {
    void runInWantedScope(() => openTab())
  })
}
