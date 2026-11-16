/**
 * DID THE WORK A PIECE OF KNOWLEDGE DESCRIBES REACH THE DEFAULT BRANCH?
 *
 * The question is asked of the CODE repository, not of the Workspace: the
 * Workspace holds `projects/<slug>/…` knowledge, and whether that knowledge is
 * true is decided by what is on the default branch of the checkout it talks
 * about. `projects.local.json` is what connects the two, and it is the only
 * thing that knows where a project lives on THIS computer.
 *
 * ── PROMOTION: FOUR CHECKS, IN ORDER (discovery `workspace_knowledge_draft_solid`, FR-4) ──
 *
 * `checkPromotion` takes the drafts of one project — items whose provenance
 * says they were learned on a branch that has not merged — and asks, after ONE
 * bounded `git fetch` of the code repository:
 *
 *   a. ancestry   the stamped commit is an ancestor of the default branch on
 *                 the remote → solid (a normal merge, a fast-forward);
 *   b. hashes     every stamped file's digest equals that file at the default
 *                 branch → solid. This is what survives a squash or a rebase,
 *                 which mint new commits. A file missing on the default branch
 *                 never matches, and an item with no hashes cannot be judged
 *                 here (many anchors are directories);
 *   c. host       the code host says the branch's PR merged → solid;
 *   d. gone       the host says the PR closed unmerged, or no branch anywhere
 *                 still holds the stamped commit → abandoned.
 *
 * A merge (a or c) whose files have changed on the default branch since is
 * promoted as **stale** (FR-5): merged, but re-learned before it is trusted.
 * Everything else is **unknown**, and unknown WRITES NOTHING — offline, a fetch
 * that failed, a default branch that cannot be named, a branch that may simply
 * not be pushed yet. Nothing is promoted or abandoned on a guess.
 *
 * Every answer is written through `appendKnowledgeStatus`, the one writer. Its
 * timestamp is the EVIDENCE's time — the committer date of the default-branch
 * commit the check ran against — so two machines that prove the same thing at
 * the same tip write the same line, and the union merge keeps one.
 *
 * The run-token check this module used to carry (`tokenLanded`, a `Flow-Run:`
 * trailer grepped out of commit messages) is retired with the hold gate: it
 * could not see a merge Flow did not make, and a squash message edited by hand
 * lost it for ever.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseFlowConfig } from '../state/flowconfig-parser.js';
import { hashFileAtRevision, type ProvenanceHash } from '../state/knowledge-provenance.js';
import { appendKnowledgeStatus } from '../state/knowledge-status-log.js';
import { hashFileContent } from '../blueprint/store.js';
import type { WorkspaceGit } from './workspace-model.js';

/** Branch names tried, in order, when the repository does not say. */
const FALLBACK_DEFAULTS = ['main', 'master'] as const;

/** The remote promotion fetches from and judges against. */
const PROMOTION_REMOTE = 'origin';

/** How long one host question (`gh pr list`) may take. */
export const HOST_TIMEOUT_MS = 20_000;

function run(git: WorkspaceGit, args: string[], cwd: string, options?: { network?: boolean }): string | null {
  try {
    return options === undefined ? git(args, cwd) : git(args, cwd, options);
  } catch {
    return null;
  }
}

/**
 * The ref to search: the remote's own default branch where one is recorded,
 * then a local `main`/`master`.
 *
 * `origin/HEAD` FIRST, because it is the only one of these that is a fact
 * rather than a convention — it is what the remote said its default was when
 * the repository was cloned. Guessing `main` at a shop whose trunk is
 * `develop` would answer "not landed" about every document for ever.
 *
 * `baseBranch` — the project's Base branch setting (`branch:` in
 * `flow/.flowconfig`) — outranks all of them when a caller has it (FR-14 of
 * `workspace_knowledge_draft_solid`): a person said it, which beats both the
 * remote's record and the convention. A setting that names no ref here falls
 * through to the ladder rather than answering null.
 */
