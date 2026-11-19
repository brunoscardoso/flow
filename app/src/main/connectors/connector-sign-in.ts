// connector-sign-in — Sign in and Sign out for a connector (plan_connectors,
// Phase 5; path (b) of flow/brain/decisions/connector-sign-in.md).
//
// Claude Code signs in itself. The SDK's `Query` has methods its type file
// does not declare — `mcpAuthenticate(serverName, redirectUri?)` and
// `mcpClearAuth(serverName)` — and they are reached ONLY through the narrow
// adapter below, which checks at run time that each method exists and that
// its answer has the expected shape. Flow stores no token: Claude Code keeps
// it in its own store for the account, so Flow and the terminal share one
// sign-in. No `redirectUri` is passed — Claude Code then runs its own
// localhost callback and Flow only opens the address in the browser.
//
//   • `callbackExpected: true` — the browser is opened and the sign-in is
//     watched: the server's status is read every ~2 s, up to ~5 min, stopping
//     early when it is connected or the person cancels. Then the server is
//     reconnected and `connectors:changed` carries how it ended.
//   • `callbackExpected: false` (a Claude.ai connector) — the person finishes
//     on Claude.ai, and the renderer offers a reconnect when they are back.
//
// Sign out revokes the stored sign-in only when the call carries the literal
// `confirmed: true` a person's confirmation produced (forbidden-pattern #15).

import type { McpServerStatus, Query } from '@anthropic-ai/claude-agent-sdk'

import type {
  ConnectorChangeEvent,
  ConnectorSignInAnswer,
  ConnectorSignInOutcome,
  ConnectorTransport,
  ConnectorWriteAnswer,
} from '../../shared/connectors'
import { statusKey, type StatusContext } from './connector-status'

/** The SDK cannot sign in here (its methods are missing). Carries the sentence shown. */
export class ConnectorSignInUnavailable extends Error {
  constructor() {
    super('Flow cannot start sign-in for this connector. Sign in to it outside Flow, then try again.')
    this.name = 'ConnectorSignInUnavailable'
  }
}

/** A call to the runtime that did not answer in time. */
export class ConnectorSignInTimeout extends Error {
  constructor() {
    super('The connector did not answer in time.')
    this.name = 'ConnectorSignInTimeout'
  }
}

export interface McpAuthAnswer {
  authUrl?: string
  requiresUserAction: boolean
  callbackExpected: boolean
}

type UntypedQuery = Record<string, unknown>

function methodOf(query: Query, name: string): ((...args: unknown[]) => unknown) | null {
  const candidate = (query as unknown as UntypedQuery)[name]
  return typeof candidate === 'function' ? (candidate as (...args: unknown[]) => unknown).bind(query) : null
}

/** True when this query can sign in and out (the runtime has the methods). */
export function canSignIn(query: Query): boolean {
  return methodOf(query, 'mcpAuthenticate') !== null && methodOf(query, 'mcpClearAuth') !== null
}

/**
 * Start Claude Code's own sign-in for one server. No redirect address is
 * passed: Claude Code then runs its own localhost callback.
 */
export async function mcpAuthenticate(query: Query, serverName: string): Promise<McpAuthAnswer> {
  const method = methodOf(query, 'mcpAuthenticate')
  if (method === null) throw new ConnectorSignInUnavailable()
  const raw = (await method(serverName)) as unknown
  if (typeof raw !== 'object' || raw === null) throw new ConnectorSignInUnavailable()
  const record = raw as Record<string, unknown>
  const authUrl = typeof record['authUrl'] === 'string' && record['authUrl'] !== '' ? record['authUrl'] : undefined
  const requiresUserAction = record['requiresUserAction'] === true || (record['requiresUserAction'] === undefined && authUrl !== undefined)
  const callbackExpected = record['callbackExpected'] !== false
  return { ...(authUrl !== undefined ? { authUrl } : {}), requiresUserAction, callbackExpected }
}

/** Revoke one server's stored sign-in. */
export async function mcpClearAuth(query: Query, serverName: string): Promise<void> {
  const method = methodOf(query, 'mcpClearAuth')
  if (method === null) throw new ConnectorSignInUnavailable()
  await method(serverName)
}

