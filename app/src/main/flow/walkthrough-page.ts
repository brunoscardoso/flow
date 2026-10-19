/**
 * Serves a discovery's USER WALKTHROUGH PAGE on the privileged `flow-page`
 * scheme, so the renderer can frame agent-authored HTML that runs its own
 * inline scripts without that HTML ever touching the renderer's origin.
 *
 * WHY A SCHEME AND NOT `srcdoc`. A srcdoc iframe inherits the renderer's CSP
 * (`script-src 'self'`), so the page's navigation script would never run. A
 * response from this scheme carries its OWN CSP — inline script and style, data:
 * images and fonts, and nothing else: no fetch, no remote image, no network at
 * all. The renderer frames it with `sandbox="allow-scripts"` (never
 * `allow-same-origin`), so the page is an opaque origin that cannot reach
 * `parent.document`. Proven in a hidden Electron probe before this was built:
 * the inline script ran, `parent.document` was refused, a fetch and a remote
 * image were both blocked, zero network requests left the process.
 *
 * THE GUARD IS LEXICAL, AND THAT IS ENOUGH. `root` must be a root the app
 * already lets the renderer address (the same predicate `project:readFile`
 * uses — one gate, allowed-pattern #14), and `path` must match the walkthrough
 * path rule in `shared/walkthrough-page.ts`: one file directly inside a flow doc
 * dir, no `..`, nothing absolute. `flow/` is usually a symlink into the user's
 * vault OUTSIDE the root, so the file is read through it on purpose — the
 * lexical check, not a realpath comparison, is what keeps the scheme inside
 * the flow doc dirs.
 *
 * The file is read with fs/promises: the main process answers every window's
 * IPC and must never block on a read (allowed-pattern #19).
 */
import { promises as fsPromises } from 'fs'
import { join } from 'path'

import {
  WALKTHROUGH_PAGE_SCHEME,
  parseWalkthroughPageUrl,
  withTheme,
  type WalkthroughPageRequest,
} from '../../shared/walkthrough-page'

export {
  WALKTHROUGH_PAGE_SCHEME,
  isWalkthroughPath,
  parseWalkthroughPageUrl,
  walkthroughPageUrl,
} from '../../shared/walkthrough-page'

/**
 * The page's own policy. Inline script and style so the page can navigate its
 * steps; data: images and fonts so it can embed what it draws; `default-src
 * 'none'` for everything else — which is what makes fetch, XHR, WebSocket,
 * remote images, remote fonts, frames and form posts all fail closed.
 */
export const WALKTHROUGH_PAGE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/** The outcome of resolving one request, before anything is read. */
export type WalkthroughResolution =
  | { ok: true; request: WalkthroughPageRequest; absPath: string }
  | { ok: false; reason: string }

/**
 * Decide whether a request may be served and from which file. PURE over the
 * injected root predicate — the whole security decision, testable without
 * Electron or a filesystem.
 */
export function resolveWalkthroughRequest(
  url: string,
  isKnownRoot: (rootPath: string) => boolean,
): WalkthroughResolution {
  const request = parseWalkthroughPageUrl(url)
  if (request === null) return { ok: false, reason: 'not a walkthrough page address' }
  if (!isKnownRoot(request.root)) return { ok: false, reason: 'unknown project root' }
  return { ok: true, request, absPath: join(request.root, request.path) }
}

export interface WalkthroughPageDeps {
  /** Whether the renderer may address this root (the readFile gate). */
  isKnownRoot: (rootPath: string) => boolean
  /** Async file read; injectable for tests. Defaults to fs/promises. */
  readFile?: (absPath: string) => Promise<string>
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}

/**
 * Answer one `flow-page` request: the page with its CSP, or a plain 404. A
 * refusal is logged with its context — never swallowed silently — and says
 * nothing to the page about why.
 */
export async function serveWalkthroughPage(url: string, deps: WalkthroughPageDeps): Promise<Response> {
  const resolution = resolveWalkthroughRequest(url, deps.isKnownRoot)
  if (!resolution.ok) {
    console.warn('[WalkthroughPage] refused request', { url, reason: resolution.reason })
    return notFound()
  }
  const read = deps.readFile ?? ((absPath: string) => fsPromises.readFile(absPath, 'utf8'))
  let html: string
  try {
    html = await read(resolution.absPath)
  } catch (error) {
    console.warn('[WalkthroughPage] failed to read page', {
      root: resolution.request.root,
      path: resolution.request.path,
      error,
    })
    return notFound()
  }
  const theme = resolution.request.theme
  return new Response(theme === undefined ? html : withTheme(html, theme), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': WALKTHROUGH_PAGE_CSP,
    },
  })
}

/**
 * Declare the scheme privileged. MUST run at module top level, before the app
 * is ready — Electron ignores the call afterwards. `standard` gives it real URL
 * parsing (host, query); `secure` lets a secure-context page frame it.
 */
export function registerWalkthroughPageScheme(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { protocol } = require('electron') as typeof import('electron')
  protocol.registerSchemesAsPrivileged([
    { scheme: WALKTHROUGH_PAGE_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

/**
 * Install the handler on the default session (after ready). Returns a dispose
 * function that unregisters it.
 */
export function handleWalkthroughPages(deps: WalkthroughPageDeps): () => void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { protocol } = require('electron') as typeof import('electron')
  protocol.handle(WALKTHROUGH_PAGE_SCHEME, (request) => serveWalkthroughPage(request.url, deps))
  return () => protocol.unhandle(WALKTHROUGH_PAGE_SCHEME)
}
