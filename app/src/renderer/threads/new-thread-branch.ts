/**
 * THE ONE DECISION, MADE BEFORE THERE IS A THREAD TO MAKE IT ABOUT — and the
 * one question main refuses to answer, restated in the same menu.
 *
 * Every earlier version of this asked in pieces and asked late: a plain text
 * box in the composer's footer for a branch name nobody had validated, a
 * dialog after the fact for where that branch begins, and a modal later still —
 * arriving over a conversation that already existed — for what should happen to
 * the work sitting uncommitted in the reader's editor. Three surfaces, three
 * moments, one decision.
 *
 * This module is that decision, whole and DOM-free. It decides four things, and
 * all four are things that can be WRONG, which is why they are here rather than
 * in the chip that draws them:
 *
 *   1. which rungs the menu offers (`newThreadRungs`, `newThreadBaseRungs`)
 *   2. what each one says (every string below, and nowhere else)
 *   3. what a dismissal means (`CarryAnswer`'s null, and `carryQuestion`'s)
 *   4. whether a typed name is acceptable — delegated, never re-derived
 *
 * THE NAME RULES ARE NOT RESTATED HERE. `suggestBranchName` sanitizes what this
 * app derived and `validateBranchName` refuses what a person typed
 * (allowed-pattern #22); both live in `branch-name.ts`, which delegates in turn
 * to the app's single spelling of git's ref grammar. A third opinion in this
 * file would drift from both, and would drift silently — the field would simply
 * begin accepting names the cut later refuses.
 *
 * THE VOCABULARY. Nothing below says *copy*, *workspace* or *worktree*. Three
 * of the carry lines are restated rather than lifted, and the restatements are
 * marked where they appear with what was dropped and what was kept.
 */

import type {
  CarryChoice,
  WorktreeBranchChoices,
  WorktreeBranchOption,
  WorktreeStart,
} from '../../shared/ipc-contract'
import {
  WORKTREE_FOLDER_PREFIX,
  folderForBranch,
  validateWorktreeName,
  worktreeNameFromTitle,
} from '../../shared/worktree-name'
import { suggestBranchName, validateBranchName } from './branch-name'

// ── What the chip is holding ───────────────────────────────────────────────

/** The two answers to "where does this thread's work happen?". */
export type NewThreadPlacement = 'own' | 'project'

/**
 * The whole of the chip's state.
 *
 * `typedName` IS NULLABLE ON PURPOSE, and the null is the interesting half. A
 * person who has not touched the field expects the suggestion to keep up with
 * what they are typing above it — they are still describing the work, and the
 * name is derived from that description. A person who HAS typed one expects it
 * to stay exactly as they left it, even when they go back and rewrite the ask.
 * Storing the suggestion eagerly collapses those two into one and gets the
 * second wrong: the typed name would be overwritten on the next keystroke in
 * the box above. So null means "still following", and a string means "a person
 * decided this".
 */
export interface NewThreadBranchChoice {
  placement: NewThreadPlacement
  /** null while the name still follows what is being typed above it. */
  typedName: string | null
  /**
   * What the checkout's FOLDER is called, when somebody typed one.
   *
   * THE SECOND NAME. `typedName` names the ref; this names the directory, and
   * they are free to differ — null means "take it from the title", exactly as
   * the branch's null does (user, 2026-09-17: "we should have two dif things,
   * one is branch, and another is worktree").
   */
  typedWorktree?: string | null
  /** Where an own branch begins. Meaningless when `placement` is 'project'. */
  start: WorktreeStart
}

