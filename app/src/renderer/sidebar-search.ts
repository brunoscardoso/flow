/**
 * The sidebar's search row and its results (polish, 2026-11-17).
 *
 * One box under the tabs finds threads and files; a small square beside it
 * starts a new thing — a thread on Threads and Changes, a file on Files. While
 * the box holds a query the results take the pane's place; Esc or clearing the
 * box gives the pane back.
 *
 * Every decision is in `sidebar-search-model.ts`. This file fetches (the
 * store's thread search, and each project's file list, which main caches per
 * root — allowed-pattern #20) and paints.
 */

import { workspaceScope } from './threads/workspace-scope'
import { fileIconBadge, fileIconColor } from './editor/file-icon-color'
import {
  SEARCH_COPY,
  fileHits,
  flatHits,
  groupResults,
  moveCursor,
  newActionFor,
  newMenuFor,
  searchModeFor,
  normaliseQuery,
  threadHits,
  type FileHit,
  type SearchGroup,
  type SearchKind,
  type SidebarTab,
  type ThreadHit,
} from './sidebar-search-model'

/** How long typing must pause before a search runs. */
const SEARCH_DEBOUNCE_MS = 120
/** Files read per project for name matching. Main caches the walk. */
const FILE_LIST_LIMIT = 20_000
/** Projects searched at once — the first ones in view. */
const MAX_SEARCH_ROOTS = 6

interface SearchApi {
  threads: { search(request: { query: string }): Promise<Array<{ id: string; title: string; projectRoot: string }>> }
  project: { listAllFiles(request: { rootPath: string; limit?: number }): Promise<{ relPaths: string[] }> }
}

function api(): SearchApi | null {
  return (window as unknown as { flow?: SearchApi }).flow ?? null
}

export interface SidebarSearch {
  /** The row: the search box and the New button. */
  row: HTMLElement
  /** The results, shown in place of the pane while there is a query. */
  results: HTMLElement
  /** Tell the search which tab is open (orders groups, labels New). */
  setTab(tab: SidebarTab): void
  /** Put the cursor in the box. */
  focus(): void
}

