/**
 * BROWSER TABS — the pure rules behind the built-in browser's tab row.
 *
 * DOM-free and Electron-free: `renderer/browser/browser-tab.ts` keeps the
 * state and draws it, main's guest open handler asks `opensInFlow`.
 *
 * What a tab is: an address and a title, and maybe a live page. A tab without
 * a live page is ASLEEP — it keeps its address and title and loads again when
 * it is opened. At most LIVE_TAB_CAP pages run at once; past that the tab used
 * longest ago goes to sleep.
 */

export const LIVE_TAB_CAP = 6

/** The tab shortcuts, by what they do. Pressed inside a page, main forwards them. */
export type BrowserTabShortcut =
  | { kind: 'new' }
  | { kind: 'close' }
  | { kind: 'reopen' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'goto'; digit: number }

/** The key facts a shortcut is read from — the shape of Electron's input event and of a DOM KeyboardEvent alike. */
export interface ShortcutKeys {
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

/**
 * Which tab shortcut a key press is, or null. ⌘ on macOS, Ctrl elsewhere —
 * `mac` says which. ⌃Tab / ⌃⇧Tab move between tabs on every platform.
 */
export function tabShortcut(keys: ShortcutKeys, mac: boolean): BrowserTabShortcut | null {
  if (keys.alt) return null
  const key = keys.key.length === 1 ? keys.key.toLowerCase() : keys.key
  if (keys.control && key === 'Tab') return { kind: keys.shift ? 'previous' : 'next' }
  const command = mac ? keys.meta && !keys.control : keys.control && !keys.meta
  if (!command) return null
  if (key === 't') return { kind: keys.shift ? 'reopen' : 'new' }
  if (key === 'w' && !keys.shift) return { kind: 'close' }
  if (!keys.shift && /^[1-9]$/.test(key)) return { kind: 'goto', digit: Number(key) }
  return null
}
/** How many closed tabs ⌘⇧T can bring back. */
export const CLOSED_TAB_MEMORY = 10

export interface BrowserTab {
  id: string
  /** Where the tab is, or null for a new blank tab. */
  url: string | null
  title: string
  /** A live page exists for it. */
  live: boolean
  /** When it was last the active tab (for choosing who sleeps). */
  lastUsed: number
  /** Errors logged since it was last looked at — the red dot. */
  unseenErrors: number
}

export interface BrowserTabsState {
  tabs: BrowserTab[]
  activeId: string | null
  /** Most recent last. */
  closed: Array<{ url: string; title: string }>
}

/** What a conversation's tab set remembers about its browser. */
export interface SavedBrowserTabs {
  tabs: Array<{ url: string | null; title: string }>
  active: number
}

export function emptyTabs(): BrowserTabsState {
  return { tabs: [], activeId: null, closed: [] }
}

export function activeTab(state: BrowserTabsState): BrowserTab | null {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null
}

/** A title for a tab: the page's own, else its host, else "New tab". */
export function tabTitle(url: string | null, pageTitle: string | null | undefined): string {
  const title = (pageTitle ?? '').trim()
  if (title !== '' && title !== url) return title
  if (url === null || url === '' || url === 'about:blank') return 'New tab'
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
    }
    return url
  } catch {
    return url
  }
}

/**
 * Add a tab. `after`: placed right after that tab (a link opened from it),
 * else at the end. `activate`: becomes the active tab (else it opens behind).
 */
export function addTab(
  state: BrowserTabsState,
  input: { id: string; url: string | null; title?: string; after?: string | null; activate: boolean; now: number },
): BrowserTabsState {
  const tab: BrowserTab = {
    id: input.id,
    url: input.url,
    title: input.title ?? tabTitle(input.url, null),
    live: input.activate,
    lastUsed: input.activate ? input.now : 0,
    unseenErrors: 0,
  }
  const tabs = [...state.tabs]
  const at = input.after === undefined || input.after === null ? -1 : tabs.findIndex((t) => t.id === input.after)
  tabs.splice(at === -1 ? tabs.length : at + 1, 0, tab)
  return { ...state, tabs, activeId: input.activate ? tab.id : state.activeId ?? tab.id }
}

/**
 * Close a tab. The next active tab is the one to its right, else its left —
 * as in every browser. Null active when none is left.
 */
export function closeTab(state: BrowserTabsState, id: string): BrowserTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index === -1) return state
  const closing = state.tabs[index] as BrowserTab
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  let activeId = state.activeId
  if (activeId === id) activeId = (tabs[index] ?? tabs[index - 1] ?? null)?.id ?? null
  const closed =
    closing.url === null
      ? state.closed
      : [...state.closed, { url: closing.url, title: closing.title }].slice(-CLOSED_TAB_MEMORY)
  return { tabs, activeId, closed }
}

/** Take the most recently closed tab off the stack. */
export function popClosed(state: BrowserTabsState): { state: BrowserTabsState; tab: { url: string; title: string } | null } {
  const tab = state.closed[state.closed.length - 1] ?? null
  return { state: { ...state, closed: state.closed.slice(0, -1) }, tab }
}