/**
 * What the chip opens on: the project itself.
 *
 * THE DEFAULT WAS THE ISOLATED ONE, AND THE MEASUREMENT IS WHY IT IS NOT. The
 * gate restricting AUTOMATIC checkouts to loop-driven threads is correct and
 * works exactly as written — and it turned out not to be what was creating
 * them. Counted on a real machine: 152 threads, 23 checkouts, and **one** of
 * them cut by a loop. The other 22 existed because this constant said `own` and
 * nobody pressed anything. A default is not a decision, but it produces the
 * same files as one.
 *
 * The old argument here — "that is what a thread is for" — is still true of
 * SOME threads, and it stopped being true of the default the moment isolation
 * became the thing that happens to you rather than the thing you reach for.
 * Every consequence the reader reported downstream (a mark lit on every row
 * that therefore meant nothing, `Reveal in Finder` landing somewhere
 * unexpected, a push aimed at a branch nobody chose) begins here.
 *
 * ISOLATION IS ONE PRESS AWAY AND LOSES NOTHING. `OWN_LABEL` is the next rung
 * of the same menu, its name field is unchanged, and the choice is still free
 * to undo in either direction — which is what makes flipping the default the
 * cheap half of this fix rather than a removal of the feature.
 */
export const INITIAL_BRANCH_CHOICE: NewThreadBranchChoice = {
  placement: 'project',
  typedName: null,
  typedWorktree: null,
  // FROM THE BASE BRANCH. `here` meant "wherever the project folder is sitting",
  // which is usually the last thread's branch or something somebody checked out
  // to read — so a new conversation silently inherited work that was not its
  // own (user, 2026-09-17: "new thread should always start from main"). The
  // picker still offers every other starting point; this is only the answer
  // nobody gave.
  start: { kind: 'trunk' },
}

/**
 * The text a suggested branch name is derived from.
 *
 * TITLE FIRST, THEN THE ASK. The new-thread page has no title field for a
 * thread written from scratch (the description IS the ask, and the title comes
 * out of it later), so the description is what there is to name a branch after
 * — but the three import sources DO carry a title, and when one is there it is
 * the better sentence: somebody wrote it to be a name.
 */
export function branchSeed(draft: { title: string; description: string }): string {
  const title = draft.title.trim()
  return title === '' ? draft.description.trim() : title
}

/**
 * The branch name this choice actually stands for.
 *
 * One function, called by the chip's face, by its menu and by the request
 * builder, so those three can never show or send different names (the whole of
 * `branch-name.ts`'s contract restated at this level: the branch shown has to
 * be the branch made).
 */
export function chosenBranchName(choice: NewThreadBranchChoice, seed: string): string {
  return choice.typedName ?? suggestBranchName(seed)
}

/**
 * The folder this thread's checkout would land in.
 *
 * SAME SHAPE AS `chosenBranchName`, and deliberately a separate function: the
 * two names are derived from one title and then belong to different questions.
 */
export function chosenWorktreeName(choice: NewThreadBranchChoice, seed: string): string {
  const typed = choice.typedWorktree?.trim() ?? ''
  return typed === '' ? worktreeNameFromTitle(seed) : typed
}

/**
 * What goes IN the folder field — the name without its prefix.
 *
 * The prefix is the field's, not the value's: it is drawn beside the box, so
 * the value a person edits is only ever the part they chose.
 */
export function folderStem(choice: NewThreadBranchChoice, seed: string): string {
  const name = chosenWorktreeName(choice, seed)
  return name.startsWith(WORKTREE_FOLDER_PREFIX)
    ? name.slice(WORKTREE_FOLDER_PREFIX.length)
    : name
}

// ── The chip's face ────────────────────────────────────────────────────────

/**
 * How the chip reads. The same two tone words the header chip uses
 * (`branch-chip.ts`), for the same two states, so a reader who learns the
 * colours once does not learn them again three screens later.
 */
export type NewThreadChipTone = 'own' | 'project'

export interface NewThreadChipFace {
  /** The branch name, or a whole fragment when there is none to print. Never ''. */
  label: string
  tone: NewThreadChipTone
  /** Hover text: what this state MEANS, never what the control does. */
  title: string
}

/** What the chip says when nothing could tell it which branch the project is on. */
export const UNKNOWN_PROJECT_BRANCH_LABEL = 'Unknown branch'

/** A name in the reader's own quotes — never backticks, which read as code. */
function quoted(name: string): string {
  return `‘${name}’`
}