/** Reconnect one server (typed on the SDK's Query). */
export async function reconnectMcpServer(query: Query, serverName: string): Promise<void> {
  await query.reconnectMcpServer(serverName)
}

/** Only a browser address may be opened: https, or http on this computer. */
export function isOpenableAuthUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:') return true
    return parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
  } catch {
    return false
  }
}

export interface ConnectorSignInDeps {
  /** The chat's live query when a chat is named and running, else the held status query. */
  queryFor: (context: StatusContext, threadId?: string) => Promise<Query>
  /** Electron's shell.openExternal. */
  openExternal: (url: string) => Promise<void>
  /** Broadcast `connectors:changed`. */
  onChanged: (change: ConnectorChangeEvent) => void
  pollMs?: number
  maxWaitMs?: number
  callTimeoutMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** What a sign-in needs to know about the connector. */
export interface SignInTarget {
  name: string
  transport: ConnectorTransport
}

const DEFAULT_POLL_MS = 2_000
const DEFAULT_MAX_WAIT_MS = 5 * 60_000
const DEFAULT_CALL_TIMEOUT_MS = 30_000

const PROGRAM_SENTENCE = 'This connector runs on this computer and has no sign-in.'

interface Watch {
  token: number
  timer: unknown
}

function sentenceOf(error: unknown, fallback: string): string {
  if (error instanceof ConnectorSignInUnavailable) return error.message
  if (error instanceof ConnectorSignInTimeout) return 'The connector took too long to answer. Try again in a moment.'
  return fallback
}

export class ConnectorSignIn {
  readonly #deps: ConnectorSignInDeps
  readonly #watches = new Map<string, Watch>()
  #nextToken = 1

  constructor(deps: ConnectorSignInDeps) {
    this.#deps = deps
  }

  #setTimer(fn: () => void, ms: number): unknown {
    if (this.#deps.setTimer !== undefined) return this.#deps.setTimer(fn, ms)
    const handle = setTimeout(fn, ms)
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
    return handle
  }

  #clearTimer(handle: unknown): void {
    if (handle === undefined || handle === null) return
    if (this.#deps.clearTimer !== undefined) this.#deps.clearTimer(handle)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  async #limited<T>(work: Promise<T>): Promise<T> {
    let timer: unknown
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.#setTimer(() => reject(new ConnectorSignInTimeout()), this.#deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      this.#clearTimer(timer)
    }
  }

