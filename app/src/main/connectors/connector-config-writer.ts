// connector-config-writer — the ONE writer of connector entries in Claude's own
// files (plan_connectors, note 2). Flow keeps no connector store of its own:
// a connector added here is a connector the terminal sees too.
//
// THREE TARGETS, the same three external-mcp.ts reads:
//   account         <config>/.claude.json  → top-level `mcpServers`
//   project-local   <config>/.claude.json  → `projects[<projectRoot>].mcpServers`
//   project-shared  <projectRoot>/.mcp.json → `mcpServers`
//
// SURGICAL. `.claude.json` is a large, live file Claude Code also writes. A
// write reads it, changes exactly one entry, and leaves every other key — and
// the order of keys — as it found them (JSON.parse keeps insertion order for
// every non-numeric key, and nothing here sorts). The replacement is atomic: a
// temp file in the same folder, with the original's permissions, renamed over
// the original.
//
// REFUSE, NEVER MERGE. If the file changed between the read and the write
// (mtime, size or content), the write is abandoned and says so. A file that
// does not parse is refused too: rewriting it would destroy whatever the person
// or Claude Code was in the middle of.
//
// NO WORKING DEFAULT FOR REMOVE (forbidden-pattern #15). A removal happens only
// when the change carries `confirmed: true` literally; anything else returns a
// refusal before the file is even read.
//
// Every refusal is a sentence for a person: it names the place in words, never
// a path, a key or a command (forbidden-pattern #12).

