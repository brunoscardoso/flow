// connector-status — where connector STATUS comes from (plan_connectors,
// Phase 2; spike: flow/brain/decisions/connector-sign-in.md).
//
// `mcpServerStatus()` needs a live SDK query. A chat with a running session
// answers from its own query. Anything else — the composer before the first
// message, Settings — uses ONE status-only query per (account, project): a
// query whose prompt never yields, so no message is sent and no tokens are
// spent, with the account's environment and the project root as its cwd. The
// runtime does its own discovery there (Claude.ai connectors, plugins), and the
// servers Flow hands every session are passed the same way, so the list
// matches what a session would load.
//
// COST. Opening one starts every program connector the project has, so a query
// is opened only on request (the list or Settings on screen, a sign-in) and
// closed after an idle time (allowed-pattern #17). Every call is time-limited
// and async; nothing here can hold the main process (allowed-pattern #19).
//
// `getQuery` is also the door for sign-in (Phase 5), which calls methods the
// SDK's types do not declare on the same query.

import type { McpServerConfig, McpServerStatus, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import type { QueryFunction } from '../agent/agent-manager'
import { NOT_ANSWERING } from './connector-model'

/** Who a status query runs as, and where. */
export interface StatusContext {
  projectRoot: string
  /** The account's config folder, or null for the inherited login. */
  configDir: string | null
  /** The environment a session for this project would run with (undefined = inherit). */
  env: NodeJS.ProcessEnv | undefined
}

export interface ConnectorStatusDeps {
  /** The SDK's query function, bound to the agent binary. */
  queryFn: () => Promise<QueryFunction>
  /** The servers Flow merges into every session for this project and account. */
  loadServers: (projectRoot: string, configDir: string | undefined) => Record<string, McpServerConfig>
  /** A running chat's own query, when it has one. */
  liveQueryFor?: (threadId: string) => Query | null
  idleMs?: number
  timeoutMs?: number
  /**
   * How long after a held query opened a read waits for servers still
   * starting. A fresh runtime answers every server as `pending` (no tools) for
   * its first half second or so — measured against the bundled SDK, ~600 ms for
   * a stdio server — and nothing would ever read it again while the list is on
   * screen, so the first answer is polled until it settles or this passes.
   */
  settleMs?: number
  pollMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** A status read that did not answer in time. */
export class ConnectorStatusTimeout extends Error {
  constructor() {
    super('The connector status did not answer in time.')
    this.name = 'ConnectorStatusTimeout'
  }
}


const DEFAULT_IDLE_MS = 2 * 60_000
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_SETTLE_MS = 8_000
const DEFAULT_POLL_MS = 250

interface HeldQuery {
  query: Query
  abort: AbortController
  idle: unknown
  /** When it was opened — a read soon after waits for servers still starting. */
  openedAt: number
}

/** A prompt that never yields: the query stays open for control requests only. */
function silentPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
            if (signal.aborted) {
              resolve({ value: undefined, done: true })
              return
            }
            signal.addEventListener('abort', () => resolve({ value: undefined, done: true }), { once: true })
          }),
        return: () => Promise.resolve({ value: undefined, done: true }),
      }
    },
  }
}

export function statusKey(context: Pick<StatusContext, 'projectRoot' | 'configDir'>): string {
  return `${context.configDir ?? ''}\u0000${context.projectRoot}`
}

export class ConnectorStatusService {
  readonly #deps: ConnectorStatusDeps
  readonly #held = new Map<string, HeldQuery>()
  readonly #opening = new Map<string, Promise<HeldQuery>>()

  constructor(deps: ConnectorStatusDeps) {
    this.#deps = deps
  }