export function createSidebarSearch(onSearchingChange: (searching: boolean) => void): SidebarSearch {
  injectStyles()
  let tab: SidebarTab = 'threads'
  let only: SearchKind | null = null
  let groups: SearchGroup[] = []
  let cursor = -1
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let searching = false
  let allThreads: ThreadHit[] = []
  let allFiles: FileHit[] = []

  const row = document.createElement('div')
  row.className = 'fl-sidebar-search-row'

  const box = document.createElement('label')
  box.className = 'fl-sidebar-search'
  const glass = document.createElement('fl-icon')
  glass.setAttribute('name', 'search')
  glass.setAttribute('size', '13')
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = SEARCH_COPY.placeholder
  input.setAttribute('aria-label', SEARCH_COPY.placeholder)
  input.spellcheck = false
  const kbd = document.createElement('kbd')
  kbd.className = 'fl-sidebar-search-kbd'
  kbd.textContent = '⌘K'
  kbd.setAttribute('aria-hidden', 'true')
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'fl-sidebar-search-clear'
  clear.setAttribute('aria-label', 'Clear search')
  clear.hidden = true
  const clearIcon = document.createElement('fl-icon')
  clearIcon.setAttribute('name', 'close')
  clearIcon.setAttribute('size', '10')
  clear.appendChild(clearIcon)
  box.append(glass, input, kbd, clear)

  const newButton = document.createElement('button')
  newButton.type = 'button'
  newButton.className = 'fl-sidebar-new'
  const plus = document.createElement('fl-icon')
  plus.setAttribute('name', 'plus')
  plus.setAttribute('size', '11')
  newButton.appendChild(plus)
  newButton.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent(newActionFor(tab).event))
  })
  newButton.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    openNewMenu(newButton, tab)
  })
  row.append(box, newButton)

  const results = document.createElement('div')
  results.className = 'fl-sidebar-results'
  results.hidden = true
  results.setAttribute('role', 'listbox')
  results.setAttribute('aria-label', 'Search results')

  function paintNew(): void {
    const { label } = newActionFor(tab)
    newButton.title = tab === 'files' ? label : `${label} (⌘N)`
    newButton.setAttribute('aria-label', label)
  }

  const filtering = (): boolean => searchModeFor(tab) === 'filter-list'
  /** The thread list's own filter box, hidden under this one. */
  const listFilter = (): HTMLInputElement | null =>
    document.querySelector<HTMLInputElement>('.fl-activity-sidebar .fl-thread-search input')

  /** Hand the text to the list's filter, so every behaviour it has stays its own. */
  function mirror(value: string): void {
    const target = listFilter()
    if (target === null || target.value === value) return
    target.value = value
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** Show what the mode calls for: on Threads the list stays and only files
   *  that match show above it; elsewhere the results take the pane's place. */
  function layout(): void {
    const filter = filtering()
    results.classList.toggle('filter-list', filter)
    results.hidden = !searching || (filter && allFiles.length === 0)
    kbd.hidden = searching
    clear.hidden = !searching
    onSearchingChange(searching && !filter)
  }

  function setSearching(next: boolean): void {
    if (next === searching) return
    searching = next
    layout()
  }

  function reset(fromList = false): void {
    if (!fromList) mirror('')
    input.value = ''
    only = null
    groups = []
    cursor = -1
    generation += 1
    if (timer !== null) clearTimeout(timer)
    timer = null
    results.replaceChildren()
    setSearching(false)
  }

  async function run(query: string): Promise<void> {
    const mine = ++generation
    const flow = api()
    if (flow === null) return
    const roots = workspaceScope.scopeRoots().slice(0, MAX_SEARCH_ROOTS)
    const [threads, lists] = await Promise.all([
      flow.threads.search({ query }).catch(() => []),
      Promise.all(
        roots.map((rootPath) =>
          flow.project
            .listAllFiles({ rootPath, limit: FILE_LIST_LIMIT })
            .then((listing) => ({ rootPath, relPaths: listing.relPaths }))
            .catch(() => ({ rootPath, relPaths: [] as string[] })),
        ),
      ),
    ])
    if (mine !== generation) return // a newer query took over
    const threadMatches = threadHits(threads, workspaceScope.scopeRoots())
    const fileMatches = fileHits(lists, query)
    allThreads = threadMatches
    allFiles = fileMatches
    cursor = -1
    paint()
  }

  function paint(): void {
    const filter = filtering()
    groups = groupResults(allThreads, allFiles, tab, filter ? 'files' : only)
    const nodes: Node[] = []
    if (!filter && allThreads.length > 0 && allFiles.length > 0) nodes.push(chips())
    const flat = flatHits(groups)
    if (flat.length === 0 && !filter) {
      const none = document.createElement('p')
      none.className = 'fl-sidebar-results-empty'
      none.textContent = SEARCH_COPY.nothing
      nodes.push(none)
    }
    let index = 0
    for (const group of groups) {
      const head = document.createElement('div')
      head.className = 'fl-sidebar-results-head'
      head.textContent = group.kind === 'threads' ? SEARCH_COPY.threads : SEARCH_COPY.files
      nodes.push(head)
      for (const hit of group.hits) {
        nodes.push(hitRow(hit, index))
        index += 1
      }
    }
    results.replaceChildren(...nodes)
    layout()
  }

  function chips(): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'fl-sidebar-results-chips'
    const entries: Array<{ kind: SearchKind | null; label: string }> = [
      { kind: null, label: SEARCH_COPY.all },
      { kind: 'threads', label: `${SEARCH_COPY.threads} ${String(allThreads.length)}` },
      { kind: 'files', label: `${SEARCH_COPY.files} ${String(allFiles.length)}` },
    ]
    for (const entry of entries) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'fl-sidebar-chip'
      chip.textContent = entry.label
      chip.setAttribute('aria-pressed', String(only === entry.kind))
      chip.addEventListener('mousedown', (event) => event.preventDefault()) // keep the box focused
      chip.addEventListener('click', () => {
        only = entry.kind
        cursor = -1
        paint()
      })
      wrap.appendChild(chip)
    }
    return wrap
  }

  function hitRow(hit: ThreadHit | FileHit, index: number): HTMLElement {
    const rowEl = document.createElement('button')
    rowEl.type = 'button'
    rowEl.className = 'fl-sidebar-hit'
    rowEl.setAttribute('role', 'option')
    rowEl.dataset['kind'] = hit.kind
    rowEl.classList.toggle('cursor', index === cursor)
    rowEl.setAttribute('aria-selected', String(index === cursor))
    const q = normaliseQuery(input.value)
    if (hit.kind === 'thread') {
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', 'message')
      icon.setAttribute('size', '13')
      icon.className = 'fl-sidebar-hit-icon'
      rowEl.append(icon, highlighted(hit.title, q, 'fl-sidebar-hit-name'))
    } else {
      const badge = fileIconBadge(hit.name)
      const mark = document.createElement('span')
      mark.className = 'fl-sidebar-hit-mark'
      mark.style.color = fileIconColor(hit.name)
      if (badge !== null) {
        mark.textContent = badge
      } else {
        const icon = document.createElement('fl-icon')
        icon.setAttribute('name', 'file')
        icon.setAttribute('size', '13')
        mark.appendChild(icon)
      }
      const folder = document.createElement('span')
      folder.className = 'fl-sidebar-hit-meta'
      folder.textContent = hit.folder
      rowEl.append(mark, highlighted(hit.name, q, 'fl-sidebar-hit-name'), folder)
    }
    rowEl.addEventListener('mousedown', (event) => event.preventDefault())
    rowEl.addEventListener('click', () => open(hit))
    return rowEl
  }

  function open(hit: ThreadHit | FileHit): void {
    if (hit.kind === 'thread') {
      document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: hit.id } }))
    } else {
      document.dispatchEvent(
        new CustomEvent('flow:open-file', { detail: { rootPath: hit.rootPath, relPath: hit.relPath } }),
      )
    }
    reset()
  }

  input.addEventListener('input', () => {
    mirror(input.value)
    const query = normaliseQuery(input.value)
    if (timer !== null) clearTimeout(timer)
    if (query === '') {
      reset()
      return
    }
    setSearching(true)
    timer = setTimeout(() => {
      timer = null
      void run(query)
    }, SEARCH_DEBOUNCE_MS)
  })

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (input.value !== '') {
        event.preventDefault()
        event.stopPropagation()
        reset()
      } else {
        input.blur()
      }
      return
    }
    if (filtering() && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) {
      // The list walks its own rows (#1172) — the files above are a click away.
      event.preventDefault()
      listFilter()?.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true, cancelable: true }))
      return
    }
    const flat = flatHits(groups)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      cursor = moveCursor(cursor, event.key === 'ArrowDown' ? 1 : -1, flat.length)
      paint()
      results.querySelector('.fl-sidebar-hit.cursor')?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter') {
      const hit = flat[cursor >= 0 ? cursor : 0]
      if (hit !== undefined) {
        event.preventDefault()
        open(hit)
      }
    }
  })

  clear.addEventListener('click', (event) => {
    event.preventDefault()
    reset()
    input.focus()
  })

  // The list clears its own filter at times (a thread made or renamed under
  // it, its own Escape) — this box follows, so the two never disagree.
  document.addEventListener('flow:thread-search-cleared', () => {
    if (input.value !== '') reset(true)
  })

  paintNew()

  return {
    row,
    results,
    setTab(next: SidebarTab): void {
      tab = next
      paintNew()
      if (searching) paint()
      else layout()
    },
    focus(): void {
      input.focus()
      input.select()
    },
  }
}

