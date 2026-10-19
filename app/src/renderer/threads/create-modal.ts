// The rules two create dialogs share — pure, DOM-free, testable.
import type { MessageAttachmentInput, WorktreeStart } from '../../shared/ipc-contract'
import type { HuntConfig } from '../loops/hunt-config'

//
// WHAT IS SHARED AND WHAT IS NOT. `#promptNewTask` is 257 lines closing over
// eight pieces of sidebar state (`#newTaskDrafts`, `#afterCreate`,
// `#importIssue`, `#notify`, `#closeMenu`, …). Lifting that whole DOM builder
// out so a second dialog could call it would be a large refactor of a method
// nobody asked to change, for a benefit that lives almost entirely in the
// RULES rather than the markup.
//
// So this holds the rules: which sources exist, what each one asks for, and
// when the submit button is allowed to work. Those are the parts that would
// silently disagree between the two dialogs — a fifth source added to one, a
// hint reworded in the other — and disagreeing is the failure
// allowed-pattern #14 is about. The elements stay where they are built, wearing
// the same `fl-thread-menu*` classes.

/** Where a new task or thread can come from. */
export const CREATE_SOURCES = [
  { key: 'manual', label: 'From scratch' },
  { key: 'jira', label: 'Jira' },
  { key: 'github', label: 'GitHub' },
  { key: 'azure', label: 'Azure' },
] as const

export type CreateSource = (typeof CREATE_SOURCES)[number]['key']

/** What each imported source asks a person to paste. */
export const SOURCE_PLACEHOLDER: Record<Exclude<CreateSource, 'manual'>, string> = {
  jira: 'Jira key (PRJ-123) or issue URL',
  github: 'GitHub issue URL',
  azure: 'Azure work-item or PR URL (…/_workitems/edit/N or …/pullrequest/N)',
}

/** The label of a source, for a sentence. */
export function sourceLabel(source: CreateSource): string {
  return CREATE_SOURCES.find((entry) => entry.key === source)?.label ?? ''
}

export interface SubmitState {
  ready: boolean
  /** Why the button will not act, or '' when it will. Never a command. */
  hint: string
}

/**
 * Whether the dialog can act yet, and what to say while it cannot.
 *
 * A DISABLED CONTROL OWES A REASON IN ITS OWN TERMS (forbidden-pattern #12) —
 * the noun changes with the dialog ("task"/"thread"), never the shape of the
 * sentence, and never a field name or a config key.
 */
export function submitState(input: {
  source: CreateSource
  title: string
  reference: string
  noun: 'task' | 'thread'
  /**
   * Present only on a surface that has NO title field, where the description is
   * the thing being asked for and the title is generated from it afterwards.
   *
   * Passing it changes which box has to be filled AND what the refusal says, so
   * neither surface can end up demanding a field it does not show. Absent — the
   * task dialog, which still asks for a title — nothing about this changes.
   */
  description?: string
}): SubmitState {
  const described = input.description
  const titleless = described !== undefined
  const value =
    input.source === 'manual'
      ? (described ?? input.title).trim()
      : input.reference.trim()
  if (value !== '') return { ready: true, hint: '' }
  return {
    ready: false,
    hint:
      input.source === 'manual'
        ? titleless
          ? `Say what this ${input.noun} is about`
          : `Enter a ${input.noun} title`
        : `Enter a ${sourceLabel(input.source)} reference`,
  }
}

/**
 * Whether this source can produce a thread with NO card on the task board.
 *
 * Only "From scratch" can. The other three do not create a task as a side
 * effect of importing — importing IS creating one: the issue's key, link,
 * title and body land on a card, and the thread is the card's 1:1 chat. So the
 * checkbox is shown ticked and unusable for them, saying what will happen
 * rather than offering a choice that isn't there (forbidden-pattern #12: a
 * control that cannot act owes the reason in its own terms).
 */