/** Make a tab active; it is live from now on and its errors are seen. */
export function activate(state: BrowserTabsState, id: string, now: number): BrowserTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state
  return {
    ...state,
    activeId: id,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, live: true, lastUsed: now, unseenErrors: 0 } : tab)),
  }
}

/** The live tabs that must sleep to stay within the cap — never the active one. */
export function tabsToSleep(state: BrowserTabsState, cap = LIVE_TAB_CAP): string[] {
  const live = state.tabs.filter((tab) => tab.live)
  if (live.length <= cap) return []
  return live
    .filter((tab) => tab.id !== state.activeId)
    .sort((a, b) => a.lastUsed - b.lastUsed)
    .slice(0, live.length - cap)
    .map((tab) => tab.id)
}

export function markAsleep(state: BrowserTabsState, ids: readonly string[]): BrowserTabsState {
  if (ids.length === 0) return state
  return { ...state, tabs: state.tabs.map((tab) => (ids.includes(tab.id) ? { ...tab, live: false } : tab)) }
}

export function updateTab(state: BrowserTabsState, id: string, patch: Partial<Pick<BrowserTab, 'url' | 'title' | 'unseenErrors'>>): BrowserTabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) }
}

/** Move a tab to a position (drag to reorder). */
export function moveTab(state: BrowserTabsState, id: string, toIndex: number): BrowserTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === id)
  if (from === -1) return state
  const tabs = [...state.tabs]
  const [tab] = tabs.splice(from, 1)
  const at = Math.max(0, Math.min(tabs.length, toIndex))
  tabs.splice(at, 0, tab as BrowserTab)
  return { ...state, tabs }
}

/** The tab `delta` steps from the active one, wrapping (⌃Tab / ⌃⇧Tab). */
export function neighbourTab(state: BrowserTabsState, delta: number): string | null {
  if (state.tabs.length === 0) return null
  const index = Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeId))
  const next = (index + delta + state.tabs.length * 4) % state.tabs.length
  return state.tabs[next]?.id ?? null
}

/** ⌘1–⌘8 go to that position; ⌘9 goes to the last tab, as in every browser. */
export function tabAtShortcut(state: BrowserTabsState, digit: number): string | null {
  if (digit < 1 || digit > 9 || state.tabs.length === 0) return null
  if (digit === 9) return state.tabs[state.tabs.length - 1]?.id ?? null
  return state.tabs[digit - 1]?.id ?? null
}

/**
 * The saved tabs as the flat record a view's saved state must be: the list as
 * JSON, the active index, and the active address as `url` (what builds before
 * tabs read).
 */
export function flatTabs(saved: SavedBrowserTabs): Record<string, string | number | null> {
  return { tabs: JSON.stringify(saved.tabs), active: saved.active, url: saved.tabs[saved.active]?.url ?? null }
}

export function saveTabs(state: BrowserTabsState): SavedBrowserTabs {
  const active = Math.max(0, state.tabs.findIndex((tab) => tab.id === state.activeId))
  return { tabs: state.tabs.map((tab) => ({ url: tab.url, title: tab.title })), active }
}

/**
 * A saved tab set as state: every tab asleep, the saved active one chosen.
 * Accepts the older single-page shape `{ url }` too.
 */
export function restoreTabs(saved: unknown, newId: () => string): BrowserTabsState {
  const state = emptyTabs()
  if (typeof saved !== 'object' || saved === null) return state
  const record = saved as { tabs?: unknown; active?: unknown; url?: unknown }
  const list: Array<{ url: string | null; title: string }> = []
  let entries: unknown = record.tabs
  if (typeof entries === 'string') {
    try {
      entries = JSON.parse(entries) as unknown
    } catch {
      entries = undefined
    }
  }
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) continue
      const url = (entry as { url?: unknown }).url
      const title = (entry as { title?: unknown }).title
      const safeUrl = typeof url === 'string' && url !== '' ? url : null
      list.push({ url: safeUrl, title: typeof title === 'string' && title !== '' ? title : tabTitle(safeUrl, null) })
    }
  } else if (typeof record.url === 'string' && record.url !== '') {
    list.push({ url: record.url, title: tabTitle(record.url, null) })
  }
  if (list.length === 0) return state
  const tabs: BrowserTab[] = list.map((entry) => ({ id: newId(), url: entry.url, title: entry.title, live: false, lastUsed: 0, unseenErrors: 0 }))
  const index = typeof record.active === 'number' && record.active >= 0 && record.active < tabs.length ? record.active : 0
  return { tabs, activeId: tabs[index]?.id ?? null, closed: [] }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

/**
 * Whether a new window a page asks for opens as a Flow tab (true) or in the
 * person's own browser (false). A tab: the same host as the page, or a local
 * address (another dev server). Your own browser: any other site.
 */
export function opensInFlow(openerUrl: string | null, targetUrl: string): boolean {
  let target: URL
  try {
    target = new URL(targetUrl)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
  const host = target.hostname.toLowerCase()
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return true
  if (openerUrl === null) return false
  try {
    return new URL(openerUrl).hostname.toLowerCase() === host
  } catch {
    return false
  }
}
