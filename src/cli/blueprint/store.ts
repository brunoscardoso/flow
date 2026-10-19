/**
 * File I/O for the blueprint stores under `<flowDir>/brain/.structure/`.
 *
 * Two stores live here:
 * - `graph.json` — the derived system graph, rewritten in full on each derive
 *   run (previous version rotated to `graph.prev.json`).
 * - `annotations.jsonl` + `status-events.jsonl` — append-only annotation
 *   stream; status events fold into effective annotation status on read.
 *
 * Corrupt or missing files never throw — readers return empty structures.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  Anchor,
  AnchorKind,
  AnnotationEntry,
  AnnotationStatus,
  AnnotationStatusEvent,
  BlueprintGraph,
} from './types.js';

/** Name of the blueprint directory under the flow directory (shared with sibling store modules). */
export const BLUEPRINT_DIRNAME = join('brain', '.structure');
const GRAPH_FILENAME = 'graph.json';

/**
 * Forward-slash display path of the derived graph, for every user- and
 * agent-facing message that names the graph's location. Derived from
 * `BLUEPRINT_DIRNAME` so a reported path can never drift from the real write
 * location again (#76). Forward slashes keep it byte-identical across platforms.
 */
export const BLUEPRINT_GRAPH_DISPLAY_PATH = `flow/${BLUEPRINT_DIRNAME.split(/[\\/]/).join('/')}/${GRAPH_FILENAME}`;
const GRAPH_PREV_FILENAME = 'graph.prev.json';
const GRAPH_TEMP_FILENAME = 'graph.json.tmp';
const GRAPH_LOCK_FILENAME = 'graph.lock';
const ANNOTATIONS_FILENAME = 'annotations.jsonl';
const STATUS_EVENTS_FILENAME = 'status-events.jsonl';
const JSON_INDENT = 2;

/** A graph lock older than this is considered abandoned and reclaimed. */
const GRAPH_LOCK_STALE_MS = 30_000;
/** Attempts to acquire the graph lock before failing soft. */
const GRAPH_LOCK_MAX_ATTEMPTS = 5;
/** Pause between graph lock acquisition attempts. */
const GRAPH_LOCK_RETRY_DELAY_MS = 50;

/** The five anchor granularities accepted when parsing annotation lines. */
const ANCHOR_KINDS: readonly AnchorKind[] = ['symbol', 'file', 'table', 'endpoint', 'module'];

/**
 * Ensure the blueprint directory exists under the flow directory.
 * Returns the absolute path to `<flowDir>/brain/.structure/`.
 */
export function ensureBlueprintDir(flowDir: string): string {
  const blueprintDir = join(flowDir, BLUEPRINT_DIRNAME);
  mkdirSync(blueprintDir, { recursive: true });
  return blueprintDir;
}

/**
 * Compute the stable fingerprint of an annotation:
 * `<type>+<text>+<JSON array of sorted anchor refs>`.
 * The anchor-set component is JSON-serialized so a single ref containing a
 * comma can never collide with a multi-anchor set.
 * Status events target annotations by this fingerprint.
 */
export function annotationFingerprint(entry: Pick<AnnotationEntry, 'type' | 'text' | 'anchors'>): string {
  const sortedRefs = entry.anchors.map((anchor) => anchor.ref).sort();
  return `${entry.type}+${entry.text}+${JSON.stringify(sortedRefs)}`;
}

/**
 * Read the derived system graph from `graph.json`.
 * Returns null if the file is missing, empty, or contains corrupt JSON —
 * absence of a graph must never throw.
 */
export function readGraph(flowDir: string): BlueprintGraph | null {
  const filePath = join(flowDir, BLUEPRINT_DIRNAME, GRAPH_FILENAME);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return null;
    }
    const parsed = JSON.parse(content) as BlueprintGraph;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON — treat as missing; the graph is rebuilt, never patched
    return null;
  }
}

/** Block the current thread for `ms` milliseconds (store I/O is fully sync). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether an existing graph lock is older than the staleness timeout. */
function graphLockIsStale(lockPath: string): boolean {
  try {
    return Date.now() - statSync(lockPath).mtimeMs > GRAPH_LOCK_STALE_MS;
  } catch {
    // Lock vanished between attempts — the next open attempt decides
    return false;
  }
}

