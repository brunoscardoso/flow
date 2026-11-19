// connector-suggest-model — the pure half of "Suggested for <project>" in
// Settings → Connectors. No file system, no database, no clock: the gatherer
// (connector-suggest.ts) reads the project and hands the facts here, and this
// module decides which connectors to suggest and says why.
//
// THE CANDIDATES. Only connectors that ask to sign in (`needs-auth`): Flow can
// finish that for the person. A Claude.ai connector that is switched off is
// turned on on Claude.ai, not here; a plugin's connector comes and goes with
// its plugin. Neither is suggested.
//
// THE REASONS, strongest first, one per connector:
//   1. repo  — the project's git remote is on the service the connector names;
//   2. used  — the connector's tools were used in this project's other chats;
//   3. files — a distinctive word of its name appears in the project's files.
//
// Every sentence is plain words: no command, no file path, no config key
// (forbidden-pattern #12). The tests scan them.

import type {
  ConnectorEntry,
  ConnectorSuggestion,
  ConnectorSuggestionReasonKind,
} from '../../shared/connectors'
import { suggestionFingerprint } from '../../shared/connectors'

// ── Repository host ─────────────────────────────────────────────────────────

/** A repository host Flow recognises, and the words a connector for it is named with. */
export interface RepoHost {
  label: string
  keyword: string
}

/** Every remote URL in a git config file's text, in order, without repeats. */
export function remoteUrlsFromGitConfig(text: string): string[] {
  const urls: string[] = []
  let inRemote = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inRemote = /^\[remote\s+"[^"]*"\s*\]$/i.test(line)
      continue
    }
    if (!inRemote) continue
    const match = /^(?:push)?url[ \t]*=[ \t]*(.+)$/i.exec(line)
    if (match === null) continue
    const url = match[1]!.trim().replace(/^"(.*)"$/, '$1')
    if (url !== '' && !urls.includes(url)) urls.push(url)
  }
  return urls
}

/** The host of a remote URL: `https://host/…`, `ssh://user@host:port/…` or `user@host:path`. */
export function hostOfRemote(url: string): string | null {
  const trimmed = url.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(trimmed)
  if (withScheme !== null) {
    try {
      const host = new URL(trimmed).hostname.toLowerCase()
      return host === '' ? null : host
    } catch {
      return null
    }
  }
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(trimmed)
  return scp === null ? null : scp[1]!.toLowerCase()
}

/** The service a repository host belongs to, or null when Flow does not know it. */
export function repoHostOf(host: string): RepoHost | null {
  const h = host.toLowerCase()
  if (h === 'dev.azure.com' || h.endsWith('.dev.azure.com') || h === 'visualstudio.com' || h.endsWith('.visualstudio.com')) {
    return { label: 'Azure DevOps', keyword: 'azure devops' }
  }
  if (h === 'github.com' || h.endsWith('.github.com')) return { label: 'GitHub', keyword: 'github' }
  if (/(^|\.)gitlab\./.test(h) || h === 'gitlab.com') return { label: 'GitLab', keyword: 'gitlab' }
  if (h === 'bitbucket.org' || h.endsWith('.bitbucket.org')) return { label: 'Bitbucket', keyword: 'bitbucket' }
  return null
}

/** Lowercase words separated by single spaces: `Azure-DevOps (Work)` → `azure devops work`. */
export function normaliseWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** True when `phrase` appears in `text` as whole words, case-insensitive. */
export function hasPhrase(text: string, phrase: string): boolean {
  const words = normaliseWords(phrase)
  if (words === '') return false
  return ` ${normaliseWords(text)} `.includes(` ${words} `)
}

// ── Keywords from a name ────────────────────────────────────────────────────

/** Words in a connector's name that say nothing about which service it is. */
export const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set([
  'mcp',
  'dev',
  'prod',
  'test',
  'staging',
  'claude',
  'claudeai',
  'microsoft',
  'product',
  'documentation',
  'learn',
  'digital',
  'thread',
  'demo',
  'api',
  'server',
  'docs',
  'app',
])

