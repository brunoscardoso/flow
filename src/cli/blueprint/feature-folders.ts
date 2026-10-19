/**
 * Feature folders — WHERE a feature lives, in the file explorer's own words
 * (plan `feature-home-folders` phase 1, discovery FR-1/2/3/10/11, NFR-2..4).
 *
 * A feature's anchors stop at its route folders, so the files that make it up
 * are worked out wider than its size is (FR-9: sizes still come from anchors,
 * `feature-size.ts`). Three sources, one set per node:
 *
 *   1. ANCHORED files — every anchor resolved on disk exactly as the size
 *      measurer resolves it (`anchorTarget` + `filesUnderAnchor`);
 *   2. NAME-MATCHED files — any project source file with a path SEGMENT whose
 *      words contain the slug's words (kebab, camel, snake and compact forms;
 *      the last word singular or plural). A stem shorter than
 *      `MIN_NAME_STEM_LENGTH` characters never name-matches, so `apps` claims
 *      `apps/` but its singular `app` claims nothing;
 *   3. the IMPORT TRACE — the forward import closure of the anchored files,
 *      read from the story's import index (`storyline-imports.ts`, every
 *      language with a reader), at most `DEFAULT_IMPORT_DEPTH` hops, never
 *      entering or walking through a shared file.
 *
 * Tests, mocks, fixtures, generated and declaration files are left out (the
 * story's own test rule, `isStoryTestFile`, plus the rules below), and only
 * code files count — a README or an image under an anchored folder is not
 * where the feature's code lives.
 *
 * SHARED CODE IS NOBODY'S HOME (FR-2). Marked once per builder, in this order:
 *   a. every core feature's anchored + name-matched set is computed;
 *   b. a file in ≥ `SHARED_FEATURE_THRESHOLD` of those sets is shared;
 *   c. every core feature's import trace advances ONE HOP AT A TIME, all in
 *      lockstep, never entering a shared file;
 *   d. after each hop, a file now in ≥ threshold features' sets (a client
 *      every feature calls) is shared before anyone walks on from it — so
 *      nothing is reached THROUGH a hub;
 *   e. after the last hop, one more count over the traced sets: a file that
 *      features reached at DIFFERENT hops can still add up to the threshold
 *      (whatever was walked through it at that point stays — the cost of one
 *      pass instead of a fixpoint, and it only ever errs toward a few extra
 *      files in a set, never toward a hub's being somebody's home).
 * Shared files are then dropped from every set, a part's included. A part is
 * never counted toward sharing: its files are its owner's too, and a feature
 * with three parts must not make its own folder "shared".
 *
 * ROWS (FR-3). A file's starting folder is the layer folder's child — the
 * layer folder is the first segment under a source root — so
 * `src/components/automations/Builder/x.tsx` starts at
 * `src/components/automations`, and a file directly in a layer folder
 * (`src/commands/createAutomation.ts`) at `src/commands`. From there a row goes
 * one level deeper while a single subfolder holds ≥ `DESCEND_SHARE` of its
 * lines; what the deeper folder leaves behind stays a row of its own at the
 * shallower path, so every line is counted exactly once. Rows rank by lines
 * (ties by path), the top `MAX_ROWS` are kept. `share` is a FRACTION 0..1 of
 * the node's lines, rounded to three decimals (by files when every file has 0
 * lines). `spread` is a top computed share below `SPREAD_BELOW`.
 *
 * A PINNED home (FR-10) that exists as a folder becomes the first row with its
 * real lines and share — 0 included — and `pinned: true`; the rest are still
 * computed. One that does not exist is ignored and reported (`pinMissing`) so
 * the limitations disclosure can say so (NFR-4). No files at all → null: no
 * rows rather than a guessed folder.
 *
 * Pure given the host and the import index — tests use in-memory worlds — and
 * memoized per builder, one builder per `features graph` run (NFR-2).
 */

import { isCodeFile } from './extractors/scan.js';
import { normalizePath } from './feature-map.js';
import { anchorTarget, countLines, filesUnderAnchor, SKIP_DIRS, type SizeHost } from './feature-size.js';
import { isStoryTestFile } from './storyline-reader.js';
import { storylineTableFor } from './storyline-languages.js';

// ── Tunables ─────────────────────────────────────────────

