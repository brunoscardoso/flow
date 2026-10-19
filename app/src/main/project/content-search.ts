// Project content search — the file-explorer content-search panel's backend
// (project:searchContent). Two layers, mirroring files.ts:
//   - searchFiles(): a PURE, fs-injected walk-and-scan (no fs, no clock) so it is
//     trivially unit-testable with in-memory fakes, exactly like collectFiles.
//   - searchProjectContent(): the fs-backed wrapper the IPC handler calls —
//     validates the root through the addressable-roots gate (untrusted renderer
//     input), builds the fs readers, and caches behind a short TTL.
//
// It deliberately REUSES files.ts's guards rather than copying them
// (allowed-pattern #14): the same SEARCH_IGNORED_DIRS, the same depth bound, the
// same fs dir reader (whose symlink skipping keeps the walk on real files under
// the root), and the same binary/size classification. Matching is a literal
// substring, case-insensitive unless caseSensitive is set.

import { promises as fsPromises } from 'fs'
import { join, resolve } from 'path'

import type {
  ContentSearchFile,
  ContentSearchMatch,
  ContentSearchResult,
} from '../../shared/ipc-contract'
import type { AddressableRoots } from './addressable-roots'
import {
  MAX_FILE_SIZE_BYTES,
  MAX_LIST_ALL_FILES_DEPTH,
  SEARCH_IGNORED_DIRS,
  skipDirDuringWalk,
  UTF8_BOM,
  looksBinary,
  makeFsDirReader,
  type DirReader,
} from './files'

/** Default cap on TOTAL matches returned across all files. */
export const DEFAULT_SEARCH_MAX_RESULTS = 2000
/** Default cap on matches recorded per single file. */
export const DEFAULT_SEARCH_MAX_PER_FILE = 20
/** Default cap on files SCANNED (read) before the walk stops as truncated. */
export const DEFAULT_SEARCH_FILE_SCAN_LIMIT = 20000
/** A matched line is trimmed to this many characters for the preview. */
export const SEARCH_PREVIEW_MAX_CHARS = 200
/** Files read+scanned concurrently per batch. The walk is I/O-bound (reading
 *  every text file under the root), and reading them one await at a time was the
 *  whole cost — a 24 MB repo measured 1150 ms serial vs 355 ms at this width
 *  (#1910). A batch's reads run in parallel; its results are consumed IN ORDER,
 *  so the deterministic early-stop below is preserved (allowed-pattern #19 —
 *  don't make the main process wait longer than it has to). */
const SEARCH_READ_CONCURRENCY = 24
/** Bytes sniffed for binary classification — mirrors readProjectFile. */
const BINARY_SNIFF_BYTES = 8192

export interface SearchFilesOptions {
  /** The literal substring to find. Empty/whitespace-only yields no matches. */
  query: string
  /** Case-sensitive when true; case-insensitive (default) otherwise. */
  caseSensitive?: boolean
  /** Directory basenames never descended into. */
  ignoredDirs: ReadonlySet<string>
  /** Cap on total matches across all files. */
  maxResults: number
  /** Cap on matches recorded per file. */
  maxPerFile: number
  /** Cap on files scanned before stopping as truncated. */
  fileScanLimit: number
  /** Max directory depth to descend (root entries are depth 1). */
  maxDepth?: number
  /** Preview trim length. */
  previewMaxChars?: number
}

/** Reads a file's text given a repo-relative POSIX path. Returns null to SKIP
 *  the file (binary, oversized, or unreadable). May reject — treated as a skip. */
export type FileTextReader = (relPath: string) => Promise<string | null>

