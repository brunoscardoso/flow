// The one place a provider + the account's own model ids become a labelled
// picker list (#1918). Both model pickers — the in-session composer
// (`composer.setModelProvider`) and the new-thread page — build their options
// through this, so the two surfaces cannot drift into offering different lists
// (allowed-pattern #14). It used to live inlined in the composer, and the
// new-thread page offered a hardcoded Claude alias list as a result: a Copilot
// user's configured models were unselectable when starting a session.
//
// Pure and DOM-free, so it is unit-testable without a renderer.

import {
  COPILOT_MODEL_LABELS,
  modelOptionsFor,
  type RuntimeModelOption,
} from '../../shared/runtime-models'
import { modelLabel } from './model-label'

/**
 * The options a picker offers for `provider`: the provider's base aliases
 * (`modelOptionsFor` — for Copilot/Codex that is only Auto), followed by the
 * account's own ids.
 *
 * `extraModels` are what the person pinned (Settings → Models) plus what Flow
 * found without being told (Codex's rollouts, Copilot's catalogue, Claude's own
 * entitlement list). They are deduped against the base aliases and against each
 * other, and LABELLED rather than shown raw — `claude-opus-5` reads as "Opus 5",
 * the same name the transcript uses for the model that ran.
 */
export function buildModelOptions(
  provider: string,
  extraModels: readonly string[] = [],
  untestedModels: readonly string[] = [],
): RuntimeModelOption[] {
  const base = modelOptionsFor(provider)
  const taken = new Set(base.map((option) => option.value))
  const keep = (value: string): boolean => {
    if (value === '' || taken.has(value)) return false
    taken.add(value)
    return true
  }
  // Copilot's ids get their catalogue label ("GPT-6 Astra", "Claude Sonnet 5")
  // — modelLabel only knows Claude families and would print the raw id for a
  // gpt/gemini/grok/mai model, or drop a dotted minor like `5.6`. Provider-
  // scoped so Claude's own labels ("Sonnet 5") are untouched (#1929).
  const labelFor = (value: string): string =>
    (provider === 'copilot' ? COPILOT_MODEL_LABELS[value] : undefined) ?? modelLabel(value)
  return [
    ...base,
    ...extraModels
      // `!taken.add(value)` was the dedupe here, and it discarded EVERYTHING:
      // `Set.add` returns the Set, which is truthy, so the negation is always
      // false and no extra model ever survived the filter. A Copilot account
      // with four models pinned got a picker offering one entry — Auto — and
      // the select hid itself as well, because `options.length < 2`.
      //
      // The add is a side effect, not a test. Keeping the two apart is what
      // makes that impossible to mistake again.
      .filter(keep)
      .map((value) => ({ value, label: labelFor(value) })),
    // OFFERED, AND SAID TO BE A GUESS. These are ids Copilot commonly takes,
    // measured on one account — Flow cannot ask GitHub what THIS plan has, and
    // picking one it does not have comes back as
    // `Model "claude-sonnet-4.5" from --model flag is not available`.
    //
    // Listing them unmarked made the picker promise a model the account may not
    // own; leaving them out made a person hand-type ids to use their own
    // runtime. Marked, the choice is theirs and informed — and the moment a
    // model is watched running it arrives through `seen` instead, labelled
    // plainly, because by then it is not a guess any more.
    ...untestedModels
      .filter(keep)
      .map((value) => ({ value, label: `${labelFor(value)} (untested)` })),
  ]
}
