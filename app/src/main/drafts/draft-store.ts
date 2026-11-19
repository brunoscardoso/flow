/**
 * THE DRAFTS STORE — the one code path in main that reads and writes a canvas
 * folder (allowed-pattern #14): atomic writes, undo snapshots, named versions,
 * the canvas list and the layout read. Serving, editing, stamping and the
 * observer all come through here, so every write is atomic, snapshotted and
 * recorded as Flow's own in the same way.
 *
 * ASYNC AND BOUNDED (allowed-pattern #19): every call is fs/promises, and the
 * history keeps at most DRAFT_HISTORY_LIMIT snapshots per file.
 *
 * NO WORKING DEFAULTS (forbidden-pattern #15): every function that writes or
 * deletes takes its filesystem and its write ledger as explicit inputs. There
 * is no default that reaches the real disk, so a test that forgets a dep fails
 * to compile instead of writing into a real project.
 */
import { promises as fsPromises } from 'fs'
import { dirname, join } from 'path'

import {
  DRAFT_HISTORY_DIR,
  DRAFT_HISTORY_LIMIT,
  DRAFT_LAYOUT_FILE,
  DRAFT_TOKENS_FILE,
  DRAFT_VERSION_FILE,
  DRAFT_VERSIONS_DIR,
  DRAFTS_DIR,
  draftCanvasDir,
  draftVersionSlug,
  isDraftSlug,
  parseDraftLayout,
  resolveDraftPath,
  type DraftCanvasSummary,
  type DraftFilesAnswer,
  type DraftLayoutAnswer,
  type DraftSaveVersionAnswer,
  type DraftVersionInfo,
  type DraftWriteAnswer,
} from '../../shared/ui-drafts'
import {
  fileOfHistoryFolder,
  planCanvasUndo,
  snapshotName,
  snapshotsToPrune,
  sortedSnapshots,
  type HistoryFolder,
} from './draft-history'
import type { DraftWriteLedger } from './draft-write-ledger'

