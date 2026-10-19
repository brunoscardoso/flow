// LspManager — generic language-server lifecycle for the Flow main process.
//
// DESIGN DECISION (plan "Ruled Out" note): no monaco-languageclient. This is a
// hand-rolled minimal LSP client — stdio JSON-RPC with Content-Length framing,
// initialize/initialized handshake, full-text document sync, and the three
// request kinds Flow v1 needs (hover / definition / completion) plus
// publishDiagnostics. Hand-rolling keeps the main bundle CJS-simple and this
// module Electron-free, so a plain Node harness can drive it end-to-end.
//
// Genericity: servers are pure config (`LanguageServerConfig`) — adding a
// language later means registering another config entry, not new code. One
// server process is spawned per (server, workspace root) pair, on demand: the
// first didOpen of a file whose extension matches. Crashed servers restart
// with exponential backoff and replay their open documents.
//
// Events:
//   LSP_DIAGNOSTICS_EVENT → LspDiagnosticsEvent (publishDiagnostics, absolute path)

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { extname, join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

// ── Server registry config ─────────────────────────────────────────────────

export interface LanguageServerConfig {
  /** Stable registry id, e.g. 'typescript'. */
  id: string
  /** Executable to spawn (absolute path or PATH-resolved). */
  command: string
  args: string[]
  /** Extra environment merged over process.env for the child. */
  env?: Record<string, string>
  /** Extensions (with dot, lowercase) this server handles, e.g. ['.ts']. */
  fileExtensions: string[]
  /**
   * Files whose presence at a workspace root marks it as a project for this
   * server (e.g. tsconfig.json). Empty/omitted → always spawn. When provided
   * and none exist at the root, the server is NOT spawned for that root.
   */
  rootMarkers?: string[]
  /** Extension (with dot) → LSP languageId. Unmapped extensions → 'plaintext'. */
  languageIds?: Record<string, string>
  /** Passed through on `initialize`. */
  initializationOptions?: unknown
}

// ── Minimal LSP wire types (only what Flow v1 consumes) ────────────────────

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

interface LspLocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange?: LspRange
}

export interface LspMarkupContent {
  kind: string
  value: string
}

type LspMarkedString = string | { language: string; value: string }

export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[]
  range?: LspRange
}

export interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | LspMarkupContent
  insertText?: string
  insertTextFormat?: number
  sortText?: string
  filterText?: string
}

interface LspCompletionList {
  isIncomplete: boolean
  items: LspCompletionItem[]
}

export interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: number | string
  source?: string
  message: string
}

interface PublishDiagnosticsParams {
  uri: string
  diagnostics: LspDiagnostic[]
}

// ── JSON-RPC envelope types ────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── Manager events ─────────────────────────────────────────────────────────

export const LSP_DIAGNOSTICS_EVENT = 'diagnostics'

export interface LspDiagnosticsEvent {
  serverId: string
  /** Workspace root the owning server was spawned for. */
  rootPath: string
  /** Absolute file path the diagnostics belong to. */
  path: string
  diagnostics: LspDiagnostic[]
}

// ── Tunables ───────────────────────────────────────────────────────────────

/** Per-request timeout — a hung server must not wedge editor features. */
const REQUEST_TIMEOUT_MS = 15_000
/** The initialize handshake may load a whole TS project — allow longer. */
const INITIALIZE_TIMEOUT_MS = 30_000
/** Give up restarting after this many rapid crashes. */
const MAX_RESTARTS = 5
const RESTART_BASE_DELAY_MS = 1_000
const RESTART_MAX_DELAY_MS = 10_000
/** Uptime after which the crash counter resets (server proved stable). */
const STABLE_UPTIME_MS = 30_000
/** Grace period between `shutdown`/`exit` and SIGKILL on dispose. */
const SHUTDOWN_GRACE_MS = 2_000
/**
 * PERF-5: full-document sync ships the ENTIRE buffer on every didChange, so
 * unthrottled per-edit sync of a huge file costs O(size) serialization plus
 * a server-side re-parse per keystroke. Documents at or above this size
 * (UTF-8 bytes) have their didChange notifications throttled to at most one
 * per LARGE_DOCUMENT_SYNC_INTERVAL_MS, with a trailing-edge flush so the
 * final text always reaches the server. 1 MiB is the accepted ceiling for
 * unthrottled full-buffer sync.
 */
