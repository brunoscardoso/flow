/**
 * Full-graph content-hash BASELINE for the blueprint drift detector.
 *
 * Where `blueprint observe` hash-stamps only the file-backed anchors of a
 * NARRATED investigation note, this store stamps the source file of EVERY
 * graph node at derive time — so a change to a never-learned module still
 * produces a signal (`blueprint drift-check`). Unlike `graph.json`, the
 * baseline is a STABLE "last seen" reference: it is established ONCE (first
 * derive, `establishFileStampsIfMissing`) and advanced only when the user has
 * SEEN the changes — `advanceFileStamps` (ack specific files) or a full reset
 * (`writeFileStamps`, "mark everything reviewed"). It is NOT clobbered on every
 * derive, so a re-derive after a pull cannot silently chase the change and make
 * drift vanish. The previous version is still rotated to `file-stamps.prev.json`
 * on every write.
 *
 * Content hash is the ONLY truth (forbidden-pattern #10). Each stamp ALSO
 * records the file's mtime+size at stamp time as a cheap PRE-FILTER hint:
 * drift-check skips re-hashing a file whose stat still matches its stamp, and
 * re-hashes (the truth) the moment either differs. Every hash goes through the
 * SAME `hashRepoFile` helper `observe`/`stale-check` use (allowed-pattern #14
 * — one file-hashing code path). Corrupt or missing stores never throw —
 * readers return null, the writer fails soft.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLUEPRINT_DIRNAME, ensureBlueprintDir, hashRepoFile, hashRepoFileWithHint, statRepoFile } from './store.js';
import { isCodeFile, walkRepo, type RepoScan } from './extractors/scan.js';
import type { BlueprintGraph } from './types.js';

/** One stamped source file: its repo-relative path and content digest. */
export interface FileStamp {
  /** Repo-relative path of the stamped file. */
  path: string;
  /** SHA-256 hex digest of the file's content at derive time. */
  contentHash: string;
  /** File mtime (ms) at stamp time — pre-filter hint only, never the truth. */
  mtimeMs?: number;
  /** File size (bytes) at stamp time — pre-filter hint only, never the truth. */
  size?: number;
}

/** The full-graph baseline written at derive time. */
export interface FileStampStore {
  /** ISO 8601 timestamp of the derive run that produced the baseline. */
  derivedAt: string;
  /** One stamp per real source file the graph references, sorted by `path`. */
  stamps: FileStamp[];
}

const FILE_STAMPS_FILENAME = 'file-stamps.json';
const FILE_STAMPS_PREV_FILENAME = 'file-stamps.prev.json';
const FILE_STAMPS_TEMP_FILENAME = 'file-stamps.json.tmp';
const JSON_INDENT = 2;

