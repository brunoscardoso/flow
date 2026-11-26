/**
 * What the thread delete confirm says, and what it does to the thread's
 * worktree (thread-worktrees Phase 6; worktree-management follow-up).
 *
 * A thread with a worktree of its own is two things wearing one row: a
 * conversation, and a branch with code on it. The Delete on that row is aimed
 * at the conversation — and it was written when a thread was only ever a
 * conversation, so it said "Delete this thread?" with no idea that there might
 * be a week of uncommitted work behind it.
 *
 * TWO CASES, AND THEY ARE NOT THE SAME CASE.
 *
 *  1. THE COPY STILL HOLDS WORK THAT IS NOWHERE ELSE. The settled answer (a
 *     brainstorm rejection: deleting the worktree with the thread) is that **a
 *     click meant for a conversation never destroys code**. The worktree and
 *     the branch survive the delete, and the confirm says both what is there —
 *     the count and the branch name — and that it is not being destroyed,
 *     because the first sentence otherwise reads as a warning about losing it.
 *
 *  2. THE COPY HOLDS NOTHING THAT WOULD BE LOST. Its work reached its branch,
 *     or it never changed anything. There is nothing to protect and the copy is
 *     pure waste — a whole checkout of the project that nothing in the app will
 *     ever mention again, quietly accumulating every time somebody tidies their
 *     sidebar. So deleting the conversation frees it, and the confirm SAYS SO.
 *
 * HOW THAT SQUARES WITH "DESTRUCTIVE NEEDS AN EXPLICIT SAY-SO"
 * (forbidden-pattern #15). Releasing a worktree is destructive and the release
 * path refuses without `confirmed`. It is not, however, a second DECISION for
 * the reader: a person deleting a conversation did not open a disk-management
 * question and must not be handed one. So the say-so is the press they already
 * make, on a button whose sentence states the copy is freed — and the second,
 * separate say-so (`allowUnlanded`) is never given from here at all. Case 2's
 * classification only picks the SENTENCE; the safety is the release path's own
 * gate, which re-checks at the moment of the act and keeps the copy if the
 * answer changed underneath us.
 *
 * The branch name is the record that outlives the conversation, which is why it
 * is named rather than merely counted: after the row is gone it is the only
 * handle left on the work. The worktree's PATH is never shown — that is the
 * internal spelling forbidden-pattern #12 keeps off the screen — and no
 * sentence here instructs anyone to type anything.
 *
 * Pure and DOM-free: thread-sidebar.ts renders whatever this returns.
 */

export interface ThreadDeleteSubject {
  /** The thread's title, or null/'' when its first turn never named it. */
  threadTitle: string | null
  /** True when the thread has a checkout of its own. */
  hasWorktree: boolean
  /** The branch that checkout is on, or null while it has no name yet. */
  branch: string | null
  /**
   * Files with changes in that worktree, or null when it has NOT BEEN READ.
   *
   * Null is the confirm's opening state — the read is a round trip and the
   * menu is on screen before it answers — and it is deliberately the same
   * value an unreadable worktree leaves behind. Both mean "Flow cannot say",
   * and both get the sentence that promises nothing it cannot keep.
   */
  changedFiles: number | null
  /**
   * Commits in that worktree the branch it was cut from does not have.
   *
   * The SAME fact the release path checks, read from the same service — a
   * worktree with nothing uncommitted can still be holding a week of commits
   * that have not landed, and calling that "landed" is how a confirm ends up
   * promising to free something it must not touch. Null when there is no base
   * to compare against, which is exactly the release path's "nothing held".
   */
  aheadCommits?: number | null
  /** Title of the task that owns this chat 1:1, or null when none does. The
   *  question changes shape there (#1061) — a task stripped of its only chat
   *  is a different loss from a loose conversation. */
  owningTaskTitle?: string | null
  /**
   * The Docker data this conversation holds, or null/absent when it has none
   * (or the read has not landed, or Docker could not say). `totalBytes` is null
   * when at least one volume's size is unknown.
   *
   * Absent and null are the same answer, on purpose: with no volumes the notice
   * is exactly what it was before the feature existed.
   */
  dataVolumes?: { count: number; totalBytes: number | null } | null
}

export interface ThreadDeleteNotice {
  /** The question. Names the subject — "Are you sure?" over an unnamed row is
   *  how the wrong one gets deleted (#1173). */
  question: string
  /** The second line: what is there, and what happens to it. Null when the
   *  thread has no worktree at all — today's confirm, unchanged. */
  detail: string | null
  /** The destructive button's label. */
  confirmLabel: string
  /**
   * True when pressing the confirm should ALSO release the thread's copy of
   * the project.
   *
   * IT IS THE SAME ANSWER THE SENTENCE GIVES. The two are computed together
   * here precisely so they cannot disagree — a confirm that says the copy is
   * freed and then leaves it, or leaves it while saying nothing, is the app
   * lying about what it stored. Never carries the second say-so that would
   * overrule the release path's refusal: unlanded work is kept by that gate,
   * not by this flag.
   */
  releaseWorktree: boolean
  /**
   * Present ONLY when the conversation holds Docker data: the line that offers
   * to delete it, with its total size. The sidebar shows it beside a checkbox
   * that starts unticked — the data is removed only when the person ticks it
   * (forbidden-pattern #15), never by the Delete press alone.
   */
  volumesLine?: string
  /** The checkbox's own label ("Also delete its data"), present with `volumesLine`. */
  volumesLabel?: string
  /** True exactly when `volumesLine` is present: the sidebar offers the choice. */
  offerVolumes?: boolean
}

const UNTITLED = 'Untitled thread'

