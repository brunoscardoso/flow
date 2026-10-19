/**
 * One project's feature graph, READ — the I/O half of `features graph`.
 *
 * `buildFeatureGraph` is pure; this is the one place that gathers what it is
 * handed (the store, its parts, module learning, valid views, stale edges, the
 * size measurer). It was inline in `runFeaturesGraph`; the Workspace map
 * (`blueprint workspace graph`) needs the SAME answer for every project of a
 * Workspace, so it moved here rather than being re-assembled a second way —
 * two assemblies of one graph are how two boards come to disagree about a
 * feature's understanding (allowed-pattern #14).
 *
 * `repoRoot` is the project's CHECKOUT, or null when this machine has none. A
 * project with no checkout is still readable — its features live in the
 * Workspace's knowledge folder — but nothing about its code can be measured or
 * checked: no sizes, no stale-edge verdicts, no excerpt checks. Those are left
 * ABSENT, never guessed (an absent size is "not measured", which the board
 * already reads correctly). The same goes for WHERE a feature lives (its
 * folder rows, `feature-folders.ts`) and for checking a pinned `home:`.
 *
 * FOLDER ROWS trace imports through the story's cached import index — the
 * same cache file the story verb reads (`storylineCacheDir`), so a graph read
 * after a story read pays only the cache's stat check. The trace is TS/JS
 * only: another language's import edges need its tree-sitter grammar loaded,
 * an asynchronous start this synchronous read does not pay on every board
 * refresh. Those languages still get their anchored and name-matched files.
 *
 * NEVER BLOCKED BY A COLD INDEX. The graph reads the index with a read budget
 * (`GRAPH_IMPORT_READ_BUDGET`): building it from nothing opens every TS/JS file
 * of the project, and on a fresh checkout each first open is slow — measured on
 * a scratch clone of a 5,100-file repo, `features graph` took 18.8 s wall for
 * 1.3 s of CPU, 19.6 s of it in the index's serial reads, against the app's
 * 30 s timeout. With more files to open than the budget allows, the read
 * answers with anchored + name-matched rows marked `partial` (no import trace)
 * and says so (`importIndex: 'partial'`), and the caller starts the background
 * build (`blueprint index warm`) so the next read is complete. Measured on
 * that clone (fresh `git clone` each run, 2026-10-09): before 16.4–18.8 s;
 * after, cold 3.3–3.9 s (partial, with `readProjectFeatureGraphPrefetched`)
 * and warm 0.96 s (was 1.01 s), the warm answer byte-identical to before.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isSourceFile } from './extractors/scan.js';
import { createFolderRowsBuilder, pinnedHomeExists, type FolderImportIndex } from './feature-folders.js';
import { buildFeatureGraph, readModuleLearning, type FeatureGraph, type FolderRowsFor } from './feature-graph.js';
import { computeFeatureLimitations, type FeatureLimitations } from './feature-limitations.js';
import { createAnchorMeasurer, repoSizeHost, type SizeHost } from './feature-size.js';
import { featureHome, readFeaturesWithExclusions, readParts, type FeatureNode, type FeaturePart } from './feature-store.js';
import { readProjectImportIndex, storylineCacheDir, type ImportIndexReadOptions } from './storyline-imports.js';
import { StorylineReaders } from './storyline-reader.js';
import { computeStaleEdges, staleEdgeKeys } from './stale-check.js';
import { BLUEPRINT_DIRNAME } from './store.js';

/**
 * Read every feature's parts, fail-soft PER FEATURE.
 *
 * `buildFeatureGraph` and `buildFeatureIndexMarkdown` are both I/O-free, so
 * both need this read done for them; sharing it keeps the two surfaces from
 * disagreeing about which features have parts (and keeps the rule stated once:
 * an unreadable `## Parts` costs that feature its parts, never the caller its
 * features).
 */
export function readPartsBySlug(flowDir: string, features: readonly FeatureNode[]): Map<string, FeaturePart[]> {
  const partsBySlug = new Map<string, FeaturePart[]>();
  for (const feature of features) {
    try {
      const parts = readParts(flowDir, feature.slug);
      if (parts.length > 0) partsBySlug.set(feature.slug, parts);
    } catch {
      continue;
    }
  }
  return partsBySlug;
}

