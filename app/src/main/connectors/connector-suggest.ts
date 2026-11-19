// connector-suggest — gathers the facts for "Suggested for <project>" and
// hands them to the pure decision (connector-suggest-model.ts).
//
// WHAT IT READS, for the selected project only:
//   • the git remotes, by reading the repository's config as a FILE (a `.git`
//     that is a file pointing at a worktree's git folder is followed to the
//     shared config) — no child process;
//   • the connector tool names used in this project's chats (one point-read
//     on the thread store, bounded there);
//   • a BOUNDED set of the project's files: a few named top-level files and
//     the files directly inside a few deploy folders — at most 40 files, each
//     read capped at 256 KB, 4 MB in all.
//
// COST (allowed-patterns #17, #19, #20). Every read is async. The file scan is
// cached per project for 60 s, so a sign-in finishing (which re-reads the
// list and the suggestions) costs no second scan. Nothing polls: the Settings
// section asks only while it is on screen.

import { promises as fsp } from 'fs'
import type { FileHandle } from 'fs/promises'
import { isAbsolute, join, resolve } from 'path'

import type { ConnectorEntry, ConnectorSuggestAnswer, ConnectorWriteAnswer } from '../../shared/connectors'
import { SCAN_DIRS, isTopLevelScanFile, remoteUrlsFromGitConfig, suggestConnectors } from './connector-suggest-model'

export const SCAN_TTL_MS = 60_000
export const MAX_SCAN_FILES = 40
export const MAX_FILE_BYTES = 256 * 1024
export const MAX_TOTAL_BYTES = 4 * 1024 * 1024
const MAX_CACHED_PROJECTS = 8
const MAX_FINGERPRINTS = 200

/** What one scan of a project read. */
export interface ProjectScan {
  remoteUrls: string[]
  files: Array<{ path: string; text: string }>
}

export interface ConnectorSuggesterDeps {
  /** The project's connectors: the last list's, else a fresh one. */
  entriesFor: (projectRoot: string) => Promise<ConnectorEntry[]>
  /** Distinct (chat, tool name) pairs of connector tool calls in this project's chats. */
  usedToolRows: (projectRoot: string) => Array<{ threadId: string; toolName: string }>
  /** The "Not now" fingerprints kept per project (app settings). */
  dismissed: {
    get(projectRoot: string): string[]
    set(projectRoot: string, fingerprints: readonly string[]): void
  }
  /** Injectable clock for the scan cache. */
  now?: () => number
}

/** Read at most `cap` bytes of a file as text; null when it cannot be read. */
async function readHead(path: string, cap: number): Promise<string | null> {
  if (cap <= 0) return null
  let handle: FileHandle | null = null
  try {
    handle = await fsp.open(path, 'r')
    const stat = await handle.stat()
    if (!stat.isFile()) return null
    const size = Math.min(stat.size, cap)
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** The git config file for a checkout: `.git/config`, or a worktree's shared one. */
export async function gitConfigPathOf(projectRoot: string): Promise<string | null> {
  const dotGit = join(projectRoot, '.git')
  let gitDir: string
  try {
    const stat = await fsp.stat(dotGit)
    if (stat.isDirectory()) {
      gitDir = dotGit
    } else if (stat.isFile()) {
      const text = await readHead(dotGit, 4096)
      const match = text === null ? null : /^gitdir:[ \t]*(.+)$/m.exec(text)
      if (match === null) return null
      const target = match[1]!.trim()
      gitDir = isAbsolute(target) ? target : resolve(projectRoot, target)
    } else {
      return null
    }
  } catch {
    return null
  }
  const common = await readHead(join(gitDir, 'commondir'), 4096)
  if (common !== null && common.trim() !== '') {
    const target = common.trim()
    return join(isAbsolute(target) ? target : resolve(gitDir, target), 'config')
  }
  return join(gitDir, 'config')
}

/** The project's git remote URLs, read from the config file. Empty when there is none. */
export async function readRemoteUrls(projectRoot: string): Promise<string[]> {
  const configPath = await gitConfigPathOf(projectRoot)
  if (configPath === null) return []
  const text = await readHead(configPath, MAX_FILE_BYTES)
  return text === null ? [] : remoteUrlsFromGitConfig(text)
}

/** The bounded list of files to read, as paths relative to the project. */
export async function scanTargets(projectRoot: string): Promise<string[]> {
  const out: string[] = []
  try {
    const top = await fsp.readdir(projectRoot, { withFileTypes: true })
    for (const entry of top.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isFile() && isTopLevelScanFile(entry.name)) out.push(entry.name)
    }
  } catch {
    return []
  }
  for (const dir of SCAN_DIRS) {
    if (out.length >= MAX_SCAN_FILES) break
    try {
      const entries = await fsp.readdir(join(projectRoot, dir), { withFileTypes: true })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isFile()) out.push(`${dir}/${entry.name}`)
      }
    } catch {
      // The folder is not there: nothing to read.
    }
  }
  return out.slice(0, MAX_SCAN_FILES)
}

