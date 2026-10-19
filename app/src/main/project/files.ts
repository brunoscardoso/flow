// Project file IO — main-process handlers for the contract's
// project:readFile / project:writeFile channels.
//
// Registered separately from the central IPC registry (src/main/ipc/index.ts)
// so the project domain owns its file semantics:
//   - UTF-8 only, with binary sniffing on read (NUL byte in the head)
//   - ~10MB size guard in both directions with a clear error message
//   - atomic saves: write to a temp file in the same directory, then rename,
//     so a crash mid-write can never truncate the target file
//   - path containment: relPath is untrusted renderer input and must resolve
//     inside an ADDRESSABLE root — see addressable-roots.ts, which owns that
//     one question for this module, the file tree and the git write channels
//
// The coordinator wires this after boot: registerFileChannels({ roots }).

import { randomBytes } from 'crypto'
import { timed } from '../ipc/slow-handler'
import { promises as fsPromises, type Dirent } from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { ipcMain, shell } from 'electron'

import type {
  FileContent,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import { realPathStaysInsideRoot } from './paths'
import type { AddressableRoots } from './addressable-roots'
// NOTE: circular by design — content-search.ts reuses this module's guards
// (SEARCH_IGNORED_DIRS, makeFsDirReader, looksBinary, …). Every cross-reference
// is read at call time, never at module init, so the cycle is safe.
import { searchProjectContent } from './content-search'

/** Refuse to read or write files beyond this size — the editor is a code
 *  surface, not a large-asset viewer. */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024
/** Bytes sniffed for a NUL byte when classifying a file as binary. */
const BINARY_SNIFF_BYTES = 8192
/** U+FEFF — the UTF-8 BOM, as decoded text (`EF BB BF` on disk) (#1147).
 *  Written as an escape on purpose: the literal character is invisible.
 *  Exported so the content-search reader strips it identically. */
export const UTF8_BOM ='\ufeff'

export interface FileChannelDependencies {
  /** The address gate — which roots the renderer may read and write through.
   *  Registered project roots plus every thread's own checkout. */
  roots: AddressableRoots
}

/**
 * Register the file read/write invoke handlers. Returns a dispose function
 * that unregisters them (mirrors registerIpcHandlers' contract).
 */
export function registerFileChannels(deps: FileChannelDependencies): () => void {
  const { roots } = deps
  const registered: IpcInvokeChannel[] = []

  /** Contract-typed ipcMain.handle — compile error on channel/shape drift. */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  handle('project:readFile', ({ rootPath, relPath, missingOk }) =>
    readProjectFile(roots, rootPath, relPath, MAX_FILE_SIZE_BYTES, { missingOk: missingOk === true }),
  )
  handle('project:writeFile', async ({ rootPath, relPath, content }) => {
    await writeProjectFile(roots, rootPath, relPath, content)
  })
  handle('project:resolveFileRef', async ({ rootPath, ref }) => ({
    relPath: await resolveProjectFileRef(roots, rootPath, ref),
  }))
  handle('project:renamePath', async ({ rootPath, relPath, newRelPath }) => {
    await renameProjectPath(roots, rootPath, relPath, newRelPath)
  })
  handle('project:deletePath', async ({ rootPath, relPath }) => {
    await deleteProjectPath(roots, rootPath, relPath)
  })
  handle('project:createPath', async ({ rootPath, relPath, kind }) => {
    await createProjectPath(roots, rootPath, relPath, kind)
  })
  // #1063: reveal in the OS file manager. Resolved + root-contained through the
  // SAME guard every other file channel uses — the renderer never hands main an
  // absolute path, so this can't be steered outside the project.
  handle('project:revealPath', async ({ rootPath, relPath }) => {
    const absolute = await resolveInsideRoot(roots, rootPath, relPath)
    shell.showItemInFolder(absolute)
  })
  // THE SAME GATE, ENUMERATED — beside the guard rather than anywhere else, so
  // the list a renderer maps against and the list this channel accepts are read
  // from one object. A surface holding an absolute path asks this to find the
  // root containing it; asking `project:list` gets the PROJECT list, which
  // contains no thread checkout — and mapping against it is why Reveal in
  // Finder silently did nothing for every file in a thread's own worktree.
  handle('project:addressableRoots', () => [...roots.addressablePaths()])
  handle('project:listAllFiles', ({ rootPath, limit }) =>
    listAllProjectFiles(roots, rootPath, limit),
  )
  handle('project:searchContent', ({ rootPath, query, caseSensitive, maxResults, maxPerFile }) =>
    searchProjectContent(roots, rootPath, { query, caseSensitive, maxResults, maxPerFile }),
  )

  return function disposeFileChannels(): void {
    for (const channel of registered) {
      ipcMain.removeHandler(channel)
    }
    registered.length = 0
  }
}

// plan-flow artifact dirs, searched first for a bare-name reference (the common
// case: the agent mentions `brainstorm_*.md` / `plan_*.md` created under flow/).
const FLOW_ARTIFACT_SUBDIRS = [
  'flow/brainstorms',
  'flow/discovery',
  'flow/plans',
  'flow/contracts',
  'flow/reviewed-code',
  'flow/reviewed-pr',
  'flow/resources',
  'flow/references',
  'flow/archive',
  'flow',
]
/** Dirs skipped by the recursive fallback — heavy/irrelevant to file refs.
 *  Exported so the content-search walk reuses the exact same ignore set
 *  (allowed-pattern #14 — one code path for the invariant). */
export const SEARCH_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.cache',
  'coverage',
  '.turbo',
  'vendor',
  '.venv',
  // Generated or vendored caches that happen to begin with a dot. They are
  // named ONE BY ONE on purpose — see `skipDirDuringWalk`, which no longer
  // skips a directory merely for starting with one.
  '.pnpm-store',
  '.yarn',
  '.parcel-cache',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
  '.terraform',
  '.svelte-kit',
  '.nuxt',
  '.output',
  '.astro',
  '.vercel',
  '.netlify',
  '.expo',
  '.dart_tool',
])

