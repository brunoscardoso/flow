/**
 * The one rule that turns a thread's title into a branch name.
 *
 * IT LIVES HERE BECAUSE THREE SIDES NEED THE SAME ANSWER (allowed-pattern #14):
 *
 *  - main NAMES the branch from the title after the first successful turn,
 *  - main RENAMES it when a person types a new name for it,
 *  - and the renderer has to know whether a branch it is about to print was
 *    derived from the title sitting right next to it — because if it was, it
 *    is the same fact twice and the second copy is noise.
 *
 * A second spelling of this slug in the renderer would drift from the one main
 * writes, and the drift would be invisible: the titlebar would simply start
 * showing a name it thinks is independent when it is not.
 */

/** Every branch a thread's worktree gets on its own. */
/**
 * SECOND COPY LIVES IN `src/cli/loop/worktree.ts`, and cannot be merged with
 * this one: the root package compiles with `rootDir: ./src`, so importing
 * across the boundary fails with TS6059 (verified against tsc). The pair is
 * pinned by `src/cli/loop/thread-branch-prefix.test.ts`, which reads both
 * files rather than importing either.
 */
export const THREAD_BRANCH_PREFIX = 'worktree/'

/**
 * The prefix this app used to mint, still carried by every branch cut before
 * 2026-09-17.
 *
 * KEPT SO OLD WORK STAYS RECOGNISED. Nothing DETECTS a thread by its prefix, but
 * `branchIsTitleDerived` compares a branch against the name the title would
 * produce today — and without this, every existing `thread/<slug>` branch would
 * suddenly read as a name somebody chose by hand and start taking screen space
 * beside the title that says the same thing. New branches are minted with
 * `THREAD_BRANCH_PREFIX`; this one is only ever read.
 */
export const LEGACY_THREAD_BRANCH_PREFIX = 'thread/'

/** Longest slug taken from a thread title for its branch name. */
export const MAX_SLUG_LENGTH = 48

/**
 * The slug part of a branch name, or '' when the text survives none of it.
 *
 * SANITIZES. Only ever applied to values this app derived (a thread title, a
 * ticket key) — never to a branch name somebody typed.
 *
 * Lowercase words joined by `-`, because that is the grammar the worktree CLI
 * validates against and a refusal there would be a rename that silently never
 * happened.
 */
export function branchSlug(text: string | null): string {
  return (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '')
}

/**
 * The branch a titled thread's checkout should carry.
 *
 * A DERIVED NAME, so it sanitizes — see `isValidRefName` for the typed half,
 * and allowed-pattern #22 for why the two must not swap places.
 *
 * Returns null for a title that slugs to nothing — an emoji-only title is not
 * a branch name, and a detached checkout is a perfectly good state to stay in.
 */
export function threadBranchName(title: string | null): string | null {
  const slug = branchSlug(title)
  return slug === '' ? null : `${THREAD_BRANCH_PREFIX}${slug}`
}

/**
 * Whether this branch is just the thread's own title, spelled as a branch.
 *
 * TRUE MEANS THE NAME CARRIES NOTHING THE TITLE DOES NOT. Naming dedupes on
 * collision (`-2`, `-3`), so those count too: `thread/fix-the-parser-2` beside
 * a thread called "Fix the parser" is still the title and a disambiguator, not
 * a second fact about where the work goes.
 *
 * FALSE is the answer whenever the branch could surprise somebody — a worktree
 * that took an existing branch, a branch a person renamed by hand, or a title
 * that changed after the branch was cut. Those are the cases where the name is
 * worth screen space.
 */
export function branchIsTitleDerived(branch: string | null, title: string | null): boolean {
  const name = branch?.trim() ?? ''
  const derived = threadBranchName(title)
  if (name === '' || derived === null) return false
  // BOTH SPELLINGS. The prefix changed from `thread/` to `worktree/`; a branch
  // cut before that is no less derived from its title than one cut after.
  const slug = derived.slice(THREAD_BRANCH_PREFIX.length)
  for (const prefix of [THREAD_BRANCH_PREFIX, LEGACY_THREAD_BRANCH_PREFIX]) {
    const candidate = `${prefix}${slug}`
    if (name === candidate) return true
    // `<derived>-2`, `<derived>-17` — the dedupe suffix and nothing else.
    if (new RegExp(`^${escapeForRegExp(candidate)}-\\d+$`).test(name)) return true
  }
  return false
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a name is one git would accept as a branch.
 *
 * THE OTHER HALF OF THE RULE ABOVE, and the reason it had to be written.
 * `threadBranchName` SANITIZES: it takes a title nobody typed as a branch name
 * and produces one, slugging away whatever git would reject. That is right for
 * a value this app DERIVED and is offering as a suggestion.
 *
 * It is wrong for a value a person TYPED. Run through the same function,
 * `feature/PF-42-fix-parser` comes out as `thread/feature-pf-42-fix-parser` —
 * a different branch from the one on screen, created silently, and the ticket
 * shape that was the whole point of typing it gone. Allowed-pattern #22: what
 * you propose is sanitized, what you were told is validated.
 *
 * So this refuses instead of repairing. It is the rule git itself applies
 * (`git check-ref-format --branch`), spelled out rather than shelled out to:
 * the caller is a modal that has to explain the refusal in a sentence, and a
 * subprocess per keystroke is not a thing to put on the main process
 * (allowed-pattern #19).
 */
export function isValidRefName(name: string): boolean {
  const value = name.trim()
  if (value === '') return false
  // Git's own list, in the order it is easiest to check.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(value)) return false
  if (value.includes('..') || value.includes('@{')) return false
  if (value.startsWith('/') || value.endsWith('/') || value.includes('//')) return false
  if (value.startsWith('-') || value.startsWith('.')) return false
  if (value.endsWith('.') || value.endsWith('.lock')) return false
  // A DELIBERATE DIVERGENCE FROM GIT, and the only one. Checked against the
  // real thing: `git check-ref-format refs/heads/@` passes, because git's rule
  // is that the WHOLE refname cannot be `@` — `refs/heads/@` is not. So git
  // will happily create this branch. `@` is also revision shorthand for HEAD,
  // which makes `git checkout @` mean something else entirely, so a branch
  // named `@` is a trap the app should not help anyone build.
  //
  // Every other case in the test table matches `git check-ref-format` exactly
  // (23 of 24 verified against the binary, not against memory).
  if (value === '@') return false
  // No path component may start with a dot or end in .lock — the whole-string
  // checks above miss `feat/.hidden` and `feat/x.lock/y`.
  return value.split('/').every((part) => {
    if (part === '') return false
    if (part.startsWith('.')) return false
    return !part.endsWith('.lock')
  })
}

/**
 * Why a typed branch name cannot be used, or null when it can — SYNTAX ONLY.
 *
 * The other half of the question ("does something already answer to it?") needs
 * git and is asked wherever the rename actually happens. This half is the same
 * sentence everywhere it is asked, which is the point: a name refused at the
 * cut, in the worktree manager and on the Source Control line must not explain
 * itself three different ways for the same reason (allowed-pattern #14).
 */
export function branchNameProblem(name: string): string | null {
  const wanted = name.trim()
  if (wanted === '') return 'Type a name for this branch.'
  if (!isValidRefName(wanted)) return `\u2018${wanted}\u2019 isn\u2019t a name a branch can have.`
  return null
}