/**
 * The most TS/JS files a graph read opens to bring the import index up to
 * date. An edit or two re-reads inline as before; a cold cache or a branch
 * switch (hundreds of files) answers partial instead and leaves the build to
 * the background.
 */
export const GRAPH_IMPORT_READ_BUDGET = 64;

/**
 * The project's import index as the folder rows read it: every file a story
 * can be read from, and TS/JS import edges only (see the module note). Null
 * when it cannot be read — the rows then come from anchors alone. With a
 * `readBudget` it never blocks on a cold index: `complete: false` then.
 */
export function readFolderImportIndex(repoRoot: string, options: ImportIndexReadOptions = {}): FolderImportIndex | null {
  try {
    const index = readProjectImportIndex(repoRoot, new StorylineReaders(), storylineCacheDir(repoRoot), options);
    return {
      sourceFiles: index.sourceFiles,
      importersOf: (target) => (isSourceFile(target) ? index.importersOf(target) : []),
      complete: index.complete,
    };
  } catch {
    return null;
  }
}

/**
 * ONE folder-rows builder for this read: the shared set is counted over the
 * store's core features once, and every node — feature or part — reads its
 * rows from it.
 */
function folderRowsFor(host: SizeHost, imports: FolderImportIndex | null, features: readonly FeatureNode[]): FolderRowsFor {
  const builder = createFolderRowsBuilder(host, {
    coreFeatures: features
      .filter((feature) => feature.kind === 'core')
      .map((feature) => ({ id: feature.id, slug: feature.slug, anchors: feature.anchors, home: featureHome(feature) })),
    imports,
  });
  return (input) => builder.rowsFor(input);
}

/**
 * The state of the import index behind this read's folder rows: `complete`,
 * `partial` (not built yet — rows carry `partial: true`; the caller should
 * start `blueprint index warm`), or `none` (no checkout, or unreadable).
 */
export type ImportIndexState = 'complete' | 'partial' | 'none';

/** Everything one read of a project's store yields. */
export interface ProjectFeatureRead {
  graph: FeatureGraph;
  limitations: FeatureLimitations;
  /** The store as read — the same list the graph was built from. */
  features: FeatureNode[];
  partsBySlug: Map<string, FeaturePart[]>;
  /** Whether the folder rows had the whole import index (see `ImportIndexState`). */
  importIndex: ImportIndexState;
}

/**
 * Read one project's feature graph exactly as `features graph --json` builds
 * it. `flowDir` is the project's knowledge folder (`<repo>/flow`, or the
 * Workspace's `projects/<p>/` for a project with no checkout here).
 */
export interface ProjectFeatureReadOptions {
  /** The graph's import read budget (`GRAPH_IMPORT_READ_BUDGET` by default). */
  importReadBudget?: number;
  /** The import index, already read for this checkout (`readProjectFeatureGraphPrefetched`). */
  imports?: FolderImportIndex | null;
  /** The view of the checkout to measure through — `repoSizeHost` by default. */
  host?: SizeHost;
}

