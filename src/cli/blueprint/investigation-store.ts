/**
 * File I/O for the investigation store at
 * `<flowDir>/brain/.structure/investigations.jsonl`.
 *
 * A third store beside `annotations.jsonl` that captures investigation-time
 * knowledge with a SUPERSEDE/COMPACTION lifecycle (annotations stay
 * append-only-forever and untouched). Two line shapes share the file,
 * discriminated by a `kind` field:
 * - `{"kind":"note", ...InvestigationEntry}` — an investigation note; a later
 *   note may name an earlier note's fingerprint in `supersedes`.
 * - `{"kind":"heat", ...HeatTick}` — a raw visit event; compaction rewrites
 *   these as one aggregated `HeatCounter`-shaped line per anchor ref
 *   (`{"kind":"heat", ...HeatCounter}`), which readers also accept, so total
 *   counts are never lost.
 *
 * Fold-on-read: supersede chains collapse (the latest non-superseded note per
 * chain wins; pre-existing supersede CYCLES keep exactly their newest member
 * instead of vanishing — new cycles are refused at write time) and heat
 * ticks aggregate per anchor ref. Corrupt or missing files never throw —
 * readers skip bad lines and return empty structures.
 * The only writers are the append/compact functions in this module; they are
 * invoked exclusively via the mediated CLI command (never self-narration),
 * and ALL of them — appends included — share the `investigations.lock`
 * write lock so an append can never land inside compaction's read→rename
 * window. Compaction's production trigger is `maybeCompactInvestigations`,
 * called by `blueprint derive`.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  acquireGraphLock,
  BLUEPRINT_DIRNAME,
  ensureBlueprintDir,
  isValidAnchor,
  readJsonlLines,
} from './store.js';
import type {
  Anchor,
  AnchorHashStamp,
  HeatCounter,
  HeatTick,
  InvestigationEntry,
  InvestigationStatus,
} from './types.js';

const INVESTIGATIONS_FILENAME = 'investigations.jsonl';
const INVESTIGATIONS_TEMP_FILENAME = 'investigations.jsonl.tmp';
const INVESTIGATIONS_LOCK_FILENAME = 'investigations.lock';

/**
 * One-line notice thrown when an append cannot acquire the store lock after
 * `acquireGraphLock`'s brief retry loop. Surfaced fail-soft by the CLI as
 * `observe refused: investigation store busy — retry`.
 */
const INVESTIGATION_STORE_BUSY_NOTICE = 'investigation store busy — retry';

/**
 * Fold-dropped ratio (foldable lines / valid lines) at or above which
 * `maybeCompactInvestigations` compacts the store. Foldable lines are
 * superseded notes plus heat ticks that would merge into an existing
 * per-anchor aggregate.
 */
export const COMPACT_DROPPED_RATIO = 0.5;

/**
 * Store file size (bytes) at or above which `maybeCompactInvestigations`
 * compacts unconditionally — a cheap `stat` guard so a huge store is never
 * fully parsed twice just to decide. 256 KiB keeps fold-on-read (every
 * note-mode observe and every `context`) comfortably inside the <200ms NFR.
 */
export const COMPACT_MIN_BYTES = 256 * 1024;

/** The three epistemic statuses accepted when parsing note lines. */
const INVESTIGATION_STATUSES: readonly InvestigationStatus[] = ['observed', 'corroborated', 'contradicted'];
/** Status applied to note lines whose status field is missing or invalid. */
const DEFAULT_INVESTIGATION_STATUS: InvestigationStatus = 'observed';

/** Everything read back from the store: folded notes plus aggregated heat. */
export interface InvestigationReadResult {
  /** Non-superseded notes, sorted by ts then fingerprint. */
  notes: InvestigationEntry[];
  /** Aggregated visit counters, sorted by anchor ref. */
  heat: HeatCounter[];
}

/** Counts produced by a compaction pass. */
export interface CompactionResult {
  /** Non-superseded notes rewritten into the compacted file. */
  notesKept: number;
  /** Superseded notes dropped by the compaction. */
  notesDropped: number;
  /** Valid heat lines (ticks or aggregates) in the file before compaction. */
  heatLinesBefore: number;
  /** Aggregated heat lines (one per anchor ref) after compaction. */
  heatLinesAfter: number;
}

/**
 * Compute the stable fingerprint of an investigation note:
 * `<text>+<JSON array of sorted anchor refs>` (mirrors `annotationFingerprint`).
 * Supersede pointers target notes by this fingerprint.
 */
