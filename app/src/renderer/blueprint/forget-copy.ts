/**
 * What Reset is about to forget, in words.
 *
 * The button used to ask "Reset learning for 5 modules?" and then clear one
 * file. What actually stayed was everything the learning had produced — on the
 * project this was reported from: 400 module docs, 506 notes with 2,131 heat
 * ticks, 19 generated views, and the learned sections inside 57 features. The
 * count in the question was the smallest number on the screen.
 *
 * So the question now names the work, not the bookkeeping, and the answer
 * afterwards names what went. Both from the same tally, so they cannot
 * disagree.
 */
import type { LearnForgetTally } from '../../shared/ipc-contract'

/** `3 notes`, `1 note` — a count with the noun it counts. */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`
}

/**
 * The parts of a tally that are worth saying out loud — zero counts are
 * dropped, because "0 heat ticks" is noise in a sentence about deleting things.
 */
function pieces(tally: LearnForgetTally): string[] {
  const out: string[] = []
  if (tally.moduleDocs > 0) out.push(plural(tally.moduleDocs, 'module doc'))
  if (tally.notes > 0) out.push(plural(tally.notes, 'note'))
  if (tally.heat > 0) out.push(plural(tally.heat, 'heat tick'))
  if (tally.featuresStripped > 0) {
    out.push(
      `what was learned about ${plural(tally.featuresStripped, 'feature')}`,
    )
  }
  if (tally.featureViews > 0) out.push(plural(tally.featureViews, 'generated view'))
  if (tally.learningRows > 0) out.push(plural(tally.learningRows, 'status row'))
  return out
}

/** True when there is nothing to forget — the button then says so. */
export function forgetIsEmpty(tally: LearnForgetTally): boolean {
  return pieces(tally).length === 0
}

/**
 * The question, before anything happens.
 *
 * Deliberately long: this is irreversible, and a person deciding deserves the
 * real list rather than a number that undersells it.
 */
export function forgetQuestion(tally: LearnForgetTally): string {
  const list = pieces(tally)
  if (list.length === 0) return 'Nothing has been learned here yet.'
  return `Forget ${joinWithAnd(list)}?`
}

/** What the panel says after — the same facts, in the past tense. */
export function forgetResult(tally: LearnForgetTally): string {
  const list = pieces(tally)
  if (list.length === 0) return 'There was nothing to forget.'
  const skipped =
    tally.featuresSkipped.length === 0
      ? ''
      : ` ${plural(tally.featuresSkipped.length, 'feature file')} kept its learned section — someone had written inside it by hand.`
  return `Forgot ${joinWithAnd(list)}.${skipped}`
}

/** What survives, said once, where the question is asked. */
export const FORGET_KEEPS =
  'Your features keep their names and descriptions. Notes you wrote yourself, and the map of the code, are untouched.'

/** `a, b and c` — an Oxford-free list, because this is a sentence. */
function joinWithAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`
}
