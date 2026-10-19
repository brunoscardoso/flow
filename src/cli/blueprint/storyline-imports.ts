/**
 * CODE STORYLINE — who imports what, for ranking a story's ways in
 * (plan `code-storyline` phase 3).
 *
 * A story opens on the piece OTHER files use most, so the verb needs to know,
 * for any file, which project files import it. That answer needs every TS/JS
 * file of the project, and walking the project is the expensive part: on this
 * repo the shared walker (`walkRepo` — the extractors' own ignore rules,
 * including the repo's `.gitignore`) takes ~2.5 s, almost all of it asking git
 * which directories it ignores.
 *
 * So the walk is CACHED, at `flow/brain/.structure/storyline/imports.json`
 * (generated class — rebuilt per machine, never synced), and re-checked
 * cheaply instead of re-walked:
 *
 *   • the file LIST stands while every walked directory keeps its mtime
 *     (adding, removing or renaming an entry changes its directory's) and every
 *     `.gitignore` keeps its mtime and size — any difference re-walks;
 *   • each file's import SPECIFIERS stand while the file keeps its mtime and
 *     size; a changed file is re-read alone.
 *
 * mtime + size is a pre-filter, not proof of content (forbidden-pattern #10 is
 * about a commit clock; this is the file's own stat). What it can get wrong is a
 * rank COUNT — never a drawn arrow: the story's arrows come from the file's own
 * parse, cached by content hash in the verb. Known blind spot: a file created
 * inside a directory that held no walked entry before (an empty directory) is
 * not seen until something else changes the walk.
 *
 * Specifiers come from `ts.preProcessFile` — the compiler's scanner-only import
 * reader, which already knows comments and strings from code — so a cold build
 * never pays for a full parse of every file. Names are read later, by a real
 * parse of the handful of files whose specifiers point at the story's file.
 *
 * EVERY LANGUAGE WITH A READER (plan `story-any-language` phase 3). The walk
 * keeps every file a story can be read from — TS/JS and every tree-sitter
 * table's extensions — so a part's directory anchors expand to its Python or Go
 * files too. TS/JS specifiers are read eagerly (as before); another language's
 * are read LAZILY, the first time a story in that language asks who imports it,
 * with its table's imports query (the grammar is loaded by then — the story's
 * own file needed it), and resolved by its table's resolver against the disk.
 * Imports only ever resolve within a language, so a TypeScript story never pays
 * for parsing the project's Python, and vice versa.
 *
 * NEVER BUILT ON AN INTERACTIVE PATH WHEN COLD. A read first PLANS (stats and
 * directory reads only — ~0.3 s for 5,000 files on a fresh checkout) and only
 * then opens the TS/JS files whose stat changed. Opening is the cost: on a
 * freshly cloned 4,900-file repo the serial reads took 17.4 s wall for ~1.3 s
 * of CPU. So a read may carry a `readBudget` (the feature graph's): with more
 * files to open than that, it opens none, answers `complete: false` and writes
 * nothing, and `warmProjectImportIndex` (the `blueprint index warm` verb,
 * started detached) builds it with concurrent reads — 3.8 s on that clone —
 * under a per-project lock so one build runs at a time. The cache is written
 * aside and renamed, so no reader ever sees half of it. Files over
 * `MAX_SPECIFIER_FILE_BYTES` and minified bundles are recorded as importing
 * nothing without being opened.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { isSourceFile, readFileSafe, walkRepo } from './extractors/scan.js';
import { resolveRelativeImport } from './storyline.js';
import { importSpecifiersOf, isDirectoryTarget, storylineTableFor } from './storyline-languages.js';
import { storylineFamilyOf, storylineProjectOf, type StorylineReaders } from './storyline-reader.js';
import { BLUEPRINT_DIRNAME } from './store.js';

/** The storyline cache's folder, inside the blueprint structure folder. */
export const STORYLINE_CACHE_DIRNAME = 'storyline';

/**
 * Where a project's storyline cache lives (`flow/brain/.structure/storyline`),
 * or null when the project has no `flow/` folder — read, never written into.
 * The ONE answer: the story verb and the features graph's folder rows both read
 * the import index through it, so a graph read reuses the story's cache.
 */