export function investigationFingerprint(entry: Pick<InvestigationEntry, 'text' | 'anchors'>): string {
  const sortedRefs = entry.anchors.map((anchor) => anchor.ref).sort();
  return `${entry.text}+${JSON.stringify(sortedRefs)}`;
}

/** Absolute path of the investigation store file for a flow directory. */
function investigationsPath(flowDir: string): string {
  return join(flowDir, BLUEPRINT_DIRNAME, INVESTIGATIONS_FILENAME);
}

/**
 * Append one line to the store under the SAME lock compaction holds — an
 * append may never land on the old inode inside compaction's read→rename
 * window (it would be silently lost by the rename). `acquireGraphLock`
 * already retries briefly with stale-lock reclaim; if the lock stays
 * contended, this throws the one-line busy notice for the CLI's fail-soft
 * catch — nothing is written.
 */
function appendStoreLine(flowDir: string, record: Record<string, unknown>): void {
  const blueprintDir = ensureBlueprintDir(flowDir);
  const filePath = join(blueprintDir, INVESTIGATIONS_FILENAME);
  const lockPath = join(blueprintDir, INVESTIGATIONS_LOCK_FILENAME);

  if (!acquireGraphLock(lockPath)) {
    throw new Error(INVESTIGATION_STORE_BUSY_NOTICE);
  }
  try {
    appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (e.g. reclaimed as stale) — nothing to clean up
    }
  }
}

/**
 * Append one investigation note (`kind: "note"`) to the store.
 * Creates `<flowDir>/brain/.structure/` if it does not exist yet.
 * Takes the store write lock (shared with compaction); throws the one-line
 * busy notice when the lock stays contended — nothing is written.
 */
export function appendInvestigationNote(flowDir: string, entry: InvestigationEntry): void {
  appendStoreLine(flowDir, { kind: 'note', ...entry });
}

/**
 * Append one raw heat tick (`kind: "heat"`) to the store.
 * Creates `<flowDir>/brain/.structure/` if it does not exist yet.
 * Takes the store write lock (shared with compaction); throws the one-line
 * busy notice when the lock stays contended — nothing is written.
 */
export function appendHeatTick(flowDir: string, tick: HeatTick): void {
  appendStoreLine(flowDir, { kind: 'heat', ...tick });
}

/**
 * Whether one parsed hash-stamp element is structurally valid: an object
 * whose `ref` is a non-empty string and whose `contentHash` is a string.
 */
function isValidHashStamp(value: unknown): value is AnchorHashStamp {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { ref?: unknown; contentHash?: unknown };
  return typeof candidate.ref === 'string' && candidate.ref.length > 0 && typeof candidate.contentHash === 'string';
}

/**
 * Parse one `kind: "note"` record into an `InvestigationEntry`.
 * Malformed anchor/hash-stamp elements are dropped individually; missing
 * optional fields default rather than invalidating the note. Returns null
 * when the note lacks its required `text`.
 */
function parseNoteRecord(record: Record<string, unknown>): InvestigationEntry | null {
  if (typeof record.text !== 'string') {
    return null;
  }
  const anchors: Anchor[] = Array.isArray(record.anchors) ? record.anchors.filter(isValidAnchor) : [];
  const hashStamps: AnchorHashStamp[] = Array.isArray(record.hashStamps)
    ? record.hashStamps.filter(isValidHashStamp)
    : [];
  const status = INVESTIGATION_STATUSES.includes(record.status as InvestigationStatus)
    ? (record.status as InvestigationStatus)
    : DEFAULT_INVESTIGATION_STATUS;

  const entry: InvestigationEntry = {
    ts: typeof record.ts === 'string' ? record.ts : '',
    runId: typeof record.runId === 'string' ? record.runId : null,
    anchors,
    text: record.text,
    provenance: typeof record.provenance === 'string' ? record.provenance : '',
    status,
    hashStamps,
  };
  if (typeof record.ambiguous === 'boolean') {
    entry.ambiguous = record.ambiguous;
  }
  if (typeof record.supersedes === 'string') {
    entry.supersedes = record.supersedes;
  }
  return entry;
}

/**
 * Parse one `kind: "heat"` record into a counter-shaped contribution.
 * Accepts both line shapes: a raw `HeatTick` (contributes one visit) and an
 * aggregated `HeatCounter` written by a previous compaction (contributes its
 * preserved totals). Returns null for records matching neither shape.
 */
