/**
 * The saved-answer log of "Ask the Blueprint": `<flowDir>/brain/.structure/qa.jsonl`.
 *
 * TWO DRAWERS, ONE WRITER EACH. Code facts an answer discovers go through
 * `blueprint observe` (the investigation store). The question, the answer, its
 * verdict, a teammate's reply and its follow-ups go HERE, through
 * `appendQaEntry` — the only function that writes this file, reached only via
 * `planflow-ai blueprint qa record | follow-up` (allowed-pattern #14). An agent
 * never writes either drawer directly.
 *
 * WHAT IS NEVER STORED. The log is shared knowledge (it syncs append-only with
 * a Workspace), so nothing from a personal conversation may land in it — only
 * THAT one was used (`usedConversation`) and how many (`conversationCount`).
 * The writer is strict: an unknown key is refused, and a key that looks like
 * conversation content (`conversation`, `messages`, …) is refused by name, so
 * a caller cannot smuggle a transcript in under a field nobody reads.
 *
 * FILE-BACKED SOURCES ARE STAMPED. Every source naming a file is hashed with
 * `hashRepoFile` — the same code path `observe` stamps with and `stale-check`
 * re-hashes with — so `qaStaleness` can say when the code under an answer
 * moved. The caller never supplies a stamp.
 *
 * Readers never throw: a missing file reads empty, a corrupt line is skipped,
 * and a union-merge twin (the same id twice) keeps its first occurrence.
 */

import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireGraphLock, BLUEPRINT_DIRNAME, ensureBlueprintDir, hashRepoFile, readJsonlLines } from './store.js';
import {
  addressPartNames,
  featureNamespace,
  findFeatureByRef,
  parseFeatureId,
  readFeatures,
  readParts,
  sameFeatureId,
  type FeatureNode,
} from './feature-store.js';
import {
  WorkspaceRefusal,
  workspaceStatus,
  type ProjectView,
  type WorkspaceContext,
} from '../handlers/workspace-model.js';
import type {
  QaEntry,
  QaPointerEntry,
  QaRecordInput,
  QaSource,
  QaStaleness,
  QaThread,
  QaVerdict,
  WorkspaceQaEntry,
  WorkspaceQaProject,
  WorkspaceQaProjects,
  WorkspaceQaRecordInput,
  WorkspaceQaStaleness,
  WorkspaceQaThread,
} from './types.js';

const QA_FILENAME = 'qa.jsonl';
const QA_LOCK_FILENAME = 'qa.lock';

/**
 * A feature or part id: `feature:<slug>`, `feature:<slug>/<part>`, optionally
 * namespaced by a Workspace project as `feature:<project>::<slug>[/<part>]`.
 * Slugs follow `slugifyFeatureName` (`[a-z0-9]` runs joined by `-`); a project
 * is its folder name, which may carry `.`/`_` and capitals but never `/`.
 */
const FEATURE_TAG_PATTERN =
  /^feature:(?:([A-Za-z0-9._-]+)::)?([a-z0-9]+(?:-[a-z0-9]+)*)(?:\/([a-z0-9]+(?:-[a-z0-9]+)*))?$/;

/** Keys the caller may send at the top level. Everything else is refused. */
const INPUT_KEYS = new Set<string>([
  'author',
  'question',
  'tags',
  'conversationCount',
  'usedConversation',
  'answer',
  'verdict',
  'reply',
  'sources',
  'factsLearned',
  'parentId',
  'partial',
  'branchInProgress',
]);

/** Keys the writer mints; a caller sending one is refused under its own reason. */
const WRITER_OWNED_KEYS = new Set<string>(['id', 'ts']);

/**
 * Keys that would carry what was SAID in a personal conversation. Refused by
 * name (reason `conversation-content`), ahead of the generic unknown-key rule,
 * so the refusal tells the caller exactly why.
 */
const CONVERSATION_KEY_PATTERN = /^(conversation|conversations|conversationtext|conversationid|transcript|messages|message|chat|chathistory|thread|threadtext|history|excerpt|quote|quotes)$/i;

const VERDICT_KEYS = new Set<string>(['label', 'risk']);
const SOURCE_KEYS = new Set<string>(['label', 'featureId', 'file']);

/** Why a write was refused: a reason code, the field(s) at fault, one sentence. */
export class QaRefusal extends Error {
  readonly reason: string;
  readonly field: string | string[] | null;
  readonly sentence: string;

  constructor(reason: string, field: string | string[] | null, sentence: string) {
    super(`${reason} — ${sentence}`);
    this.name = 'QaRefusal';
    this.reason = reason;
    this.field = field;
    this.sentence = sentence;
  }

  /** The JSON payload printed ahead of the refusal line (allowed-pattern #21). */
  get payload(): Record<string, unknown> {
    return { refused: this.reason, field: this.field, detail: this.sentence };
  }
}

/** Absolute path of the log for a repo. */
function qaPath(repoRoot: string): string {
  return join(repoRoot, 'flow', BLUEPRINT_DIRNAME, QA_FILENAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Refuse unknown / conversation / writer-owned keys of one object, all at once. */
function refuseStrayKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, prefix: string): void {
  const keys = Object.keys(record);
  const conversation = keys.filter((key) => CONVERSATION_KEY_PATTERN.test(key));
  if (conversation.length > 0) {
    throw new QaRefusal(
      'conversation-content',
      conversation.map((key) => `${prefix}${key}`),
      'the log stores only that a conversation was used (usedConversation, conversationCount), never what was said',
    );
  }
  const owned = prefix === '' ? keys.filter((key) => WRITER_OWNED_KEYS.has(key)) : [];
  if (owned.length > 0) {
    throw new QaRefusal('writer-owned', owned, 'the id and timestamp are minted by the writer, never supplied');
  }
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new QaRefusal(
      'unknown-field',
      unknown.map((key) => `${prefix}${key}`),
      `the saved-answer record has no such field — expected only ${[...allowed].join(', ')}`,
    );
  }
}

// ── The feature graph (existence checks, fail-soft) ─────────────────────────

/** What the writer can check tags against. `null` = no graph to check against. */
interface FeatureIndex {
  features: FeatureNode[];
  namespace: string | null;
  flowDir: string;
}

function readFeatureIndex(repoRoot: string): FeatureIndex | null {
  return readFeatureIndexAt(join(repoRoot, 'flow'));
}

function readFeatureIndexAt(flowDir: string, namespace?: string): FeatureIndex | null {
  try {
    const features = readFeatures(flowDir);
    if (features.length === 0) return null;
    return { features, namespace: namespace ?? featureNamespace(flowDir), flowDir };
  } catch {
    // Sanctioned fail-soft: no readable feature graph — grammar is still checked,
    // existence is not (the plan's rule: qa never refuses for a missing graph).
    return null;
  }
}