const MIN_KEYWORD_LENGTH = 4

/** Every lowercase word in the remote URLs — an org name there would match every file of the repo. */
export function remoteWords(urls: readonly string[]): Set<string> {
  const words = new Set<string>()
  for (const url of urls) {
    for (const word of normaliseWords(url).split(' ')) if (word !== '') words.add(word)
  }
  return words
}

/**
 * The distinctive words of a connector's display name: parenthesised parts
 * dropped, generic words dropped, words shorter than four letters dropped,
 * and any word that is part of the git remote dropped.
 */
export function nameKeywords(displayName: string, remote: ReadonlySet<string> = new Set()): string[] {
  const words = normaliseWords(displayName.replace(/\([^)]*\)/g, ' ').replace(/claude\.ai/gi, ' ')).split(' ')
  const out: string[] = []
  for (const word of words) {
    if (word.length < MIN_KEYWORD_LENGTH) continue
    if (GENERIC_NAME_WORDS.has(word) || remote.has(word)) continue
    if (!out.includes(word)) out.push(word)
  }
  return out
}

// ── The project's files ─────────────────────────────────────────────────────

/** What kind of file a name was found in, which picks the sentence. */
export type ScannedFileKind = 'deploy' | 'dependencies' | 'docs' | 'files'

/** Top-level files read, by name. */
export function isTopLevelScanFile(name: string): boolean {
  return (
    name === 'package.json' ||
    name === 'pyproject.toml' ||
    /^requirements.*\.txt$/i.test(name) ||
    /^docker-compose.*\.ya?ml$/i.test(name) ||
    name === 'Makefile' ||
    /^readme/i.test(name) ||
    name === 'CLAUDE.md' ||
    name === '.env.example'
  )
}

/** Folders whose files (one level, not below) are read. */
export const SCAN_DIRS: readonly string[] = ['.github/workflows', 'deploy', 'k8s', 'helm', 'charts', 'infra']

/** The kind of a scanned file, from its path relative to the project. */
export function fileKindOf(relPath: string): ScannedFileKind {
  const path = relPath.replace(/\\/g, '/')
  const base = path.split('/').pop() ?? path
  if (SCAN_DIRS.some((dir) => path.startsWith(`${dir}/`)) || /^docker-compose/i.test(base)) return 'deploy'
  if (base === 'package.json' || base === 'pyproject.toml' || /^requirements.*\.txt$/i.test(base)) return 'dependencies'
  if (/^readme/i.test(base) || base === 'CLAUDE.md') return 'docs'
  return 'files'
}

const FILE_KIND_RANK: Record<ScannedFileKind, number> = { deploy: 0, dependencies: 1, docs: 2, files: 3 }

const FILE_KIND_PHRASE: Record<ScannedFileKind, string> = {
  deploy: 'deploy files',
  dependencies: 'dependencies',
  docs: 'docs',
  files: 'files',
}

/** True when `keyword` appears in `text` as a whole word, case-insensitive. */
export function containsWord(text: string, keyword: string): boolean {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text)
}

/** The strongest kind of file any keyword appears in, or null. */
export function strongestFileMatch(
  keywords: readonly string[],
  files: ReadonlyArray<{ path: string; text: string }>,
): ScannedFileKind | null {
  let best: ScannedFileKind | null = null
  for (const file of files) {
    const kind = fileKindOf(file.path)
    if (best !== null && FILE_KIND_RANK[kind] >= FILE_KIND_RANK[best]) continue
    if (keywords.some((keyword) => containsWord(file.text, keyword))) best = kind
  }
  return best
}

// ── Use in other chats ──────────────────────────────────────────────────────

/**
 * The server part of a connector's tool names: every character outside
 * letters, digits, `_` and `-` becomes `_` — the runtime's rule, the same as
 * `toolPrefixName` in the connector service (copied, so this module stays
 * free of the service's imports).
 */