function parseHeatRecord(record: Record<string, unknown>): HeatCounter | null {
  if (typeof record.anchorRef !== 'string' || record.anchorRef.length === 0) {
    return null;
  }
  if (record.visitor === 'human' || record.visitor === 'agent') {
    return {
      anchorRef: record.anchorRef,
      humanVisits: record.visitor === 'human' ? 1 : 0,
      agentVisits: record.visitor === 'agent' ? 1 : 0,
      lastVisited: typeof record.ts === 'string' ? record.ts : '',
    };
  }
  if (typeof record.humanVisits === 'number' && typeof record.agentVisits === 'number') {
    return {
      anchorRef: record.anchorRef,
      humanVisits: record.humanVisits,
      agentVisits: record.agentVisits,
      lastVisited: typeof record.lastVisited === 'string' ? record.lastVisited : '',
    };
  }
  return null;
}

/**
 * Stable identity of one note record: its own JSON with keys sorted, so two
 * serializations of the same entry collapse regardless of key order.
 */
function noteIdentity(record: Record<string, unknown>): string {
  return stableStringify(record);
}

/**
 * A key-order-insensitive serialization, sorted at EVERY depth.
 *
 * NOT `JSON.stringify(record, Object.keys(record).sort())`. The replacer-array
 * form is a recursive property ALLOWLIST, not a key order: it keeps only the
 * named keys at every level, so every nested object is emptied. Two notes
 * differing solely in their `anchors` or `hashStamps` both serialize to
 * `{"anchors":[{}],"text":…}` — identical keys for genuinely different notes,
 * and the dedupe below then DISCARDS one of them.
 *
 * That is silent data loss from a precious, append-only store, which is the one
 * thing this file exists to prevent. Sort the keys instead of listing them.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Raw parse of the store file, before supersede folding and heat aggregation. */
interface ParsedInvestigationsFile {
  notes: InvestigationEntry[];
  heatContributions: HeatCounter[];
  /** Count of valid heat lines encountered (ticks and aggregates alike). */
  heatLineCount: number;
}

/**
 * Read and parse every line of the store file.
 * Missing file yields empty results; corrupt or shape-invalid lines are
 * skipped individually so one bad line never poisons the whole read.
 */
function parseInvestigationsFile(filePath: string): ParsedInvestigationsFile {
  const notes: InvestigationEntry[] = [];
  const heatContributions: HeatCounter[] = [];
  let heatLineCount = 0;
  /**
   * READ-TIME DEDUPE (task 4.5). `.gitattributes` marks these stores
   * `merge=union` so a merge never drops a teammate's entry — the cost is that
   * an entry BOTH sides appended lands twice. An identical note is the same
   * fact stated twice, so the first occurrence wins and the twin is dropped.
   *
   * Heat lines are deliberately NOT deduped: two identical ticks are two real
   * visits that happen to share a timestamp, and dropping one would quietly
   * lose a count. Aggregation already folds them into one counter, so a
   * duplicated tick costs at most one visit — the safe direction.
   */
  const seenNotes = new Set<string>();

  for (const line of readJsonlLines(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: corrupt line — skip it rather than failing the whole read
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      // Sanctioned fail-soft: non-object line — skip it
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.kind === 'note') {
      const identity = noteIdentity(record);
      if (seenNotes.has(identity)) {
        continue; // a union-merge twin — the same fact, stated twice
      }
      seenNotes.add(identity);
      const note = parseNoteRecord(record);
      if (note !== null) {
        notes.push(note);
      }
      continue;
    }
    if (record.kind === 'heat') {
      const contribution = parseHeatRecord(record);
      if (contribution !== null) {
        heatContributions.push(contribution);
        heatLineCount += 1;
      }
    }
    // Sanctioned fail-soft: unknown kind — skip it (forward compatibility)
  }

  return { notes, heatContributions, heatLineCount };
}

/**
 * Detect cycles in the supersede pointer graph. The graph is functional
 * (each fingerprint has at most one outgoing edge — when duplicate notes
 * share a fingerprint with different pointers, the LAST occurrence in file
 * order wins, deterministically), so a standard three-state walk finds every
 * cycle. Returned cycles are arrays of member fingerprints.
 */