/** A branch worth printing, or null. Blank is not a name. */
function named(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

/** The branch a start names, or null for the two that name none. */
export function startBranch(start: WorktreeStart): string | null {
  return start.kind === 'branch' || start.kind === 'checkout' ? start.branch : null
}

/** One sentence about where an own branch begins, or '' when it begins where the reader is. */
function beginsNote(start: WorktreeStart, base: string | null): string {
  switch (start.kind) {
    case 'here':
      return ''
    case 'trunk':
      return base === null
        ? ' It begins from the project’s main branch.'
        : ` It begins from ${quoted(base)}, the project’s main branch.`
    case 'branch':
      return ` It begins from ${quoted(start.branch)}.`
    case 'checkout':
      return ` It works on ${quoted(start.branch)} itself.`
  }
}

/** The chip's whole answer for one moment. */
export function newThreadChipFace(
  choice: NewThreadBranchChoice,
  seed: string,
  projectBranch: string | null,
  /** The project's base branch by name, once the branch list has said which. */
  base: string | null = null,
): NewThreadChipFace {
  if (choice.placement === 'project') {
    const branch = named(projectBranch)
    return {
      label: branch ?? UNKNOWN_PROJECT_BRANCH_LABEL,
      tone: 'project',
      title:
        branch === null
          ? 'This thread changes the project’s files directly. Which branch they are on could not be read.'
          : `This thread changes the project’s files directly, on ${quoted(branch)}.`,
    }
  }
  // A CHECKOUT START NAMES THE BRANCH ITSELF. The thread does not make a branch
  // at all in that case — it takes one — so showing the suggested name here
  // would print a branch that is never going to exist.
  const taken = choice.start.kind === 'checkout' ? choice.start.branch : null
  const name = taken ?? chosenBranchName(choice, seed)
  return {
    label: name,
    tone: 'own',
    title:
      taken === null
        ? `Everything this thread does goes on ${quoted(name)}, and nowhere else.${beginsNote(choice.start, named(base))}`
        : `Everything this thread does goes on ${quoted(name)}, a branch it did not create.`,
  }
}

// ── The default: from the base branch, without moving the project ─────────

/**
 * What the new-thread page knows when it picks a default for nobody.
 *
 * Every field arrives on its own round trip, so every field has a "not read
 * yet" answer — and none of them guesses in the meantime.
 */
export interface NewThreadDefaultsSubject {
  /**
   * Where a new conversation's branch begins, as the project's settings
   * resolve it (the one resolver in main — never re-derived here). Until those
   * are read, `INITIAL_BRANCH_CHOICE.start`.
   */
  start: WorktreeStart
  /** Whether this project lets a thread have a checkout of its own at all. */
  worktreesAllowed: boolean
  /** The branch list, or null while it is unread. */
  choices: WorktreeBranchChoices | null
}

/** The project's base branch by name, or null while nobody has said which. */
export function baseBranchOf(choices: WorktreeBranchChoices | null): string | null {
  return named(choices?.branches.find((branch) => branch.trunk)?.name)
}

/** The branch a start lands on, by name — or null when that is not known yet. */
function startTarget(start: WorktreeStart, choices: WorktreeBranchChoices | null): string | null {
  if (start.kind === 'trunk') return baseBranchOf(choices)
  if (start.kind === 'here') return named(choices?.current)
  return start.branch
}

/**
 * What the chip opens on once the project has been read — the answer nobody gave.
 *
 * "ALWAYS START FROM MAIN BY DEFAULT" (user, 2026-10-08), WITHOUT MOVING THE
 * PROJECT. The default used to be the project folder, full stop — so a new
 * conversation began on whatever branch the folder happened to be sitting on,
 * usually the last piece of work, and nothing on the menu could say otherwise:
 * with the switch off the branch was a report, not a choice. Starting from the
 * base IN the project folder would mean switching that folder's branch, which
 * moves files under every editor and every other conversation working there,
 * and is not something to do to a tree with work in it. So:
 *
 *   - the folder is ALREADY where a new conversation should begin (on the base,
 *     or on the configured start) → work there. Nothing is made; this is the
 *     common case and the one that keeps checkouts rare (the reason the default
 *     stopped being `own` — 22 of 23 checkouts on one machine were defaults).
 *   - the folder is somewhere else → a branch of its own, cut from the base.
 *     The project folder, and everything uncommitted in it, is never touched.
 *   - the project has turned those off, or the branch list is not read yet →
 *     the folder, as before. Never a guess about a branch nobody has named.
 *
 * Only an UNTOUCHED chip takes this answer; anything a person picked stands.
 */
export function defaultBranchChoice(subject: NewThreadDefaultsSubject): NewThreadBranchChoice {
  const base: NewThreadBranchChoice = { ...INITIAL_BRANCH_CHOICE, start: subject.start }
  if (subject.start.kind === 'here') return base
  const target = startTarget(subject.start, subject.choices)
  if (target === null || subject.choices === null) return base
  if (target === named(subject.choices.current)) return base
  if (!subject.worktreesAllowed) return base
  return { ...base, placement: 'own' }
}

/** One entry in the compact "starts from" list. */
export interface StartPickerOption {
  /** Stable id, so the view answers with something other than an index. */
  id: string
  /** What the entry reads: the branch, then its role when it has one. */
  text: string
  start: WorktreeStart
  selected: boolean
}

/** The role word beside the base branch in the "starts from" list. */
export const BASE_ROLE = 'main branch'
/** The role word beside the project folder's own branch. */
export const HERE_ROLE = 'where you are now'

/**
 * Where a branch of its own could begin, base first.
 *
 * ONE COMPACT LIST, NOT THE OLD STAGE. A list of every branch with three lines
 * of explanation each was taken off this page for being a lecture at the
 * moment nobody had an opinion (2026-09-17). What a person does need here is
 * two answers by name — the base, and the branch they are on — plus the rest
 * for the few who want them; so each entry is one line, and the entry for a
 * branch nothing has open TAKES it, exactly as the thread menu's picker does.
 */
export function startPickerOptions(subject: {
  choices: WorktreeBranchChoices | null
  start: WorktreeStart
}): StartPickerOption[] {
  const current = named(subject.choices?.current)
  const base = baseBranchOf(subject.choices)
  const rows: Omit<StartPickerOption, 'selected'>[] = [
    {
      id: 'trunk',
      text: base === null ? `The ${BASE_ROLE}` : `${base} — ${BASE_ROLE}`,
      start: { kind: 'trunk' },
    },
  ]
  if (current === null || current !== base) {
    rows.push({
      id: 'here',
      text: current === null ? 'Where the project is now' : `${current} — ${HERE_ROLE}`,
      start: { kind: 'here' },
    })
  }
  for (const branch of subject.choices?.branches ?? []) {
    if (branch.current || branch.trunk || branch.name === current) continue
    const rung = baseRungFor(branch)
    rows.push({ id: rung.id, text: branch.name, start: rung.start })
  }
  // A start nobody listed — a configured branch that is not on this computer,
  // say — is still shown, rather than the list quietly selecting another one.
  if (!rows.some((row) => sameStart(row.start, subject.start))) {
    const name = startBranch(subject.start)
    if (name !== null) rows.push({ id: `${subject.start.kind}:${name}`, text: name, start: subject.start })
  }
  return rows.map((row) => ({ ...row, selected: sameStart(row.start, subject.start) }))
}

/**
 * The line under the project folder's branch, when it is not where a new
 * conversation should begin — or null when there is nothing to say.
 *
 * SAID, NEVER DONE. The way to the base from here is a branch of its own (the
 * switch above this line), not a change to the folder's branch, so this names
 * the difference and the press that resolves it — never a command.
 */
export function projectFolderNote(subject: {
  projectBranch: string | null
  choices: WorktreeBranchChoices | null
  worktreesAllowed: boolean
}): string | null {
  const base = baseBranchOf(subject.choices)
  const here = named(subject.projectBranch)
  if (base === null || here === null || here === base) return null
  return subject.worktreesAllowed
    ? `This works on ${quoted(here)}, not ${quoted(base)}. Turn the switch on to start from ${quoted(base)} without touching your project folder.`
    : `This works on ${quoted(here)}, not ${quoted(base)}: this project keeps every conversation in your project folder.`
}

// ── The menu's first stage: where the work happens ─────────────────────────

export type NewThreadRungId = 'own' | 'project' | 'base'

export interface NewThreadRung {
  id: NewThreadRungId
  /** The role word, fixed and short. A branch never appears inside it. */
  label: string
  /** One sentence: what this does to THEIR files. */
  detail: string
  /** The branch this rung is about, shown once and free to shorten. */
  branch: string | null
  selected: boolean
  /** True for the one rung that carries the editable name field. */
  editable: boolean
}

/** What the first stage needs to know. */
export interface NewThreadRungSubject {
  choice: NewThreadBranchChoice
  seed: string
  /** The branch the project itself is on, or null when it could not be read. */
  projectBranch: string | null
  /**
   * True once the branch list has been read and has something to offer.
   *
   * A DOOR TO AN EMPTY ROOM IS NOT A DOOR (forbidden-pattern #12's neighbour):
   * the third rung opens a list, so it is offered only when there is a list.
   * A project whose branches could not be read still gets the first two rungs,
   * which are the whole of the decision that matters.
   */
  branchesKnown: boolean
}

export const OWN_LABEL = 'On its own branch'
export const PROJECT_LABEL = 'In the project'
export const BASE_LABEL = 'Start from another branch…'

export function newThreadRungs(subject: NewThreadRungSubject): NewThreadRung[] {
  const { choice, projectBranch } = subject
  const own = choice.placement === 'own'
  const taken = choice.start.kind === 'checkout' ? choice.start.branch : null
  const project = named(projectBranch)

  const rungs: NewThreadRung[] = [
    {
      id: 'own',
      label: OWN_LABEL,
      detail:
        'The agent works on a branch of its own, so nothing it does touches the files you have open.',
      branch: taken ?? chosenBranchName(choice, subject.seed),
      selected: own,
      // The field belongs to this rung and only this rung — it is the name of
      // the branch this rung makes. A branch TAKEN is not made, so there is
      // nothing to name and the field would be editing a name git already owns.
      editable: own && taken === null,
    },
    {
      id: 'project',
      label: PROJECT_LABEL,
      detail:
        project === null
          ? 'The agent changes the files you have open. Which branch they are on could not be read.'
          : 'The agent changes the files you have open, on the branch you are already on.',
      branch: project,
      selected: choice.placement === 'project',
      editable: false,
    },
  ]

  if (subject.branchesKnown) {
    const begins = startBranch(choice.start)
    rungs.push({
      id: 'base',
      label: BASE_LABEL,
      detail:
        choice.start.kind === 'here'
          ? 'It begins where the project is now. Pick somewhere else for it to begin.'
          : 'Pick somewhere else for it to begin.',
      branch: choice.start.kind === 'trunk' ? null : begins,
      // Selected is a fact about the START, not about this rung being pressed:
      // it marks that the reader has already moved the beginning off the
      // default, which is the one thing they would want to see from the chip.
      selected: own && choice.start.kind !== 'here',
      editable: false,
    })
  }
  return rungs
}

// ── The menu's second stage: where that branch begins ─────────────────────

export interface NewThreadBaseRung {
  /** Stable id, so the view answers with something other than an index. */
  id: string
  /** The role word — or null for a row whose subject IS a branch. */
  label: string | null
  branch: string | null
  detail: string
  start: WorktreeStart
  selected: boolean
}

export const BASE_STAGE_TITLE = 'Where should this branch begin?'
/** The role word for beginning where the person already is. */
export const HERE_LABEL = 'Where you are now'
/** The role word for beginning at the project's default branch. */
export const TRUNK_LABEL = 'A fresh start'

/** Two starts asking for the same thing. */
export function sameStart(a: WorktreeStart, b: WorktreeStart): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'branch' && b.kind === 'branch') return a.branch === b.branch
  if (a.kind === 'checkout' && b.kind === 'checkout') return a.branch === b.branch
  return true
}

