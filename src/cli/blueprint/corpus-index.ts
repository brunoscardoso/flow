/**
 * Corpus index (feature-blueprint, #1532) — one entry per DOC, with dates.
 *
 * The corpus miner (`feature-discover`) scans `flow/{plans,discovery,archive}`
 * on every pass and forgets everything between passes — fine for staging
 * candidates, useless for a board that wants to list "what changed, when".
 * This module persists that pass as `flow/brain/.derived/corpus-index.json`:
 * every change/discovery doc the miner saw, with a `created` date that
 * survives re-runs (previous index → git first-commit → pass timestamp).
 *
 * PER-DOC, NOT PER-SLUG. `mineCorpus` dedupes by slug first-seen so a live
 * plan beats its archived copy; the index wants BOTH files — the archived one
 * flagged — because the doc file is the unit a date belongs to.
 *
 * DERIVED AND DISPOSABLE. Lives in `flow/brain/.derived/` under that
 * directory's one rule: every byte is regenerable (see the essay on
 * `FEATURE_INDEX_RELPATH` in `feature-graph.ts`). Deleting it costs only the
 * carried-forward `created` dates, which the git lookup mostly restores.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Where the index lives, relative to the project's `flow/` dir. */
export const CORPUS_INDEX_RELPATH = 'brain/.derived/corpus-index.json';

/** Timeout for the one capped git first-commit lookup per new doc. */
const GIT_LOG_TIMEOUT_MS = 5_000;

/** One corpus document, as the discover pass saw it. */
export interface CorpusIndexEntry {
  /** Repo-relative doc path, e.g. `flow/plans/plan_x_v1.md`. */
  path: string;
  /** Plans and archived docs are CHANGES; discovery docs are DISCOVERY. */
  kind: 'change' | 'discovery';
  /** Core feature this doc was parented under; null when unparented. */
  featureSlug: string | null;
  /** Display name — the doc's `#` heading, or a title-cased slug. */
  name: string;
  /** First-seen ISO date: previous index → git first commit → pass timestamp. */
  created: string;
  /** ISO timestamp of the pass that (re)wrote this entry. */
  indexed: string;
  /** True when the doc was sourced from `flow/archive/`. */
  archived: boolean;
}

/** The persisted envelope. */
export interface CorpusIndex {
  /** ISO timestamp of the pass that wrote the file. */
  indexedAt: string;
  entries: CorpusIndexEntry[];
}

/** What the discover pass hands the builder — an entry minus the dates. */
export type CorpusDocRecord = Omit<CorpusIndexEntry, 'created' | 'indexed'>;

const EMPTY_INDEX: CorpusIndex = { indexedAt: '', entries: [] };

/**
 * Read the persisted index. Fail-soft by contract: a missing, unreadable or
 * shape-invalid file is an EMPTY index, never a throw — the index is derived,
 * and losing it only means `created` dates fall back to the git lookup.
 */
export function readCorpusIndex(flowDir: string): CorpusIndex {
  const filePath = join(flowDir, CORPUS_INDEX_RELPATH);
  if (!existsSync(filePath)) return { ...EMPTY_INDEX, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as CorpusIndex;
    if (typeof parsed.indexedAt !== 'string' || !Array.isArray(parsed.entries)) {
      return { ...EMPTY_INDEX, entries: [] };
    }
    return {
      indexedAt: parsed.indexedAt,
      entries: parsed.entries.filter(
        (entry) => typeof entry?.path === 'string' && typeof entry?.created === 'string',
      ),
    };
  } catch {
    // Corrupt JSON — the regenerable tier's sanctioned answer is "start empty".
    return { ...EMPTY_INDEX, entries: [] };
  }
}

/**
 * Write the index in full. Derived + disposable: sorted by path so the same
 * pass produces the same bytes, written through a temp file + rename so a
 * reader never observes a half-written index.
 */