export function storylineCacheDir(repoRoot: string): string | null {
  const flowDir = join(repoRoot, 'flow');
  if (!existsSync(flowDir)) return null;
  return join(flowDir, BLUEPRINT_DIRNAME, STORYLINE_CACHE_DIRNAME);
}

/** Bumped whenever the stored shape changes, so an older index is rebuilt. */
const IMPORT_INDEX_VERSION = 2;

/** The cached index's file name inside the storyline cache folder. */
export const IMPORT_INDEX_FILENAME = 'imports.json';

/** Held by the one warm build running for a project (`warmProjectImportIndex`). */
export const IMPORT_INDEX_LOCK_FILENAME = 'imports.lock';

/**
 * A lock older than this is a build that died without releasing it. A warm
 * build of a 5,000-file repo takes seconds; ten minutes is never a live one.
 */
export const IMPORT_INDEX_LOCK_STALE_MS = 10 * 60 * 1000;

const GITIGNORE_NAME = '.gitignore';

/** The family TS and JS share — one import graph, read by the compiler. */
const COMPILER_FAMILY = 'typescript';

interface FileStat {
  mtimeMs: number;
  size: number;
}

interface IndexedFile extends FileStat {
  /** Its import specifiers — null while not read yet (another language's, read on demand). */
  specifiers: string[] | null;
}

interface ImportIndexStore {
  version: number;
  /** Walked directory → its mtime when walked. */
  dirs: Record<string, number>;
  /** Every `.gitignore` the walk saw → its stat. */
  ignoreFiles: Record<string, FileStat>;
  /** Every file a story can be read from → its stat and import specifiers. */
  files: Record<string, IndexedFile>;
}

/** The project's readable files and who imports whom, for one run of the verb. */
export interface ProjectImportIndex {
  /** Every file a story can be read from (any language with a reader), sorted. */
  sourceFiles: readonly string[];
  /** Whether a project path names one of those files. */
  has: (relPath: string) => boolean;
  /** Files of the same language whose imports resolve to `target`, sorted. */
  importersOf: (target: string) => string[];
  /** Whether this run re-walked the project or trusted the cached walk. */
  built: 'walk' | 'cache';
  /**
   * Whether every TS/JS file's import specifiers were read. False only for a
   * budgeted read (`readBudget`) that found more files to open than it may:
   * the file list is whole, the import edges are not to be trusted, and
   * nothing was written — `warmProjectImportIndex` builds it.
   */
  complete: boolean;
}

/** How a read of the index may spend its time. */
export interface ImportIndexReadOptions {
  /**
   * The most files this read may OPEN to read their import specifiers. When
   * more need reading (a cold cache, a branch switch) it opens none of them and
   * answers `complete: false` instead of blocking — on a freshly checked-out
   * repo each first open costs milliseconds (measured: 4,901 files read
   * serially in 17.4 s wall, 1.3 s CPU). Omitted: no limit — the story verb's
   * read, which needs the edges to answer at all.
   */
  readBudget?: number;
}

/**
 * Files larger than this are not read for their imports — a hand-written
 * module is far smaller; anything this size is a bundle, a vendored library or
 * generated output whose imports no story ranks by. Recorded as importing
 * nothing, so it never costs a read again while its stat holds.
 */
export const MAX_SPECIFIER_FILE_BYTES = 512 * 1024;

/** Minified and bundled output — read as importing nothing, like an oversized file. */
const NOT_READ_FOR_IMPORTS = /(?:\.min\.[cm]?js|\.bundle\.[cm]?js|\.chunk\.[cm]?js)$/;

/** How many reads a warm build keeps in flight (bounded — allowed-pattern #19's cousin). */
export const WARM_READ_CONCURRENCY = 32;

/** Whether the walk keeps a file: a story can be read from it. */
function isIndexedFile(relPath: string): boolean {
  return isSourceFile(relPath) || storylineTableFor(relPath) !== null;
}

/**
 * Read (or build) the project's import index. `cacheDir` null keeps nothing
 * on disk — a repo without a `flow/` folder is read, never written into.
 */
