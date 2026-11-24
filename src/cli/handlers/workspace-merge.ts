/**
 * THE WORKSPACE MERGE — what `workspace sync` does with a merge in progress
 * (workspaces-knowledge-hub FR-16, risks R-2 and R-3).
 *
 * `inspectMerge` reads a `git merge --no-ff --no-commit` that has just run in a
 * Workspace repository and sorts every path BOTH sides touched (plus the few
 * cross-file collisions knowledge can have) into exactly one of three piles:
 *
 *   resolutions  Flow settles it on its own — ONLY the safe classes:
 *                  union        an append-only `*.jsonl` store: every line of both
 *                               sides kept (git's `merge=union`, verified; done by
 *                               hand, de-duplicated in order, if it did not take)
 *                  renumber     the same new versioned document (`<name>_v<N>.md`)
 *                               created on both sides: theirs keeps the name, ours
 *                               moves to the next free version, its
 *                               `.walkthrough.html` follows, and references to
 *                               it inside our other changed documents follow too
 *                  workspace-file  `workspace.json` changed on both sides with no
 *                               field or project changed differently by both
 *                  line-merge   any other file both sides edited that git merged
 *                               without a conflict
 *                Each one is written to `merges/<date>-<id>.md` with both sides.
 *                  feature-rules  a feature note edited on both sides, settled by
 *                               the draft/solid rules (discovery
 *                               `workspace_knowledge_draft_solid`, FR-11): a
 *                               clean git merge is accepted; conflicting
 *                               `## Learned` / part learnings are merged as a set
 *                               of independent lines; the same learning changed
 *                               differently on both sides keeps both when either
 *                               is a draft, takes the one proved by the newer
 *                               default-branch commit when both are solid, and
 *                               keeps both marked stale when that cannot be told
 *   asks         a person (or, for intent, an agent) decides — the merge is aborted
 *                until they have:
 *                  decision             a decision note touched on both sides — ALWAYS;
 *                                       `agentMergeable`, with the base text
 *                  same-feature         a feature note the rules cannot settle (both
 *                                       sides changed its prose in the same place, a
 *                                       part's fields, hand-written lines in a machine
 *                                       section), or two files claiming one id
 *                  overlapping-anchors  two features newly claiming the same anchor
 *                  same-discovery       one discovery slug changed on both sides where
 *                                       at least one side EDITED an existing version
 *                                       (or both edited one version and git conflicted);
 *                                       `agentMergeable`, with the base text
 *   reviews      any other authored file git could not merge (conflict markers,
 *                modify/delete) — both versions and the base are handed back so an
 *                agent can draft the merge; a plan's is flagged `agentMergeable`.
 *
 * DECIDING. Every ask and review is about ONE path of the Workspace repo and
 * is answered by what that path holds afterwards:
 *
 *   ours     this machine's version (HEAD), or no file when this side has none
 *   theirs   the Workspace's version (the incoming commit), or no file
 *   merged   git's clean merge — offered only when git merged the path cleanly
 *   file     a given text (an agent-drafted merge, a hand edit)
 *
 * Decisions are kept in the repository's own `.git` folder (never committed),
 * keyed by an id that hashes the item's kind, paths and both sides' blob ids —
 * so a decision is applied only to exactly the content it was made about; if
 * either side changes afterwards, the question is put again.
 *
 * "Existing" in every payload is what the Workspace already says (theirs);
 * "incoming" is this machine's (ours) — the words the collision card uses.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  LEARNED_HEADING,
  PARTS_HEADING,
  featureAddress,
  featureExclusion,
  hasUnparsedContent,
  mintFeatureId,
  parseFeatureFile,
  parseFeatureId,
  parseLearnings,
  parseParts,
  serializeLearnings,
  serializeParts,
  slugifyFeatureName,
  splitParts,
  type FeaturePart,
  type Learning,
} from '../blueprint/feature-store.js';
import { BLUEPRINT_DIRNAME, hashFileContent } from '../blueprint/store.js';
import { KNOWLEDGE_PROVENANCE_FILENAME, type KnowledgeProvenance } from '../state/knowledge-provenance.js';
import {
  KNOWLEDGE_STATUS_FILENAME,
  appendKnowledgeStatus,
  foldKnowledgeStatus,
  itemStampOf,
  knowledgeItemId,
  resolveItemStatus,
  type FoldedKnowledgeStatus,
  type KnowledgeStatusEntry,
} from '../state/knowledge-status-log.js';
import { parseProvenanceRecords } from '../state/knowledge-status-fold.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { classifyKnowledgePath } from './knowledge-classes.js';
import { projectCheckout } from './knowledge-landing.js';
import { readLocalProjects, workspaceFileProblem, type WorkspaceGit } from './workspace-model.js';

// ─── Names ──────────────────────────────────────────────────────────────────

/** The audit folder at the Workspace repo's root (authored — it syncs). */
export const MERGES_DIRNAME = 'merges';
/** Inside `.git`: decisions waiting for a merge to apply them. */
export const SYNC_DECISIONS_GIT_PATH = 'plan-flow-sync-decisions.json';
/** A payload text longer than this is cut (the full text is in git, by blob id). */
export const MAX_PAYLOAD_TEXT = 100_000;
/** The longest `file:` content a decision may carry. */
export const MAX_DECISION_CONTENT = 5 * 1024 * 1024;

// ─── Types ──────────────────────────────────────────────────────────────────

export type Take = 'ours' | 'theirs' | 'merged' | 'file';

export type AskKind = 'decision' | 'same-feature' | 'overlapping-anchors' | 'same-discovery';
export type ReviewKind = 'conflict' | 'add-add' | 'modify-delete';

export interface SyncAsk {
  /** Stable for exactly this content on both sides. */
  id: string;
  kind: AskKind;
  /** What the collision is about, in the Workspace's own words (`backend/auth`, …). */
  topic: string;
  /** The path the decision is about (Workspace-relative) — this machine's file. */
  path: string;
  /** Where the Workspace's side lives — the same path, or the other file of a cross-file collision. */
  existingPath: string;
  /** What the Workspace already says (theirs, at `existingPath`). */
  existing: string | null;
  /** This machine's version (ours, at `path`). */
  incoming: string | null;
  /** Git's clean merge of the path, when there is one. */
  merged: string | null;
  /** overlapping-anchors: the anchors both sides newly claimed. */
  anchors?: string[];
  /**
   * An intent document (decision, discovery) an agent may merge: the app hands
   * `base`, `existing` and `incoming` to an agent and resolves with its text.
   * Additive — a consumer that ignores it sees the ask it always saw.
   */
  agentMergeable?: true;
  /** agentMergeable only: the common ancestor's text at `path` (null when new on both sides). */
  base?: string | null;
  /** agentMergeable only: git's author name of the Workspace side's last change to `existingPath`. */
  theirAuthor?: string | null;
  truncated: boolean;
  /** Every `take` this item accepts (`file` always). */
  options: Take[];
}

export interface SyncReview {
  id: string;
  kind: ReviewKind;
  path: string;
  /** The common ancestor's version (null when the file is new on both sides). */
  base: string | null;
  /** The Workspace's version (theirs). */
  existing: string | null;
  /** This machine's version (ours). */
  incoming: string | null;
  /** The working copy with git's conflict markers, when there is one. */
  conflicted: string | null;
  /** An intent document (a plan, a discovery, a decision) an agent may merge. Additive. */
  agentMergeable?: true;
  /** agentMergeable only: git's author name of the Workspace side's last change to `path`. */
  theirAuthor?: string | null;
  truncated: boolean;
  options: Take[];
}

