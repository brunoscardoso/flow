/**
 * The decisions the `worktree bind | push | pr` verbs make BEFORE they touch
 * git or `gh` — every one of them a pure function over its arguments.
 *
 * WHY A SECOND MODULE. `remote-binding.ts` owns what a binding IS (read it,
 * write it, suggest one, tell me when it went stale). This owns what the VERBS
 * have to work out around a binding: which base a pull request opens against,
 * which repository a non-`origin` remote names, what the transcript of an
 * external tool said, and what the rename record should say next. Keeping them
 * here rather than inline in the command file is the same rule the rest of this
 * family follows — a verb is argument parsing, a refusal and an exec sequence,
 * and everything a test would want to drive is a function it can call with no
 * repository at all (NFR-2).
 */

/**
 * Which base a pull request opens against, or null when nobody has said.
 *
 * FOUR SOURCES, MOST-DELIBERATE FIRST, and the last rung is deliberately NOT
 * `main`:
 *
 *   1. `override`  — `--base` on this invocation. Somebody typed it just now.
 *   2. `prBase`    — the base recorded WITH the binding (the store's mirror of
 *                    it; git has no key for a PR base, so the caller passes it).
 *   3. `worktreeBase` — the branch the worktree was actually cut from. It is
 *                    the truest answer when nothing was chosen, and it is the
 *                    caller's to supply because it lives in the thread store,
 *                    never in git.
 *   4. `configBranch` — the project's default base from `.flowconfig`.
 *
 * NULL IS A REFUSAL, NOT A DEFAULT. Guessing `main` here is the same class of
 * mistake as guessing a remote branch name: it succeeds, it looks right, and
 * the pull request opens against a branch nobody meant. The verb refuses and
 * says what it is missing instead.
 *
 * Blank strings are absences — `.flowconfig` writes `branch:` with no value to
 * mean "not configured", and an empty base would reach `gh` as a flag with a
 * missing argument.
 */
export function resolvePrBase(input: {
  /** `--base` on this invocation. */
  override?: string | null;
  /** The base recorded with the binding. */
  prBase?: string | null;
  /** The branch the worktree was cut from. */
  worktreeBase?: string | null;
  /** `.flowconfig`'s `branch` — the project default. */
  configBranch?: string | null;
}): string | null {
  for (const candidate of [input.override, input.prBase, input.worktreeBase, input.configBranch]) {
    const value = (candidate ?? '').trim();
    if (value.length > 0) return value;
  }
  return null;
}

/** `owner/repo` — what `gh --repo` wants. */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** A remote that is a directory on this machine, in any of its spellings. */
const LOCAL_PATH_PATTERN = /^(\/|~|\.{1,2}\/|[A-Za-z]:[\\/]|file:\/\/)/;

/**
 * A hostname, as the first segment of a forge URL.
 *
 * THE DOT IS THE TEST, and a probe is what made it necessary: a remote pointing
 * at a sibling directory (`/tmp/scratch/elsewhere`) has three path segments
 * exactly like `github.com/owner/repo` does, and without this it was read as
 * the repository `scratch/elsewhere` — a slug `gh` would have taken seriously.
 * A single-label intranet host is the cost; it returns null and the verb says
 * it cannot tell, which is the right answer to give about a guess.
 */
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9-]+(?::\d+)?$/;

/**
 * The `owner/repo` a remote URL names, or null when it names something else.
 *
 * WHY THE `pr` VERB NEEDS THIS AT ALL: `gh pr create` works out its repository
 * from the checkout's `origin`, so a thread bound to `upstream` — a fork, a
 * mirror, a second remote somebody added — would open its pull request against
 * the WRONG repository while reporting success. Passing `--repo` explicitly is
 * the only way to say which one, and the only place the answer exists is the
 * remote's own URL.
 *
 * THREE SPELLINGS, ONE ANSWER. Git remotes are written as
 * `https://host/owner/repo.git`, `ssh://git@host/owner/repo.git` and the scp
 * form `git@host:owner/repo.git`; the last has no scheme at all, which is why
 * this cannot be a `new URL()` one-liner.
 *
 * NULL RATHER THAN A GUESS. A local path remote, a relative URL, a host with a
 * deeper namespace than `owner/repo` (some self-hosted forges) all return null
 * so the verb can refuse in one line, instead of handing `gh` a slug that does
 * not exist.
 */