/**
 * PURE, fs-injected content search. First a breadth-first walk (deterministic
 * per-dir sort, dotfile + ignoredDirs skipping, depth guard, fail-soft on
 * unreadable dirs) collects the candidate files, capped at `fileScanLimit`. Then
 * the candidates are read+scanned in bounded-concurrency batches — parallel I/O
 * is the whole speedup (#1910) — whose results are consumed IN ORDER so the
 * early-stop stays deterministic: it records `{ line (1-based), column (0-based),
 * preview }` per match (capped at `maxPerFile`) and stops with `truncated: true`
 * when the total hits `maxResults` or the walk hits `fileScanLimit`. Files are
 * returned sorted by relPath. No fs, no clock.
 */
export async function searchFiles(
  read: DirReader,
  readText: FileTextReader,
  options: SearchFilesOptions,
): Promise<ContentSearchResult> {
  const { query, ignoredDirs, maxResults, maxPerFile, fileScanLimit } = options
  if (query.trim() === '') return { files: [], truncated: false }

  const maxDepth = options.maxDepth ?? MAX_LIST_ALL_FILES_DEPTH
  const previewMaxChars = options.previewMaxChars ?? SEARCH_PREVIEW_MAX_CHARS
  const caseSensitive = options.caseSensitive === true
  const needle = caseSensitive ? query : query.toLowerCase()

  // Phase 1: BFS walk collecting candidate files (deterministic order), stopping
  // once fileScanLimit is reached — the same bound the serial walk enforced.
  const candidates: string[] = []
  let truncated = false
  const queue: Array<{ relDir: string; depth: number }> = [{ relDir: '', depth: 0 }]
  walk: while (queue.length > 0) {
    const { relDir, depth } = queue.shift() as { relDir: string; depth: number }
    let entries
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
        continue
      }
      if (candidates.length >= fileScanLimit) {
        truncated = true
        break walk
      }
      candidates.push(childRel)
    }
  }

  // Phase 2: read+scan the candidates in parallel batches. A batch's reads fan
  // out concurrently; its results are then consumed IN CANDIDATE ORDER, so which
  // files land under the maxResults cap does not depend on read-completion order.
  const files: ContentSearchFile[] = []
  let totalMatches = 0
  batches: for (let start = 0; start < candidates.length; start += SEARCH_READ_CONCURRENCY) {
    const slice = candidates.slice(start, start + SEARCH_READ_CONCURRENCY)
    const texts = await Promise.all(
      slice.map((relPath) => readText(relPath).catch(() => null)), // unreadable → skip
    )
    for (let i = 0; i < slice.length; i += 1) {
      const text = texts[i]
      if (text === null) continue // binary / oversized / unreadable
      const fileMatches = scanText(text, needle, caseSensitive, maxPerFile, previewMaxChars)
      if (fileMatches.length === 0) continue

      files.push({ relPath: slice[i], matches: fileMatches })
      totalMatches += fileMatches.length
      if (totalMatches >= maxResults) {
        truncated = true
        break batches
      }
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { files, truncated }
}

/** Scan one file's text for the (already case-folded) needle, up to `maxPerFile`
 *  matches. `needle` is lowercased by the caller when case-insensitive. */
function scanText(
  text: string,
  needle: string,
  caseSensitive: boolean,
  maxPerFile: number,
  previewMaxChars: number,
): ContentSearchMatch[] {
  const matches: ContentSearchMatch[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    if (matches.length >= maxPerFile) break
    const raw = lines[i]
    // Trim a trailing CR so a CRLF file's preview and column stay clean.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const haystack = caseSensitive ? line : line.toLowerCase()
    const column = haystack.indexOf(needle)
    if (column === -1) continue
    matches.push({
      line: i + 1,
      column,
      preview: line.length > previewMaxChars ? line.slice(0, previewMaxChars) : line,
    })
  }
  return matches
}

// ── fs-backed wrapper + cache ────────────────────────────────────────────────

/** How long a content-search result stays good — one search session's worth,
 *  matching the flat-file-list TTL convention (files.ts:309-329). */
const SEARCH_TTL_MS = 5_000

/** Cached results keyed by (root, case-mode, caps, query). See files.ts's
 *  listAllCache doc for why a short TTL, not a watcher subscription. */
const searchCache = new Map<string, { at: number; result: ContentSearchResult }>()

/** Drop a root's cached searches — called when a root is removed,
 *  alongside forgetListAllCache. */
export function forgetContentSearchCache(rootPath?: string): void {
  if (rootPath === undefined) {
    searchCache.clear()
    return
  }
  const prefix = `${resolve(rootPath)} `
  for (const key of searchCache.keys()) {
    if (key.startsWith(prefix)) searchCache.delete(key)
  }
}

export interface SearchProjectRequest {
  query: string
  caseSensitive?: boolean
  maxResults?: number
  maxPerFile?: number
}

/** Clamp a caller cap into `[1, fallback]`; absent/invalid → fallback. */
function normalizeCap(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), fallback)
}

