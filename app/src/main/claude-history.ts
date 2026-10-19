// Claude Code session reader — surfaces a project's Claude Code CLI
// conversations so they can be imported into the app's thread sidebar.
//
// Claude Code stores one JSONL file per session at
//   ~/.claude/projects/<escaped-cwd>/<session-id>.jsonl
// where <escaped-cwd> is the absolute project path with every '/' replaced by
// '-' (verified against the real store; see flow/resources/claude-resume-spike.md).
//
// This module is READ-ONLY against ~/.claude — the app must never modify Claude
// Code's session files. `parseSession` is pure (operates on lines) so it is
// unit-tested without touching the filesystem.

import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** A message extracted from a session, keeping its original Claude timestamp. */
export interface ParsedMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

/** A parsed Claude Code session ready to import as a thread. */
export interface ParsedSession {
  sessionId: string
  title: string
  messages: ParsedMessage[]
  createdAt: string
  updatedAt: string
}

/** Cap a single message's stored content so a giant turn can't bloat the DB. */
const MAX_MESSAGE_CONTENT = 8_000
/** Cap the short argument shown in a tool-call marker. */
const MAX_TOOL_ARG = 80
const DEFAULT_TITLE = 'Claude Code session'

// Non-conversation line types (mode, permission-mode, file-history-snapshot,
// attachment, system, queue-operation, last-prompt, ai-title) are skipped
// implicitly: only `user`/`assistant` turns become messages, and `ai-title` is
// handled separately for the title.

/**
 * Map an absolute project path to Claude Code's escaped directory name: every
 * '/' becomes '-'. A trailing slash is stripped first so `/a/b` and `/a/b/`
 * map identically.
 */
export function escapeProjectPath(rootPath: string): string {
  const trimmed = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath
  return trimmed.replace(/\//g, '-')
}

/** Absolute path to a project's Claude Code session directory. */
export function claudeProjectDir(rootPath: string): string {
  return join(homedir(), '.claude', 'projects', escapeProjectPath(rootPath))
}

/**
 * List a project's Claude Code session files (absolute paths to `*.jsonl`).
 * Returns [] when the directory does not exist — never throws for a missing
 * project (a project simply may have no Claude Code history).
 */
export function listSessionFiles(rootPath: string): string[] {
  const dir = claudeProjectDir(rootPath)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.filter((name) => name.endsWith('.jsonl')).map((name) => join(dir, name))
}

/**
 * The session id a file carries in its name: sessions live at
 * `<session-id>.jsonl`, so the basename is the id without opening the file.
 * For a file named some other way this returns a string no store lookup will
 * match — callers fall back to the parsed sessionId.
 */
export function sessionIdFromFileName(filePath: string): string {
  return basename(filePath, '.jsonl')
}

/**
 * Read + parse a single session file. Returns null if unreadable or empty.
 * Async so a large transcript never blocks the main process on I/O (#1667).
 */
export async function readSessionFile(filePath: string): Promise<ParsedSession | null> {
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  return parseSession(text.split('\n'))
}

/**
 * Parse the JSONL lines of one Claude Code session into an importable shape.
 *
 * - Malformed lines and noise types are skipped (never fatal — NFR3).
 * - `user`/`assistant` turns become messages; content is joined `text` parts
 *   plus a compact one-line marker per tool call (tool RESULTS are omitted).
 * - A turn whose content is empty after extraction (e.g. a user turn that only
 *   carries tool_result feedback) is dropped.
 * - title = latest `ai-title` → else first user message → else a default.
 * - Returns null when the session has zero usable messages.
 */
export function parseSession(lines: string[]): ParsedSession | null {
  const messages: ParsedMessage[] = []
  let sessionId = ''
  let aiTitle = ''
  let firstTimestamp = ''
  let lastTimestamp = ''

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue // malformed line — skip, don't fail the session
    }
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const type = record['type']

    if (typeof record['sessionId'] === 'string' && !sessionId) {
      sessionId = record['sessionId']
    }

    if (type === 'ai-title') {
      if (typeof record['aiTitle'] === 'string' && record['aiTitle'].trim()) {
        aiTitle = record['aiTitle'].trim()
      }
      continue
    }

    if (type !== 'user' && type !== 'assistant') continue // noise or unknown

    const message = record['message']
    if (typeof message !== 'object' || message === null) continue
    const role = (message as Record<string, unknown>)['role']
    if (role !== 'user' && role !== 'assistant') continue

    const content = extractContent((message as Record<string, unknown>)['content'])
    const timestamp = typeof record['timestamp'] === 'string' ? record['timestamp'] : ''
    if (timestamp) {
      if (!firstTimestamp) firstTimestamp = timestamp
      lastTimestamp = timestamp
    }
    if (!content) continue // empty turn (e.g. tool_result-only) — drop

    messages.push({
      role,
      content: content.slice(0, MAX_MESSAGE_CONTENT),
      createdAt: timestamp || firstTimestamp || new Date(0).toISOString(),
    })
  }

  if (messages.length === 0) return null

  const created = firstTimestamp || messages[0]!.createdAt
  const updated = lastTimestamp || messages[messages.length - 1]!.createdAt
  return {
    sessionId,
    title: aiTitle || firstUserTitle(messages) || DEFAULT_TITLE,
    messages,
    createdAt: created,
    updatedAt: updated,
  }
}

/** Extract readable text from a message's `content` (string OR parts array). */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const pieces: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const p = part as Record<string, unknown>
    if (p['type'] === 'text' && typeof p['text'] === 'string') {
      const text = p['text'].trim()
      if (text) pieces.push(text)
    } else if (p['type'] === 'tool_use' && typeof p['name'] === 'string') {
      pieces.push(`⤷ ${p['name']}: ${toolArg(p['name'], p['input'])}`)
    }
    // tool_result and any other part type: intentionally omitted (v1).
  }
  return pieces.join('\n').trim()
}

/** A compact argument for a tool-call marker, tool-aware where it helps. */
function toolArg(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  const preferred: Record<string, string> = {
    Bash: 'command',
    Edit: 'file_path',
    Write: 'file_path',
    MultiEdit: 'file_path',
    Read: 'file_path',
    NotebookEdit: 'notebook_path',
    Glob: 'pattern',
    Grep: 'pattern',
  }
  const key = preferred[name]
  const value = key && typeof record[key] === 'string' ? (record[key] as string) : firstString(record)
  return truncate(value.replace(/\s+/g, ' ').trim(), MAX_TOOL_ARG)
}

/** First string-valued field of an object, or '' when there is none. */
function firstString(record: Record<string, unknown>): string {
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/** Derive a title from the first user message's first non-empty line. */
function firstUserTitle(messages: ParsedMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return ''
  const firstLine = firstUser.content.split('\n').find((l) => l.trim()) ?? ''
  return truncate(firstLine.trim(), 80)
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
