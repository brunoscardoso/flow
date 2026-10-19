/**
 * Re-hash pass for the investigation store: `blueprint stale-check`.
 *
 * `blueprint observe` hash-stamps every file-backed anchor of a note at write
 * time (`InvestigationEntry.hashStamps`) but never re-checks those stamps.
 * This module reads the store's ACTIVE notes (fold-on-read — supersede
 * chains already collapsed, so superseded notes are never reported), re-hashes
 * every stamped file with the SAME `hashRepoFile` helper `observe` used to
 * produce the stamp (allowed-pattern #14 — one hashing code path), and reports
 * which notes drifted: a stamped file's content changed, or the file is gone.
 *
 * Read-only and side-effect-free — no writes, no graph required. A note is
 * STALE when at least one of its stamped files changed or went missing;
 * everything else is fresh.
 */

import { hashRepoFile } from './store.js';
import { investigationFingerprint, readInvestigations } from './investigation-store.js';
import { edgeFreshness, edgeViaFile } from './file-stamps.js';
import { edgeKey, readFeatures } from './feature-store.js';
import type { FeatureEdge, FeatureNode } from './feature-store.js';
import type { Anchor, InvestigationEntry } from './types.js';

/** One stale note in a stale-check report. */
export interface StaleNoteResult {
  fingerprint: string;
  anchors: Anchor[];
  /** Stamped files whose current content hash no longer matches the stamp. */
  changedFiles: string[];
  /** Stamped files that no longer exist (or escape the repo root — never legitimately reachable). */
  missingFiles: string[];
  /** Total stamped files this note carries — the `m` in "n of m stamped files changed". */
  totalStamps: number;
}

/**
 * ONE RELATIONSHIP whose mechanism no longer reads the way it did.
 *
 * An edge is a statement about how two capabilities connect, written once and
 * then quoted as fact by everything that reads the feature. When the file its
 * `via` names changes, that statement has to be re-verified — and nothing about
 * a changed file errors, so unless it is SURFACED the wrongness is silent,
 * shared and permanent. This is the discovery's highest-severity risk made
 * visible.
 */
export interface StaleEdgeResult {
  /** Feature that recorded the edge. */
  feature: string;
  /** That feature's slug — the file a reader would open. */
  slug: string;
  /** The other feature's id. */
  target: string;
  /** The mechanism, exactly as recorded. */
  via: string;
  /** The edge's note, carried so a report can say what is now in doubt. */
  note?: string;
  /** `stale` — the mechanism changed. `missing` — the file is gone entirely. */
  state: 'stale' | 'missing';
}

/** Full stale-check report over the (optionally module-scoped) active note set. */
export interface StaleCheckReport {
  /** Active notes examined (after any `--module` filter). */
  checked: number;
  /** Notes examined with every stamped file unchanged. */
  fresh: number;
  /** Notes with at least one changed or missing stamped file, sorted by fingerprint. */
  stale: StaleNoteResult[];
  /**
   * Feature edges whose stamped mechanism changed or vanished, sorted by
   * feature then target. Same pass, same hashing path, same verb — a second
   * command for edges would be a second notion of what "stale" means.
   */
  staleEdges: StaleEdgeResult[];
}

/**
 * The repo-relative file path backing one of a note's hash stamps — mirrors
 * the SAME rule `blueprint observe` used when it produced the stamp: a
 * `file` anchor is stamped under its own `ref`; a `symbol` anchor is stamped
 * under its `file` field; anchors of any other kind are never stamped, so a
 * stamp whose `ref` cannot be matched back to a `file`/`symbol` anchor on the
 * note has no path to re-hash.
 */
function fileBackingStamp(note: InvestigationEntry, stampRef: string): string | undefined {
  const anchor = note.anchors.find((candidate) => candidate.ref === stampRef);
  if (anchor === undefined) {
    return undefined;
  }
  if (anchor.kind === 'file') {
    return anchor.ref;
  }
  if (anchor.kind === 'symbol') {
    return anchor.file;
  }
  return undefined;
}

/**
 * Repo-relative paths a note's anchors reference, for the `--module` filter.
 * `file`/`symbol` anchors contribute the file they point at; `module`
 * anchors contribute their own ref (a directory path); `table`/`endpoint`
 * anchors carry no path and contribute nothing.
 */
function notePaths(note: InvestigationEntry): string[] {
  const paths: string[] = [];
  for (const anchor of note.anchors) {
    if (anchor.kind === 'file') {
      paths.push(anchor.ref);
    } else if (anchor.kind === 'symbol' && anchor.file !== undefined) {
      paths.push(anchor.file);
    } else if (anchor.kind === 'module') {
      paths.push(anchor.ref);
    }
  }
  return paths;
}

/** Strip a trailing slash so `src/cli` and `src/cli/` filter identically. */
function normalizeModulePath(modulePath: string): string {
  return modulePath.replace(/\/+$/, '');
}