export function defaultBranchRef(git: WorkspaceGit, repo: string, baseBranch?: string | null): string | null {
  const base = typeof baseBranch === 'string' ? baseBranch.trim() : '';
  // A name that cannot be a branch is never spliced into a ref.
  if (base !== '' && !base.startsWith('-') && !/[\s~^:?*[\\]|\.\.|@\{/.test(base)) {
    for (const ref of [`refs/remotes/origin/${base}`, `refs/heads/${base}`]) {
      if (run(git, ['rev-parse', '--verify', '--quiet', ref], repo) !== null) return ref;
    }
  }
  const head = run(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo);
  if (head !== null && head.trim() !== '') {
    const ref = head.trim();
    // `refs/remotes/origin/main` — usable as a rev directly.
    if (run(git, ['rev-parse', '--verify', '--quiet', ref], repo) !== null) return ref;
  }
  for (const name of FALLBACK_DEFAULTS) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      if (run(git, ['rev-parse', '--verify', '--quiet', ref], repo) !== null) return ref;
    }
  }
  return null;
}

/**
 * Where a Workspace project's code lives on this computer, or null.
 *
 * Two lookups because the two files disagree about what names a project: the
 * Workspace names it by SLUG (the folder its knowledge sits in) and
 * `projects.local.json` keys by ID (the repository address). The workspace
 * file is what maps one to the other, and it is per-Workspace while the local
 * map is per-computer — which is the whole reason the local map is not shared.
 */
export function projectCheckout(
  localProjects: Readonly<Record<string, string>>,
  projects: readonly { slug: string; id: string }[],
  slug: string
): string | null {
  const project = projects.find((entry) => entry.slug === slug);
  if (project === undefined) return null;
  const path = localProjects[project.id];
  return path === undefined || path === '' ? null : path;
}

// ─── Promotion ──────────────────────────────────────────────────────────────

/** What kind of thing a draft is. Documents are discovery and plan files. */
export type DraftKind = 'learning' | 'part-learning' | 'note' | 'document';

/** One draft to check: its status-log id and the provenance it was stamped with. */
export interface DraftItem {
  /** The status-log item id (`knowledgeItemId`, or `documentItemId` for a document). */
  item: string;
  kind: DraftKind;
  /** The branch it was learned on, when known. */
  branch: string | null;
  /** The commit it was learned at; null when its record has not reached this machine. */
  commit: string | null;
  /** The cited files' digests at stamping time. Empty for a document. */
  hashes: readonly ProvenanceHash[];
  /** Documents only: the path inside `flow/` (`discovery/…`, `plans/…`). */
  document?: string;
}

/** What the code host says about a branch's pull request. */
export interface HostPrAnswer {
  /** `merged` beats `open` beats `closed`; `none` = the host knows no PR for the branch. */
  state: 'merged' | 'open' | 'closed' | 'none';
  /** When it merged or closed, ISO-8601, when the host says. */
  at: string | null;
}

/** The code host, injected. A null answer means the host could not be asked. */
export interface HostPrState {
  prState(branch: string): HostPrAnswer | null;
}

export type PromotionOutcome = 'solid' | 'stale' | 'abandoned' | 'unknown';

/** Short codes; `reason` in the status log. */
export type PromotionReason =
  | 'ancestor'
  | 'hashes-match'
  | 'pr-merged'
  | 'pr-closed'
  | 'branch-gone'
  | 'not-yet'
  | 'no-record'
  | 'fetch-failed'
  | 'no-default-branch';

export interface PromotionResult {
  item: string;
  kind: DraftKind;
  outcome: PromotionOutcome;
  reason: PromotionReason;
  branch: string | null;
  document?: string;
  /** A status line was written (never for `unknown`). */
  written: boolean;
}

export interface PromotionOptions {
  /** Where the status log lives. Default: `<checkout>/flow`. */
  flowDir?: string;
  /** The project's Base branch setting. Default: read from `<checkout>/flow/.flowconfig`. */
  baseBranch?: string | null;
  /** Hash a file at a revision. Default: `hashFileAtRevision` (the one digest). */
  hashAt?: (checkout: string, ref: string, path: string) => string | null;
}

const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function baseBranchOf(checkout: string): string | null {
  try {
    const branch = parseFlowConfig(join(checkout, 'flow')).branch;
    return typeof branch === 'string' && branch.trim() !== '' ? branch.trim() : null;
  } catch {
    return null;
  }
}

/** Does a commit object exist here? */
function hasCommit(git: WorkspaceGit, checkout: string, commit: string): boolean {
  return run(git, ['cat-file', '-e', `${commit}^{commit}`], checkout) !== null;
}

/**
 * Promote what can be proved, for ONE project. See the module header for the
 * four checks. Writes one status line per decided item; returns every result,
 * `unknown` included.
 */