function findSupersedeCycles(supersedesOf: Map<string, string>): string[][] {
  const UNVISITED = undefined;
  const IN_CURRENT_WALK = 1;
  const DONE = 2;
  const state = new Map<string, 1 | 2>();
  const cycles: string[][] = [];

  for (const start of supersedesOf.keys()) {
    if (state.get(start) !== UNVISITED) {
      continue;
    }
    const walk: string[] = [];
    let current: string | undefined = start;
    while (current !== undefined && supersedesOf.has(current) && state.get(current) === UNVISITED) {
      state.set(current, IN_CURRENT_WALK);
      walk.push(current);
      current = supersedesOf.get(current);
    }
    if (current !== undefined && state.get(current) === IN_CURRENT_WALK) {
      // The walk re-entered itself — members are the tail from the re-entry point
      cycles.push(walk.slice(walk.indexOf(current)));
    }
    for (const fingerprint of walk) {
      state.set(fingerprint, DONE);
    }
  }
  return cycles;
}

/**
 * Collapse supersede chains: a note whose fingerprint is referenced by any
 * other note's `supersedes` is dropped — the latest non-superseded note per
 * chain wins. Chains of arbitrary length collapse because every superseded
 * link is referenced by its successor.
 *
 * CYCLE TOLERANCE (pre-existing bad data — new cycles are refused at write
 * time by `blueprint observe`): in a supersede cycle every member is
 * referenced by its predecessor, so the naive fold would silently delete ALL
 * of them. Instead, exactly one note per cycle survives — the newest by
 * `ts`, ties broken by fingerprint then file order (deterministic) — UNLESS
 * a note from OUTSIDE the cycle also supersedes it (a legitimate external
 * supersession still wins). Other notes carrying the winner's fingerprint
 * stay dropped, so the fold yields one surviving note per cycle.
 */
function collapseSupersedeChains(notes: InvestigationEntry[]): { kept: InvestigationEntry[]; dropped: number } {
  /** target fingerprint → fingerprints of the notes superseding it */
  const supersededBy = new Map<string, Set<string>>();
  /** source fingerprint → its supersede target (last file occurrence wins) */
  const supersedesOf = new Map<string, string>();
  for (const note of notes) {
    if (note.supersedes === undefined) {
      continue;
    }
    const source = investigationFingerprint(note);
    supersedesOf.set(source, note.supersedes);
    const sources = supersededBy.get(note.supersedes) ?? new Set<string>();
    sources.add(source);
    supersededBy.set(note.supersedes, sources);
  }

  // Rescue one winner per cycle: the newest member note, kept only when
  // every supersession of it originates INSIDE the cycle.
  const rescuedNoteIndices = new Set<number>();
  for (const cycle of findSupersedeCycles(supersedesOf)) {
    const members = new Set(cycle);
    let winnerIndex = -1;
    let winnerFingerprint = '';
    for (let index = 0; index < notes.length; index += 1) {
      const fingerprint = investigationFingerprint(notes[index]);
      if (!members.has(fingerprint)) {
        continue;
      }
      const isNewer =
        winnerIndex === -1 ||
        notes[index].ts > notes[winnerIndex].ts ||
        (notes[index].ts === notes[winnerIndex].ts && fingerprint >= winnerFingerprint);
      if (isNewer) {
        winnerIndex = index;
        winnerFingerprint = fingerprint;
      }
    }
    if (winnerIndex === -1) {
      continue;
    }
    const superseders = supersededBy.get(winnerFingerprint) ?? new Set<string>();
    const externallySuperseded = [...superseders].some((source) => !members.has(source));
    if (!externallySuperseded) {
      rescuedNoteIndices.add(winnerIndex);
    }
  }

  const kept = notes.filter(
    (note, index) => rescuedNoteIndices.has(index) || !supersededBy.has(investigationFingerprint(note)),
  );
  return { kept, dropped: notes.length - kept.length };
}

/**
 * Whether recording `supersedesTarget` on a new note with fingerprint
 * `entryFingerprint` would close a supersede cycle: walking the existing
 * pointer chain from the target must never reach the new note's own
 * fingerprint. Pre-existing cycles not involving the new entry terminate the
 * walk (the fold's cycle tolerance handles those). Used by `blueprint
 * observe` to REFUSE cycle-creating writes at write time.
 */
