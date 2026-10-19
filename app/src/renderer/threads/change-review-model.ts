// Pure helpers for the thread change-review card (#1906). No DOM, no window —
// unit-tested in change-review-model.test.ts. The card stays a thin renderer of
// these.

import type {
  ChangeReviewFile,
  GitPublishResult,
  ThreadChangeReview,
} from '../../shared/ipc-contract'

/**
 * Does a `threads:changeReviewUpdated` event concern the card's active thread?
 * The FIRST gate before any refetch — a broadcast for another thread (or none)
 * must draw nothing (allowed-pattern #17; forbidden #14). Visibility is the
 * SECOND gate, applied by the card after this one.
 */
export function changeReviewAffectsThread(
  event: { threadId: string },
  activeThreadId: string | null,
): boolean {
  return activeThreadId !== null && event.threadId === activeThreadId
}

/** A working-tree file changed under `rootId` — does the card watching it care? */
export function fileChangeAffectsRoot(
  changedRootId: string | null | undefined,
  activeRootId: string | null,
): boolean {
  return activeRootId !== null && changedRootId === activeRootId
}

/** The keep/rejectable files — everything git actually reports as changed. A
 *  `touchedOnly` entry is informational and never keep/rejectable. */
export function reviewableFiles(review: ThreadChangeReview | null): ChangeReviewFile[] {
  return (review?.files ?? []).filter((file) => !file.touchedOnly)
}

/** Format a file's line counts as Cursor does: `+12 −3`, `+5`, `−2`, or '' when
 *  neither is known (untracked / binary / touched-only). Uses the real minus
 *  sign (U+2212) to match the Source Control panel. */
export function formatCounts(added: number | null, deleted: number | null): string {
  const parts: string[] = []
  if (added !== null && added > 0) parts.push(`+${added}`)
  if (deleted !== null && deleted > 0) parts.push(`−${deleted}`)
  return parts.join(' ')
}

export interface ChangeReviewSummary {
  fileCount: number
  reviewableCount: number
  added: number | null
  deleted: number | null
}

/** Header summary: how many files, and the total +/- across the ones with
 *  counts. `added`/`deleted` are null only when NO file carried a count. */
export function summarizeReview(review: ThreadChangeReview | null): ChangeReviewSummary {
  const files = review?.files ?? []
  let added: number | null = null
  let deleted: number | null = null
  for (const file of files) {
    if (file.added !== null) added = (added ?? 0) + file.added
    if (file.deleted !== null) deleted = (deleted ?? 0) + file.deleted
  }
  return {
    fileCount: files.length,
    reviewableCount: files.filter((f) => !f.touchedOnly).length,
    added,
    deleted,
  }
}

/**
 * The strip above the composer — Cursor's `Changes  +1460  −5`.
 *
 * IT IS THE WHOLE ANSWER TO "those changes was not being showed". The review
 * shipped twice with no way in: first as a band in the chat column, then as an
 * editor tab that (rightly) refuses to open itself. Both times a thread could
 * have four changed files and say so nowhere. This is the thing on screen that
 * says there is something to look at, and pressing it is what opens the panel.
 *
 * It hides when there is nothing — unlike the panel, which says so in words.
 * A strip is a notice, and a notice about nothing is noise; the panel is a place,
 * and a place you asked to open must never render blank.
 */
export interface ChangesStripState {
  /** Whether the strip is on screen at all. */
  show: boolean
  /** Fixed role word — the file count and the counts live in their own fields,
   *  so no repository can set the control's width (forbidden-pattern #12's
   *  neighbour). */
  label: string
  /** `+1460`, or '' when nothing is known to have been added. */
  added: string
  /** `−5`, or '' likewise. */
  deleted: string
  /** Hover text: what pressing it does, in the terms of what is on screen. */
  title: string
}

export function changesStripState(review: ThreadChangeReview | null): ChangesStripState {
  const summary = summarizeReview(review)
  return {
    // REVIEWABLE, NOT MERELY TOUCHED. `fileCount` counts every row the review
    // knows about, including the files an agent opened and left byte-identical
    // — so the strip offered "Changes" with no counts beside it, and opening it
    // said "Nothing changed — N files were opened and left exactly as they
    // were" (user, 2026-09-16). The card already draws this line; the strip
    // that advertises the card was the one place still on the other count.
    show: summary.reviewableCount > 0,
    label: 'Changes',
    added: summary.added !== null && summary.added > 0 ? `+${summary.added}` : '',
    deleted: summary.deleted !== null && summary.deleted > 0 ? `−${summary.deleted}` : '',
    title: `Review ${changeScopePhrase(review, summary.fileCount)}`,
  }
}