/**
 * Check one feature/part id: grammar always, existence when a graph can be
 * read. Returns the id to store — the known id it resolved to when one did, so
 * the short and namespaced forms of one feature are saved the same way.
 */
function checkFeatureRef(value: unknown, field: string, index: FeatureIndex | null): string {
  if (typeof value !== 'string' || !FEATURE_TAG_PATTERN.test(value)) {
    throw new QaRefusal(
      'bad-tag',
      field,
      `'${String(value)}' is not a feature or part id — expected feature:<slug> or feature:<slug>/<part>`,
    );
  }
  if (index === null) return value;
  const match = FEATURE_TAG_PATTERN.exec(value);
  const project = match?.[1];
  // Another project's feature cannot be checked from this checkout.
  if (project !== undefined && index.namespace !== null && project !== index.namespace) return value;
  if (project !== undefined && index.namespace === null) return value;

  const featurePart = match?.[3];
  const featureRef = featurePart === undefined ? value : value.slice(0, value.length - featurePart.length - 1);
  const feature = index.features.find((node) => sameFeatureId(node.id, featureRef));
  if (feature === undefined) {
    throw new QaRefusal('unknown-tag', field, `no feature '${featureRef}' on the Blueprint`);
  }
  if (feature.kind === 'child') {
    throw new QaRefusal('unknown-tag', field, `'${featureRef}' is a change record, not a feature — tag the feature it changed`);
  }
  if (featurePart === undefined) return feature.id;
  let partNames: string[] = [];
  try {
    partNames = readParts(index.flowDir, feature.slug)
      .map((part) => part.name)
      .filter((name) => name.trim().length > 0);
  } catch {
    // Sanctioned fail-soft: unreadable parts section — treated as no parts
    partNames = [];
  }
  const partId = `${feature.id}/${featurePart}`;
  if (!addressPartNames(feature.id, partNames).includes(partId)) {
    throw new QaRefusal('unknown-tag', field, `feature '${feature.id}' has no part '${featurePart}'`);
  }
  return partId;
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateVerdict(value: unknown): QaVerdict {
  if (!isPlainObject(value)) {
    throw new QaRefusal('bad-field', 'verdict', 'verdict must be an object with a label and an optional risk');
  }
  refuseStrayKeys(value, VERDICT_KEYS, 'verdict.');
  if (!nonEmptyString(value.label)) {
    throw new QaRefusal('bad-field', 'verdict.label', 'a verdict needs a label, e.g. "Yes · medium effort"');
  }
  if (value.risk !== undefined && !nonEmptyString(value.risk)) {
    throw new QaRefusal('bad-field', 'verdict.risk', 'a verdict risk, when given, is one non-empty sentence');
  }
  return { label: value.label.trim(), ...(value.risk !== undefined ? { risk: (value.risk as string).trim() } : {}) };
}

function validateSource(value: unknown, at: number, repoRoot: string, index: FeatureIndex | null): QaSource {
  const field = `sources[${at}]`;
  if (!isPlainObject(value)) {
    throw new QaRefusal('bad-field', field, 'a source is an object with a label, and optionally a featureId and a file');
  }
  if ('hashStamp' in value) {
    throw new QaRefusal('writer-owned', `${field}.hashStamp`, 'a source file is stamped by the writer, never by the caller');
  }
  refuseStrayKeys(value, SOURCE_KEYS, `${field}.`);
  if (!nonEmptyString(value.label)) {
    throw new QaRefusal('bad-field', `${field}.label`, 'every source needs a label the reader can see');
  }
  const source: QaSource = { label: value.label.trim() };
  if (value.featureId !== undefined) {
    source.featureId = checkFeatureRef(value.featureId, `${field}.featureId`, index);
  }
  if (value.file !== undefined) {
    if (!nonEmptyString(value.file)) {
      throw new QaRefusal('bad-field', `${field}.file`, 'a source file is a repo-relative path');
    }
    const file = value.file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    const hashed = hashRepoFile(repoRoot, file);
    if (hashed.status === 'escapes') {
      throw new QaRefusal('bad-source', `${field}.file`, `'${file}' is outside the repository`);
    }
    if (hashed.status === 'missing') {
      throw new QaRefusal('bad-source', `${field}.file`, `'${file}' does not exist in this checkout — an answer can only cite code that is here`);
    }
    source.file = file;
    source.hashStamp = { ref: file, contentHash: hashed.contentHash };
  }
  return source;
}

function nonNegativeInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new QaRefusal('bad-field', field, `${field} is a whole number, zero or more`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new QaRefusal('bad-field', field, `${field} is true or false`);
  }
  return value;
}

function mintId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `qa-${stamp}-${randomBytes(3).toString('hex')}`;
}

/**
 * Validate `input` and build the entry to write. Throws `QaRefusal` on the
 * first problem — nothing is written before every check has passed.
 */
function buildEntry(repoRoot: string, input: unknown, now: Date): QaEntry {
  if (!isPlainObject(input)) {
    throw new QaRefusal('bad-input', null, 'the input is one JSON object');
  }
  refuseStrayKeys(input, INPUT_KEYS, '');

  if (!nonEmptyString(input.author)) throw new QaRefusal('bad-field', 'author', 'every saved answer names who asked');
  if (!nonEmptyString(input.question)) throw new QaRefusal('bad-field', 'question', 'the question is required');
  if (!nonEmptyString(input.answer)) throw new QaRefusal('bad-field', 'answer', 'the answer is required');

  const usedConversation = optionalBoolean(input.usedConversation, 'usedConversation', false);
  const conversationCount = nonNegativeInteger(input.conversationCount, 'conversationCount', 0);
  if (usedConversation !== conversationCount > 0) {
    throw new QaRefusal(
      'bad-field',
      ['usedConversation', 'conversationCount'],
      'usedConversation is true exactly when conversationCount is more than zero',
    );
  }

  const index = readFeatureIndex(repoRoot);

  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new QaRefusal('bad-field', 'tags', 'tags is a list of feature or part ids');
  }
  const tags: string[] = [];
  for (const [at, tag] of ((input.tags as unknown[] | undefined) ?? []).entries()) {
    const id = checkFeatureRef(tag, `tags[${at}]`, index);
    if (!tags.includes(id)) tags.push(id);
  }

  if (input.sources !== undefined && !Array.isArray(input.sources)) {
    throw new QaRefusal('bad-field', 'sources', 'sources is a list of {label, featureId?, file?}');
  }
  const sources = ((input.sources as unknown[] | undefined) ?? []).map((source, at) =>
    validateSource(source, at, repoRoot, index),
  );

  const entry: QaEntry = {
    id: mintId(now),
    ts: now.toISOString(),
    author: input.author.trim(),
    question: input.question.trim(),
    tags,
    conversationCount,
    usedConversation,
    answer: input.answer.trim(),
    sources,
    factsLearned: nonNegativeInteger(input.factsLearned, 'factsLearned', 0),
    partial: optionalBoolean(input.partial, 'partial', false),
  };
  if (input.verdict !== undefined) entry.verdict = validateVerdict(input.verdict);
  if (input.reply !== undefined) {
    if (!nonEmptyString(input.reply)) throw new QaRefusal('bad-field', 'reply', 'a reply, when given, is non-empty text');
    entry.reply = input.reply.trim();
  }
  if (input.branchInProgress !== undefined) {
    if (!nonEmptyString(input.branchInProgress)) {
      throw new QaRefusal('bad-field', 'branchInProgress', 'branchInProgress, when given, names the branch the work is on');
    }
    entry.branchInProgress = input.branchInProgress.trim();
  }
  if (input.parentId !== undefined) {
    if (!nonEmptyString(input.parentId)) {
      throw new QaRefusal('bad-field', 'parentId', 'a follow-up names the id of the entry it follows');
    }
    const parentId = input.parentId.trim();
    if (!readQaEntries(repoRoot).some((existing) => existing.id === parentId)) {
      throw new QaRefusal('unknown-parent', 'parentId', `no saved answer '${parentId}' to follow up on`);
    }
    entry.parentId = parentId;
  }
  return entry;
}