export function readProjectImportIndex(
  repoRoot: string,
  readers: StorylineReaders,
  cacheDir: string | null,
  options: ImportIndexReadOptions = {},
): ProjectImportIndex {
  const cachePath = cacheDir === null ? null : join(cacheDir, IMPORT_INDEX_FILENAME);
  const stored = cachePath === null ? null : readStore(cachePath);
  const reader: SpecifierReader = { repoRoot, readers };
  const plan = planIndex(reader, stored);

  const budget = options.readBudget;
  if (budget !== undefined && plan.pending.length > budget) {
    // Too much to open on this path: answer with the list, no edges, and
    // leave the cache for the warm build to write.
    const files = { ...plan.files };
    for (const { relPath, stat } of plan.pending) files[relPath] = { ...stat, specifiers: null };
    return indexOver(reader, { version: IMPORT_INDEX_VERSION, dirs: plan.dirs, ignoreFiles: plan.ignoreFiles, files }, null, plan.built, false);
  }

  let changed = plan.changed;
  const files = { ...plan.files };
  for (const { relPath, stat } of plan.pending) {
    const text = readFileSafe(join(repoRoot, relPath));
    changed = true;
    if (text === null) continue;
    files[relPath] = { ...stat, specifiers: specifiersOf(reader, text) };
  }
  const store: ImportIndexStore = { version: IMPORT_INDEX_VERSION, dirs: plan.dirs, ignoreFiles: plan.ignoreFiles, files: sortedRecord(files) };
  if (changed && cachePath !== null) writeStore(cachePath, store);
  return indexOver(reader, store, cachePath, plan.built, true);
}

/** What a warm build did. */
export interface ImportIndexWarmResult {
  /** `built`: read and wrote; `fresh`: the cache already stood; `busy`: another build holds the lock; `no-cache`: no `flow/` folder to keep it in. */
  status: 'built' | 'fresh' | 'busy' | 'no-cache';
  /** Files in the index. */
  files: number;
  /** Files opened to read their imports. */
  read: number;
  ms: number;
}

/**
 * Build the index OFF any interactive path — the background `blueprint index
 * warm` verb. One build per project at a time (`imports.lock`); reads run
 * concurrently (`WARM_READ_CONCURRENCY`), which on a fresh checkout cut 4,901
 * cold reads from 17.4 s serial to 3.4–5.6 s.
 */
export async function warmProjectImportIndex(
  repoRoot: string,
  readers: StorylineReaders,
  cacheDir: string | null,
  options: { concurrency?: number; now?: () => number } = {},
): Promise<ImportIndexWarmResult> {
  const now = options.now ?? Date.now;
  const started = now();
  if (cacheDir === null) return { status: 'no-cache', files: 0, read: 0, ms: 0 };
  const release = acquireIndexLock(cacheDir);
  if (release === null) return { status: 'busy', files: 0, read: 0, ms: now() - started };
  try {
    const cachePath = join(cacheDir, IMPORT_INDEX_FILENAME);
    const reader: SpecifierReader = { repoRoot, readers };
    const plan = planIndex(reader, readStore(cachePath));
    const files = { ...plan.files };
    const pending = plan.pending;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const { relPath, stat } = pending[next];
        next += 1;
        const text = await readFileAsync(join(repoRoot, relPath));
        if (text !== null) files[relPath] = { ...stat, specifiers: specifiersOf(reader, text) };
      }
    };
    const concurrency = Math.max(1, options.concurrency ?? WARM_READ_CONCURRENCY);
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    const changed = plan.changed || pending.length > 0;
    const store: ImportIndexStore = { version: IMPORT_INDEX_VERSION, dirs: plan.dirs, ignoreFiles: plan.ignoreFiles, files: sortedRecord(files) };
    // A project deleted while the build ran (a test's temp checkout) is not
    // written back into being.
    if (changed && existsSync(cacheDir)) writeStore(cachePath, store);
    return { status: changed ? 'built' : 'fresh', files: Object.keys(files).length, read: pending.length, ms: now() - started };
  } finally {
    release();
  }
}

/** Whether a warm build is running for this cache folder right now. */
export function importIndexWarmRunning(cacheDir: string): boolean {
  return liveLock(join(cacheDir, IMPORT_INDEX_LOCK_FILENAME)) !== null;
}