/**
 * Should a walk skip this directory?
 *
 * ONE RULE, THREE WALKS — the basename search, the symlink branch beside it,
 * and the file picker's listing all asked this separately, and all three
 * answered "skip anything starting with a dot".
 *
 * That blanket was the bug. Every dot-directory a PERSON keeps was swept up
 * with the caches: `.github`, `.claude`, `.vscode`, `.husky`. A project whose
 * documentation lives in `.github/instructions/` had every chat link to it
 * answer "File not found", and none of those files ever appeared in the file
 * picker either. The heavy dot-directories were already named in the set above,
 * so the blanket bought nothing and cost the rest.
 *
 * Anything genuinely not worth walking gets a NAME in `SEARCH_IGNORED_DIRS`. A
 * rule keyed on the shape of a name rather than on what the directory is will
 * always swallow something somebody meant to keep.
 */
export function skipDirDuringWalk(name: string, ignored: ReadonlySet<string> = SEARCH_IGNORED_DIRS): boolean {
  return ignored.has(name)
}
const MAX_SEARCH_DIRS = 4000

/**
 * Resolve a raw file reference from chat (a bare filename or a partial/relative
 * path) to a real root-relative path. Tries, in order: the ref as given under
 * the root; the plan-flow flow/ artifact dirs by basename; a bounded recursive
 * search by basename. Returns null when nothing matches — the caller notifies
 * rather than opening a phantom path. Never resolves outside the root.
 */
export async function resolveProjectFileRef(
  roots: AddressableRoots,
  rootPath: string,
  ref: string,
): Promise<string | null> {
  const absoluteRoot = resolve(rootPath)
  if (!roots.isAddressable(absoluteRoot)) return null

  const cleaned = ref.trim().replace(/^\.\/+/, '')
  if (!cleaned) return null

  // As given: an in-root relative path, or an absolute path under the root.
  const asGiven = isAbsolute(cleaned) ? relative(absoluteRoot, cleaned) : cleaned
  if (asGiven && !asGiven.startsWith('..') && !isAbsolute(asGiven)) {
    if (await isReadableFile(join(absoluteRoot, asGiven))) return toPosix(asGiven)
  }

  const base = basename(cleaned)
  if (!base || base === '..') return null

  // flow/ artifact dirs first (fast, exact for the common plan-flow case).
  for (const dir of FLOW_ARTIFACT_SUBDIRS) {
    const candidate = join(absoluteRoot, dir, base)
    if (await isReadableFile(candidate)) return toPosix(join(dir, base))
  }

  // Bounded breadth-first search of the tree by basename.
  return searchByBasename(absoluteRoot, base, roots.ownerCheckoutFor(absoluteRoot))
}