export function readProjectFeatureGraph(
  flowDir: string,
  repoRoot: string | null,
  options: ProjectFeatureReadOptions = {},
): ProjectFeatureRead {
  const structureDir = join(flowDir, BLUEPRINT_DIRNAME);
  // ONE READ answers both "what are the features" and "what in this directory
  // is not one" — see `readFeaturesWithExclusions`.
  const { features, excluded } = readFeaturesWithExclusions(flowDir);
  // One view of the checkout for the whole read — sizes, folder rows and the
  // pinned-home check all ask it.
  const host = repoRoot === null ? null : (options.host ?? repoSizeHost(repoRoot));
  // COMPUTED FIRST, because the graph depends on it: `understandingOf` counts a
  // VALID curated view as the feature's own understanding, and the only place
  // validity is judged is the inspection this performs.
  const limitations = computeFeatureLimitations(features, flowDir, {
    ...(repoRoot === null ? {} : { repoRoot }),
    excluded,
    ...(host === null ? {} : { homeExists: (home: string) => pinnedHomeExists(host, home) }),
  });
  const partsBySlug = readPartsBySlug(flowDir, features);
  const imports =
    host === null || repoRoot === null
      ? null
      : options.imports !== undefined
        ? options.imports
        : readFolderImportIndex(repoRoot, { readBudget: options.importReadBudget ?? GRAPH_IMPORT_READ_BUDGET });
  const graph = buildFeatureGraph(
    features,
    readModuleLearning(structureDir),
    new Set(),
    new Set(limitations.views.validSlugs),
    partsBySlug,
    // ONE AUTHORITY ON STALENESS — and it needs the code. With no checkout
    // there is nothing to re-hash, so no edge is marked (absent = unchecked).
    repoRoot === null ? new Set() : staleEdgeKeys(computeStaleEdges(flowDir, repoRoot, undefined, features)),
    // HOW MUCH CODE EACH NODE STANDS ON — the board's area. Unmeasurable
    // without a checkout; the caller may lay a last-known size over it.
    host === null ? undefined : createAnchorMeasurer(host),
    // WHERE EACH NODE LIVES — derived on every read, never stored; nothing to
    // read without a checkout, so absent then (FR-12).
    host === null || repoRoot === null ? undefined : folderRowsFor(host, imports, features),
  );
  const importIndex: ImportIndexState = imports === null ? 'none' : imports.complete === false ? 'partial' : 'complete';
  return { graph, limitations, features, partsBySlug, importIndex };
}

/** Reads in flight while a cold read prefetches the files it will measure. */
export const GRAPH_PREFETCH_CONCURRENCY = 32;

/**
 * `readProjectFeatureGraph`, with the files it measures read CONCURRENTLY first
 * when the checkout is cold.
 *
 * Sizes and folder rows read every anchored and name-matched file for its line
 * count — ~3,900 files on the measured repo, one blocking `readFileSync` after
 * another. On a fresh checkout each first open is slow, so even with the import
 * index left partial a read took 8–15 s wall for under 1 s of CPU. WHICH files
 * are read never depends on what they hold (anchors, directory listings and
 * names decide it), so a first pass through a recording host lists them, they
 * are read concurrently (`GRAPH_PREFETCH_CONCURRENCY`), and the real pass reads
 * from memory. Only when the import index is not complete — the sign of a cold
 * or changed checkout; a warm read takes the one-pass path unchanged.
 */
export async function readProjectFeatureGraphPrefetched(
  flowDir: string,
  repoRoot: string | null,
  options: Pick<ProjectFeatureReadOptions, 'importReadBudget'> & { concurrency?: number } = {},
): Promise<ProjectFeatureRead> {
  if (repoRoot === null) return readProjectFeatureGraph(flowDir, null, options);
  const imports = readFolderImportIndex(repoRoot, { readBudget: options.importReadBudget ?? GRAPH_IMPORT_READ_BUDGET });
  const base = repoSizeHost(repoRoot);
  if (imports === null || imports.complete !== false) return readProjectFeatureGraph(flowDir, repoRoot, { imports, host: base });
  const wanted = new Set<string>();
  readProjectFeatureGraph(flowDir, repoRoot, {
    imports,
    host: {
      classify: (path) => base.classify(path),
      list: (dir) => base.list(dir),
      read: (path) => {
        wanted.add(path);
        return '';
      },
    },
  });
  const contents = await readFilesConcurrently(repoRoot, [...wanted], options.concurrency ?? GRAPH_PREFETCH_CONCURRENCY);
  return readProjectFeatureGraph(flowDir, repoRoot, {
    imports,
    host: {
      classify: (path) => base.classify(path),
      list: (dir) => base.list(dir),
      read: (path) => (contents.has(path) ? (contents.get(path) ?? null) : base.read(path)),
    },
  });
}

async function readFilesConcurrently(
  repoRoot: string,
  paths: readonly string[],
  concurrency: number,
): Promise<Map<string, string | null>> {
  const contents = new Map<string, string | null>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next];
      next += 1;
      try {
        contents.set(path, await readFile(join(repoRoot, path), 'utf8'));
      } catch {
        // Unreadable — the same null the sync host answers.
        contents.set(path, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), paths.length) }, worker));
  return contents;
}
