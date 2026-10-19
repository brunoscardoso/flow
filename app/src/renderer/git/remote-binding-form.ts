// The ask that stands between a thread and a wrong-but-valid push
// (thread_remote_binding Phase 5, tasks 5.3 and 5.4).
//
// TWO SURFACES, ONE FORM. The landing bar shows it when a pull request refuses
// for want of a destination; the worktree list shows it when somebody wants to
// change one. They ask the same three things and they ask them the same way, so
// the questions, the pre-fill and the reasons a value cannot be used live here
// once (allowed-pattern #14) and both surfaces render what this returns.
//
// WHAT IT IS AND IS NOT. Every value below is a SUGGESTION put in front of a
// person. Nothing here binds anything, nothing here is sent anywhere, and the
// one field that is filled in from a guess says out loud that it is one — the
// failure this whole feature exists to prevent is a name that was plausible,
// unread and wrong.
//
// Pure and DOM-free, and it prints no command, no path and no config key
// (forbidden-pattern #12).

import type { ThreadBindingState, ThreadBindingSuggestion } from '../../shared/ipc-contract'

/** What a person has typed, or is about to accept. */
export interface BindingDraft {
  /** Which remote the work is published to. */
  remote: string
  /** What it is called when it gets there — NOT the local branch's name. */
  remoteBranch: string
  /** What a pull request opens against. Empty follows the branch it was cut from. */
  prBase: string
}

/** The whole question, ready to render. */
export interface BindingForm {
  title: string
  /** The sentence under the title — why this is being asked at all. */
  body: string
  /** What the three fields start with. */
  draft: BindingDraft
  /** The remotes to choose between, in git's order. Empty when none are known. */
  remotes: string[]
  /**
   * True only when there is a genuine choice to make.
   *
   * A SELECT WITH ONE OPTION IS A LABEL WEARING A CONTROL'S CLOTHES. One remote
   * is the ordinary case, and offering to pick between it and nothing adds a
   * decision nobody has.
   */
  showRemoteChoice: boolean
  /** What the name field's helper line says about where its value came from. */
  help: string
  /**
   * What the remote choice says about why one of its options is already
   * selected, or null when nothing pre-selected it.
   *
   * SAID ONLY WHEN THERE WAS A CHOICE TO MAKE. A pre-selected option among
   * several is the easiest thing on this form to accept unread, so the reason
   * it is selected is on screen next to it; with one remote there is no choice
   * and no claim to explain.
   */
  remoteHelp: string | null
  confirmLabel: string
}

/** What each rung of the ladder admits about itself. */
const HELP: Record<ThreadBindingSuggestion['source'], string> = {
  pattern: 'Suggested from the way this project names its branches.',
  ticket: 'Suggested from the ticket in this thread’s title.',
  learned: 'Suggested from the last branch you published here.',
  // THE WEAKEST RUNG SAYS SO. It is the local name and nothing more — no
  // convention was found, so accepting it unread is how a plausible wrong name
  // gets published. The sentence exists to be read before that happens.
  local: 'This is just the name it has here — change it if your project names things differently.',
}

/** Why one of several remotes is already selected. Names no setting, no file. */
const CONFIGURED_REMOTE_HELP =
  'Pre-selected because it is the copy this project usually publishes to — change it if this work goes somewhere else.'

/**
 * The question, pre-filled with the best thing anybody knows.
 *
 * THE ORDER OF THE PRE-FILL IS THE DESIGN. What is already bound wins, because
 * editing a binding starts from the binding. Then the proposal a refusal handed
 * back, which is the ladder's answer and carries its own provenance. Then the
 * local branch name, labelled as the guess it is.
 *
 * THE REMOTE IS DEFAULTED, NEVER INVENTED. The project's usual remote comes
 * down with the proposal and is offered pre-selected — a default a person
 * confirms with the same click that confirms everything else, and one this
 * form says out loud is a default. What is NOT offered is a name nothing
 * stands behind: with no binding, no project remote and more than one to
 * choose from, the field starts empty and the person says which one, rather
 * than being handed the first remote in the list to nod at.
 */