/**
 * What the file list may honestly be CALLED — and it is not the same sentence in
 * both cases.
 *
 * On a conversation's own branch the list really is what it changed:
 * nothing else writes there. In the project's own tree it is every uncommitted
 * change in the repository — the agent's, yours, and whatever was already
 * sitting in the tree before the conversation started. Calling the second one
 * "what this conversation changed" is the app claiming authorship it cannot
 * establish, on the screen where a person decides what to keep and what to
 * throw away. Cursor draws the same distinction with one word: *Uncommitted*.
 */
export function changeScopePhrase(
  review: ThreadChangeReview | null,
  fileCount: number,
): string {
  const fileWord = fileCount === 1 ? 'file' : 'files'
  return review?.ownWorktree === true
    ? `the ${fileCount} ${fileWord} this conversation changed`
    : `the ${fileCount} uncommitted ${fileWord} in this project`
}

/**
 * The review's toolbar — Cursor's second row, `⧉ Uncommitted +1460 −5  ⌄ main`.
 *
 * Three facts, in the order a person needs them before pressing anything: WHAT
 * this list is, HOW BIG it is, and WHERE a commit of it would land. Pure, so the
 * one thing that can be dishonest here — calling a shared tree's uncommitted
 * work "this conversation's" — is pinned by a test rather than by a render path
 * remembering to check `ownWorktree`.
 */
export interface ChangeReviewToolbarState {
  /** What the list below IS — one fixed word, `Uncommitted`. */
  scope: string
  /** `+1460`, or '' when nothing counted was added. */
  added: string
  /** `−5`, or '' likewise. */
  deleted: string
  /** The branch a commit would land on, or null when detached / not a repo. */
  branch: string | null
  /** Commits waiting to be pushed; 0 in the uncommitted state and when unknown. */
  aheadCommits: number
  /**
   * Whether the list is a RECORD rather than a decision.
   *
   * Committed work has nothing left to keep or reject: the checkbox, the revert
   * arrow and all three toolbar buttons would either lie or do something the
   * person did not ask for. The diffs stay openable — reading is the whole
   * point of the state.
   */
  readOnly: boolean
  /** Hover text for the scope chip: the claim, spelled out. */
  scopeTitle: string
  /**
   * Whether a Push control belongs in this toolbar at all.
   *
   * `(bound && aheadCommits > 0) || !bound`
   *
   * THE SECOND HALF IS THE WHOLE POINT, and it is why the rule costs no extra
   * git read. A branch nobody has aimed anywhere has never been published *by
   * definition* — there is no upstream for it to be ahead of, so it reports
   * `aheadCommits: 0` for exactly the same reason a fully-published branch
   * does. Asking "how many commits are waiting?" of an unbound branch is asking
   * a question that has no answer; `bound` answers it instead, and `bound` is
   * already on the review. A count that would have to be computed against
   * some guessed remote is never taken, and nothing below the ask fills the
   * missing destination in (allowed-pattern #22).
   *
   * A null review shows nothing: there is no branch to publish.
   */
  showPush: boolean
}

export function changeReviewToolbarState(
  review: ThreadChangeReview | null,
): ChangeReviewToolbarState {
  const summary = summarizeReview(review)
  const own = review?.ownWorktree === true
  const ahead = review?.state === 'committed' ? (review.aheadCommits ?? 0) : 0
  return {
    // ONE WORD, both cases. It read `This conversation` on its own branch,
    // which was accurate and too long to be a label — and it made the row about
    // Flow's model of the thread rather than about the files under it. The
    // reference says `Uncommitted`, which is true of a thread's own checkout
    // and of the project's tree alike; what actually differs between them is
    // WHO ELSE could have written these files, and that is a tooltip, not a
    // heading.
    scope: review?.state === 'committed' ? 'Committed' : 'Uncommitted',
    added: summary.added !== null && summary.added > 0 ? `+${summary.added}` : '',
    deleted: summary.deleted !== null && summary.deleted > 0 ? `−${summary.deleted}` : '',
    branch: review?.branch ?? null,
    /** Commits waiting to be pushed, or 0. Only the committed state has any. */
    aheadCommits: ahead,
    /** Nothing here can be kept or rejected — it is already committed. */
    readOnly: review?.state === 'committed',
    // Keyed on the SAME `aheadCommits` the chip beside it prints, not on the
    // review's raw field: a control whose rule reads a number the reader cannot
    // see is a control that appears for no visible reason.
    // A detached HEAD is unbound too, and there is nothing there to publish —
    // the branch a push would name does not exist. Guarding on it is the one
    // addition to the rule above, and it only ever REMOVES the control.
    showPush: review !== null && review.branch !== null && (review.bound ? ahead > 0 : true),
    scopeTitle:
      review?.state === 'committed'
        ? 'Committed here and not pushed anywhere yet.'
        : own
          ? 'This conversation works on its own branch — everything here is its work.'
          : 'Everything uncommitted in the project, whoever changed it.',
  }
}

