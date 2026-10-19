/**
 * Dev-server detection for the embedded browser tab's INITIAL target.
 *
 * Two sources, best-first:
 *   1. A URL a dev server printed to the terminal ("Local: http://localhost:5173").
 *      This reuses the terminal's own link detector (terminal/terminal-links.ts) —
 *      the same pure parser that makes those URLs clickable — so the two surfaces
 *      agree on what counts as a URL (allowed-pattern #14: one code path for the
 *      shared fact). Only loopback URLs are accepted here; a printed
 *      https://docs.example.com is a link, not a dev server.
 *   2. A common-port fallback list (3000, 5173, 8080) when nothing was printed —
 *      the first port is the best guess. The URL bar lets the user navigate
 *      anywhere, so this only has to be a sensible starting point.
 *
 * Pure and unit-testable: no DOM, no IPC. The tab feeds it whatever printed
 * output it can reach and uses the result as the webview's initial `src`.
 */
import { detectTerminalLinks } from '../terminal/terminal-links'

/** Common dev-server ports, in the order to guess when nothing was printed. */
export const COMMON_DEV_PORTS: readonly number[] = [3000, 5173, 8080]

/** Loopback hosts a local dev server is reached on. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])

/** Is this a local dev-server URL (loopback host, http[s])? */
function isLocalDevUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    return LOOPBACK_HOSTS.has(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * The first loopback dev-server URL printed in `text` (any number of lines), or
 * null. Reuses the terminal link detector so "Local: http://localhost:5173/"
 * is recognised exactly as it is in the terminal.
 */
export function detectDevServerUrlFromOutput(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    for (const span of detectTerminalLinks(line)) {
      if (isLocalDevUrl(span.url)) return span.url
    }
  }
  return null
}

export interface DevServerDetectOptions {
  /** Recent terminal output to scan for a printed dev-server URL. */
  printedOutput?: string
  /** Override the common-port fallback list (defaults to COMMON_DEV_PORTS). */
  ports?: readonly number[]
}

/**
 * Best-guess initial URL for the browser tab: a printed loopback URL if one is
 * found, else `http://localhost:<first-common-port>`. Returns null only when
 * there is nothing to print AND the fallback list is empty.
 */
export function detectDevServerUrl(options: DevServerDetectOptions = {}): string | null {
  if (options.printedOutput) {
    const printed = detectDevServerUrlFromOutput(options.printedOutput)
    if (printed) return printed
  }
  const ports = options.ports ?? COMMON_DEV_PORTS
  return ports.length > 0 ? `http://localhost:${ports[0]}` : null
}