/** The filesystem calls the store makes — injected, never defaulted. */
export interface DraftFs {
  readFile(absPath: string): Promise<string>
  writeFile(absPath: string, content: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(absPath: string): Promise<void>
  /** Names inside a directory; rejects when it does not exist. */
  readdir(absPath: string): Promise<string[]>
  /** Whether `absPath` is a directory (false when it does not exist). */
  isDirectory(absPath: string): Promise<boolean>
  /** Remove one file. */
  unlink(absPath: string): Promise<void>
  /** Remove a directory tree (used only for a failed version's temp folder). */
  removeTree(absPath: string): Promise<void>
  /** Last-modified time (ms) of a file, or undefined when it cannot be read. Optional: a fake without it reports no recency. */
  mtimeMs?(absPath: string): Promise<number | undefined>
}

/** The real filesystem, for main's wiring only — passed explicitly, never a default. */
export const nodeDraftFs: DraftFs = {
  readFile: (absPath) => fsPromises.readFile(absPath, 'utf8'),
  writeFile: (absPath, content) => fsPromises.writeFile(absPath, content, 'utf8'),
  rename: (from, to) => fsPromises.rename(from, to),
  mkdir: async (absPath) => {
    await fsPromises.mkdir(absPath, { recursive: true })
  },
  readdir: (absPath) => fsPromises.readdir(absPath),
  isDirectory: async (absPath) => {
    try {
      return (await fsPromises.stat(absPath)).isDirectory()
    } catch {
      return false
    }
  },
  unlink: (absPath) => fsPromises.unlink(absPath),
  removeTree: (absPath) => fsPromises.rm(absPath, { recursive: true, force: true }),
  mtimeMs: async (absPath) => {
    try {
      return (await fsPromises.stat(absPath)).mtimeMs
    } catch {
      return undefined
    }
  },
}

/** What every writing call needs. */
export interface DraftStoreDeps {
  fs: DraftFs
  /** Records each write as Flow's own before it lands, so the observer skips it. */
  ledger: DraftWriteLedger
  /** Clock for snapshot names and version stamps. */
  now: () => number
}

export const NOTHING_TO_UNDO = 'There is nothing to undo on this screen.'
export const NOTHING_TO_UNDO_CANVAS = 'Nothing to undo.'
export const CANVAS_MISSING = 'This canvas is no longer in the project.'

function canvasAbs(root: string, canvas: string): string | null {
  const dir = draftCanvasDir(canvas)
  return dir === null ? null : join(root, dir)
}

/**
 * The history folder of one canvas file. A screen's is its slug; the layout
 * and the tokens stylesheet get dot-names, which no screen slug can take.
 */
export function historyDirFor(root: string, canvas: string, file: string): string | null {
  const resolution = resolveDraftPath(root, canvas, file)
  const base = canvasAbs(root, canvas)
  if (!resolution.ok || base === null) return null
  const name =
    resolution.kind === 'screen' ? (resolution.screen as string) : resolution.kind === 'layout' ? '.layout' : '.tokens'
  return join(base, DRAFT_HISTORY_DIR, name)
}

/** Write `content` to `absPath` atomically (temp file + rename), recorded as Flow's own. */
export async function writeDraftAtomic(deps: DraftStoreDeps, absPath: string, content: string): Promise<void> {
  await deps.fs.mkdir(dirname(absPath))
  const temp = `${absPath}.${deps.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  await deps.fs.writeFile(temp, content)
  deps.ledger.mark(absPath, content)
  try {
    await deps.fs.rename(temp, absPath)
  } catch (error) {
    await deps.fs.unlink(temp).catch(() => undefined)
    throw error
  }
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot === -1 ? '' : file.slice(dot)
}

async function snapshotsIn(deps: Pick<DraftStoreDeps, 'fs'>, dir: string): Promise<string[]> {
  try {
    return sortedSnapshots(await deps.fs.readdir(dir))
  } catch {
    return []
  }
}

/**
 * Keep `previous` as the newest undo snapshot of one canvas file, then drop the
 * oldest beyond the limit. Snapshots are personal (a knowledge-class row), so
 * they never leave this machine.
 */
export async function snapshotDraft(
  deps: DraftStoreDeps,
  request: { root: string; canvas: string; file: string; previous: string },
): Promise<void> {
  const dir = historyDirFor(request.root, request.canvas, request.file)
  if (dir === null) throw new Error(`snapshotDraft: '${request.file}' is not a draft file`)
  await deps.fs.mkdir(dir)
  const existing = new Set(await snapshotsIn(deps, dir))
  const at = deps.now()
  const extension = extensionOf(request.file)
  let attempt = 0
  while (existing.has(snapshotName(at, attempt, extension))) attempt += 1
  await deps.fs.writeFile(join(dir, snapshotName(at, attempt, extension)), request.previous)
  for (const stale of snapshotsToPrune(await snapshotsIn(deps, dir), DRAFT_HISTORY_LIMIT)) {
    await deps.fs.unlink(join(dir, stale)).catch((error) => {
      console.warn('[Drafts] could not prune an undo snapshot', { dir, stale, error })
    })
  }
}

/**
 * Write a new content for one canvas file: snapshot what is there now (when
 * there is something and it differs), then write atomically as Flow's own.
 * Answers whether the file changed.
 */
export async function replaceDraftFile(
  deps: DraftStoreDeps,
  request: { root: string; canvas: string; file: string; content: string },
): Promise<boolean> {
  const resolution = resolveDraftPath(request.root, request.canvas, request.file)
  if (!resolution.ok) throw new Error(`replaceDraftFile: '${request.file}' is not a draft file`)
  const absPath = join(request.root, resolution.relPath)
  let previous: string | null = null
  try {
    previous = await deps.fs.readFile(absPath)
  } catch {
    previous = null
  }
  if (previous === request.content) return false
  if (previous !== null) await snapshotDraft(deps, { ...request, previous })
  await writeDraftAtomic(deps, absPath, request.content)
  return true
}

/** Undo the newest change to one canvas file: restore its newest snapshot and remove it. */
export async function undoDraft(
  deps: DraftStoreDeps,
  request: { root: string; canvas: string; file: string },
): Promise<DraftWriteAnswer> {
  const resolution = resolveDraftPath(request.root, request.canvas, request.file)
  const dir = historyDirFor(request.root, request.canvas, request.file)
  if (!resolution.ok || dir === null) return { ok: false, reason: 'That is not a file of this canvas.' }
  const snapshots = await snapshotsIn(deps, dir)
  const newest = snapshots[snapshots.length - 1]
  if (newest === undefined) return { ok: false, reason: NOTHING_TO_UNDO }
  const snapshotPath = join(dir, newest)
  const content = await deps.fs.readFile(snapshotPath)
  await writeDraftAtomic(deps, join(request.root, resolution.relPath), content)
  await deps.fs.unlink(snapshotPath)
  return { ok: true }
}

/** Every history folder of a canvas with its snapshot names. A canvas with no history has none. */
async function historyFolders(deps: Pick<DraftStoreDeps, 'fs'>, root: string, canvas: string): Promise<HistoryFolder[]> {
  const base = canvasAbs(root, canvas)
  if (base === null) return []
  const historyDir = join(base, DRAFT_HISTORY_DIR)
  let folders: string[]
  try {
    folders = await deps.fs.readdir(historyDir)
  } catch {
    return []
  }
  const out: HistoryFolder[] = []
  for (const folder of folders) {
    if (fileOfHistoryFolder(folder) === null) continue
    out.push({ folder, names: await snapshotsIn(deps, join(historyDir, folder)) })
  }
  return out
}

/** How many times Undo can step back on a canvas — the agent's changes and the person's alike. */
export async function countDraftUndo(deps: Pick<DraftStoreDeps, 'fs'>, root: string, canvas: string): Promise<number> {
  return planCanvasUndo(await historyFolders(deps, root, canvas)).steps
}

/**
 * Undo the newest change to the canvas, whoever made it: every file that has a
 * snapshot at the newest stamp is put back and its snapshot removed. Answers
 * the files it restored, so the page can reload them (Flow's own writes are
 * not broadcast).
 */
export async function undoDraftCanvas(
  deps: DraftStoreDeps,
  request: { root: string; canvas: string },
): Promise<DraftFilesAnswer> {
  const base = canvasAbs(request.root, request.canvas)
  if (base === null || !(await deps.fs.isDirectory(base))) return { ok: false, reason: CANVAS_MISSING }
  const plan = planCanvasUndo(await historyFolders(deps, request.root, request.canvas))
  if (plan.restore.length === 0) return { ok: false, reason: NOTHING_TO_UNDO_CANVAS }
  const files: string[] = []
  for (const { folder, name } of plan.restore) {
    const file = fileOfHistoryFolder(folder)
    if (file === null) continue
    const snapshotPath = join(base, DRAFT_HISTORY_DIR, folder, name)
    const content = await deps.fs.readFile(snapshotPath)
    await writeDraftAtomic(deps, join(base, file), content)
    await deps.fs.unlink(snapshotPath)
    files.push(file)
  }
  return { ok: true, files: files.sort() }
}

// ── Reading ──────────────────────────────────────────────────────────────

/** Read and check one canvas's layout file. */
export async function readDraftLayout(
  read: (absPath: string) => Promise<string>,
  root: string,
  canvas: string,
): Promise<DraftLayoutAnswer> {
  const resolution = resolveDraftPath(root, canvas, DRAFT_LAYOUT_FILE)
  if (!resolution.ok) return { ok: false, reason: 'That is not a canvas.' }
  let text: string
  try {
    text = await read(join(root, resolution.relPath))
  } catch {
    return { ok: false, reason: 'This canvas has no layout yet.' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'The layout is not valid JSON.' }
  }
  return parseDraftLayout(raw, canvas)
}

/** Every canvas in a project's drafts folder, by slug. A missing folder is no canvases. */
export async function listDraftCanvases(
  fs: Pick<DraftFs, 'readdir' | 'isDirectory' | 'readFile' | 'mtimeMs'>,
  root: string,
): Promise<DraftCanvasSummary[]> {
  let names: string[]
  try {
    names = await fs.readdir(join(root, DRAFTS_DIR))
  } catch {
    return []
  }
  const out: DraftCanvasSummary[] = []
  for (const canvas of names.filter(isDraftSlug).sort()) {
    if (!(await fs.isDirectory(join(root, DRAFTS_DIR, canvas)))) continue
    const layout = await readDraftLayout(fs.readFile, root, canvas)
    if (!layout.ok) {
      out.push({ canvas, name: canvas, screenCount: 0, problem: layout.reason })
      continue
    }
    // How far the writing has got: the layout's screens that exist as files,
    // and when the newest of them (or the layout) was written.
    const dir = join(root, DRAFTS_DIR, canvas)
    const present = new Set(await fs.readdir(dir).catch(() => [] as string[]))
    const written = layout.layout.screens.filter((screen) => present.has(screen.file))
    let updatedAt: number | undefined
    if (fs.mtimeMs !== undefined) {
      for (const file of [DRAFT_LAYOUT_FILE, ...written.map((screen) => screen.file)]) {
        const at = await fs.mtimeMs(join(dir, file))
        if (at !== undefined && (updatedAt === undefined || at > updatedAt)) updatedAt = at
      }
    }
    out.push({
      canvas,
      name: layout.layout.name,
      screenCount: layout.layout.screens.length,
      screensWritten: written.length,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    })
  }
  return out
}

/** The files a version holds: the layout, the tokens stylesheet and every screen. */
async function canvasFiles(fs: Pick<DraftFs, 'readdir'>, dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  return names.filter((name) => resolveDraftPath('/', 'x', name).ok).sort()
}

// ── Named versions ───────────────────────────────────────────────────────

/** Every named version of a canvas, newest first. Unreadable versions are skipped. */
export async function listDraftVersions(
  fs: Pick<DraftFs, 'readdir' | 'readFile'>,
  root: string,
  canvas: string,
): Promise<DraftVersionInfo[]> {
  const base = canvasAbs(root, canvas)
  if (base === null) return []
  let names: string[]
  try {
    names = await fs.readdir(join(base, DRAFT_VERSIONS_DIR))
  } catch {
    return []
  }
  const out: DraftVersionInfo[] = []
  for (const version of names.filter(isDraftSlug)) {
    try {
      const raw = JSON.parse(await fs.readFile(join(base, DRAFT_VERSIONS_DIR, version, DRAFT_VERSION_FILE))) as Record<
        string,
        unknown
      >
      out.push({
        version,
        name: typeof raw.name === 'string' ? raw.name : version,
        savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : '',
      })
    } catch {
      continue
    }
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.version.localeCompare(b.version))
}

/**
 * Save the canvas as a named version: copy its layout, tokens and screens into
 * `versions/<slug>/` with a small `version.json`. Written into a temp folder
 * first and renamed into place, so a version is either whole or absent.
 */
export async function saveDraftVersion(
  deps: DraftStoreDeps,
  request: { root: string; canvas: string; name: string },
): Promise<DraftSaveVersionAnswer> {
  const base = canvasAbs(request.root, request.canvas)
  if (base === null || !(await deps.fs.isDirectory(base))) return { ok: false, reason: CANVAS_MISSING }
  const name = request.name.trim()
  const version = draftVersionSlug(name)
  if (version === null) return { ok: false, reason: 'A version needs a name with letters or numbers.' }
  const versionsDir = join(base, DRAFT_VERSIONS_DIR)
  const target = join(versionsDir, version)
  if (await deps.fs.isDirectory(target)) return { ok: false, reason: 'A version with that name already exists.' }
  const files = await canvasFiles(deps.fs, base)
  if (files.length === 0) return { ok: false, reason: 'This canvas has nothing to save yet.' }
  const temp = join(versionsDir, `.${version}.${deps.now()}.tmp`)
  const info: DraftVersionInfo = { version, name, savedAt: new Date(deps.now()).toISOString() }
  try {
    await deps.fs.mkdir(temp)
    for (const file of files) await deps.fs.writeFile(join(temp, file), await deps.fs.readFile(join(base, file)))
    await deps.fs.writeFile(
      join(temp, DRAFT_VERSION_FILE),
      `${JSON.stringify({ name: info.name, savedAt: info.savedAt, files }, null, 2)}\n`,
    )
    await deps.fs.rename(temp, target)
  } catch (error) {
    await deps.fs.removeTree(temp).catch(() => undefined)
    console.warn('[Drafts] could not save a version', { canvas: request.canvas, version, error })
    return { ok: false, reason: 'The version could not be saved.' }
  }
  return { ok: true, version: info }
}

/**
 * Restore a named version: each of its files is written back over the canvas
 * through `replaceDraftFile`, so what was there is snapshotted first and every
 * restored file can be undone. Screens the version does not hold are left as
 * they are — the restored layout decides which screens the canvas shows.
 */
export async function restoreDraftVersion(
  deps: DraftStoreDeps,
  request: { root: string; canvas: string; version: string },
): Promise<DraftFilesAnswer> {
  const base = canvasAbs(request.root, request.canvas)
  if (base === null || !isDraftSlug(request.version)) return { ok: false, reason: 'That version does not exist.' }
  const dir = join(base, DRAFT_VERSIONS_DIR, request.version)
  if (!(await deps.fs.isDirectory(dir))) return { ok: false, reason: 'That version does not exist.' }
  const files = await canvasFiles(deps.fs, dir)
  if (files.length === 0) return { ok: false, reason: 'That version holds no files.' }
  // Layout last: a canvas that reloads mid-restore never names a screen that
  // has not been written back yet.
  const ordered = [
    ...files.filter((file) => file !== DRAFT_LAYOUT_FILE && file !== DRAFT_TOKENS_FILE),
    ...files.filter((file) => file === DRAFT_TOKENS_FILE),
    ...files.filter((file) => file === DRAFT_LAYOUT_FILE),
  ]
  // One clock reading for the whole restore: its snapshots share a stamp, so one
  // press of Undo puts the whole restore back.
  const at = deps.now()
  const together: DraftStoreDeps = { ...deps, now: () => at }
  const changed: string[] = []
  for (const file of ordered) {
    const content = await deps.fs.readFile(join(dir, file))
    if (await replaceDraftFile(together, { root: request.root, canvas: request.canvas, file, content })) changed.push(file)
  }
  return { ok: true, files: changed.sort() }
}
