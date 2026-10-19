// An always-on, memory-capped ring buffer for embedded-browser captures.
//
// Phase 5 (console + network capture via CDP) feeds every event through this
// buffer; the controller reads slices out of it to satisfy `browser:bufferSlice`
// / `browser:tagRecent` / `browser:tagEntry`. The buffer is deliberately DUMB
// about capture semantics — redaction and the IPC-boundary bounding are Phase 6's
// job (allowed-pattern #18). Its only responsibilities are:
//
//   1. bound memory: an entry-count cap AND a byte cap per kind, oldest-first
//      drop, so a long session cannot grow the buffer without limit (NFR-7);
//   2. bound retained response/request bodies to a max size on the way in;
//   3. answer the three `TagWindow` slice selectors (`last-n`, `since-nav`,
//      `single`) — with `since-nav` surviving eviction via a monotonic sequence,
//      not an index into an array that shifts as entries drop.

import type {
  BrowserBufferCounts,
  BrowserCapture,
  BrowserCaptureKind,
  TagWindow,
} from '../../shared/browser-capture-types'

/** Per-kind and per-body caps. All three are hard ceilings, never soft targets. */
export interface RollingBufferLimits {
  /** Max entries retained per kind before oldest-first drop. */
  maxEntriesPerKind: number
  /** Max serialized bytes retained per kind before oldest-first drop. */
  maxBytesPerKind: number
  /** Max bytes of a single request/response body kept in the buffer. */
  maxBodyBytes: number
}

/**
 * Defaults sized for a long debugging session that must never hold megabytes:
 * 500 entries × ~64 KB worst-case body = a 4 MB per-kind byte ceiling that bites
 * first on body-heavy network traffic, while the entry cap bounds chatty console
 * logs whose individual size is tiny.
 */
export const DEFAULT_BUFFER_LIMITS: RollingBufferLimits = {
  maxEntriesPerKind: 500,
  maxBytesPerKind: 4 * 1024 * 1024,
  maxBodyBytes: 64 * 1024,
}

interface StoredEntry {
  capture: BrowserCapture
  /** Approximate serialized size, used for the byte cap. */
  bytes: number
  /** Monotonic push order — the eviction-safe basis for `since-nav`. */
  seq: number
}

interface KindStore {
  entries: StoredEntry[]
  bytes: number
}

const KINDS: readonly BrowserCaptureKind[] = ['element', 'console', 'network']

export class RollingBuffer {
  readonly #limits: RollingBufferLimits
  readonly #byKind: Record<BrowserCaptureKind, KindStore> = {
    element: { entries: [], bytes: 0 },
    console: { entries: [], bytes: 0 },
    network: { entries: [], bytes: 0 },
  }
  /** The seq the NEXT push will receive; also the `since-nav` boundary marker. */
  #nextSeq = 0
  /** Entries with `seq >= #navSeq` are "since the last navigation". */
  #navSeq = 0

  constructor(limits: RollingBufferLimits = DEFAULT_BUFFER_LIMITS) {
    this.#limits = limits
  }

  /** Append one capture, capping its bodies and evicting as needed. */
  push(capture: BrowserCapture): void {
    const bounded = this.#capBodies(capture)
    const store = this.#byKind[bounded.kind]
    const bytes = byteSizeOf(bounded)
    store.entries.push({ capture: bounded, bytes, seq: this.#nextSeq++ })
    store.bytes += bytes
    this.#evict(store)
  }

  /** Mark a navigation boundary — resets what `since-nav` returns to "empty". */
  markNavigation(): void {
    this.#navSeq = this.#nextSeq
  }

  /** The slice of `kind` selected by `window`, oldest-to-newest. */
  slice(kind: BrowserCaptureKind, window: TagWindow): BrowserCapture[] {
    const entries = this.#byKind[kind].entries
    switch (window.mode) {
      case 'last-n': {
        const n = Math.max(0, Math.trunc(window.n))
        return entries.slice(entries.length - Math.min(n, entries.length)).map((e) => e.capture)
      }
      case 'since-nav':
        return entries.filter((e) => e.seq >= this.#navSeq).map((e) => e.capture)
      case 'single': {
        const found = entries.find((e) => e.capture.id === window.id)
        return found ? [found.capture] : []
      }
    }
  }

  /** One capture by id, searched across every kind (null when absent/evicted). */
  get(id: string): BrowserCapture | null {
    for (const kind of KINDS) {
      const found = this.#byKind[kind].entries.find((e) => e.capture.id === id)
      if (found) return found.capture
    }
    return null
  }

  /** The current per-kind entry counts, for `browser:bufferUpdated`. */
  counts(): BrowserBufferCounts {
    return {
      element: this.#byKind.element.entries.length,
      console: this.#byKind.console.entries.length,
      network: this.#byKind.network.entries.length,
    }
  }

  /** Drop everything (e.g. when a new guest attaches). */
  clear(): void {
    for (const kind of KINDS) {
      this.#byKind[kind].entries = []
      this.#byKind[kind].bytes = 0
    }
  }

  /** Oldest-first drop until BOTH caps are satisfied. */
  #evict(store: KindStore): void {
    while (
      store.entries.length > this.#limits.maxEntriesPerKind ||
      (store.bytes > this.#limits.maxBytesPerKind && store.entries.length > 1)
    ) {
      const dropped = store.entries.shift()
      if (!dropped) break
      store.bytes -= dropped.bytes
    }
  }

  /** Return a copy with request/response bodies truncated to the body cap.
   *  Never mutates the caller's capture (forbidden-pattern #4). */
  #capBodies(capture: BrowserCapture): BrowserCapture {
    if (capture.kind !== 'network') return capture
    const payload = capture.payload
    const requestBody = this.#truncateBody(payload.requestBody)
    const responseBody = this.#truncateBody(payload.responseBody)
    if (requestBody === payload.requestBody && responseBody === payload.responseBody) return capture
    return { ...capture, payload: { ...payload, requestBody, responseBody } }
  }

  #truncateBody(body: string | undefined): string | undefined {
    if (body === undefined) return undefined
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes <= this.#limits.maxBodyBytes) return body
    // Slice by characters as an upper bound on kept bytes; append a note so a
    // reader never mistakes a truncated body for the whole thing.
    const kept = body.slice(0, this.#limits.maxBodyBytes)
    const droppedBytes = bytes - Buffer.byteLength(kept, 'utf8')
    return `${kept}…[truncated ${droppedBytes} bytes]`
  }
}

/** Approximate retained size of a capture, in bytes. */
function byteSizeOf(capture: BrowserCapture): number {
  return Buffer.byteLength(JSON.stringify(capture), 'utf8')
}
