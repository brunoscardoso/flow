// connector-service — the ONE owner of connectors in main (plan_connectors,
// Phase 2; allowed-pattern #14). Everything the renderer can learn or change
// about a connector goes through here:
//
//   • the list, with source and status (note 1) — status from the chat's live
//     query or the held status query (connector-status.ts), merged with
//     Claude's files (external-mcp.ts), each chat's off list and the account's
//     ask-first marks; the files alone when the status cannot be read;
//   • writes to Claude's own files (connector-config-writer.ts, note 2);
//   • each chat's off list (ThreadStore, migration v43) and its live toggle
//     (AgentManager, note 3);
//   • ask-first marks (app settings) and the permission lookup (note 4);
//   • each connector's icon (connector-icons.ts, note 6), looked up from the
//     project's last list;
//   • sign-in, sign-out and cancel (connector-sign-in.ts, Phase 5).
//
// Nothing here blocks: every read of status is async and time-limited, and the
// file reads are small and fail-soft. No secret leaves: entries are built by
// connector-model.ts, which never copies env, headers or a program's command.

import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'

import type {
  ConnectorChangeEvent,
  ConnectorEntry,
  ConnectorIconAnswer,
  ConnectorIconTheme,
  ConnectorListAnswer,
  ConnectorScope,
  ConnectorSignInAnswer,
  ConnectorWriteAnswer,
} from '../../shared/connectors'
import type { ScopedExternalMcpServer } from '../agent/external-mcp'
import { FLOW_MCP_SERVER_NAME } from '../agent/board-tools/board-tools-shared'
import {
  writeConnectorEntry,
  type ConnectorChange,
  type ConnectorConfig,
  type ConnectorTarget,
  type WriteResult,
} from './connector-config-writer'
import { buildConnectorList } from './connector-model'
import type { ConnectorSignIn } from './connector-sign-in'
import { ConnectorStatusTimeout, statusKey, type StatusContext } from './connector-status'

/** The account key for the inherited login (no account folder). */
export const INHERITED_ACCOUNT_KEY = 'inherited'

export type ConnectorContextAnswer =
  | { ok: true; configDir: string | null; env: NodeJS.ProcessEnv | undefined }
  | { ok: false; reason: string }

export interface ConnectorServiceDeps {
  status: {
    status(context: StatusContext, threadId?: string): Promise<McpServerStatus[]>
    reconnect(context: StatusContext, name: string, threadId?: string): Promise<void>
    close(key: string): void
    closeAll(): void
  }
  /** Who a session for this project runs as (AgentManager.connectorContext). */
  contextFor: (projectRoot: string) => ConnectorContextAnswer
  /** Claude's files, with the scope each entry came from. */
  loadScoped: (projectRoot: string, configDir: string | undefined) => Record<string, ScopedExternalMcpServer>
  threads: {
    getThread(id: string): { projectRoot: string } | null
    getConnectorsOff(id: string): string[]
    setConnectorsOff(id: string, names: readonly string[]): void
  }
  askFirst: {
    get(account: string, connector: string): string[]
    set(account: string, connector: string, tool: string, on: boolean): void
  }
  /** Toggle on the chat's live session, best effort (AgentManager.applyThreadConnector). */
  applyThreadConnector: (threadId: string, name: string, on: boolean) => Promise<void>
  /** Broadcast `connectors:changed`. */
  onChanged: (change: ConnectorChangeEvent) => void
  /** The icon resolver (resolveConnectorIcon, bound to the app's cache). */
  resolveIcon: (entry: ConnectorEntry, theme: ConnectorIconTheme) => Promise<string | null>
  /** Sign-in, sign-out and cancel. */
  signIn: Pick<ConnectorSignIn, 'signIn' | 'signOut' | 'cancel' | 'dispose'>
  /** The writer; injectable so tests never touch a real file. */
  write?: (target: ConnectorTarget, change: ConnectorChange) => Promise<WriteResult>
}

/**
 * The server part of a connector's tool names. The runtime builds tool names
 * as `mcp__<server>__<tool>` with every character outside letters, digits,
 * `_` and `-` replaced by `_` (a Claude.ai "claude.ai Linear" becomes
 * `claude_ai_Linear`), so ask-first marks are kept under this form.
 */
export function toolPrefixName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Every (server, tool) split of a connector tool name. A server name may hold
 * `__` itself, so each split point is a candidate; the mark decides.
 */
