/**
 * The push carve-out — the one place the standing "no unprompted pushes" rule
 * is relaxed, and the code that makes the relaxation exactly as narrow as it was
 * agreed to be.
 *
 * A loop may push its own `loop/*` branch and open a pull request from it.
 * Nothing else: not `main`, not a colleague's feature branch, not a branch
 * deletion, and not a refspec whose left-hand side hides a different
 * destination on its right (`git push origin HEAD:main` pushes to main, which
 * is precisely the shape a ref-prefix check reads as safe if it only ever looks
 * at the string it was handed).
 *
 * ENFORCED AT THE SEAM, IN CODE (allowed-pattern #14). The rule is not restated
 * in a run prompt, because a rule restated across N prompts is a rule that
 * drifts; `loop push` cannot reach `git` without coming through here, so a
 * prompt that has never heard of the carve-out still cannot violate it.
 *
 * PURE. No exec, no clock, no I/O — a refusal is a string, and the caller turns
 * it into the one `loop refused:` line and the exit code.
 *
 * MERGING LIVES HERE TOO, and for the same reason. Landing a branch is the
 * largest thing a loop may do unattended, so its gate is written beside the push
 * carve-out rather than in the verb that calls it: one file answers "what may a
 * loop write, and what may it land", and both answers are functions of their
 * arguments that no caller can talk out of an early return.
 */

import { evidenceCommandProblem } from './queue-backend.js';
import type { CloseEvidence } from './queue-backend.js';

/** Every branch a loop may write. */
export const LOOP_BRANCH_PREFIX = 'loop/';

/** The branch a loop's own worktree sits on. */
export function loopBranch(loop: string): string {
  return `${LOOP_BRANCH_PREFIX}${loop}`;
}

/**
 * What separates a loop's name from the item its branch carries.
 *
 * NOT `/`, AND THIS IS THE WHOLE REASON THE CONSTANT EXISTS. A loop's worktree
 * sits on `loop/<name>`, which git stores as the FILE `refs/heads/loop/<name>`;
 * `loop/<name>/<id>` would need that same path to be a DIRECTORY, so git refuses
 * it outright:
 *
 *     fatal: cannot lock ref 'refs/heads/loop/fix/1430':
 *            'refs/heads/loop/fix' exists; cannot create
 *
 * The namespace a merge gate was written to accept was therefore unreachable for
 * as long as the loop had a worktree — which is always, because a run resolves
 * its worktree before it branches. Consumers improvised `loop/<name>-<id>`, and
 * every one of those branches was then refused at `loop merge`: pushed, proposed,
 * unlandable.
 *
 * `.` is chosen because a loop name CANNOT contain one (`LOOP_NAME_PATTERN` is
 * lowercase alphanumerics joined by `-`), so `loop/<name>.<id>` splits back to
 * exactly one loop. A `-` would not: `loop/fix-er-12` reads as loop `fix` with
 * item `er-12` and as loop `fix-er` with item `12`, and ownership that can be
 * read two ways is the cross-loop landing `isOwnLoopRef` exists to refuse.
 */
export const LOOP_ITEM_SEPARATOR = '.';

/**
 * The branch a consumer run puts one item's work on — named HERE rather than in
 * a prompt (allowed-pattern #14).
 *
 * The old scheme was a sentence in two markdown files telling the run to type
 * `loop/<name>/<id>`. Git refused that name, so each run invented its own
 * replacement, and the gate that had to recognise the result was written against
 * the sentence rather than against what git allowed. One function now answers it,
 * and `isOwnLoopRef` accepts precisely what this produces.
 */
