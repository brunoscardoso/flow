/**
 * Renderer capture-chip model — turns an embedded browser capture into a
 * composer CONTEXT chip carrying the capture's FULL payload (not just a label),
 * so the agent actually receives the request/response, console text, or DOM it
 * was asked about. Element captures additionally auto-attach the resolved source
 * file and a screenshot.
 *
 * It subscribes to BOTH capture sources and normalizes them through the ONE
 * capture boundary (allowed-pattern #14):
 *   - element captures arrive on the RENDERER as the `document` CustomEvent
 *     `flow:browser-element-captured`; they NEVER pass through main, so they are
 *     redacted + bounded HERE via `redactAndBound`.
 *   - console/network captures arrive over `browser:tagPosted`, already redacted
 *     in main; `redactAndBound` runs again (idempotent) as defense in depth.
 *
 * Each capture becomes a `flow:add-to-chat` CONTEXT chip: `{ source, label, text }`
 * where `text` is the full formatted payload. The composer folds it into the
 * message as a `Context from <label>:` fenced block (context-chips.ts) — the same
 * path terminal selections and files already use. Element captures also fire
 * `flow:add-to-chat` (source file) and `flow:attach-image` (screenshot).
 */
import { redactAndBound } from '../../shared/browser-capture-boundary'
import type {
  BrowserCapture,
  BrowserConsolePayload,
  BrowserElementCapture,
  BrowserElementPayload,
  BrowserNetworkPayload,
} from '../../shared/browser-capture-types'
import type { MessageAttachmentInput } from '../../shared/ipc-contract'

/** The slice of the browser IPC surface this model needs. */
export interface CaptureChipBrowserApi {
  captureScreenshot(request: Record<string, never>): Promise<MessageAttachmentInput | null>
  onTagPosted(listener: (capture: BrowserCapture) => void): () => void
}

/** Cap a label so the composer badge stays a single readable pill. */
const MAX_LABEL = 80

function firstLine(text: string): string {
  return text.split('\n', 1)[0] ?? ''
}

function truncate(text: string, max = MAX_LABEL): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** The path portion of a URL, for a compact label (full URL stays in the body). */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.pathname + parsed.search
  } catch {
    return url
  }
}

function headerLines(headers: Record<string, string>): string {
  const entries = Object.entries(headers)
  if (entries.length === 0) return '  (none)'
  return entries.map(([name, value]) => `  ${name}: ${value}`).join('\n')
}

// ── Per-kind label + full-payload body ────────────────────────────────────────

function networkText(p: BrowserNetworkPayload, withheld: boolean): string {
  const lines: string[] = [
    `${p.method} ${p.url}`,
    `Status: ${String(p.status)} · ${String(p.timingMs)}ms`,
    '',
    'Request headers:',
    headerLines(p.requestHeaders),
  ]
  if (typeof p.requestBody === 'string' && p.requestBody.length > 0) {
    lines.push('', 'Request body:', p.requestBody)
  }
  lines.push('', 'Response headers:', headerLines(p.responseHeaders))
  if (typeof p.responseBody === 'string' && p.responseBody.length > 0) {
    lines.push('', 'Response body:', p.responseBody)
  } else if (withheld) {
    lines.push('', 'Response body: (withheld — too large to inline)')
  }
  return lines.join('\n')
}

function consoleText(p: BrowserConsolePayload): string {
  const head = `[${p.level}] ${p.text}`
  return typeof p.stack === 'string' && p.stack.length > 0 ? `${head}\n\n${p.stack}` : head
}

function elementText(p: BrowserElementPayload): string {
  const lines: string[] = [`Component: ${p.componentPath}`]
  if (typeof p.sourceFile === 'string' && p.sourceFile.length > 0) {
    lines.push(`Source: ${p.sourceFile}${typeof p.sourceLine === 'number' ? `:${String(p.sourceLine)}` : ''}`)
  }
  lines.push(`Selector: ${p.selector}`, `DOM: ${p.domSummary}`)
  if (p.props !== undefined) {
    const props = Object.entries(p.props)
    if (props.length > 0) {
      lines.push('Props:', ...props.map(([key, value]) => `  ${key}: ${value}`))
    }
  }
  return lines.join('\n')
}