/**
 * fs-backed content search for an ADDRESSABLE root — the IPC layer calls this via
 * project:searchContent. Validates the root (untrusted renderer input), builds
 * the shared fs dir reader + a size/binary-guarded text reader (mirroring
 * readProjectFile), and searches with the shared ignore set + depth bound.
 * Cached for SEARCH_TTL_MS per (root, query, options); injectable `now()` for
 * tests. Throws only for an unknown root; empty/whitespace query returns no
 * matches without touching the fs.
 */
export async function searchProjectContent(
  roots: AddressableRoots,
  rootPath: string,
  req: SearchProjectRequest,
  now: () => number = Date.now,
): Promise<ContentSearchResult> {
  const absoluteRoot = resolve(rootPath)
  if (!roots.isAddressable(absoluteRoot)) {
    throw new Error(`[Project] Unknown root: ${rootPath}`)
  }

  const query = req.query ?? ''
  if (query.trim() === '') return { files: [], truncated: false }

  const caseSensitive = req.caseSensitive === true
  const maxResults = normalizeCap(req.maxResults, DEFAULT_SEARCH_MAX_RESULTS)
  const maxPerFile = normalizeCap(req.maxPerFile, DEFAULT_SEARCH_MAX_PER_FILE)

  const key = `${absoluteRoot} ${caseSensitive ? 'cs' : 'ci'} ${maxResults} ${maxPerFile} ${query}`
  const cached = searchCache.get(key)
  if (cached !== undefined && now() - cached.at < SEARCH_TTL_MS) {
    return cached.result
  }

  const result = await searchFiles(
    makeFsDirReader(absoluteRoot),
    makeFsTextReader(absoluteRoot),
    {
      query,
      caseSensitive,
      ignoredDirs: SEARCH_IGNORED_DIRS,
      maxResults,
      maxPerFile,
      fileScanLimit: DEFAULT_SEARCH_FILE_SCAN_LIMIT,
      maxDepth: MAX_LIST_ALL_FILES_DEPTH,
      previewMaxChars: SEARCH_PREVIEW_MAX_CHARS,
    },
  )
  searchCache.set(key, { at: now(), result })
  return result
}

/** fs-backed {@link FileTextReader}: reads a file's UTF-8 text, returning null to
 *  SKIP oversized (> MAX_FILE_SIZE_BYTES) or binary files — the same guards
 *  readProjectFile applies — and stripping a leading UTF-8 BOM so a search for
 *  the first token on line 1 is not thrown off by an invisible byte. */
function makeFsTextReader(absoluteRoot: string): FileTextReader {
  return async (relPath: string): Promise<string | null> => {
    const target = join(absoluteRoot, relPath)
    const stats = await fsPromises.stat(target)
    if (!stats.isFile() || stats.size > MAX_FILE_SIZE_BYTES) return null
    const buffer = await fsPromises.readFile(target)
    if (looksBinary(buffer.subarray(0, BINARY_SNIFF_BYTES))) return null
    const decoded = buffer.toString('utf8')
    return decoded.startsWith(UTF8_BOM) ? decoded.slice(UTF8_BOM.length) : decoded
  }
}