export const LARGE_DOCUMENT_THRESHOLD_BYTES = 1024 * 1024
/** Minimum spacing between didChange notifications for large documents. */
export const LARGE_DOCUMENT_SYNC_INTERVAL_MS = 2_000

// ── URI helpers ────────────────────────────────────────────────────────────

export function pathToLspUri(path: string): string {
  return pathToFileURL(path).toString()
}

/** file:// URI → absolute path; null for non-file or malformed URIs. */
export function lspUriToPath(uri: string): string | null {
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

// ── Stdio framing ──────────────────────────────────────────────────────────

/** Incremental Content-Length framed JSON-RPC reader (LSP base protocol). */
class MessageReader {
  #buffer: Buffer = Buffer.alloc(0)
  #contentLength = -1

  push(chunk: Buffer, onMessage: (message: JsonRpcMessage) => void): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    for (;;) {
      if (this.#contentLength < 0) {
        const headerEnd = this.#buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) {
          return
        }
        const header = this.#buffer.subarray(0, headerEnd).toString('ascii')
        this.#buffer = this.#buffer.subarray(headerEnd + 4)
        const match = /Content-Length:\s*(\d+)/i.exec(header)
        if (!match) {
          // Malformed header block — skip it and keep scanning.
          continue
        }
        this.#contentLength = Number.parseInt(match[1], 10)
      }
      if (this.#buffer.length < this.#contentLength) {
        return
      }
      const body = this.#buffer.subarray(0, this.#contentLength).toString('utf8')
      this.#buffer = this.#buffer.subarray(this.#contentLength)
      this.#contentLength = -1
      try {
        onMessage(JSON.parse(body) as JsonRpcMessage)
      } catch (error) {
        console.error('[LSP] Failed to parse server message', error)
      }
    }
  }
}