function threadName(subject: ThreadDeleteSubject): string {
  const title = subject.threadTitle?.trim() ?? ''
  return title === '' ? UNTITLED : title
}

/** Bytes as a person reads them: "340 MB", "1.2 GB". */
export function humanSize(bytes: number): string {
  const value = Math.max(0, bytes)
  if (value < 1024) return `${Math.round(value)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  // One decimal below 10, whole numbers above — "1.2 GB", "340 MB".
  const text = size < 10 ? size.toFixed(1) : String(Math.round(size))
  return `${text.replace(/\.0$/, '')} ${units[unit]}`
}

/** The checkbox's label in the delete confirm. */
export const VOLUMES_LABEL = 'Also delete its data'

/** "2 volumes · 1.3 GB. Left unticked, the data stays and can be removed later from Storage." */
function volumesLineOf(volumes: { count: number; totalBytes: number | null }): string {
  const count = volumes.count === 1 ? '1 volume' : `${String(volumes.count)} volumes`
  const size = volumes.totalBytes === null ? 'size unknown' : humanSize(volumes.totalBytes)
  return `${count} · ${size}. Left unticked, the data stays and can be removed later from Storage.`
}

function files(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`
}

function changes(count: number): string {
  return count === 1 ? '1 saved change' : `${count} saved changes`
}

/**
 * The confirm for deleting `subject`. A thread with no worktree — every
 * chat-only thread, forever — gets the plain question, no detail line and no
 * release, exactly as before.
 */
export function threadDeleteNotice(subject: ThreadDeleteSubject): ThreadDeleteNotice {
  const notice = worktreeNotice(subject)
  const volumes = subject.dataVolumes
  if (volumes === undefined || volumes === null || volumes.count < 1) return notice
  return { ...notice, volumesLine: volumesLineOf(volumes), volumesLabel: VOLUMES_LABEL, offerVolumes: true }
}

function worktreeNotice(subject: ThreadDeleteSubject): ThreadDeleteNotice {
  const owner = subject.owningTaskTitle?.trim() ?? ''
  // Unchanged from #1061: a task owns exactly one chat, so deleting the chat
  // strips the task of it — the question has to say whose chat this is.
  const question =
    owner === ''
      ? 'Delete this thread?'
      : `This chat belongs to the task “${owner}”. Delete it anyway?`
  if (!subject.hasWorktree) {
    return { question, detail: null, confirmLabel: 'Delete', releaseWorktree: false }
  }

  const branch = subject.branch?.trim() ?? ''
  const changed = subject.changedFiles === null ? null : Math.max(0, Math.trunc(subject.changedFiles))
  // NULL IS "CANNOT SAY"; UNDEFINED IS "NOT SUPPLIED". They were folded
  // together and both read as 0.
  //
  // `null` is the answer for a checkout on NO BRANCH: its commits have no base
  // to be counted against. Read as 0 it printed the empty-and-safe sentence
  // over work reachable from nowhere else, immediately before offering to
  // delete it — the same coercion the line above deliberately does NOT make
  // for `changedFiles`.
  //
  // `undefined` stays 0: it means this caller never computed the number, which
  // every pre-existing surface relies on, and is not evidence of anything.
  const ahead =
    subject.aheadCommits === undefined
      ? 0
      : subject.aheadCommits === null
        ? null
        : Math.max(0, Math.trunc(subject.aheadCommits))
  const name = threadName(subject)
  const where = branch === '' ? ', on no branch yet' : `, on the branch ${branch}`
  // The reassurance is the design, not a softener: deleting a conversation
  // must never delete code.
  const kept =
    branch === ''
      ? 'Deleting the conversation leaves its files and its changes exactly where they are.'
      : `Deleting the conversation leaves its files and ${branch} exactly where they are.`

  // NOT READ YET (or unreadable). The press is still safe — the release path
  // keeps anything it finds — so the sentence promises exactly that and
  // nothing more precise than Flow can currently see.
  // A null `ahead` is the same kind of not-knowing as a null `changed`, and it
  // takes the same branch. It means the worktree is on no branch, so nothing
  // it committed can be counted against a base — the one case where "0" would
  // have been read as "empty" over work that is reachable from nowhere else.
  if (changed === null || ahead === null) {
    return {
      question,
      detail: `“${name}” has files of its own${where}. Deleting the conversation frees them — unless they still hold work that is nowhere else, and then they stay exactly where they are.`,
      confirmLabel: 'Delete the conversation',
      releaseWorktree: true,
    }
  }

  // CASE 1 — there is something here that lives nowhere else.
  if (changed > 0) {
    return {
      question,
      detail: `“${name}” has ${files(changed)} changed in its own files${where}. ${kept}`,
      confirmLabel: 'Delete the conversation',
      releaseWorktree: false,
    }
  }
  if (ahead > 0) {
    return {
      question,
      detail: `“${name}” has files of its own${where}, holding ${changes(ahead)} that ${ahead === 1 ? 'hasn’t' : 'haven’t'} landed anywhere else. ${kept}`,
      confirmLabel: 'Delete the conversation',
      releaseWorktree: false,
    }
  }

  // CASE 2 — nothing to lose. The files go with the conversation, and the
  // sentence says which record survives it.
  if (branch === '') {
    return {
      question,
      detail: `“${name}” has files of its own with nothing in them. Deleting the conversation frees the space they were taking.`,
      confirmLabel: 'Delete the conversation',
      releaseWorktree: true,
    }
  }
  return {
    question,
    detail: `Everything “${name}” did is on the branch ${branch}. Deleting the conversation frees its files — ${branch} keeps the record of what it did.`,
    confirmLabel: 'Delete the conversation',
    releaseWorktree: true,
  }
}