export function taskIsForced(source: CreateSource): boolean {
  return source !== 'manual'
}

/** What the "also make a card" checkbox says, and whether it can be changed. */
export function taskCheckboxState(input: { source: CreateSource; asTask: boolean }): {
  checked: boolean
  disabled: boolean
  hint: string
} {
  if (taskIsForced(input.source)) {
    return {
      checked: true,
      disabled: true,
      hint: `A ${sourceLabel(input.source)} issue always arrives as a card — the thread is its chat.`,
    }
  }
  return { checked: input.asTask, disabled: false, hint: '' }
}

/** Everything a half-finished new-thread page is holding. */
export interface ThreadDraft {
  /** Which tab was showing when Create was pressed — it decides what gets made. */
  source: CreateSource
  title: string
  description: string
  branch: string
  /**
   * Where the thread's own branch BEGINS — a different question from `branch`,
   * which is what it is called.
   *
   * OPTIONAL, AND ABSENT IS THE DEFAULT. Absent means "where the project is
   * now", which is what every thread got before the chip offered anything else,
   * so a draft nobody touched still creates exactly the thread it used to.
   */
  start?: WorktreeStart
  /**
   * What the checkout's FOLDER is called — a third question, and the one that
   * was being thrown away.
   *
   * The chip has always worked this out (`prepareRequestFor` returns it), and
   * the draft had nowhere to put it: `withBranch` copied the branch and the
   * start across and let the folder's name fall on the floor. So a thread
   * created from this page got its branch named and its directory named after
   * the thread's id — a person's shell prompt reading
   * `6418475d-0a52-46d8-a854-4440abc99960` beside a branch called
   * `worktree/work-test-branch` (user, 2026-09-17).
   *
   * OPTIONAL, AND ABSENT IS THE DEFAULT, like `start`: absent means "name it
   * from the conversation's title", which is what main does on its own.
   */
  worktreeName?: string
  reference: string
  /**
   * Put a card on the task board too. The card owns this thread 1:1, so this
   * is not a second thing being created alongside the thread — it is the same
   * thread, tracked. Always true for an imported issue (`taskIsForced`).
   */
  asTask: boolean
  /** Primary first — the order the checklist was ticked in. */
  roots: string[]
  /**
   * The runtime settings for the thread's FIRST turn, chosen before it exists.
   *
   * They were only reachable from the composer, which does not appear until a
   * thread is open — so the opening turn, the one most worth choosing a model
   * for, was the one turn you could not choose one for. Empty means "whatever
   * the thread would have defaulted to", which is what every caller before this
   * got, so an untouched page still creates exactly the thread it used to.
   */
  model: string
  effort: string
  /** Images to send with the description, as its first message. */
  attachments: MessageAttachmentInput[]
  /**
   * The loop this thread was asked to run as, when somebody switched it on.
   *
   * OPTIONAL, AND ABSENT IS THE NORMAL CASE. A thread is a conversation; a
   * thread with a hunt behind it is a conversation that keeps looking after it,
   * and only the page that offers the switch fills this in. `loop` is null when
   * the project's producer could not be settled — the caller checks both rather
   * than starting a hunt against a name nobody chose.
   */
  hunt?: { config: HuntConfig; loop: string | null }
}

export const EMPTY_THREAD_DRAFT: ThreadDraft = {
  source: 'manual',
  title: '',
  description: '',
  branch: '',
  reference: '',
  asTask: false,
  roots: [],
  model: '',
  effort: '',
  attachments: [],
}

// ROOT SPLITTING LIVES IN `multi-project-picker.ts` (`splitRoots`), which is
// older, tested, and better than the version this module briefly grew: it
// dedupes the selection and keeps the PREFERRED primary when it is ticked,
// rather than taking whichever box happened to be first. A checklist has no
// meaningful order, so "first ticked" was the wrong rule — and two answers to
// one question is the drift this module exists to prevent
// (allowed-pattern #14).
