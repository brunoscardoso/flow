/**
 * Broadened drift detector: `blueprint drift-check`.
 *
 * Where `blueprint stale-check` re-hashes only the files stamped by
 * ALREADY-LEARNED investigation notes, this pass diffs the FULL-graph baseline
 * (`file-stamps.json`, written by every derive) against the current disk
 * content — so a change to a never-learned module still surfaces. For each
 * baseline stamp it re-hashes with the SAME `hashRepoFile` helper the baseline
 * used (allowed-pattern #14 — one file-hashing code path), classifying every
 * path `changed` / `missing`, plus current source files absent from the
 * baseline as `added`, and best-effort collapsing move pairs into `renamed`.
 *
 * Read-only and side-effect-free — no writes, pure for the same on-disk
 * inputs. Content hash is the ONLY truth (forbidden-pattern #10); the stamps'
 * recorded mtime+size act purely as a PRE-FILTER (a stat-identical file skips
 * re-hashing; any difference falls through to the hash). Fail-soft: an
 * unreadable file is treated as `missing`, never thrown.
 *
 * COLD-INDEX rule: with no baseline (missing/empty store) the report is
 * `{ baselineAt: null, entries: [] }` — a first derive must never flag every
 * file as drift (mirrors must-review's "first derive skips deltas").
 */

import { buildDriftOwnerIndex, driftOwnerNodeId, type DriftOwnerIndex } from './drift-owner.js';
import { isCodeFile, walkRepo } from './extractors/scan.js';
import { readFileStamps, type FileStamp } from './file-stamps.js';
import { hashRepoFile, statRepoFile } from './store.js';
import type { BlueprintGraph } from './types.js';

/** How a path drifted from the baseline. */
export type DriftKind = 'changed' | 'missing' | 'added' | 'renamed';

/** One drifted path, mapped to its owning graph node where one exists. */
export interface DriftEntry {
  /** Repo-relative path that drifted (for `renamed`, the NEW path). */
  path: string;
  kind: DriftKind;
  /** `id` of the graph node whose `sourceFile` is `path`, when one exists. */
  nodeId?: string;
  /** For `renamed`: the baseline path the content moved from. */
  renamedFrom?: string;
}

/** Full drift report over the full-graph baseline. */
export interface DriftReport {
  /** ISO 8601 `derivedAt` of the baseline, or null on a cold index. */
  baselineAt: string | null;
  /** Drifted paths, sorted by `path`. */
  entries: DriftEntry[];
}

/**
 * Current content hash of a repo-relative file, or null when it cannot be read
 * (missing, a directory, escapes the repo root, or a read race) — every
 * unreadable case collapses to null so the caller treats it as gone.
 */
function currentHash(repoRoot: string, relPath: string): string | null {
  const result = hashRepoFile(repoRoot, relPath);
  return result.status === 'ok' ? result.contentHash : null;
}

/** Whether a stamp's stat pre-filter hints still match the file on disk —
 *  the cheap "definitely unchanged" fast path. False for legacy stamps with
 *  no hints (they always re-hash) and on any stat difference or failure. */
function statMatchesStamp(repoRoot: string, stamp: FileStamp): boolean {
  if (typeof stamp.mtimeMs !== 'number' || typeof stamp.size !== 'number') {
    return false;
  }
  const stat = statRepoFile(repoRoot, stamp.path);
  return stat.status === 'ok' && stat.mtimeMs === stamp.mtimeMs && stat.size === stamp.size;
}

/**
 * Attribution index for the graph (#1155). Exact sourceFile match first, then
 * the deepest DIRECTORY-owning node containing the path — module nodes own a
 * directory, so an exact-only rule dropped ~99% of source drift on the floor.
 * See drift-owner.ts.
 */
function sourceFileOwners(graph: BlueprintGraph): DriftOwnerIndex {
  return buildDriftOwnerIndex(graph.nodes);
}

/**
 * Compute the drift report for `graph` against the full-graph baseline under
 * `flowDir`. Deterministic and pure: baseline stamps and current source files
 * are diffed by content hash, move pairs collapse into `renamed`, and the
 * entries are sorted by `path`. Fail-soft everywhere — a missing baseline
 * yields the cold-index report, and unreadable files are reported as
 * `missing`, never thrown.
 */
