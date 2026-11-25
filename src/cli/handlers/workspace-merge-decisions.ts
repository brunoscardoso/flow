/**
 * THE SHARED MERGE-DECISIONS RECORD — the one writer and the readers of
 * `<workspace>/merge-decisions.jsonl` (agent-decided conflicts, Phase 1).
 *
 * When a person agrees or disagrees with how a conflict was settled, the
 * decision and the reason are kept here, so every machine of the Workspace —
 * and the agent that settles the next conflict — can read what the team
 * already decided and why.
 *
 * ONE WRITER (forbidden-pattern #18): `planflow-ai workspace merge-decision
 * record | remove`, through `recordMergeDecision` below. Nothing composes a
 * line of this file by hand, and both line types leave through one append.
 *
 * The store is APPEND-ONLY, one line per fact, merged across machines by union
 * (`*.jsonl merge=union`). Two line types:
 *
 *   { type: 'decision', id, kind, project, path, take, summary, reason, outcome, author, ts }
 *   { type: 'removed',  id, author, ts, reason? }
 *
 * CONVERGENCE. `id` is the first 16 hex of SHA-256 over
 * `kind \0 project \0 path \0 take \0 summary \0 reason \0 outcome` — never the
 * time and never the author, so two machines recording the same decision write
 * the same id. Keys are written in one fixed order. The fold is ORDER-FREE:
 * the union merge writes "ours first, then theirs", so a removal that arrives
 * before the line it names still removes it, and any permutation of the same
 * lines folds to the same answer.
 *
 * A removed decision stays removed: recording the very same words again does
 * not bring it back (the fold cannot tell "again" from "before" without
 * trusting line order). Different words are a different decision.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashFileContent } from '../blueprint/store.js';
import {
  WorkspaceRefusal,
  defaultWorkspaceGit,
  workspaceStatus,
  type StatusListResult,
  type StatusTargetResult,
  type WorkspaceContext,
  type WorkspaceDeps,
  type WorkspaceSummary,
} from './workspace-model.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const MERGE_DECISIONS_FILENAME = 'merge-decisions.jsonl';

/** The conflict kinds a decision can be about. */
export const MERGE_DECISION_KINDS = [
  'decision',
  'same-feature',
  'overlapping-anchors',
  'same-discovery',
  'conflict',
  'add-add',
  'modify-delete',
] as const;
export type MergeDecisionKind = (typeof MERGE_DECISION_KINDS)[number];

/** What the path held afterwards. */
export const MERGE_DECISION_TAKES = ['ours', 'theirs', 'merged', 'file', 'both'] as const;
export type MergeDecisionTake = (typeof MERGE_DECISION_TAKES)[number];

export const MERGE_DECISION_OUTCOMES = ['agreed', 'disagreed'] as const;
export type MergeDecisionOutcome = (typeof MERGE_DECISION_OUTCOMES)[number];

/** A summary or a reason is one line a reader takes in at a glance. */
const LINE_MAX_LENGTH = 300;

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface MergeDecisionEntry {
  type: 'decision';
  id: string;
  kind: MergeDecisionKind;
  project: string;
  path: string;
  take: MergeDecisionTake;
  summary: string;
  reason: string;
  outcome: MergeDecisionOutcome;
  author: string | null;
  ts: string;
}

export interface MergeDecisionRemoval {
  type: 'removed';
  id: string;
  author: string | null;
  ts: string;
  reason?: string;
}

export interface MergeDecisionsRead {
  /** Live entries (not removed), deduplicated by id, oldest first. */
  entries: MergeDecisionEntry[];
  /** The ids a removal line names, whether or not their entry is present. */
  removed: Set<string>;
  /** Lines that could not be read — reported, never fatal. */
  unreadable: number;
}

export interface RecordMergeDecisionOptions extends WorkspaceContext {
  /** The repo the caller stands in. Defaults to the working directory. */
  target?: string;
  workspace?: string;
  action: 'record' | 'remove';
  // record
  kind?: string;
  project?: string;
  path?: string;
  take?: string;
  summary?: string;
  /** record: why. remove: why it is withdrawn (optional). */
  reason?: string;
  outcome?: string;
  // remove
  id?: string;
  /** When the line is written. Defaults to now. */
  ts?: string;
}