export function checkPromotion(
  git: WorkspaceGit,
  checkout: string,
  drafts: readonly DraftItem[],
  host: HostPrState | null,
  options: PromotionOptions = {}
): PromotionResult[] {
  const flowDir = options.flowDir ?? join(checkout, 'flow');
  const unknownAll = (reason: PromotionReason): PromotionResult[] =>
    drafts.map((draft) => resultOf(draft, 'unknown', reason, false));
  if (drafts.length === 0) return [];

  // ONE bounded fetch per call (NFR-4) — the network timeout, no terminal
  // prompt. A failure is "could not ask", never "not merged".
  if (!existsSync(checkout) || run(git, ['fetch', '--quiet', '--prune', PROMOTION_REMOTE], checkout, { network: true }) === null) {
    return unknownAll('fetch-failed');
  }
  const ref = defaultBranchRef(git, checkout, options.baseBranch === undefined ? baseBranchOf(checkout) : options.baseBranch);
  const tip = ref === null ? null : run(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], checkout)?.trim() ?? null;
  if (ref === null || tip === null || !COMMIT_RE.test(tip)) return unknownAll('no-default-branch');
  const evidenceTs = run(git, ['show', '-s', '--format=%cI', tip], checkout)?.trim() ?? '';
  if (Number.isNaN(Date.parse(evidenceTs))) return unknownAll('no-default-branch');

  // `git show` results cached per (default-branch commit, path) for this call (NFR-4).
  const hashAt = options.hashAt ?? hashFileAtRevision;
  const hashCache = new Map<string, string | null>();
  const hashAtTip = (path: string): string | null => {
    if (!hashCache.has(path)) hashCache.set(path, hashAt(checkout, tip, path));
    return hashCache.get(path) ?? null;
  };
  /** True / false over every stamped file; null when there are none to compare. */
  const hashesMatch = (hashes: readonly ProvenanceHash[]): boolean | null => {
    if (hashes.length === 0) return null;
    return hashes.every((hash) => {
      const now = hashAtTip(hash.path);
      return now !== null && now === hash.contentHash;
    });
  };

  const hostCache = new Map<string, HostPrAnswer | null>();
  const askHost = (branch: string | null): HostPrAnswer | null => {
    if (host === null || branch === null) return null;
    if (!hostCache.has(branch)) {
      let answer: HostPrAnswer | null = null;
      try {
        answer = host.prState(branch);
      } catch {
        answer = null;
      }
      hostCache.set(branch, answer);
    }
    return hostCache.get(branch) ?? null;
  };

  const results: PromotionResult[] = [];
  for (const draft of drafts) {
    if (draft.commit === null || !COMMIT_RE.test(draft.commit)) {
      results.push(resultOf(draft, 'unknown', 'no-record', false));
      continue;
    }
    const known = hasCommit(git, checkout, draft.commit);
    const match = hashesMatch(draft.hashes);

    // a. ancestry
    if (known && run(git, ['merge-base', '--is-ancestor', draft.commit, tip], checkout) !== null) {
      results.push(write(draft, match === false ? 'stale' : 'solid', 'ancestor'));
      continue;
    }
    // b. every stamped file as it is on the default branch (squash- and rebase-safe)
    if (match === true) {
      results.push(write(draft, 'solid', 'hashes-match'));
      continue;
    }
    // c. the host says it merged
    const answer = askHost(draft.branch);
    if (answer?.state === 'merged') {
      results.push(write(draft, match === false ? 'stale' : 'solid', 'pr-merged'));
      continue;
    }
    // d. closed unmerged, or no branch anywhere still holds the commit
    if (answer?.state === 'closed') {
      results.push(write(draft, 'abandoned', 'pr-closed'));
      continue;
    }
    if (answer?.state !== 'open' && known && branchGone(git, checkout, draft)) {
      results.push(write(draft, 'abandoned', 'branch-gone'));
      continue;
    }
    // e. not yet — or not knowable from here
    results.push(resultOf(draft, 'unknown', 'not-yet', false));
  }
  return results;

  function write(draft: DraftItem, outcome: 'solid' | 'stale' | 'abandoned', reason: PromotionReason): PromotionResult {
    appendKnowledgeStatus(flowDir, {
      item: draft.item,
      status: outcome,
      branch: draft.branch,
      commit: tip,
      reason,
      ts: evidenceTs,
    });
    return resultOf(draft, outcome, reason, true);
  }
}