export function wouldCreateSupersedeCycle(
  flowDir: string,
  entryFingerprint: string,
  supersedesTarget: string,
): boolean {
  if (supersedesTarget === entryFingerprint) {
    return true;
  }
  const { notes } = parseInvestigationsFile(investigationsPath(flowDir));
  const supersedesOf = new Map<string, string>();
  for (const note of notes) {
    if (note.supersedes !== undefined) {
      supersedesOf.set(investigationFingerprint(note), note.supersedes);
    }
  }
  const visited = new Set<string>();
  let current: string | undefined = supersedesTarget;
  while (current !== undefined) {
    if (current === entryFingerprint) {
      return true;
    }
    if (visited.has(current)) {
      // Pre-existing cycle that does not involve the new entry — the write
      // itself is acyclic; the fold's cycle tolerance owns the bad data.
      return false;
    }
    visited.add(current);
    current = supersedesOf.get(current);
  }
  return false;
}

/**
 * Aggregate heat contributions into one `HeatCounter` per anchor ref:
 * visit counts sum, `lastVisited` is the max timestamp. Result is sorted by
 * anchor ref for deterministic output.
 */
function aggregateHeat(contributions: HeatCounter[]): HeatCounter[] {
  const byAnchorRef = new Map<string, HeatCounter>();

  for (const contribution of contributions) {
    const existing = byAnchorRef.get(contribution.anchorRef);
    if (existing === undefined) {
      byAnchorRef.set(contribution.anchorRef, { ...contribution });
      continue;
    }
    byAnchorRef.set(contribution.anchorRef, {
      anchorRef: contribution.anchorRef,
      humanVisits: existing.humanVisits + contribution.humanVisits,
      agentVisits: existing.agentVisits + contribution.agentVisits,
      lastVisited: contribution.lastVisited > existing.lastVisited ? contribution.lastVisited : existing.lastVisited,
    });
  }

  return [...byAnchorRef.values()].sort((a, b) => a.anchorRef.localeCompare(b.anchorRef));
}

/** Sort notes by ts, then fingerprint, for deterministic output. */
function sortNotes(notes: InvestigationEntry[]): InvestigationEntry[] {
  return [...notes].sort((a, b) => {
    if (a.ts !== b.ts) {
      return a.ts.localeCompare(b.ts);
    }
    return investigationFingerprint(a).localeCompare(investigationFingerprint(b));
  });
}

/**
 * Read the investigation store with fold-on-read semantics:
 * supersede chains collapsed (latest non-superseded note per chain wins),
 * heat ticks aggregated into one counter per anchor ref.
 * Missing file yields empty results; corrupt lines are skipped.
 */
export function readInvestigations(flowDir: string): InvestigationReadResult {
  const { notes, heatContributions } = parseInvestigationsFile(investigationsPath(flowDir));
  const { kept } = collapseSupersedeChains(notes);
  return { notes: sortNotes(kept), heat: aggregateHeat(heatContributions) };
}

/**
 * Compact the investigation store in place: rewrite the file as one
 * aggregated heat line per anchor ref (preserving TOTAL counts and
 * `lastVisited` — count history is never lost) followed by every
 * non-superseded note. Superseded notes are dropped — that is the point of
 * compaction; non-superseded notes are ALWAYS kept.
 *
 * Concurrency-safe: runs under the store's exclusive-create lock file
 * (stale locks reclaimed), and the compacted content is written to a temp
 * file in the same directory then renamed into place — readers never observe
 * a partially-written file. Idempotent: compacting a compacted file is a
 * no-op. On lock contention this throws a one-line error, handled by the
 * CLI's existing fail-soft catch.
 */
export function compactInvestigations(flowDir: string): CompactionResult {
  const blueprintDir = ensureBlueprintDir(flowDir);
  const filePath = join(blueprintDir, INVESTIGATIONS_FILENAME);
  const tempPath = join(blueprintDir, INVESTIGATIONS_TEMP_FILENAME);
  const lockPath = join(blueprintDir, INVESTIGATIONS_LOCK_FILENAME);

  if (!existsSync(filePath)) {
    return { notesKept: 0, notesDropped: 0, heatLinesBefore: 0, heatLinesAfter: 0 };
  }

  if (!acquireGraphLock(lockPath)) {
    throw new Error('investigation store is locked by another writer — retry shortly');
  }

  try {
    const { notes, heatContributions, heatLineCount } = parseInvestigationsFile(filePath);
    const { kept, dropped } = collapseSupersedeChains(notes);
    const counters = aggregateHeat(heatContributions);
    const sortedKept = sortNotes(kept);

    const lines = [
      ...counters.map((counter) => JSON.stringify({ kind: 'heat', ...counter })),
      ...sortedKept.map((note) => JSON.stringify({ kind: 'note', ...note })),
    ];
    const content = lines.length > 0 ? `${lines.join('\n')}\n` : '';

    // Full rewrite lands in the temp file first; the rename below is atomic
    // on the same filesystem.
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, filePath);

    return {
      notesKept: kept.length,
      notesDropped: dropped,
      heatLinesBefore: heatLineCount,
      heatLinesAfter: counters.length,
    };
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (e.g. reclaimed as stale) — nothing to clean up
    }
  }
}

