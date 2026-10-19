// WHERE THIS PROJECT'S WORK COMES FROM — the one setting the board's Remote
// column and the loop both read.
//
// WHY IT CAME BACK. This lived on the Loops screen, which is gone: everything
// on that screen moved to where the decision is actually made, and this one has
// no such place — it is not about a hunt, or about a run, or about one loop. It
// is the project answering "which list is my work on", and the answer decides
// whether the board has a Remote column at all. Deleting the screen took the
// only way to set it with it, so a person who connected GitHub in Settings had
// no way to point anything at it. This is that setting, on the screen where
// every other project-wide answer lives.
//
// ONE QUESTION, N WRITES, and every consequence of that is faced rather than
// hidden. A project has one list and the store has one answer PER LOOP, in each
// loop's committed directive. The obvious fix — a single key in the project
// config — was considered and rejected when this was first built: a second
// setting can disagree with the first, and then nothing in the system knows
// which is true. So:
//
//  - The loops MAY ALREADY DISAGREE, and that is shown rather than silently
//    reconciled or reported as whichever answer came first.
//  - A WRITE MAY LAND HALF WAY. Two loops, one accepted and one refused, is a
//    real outcome of N writes and is reported as exactly that. Nothing is
//    rolled back: undoing the write that succeeded would be a second write
//    nobody asked for, against a file somebody may since have read.
//
// Pure — no DOM, no IPC. What draws it is a settings section; what performs it
// is `loops:setDirectiveQueue`, once per loop, and the CLI is the only writer.

import type { LoopSourceKind, LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'

/**
 * The two lists a project can read, and what each is called here.
 *
 * ORDERED, and the order answers "which one is this project's own": GitHub
 * first because it is the one that needs a name typed after it, the project's
 * own list second because it needs nothing at all.
 */
export const TASK_LIST_CHOICES: readonly { kind: LoopSourceKind; label: string }[] = [
  { kind: 'github', label: 'GitHub' },
  { kind: 'ledger', label: 'This project' },
]

/** What a person is asking for. */
export interface TaskListChoice {
  kind: LoopSourceKind
  /** `owner/name`. Read only under GitHub — the other list needs no location. */
  repo: string
}

/** What the section shows about the list this project reads now. */
export interface TaskListState {
  /** True when the loops could be read at all. */
  known: boolean
  /** The list every loop agrees on, or null when they do not (or none was read). */
  agreed: TaskListChoice | null
  /**
   * What each loop reads, when they DISAGREE — empty when they agree or when
   * nothing could be read.
   *
   * SHOWN, NEVER RECONCILED. A project whose loops point at different lists is
   * a real state somebody has to look at, and picking one of them to report
   * would be this surface inventing an answer.
   */
  disagreement: { loop: string; label: string }[]
  /** The loops a write would be performed against, in order. */
  loops: string[]
  /** One line saying what this project reads now. Always present. */
  summary: string
}

/** The words for a queue kind, on this surface. */
const KIND_WORDS: Record<string, string> = { github: 'GitHub', ledger: 'This project' }

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length === 0 ? null : trimmed
}

/**
 * One loop's list, in words.
 *
 * A GITHUB LOCATION IS A NAME (`owner/repo`) and is shown as one. A LEDGER
 * LOCATION IS A PATH, and a path is exactly what this surface must not print —
 * so the project's own list keeps only the file's stem, which is the half a
 * reader can act on (forbidden-pattern #12).
 */
export function taskListLabelFor(row: LoopStatusRow): string | null {
  const kind = trimmedOrNull(row.queueKind)
  const location = trimmedOrNull(row.queueLocation)
  if (kind === null) return location
  const word = KIND_WORDS[kind] ?? kind
  if (location === null) return word
  if (kind === 'ledger') {
    const segment = location.split('/').pop() ?? ''
    const dot = segment.lastIndexOf('.')
    const stem = dot <= 0 ? segment : segment.slice(0, dot)
    return stem.length === 0 ? word : `${word} · ${stem}`
  }
  return `${word} · ${location}`
}

/** What this project reads now, and what a write would touch. */
export function taskListStateFor(snapshot: LoopsSnapshot | null): TaskListState {
  if (snapshot === null || !snapshot.available) {
    return {
      known: false,
      agreed: null,
      disagreement: [],
      loops: [],
      summary: "Couldn't read this project's loops, so its list is unknown.",
    }
  }
  // A loop whose directive would not parse is a loop no write can reach, so it
  // is not one of the loops this control claims to change.
  const readable = snapshot.loops.filter((row) => trimmedOrNull(row.queueKind) !== null)
  if (readable.length === 0) {
    return {
      known: true,
      agreed: null,
      disagreement: [],
      loops: [],
      summary: 'This project has no loops yet, so there is no list to point them at.',
    }
  }
  const labels = readable.map((row) => ({ loop: row.loop, label: taskListLabelFor(row) ?? '' }))
  const distinct = [...new Set(labels.map((entry) => entry.label))]
  const loops = readable.map((row) => row.loop)
  if (distinct.length > 1) {
    return {
      known: true,
      agreed: null,
      disagreement: labels,
      loops,
      summary: 'This project’s loops do not agree on one list.',
    }
  }
  const first = readable[0] as LoopStatusRow
  const kind = first.queueKind === 'github' ? 'github' : 'ledger'
  return {
    known: true,
    agreed: { kind, repo: kind === 'github' ? (trimmedOrNull(first.queueLocation) ?? '') : '' },
    disagreement: [],
    loops,
    summary: `Reading from ${distinct[0] ?? ''}.`,
  }
}

/**
 * `owner/name`, as `gh` and the directive grammar both spell it — the app's own
 * copy of the CLI's `REPO_PATTERN`.
 *
 * MIRRORED RATHER THAN IMPORTED, like every other fact this renderer knows
 * about the CLI: the two processes share no module. Holding it here is what
 * lets a person who typed `widgets` find out while the box is still open,
 * instead of watching a write travel to a subprocess and come back as a
 * refusal about a file they have never seen.
 */
const REPO_SHAPE = /^[^\s/]+\/[^\s/]+$/

/**
 * Why this choice cannot be written, in a sentence a person can act on, or null.
 *
 * Only the GitHub list can be wrong here — the project's own list carries no
 * location to get wrong, which is exactly why it is offered without one.
 */
export function taskListProblem(choice: TaskListChoice): string | null {
  if (choice.kind !== 'github') return null
  const repo = choice.repo.trim()
  if (repo.length === 0) return 'Name the repository to read, as owner and name.'
  if (!REPO_SHAPE.test(repo)) {
    return `“${repo}” is not a repository — it needs an owner and a name, like acme/widgets.`
  }
  return null
}

/** What N writes did, said in one sentence. */
export function taskListOutcome(accepted: string[], refused: string[]): string {
  if (refused.length === 0) {
    const many = accepted.length === 1 ? 'loop' : 'loops'
    return `Done — ${String(accepted.length)} ${many} now read this list.`
  }
  if (accepted.length === 0) {
    return `Nothing changed — ${refused.join(', ')} refused the write.`
  }
  // HALF IS A REAL OUTCOME AND IS NAMED AS ONE. Reporting either half alone
  // would leave a person believing the project agrees when it does not.
  return `${accepted.join(', ')} changed; ${refused.join(', ')} did not.`
}
