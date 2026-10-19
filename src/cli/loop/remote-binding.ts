/**
 * A thread's REMOTE binding — the remote, the remote branch and the PR base
 * that its local branch publishes to.
 *
 * TWO IDENTITIES, ONE BINDING. A thread has always had a local branch
 * (`thread/<slug>`, minted by `nameWorktreeBranch`), and every writer treated
 * that name as if it were also the name the project wanted on the remote: the
 * IDE landing path pushed it verbatim to a hardcoded `origin`, and the
 * execute-plan skill opened a PR against whatever base happened to be recorded.
 * The local name is OURS — generated from a thread title nobody chose. The
 * remote branch, the remote and the PR base belong to the project's
 * conventions, and the only reliable source for a convention is a person.
 *
 * NEVER GUESS (the plan's first constraint, and the reason this module has a
 * `suggest…` function and no `apply…` one). A wrong-but-valid push is the bug
 * this exists to stop: it succeeds, it looks right in the transcript, and the
 * work lands somewhere nobody is watching. So an unbound thread is REFUSED at
 * push and PR, with the suggestion carried in the refusal for a human (or an
 * `AskUserQuestion`) to accept, edit or reject. Nothing here writes a binding
 * as a side effect of reading one, and nothing falls back to the local name.
 *
 * GIT IS THE TRUTH, THE STORE IS THE MIRROR. The binding lives in git's own
 * upstream configuration — `branch.<local>.remote` and `branch.<local>.merge` —
 * so a person running plain `git push` from the worktree goes exactly where the
 * IDE would have sent them, and so a thread that was already pushed by hand is
 * read as bound rather than asked again (FR-10). Only `prBase` has no home in
 * git; it comes from the caller and is mirrored in the thread store. When the
 * two disagree, git wins.
 *
 * GIT IS AN INJECTED EXEC (allowed-pattern #12), as in `worktree.ts`. Every
 * function here is pure over its arguments plus that exec: no clock, no
 * filesystem, no `process.env`, and no test in this feature runs a real `git`
 * or touches PATH. That is also what makes the refusals testable without a
 * remote (NFR-2).
 */

import { LOOP_BRANCH_PREFIX } from './push-guard.js';
import type { GitExec } from './worktree.js';

/**
 * Where a local branch publishes to.
 *
 * `remote` and `remoteBranch` are git's; `prBase` is ours. `prBase` is null
 * when nobody has chosen one — the PR verb then falls back to the worktree's
 * recorded base, and refuses if there is none. A null is "not chosen", never
 * "default to trunk": defaulting a PR base is the same class of mistake as
 * defaulting a remote branch.
 */
export interface RemoteBinding {
  /** Remote NAME (`origin`, `upstream`), never a URL. */
  remote: string;
  /** Branch name on the remote, without `refs/heads/`. */
  remoteBranch: string;
  /** The base a PR from this branch opens against, or null when unchosen. */
  prBase: string | null;
}

/**
 * The characters a ref name may carry here — the same narrowing
 * `worktree.ts` applies to branch names, kept identical on purpose so a name
 * this module suggests is a name that module will accept.
 */
const REF_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Remote NAMES are narrower than ref names: no slashes, no dots leading. */
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Whether a string is usable as a branch name on a remote.
 *
 * Checked HERE rather than left to `git push` so a bad name is one refusal
 * line at the seam instead of git's multi-line complaint after a network
 * round trip — and so a suggestion can be rejected before it is ever shown to
 * a person as if it were valid.
 */
export function isValidRefName(value: string): boolean {
  const name = value.trim();
  return (
    REF_NAME_PATTERN.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.split('/').some((segment) => segment.endsWith('.lock') || segment.length === 0)
  );
}

/** Whether a string is usable as the NAME of a git remote. */
export function isValidRemoteName(value: string): boolean {
  const name = value.trim();
  return REMOTE_NAME_PATTERN.test(name) && !name.includes('..');
}

/**
 * Coerce arbitrary prose into something git will accept as a branch name, or
 * null when nothing usable survives.
 *
 * SANITIZE, DON'T REFUSE — for the SUGGESTION path only. A thread title is
 * written by a person for people ("ACME-2204: Error endpoint when spaces is not
 * enabled"); refusing it would leave the ladder with nothing to offer at the
 * exact moment a person is being asked to decide. A binding a person TYPES is
 * validated instead (`isValidRefName`), because there the input was deliberate
 * and silently changing it would be the surprise.
 */