/** Read the project's remotes and its bounded files. */
export async function scanProject(projectRoot: string): Promise<ProjectScan> {
  const [remoteUrls, targets] = await Promise.all([readRemoteUrls(projectRoot), scanTargets(projectRoot)])
  const files: ProjectScan['files'] = []
  let budget = MAX_TOTAL_BYTES
  for (const path of targets) {
    if (budget <= 0) break
    const text = await readHead(join(projectRoot, path), Math.min(MAX_FILE_BYTES, budget))
    if (text === null) continue
    budget -= Buffer.byteLength(text, 'utf8')
    files.push({ path, text })
  }
  return { remoteUrls, files }
}

export class ConnectorSuggester {
  readonly #deps: ConnectorSuggesterDeps
  readonly #now: () => number
  readonly #scans = new Map<string, { at: number; scan: Promise<ProjectScan> }>()
  /** Injectable for tests; the real scan by default. */
  readonly #scan: (projectRoot: string) => Promise<ProjectScan>

  constructor(deps: ConnectorSuggesterDeps, scan: (projectRoot: string) => Promise<ProjectScan> = scanProject) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
    this.#scan = scan
  }

  /** The project's scan: a cached one under 60 s old, else a fresh one. */
  #scanOf(projectRoot: string): Promise<ProjectScan> {
    const cached = this.#scans.get(projectRoot)
    const now = this.#now()
    if (cached !== undefined && now - cached.at < SCAN_TTL_MS) return cached.scan
    const scan = this.#scan(projectRoot).catch(() => ({ remoteUrls: [], files: [] }))
    this.#scans.delete(projectRoot)
    this.#scans.set(projectRoot, { at: now, scan })
    while (this.#scans.size > MAX_CACHED_PROJECTS) {
      const oldest = this.#scans.keys().next().value
      if (oldest === undefined) break
      this.#scans.delete(oldest)
    }
    return scan
  }

  /** The suggestions for one project, strongest first, dismissed ones left out. */
  async suggest(projectRoot: string): Promise<ConnectorSuggestAnswer> {
    const entries = await this.#deps.entriesFor(projectRoot).catch(() => [] as ConnectorEntry[])
    // No candidate → no scan at all: the common case once everything is set up.
    if (!entries.some((entry) => entry.status === 'needs-auth' && entry.source !== 'plugin')) {
      return { suggestions: [] }
    }
    let usedRows: Array<{ threadId: string; toolName: string }> = []
    try {
      usedRows = this.#deps.usedToolRows(projectRoot)
    } catch (error) {
      console.warn('[Connectors] reading connector use in chats failed:', error)
    }
    const scan = await this.#scanOf(projectRoot)
    const suggestions = suggestConnectors({
      entries,
      remoteUrls: scan.remoteUrls,
      usedRows,
      files: scan.files,
      dismissed: new Set(this.#deps.dismissed.get(projectRoot)),
    })
    return { suggestions }
  }

  /** "Not now": keep these fingerprints for the project, added to the ones already kept. */
  dismiss(projectRoot: string, fingerprints: readonly string[]): ConnectorWriteAnswer {
    try {
      const kept = new Set(this.#deps.dismissed.get(projectRoot))
      for (const fingerprint of fingerprints) kept.add(fingerprint)
      this.#deps.dismissed.set(projectRoot, [...kept].slice(-MAX_FINGERPRINTS))
      return { ok: true }
    } catch (error) {
      console.warn('[Connectors] keeping a dismissed suggestion failed:', error)
      return { ok: false, reason: 'Flow could not save that right now. Try again in a moment.' }
    }
  }
}