/** Whether `file` is `dir` itself or lives underneath it (posix paths). */
function isUnderDir(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

/** Build a stamp for a hashed file, attaching the stat pre-filter hints when
 *  the file stats cleanly (fail-soft: no stat → a hint-less stamp, which
 *  drift-check always re-hashes — correct, just slower for that file). */
function stampFor(repoRoot: string, path: string, contentHash: string): FileStamp {
  const stat = statRepoFile(repoRoot, path);
  if (stat.status !== 'ok') {
    return { path, contentHash };
  }
  return { path, contentHash, mtimeMs: stat.mtimeMs, size: stat.size };
}

/**
 * Compute the full-graph baseline for `graph`. Most graph nodes are MODULES
 * whose `sourceFile` is a DIRECTORY (a folder roll-up), so stamping only the
 * literal `sourceFile` of each node would cover almost nothing — drift would
 * miss every edit to a file inside a module. Instead:
 *
 *  1. Nodes whose `sourceFile` is a real file (integrations, datastores, symbol
 *     anchors) are stamped directly.
 *  2. Nodes whose `sourceFile` does not resolve to a file (module directories)
 *     are treated as directory prefixes; the repo is walked ONCE and every CODE
 *     file (`isCodeFile`) living under any such module directory is stamped.
 *     `walkRepo` already skips hidden + artifact dirs (node_modules/dist/…).
 *
 * `missing`/`escapes` hash results are dropped. Deterministic: each path is
 * hashed once and the stamps are sorted by `path`. This computes a full-tree
 * snapshot; whether it becomes the baseline is decided by the caller
 * (`establishFileStampsIfMissing` on first derive, `writeFileStamps` on reset).
 *
 * Perf inputs (both optional, behavior-identical): `repoScan` reuses a
 * pre-computed `walkRepo` result; `previous` supplies the prior baseline's
 * stamps as stat pre-filter HINTS — a file whose current mtime+size both
 * match its own prior stamp reuses that stamp's stored hash without a read
 * (`hashRepoFileWithHint` — any mismatch or missing hint re-hashes content,
 * which stays the only truth, forbidden-pattern #10).
 */
export function computeFileStamps(
  repoRoot: string,
  graph: BlueprintGraph,
  options: { repoScan?: RepoScan; previous?: FileStampStore | null } = {},
): FileStampStore {
  const hashByPath = new Map<string, string>();
  const moduleDirs: string[] = [];
  const hintByPath = new Map<string, FileStamp>();
  for (const stamp of options.previous?.stamps ?? []) {
    hintByPath.set(stamp.path, stamp);
  }

  for (const node of graph.nodes) {
    const relPath = node.sourceFile;
    if (typeof relPath !== 'string' || relPath.length === 0) {
      continue;
    }
    const normalized = relPath.replace(/\/+$/, '');
    if (hashByPath.has(normalized)) {
      continue;
    }
    const result = hashRepoFileWithHint(repoRoot, normalized, hintByPath.get(normalized));
    if (result.status === 'ok') {
      hashByPath.set(normalized, result.contentHash);
    } else if (result.status === 'missing') {
      // A non-file sourceFile — a module directory roll-up (or a genuinely
      // absent file, which simply contributes no children below). Its source
      // files are stamped by the walk. `escapes` is dropped entirely.
      moduleDirs.push(normalized);
    }
  }

  if (moduleDirs.length > 0) {
    for (const file of (options.repoScan ?? walkRepo(repoRoot)).files) {
      if (hashByPath.has(file) || !isCodeFile(file)) {
        continue;
      }
      if (!moduleDirs.some((dir) => isUnderDir(file, dir))) {
        continue;
      }
      const result = hashRepoFileWithHint(repoRoot, file, hintByPath.get(file));
      if (result.status === 'ok') {
        hashByPath.set(file, result.contentHash);
      }
    }
  }

  const stamps: FileStamp[] = [...hashByPath.entries()]
    .map(([path, contentHash]) => stampFor(repoRoot, path, contentHash))
    .sort((a, b) => a.path.localeCompare(b.path));

  return { derivedAt: graph.derivedAt, stamps };
}

/**
 * Write the baseline to `file-stamps.json`, rotating any existing baseline to
 * `file-stamps.prev.json` first (mirrors `writeGraph`). The new store lands in
 * a temp file then renamed into place, so readers never observe a partial
 * write. Fail-soft: any I/O error is swallowed — a stamp failure must never
 * fail an otherwise-successful derive.
 */
export function writeFileStamps(flowDir: string, store: FileStampStore): void {
  try {
    const blueprintDir = ensureBlueprintDir(flowDir);
    const storePath = join(blueprintDir, FILE_STAMPS_FILENAME);
    const prevPath = join(blueprintDir, FILE_STAMPS_PREV_FILENAME);
    const tempPath = join(blueprintDir, FILE_STAMPS_TEMP_FILENAME);

    writeFileSync(tempPath, `${JSON.stringify(store, null, JSON_INDENT)}\n`, 'utf-8');
    if (existsSync(storePath)) {
      renameSync(storePath, prevPath);
    }
    renameSync(tempPath, storePath);
  } catch {
    // Sanctioned fail-soft: the baseline is derived/disposable — a write
    // failure degrades drift-check to a cold index, never fails derive.
  }
}

/**
 * Whether a baseline file (`file-stamps.json`) already exists under `flowDir`.
 * A pure filesystem probe — makes no claim about the file being valid, only
 * present. `establishFileStampsIfMissing` gates on this so an established
 * baseline is never clobbered by a later derive.
 */
export function baselineExists(flowDir: string): boolean {
  return existsSync(join(flowDir, BLUEPRINT_DIRNAME, FILE_STAMPS_FILENAME));
}

/**
 * Establish the baseline ONLY when none exists yet — the derive hook. A change
 * that already drifted from an established baseline must survive re-derives, so
 * this never overwrites an existing store. Returns true when it wrote a fresh
 * baseline, false when one was already present. Fail-soft: `writeFileStamps`
 * swallows I/O errors, so a stamp failure never fails an otherwise-successful
 * derive.
 */
export function establishFileStampsIfMissing(
  repoRoot: string,
  flowDir: string,
  graph: BlueprintGraph,
  repoScan?: RepoScan,
): boolean {
  if (baselineExists(flowDir)) {
    return false;
  }
  writeFileStamps(flowDir, computeFileStamps(repoRoot, graph, { repoScan }));
  return true;
}

/**
 * Advance the baseline for a set of reviewed paths — "I've seen these files".
 * Each given path is re-hashed to its CURRENT content and upserted (added if
 * absent, updated if present); a path that no longer resolves to a file drops
 * its baseline entry entirely. This is how an ack clears specific files from
 * drift without disturbing every other stamp. No-op when no baseline exists or
 * `paths` is empty. Fail-soft: any read/hash/write error is swallowed — an ack
 * that cannot advance the baseline degrades to leaving it untouched, never
 * throws. Content hash is the only truth (forbidden-pattern #10).
 */
export function advanceFileStamps(repoRoot: string, flowDir: string, paths: string[]): void {
  try {
    if (paths.length === 0) {
      return;
    }
    const baseline = readFileStamps(flowDir);
    if (baseline === null) {
      return;
    }
    const stampByPath = new Map<string, FileStamp>();
    for (const stamp of baseline.stamps) {
      stampByPath.set(stamp.path, stamp);
    }
    for (const relPath of paths) {
      const normalized = relPath.replace(/\/+$/, '');
      if (normalized.length === 0) {
        continue;
      }
      const result = hashRepoFile(repoRoot, normalized);
      if (result.status === 'ok') {
        // Fresh hash + fresh stat hints — the reviewed file reads clean and
        // its next drift-check takes the cheap stat fast path.
        stampByPath.set(normalized, stampFor(repoRoot, normalized, result.contentHash));
      } else {
        // The file is gone — drop its stamp so it stops reading as `missing`.
        stampByPath.delete(normalized);
      }
    }
    const stamps: FileStamp[] = [...stampByPath.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    writeFileStamps(flowDir, { derivedAt: baseline.derivedAt, stamps });
  } catch {
    // Sanctioned fail-soft: an ack that cannot advance the baseline leaves the
    // last-seen reference in place — drift simply keeps showing the change.
  }
}

// ── Edge stamps: a relationship's mechanism, hashed ─────────────────────────
//
// A feature edge's `via` names the MECHANISM through which two capabilities
// connect — usually a source file. That file is the thing that can make the
// edge's note wrong: the binder is rewritten, the seam moves, and a confident,
// shared sentence about how two features connect quietly becomes false. It is
// the highest-severity risk in the discovery precisely because nothing errors.
//
// So an edge is stamped exactly like everything else here: the SAME
// `hashRepoFile` helper, content hash as the only truth (forbidden-pattern
// #10), one hashing code path (allowed-pattern #14). No second notion of fresh
// is introduced — the stamp simply travels on the edge, the way an
// investigation note's stamps travel on the note, because an edge is written
// and read per feature rather than per derive.

/** Longest a `via` may be and still plausibly name a path. */
const MAX_VIA_PATH_CHARS = 400;

/**
 * The repo-relative FILE a `via` names, or null when it names no file.
 *
 * A `via` is written by a model, so it arrives in every shape a human writes
 * one: `src/a/binder.ts`, `` `src/a/binder.ts` ``, `file:src/a/binder.ts`,
 * `src/a/binder.ts#resolveSlug`, `src/a/binder.ts:42`. All of those name the
 * same file. A `via` that names a SYMBOL or a seam (`playbook_manifest_binder`,
 * "the manifest handshake") names no file, and returns null — that edge is
 * simply never stamped, which is honest. Never guesses: anything with
 * whitespace, no extension, or an escaping/absolute path is not a file here.
 */
export function edgeViaFile(via: string | undefined): string | null {
  if (typeof via !== 'string' || via.length === 0 || via.length > MAX_VIA_PATH_CHARS) {
    return null;
  }
  let candidate = via.trim().replace(/^[`'"[(]+/, '').replace(/[`'")\]]+$/, '');
  candidate = candidate.replace(/^(?:file|symbol|module):/, '');
  candidate = candidate.split('#')[0];
  candidate = candidate.split('\\').join('/').trim();
  // A locator suffix follows the extension: `foo.ts:42`, not `foo.ts` — mirrors
  // `normalizeAnchorRef`'s rule so a `via` and an anchor read the same way.
  const locator = /^(.*\.[A-Za-z0-9]+):[^/]*$/.exec(candidate);
  if (locator !== null) candidate = locator[1];
  if (candidate.length === 0 || /\s/.test(candidate)) return null;
  if (candidate.startsWith('/') || candidate.startsWith('..')) return null;
  // No extension ⇒ a symbol or a seam, not a file. A directory is not a
  // mechanism either: it cannot be hashed, so it could never go stale.
  if (!/\/?[^/]+\.[A-Za-z0-9]+$/.test(candidate)) return null;
  return candidate;
}

/**
 * Stamp one edge against the repo as it is right now.
 *
 * Returns the edge with `viaHash` set when its `via` resolves to a readable
 * file, and with any previous `viaHash` REMOVED when it does not. Dropping a
 * stamp that can no longer be backed is the point: a hash left behind after its
 * file was deleted or its `via` rewritten would be re-checked forever against
 * nothing, which reports as permanently stale — noise indistinguishable from a
 * real drift.
 */
export function stampEdgeVia<T extends { via?: string; viaHash?: string }>(
  repoRoot: string,
  edge: T,
): T {
  const relPath = edgeViaFile(edge.via);
  const result = relPath === null ? null : hashRepoFile(repoRoot, relPath);
  // Drop any prior stamp: a re-stamp must not inherit a hash it did not compute.
  const { viaHash: _unusedPriorStamp, ...rest } = edge; // eslint-disable-line @typescript-eslint/no-unused-vars
  if (result === null || result.status !== 'ok') {
    return rest as T;
  }
  return { ...rest, viaHash: result.contentHash } as T;
}

/** Stamp every edge in a batch. Order is preserved; nothing is dropped. */
export function stampEdgeVias<T extends { via?: string; viaHash?: string }>(
  repoRoot: string,
  edges: readonly T[],
): T[] {
  return edges.map((edge) => stampEdgeVia(repoRoot, edge));
}

/**
 * What an edge's stamp says about its mechanism, right now.
 *
 *   unstamped — no file-backed `via`, or it was never stamped. Makes NO claim.
 *   fresh     — the file's content still hashes to the stamp.
 *   stale     — the mechanism changed since the edge was recorded.
 *   missing   — the file is gone (or escapes the repo), so the edge's `via`
 *               points at nothing at all.
 *
 * `unstamped` is deliberately not `fresh`: an edge that cannot be checked must
 * never be presented as verified, which is the whole failure this guards.
 */
export type EdgeFreshness = 'unstamped' | 'fresh' | 'stale' | 'missing';

/** Judge one edge's stamp against the file it was taken from. */
export function edgeFreshness(
  repoRoot: string,
  edge: { via?: string; viaHash?: string },
): EdgeFreshness {
  const relPath = edgeViaFile(edge.via);
  if (relPath === null || edge.viaHash === undefined || edge.viaHash.length === 0) {
    return 'unstamped';
  }
  const result = hashRepoFile(repoRoot, relPath);
  if (result.status !== 'ok') return 'missing';
  return result.contentHash === edge.viaHash ? 'fresh' : 'stale';
}

/**
 * Read the baseline from `file-stamps.json`. Returns null when the file is
 * missing, empty, corrupt, or shape-invalid — absence of a baseline must never
 * throw (drift-check treats null as a cold index).
 */
export function readFileStamps(flowDir: string): FileStampStore | null {
  const filePath = join(flowDir, BLUEPRINT_DIRNAME, FILE_STAMPS_FILENAME);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return null;
    }
    const parsed = JSON.parse(content) as Partial<FileStampStore>;
    if (typeof parsed.derivedAt !== 'string' || !Array.isArray(parsed.stamps)) {
      return null;
    }
    const stamps: FileStamp[] = [];
    for (const candidate of parsed.stamps) {
      if (
        typeof candidate === 'object' &&
        candidate !== null &&
        typeof (candidate as FileStamp).path === 'string' &&
        typeof (candidate as FileStamp).contentHash === 'string'
      ) {
        const raw = candidate as FileStamp;
        const stamp: FileStamp = { path: raw.path, contentHash: raw.contentHash };
        // Optional stat pre-filter hints (perf) — kept only when BOTH are valid
        // numbers; a hint-less stamp simply always re-hashes (legacy stores).
        if (typeof raw.mtimeMs === 'number' && typeof raw.size === 'number') {
          stamp.mtimeMs = raw.mtimeMs;
          stamp.size = raw.size;
        }
        stamps.push(stamp);
      }
    }
    return { derivedAt: parsed.derivedAt, stamps };
  } catch {
    // Corrupt JSON — treat as no baseline; it is rebuilt on the next derive
    return null;
  }
}