  get #idleMs(): number {
    return this.#deps.idleMs ?? DEFAULT_IDLE_MS
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now()
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#setTimer(resolve, ms)
    })
  }

  get #timeoutMs(): number {
    return this.#deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  #setTimer(fn: () => void, ms: number): unknown {
    if (this.#deps.setTimer !== undefined) return this.#deps.setTimer(fn, ms)
    const handle = setTimeout(fn, ms)
    // An idle close must never keep the app alive on quit.
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
    return handle
  }

  #clearTimer(handle: unknown): void {
    if (handle === undefined || handle === null) return
    if (this.#deps.clearTimer !== undefined) this.#deps.clearTimer(handle)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
  }

  #touch(key: string, held: HeldQuery): void {
    this.#clearTimer(held.idle)
    held.idle = this.#setTimer(() => this.close(key), this.#idleMs)
  }

  async #open(context: StatusContext): Promise<HeldQuery> {
    const queryFn = await this.#deps.queryFn()
    const abort = new AbortController()
    let servers: Record<string, McpServerConfig> = {}
    try {
      servers = this.#deps.loadServers(context.projectRoot, context.configDir ?? undefined)
    } catch (error) {
      console.warn('[Connectors] reading configured servers failed:', error)
    }
    const options: Options = {
      cwd: context.projectRoot,
      settingSources: ['user', 'project', 'local'],
      ...(context.env !== undefined ? { env: context.env } : {}),
      ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
      abortController: abort,
      persistSession: false,
      permissionMode: 'default',
      // Nothing is ever asked of this query; anything that would run is refused.
      canUseTool: async () => ({ behavior: 'deny', message: 'Status only.' }),
    }
    const query = queryFn({ prompt: silentPrompt(abort.signal), options })
    // Drain whatever the runtime emits so its stream never backs up.
    void (async () => {
      try {
        for await (const _message of query) {
          // status-only: messages are not used
        }
      } catch {
        // closed or failed — the next call opens a fresh one
      }
    })()
    return { query, abort, idle: undefined, openedAt: this.#now() }
  }

  /**
   * The held status query for this account and project, opened on demand.
   * Sign-in (Phase 5) calls its undeclared methods through a narrow adapter.
   */
  async getQuery(context: StatusContext): Promise<Query> {
    const key = statusKey(context)
    const held = this.#held.get(key)
    if (held !== undefined) {
      this.#touch(key, held)
      return held.query
    }
    let opening = this.#opening.get(key)
    if (opening === undefined) {
      opening = this.#open(context)
      this.#opening.set(key, opening)
    }
    try {
      const opened = await opening
      if (!this.#held.has(key)) this.#held.set(key, opened)
      const current = this.#held.get(key) as HeldQuery
      this.#touch(key, current)
      return current.query
    } finally {
      if (this.#opening.get(key) === opening) this.#opening.delete(key)
    }
  }

  /**
   * The query a sign-in talks to: the chat's live one when it has one, else
   * the held one (opened on demand, its idle time restarted).
   */
  async queryFor(context: StatusContext, threadId?: string): Promise<Query> {
    return (await this.#queryFor(context, threadId)).query
  }

  /** The query to ask: the chat's live one when it has one, else the held one. */
  async #queryFor(context: StatusContext, threadId?: string): Promise<{ query: Query; held: boolean }> {
    if (threadId !== undefined) {
      const live = this.#deps.liveQueryFor?.(threadId) ?? null
      if (live !== null) return { query: live, held: false }
    }
    return { query: await this.getQuery(context), held: true }
  }

  async #limited<T>(work: Promise<T>): Promise<T> {
    let timer: unknown
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.#setTimer(() => reject(new ConnectorStatusTimeout()), this.#timeoutMs)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      this.#clearTimer(timer)
    }
  }

  /** Every server's status, time-limited. A failed or late held query is closed. */
  async status(context: StatusContext, threadId?: string): Promise<McpServerStatus[]> {
    const { query, held } = await this.#limited(this.#queryFor(context, threadId))
    try {
      let statuses = await this.#limited(query.mcpServerStatus())
      // A held query opened moments ago reports its servers as still starting;
      // wait for them (bounded) rather than show "pending" until the list is
      // reopened. A chat's live query is asked once, as it is.
      const openedAt = held ? this.#held.get(statusKey(context))?.openedAt : undefined
      const settleMs = this.#deps.settleMs ?? DEFAULT_SETTLE_MS
      while (
        openedAt !== undefined &&
        statuses.some((status) => status.status === 'pending') &&
        this.#now() - openedAt < settleMs
      ) {
        await this.#sleep(this.#deps.pollMs ?? DEFAULT_POLL_MS)
        statuses = await this.#limited(query.mcpServerStatus())
      }
      // Still starting after the whole window: it is not going to answer on its
      // own (a host this computer cannot reach hangs here for ever). Say so, so
      // the row offers Retry instead of "Starting" with no end (2026-11-18).
      if (openedAt !== undefined && this.#now() - openedAt >= settleMs) {
        statuses = statuses.map((status) =>
          status.status === 'pending' ? { ...status, status: 'failed', error: NOT_ANSWERING } : status,
        )
      }
      return statuses
    } catch (error) {
      if (held) this.close(statusKey(context))
      throw error
    }
  }

  /** Reconnect one server, on the chat's live query when it has one. */
  async reconnect(context: StatusContext, name: string, threadId?: string): Promise<void> {
    const { query, held } = await this.#limited(this.#queryFor(context, threadId))
    await this.#limited(query.reconnectMcpServer(name))
    // A reconnected server starts again: give it a fresh settle window.
    const entry = held ? this.#held.get(statusKey(context)) : undefined
    if (entry !== undefined) entry.openedAt = this.#now()
  }

  /** Close one held query (idle, failed, or an account change). */
  close(key: string): void {
    const held = this.#held.get(key)
    if (held === undefined) return
    this.#held.delete(key)
    this.#clearTimer(held.idle)
    try {
      held.abort.abort()
      held.query.close()
    } catch (error) {
      console.warn('[Connectors] closing a status query failed:', error)
    }
  }

  /** Close every held query — the configs changed, or the app is quitting. */
  closeAll(): void {
    for (const key of [...this.#held.keys()]) this.close(key)
  }
}