/**
 * Breadth-first search for a bare filename, bounded by MAX_SEARCH_DIRS.
 *
 * IT FOLLOWS A TRUSTED SYMLINKED DIRECTORY, and it has to: `plan-flow init`
 * puts a project's `flow/` behind a symlink to the vault, and `Dirent.isDirectory()`
 * is FALSE for a symlink. So the walk used to stop dead at the door of the one
 * directory whose contents a chat message is most likely to name — an agent
 * writes `flow/design-system/design-system.html`, links to it, and the click
 * answered "File not found" for a file that was there all along. The fixed
 * artifact list above hides this for `flow/plans` and its siblings, because
 * opening a path THROUGH a symlink works; only the walk, which has to decide
 * whether to descend, ever sees the difference.
 *
 * WHICH LINKS ARE FOLLOWED IS NOT THIS FUNCTION'S RULE. `realPathStaysInsideRoot`
 * already owns it — inside the root, inside a worktree's owner checkout, or
 * under a `flow/` link that genuinely resolves into the vault, with the
 * DESTINATION validated rather than the mutable link (#94). Asking it here
 * keeps one containment rule (allowed-pattern #14) instead of a second one that
 * agrees until the day it does not.
 */
async function searchByBasename(
  absoluteRoot: string,
  base: string,
  ownerCheckout: string | null,
): Promise<string | null> {
  const queue: string[] = ['']
  let scanned = 0
  // Real paths already walked. A link pointing at an ancestor would otherwise
  // spend the whole budget going round it — bounded, but bounded is not the
  // same as finished, and the file would be missed for a reason nobody could see.
  const seen = new Set<string>()
  while (queue.length > 0 && scanned < MAX_SEARCH_DIRS) {
    const relDir = queue.shift() as string
    scanned += 1
    const dirPath = join(absoluteRoot, relDir)
    const realDir = await realPathOrSelf(dirPath)
    if (seen.has(realDir)) continue
    seen.add(realDir)
    let entries: Dirent[]
    try {
      entries = await fsPromises.readdir(dirPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirDuringWalk(entry.name)) continue
        queue.push(join(relDir, entry.name))
      } else if (entry.isSymbolicLink()) {
        // The same ignore list applies to a link: a linked-in `node_modules` is
        // no cheaper to walk than a real one.
        if (skipDirDuringWalk(entry.name)) continue
        const linked = join(relDir, entry.name)
        if (await isTrustedDirLink(absoluteRoot, linked, ownerCheckout)) queue.push(linked)
      } else if (entry.isFile() && entry.name === base) {
        return toPosix(join(relDir, base))
      }
    }
  }
  return null
}

/** realpath(dir), or the path itself when it cannot be resolved — the loop
 *  guard must never drop a directory just because realpath failed. */
async function realPathOrSelf(path: string): Promise<string> {
  try {
    return await fsPromises.realpath(path)
  } catch {
    return path
  }
}

/** A symlink worth descending into: it points at a directory, and the shared
 *  containment rule allows that destination. */
async function isTrustedDirLink(
  absoluteRoot: string,
  relPath: string,
  ownerCheckout: string | null,
): Promise<boolean> {
  const target = join(absoluteRoot, relPath)
  try {
    if (!(await fsPromises.stat(target)).isDirectory()) return false
  } catch {
    // A broken link is not a directory and is not an error worth reporting: the
    // walk simply has nothing to descend into.
    return false
  }
  return realPathStaysInsideRoot(absoluteRoot, target, ownerCheckout)
}

async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(path)).isFile()
  } catch {
    return false
  }
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

// ── Flat file list (command palette source) ──────────────────────────────────

/** Default hard cap on the flat file list — the walk stops once this many files
 *  are collected and reports `truncated: true`. */
export const DEFAULT_LIST_ALL_FILES_LIMIT = 20000
/** Depth guard so a pathological/symlinked tree can't make the walk unbounded.
 *  Exported so the content-search walk shares the same depth bound. */
export const MAX_LIST_ALL_FILES_DEPTH = 32

/** One directory entry, reduced to what {@link collectFiles} needs. */
export interface DirReadEntry {
  name: string
  isDirectory: boolean
}

/** Reads one directory's entries given a repo-relative POSIX dir path (''=root).
 *  May reject — {@link collectFiles} treats a rejection as an unreadable dir and
 *  skips it (fail-soft). */