/** A slug stem shorter than this never name-matches (`app`, `ui`, `api`). */
export const MIN_NAME_STEM_LENGTH = 4;

/** How many import hops the trace follows from an anchored file. */
export const DEFAULT_IMPORT_DEPTH = 3;

/** A file in this many core features' sets is shared — nobody's home. */
export const SHARED_FEATURE_THRESHOLD = 3;

/** A subfolder holding at least this share of its folder's lines is shown instead. */
export const DESCEND_SHARE = 0.8;

/** A top folder below this share means the feature is spread. */
export const SPREAD_BELOW = 0.4;

/** Rows kept per node, a pinned home included. */
export const MAX_ROWS = 4;

/** Source roots looked for when the caller names none (`discoverSpineRoots`' conventional set). */
const CONVENTIONAL_SOURCE_ROOTS = ['src', 'app/src', 'lib', 'packages/*/src', 'apps/*/src'];

/** The path of the repository root as a row (a file sitting at the top level). */
export const REPO_ROOT_FOLDER = '.';

const SHARE_DECIMALS = 1000;

// ── Types ────────────────────────────────────────────────

/** One explorer row: a folder, how much of the node lives there. */
export interface FolderRow {
  /** Repo-relative folder path (`.` for the repository root). */
  path: string;
  /** The node's lines in this folder's own row (deeper rows not included). */
  lines: number;
  /** The node's files counted in this row. */
  files: number;
  /** Fraction 0..1 of the node's lines, three decimals. */
  share: number;
  /** Present and true only on a person-pinned home. */
  pinned?: true;
}

/** Where one feature or part lives. */
export interface FeatureFolders {
  /** Up to `MAX_ROWS`; a pinned home first. */
  rows: FolderRow[];
  /** How many folders the node's files fall in (computed rows, before the cap). */
  folderCount: number;
  /** No computed folder holds `SPREAD_BELOW` of the node. */
  spread: boolean;
  /** A person-pinned home was given and exists — it is `rows[0]`. */
  pinned: boolean;
  /** The pinned home that was given but is not a folder of the project, else null. */
  pinMissing: string | null;
  /** The node's file set, after exclusions and shared code left out. */
  files: number;
  lines: number;
  /**
   * Present and true when the import trace was left out because the project's
   * import index was not built yet (a cold cache, read without blocking): the
   * rows hold the anchored and name-matched files only, and the next read —
   * once the background build has written the index — is complete.
   */
  partial?: true;
}

/**
 * What the builder needs of the story's import index — `ProjectImportIndex`
 * satisfies it as is.
 */
export interface FolderImportIndex {
  /** Every project file a story can be read from — the name-matching universe. */
  readonly sourceFiles: readonly string[];
  /** Files of the same language whose imports resolve to `target`. */
  importersOf(target: string): string[];
  /** False when the import edges are missing (a cold index): no trace, rows marked `partial`. Default true. */
  readonly complete?: boolean;
}

/** One node to compute rows for. */
export interface FolderNodeInput {
  slug: string;
  anchors: readonly string[];
  /** A person-owned `home:` folder, when the note has one. */
  home?: string | null;
}

/** One core feature, as the shared marking sees it. */
export interface FolderFeatureInput extends FolderNodeInput {
  id: string;
}

export interface FolderRowsOptions {
  /** Every core feature of the graph — the population sharing is counted over. */
  coreFeatures: readonly FolderFeatureInput[];
  /** The story's import index; null → no name matching and no import trace. */
  imports: FolderImportIndex | null;
  /** The project's source roots (`discoverSpineRoots`); derived from the file list when omitted. */
  sourceRoots?: readonly string[];
  /** Import hops from an anchored file. */
  importDepth?: number;
  /** Core features a file must be in to be shared. */
  sharedThreshold?: number;
}

export interface FolderRowsBuilder {
  /** A node's rows (memoized per slug + anchors), or null when no files were found. */
  rowsFor(input: FolderNodeInput): FeatureFolders | null;
  /** The shared files of this run, sorted (computed on first ask). */
  sharedFiles(): readonly string[];
  /** The node's file set before rows are grouped (for probes and tests). */
  filesFor(input: FolderNodeInput): ReadonlyMap<string, number>;
}

// ── Exclusions ───────────────────────────────────────────