// ── Path normalization (migration) ──────────────────────────────────────────
// The store is otherwise portable: features, annotations, graph and file-stamps
// carry ZERO absolute paths. Investigation notes are the one leak — an anchor
// captured with a machine-absolute path pins the knowledge to one checkout, so
// it breaks the moment the repo is cloned somewhere else. Normalization is
// therefore a MIGRATION step, not a routine one: it rewrites only the lines
// that actually leak and leaves every other line BYTE-IDENTICAL, because an
// append-only store that gets reformatted wholesale is indistinguishable from
// one that got corrupted.

/** An absolute prefix to strip, and what to put in its place (repo-relative). */
export interface PathRoot {
  /** Absolute directory prefix, e.g. the repo root or the old vault flow dir. */
  prefix: string;
  /** Repo-relative replacement, e.g. `flow` for the vault's flow directory. */
  replacement?: string;
}

/** What a normalization pass did. `unchanged` lines are byte-identical. */
export interface PathNormalizationResult {
  /** Lines read from the store. */
  scanned: number;
  /** Lines rewritten because they carried an absolute path. */
  rewritten: number;
  /** Lines left exactly as they were, byte for byte. */
  unchanged: number;
}

/** Normalize the roots to `{ prefix (no trailing slash), replacement }`, longest first. */
function normalizeRoots(roots: readonly (string | PathRoot)[]): Required<PathRoot>[] {
  return roots
    .map((root) => (typeof root === 'string' ? { prefix: root, replacement: '' } : root))
    .map((root) => ({
      prefix: resolve(root.prefix).replace(/\/+$/, ''),
      replacement: (root.replacement ?? '').replace(/\/+$/, ''),
    }))
    .filter((root) => root.prefix.length > 1)
    // Longest prefix first: the vault flow dir sits INSIDE the vault root, and
    // the more specific mapping has to win.
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * Replace every `<prefix>/` occurrence in `value` with its repo-relative form.
 * A pure prefix strip: the surrounding text is never touched, so a note's prose
 * keeps its wording and only the path inside it becomes portable.
 */
function relativizeValue(value: string, roots: readonly Required<PathRoot>[]): string {
  let out = value;
  for (const root of roots) {
    if (!out.includes(root.prefix)) continue;
    const head = root.replacement.length > 0 ? `${root.replacement}/` : '';
    out = out.split(`${root.prefix}/`).join(head);
    // A bare reference to the root itself becomes the replacement (or `.`).
    out = out.split(root.prefix).join(root.replacement.length > 0 ? root.replacement : '.');
  }
  return out;
}

/** Rewrite the path-bearing fields of one parsed record. Returns null when
 *  nothing changed, so the caller can keep the original line untouched. */
function relativizeRecord(
  record: Record<string, unknown>,
  roots: readonly Required<PathRoot>[],
): Record<string, unknown> | null {
  let changed = false;
  const next: Record<string, unknown> = { ...record };

  const rewriteString = (value: unknown): unknown => {
    if (typeof value !== 'string') return value;
    const rewritten = relativizeValue(value, roots);
    if (rewritten !== value) changed = true;
    return rewritten;
  };

  if (Array.isArray(record.anchors)) {
    next.anchors = record.anchors.map((anchor) => {
      if (typeof anchor !== 'object' || anchor === null) return anchor;
      const source = anchor as Record<string, unknown>;
      return { ...source, ref: rewriteString(source.ref), ...(source.file === undefined ? {} : { file: rewriteString(source.file) }) };
    });
  }
  if (Array.isArray(record.hashStamps)) {
    next.hashStamps = record.hashStamps.map((stamp) => {
      if (typeof stamp !== 'object' || stamp === null) return stamp;
      const source = stamp as Record<string, unknown>;
      return { ...source, ref: rewriteString(source.ref) };
    });
  }
  // A note's text and provenance can quote a path; the prose around it stays.
  next.text = rewriteString(record.text);
  next.provenance = rewriteString(record.provenance);
  if (record.text === undefined) delete next.text;
  if (record.provenance === undefined) delete next.provenance;
  if (typeof record.anchorRef === 'string') next.anchorRef = rewriteString(record.anchorRef);

  return changed ? next : null;
}

/**
 * Rewrite absolute paths in `investigations.jsonl` to repo-relative form.
 *
 * Line-by-line and conservative: a line with no absolute path is copied through
 * BYTE-IDENTICAL (not re-serialized), and a corrupt line is preserved verbatim
 * rather than dropped — normalization is not a compaction and must never lose
 * an entry. Runs under the store's write lock and lands via temp + rename, so a
 * reader never sees a half-written file. Missing file → a no-op zero result.
 */
export function normalizeInvestigationPaths(
  flowDir: string,
  roots: readonly (string | PathRoot)[],
): PathNormalizationResult {
  const filePath = investigationsPath(flowDir);
  const result: PathNormalizationResult = { scanned: 0, rewritten: 0, unchanged: 0 };
  if (!existsSync(filePath)) return result;

  const normalizedRoots = normalizeRoots(roots);
  if (normalizedRoots.length === 0) return result;

  const raw = readFileSync(filePath, 'utf-8');
  const endsWithNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (endsWithNewline) lines.pop();

  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      out.push(line);
      continue;
    }
    result.scanned += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: a corrupt line is kept exactly as found.
      out.push(line);
      result.unchanged += 1;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      out.push(line);
      result.unchanged += 1;
      continue;
    }
    const rewritten = relativizeRecord(parsed as Record<string, unknown>, normalizedRoots);
    if (rewritten === null) {
      out.push(line);
      result.unchanged += 1;
      continue;
    }
    out.push(JSON.stringify(rewritten));
    result.rewritten += 1;
  }

  if (result.rewritten === 0) return result;

  const blueprintDir = ensureBlueprintDir(flowDir);
  const tempPath = join(blueprintDir, INVESTIGATIONS_TEMP_FILENAME);
  const lockPath = join(blueprintDir, INVESTIGATIONS_LOCK_FILENAME);
  if (!acquireGraphLock(lockPath)) {
    throw new Error(INVESTIGATION_STORE_BUSY_NOTICE);
  }
  try {
    writeFileSync(tempPath, out.length > 0 ? `${out.join('\n')}${endsWithNewline ? '\n' : ''}` : '', 'utf-8');
    renameSync(tempPath, filePath);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (e.g. reclaimed as stale) — nothing to clean up
    }
  }

  return result;
}