function resultOf(draft: DraftItem, outcome: PromotionOutcome, reason: PromotionReason, written: boolean): PromotionResult {
  return {
    item: draft.item,
    kind: draft.kind,
    outcome,
    reason,
    branch: draft.branch,
    ...(draft.document === undefined ? {} : { document: draft.document }),
    written,
  };
}

/**
 * Is the draft's branch gone with nothing left of it?
 *
 * "The remote has no branch of that name" alone would abandon every branch
 * nobody pushed yet, so the test is stricter: the stamped commit is HERE (this
 * machine once had it — from its own work or a fetch), and after the pruning
 * fetch no branch, local or on the remote, contains it any more. A commit this
 * machine never saw is not judged at all (the caller checks `known`).
 */
function branchGone(git: WorkspaceGit, checkout: string, draft: DraftItem): boolean {
  if (draft.commit === null) return false;
  if (draft.branch !== null) {
    for (const ref of [`refs/remotes/${PROMOTION_REMOTE}/${draft.branch}`, `refs/heads/${draft.branch}`]) {
      if (run(git, ['rev-parse', '--verify', '--quiet', ref], checkout) !== null) return false;
    }
  }
  const holders = run(
    git,
    ['for-each-ref', '--format=%(refname)', '--contains', draft.commit, 'refs/heads', `refs/remotes/${PROMOTION_REMOTE}`],
    checkout
  );
  // null = git could not say: never abandon on that.
  return holders !== null && holders.trim() === '';
}

/**
 * The status-log id of a discovery or plan document: the document's file name
 * and the commit it was stamped at, through the same digest and shape as
 * `knowledgeItemId` (`kind \0 scope \0 text \0 learnedAt`). The file name and
 * not the path, so an archived document keeps its id.
 */
export function documentItemId(fileName: string, commit: string): string {
  return hashFileContent(['document', fileName, '', commit].join('\u0000')).slice(0, 16);
}

// ─── The code host ──────────────────────────────────────────────────────────

/**
 * Read `gh pr list --json state,mergedAt,closedAt` output (validated against
 * gh 2.x: an array of `{ state: 'MERGED'|'OPEN'|'CLOSED', mergedAt: ISO|null,
 * closedAt: ISO|null }`; `[]` when the branch has no PR). Null for anything
 * else — an answer that cannot be read is no answer.
 */
export function parseGhPrList(stdout: string): HostPrAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const prs = parsed.filter((entry): entry is { state: string; mergedAt?: unknown; closedAt?: unknown } =>
    typeof entry === 'object' && entry !== null && typeof (entry as { state?: unknown }).state === 'string'
  );
  const iso = (value: unknown): string | null => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null);
  const merged = prs.find((pr) => pr.state.toUpperCase() === 'MERGED');
  if (merged !== undefined) return { state: 'merged', at: iso(merged.mergedAt) };
  if (prs.some((pr) => pr.state.toUpperCase() === 'OPEN')) return { state: 'open', at: null };
  const closed = prs.find((pr) => pr.state.toUpperCase() === 'CLOSED');
  if (closed !== undefined) return { state: 'closed', at: iso(closed.closedAt) };
  return prs.length === 0 && parsed.length === 0 ? { state: 'none', at: null } : null;
}

/** Runs a host CLI; returns stdout or null (missing, failed, timed out). */
export type HostRunner = (command: string, args: string[], cwd: string) => string | null;

/**
 * The code host for a checkout, asked through its own signed-in CLI — today
 * `gh` for a GitHub remote. Any other host, a missing CLI, or a remote that
 * cannot be read → null: promotion then relies on checks a and b, and nothing
 * is decided by the host's silence.
 */
export function hostForCheckout(git: WorkspaceGit, checkout: string, runHost: HostRunner): HostPrState | null {
  const url = run(git, ['config', '--get', `remote.${PROMOTION_REMOTE}.url`], checkout)?.trim() ?? '';
  if (!/(^|[@/])github\.com[:/]/i.test(url)) return null;
  return {
    prState(branch) {
      if (branch.startsWith('-')) return null;
      const out = runHost('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'state,mergedAt,closedAt', '--limit', '30'], checkout);
      return out === null ? null : parseGhPrList(out);
    },
  };
}

