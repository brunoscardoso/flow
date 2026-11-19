/**
 * SERVING DRAFTS on the `flow-page` scheme's `drafts` host (note 2). The
 * scheme's one server (`serveWalkthroughPage`) dispatches here by host; the
 * walkthrough host keeps its own rule untouched.
 *
 * The gate is the walkthrough page's gate, applied the same way: the root must
 * be one the renderer may already address (the readFile predicate), and the
 * file must pass `resolveDraftPath` — one canvas folder, one known file, no
 * traversal. Lexical on purpose: `flow/` is usually a link into the vault, and
 * the file is read through it.
 *
 * WHAT EACH RESPONSE MAY DO (measured in the Phase 1 spike,
 * `flow/brain/decisions/ui-drafts-frames.md`):
 *   - a SCREEN: inline script and style, data: images and fonts, and its own
 *     canvas's tokens stylesheet — nothing that reaches the network. Always
 *     served with a CSP `sandbox allow-scripts`, so even a screen opened as
 *     the top document (the single-screen view) is an opaque origin with no
 *     storage. Never `allow-same-origin`.
 *   - the CANVAS page: Flow's own page; it may frame `flow-page:` screens and
 *     nothing else reaches out.
 *   - the TOKENS stylesheet and the LAYOUT: plain data, `default-src 'none'`.
 */
import { join } from 'path'

import {
  DRAFT_LAYOUT_FILE,
  DRAFT_TOKENS_FILE,
  draftPageUrl,
  parseDraftPageUrl,
  resolveDraftPath,
  type DraftLayout,
  type DraftPageRequest,
} from '../../shared/ui-drafts'
import { canvasPageHtml, screenProblemSentence } from './canvas-page'
import { readDraftLayout } from './draft-store'

/** The policy every screen shares, before its own canvas's stylesheet is named. */
const SCREEN_CSP_BASE =
  "default-src 'none'; script-src 'unsafe-inline'; img-src data:; font-src data:"

/**
 * A screen's policy: sandboxed to an opaque origin, inline script and style,
 * and the ONE stylesheet URL of its own canvas.
 */
export function draftScreenCsp(root: string, canvas: string): string {
  const tokens = draftPageUrl({ kind: 'asset', root, canvas, file: DRAFT_TOKENS_FILE })
  return `sandbox allow-scripts; ${SCREEN_CSP_BASE}; style-src 'unsafe-inline' ${tokens}`
}

/** The canvas page's policy: its own inline code, and frames from the page scheme only. */
export const DRAFT_CANVAS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src flow-page:"

/** The data files' policy: nothing at all. */
export const DRAFT_DATA_CSP = "default-src 'none'"

export type DraftServeResolution =
  | { ok: true; request: DraftPageRequest; absPath: string | null }
  | { ok: false; reason: string }

/**
 * Decide whether a drafts request may be served and from which file. PURE over
 * the root predicate — the whole security decision, testable without Electron.
 * The canvas page has no file of its own (`absPath: null`); it reads the layout.
 */
export function resolveDraftRequest(url: string, isKnownRoot: (rootPath: string) => boolean): DraftServeResolution {
  const request = parseDraftPageUrl(url)
  if (request === null) return { ok: false, reason: 'not a drafts address' }
  if (!isKnownRoot(request.root)) return { ok: false, reason: 'unknown project root' }
  if (request.kind === 'canvas') return { ok: true, request, absPath: null }
  const file = request.kind === 'screen' ? `${request.screen}.html` : request.file
  const resolution = resolveDraftPath(request.root, request.canvas, file)
  if (!resolution.ok) return { ok: false, reason: resolution.reason }
  return { ok: true, request, absPath: join(request.root, resolution.relPath) }
}

export interface DraftServeDeps {
  isKnownRoot: (rootPath: string) => boolean
  readFile: (absPath: string) => Promise<string>
}

function notFound(): Response {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/** Answer one drafts request: the file with its policy, or a plain 404 (logged with its context). */
export async function serveDraftRequest(url: string, deps: DraftServeDeps): Promise<Response> {
  const resolution = resolveDraftRequest(url, deps.isKnownRoot)
  if (!resolution.ok) {
    console.warn('[Drafts] refused request', { url, reason: resolution.reason })
    return notFound()
  }
  const { request } = resolution
  if (request.kind === 'canvas') {
    const layout = await readDraftLayout(deps.readFile, request.root, request.canvas)
    const html = canvasPageHtml(
      layout.ok
        ? {
            canvas: request.canvas,
            layout: layout.layout,
            screenProblems: await unreadableScreens(deps.readFile, request.root, request.canvas, layout.layout),
          }
        : { canvas: request.canvas, layout: null, problem: layout.reason },
    )
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': DRAFT_CANVAS_CSP },
    })
  }
  let body: string
  try {
    body = await deps.readFile(resolution.absPath as string)
  } catch (error) {
    console.warn('[Drafts] failed to read a draft file', { root: request.root, canvas: request.canvas, url, error })
    if (request.kind !== 'screen') return notFound()
    body = unreadableScreenHtml(screenProblemSentence('missing'))
  }
  if (request.kind === 'screen') {
    // An empty screen is drawn as the sentence, not as a blank white frame — the
    // canvas reloads a changed frame alone, so the frame must say it itself.
    if (body.trim().length === 0) body = unreadableScreenHtml(screenProblemSentence('empty'))
    return new Response(body, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': draftScreenCsp(request.root, request.canvas),
      },
    })
  }
  const contentType =
    request.file === DRAFT_LAYOUT_FILE ? 'application/json; charset=utf-8' : 'text/css; charset=utf-8'
  return new Response(body, {
    headers: { 'content-type': contentType, 'content-security-policy': DRAFT_DATA_CSP },
  })
}

/**
 * Which of a layout's screens cannot be shown, by id, with the sentence the
 * canvas draws in its place: a file that is missing or empty. Read once per
 * canvas serve, all screens at once (allowed-pattern #19 — async, bounded by
 * the layout).
 */
export async function unreadableScreens(
  readFile: (absPath: string) => Promise<string>,
  root: string,
  canvas: string,
  layout: DraftLayout,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    layout.screens.map(async (screen) => {
      const resolution = resolveDraftPath(root, canvas, screen.file)
      if (!resolution.ok) {
        out[screen.id] = screenProblemSentence('missing')
        return
      }
      try {
        const text = await readFile(join(root, resolution.relPath))
        if (text.trim().length === 0) out[screen.id] = screenProblemSentence('empty')
      } catch {
        out[screen.id] = screenProblemSentence('missing')
      }
    }),
  )
  return out
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Flow's own stand-in for a screen that cannot be read: the sentence, in a dashed red box. */
export function unreadableScreenHtml(sentence: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  body { box-sizing: border-box; display: flex; align-items: center; justify-content: center; padding: 32px;
    background: #fef2f2; color: #dc2626; border: 2px dashed #dc2626; text-align: center;
    font: 15px/1.5 system-ui, -apple-system, sans-serif; }
</style>
</head>
<body data-flow-unreadable="true">${escapeText(sentence)}</body>
</html>
`
}