export function toolPrefixName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** How many distinct chats used a tool of the connector called `name`. */
export function chatsUsing(name: string, rows: ReadonlyArray<{ threadId: string; toolName: string }>): number {
  const prefix = `mcp__${toolPrefixName(name)}__`
  const threads = new Set<string>()
  for (const row of rows) {
    if (row.toolName.startsWith(prefix) && row.toolName.length > prefix.length) threads.add(row.threadId)
  }
  return threads.size
}

// ── Sentences ───────────────────────────────────────────────────────────────

export function repoReason(host: RepoHost): string {
  return `This project’s repository is on ${host.label}.`
}

export function usedReason(count: number): string {
  return count === 1 ? 'Used in 1 other chat in this project.' : `Used in ${count} other chats in this project.`
}

export function filesReason(kind: ScannedFileKind): string {
  return `Named in this project’s ${FILE_KIND_PHRASE[kind]}.`
}

// ── The decision ────────────────────────────────────────────────────────────

/** The facts the gatherer read for one project. */
export interface SuggestInput {
  entries: readonly ConnectorEntry[]
  remoteUrls: readonly string[]
  /** Distinct (chat, tool name) pairs of connector tool calls in this project's chats. */
  usedRows: ReadonlyArray<{ threadId: string; toolName: string }>
  files: ReadonlyArray<{ path: string; text: string }>
  /** Fingerprints a person answered "Not now" to. */
  dismissed?: ReadonlySet<string>
}

const KIND_RANK: Record<ConnectorSuggestionReasonKind, number> = { repo: 0, used: 1, files: 2 }

/** Whether an entry may be suggested at all (see the header). */
export function isSuggestionCandidate(entry: Pick<ConnectorEntry, 'status' | 'source'>): boolean {
  return entry.status === 'needs-auth' && entry.source !== 'plugin'
}

/**
 * The suggestions for one project, strongest first: by kind of reason, then
 * by how many chats used it, then by name. One reason per connector — its
 * strongest. Dismissed fingerprints are left out.
 */
export function suggestConnectors(input: SuggestInput): ConnectorSuggestion[] {
  const hosts = input.remoteUrls
    .map((url) => hostOfRemote(url))
    .map((host) => (host === null ? null : repoHostOf(host)))
    .filter((host): host is RepoHost => host !== null)
  const remote = remoteWords(input.remoteUrls)
  const dismissed = input.dismissed ?? new Set<string>()
  const ranked: Array<{ suggestion: ConnectorSuggestion; used: number }> = []
  for (const entry of input.entries) {
    if (!isSuggestionCandidate(entry)) continue
    const used = chatsUsing(entry.name, input.usedRows)
    const base = { name: entry.name, displayName: entry.displayName }
    let suggestion: ConnectorSuggestion | null = null
    const host = hosts.find((candidate) => hasPhrase(entry.displayName, candidate.keyword) || hasPhrase(entry.name, candidate.keyword))
    if (host !== undefined) {
      suggestion = { ...base, reasonKind: 'repo', reason: repoReason(host) }
    } else if (used > 0) {
      suggestion = { ...base, reasonKind: 'used', reason: usedReason(used) }
    } else {
      const kind = strongestFileMatch(nameKeywords(entry.displayName, remote), input.files)
      if (kind !== null) suggestion = { ...base, reasonKind: 'files', reason: filesReason(kind) }
    }
    if (suggestion === null || dismissed.has(suggestionFingerprint(suggestion))) continue
    ranked.push({ suggestion, used })
  }
  ranked.sort(
    (a, b) =>
      KIND_RANK[a.suggestion.reasonKind] - KIND_RANK[b.suggestion.reasonKind] ||
      b.used - a.used ||
      a.suggestion.displayName.localeCompare(b.suggestion.displayName, undefined, { sensitivity: 'base' }),
  )
  return ranked.map((item) => item.suggestion)
}
