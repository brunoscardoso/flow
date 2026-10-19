/**
 * How many of a checkout's changes would be LOST if the checkout went away.
 *
 * THE SAME QUESTION THE CLI ASKS BEFORE IT DELETES ONE (`losableWork` /
 * `isProvidedIn`, src/cli/loop/worktree.ts), asked here for every surface that
 * reports it to a person: the Storage page, the cap's "has it landed?", the
 * re-cut guard and the delete refusal.
 *
 * Every thread checkout has the project's untracked set put into it — `flow`,
 * `.claude` and `node_modules` LINKED, `.env*` COPIED — and a repository that
 * does not gitignore those exact names reports each one as `??`. Counted as
 * work, they made every checkout "hold work": the Storage page offered to free
 * nothing, the cap could never release a landed copy, and the delete question
 * told a person that two files had changes they never committed when one of
 * them was a link to their own `.claude`. A link destroys nothing when it is
 * deleted, and a copy still byte-identical to the project's has its twin there.
 *
 * An EDITED copy is losable and stays counted — that is the reason `.env` is
 * copied rather than linked in the first place.
 */
import { lstat, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The largest copy compared byte for byte. The untracked set is `.env*` —
 * a few hundred bytes. Anything bigger is not one of the copies a checkout is
 * given, and reading two of them into memory per row of a list somebody just
 * opened is how a main process stops answering (allowed-pattern #19). Above
 * the cap a file counts as work: unknown is never "safe to delete".
 */
export const MAX_COMPARED_BYTES = 1024 * 1024

/** The filesystem reads this needs — injected so tests create nothing on disk. */
export interface LosableWorkFs {
  isSymlink(path: string): Promise<boolean>
  /** The size of a regular file in bytes, or null when it is not one (or unreadable). */
  size(path: string): Promise<number | null>
  /** The file's text, or null when it is not a readable regular file. */
  readText(path: string): Promise<string | null>
}

const nodeFs: LosableWorkFs = {
  isSymlink: async (path) => (await lstat(path)).isSymbolicLink(),
  size: async (path) => {
    try {
      const info = await stat(path)
      return info.isFile() ? info.size : null
    } catch {
      return null
    }
  },
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch {
      return null
    }
  },
}

/** Whether one porcelain line names something the project's own tree still has. */
async function providedByProject(
  line: string,
  checkoutPath: string,
  projectRoot: string | null,
  fs: LosableWorkFs,
): Promise<boolean> {
  if (!line.startsWith('??')) return false
  // `?? node_modules/` — a directory entry carries a trailing slash; the entry
  // itself is what to look at.
  const name = line.slice(2).trim().replace(/\/$/, '')
  if (name === '') return false
  try {
    if (await fs.isSymlink(join(checkoutPath, name))) return true
  } catch {
    return false
  }
  if (projectRoot === null) return false
  // SIZES FIRST: two files of different sizes are not identical, and a size is
  // one stat rather than two whole reads.
  const [hereSize, thereSize] = await Promise.all([
    fs.size(join(checkoutPath, name)),
    fs.size(join(projectRoot, name)),
  ])
  if (hereSize === null || thereSize === null || hereSize !== thereSize) return false
  if (hereSize > MAX_COMPARED_BYTES) return false
  const here = await fs.readText(join(checkoutPath, name))
  if (here === null) return false
  const there = await fs.readText(join(projectRoot, name))
  return there !== null && there === here
}

/**
 * The `git status --porcelain` lines that hold work existing nowhere else.
 * `projectRoot` enables the identical-copy rule; without it only links are
 * set aside.
 */
export async function losableChanges(
  porcelain: string,
  checkoutPath: string,
  projectRoot: string | null,
  fs: LosableWorkFs = nodeFs,
): Promise<string[]> {
  const kept: string[] = []
  for (const line of porcelain.split('\n')) {
    if (line.trim() === '') continue
    if (await providedByProject(line, checkoutPath, projectRoot, fs)) continue
    kept.push(line)
  }
  return kept
}

/** {@link losableChanges}, counted. */
export async function countLosableChanges(
  porcelain: string,
  checkoutPath: string,
  projectRoot: string | null,
  fs: LosableWorkFs = nodeFs,
): Promise<number> {
  return (await losableChanges(porcelain, checkoutPath, projectRoot, fs)).length
}