/**
 * A branch the person names, and the outcome genuinely available for it.
 *
 * THE TWO OUTCOMES ARE DIFFERENT AND BOTH ARE SAID. A branch nothing has open
 * can be TAKEN — the thread's commits land on it and there is no merge at the
 * end. A branch the project itself has open cannot be: git allows one checkout
 * per branch. Offering "take it" there would be offering an action that fails,
 * so the row offers the thing that works and says why it is that instead.
 */
function baseRungFor(branch: WorktreeBranchOption): Omit<NewThreadBaseRung, 'selected'> {
  if (branch.canCheckOut) {
    return {
      id: `checkout:${branch.name}`,
      label: null,
      branch: branch.name,
      detail: branch.remoteOnly
        ? 'The thread brings this branch down and works on it directly, so there is nothing to merge back.'
        : 'The thread works on this branch itself, so its commits are already in the right place and there is nothing to merge back.',
      start: { kind: 'checkout', branch: branch.name },
    }
  }
  return {
    id: `branch:${branch.name}`,
    label: null,
    branch: branch.name,
    detail:
      'You have this branch open, so the thread can’t work on it too. It begins a new branch from the same place — unpushed commits and all.',
    start: { kind: 'branch', branch: branch.name },
  }
}

/**
 * Everywhere this branch could begin.
 *
 * THE FIRST ROW IS THE DEFAULT AND IT IS THE PERSON'S OWN BRANCH. Whatever else
 * is on offer, the thing a thread does unless told otherwise is help with the
 * work in front of them — including the commits they have never pushed.
 */