export interface RecordMergeDecisionResult {
  action: 'merge-decision';
  op: 'record' | 'remove';
  workspace: WorkspaceSummary;
  /** The decision recorded, or the one removed. */
  decision: MergeDecisionEntry | null;
  id: string;
  /** False when nothing was appended: the same line was already there. */
  recorded: boolean;
  /** True when the id was already removed, so a record changed nothing. */
  removed: boolean;
  decisionsPath: string;
}

export interface ListMergeDecisionsOptions extends WorkspaceContext {
  target?: string;
  workspace?: string;
  project?: string;
  kind?: string;
}

export interface MergeDecisionsListResult {
  action: 'merge-decision';
  op: 'list';
  workspace: WorkspaceSummary;
  project: string | null;
  kind: string | null;
  decisions: MergeDecisionEntry[];
  unreadable: number;
}

// ─── Ids and lines ──────────────────────────────────────────────────────────

function isOneOf<T extends string>(vocabulary: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (vocabulary as readonly string[]).includes(value);
}

/** Collapse to one clean line. */
function oneLine(value: string | undefined): string {
  const collapsed = (value ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length > LINE_MAX_LENGTH ? `${collapsed.slice(0, LINE_MAX_LENGTH - 1)}…` : collapsed;
}

/** The stable id of one decision. Time and author are NOT in it. */
export function mergeDecisionId(input: {
  kind: string;
  project: string;
  path: string;
  take: string;
  summary: string;
  reason: string;
  outcome: string;
}): string {
  const text = [input.kind, input.project, input.path, input.take, input.summary, input.reason, input.outcome].join('\u0000');
  return hashFileContent(text).slice(0, 16);
}

/** One decision line, keys in one fixed order. */
function decisionLine(entry: MergeDecisionEntry): string {
  return JSON.stringify({
    type: 'decision',
    id: entry.id,
    kind: entry.kind,
    project: entry.project,
    path: entry.path,
    take: entry.take,
    summary: entry.summary,
    reason: entry.reason,
    outcome: entry.outcome,
    author: entry.author,
    ts: entry.ts,
  });
}

function removalLine(removal: MergeDecisionRemoval): string {
  return JSON.stringify({
    type: 'removed',
    id: removal.id,
    author: removal.author,
    ts: removal.ts,
    ...(removal.reason === undefined ? {} : { reason: removal.reason }),
  });
}

// ─── The store ──────────────────────────────────────────────────────────────

export function mergeDecisionsPath(workspacePath: string): string {
  return join(workspacePath, MERGE_DECISIONS_FILENAME);
}

function entryOf(row: Record<string, unknown>): MergeDecisionEntry | null {
  if (!isOneOf(MERGE_DECISION_KINDS, row.kind) || !isOneOf(MERGE_DECISION_TAKES, row.take) || !isOneOf(MERGE_DECISION_OUTCOMES, row.outcome)) {
    return null;
  }
  if (typeof row.id !== 'string' || typeof row.project !== 'string' || typeof row.path !== 'string') return null;
  if (typeof row.summary !== 'string' || typeof row.ts !== 'string') return null;
  return {
    type: 'decision',
    id: row.id,
    kind: row.kind,
    project: row.project,
    path: row.path,
    take: row.take,
    summary: row.summary,
    reason: typeof row.reason === 'string' ? row.reason : '',
    outcome: row.outcome,
    author: typeof row.author === 'string' ? row.author : null,
    ts: row.ts,
  };
}

/** Of two lines for one id, the earlier time wins; a tie breaks on the bytes. */
function earlier(a: MergeDecisionEntry, b: MergeDecisionEntry): MergeDecisionEntry {
  if (a.ts !== b.ts) return a.ts < b.ts ? a : b;
  return decisionLine(a) <= decisionLine(b) ? a : b;
}

/**
 * The fold, over lines already read. Order-free: a decision is live unless some
 * removal names its id, wherever the removal sits. Fail-soft per line.
 */
export function foldMergeDecisions(lines: readonly string[]): MergeDecisionsRead {
  const byId = new Map<string, MergeDecisionEntry>();
  const removed = new Set<string>();
  let unreadable = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      unreadable += 1;
      continue;
    }
    const row = parsed as Record<string, unknown>;
    if (row.type === 'removed' && typeof row.id === 'string') {
      removed.add(row.id);
      continue;
    }
    const entry = row.type === 'decision' ? entryOf(row) : null;
    if (entry === null) {
      unreadable += 1;
      continue;
    }
    const known = byId.get(entry.id);
    byId.set(entry.id, known === undefined ? entry : earlier(known, entry));
  }
  const entries = [...byId.values()]
    .filter((entry) => !removed.has(entry.id))
    .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? -1 : 1) : a.ts < b.ts ? -1 : 1));
  return { entries, removed, unreadable };
}

