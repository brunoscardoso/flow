/**
 * Run-script store — the single mediated write path for compiled run
 * artifacts (allowed-pattern #14: invariants live in ONE code path, not
 * prompt convention).
 *
 * Artifacts live beside their plan: `flow/plans/<plan>.run.json`, with the
 * previous compile rotated to `<plan>.run.prev.json` before every write
 * (mirroring the blueprint store's `graph.json` → `graph.prev.json`
 * rotation). Writes are atomic (temp file + rename) under a per-plan
 * `<plan>.run.lock` file with the sibling stores' `acquireGraphLock`
 * semantics (brief retry, stale reclaim); on lock contention the write
 * throws a one-line busy notice — nothing is written — which callers
 * surface fail-soft.
 *
 * Reads are fail-soft: missing, empty, corrupt, or version-mismatched
 * artifacts return null — never throw. Recompiles use `readRunScript` to
 * recover the preserved `overrides` block from the previous artifact.
 *
 * Paths are joined, never resolved — `flow/` (and its subdirectories) may be
 * symlinks into the central vault, and the store must work through them
 * transparently. NO timestamps are written into artifacts (determinism rule:
 * same script → byte-identical file via `serializeRunScript`).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireGraphLock } from '../blueprint/store.js';
import { serializeRunScript } from './run-compiler.js';
import type { RunScript } from './types.js';

/** Plans directory (under `flowDir`) where run-script artifacts live. */
const PLANS_DIRNAME = 'plans';
/** Archive directory (under `flowDir`) run-script artifacts move to. */
const ARCHIVE_DIRNAME = 'archive';
/** Suffix of the current run-script artifact: `<plan>.run.json`. */
const RUN_SCRIPT_SUFFIX = '.run.json';
/** Suffix of the rotated previous artifact: `<plan>.run.prev.json`. */
const RUN_SCRIPT_PREV_SUFFIX = '.run.prev.json';
/** Suffix of the temp file the serialization lands in before the rename. */
const RUN_SCRIPT_TEMP_SUFFIX = '.run.json.tmp';
/** Suffix of the per-plan write lock file: `<plan>.run.lock`. */
const RUN_SCRIPT_LOCK_SUFFIX = '.run.lock';
/** The only artifact version this store reads back. */
const SUPPORTED_RUN_SCRIPT_VERSION = 1;

/**
 * One-line notice thrown when a run-script write cannot acquire the store
 * lock. Surfaced fail-soft by callers as `compile refused: run-script store
 * busy — retry`.
 */
export const RUN_SCRIPT_STORE_BUSY_NOTICE = 'run-script store busy — retry';

/** Path of a plan's current run-script artifact: `<flowDir>/plans/<plan>.run.json`. */
export function runScriptPath(flowDir: string, planName: string): string {
  return join(flowDir, PLANS_DIRNAME, `${planName}${RUN_SCRIPT_SUFFIX}`);
}

/** Path of a plan's rotated previous artifact: `<flowDir>/plans/<plan>.run.prev.json`. */
export function runScriptPrevPath(flowDir: string, planName: string): string {
  return join(flowDir, PLANS_DIRNAME, `${planName}${RUN_SCRIPT_PREV_SUFFIX}`);
}

/**
 * Move a file into place, falling back to copy + delete when the rename
 * crosses a filesystem boundary (EXDEV) — `flow/` subdirectories may be
 * individual symlinks into the central vault, so `plans/` and `archive/`
 * are not guaranteed to share a device.
 */
export function moveFileSync(fromPath: string, toPath: string): void {
  try {
    renameSync(fromPath, toPath);
  } catch {
    copyFileSync(fromPath, toPath);
    unlinkSync(fromPath);
  }
}

/**
 * Atomically write a compiled run script to `<flowDir>/plans/<plan>.run.json`
 * under the plan's write lock (temp file + rename, so readers never see a
 * partial file). An existing artifact is rotated to `<plan>.run.prev.json`
 * BEFORE the rename — mirroring the blueprint store's graph rotation — so
 * the previous compile is always preserved. Creates the plans directory if
 * missing. Throws the one-line busy notice on lock contention — nothing is
 * written; callers surface it fail-soft.
 */
export function writeRunScript(flowDir: string, planName: string, script: RunScript): void {
  const plansDir = join(flowDir, PLANS_DIRNAME);
  mkdirSync(plansDir, { recursive: true });
  const filePath = runScriptPath(flowDir, planName);
  const prevPath = runScriptPrevPath(flowDir, planName);
  const tempPath = join(plansDir, `${planName}${RUN_SCRIPT_TEMP_SUFFIX}`);
  const lockPath = join(plansDir, `${planName}${RUN_SCRIPT_LOCK_SUFFIX}`);

  if (!acquireGraphLock(lockPath)) {
    throw new Error(RUN_SCRIPT_STORE_BUSY_NOTICE);
  }
  try {
    // Full serialization lands in the temp file first; both renames below are
    // atomic on the same filesystem.
    writeFileSync(tempPath, serializeRunScript(script), 'utf-8');
    if (existsSync(filePath)) {
      renameSync(filePath, prevPath);
    }
    renameSync(tempPath, filePath);
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (reclaimed as stale) — nothing to clean up
    }
  }
}