/**
 * Compact the store only when a maintenance threshold is crossed:
 * - file size ≥ `COMPACT_MIN_BYTES` (cheap `stat` — compacts unconditionally), OR
 * - fold-dropped ratio ≥ `COMPACT_DROPPED_RATIO` (superseded notes plus
 *   aggregatable heat ticks, over all valid lines).
 *
 * Returns the `CompactionResult` when a compaction ran, null when skipped
 * (missing file, unreadable stat, or below both thresholds — the file is not
 * touched). The production caller is `deriveBlueprint` (C3 wiring — the
 * store's maintenance runs on every derive); lock contention propagates as
 * `compactInvestigations`' one-line error for the caller's fail-soft catch.
 */
export function maybeCompactInvestigations(flowDir: string): CompactionResult | null {
  const filePath = investigationsPath(flowDir);
  if (!existsSync(filePath)) {
    return null;
  }

  let fileBytes: number;
  try {
    fileBytes = statSync(filePath).size;
  } catch {
    // Sanctioned fail-soft: file vanished between existence check and stat — nothing to compact
    return null;
  }

  if (fileBytes < COMPACT_MIN_BYTES) {
    const { notes, heatContributions, heatLineCount } = parseInvestigationsFile(filePath);
    const { dropped } = collapseSupersedeChains(notes);
    const foldableLines = dropped + (heatLineCount - aggregateHeat(heatContributions).length);
    const validLines = notes.length + heatLineCount;
    if (validLines === 0 || foldableLines / validLines < COMPACT_DROPPED_RATIO) {
      return null;
    }
  }

  return compactInvestigations(flowDir);
}