function frameMessage(message: JsonRpcMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

// ── Per-(server, root) client ──────────────────────────────────────────────

interface PendingRequest {
  method: string
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

interface OpenDocument {
  languageId: string
  version: number
  text: string
}

type ClientState = 'idle' | 'starting' | 'ready' | 'failed' | 'disposed'

class LspClient {
  readonly config: LanguageServerConfig
  readonly rootPath: string

  #child: ChildProcessWithoutNullStreams | null = null
  #reader = new MessageReader()
  #state: ClientState = 'idle'
  #nextRequestId = 1
  #pending = new Map<number, PendingRequest>()
  #openDocuments = new Map<string, OpenDocument>()
  /** LOG-12: in-flight didOpen per path — concurrent openers await it. */
  #openingDocuments = new Map<string, Promise<void>>()
  #ready: Promise<void> | null = null
  #restartCount = 0
  #restartTimer: NodeJS.Timeout | null = null
  /** LOG-13: the scheduled backoff restart, awaited by ensureStarted(). */
  #pendingRestart: { promise: Promise<void>; cancel: (reason: Error) => void } | null = null
  /** PERF-5: trailing-flush timers for throttled large-document sync. */
  #largeDocSyncTimers = new Map<string, NodeJS.Timeout>()
  /** PERF-5: last time a didChange was sent for each large document. */
  #largeDocLastSyncAt = new Map<string, number>()
  #spawnedAt = 0
  #onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void

  constructor(
    config: LanguageServerConfig,
    rootPath: string,
    onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
  ) {
    this.config = config
    this.rootPath = rootPath
    this.#onDiagnostics = onDiagnostics
  }

  get openDocumentPaths(): string[] {
    return [...this.#openDocuments.keys()]
  }

  hasDocument(path: string): boolean {
    return this.#openDocuments.has(path)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Ensure the server process is up and initialized. Idempotent. */
  ensureStarted(): Promise<void> {
    if (this.#state === 'disposed') {
      return Promise.reject(new Error(`[LSP:${this.config.id}] Client is disposed`))
    }
    if (this.#state === 'failed') {
      return Promise.reject(
        new Error(
          `[LSP:${this.config.id}] Server gave up after ${MAX_RESTARTS} crashes (root: ${this.rootPath})`,
        ),
      )
    }
    if (!this.#ready) {
      // LOG-13: a crash-backoff restart may already be scheduled. Spawning
      // immediately here would bypass the exponential backoff, so await the
      // scheduled restart instead — it resolves once the backoff-restarted
      // server is ready (and its documents replayed).
      if (this.#pendingRestart) {
        return this.#pendingRestart.promise
      }
      this.#ready = this.#start()
    }
    return this.#ready
  }

  async #start(): Promise<void> {
    this.#state = 'starting'
    this.#spawnedAt = Date.now()

    const child = spawn(this.config.command, this.config.args, {
      cwd: this.rootPath,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#child = child

    child.stdout.on('data', (chunk: Buffer) => {
      this.#reader.push(chunk, (message) => this.#onMessage(message))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) {
        console.warn(`[LSP:${this.config.id}] stderr: ${text}`)
      }
    })
    child.on('error', (error) => {
      console.error(`[LSP:${this.config.id}] Failed to spawn "${this.config.command}"`, error)
      this.#onExit(child)
    })
    child.on('exit', (code, signal) => {
      if (this.#state !== 'disposed') {
        console.warn(
          `[LSP:${this.config.id}] Server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
        )
      }
      this.#onExit(child)
    })

    try {
      await this.#initialize()
    } catch (error) {
      // Initialize failed or timed out: without cleanup, #ready stays pinned
      // to this rejected promise (LSP dead for the root forever) and the
      // half-started child leaks. Reset state so the next ensureStarted()
      // retries cleanly, and take the child down (SIGTERM → SIGKILL).
      if (this.#child === child) {
        this.#child = null
      }
      this.#ready = null
      if (this.#state === 'starting') {
        this.#state = 'idle'
      }
      this.#killChild(child)
      throw error
    }
    this.#state = 'ready'
  }

  /** SIGTERM now, SIGKILL if the child is still alive after the grace. */
  #killChild(child: ChildProcessWithoutNullStreams): void {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
    }, SHUTDOWN_GRACE_MS)
    killTimer.unref()
    child.once('exit', () => clearTimeout(killTimer))
    child.kill('SIGTERM')
  }

  async #initialize(): Promise<void> {
    const rootUri = pathToLspUri(this.rootPath)
    await this.#sendRequest(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        rootPath: this.rootPath,
        workspaceFolders: [{ uri: rootUri, name: this.rootPath }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { relatedInformation: false },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: {},
            completion: {
              completionItem: {
                snippetSupport: false,
                documentationFormat: ['markdown', 'plaintext'],
              },
              contextSupport: false,
            },
          },
          workspace: { workspaceFolders: true, configuration: false },
        },
        initializationOptions: this.config.initializationOptions,
      },
      INITIALIZE_TIMEOUT_MS,
    )
    this.#sendNotification('initialized', {})
  }

  #onExit(exitedChild: ChildProcessWithoutNullStreams): void {
    if (this.#child !== null && this.#child !== exitedChild) {
      // A superseded child (e.g. killed after a failed initialize) exiting
      // late must not tear down the live replacement's state.
      exitedChild.removeAllListeners()
      return
    }
    this.#child = null
    this.#ready = null
    exitedChild.removeAllListeners()

    const exitError = new Error(`[LSP:${this.config.id}] Server process exited`)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(exitError)
    }
    this.#pending.clear()

    // PERF-5: pending large-doc flushes target the dead process; the restart
    // replay resets document versions, so a late flush would send a stale
    // version. Drop them — replay ships the latest text via didOpen.
    for (const timer of this.#largeDocSyncTimers.values()) {
      clearTimeout(timer)
    }
    this.#largeDocSyncTimers.clear()
    this.#largeDocLastSyncAt.clear()

    if (this.#state === 'disposed') {
      return
    }

    // A long stable run earns a fresh crash budget.
    if (Date.now() - this.#spawnedAt > STABLE_UPTIME_MS) {
      this.#restartCount = 0
    }
    if (this.#openDocuments.size === 0) {
      // Nothing depends on this server right now — respawn lazily on demand.
      this.#state = 'idle'
      return
    }
    if (this.#restartCount >= MAX_RESTARTS) {
      this.#state = 'failed'
      console.error(
        `[LSP:${this.config.id}] Giving up after ${MAX_RESTARTS} crashes (root: ${this.rootPath})`,
      )
      return
    }

    const delay = Math.min(
      RESTART_BASE_DELAY_MS * 2 ** this.#restartCount,
      RESTART_MAX_DELAY_MS,
    )
    this.#restartCount += 1
    this.#state = 'idle'
    console.warn(`[LSP:${this.config.id}] Restarting in ${delay}ms (attempt ${this.#restartCount})`)
    // LOG-13: expose the scheduled restart as a promise so ensureStarted()
    // can await the backoff instead of spawning a fresh server immediately.
    let cancel!: (reason: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      cancel = reject
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null
        this.#pendingRestart = null
        this.#restart().then(resolve, reject)
      }, delay)
    })
    // The scheduled restart may go entirely un-awaited — never let its
    // rejection become an unhandled rejection.
    promise.catch((error) => {
      if (this.#state !== 'disposed') {
        console.error(`[LSP:${this.config.id}] Restart failed`, error)
      }
    })
    this.#pendingRestart = { promise, cancel }
  }

  /** Respawn after a crash and replay didOpen for every tracked document. */
  async #restart(): Promise<void> {
    if (this.#state === 'disposed' || this.#state === 'failed') {
      return
    }
    await this.ensureStarted()
    for (const [path, document] of this.#openDocuments) {
      document.version = 1
      this.#sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: pathToLspUri(path),
          languageId: document.languageId,
          version: document.version,
          text: document.text,
        },
      })
    }
  }

  async dispose(): Promise<void> {
    if (this.#state === 'disposed') {
      return
    }
    this.#state = 'disposed'
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }
    if (this.#pendingRestart) {
      // LOG-13: callers awaiting the scheduled restart must not hang forever.
      this.#pendingRestart.cancel(new Error(`[LSP:${this.config.id}] Client is disposed`))
      this.#pendingRestart = null
    }
    for (const timer of this.#largeDocSyncTimers.values()) {
      clearTimeout(timer)
    }
    this.#largeDocSyncTimers.clear()
    this.#largeDocLastSyncAt.clear()
    this.#openDocuments.clear()

    const child = this.#child
    if (!child) {
      return
    }
    try {
      // Polite LSP shutdown; SIGTERM → SIGKILL as backstop if the server
      // ignores it. Awaited (bounded) so quit never orphans the child.
      await this.#sendRequest('shutdown', null, SHUTDOWN_GRACE_MS)
      this.#sendNotification('exit', null)
    } catch {
      // Server unresponsive — fall through to the kill below.
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
    await waitForExit(child, SHUTDOWN_GRACE_MS)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await waitForExit(child, SHUTDOWN_GRACE_MS)
    }
  }

  // ── Document sync (full-text) ────────────────────────────────────────────

  async openDocument(path: string, languageId: string, text: string): Promise<void> {
    // LOG-12: two concurrent openDocument calls for the same path would both
    // pass the "not open yet" check while awaiting ensureStarted() and
    // double-send textDocument/didOpen (a protocol violation). The first
    // caller performs the open; concurrent callers await that in-flight open
    // and fold their (possibly newer) text in as a didChange.
    const inFlight = this.#openingDocuments.get(path)
    if (inFlight) {
      await inFlight
      await this.changeDocument(path, text)
      return
    }
    if (this.#openDocuments.has(path)) {
      await this.changeDocument(path, text)
      return
    }
    const opening = this.#openNewDocument(path, languageId, text)
    this.#openingDocuments.set(path, opening)
    try {
      await opening
    } finally {
      this.#openingDocuments.delete(path)
    }
  }

  async #openNewDocument(path: string, languageId: string, text: string): Promise<void> {
    await this.ensureStarted()
    const document: OpenDocument = { languageId, version: 1, text }
    this.#openDocuments.set(path, document)
    this.#sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: pathToLspUri(path),
        languageId,
        version: document.version,
        text,
      },
    })
  }

  async changeDocument(path: string, text: string): Promise<void> {
    const document = this.#openDocuments.get(path)
    if (!document) {
      return
    }
    await this.ensureStarted()
    if (document.text === text) {
      return
    }
    document.text = text
    document.version += 1
    // PERF-5: full-buffer sync of huge documents is throttled — the tracked
    // text/version above stay authoritative (requests and crash replay use
    // them); only the didChange notification is deferred.
    if (Buffer.byteLength(text, 'utf8') >= LARGE_DOCUMENT_THRESHOLD_BYTES) {
      this.#scheduleLargeDocumentSync(path)
      return
    }
    // Back under the threshold: cancel any pending flush (this send already
    // carries the latest text) and sync immediately.
    this.#cancelLargeDocumentSync(path)
    this.#sendDidChange(path, document)
  }

  /** Send didChange with the document's CURRENT tracked text and version. */
  #sendDidChange(path: string, document: OpenDocument): void {
    // Full-document sync: a contentChanges entry without a range replaces
    // the whole text — valid for both full and incremental sync servers.
    this.#sendNotification('textDocument/didChange', {
      textDocument: { uri: pathToLspUri(path), version: document.version },
      contentChanges: [{ text: document.text }],
    })
  }

  /**
   * PERF-5: send at most one didChange per LARGE_DOCUMENT_SYNC_INTERVAL_MS
   * for documents over the size threshold. Leading edge sends immediately;
   * inside the window a single trailing timer flushes the latest text.
   */
  #scheduleLargeDocumentSync(path: string): void {
    if (this.#largeDocSyncTimers.has(path)) {
      // A trailing flush is already queued — it reads the latest text.
      return
    }
    const now = Date.now()
    const lastSyncAt = this.#largeDocLastSyncAt.get(path) ?? 0
    const elapsed = now - lastSyncAt
    if (elapsed >= LARGE_DOCUMENT_SYNC_INTERVAL_MS) {
      const document = this.#openDocuments.get(path)
      if (document) {
        this.#largeDocLastSyncAt.set(path, now)
        this.#sendDidChange(path, document)
      }
      return
    }
    const timer = setTimeout(() => {
      this.#largeDocSyncTimers.delete(path)
      const document = this.#openDocuments.get(path)
      if (document) {
        this.#largeDocLastSyncAt.set(path, Date.now())
        this.#sendDidChange(path, document)
      }
    }, LARGE_DOCUMENT_SYNC_INTERVAL_MS - elapsed)
    timer.unref()
    this.#largeDocSyncTimers.set(path, timer)
  }

  #cancelLargeDocumentSync(path: string): void {
    const timer = this.#largeDocSyncTimers.get(path)
    if (timer) {
      clearTimeout(timer)
      this.#largeDocSyncTimers.delete(path)
    }
  }

  closeDocument(path: string): void {
    this.#cancelLargeDocumentSync(path)
    this.#largeDocLastSyncAt.delete(path)
    if (!this.#openDocuments.delete(path)) {
      return
    }
    if (this.#state === 'ready') {
      this.#sendNotification('textDocument/didClose', {
        textDocument: { uri: pathToLspUri(path) },
      })
    }
    // Clear any stale markers the renderer is still showing for this file.
    this.#onDiagnostics(path, [])
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  async hover(path: string, position: LspPosition): Promise<LspHover | null> {
    const result = await this.#documentRequest('textDocument/hover', path, position)
    return (result as LspHover | null) ?? null
  }

  async definition(path: string, position: LspPosition): Promise<LspLocation[]> {
    const result = await this.#documentRequest('textDocument/definition', path, position)
    return normalizeDefinitionResult(result)
  }

  async completions(path: string, position: LspPosition): Promise<LspCompletionItem[]> {
    const result = await this.#documentRequest('textDocument/completion', path, position)
    if (!result) {
      return []
    }
    if (Array.isArray(result)) {
      return result as LspCompletionItem[]
    }
    return (result as LspCompletionList).items ?? []
  }

  async #documentRequest(
    method: string,
    path: string,
    position: LspPosition,
  ): Promise<unknown> {
    await this.ensureStarted()
    return this.#sendRequest(method, {
      textDocument: { uri: pathToLspUri(path) },
      position,
    })
  }

  // ── JSON-RPC plumbing ────────────────────────────────────────────────────

  #sendRequest(
    method: string,
    params: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const child = this.#child
    if (!child || child.exitCode !== null) {
      return Promise.reject(new Error(`[LSP:${this.config.id}] Server is not running`))
    }
    const id = this.#nextRequestId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`[LSP:${this.config.id}] Request "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#pending.set(id, { method, resolve, reject, timer })
      child.stdin.write(frameMessage({ jsonrpc: '2.0', id, method, params }))
    })
  }

  #sendNotification(method: string, params: unknown): void {
    const child = this.#child
    if (!child || child.exitCode !== null) {
      return
    }
    child.stdin.write(frameMessage({ jsonrpc: '2.0', method, params }))
  }

  #sendResponse(id: number | string, result: unknown, error?: { code: number; message: string }): void {
    const child = this.#child
    if (!child || child.exitCode !== null) {
      return
    }
    const message: JsonRpcMessage = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result }
    child.stdin.write(frameMessage(message))
  }

  #onMessage(message: JsonRpcMessage): void {
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.#pending.get(message.id as number)
      if (!pending) {
        return
      }
      this.#pending.delete(message.id as number)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(
          new Error(
            `[LSP:${this.config.id}] "${pending.method}" failed: ${message.error.message} (${message.error.code})`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }

    // Server → client request: answer benignly so the server never stalls.
    if (message.id !== undefined && message.method !== undefined) {
      switch (message.method) {
        case 'workspace/configuration': {
          const params = message.params as { items?: unknown[] } | undefined
          this.#sendResponse(message.id, (params?.items ?? []).map(() => null))
          return
        }
        case 'client/registerCapability':
        case 'client/unregisterCapability':
        case 'window/workDoneProgress/create':
          this.#sendResponse(message.id, null)
          return
        case 'workspace/applyEdit':
          this.#sendResponse(message.id, { applied: false })
          return
        default:
          this.#sendResponse(message.id, null, { code: -32601, message: 'Method not found' })
          return
      }
    }

    // Notification.
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as PublishDiagnosticsParams
      const path = lspUriToPath(params.uri)
      if (path) {
        this.#onDiagnostics(path, params.diagnostics ?? [])
      }
    }
    // All other notifications (logMessage, telemetry, progress) are ignored.
  }
}