/**
 * THE ONLY WRITER of `qa.jsonl`. Validates `input` (strict keys, no
 * conversation content, tags against the feature graph when one can be read),
 * stamps every file-backed source with its content hash, and appends one line
 * under the log's own lock. A follow-up (`parentId` set) appends a line naming
 * its parent. Throws `QaRefusal` with nothing written on any problem.
 */
export function appendQaEntry(repoRoot: string, input: QaRecordInput, now: Date = new Date()): QaEntry {
  const entry = buildEntry(repoRoot, input, now);
  const blueprintDir = ensureBlueprintDir(join(repoRoot, 'flow'));
  const lockPath = join(blueprintDir, QA_LOCK_FILENAME);
  if (!acquireGraphLock(lockPath)) {
    throw new QaRefusal('busy', null, 'the saved-answer log is being written by another process — retry');
  }
  try {
    appendFileSync(join(blueprintDir, QA_FILENAME), `${JSON.stringify(entry)}\n`, 'utf-8');
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (e.g. reclaimed as stale) — nothing to clean up
    }
  }
  return entry;
}

// ── Readers ──────────────────────────────────────────────────────────────────

function parseStamp(value: unknown): QaSource['hashStamp'] | undefined {
  if (!isPlainObject(value)) return undefined;
  return nonEmptyString(value.ref) && typeof value.contentHash === 'string'
    ? { ref: value.ref, contentHash: value.contentHash }
    : undefined;
}

function parseSources(raw: unknown): QaSource[] {
  const sources: QaSource[] = [];
  if (!Array.isArray(raw)) return sources;
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.label !== 'string') continue;
    const source: QaSource = { label: item.label };
    if (typeof item.featureId === 'string') source.featureId = item.featureId;
    if (typeof item.file === 'string') source.file = item.file;
    const stamp = parseStamp(item.hashStamp);
    if (stamp !== undefined) source.hashStamp = stamp;
    if (typeof item.project === 'string') source.project = item.project;
    sources.push(source);
  }
  return sources;
}

/**
 * A Workspace answer's pointer, read as a thread entry of this project: the
 * question and this project's tags, an empty answer, and `workspaceAnswer`
 * naming where the rest lives. A pointer whose Workspace record has not been
 * pulled yet still lists — it never vanishes because the record is elsewhere.
 */
function parsePointer(record: Record<string, unknown>): QaEntry | null {
  if (!nonEmptyString(record.id) || typeof record.question !== 'string' || !nonEmptyString(record.workspace)) return null;
  const entry: QaEntry = {
    id: record.id,
    ts: typeof record.ts === 'string' ? record.ts : '',
    author: typeof record.author === 'string' ? record.author : '',
    question: record.question,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    conversationCount: 0,
    usedConversation: false,
    answer: '',
    sources: parseSources(record.sources),
    factsLearned: 0,
    partial: false,
    workspaceAnswer: { workspace: record.workspace, entryId: record.id },
  };
  if (typeof record.parentId === 'string') entry.parentId = record.parentId;
  return entry;
}

function parseEntry(record: Record<string, unknown>): QaEntry | null {
  if (record.kind === 'workspace-pointer') return parsePointer(record);
  if (!nonEmptyString(record.id) || typeof record.question !== 'string' || typeof record.answer !== 'string') return null;
  const sources = parseSources(record.sources);
  const entry: QaEntry = {
    id: record.id,
    ts: typeof record.ts === 'string' ? record.ts : '',
    author: typeof record.author === 'string' ? record.author : '',
    question: record.question,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    conversationCount: typeof record.conversationCount === 'number' ? record.conversationCount : 0,
    usedConversation: record.usedConversation === true,
    answer: record.answer,
    sources,
    factsLearned: typeof record.factsLearned === 'number' ? record.factsLearned : 0,
    partial: record.partial === true,
  };
  if (isPlainObject(record.verdict) && typeof record.verdict.label === 'string') {
    entry.verdict = {
      label: record.verdict.label,
      ...(typeof record.verdict.risk === 'string' ? { risk: record.verdict.risk } : {}),
    };
  }
  if (typeof record.reply === 'string') entry.reply = record.reply;
  if (typeof record.parentId === 'string') entry.parentId = record.parentId;
  if (typeof record.branchInProgress === 'string') entry.branchInProgress = record.branchInProgress;
  return entry;
}

/**
 * Every entry in the log, in file order. Corrupt lines are skipped; a
 * union-merge twin (the same id twice) keeps its first occurrence. Never throws.
 */
