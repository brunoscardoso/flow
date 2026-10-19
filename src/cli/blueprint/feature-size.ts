/**
 * Feature size — HOW MUCH CODE a feature's anchors actually stand on.
 *
 * `anchorCount` is how many anchor LINES someone wrote in the feature's
 * markdown: a feature anchored by one `module:app/src/renderer` line counts 1,
 * one that lists twelve single files counts 12. The board drew its Territory
 * with that as area, and the sheet said nothing true about size (#territory
 * feedback, 2026-08-28). This module answers the question the area is meant
 * to: the anchors, resolved on disk, are N files holding M lines.
 *
 * RULES
 *  - a `file:` anchor is one file; a `module:` / directory anchor is every
 *    file under it, walked recursively, with dependency and build directories
 *    skipped (`SKIP_DIRS`) so `module:app` never counts `node_modules`;
 *  - a file counts ONCE per feature however many anchors reach it — a feature
 *    that anchors both a directory and a file inside it is not bigger for it;
 *  - lines are counted for text files only; a binary (a NUL in its first
 *    kilobyte) or an oversized file is a file with zero lines, never skipped;
 *  - a locator suffix (`file:foo.ts:symbol`) is stripped before resolution,
 *    the same rule the renderer's `normalizeAnchorRef` mirrors;
 *  - an anchor that resolves to nothing contributes nothing — the feature's
 *    limitations report already names unresolved anchors, and counting a
 *    phantom would make the sheet lie in the other direction.
 *
 * Host-injected and I/O-free at the core (`measureAnchors`), like
 * `computeFeatureMap`: the same anchors against the same world always give the
 * same numbers, and a test needs no disk. `createAnchorMeasurer` memoizes per
 * anchor path so a directory shared by several features is walked once per
 * `features graph` run.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { normalizePath } from './feature-map.js';

/** What a feature stands on, resolved on disk. */
export interface FeatureSize {
  /** Distinct files its anchors resolve to. */
  files: number;
  /** Lines in those files (text files only; a binary counts as a file of 0). */
  lines: number;
}

/** One directory entry, with what the directory listing already knows about it. */
export interface SizeEntry {
  name: string;
  /** `other` for anything the listing could not settle (a symlink, a socket) —
   *  the walker then asks `classify`, one stat, only for those. */
  kind: 'file' | 'dir' | 'other';
}

/** What the walker needs to know about the world — injected for tests. */
export interface SizeHost {
  /** `file` | `dir` | null (absent). Paths are repo-relative posix. */
  classify(path: string): 'file' | 'dir' | null;
  /**
   * A directory's entries with their kinds, or `[]` when unreadable. Kinds come
   * from the listing itself (`readdir` with file types) — one call per
   * directory instead of one stat per entry, which on a slow filesystem is
   * the difference between a walk that takes a second and one that does not.
   */
  list(dir: string): SizeEntry[];
  /** File content, or null when unreadable. */
  read(path: string): string | null;
}

/**
 * Directories a walk never enters. The same list `feature-surfaces` skips when
 * mining a repo — one vocabulary for "not the project's own code".
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'graphify-out',
]);

/**
 * How many files one anchor may resolve to before the walk stops. A feature
 * anchored at the repo root is a mistake in a precious file, not a reason for
 * `features graph` to read the whole tree; the cap keeps a bad anchor's cost
 * bounded and the count it produces is still "a lot", which is the truth.
 */
export const MAX_FILES_PER_ANCHOR = 20_000;

/** Files larger than this are counted as a file with zero lines. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Where a NUL byte marks a file as binary. */
const BINARY_PROBE_CHARS = 1024;

/** A repo-relative path for an anchor, stripped of its kind and any locator. */
export function anchorTarget(anchor: string): string {
  const trimmed = anchor.trim();
  const colon = trimmed.indexOf(':');
  let ref = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  ref = ref.replace(/^[`[\s]+/, '').replace(/[`\]\s]+$/, '');
  // A locator follows the extension: `foo.ts:sym`, never `foo.ts`.
  const locator = ref.match(/^(.*\.[A-Za-z0-9]+):[^/]*$/);
  if (locator !== null) ref = locator[1];
  return normalizePath(ref);
}

/** Lines in a text file; 0 for a binary or an oversized one. */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  if (content.length > MAX_TEXT_BYTES) return 0;
  if (content.slice(0, BINARY_PROBE_CHARS).includes('\u0000')) return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lines += 1;
  }
  // A trailing newline ends the last line; it does not start another.
  if (content.charCodeAt(content.length - 1) === 10) lines -= 1;
  return lines;
}

/** Every file under one anchor path, with its line count — the unit that is memoized. */
export function filesUnderAnchor(path: string, host: SizeHost): Map<string, number> {
  const out = new Map<string, number>();
  if (path.length === 0) return out;
  const kind = host.classify(path);
  if (kind === null) return out;
  const measure = (file: string): void => {
    const content = host.read(file);
    out.set(file, content === null ? 0 : countLines(content));
  };
  if (kind === 'file') {
    measure(path);
    return out;
  }
  const stack: string[] = [path];
  while (stack.length > 0 && out.size < MAX_FILES_PER_ANCHOR) {
    const dir = stack.pop() as string;
    // Sorted so the walk — and therefore where the cap falls — is deterministic.
    const entries = [...host.list(dir)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (out.size >= MAX_FILES_PER_ANCHOR) break;
      const child = `${dir}/${entry.name}`;
      const childKind = entry.kind === 'other' ? host.classify(child) : entry.kind;
      if (childKind === 'dir') {
        if (!SKIP_DIRS.has(entry.name)) stack.push(child);
      } else if (childKind === 'file') {
        measure(child);
      }
    }
  }
  return out;
}

/**
 * The size of a set of anchors: distinct files and their lines. Pure given the
 * host; `lookup` lets a caller memoize per anchor path across features.
 */
export function measureAnchors(
  anchors: readonly string[],
  host: SizeHost,
  lookup: (path: string) => Map<string, number> = (path) => filesUnderAnchor(path, host),
): FeatureSize {
  const seen = new Map<string, number>();
  for (const anchor of anchors) {
    const path = anchorTarget(anchor);
    if (path.length === 0) continue;
    for (const [file, lines] of lookup(path)) {
      if (!seen.has(file)) seen.set(file, lines);
    }
  }
  let lines = 0;
  for (const count of seen.values()) lines += count;
  return { files: seen.size, lines };
}

/**
 * A measurer for one `features graph` run: each anchor path is walked once,
 * however many features or parts name it.
 */
export function createAnchorMeasurer(host: SizeHost): (anchors: readonly string[]) => FeatureSize {
  const memo = new Map<string, Map<string, number>>();
  const lookup = (path: string): Map<string, number> => {
    const cached = memo.get(path);
    if (cached !== undefined) return cached;
    const walked = filesUnderAnchor(path, host);
    memo.set(path, walked);
    return walked;
  };
  return (anchors) => measureAnchors(anchors, host, lookup);
}

/** The fs-backed host every real caller uses. */
export function repoSizeHost(repoRoot: string): SizeHost {
  return {
    classify(path) {
      try {
        return statSync(join(repoRoot, path)).isDirectory() ? 'dir' : 'file';
      } catch {
        return null;
      }
    },
    list(dir) {
      try {
        return readdirSync(join(repoRoot, dir), { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        }));
      } catch {
        return [];
      }
    },
    read(path) {
      try {
        return readFileSync(join(repoRoot, path), 'utf8');
      } catch {
        return null;
      }
    },
  };
}
