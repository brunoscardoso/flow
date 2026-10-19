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
 *   asks         a person decides — the merge is aborted until they have:
 *                  decision             a decision note touched on both sides — ALWAYS
 *                  same-feature         the same namespaced feature id edited on both
 *                                       sides (one file, or two files claiming one id)
 *                  overlapping-anchors  two features newly claiming the same anchor
 *                  same-discovery       one discovery slug changed on both sides where
 *                                       at least one side EDITED an existing version
 *                                       (or both edited one version and git conflicted)
 *   reviews      any other authored file git could not merge (conflict markers,
 *                modify/delete) — both versions and the base are handed back so an
 *                agent can draft the merge.
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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { featureAddress, featureExclusion, mintFeatureId, parseFeatureFile, parseFeatureId } from '../blueprint/feature-store.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { classifyKnowledgePath } from './knowledge-classes.js';
import { workspaceFileProblem, type WorkspaceGit } from './workspace-model.js';

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
  | { kind: 'decision'; path: string; take: Take; item: string };

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
  | { kind: 'line-merge'; path: string };

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
    const picked = pick3(base[key], ours[key], theirs[key]);
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
  extra: { anchors?: string[] } = {}
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
    truncated: existing.truncated || incoming.truncated || merged.truncated,
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
      inspection.asks.push(askOf(facts, 'decision', decisionTopic(path), path, path));
      continue;
    }
    if (isFeaturePath(path, [sides.ours, sides.theirs, sides.base])) {
      const feature = featureOf(path, sides.ours) ?? featureOf(path, sides.theirs) ?? featureOf(path, sides.base);
      const topic = feature === null ? path : featureAddress(feature.id);
      inspection.asks.push(askOf(facts, 'same-feature', topic, path, path));
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
      inspection.asks.push(askOf(facts, 'same-discovery', `${discovery[1]}/discovery ${discovery[2]}`, path, path));
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
  const pushAsk = (kind: AskKind, topic: string, path: string, existingPath: string, extra: { anchors?: string[] } = {}): void => {
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
      pushAsk('same-discovery', `${project}/discovery ${slug}`, ours.path, theirs.path);
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
    }
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
