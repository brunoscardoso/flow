/**
 * READ ONE FILE A SHARE MAY SEND — and refuse anything that is not exactly one
 * regular file, in exactly the directory its name says, on every platform.
 *
 * The lexical gate in the client says which NAME may be read; it cannot say
 * what that name points at. A cloned repo, or an agent, can make the
 * walkthrough a symlink to a private key, a hard link to one, a named pipe that
 * hangs main forever on `open`, or put the whole `flow/discovery` directory
 * somewhere else. Each of those is refused here, BEFORE a byte is read:
 *
 *  1. CONTAINMENT (review R2-L9). `realpath(dirname(file))` must equal
 *     `realpath(<root>/flow)/<discovery|archive>`. A symlinked `flow/` is
 *     allowed (the central vault does exactly that); a symlinked
 *     `flow/discovery` or `flow/archive` is not.
 *  2. LSTAT FIRST (review R2-M5, R2-M6). The final component must be a regular
 *     file — never a symlink, FIFO, socket, device or directory. This is the
 *     check that holds on Windows, where `O_NOFOLLOW` does not exist, and the
 *     one that keeps a FIFO from ever reaching `open`.
 *  3. OPEN `O_RDONLY | O_NOFOLLOW? | O_NONBLOCK?`. Both extra flags are used
 *     where the platform has them, as a second guard; their absence is what
 *     step 2 and step 4 exist for.
 *  4. FSTAT THE SAME HANDLE. Still a regular file, the SAME inode and device
 *     lstat saw (nothing was swapped between the two), and exactly one link (a
 *     second name for the same inode can be planted just as a symlink can).
 *  5. SIZE BEFORE BYTES (review R2-L10). Over the cap → "too large", nothing
 *     read. Otherwise read at most cap + 1 bytes, so a file that grows after
 *     fstat is still caught.
 *
 * Errors carry a `code` and no path: the caller logs the code only.
 */
import { constants as fsConstants, promises as fsPromises, type Stats } from 'fs'
import { basename, dirname, join } from 'path'

/** One file read through a guarded handle. `content` is null when it was over the cap. */
export interface GuardedFileRead {
  /** The exact bytes, or null when the file is larger than the cap (nothing was read). */
  content: Buffer | null
  /** Bytes on disk (at least cap + 1 when over it). */
  size: number
  /** The handle's own mtime — the same file the bytes came from. */
  mtimeMs: number
}

/** Where a share file must live, and how much of it may be read. */
export interface ShareFileGuard {
  /** `<root>/flow` — may itself be a symlink. */
  flowDir: string
  /** The real directory inside the resolved `flow` the file must sit directly in. */
  subdir: 'discovery' | 'archive'
  /** The most bytes that are read; anything larger is reported, not read. */
  maxBytes: number
}

export type NotARegularFileWhy =
  | 'symlink'
  | 'not-a-file'
  | 'hard-linked'
  | 'swapped'
  | 'outside'

/** Thrown when the path names anything but one regular file in its own directory. */
export class NotARegularFileError extends Error {
  readonly code: string
  constructor(readonly why: NotARegularFileWhy) {
    super(`not a regular file (${why})`)
    this.name = 'NotARegularFileError'
    this.code = `ESHARE_${why.toUpperCase().replace(/-/g, '_')}`
  }
}

/** The filesystem the guard reads through — injectable so a test can take a flag away. */
export interface GuardFs {
  lstat(path: string): Promise<Stats>
  realpath(path: string): Promise<string>
  open(path: string, flags: number): Promise<fsPromises.FileHandle>
  /** `fs.constants` — `O_NOFOLLOW` / `O_NONBLOCK` are undefined on Windows. */
  constants: { O_RDONLY: number; O_NOFOLLOW?: number; O_NONBLOCK?: number }
}

const NODE_FS: GuardFs = {
  lstat: (path) => fsPromises.lstat(path),
  realpath: (path) => fsPromises.realpath(path),
  open: (path, flags) => fsPromises.open(path, flags),
  constants: fsConstants,
}

/** The open flags: read-only, plus no-follow and non-blocking wherever they exist. */
export function guardedOpenFlags(constants: GuardFs['constants']): number {
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
}

export async function readGuardedFile(
  absPath: string,
  guard: ShareFileGuard,
  fs: GuardFs = NODE_FS,
): Promise<GuardedFileRead> {
  // 1. Containment: the file's real directory is the real discovery/archive
  //    directory inside the resolved flow/ — never somewhere a link points.
  const realFlow = await fs.realpath(guard.flowDir)
  const realParent = await fs.realpath(dirname(absPath))
  if (realParent !== join(realFlow, guard.subdir) || basename(absPath) === '') {
    throw new NotARegularFileError('outside')
  }

  // 2. What the name is, without following it. A FIFO stops here, unopened.
  const named = await fs.lstat(absPath)
  if (named.isSymbolicLink()) throw new NotARegularFileError('symlink')
  if (!named.isFile()) throw new NotARegularFileError('not-a-file')

  // 3. Open without following, without blocking — where the platform can.
  let handle: fsPromises.FileHandle
  try {
    handle = await fs.open(absPath, guardedOpenFlags(fs.constants))
  } catch (error) {
    // ELOOP (Linux/macOS) / EMLINK (FreeBSD): swapped for a symlink after lstat.
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ELOOP' || code === 'EMLINK') throw new NotARegularFileError('symlink')
    throw error
  }
  try {
    // 4. The handle is the file lstat saw, and only that file.
    const opened = await handle.stat()
    if (!opened.isFile()) throw new NotARegularFileError('not-a-file')
    if (opened.ino !== named.ino || opened.dev !== named.dev) throw new NotARegularFileError('swapped')
    if (opened.nlink !== 1) throw new NotARegularFileError('hard-linked')

    // 5. Size before bytes.
    if (opened.size > guard.maxBytes) return { content: null, size: opened.size, mtimeMs: opened.mtimeMs }
    // Room for one byte more than fstat said (or than the cap): filling it
    // means the file grew after fstat.
    const capacity = Math.min(opened.size, guard.maxBytes) + 1
    const buffer = Buffer.alloc(capacity)
    let total = 0
    while (total < capacity) {
      const { bytesRead } = await handle.read(buffer, total, capacity - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > guard.maxBytes) return { content: null, size: total, mtimeMs: opened.mtimeMs }
    // Grew while being read, still under the cap: what was read is not the file.
    if (total > opened.size) throw new NotARegularFileError('swapped')
    return { content: buffer.subarray(0, total), size: total, mtimeMs: opened.mtimeMs }
  } finally {
    await handle.close()
  }
}

/** The error's code for a log line — never its message, which carries a path. */
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code !== '') return code
  return error instanceof Error ? error.name : typeof error
}