/** The right-click menu of New: every other thing it can start. */
function openNewMenu(anchor: HTMLElement, tab: SidebarTab): void {
  document.querySelector('.fl-sidebar-new-menu')?.remove()
  const menu = document.createElement('div')
  menu.className = 'fl-sidebar-new-menu'
  menu.setAttribute('role', 'menu')
  const close = (): void => {
    menu.remove()
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }
  const onOutside = (event: MouseEvent): void => {
    if (!menu.contains(event.target as Node)) close()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      anchor.focus()
    }
  }
  for (const entry of newMenuFor(tab)) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'fl-sidebar-new-menu-item'
    item.setAttribute('role', 'menuitem')
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', entry.icon)
    icon.setAttribute('size', '14')
    const label = document.createElement('span')
    label.textContent = entry.label
    item.append(icon, label)
    item.addEventListener('click', () => {
      close()
      document.dispatchEvent(new CustomEvent(entry.event))
    })
    menu.appendChild(item)
  }
  document.body.appendChild(menu)
  const box = anchor.getBoundingClientRect()
  const width = menu.offsetWidth
  menu.style.left = `${String(Math.max(4, Math.min(box.left, window.innerWidth - width - 4)))}px`
  menu.style.top = `${String(box.bottom + 4)}px`
  document.addEventListener('mousedown', onOutside, true)
  document.addEventListener('keydown', onKey, true)
  menu.querySelector<HTMLButtonElement>('button')?.focus()
}

