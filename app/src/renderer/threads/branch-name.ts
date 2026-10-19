/**
 * THE TWO HALVES OF A BRANCH NAME, and why they must not swap places.
 *
 * This is allowed-pattern #22 as a module. Two inputs reach the same field and
 * want opposite handling:
 *
 *  - `suggestBranchName` takes something this app DERIVED — a conversation's
 *    title, written by a person for people — and must always hand back a usable
 *    name. Refusing here would leave the reader with an empty box at the exact
 *    moment they are being asked to decide, so it SANITIZES: a title of emoji,
 *    punctuation or nothing at all still yields a branch.
 *
 *  - `validateBranchName` takes something a person TYPED and must never change
 *    it. Run through the sanitizer, `feature/PF-42-parser` comes out as
 *    `thread/feature-pf-42-parser` — a different branch from the one on screen,
 *    created silently, with the ticket shape that was the whole point of typing
 *    it gone. So it REFUSES, with a sentence, and returns what it was given.
 *
 * THE BRANCH SHOWN HAS TO BE THE BRANCH MADE. That single sentence is the
 * contract; everything above is why it needs two functions to keep.
 *
 * WHERE THE RULES COME FROM. Neither half invents a grammar. Both delegate to
 * `shared/thread-branch.ts`, which is the app's one spelling of git's
 * `check-ref-format` (23 of its 24 cases verified against the binary) and whose
 * CLI twin is `sanitizeRefName` / `isValidRefName` in
 * `src/cli/loop/remote-binding.ts` — the pair is kept identical on purpose so a
 * name this surface suggests is a name the CLI will accept. A third spelling
 * here would drift from both, and the drift would be invisible: the field would
 * simply start accepting names the push later refuses.
 *
 * Pure and DOM-free; the chip's menu renders whatever this returns.
 */

import {
  THREAD_BRANCH_PREFIX,
  branchNameProblem,
  branchSlug,
  isValidRefName,
} from '../../shared/thread-branch'

/**
 * The branch offered when a title survives none of the slug.
 *
 * A CONSTANT, NOT A FAILURE. An emoji-only title is a perfectly ordinary thing
 * for a person to write, and `null` here would mean an empty field. The name is
 * deliberately dull: it is a placeholder the reader is expected to type over,
 * and a clever one would look like Flow had understood something it had not.
 */
export const FALLBACK_BRANCH_NAME = `${THREAD_BRANCH_PREFIX}work`

/**
 * A branch name derived from a conversation's title — always usable, never
 * empty, never something `validateBranchName` would refuse.
 *
 * IT MATCHES WHAT NAMING WOULD DO ANYWAY. The same prefix and the same slug
 * main uses when it names a branch after the first successful turn, so the
 * suggestion is not a second opinion about the same title — it is the name the
 * conversation was going to get, shown early enough to be edited.
 *
 * The final validity check is not defensive theatre: it is the promise this
 * function makes, kept in code rather than in an argument about the slug's
 * grammar, so a change to either side cannot quietly break it.
 */
export function suggestBranchName(title: string | null): string {
  const slug = branchSlug(title)
  if (slug === '') return FALLBACK_BRANCH_NAME
  const derived = `${THREAD_BRANCH_PREFIX}${slug}`
  return isValidRefName(derived) ? derived : FALLBACK_BRANCH_NAME
}

/**
 * The answer to "can this be the name?" — accepted with the name, or refused
 * with a sentence.
 *
 * A DISCRIMINATED UNION rather than a nullable string, because the two outcomes
 * carry different things and a caller that forgets which it is holding should
 * not compile. The accepted branch carries the name so the caller uses THIS
 * value rather than re-reading the field it validated — one code path from the
 * check to the creation (allowed-pattern #14).
 */
export type BranchNameCheck =
  | { ok: true; name: string }
  | { ok: false; detail: string }

/**
 * Whether a typed branch name can be used — SYNTAX ONLY.
 *
 * The other half of the question ("does something already answer to it?") needs
 * git and is asked where the branch is actually made. This half is the same
 * sentence everywhere it is asked, which is the point: a name refused at the
 * cut and a name refused at a rename must not explain themselves two different
 * ways for the same reason (allowed-pattern #14). The sentences themselves come
 * from `branchNameProblem`, so the refusal a person reads here is word for word
 * the one the rename has always given.
 *
 * WHAT COMES BACK IS WHAT WENT IN. The only difference is whitespace at the
 * ends, which is not part of any name and which a text field adds by accident —
 * nothing inside the name is touched, ever. If that ever needs to change, it
 * needs to become a refusal instead.
 */
export function validateBranchName(typed: string): BranchNameCheck {
  const problem = branchNameProblem(typed)
  if (problem !== null) return { ok: false, detail: problem }
  return { ok: true, name: typed.trim() }
}