export function writeCorpusIndex(flowDir: string, index: CorpusIndex): void {
  const filePath = join(flowDir, CORPUS_INDEX_RELPATH);
  mkdirSync(dirname(filePath), { recursive: true });
  const sorted: CorpusIndex = {
    indexedAt: index.indexedAt,
    entries: [...index.entries].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf-8');
  renameSync(temp, filePath);
}

/** Minimal exec surface for the git lookup — injectable so tests mock the
 * module, never PATH (allowed-pattern #12). Returns raw stdout. */
export type GitLogExec = (args: readonly string[], cwd: string) => string;

// Argv-array spawning, never a command STRING: `execFileSync` hands git the
// arguments directly, with no shell parse on any platform — on native Windows
// a string goes through cmd.exe, where POSIX single-quoting quotes nothing
// and a hostile doc path becomes an injection.
const defaultGitLogExec: GitLogExec = (args, cwd) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_LOG_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/**
 * First-commit author date for a path, or null. One capped lookup; ANY
 * failure (no git, untracked file, symlinked flow/, timeout) is a silent
 * null by contract — the caller falls back to the pass timestamp.
 */
function gitFirstCommitDate(repoRoot: string, relPath: string, exec: GitLogExec): string | null {
  try {
    const out = exec(['log', '--follow', '--format=%aI', '--reverse', '--', relPath], repoRoot);
    const first = out.split('\n')[0].trim();
    return first.length > 0 ? first : null;
  } catch {
    // Sanctioned fail-soft: `created` degrades to the pass timestamp.
    return null;
  }
}

/**
 * First-commit author dates for MANY paths in one history walk (#1654). A
 * per-doc `git log --follow` spawn walks the entire history each time and
 * runs sequentially — a cold pass paid `docs × full-history` (~1.8s per doc
 * on a WSL /mnt/c checkout). One `--diff-filter=A` traversal dates every
 * added path at the cost of a single spawn. Rename detection means a MOVED
 * doc never shows as an add here, so its date is deliberately absent from
 * the result — the caller reserves the per-path `--follow` lookup for
 * exactly those misses. Fail-soft like the per-path lookup: any failure is
 * an empty map, and every path degrades to the `--follow` path.
 */
function gitFirstCommitDates(
  repoRoot: string,
  relPaths: readonly string[],
  exec: GitLogExec,
): Map<string, string> {
  const dates = new Map<string, string>();
  try {
    // %x00 marks commit-date lines apart from the path lines that follow
    // them; quotepath off so non-ASCII doc names come back unescaped.
    const out = exec(
      ['-c', 'core.quotepath=false', 'log', '--reverse', '--diff-filter=A', '--format=%x00%aI', '--name-only', '--', ...relPaths],
      repoRoot,
    );
    let currentDate: string | null = null;
    for (const rawLine of out.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('\0')) {
        const date = line.slice(1).trim();
        currentDate = date.length > 0 ? date : null;
        continue;
      }
      if (line.length === 0 || currentDate === null) continue;
      // --reverse: the first commit listing a path is its creation.
      if (!dates.has(line)) dates.set(line, currentDate);
    }
  } catch {
    // Sanctioned fail-soft: every path falls back to its per-path lookup.
  }
  return dates;
}

/**
 * Build the next index from the pass's docs and the previous index.
 *
 * `created` resolution, first-seen wins: a path already in the previous index
 * keeps its `created` forever; an archived doc whose file name the previous
 * index already dated inherits that date (the plans→archive move keeps the
 * name, so archiving never re-pays the git lookup — #1654); a new path gets
 * its git first-commit date; a path git has never seen gets the pass
 * timestamp. `indexed` is always the pass timestamp. Deterministic given the
 * same docs + previous index + clock.
 *
 * Date resolution costs O(1) spawns, not O(docs) (#1654): all unresolved
 * paths share one `--diff-filter=A` history walk, and the per-path
 * `--follow` spawn is reserved for the paths that walk cannot date (renames).
 */
export function buildCorpusIndex(
  docs: readonly CorpusDocRecord[],
  previous: CorpusIndex,
  passTimestamp: string,
  repoRoot: string,
  exec: GitLogExec = defaultGitLogExec,
): CorpusIndex {
  const previousCreated = new Map<string, string>();
  for (const entry of previous.entries) {
    if (!previousCreated.has(entry.path)) previousCreated.set(entry.path, entry.created);
  }
  // File name → created, for the archive carry. A name dated to two DIFFERENT
  // times in the previous index is ambiguous and carries nothing.
  const previousByName = new Map<string, string | null>();
  for (const [path, created] of previousCreated) {
    const name = basename(path);
    const known = previousByName.get(name);
    previousByName.set(name, known === undefined || known === created ? created : null);
  }
  const carriedCreated = (doc: CorpusDocRecord): string | undefined => {
    if (!doc.archived) return undefined;
    return previousByName.get(basename(doc.path)) ?? undefined;
  };
  const unresolved = docs.filter(
    (doc) => !previousCreated.has(doc.path) && carriedCreated(doc) === undefined,
  );
  // A single unresolved path keeps the direct `--follow` lookup — one spawn
  // either way, and `--follow` dates a renamed doc where the batch cannot.
  const batchDates =
    unresolved.length > 1
      ? gitFirstCommitDates(repoRoot, unresolved.map((doc) => doc.path), exec)
      : new Map<string, string>();
  const entries = docs.map((doc): CorpusIndexEntry => {
    const created =
      previousCreated.get(doc.path) ??
      carriedCreated(doc) ??
      batchDates.get(doc.path) ??
      gitFirstCommitDate(repoRoot, doc.path, exec) ??
      passTimestamp;
    return { ...doc, created, indexed: passTimestamp };
  });
  return { indexedAt: passTimestamp, entries };
}
