/**
 * Hygiene gate for the permissions-suggest verb.
 *
 * This is the ONE code path that decides suggest vs skip (allowed-pattern
 * #14): every candidate mined from approval history passes through
 * `applyHygiene`, and every rejection carries a stable, human-readable
 * reason so the dry-run report is fully explainable. Pure and table-driven —
 * no I/O, no environment probing — so the rule sets are enumerable in tests
 * and the output is deterministic (input order preserved, stable reasons).
 *
 * Precedence (first match wins):
 *   1. existing deny rule matches        -> deny always wins
 *   2. mutating family                    -> never auto-allowed
 *   3. wildcard-equivalent runner         -> arbitrary code execution
 *   4. already auto-allowed by harness    -> suggesting it adds noise
 *   5. already covered by existing allow  -> suggesting it adds noise
 * Everything else passes through as a suggestion.
 */

import type { SkippedCandidate, SuggestCandidate } from './permissions-types.js';

/**
 * Families that mutate state and must never be auto-allowed, no matter how
 * often the user approved them: each approval deserved individual scrutiny.
 * Matched exactly against the candidate's family; the verb-suffix rule below
 * extends this set to any `<cli> install|publish|deploy|save|backfill`.
 */
export const MUTATING_FAMILIES: ReadonlySet<string> = new Set([
  'git push',
  'git commit',
  'git merge',
  'git rebase',
  'git reset',
  'rm',
  'mv',
]);

/**
 * Verb-suffix rule: a family whose SECOND token (or only token) is one of
 * these verbs is mutating regardless of the leading CLI — `npm install`,
 * `cargo publish`, `vercel deploy`, bare `deploy`, ...
 */
export const MUTATING_VERB_SUFFIXES: ReadonlySet<string> = new Set([
  'install',
  'publish',
  'deploy',
  'save',
  'backfill',
]);

/**
 * CLIs whose `i` shorthand means `install`. Only for these does a second
 * token `i` count as mutating (`npm i` yes, `docker i` is not a thing).
 */
export const INSTALL_SHORTHAND_CLIS: ReadonlySet<string> = new Set([
  'npm',
  'yarn',
  'pnpm',
]);

/**
 * Runners whose allow rule would be wildcard-equivalent: allowing
 * `Bash(npx *)` is allowing arbitrary code execution. Matched against the
 * candidate's first token, or the whole family for multi-token entries
 * (`bun run`).
 */
export const WILDCARD_RUNNERS: ReadonlySet<string> = new Set([
  'npx',
  'bunx',
  'eval',
  'xargs',
  'sudo',
  'sh',
  'bash',
  'zsh',
  'node',
  'bun run',
]);

/**
 * Families the harness already allows without prompting — suggesting them
 * would add settings noise for zero saved prompts. Matched against the
 * candidate's first token, or the whole family for multi-token entries.
 */
export const AUTO_ALLOWED: ReadonlySet<string> = new Set([
  'git status',
  'git log',
  'git diff',
  'ls',
  'cat',
  'pwd',
  'which',
]);

/** Result of the hygiene gate: survivors plus every rejection with reason. */
export interface HygieneResult {
  suggested: SuggestCandidate[];
  skipped: SkippedCandidate[];
}

/** First whitespace-delimited token of a family (`git status` -> `git`). */
function firstToken(family: string): string {
  return family.split(' ')[0];
}

/** True when `prefixTokens` is a leading token sequence of `tokens`. */
function isTokenPrefix(prefixTokens: string[], tokens: string[]): boolean {
  if (prefixTokens.length > tokens.length) {
    return false;
  }
  return prefixTokens.every((token, index) => token === tokens[index]);
}

/**
 * Extract the prefix of a `Bash(<prefix> *)`-shaped rule, or `null` when the
 * rule has another shape. Also accepts the `Bash(<prefix>:*)` variant Claude
 * Code understands — users hand-write that shape in settings, and refusing
 * to parse it would silently double-suggest already-covered families
 * (defensive-variant lesson from allowed-pattern #11).
 */
function bashRulePrefix(rule: string): string | null {
  const match = /^Bash\((.+)\)$/.exec(rule.trim());
  if (match === null) {
    return null;
  }
  const inner = match[1];
  if (inner.endsWith(' *')) {
    return inner.slice(0, -2).trim();
  }
  if (inner.endsWith(':*')) {
    return inner.slice(0, -2).trim();
  }
  return null;
}

/**
 * True when an existing rule covers the candidate: exact rule-string match,
 * or (Bash only) the rule's `Bash(<prefix> *)` prefix is a token-prefix of
 * the candidate family (`Bash(git *)` covers family `git status`).
 */