export function computeDrift(repoRoot: string, flowDir: string, graph: BlueprintGraph): DriftReport {
  const baseline = readFileStamps(flowDir);
  // Cold index — never report every file as drift on a first derive.
  if (baseline === null || baseline.stamps.length === 0) {
    return { baselineAt: null, entries: [] };
  }

  const baselineHashByPath = new Map<string, string>();
  for (const stamp of baseline.stamps) {
    baselineHashByPath.set(stamp.path, stamp.contentHash);
  }
  const owners = sourceFileOwners(graph);

  // Pass 1 — classify every baseline path against its current content. The
  // stat PRE-FILTER makes this cheap on the common all-clean case: a stamp
  // whose recorded mtime+size still match is taken as unchanged WITHOUT
  // re-reading + hashing the file (a ~900-file repo drops from ~900 full
  // reads to ~900 stats per check). Any stat mismatch — or a legacy stamp
  // with no hints — falls through to the content hash, which stays the only
  // truth (forbidden-pattern #10): a real edit always moves mtime/size, and
  // the hash still decides whether the content actually differs.
  const changed: DriftEntry[] = [];
  const missing: Array<{ path: string; baselineHash: string }> = [];
  for (const stamp of baseline.stamps) {
    if (statMatchesStamp(repoRoot, stamp)) {
      continue; // fast path: stat unchanged → content taken as unchanged
    }
    const current = currentHash(repoRoot, stamp.path);
    if (current === null) {
      missing.push({ path: stamp.path, baselineHash: stamp.contentHash });
    } else if (current !== stamp.contentHash) {
      changed.push({ path: stamp.path, kind: 'changed', nodeId: driftOwnerNodeId(stamp.path, owners) });
    }
  }

  // Pass 2 — current source files absent from the baseline are `added`,
  // keyed by their current hash so Pass 3 can pair them with moved-away files.
  //
  // THE UNIVERSE SCANNED HERE MUST BE THE ONE THE BASELINE STAMPS (#1674).
  // The baseline is a full-tree snapshot: every code file under a module
  // DIRECTORY, not just graph-node sourceFiles. Iterating `owners.exact`
  // (graph nodes only) made module-internal adds invisible and broke rename
  // collapse for them — a rename surfaced as a spurious deletion with the
  // moved-to file nowhere. So the candidates mirror `computeFileStamps`:
  // every node sourceFile, plus every walked code file under one that is a
  // directory prefix. A sourceFile that is itself a directory fails
  // `currentHash` (read of a directory) and drops out harmlessly.
  const candidates = new Set<string>();
  const prefixes: string[] = [];
  for (const node of graph.nodes) {
    const relPath = node.sourceFile;
    if (typeof relPath !== 'string' || relPath.length === 0) {
      continue;
    }
    const normalized = relPath.replace(/\/+$/, '');
    candidates.add(normalized);
    prefixes.push(normalized);
  }
  for (const file of walkRepo(repoRoot).files) {
    if (candidates.has(file) || !isCodeFile(file)) {
      continue;
    }
    if (prefixes.some((dir) => file.startsWith(`${dir}/`))) {
      candidates.add(file);
    }
  }

  const added: Array<{ path: string; currentHash: string }> = [];
  for (const path of candidates) {
    if (baselineHashByPath.has(path)) {
      continue;
    }
    const current = currentHash(repoRoot, path);
    if (current !== null) {
      added.push({ path, currentHash: current });
    }
  }

  // Pass 3 — best-effort rename collapse: a `missing` path whose baseline hash
  // equals an `added` path's current hash is the same content moved. Pair
  // deterministically (both sides sorted by path, first free match wins).
  const missingSorted = [...missing].sort((a, b) => a.path.localeCompare(b.path));
  const addedSorted = [...added].sort((a, b) => a.path.localeCompare(b.path));
  const consumedAdded = new Set<string>();
  const consumedMissing = new Set<string>();
  const renamed: DriftEntry[] = [];
  for (const gone of missingSorted) {
    const match = addedSorted.find(
      (candidate) => !consumedAdded.has(candidate.path) && candidate.currentHash === gone.baselineHash,
    );
    if (match === undefined) {
      continue;
    }
    consumedAdded.add(match.path);
    consumedMissing.add(gone.path);
    renamed.push({ path: match.path, kind: 'renamed', nodeId: driftOwnerNodeId(match.path, owners), renamedFrom: gone.path });
  }

  const entries: DriftEntry[] = [...changed, ...renamed];
  for (const gone of missing) {
    if (!consumedMissing.has(gone.path)) {
      entries.push({ path: gone.path, kind: 'missing', nodeId: driftOwnerNodeId(gone.path, owners) });
    }
  }
  for (const candidate of added) {
    if (!consumedAdded.has(candidate.path)) {
      entries.push({ path: candidate.path, kind: 'added', nodeId: driftOwnerNodeId(candidate.path, owners) });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return { baselineAt: baseline.derivedAt, entries };
}