// ── Manager ────────────────────────────────────────────────────────────────

export class LspManager extends EventEmitter {
  #configs = new Map<string, LanguageServerConfig>()
  #clients = new Map<string, LspClient>()
  #disposed = false

  /** Register a language server. Later servers = another config, not code. */
  registerServer(config: LanguageServerConfig): void {
    this.#configs.set(config.id, config)
  }

  /** The registered server config responsible for `path`, if any. */
  configForFile(path: string): LanguageServerConfig | null {
    const extension = extname(path).toLowerCase()
    for (const config of this.#configs.values()) {
      if (config.fileExtensions.includes(extension)) {
        return config
      }
    }
    return null
  }

  /** True when `path` is currently synced with a server under `rootPath`. */
  isOpen(rootPath: string, path: string): boolean {
    const client = this.#existingClient(rootPath, path)
    return client?.hasDocument(path) ?? false
  }

  /**
   * Open (or refresh) a document. Spawns the owning server for `rootPath` on
   * first use. Returns false when no registered server handles the file or
   * the root lacks the server's rootMarkers.
   */
  async didOpen(rootPath: string, path: string, text: string): Promise<boolean> {
    if (this.#disposed) {
      return false
    }
    const config = this.configForFile(path)
    if (!config || !rootMatchesMarkers(rootPath, config)) {
      return false
    }
    const client = this.#clientFor(config, rootPath)
    const extension = extname(path).toLowerCase()
    const languageId = config.languageIds?.[extension] ?? 'plaintext'
    await client.openDocument(path, languageId, text)
    return true
  }