import { createHash, randomBytes } from 'node:crypto'
import { promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

import { FLOW_MCP_SERVER_NAME } from '../agent/board-tools/board-tools-shared'
import { isExternalMcpServer } from '../agent/external-mcp'

/** Which of Claude's files, and which map inside it. */
export type ConnectorTarget =
  | { kind: 'account'; configDir: string | undefined }
  | { kind: 'project-local'; configDir: string | undefined; projectRoot: string }
  | { kind: 'project-shared'; projectRoot: string }

/** A connector config as Claude's files hold it (never the in-process `sdk` kind). */
export type ConnectorConfig = Exclude<McpServerConfig, { type: 'sdk' }>

export type ConnectorChange =
  | { add: { name: string; config: ConnectorConfig } }
  | { remove: string; confirmed: true }

export type WriteResult = { ok: true } | { ok: false; reason: string }

/** Injectable fs so tests write temp folders, never the developer's own files. */
export interface ConnectorWriterFs {
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  stat(path: string): Promise<{ mtimeMs: number; size: number; mode: number }>
  realpath(path: string): Promise<string>
  homedir(): string
}

export const nodeConnectorWriterFs: ConnectorWriterFs = {
  readFile: (path) => fsPromises.readFile(path, 'utf8'),
  writeFile: async (path, data, mode) => {
    await fsPromises.writeFile(path, data, { encoding: 'utf8', mode, flag: 'wx' })
    // `mode` on create is masked by the umask; set it outright so a 0600 file
    // never comes back wider than it was.
    await fsPromises.chmod(path, mode)
  },
  rename: (from, to) => fsPromises.rename(from, to),
  unlink: (path) => fsPromises.unlink(path),
  stat: async (path) => {
    const stats = await fsPromises.stat(path)
    return { mtimeMs: stats.mtimeMs, size: stats.size, mode: stats.mode }
  },
  realpath: (path) => fsPromises.realpath(path),
  homedir,
}

/** Connector names Claude accepts and that form a valid tool prefix. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
/** A new file is written owner-only: it may come to hold headers or env. */
const NEW_FILE_MODE = 0o600

/** The file a target writes. */
export function targetPath(target: ConnectorTarget, home: () => string = homedir): string {
  if (target.kind === 'project-shared') return join(target.projectRoot, '.mcp.json')
  const dir = target.configDir !== undefined && target.configDir !== '' ? target.configDir : home()
  return join(dir, '.claude.json')
}

/** The place, in words, for a refusal sentence. */
function placeOf(target: ConnectorTarget): string {
  switch (target.kind) {
    case 'account':
      return "this account's connector settings"
    case 'project-local':
      return "this project's private connector settings"
    case 'project-shared':
      return "this project's shared connector list"
  }
}

function refuse(reason: string): WriteResult {
  return { ok: false, reason }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The indent the file already uses (Claude Code writes two spaces). */
function indentOf(text: string): string | number {
  const match = /^[{[]\r?\n([ \t]+)\S/.exec(text)
  return match?.[1] ?? 2
}

/** Is this name one a person may add? A sentence when not, null when fine. */
export function nameProblem(name: string): string | null {
  if (name.toLowerCase() === FLOW_MCP_SERVER_NAME) return 'That name is reserved for Flow. Choose another name.'
  if (!NAME_PATTERN.test(name)) {
    return 'A connector name uses letters, numbers, dashes and underscores only, up to 64 characters.'
  }
  return null
}

/**
 * Change exactly one connector entry in the target file. Never throws: every
 * failure is a refusal with a sentence, and a refusal means nothing changed.
 */
export async function writeConnectorEntry(
  target: ConnectorTarget,
  change: ConnectorChange,
  fs: ConnectorWriterFs = nodeConnectorWriterFs,
): Promise<WriteResult> {
  // Forbidden-pattern #15: no confirmation, no read, no write.
  const removing = 'remove' in change
  if (removing && (change as { confirmed?: unknown }).confirmed !== true) {
    return refuse('Removing a connector needs an explicit confirmation.')
  }
  const name = removing ? change.remove : change.add.name
  if (typeof name !== 'string' || name === '') return refuse('A connector needs a name.')
  if (!removing) {
    const problem = nameProblem(name)
    if (problem !== null) return refuse(problem)
    if (!isExternalMcpServer(change.add.config)) {
      return refuse('This connector needs a web address or a program to run.')
    }
  }
  if (target.kind !== 'account' && (typeof target.projectRoot !== 'string' || target.projectRoot === '')) {
    return refuse('Flow could not tell which project this connector belongs to.')
  }

  const place = placeOf(target)
  let path = targetPath(target, () => fs.homedir())
  // Write through a link to the real file, so a linked settings file stays a
  // link instead of being replaced by a copy.
  try {
    path = await fs.realpath(path)
  } catch {
    // Missing file: written at its own path below.
  }

  // ── Read ─────────────────────────────────────────────────────────────
  let original: string | null
  let before: { mtimeMs: number; size: number; mode: number } | null
  try {
    before = await fs.stat(path)
    original = await fs.readFile(path)
  } catch (error) {
    if (!isMissing(error)) return refuse(`Flow could not read ${place}, so nothing was changed.`)
    before = null
    original = null
  }

  let document: Record<string, unknown>
  if (original === null || original.trim() === '') {
    if (removing) return refuse('This connector is no longer there.')
    document = {}
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(original)
    } catch {
      return refuse(`Flow could not understand ${place}, so nothing was changed.`)
    }
    if (!isPlainObject(parsed)) return refuse(`Flow could not understand ${place}, so nothing was changed.`)
    document = parsed
  }

  // ── Find the one map ─────────────────────────────────────────────────
  let holder: Record<string, unknown> = document
  if (target.kind === 'project-local') {
    const projects = document['projects']
    if (projects !== undefined && !isPlainObject(projects)) {
      return refuse(`Flow could not understand ${place}, so nothing was changed.`)
    }
    const projectMap = projects ?? {}
    const entry = projectMap[target.projectRoot]
    if (entry !== undefined && !isPlainObject(entry)) {
      return refuse(`Flow could not understand ${place}, so nothing was changed.`)
    }
    if (entry === undefined) {
      if (removing) return refuse('This connector is no longer there.')
      projectMap[target.projectRoot] = {}
    }
    if (projects === undefined) document['projects'] = projectMap
    holder = projectMap[target.projectRoot] as Record<string, unknown>
  }
  const servers = holder['mcpServers']
  if (servers !== undefined && !isPlainObject(servers)) {
    return refuse(`Flow could not understand ${place}, so nothing was changed.`)
  }

  // ── Change it ────────────────────────────────────────────────────────
  if (removing) {
    if (servers === undefined || !Object.prototype.hasOwnProperty.call(servers, name)) {
      return refuse('This connector is no longer there.')
    }
    delete servers[name]
  } else {
    const map = servers ?? {}
    if (Object.prototype.hasOwnProperty.call(map, name)) {
      return refuse('A connector with this name is already there. Choose another name, or remove that one first.')
    }
    map[name] = change.add.config
    if (servers === undefined) holder['mcpServers'] = map
  }

  const trailingNewline = original === null || original.endsWith('\n')
  const next = JSON.stringify(document, null, original === null ? 2 : indentOf(original)) + (trailingNewline ? '\n' : '')

  // ── Write: temp file beside it, check, rename ────────────────────────
  const temp = join(dirname(path), `.${basename(path)}.flow-${randomBytes(6).toString('hex')}.tmp`)
  try {
    await fs.writeFile(temp, next, before === null ? NEW_FILE_MODE : before.mode & 0o777)
  } catch {
    await fs.unlink(temp).catch(() => undefined)
    return refuse(`Flow could not save ${place}, so nothing was changed.`)
  }

  const changed = await changedSinceRead(path, before, original, fs)
  if (changed) {
    await fs.unlink(temp).catch(() => undefined)
    return refuse(`${capitalise(place)} changed while Flow was saving. Nothing was changed; try again.`)
  }

  try {
    await fs.rename(temp, path)
  } catch {
    await fs.unlink(temp).catch(() => undefined)
    return refuse(`Flow could not save ${place}, so nothing was changed.`)
  }
  return { ok: true }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Did the file change since it was read? Any doubt counts as changed. */
async function changedSinceRead(
  path: string,
  before: { mtimeMs: number; size: number } | null,
  original: string | null,
  fs: ConnectorWriterFs,
): Promise<boolean> {
  let now: { mtimeMs: number; size: number }
  try {
    now = await fs.stat(path)
  } catch (error) {
    // Missing now: unchanged only if it was missing before.
    return !(isMissing(error) && before === null)
  }
  if (before === null || original === null) return true
  if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) return true
  try {
    return hashOf(await fs.readFile(path)) !== hashOf(original)
  } catch {
    return true
  }
}