/** Mocks, fixtures, generated and declaration files — on top of the story's test rule. */
const NOT_PRODUCT_DIR = /(?:^|\/)(?:__mocks__|__fixtures__|__generated__|mocks|generated|fixtures)\//;
const NOT_PRODUCT_FILE = /(?:\.d\.[cm]?ts|\.(?:mock|mocks|fixture|generated|gen)\.[^/.]+|_pb2(?:_grpc)?\.pyi?)$/;

/**
 * Whether a file counts toward where a feature lives: a code file the project
 * owns, not a test, mock, fixture, generated or declaration file, and not under
 * a dependency or build folder.
 */
export function isFolderRowFile(path: string): boolean {
  if (path.length === 0) return false;
  if (!isCodeFile(path) && storylineTableFor(path) === null) return false;
  if (isStoryTestFile(path)) return false;
  if (NOT_PRODUCT_DIR.test(path) || NOT_PRODUCT_FILE.test(path)) return false;
  for (const segment of path.split('/').slice(0, -1)) if (SKIP_DIRS.has(segment)) return false;
  return true;
}

// ── Name matching ────────────────────────────────────────

/** A name's lowercase words: kebab, snake, dots, camel and acronym boundaries. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function singularOf(word: string): string | null {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ss')) return null;
  if (word.endsWith('s') && word.length > 1) return word.slice(0, -1);
  return null;
}

function pluralOf(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(?:s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/** The word sequences a slug is recognised by — singular and plural, short stems dropped. */
export function slugStems(slug: string): string[][] {
  const words = nameWords(slug);
  if (words.length === 0) return [];
  const head = words.slice(0, -1);
  const last = words[words.length - 1];
  // A plural slug adds its singular; a singular one its plural — never `appses`.
  const singular = singularOf(last);
  const forms = new Set<string>([last, singular ?? pluralOf(last)]);
  const stems: string[][] = [];
  for (const form of forms) {
    const stem = [...head, form];
    if (stem.join('').length >= MIN_NAME_STEM_LENGTH) stems.push(stem);
  }
  return stems;
}

function containsRun(words: readonly string[], stem: readonly string[]): boolean {
  for (let start = 0; start + stem.length <= words.length; start += 1) {
    let all = true;
    for (let i = 0; i < stem.length; i += 1) {
      if (words[start + i] !== stem[i]) {
        all = false;
        break;
      }
    }
    if (all) return true;
  }
  return false;
}

/**
 * Whether a path carries the slug's name: some segment (a folder, or the file
 * without its extension) holds the stem's words in a row — or, for a
 * multi-word stem, one word spelling it compactly (`planlibrary`).
 */
export function pathMatchesSlug(path: string, stems: readonly (readonly string[])[]): boolean {
  if (stems.length === 0) return false;
  return segmentsMatchStems(pathSegmentWords(path), stems);
}

/** Each path segment's words (the file's without its extension) — what name matching compares. */
export function pathSegmentWords(path: string): string[][] {
  const segments = path.split('/');
  const last = segments.length - 1;
  segments[last] = segments[last].replace(/\.[^.]+$/, '');
  return segments.map(nameWords);
}

/** `pathMatchesSlug` over segment words already split — a builder splits each file once. */
function segmentsMatchStems(segments: readonly (readonly string[])[], stems: readonly (readonly string[])[]): boolean {
  for (const words of segments) {
    for (const stem of stems) {
      if (containsRun(words, stem)) return true;
      if (stem.length > 1 && words.includes(stem.join(''))) return true;
    }
  }
  return false;
}

// ── Folders ──────────────────────────────────────────────

/** The source roots in a file list, by the conventional patterns; outermost kept. */
export function conventionalSourceRoots(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
  }
  const found: string[] = [];
  for (const pattern of CONVENTIONAL_SOURCE_ROOTS) {
    const parts = pattern.split('/');
    for (const dir of dirs) {
      const segments = dir.split('/');
      if (segments.length !== parts.length) continue;
      if (parts.every((part, i) => part === '*' || part === segments[i])) found.push(dir);
    }
  }
  const unique = [...new Set(found)].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const roots: string[] = [];
  for (const candidate of unique) {
    if (!roots.some((root) => candidate.startsWith(`${root}/`))) roots.push(candidate);
  }
  return roots;
}

