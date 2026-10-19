// Where should this branch publish? — the question, in a person's words.
//
// THE QUESTION EXISTS BECAUSE THE ANSWER MUST NOT BE ASSUMED. `git:publish`
// refuses an unaimed branch with `unbound` and hands back everything the ask
// needs (allowed-pattern #21); this module turns that payload into copy, and
// `remote-binding-dialog.ts` puts the copy on screen. Splitting them is not
// ceremony: the one thing that can go wrong with these words is that one of
// them hands the reader an invocation to run (forbidden-pattern #12), and a
// pure function can be held to that by a test rather than by whoever edits the
// render path next.
//
// NOTHING HERE DECIDES ANYTHING. It is content — no defaults filled in, no
// validation, no side effects. The two halves of allowed-pattern #22 live in
// different files on purpose: what we PROPOSE is passed through untouched
// (below), and what a person TYPES BACK is validated by the dialog before it
// can resolve.

import type { ThreadBindingSuggestion } from '../../shared/ipc-contract'

/**
 * Everything the modal renders, and nothing it does.
 *
 * Every field is a string or a plain list because the dialog is the DOM half:
 * handing it anything it had to interpret would move a decision into the render
 * path, which is exactly what this split exists to prevent.
 */
export interface RemoteBindingQuestion {
  title: string
  body: string
  /** The label above the destination field. */
  remoteLabel: string
  /**
   * Every destination this repository actually has, in the order it reported
   * them. Empty is a legitimate answer, not a failure — see `remoteIsTyped`.
   */
  remoteChoices: string[]
  /**
   * True when there is nothing to choose BETWEEN, so the destination is typed
   * rather than picked.
   *
   * IT IS SAID IN THE SHAPE, not left for the dialog to infer from an empty
   * list. A surface that derived "picker or field" from `remoteChoices.length`
   * would be re-deciding the question's form every time it painted, and the day
   * a one-entry list wants a field too, the rule would live in two places.
   */
  remoteIsTyped: boolean
  /**
   * What the destination field opens with — '' when nobody has named one.
   *
   * NOT COMPLETED FROM WHAT IS AVAILABLE (allowed-pattern #22). When the
   * project named a destination it arrives pre-selected, so the ordinary answer
   * costs a nod; when it did not, a single available remote is still NOT
   * selected on the reader's behalf. Picking the only one there looks harmless
   * and is the same act as picking one of four: naming a place nobody named.
   */
  remotePreset: string
  /** Ghost text for the destination field, in each of its two forms. */
  remotePlaceholder: string
  /** The label above the branch-name field. */
  branchLabel: string
  /**
   * The proposed name, VERBATIM.
   *
   * A DERIVED VALUE SHOWN FOR CONFIRMATION IS NEVER REWRITTEN ON ITS WAY TO THE
   * FIELD. Sanitising it here would mean the name the reader is asked to accept
   * is not the name that was proposed — and since this field is editable, any
   * cleaning we did would silently become their answer the moment they pressed
   * without reading. The validation belongs on what they type back
   * (allowed-pattern #22).
   */
  branchPreset: string
  /** One line under the branch field: where this name came from. */
  provenance: string
  /** The verb on the confirming button — fixed, so no repository sets its width. */
  confirmLabel: string
  cancelLabel: string
  /** What the dialog says when the destination is left blank. */
  blankRemoteMessage: string
  /** What it says when the name is left blank. */
  blankBranchMessage: string
}

/**
 * Where the proposal came from, said in the project's own words.
 *
 * THE ENUM IS NOT THE VOCABULARY. `pattern`, `ticket`, `learned` and `local`
 * are how the suggestion ladder labels its own rungs; none of them is a word a
 * reader of this dialog knows, and three of them mean something else in
 * ordinary English. What the person deciding actually needs is how strong the
 * claim is — a name built from the project's own convention is a much better
 * guess than the local branch's name reused for want of anything better — so
 * each rung says that outright instead of naming itself.
 */
const PROVENANCE: Record<ThreadBindingSuggestion['source'], string> = {
  pattern: 'Suggested from the way this project names its branches.',
  ticket: 'Suggested from an issue id in this work’s own title.',
  learned: 'Suggested from the shape of the last branch published here.',
  local: 'Suggested from the branch’s own name, for want of anything better.',
}

const TITLE = 'Where should this branch publish?'

const BODY =
  'Nobody has said where this work goes, so nothing has been sent yet. ' +
  'Choose where it should land and what it should be called when it gets there.'

/** Build the question from what the refusal carried with it. */
export function remoteBindingQuestion(
  suggestion: ThreadBindingSuggestion,
): RemoteBindingQuestion {
  const remoteChoices = [...suggestion.remotes]
  // An empty list is still an answerable question — the destination becomes
  // something to write rather than something to pick. Refusing to ask because
  // this repository reported no remotes would leave the reader with a control
  // that does nothing and no way to make it work.
  const remoteIsTyped = remoteChoices.length === 0
  return {
    title: TITLE,
    body: BODY,
    remoteLabel: 'Publish to',
    remoteChoices,
    remoteIsTyped,
    // Only what the project itself named, and only when this checkout has it —
    // a preset pointing somewhere absent is worse than no preset at all.
    remotePreset:
      suggestion.remote !== null && (remoteIsTyped || remoteChoices.includes(suggestion.remote))
        ? suggestion.remote
        : '',
    remotePlaceholder: remoteIsTyped ? 'Where this should go' : 'Choose one',
    branchLabel: 'Call it',
    branchPreset: suggestion.suggestion,
    provenance: PROVENANCE[suggestion.source],
    confirmLabel: 'Publish',
    cancelLabel: 'Cancel',
    blankRemoteMessage: 'Say where this should go — nothing will be chosen for you.',
    blankBranchMessage: 'Give it a name for when it arrives — nothing will be filled in for you.',
  }
}

/**
 * Every string this module authors, so a test can hold all of them to the same
 * rule at once.
 *
 * The two PRESETS are deliberately absent: they are data that arrived from the
 * repository, not words this app wrote, and a branch genuinely called
 * `feature/git-cleanup` must not fail a check written about our own checkout.
 */
export function authoredStrings(question: RemoteBindingQuestion): string[] {
  return [
    question.title,
    question.body,
    question.remoteLabel,
    question.remotePlaceholder,
    question.branchLabel,
    question.provenance,
    question.confirmLabel,
    question.cancelLabel,
    question.blankRemoteMessage,
    question.blankBranchMessage,
  ]
}