  #key(context: StatusContext, name: string): string {
    return `${statusKey(context)}\u0000${name}`
  }

  #changed(context: StatusContext, threadId: string | undefined, signIn?: ConnectorChangeEvent['signIn']): void {
    this.#deps.onChanged({
      projectRoot: context.projectRoot,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(signIn !== undefined ? { signIn } : {}),
    })
  }

  /** True while a sign-in for this connector is being watched. */
  isWaiting(context: StatusContext, name: string): boolean {
    return this.#watches.has(this.#key(context, name))
  }

  /** Start signing in to one connector. Never throws. */
  async signIn(context: StatusContext, target: SignInTarget, threadId?: string): Promise<ConnectorSignInAnswer> {
    if (target.transport === 'program') return { ok: false, reason: PROGRAM_SENTENCE }
    let query: Query
    let answer: McpAuthAnswer
    try {
      query = await this.#limited(this.#deps.queryFor(context, threadId))
      answer = await this.#limited(mcpAuthenticate(query, target.name))
    } catch (error) {
      console.warn('[Connectors] starting sign-in failed:', error)
      return { ok: false, reason: sentenceOf(error, 'Sign-in could not be started. Try again in a moment.') }
    }

    if (!answer.requiresUserAction || answer.authUrl === undefined) {
      // Already signed in: reconnect so the session picks it up.
      try {
        await this.#limited(reconnectMcpServer(query, target.name))
      } catch (error) {
        console.warn('[Connectors] reconnect after sign-in failed:', error)
      }
      this.#changed(context, threadId, { name: target.name, outcome: 'connected' })
      return { ok: true, state: 'connected' }
    }

    if (!isOpenableAuthUrl(answer.authUrl)) {
      console.warn('[Connectors] refused to open a sign-in address that is not a web address')
      return { ok: false, reason: 'The connector asked to open an address Flow will not open.' }
    }
    try {
      await this.#deps.openExternal(answer.authUrl)
    } catch (error) {
      console.warn('[Connectors] opening the browser failed:', error)
      return { ok: false, reason: 'Flow could not open your browser to sign in. Try again.' }
    }

    if (!answer.callbackExpected) return { ok: true, state: 'finish-in-browser' }
    this.#watch(context, target.name, threadId)
    return { ok: true, state: 'waiting' }
  }

  /** Watch one sign-in until it connects, times out or is cancelled. */
  #watch(context: StatusContext, name: string, threadId: string | undefined): void {
    const key = this.#key(context, name)
    const previous = this.#watches.get(key)
    if (previous !== undefined) this.#clearTimer(previous.timer)
    const token = this.#nextToken++
    const deadline = this.#now() + (this.#deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)
    const pollMs = this.#deps.pollMs ?? DEFAULT_POLL_MS
    const watch: Watch = { token, timer: undefined }
    this.#watches.set(key, watch)

    const current = (): boolean => this.#watches.get(key)?.token === token
    const finish = (outcome: ConnectorSignInOutcome): void => {
      if (!current()) return
      this.#watches.delete(key)
      this.#changed(context, threadId, { name, outcome })
    }
    const tick = async (): Promise<void> => {
      if (!current()) return
      if (this.#now() >= deadline) {
        finish('timed-out')
        return
      }
      try {
        // Asked for again on every tick: it keeps a held query from closing
        // while idle, and follows a chat whose session started meanwhile.
        const query = await this.#limited(this.#deps.queryFor(context, threadId))
        const statuses: McpServerStatus[] = await this.#limited(query.mcpServerStatus())
        if (!current()) return
        if (statuses.find((status) => status.name === name)?.status === 'connected') {
          try {
            await this.#limited(reconnectMcpServer(query, name))
          } catch (error) {
            console.warn('[Connectors] reconnect after sign-in failed:', error)
          }
          finish('connected')
          return
        }
      } catch (error) {
        console.warn('[Connectors] reading sign-in status failed; trying again:', error)
      }
      if (!current()) return
      watch.timer = this.#setTimer(() => void tick(), pollMs)
    }
    watch.timer = this.#setTimer(() => void tick(), pollMs)
  }

  /** Stop watching a sign-in (the person pressed Cancel). */
  cancel(context: StatusContext, name: string, threadId?: string): ConnectorWriteAnswer {
    const key = this.#key(context, name)
    const watch = this.#watches.get(key)
    if (watch !== undefined) {
      this.#clearTimer(watch.timer)
      this.#watches.delete(key)
      this.#changed(context, threadId, { name, outcome: 'cancelled' })
    }
    return { ok: true }
  }

  /**
   * Sign out of one connector. `confirmed` must be the literal `true` a
   * person's confirmation produced; anything else does nothing.
   */
  async signOut(
    context: StatusContext,
    target: SignInTarget,
    confirmed: unknown,
    threadId?: string,
  ): Promise<ConnectorWriteAnswer> {
    if (confirmed !== true) return { ok: false, reason: 'Signing out of a connector needs an explicit confirmation.' }
    if (target.transport === 'program') return { ok: false, reason: PROGRAM_SENTENCE }
    try {
      const query = await this.#limited(this.#deps.queryFor(context, threadId))
      await this.#limited(mcpClearAuth(query, target.name))
      try {
        await this.#limited(reconnectMcpServer(query, target.name))
      } catch (error) {
        console.warn('[Connectors] reconnect after sign-out failed:', error)
      }
    } catch (error) {
      console.warn('[Connectors] sign-out failed:', error)
      return { ok: false, reason: sentenceOf(error, 'Signing out did not finish. Try again in a moment.') }
    }
    this.#changed(context, threadId)
    return { ok: true }
  }

  /** Stop every watch (the app is quitting). Nothing is broadcast. */
  dispose(): void {
    for (const watch of this.#watches.values()) this.#clearTimer(watch.timer)
    this.#watches.clear()
  }
}