export function loopItemBranch(loop: string, id: string): string {
  const name = loop.trim();
  const item = id.trim();
  if (name.length === 0) throw new Error('a loop branch needs a loop name');
  if (item.length === 0) throw new Error('a loop item branch needs an item id');
  if (/[\s~^:?*[\\]/.test(item) || item.includes('/') || item.includes('..')) {
    throw new Error(`'${id}' cannot be part of a branch name`);
  }
  return `${loopBranch(name)}${LOOP_ITEM_SEPARATOR}${item}`;
}

/**
 * Whether a branch name is inside the carve-out.
 *
 * The checks after the prefix are not paranoia about git — they are about what
 * a REF can be made to mean: `loop/../main` resolves outside the namespace,
 * `loop/` alone names nothing, and a ref carrying whitespace or a wildcard is
 * not a branch a loop authored.
 */
export function isLoopRef(ref: string): boolean {
  const value = ref.trim();
  if (!value.startsWith(LOOP_BRANCH_PREFIX)) return false;
  const rest = value.slice(LOOP_BRANCH_PREFIX.length);
  if (rest.length === 0) return false;
  if (rest.includes('..') || rest.includes('*') || /\s/.test(value)) return false;
  return true;
}

/**
 * Strip the decorations a caller may legitimately have written a ref with, so
 * the comparison is against the branch itself: `refs/heads/loop/fix` and
 * `loop/fix` are the same destination, and a leading `+` is only a force flag.
 */
export function normalizeRef(ref: string): string {
  return ref.trim().replace(/^\+/, '').replace(/^refs\/heads\//, '');
}

/**
 * The DESTINATION a push argument writes, and whether it deletes.
 *
 * A refspec is `<src>:<dst>`; when there is no colon, source and destination
 * are the same ref. An empty source (`:loop/fix`) is a DELETION — which is
 * inside the namespace but is not "pushing a branch", and deleting a branch a
 * PR may already point at is not something an unattended run should do.
 */
export interface PushTarget {
  /** The ref that will be written on the remote, normalized. */
  destination: string;
  /** The local ref being pushed, normalized. Empty for a deletion. */
  source: string;
  /** Whether the refspec deletes the destination. */
  deletes: boolean;
}

/** Read a push argument into its destination and source. */
export function parsePushTarget(ref: string): PushTarget {
  const value = ref.trim();
  const colon = value.indexOf(':');
  if (colon === -1) {
    const normalized = normalizeRef(value);
    return { destination: normalized, source: normalized, deletes: false };
  }
  const source = normalizeRef(value.slice(0, colon));
  const destination = normalizeRef(value.slice(colon + 1));
  return { destination, source, deletes: source.length === 0 };
}

/**
 * Trunk-shaped names a loop may NEVER write, whatever a store says it owns.
 *
 * THE BACKSTOP FOR THE OWNED-BRANCH PATH. Widening the carve-out to a branch the
 * loop recorded (`ownedBranch`) trusts that record — and a record is data, which
 * can be wrong (a corrupt line, a bad write, a future bug). If a store ever said
 * a loop owned `main`, nothing else here would stop the push. This does: a
 * destination that normalizes to a trunk name is refused even when it matches
 * `ownedBranch` exactly. It is the same instinct as `HEAD:main` in the refspec
 * check — the string may look owned and still be catastrophic.
 */
const PROTECTED_TRUNK_NAMES: readonly string[] = ['main', 'master', 'develop', 'trunk', 'HEAD'];

/** Whether a normalized ref is a trunk name a loop may never write. */
function isProtectedTrunk(normalized: string): boolean {
  return PROTECTED_TRUNK_NAMES.includes(normalized);
}

/**
 * Whether a destination is the specific non-loop branch this loop OWNS.
 *
 * OWNERSHIP IS PASSED IN, NEVER PARSED (C-2). A `feat/<ticket>` branch carries
 * no loop identity, so the caller looks it up in the ownership store
 * (`foreign-items.ts` `branch`) and hands the answer here. This stays pure: it
 * compares the destination to the one branch the loop said it is using, and
 * refuses a trunk name regardless — the record is trusted for "which feature
 * branch", never for "may I write main".
 */
function isOwnedBranch(destination: string, ownedBranch: string | null | undefined): boolean {
  if (ownedBranch === null || ownedBranch === undefined) return false;
  const owned = normalizeRef(ownedBranch);
  if (owned.length === 0 || isProtectedTrunk(owned)) return false;
  return destination === owned;
}

/**
 * Why this push is refused, or null when it is inside the carve-out.
 *
 * The DESTINATION decides. A source ref of `HEAD` pushing to `loop/fix` is
 * fine; a source of `loop/fix` pushing to `main` is the exact violation this
 * function exists for.
 *
 * `ownedBranch` WIDENS THE CARVE-OUT BY EXACTLY ONE BRANCH (FR-8, D3). A
 * consumer loop that publishes on `feat/<ticket>` passes the branch it recorded
 * owning; the destination is then allowed iff it IS that branch (and not a
 * trunk name). Omitted — every caller before this feature — the behaviour is
 * byte-for-byte the loop-namespace rule it always was. Deletions are refused
 * either way.
 */
export function pushRefusal(ref: string, ownedBranch?: string | null): string | null {
  const value = ref.trim();
  if (value.length === 0) {
    return 'push requires --branch <loop/...>';
  }
  const target = parsePushTarget(value);
  if (target.deletes) {
    return `a loop may not delete a remote branch ('${value}')`;
  }
  if (isLoopRef(target.destination)) {
    return null;
  }
  if (isOwnedBranch(target.destination, ownedBranch)) {
    return null;
  }
  const ownedNote =
    ownedBranch === null || ownedBranch === undefined ? '' : ` (nor the '${ownedBranch}' it owns)`;
  return `a loop may push only '${LOOP_BRANCH_PREFIX}*' branches — '${target.destination}' is outside the carve-out${ownedNote}`;
}

/**
 * Why this pull request is refused, or null when it is allowed.
 *
 * Only the HEAD is constrained: the whole point of the PR is to propose a
 * `loop/*` branch INTO a protected branch, so constraining the base as well
 * would refuse the thing the carve-out exists to permit. The base is still
 * checked for shape, because a base carrying a refspec colon is not a base.
 */
export function prRefusal(head: string, base: string, ownedBranch?: string | null): string | null {
  const normalizedHead = normalizeRef(head);
  if (normalizedHead.length === 0) {
    return 'opening a PR requires --branch <loop/...>';
  }
  if (!isLoopRef(normalizedHead) && !isOwnedBranch(normalizedHead, ownedBranch)) {
    const ownedNote =
      ownedBranch === null || ownedBranch === undefined ? '' : ` (nor the '${ownedBranch}' it owns)`;
    return `a loop may open a PR only from a '${LOOP_BRANCH_PREFIX}*' branch — '${normalizedHead}' is outside the carve-out${ownedNote}`;
  }
  const normalizedBase = normalizeRef(base);
  if (normalizedBase.length === 0 || normalizedBase.includes(':') || /\s/.test(normalizedBase)) {
    return `malformed --base '${base}'`;
  }
  return null;
}

// ── merging: the same shape, one namespace narrower ──────

/**
 * Whether `ref` is inside THIS loop's own branch namespace.
 *
 * NARROWER THAN `isLoopRef` ON PURPOSE. Pushing is bounded by the carve-out
 * (`loop/*`) because every loop's branch is equally not-`main`. LANDING is
 * bounded by ownership: `loop/other/12` is another loop's work, and a loop that
 * may merge it can land a fix it never wrote, never verified and cannot report
 * on. So the namespace is `loop/<name>` and anything under it, and nothing else.
 *
 * The SEPARATOR in the prefix test is load-bearing: without it `loop/fixer.3`
 * reads as belonging to loop `fix`.
 *
 * BOTH SEPARATORS ARE ACCEPTED. `loop/<name>.<id>` is what a run can actually
 * create beside its own worktree branch and is what `loopItemBranch` produces;
 * `loop/<name>/<id>` stays accepted because it is reachable whenever the loop has
 * no worktree branch in the way, and a ref that git DID let a run create is not
 * one this gate should discover it cannot land.
 */
export function isOwnLoopRef(ref: string, loop: string): boolean {
  const name = loop.trim();
  if (name.length === 0) return false;
  const value = normalizeRef(ref);
  if (!isLoopRef(value)) return false;
  const own = loopBranch(name);
  if (value === own) return true;
  for (const separator of ['/', LOOP_ITEM_SEPARATOR]) {
    const prefix = `${own}${separator}`;
    // The item half must exist: `loop/fix.` names no item, and treating it as
    // owned would let a malformed ref through on the strength of its prefix.
    if (value.startsWith(prefix) && value.length > prefix.length) return true;
  }
  return false;
}

/**
 * Why this pull request may not be merged by `loop`, or null when it may.
 *
 * THE HEAD IS THE WHOLE QUESTION — as with a push, what matters is where the
 * work came from, not where it is going: the base is the repo's business and
 * `gh` resolves it from the pull request itself, so there is nothing here for a
 * caller to point somewhere else.
 *
 * A REFSPEC IS REFUSED OUTRIGHT rather than parsed. `pushRefusal` has to read
 * `<src>:<dst>` because that is a legal push argument; a merge takes a BRANCH,
 * and a colon in one means the caller is describing something this verb does not
 * do. Refusing runs picking a half of it and guessing.
 */
export function mergeRefusal(head: string, loop: string, ownedBranch?: string | null): string | null {
  const name = loop.trim();
  if (name.length === 0) {
    return 'merging requires --loop <name>';
  }
  const value = head.trim();
  if (value.length === 0) {
    return `merging requires --branch <${loopBranch(name)}${LOOP_ITEM_SEPARATOR}<id>>`;
  }
  if (value.includes(':')) {
    return `a merge takes a branch, not a refspec — '${head}'`;
  }
  const normalized = normalizeRef(value);
  // TWO WAYS TO OWN A BRANCH, and both are checked here so `loop merge` has ONE
  // ownership answer (allowed-pattern #14). The historical way is the NAME —
  // `loop/<name>.<id>` parses back to this loop. The new way (D3) is the STORE:
  // a `feat/<ticket>` branch carries no loop identity, so the caller looks up
  // the branch THIS loop recorded owning for THIS item and passes it as
  // `ownedBranch`. A merge is refused unless the head is owned one of those two
  // ways — another loop's `feat/*`, or a person's, matches neither and stops
  // here exactly as another loop's `loop/*` always has.
  if (!isOwnLoopRef(normalized, name) && !isOwnedBranch(normalized, ownedBranch)) {
    // The hint names the form that WORKS. A run reaching this line has already
    // pushed a branch and opened a pull request from it; telling it only that
    // the name is wrong leaves it to guess again, and the guess it made last
    // time (`loop/<name>-<id>`) is the one that lands here.
    const ownedHint =
      ownedBranch === null || ownedBranch === undefined
        ? ''
        : ` or the '${ownedBranch}' it owns`;
    return `a loop may merge only its own '${loopBranch(name)}' branches${ownedHint} — '${normalized}' is outside them (name an item branch '${loopBranch(name)}${LOOP_ITEM_SEPARATOR}<id>')`;
  }
  return null;
}

/**
 * One kind of proof a merge requires, and how a recorded command is recognized
 * as being that kind.
 *
 * MATCHED ON THE COMMAND STRING, because that is the only thing captured: the
 * evidence is `{command, exitCode}` records, and a category derived from
 * anything else would be a claim the run makes about its own work — which is
 * the one thing this gate exists not to accept (forbidden-pattern #7).
 *
 * The patterns are deliberately generous about HOW a project spells each
 * command (`npm run typecheck`, `npx tsc --noEmit`, `pnpm build`, `jest`,
 * `pytest`) and strict about the fact that all three were run at all. A command
 * that satisfies two categories at once satisfies both — it really did run both.
 */
export interface MergeEvidenceCategory {
  /** Stable key, for callers that report which proof was missing. */
  key: 'typecheck' | 'build' | 'test';
  /** How the refusal names it. */
  label: string;
  /** How a recorded command is recognized as this kind of proof. */
  pattern: RegExp;
}

/**
 * The three proofs a merge is gated on: the code still typechecks, it still
 * builds, and the tests that cover the change ran.
 *
 * TARGETED TESTS, NOT THE ROOT SUITE — the full suite is slow and currently
 * flaky enough that unrelated failures would block every landing, so what is
 * required is that tests RAN and passed, not which ones. Judging "targeted
 * enough" is not machine-checkable, and a gate that pretends to check something
 * it cannot is worse than one whose bar is written down.
 */
export const MERGE_EVIDENCE_CATEGORIES: readonly MergeEvidenceCategory[] = [
  {
    key: 'typecheck',
    label: 'a typecheck',
    pattern: /type[-\s]?check|(?:^|[\s/])tsc(?:$|\s)|--noEmit|\bmypy\b|\bpyright\b/i,
  },
  { key: 'build', label: 'a build', pattern: /\bbuild\b/i },
  {
    key: 'test',
    label: 'the targeted tests',
    pattern: /\btests?\b|\bjest\b|\bvitest\b|\bpytest\b|\bplaywright\b|\bmocha\b/i,
  },
];

/** Which categories these recorded commands cover, in declaration order. */
export function mergeEvidenceCoverage(
  commands: readonly { command: string }[],
): MergeEvidenceCategory['key'][] {
  return MERGE_EVIDENCE_CATEGORIES.filter((category) =>
    commands.some((entry) => category.pattern.test(entry.command)),
  ).map((category) => category.key);
}

/**
 * Why this evidence does not support a merge, or null when it does.
 *
 * THE SAME BAR `close` ALREADY ENFORCES, RAISED BY EXACTLY ONE NOTCH. A `done`
 * close requires at least one captured `{command, exitCode}` record, every one
 * of them exited 0, and refuses prose (`validateCloseEvidence`); the record
 * shape is checked by that same function's helper, so there is one definition of
 * "a well-formed evidence record" and this cannot drift from it. What a merge
 * adds is WHICH proofs must be among them, because a close leaves the work in a
 * pull request a person can still read, and a merge does not.
 *
 * A refusal always shows what WAS recorded. The run's next move is to run the
 * missing command and record it, and a refusal that only says "not enough"
 * teaches it to argue instead.
 */
export function mergeEvidenceRefusal(evidence: CloseEvidence | undefined): string | null {
  const commands = evidence?.commands as unknown;
  if (commands === undefined) {
    return "a merge requires machine-checkable evidence — a typecheck, a build and the targeted tests, each with the exit code it really returned, never prose alone";
  }
  if (!Array.isArray(commands)) {
    return "evidence 'commands' must be an array of {command, exitCode} records";
  }
  if (commands.length === 0) {
    return "a merge requires machine-checkable evidence — a typecheck, a build and the targeted tests, each with the exit code it really returned, never prose alone";
  }
  for (let index = 0; index < commands.length; index += 1) {
    const problem = evidenceCommandProblem(commands[index], index);
    if (problem !== null) return problem;
  }

  const records = commands as { command: string; exitCode: number }[];
  const failed = records.find((entry) => entry.exitCode !== 0);
  if (failed !== undefined) {
    return `evidence command '${failed.command}' exited ${failed.exitCode} — a merge requires every recorded command to have exited 0`;
  }

  const covered = new Set(mergeEvidenceCoverage(records));
  const missing = MERGE_EVIDENCE_CATEGORIES.filter((category) => !covered.has(category.key));
  if (missing.length > 0) {
    return `merge evidence is missing ${missing.map((category) => category.label).join(' and ')} — recorded: ${records
      .map((entry) => `'${entry.command}'`)
      .join(', ')}`;
  }
  return null;
}