export function readQaEntries(repoRoot: string): QaEntry[] {
  const entries: QaEntry[] = [];
  const seen = new Set<string>();
  for (const line of readJsonlLines(qaPath(repoRoot))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: corrupt line — skip it rather than failing the whole read
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const entry = parseEntry(parsed);
    if (entry === null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

/**
 * Fold entries into threads: each root carries its follow-ups (follow-ups of
 * follow-ups attach to the same root), oldest first inside a thread; threads
 * newest first by their root's timestamp. A follow-up whose parent is not in
 * the log stands as its own thread — never dropped.
 */
export function foldQaEntries<T extends QaEntry>(entries: readonly T[]): Array<T & { followUps: T[] }> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rootOf = (entry: T): T => {
    let current = entry;
    const visited = new Set<string>([current.id]);
    while (current.parentId !== undefined) {
      const parent = byId.get(current.parentId);
      if (parent === undefined || visited.has(parent.id)) break;
      visited.add(parent.id);
      current = parent;
    }
    return current;
  };
  const threads = new Map<string, T & { followUps: T[] }>();
  for (const entry of entries) {
    const root = rootOf(entry);
    if (!threads.has(root.id)) threads.set(root.id, { ...root, followUps: [] });
    if (root.id !== entry.id) threads.get(root.id)?.followUps.push(entry);
  }
  const out = [...threads.values()];
  for (const thread of out) thread.followUps.sort((a, b) => a.ts.localeCompare(b.ts));
  return out.sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
}

/** The log folded into threads, newest first. Never throws. */
export function readQaThreads(repoRoot: string): QaThread[] {
  return foldQaEntries(readQaEntries(repoRoot));
}

/** Every feature/part id one entry touched: its tags and its sources' features. */
function touchedIds(entry: QaEntry): string[] {
  return [...entry.tags, ...entry.sources.flatMap((source) => (source.featureId === undefined ? [] : [source.featureId]))];
}

/** The feature id a part id belongs to (`feature:x/y` → `feature:x`), or the id itself. */
function owningFeature(id: string): string {
  const parsed = parseFeatureId(id);
  if (parsed === null) return id;
  const slash = id.lastIndexOf('/');
  return slash > id.indexOf(':') && parsed.slug.includes('/') ? id.slice(0, slash) : id;
}

/** Does a touched id pin an entry to the asked-for feature or part? */
function touches(touched: string, asked: string): boolean {
  if (sameFeatureId(touched, asked)) return true;
  // A part's parent feature also matches.
  return owningFeature(touched) !== touched && sameFeatureId(owningFeature(touched), asked);
}

/**
 * Resolve what the caller typed (`feature:x`, `x`, `feature:x/part`) to a
 * feature/part id. Uses the feature store when it can; otherwise prefixes.
 */
function resolveAskedFeature(repoRoot: string, featureId: string): string {
  if (featureId.startsWith('feature:')) return featureId;
  const index = readFeatureIndex(repoRoot);
  const found = index === null ? undefined : findFeatureByRef(index.features, featureId);
  return found?.id ?? `feature:${featureId}`;
}

/**
 * The threads pinned to one feature or part — an entry is pinned to every tag
 * AND every source feature/part it touched, and a part's parent feature also
 * matches. A thread is listed when its root or any follow-up touches it.
 */
export function listQaForFeature(repoRoot: string, featureId: string): QaThread[] {
  const asked = resolveAskedFeature(repoRoot, featureId.trim());
  return readQaThreads(repoRoot).filter((thread) =>
    [thread, ...thread.followUps].some((entry) => touchedIds(entry).some((id) => touches(id, asked))),
  );
}

/**
 * One answer per entry to "has the code under it changed?": every stamped
 * source file is re-hashed with `hashRepoFile` exactly as stale-check's
 * `evaluateNote` does — a changed digest is `changedFiles`, a gone or escaping
 * file is `missingFiles`, and a stamp with no file to re-hash is reported
 * missing rather than silently skipped. Read-only; never throws.
 */
export function qaStaleness(repoRoot: string, entries: readonly QaEntry[]): Map<string, QaStaleness> {
  const out = new Map<string, QaStaleness>();
  for (const entry of entries) {
    const changedFiles: string[] = [];
    const missingFiles: string[] = [];
    for (const source of entry.sources) {
      const stamp = source.hashStamp;
      if (stamp === undefined) continue;
      const relPath = source.file;
      if (relPath === undefined) {
        // Sanctioned fail-soft: a stamp with no backing file cannot be verified —
        // reported conservatively as missing (mirrors evaluateNote).
        missingFiles.push(stamp.ref);
        continue;
      }
      const result = hashRepoFile(repoRoot, relPath);
      if (result.status === 'missing' || result.status === 'escapes') {
        missingFiles.push(relPath);
        continue;
      }
      if (result.contentHash !== stamp.contentHash) changedFiles.push(relPath);
    }
    out.set(entry.id, {
      stale: changedFiles.length > 0 || missingFiles.length > 0,
      changedFiles,
      missingFiles,
    });
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// Ask the Blueprint at WORKSPACE level — `<workspace>/qa.jsonl`
// ════════════════════════════════════════════════════════════════════════════
//
// ONE WRITER, TWO STORES. A Workspace answer is saved once at the Workspace
// repository's root (`qa.jsonl`, beside `links.jsonl`, append-only — named in
// `WORKSPACE_ROOT_TABLE`), and a small pointer (`QaPointerEntry`) is appended
// to each cited LOCAL project's own `qa.jsonl`, so that project's Ask history
// and feature briefs list it. Both are written by `appendWorkspaceQaEntry`
// alone — reached only through `blueprint qa … --workspace` — every check
// decided before the first byte, and every append under its store's lock, so
// the record and its pointers never disagree (allowed-pattern #14).
//
// THE TAG GRAMMAR at Workspace level (every id names its project):
//
//   feature:<project>::<slug>            a feature of one project
//   feature:<project>::<slug>/<part>     a part of it
//   project:<project>                    a whole project
//   link:<project-a>::<project-b>        the connection between two projects
//                                        (one ribbon on the Workspace sheet);
//                                        stored with the two slugs sorted, so
//                                        `link:b::a` and `link:a::b` are one tag
//
// A bare `feature:<slug>` is refused (`unqualified-tag`): at Workspace level
// it could name a feature of any project. Feature tags are checked against
// that project's own feature notes — its checkout's `flow/` when it is on this
// computer, its shared copy under the Workspace repository's
// `projects/<slug>/` when it is not; when neither can be read, only the
// grammar is checked (the project rule: qa never refuses for a missing graph).
// Project and link tags must name projects of this Workspace; a link tag does
// not require a recorded link (a question may be about whether one exists).

const WORKSPACE_QA_FILENAME = 'qa.jsonl';
/** Inside the Workspace repository's `.git` — never tracked, never synced. */
const WORKSPACE_QA_LOCK_GIT_NAME = 'plan-flow-qa.lock';

/** A Workspace project slug: a folder name, never `/` or `:`. */
const PROJECT_SLUG_SOURCE = '[A-Za-z0-9._-]+';
const PROJECT_TAG_PATTERN = new RegExp(`^project:(${PROJECT_SLUG_SOURCE})$`);
const LINK_TAG_PATTERN = new RegExp(`^link:(${PROJECT_SLUG_SOURCE})::(${PROJECT_SLUG_SOURCE})$`);

/** Top-level keys of a Workspace record input — the project keys plus scope. */
const WORKSPACE_INPUT_KEYS = new Set<string>([...INPUT_KEYS, 'projectsRead', 'knowledgeOnly']);
const WORKSPACE_SOURCE_KEYS = new Set<string>([...SOURCE_KEYS, 'project']);

/** Absolute path of the Workspace answer log. */
export function workspaceQaPath(workspaceRoot: string): string {
  return join(workspaceRoot, WORKSPACE_QA_FILENAME);
}

/**
 * Where the Workspace log's lock lives: inside the repository's `.git`
 * directory (as workspace sync's lock does), so it can never be staged or
 * synced; when there is no `.git` directory (a worktree's `.git` file, a
 * fixture), in the OS temp folder, keyed by the Workspace path.
 */
function workspaceQaLockPath(workspaceRoot: string): string {
  const gitDir = join(workspaceRoot, '.git');
  try {
    if (statSync(gitDir).isDirectory()) return join(gitDir, WORKSPACE_QA_LOCK_GIT_NAME);
  } catch {
    // Sanctioned fail-soft: no `.git` directory — fall back to the temp folder below
  }
  const key = createHash('sha256').update(resolve(workspaceRoot)).digest('hex').slice(0, 16);
  return join(tmpdir(), `plan-flow-qa-${key}.lock`);
}

/** The flow folder project readers read: the checkout's `flow/` when local, else the shared copy. */
function knowledgeDirOf(project: WorkspaceQaProject): string {
  return project.localPath === null ? project.flowPath : join(project.localPath, 'flow');
}

function knownProject(projects: WorkspaceQaProjects, slug: string, field: string): WorkspaceQaProject {
  const project = Object.prototype.hasOwnProperty.call(projects, slug) ? projects[slug] : undefined;
  if (project === undefined) {
    throw new QaRefusal(
      'unknown-project',
      field,
      `'${slug}' is not a project of this Workspace — expected one of ${Object.keys(projects).join(', ') || '(none)'}`,
    );
  }
  return project;
}

/** `feature:<x>` → `feature:<project>::<x>`; an id already qualified is kept. */
function qualifyFeatureId(id: string, project: string): string {
  const parsed = parseFeatureId(id);
  if (parsed === null || parsed.namespace !== null) return id;
  return `feature:${project}::${parsed.slug}`;
}

/** Per-project feature indexes, read once per write. */
type IndexCache = Map<string, FeatureIndex | null>;

function indexFor(cache: IndexCache, project: WorkspaceQaProject): FeatureIndex | null {
  if (!cache.has(project.slug)) {
    const dir = knowledgeDirOf(project);
    cache.set(project.slug, existsSync(dir) ? readFeatureIndexAt(dir, project.slug) : null);
  }
  return cache.get(project.slug) ?? null;
}

/** Check one qualified feature id against its project; returns the stored (qualified) id and the project. */
function checkWorkspaceFeatureRef(
  value: unknown,
  field: string,
  projects: WorkspaceQaProjects,
  cache: IndexCache,
): { id: string; project: string } {
  const match = typeof value === 'string' ? FEATURE_TAG_PATTERN.exec(value) : null;
  if (match === null) {
    throw new QaRefusal(
      'bad-tag',
      field,
      `'${String(value)}' is not a Workspace tag — expected feature:<project>::<slug>[/<part>], project:<project> or link:<project>::<project>`,
    );
  }
  const slug = match[1];
  if (slug === undefined) {
    throw new QaRefusal(
      'unqualified-tag',
      field,
      `'${String(value)}' does not name its project — at Workspace level a feature is feature:<project>::<slug>`,
    );
  }
  const project = knownProject(projects, slug, field);
  const id = checkFeatureRef(value, field, indexFor(cache, project));
  return { id: qualifyFeatureId(id, project.slug), project: project.slug };
}

/** Check one Workspace tag; returns the stored spelling and the projects it names. */
function checkWorkspaceTag(
  value: unknown,
  field: string,
  projects: WorkspaceQaProjects,
  cache: IndexCache,
): { tag: string; projects: string[] } {
  if (typeof value === 'string') {
    const projectMatch = PROJECT_TAG_PATTERN.exec(value);
    if (projectMatch !== null) {
      const project = knownProject(projects, projectMatch[1] ?? '', field);
      return { tag: `project:${project.slug}`, projects: [project.slug] };
    }
    const linkMatch = LINK_TAG_PATTERN.exec(value);
    if (linkMatch !== null) {
      const a = knownProject(projects, linkMatch[1] ?? '', field).slug;
      const b = knownProject(projects, linkMatch[2] ?? '', field).slug;
      if (a === b) {
        throw new QaRefusal('bad-tag', field, `'${value}' names ${a} twice — a connection is between two different projects`);
      }
      const [first, second] = [a, b].sort();
      return { tag: `link:${first}::${second}`, projects: [first as string, second as string] };
    }
  }
  const feature = checkWorkspaceFeatureRef(value, field, projects, cache);
  return { tag: feature.id, projects: [feature.project] };
}

function validateWorkspaceSource(
  value: unknown,
  at: number,
  projects: WorkspaceQaProjects,
  cache: IndexCache,
): QaSource {
  const field = `sources[${at}]`;
  if (!isPlainObject(value)) {
    throw new QaRefusal('bad-field', field, 'a source is an object with a label, a project, and optionally a featureId and a file');
  }
  if ('hashStamp' in value) {
    throw new QaRefusal('writer-owned', `${field}.hashStamp`, 'a source file is stamped by the writer, never by the caller');
  }
  refuseStrayKeys(value, WORKSPACE_SOURCE_KEYS, `${field}.`);
  if (!nonEmptyString(value.label)) {
    throw new QaRefusal('bad-field', `${field}.label`, 'every source needs a label the reader can see');
  }
  let project: string | undefined;
  if (value.project !== undefined) {
    if (!nonEmptyString(value.project)) {
      throw new QaRefusal('bad-field', `${field}.project`, 'a source project is the slug of a project of this Workspace');
    }
    project = knownProject(projects, value.project.trim(), `${field}.project`).slug;
  }
  const source: QaSource = { label: value.label.trim() };
  if (value.featureId !== undefined) {
    const feature = checkWorkspaceFeatureRef(value.featureId, `${field}.featureId`, projects, cache);
    if (project !== undefined && feature.project !== project) {
      throw new QaRefusal(
        'bad-source',
        [`${field}.project`, `${field}.featureId`],
        `the source says it is in ${project} but cites a feature of ${feature.project}`,
      );
    }
    project = feature.project;
    source.featureId = feature.id;
  }
  if (project === undefined) {
    throw new QaRefusal('bad-source', `${field}.project`, 'every Workspace source names its project (project, or a feature:<project>::<slug> featureId)');
  }
  source.project = project;
  if (value.file !== undefined) {
    if (!nonEmptyString(value.file)) {
      throw new QaRefusal('bad-field', `${field}.file`, "a source file is a path relative to its project's checkout");
    }
    const owner = projects[project] as WorkspaceQaProject;
    const file = value.file.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (owner.localPath === null) {
      throw new QaRefusal(
        'remote-file',
        `${field}.file`,
        `${project} is not on this computer — a source there can cite a feature, never a file`,
      );
    }
    const hashed = hashRepoFile(owner.localPath, file);
    if (hashed.status === 'escapes') {
      throw new QaRefusal('bad-source', `${field}.file`, `'${file}' is outside ${project}'s checkout`);
    }
    if (hashed.status === 'missing') {
      throw new QaRefusal('bad-source', `${field}.file`, `'${file}' does not exist in ${project}'s checkout — an answer can only cite code that is there`);
    }
    source.file = file;
    source.hashStamp = { ref: file, contentHash: hashed.contentHash };
  }
  return source;
}

/** A list of project slugs, each known; deduped, in the order given. */
function projectList(value: unknown, field: string, projects: WorkspaceQaProjects): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new QaRefusal('bad-field', field, `${field} is a list of project slugs`);
  const out: string[] = [];
  for (const [at, item] of value.entries()) {
    if (!nonEmptyString(item)) throw new QaRefusal('bad-field', `${field}[${at}]`, `${field} holds project slugs`);
    const slug = knownProject(projects, item.trim(), `${field}[${at}]`).slug;
    if (!out.includes(slug)) out.push(slug);
  }
  return out;
}

function mintWorkspaceId(now: Date): string {
  return `w${mintId(now)}`;
}

/** Validate a Workspace record input and build the entry. Throws `QaRefusal` before any write. */
function buildWorkspaceEntry(
  workspaceRoot: string,
  workspaceSlug: string,
  projects: WorkspaceQaProjects,
  input: unknown,
  now: Date,
): WorkspaceQaEntry {
  if (!isPlainObject(input)) {
    throw new QaRefusal('bad-input', null, 'the input is one JSON object');
  }
  refuseStrayKeys(input, WORKSPACE_INPUT_KEYS, '');

  if (!nonEmptyString(input.author)) throw new QaRefusal('bad-field', 'author', 'every saved answer names who asked');
  if (!nonEmptyString(input.question)) throw new QaRefusal('bad-field', 'question', 'the question is required');
  if (!nonEmptyString(input.answer)) throw new QaRefusal('bad-field', 'answer', 'the answer is required');

  const usedConversation = optionalBoolean(input.usedConversation, 'usedConversation', false);
  const conversationCount = nonNegativeInteger(input.conversationCount, 'conversationCount', 0);
  if (usedConversation !== conversationCount > 0) {
    throw new QaRefusal(
      'bad-field',
      ['usedConversation', 'conversationCount'],
      'usedConversation is true exactly when conversationCount is more than zero',
    );
  }

  const cache: IndexCache = new Map();
  const named = new Set<string>();

  if (input.tags !== undefined && !Array.isArray(input.tags)) {
    throw new QaRefusal('bad-field', 'tags', 'tags is a list of Workspace tags');
  }
  const tags: string[] = [];
  for (const [at, raw] of ((input.tags as unknown[] | undefined) ?? []).entries()) {
    const checked = checkWorkspaceTag(raw, `tags[${at}]`, projects, cache);
    for (const slug of checked.projects) named.add(slug);
    if (!tags.includes(checked.tag)) tags.push(checked.tag);
  }

  if (input.sources !== undefined && !Array.isArray(input.sources)) {
    throw new QaRefusal('bad-field', 'sources', 'sources is a list of {label, project, featureId?, file?}');
  }
  const sources = ((input.sources as unknown[] | undefined) ?? []).map((source, at) =>
    validateWorkspaceSource(source, at, projects, cache),
  );
  for (const source of sources) if (source.project !== undefined) named.add(source.project);

  const projectsRead = projectList(input.projectsRead, 'projectsRead', projects);
  const notLocal = projectsRead.filter((slug) => projects[slug]?.localPath === null);
  if (notLocal.length > 0) {
    throw new QaRefusal(
      'remote-read',
      'projectsRead',
      `${notLocal.join(', ')} ${notLocal.length === 1 ? 'is' : 'are'} not on this computer, so no code there could have been read`,
    );
  }
  const knowledgeOnly = projectList(input.knowledgeOnly, 'knowledgeOnly', projects);
  const both = projectsRead.filter((slug) => knowledgeOnly.includes(slug));
  if (both.length > 0) {
    throw new QaRefusal(
      'bad-field',
      ['projectsRead', 'knowledgeOnly'],
      `${both.join(', ')} cannot be both read and answered from knowledge only`,
    );
  }

  const order = Object.keys(projects);
  const entry: WorkspaceQaEntry = {
    id: mintWorkspaceId(now),
    ts: now.toISOString(),
    workspace: workspaceSlug,
    author: input.author.trim(),
    question: input.question.trim(),
    tags,
    conversationCount,
    usedConversation,
    answer: input.answer.trim(),
    sources,
    factsLearned: nonNegativeInteger(input.factsLearned, 'factsLearned', 0),
    partial: optionalBoolean(input.partial, 'partial', false),
    projectsRead,
    knowledgeOnly,
    cited: order.filter((slug) => named.has(slug)),
  };
  if (input.verdict !== undefined) entry.verdict = validateVerdict(input.verdict);
  if (input.reply !== undefined) {
    if (!nonEmptyString(input.reply)) throw new QaRefusal('bad-field', 'reply', 'a reply, when given, is non-empty text');
    entry.reply = input.reply.trim();
  }
  if (input.branchInProgress !== undefined) {
    if (!nonEmptyString(input.branchInProgress)) {
      throw new QaRefusal('bad-field', 'branchInProgress', 'branchInProgress, when given, names the branch the work is on');
    }
    entry.branchInProgress = input.branchInProgress.trim();
  }
  if (input.parentId !== undefined) {
    if (!nonEmptyString(input.parentId)) {
      throw new QaRefusal('bad-field', 'parentId', 'a follow-up names the id of the entry it follows');
    }
    const parentId = input.parentId.trim();
    if (!readWorkspaceQaEntries(workspaceRoot).some((existing) => existing.id === parentId)) {
      throw new QaRefusal('unknown-parent', 'parentId', `no saved Workspace answer '${parentId}' to follow up on`);
    }
    entry.parentId = parentId;
  }
  return entry;
}

/** Does a Workspace tag concern this project? */
function tagConcerns(tag: string, slug: string): boolean {
  const project = PROJECT_TAG_PATTERN.exec(tag);
  if (project !== null) return project[1] === slug;
  const link = LINK_TAG_PATTERN.exec(tag);
  if (link !== null) return link[1] === slug || link[2] === slug;
  return parseFeatureId(tag)?.namespace === slug;
}

/** The pointer one cited project receives. */
function pointerFor(entry: WorkspaceQaEntry, slug: string): QaPointerEntry {
  const pointer: QaPointerEntry = {
    kind: 'workspace-pointer',
    id: entry.id,
    ts: entry.ts,
    workspace: entry.workspace,
    author: entry.author,
    question: entry.question,
    tags: entry.tags.filter((tag) => tagConcerns(tag, slug)),
    sources: entry.sources
      .filter((source) => source.project === slug && source.featureId !== undefined)
      .map((source) => ({ label: source.label, featureId: source.featureId as string, project: slug })),
  };
  if (entry.parentId !== undefined) pointer.parentId = entry.parentId;
  return pointer;
}

function releaseLocks(paths: readonly string[]): void {
  for (const path of [...paths].reverse()) {
    try {
      unlinkSync(path);
    } catch {
      // Sanctioned fail-soft: lock already removed (e.g. reclaimed as stale) — nothing to clean up
    }
  }
}

/**
 * THE ONLY WRITER of a Workspace answer. Validates `input` strictly (the
 * project keys plus `projectsRead` / `knowledgeOnly`; qualified tags; every
 * source naming its project, a file only in a project on this computer),
 * stamps each file source against its OWN project's checkout, then — holding
 * the Workspace log's lock and every pointed project's lock — appends the
 * Workspace record and one `QaPointerEntry` to each cited local project's
 * `qa.jsonl`. Throws `QaRefusal` with nothing written on any problem.
 *
 * `workspaceRoot` is the Workspace repository; `projects` is every project of
 * the Workspace (`resolveWorkspaceQaScope` builds both from the Workspace
 * model). The Workspace slug is the root folder's name.
 */
export function appendWorkspaceQaEntry(
  workspaceRoot: string,
  projects: WorkspaceQaProjects,
  input: WorkspaceQaRecordInput,
  now: Date = new Date(),
): WorkspaceQaEntry {
  const workspaceSlug = resolve(workspaceRoot).split(/[\\/]/).filter((part) => part !== '').pop() ?? '';
  const entry = buildWorkspaceEntry(workspaceRoot, workspaceSlug, projects, input, now);
  const pointed = entry.cited
    .map((slug) => projects[slug] as WorkspaceQaProject)
    .filter((project) => project.localPath !== null && existsSync(join(project.localPath, 'flow')));

  // Every lock first, in a fixed order (the Workspace's, then projects by
  // slug), so two writers can never hold each other's halves.
  const held: string[] = [];
  const take = (lockPath: string, what: string): void => {
    let ok = false;
    try {
      ok = acquireGraphLock(lockPath);
    } catch (error) {
      releaseLocks(held);
      throw new QaRefusal('unwritable', null, error instanceof Error ? error.message : String(error));
    }
    if (!ok) {
      releaseLocks(held);
      throw new QaRefusal('busy', null, `${what} is being written by another process — retry`);
    }
    held.push(lockPath);
  };
  take(workspaceQaLockPath(workspaceRoot), "the Workspace's saved-answer log");
  const targets = [...pointed]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((project) => {
      const blueprintDir = ensureBlueprintDir(join(project.localPath as string, 'flow'));
      take(join(blueprintDir, QA_LOCK_FILENAME), `${project.slug}'s saved-answer log`);
      return { slug: project.slug, path: join(blueprintDir, QA_FILENAME) };
    });
  try {
    appendFileSync(workspaceQaPath(workspaceRoot), `${JSON.stringify(entry)}\n`, 'utf-8');
    for (const target of targets) {
      appendFileSync(target.path, `${JSON.stringify(pointerFor(entry, target.slug))}\n`, 'utf-8');
    }
  } finally {
    releaseLocks(held);
  }
  return entry;
}

/** The projects of `entry` that got a pointer — exactly the writer's rule, for reporting. */
export function workspaceQaPointedProjects(entry: WorkspaceQaEntry, projects: WorkspaceQaProjects): string[] {
  return entry.cited.filter((slug) => {
    const project = projects[slug];
    return project !== undefined && project.localPath !== null && existsSync(join(project.localPath, 'flow'));
  });
}

// ── Workspace readers ────────────────────────────────────────────────────────

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Every Workspace answer, in file order. Corrupt lines are skipped; a
 * union-merge twin keeps its first occurrence. Never throws.
 */
export function readWorkspaceQaEntries(workspaceRoot: string): WorkspaceQaEntry[] {
  const entries: WorkspaceQaEntry[] = [];
  const seen = new Set<string>();
  for (const line of readJsonlLines(workspaceQaPath(workspaceRoot))) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: corrupt line — skip it rather than failing the whole read
      continue;
    }
    if (!isPlainObject(parsed) || parsed.kind === 'workspace-pointer') continue;
    const base = parseEntry(parsed);
    if (base === null || seen.has(base.id)) continue;
    seen.add(base.id);
    entries.push({
      ...base,
      workspace: typeof parsed.workspace === 'string' ? parsed.workspace : '',
      projectsRead: stringList(parsed.projectsRead),
      knowledgeOnly: stringList(parsed.knowledgeOnly),
      cited: stringList(parsed.cited),
    });
  }
  return entries;
}

/** The Workspace log folded into threads, newest first. Never throws. */
export function readWorkspaceQaThreads(workspaceRoot: string): WorkspaceQaThread[] {
  return foldQaEntries(readWorkspaceQaEntries(workspaceRoot));
}

/** Every project one Workspace entry names: tags, sources, projects read and knowledge-only. */
function entryProjects(entry: WorkspaceQaEntry): Set<string> {
  const out = new Set<string>([...entry.cited, ...entry.projectsRead, ...entry.knowledgeOnly]);
  for (const tag of entry.tags) {
    const project = PROJECT_TAG_PATTERN.exec(tag);
    const link = LINK_TAG_PATTERN.exec(tag);
    if (project !== null) out.add(project[1] as string);
    else if (link !== null) {
      out.add(link[1] as string);
      out.add(link[2] as string);
    } else {
      const namespace = parseFeatureId(tag)?.namespace;
      if (namespace !== null && namespace !== undefined) out.add(namespace);
    }
  }
  for (const source of entry.sources) if (source.project !== undefined) out.add(source.project);
  return out;
}

/** What a Workspace list is narrowed by. Empty (or nothing given) = the whole Workspace. */
export interface WorkspaceQaFilter {
  /** Qualified feature or part ids (`feature:<project>::<slug>[/<part>]`). */
  features?: readonly string[];
  /** Project slugs: an entry naming the project anywhere matches. */
  projects?: readonly string[];
  /** Connection tags (`link:<a>::<b>`, either order). */
  links?: readonly string[];
}

/**
 * Split Workspace tags (the record grammar) into a filter. Refuses a tag that
 * is not one of the three forms, and a bare feature id — it could name a
 * feature of any project.
 */
export function workspaceQaFilterOf(tags: readonly string[]): WorkspaceQaFilter {
  const features: string[] = [];
  const projects: string[] = [];
  const links: string[] = [];
  for (const [at, raw] of tags.entries()) {
    const tag = raw.trim();
    const field = `--tag[${at}]`;
    const project = PROJECT_TAG_PATTERN.exec(tag);
    const link = LINK_TAG_PATTERN.exec(tag);
    if (project !== null) projects.push(project[1] as string);
    else if (link !== null) links.push(`link:${[link[1], link[2]].sort().join('::')}`);
    else {
      const feature = FEATURE_TAG_PATTERN.exec(tag);
      if (feature === null) {
        throw new QaRefusal(
          'bad-tag',
          field,
          `'${tag}' is not a Workspace tag — expected feature:<project>::<slug>[/<part>], project:<project> or link:<project>::<project>`,
        );
      }
      if (feature[1] === undefined) {
        throw new QaRefusal('unqualified-tag', field, `'${tag}' does not name its project — at Workspace level a feature is feature:<project>::<slug>`);
      }
      features.push(tag);
    }
  }
  return { features, projects, links };
}

/**
 * The Workspace threads for a scope: a thread is listed when its root or any
 * follow-up touches a named feature (a part's parent feature also matches;
 * namespaces must agree), names a named project anywhere, or carries a named
 * connection tag. An empty filter lists every Workspace answer.
 */
export function listWorkspaceQa(workspaceRoot: string, filter: WorkspaceQaFilter = {}): WorkspaceQaThread[] {
  const features = filter.features ?? [];
  const projects = filter.projects ?? [];
  const links = (filter.links ?? []).map((tag) => {
    const match = LINK_TAG_PATTERN.exec(tag);
    return match === null ? tag : `link:${[match[1], match[2]].sort().join('::')}`;
  });
  const threads = readWorkspaceQaThreads(workspaceRoot);
  if (features.length === 0 && projects.length === 0 && links.length === 0) return threads;
  const matches = (entry: WorkspaceQaEntry): boolean => {
    if (projects.length > 0) {
      const named = entryProjects(entry);
      if (projects.some((slug) => named.has(slug))) return true;
    }
    if (links.length > 0 && entry.tags.some((tag) => links.includes(tag))) return true;
    if (features.length > 0) {
      const touched = touchedIds(entry);
      if (features.some((asked) => touched.some((id) => touches(id, asked)))) return true;
    }
    return false;
  };
  return threads.filter((thread) => [thread, ...thread.followUps].some(matches));
}

/**
 * Per-project staleness of Workspace answers: every stamped source is
 * re-hashed against ITS project's checkout with `hashRepoFile` (the same path
 * `qaStaleness` and stale-check use). A changed digest is `changedFiles`, a
 * gone or escaping file `missingFiles`, both written `<project>/<path>`. A
 * project whose stamped files cannot be checked here — not on this computer,
 * or no longer in the Workspace — is listed in `notChecked` and never counted
 * as fresh. Read-only; never throws.
 */
export function workspaceQaStaleness(
  projects: WorkspaceQaProjects,
  entries: readonly WorkspaceQaEntry[],
): Map<string, WorkspaceQaStaleness> {
  const out = new Map<string, WorkspaceQaStaleness>();
  for (const entry of entries) {
    const changedFiles: string[] = [];
    const missingFiles: string[] = [];
    const notChecked: string[] = [];
    for (const source of entry.sources) {
      const stamp = source.hashStamp;
      if (stamp === undefined) continue;
      const slug = source.project ?? '';
      const project = Object.prototype.hasOwnProperty.call(projects, slug) ? projects[slug] : undefined;
      if (project === undefined || project.localPath === null) {
        if (!notChecked.includes(slug)) notChecked.push(slug);
        continue;
      }
      const relPath = source.file;
      if (relPath === undefined) {
        // Sanctioned fail-soft: a stamp with no backing file cannot be verified —
        // reported conservatively as missing (mirrors qaStaleness).
        missingFiles.push(`${slug}/${stamp.ref}`);
        continue;
      }
      const result = hashRepoFile(project.localPath, relPath);
      if (result.status === 'missing' || result.status === 'escapes') {
        missingFiles.push(`${slug}/${relPath}`);
        continue;
      }
      if (result.contentHash !== stamp.contentHash) changedFiles.push(`${slug}/${relPath}`);
    }
    out.set(entry.id, {
      stale: changedFiles.length > 0 || missingFiles.length > 0,
      changedFiles,
      missingFiles,
      notChecked,
    });
  }
  return out;
}

// ── Resolving the Workspace (through the Workspace model) ───────────────────

/** The Workspace a repo belongs to, as the Workspace writer and readers need it. */
export interface WorkspaceQaScope {
  workspace: { name: string; slug: string; path: string };
  /** The project the target repo is. */
  current: string;
  projects: WorkspaceQaProjects;
}

export interface WorkspaceQaScopeOptions extends WorkspaceContext {
  /** The repo the caller stands in. */
  target: string;
  /** Which Workspace, when the repo is in more than one. */
  workspace?: string;
}

function projectOf(view: ProjectView): WorkspaceQaProject {
  return { slug: view.slug, name: view.name, localPath: view.localPath, flowPath: view.flowPath };
}

/**
 * Resolve the target repo's Workspace and every project's checkout and shared
 * knowledge folder through `workspaceStatus` — nothing here derives a
 * Workspace path of its own. Refuses (`no-workspace`, or the model's own
 * reason) with a sentence when there is no Workspace to answer for.
 */
export function resolveWorkspaceQaScope(options: WorkspaceQaScopeOptions): WorkspaceQaScope {
  let status;
  try {
    status = workspaceStatus({
      ...(options.flowFolder === undefined ? {} : { flowFolder: options.flowFolder }),
      ...(options.deps === undefined ? {} : { deps: options.deps }),
      target: options.target,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw new QaRefusal(error.reason, '--workspace', error.sentence);
    throw error;
  }
  if (!('target' in status) || status.workspace === null || status.project === null) {
    throw new QaRefusal('no-workspace', '--workspace', 'this repository is in no Workspace, so there is no Workspace answer to save or read');
  }
  const projects: Record<string, WorkspaceQaProject> = {};
  for (const view of [status.project, ...status.siblings]) projects[view.slug] = projectOf(view);
  return {
    workspace: { name: status.workspace.name, slug: status.workspace.slug, path: status.workspace.path },
    current: status.project.slug,
    projects,
  };
}