export type DirReader = (relDir: string) => Promise<DirReadEntry[]>

export interface CollectFilesOptions {
  /** Directory basenames to skip entirely (never descended into). */
  ignoredDirs: ReadonlySet<string>
  /** Hard cap on collected files; the walk stops and sets `truncated` at it. */
  limit: number
  /** Max directory depth to descend (root entries are depth 1). */
  maxDepth?: number
}

export interface CollectFilesResult {
  /** Repo-relative POSIX paths, sorted deterministically. */
  relPaths: string[]
  /** True when the `limit` cap was hit and the list is incomplete. */
  truncated: boolean
}

/**
 * PURE, fs-injected breadth-first file walk. Given a directory reader, an
 * ignored-dir set, and a hard cap, returns a bounded flat list of repo-relative
 * POSIX file paths plus a `truncated` flag. Skips ignored + dotfile directories,
 * honors the depth guard, and is fail-soft (a reader rejection skips that dir).
 * Traversal order is deterministic (entries sorted per directory) so the capped
 * subset is stable; the final list is sorted lexicographically. No fs, no clock
 * — trivially unit-testable with a fake reader.
 */
export async function collectFiles(
  read: DirReader,
  options: CollectFilesOptions,
): Promise<CollectFilesResult> {
  const { ignoredDirs, limit } = options
  const maxDepth = options.maxDepth ?? MAX_LIST_ALL_FILES_DEPTH
  const relPaths: string[] = []
  let truncated = false

  const queue: Array<{ relDir: string; depth: number }> = [{ relDir: '', depth: 0 }]
  walk: while (queue.length > 0) {
    const { relDir, depth } = queue.shift() as { relDir: string; depth: number }
    let entries: DirReadEntry[]
    try {
      entries = await read(relDir)
    } catch {
      continue // unreadable dir — skip, never throw
    }
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of sorted) {
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory) {
        if (skipDirDuringWalk(entry.name, ignoredDirs)) continue
        if (depth + 1 <= maxDepth) queue.push({ relDir: childRel, depth: depth + 1 })
      } else {
        if (relPaths.length >= limit) {
          truncated = true
          break walk
        }
        relPaths.push(childRel)
      }
    }
  }

  relPaths.sort((a, b) => a.localeCompare(b))
  return { relPaths, truncated }
}

/** fs-backed {@link DirReader} rooted at an absolute path. Classifies only real
 *  files/dirs (symlinks/other node types are skipped, matching the basename
 *  search above). Exported so the content-search walk reuses the same reader —
 *  symlink skipping is what keeps the walk contained to real files under the
 *  root. */
export function makeFsDirReader(absoluteRoot: string): DirReader {
  return async (relDir: string): Promise<DirReadEntry[]> => {
    const dirents = await fsPromises.readdir(join(absoluteRoot, relDir), { withFileTypes: true })
    const out: DirReadEntry[] = []
    for (const dirent of dirents) {
      if (dirent.isDirectory()) out.push({ name: dirent.name, isDirectory: true })
      else if (dirent.isFile()) out.push({ name: dirent.name, isDirectory: false })
    }
    return out
  }
}

/** Clamp a caller-supplied `limit` into `[1, DEFAULT_LIST_ALL_FILES_LIMIT]`;
 *  absent/invalid falls back to the default hard cap. */
function normalizeListAllLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIST_ALL_FILES_LIMIT
  }
  return Math.min(Math.floor(limit), DEFAULT_LIST_ALL_FILES_LIMIT)
}

/**
 * The last walk of each root, and when it was taken.
 *
 * THE COMMAND PALETTE WALKS THE REPO PER KEYSTROKE. `fileCandidates` asks for
 * this list on every character typed, and each ask was a fresh recursive
 * readdir on the MAIN process — measured on this repo at 45 ms cold and 10-12 ms
 * warm for 2,693 files, plus ~100 KB of paths across IPC, every keystroke. On a
 * bigger checkout that is the lag a reader feels while typing, and it is main,
 * so it is felt everywhere at once.
 *
 * A SHORT TTL, NOT AN INVALIDATION SUBSCRIPTION. A file list is allowed to be a
 * few seconds stale — a file created while the palette is open appears on the
 * next walk, which is the same guarantee the walk itself gave (it races
 * whatever the filesystem does mid-traversal). Wiring this to the watcher would
 * buy exactness this surface has never had, at the cost of a cache that outlives
 * its truth if a single event is missed.
 */