function ruleCoversCandidate(rule: string, candidate: SuggestCandidate): boolean {
  if (rule.trim() === candidate.rule) {
    return true;
  }
  if (candidate.tool !== 'Bash') {
    return false;
  }
  const prefix = bashRulePrefix(rule);
  if (prefix === null) {
    return false;
  }
  return isTokenPrefix(prefix.split(/\s+/), candidate.family.split(' '));
}

/**
 * True when a deny rule and the candidate overlap at all. Broader than allow
 * coverage on purpose: a deny `Bash(git push origin *)` also blocks part of
 * what a suggested `Bash(git push *)` would open, so token-prefix in EITHER
 * direction counts — deny always wins, ambiguity means skip.
 */
function denyRuleMatches(rule: string, candidate: SuggestCandidate): boolean {
  if (ruleCoversCandidate(rule, candidate)) {
    return true;
  }
  if (candidate.tool !== 'Bash') {
    return false;
  }
  const prefix = bashRulePrefix(rule);
  if (prefix === null) {
    return false;
  }
  return isTokenPrefix(candidate.family.split(' '), prefix.split(/\s+/));
}

/**
 * True when the family is mutating (exact table or verb-suffix rule).
 *
 * Exported so the guard-classifier reuses this exact predicate rather than
 * re-deriving membership from the Sets — one source of truth (allowed-pattern
 * #14): the bash dangerousness vocabulary lives here alone.
 */
export function isMutatingFamily(family: string): boolean {
  if (MUTATING_FAMILIES.has(family)) {
    return true;
  }
  const tokens = family.split(' ');
  const verb = tokens.length >= 2 ? tokens[1] : tokens[0];
  if (MUTATING_VERB_SUFFIXES.has(verb)) {
    return true;
  }
  return verb === 'i' && tokens.length >= 2 && INSTALL_SHORTHAND_CLIS.has(tokens[0]);
}

/**
 * True when the family's runner makes any allow rule wildcard-equivalent.
 * Exported for the guard-classifier — see `isMutatingFamily` (one source of
 * truth, allowed-pattern #14).
 */
export function isWildcardRunner(family: string): boolean {
  return WILDCARD_RUNNERS.has(family) || WILDCARD_RUNNERS.has(firstToken(family));
}

/**
 * True when the harness already allows this family without prompting.
 * Exported for the guard-classifier — see `isMutatingFamily` (one source of
 * truth, allowed-pattern #14).
 */
export function isAutoAllowed(family: string): boolean {
  return AUTO_ALLOWED.has(family) || AUTO_ALLOWED.has(firstToken(family));
}

/**
 * A single gate in precedence order: returns the stable skip reason, or
 * `null` to let the candidate fall through to the next gate.
 */
type HygieneGate = (
  candidate: SuggestCandidate,
  existingAllow: string[],
  existingDeny: string[],
) => string | null;

/** The gate table, in precedence order — deny first, coverage last. */
const HYGIENE_GATES: HygieneGate[] = [
  (candidate, _allow, deny) => {
    const match = deny.find((rule) => denyRuleMatches(rule, candidate));
    return match === undefined
      ? null
      : `matches existing deny rule ${match} — deny always wins`;
  },
  (candidate) =>
    candidate.tool === 'Bash' && isMutatingFamily(candidate.family)
      ? 'mutating operation — never auto-allowed'
      : null,
  (candidate) =>
    candidate.tool === 'Bash' && isWildcardRunner(candidate.family)
      ? 'wildcard-equivalent runner (arbitrary code execution)'
      : null,
  (candidate) =>
    candidate.tool === 'Bash' && isAutoAllowed(candidate.family)
      ? 'already auto-allowed by the harness'
      : null,
  (candidate, allow) => {
    const match = allow.find((rule) => ruleCoversCandidate(rule, candidate));
    return match === undefined ? null : `already covered by ${match}`;
  },
];

/**
 * Run every candidate through the gate table. Deterministic: input order is
 * preserved in both outputs, and each skip reason is a stable string derived
 * only from the inputs.
 */
export function applyHygiene(
  candidates: SuggestCandidate[],
  existingAllow: string[],
  existingDeny: string[],
): HygieneResult {
  const suggested: SuggestCandidate[] = [];
  const skipped: SkippedCandidate[] = [];

  for (const candidate of candidates) {
    let reason: string | null = null;
    for (const gate of HYGIENE_GATES) {
      reason = gate(candidate, existingAllow, existingDeny);
      if (reason !== null) {
        break;
      }
    }
    if (reason === null) {
      suggested.push(candidate);
    } else {
      skipped.push({ candidate: candidate.rule, reason });
    }
  }

  return { suggested, skipped };
}
