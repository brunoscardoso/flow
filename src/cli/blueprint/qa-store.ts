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

import { randomBytes } from 'node:crypto';
import { appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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
import type { QaEntry, QaRecordInput, QaSource, QaStaleness, QaThread, QaVerdict } from './types.js';

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
  const flowDir = join(repoRoot, 'flow');
  try {
    const features = readFeatures(flowDir);
    if (features.length === 0) return null;
    return { features, namespace: featureNamespace(flowDir), flowDir };
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

function parseEntry(record: Record<string, unknown>): QaEntry | null {
  if (!nonEmptyString(record.id) || typeof record.question !== 'string' || typeof record.answer !== 'string') return null;
  const sources: QaSource[] = [];
  if (Array.isArray(record.sources)) {
    for (const raw of record.sources) {
      if (!isPlainObject(raw) || typeof raw.label !== 'string') continue;
      const source: QaSource = { label: raw.label };
      if (typeof raw.featureId === 'string') source.featureId = raw.featureId;
      if (typeof raw.file === 'string') source.file = raw.file;
      const stamp = parseStamp(raw.hashStamp);
      if (stamp !== undefined) source.hashStamp = stamp;
      sources.push(source);
    }
  }
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
export function foldQaEntries(entries: readonly QaEntry[]): QaThread[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const rootOf = (entry: QaEntry): QaEntry => {
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
  const threads = new Map<string, QaThread>();
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