export function sanitizeRefName(value: string): string | null {
  let name = value
    .trim()
    .replace(/\s+/g, '-')
    // Anything git cannot carry in a ref, plus the characters our own
    // narrowing rejects. Dropped rather than transliterated: a slug is a
    // handle, not a translation.
    .replace(/[^A-Za-z0-9._/-]+/g, '-');

  // Collapse the sequences git rejects outright. Looped because collapsing can
  // create a new one (`a...b` → `a..b` → `a.b`).
  let previous = '';
  while (name !== previous) {
    previous = name;
    name = name.replace(/\.\./g, '.').replace(/\/\//g, '/').replace(/--+/g, '-');
  }

  name = name
    .split('/')
    .map((segment) => segment.replace(/\.lock$/, '').replace(/^[-.]+|[-.]+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/');

  // A ref must start with an alphanumeric for our narrowing to accept it.
  name = name.replace(/^[^A-Za-z0-9]+/, '');

  if (name.length === 0 || !isValidRefName(name)) return null;
  return name;
}

/** The git config key holding a local branch's remote. */
function remoteKey(localBranch: string): string {
  return `branch.${localBranch}.remote`;
}

/** The git config key holding a local branch's upstream ref. */
function mergeKey(localBranch: string): string {
  return `branch.${localBranch}.merge`;
}

/** One `git config --get`, with "unset" (exit 1) read as absence, not failure. */
function configValue(exec: GitExec, path: string, key: string): string | null {
  try {
    const value = exec('git', ['config', '--get', key], path).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** `refs/heads/x` → `x`; anything else is returned as it came. */
function shortBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Read a local branch's binding from git, or null when it has none.
 *
 * THE MIGRATION PATH, and why this reads git rather than the store. Threads
 * that were pushed by hand before any of this existed already have an
 * upstream; reading it here means they are BOUND on the first look instead of
 * being asked to re-decide something they already decided (FR-10). Nothing is
 * renamed and nothing is re-pointed — this is read-only inference.
 *
 * A HALF-SET UPSTREAM IS UNBOUND. Git will happily hold a `.remote` with no
 * `.merge` (a `git config` typo, a partially-removed upstream), and a push
 * built from half a binding would pick its own destination — precisely the
 * guess this feature exists to prevent. Both keys or nothing.
 *
 * `prBase` COMES FROM THE CALLER because git has nowhere to keep it: the
 * thread store mirrors it, and a reader without the store passes null.
 */
export function readBinding(
  exec: GitExec,
  worktreePath: string,
  localBranch: string,
  prBase: string | null = null,
): RemoteBinding | null {
  const branch = localBranch.trim();
  if (branch.length === 0) return null;

  const remote = configValue(exec, worktreePath, remoteKey(branch));
  const merge = configValue(exec, worktreePath, mergeKey(branch));
  if (remote === null || merge === null) return null;

  const remoteBranch = shortBranch(merge);
  if (remoteBranch.length === 0) return null;

  return { remote, remoteBranch, prBase };
}

/**
 * Write a local branch's binding into git's own upstream configuration.
 *
 * `git config`, NOT `git branch --set-upstream-to`. The latter demands that
 * `<remote>/<branch>` already exist as a remote-tracking ref, which it does
 * not on a FIRST push — the exact moment a binding is decided. Setting the two
 * keys directly is what `git push -u` itself does once the push succeeds, and
 * it lets the binding be recorded BEFORE the network is involved.
 *
 * VALIDATED, NEVER SANITIZED. Values reaching here were typed or confirmed by
 * a person; quietly rewriting them would mean the branch they were told about
 * is not the branch that gets written.
 *
 * `prBase` IS NOT WRITTEN. Git has no key for it; the store is its home. This
 * function touching git only is what keeps "git is the truth" true for the two
 * fields git actually owns.
 */
export function writeBinding(
  exec: GitExec,
  worktreePath: string,
  localBranch: string,
  binding: RemoteBinding,
): void {
  const branch = localBranch.trim();
  if (!isValidRefName(branch)) {
    throw new Error(`'${localBranch}' is not a branch name`);
  }
  if (!isValidRemoteName(binding.remote)) {
    throw new Error(`'${binding.remote}' is not the name of a remote`);
  }
  if (!isValidRefName(binding.remoteBranch)) {
    throw new Error(`'${binding.remoteBranch}' is not a branch name`);
  }

  exec('git', ['config', remoteKey(branch), binding.remote.trim()], worktreePath);
  exec(
    'git',
    ['config', mergeKey(branch), `refs/heads/${binding.remoteBranch.trim()}`],
    worktreePath,
  );
}

/**
 * The refspec a bound push sends: `<local>:<remoteBranch>`.
 *
 * SPELLED OUT ON BOTH SIDES, ALWAYS — even when the two names are identical.
 * A bare `git push <remote> <branch>` resolves its destination through
 * `push.default` and any configured push refspec, which means the destination
 * is a function of the machine's configuration rather than of the binding a
 * person agreed to. An explicit `<src>:<dst>` is the same string on every
 * machine.
 */
export function bindingRefspec(localBranch: string, binding: RemoteBinding): string {
  const local = localBranch.trim();
  if (!isValidRefName(local)) {
    throw new Error(`'${localBranch}' is not a branch name`);
  }
  if (!isValidRefName(binding.remoteBranch)) {
    throw new Error(`'${binding.remoteBranch}' is not a branch name`);
  }
  return `${local}:${binding.remoteBranch.trim()}`;
}

/** The remote names configured in a checkout, in git's order. */
export function remoteNames(exec: GitExec, path: string): string[] {
  try {
    return exec('git', ['remote'], path)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Whether a remote branch of that exact name exists on that remote.
 *
 * `--heads` and an explicit pattern so the answer is one line or none: a bare
 * `ls-remote` on a large repository lists every ref, and a substring match
 * would read `feature/foo-2` as proof that `feature/foo` exists.
 */
function remoteBranchExists(
  exec: GitExec,
  path: string,
  remote: string,
  remoteBranch: string,
): boolean {
  const out = exec('git', ['ls-remote', '--heads', remote, `refs/heads/${remoteBranch}`], path);
  return out
    .split('\n')
    .some((line) => line.trim().endsWith(`refs/heads/${remoteBranch}`));
}

/**
 * Why a binding can no longer be honoured, or null when it can.
 *
 * TWO WAYS A BINDING GOES BAD, and only one of them is always a problem. The
 * REMOTE disappearing (renamed, removed, a clone that never had it) means the
 * push has nowhere to go — always stale. The remote BRANCH being absent means
 * either somebody deleted it after a merge, or this binding has simply never
 * been pushed; those look identical from here, which is why the second check
 * is the caller's to ask for. A first push must not be refused as "stale", so
 * `expectRemoteBranch` defaults to false and the push verb turns it on only
 * once the store says this thread has published before.
 *
 * THE REASON IS PROSE FOR A PERSON, not a code a caller branches on. Callers
 * that need to distinguish the two cases ask the two questions separately;
 * parsing this string would be a contract nobody agreed to.
 *
 * FAIL-SOFT ON THE NETWORK. `ls-remote` reaches out, and being offline is not
 * evidence that a binding is wrong — an unreachable remote returns null
 * (fresh) so an offline push fails at `git push`, with git's own message,
 * rather than being refused here for the wrong reason.
 */
export function bindingStaleness(input: {
  exec: GitExec;
  /** The checkout the binding belongs to. */
  path: string;
  binding: RemoteBinding;
  /**
   * Whether this binding has been pushed before. False (the default) skips the
   * remote-branch check entirely — a binding decided a moment ago has no
   * branch on the remote yet and is not stale for it.
   */
  expectRemoteBranch?: boolean;
}): string | null {
  const { exec, path, binding } = input;

  const remotes = remoteNames(exec, path);
  if (remotes.length > 0 && !remotes.includes(binding.remote)) {
    return `this worktree publishes to a remote named '${binding.remote}', which this repository no longer has`;
  }

  if (input.expectRemoteBranch !== true) return null;

  try {
    if (!remoteBranchExists(exec, path, binding.remote, binding.remoteBranch)) {
      return `'${binding.remoteBranch}' is no longer on ${binding.remote} — it was published there before`;
    }
  } catch {
    // Unreachable remote, no credentials, a proxy: not evidence of staleness.
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The suggestion ladder
// ---------------------------------------------------------------------------

/**
 * Which rung of the ladder produced a suggestion.
 *
 * CARRIED WITH THE SUGGESTION, not inferred by the caller, because the source
 * is what the person deciding actually needs: "this is your project's pattern"
 * and "this is just your local name, we had nothing better" are the same
 * string with completely different amounts of confidence behind them. The
 * landing form shows it as helper text (FR-4).
 */
export type RemoteBranchSource = 'pattern' | 'ticket' | 'learned' | 'local';

/** A proposed remote branch name and where it came from. */
export interface RemoteBranchSuggestion {
  suggestion: string;
  source: RemoteBranchSource;
}

/**
 * The built-in default naming, applied ONLY when a project has set no
 * `remote_branch_pattern` of its own.
 *
 * TWO TIERS, MOST-SPECIFIC FIRST, and this is the whole of TC-1. A single
 * `feat/{ticket}-{slug}` cannot degrade to `feat/{slug}`: `fillPattern` drops a
 * rung whole when a placeholder is unfillable, so a thread with no ticket would
 * lose the `feat/` prefix and fall through to the ticket rung's bare
 * `{ticket}-{slug}` (no prefix) or, ticketless, to the local name. Trying two
 * patterns in order — with the ticket, then without — expresses "the ticket is
 * optional" without inventing a new pattern grammar for users to learn.
 *
 * SOURCE STAYS `pattern`. A name produced from these is still the project's
 * convention (the shipped default IS the convention until a project overrides
 * it), so it is a CONFIDENT rung and `autoBindDecision` may apply it unattended.
 */
export const DEFAULT_REMOTE_BRANCH_PATTERNS = ['feat/{ticket}-{slug}', 'feat/{slug}'] as const;

/**
 * Whether an UNATTENDED run may apply a suggestion without asking, or must still
 * pause and let a person decide.
 *
 * THE ONE NARROWING OF "NEVER GUESS" (allowed-pattern #22 / the
 * thread-remote-binding decision). That rule exists because a wrong-but-valid
 * push lands where nobody is watching; this function is the single, code-level
 * place where the rule is relaxed, and it is relaxed only where the evidence is
 * strong AND nobody is present to be asked:
 *
 *   - `pattern` / `ticket` — the answer is the project's own convention applied
 *     to a named work item, not a guess. APPLIED, when unattended.
 *   - `learned` / `local`  — the ladder had to infer a shape or fall back to our
 *     own name. Weak evidence stays a question, unattended or not: ASKED.
 *
 * ATTENDED IS NEVER TOUCHED. With `unattended: false` this always returns `ask`,
 * so every attended surface keeps asking exactly as before (NFR-1). "Unattended"
 * is a declared property of the call, never sniffed from the environment (C-3);
 * this function only reads the boolean it was handed.
 */
export function autoBindDecision(
  suggestion: RemoteBranchSuggestion,
  opts: { unattended: boolean },
): 'apply' | 'ask' {
  if (opts.unattended !== true) return 'ask';
  return suggestion.source === 'pattern' || suggestion.source === 'ticket' ? 'apply' : 'ask';
}

/** The shape of a binding already made in this repository. */
export interface LastBinding {
  remote: string;
  remoteBranch: string;
}

/** Jira-and-friends: `ACME-2204`, `PROJ2-17`. Two leading chars minimum. */
const TICKET_PATTERN = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** GitHub-and-friends: `#1430`. */
const ISSUE_PATTERN = /#\d+\b/;

/** How many hyphen-words of a title survive into a branch name. */
const MAX_SLUG_WORDS = 6;

/** How many characters of slug survive, whatever the word count says. */
const MAX_SLUG_LENGTH = 48;

/**
 * The ticket a piece of prose names, or null.
 *
 * TWO SHAPES, IN THIS ORDER (FR-14). A Jira-style key is unambiguous, so it
 * wins wherever both appear — `#2` in "ACME-2204: fixes #2" is a reference, not
 * the subject. The match is returned VERBATIM, `#` and all: this function's
 * job is to say what the text names, and turning `#1430` into something git
 * will accept is the branch-name step's job, not this one's.
 */
export function extractTicketId(text: string | null | undefined): string | null {
  const value = (text ?? '').trim();
  if (value.length === 0) return null;
  return value.match(TICKET_PATTERN)?.[0] ?? value.match(ISSUE_PATTERN)?.[0] ?? null;
}

/**
 * A short kebab handle for a title, with the ticket taken out of it.
 *
 * TRUNCATED ON PURPOSE. A thread title is a sentence ("Error endpoint when
 * spaces is not enabled for a workspace member"), and a branch name that
 * carries the whole sentence is a name nobody can type, read in a PR list, or
 * fit in a terminal. Six words is enough to recognise and short enough to say.
 */
function titleSlug(text: string | null | undefined, ticket: string | null): string | null {
  let value = (text ?? '').trim();
  if (value.length === 0) return null;
  if (ticket !== null) value = value.split(ticket).join(' ');

  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word.length > 0)
    .slice(0, MAX_SLUG_WORDS);
  if (words.length === 0) return null;

  const slug = words.join('-').slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');
  return slug.length > 0 ? slug : null;
}

/** The last `/`-separated part of a branch name — `thread/fix-parser` → `fix-parser`. */
function refLeaf(ref: string): string {
  const parts = ref.split('/');
  return parts[parts.length - 1] ?? ref;
}

/** Everything up to and including a branch name's last `/`, or null when flat. */
function refNamespace(ref: string): string | null {
  const cut = ref.lastIndexOf('/');
  return cut > 0 ? ref.slice(0, cut + 1) : null;
}

/** The placeholders a `remote_branch_pattern` may carry. */
const PLACEHOLDER_PATTERN = /\{([a-z]+)\}/g;

/**
 * Fill a configured pattern, or null when it names something we do not have.
 *
 * AN UNFILLABLE PLACEHOLDER FALLS THROUGH — it does not become an empty
 * string. `feature/{ticket}` on a thread with no ticket would otherwise
 * suggest `feature/`, which is not a branch name, or `feature` with the
 * trailing slash trimmed, which is a branch name and the WRONG one. Falling to
 * the next rung offers something true instead of something well-formed.
 * Unknown placeholders (`{sprint}`) are unfillable by the same rule, so a
 * mistyped pattern degrades to the next rung rather than leaking braces into a
 * ref name.
 */
function fillPattern(pattern: string, values: Record<string, string | null>): string | null {
  let unfillable = false;
  const filled = pattern.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    const value = values[name];
    if (value === null || value === undefined || value === '') {
      unfillable = true;
      return '';
    }
    return value;
  });
  return unfillable ? null : filled;
}

/**
 * What to call this thread's branch on the remote — a PROPOSAL, never applied.
 *
 * FOUR RUNGS, MOST-SPECIFIC FIRST (FR-4), and the ordering is an ordering of
 * EVIDENCE rather than of convenience:
 *
 *   1. `pattern` — the project said so, in `.flowconfig`. Nothing beats an
 *      explicit convention.
 *   2. `ticket`  — the thread's own title (then the plan's name) names the
 *      work item. This is what a person would have typed.
 *   3. `learned` — the last binding made in this repository had a namespace
 *      (`feature/`, `bugfix/`), so this repository has a shape even though
 *      nobody wrote it down.
 *   4. `local`   — nothing above applied. The local name is offered as the
 *      last resort, LABELLED as such, so the person is choosing it rather than
 *      inheriting it silently. This rung is the difference between suggesting
 *      the local name and the old behaviour of pushing it.
 *
 * NOTHING HERE WRITES ANYTHING. The output is shown, edited or rejected; a
 * binding exists only after `writeBinding`, and only because somebody said so.
 *
 * THROWS ON A LOCAL BRANCH GIT CANNOT NAME, because there is no fourth rung
 * without one. In practice the caller reads it from git, and a detached HEAD
 * has already been refused by the bind verb for a better reason.
 */
export function suggestRemoteBranch(input: {
  /** `remote_branch_pattern` from `.flowconfig`, when set. */
  pattern?: string | null;
  /** The thread's title — the first place a ticket is looked for. */
  threadTitle?: string | null;
  /** The plan's name — the second place. */
  planName?: string | null;
  /** The most recent binding shape in this repository (`lastBinding`). */
  lastBinding?: LastBinding | null;
  /** The branch the worktree is actually on — and the THIRD place a ticket is
   *  looked for, after the title and the plan (#1839). */
  localBranch: string;
  /** Who is asking, for `{user}`. The caller resolves it; this stays pure. */
  user?: string | null;
  /**
   * Apply the built-in `feat/…` default when the project set no pattern of its
   * own — the ONLY caller that passes true is the unattended auto-bind path.
   *
   * OFF BY DEFAULT, ON PURPOSE. An attended unbound refusal must show the same
   * suggestion it always did (rung 2/3/4), so every existing surface and its
   * tests are byte-for-byte unchanged (NFR-1). The `feat/` default is a
   * convenience for a run with nobody to ask, not a new global convention — so
   * it is confined to the one path that has nobody to ask.
   */
  applyBuiltinDefault?: boolean;
}): RemoteBranchSuggestion {
  const local = input.localBranch.trim();
  if (!isValidRefName(local)) {
    throw new Error(`'${input.localBranch}' is not a branch name`);
  }

  // THE BRANCH IS THE THIRD PLACE A TICKET IS LOOKED FOR (#1839), and it is the
  // only one always available. A `--thread` caller supplies a title, but
  // `--here` — the mode added for the execute-plan skill, which "runs in
  // whatever checkout the user started it in, with no thread and no worktree"
  // — has neither a title nor, in this project's naming, a plan whose name is a
  // ticket. So `{ticket}` was unfillable, the pattern rung was skipped every
  // time, and a project that had DECLARED its convention was offered its own
  // local branch name back. That is precisely the confusion `source` exists to
  // prevent (allowed-pattern #21).
  //
  // LAST OF THE THREE, so a thread's own words still win over the branch it
  // happens to be standing on.
  const ticket =
    extractTicketId(input.threadTitle) ??
    extractTicketId(input.planName) ??
    extractTicketId(refLeaf(local));
  const slug =
    titleSlug(input.threadTitle, ticket) ??
    titleSlug(input.planName, ticket) ??
    titleSlug(refLeaf(local), ticket);

  // Rung 1 — the project's own pattern, or (only for an unattended caller that
  // opted in) the built-in default when the project set none. The default's two
  // tiers (`feat/{ticket}-{slug}` then `feat/{slug}`) are tried in order so a
  // thread with no ticket still gets a `feat/`-prefixed name rather than falling
  // through to a bare local one (TC-1). Either way the source is `pattern`: the
  // shipped default IS the convention until overridden. Without an explicit
  // pattern AND without the opt-in, this list is empty and the ladder falls to
  // rung 2 exactly as it always has — that is what keeps attended output
  // unchanged (NFR-1).
  const explicitPattern = (input.pattern ?? '').trim();
  const patterns =
    explicitPattern.length > 0
      ? [explicitPattern]
      : input.applyBuiltinDefault === true
        ? [...DEFAULT_REMOTE_BRANCH_PATTERNS]
        : [];
  const values = {
    ticket,
    slug,
    local,
    user: (input.user ?? '').trim() || null,
  };
  for (const candidate of patterns) {
    const filled = fillPattern(candidate, values);
    const suggestion = filled === null ? null : sanitizeRefName(filled);
    if (suggestion !== null) return { suggestion, source: 'pattern' };
  }

  // Rung 2 — the ticket the thread or the plan names, with what it is about.
  if (ticket !== null) {
    const suggestion = sanitizeRefName(slug === null ? ticket : `${ticket}-${slug}`);
    if (suggestion !== null) return { suggestion, source: 'ticket' };
  }

  // Rung 3 — the namespace this repository has been using. A FLAT last binding
  // teaches nothing that rung 4 does not already say, so it is not a rung.
  const namespace =
    input.lastBinding == null ? null : refNamespace(input.lastBinding.remoteBranch.trim());
  if (namespace !== null) {
    // `ticket` first, and it stays first even though rung 2 above has already
    // returned for every input where it is non-null: this rung is reachable
    // with a ticket only if `sanitizeRefName` rejected rung 2's composition.
    //
    // THE CASE MISMATCH #1839 ALSO REPORTED IS FIXED BY THE TICKET SOURCE
    // ABOVE, NOT HERE. The same branch used to read `acme-2446` from this rung
    // and `ACME-2446` from rung 2 — but only because nothing looked at the
    // branch for a ticket, so rung 2 was skipped and this one fell through to
    // the lowercasing `slug`. Now the branch supplies the ticket, rung 2
    // answers, and the two can no longer disagree about the same input. A
    // composition here would be unreachable code dressed as a fix.
    const leaf = ticket ?? slug ?? refLeaf(local);
    const suggestion = sanitizeRefName(`${namespace}${leaf}`);
    if (suggestion !== null) return { suggestion, source: 'learned' };
  }

  // Rung 4 — our own name, offered as ours.
  return { suggestion: sanitizeRefName(local) ?? local, source: 'local' };
}

// ---------------------------------------------------------------------------
// The learned rung's source
// ---------------------------------------------------------------------------

/**
 * One `branch.<name>.merge` line of `git config --get-regexp`, split back into
 * the local branch and the ref it tracks.
 *
 * SPLIT FROM BOTH ENDS, not on `.`, because a branch name may contain dots
 * (`release/v1.2`) and a naive split would report the local branch as
 * `release/v1` and quietly learn a shape from a branch that does not exist.
 */
function parseMergeLine(line: string): { localBranch: string; remoteBranch: string } | null {
  const trimmed = line.trim();
  const space = trimmed.indexOf(' ');
  if (space <= 0) return null;

  const key = trimmed.slice(0, space);
  const value = trimmed.slice(space + 1).trim();
  if (!key.startsWith('branch.') || !key.endsWith('.merge')) return null;
  if (!value.startsWith('refs/heads/')) return null;

  const localBranch = key.slice('branch.'.length, key.length - '.merge'.length);
  const remoteBranch = shortBranch(value);
  if (localBranch.length === 0 || remoteBranch.length === 0) return null;
  return { localBranch, remoteBranch };
}

/**
 * The most recent binding shape in this repository, or null when there is none.
 *
 * WHAT THE REPOSITORY DOES, READ FROM THE REPOSITORY. A project that has never
 * written `remote_branch_pattern` down still has a convention — it is sitting
 * in `branch.*.merge` on every branch anyone has pushed. Rung 3 of the ladder
 * reads it so the first thread in a `feature/`-shaped repository is offered a
 * `feature/`-shaped name instead of `thread/whatever-the-title-was`.
 *
 * `loop/*` IS EXCLUDED, and this is the v1 loop carve-out showing up here. A
 * loop's binding is a LOOP's binding — its branch namespace is enforced by
 * `push-guard.ts` and belongs to unattended runs, not to a person's thread.
 * Learning from it would teach every thread in a repository with an active
 * loop to publish under `loop/`, which is the one namespace a thread must not
 * touch.
 *
 * ORDERED BY COMMIT DATE, which is what git's own "recent branches" listings
 * use (`for-each-ref --sort=-committerdate`, the same call `worktree.ts` makes
 * for `refNames`). The per-branch reflog would be a truer "most recently used"
 * but costs one exec per branch and is empty in a fresh clone — a repository
 * where every reflog is missing would then teach nothing at all.
 *
 * FAIL-SOFT. `--get-regexp` exits non-zero when nothing matches, a repository
 * may have no branches, and neither is an error worth propagating: a ladder
 * with no third rung falls to its fourth.
 */
export function lastBinding(exec: GitExec, repoRoot: string): LastBinding | null {
  let merges: string;
  try {
    merges = exec('git', ['config', '--get-regexp', '^branch\\..*\\.merge$'], repoRoot);
  } catch {
    // No branch tracks anything — there is nothing to learn from.
    return null;
  }

  const tracked = new Map<string, string>();
  for (const line of merges.split('\n')) {
    const parsed = parseMergeLine(line);
    if (parsed === null) continue;
    if (parsed.localBranch.startsWith(LOOP_BRANCH_PREFIX)) continue;
    tracked.set(parsed.localBranch, parsed.remoteBranch);
  }
  if (tracked.size === 0) return null;

  let ordered: string[];
  try {
    ordered = exec(
      'git',
      ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/'],
      repoRoot,
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    ordered = [];
  }

  // Branches git could not order still count — they go last, in config order,
  // so a repository whose ref listing failed is not treated as having no
  // conventions at all.
  const candidates = [...ordered.filter((name) => tracked.has(name))];
  for (const name of tracked.keys()) {
    if (!candidates.includes(name)) candidates.push(name);
  }

  for (const localBranch of candidates) {
    const remoteBranch = tracked.get(localBranch);
    if (remoteBranch === undefined) continue;
    const remote = configValue(exec, repoRoot, remoteKey(localBranch));
    // A `.merge` with no `.remote` is the same half-binding `readBinding`
    // refuses to honour; it is not a shape worth teaching either.
    if (remote === null) continue;
    return { remote, remoteBranch };
  }
  return null;
}