/** The badge on a file that did not exist before — Cursor's `New`. Empty for a
 *  file that did, so the column stays quiet on an ordinary edit. */
export function fileBadge(file: ChangeReviewFile): string {
  return file.status === 'untracked' || file.status === 'added' ? 'New' : ''
}

/**
 * The files the review LISTS, and the ones it merely counts.
 *
 * A `touchedOnly` entry is a file the agent opened and left byte-identical. On a
 * real run nine of ten rows were these, and they pushed the one file that
 * actually changed off the top of the list. They are not drawn at all now — a
 * collapsible foot line for them sat directly above the terminal's tab strip
 * and read as part of it. Their COUNT still reaches the reader, in the empty
 * state's sentence, which is the one moment it says anything.
 */
export function partitionReviewFiles(review: ThreadChangeReview | null): {
  changed: ChangeReviewFile[]
  touched: ChangeReviewFile[]
} {
  const files = review?.files ?? []
  return {
    changed: files.filter((file) => !file.touchedOnly),
    touched: files.filter((file) => file.touchedOnly),
  }
}

/** A short status word for a file row's glyph/label. `touchedOnly` reads as
 *  'touched' — the honest word for "edited, but git shows no net change". */
export function statusLabel(file: ChangeReviewFile): string {
  if (file.touchedOnly) return 'touched'
  return file.status
}

/**
 * What the toolbar SAYS after a publish — one sentence per outcome, and null
 * when the outcome is a question rather than an answer.
 *
 * It lives here, and not in the card, for the reason every other string in this
 * module does: the one thing that can go wrong with these words is that one of
 * them hands the reader an invocation to run (forbidden-pattern #12), and a
 * pure function can be held to that by a test instead of by whoever edits the
 * render path next. `failed` is the exception that proves it — its sentence is
 * main's `detail`, already trimmed at the display boundary, passed through
 * whole rather than wrapped in a second sentence about itself.
 *
 * `unbound` returns null ON PURPOSE. Nobody has said where this branch
 * publishes, and the honest response to that is the question, not a sentence
 * about it — the card opens the binding ask instead, and a placeholder line
 * here would be a dead end sitting exactly where a decision belongs.
 */
export function publishOutcomeSentence(result: GitPublishResult): string | null {
  switch (result.status) {
    case 'published': {
      const where = `${result.remote}/${result.remoteBranch}`
      return result.previouslyPushedAs === undefined
        ? `Published to ${where}.`
        : `Published to ${where}. The earlier name, ${result.previouslyPushedAs}, is still on the remote.`
    }
    case 'diverged': {
      const commitWord = result.behind === 1 ? 'commit' : 'commits'
      return `The remote has ${result.behind} ${commitWord} this branch does not. Nothing was sent — bring those down first.`
    }
    case 'nothing':
      return 'Everything on this branch is already published.'
    case 'failed':
    // The three ways an ANSWER can be unusable, for the same reason `failed` is
    // passed through whole: main already wrote each of them as a sentence about
    // this repository, trimmed at the display boundary. What differs between
    // them is what the card DOES next — re-ask, re-ask pointing at the blank,
    // or stop — and that is a decision about a status, not about prose. A
    // surface picking its behaviour by reading one of these sentences would be
    // parsing words to choose an action.
    case 'unconfirmed':
    case 'incomplete':
    case 'bind-failed':
      return result.detail
    case 'unbound':
      return null
    default:
      // An outcome this build does not know about says nothing rather than
      // guessing at one — the union is the contract's to grow, not ours.
      return null
  }
}

/** How the sentence should READ — plain, or as something that did not happen.
 *  Separate from the words so the card stays a renderer and never re-decides
 *  whether a refusal is an error (it is not: `diverged` and `nothing` are both
 *  the system working). */
export function publishOutcomeTone(result: GitPublishResult): 'ok' | 'refused' {
  return result.status === 'published' || result.status === 'nothing' ? 'ok' : 'refused'
}

/**
 * THE HEADER CHECKBOX — what it shows, and which way the next press goes.
 *
 * The column of checkboxes had no head, so "keep everything" was a labelled
 * button and "keep nothing" was not reachable at all: a reader who had ticked
 * six files and changed their mind had to untick six files. `Reject all` is not
 * that control and must never be mistaken for it — it DISCARDS the work, where
 * this only decides what rides in the next commit.
 *
 * Three states, because two would lie. A list where some rows are ticked is
 * neither on nor off, and drawing it as either tells the reader something
 * untrue about the five files they cannot see from here. Mixed shows the dash,
 * and the next press completes the selection rather than clearing it — the
 * convention every file list shares, and the safer of the two directions.
 */