/** The folder a file's row starts at: the layer folder's child, or the layer folder for its own files. */
export function startingFolderOf(file: string, sourceRoots: readonly string[]): string {
  let root = '';
  for (const candidate of sourceRoots) {
    if (file.startsWith(`${candidate}/`) && candidate.length > root.length) root = candidate;
  }
  const rest = root.length === 0 ? file : file.slice(root.length + 1);
  const dirs = rest.split('/').slice(0, -1);
  const kept = dirs.slice(0, 2);
  const parts = root.length === 0 ? kept : [root, ...kept];
  return parts.length === 0 ? REPO_ROOT_FOLDER : parts.join('/');
}

function isUnder(file: string, folder: string): boolean {
  return folder === REPO_ROOT_FOLDER || file.startsWith(`${folder}/`);
}

function sumLines(files: ReadonlyMap<string, number>): number {
  let lines = 0;
  for (const count of files.values()) lines += count;
  return lines;
}

/** Split one starting folder's files into rows by the descend rule. */
function descend(folder: string, files: Map<string, number>, out: Map<string, Map<string, number>>): void {
  let current = folder;
  let remaining = files;
  for (;;) {
    const total = sumLines(remaining);
    const byChild = new Map<string, Map<string, number>>();
    for (const [file, lines] of remaining) {
      const rest = current === REPO_ROOT_FOLDER ? file : file.slice(current.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const child = current === REPO_ROOT_FOLDER ? rest.slice(0, slash) : `${current}/${rest.slice(0, slash)}`;
      const bucket = byChild.get(child) ?? new Map<string, number>();
      bucket.set(file, lines);
      byChild.set(child, bucket);
    }
    let deeper: [string, Map<string, number>] | null = null;
    for (const entry of byChild) {
      // By lines; by files when nothing here has a line to weigh.
      const weight = total > 0 ? sumLines(entry[1]) / total : entry[1].size / remaining.size;
      if (weight >= DESCEND_SHARE) deeper = entry;
    }
    if (deeper === null) break;
    const [child, kept] = deeper;
    const left = new Map([...remaining].filter(([file]) => !kept.has(file)));
    if (left.size > 0) out.set(current, left);
    current = child;
    remaining = kept;
  }
  out.set(current, remaining);
}

function roundShare(value: number): number {
  return Math.round(value * SHARE_DECIMALS) / SHARE_DECIMALS;
}

/** A pinned home's normalized path, or null when it cannot name a folder inside the project. */
function homePathOf(home: string): string | null {
  const raw = home.trim().replace(/\\/g, '/');
  if (raw.length === 0 || raw.startsWith('/') || raw.split('/').includes('..')) return null;
  const path = normalizePath(raw);
  return path.length === 0 ? null : path;
}

/** Whether a pinned home names an existing folder of the project. */
export function pinnedHomeExists(host: SizeHost, home: string): boolean {
  const path = homePathOf(home);
  return path !== null && host.classify(path) === 'dir';
}

/**
 * Rows for one node's file set (file → lines). Pure; exported for tests and
 * for any caller that already has a file set.
 */
export function folderRowsOf(
  files: ReadonlyMap<string, number>,
  sourceRoots: readonly string[],
  pin: { home: string | null | undefined; exists: (path: string) => boolean } = { home: null, exists: () => false },
): FeatureFolders | null {
  if (files.size === 0) return null;
  const starts = new Map<string, Map<string, number>>();
  for (const [file, lines] of files) {
    const start = startingFolderOf(file, sourceRoots);
    const bucket = starts.get(start) ?? new Map<string, number>();
    bucket.set(file, lines);
    starts.set(start, bucket);
  }
  const grouped = new Map<string, Map<string, number>>();
  for (const [start, bucket] of [...starts].sort(([a], [b]) => a.localeCompare(b))) descend(start, bucket, grouped);

  const totalLines = sumLines(files);
  const shareOf = (bucket: ReadonlyMap<string, number>): number =>
    roundShare(totalLines > 0 ? sumLines(bucket) / totalLines : bucket.size / files.size);
  const computed: FolderRow[] = [...grouped]
    .map(([path, bucket]) => ({ path, lines: sumLines(bucket), files: bucket.size, share: shareOf(bucket) }))
    .sort((a, b) => b.lines - a.lines || b.files - a.files || a.path.localeCompare(b.path));

  const spread = (computed[0]?.share ?? 0) < SPREAD_BELOW;
  let pinMissing: string | null = null;
  let pinnedRow: FolderRow | null = null;
  const home = pin.home ?? null;
  if (home !== null && home.trim().length > 0) {
    const path = homePathOf(home);
    if (path !== null && pin.exists(path)) {
      const under = new Map([...files].filter(([file]) => isUnder(file, path)));
      pinnedRow = { path, lines: sumLines(under), files: under.size, share: shareOf(under), pinned: true };
    } else {
      pinMissing = home.trim();
    }
  }
  const rows =
    pinnedRow === null
      ? computed.slice(0, MAX_ROWS)
      : [pinnedRow, ...computed.filter((row) => row.path !== pinnedRow?.path).slice(0, MAX_ROWS - 1)];
  return {
    rows,
    folderCount: computed.length,
    spread,
    pinned: pinnedRow !== null,
    pinMissing,
    files: files.size,
    lines: totalLines,
  };
}

// ── The builder ──────────────────────────────────────────

/**
 * One builder per `features graph` run: anchor walks, line counts, forward
 * imports and the shared set are computed once and reused for every feature
 * and part.
 */
export function createFolderRowsBuilder(host: SizeHost, options: FolderRowsOptions): FolderRowsBuilder {
  const imports = options.imports;
  const depth = options.importDepth ?? DEFAULT_IMPORT_DEPTH;
  const threshold = options.sharedThreshold ?? SHARED_FEATURE_THRESHOLD;
  const universe = (imports?.sourceFiles ?? []).filter(isFolderRowFile);
  const partial = imports !== null && imports.complete === false;
  const sourceRoots = options.sourceRoots ?? conventionalSourceRoots(imports?.sourceFiles ?? []);

  const anchorMemo = new Map<string, Map<string, number>>();
  const lineMemo = new Map<string, number>();
  const linesOf = (file: string): number => {
    const cached = lineMemo.get(file);
    if (cached !== undefined) return cached;
    const content = host.read(file);
    const lines = content === null ? 0 : countLines(content);
    lineMemo.set(file, lines);
    return lines;
  };
  const anchoredFiles = (anchors: readonly string[]): Map<string, number> => {
    const out = new Map<string, number>();
    for (const anchor of anchors) {
      const path = anchorTarget(anchor);
      if (path.length === 0) continue;
      let walked = anchorMemo.get(path);
      if (walked === undefined) {
        walked = filesUnderAnchor(path, host);
        anchorMemo.set(path, walked);
      }
      for (const [file, lines] of walked) {
        if (!isFolderRowFile(file) || out.has(file)) continue;
        out.set(file, lines);
        if (!lineMemo.has(file)) lineMemo.set(file, lines);
      }
    }
    return out;
  };
  // Every file's segment words, split once per builder — a graph read name-
  // matches ~150 nodes against the same few thousand paths.
  let universeWords: Array<{ file: string; segments: string[][] }> | null = null;
  const nameMatchedFiles = (slug: string): string[] => {
    const stems = slugStems(slug);
    if (stems.length === 0) return [];
    universeWords ??= universe.map((file) => ({ file, segments: pathSegmentWords(file) }));
    return universeWords.filter((entry) => segmentsMatchStems(entry.segments, stems)).map((entry) => entry.file);
  };

  // Forward edges, inverted from the index's reverse ones on first need.
  let forward: Map<string, string[]> | null = null;
  const importsOf = (file: string): readonly string[] => {
    if (imports === null || partial) return [];
    if (forward === null) {
      const built = new Map<string, string[]>();
      for (const target of imports.sourceFiles) {
        for (const importer of imports.importersOf(target)) {
          const list = built.get(importer) ?? [];
          list.push(target);
          built.set(importer, list);
        }
      }
      forward = built;
    }
    return forward.get(file) ?? [];
  };
  /** Files reached from `seeds` within `depth` hops, never entering a stopped file. */
  const trace = (seeds: Iterable<string>, stop: ReadonlySet<string>): Set<string> => {
    const reached = new Set<string>();
    let frontier = [...seeds].filter((file) => !stop.has(file));
    const seen = new Set(frontier);
    for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const file of frontier) {
        for (const target of importsOf(file)) {
          if (seen.has(target)) continue;
          seen.add(target);
          if (stop.has(target) || !isFolderRowFile(target)) continue;
          reached.add(target);
          next.push(target);
        }
      }
      frontier = next;
    }
    return reached;
  };

  interface BaseSet {
    anchored: Map<string, number>;
    named: string[];
  }
  const baseMemo = new Map<string, BaseSet>();
  const keyOf = (input: FolderNodeInput): string => `${input.slug}\u0000${[...input.anchors].join('\u0000')}`;
  const baseOf = (input: FolderNodeInput): BaseSet => {
    const key = keyOf(input);
    const cached = baseMemo.get(key);
    if (cached !== undefined) return cached;
    const base = { anchored: anchoredFiles(input.anchors), named: nameMatchedFiles(input.slug) };
    baseMemo.set(key, base);
    return base;
  };

  let shared: Set<string> | null = null;
  const sharedSet = (): Set<string> => {
    if (shared !== null) return shared;
    const markOver = (sets: readonly ReadonlySet<string>[]): Set<string> => {
      const counts = new Map<string, number>();
      for (const set of sets) for (const file of set) counts.set(file, (counts.get(file) ?? 0) + 1);
      return new Set([...counts].filter(([, count]) => count >= threshold).map(([file]) => file));
    };
    // Each feature once, however many times the graph lists it.
    const features = [...new Map(options.coreFeatures.map((feature) => [feature.id, feature])).values()];
    const walks = features.map((feature) => {
      const base = baseOf(feature);
      const reached = new Set([...base.anchored.keys(), ...base.named]);
      return { reached, frontier: [...base.anchored.keys()] };
    });
    // (a)+(b): shared among the anchored + name-matched sets.
    const marked = markOver(walks.map((walk) => walk.reached));
    // (c)+(d): every feature's trace advances one hop at a time, in lockstep. A
    // file this hop brings to ≥ threshold features is shared before anyone
    // walks on from it, so nothing is ever reached THROUGH a hub.
    for (let hop = 0; hop < depth; hop += 1) {
      const candidates = walks.map((walk) => {
        const next = new Set<string>();
        for (const file of walk.frontier) {
          if (marked.has(file)) continue;
          for (const target of importsOf(file)) {
            if (!walk.reached.has(target) && !marked.has(target) && isFolderRowFile(target)) next.add(target);
          }
        }
        return next;
      });
      const counts = new Map<string, number>();
      walks.forEach((walk, i) => {
        for (const file of new Set([...walk.reached, ...candidates[i]])) counts.set(file, (counts.get(file) ?? 0) + 1);
      });
      for (const [file, count] of counts) if (count >= threshold) marked.add(file);
      walks.forEach((walk, i) => {
        const next = [...candidates[i]].filter((file) => !marked.has(file));
        for (const file of next) walk.reached.add(file);
        walk.frontier = next;
      });
    }
    // (e): one last count over the traced sets — a file the features reached
    // at different hops can still add up to the threshold.
    for (const file of markOver(walks.map((walk) => walk.reached))) marked.add(file);
    shared = marked;
    return shared;
  };

  const setMemo = new Map<string, Map<string, number>>();
  const filesFor = (input: FolderNodeInput): Map<string, number> => {
    const key = keyOf(input);
    const cached = setMemo.get(key);
    if (cached !== undefined) return cached;
    const stop = sharedSet();
    const base = baseOf(input);
    const out = new Map<string, number>();
    for (const [file, lines] of base.anchored) if (!stop.has(file)) out.set(file, lines);
    for (const file of base.named) if (!stop.has(file) && !out.has(file)) out.set(file, linesOf(file));
    for (const file of trace(base.anchored.keys(), stop)) if (!out.has(file)) out.set(file, linesOf(file));
    setMemo.set(key, out);
    return out;
  };

  const rowsMemo = new Map<string, FeatureFolders | null>();
  return {
    rowsFor(input) {
      const key = `${keyOf(input)}\u0001${input.home ?? ''}`;
      if (rowsMemo.has(key)) return rowsMemo.get(key) ?? null;
      const rows = folderRowsOf(filesFor(input), sourceRoots, {
        home: input.home,
        exists: (path) => host.classify(path) === 'dir',
      });
      const answer = rows !== null && partial ? { ...rows, partial: true as const } : rows;
      rowsMemo.set(key, answer);
      return answer;
    },
    sharedFiles: () => [...sharedSet()].sort(),
    filesFor,
  };
}