export type MergeResolution =
  | { kind: 'union'; path: string; attribute: boolean; lines: number }
  | {
      kind: 'renumber';
      path: string;
      renamedTo: string;
      walkthrough: { from: string; to: string } | null;
      referencesUpdated: string[];
      /** Files that still name the old version because the Workspace changed them too. */
      referencesNotUpdated: string[];
    }
  | { kind: 'workspace-file'; path: string }
  | { kind: 'line-merge'; path: string }
  | {
      kind: 'feature-rules';
      path: string;
      /** Which rule settled it. */
      rule: FeatureRule;
      /** Learning lines left out because the newer default-branch commit's version won. */
      dropped: number;
      /** Items marked stale (kept both; to be re-learned). */
      stale: number;
    }
  | { kind: 'decision'; path: string; take: Take; item: string };

/**
 * `clean` — git merged the file without a conflict; `union` — the conflict was
 * only in learning lines, and every line of both sides was kept (drafts, or
 * different learnings); `newer-wins` — at least one solid learning was settled
 * by the newer default-branch commit; `kept-both-stale` — at least one solid
 * learning could not be ordered, so both were kept and marked stale.
 */
export type FeatureRule = 'clean' | 'union' | 'newer-wins' | 'kept-both-stale';

export interface StoredDecision {
  id: string;
  path: string;
  take: Take;
  /** `file` only: the text the path should hold. */
  content?: string;
  decidedAt: string;
}

/** Everything one inspection found. Nothing has been written yet. */
export interface MergeInspection {
  resolutions: PlannedResolution[];
  asks: SyncAsk[];
  reviews: SyncReview[];
}

/** A resolution with what applying it needs. */
export type PlannedResolution =
  | { kind: 'union'; path: string; attribute: boolean; content: string | null; lines: number }
  | { kind: 'renumber'; path: string; ours: string; theirs: string; family: VersionedName; walkthrough: string | null }
  | { kind: 'workspace-file'; path: string; content: string }
  | { kind: 'line-merge'; path: string }
  | {
      kind: 'feature-rules';
      path: string;
      /** The settled text; null = keep git's clean merge in the working tree. */
      content: string | null;
      rule: FeatureRule;
      dropped: number;
      /** Status lines to append (through `appendKnowledgeStatus`), with the knowledge folder they belong to. */
      stale: { projectDir: string; entry: KnowledgeStatusEntry }[];
    };

/** `dir/stem_v<N>.md`. */
interface VersionedName {
  dir: string;
  stem: string;
  version: number;
}

type Status = 'A' | 'M' | 'D' | 'T';

/** The facts of one merge: who changed what since the common ancestor. */
export interface MergeFacts {
  repo: string;
  git: WorkspaceGit;
  base: string;
  ours: string;
  theirs: string;
  oursChanged: Map<string, Status>;
  theirsChanged: Map<string, Status>;
  conflicted: Set<string>;
}

// ─── Git helpers ────────────────────────────────────────────────────────────

function attempt(git: WorkspaceGit, args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function splitZ(out: string | null): string[] {
  return (out ?? '').split('\0').filter((entry) => entry.length > 0);
}

/** `<rev>:<path>`'s blob id, or null when the path is absent there. */
export function blobAt(git: WorkspaceGit, repo: string, rev: string, path: string): string | null {
  const out = attempt(git, ['rev-parse', '--verify', '-q', `${rev}:${path}`], repo);
  const id = out?.trim() ?? '';
  return id === '' ? null : id;
}

/**
 * Who last changed `path` on `rev`'s side (git's author name), or null. Only
 * asked for intent documents, so the app can say whose edit it merged.
 */
function authorAt(git: WorkspaceGit, repo: string, rev: string, path: string): string | null {
  const out = attempt(git, ['log', '-1', '--format=%an', rev, '--', path], repo);
  const name = out?.trim() ?? '';
  return name === '' ? null : name.slice(0, 120);
}

/** `<rev>:<path>`'s text, or null when the path is absent there. */
export function textAt(git: WorkspaceGit, repo: string, rev: string, path: string): string | null {
  if (blobAt(git, repo, rev, path) === null) return null;
  return attempt(git, ['cat-file', 'blob', `${rev}:${path}`], repo);
}

/** Paths changed between two commits, with their status (renames off). */
export function changedPaths(git: WorkspaceGit, repo: string, from: string, to: string): Map<string, Status> {
  const parts = splitZ(attempt(git, ['diff', '--name-status', '--no-renames', '-z', from, to], repo));
  const changed = new Map<string, Status>();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const status = parts[index].charAt(0) as Status;
    changed.set(parts[index + 1], status);
  }
  return changed;
}

/** Paths git left unmerged in the index. */
export function unmergedPaths(git: WorkspaceGit, repo: string): Set<string> {
  const paths = new Set<string>();
  for (const entry of splitZ(attempt(git, ['ls-files', '--unmerged', '-z'], repo))) {
    const tab = entry.indexOf('\t');
    if (tab !== -1) paths.add(entry.slice(tab + 1));
  }
  return paths;
}

/** Read the facts of the merge in progress in `repo` (MERGE_HEAD must exist). */
export function readMergeFacts(git: WorkspaceGit, repo: string, ours: string, theirs: string): MergeFacts {
  const base = git(['merge-base', ours, theirs], repo).trim();
  return {
    repo,
    git,
    base,
    ours,
    theirs,
    oursChanged: changedPaths(git, repo, base, ours),
    theirsChanged: changedPaths(git, repo, base, theirs),
    conflicted: unmergedPaths(git, repo),
  };
}

function workingText(repo: string, path: string): string | null {
  const full = join(repo, path);
  return existsSync(full) ? readFileSync(full, 'utf-8') : null;
}

