/**
 * Feature code map — the ONE code path (allowed-pattern #14) that turns a
 * feature ref into a file graph: the union of the feature's own `anchors` and
 * every part's anchors, resolved to files, with import edges BETWEEN those
 * files and nothing else.
 *
 * This deliberately lives OUTSIDE the derived graph. `graph.json` is frozen at
 * version 1 (module-granular, no file nodes — `validate.ts` hard-errors on new
 * kinds), so the map is computed on demand from the feature store and the
 * files themselves: nothing added to derive, nothing to keep fresh (#1533).
 *
 * Edge rule, settled with the user: an edge exists only when BOTH endpoints
 * are in the feature's file set. No outside-neighbor ring. Non-code files are
 * legitimate nodes with no scan and no edges. `module:<dir>` anchors render as
 * a single folder node rather than exploding into the directory's files — the
 * bounded choice that keeps map-open time proportional to the feature.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { FeatureNode } from './feature-store.js';
import { parseParts, splitParts, type FeaturePart } from './feature-store.js';

/** One node of the map. `part` is the FIRST claimant (FR5); others badge. */
export interface FeatureMapFile {
  /** Repo-relative posix path. */
  path: string;
  /** Name of the part whose anchor claimed it first; null when the feature's own anchors did. */
  part: string | null;
  /** `folder` for `module:<dir>` / directory anchors — rendered as one node, never expanded. */
  kind: 'file' | 'folder';
  /** Other parts that also anchor this path (dedup'd, claim order). */
  badges: string[];
}

export interface FeatureMapEdge {
  from: string;
  to: string;
}

export interface FeatureMapUnresolved {
  anchor: string;
  reason: string;
}

/** The JSON contract `blueprint feature-map --json` prints, verbatim. */
export interface FeatureMap {
  feature: string;
  files: FeatureMapFile[];
  edges: FeatureMapEdge[];
  unresolved: FeatureMapUnresolved[];
}

/** What the resolver needs to know about the world — injected for tests. */
export interface FeatureMapHost {
  /** `file` | `dir` | null (absent). Paths are repo-relative posix. */
  classify(path: string): 'file' | 'dir' | null;
  /** File content, or null when unreadable. Only ever called on code files. */
  read(path: string): string | null;
}

/** Extensions the import scanner reads and the resolver tries, in order. */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

const CODE_FILE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Import-statement forms the scanner recognises. Placeholder-free on purpose:
 * a heuristic extractor must never match its own documentation
 * (forbidden-pattern #9), so the examples here stay prose.
 */
const IMPORT_RES = [
  // static import ... from / export ... from
  /\b(?:import|export)\s+[^'"()]*?\bfrom\s+['"]([^'"]+)['"]/g,
  // side-effect import
  /\bimport\s+['"]([^'"]+)['"]/g,
  // dynamic import
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // commonjs require
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Strip a `file:`/`module:` prefix; bare part anchors pass through unchanged. */
function anchorPath(anchor: string): string {
  const trimmed = anchor.trim();
  const colon = trimmed.indexOf(':');
  const ref = colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  return normalizePath(ref);
}

/** Posix-normalize a repo-relative path: no `./`, no trailing `/`, `..` folded. */
export function normalizePath(raw: string): string {
  const segments: string[] = [];
  for (const segment of raw.replace(/\\/g, '/').split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** The claim sequence: the feature's own anchors first, then parts in order. */
function claimants(
  feature: FeatureNode,
  parts: readonly FeaturePart[],
): Array<{ part: string | null; anchors: readonly string[] }> {
  return [
    { part: null, anchors: feature.anchors },
    ...parts.map((part) => ({ part: part.name, anchors: part.anchors })),
  ];
}

/**
 * Resolve one relative import specifier against the feature's file set.
 * Extension and `/index` fallback mirror the TS/Node resolution the repo
 * itself uses; bare (package) specifiers are out of scope by design.
 */
function resolveSpecifier(fromFile: string, spec: string, fileSet: ReadonlySet<string>): string | null {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const base = normalizePath(dir.length > 0 ? `${dir}/${spec}` : spec);
  if (base.length === 0) return null;
  const candidates: string[] = [base];
  // `./store.js` in an ESM-authored TS repo compiles from `store.ts` — try the
  // sibling extensions of the written one before giving up.
  const written = base.match(CODE_FILE_RE)?.[0];
  const stem = written !== undefined ? base.slice(0, -written.length) : base;
  for (const ext of CODE_EXTENSIONS) candidates.push(`${stem}${ext}`);
  for (const ext of CODE_EXTENSIONS) candidates.push(`${stem}/index${ext}`);
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

/** Every relative specifier in one file's source, in appearance order. */
export function scanImports(source: string): string[] {
  const specs: string[] = [];
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    for (let match = re.exec(source); match !== null; match = re.exec(source)) {
      specs.push(match[1]);
    }
  }
  return specs;
}

/**
 * The whole computation, host-injected and deterministic: the same feature and
 * the same files always print the same bytes (files sorted by path, edges by
 * from/to, unresolved by anchor).
 */
export function computeFeatureMap(
  feature: FeatureNode,
  parts: readonly FeaturePart[],
  host: FeatureMapHost,
): FeatureMap {
  const byPath = new Map<string, FeatureMapFile>();
  const unresolved: FeatureMapUnresolved[] = [];

  for (const claim of claimants(feature, parts)) {
    for (const anchor of claim.anchors) {
      const path = anchorPath(anchor);
      if (path.length === 0) {
        unresolved.push({ anchor, reason: 'empty anchor' });
        continue;
      }
      const existing = byPath.get(path);
      if (existing !== undefined) {
        // FR5 — first claimant owns the node; later parts badge it.
        if (claim.part !== null && claim.part !== existing.part && !existing.badges.includes(claim.part)) {
          existing.badges.push(claim.part);
        }
        continue;
      }
      const kind = host.classify(path);
      if (kind === null) {
        unresolved.push({ anchor, reason: 'no such file or directory' });
        continue;
      }
      byPath.set(path, { path, part: claim.part, kind: kind === 'dir' ? 'folder' : 'file', badges: [] });
    }
  }

  const fileSet = new Set(
    [...byPath.values()].filter((node) => node.kind === 'file').map((node) => node.path),
  );
  const edgeKeys = new Set<string>();
  const edges: FeatureMapEdge[] = [];
  for (const path of fileSet) {
    if (!CODE_FILE_RE.test(path)) continue; // non-code files: nodes, never edges
    const source = host.read(path);
    if (source === null) continue;
    for (const spec of scanImports(source)) {
      const target = resolveSpecifier(path, spec, fileSet);
      if (target === null || target === path) continue;
      const key = `${path} ${target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from: path, to: target });
    }
  }

  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  unresolved.sort((a, b) => a.anchor.localeCompare(b.anchor));
  return { feature: feature.slug, files, edges, unresolved };
}

/** The fs-backed host every real caller uses. */
export function repoHost(repoRoot: string): FeatureMapHost {
  return {
    classify(path) {
      const full = join(repoRoot, path);
      if (!existsSync(full)) return null;
      try {
        return statSync(full).isDirectory() ? 'dir' : 'file';
      } catch {
        return null;
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

/** Convenience: feature body → parts → map, against the real repo. */
export function deriveFeatureMap(repoRoot: string, feature: FeatureNode): FeatureMap {
  const parts = parseParts(splitParts(feature.body).parts);
  return computeFeatureMap(feature, parts, repoHost(repoRoot));
}