function indexOver(
  reader: SpecifierReader,
  store: ImportIndexStore,
  cachePath: string | null,
  built: 'walk' | 'cache',
  complete: boolean,
): ProjectImportIndex {
  const { repoRoot } = reader;
  const sourceFiles = Object.keys(store.files).sort();
  const known = new Set(sourceFiles);
  const has = (relPath: string): boolean => known.has(relPath);
  const reverseByFamily = new Map<string, Map<string, string[]>>();
  const importersOf = (target: string): string[] => {
    const family = storylineFamilyOf(target);
    if (family === null) return [];
    let reverse = reverseByFamily.get(family);
    if (reverse === undefined) {
      if (family !== COMPILER_FAMILY && fillFamily(reader, store, family) && cachePath !== null) writeStore(cachePath, store);
      reverse = family === COMPILER_FAMILY ? buildCompilerReverse(store, has) : buildTableReverse(repoRoot, store, family, has);
      reverseByFamily.set(family, reverse);
    }
    return reverse.get(target) ?? [];
  };
  return { sourceFiles, has, importersOf, built, complete };
}

// ── Building ─────────────────────────────────────────────

interface SpecifierReader {
  repoRoot: string;
  readers: StorylineReaders;
}

/** A TS/JS file whose specifiers must be read: its stat, and nothing read yet. */
interface PendingRead {
  relPath: string;
  stat: FileStat;
}

/**
 * Everything an index read decides WITHOUT opening a file: the list (cached or
 * re-walked), every entry whose stat still stands, and the TS/JS files that
 * need a read. Stats and directory reads only — on a fresh checkout those cost
 * ~0.3 s for 5,000 files where opening them cost 17 s.
 */
interface IndexPlan {
  dirs: Record<string, number>;
  ignoreFiles: Record<string, FileStat>;
  /** Entries settled without a read. */
  files: Record<string, IndexedFile>;
  pending: PendingRead[];
  built: 'walk' | 'cache';
  /** Whether a settled entry differs from the stored one (or the list was re-walked). */
  changed: boolean;
}

function planIndex(reader: SpecifierReader, stored: ImportIndexStore | null): IndexPlan {
  const listed = stored === null ? null : listFromCache(reader.repoRoot, stored);
  const fromCache = listed === null ? null : planEntries(reader, listed.paths, stored, true);
  if (listed !== null && fromCache !== null) {
    return { dirs: listed.dirs, ignoreFiles: listed.ignoreFiles, ...fromCache, built: 'cache' };
  }
  const walked = walkList(reader.repoRoot);
  const entries = planEntries(reader, walked.paths, stored, false) as Pick<IndexPlan, 'files' | 'pending' | 'changed'>;
  return { dirs: walked.dirs, ignoreFiles: walked.ignoreFiles, files: entries.files, pending: entries.pending, changed: true, built: 'walk' };
}

interface FileList {
  dirs: Record<string, number>;
  ignoreFiles: Record<string, FileStat>;
  paths: string[];
}

function walkList(repoRoot: string): FileList {
  const scan = walkRepo(repoRoot);
  const dirs: Record<string, number> = {};
  for (const dir of scan.dirs ?? []) {
    const stat = statOf(dir === '' ? repoRoot : join(repoRoot, dir));
    if (stat !== null) dirs[dir] = stat.mtimeMs;
  }
  const ignoreFiles: Record<string, FileStat> = {};
  const paths: string[] = [];
  for (const relPath of scan.files) {
    if (isGitignore(relPath)) {
      const stat = statOf(join(repoRoot, relPath));
      if (stat !== null) ignoreFiles[relPath] = stat;
      continue;
    }
    if (isIndexedFile(relPath)) paths.push(relPath);
  }
  return { dirs, ignoreFiles, paths };
}

/**
 * The cached file list, while it stands — or null when it may have changed
 * and only a new walk can say how.
 */
function listFromCache(repoRoot: string, stored: ImportIndexStore): FileList | null {
  for (const [dir, mtimeMs] of Object.entries(stored.dirs)) {
    const stat = statOf(dir === '' ? repoRoot : join(repoRoot, dir));
    if (stat === null || stat.mtimeMs !== mtimeMs) return null;
  }
  for (const [relPath, recorded] of Object.entries(stored.ignoreFiles)) {
    const stat = statOf(join(repoRoot, relPath));
    if (stat === null || !sameStat(stat, recorded)) return null;
  }
  return { dirs: stored.dirs, ignoreFiles: stored.ignoreFiles, paths: Object.keys(stored.files) };
}

/**
 * Settle each listed file by its stat, reusing the stored entry (the same
 * object) while the stat holds. `strict`: a listed file that is gone means the
 * cached list is wrong after all → null (the caller re-walks).
 */
