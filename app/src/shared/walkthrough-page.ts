/**
 * THE WALKTHROUGH PAGE'S ADDRESS — shared by main (which serves it) and the
 * renderer (which frames it). DOM-free and node-free on purpose: both sides
 * import this one module, so the path rule the card offers a door on and the
 * path rule the server accepts can never disagree (allowed-pattern #14).
 *
 * A discovery's user walkthrough page — the ARTIFACT, in the app's words — sits
 * beside it, written on request by `/artifact` (never by discovery itself):
 *
 *   flow/discovery/discovery_<slug>_v<N>.md
 *   flow/discovery/discovery_<slug>_v<N>.walkthrough.html
 *
 * The page is agent-authored HTML that runs its own small inline scripts, so it
 * is never loaded into the renderer's own origin. Main serves it from the
 * privileged `flow-page` scheme with a CSP that allows inline script and style
 * and nothing that reaches the network; the renderer frames that URL in an
 * iframe sandboxed to `allow-scripts` only.
 */

/** The custom scheme main registers for walkthrough pages. */
export const WALKTHROUGH_PAGE_SCHEME = 'flow-page'

/** The single host the scheme serves. */
export const WALKTHROUGH_PAGE_HOST = 'walkthrough'

/** The suffix that replaces a doc's `.md` to name its walkthrough page. */
export const WALKTHROUGH_PAGE_SUFFIX = '.walkthrough.html'

/**
 * WHILE A PAGE IS BEING WRITTEN it exists but is not a page yet. `/artifact`
 * copies the template first and fills it in place, so for a few minutes the
 * file beside the doc is the template with its placeholders still in it — and
 * a door opened on it showed an empty template. A page that still carries this
 * marker is being written; `/artifact`'s own check refuses to finish while
 * one is left.
 */
export const WALKTHROUGH_UNFILLED_MARKER = 'SLOT:'

/**
 * How long an unfilled page counts as being written. The writer edits it every
 * few seconds; a page untouched this long with placeholders left was abandoned
 * (an interrupted turn), and the door opens on what is there rather than
 * spinning forever.
 */
export const WALKTHROUGH_WRITING_WINDOW_MS = 10 * 60 * 1000

/** Whether a page with this mtime and marker state is still being written. */
export function isWalkthroughBeingWritten(unfilled: boolean, mtimeMs: number | undefined, now: number): boolean {
  return unfilled && mtimeMs !== undefined && now - mtimeMs < WALKTHROUGH_WRITING_WINDOW_MS
}

/**
 * The only relative paths a walkthrough page may live at: one file directly
 * inside one of the flow doc dirs (archive included — an archived discovery
 * keeps its page). A single path segment for the file name, so `..`, nested
 * dirs and absolute paths are refused lexically; the `..` check is repeated
 * because `..walkthrough.html`-style names are still one segment.
 */
const WALKTHROUGH_PATH_PATTERN = /^flow\/(discovery|plans|brainstorms|archive)\/[^/\\]+\.walkthrough\.html$/

/** Whether `relPath` is a walkthrough page a surface may address. */
export function isWalkthroughPath(relPath: string): boolean {
  if (!WALKTHROUGH_PATH_PATTERN.test(relPath)) return false
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  return name !== WALKTHROUGH_PAGE_SUFFIX && !name.startsWith('.') && !relPath.includes('..')
}

/**
 * The walkthrough page that sits beside a doc — `…/x_v1.md` → `…/x_v1.walkthrough.html` —
 * or null when `docPath` is not a markdown doc.
 */
export function walkthroughPathFor(docPath: string): string | null {
  if (!/\.md$/i.test(docPath)) return null
  return docPath.replace(/\.md$/i, WALKTHROUGH_PAGE_SUFFIX)
}

/**
 * The doc a walkthrough page belongs to — the inverse of `walkthroughPathFor` —
 * or null when `pagePath` is not a walkthrough page name.
 */
export function docPathForWalkthrough(pagePath: string): string | null {
  if (!pagePath.endsWith(WALKTHROUGH_PAGE_SUFFIX)) return null
  const stem = pagePath.slice(0, -WALKTHROUGH_PAGE_SUFFIX.length)
  if (stem.length === 0 || stem.endsWith('/')) return null
  return `${stem}.md`
}

/**
 * The URL the renderer frames. `version` is a cache-buster the server ignores —
 * changing it is how a refresh reloads a page whose address did not change.
 */
export function walkthroughPageUrl(
  rootPath: string,
  relPath: string,
  version?: number | string,
  theme?: WalkthroughTheme,
): string {
  const base =
    `${WALKTHROUGH_PAGE_SCHEME}://${WALKTHROUGH_PAGE_HOST}/` +
    `?root=${encodeURIComponent(rootPath)}&path=${encodeURIComponent(relPath)}`
  const versioned = version === undefined ? base : `${base}&v=${encodeURIComponent(String(version))}`
  return theme === undefined ? versioned : `${versioned}&theme=${theme}`
}

/**
 * The theme Flow is showing. Passed with the page so a walkthrough framed in a
 * dark Flow is dark — the page itself cannot read its host (it is sandboxed to
 * an opaque origin), and `prefers-color-scheme` follows the OS, not Flow.
 */
export type WalkthroughTheme = 'dark' | 'light'

/** A parsed walkthrough page request: which project, which page, which theme. */
export interface WalkthroughPageRequest {
  root: string
  path: string
  /** Absent when the URL named none — the page then follows the OS. */
  theme?: WalkthroughTheme
}

/**
 * Stamp Flow's theme onto the page's `<html>` — the template's tokens key on
 * `data-theme`. An existing `data-theme` is replaced; a page with no `<html>`
 * tag is left as written.
 */
export function withTheme(html: string, theme: WalkthroughTheme): string {
  return html.replace(/<html\b([^>]*)>/i, (_tag, attrs: string) => {
    const kept = attrs.replace(/\sdata-theme\s*=\s*("[^"]*"|'[^']*'|\S+)/i, '')
    return `<html${kept} data-theme="${theme}">`
  })
}

/**
 * Parse a `flow-page://walkthrough/?root=…&path=…` URL, or null when it is not
 * one — wrong scheme or host, a missing parameter, or a path that is not a
 * walkthrough page. Root membership is NOT decided here: only main knows which
 * roots exist.
 */
export function parseWalkthroughPageUrl(url: string): WalkthroughPageRequest | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${WALKTHROUGH_PAGE_SCHEME}:`) return null
  if (parsed.hostname !== WALKTHROUGH_PAGE_HOST) return null
  const root = parsed.searchParams.get('root')
  const path = parsed.searchParams.get('path')
  if (root === null || root.length === 0 || path === null) return null
  if (!isWalkthroughPath(path)) return null
  const theme = parsed.searchParams.get('theme')
  return theme === 'dark' || theme === 'light' ? { root, path, theme } : { root, path }
}