  /** Sync new full text for an already-open document (no-op otherwise). */
  async didChange(rootPath: string, path: string, text: string): Promise<void> {
    const client = this.#existingClient(rootPath, path)
    if (client?.hasDocument(path)) {
      await client.changeDocument(path, text)
    }
  }

  didClose(rootPath: string, path: string): void {
    const client = this.#existingClient(rootPath, path)
    client?.closeDocument(path)
  }

  async hover(rootPath: string, path: string, position: LspPosition): Promise<LspHover | null> {
    const client = this.#existingClient(rootPath, path)
    if (!client?.hasDocument(path)) {
      return null
    }
    return client.hover(path, position)
  }

  async definition(
    rootPath: string,
    path: string,
    position: LspPosition,
  ): Promise<LspLocation[]> {
    const client = this.#existingClient(rootPath, path)
    if (!client?.hasDocument(path)) {
      return []
    }
    return client.definition(path, position)
  }

  async completions(
    rootPath: string,
    path: string,
    position: LspPosition,
  ): Promise<LspCompletionItem[]> {
    const client = this.#existingClient(rootPath, path)
    if (!client?.hasDocument(path)) {
      return []
    }
    return client.completions(path, position)
  }

  /** Shut down every server spawned for `rootPath` (root removed). */
  async disposeRoot(rootPath: string): Promise<void> {
    const closing: Promise<void>[] = []
    for (const [key, client] of this.#clients) {
      if (client.rootPath === rootPath) {
        this.#clients.delete(key)
        closing.push(client.dispose())
      }
    }
    await Promise.all(closing)
  }