const listAllCache = new Map<string, { at: number; limit: number; result: CollectFilesResult }>()

/** How long a flat file list stays good. One palette session's worth. */
const LIST_ALL_TTL_MS = 5_000

/** Drop a root's cached walk — called when a root is removed. */
export function forgetListAllCache(rootPath?: string): void {
  if (rootPath === undefined) listAllCache.clear()
  else listAllCache.delete(resolve(rootPath))
}

/**
 * Exported for tests — the IPC layer calls this via project:listAllFiles.
 * Bounded, ignore-aware flat file list for an ADDRESSABLE root. Reuses
 * SEARCH_IGNORED_DIRS + dotfile-dir skipping, caps at `limit` (default 20000),
 * and returns repo-relative POSIX paths. Fail-soft on unreadable dirs; throws
 * only for an unknown root (renderer input is untrusted).
 *
 * Cached for `LIST_ALL_TTL_MS` per root — see `listAllCache` for why.
 */
export async function listAllProjectFiles(
  roots: AddressableRoots,
  rootPath: string,
  limit?: number,
  now: () => number = Date.now,
): Promise<CollectFilesResult> {
  const absoluteRoot = resolve(rootPath)
  if (!roots.isAddressable(absoluteRoot)) {
    throw new Error(`[Project] Unknown root: ${rootPath}`)
  }
  const normalized = normalizeListAllLimit(limit)
  const cached = listAllCache.get(absoluteRoot)
  // The LIMIT is part of the key, not just the root: a caller asking for more
  // than a cached walk collected would be handed a truncated answer as if it
  // were complete.
  if (cached !== undefined && cached.limit >= normalized && now() - cached.at < LIST_ALL_TTL_MS) {
    return cached.result
  }
  const result = await collectFiles(makeFsDirReader(absoluteRoot), {
    ignoredDirs: SEARCH_IGNORED_DIRS,
    limit: normalized,
    maxDepth: MAX_LIST_ALL_FILES_DEPTH,
  })
  listAllCache.set(absoluteRoot, { at: now(), limit: normalized, result })
  return result
}

// ── Handlers ───────────────────────────────────────────────────────────────

/** Exported for tests — the IPC layer calls this via project:readFile. */
export async function readProjectFile(
  roots: AddressableRoots,
  rootPath: string,
  relPath: string,
  maxBytes: number = MAX_FILE_SIZE_BYTES,
  options: { missingOk?: boolean } = {},
): Promise<FileContent> {
  const targetPath = await resolveInsideRoot(roots, rootPath, relPath)

  let stats: Awaited<ReturnType<typeof fsPromises.stat>>
  try {
    stats = await fsPromises.stat(targetPath)
  } catch (error) {
    // An EXPECTED absence is an answer, not a failure: thrown, it reaches the
    // main process log as "Error occurred in handler for 'project:readFile'"
    // for every plan card re-read while a document (or the `flow` link it
    // lives under) is momentarily not there.
    const code = (error as { code?: unknown }).code
    if (options.missingOk === true && (code === 'ENOENT' || code === 'ENOTDIR')) {
      return { relPath, content: '', binary: true, missing: true }
    }
    throw error
  }
  if (!stats.isFile()) {
    throw new Error(`[Project] Not a file: ${relPath}`)
  }
  if (stats.size > maxBytes) {
    // Opening an over-limit file (e.g. a derived 12MB .brain.sqlite) is a normal
    // user click, not an error — return the same read-only placeholder state as
    // a binary file so the editor shows "too large" instead of throwing an
    // unhandled IPC error. Never read the oversized buffer into memory.
    return { relPath, content: '', binary: true, tooLarge: true }
  }

  const buffer = await fsPromises.readFile(targetPath)
  if (looksBinary(buffer)) {
    return { relPath, content: '', binary: true }
  }
  // #1147: a UTF-8 BOM is a property of the FILE, not of its text. Strip it
  // from the content the editor sees (Monaco strips it internally anyway, and a
  // stray U+FEFF is noise in diffs/search) and report it as a flag; the save
  // path restores it from the file's own bytes.
  const decoded = buffer.toString('utf8')
  if (decoded.startsWith(UTF8_BOM)) {
    return { relPath, content: decoded.slice(UTF8_BOM.length), binary: false, hasBom: true }
  }
  return { relPath, content: decoded, binary: false }
}