function planEntries(
  reader: SpecifierReader,
  paths: readonly string[],
  stored: ImportIndexStore | null,
  strict: boolean,
): Pick<IndexPlan, 'files' | 'pending' | 'changed'> | null {
  const files: Record<string, IndexedFile> = {};
  const pending: PendingRead[] = [];
  let changed = false;
  // The compiler is loaded only when some entry needs it to decide.
  let ts: ReturnType<StorylineReaders['typescript']> | undefined;
  const compilerLoaded = (): boolean => {
    if (ts === undefined) ts = reader.readers.typescript();
    return ts !== null;
  };
  for (const relPath of paths) {
    const stat = statOf(join(reader.repoRoot, relPath));
    if (stat === null) {
      // A file gone without its directory noticing is a list change after all.
      if (strict) return null;
      continue;
    }
    const previous = stored?.files[relPath];
    const compiler = isSourceFile(relPath);
    if (previous !== undefined && sameStat(stat, previous)) {
      // An entry left unread because the compiler was missing is read once it is not.
      if (previous.specifiers !== null || !compiler || !compilerLoaded()) {
        files[relPath] = previous;
        continue;
      }
    }
    changed = true;
    if (!compiler || !compilerLoaded()) {
      // Another language's specifiers wait for `fillFamily`.
      files[relPath] = { ...stat, specifiers: null };
    } else if (stat.size > MAX_SPECIFIER_FILE_BYTES || NOT_READ_FOR_IMPORTS.test(relPath)) {
      files[relPath] = { ...stat, specifiers: [] };
    } else {
      pending.push({ relPath, stat });
    }
  }
  return { files, pending, changed };
}

/** A TS/JS file's import specifiers, by the compiler's scanner-only reader. */
function specifiersOf(reader: SpecifierReader, text: string): string[] {
  const ts = reader.readers.typescript();
  if (ts === null) return [];
  const specifiers = ts.preProcessFile(text, true, true).importedFiles.map((entry) => entry.fileName);
  return [...new Set(specifiers)];
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

/** Read the specifiers of every unread file of a tree-sitter family. True when any entry changed. */
function fillFamily(reader: SpecifierReader, store: ImportIndexStore, family: string): boolean {
  let changed = false;
  for (const [relPath, indexed] of Object.entries(store.files)) {
    if (indexed.specifiers !== null || storylineFamilyOf(relPath) !== family) continue;
    const table = storylineTableFor(relPath);
    const text = readFileSafe(join(reader.repoRoot, relPath));
    if (table === null || text === null) continue;
    const imports = reader.readers.treeSitterImports(relPath, text);
    // No grammar loaded: leave it unread rather than record "imports nothing".
    if (imports === null) continue;
    store.files[relPath] = { mtimeMs: indexed.mtimeMs, size: indexed.size, specifiers: importSpecifiersOf(table, imports) };
    changed = true;
  }
  return changed;
}

function buildCompilerReverse(store: ImportIndexStore, has: (relPath: string) => boolean): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const [importer, indexed] of Object.entries(store.files)) {
    if (indexed.specifiers === null || !isSourceFile(importer)) continue;
    const targets = new Set<string>();
    for (const specifier of indexed.specifiers) {
      const target = resolveRelativeImport(importer, specifier, has);
      if (target !== null && target !== importer) targets.add(target);
    }
    addAll(reverse, importer, targets);
  }
  return sorted(reverse);
}

/**
 * Who imports whom within one tree-sitter family: each specifier resolved by
 * the table's own resolver against the disk (a Go module path needs `go.mod`,
 * a PHP namespace `composer.json`); a directory target (a Go package) counts
 * for each of its files of the family.
 */
function buildTableReverse(
  repoRoot: string,
  store: ImportIndexStore,
  family: string,
  has: (relPath: string) => boolean,
): Map<string, string[]> {
  const project = storylineProjectOf(repoRoot);
  const filesOfFamily = Object.keys(store.files).filter((file) => storylineFamilyOf(file) === family);
  const reverse = new Map<string, string[]>();
  for (const importer of filesOfFamily) {
    const indexed = store.files[importer];
    const table = storylineTableFor(importer);
    if (indexed === undefined || indexed.specifiers === null || table === null) continue;
    const targets = new Set<string>();
    for (const specifier of indexed.specifiers) {
      const resolved = table.resolveImport(importer, specifier, project);
      if (resolved === null) continue;
      if (isDirectoryTarget(resolved)) {
        const directory = resolved.slice(0, -1) || '.';
        for (const file of filesOfFamily) if (posix.dirname(file) === directory) targets.add(file);
        continue;
      }
      if (has(resolved)) targets.add(resolved);
    }
    targets.delete(importer);
    addAll(reverse, importer, targets);
  }
  return sorted(reverse);
}