function hashId(parts: readonly (string | null)[]): string {
  return createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

function cut(text: string | null): { text: string | null; truncated: boolean } {
  if (text === null || text.length <= MAX_PAYLOAD_TEXT) return { text, truncated: false };
  return { text: `${text.slice(0, MAX_PAYLOAD_TEXT)}\n…`, truncated: true };
}

// ─── Path kinds ─────────────────────────────────────────────────────────────

const DECISION_PATH = /^projects\/([^/]+)\/brain\/decisions\/(.+)$/;
const FEATURE_PATH = /^projects\/([^/]+)\/brain\/features\/([^/]+)\.md$/;
const DISCOVERY_PATH = /^projects\/([^/]+)\/discovery\/discovery_(.+)_v(\d+)\.md$/;
const VERSIONED_PATH = /^(projects\/[^/]+\/(?:.+\/)?)([^/]+)_v(\d+)\.md$/;
const WALKTHROUGH_SUFFIX = '.walkthrough.html';
const REFERENCE_EXTENSIONS = /\.(md|html)$/;

export function isDecisionPath(path: string): boolean {
  return DECISION_PATH.test(path);
}

const PLAN_PATH = /^projects\/[^/]+\/plans\/[^/]+\.md$/;

/** A decision, plan or discovery document — intent, which an agent may merge (FR-12). */
export function isIntentPath(path: string): boolean {
  return DECISION_PATH.test(path) || DISCOVERY_PATH.test(path) || PLAN_PATH.test(path);
}

/**
 * Any markdown note of a project — intent, a feature, an error, a learned
 * note — which an agent may merge (user, 2026-11-24: "we are having
 * conflicts that agent should fix"). Only the base text is extra; the app
 * still decides, item by item, whether its answer is usable.
 */
export function isAgentMergeablePath(path: string): boolean {
  return isIntentPath(path) || /^projects\/[^/]+\/.+\.md$/.test(path);
}

function versionedName(path: string): VersionedName | null {
  const match = VERSIONED_PATH.exec(path);
  if (match === null) return null;
  return { dir: match[1], stem: match[2], version: Number.parseInt(match[3], 10) };
}

function versionedPath(name: VersionedName, version: number): string {
  return `${name.dir}${name.stem}_v${version}.md`;
}

function walkthroughOf(mdPath: string): string {
  return `${mdPath.slice(0, -'.md'.length)}${WALKTHROUGH_SUFFIX}`;
}

/** A feature note's namespaced id and anchors, or null when the text is not a feature. */
function featureOf(path: string, text: string | null): { id: string; anchors: string[] } | null {
  const match = FEATURE_PATH.exec(path);
  if (match === null || text === null) return null;
  if (featureExclusion(text) !== null) return null;
  const node = parseFeatureFile(match[2], text);
  // The first cut minted `feature:<project>/<slug>` (the part grammar); for
  // the note's own file it can only mean the namespaced id.
  const ownId = node.id === `feature:${match[1]}/${match[2]}` ? mintFeatureId(match[2], match[1]) : node.id;
  const parsed = parseFeatureId(ownId);
  const id = parsed !== null && parsed.namespace === null ? mintFeatureId(parsed.slug, match[1]) : ownId;
  return { id, anchors: node.anchors };
}

function isFeaturePath(path: string, texts: readonly (string | null)[]): boolean {
  if (!FEATURE_PATH.test(path)) return false;
  const sample = texts.find((text) => text !== null);
  return sample === undefined || sample === null || featureExclusion(sample) === null;
}

// ─── Union ──────────────────────────────────────────────────────────────────

function contentLines(text: string | null): string[] {
  return (text ?? '').split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Both sides' lines, de-duplicated, in order (ours first) — complete RELATIVE
 * TO THE BASE when there is one: a line either side added survives, and a
 * line either side removed since the base stays removed (a union that brought
 * it back would resurrect what someone deleted).
 */
export function unionLines(ours: string | null, theirs: string | null, base: string | null = null): string {
  const before = new Set(contentLines(base));
  const oursSet = new Set(contentLines(ours));
  const theirsSet = new Set(contentLines(theirs));
  const removed = (line: string): boolean => before.has(line) && (!oursSet.has(line) || !theirsSet.has(line));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...contentLines(ours), ...contentLines(theirs)]) {
    if (seen.has(line) || removed(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

/** Do two texts hold exactly the same set of lines? */
function sameLines(left: string | null, right: string): boolean {
  const a = new Set(contentLines(left));
  const b = new Set(contentLines(right));
  return a.size === b.size && [...a].every((line) => b.has(line));
}

function hasUnionAttribute(git: WorkspaceGit, repo: string, path: string): boolean {
  const out = attempt(git, ['check-attr', 'merge', '--', path], repo) ?? '';
  return /: merge: union\s*$/.test(out.trim());
}

// ─── workspace.json ─────────────────────────────────────────────────────────

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Three-way pick of one value by its JSON; `undefined` = conflict. */
function pick3(base: unknown, ours: unknown, theirs: unknown): { value: unknown } | undefined {
  const [b, o, t] = [JSON.stringify(base), JSON.stringify(ours), JSON.stringify(theirs)];
  if (o === t) return { value: ours };
  if (o === b) return { value: theirs };
  if (t === b) return { value: ours };
  return undefined;
}

/**
 * `workspace.json` changed on both sides: merged field by field, and its
 * project list project by project (by id). Null when any one field or project
 * was changed differently on both sides, or the result would not validate —
 * then a person reviews it.
 */
export function mergeWorkspaceFile(baseText: string | null, oursText: string | null, theirsText: string | null): string | null {
  const base = parseJsonObject(baseText);
  const ours = parseJsonObject(oursText);
  const theirs = parseJsonObject(theirsText);
  if (base === null || ours === null || theirs === null) return null;
  const keys = [...new Set([...Object.keys(theirs), ...Object.keys(ours), ...Object.keys(base)])];
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (key === 'projects') {
      const projects = mergeProjects(base.projects, ours.projects, theirs.projects);
      if (projects === null) return null;
      out.projects = projects;
      continue;
    }
    // The shared name is only what someone who never renamed it sees; each
    // machine keeps its own (settings/workspaces.local.json). Two different
    // renames are not a reason to stop a sync: the team's version stands.
    const picked = pick3(base[key], ours[key], theirs[key]) ?? (key === 'name' ? { value: theirs[key] ?? ours[key] } : undefined);
    if (picked === undefined) return null;
    if (picked.value !== undefined) out[key] = picked.value;
  }
  if (workspaceFileProblem(out) !== null) return null;
  return `${JSON.stringify(out, null, 2)}\n`;
}

function byId(list: unknown): Map<string, unknown> | null {
  if (list === undefined) return new Map();
  if (!Array.isArray(list)) return null;
  const map = new Map<string, unknown>();
  for (const entry of list) {
    const id = typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || map.has(id)) return null;
    map.set(id, entry);
  }
  return map;
}

function mergeProjects(base: unknown, ours: unknown, theirs: unknown): unknown[] | null {
  const [b, o, t] = [byId(base), byId(ours), byId(theirs)];
  if (b === null || o === null || t === null) return null;
  const ids = [...new Set([...t.keys(), ...o.keys(), ...b.keys()])];
  const out: unknown[] = [];
  for (const id of ids) {
    const picked = pick3(b.get(id), o.get(id), t.get(id));
    if (picked === undefined) return null;
    if (picked.value !== undefined) out.push(picked.value);
  }
  return out;
}

// ─── Feature notes: the draft/solid rules (FR-11) ──────────────────────────

/** What proved a solid learning: the default-branch commit and its time, when known. */
interface Evidence {
  commit: string | null;
  ts: string | null;
}

/** One learning line, with what the status store says about it. */
interface LineInfo {
  item: string;
  status: 'solid' | 'draft' | 'abandoned';
  stamped: boolean;
  provenance: KnowledgeProvenance | null;
  folded: FoldedKnowledgeStatus | undefined;
  evidence: Evidence;
}

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const STRUCTURE_DIR = BLUEPRINT_DIRNAME.replace(/\\/g, '/');

/**
 * Answers "draft or solid, and proved by which commit?" for a learning line
 * during a merge, from BOTH sides' status logs and provenance records — the
 * union a finished merge will hold. Read once per project, lazily. Read-only.
 */
class StatusOracle {
  readonly #facts: MergeFacts;
  readonly #stores = new Map<string, { folded: Map<string, FoldedKnowledgeStatus>; records: Map<string, KnowledgeProvenance> }>();
  readonly #checkouts = new Map<string, string | null>();
  #fallback: string | null | undefined;

  constructor(facts: MergeFacts) {
    this.#facts = facts;
  }

  #store(project: string): { folded: Map<string, FoldedKnowledgeStatus>; records: Map<string, KnowledgeProvenance> } {
    const cached = this.#stores.get(project);
    if (cached !== undefined) return cached;
    const { git, repo } = this.#facts;
    const both = (name: string): string =>
      [this.#facts.ours, this.#facts.theirs].map((rev) => textAt(git, repo, rev, `projects/${project}/${STRUCTURE_DIR}/${name}`) ?? '').join('\n');
    const store = {
      folded: foldKnowledgeStatus(both(KNOWLEDGE_STATUS_FILENAME).split('\n')),
      records: parseProvenanceRecords(both(KNOWLEDGE_PROVENANCE_FILENAME), (text) => hashFileContent(text)),
    };
    this.#stores.set(project, store);
    return store;
  }

  info(project: string, kind: 'learning' | 'part-learning', scope: string, entry: Learning): LineInfo {
    const { folded, records } = this.#store(project);
    const stamp = itemStampOf(entry.learnedAt, records);
    const item = knowledgeItemId({ kind, scope, text: entry.text, learnedAt: entry.learnedAt ?? null });
    const decided = stamp.kind === 'stamped' ? folded.get(item) : undefined;
    const resolved = resolveItemStatus(stamp, decided);
    const provenance = stamp.kind === 'stamped' ? stamp.provenance : null;
    let evidence: Evidence = { commit: null, ts: null };
    if (decided !== undefined && decided.status !== 'draft') evidence = { commit: decided.entry.commit, ts: decided.entry.ts };
    else if (provenance?.onDefault === true) evidence = { commit: provenance.commit, ts: null };
    return { item, status: resolved.status, stamped: stamp.kind === 'stamped', provenance, folded: decided, evidence };
  }

  /** The project's code checkout on this machine, or null. */
  #checkout(project: string): string | null {
    if (this.#checkouts.has(project)) return this.#checkouts.get(project) ?? null;
    let checkout: string | null = null;
    try {
      const file = JSON.parse(readFileSync(join(this.#facts.repo, 'workspace.json'), 'utf-8')) as { projects?: { slug?: unknown; id?: unknown }[] };
      const projects = (file.projects ?? [])
        .filter((entry) => typeof entry.slug === 'string' && typeof entry.id === 'string')
        .map((entry) => ({ slug: entry.slug as string, id: entry.id as string }));
      checkout = projectCheckout(readLocalProjects(dirname(dirname(this.#facts.repo))), projects, project);
      if (checkout !== null && !existsSync(checkout)) checkout = null;
    } catch {
      checkout = null;
    }
    this.#checkouts.set(project, checkout);
    return checkout;
  }

  /**
   * Which evidence is newer on the default branch: commit order in the
   * project's checkout when this machine has it, else the evidence times.
   * `same` for one commit; null when it cannot be told.
   */
  order(project: string, a: Evidence, b: Evidence): 'a' | 'b' | 'same' | null {
    if (a.commit !== null && a.commit === b.commit) return 'same';
    const checkout = this.#checkout(project);
    if (checkout !== null && a.commit !== null && b.commit !== null && COMMIT_ID.test(a.commit) && COMMIT_ID.test(b.commit)) {
      const isAncestor = (x: string, y: string): boolean =>
        attempt(this.#facts.git, ['merge-base', '--is-ancestor', x, y], checkout) !== null;
      if (isAncestor(a.commit, b.commit)) return 'b';
      if (isAncestor(b.commit, a.commit)) return 'a';
    }
    if (a.ts !== null && b.ts !== null && a.ts !== b.ts) return a.ts > b.ts ? 'a' : 'b';
    return null;
  }

  /**
   * The time a stale line carries when its item has no decided line to take
   * one from: the merge base's committer date — the same on both machines of
   * a symmetric merge, so their lines agree.
   */
  fallbackTs(): string | null {
    if (this.#fallback === undefined) {
      const out = attempt(this.#facts.git, ['show', '-s', '--format=%cI', this.#facts.base], this.#facts.repo)?.trim() ?? '';
      this.#fallback = Number.isNaN(Date.parse(out)) ? null : out;
    }
    return this.#fallback;
  }
}

/** What one feature settlement collected on the way. */
interface Settling {
  project: string;
  oracle: StatusOracle;
  rules: Set<FeatureRule>;
  dropped: number;
  stale: { projectDir: string; entry: KnowledgeStatusEntry }[];
}

function learningKey(entry: Learning): string {
  return serializeLearnings([entry]).trim();
}

/**
 * Merge three versions of a list of learnings. Every line is an independent
 * entry: a line either side added is kept, a line either side removed since
 * the base stays removed. The SAME learning — one sentence whose line each
 * side changed differently — is settled by status: a draft on either side
 * keeps both; two solid lines take the one proved by the newer default-branch
 * commit; one that cannot be ordered keeps both and marks them stale.
 */
function mergeLearnings(
  settling: Settling,
  kind: 'learning' | 'part-learning',
  scope: string,
  base: readonly Learning[],
  ours: readonly Learning[],
  theirs: readonly Learning[]
): Learning[] {
  const toMap = (list: readonly Learning[]): Map<string, Learning> => new Map(list.map((entry) => [learningKey(entry), entry]));
  const [b, o, t] = [toMap(base), toMap(ours), toMap(theirs)];
  const kept = new Map<string, Learning>();
  for (const [key, entry] of [...o, ...t]) {
    if (kept.has(key)) continue;
    if (b.has(key) && (!o.has(key) || !t.has(key))) continue; // removed since the base by one side
    kept.set(key, entry);
  }

  const byText = new Map<string, string[]>();
  for (const [key, entry] of kept) byText.set(entry.text, [...(byText.get(entry.text) ?? []), key]);
  for (const keys of byText.values()) {
    const oursOnly = keys.filter((key) => o.has(key) && !t.has(key));
    const theirsOnly = keys.filter((key) => t.has(key) && !o.has(key));
    if (oursOnly.length === 0 || theirsOnly.length === 0) continue;
    const info = (key: string): LineInfo => settling.oracle.info(settling.project, kind, scope, kept.get(key) as Learning);
    const oursInfo = oursOnly.map(info);
    const theirsInfo = theirsOnly.map(info);
    if ([...oursInfo, ...theirsInfo].some((line) => line.status !== 'solid')) {
      settling.rules.add('union'); // draft vs draft, draft vs solid: both kept
      continue;
    }
    const verdict =
      oursInfo.length === 1 && theirsInfo.length === 1
        ? settling.oracle.order(settling.project, oursInfo[0].evidence, theirsInfo[0].evidence)
        : null;
    if (verdict === 'a' || verdict === 'b') {
      for (const key of verdict === 'a' ? theirsOnly : oursOnly) kept.delete(key);
      settling.dropped += verdict === 'a' ? theirsOnly.length : oursOnly.length;
      settling.rules.add('newer-wins');
      continue;
    }
    settling.rules.add('kept-both-stale');
    const reason = verdict === 'same' ? 'merge-same-commit' : 'merge-undecidable';
    for (const line of [...oursInfo, ...theirsInfo]) {
      // An unstamped learning resolves as solid whatever the log says; a line for it would change nothing.
      if (!line.stamped) continue;
      const ts = line.folded?.entry.ts ?? settling.oracle.fallbackTs();
      if (ts === null) continue;
      const commit = line.evidence.commit !== null && COMMIT_ID.test(line.evidence.commit) ? line.evidence.commit : null;
      settling.stale.push({
        projectDir: `projects/${settling.project}`,
        entry: { item: line.item, status: 'stale', branch: line.provenance?.branch ?? null, commit, reason, ts },
      });
    }
  }
  return [...kept.values()];
}

/** Three-way pick of a value by its JSON; `undefined` = changed differently on both sides. */
function pickSame<T>(base: T, ours: T, theirs: T): { value: T } | undefined {
  return pick3(base, ours, theirs) as { value: T } | undefined;
}

/** A region as lines that carry content, so a re-serialization compares equal to the file. */
function regionShape(text: string | null): string {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

const PART_FIELDS = ['summary', 'anchors', 'home', 'role', 'learnedRole'] as const;

/** Merge three `## Parts` regions part by part, by name. Null when a part's own fields conflict. */
function mergePartLists(settling: Settling, slug: string, base: FeaturePart[], ours: FeaturePart[], theirs: FeaturePart[]): FeaturePart[] | null {
  const byName = (list: FeaturePart[]): Map<string, FeaturePart> => new Map(list.map((part) => [part.name, part]));
  const [b, o, t] = [byName(base), byName(ours), byName(theirs)];
  const names = [...new Set([...t.keys(), ...o.keys()])];
  const out: FeaturePart[] = [];
  for (const name of names) {
    const [bp, op, tp] = [b.get(name), o.get(name), t.get(name)];
    if (op === undefined || tp === undefined) {
      const present = (op ?? tp) as FeaturePart;
      if (bp === undefined) {
        out.push(present); // added on one side
        continue;
      }
      // Removed on one side: fine when the other left it as it was; a person decides otherwise.
      if (JSON.stringify(present) === JSON.stringify(bp)) continue;
      return null;
    }
    const merged: FeaturePart = { name, summary: '', anchors: [], learnings: [] };
    for (const field of PART_FIELDS) {
      const picked = pickSame<unknown>(bp?.[field], op[field], tp[field]);
      if (picked === undefined) return null;
      if (picked.value !== undefined) (merged as unknown as Record<string, unknown>)[field] = picked.value;
    }
    merged.learnings = mergeLearnings(settling, 'part-learning', `${slug}/${slugifyFeatureName(name)}`, bp?.learnings ?? [], op.learnings, tp.learnings);
    out.push(merged);
  }
  return out;
}

/**
 * git's own three-way merge of one region of text (`git merge-file`), run on
 * temporary copies outside the repository. Null when it conflicts.
 */
function mergeText3(git: WorkspaceGit, base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const dir = mkdtempSync(join(tmpdir(), 'pf-merge-'));
  try {
    const [o, b, t] = [join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')];
    writeFileSync(o, ours);
    writeFileSync(b, base);
    writeFileSync(t, theirs);
    return attempt(git, ['merge-file', '-p', '--quiet', o, b, t], dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Settle a feature note edited on both sides by the rules, or return null for
 * a person: a clean git merge is accepted as it is; a conflict is settled when
 * it lies only in learning lines (`## Learned`, part learnings) — the prose
 * above the heading, a part's own fields, a machine section holding
 * hand-written lines, or a file deleted on one side are not the rules' to
 * decide. READ-ONLY: the text and the status lines are applied later.
 */
function settleFeatureFile(facts: MergeFacts, path: string, sides: Sides, isConflict: boolean, oracle: StatusOracle): PlannedResolution | null {
  if (!isConflict) return { kind: 'feature-rules', path, content: null, rule: 'clean', dropped: 0, stale: [] };
  if (sides.ours === null || sides.theirs === null) return null;
  const match = FEATURE_PATH.exec(path);
  if (match === null) return null;
  const [, project, slug] = match;
  type Regions = ReturnType<typeof splitParts>;
  let regions: [Regions, Regions, Regions];
  try {
    const split = (text: string | null): Regions => (text === null ? { human: '', learned: null, parts: null } : splitParts(text.replace(/\r\n/g, '\n')));
    regions = [split(sides.base), split(sides.ours), split(sides.theirs)];
  } catch {
    return null; // an ambiguous section boundary is never guessed at
  }
  const [base, ours, theirs] = regions;
  if ([base.learned, ours.learned, theirs.learned].some((section) => hasUnparsedContent(section))) return null;

  const human = mergeText3(facts.git, base.human, ours.human, theirs.human);
  if (human === null) return null; // prose changed in the same place on both sides

  const settling: Settling = { project, oracle, rules: new Set(), dropped: 0, stale: [] };

  let learned: string | null;
  if (ours.learned === theirs.learned || theirs.learned === base.learned) learned = ours.learned;
  else if (ours.learned === base.learned) learned = theirs.learned;
  else {
    learned = serializeLearnings(
      mergeLearnings(settling, 'learning', slug, parseLearnings(base.learned), parseLearnings(ours.learned), parseLearnings(theirs.learned))
    );
  }

  let parts: string | null;
  if (ours.parts === theirs.parts || theirs.parts === base.parts) parts = ours.parts;
  else if (ours.parts === base.parts) parts = theirs.parts;
  else {
    // Only a region this module can read back exactly is rewritten from what it read.
    for (const region of [base.parts, ours.parts, theirs.parts]) {
      if (region !== null && regionShape(serializeParts(parseParts(region))) !== regionShape(region)) return null;
    }
    const merged = mergePartLists(settling, slug, parseParts(base.parts), parseParts(ours.parts), parseParts(theirs.parts));
    if (merged === null) return null;
    parts = `\n${serializeParts(merged)}`;
  }

  const above = learned === null ? human : `${human}\n${LEARNED_HEADING}\n${learned}`;
  // The exact inverse of `splitParts` / `splitLearned`: a region nobody changed keeps its bytes.
  const content = parts === null ? above : `${above}\n${PARTS_HEADING}\n${parts}`;
  const rule: FeatureRule = settling.rules.has('kept-both-stale')
    ? 'kept-both-stale'
    : settling.rules.has('newer-wins')
      ? 'newer-wins'
      : 'union';
  return { kind: 'feature-rules', path, content, rule, dropped: settling.dropped, stale: settling.stale };
}

// ─── Inspection ─────────────────────────────────────────────────────────────

interface Sides {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  baseBlob: string | null;
  oursBlob: string | null;
  theirsBlob: string | null;
}

function sidesOf(facts: MergeFacts, path: string): Sides {
  const { git, repo } = facts;
  return {
    base: textAt(git, repo, facts.base, path),
    ours: textAt(git, repo, facts.ours, path),
    theirs: textAt(git, repo, facts.theirs, path),
    baseBlob: blobAt(git, repo, facts.base, path),
    oursBlob: blobAt(git, repo, facts.ours, path),
    theirsBlob: blobAt(git, repo, facts.theirs, path),
  };
}

function askOf(
  facts: MergeFacts,
  kind: AskKind,
  topic: string,
  path: string,
  existingPath: string,
  extra: { anchors?: string[]; agentMergeable?: boolean } = {}
): SyncAsk {
  const { git, repo } = facts;
  const oursBlob = blobAt(git, repo, facts.ours, path);
  const theirsBlob = blobAt(git, repo, facts.theirs, path);
  const existingBlob = blobAt(git, repo, facts.theirs, existingPath);
  const existing = cut(textAt(git, repo, facts.theirs, existingPath));
  const incoming = cut(textAt(git, repo, facts.ours, path));
  const clean = !facts.conflicted.has(path);
  const merged = clean ? cut(workingText(repo, path)) : { text: null, truncated: false };
  const options: Take[] = clean ? ['ours', 'theirs', 'merged', 'file'] : ['ours', 'theirs', 'file'];
  const base = extra.agentMergeable === true ? cut(textAt(git, repo, facts.base, path)) : { text: null, truncated: false };
  return {
    id: hashId([kind, path, existingPath, oursBlob, theirsBlob, existingBlob]),
    kind,
    topic,
    path,
    existingPath,
    existing: existing.text,
    incoming: incoming.text,
    merged: clean ? merged.text : null,
    ...(extra.anchors === undefined ? {} : { anchors: extra.anchors }),
    ...(extra.agentMergeable === true
      ? { agentMergeable: true as const, base: base.text, theirAuthor: authorAt(git, repo, facts.theirs, existingPath) }
      : {}),
    truncated: existing.truncated || incoming.truncated || merged.truncated || base.truncated,
    options,
  };
}

function reviewOf(facts: MergeFacts, path: string, sides: Sides): SyncReview {
  const kind: ReviewKind = sides.base === null && sides.ours !== null && sides.theirs !== null
    ? 'add-add'
    : sides.ours === null || sides.theirs === null
      ? 'modify-delete'
      : 'conflict';
  const base = cut(sides.base);
  const existing = cut(sides.theirs);
  const incoming = cut(sides.ours);
  const conflicted = cut(workingText(facts.repo, path));
  return {
    id: hashId(['review', path, path, sides.oursBlob, sides.theirsBlob, sides.theirsBlob]),
    kind,
    path,
    base: base.text,
    existing: existing.text,
    incoming: incoming.text,
    conflicted: conflicted.text,
    ...(isAgentMergeablePath(path) ? { agentMergeable: true as const, theirAuthor: authorAt(facts.git, facts.repo, facts.theirs, path) } : {}),
    truncated: base.truncated || existing.truncated || incoming.truncated || conflicted.truncated,
    options: ['ours', 'theirs', 'file'],
  };
}

function decisionTopic(path: string): string {
  const match = DECISION_PATH.exec(path);
  return match === null ? path : `${match[1]}/decisions/${match[2].replace(/\.md$/, '')}`;
}

function anchorsAdded(text: string | null, baseText: string | null, path: string): string[] {
  const now = featureOf(path, text)?.anchors ?? [];
  const before = new Set(featureOf(path, baseText)?.anchors ?? []);
  return now.filter((anchor) => !before.has(anchor));
}

/**
 * Sort the merge in progress. READ-ONLY: nothing in the working tree or the
 * index is changed — so a merge that turns out to need a person can be
 * aborted onto exactly the commit it started from.
 */
export function inspectMerge(facts: MergeFacts): MergeInspection {
  const { git, repo, oursChanged, theirsChanged, conflicted } = facts;
  const inspection: MergeInspection = { resolutions: [], asks: [], reviews: [] };
  const both = [...new Set([...[...oursChanged.keys()].filter((path) => theirsChanged.has(path)), ...conflicted])].sort();
  const handled = new Set<string>();
  const oracle = new StatusOracle(facts);

  // ── Pass 1: the same new versioned document on both sides → renumber ours. ──
  for (const path of both) {
    if (!conflicted.has(path) || oursChanged.get(path) !== 'A' || theirsChanged.get(path) !== 'A') continue;
    if (isDecisionPath(path) || classifyKnowledgePath(path, { root: 'workspace' }) !== 'authored') continue;
    const family = versionedName(path);
    if (family === null) continue;
    const ours = textAt(git, repo, facts.ours, path);
    const theirs = textAt(git, repo, facts.theirs, path);
    if (ours === null || theirs === null) continue;
    const sibling = walkthroughOf(path);
    const walkthrough = oursChanged.get(sibling) === 'A' ? sibling : null;
    inspection.resolutions.push({ kind: 'renumber', path, ours, theirs, family, walkthrough });
    handled.add(path);
    if (walkthrough !== null) handled.add(walkthrough);
  }

  // ── Pass 2: every other path both sides touched. ──
  for (const path of both) {
    if (handled.has(path)) continue;
    const sides = sidesOf(facts, path);
    if (sides.oursBlob === sides.theirsBlob && !conflicted.has(path)) continue; // the same change on both sides
    const isConflict = conflicted.has(path);

    if (isDecisionPath(path)) {
      inspection.asks.push(askOf(facts, 'decision', decisionTopic(path), path, path, { agentMergeable: true }));
      continue;
    }
    if (isFeaturePath(path, [sides.ours, sides.theirs, sides.base])) {
      const settled = settleFeatureFile(facts, path, sides, isConflict, oracle);
      if (settled !== null) {
        inspection.resolutions.push(settled);
        continue;
      }
      const feature = featureOf(path, sides.ours) ?? featureOf(path, sides.theirs) ?? featureOf(path, sides.base);
      const topic = feature === null ? path : featureAddress(feature.id);
      inspection.asks.push(askOf(facts, 'same-feature', topic, path, path, { agentMergeable: true }));
      continue;
    }
    const knowledgeClass = classifyKnowledgePath(path, { root: 'workspace' });
    if (knowledgeClass === 'append-only' && sides.ours !== null && sides.theirs !== null) {
      const attribute = hasUnionAttribute(git, repo, path);
      const current = isConflict ? null : workingText(repo, path);
      const expected = unionLines(sides.ours, sides.theirs, sides.base);
      // Complete = exactly the expected lines: every addition, and no line removed since the base.
      const complete = current !== null && sameLines(current, expected);
      const content = complete ? null : expected;
      const lines = contentLines(complete ? current : content).length;
      inspection.resolutions.push({ kind: 'union', path, attribute: attribute && complete, content, lines });
      continue;
    }
    if (path === 'workspace.json') {
      const merged = mergeWorkspaceFile(sides.base, sides.ours, sides.theirs);
      if (merged !== null) {
        inspection.resolutions.push({ kind: 'workspace-file', path, content: merged });
      } else {
        inspection.reviews.push(reviewOf(facts, path, sides));
      }
      continue;
    }
    const discovery = DISCOVERY_PATH.exec(path);
    if (isConflict && discovery !== null) {
      inspection.asks.push(askOf(facts, 'same-discovery', `${discovery[1]}/discovery ${discovery[2]}`, path, path, { agentMergeable: true }));
      continue;
    }
    if (isConflict) {
      inspection.reviews.push(reviewOf(facts, path, sides));
      continue;
    }
    inspection.resolutions.push({ kind: 'line-merge', path });
  }

  // ── Pass 3: collisions across two different files. ──
  const asked = new Set(inspection.asks.map((ask) => `${ask.path}\0${ask.existingPath}`));
  const pushAsk = (
    kind: AskKind,
    topic: string,
    path: string,
    existingPath: string,
    extra: { anchors?: string[]; agentMergeable?: boolean } = {}
  ): void => {
    const key = `${path}\0${existingPath}`;
    if (asked.has(key)) return;
    asked.add(key);
    inspection.asks.push(askOf(facts, kind, topic, path, existingPath, extra));
  };

  const edited = (changed: Map<string, Status>): string[] =>
    [...changed.entries()].filter(([, status]) => status === 'A' || status === 'M').map(([path]) => path);

  // Features: one id claimed by two files, or the same anchor newly claimed by two features.
  const ourFeatures = edited(oursChanged).filter((path) => FEATURE_PATH.test(path));
  const theirFeatures = edited(theirsChanged).filter((path) => FEATURE_PATH.test(path));
  for (const ourPath of ourFeatures) {
    const ourText = textAt(git, repo, facts.ours, ourPath);
    const ours = featureOf(ourPath, ourText);
    if (ours === null) continue;
    const ourNew = anchorsAdded(ourText, textAt(git, repo, facts.base, ourPath), ourPath);
    for (const theirPath of theirFeatures) {
      if (theirPath === ourPath) continue;
      if (FEATURE_PATH.exec(theirPath)?.[1] !== FEATURE_PATH.exec(ourPath)?.[1]) continue;
      const theirText = textAt(git, repo, facts.theirs, theirPath);
      const theirs = featureOf(theirPath, theirText);
      if (theirs === null) continue;
      if (theirs.id === ours.id) {
        pushAsk('same-feature', featureAddress(ours.id), ourPath, theirPath);
        continue;
      }
      const theirNew = new Set(anchorsAdded(theirText, textAt(git, repo, facts.base, theirPath), theirPath));
      const overlap = ourNew.filter((anchor) => theirNew.has(anchor));
      if (overlap.length > 0) {
        const project = FEATURE_PATH.exec(ourPath)?.[1] ?? '';
        pushAsk('overlapping-anchors', `${project}: ${overlap.join(', ')}`, ourPath, theirPath, { anchors: overlap });
      }
    }
  }

  // Discoveries: one slug changed on both sides, at least one side EDITING a version.
  const discoveries = (changed: Map<string, Status>): { path: string; key: string; status: Status }[] =>
    edited(changed).flatMap((path) => {
      const match = DISCOVERY_PATH.exec(path);
      return match === null ? [] : [{ path, key: `${match[1]}\0${match[2]}`, status: changed.get(path) as Status }];
    });
  const theirDiscoveries = discoveries(theirsChanged);
  for (const ours of discoveries(oursChanged)) {
    if (handled.has(ours.path)) continue;
    for (const theirs of theirDiscoveries) {
      if (theirs.key !== ours.key || theirs.path === ours.path || handled.has(theirs.path)) continue;
      if (ours.status === 'A' && theirs.status === 'A') continue; // two new versions — both kept
      const [project, slug] = ours.key.split('\0');
      pushAsk('same-discovery', `${project}/discovery ${slug}`, ours.path, theirs.path, { agentMergeable: true });
    }
  }

  return inspection;
}

// ─── Applying ───────────────────────────────────────────────────────────────

function writeOrRemove(repo: string, path: string, text: string | null): void {
  const full = join(repo, path);
  if (text === null) {
    rmSync(full, { force: true });
    return;
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf-8');
}

function stage(git: WorkspaceGit, repo: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  git(['add', '-A', '--', ...paths], repo);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nextFreeVersion(facts: MergeFacts, family: VersionedName, taken: ReadonlySet<string>): number {
  const { git, repo } = facts;
  const pattern = new RegExp(`^${escapeRegex(family.stem)}_v(\\d+)\\.md$`);
  let highest = family.version;
  const names = new Set<string>();
  for (const rev of [facts.ours, facts.theirs]) {
    for (const entry of splitZ(attempt(git, ['ls-tree', '--name-only', '-z', rev, '--', family.dir], repo))) {
      names.add(entry.slice(family.dir.length));
    }
  }
  for (const name of names) {
    const match = pattern.exec(name);
    if (match !== null) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  for (let version = highest + 1; ; version += 1) {
    const candidate = versionedPath(family, version);
    if (!taken.has(candidate) && !existsSync(join(repo, candidate))) return version;
  }
}

/** One renumbered stem: `discovery_x_v1` → `discovery_x_v2`. */
interface StemRename {
  from: string;
  to: string;
}

/**
 * Replace whole-name references (`discovery_x_v1`, never `discovery_x_v10`)
 * for EVERY rename at once — one pass, so two renames never rewrite each
 * other's output. Returns the text and which renames it applied.
 */
function replaceReferences(text: string, renames: readonly StemRename[]): { text: string; applied: Set<string> } {
  const applied = new Set<string>();
  if (renames.length === 0) return { text, applied };
  const byFrom = new Map(renames.map((rename) => [rename.from, rename.to]));
  const alternation = [...byFrom.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
  const out = text.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})(?![0-9])`, 'g'), (match) => {
    applied.add(match);
    return byFrom.get(match) ?? match;
  });
  return { text: out, applied };
}

type PlannedRenumber = Extract<PlannedResolution, { kind: 'renumber' }>;

/**
 * Every renumber of one merge, TOGETHER: versions are chosen first (two
 * collisions in one family never take the same free version), then each
 * renamed document and its feature view are written with every rename
 * applied, then every file only this machine changed is rewritten once.
 * Applying them one at a time left the first renamed document naming the
 * second one's old version.
 */
function applyRenumbers(facts: MergeFacts, planned: readonly PlannedRenumber[]): MergeResolution[] {
  const { git, repo, oursChanged, theirsChanged } = facts;
  const taken = new Set<string>();
  const plans = planned.map((entry) => {
    const version = nextFreeVersion(facts, entry.family, taken);
    const renamedTo = versionedPath(entry.family, version);
    taken.add(renamedTo);
    return { entry, renamedTo, rename: { from: `${entry.family.stem}_v${entry.family.version}`, to: `${entry.family.stem}_v${version}` } };
  });
  const renames = plans.map((plan) => plan.rename);
  const touched: string[] = [];
  const skip = new Set<string>();

  const results = plans.map(({ entry, renamedTo }) => {
    // Theirs keeps the name; ours moves to the next free version.
    writeOrRemove(repo, entry.path, entry.theirs);
    writeOrRemove(repo, renamedTo, replaceReferences(entry.ours, renames).text);
    touched.push(entry.path, renamedTo);
    skip.add(entry.path).add(renamedTo);
    let walkthrough: { from: string; to: string } | null = null;
    if (entry.walkthrough !== null) {
      const ourPage = textAt(git, repo, facts.ours, entry.walkthrough);
      const theirPage = textAt(git, repo, facts.theirs, entry.walkthrough);
      const to = walkthroughOf(renamedTo);
      writeOrRemove(repo, to, ourPage === null ? null : replaceReferences(ourPage, renames).text);
      // Their page (if they wrote one) stays beside their document; ours never does.
      writeOrRemove(repo, entry.walkthrough, theirPage);
      touched.push(entry.walkthrough, to);
      skip.add(entry.walkthrough).add(to);
      walkthrough = { from: entry.walkthrough, to };
    }
    return { kind: 'renumber' as const, path: entry.path, renamedTo, walkthrough, referencesUpdated: [] as string[], referencesNotUpdated: [] as string[] };
  });

  for (const [path, status] of oursChanged) {
    if (skip.has(path) || (status !== 'A' && status !== 'M') || !REFERENCE_EXTENSIONS.test(path)) continue;
    if (classifyKnowledgePath(path, { root: 'workspace' }) !== 'authored') continue;
    const ourText = textAt(git, repo, facts.ours, path);
    if (ourText === null) continue;
    const mentioned = replaceReferences(ourText, renames).applied;
    if (mentioned.size === 0) continue;
    const owners = plans.flatMap((plan, index) => (mentioned.has(plan.rename.from) ? [index] : []));
    if (theirsChanged.has(path)) {
      // Merged with the Workspace's own edits — its mentions mean ITS documents.
      for (const index of owners) results[index].referencesNotUpdated.push(path);
      continue;
    }
    const current = workingText(repo, path);
    if (current === null) continue;
    writeOrRemove(repo, path, replaceReferences(current, renames).text);
    touched.push(path);
    for (const index of owners) results[index].referencesUpdated.push(path);
  }
  stage(git, repo, touched);
  return results;
}

/** Apply every safe resolution. Returns what was done, as the result reports it. */
export function applyResolutions(facts: MergeFacts, planned: readonly PlannedResolution[]): MergeResolution[] {
  const { git, repo } = facts;
  const renumbered = applyRenumbers(
    facts,
    planned.filter((resolution): resolution is PlannedRenumber => resolution.kind === 'renumber')
  );
  const done: MergeResolution[] = [];
  let next = 0;
  for (const resolution of planned) {
    switch (resolution.kind) {
      case 'union':
        if (resolution.content !== null) {
          writeOrRemove(repo, resolution.path, resolution.content);
          stage(git, repo, [resolution.path]);
        }
        done.push({ kind: 'union', path: resolution.path, attribute: resolution.attribute, lines: resolution.lines });
        break;
      case 'renumber':
        done.push(renumbered[next]);
        next += 1;
        break;
      case 'workspace-file':
        writeOrRemove(repo, resolution.path, resolution.content);
        stage(git, repo, [resolution.path]);
        done.push({ kind: 'workspace-file', path: resolution.path });
        break;
      case 'line-merge':
        done.push({ kind: 'line-merge', path: resolution.path });
        break;
      case 'feature-rules':
        break; // after every other resolution — see below
    }
  }
  // Feature settlements last: their stale lines append to a status log a
  // union resolution above may just have written.
  for (const resolution of planned) {
    if (resolution.kind !== 'feature-rules') continue;
    if (resolution.content !== null) {
      writeOrRemove(repo, resolution.path, resolution.content);
      stage(git, repo, [resolution.path]);
    }
    const logs = new Set<string>();
    for (const { projectDir, entry } of resolution.stale) {
      appendKnowledgeStatus(join(repo, projectDir), entry);
      logs.add(`${projectDir}/${STRUCTURE_DIR}/${KNOWLEDGE_STATUS_FILENAME}`);
    }
    stage(git, repo, [...logs]);
    done.push({ kind: 'feature-rules', path: resolution.path, rule: resolution.rule, dropped: resolution.dropped, stale: resolution.stale.length });
  }
  return done;
}

/** What `take` puts at the item's path. */
function decidedText(facts: MergeFacts, item: SyncAsk | SyncReview, decision: StoredDecision): string | null {
  switch (decision.take) {
    case 'ours':
      return textAt(facts.git, facts.repo, facts.ours, item.path);
    case 'theirs':
      return textAt(facts.git, facts.repo, facts.theirs, item.path);
    case 'merged':
      return workingText(facts.repo, item.path);
    case 'file':
      return decision.content ?? '';
  }
}

/** Apply a person's decisions to the merge in progress. */
export function applyDecisions(
  facts: MergeFacts,
  items: readonly (SyncAsk | SyncReview)[],
  decisions: ReadonlyMap<string, StoredDecision>
): MergeResolution[] {
  const done: MergeResolution[] = [];
  for (const item of items) {
    const decision = decisions.get(item.id);
    if (decision === undefined) continue;
    writeOrRemove(facts.repo, item.path, decidedText(facts, item, decision));
    stage(facts.git, facts.repo, [item.path]);
    done.push({ kind: 'decision', path: item.path, take: decision.take, item: item.id });
  }
  return done;
}

// ─── The decision store (inside .git, never committed) ─────────────────────

function decisionsFile(git: WorkspaceGit, repo: string): string {
  return resolve(repo, git(['rev-parse', '--git-path', SYNC_DECISIONS_GIT_PATH], repo).trim());
}

export function readDecisions(git: WorkspaceGit, repo: string): StoredDecision[] {
  const path = decisionsFile(git, repo);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { decisions?: unknown };
    if (!Array.isArray(parsed.decisions)) return [];
    return parsed.decisions.filter(
      (entry): entry is StoredDecision =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as StoredDecision).id === 'string' &&
        typeof (entry as StoredDecision).path === 'string' &&
        ['ours', 'theirs', 'merged', 'file'].includes((entry as StoredDecision).take)
    );
  } catch {
    // A damaged store only means every question is put again — never a wrong answer.
    return [];
  }
}

export function writeDecisions(git: WorkspaceGit, repo: string, decisions: readonly StoredDecision[]): void {
  const path = decisionsFile(git, repo);
  if (decisions.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFile(path, `${JSON.stringify({ version: 1, decisions }, null, 2)}\n`);
}

// ─── The audit (merges/) ────────────────────────────────────────────────────

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const mark = '`'.repeat(longest + 1);
  return `${mark}\n${text.endsWith('\n') ? text : `${text}\n`}${mark}`;
}

function sideBlock(title: string, text: string | null, blob: string | null): string {
  if (text === null) return `### ${title}\n\n_No such file on this side._\n`;
  const shown = cut(text);
  const note = shown.truncated ? `\n_Cut at ${MAX_PAYLOAD_TEXT} characters — the full text is blob ${blob ?? 'unknown'}._\n` : '';
  return `### ${title}${blob === null ? '' : ` (blob ${blob.slice(0, 12)})`}\n\n${fence(shown.text as string)}\n${note}`;
}

function describeResolution(resolution: MergeResolution): string {
  switch (resolution.kind) {
    case 'union':
      return `Append-only store changed on both sides — every line of both kept (${resolution.lines} lines${resolution.attribute ? ', by merge=union' : ', united by Flow because merge=union did not take'}).`;
    case 'renumber': {
      const page = resolution.walkthrough === null ? '' : ` Its artifact moved to ${resolution.walkthrough.to}.`;
      const refs = resolution.referencesUpdated.length === 0 ? '' : ` References updated in: ${resolution.referencesUpdated.join(', ')}.`;
      const stale =
        resolution.referencesNotUpdated.length === 0
          ? ''
          : ` Still naming the old version (changed in the Workspace too): ${resolution.referencesNotUpdated.join(', ')}.`;
      return `The same new document was created on both sides. The Workspace's keeps the name; this machine's is now ${resolution.renamedTo}.${page}${refs}${stale}`;
    }
    case 'workspace-file':
      return 'The Workspace description changed on both sides in different fields or projects — both changes kept.';
    case 'line-merge':
      return 'Edited on both sides in different places — git merged the two without a conflict.';
    case 'feature-rules':
      switch (resolution.rule) {
        case 'clean':
          return 'A feature note edited on both sides in different places — git merged the two without a conflict, and Flow accepted it.';
        case 'union':
          return 'A feature note whose learnings were edited on both sides — every learning of both kept (a draft is never dropped).';
        case 'newer-wins':
          return `A feature note whose learnings were edited on both sides — where both versions of one learning were on the default branch, the one learned from the newer commit was kept (${resolution.dropped} older line(s) left out).`;
        case 'kept-both-stale':
          return `A feature note whose learnings were edited on both sides — two versions of one learning could not be ordered, so both were kept and ${resolution.stale} marked to be learned again.`;
      }
      return '';
    case 'decision':
      return `Decided by a person: ${resolution.take === 'file' ? 'a merged text they gave' : resolution.take === 'merged' ? "git's clean merge" : resolution.take === 'ours' ? "this machine's version" : "the Workspace's version"}.`;
  }
}

/**
 * Write `merges/<YYYY-MM-DD>-<id>.md` — every resolution with both sides — and
 * return its Workspace-relative path. Null when there was nothing to record.
 */
export function writeMergeLog(
  facts: MergeFacts,
  resolutions: readonly MergeResolution[],
  context: { now: Date; remoteRef: string }
): string | null {
  if (resolutions.length === 0) return null;
  const { git, repo } = facts;
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${context.now.getFullYear()}-${pad(context.now.getMonth() + 1)}-${pad(context.now.getDate())}`;
  const id = createHash('sha1').update(`${facts.ours}\0${facts.theirs}`).digest('hex').slice(0, 8);
  let name = `${MERGES_DIRNAME}/${date}-${id}.md`;
  for (let n = 2; existsSync(join(repo, name)); n += 1) name = `${MERGES_DIRNAME}/${date}-${id}-${n}.md`;

  const parts: string[] = [
    `# Merge — ${date}`,
    '',
    `- This machine: ${facts.ours.slice(0, 12)}`,
    `- The Workspace: ${context.remoteRef} @ ${facts.theirs.slice(0, 12)}`,
    `- Common ancestor: ${facts.base.slice(0, 12)}`,
    '',
  ];
  resolutions.forEach((resolution, index) => {
    parts.push(`## ${index + 1}. ${resolution.kind} — ${resolution.path}`, '', describeResolution(resolution), '');
    parts.push(sideBlock('This machine', textAt(git, repo, facts.ours, resolution.path), blobAt(git, repo, facts.ours, resolution.path)));
    parts.push(sideBlock('The Workspace', textAt(git, repo, facts.theirs, resolution.path), blobAt(git, repo, facts.theirs, resolution.path)));
  });
  writeOrRemove(repo, name, `${parts.join('\n')}\n`);
  stage(git, repo, [name]);
  return name;
}