/**
 * Acquire a store write lock via exclusive create (`wx` → O_EXCL).
 * A lock older than `GRAPH_LOCK_STALE_MS` is treated as abandoned by a
 * crashed writer and reclaimed. Returns false when the lock stays contended
 * after `GRAPH_LOCK_MAX_ATTEMPTS` attempts.
 *
 * Exported for reuse by sibling blueprint stores (e.g. the investigation
 * store) — same semantics, caller supplies its own lock file path.
 */
export function acquireGraphLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < GRAPH_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      closeSync(openSync(lockPath, 'wx'));
      return true;
    } catch (error) {
      // ONLY `EEXIST` MEANS THE LOCK IS HELD. This catch used to be bare, which
      // made every other failure — above all a permission denial — wear the
      // word "busy". A sandboxed caller that cannot write into the store at all
      // then retried, found no lock to reclaim (there is no file), slept, and
      // reported `store busy — retry` forever. It cost a live debugging session
      // in which a user regenerated the same document five times against an
      // error that could never clear, because nothing was ever locked.
      //
      // Anything that is not EEXIST is re-thrown with its real cause, so the
      // caller's refusal line names what actually happened.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== undefined && code !== 'EEXIST') {
        throw new Error(
          `cannot write the blueprint store at ${lockPath}: ${code}` +
            (code === 'EACCES' || code === 'EPERM'
              ? ' — the path is not writable by this process (a sandboxed agent reaching a symlinked flow/ directory hits this)'
              : ''),
        );
      }
      // Lock held by a concurrent derive — reclaim if stale, else retry briefly
      if (graphLockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Another process reclaimed it first — fall through and retry
        }
        continue;
      }
      sleepSync(GRAPH_LOCK_RETRY_DELAY_MS);
    }
  }
  return false;
}

/**
 * Write the derived system graph to `graph.json`, rotating any existing
 * graph to `graph.prev.json` first so the previous derive run is preserved.
 *
 * Concurrency-safe: the rotate+write sequence runs under an exclusive-create
 * lock file (stale locks reclaimed after `GRAPH_LOCK_STALE_MS`), and the new
 * graph is written to a temp file in the same directory then renamed into
 * place — readers never observe a partially-written `graph.json`. On lock
 * contention this throws a one-line error, handled by the CLI's existing
 * fail-soft catch (message + exit code 1, no stack trace).
 */
export function writeGraph(flowDir: string, graph: BlueprintGraph): void {
  const blueprintDir = ensureBlueprintDir(flowDir);
  const graphPath = join(blueprintDir, GRAPH_FILENAME);
  const prevPath = join(blueprintDir, GRAPH_PREV_FILENAME);
  const tempPath = join(blueprintDir, GRAPH_TEMP_FILENAME);
  const lockPath = join(blueprintDir, GRAPH_LOCK_FILENAME);

  if (!acquireGraphLock(lockPath)) {
    throw new Error('blueprint graph is locked by another derive — retry shortly');
  }

  try {
    // Full serialization lands in the temp file first; both renames below are
    // atomic on the same filesystem.
    writeFileSync(tempPath, `${JSON.stringify(graph, null, JSON_INDENT)}\n`, 'utf-8');
    if (existsSync(graphPath)) {
      renameSync(graphPath, prevPath);
    }
    renameSync(tempPath, graphPath);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Lock already removed (e.g. reclaimed as stale) — nothing to clean up
    }
  }
}

/**
 * Append one annotation record to the append-only `annotations.jsonl`.
 */