export function newThreadBaseRungs(subject: {
  choices: WorktreeBranchChoices
  start: WorktreeStart
}): NewThreadBaseRung[] {
  const current = named(subject.choices.current)
  const rows: Omit<NewThreadBaseRung, 'selected'>[] = [
    current === null
      ? {
          id: 'here',
          label: HERE_LABEL,
          branch: null,
          detail:
            'It begins from the commit the project is sitting on. That is not a branch, so there is nowhere for the work to go back to — pick a branch below if you want one.',
          start: { kind: 'here' },
        }
      : {
          id: 'here',
          label: HERE_LABEL,
          branch: current,
          detail:
            'It begins from this branch exactly as it stands on your computer, including anything you haven’t pushed. Its work comes back here.',
          start: { kind: 'here' },
        },
  ]

  const trunk = subject.choices.branches.find((branch) => branch.trunk)
  if (trunk !== undefined && trunk.name !== current) {
    rows.push({
      id: 'trunk',
      label: TRUNK_LABEL,
      branch: trunk.name,
      detail:
        'It begins from the project’s main branch, brought up to date. Nothing you have in progress comes with it.',
      start: { kind: 'trunk' },
    })
  }

  for (const branch of subject.choices.branches) {
    if (branch.current || branch.trunk) continue
    rows.push(baseRungFor(branch))
  }

  return rows.map((row) => ({ ...row, selected: sameStart(row.start, subject.start) }))
}