/** The text with the first run that matches the query marked. */
function highlighted(text: string, query: string, className: string): HTMLElement {
  const span = document.createElement('span')
  span.className = className
  const at = query === '' ? -1 : text.toLowerCase().indexOf(query)
  if (at === -1) {
    span.textContent = text
    return span
  }
  const mark = document.createElement('mark')
  mark.textContent = text.slice(at, at + query.length)
  span.append(text.slice(0, at), mark, text.slice(at + query.length))
  return span
}

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-sidebar-search-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: none;
      padding: 0 8px 8px;
    }
    .fl-sidebar-search {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
      height: 28px;
      box-sizing: border-box;
      padding: 0 6px 0 9px;
      border: var(--fl-border-width) solid var(--fl-color-island-border);
      border-radius: 7px;
      background: var(--fl-color-ground);
      color: var(--fl-color-text-secondary);
      cursor: text;
    }
    .fl-sidebar-search:focus-within { border-color: var(--fl-color-accent); }
    .fl-sidebar-search input {
      flex: 1;
      min-width: 0;
      border: none;
      outline: none;
      background: transparent;
      color: var(--fl-color-text);
      font: inherit;
      font-size: 12.5px;
      padding: 0;
    }
    .fl-sidebar-search input::placeholder { color: var(--fl-color-text-secondary); }
    .fl-sidebar-search-kbd {
      flex: none;
      padding: 1px 5px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui);
      font-size: 10.5px;
      line-height: 1.3;
      color: var(--fl-color-text-secondary);
    }
    .fl-sidebar-search-clear {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
      padding: 0;
    }
    .fl-sidebar-search-clear:hover { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    /* NEW: a quiet square the search box's own height and weight (user,
       2026-11-17: "a light button of the new, something small"). Hover tells
       you what it makes. */
    .fl-sidebar-new {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      box-sizing: border-box;
      padding: 0;
      border: var(--fl-border-width) solid var(--fl-color-island-border);
      border-radius: 7px;
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
      cursor: pointer;
      transition: background-color var(--fl-transition-fast);
    }
    .fl-sidebar-new:hover { background: var(--fl-color-surface-selected); color: var(--fl-color-text); }
    .fl-sidebar-new:focus-visible { outline: none; border-color: var(--fl-color-accent); }
    .fl-sidebar-new-menu {
      position: fixed;
      z-index: 900;
      min-width: 190px;
      padding: 4px;
      display: flex;
      flex-direction: column;
      gap: 1px;
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    }
    .fl-sidebar-new-menu-item {
      display: flex;
      align-items: center;
      gap: 8px;
      height: 28px;
      padding: 0 8px;
      border: none;
      border-radius: var(--fl-radius-row);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    .fl-sidebar-new-menu-item fl-icon { color: var(--fl-color-text-secondary); }
    .fl-sidebar-new-menu-item:hover,
    .fl-sidebar-new-menu-item:focus-visible { outline: none; background: var(--fl-color-surface-selected); }
    .fl-sidebar-results.filter-list {
      flex: none;
      max-height: 40%;
      border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
      margin-bottom: 4px;
    }
    .fl-sidebar-results {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 0 6px 8px;
    }
    .fl-sidebar-results-chips { display: flex; gap: 6px; padding: 0 4px 8px; }
    .fl-sidebar-chip {
      border: var(--fl-border-width) solid var(--fl-color-island-border);
      border-radius: 999px;
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      font-size: 11.5px;
      padding: 2px 9px;
      cursor: pointer;
    }
    .fl-sidebar-chip[aria-pressed="true"] {
      border-color: transparent;
      background: var(--fl-color-surface-selected);
      color: var(--fl-color-text);
    }
    .fl-sidebar-results-head {
      height: 26px;
      display: flex;
      align-items: center;
      padding: 0 4px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--fl-color-text-secondary);
    }
    .fl-sidebar-results-empty {
      margin: 8px 4px;
      color: var(--fl-color-text-secondary);
      font-size: 12.5px;
    }
    .fl-sidebar-hit {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: 28px;
      padding: 0 8px;
      border: none;
      border-radius: var(--fl-radius-row);
      background: transparent;
      color: var(--fl-color-text);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
    }
    .fl-sidebar-hit:hover { background: var(--fl-color-surface-raised); }
    .fl-sidebar-hit.cursor { background: var(--fl-color-surface-selected); }
    .fl-sidebar-hit-icon { flex: none; color: var(--fl-color-text-secondary); }
    .fl-sidebar-hit-mark {
      flex: none;
      min-width: 16px;
      display: inline-flex;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .fl-sidebar-hit-name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .fl-sidebar-hit-name mark {
      background: var(--fl-color-accent-soft);
      color: var(--fl-color-text);
      border-radius: 3px;
    }
    .fl-sidebar-hit-meta {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: right;
      font-size: 11.5px;
      color: var(--fl-color-text-secondary);
    }
  `
  document.head.appendChild(style)
}