/** Exported for tests — the IPC layer calls this via project:writeFile. */
export async function writeProjectFile(
  roots: AddressableRoots,
  rootPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  const targetPath = await resolveInsideRoot(roots, rootPath, relPath)

  // #1147: restore the file's UTF-8 BOM. readProjectFile strips it and Monaco
  // never re-emits it, so without this the first save of a BOM'd file rewrites
  // byte 0 — invisible in the editor, invisible in Flow's own (content-based)
  // diff, and visible only in `git diff`/`xxd`, or in a downstream tool that
  // suddenly stops recognizing the file. Read from the EXISTING file rather
  // than from a renderer-carried flag, exactly like the mode preservation
  // below (#159): a property of the original file, restored across the atomic
  // replace. A file without a BOM never gains one, and a first write has
  // nothing to restore.
  const keepBom = await existingFileHasBom(targetPath)
  const finalContent = keepBom && !content.startsWith(UTF8_BOM) ? UTF8_BOM + content : content

  const byteSize = Buffer.byteLength(finalContent, 'utf8')
  if (byteSize > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `[Project] Refusing to write ${relPath}: content is ${formatSize(byteSize)} ` +
        `(limit ${formatSize(MAX_FILE_SIZE_BYTES)})`,
    )
  }

  // #1146: write THROUGH a symlink, not over it. The atomic replace below
  // renames onto the target path, and renaming onto a symlink replaces the LINK
  // — destroying it, leaving a detached regular file, and leaving the file the
  // user actually opened unchanged. Both harms were silent: the tab's dirty dot
  // cleared and git showed an unasked-for `T` typechange.
  //
  // Resolving first is safe by construction: resolveInsideRoot has already
  // refused any path whose REAL target escapes the project folder (#94), so a
  // link pointing outside has thrown above rather than being followed here. A
  // path that doesn't exist yet (first write) has no realpath — it stays as-is.
  const writePath = await fsPromises.realpath(targetPath).catch(() => targetPath)

  // Atomic save: temp file beside the target (same filesystem → rename is
  // atomic), then rename over the original.
  const tempPath = join(
    dirname(writePath),
    `.${basename(writePath)}.${randomBytes(6).toString('hex')}.flow-tmp`,
  )
  // Preserve the existing file's permission mode across the atomic replace —
  // the fresh temp file gets the default umask mode (0644), which would silently
  // strip an executable bit off a script/hook (#159). First-time writes (no
  // existing target) keep the default mode.
  let existingMode: number | null = null
  try {
    existingMode = (await fsPromises.stat(writePath)).mode
  } catch {
    existingMode = null
  }
  try {
    await fsPromises.writeFile(tempPath, finalContent, 'utf8')
    if (existingMode !== null) await fsPromises.chmod(tempPath, existingMode)
    await fsPromises.rename(tempPath, writePath)
  } catch (error) {
    // Best-effort cleanup of the orphaned temp file; the original write/rename
    // error is what the caller needs to see.
    await fsPromises.unlink(tempPath).catch(() => undefined)
    throw error
  }
}

/** Exported for tests — the IPC layer calls this via project:renamePath. */
export async function renameProjectPath(
  roots: AddressableRoots,
  rootPath: string,
  relPath: string,
  newRelPath: string,
): Promise<void> {
  const from = await resolveInsideRoot(roots, rootPath, relPath)
  const to = await resolveInsideRoot(roots, rootPath, newRelPath)
  // Refuse to clobber a DIFFERENT existing file — but on a case-insensitive FS
  // (APFS/HFS+, the macOS default) a case-only rename (Notes.md → notes.md)
  // stats the destination to the SAME file being renamed, so allow it when
  // `to` resolves to `from` (fs.rename then does a correct case-only rename) (#257).
  if ((await pathExists(to)) && !(await sameFile(from, to))) {
    throw new Error(`[Project] Target already exists: ${newRelPath}`)
  }
  await fsPromises.mkdir(dirname(to), { recursive: true })
  await fsPromises.rename(from, to)
}