/** The full context text + a compact label for a capture. */
function contextOf(capture: BrowserCapture): { label: string; text: string } {
  switch (capture.kind) {
    case 'network':
      return {
        label: truncate(`Network ${capture.payload.method} ${String(capture.payload.status)} ${pathOf(capture.payload.url)}`),
        text: networkText(capture.payload, capture.withheld === true),
      }
    case 'console':
      return {
        label: truncate(`Console ${capture.payload.level}: ${firstLine(capture.payload.text)}`),
        text: consoleText(capture.payload),
      }
    case 'element':
      return {
        label: truncate(`Element ${capture.payload.componentPath}`),
        text: elementText(capture.payload),
      }
  }
}

function dispatch(name: string, detail: unknown): void {
  document.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
}

/**
 * For an element: auto-attach its resolved source file (as the composer's
 * file-reference form) and a screenshot of the current guest page. Both are
 * best-effort — a missing source map or blank page just means one is absent.
 */
async function attachElementExtras(
  payload: BrowserElementPayload,
  browser: CaptureChipBrowserApi,
): Promise<void> {
  if (typeof payload.sourceFile === 'string' && payload.sourceFile.length > 0) {
    const ref =
      typeof payload.sourceLine === 'number'
        ? `${payload.sourceFile}:${String(payload.sourceLine)}`
        : payload.sourceFile
    dispatch('flow:add-to-chat', { source: 'file', label: payload.sourceFile, text: ref })
  }
  try {
    const shot = await browser.captureScreenshot({})
    if (shot) dispatch('flow:attach-image', shot)
  } catch (error) {
    console.warn('flow: browser screenshot capture failed', error)
  }
}

/** Fold a capture's full payload into the composer as a context chip. */
function dropCapture(capture: BrowserCapture, browser: CaptureChipBrowserApi): void {
  const bounded = redactAndBound(capture)
  const { label, text } = contextOf(bounded)
  dispatch('flow:add-to-chat', { source: 'browser', label, text })
  if (bounded.kind === 'element') void attachElementExtras(bounded.payload, browser)
}

/**
 * Wire both capture sources to the composer. Returns a disposer that detaches
 * the document listener and the IPC subscription.
 */
export function initBrowserCaptureChip(browser: CaptureChipBrowserApi): () => void {
  const onElement = (event: Event): void => {
    const payload = (event as CustomEvent<BrowserElementPayload | undefined>).detail
    if (!payload || typeof payload.componentPath !== 'string') return
    const capture: BrowserElementCapture = {
      id: `element:${payload.componentPath}#${payload.selector}`,
      kind: 'element',
      componentPath: payload.componentPath,
      redacted: false,
      payload,
    }
    dropCapture(capture, browser)
  }
  document.addEventListener('flow:browser-element-captured', onElement)

  const stopTag = browser.onTagPosted((capture) => dropCapture(capture, browser))

  return () => {
    document.removeEventListener('flow:browser-element-captured', onElement)
    stopTag()
  }
}

/**
 * Fold a set of captures into the composer as ONE context block — one chip, not
 * N. Adding hundreds of separate chips (a chip per entry) was the perf
 * regression; a bulk "Add all/recent" now redacts + formats each entry and joins
 * them under a single `Context from …` header. Empty slice → no-op.
 */
export function addCapturesToContext(captures: readonly BrowserCapture[], kindLabel: string): void {
  if (captures.length === 0) return
  const blocks = captures.map((capture) => {
    const bounded = redactAndBound(capture)
    const { label, text } = contextOf(bounded)
    return `── ${label} ──\n${text}`
  })
  const count = captures.length
  dispatch('flow:add-to-chat', {
    source: 'browser',
    label: `${kindLabel} · ${String(count)} ${count === 1 ? 'entry' : 'entries'}`,
    text: blocks.join('\n\n'),
  })
}
