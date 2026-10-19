/**
 * THE APP'S OWN PAGE — what the main window is allowed to show, and the only
 * page whose top frame may call the share channels (review R2-M8).
 *
 * Packaged and e2e builds load `out/renderer/index.html` from disk; `npm run
 * dev` loads the Vite server at `ELECTRON_RENDERER_URL`. The entry is decided
 * once, where the window is loaded, and every check reads it from here:
 *
 *  · `isAppEntryUrl` — the sender check pins `senderFrame.url` to it, so a
 *    window navigated anywhere else keeps its preload but loses share access.
 *  · `shouldBlockNavigation` — the main window's `will-navigate` and
 *    `will-frame-navigate` (top frame) guards refuse anything else, which also
 *    covers a file or link dropped onto the window (Chromium navigates to it).
 *    A reload of the entry itself is allowed, so dev hot reload keeps working.
 *
 * Pure: no Electron import, so the rules are testable under node-env jest.
 */
import { pathToFileURL } from 'url'

export type AppEntry =
  /** The built renderer, loaded from disk — matched by its exact file path. */
  | { kind: 'file'; href: string }
  /** The dev server — matched by origin (Vite serves every module from it). */
  | { kind: 'dev'; origin: string }

/** The entry the main window loads: the dev server when one is given, else the built page. */
export function appEntryFor(devRendererUrl: string | undefined, indexHtmlPath: string): AppEntry {
  if (devRendererUrl !== undefined && devRendererUrl !== '') {
    try {
      const origin = new URL(devRendererUrl).origin
      if (origin !== 'null') return { kind: 'dev', origin }
    } catch {
      // An unparseable dev URL falls through to the built page, which is what
      // the window would fail over to anyway.
    }
  }
  return { kind: 'file', href: pathToFileURL(indexHtmlPath).href }
}

/** Whether `url` is the app's own page (query and fragment ignored). */
export function isAppEntryUrl(url: string, entry: AppEntry): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (entry.kind === 'dev') {
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === entry.origin
  }
  if (parsed.protocol !== 'file:') return false
  const expected = new URL(entry.href)
  return parsed.host === expected.host && decodeURIComponent(parsed.pathname) === decodeURIComponent(expected.pathname)
}

/** The main window's navigation guard: anything but the app's own page is refused. */
export function shouldBlockNavigation(url: string, entry: AppEntry): boolean {
  return !isAppEntryUrl(url, entry)
}

/**
 * A refused navigation that was a web link a person clicked goes to their
 * browser, the way the window-open handler already sends `target=_blank` links.
 * Anything else — a dropped file, `javascript:`, a custom scheme — just stops.
 */
export function opensExternally(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
