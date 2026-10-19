/**
 * What the folder-behind notice says — every state, as words, with no DOM.
 *
 * The row this renders from carries no count (see `shared/folder-behind-marker`):
 * it records only that the folder was behind when the conversation began. So
 * every number on screen comes from the LIVE comparison, read through the same
 * `git:status` the git panel uses, and the past tense is all the stored row
 * asserts on its own.
 *
 * THE NOTICE OUTLIVES THE PULL, which is why there are so many states. A person
 * can press the action, pull in the git panel, pull in a terminal, reopen the
 * thread a week later, or arrive at a folder that has since diverged — and the
 * row is still sitting there in the transcript. Each of those has to read as
 * the truth at the moment it is looked at, not as the truth when it was
 * written.
 *
 * No command, no path, no setting key appears in any string here
 * (forbidden-pattern #12): the notice offers the action instead of naming the
 * invocation, and when it cannot act it says what is wrong with the folder.
 * Git's own refusal text is never shown — it is CLASSIFIED into one of three
 * known shapes and answered in this file's own words, so the reader never
 * meets "stash them before you merge" in a window with no terminal in it.
 */

/** The live comparison, as `git:status` answers it. */
export interface FolderBehindStatus {
  /** The folder's branch now — it may have moved since the row was written. */
  branch: string
  ahead: number
  behind: number
  /** How many files carry the person's own uncommitted changes. */
  dirtyFiles: number
}

/** What the person's press is doing, or has just done. */
export type FolderBehindAction =
  | { phase: 'idle' }
  | { phase: 'working' }
  /** The pull finished. `received` is measured by main, null when unknown. */
  | { phase: 'done'; received: number | null }
  /** The pull landed and left files to resolve. */
  | { phase: 'conflicted'; files: number }
  /** Git would not do it — classified, never quoted (see `classifyPullFailure`). */
  | { phase: 'refused'; reason: PullFailure }

export interface FolderBehindInput {
  /** The branch the row was written about. */
  branch: string
  /** The live numbers, or null while they are being read or if the read failed. */
  status: FolderBehindStatus | null
  action: FolderBehindAction
}

/** One control on the notice. */
export interface FolderBehindControl {
  label: string
  /** `pull` presses the action; `changes` opens the git panel. */
  kind: 'pull' | 'changes'
  /** True while the press is in flight — shown, not hidden, so the row holds still. */
  busy: boolean
}

export interface FolderBehindView {
  headline: string
  sub: string | null
  control: FolderBehindControl | null
  /** How loudly it reads: a warning, a settled fact, or something gone wrong. */
  tone: 'behind' | 'quiet' | 'done' | 'bad'
}

const PULL: FolderBehindControl = { label: 'Bring it up to date', kind: 'pull', busy: false }
const CHANGES: FolderBehindControl = { label: 'Open the changes', kind: 'changes', busy: false }

/** `1 commit`, `7 commits` — the unit the whole notice counts in. */
export function commits(count: number): string {
  return count === 1 ? '1 commit' : `${count} commits`
}