function addAll(reverse: Map<string, string[]>, importer: string, targets: ReadonlySet<string>): void {
  for (const target of targets) {
    const list = reverse.get(target) ?? [];
    list.push(importer);
    reverse.set(target, list);
  }
}

function sorted(reverse: Map<string, string[]>): Map<string, string[]> {
  for (const list of reverse.values()) list.sort();
  return reverse;
}

// ── Disk ─────────────────────────────────────────────────

function readStore(cachePath: string): ImportIndexStore | null {
  if (!existsSync(cachePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf-8')) as Partial<ImportIndexStore>;
    if (parsed.version !== IMPORT_INDEX_VERSION) return null;
    if (!isRecord(parsed.dirs) || !isRecord(parsed.ignoreFiles) || !isRecord(parsed.files)) return null;
    return parsed as ImportIndexStore;
  } catch {
    // A corrupt or half-written cache is only a cache: walk again and rewrite it.
    return null;
  }
}

function writeStore(cachePath: string, store: ImportIndexStore): void {
  // Written aside and renamed into place: a reader (the graph, a story, a
  // concurrent warm) sees the old index or the new one, never half of one.
  const tmpPath = `${cachePath}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(store), 'utf-8');
    renameSync(tmpPath, cachePath);
  } catch {
    // Fail-soft: an unwritable cache costs the next run a walk, never this
    // run its answer.
    rmSync(tmpPath, { force: true });
  }
}

async function readFileAsync(absPath: string): Promise<string | null> {
  try {
    return await readFile(absPath, 'utf-8');
  } catch {
    // Gone between the stat and the read — left out, like a sync read's null.
    return null;
  }
}

interface LockRecord {
  pid: number;
  startedAt: number;
}

/** The lock's record when a live build holds it, else null (absent, unreadable or stale). */
function liveLock(lockPath: string, now: number = Date.now()): LockRecord | null {
  let record: Partial<LockRecord>;
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf-8')) as Partial<LockRecord>;
  } catch {
    // No lock, or one being written this instant: a half-written lock is
    // younger than any stale one, so its file's age decides.
    const stat = statOf(lockPath);
    return stat !== null && now - stat.mtimeMs < IMPORT_INDEX_LOCK_STALE_MS ? { pid: 0, startedAt: stat.mtimeMs } : null;
  }
  if (typeof record.pid !== 'number' || typeof record.startedAt !== 'number') return null;
  if (now - record.startedAt >= IMPORT_INDEX_LOCK_STALE_MS) return null;
  return processAlive(record.pid) ? { pid: record.pid, startedAt: record.startedAt } : null;
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it is just not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the project's build lock, or null when a live build holds it. A stale
 * lock (dead pid, or older than `IMPORT_INDEX_LOCK_STALE_MS`) is taken over.
 * Exclusive create (`wx`) makes two racing builds agree on one winner.
 */
function acquireIndexLock(cacheDir: string): (() => void) | null {
  const lockPath = join(cacheDir, IMPORT_INDEX_LOCK_FILENAME);
  try {
    // Never re-create a project that is gone: only the cache folder itself is
    // made, under a `flow/` folder that must still exist.
    if (!existsSync(dirname(dirname(dirname(cacheDir))))) return null;
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      if (liveLock(lockPath) !== null) return null;
      // Stale: clear it and try once more — a racer that clears it first wins.
      rmSync(lockPath, { force: true });
    }
  }
  return null;
}

function statOf(absPath: string): FileStat | null {
  try {
    const stat = statSync(absPath);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    // Gone or unreadable — the caller treats a missing stat as "changed".
    return null;
  }
}

function sameStat(a: FileStat, b: FileStat): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function isGitignore(relPath: string): boolean {
  return relPath === GITIGNORE_NAME || relPath.endsWith(`/${GITIGNORE_NAME}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