/**
 * Whether a note "resolves under" a module path: containment, not exact
 * match — a note anchored anywhere inside the module directory counts,
 * mirroring `fileMatchesNode`'s module-containment rule in `anchors.ts`.
 */
function noteUnderModule(note: InvestigationEntry, modulePath: string): boolean {
  const normalized = normalizeModulePath(modulePath);
  return notePaths(note).some((path) => path === normalized || path.startsWith(`${normalized}/`));
}

/** Re-hash every stamped file of one note against its current disk content. */
function evaluateNote(repoRoot: string, note: InvestigationEntry): { changedFiles: string[]; missingFiles: string[] } {
  const changedFiles: string[] = [];
  const missingFiles: string[] = [];

  for (const stamp of note.hashStamps) {
    const relPath = fileBackingStamp(note, stamp.ref);
    if (relPath === undefined) {
      // Sanctioned fail-soft: a stamp with no resolvable backing anchor
      // cannot be verified — report it conservatively as missing rather than
      // silently skipping it.
      missingFiles.push(stamp.ref);
      continue;
    }
    const result = hashRepoFile(repoRoot, relPath);
    if (result.status === 'missing' || result.status === 'escapes') {
      missingFiles.push(relPath);
      continue;
    }
    if (result.contentHash !== stamp.contentHash) {
      changedFiles.push(relPath);
    }
  }

  return { changedFiles, missingFiles };
}

/** Whether an edge's mechanism resolves under a module path (`--module`). */
function edgeUnderModule(edge: FeatureEdge, modulePath: string): boolean {
  const file = edgeViaFile(edge.via);
  if (file === null) return false;
  const normalized = normalizeModulePath(modulePath);
  return file === normalized || file.startsWith(`${normalized}/`);
}

/**
 * Re-hash every stamped feature edge and report the ones whose mechanism moved.
 *
 * Reads the feature store directly (edges live on the features, not in the
 * investigation store) but judges them with the SAME `edgeFreshness` /
 * `hashRepoFile` path everything else here uses. An UNSTAMPED edge is never
 * reported: it made no claim to begin with, and reporting it would drown the
 * ones that did in noise. Deterministic — features arrive slug-sorted from
 * `readFeatures` and the results are sorted by feature then target.
 */
export function computeStaleEdges(
  flowDir: string,
  repoRoot: string,
  modulePath?: string,
  features: readonly FeatureNode[] = readFeatures(flowDir),
): StaleEdgeResult[] {
  const out: StaleEdgeResult[] = [];
  for (const feature of features) {
    for (const edge of feature.relates) {
      if (modulePath !== undefined && !edgeUnderModule(edge, modulePath)) continue;
      const freshness = edgeFreshness(repoRoot, edge);
      if (freshness !== 'stale' && freshness !== 'missing') continue;
      out.push({
        feature: feature.id,
        slug: feature.slug,
        target: edge.target,
        via: edge.via ?? '',
        ...(edge.note !== undefined ? { note: edge.note } : {}),
        state: freshness,
      });
    }
  }
  return out.sort((a, b) => a.feature.localeCompare(b.feature) || a.target.localeCompare(b.target));
}

/** The lookup a graph builder uses to mark an edge stale as it renders it. */
export function staleEdgeKeys(results: readonly StaleEdgeResult[]): Set<string> {
  return new Set(results.map((result) => edgeKey(result.feature, result.target)));
}

/**
 * Compute the stale-check report for the active investigation notes under
 * `flowDir`, optionally scoped to notes resolving under `modulePath`.
 * Deterministic: notes come from `readInvestigations`'s fold-on-read (already
 * ts/fingerprint-sorted, supersede chains collapsed), and the stale entries
 * are additionally sorted by fingerprint so output never depends on store
 * write order. Missing/empty store yields `{ checked: 0, fresh: 0, stale: [] }`
 * — never throws.
 */
export function computeStaleCheckReport(
  flowDir: string,
  repoRoot: string,
  modulePath?: string,
): StaleCheckReport {
  const { notes } = readInvestigations(flowDir);
  const scoped = modulePath === undefined ? notes : notes.filter((note) => noteUnderModule(note, modulePath));

  const stale: StaleNoteResult[] = [];
  for (const note of scoped) {
    const { changedFiles, missingFiles } = evaluateNote(repoRoot, note);
    if (changedFiles.length > 0 || missingFiles.length > 0) {
      stale.push({
        fingerprint: investigationFingerprint(note),
        anchors: note.anchors,
        changedFiles,
        missingFiles,
        totalStamps: note.hashStamps.length,
      });
    }
  }
  stale.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));

  return {
    checked: scoped.length,
    fresh: scoped.length - stale.length,
    stale,
    staleEdges: computeStaleEdges(flowDir, repoRoot, modulePath),
  };
}