export function connectorToolSplits(toolName: string): Array<{ server: string; tool: string }> {
  if (!toolName.startsWith('mcp__')) return []
  const rest = toolName.slice('mcp__'.length)
  const splits: Array<{ server: string; tool: string }> = []
  let index = rest.indexOf('__')
  while (index > 0) {
    const tool = rest.slice(index + 2)
    if (tool !== '') splits.push({ server: rest.slice(0, index), tool })
    index = rest.indexOf('__', index + 1)
  }
  return splits
}

function accountKeyOf(configDir: string | null): string {
  return configDir ?? INHERITED_ACCOUNT_KEY
}

function statusErrorSentence(error: unknown): string {
  return error instanceof ConnectorStatusTimeout
    ? 'Connector status took too long to answer. The list shows what is set up, not whether it works.'
    : 'Connector status could not be read. The list shows what is set up, not whether it works.'
}

const MAX_REMEMBERED_PROJECTS = 32

export class ConnectorService {
  readonly #deps: ConnectorServiceDeps
  /** Each project's last listed entries — what an icon or a sign-in is looked up in. */
  readonly #lastEntries = new Map<string, ConnectorEntry[]>()

  constructor(deps: ConnectorServiceDeps) {
    this.#deps = deps
  }

  /** The project a request is about: the chat's own project when a chat is named. */
  #projectOf(projectRoot: string, threadId: string | undefined): string {
    if (threadId === undefined) return projectRoot
    return this.#deps.threads.getThread(threadId)?.projectRoot ?? projectRoot
  }

  #context(projectRoot: string): { ok: true; context: StatusContext } | { ok: false; reason: string } {
    const answer = this.#deps.contextFor(projectRoot)
    if (!answer.ok) return answer
    return { ok: true, context: { projectRoot, configDir: answer.configDir, env: answer.env } }
  }

  #files(projectRoot: string, configDir: string | null): Record<string, ScopedExternalMcpServer> {
    try {
      return this.#deps.loadScoped(projectRoot, configDir ?? undefined)
    } catch (error) {
      console.warn('[Connectors] reading connector files failed:', error)
      return {}
    }
  }

  /**
   * Every connector a session for this project and account would load, with
   * source, status, tools and — when a chat is named — that chat's on/off.
   * Never throws: a status that cannot be read falls back to the files, with
   * the reason as a sentence.
   */
  async listConnectors(projectRoot: string, threadId?: string): Promise<ConnectorListAnswer> {
    const project = this.#projectOf(projectRoot, threadId)
    const resolved = this.#context(project)
    if (!resolved.ok) return { entries: [], error: resolved.reason }
    const { context } = resolved
    const files = this.#files(project, context.configDir)
    const account = accountKeyOf(context.configDir)
    let offInThread: string[] | undefined
    if (threadId !== undefined) {
      try {
        offInThread = this.#deps.threads.getConnectorsOff(threadId)
      } catch {
        offInThread = []
      }
    }
    const overlay = {
      ...(offInThread !== undefined ? { offInThread } : {}),
      askFirst: (name: string) => this.#askFirstOf(account, name),
    }
    try {
      let statuses = await this.#deps.status.status(context, threadId)
      // A chat's live session runs with its off connectors DENIED, so it does
      // not report them at all. They must still be listed (as off) so the
      // person can turn them back on: take their status from the project's
      // own held query, which runs without the chat's deny list.
      const missing = (offInThread ?? []).filter((name) => !statuses.some((status) => status.name === name))
      if (threadId !== undefined && missing.length > 0) {
        try {
          const project = await this.#deps.status.status(context)
          statuses = [...statuses, ...project.filter((status) => missing.includes(status.name))]
        } catch (error) {
          console.warn('[Connectors] could not read the project status for off connectors:', error)
        }
      }
      for (const status of statuses) {
        if (status.status === 'failed' && typeof status.error === 'string') {
          // The runtime's own text is not shown (it can name a program or a
          // path); it is kept here for whoever is debugging.
          console.warn(`[Connectors] ${status.name} failed:`, status.error)
        }
      }
      return { entries: this.#remember(project, buildConnectorList(statuses, files, overlay)) }
    } catch (error) {
      console.warn('[Connectors] status read failed:', error)
      return { entries: this.#remember(project, buildConnectorList(null, files, overlay)), error: statusErrorSentence(error) }
    }
  }

  #remember(project: string, entries: ConnectorEntry[]): ConnectorEntry[] {
    this.#lastEntries.delete(project)
    this.#lastEntries.set(project, entries)
    while (this.#lastEntries.size > MAX_REMEMBERED_PROJECTS) {
      const oldest = this.#lastEntries.keys().next().value
      if (oldest === undefined) break
      this.#lastEntries.delete(oldest)
    }
    return entries
  }

  #lastEntry(project: string, name: string): ConnectorEntry | null {
    return this.#lastEntries.get(project)?.find((entry) => entry.name === name) ?? null
  }

  /**
   * One connector's icon for a theme, from the project's last list. A
   * connector not listed yet answers null (the renderer draws the initial);
   * nothing here opens a status query.
   */
  async icon(projectRoot: string, name: string, theme: ConnectorIconTheme): Promise<ConnectorIconAnswer> {
    const entry = this.#lastEntry(projectRoot, name)
    if (entry === null) return { dataUri: null }
    try {
      return { dataUri: await this.#deps.resolveIcon(entry, theme) }
    } catch (error) {
      console.warn('[Connectors] resolving an icon failed:', error)
      return { dataUri: null }
    }
  }

  /**
   * A project's entries: its last list's when it was listed, else a fresh
   * list's — what the Settings suggestions are chosen from. The section asks
   * right after listing, so this normally opens no status query.
   */
  async entriesFor(projectRoot: string): Promise<ConnectorEntry[]> {
    const remembered = this.#lastEntries.get(projectRoot)
    if (remembered !== undefined) return remembered
    return (await this.listConnectors(projectRoot)).entries
  }

  /** The entry a sign-in is about: the last list's, else a fresh list's. */
  async #entryForSignIn(project: string, name: string, threadId: string | undefined): Promise<ConnectorEntry | null> {
    const remembered = this.#lastEntry(project, name)
    if (remembered !== null) return remembered
    const answer = await this.listConnectors(project, threadId)
    return answer.entries.find((entry) => entry.name === name) ?? null
  }

  /** Start signing in to one connector (opens the browser; watched in main). */
  async signIn(projectRoot: string, name: string, threadId?: string): Promise<ConnectorSignInAnswer> {
    const project = this.#projectOf(projectRoot, threadId)
    const resolved = this.#context(project)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    const entry = await this.#entryForSignIn(project, name, threadId)
    if (entry === null) return { ok: false, reason: 'That connector is no longer set up for this project.' }
    return this.#deps.signIn.signIn(resolved.context, { name: entry.name, transport: entry.transport }, threadId)
  }

  /**
   * Sign out of one connector. `confirmed` must be the literal `true` a
   * person's confirmation produced (forbidden-pattern #15).
   */
  async signOut(projectRoot: string, name: string, confirmed: unknown, threadId?: string): Promise<ConnectorWriteAnswer> {
    if (confirmed !== true) return { ok: false, reason: 'Signing out of a connector needs an explicit confirmation.' }
    const project = this.#projectOf(projectRoot, threadId)
    const resolved = this.#context(project)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    const entry = await this.#entryForSignIn(project, name, threadId)
    if (entry === null) return { ok: false, reason: 'That connector is no longer set up for this project.' }
    return this.#deps.signIn.signOut(resolved.context, { name: entry.name, transport: entry.transport }, true, threadId)
  }

  /** Stop waiting for a sign-in to finish. */
  cancelSignIn(projectRoot: string, name: string): ConnectorWriteAnswer {
    const resolved = this.#context(projectRoot)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    return this.#deps.signIn.cancel(resolved.context, name)
  }

  #askFirstOf(account: string, name: string): string[] {
    try {
      return this.#deps.askFirst.get(account, toolPrefixName(name))
    } catch {
      return []
    }
  }

  #target(scope: ConnectorScope, context: StatusContext): ConnectorTarget {
    const configDir = context.configDir ?? undefined
    switch (scope) {
      case 'account':
        return { kind: 'account', configDir }
      case 'project-local':
        return { kind: 'project-local', configDir, projectRoot: context.projectRoot }
      case 'project-shared':
        return { kind: 'project-shared', projectRoot: context.projectRoot }
    }
  }

  async #write(
    projectRoot: string,
    scope: ConnectorScope,
    change: ConnectorChange,
  ): Promise<ConnectorWriteAnswer> {
    const resolved = this.#context(projectRoot)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    const write = this.#deps.write ?? writeConnectorEntry
    const result = await write(this.#target(scope, resolved.context), change)
    if (result.ok) {
      // The files changed: every held status query may now be describing a
      // list that no longer exists (an account entry reaches every project).
      this.#deps.status.closeAll()
      this.#deps.onChanged({ projectRoot })
    }
    return result
  }

  /** Add one connector to one of Claude's files. */
  add(projectRoot: string, scope: ConnectorScope, name: string, config: ConnectorConfig): Promise<ConnectorWriteAnswer> {
    return this.#write(projectRoot, scope, { add: { name, config } })
  }

  /**
   * Remove one connector from the file it came from. `confirmed` must be the
   * literal `true` a person's confirmation produced (forbidden-pattern #15).
   */
  async remove(projectRoot: string, scope: ConnectorScope, name: string, confirmed: unknown): Promise<ConnectorWriteAnswer> {
    if (confirmed !== true) return { ok: false, reason: 'Removing a connector needs an explicit confirmation.' }
    return this.#write(projectRoot, scope, { remove: name, confirmed: true })
  }

  /** Turn one connector on or off for one chat. Stored first; toggled live as a best effort. */
  async setForThread(threadId: string, name: string, on: boolean): Promise<ConnectorWriteAnswer> {
    if (name === FLOW_MCP_SERVER_NAME || name === '') return { ok: false, reason: 'That connector cannot be turned off.' }
    const thread = this.#deps.threads.getThread(threadId)
    if (thread === null) return { ok: false, reason: 'This conversation no longer exists.' }
    const off = new Set(this.#deps.threads.getConnectorsOff(threadId))
    if (on) off.delete(name)
    else off.add(name)
    this.#deps.threads.setConnectorsOff(threadId, [...off])
    try {
      await this.#deps.applyThreadConnector(threadId, name, on)
    } catch (error) {
      console.warn('[Connectors] live toggle failed; it applies from the next turn:', error)
    }
    this.#deps.onChanged({ projectRoot: thread.projectRoot, threadId })
    return { ok: true }
  }

  /** Try a connector again (Retry). */
  async reconnect(projectRoot: string, name: string, threadId?: string): Promise<ConnectorWriteAnswer> {
    const project = this.#projectOf(projectRoot, threadId)
    const resolved = this.#context(project)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    try {
      await this.#deps.status.reconnect(resolved.context, name, threadId)
    } catch (error) {
      console.warn('[Connectors] reconnect failed:', error)
      return {
        ok: false,
        reason:
          error instanceof ConnectorStatusTimeout
            ? 'The connector took too long to answer. Try again in a moment.'
            : 'The connector could not be reached. Try again in a moment.',
      }
    } finally {
      this.#deps.onChanged({ projectRoot: project, ...(threadId !== undefined ? { threadId } : {}) })
    }
    return { ok: true }
  }

  /** Mark or unmark one tool of a connector as ask-first, for this project's account. */
  setAskFirst(projectRoot: string, name: string, tool: string, on: boolean): ConnectorWriteAnswer {
    const resolved = this.#context(projectRoot)
    if (!resolved.ok) return { ok: false, reason: resolved.reason }
    this.#deps.askFirst.set(accountKeyOf(resolved.context.configDir), toolPrefixName(name), tool, on)
    this.#deps.onChanged({ projectRoot })
    return { ok: true }
  }

  /**
   * The permission broker's lookup (note 4): is this `mcp__<server>__<tool>`
   * marked ask-first for the thread's account? Sync and cheap — one settings
   * row per candidate split.
   */
  isAskFirst(threadId: string, toolName: string): boolean {
    const splits = connectorToolSplits(toolName)
    if (splits.length === 0) return false
    const thread = this.#deps.threads.getThread(threadId)
    if (thread === null) return false
    const answer = this.#deps.contextFor(thread.projectRoot)
    if (!answer.ok) return false
    const account = accountKeyOf(answer.configDir)
    return splits.some(({ server, tool }) => this.#deps.askFirst.get(account, server).includes(tool))
  }

  /** Close the held status query for one project (it left the screen, say). */
  closeStatus(projectRoot: string): void {
    const resolved = this.#context(projectRoot)
    if (resolved.ok) this.#deps.status.close(statusKey(resolved.context))
  }

  dispose(): void {
    this.#deps.signIn.dispose()
    this.#deps.status.closeAll()
  }
}