/** Exported for tests — the IPC layer calls this via project:deletePath. */
export async function deleteProjectPath(
  roots: AddressableRoots,
  rootPath: string,
  relPath: string,
): Promise<void> {
  const target = await resolveInsideRoot(roots, rootPath, relPath)
  // #1187: to the OS trash, not oblivion. This used to be a plain recursive rm,
  // so deleting a FOLDER destroyed everything inside it with no trash and no
  // undo — and what git tracks is only part of it: gitignored contents (.env,
  // *.local, node_modules/) had no recovery path at all, and `git status`
  // afterwards doesn't even mention them, so nothing on screen hinted they had
  // existed. The tree keeps folders collapsed, so the user typically never saw
  // them either.
  //
  // Fail-soft: some filesystems and headless environments have no trash (a
  // network share, a container). Falling back to rm keeps Delete working
  // everywhere, which is the behaviour every caller already relies on.
  try {
    await shell.trashItem(target)
    return
  } catch (error) {
    console.warn('[Project] Trash unavailable, deleting permanently:', relPath, error)
  }
  await fsPromises.rm(target, { recursive: true, force: true })
}

/** Exported for tests — the IPC layer calls this via project:createPath. */
export async function createProjectPath(
  roots: AddressableRoots,
  rootPath: string,
  relPath: string,
  kind: 'file' | 'directory',
): Promise<void> {
  const target = await resolveInsideRoot(roots, rootPath, relPath)
  if (await pathExists(target)) {
    throw new Error(`[Project] Path already exists: ${relPath}`)
  }
  if (kind === 'directory') {
    await fsPromises.mkdir(target, { recursive: true })
  } else {
    await fsPromises.mkdir(dirname(target), { recursive: true })
    // 'wx' fails if the file already exists (a race after the check above).
    await fsPromises.writeFile(target, '', { flag: 'wx' })
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsPromises.stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * True when two paths resolve to the SAME on-disk file (same device + inode).
 * Lets a case-only rename on a case-insensitive filesystem past the "target
 * already exists" guard, since the destination stats to the source (#257).
 * Exported for tests. False if either path can't be stat'd.
 */
export async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [statA, statB] = await Promise.all([fsPromises.stat(a), fsPromises.stat(b)])
    return statA.dev === statB.dev && statA.ino === statB.ino
  } catch {
    return false
  }
}

/**
 * Resolve `relPath` against an ADDRESSABLE root, rejecting unaddressable roots
 * and any path that escapes the root (renderer input is untrusted). Two
 * layers: lexical (`..`/absolute escapes), then physical (a symlink inside
 * the root must not resolve outside it — for not-yet-existing write targets
 * the deepest existing ancestor is what gets realpath'd).
 */
async function resolveInsideRoot(
  roots: AddressableRoots,
  rootPath: string,
  relPath: string,
): Promise<string> {
  const absoluteRoot = resolve(rootPath)
  if (!roots.isAddressable(absoluteRoot)) {
    throw new Error(`[Project] Unknown root: ${rootPath}`)
  }

  const targetPath = resolve(join(absoluteRoot, relPath))
  const relativeToRoot = relative(absoluteRoot, targetPath)
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error(`[Project] Path escapes the project folder: ${relPath}`)
  }
  // A thread's worktree has the untracked set (`node_modules`, `.env*`, `flow/`)
  // LINKED IN from the checkout it was cut from, so those entries resolve
  // outside it by design — without the owner checkout, opening any of them from
  // a thread's worktree is refused. A registered project root has no owner and
  // is unaffected.
  const ownerCheckout = roots.ownerCheckoutFor(absoluteRoot)
  if (!(await realPathStaysInsideRoot(absoluteRoot, targetPath, ownerCheckout))) {
    throw new Error(`[Project] Path escapes the project folder: ${relPath}`)
  }
  return targetPath
}

/**
 * Does the file on disk start with a UTF-8 BOM (#1147)? Reads only the first
 * three bytes — a 10MB file must not be pulled into memory to answer this — and
 * treats any failure (missing file, unreadable) as "no BOM", so a first write
 * behaves exactly as before.
 */
async function existingFileHasBom(path: string): Promise<boolean> {
  let handle: fsPromises.FileHandle | undefined
  try {
    handle = await fsPromises.open(path, 'r')
    const head = Buffer.alloc(3)
    const { bytesRead } = await handle.read(head, 0, 3, 0)
    return bytesRead === 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** A NUL byte in the head of the file marks it binary (git's heuristic).
 *  Exported so the content-search reader classifies binary files identically. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

function formatSize(bytes: number): string {
  const megabytes = bytes / (1024 * 1024)
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)}MB`
}