export interface SelectAllState {
  /** No head on an empty column, and none on work already committed. */
  hidden: boolean
  checked: boolean
  /** Some but not all. */
  indeterminate: boolean
  /** Which way the next press goes. */
  action: 'keep' | 'unkeep'
  /** Exactly the files that press changes — never the ones already that way. */
  filePaths: string[]
  /** What pressing it does, in the words the rows use (forbidden-pattern #12). */
  title: string
}

export function selectAllState(
  files: readonly ChangeReviewFile[],
  readOnly: boolean,
): SelectAllState {
  const none: SelectAllState = {
    hidden: true,
    checked: false,
    indeterminate: false,
    action: 'keep',
    filePaths: [],
    title: '',
  }
  if (readOnly || files.length === 0) return none

  const kept = files.filter((file) => file.staged)
  const loose = files.filter((file) => !file.staged)

  if (loose.length === 0) {
    return {
      hidden: false,
      checked: true,
      indeterminate: false,
      action: 'unkeep',
      filePaths: kept.map((file) => file.filePath),
      title: kept.length === 1 ? 'Stop keeping this file' : `Stop keeping all ${kept.length} files`,
    }
  }

  return {
    hidden: false,
    checked: false,
    indeterminate: kept.length > 0,
    action: 'keep',
    // The already-kept files are left alone: a press that re-stages them would
    // be a no-op wearing the cost of a git call per file.
    filePaths: loose.map((file) => file.filePath),
    title:
      kept.length > 0
        ? `Keep the other ${loose.length} ${loose.length === 1 ? 'file' : 'files'} too`
        : `Keep all ${loose.length} ${loose.length === 1 ? 'file' : 'files'}`,
  }
}


/**
 * May the branch be renamed from the Changes toolbar?
 *
 * THE SAME PERMISSION THE HEADER CHIP USED TO DECIDE, moved with the control
 * (`branchChipState.canRename`): only a branch this conversation OWNS, and only
 * when it has a name yet. A thread working in the project's own tree shares its
 * branch with another conversation, a terminal and the reader's own editor —
 * renaming that from here would move a ref out from under all three.
 *
 * A committed review still renames: the work is in a commit, the branch is
 * still the branch, and the name is exactly what a person checks before they
 * push it somewhere other people can see.
 */
export function canRenameReviewBranch(review: ThreadChangeReview | null): boolean {
  return review !== null && review.ownWorktree === true && review.branch !== null
}

/**
 * THE COMMIT BOX — typing the message where the files are.
 *
 * The button used to open Source Control instead, on the argument that one
 * commit form is better than two that can disagree about what is staged. The
 * argument was right and the conclusion has changed: both surfaces commit THE
 * INDEX (`git:commitIndex`, no pathspec), and the index is exactly what the
 * checkboxes in this list are. There is one commit path; this is a second door
 * onto it, standing where the reader already decided what goes in.
 */
export interface CommitBoxState {
  /** Nothing to commit — hide the whole row rather than disable four controls. */
  hidden: boolean
  /** How many files the commit would carry. */
  keptCount: number
  /** Enabled only with something kept AND something written. */
  canCommit: boolean
  /** A message can be written for files; with none kept there is nothing to describe. */
  canGenerate: boolean
  /** What the button says while it is doing it. */
  commitLabel: string
  generateLabel: string
  /** The one sentence under the field, or null when there is nothing to say. */
  hint: string | null
}

export function commitBoxState(input: {
  files: readonly ChangeReviewFile[]
  readOnly: boolean
  message: string
  generating: boolean
  committing: boolean
}): CommitBoxState {
  const kept = input.files.filter((file) => file.staged)
  const written = input.message.trim().length > 0
  const busy = input.generating || input.committing
  return {
    hidden: input.readOnly || input.files.length === 0,
    keptCount: kept.length,
    canCommit: !busy && kept.length > 0 && written,
    canGenerate: !busy && kept.length > 0,
    commitLabel: input.committing ? 'Committing…' : 'Commit',
    generateLabel: input.generating ? 'Writing…' : 'Write it for me',
    hint:
      kept.length === 0
        ? 'Tick the files you want in this commit.'
        : written
          ? null
          : // The count is the useful half: a person who ticked six files and
            // sees "1 file" has learned something before they commit it.
            `${kept.length} ${kept.length === 1 ? 'file' : 'files'} ready — say what changed.`,
  }
}