  /** Shut down all servers. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    const closing = [...this.#clients.values()].map((client) => client.dispose())
    this.#clients.clear()
    await Promise.all(closing)
    this.removeAllListeners()
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #clientFor(config: LanguageServerConfig, rootPath: string): LspClient {
    const key = clientKey(config.id, rootPath)
    let client = this.#clients.get(key)
    if (!client) {
      client = new LspClient(config, rootPath, (path, diagnostics) => {
        const event: LspDiagnosticsEvent = {
          serverId: config.id,
          rootPath,
          path,
          diagnostics,
        }
        this.emit(LSP_DIAGNOSTICS_EVENT, event)
      })
      this.#clients.set(key, client)
    }
    return client
  }

  #existingClient(rootPath: string, path: string): LspClient | null {
    const config = this.configForFile(path)
    if (!config) {
      return null
    }
    return this.#clients.get(clientKey(config.id, rootPath)) ?? null
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function clientKey(serverId: string, rootPath: string): string {
  return `${serverId}\x00${rootPath}`
}

function rootMatchesMarkers(rootPath: string, config: LanguageServerConfig): boolean {
  if (!config.rootMarkers || config.rootMarkers.length === 0) {
    return true
  }
  return config.rootMarkers.some((marker) => existsSync(join(rootPath, marker)))
}

/** Resolve when `child` has exited, or after `timeoutMs` — never rejects. */
function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve()
    }, timeoutMs)
    timer.unref()
    child.once('exit', onExit)
  })
}

function normalizeDefinitionResult(result: unknown): LspLocation[] {
  if (!result) {
    return []
  }
  const entries = Array.isArray(result) ? result : [result]
  const locations: LspLocation[] = []
  for (const entry of entries) {
    const candidate = entry as Partial<LspLocation> & Partial<LspLocationLink>
    if (typeof candidate.uri === 'string' && candidate.range) {
      locations.push({ uri: candidate.uri, range: candidate.range })
    } else if (typeof candidate.targetUri === 'string') {
      const range = candidate.targetSelectionRange ?? candidate.targetRange
      if (range) {
        locations.push({ uri: candidate.targetUri, range })
      }
    }
  }
  return locations
}