export function parseRepoSlug(url: string | null | undefined): string | null {
  const value = (url ?? '').trim();
  if (value.length === 0) return null;
  // A directory on this machine names no repository `gh` could open anything
  // against, however many path segments it happens to have.
  if (LOCAL_PATH_PATTERN.test(value)) return null;

  // Drop the transport and the credentials: everything up to the host is noise
  // for this question. The scp form's `:` separator becomes a `/` so the two
  // shapes end up as the same list of path segments — and ONLY for that form,
  // because a URL with a scheme spells a PORT with the same colon
  // (`ssh://git@host:2222/owner/repo`) and converting it would invent a path
  // segment out of the port number.
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
  const hadScheme = scheme.test(value);
  const withoutScheme = value.replace(scheme, '');
  const withoutUser = withoutScheme.replace(/^[^@/]+@/, '');
  const scpNormalized = hadScheme ? withoutUser : withoutUser.replace(/^([^/:]+):/, '$1/');

  const segments = scpNormalized
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
  // host + owner + repo. Fewer means no repository was named; more means a
  // namespace this function has no right to flatten.
  if (segments.length !== 3) return null;
  if (!HOST_PATTERN.test(segments[0] ?? '')) return null;

  const slug = `${segments[1]}/${segments[2]}`;
  return REPO_SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * The first URL on a transcript — what `gh pr create` prints when it works.
 *
 * READ, NEVER PARSED FOR MEANING. `gh` writes prose around the URL and changes
 * that prose between versions; the URL is the one part of the output that is a
 * contract. The IDE's landing path has the same function for the same reason
 * (`app/src/main/git/thread-merge.ts#firstUrl`) — copied rather than shared,
 * because the CLI does not import from the app and the app does not import
 * from the CLI.
 *
 * NULL IS NOT A FAILURE. A pull request that already existed prints a
 * different line; the verb reports what it got rather than inventing a URL.
 */
export function firstUrl(transcript: string): string | null {
  for (const line of transcript.split('\n')) {
    const match = /https?:\/\/\S+/.exec(line);
    if (match !== null) return match[0];
  }
  return null;
}

/**
 * What the rename record should say after a bind, given what it says now.
 *
 * THE RECORD IS GIT'S, NOT THE STORE'S, and this is the rule that decides it.
 * FR-11 says a thread renamed after a push leaves the old branch on the remote
 * and SAYS SO — but a rename is a moment, and the surfaces that have to say so
 * (a panel row, a push result, the store's mirror) all read later. Git's own
 * config is where a later reader can still find it, so `bind` stamps it there
 * and everything else reads it back.
 *
 * THREE CASES:
 *
 *   - A rename away from a name that was PUBLISHED replaces the record. Only
 *     the most recent one is kept: "previously pushed as" is a pointer to the
 *     branch still sitting on the remote, and after two renames the first name
 *     is no longer the one somebody would go looking for.
 *   - Binding BACK to the name the record names clears it — the old branch is
 *     the current branch again, and a note saying otherwise would be wrong.
 *   - Anything else leaves the record exactly as it is. A rename away from a
 *     name that was never pushed erases nothing, because the branch the record
 *     points at is still on the remote and still the one nobody is watching.
 */
export function previousPushRecord(input: {
  /** What git currently records, or null when it records nothing. */
  stamped: string | null;
  /** The published name this bind is moving away from, or null. */
  renamedFrom: string | null;
  /** The name being bound now. */
  remoteBranch: string;
}): string | null {
  const remoteBranch = input.remoteBranch.trim();
  const renamedFrom = (input.renamedFrom ?? '').trim();
  if (renamedFrom.length > 0 && renamedFrom !== remoteBranch) return renamedFrom;

  const stamped = (input.stamped ?? '').trim();
  if (stamped.length === 0) return null;
  return stamped === remoteBranch ? null : stamped;
}
