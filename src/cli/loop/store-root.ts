/**
 * The shared repository root a loop STORE resolves against (#loop-ledger-shared-root).
 *
 * The ledger under `flow/loops/**` was built from the caller's cwd, so a
 * `loop file` run from a thread/loop worktree wrote to that worktree's OWN copy
 * — one uncommitted fork per worktree — while the board reads the main checkout
 * and never saw them. Every store must instead resolve against the ONE main
 * worktree, so a filing from any checkout lands where the board reads.
 *
 * FROM THE FILESYSTEM, NOT A SUBPROCESS. `git rev-parse --git-common-dir` would
 * answer this, but this runs deep inside `flowDirOf`, which a single verb calls
 * many times, and the loop CLI is unit-tested with `node:child_process` mocked —
 * shelling `git worktree list` here would both cost a process per store read and
 * consume the exec calls those tests count. Git already records the answer on
 * disk: a linked worktree's `.git` is a FILE naming the common dir, so reading
 * it is O(1), needs no git on PATH, and touches no mock.
 *
 * FAIL-SOFT. Anything unexpected — no `.git`, an unreadable file, a shape git
 * has never written — degrades to the given target, i.e. exactly today's
 * behaviour. A machine mid-`git init`, or one with no git at all, still reads
 * its own local queue rather than crashing.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

/** Cached per process, keyed by the raw target — one resolution per checkout. */
const cache = new Map<string, string>();

/**
 * The main worktree for `target`, or `target` itself when it already is one (or
 * when nothing on disk says otherwise). `target` is a checkout root — the value
 * a run's `--target`/cwd carries — so its `.git` is where git records the link.
 */
export function canonicalStoreRoot(target: string): string {
  const cached = cache.get(target);
  if (cached !== undefined) return cached;
  const resolved = resolveCanonicalStoreRoot(target);
  cache.set(target, resolved);
  return resolved;
}

/** For tests: clear the per-process memo so a rebuilt fixture is re-read. */
export function clearStoreRootCache(): void {
  cache.clear();
}

function resolveCanonicalStoreRoot(target: string): string {
  try {
    const dotGit = join(target, '.git');
    const stat = statSync(dotGit);
    // A directory `.git` is a main worktree or a standalone repo — it IS the root.
    if (stat.isDirectory()) return target;
    // A file `.git` is a linked worktree: `gitdir: <main>/.git/worktrees/<name>`.
    if (stat.isFile()) {
      const main = mainRootFromGitdirFile(readFileSync(dotGit, 'utf-8'), target);
      return main ?? target;
    }
  } catch {
    // Fail-soft: no `.git`, unreadable, or not a checkout root — behave as before.
  }
  return target;
}

/**
 * Parse a linked worktree's `.git` file to the main worktree path.
 *
 * git writes `gitdir: <common>/.git/worktrees/<name>` (forward slashes, even on
 * Windows). The main worktree is the parent of the common `.git`, so the answer
 * is the segment before `/.git/worktrees/`. Exported for direct unit coverage of
 * the shapes git can write; `gitdir` may be relative to the worktree, so a
 * relative one is resolved against `target`.
 */
/**
 * Is this path absolute on the platform that WROTE it, not the one reading it?
 *
 * `node:path`'s `isAbsolute` answers for the host, so on macOS a Windows path
 * (`C:\\Users\\dev\\...`) reads as RELATIVE and gets resolved against the
 * target — producing `/Users/me/project/C:/Users/dev/...`, a path that is not
 * anything. This function's whole stated job is to be separator-agnostic, and
 * it was normalising separators AFTER deciding absoluteness, which is the one
 * order in which that promise cannot hold.
 *
 * In practice a `.git` file is written by the git that runs on the machine
 * reading it, so the host and the writer agree and this changes nothing. It
 * matters where the two can differ — a fixture, a copied checkout, a path
 * carried across platforms — and those are exactly the cases where being wrong
 * is silent.
 */
function isAbsoluteOnAnyPlatform(candidate: string): boolean {
  if (isAbsolute(candidate)) return true;
  // A drive letter: `C:\...` or `C:/...`
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true;
  // A UNC share: `\\\\server\\share`
  if (/^\\\\[^\\]/.test(candidate)) return true;
  return false;
}

export function mainRootFromGitdirFile(content: string, target: string): string | null {
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (match === null) return null;
  const rawGitdir = match[1].trim();
  const gitdir = isAbsoluteOnAnyPlatform(rawGitdir) ? rawGitdir : resolve(target, rawGitdir);
  // Split on the worktrees marker in a separator-agnostic way.
  const normalized = gitdir.replace(/\\/g, '/');
  const marker = '/.git/worktrees/';
  const at = normalized.indexOf(marker);
  if (at === -1) {
    // A `.git` file that is not a worktree link (e.g. a separate git dir): the
    // common dir's parent is the closest we can honestly claim as the root.
    return null;
  }
  // `<main>` is the text before the marker — normalise it back to a native path.
  return resolve(normalized.slice(0, at));
}