/** Every live decision of a Workspace. A missing file is none. */
export function readMergeDecisions(workspacePath: string): MergeDecisionsRead {
  let raw: string;
  try {
    raw = readFileSync(mergeDecisionsPath(workspacePath), 'utf-8');
  } catch {
    return { entries: [], removed: new Set(), unreadable: 0 };
  }
  return foldMergeDecisions(raw.split('\n'));
}

/**
 * The reasons the team gave for one kind of conflict in one project, newest
 * first — context for the agent that settles the next one.
 */
export function reasonsFor(entries: readonly MergeDecisionEntry[], scope: { kind: string; project: string }): MergeDecisionEntry[] {
  return entries
    .filter((entry) => entry.kind === scope.kind && entry.project === scope.project && entry.reason !== '')
    .sort((a, b) => (a.ts === b.ts ? (a.id < b.id ? 1 : -1) : a.ts < b.ts ? 1 : -1));
}

// ─── Resolution ─────────────────────────────────────────────────────────────

function resolveWorkspace(options: { target?: string; workspace?: string } & WorkspaceContext): StatusTargetResult {
  if (options.target === undefined && options.workspace !== undefined) {
    // Named by slug, with no repository: the app's sync engine asks from its own
    // folder (`--workspace <slug>`, no --target), which is in no Workspace. The
    // record is the Workspace's, so the slug alone answers it — every project
    // of the Workspace is a valid project here. An unknown slug is refused by
    // workspaceStatus itself.
    const listed = workspaceStatus({
      ...(options.flowFolder === undefined ? {} : { flowFolder: options.flowFolder }),
      ...(options.deps === undefined ? {} : { deps: options.deps }),
      workspace: options.workspace,
    }) as StatusListResult;
    const chosen = listed.workspaces[0];
    if (chosen === undefined) {
      throw new WorkspaceRefusal('no-workspace', `there is no Workspace ${options.workspace} on this machine`, { workspace: options.workspace });
    }
    const { projects, default: _isDefault, ...summary } = chosen;
    return {
      action: 'status',
      flowFolder: listed.flowFolder,
      target: summary.path,
      workspace: summary,
      project: null,
      linked: false,
      via: null,
      siblings: projects,
      alsoIn: [],
    };
  }
  const target = options.target ?? process.cwd();
  const status = workspaceStatus({
    ...(options.flowFolder === undefined ? {} : { flowFolder: options.flowFolder }),
    ...(options.deps === undefined ? {} : { deps: options.deps }),
    target,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
  if (!('target' in status) || status.workspace === null || status.project === null) {
    throw new WorkspaceRefusal('no-workspace', 'this repository is in no Workspace, so there is no shared record of merge decisions', { target });
  }
  return status;
}

function projectSlugs(status: StatusTargetResult): string[] {
  const own = status.project === null ? [] : [status.project];
  return [...own, ...status.siblings].map((project) => project.slug).sort();
}

function gitAuthor(git: WorkspaceDeps['git'], cwd: string): string | null {
  try {
    const name = git(['config', '--get', 'user.name'], cwd).trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

function vocabularyRefusal(
  reason: 'invalid-decision-kind' | 'invalid-decision-take' | 'invalid-decision-outcome',
  flag: string,
  value: string | undefined,
  vocabulary: readonly string[],
): WorkspaceRefusal {
  return new WorkspaceRefusal(reason, `--${flag} must be one of ${vocabulary.join(', ')}`, { flag, value: value ?? null, valid: [...vocabulary] });
}

// ─── The one writer ─────────────────────────────────────────────────────────

/** The ONE append of this file. Both line types go through it. */
function appendLine(workspacePath: string, line: string): void {
  mkdirSync(workspacePath, { recursive: true });
  appendFileSync(mergeDecisionsPath(workspacePath), `${line}\n`, 'utf-8');
}

/**
 * THE ONE WRITER of `merge-decisions.jsonl`. Every refusal is decided before
 * anything is written; the payload carries the valid vocabulary
 * (allowed-pattern #21).
 */
export function recordMergeDecision(options: RecordMergeDecisionOptions): RecordMergeDecisionResult {
  const status = resolveWorkspace(options);
  const workspace = status.workspace as WorkspaceSummary;
  const deps = { git: defaultWorkspaceGit, now: () => new Date(), ...options.deps };
  const decisionsPath = mergeDecisionsPath(workspace.path);
  const read = readMergeDecisions(workspace.path);
  const author = gitAuthor(deps.git, status.target);
  const ts = options.ts ?? deps.now().toISOString();

  if (options.action === 'remove') {
    const id = (options.id ?? '').trim();
    const known = read.entries.find((entry) => entry.id === id);
    const alreadyRemoved = read.removed.has(id);
    if (id === '' || (known === undefined && !alreadyRemoved)) {
      throw new WorkspaceRefusal('unknown-decision', 'no recorded merge decision has that id', { id: id === '' ? null : id });
    }
    if (alreadyRemoved) {
      return { action: 'merge-decision', op: 'remove', workspace, decision: null, id, recorded: false, removed: true, decisionsPath };
    }
    const reason = oneLine(options.reason);
    appendLine(workspace.path, removalLine({ type: 'removed', id, author, ts, ...(reason === '' ? {} : { reason }) }));
    return { action: 'merge-decision', op: 'remove', workspace, decision: known ?? null, id, recorded: true, removed: true, decisionsPath };
  }

  const kind = options.kind?.trim();
  if (!isOneOf(MERGE_DECISION_KINDS, kind)) throw vocabularyRefusal('invalid-decision-kind', 'kind', options.kind, MERGE_DECISION_KINDS);
  const take = options.take?.trim();
  if (!isOneOf(MERGE_DECISION_TAKES, take)) throw vocabularyRefusal('invalid-decision-take', 'take', options.take, MERGE_DECISION_TAKES);
  const outcome = options.outcome?.trim();
  if (!isOneOf(MERGE_DECISION_OUTCOMES, outcome)) {
    throw vocabularyRefusal('invalid-decision-outcome', 'outcome', options.outcome, MERGE_DECISION_OUTCOMES);
  }
  const projects = projectSlugs(status);
  const project = options.project?.trim() ?? '';
  if (!projects.includes(project)) {
    throw new WorkspaceRefusal('unknown-project', `${project === '' ? 'a project' : project} is not a project of the Workspace ${workspace.name}`, {
      flag: 'project',
      project: project === '' ? null : project,
      projects,
    });
  }
  const path = (options.path ?? '').trim();
  const summary = oneLine(options.summary);
  if (path === '' || summary === '') {
    throw new WorkspaceRefusal('invalid-decision', 'a decision needs --path (what it settled) and --summary (one line of what was taken)', {
      missing: [...(path === '' ? ['path'] : []), ...(summary === '' ? ['summary'] : [])],
    });
  }
  const reason = oneLine(options.reason);
  const id = mergeDecisionId({ kind, project, path, take, summary, reason, outcome });
  const entry: MergeDecisionEntry = { type: 'decision', id, kind, project, path, take, summary, reason, outcome, author, ts };

  const existing = read.entries.find((candidate) => candidate.id === id);
  const removed = read.removed.has(id);
  if (existing !== undefined || removed) {
    return { action: 'merge-decision', op: 'record', workspace, decision: existing ?? null, id, recorded: false, removed, decisionsPath };
  }
  appendLine(workspace.path, decisionLine(entry));
  return { action: 'merge-decision', op: 'record', workspace, decision: entry, id, recorded: true, removed: false, decisionsPath };
}

// ─── list ───────────────────────────────────────────────────────────────────

export function listMergeDecisions(options: ListMergeDecisionsOptions): MergeDecisionsListResult {
  const status = resolveWorkspace(options);
  const workspace = status.workspace as WorkspaceSummary;
  const projects = projectSlugs(status);
  if (options.project !== undefined && !projects.includes(options.project)) {
    throw new WorkspaceRefusal('unknown-project', `${options.project} is not a project of the Workspace ${workspace.name}`, {
      project: options.project,
      projects,
    });
  }
  if (options.kind !== undefined && !isOneOf(MERGE_DECISION_KINDS, options.kind)) {
    throw vocabularyRefusal('invalid-decision-kind', 'kind', options.kind, MERGE_DECISION_KINDS);
  }
  const { entries, unreadable } = readMergeDecisions(workspace.path);
  return {
    action: 'merge-decision',
    op: 'list',
    workspace,
    project: options.project ?? null,
    kind: options.kind ?? null,
    decisions: entries.filter(
      (entry) => (options.project === undefined || entry.project === options.project) && (options.kind === undefined || entry.kind === options.kind),
    ),
    unreadable,
  };
}