export function bindingForm(input: {
  /** The mirror, when a surface has read one. */
  binding: ThreadBindingState | null
  /** What a refused push proposed, when one has been refused. */
  suggestion: ThreadBindingSuggestion | null
  /** The branch this work is on here — the last rung, and never silently used. */
  localBranch: string | null
  /** The branch this work was cut from — what a pull request opens against. */
  base: string | null
}): BindingForm {
  const bound = input.binding?.bound === true
  const suggestion = input.suggestion
  const remotes = suggestion?.remotes ?? []
  // The project's usual remote counts only while this repository still has it —
  // a default naming something absent is not a default, it is a wrong answer
  // already filled in.
  const configured =
    suggestion?.remote != null && remotes.includes(suggestion.remote) ? suggestion.remote : null
  const remote =
    input.binding?.remote ?? configured ?? (remotes.length === 1 ? (remotes[0] ?? '') : '')
  const remoteBranch =
    input.binding?.remoteBranch ?? suggestion?.suggestion ?? input.localBranch ?? ''
  const prBase = input.binding?.prBase ?? suggestion?.base ?? input.base ?? ''
  // A NAME WITH NO PROVENANCE IS THE WEAKEST RUNG, and says so: with no
  // proposal to carry a source, whatever is in the box came from the local
  // branch — which is exactly what `local` means.
  const source = suggestion?.source ?? 'local'

  return {
    title: bound ? 'Where this work is published' : 'Where should this work go?',
    body: bound
      ? 'This is where this thread’s work is published, and what it is called there. Changing it leaves anything already published exactly where it is.'
      : 'Flow won’t guess where this thread’s work belongs. Say where it is published and what it should be called there.',
    draft: { remote, remoteBranch, prBase },
    remotes,
    showRemoteChoice: remotes.length > 1,
    // Editing a binding that already exists is not being handed a proposal, so
    // there is nothing to say about where one came from.
    help: bound && input.suggestion === null ? '' : HELP[source],
    remoteHelp:
      input.binding?.remote == null && configured !== null && remotes.length > 1
        ? CONFIGURED_REMOTE_HELP
        : null,
    confirmLabel: bound ? 'Save' : 'Publish it there',
  }
}

/**
 * Why a draft cannot be used, or null when it can.
 *
 * IT REFUSES EMPTINESS RATHER THAN FILLING IT IN. A blank name completed from
 * the local branch would put the guess back one layer down, where nobody sees
 * it — which is the bug, not the fix.
 */
export function bindingProblem(draft: BindingDraft): string | null {
  if (draft.remote.trim() === '') {
    return 'Say where this work should be published.'
  }
  if (draft.remoteBranch.trim() === '') {
    return 'Say what this work should be called there.'
  }
  if (!/[a-z0-9]/i.test(draft.remoteBranch)) {
    return 'That name has no letters or numbers in it, so there is nothing to call it.'
  }
  if (/\s/.test(draft.remoteBranch.trim())) {
    return 'That name has spaces in it, and a published name cannot have any.'
  }
  return null
}

/**
 * What a surface says about where this thread publishes, in one line.
 *
 * IT NAMES THE DESTINATION, NOT THE ROUTE. The local branch is already on the
 * row that owns this line, in its own element where it is free to shorten
 * (the worktree list's rule 2) — repeating it inside a sentence is how a
 * 53-character name gets to set a row's width.
 */
export function bindingLine(binding: {
  bound: boolean
  remote: string | null
  remoteBranch: string | null
  prBase: string | null
}): string {
  if (!binding.bound || binding.remote === null || binding.remoteBranch === null) {
    // NOT AN ERROR AND NOT A WARNING. Most threads land by merge and never
    // publish at all; this is the ordinary state of almost every worktree.
    return 'Not published yet'
  }
  const where = `Published as ${binding.remote}/${binding.remoteBranch}`
  return binding.prBase === null || binding.prBase === ''
    ? where
    : `${where} · opens against ${binding.prBase}`
}

/**
 * What a rename left behind on the remote, or null.
 *
 * SAID, NOT CLEANED UP. Re-pointing a binding does not delete the branch it
 * used to publish to — somebody may have a pull request open against it — so
 * the old name is named here rather than left to be found as an orphan.
 */
export function previouslyPushedNote(previouslyPushedAs: string | null): string | null {
  if (previouslyPushedAs === null || previouslyPushedAs === '') return null
  return `Previously published as ${previouslyPushedAs} — that copy is still there.`
}