/** `1 file`, `3 files`. */
function files(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

export function folderBehindView(input: FolderBehindInput): FolderBehindView {
  const { action, status } = input
  // THE PRESS'S OWN OUTCOME WINS over the comparison, for as long as it is on
  // screen. A `git:status` read taken a moment after a pull can still be the
  // scan that started before it, and "up to date" flickering back to "7 behind"
  // is the app contradicting itself about something it just did.
  if (action.phase === 'working') {
    return {
      headline: behindHeadline(input.branch, status),
      sub: 'Bringing in the new commits.',
      control: { label: 'Bringing it up to date', kind: 'pull', busy: true },
      tone: 'behind',
    }
  }
  if (action.phase === 'conflicted') {
    return {
      headline: `${files(action.files)} need you to resolve them.`,
      sub: 'The new commits arrived and clash with your own. Nothing is lost.',
      control: CHANGES,
      tone: 'bad',
    }
  }
  if (action.phase === 'refused') {
    // THE CONTROL FOLLOWS THE REASON. "Try again" is the right offer for a
    // remote that was unreachable a moment ago; it is a button that cannot
    // work when files are in the way, because the next press fails
    // identically. That case gets the one action that helps instead.
    return {
      headline: 'Your folder was left as it is.',
      sub: REFUSAL_SENTENCES[action.reason],
      control:
        action.reason === 'local-changes'
          ? CHANGES
          : { label: 'Try again', kind: 'pull', busy: false },
      tone: 'bad',
    }
  }
  if (action.phase === 'done') {
    // MEASURED, NOT ASSUMED. `received` is main's before-and-after count, so
    // zero genuinely means nothing arrived — somebody else had already pulled.
    if (action.received === 0) {
      return {
        headline: 'Your project folder was already up to date.',
        sub: null,
        control: null,
        tone: 'quiet',
      }
    }
    return {
      headline:
        action.received === null
          ? 'Your project folder is up to date.'
          : `Your project folder is up to date. ${commits(action.received)} arrived.`,
      sub: 'This conversation started from the earlier version. Say what you want next and it will see the new files.',
      control: null,
      tone: 'done',
    }
  }

  // ── Nothing pressed yet: the live comparison decides ─────────────────────
  if (status === null) {
    // THE ROW'S OWN CLAIM, AND ONLY THAT. The live read has not answered (or
    // could not), so this says what the stored row knows — in the past tense,
    // which cannot go stale.
    return {
      headline: `Your project folder was behind ${input.branch} when this conversation began.`,
      sub: null,
      control: null,
      tone: 'quiet',
    }
  }
  if (status.behind === 0) {
    return {
      headline: `Your project folder was behind ${status.branch} when this conversation began.`,
      sub: 'It is up to date now.',
      control: null,
      tone: 'quiet',
    }
  }
  if (status.ahead > 0) {
    // COMMITS ON BOTH SIDES. Told, not offered: bringing it up to date would
    // merge the two, and whether a person's own commits should be merged into
    // is their decision, not a new conversation's.
    return {
      headline: `Your project folder is ${commits(status.behind)} behind ${status.branch}, and ${commits(status.ahead)} ahead.`,
      sub: 'Bringing it up to date would merge the two. That is a decision for you, not for a new conversation.',
      control: CHANGES,
      tone: 'behind',
    }
  }
  return {
    headline: behindHeadline(input.branch, status),
    sub:
      status.dirtyFiles > 0
        ? `You have uncommitted changes in ${files(status.dirtyFiles)}. They are kept.`
        : 'This conversation starts from where the folder is.',
    control: PULL,
    tone: 'behind',
  }
}

/** The one sentence every behind-state shares, live numbers when there are any. */
function behindHeadline(branch: string, status: FolderBehindStatus | null): string {
  if (status === null) return `Your project folder is behind ${branch}.`
  return `Your project folder is ${commits(status.behind)} behind ${status.branch}.`
}

/** The three shapes a refused pull takes, as far as a reader needs to care. */
export type PullFailure = 'local-changes' | 'unreachable' | 'other'

/**
 * Git's refusal, in this app's words.
 *
 * ONE SENTENCE PER CLASS, written here rather than relayed from git. The real
 * message is a terminal's ("Please commit your changes or stash them before you
 * merge", "Aborting"), and relaying it would put an instruction to go and do it
 * by hand in a window whose whole job is to do it for you
 * (forbidden-pattern #12). Each sentence names what is wrong with the folder
 * and leaves the remedy to the control beside it.
 */
const REFUSAL_SENTENCES: Record<PullFailure, string> = {
  // NOT "YOUR OWN", AND NO REMEDY IT CANNOT PERFORM.
  //
  // The pull now keeps uncommitted work across it, so this only fires for
  // files that cannot be set aside automatically. It used to say "Your own
  // uncommitted changes… Commit them or set them aside" — and the files are
  // very often Flow's: the provisioner edits `.gitignore` and a Tailwind entry
  // stylesheet in place and never commits them. So the sentence blamed a
  // person for edits they did not make and named a remedy that would put
  // Flow's own block in their history.
  'local-changes':
    'Files in your folder would have been overwritten by the new commits, so nothing was changed.',
  unreachable: 'Flow could not reach the remote. Check your connection, then try again.',
  other: 'Git would not bring in the new commits. Your files are untouched.',
}

/**
 * Which of the three a thrown pull was.
 *
 * MATCHED ON GIT'S OWN WORDING, which is the only evidence there is — the pull
 * channel rethrows git's message. Anything unrecognised is `other`, whose
 * sentence promises nothing about the cause and is true regardless; a
 * mis-guessed cause would be worse than an unnamed one.
 */
export function classifyPullFailure(message: string): PullFailure {
  const text = message.toLowerCase()
  if (
    text.includes('would be overwritten') ||
    text.includes('local changes') ||
    text.includes('unstaged changes') ||
    text.includes('commit your changes or stash')
  ) {
    return 'local-changes'
  }
  if (
    text.includes('could not resolve host') ||
    text.includes('could not read from remote') ||
    text.includes('connection timed out') ||
    text.includes('network is unreachable') ||
    text.includes('permission denied')
  ) {
    return 'unreachable'
  }
  return 'other'
}