// ── The menu's third stage: the question main refuses to answer ────────────

/**
 * The three answers to "what happens to the work you have not committed?".
 *
 * `threads:prepareWorktree` answers `needs-choice` rather than picking one,
 * and that refusal is correct: bringing the work along is what somebody
 * mid-refactor wants, and beginning from the last commit is what somebody
 * starting something unrelated wants, and nothing in the request distinguishes
 * them. So it is asked — in the chip's own menu, at the moment the person is
 * already choosing, rather than as a modal that arrives afterwards.
 */
export interface CarryRung {
  id: CarryChoice
  /** The button. A verb in the reader's terms — never a git verb. */
  label: string
  /** One sentence under it: what this does to THEIR files. */
  detail: string
}

export interface CarryQuestion {
  title: string
  body: string
  /**
   * Always three, always in this order: the two that act, then the one that
   * does nothing.
   */
  rungs: CarryRung[]
}

/**
 * What a carry menu nobody answered resolves to.
 *
 * NULL MEANS NOTHING IS MADE, and that is a deliberate change from the modal it
 * replaces. `worktree-offer.ts` resolved a dismissal to `clean` — safe for the
 * reader's files (nothing of theirs moved) but not neutral: the second
 * `prepareWorktree` call still went out, the branch was still cut, an idle
 * session was still dropped. That was defensible when the dialog owned the
 * screen and Escape was the only way past it. It is not defensible for a menu,
 * which a person dismisses by clicking anywhere else — moving the mouse is not
 * an answer, and it must not cut a branch.
 *
 * So the dismissal is strictly quieter than the one it replaces: it touches
 * neither the reader's files nor the thread. The invariant `clean` was chosen
 * to protect (forbidden-pattern #15 — no destructive default) is kept a
 * fortiori, because the new default does less than `clean` did.
 */