/**
 * Read a plan's compiled run script from `<flowDir>/plans/<plan>.run.json`.
 * Fail-soft: missing, empty, corrupt, shape-invalid, or version-mismatched
 * files return null — never throws. Recompiles read this to recover the
 * preserved `overrides` block; an unreadable artifact means starting fresh,
 * never patching.
 */
export function readRunScript(flowDir: string, planName: string): RunScript | null {
  const filePath = runScriptPath(flowDir, planName);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return null;
    }
    const parsed = JSON.parse(content) as RunScript;
    if (
      parsed.version !== SUPPORTED_RUN_SCRIPT_VERSION ||
      typeof parsed.plan !== 'string' ||
      !Array.isArray(parsed.phases)
    ) {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON — treat as absent; a run script is recompiled, never patched
    return null;
  }
}

/**
 * Delete a plan's run-script artifact and its rotated previous version, if
 * present. A missing file is a silent no-op — clearing an already-clear
 * store succeeds.
 */
export function clearRunScript(flowDir: string, planName: string): void {
  for (const filePath of [runScriptPath(flowDir, planName), runScriptPrevPath(flowDir, planName)]) {
    try {
      unlinkSync(filePath);
    } catch {
      // Sanctioned fail-soft: file absent (or vanished concurrently) — nothing to clear
    }
  }
}

/**
 * Move a plan's run-script artifact (and its rotated previous version, if
 * present) into `<flowDir>/archive/`, keeping the filenames unchanged —
 * mirroring how rounds files are archived alongside their plan
 * (`flow/archive/rounds_<plan>.jsonl` precedent). Creates the archive
 * directory if missing. A missing artifact is a silent no-op.
 */
export function archiveRunScript(flowDir: string, planName: string): void {
  const sources = [
    { from: runScriptPath(flowDir, planName), name: `${planName}${RUN_SCRIPT_SUFFIX}` },
    { from: runScriptPrevPath(flowDir, planName), name: `${planName}${RUN_SCRIPT_PREV_SUFFIX}` },
  ];
  if (!sources.some((source) => existsSync(source.from))) {
    return;
  }
  const archiveDir = join(flowDir, ARCHIVE_DIRNAME);
  mkdirSync(archiveDir, { recursive: true });
  for (const source of sources) {
    if (existsSync(source.from)) {
      moveFileSync(source.from, join(archiveDir, source.name));
    }
  }
}

/**
 * Move a knowledge document — `discovery/<name>.md` or `plans/<name>.md`,
 * relative to `flowDir` — into `<flowDir>/archive/`, filename unchanged, with
 * its `.walkthrough.html` page when it has one. The one code path that
 * archives a document (allowed-pattern #14); `plan archive` and abandoned-draft
 * promotion both use it.
 *
 * Returns the archived paths (relative to `flowDir`). Refuses — moving nothing —
 * when the path is not a document of those two folders, or an archived file of
 * the same name already exists: an archive is never overwritten. A missing
 * document returns [] (already archived, or never here).
 */
export function archiveDocument(flowDir: string, relPath: string): string[] {
  const normalized = relPath.replace(/\\/g, '/');
  const match = /^(discovery|plans)\/([^/]+\.md)$/.exec(normalized);
  if (match === null || match[2].startsWith('.')) {
    throw new Error(`only a discovery or plan document can be archived, not ${relPath}`);
  }
  const fileName = match[2];
  const from = join(flowDir, match[1], fileName);
  if (!existsSync(from)) return [];
  const page = `${fileName.slice(0, -'.md'.length)}.walkthrough.html`;
  const moves = [{ from, name: fileName }];
  if (existsSync(join(flowDir, match[1], page))) moves.push({ from: join(flowDir, match[1], page), name: page });
  const archiveDir = join(flowDir, ARCHIVE_DIRNAME);
  for (const move of moves) {
    if (existsSync(join(archiveDir, move.name))) {
      throw new Error(`${ARCHIVE_DIRNAME}/${move.name} already exists, so ${match[1]}/${move.name} was not archived`);
    }
  }
  mkdirSync(archiveDir, { recursive: true });
  for (const move of moves) moveFileSync(move.from, join(archiveDir, move.name));
  return moves.map((move) => `${ARCHIVE_DIRNAME}/${move.name}`);
}