export function appendAnnotation(flowDir: string, entry: AnnotationEntry): void {
  const blueprintDir = ensureBlueprintDir(flowDir);
  const filePath = join(blueprintDir, ANNOTATIONS_FILENAME);
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

/**
 * Append one status transition to `status-events.jsonl`.
 * Annotations are never rewritten — stale-flagging happens via these events.
 */
export function appendStatusEvent(flowDir: string, event: AnnotationStatusEvent): void {
  const blueprintDir = ensureBlueprintDir(flowDir);
  const filePath = join(blueprintDir, STATUS_EVENTS_FILENAME);
  appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
}

/**
 * Read all non-empty lines from a JSONL file.
 * Returns an empty array if the file is missing or unreadable.
 *
 * Exported for reuse by sibling blueprint stores (e.g. the investigation
 * store) — behavior is identical for every JSONL file under `brain/.structure/`.
 */
export function readJsonlLines(filePath: string): string[] {
  if (!existsSync(filePath)) {
    return [];
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return content.split('\n').filter((line) => line.trim().length > 0);
}

/**
 * Result of hashing a repo-relative file against `repoRoot`: the digest, or
 * why one could not be produced — `escapes` when the resolved path falls
 * outside `repoRoot` (containment check, W1), `missing` when it does not
 * exist (or is otherwise unreadable).
 */
export type RepoFileHashResult =
  | { status: 'ok'; contentHash: string }
  | { status: 'escapes' }
  | { status: 'missing' };

/**
 * Compute the SHA-256 hex digest of a repo-relative file's content, resolved
 * and containment-checked against `repoRoot`.
 *
 * The ONE file-hashing code path (allowed-pattern #14): `blueprint observe`
 * calls this to hash-stamp anchored files at write time, and `blueprint
 * stale-check` calls it again later to re-hash those same files and detect
 * drift — containment and digest rules can never diverge between the writer
 * and the reader because both go through here.
 */
export function hashRepoFile(repoRoot: string, relPath: string): RepoFileHashResult {
  const resolvedRepoRoot = resolve(repoRoot);
  const absolutePath = resolve(resolvedRepoRoot, relPath);
  if (absolutePath !== resolvedRepoRoot && !absolutePath.startsWith(`${resolvedRepoRoot}${sep}`)) {
    return { status: 'escapes' };
  }
  if (!existsSync(absolutePath)) {
    return { status: 'missing' };
  }
  try {
    return {
      status: 'ok',
      contentHash: hashFileContent(readFileSync(absolutePath)),
    };
  } catch {
    // Sanctioned fail-soft: vanished/unreadable between the existsSync check
    // and the read (race, permissions) — treat like "missing"
    return { status: 'missing' };
  }
}

/**
 * Digest already-read file content with the SAME algorithm `hashRepoFile`
 * uses (allowed-pattern #14 — one hashing code path). For callers that must
 * read the file anyway (e.g. code-card extraction), hashing the buffer they
 * read avoids a second read while staying byte-compatible with every stored
 * hash.
 */
export function hashFileContent(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * A stored-hash HINT for the stat pre-filter: the content hash a prior store
 * recorded for a file, plus the file's mtime+size at the moment that hash was
 * taken (`file-stamps.json` stamps carry exactly this shape).
 */
export interface RepoFileHashHint {
  contentHash: string;
  mtimeMs?: number;
  size?: number;
}

/**
 * Stat-gated variant of `hashRepoFile` (forbidden-pattern #10 discipline):
 * mtime+size may only short-circuit toward the HINT'S OWN stored hash, and
 * only when BOTH match the hint's recorded values — any mismatch, a missing
 * hint, or hint stat fields absent falls through to the full content hash,
 * which remains the only truth. The ONE stat-pre-filter code path shared by
 * file-stamps, file-tiers, and code-cards.
 */
export function hashRepoFileWithHint(
  repoRoot: string,
  relPath: string,
  hint: RepoFileHashHint | undefined,
): RepoFileHashResult {
  if (hint !== undefined && typeof hint.mtimeMs === 'number' && typeof hint.size === 'number') {
    const stat = statRepoFile(repoRoot, relPath);
    if (stat.status === 'escapes') {
      return { status: 'escapes' };
    }
    if (stat.status === 'ok' && stat.mtimeMs === hint.mtimeMs && stat.size === hint.size) {
      return { status: 'ok', contentHash: hint.contentHash };
    }
    // stat mismatch or file gone — fall through: content is the truth
  }
  return hashRepoFile(repoRoot, relPath);
}

/** Result of stat'ing a repo-relative file: cheap change hints, or why not. */
export type RepoFileStatResult =
  | { status: 'ok'; mtimeMs: number; size: number }
  | { status: 'escapes' }
  | { status: 'missing' };

/**
 * Stat a repo-relative file (mtime + size), resolved and containment-checked
 * against `repoRoot` with the SAME rules as `hashRepoFile`. Used as a cheap
 * PRE-FILTER by the drift baseline: a stamp whose recorded mtime+size still
 * match can skip re-hashing; any mismatch falls through to the content hash,
 * which remains the only truth (forbidden-pattern #10).
 */
export function statRepoFile(repoRoot: string, relPath: string): RepoFileStatResult {
  const resolvedRepoRoot = resolve(repoRoot);
  const absolutePath = resolve(resolvedRepoRoot, relPath);
  if (absolutePath !== resolvedRepoRoot && !absolutePath.startsWith(`${resolvedRepoRoot}${sep}`)) {
    return { status: 'escapes' };
  }
  try {
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      return { status: 'missing' };
    }
    return { status: 'ok', mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    // Missing or unreadable — the caller treats both as "must re-hash / gone".
    return { status: 'missing' };
  }
}

/**
 * Whether one parsed anchor element is structurally valid: an object whose
 * `kind` is one of the five anchor kinds, whose `ref` is a non-empty string,
 * and whose `file` is absent or a string.
 *
 * Exported for reuse by sibling blueprint stores (e.g. the investigation
 * store) — anchor validity rules are shared across all anchored streams.
 */
export function isValidAnchor(value: unknown): value is Anchor {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as { kind?: unknown; ref?: unknown; file?: unknown };
  if (typeof candidate.kind !== 'string' || !ANCHOR_KINDS.includes(candidate.kind as AnchorKind)) {
    return false;
  }
  if (typeof candidate.ref !== 'string' || candidate.ref.length === 0) {
    return false;
  }
  return candidate.file === undefined || typeof candidate.file === 'string';
}

/**
 * Parse one annotation line. Records without anchors or status parse
 * unchanged — anchors default to empty, status defaults to active.
 * Malformed anchor elements are dropped individually — valid siblings are
 * kept, and an entry whose anchors all drop becomes a zero-anchor entry
 * (zero-anchor entries are never staled). Returns null for corrupt or
 * shape-invalid lines.
 */
function parseAnnotationLine(line: string): AnnotationEntry | null {
  try {
    const parsed = JSON.parse(line) as Partial<AnnotationEntry>;
    if (typeof parsed.text !== 'string' || typeof parsed.type !== 'string') {
      return null;
    }
    const anchors: Anchor[] = Array.isArray(parsed.anchors) ? parsed.anchors.filter(isValidAnchor) : [];
    return {
      ts: typeof parsed.ts === 'string' ? parsed.ts : '',
      runId: typeof parsed.runId === 'string' ? parsed.runId : null,
      type: parsed.type,
      text: parsed.text,
      anchors,
      provenance: typeof parsed.provenance === 'string' ? parsed.provenance : '',
      status: parsed.status === 'stale' ? 'stale' : 'active',
    };
  } catch {
    // Corrupt line — skip it rather than failing the whole read
    return null;
  }
}

/**
 * Build the effective status per annotation fingerprint by folding status
 * events in file (append) order — the last event for a fingerprint wins.
 */
function foldStatusEvents(filePath: string): Map<string, AnnotationStatus> {
  const effectiveStatus = new Map<string, AnnotationStatus>();

  for (const line of readJsonlLines(filePath)) {
    try {
      const event = JSON.parse(line) as Partial<AnnotationStatusEvent>;
      if (typeof event.targetFingerprint !== 'string') {
        continue;
      }
      if (event.status !== 'active' && event.status !== 'stale') {
        continue;
      }
      effectiveStatus.set(event.targetFingerprint, event.status);
    } catch {
      // Corrupt line — skip it
    }
  }

  return effectiveStatus;
}

/**
 * Read the annotation stream and return entries with their effective status.
 *
 * Reads `annotations.jsonl`, folds `status-events.jsonl` into each entry's
 * status (matched by fingerprint `<type>+<text>+<JSON array of sorted anchor refs>`), and
 * returns the effective entries. Missing or corrupt files yield an empty
 * array; corrupt individual lines are skipped.
 */
export function readAnnotations(flowDir: string): AnnotationEntry[] {
  const blueprintDir = join(flowDir, BLUEPRINT_DIRNAME);
  const annotationLines = readJsonlLines(join(blueprintDir, ANNOTATIONS_FILENAME));
  const effectiveStatus = foldStatusEvents(join(blueprintDir, STATUS_EVENTS_FILENAME));

  const entries: AnnotationEntry[] = [];

  for (const line of annotationLines) {
    const entry = parseAnnotationLine(line);
    if (entry === null) {
      continue;
    }
    const overriddenStatus = effectiveStatus.get(annotationFingerprint(entry));
    entries.push(overriddenStatus === undefined ? entry : { ...entry, status: overriddenStatus });
  }

  return entries;
}