export type CarryAnswer = CarryChoice | null

function files(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`
}

/**
 * The carry question, or null when there is nothing worth asking about.
 *
 * Null for a clean tree, and null for a count that makes no sense — a caller
 * that could not read the project's state must not conjure a question about
 * work it cannot see.
 *
 * WHAT WAS RESTATED, AND WHY. Three of these lines are `worktree-offer.ts`'s,
 * reworded because they named the thing this plan is removing from the product:
 *
 *   - the body opened with the two nouns this plan removes from the product
 *     and closed with "so the agent can work without touching what you have
 *     open". The FACT is that last clause and it is kept whole; the nouns in
 *     front of it named a container the reader was never told existed, and the
 *     branch they are already looking at on the chip says it better.
 *   - "Copy my changes in" → "Bring my changes with it". The verb was the noun
 *     again, and the reader's question is not which git operation runs, it is
 *     whether their work comes along.
 *   - that choice's detail said "starts from a copy of your changes". Kept: the
 *     reassurance that their own files are untouched, which is the whole reason
 *     somebody picks it. Dropped: the word.
 *
 * The other two choices are lifted verbatim — they never named a container, so
 * there was nothing to restate and rewording them would have been change for
 * its own sake.
 */
export function carryQuestion(subject: {
  changedFiles: number
  baseBranch?: string | null
}): CarryQuestion | null {
  const changed = Math.trunc(subject.changedFiles)
  if (!Number.isFinite(changed) || changed <= 0) return null

  const branch = named(subject.baseBranch)
  const from = branch === null ? 'the last commit' : `the last commit on ${branch}`

  return {
    title: `Bring your ${files(changed)} with you?`,
    // NO PARAGRAPH. This explained what a worktree is, why it starts where it
    // starts, and what that means for the files on disk — three sentences in
    // front of a person who asked for none of it, at the moment they wanted to
    // start working (user, 2026-09-17: "this is too much… really simple and
    // short explanation, can be only a question"). The question is the
    // explanation; each answer says what it does in one line.
    body: '',
    rungs: [
      {
        id: 'commit',
        label: 'Yes, bring them',
        detail: 'They come with you, and your files stay exactly as they are.',
      },
      {
        // TWO ANSWERS, NOT THREE. "Set my changes aside" stashed them — a third
        // outcome, a place to remember, and a thing to undo later. The question
        // is binary and so are the answers now; `clean` is the one that leaves
        // everything the person has exactly where they left it.
        id: 'clean',
        label: 'No, start fresh',
        detail: `Starts from ${from}, up to date. Your changes stay where they are.`,
      },
    ],
  }
}

// ── What the choice asks main for ─────────────────────────────────────────

/** The two fields of a `threads:prepareWorktree` request this choice decides. */
export interface PrepareRequestShape {
  /** The worktree half: a checkout of its own, or the project's own folder. */
  worktree: 'own' | 'project'
  /** What the checkout's FOLDER is called. Absent → the title decides. */
  worktreeName?: string
  /** Where a NEW branch begins. Absent for a thread working in the project. */
  start?: WorktreeStart
  /** Absent when the thread is taking a branch rather than making one. */
  branch?: string
}

/**
 * What to ask main for — or null when the answer is "ask for nothing".
 *
 * THE PROJECT RUNG IS NOT A REQUEST. A thread working in the project's own
 * files is a thread that never calls `prepareWorktree` at all; returning some
 * "don't" shape would invite a caller to send it, and main has no such answer.
 * Null is the one that cannot be misread.
 *
 * A TAKEN BRANCH CARRIES NO NAME. `start: { kind: 'checkout' }` means the thread
 * works on an existing branch directly; sending a `branch` alongside it would
 * be asking main to name a branch that already has a name.
 *
 * THE FINAL CHECK IS THE PROMISE, NOT PARANOIA. The chip refuses an invalid
 * name at the field and never commits one — but this function is the last thing
 * between a name and git, and a name that would be refused downstream is
 * dropped here rather than sent. Dropping it costs the thread its chosen name
 * and nothing else: main's own fallback names the branch from the first reply,
 * which is exactly what every thread got before this control existed.
 */
export function prepareRequestFor(
  choice: NewThreadBranchChoice,
  seed: string,
): PrepareRequestShape {
  // "IN THE PROJECT" IS AN ANSWER NOW, NOT A SILENCE.
  //
  // This returned null, and null meant "do not call at all" — so the two facts
  // a person had just decided (a checkout of its own, and which branch) reached
  // main as ONE, carried by whether the call happened. Main could not tell
  // "they chose the project" from "nobody was asked" (user, 2026-09-17: "we
  // need to separate that concept everywhere").
  //
  // No `start` and no `branch` travel with it: a conversation in the project's
  // folder works on the branch that folder is on, and naming one here is the
  // combination main refuses by name rather than guesses at.
  if (choice.placement === 'project') return { worktree: 'project' }
  // THE FOLDER'S NAME TRAVELS WITH EITHER SHAPE — a checkout that TAKES a
  // branch still lands in a directory, and that directory still needs a name
  // somebody can read.
  // LINKED (no folder typed) → the folder comes from the BRANCH, prefixed, so
  // one typed word gives `feat/x` and `worktree-feat-x`. Unlinked → whatever
  // was typed for the folder, untouched.
  const typedFolder = choice.typedWorktree?.trim() ?? ''
  const folder =
    typedFolder === '' ? folderForBranch(chosenBranchName(choice, seed)) : typedFolder
  const named = validateWorktreeName(folder)
  const withFolder = named.ok ? { worktreeName: named.name } : {}
  if (choice.start.kind === 'checkout') {
    return { worktree: 'own', start: choice.start, ...withFolder }
  }
  const name = chosenBranchName(choice, seed)
  const check = validateBranchName(name)
  return check.ok
    ? { worktree: 'own', start: choice.start, branch: check.name, ...withFolder }
    : { worktree: 'own', start: choice.start, ...withFolder }
}

// ── The editable name field ───────────────────────────────────────────────

/**
 * What the chip should do with whatever is currently in the name field.
 *
 * THREE OUTCOMES, AND THE BLANK ONE IS NOT A REFUSAL. Emptying the field is a
 * person saying "stop, I don't want to name it after all" — and the honest
 * answer to that is the suggestion they started with, which follows what they
 * are typing above. Treating blank as invalid would show a red sentence for an
 * action whose meaning is perfectly clear, and would leave the field stuck:
 * every way out of it would be typing something.
 *
 * The other two are allowed-pattern #22 at the keystroke: a name that passes is
 * kept EXACTLY as typed, and a name that does not is refused with a sentence
 * and never repaired into a different branch.
 */
export type BranchFieldOutcome =
  | { kind: 'following' }
  | { kind: 'named'; name: string }
  | { kind: 'refused'; detail: string }

export function readBranchField(typed: string): BranchFieldOutcome {
  if (typed.trim() === '') return { kind: 'following' }
  const check = validateBranchName(typed)
  return check.ok ? { kind: 'named', name: check.name } : { kind: 'refused', detail: check.detail }
}
