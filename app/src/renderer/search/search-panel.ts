// Content-search panel — the thin DOM view over SearchViewModel. An input row
// above a virtualized <fl-list> of file-header + match rows. Typing drives the
// (debounced, stale-guarded) view model; activating a match row dispatches
// flow:open-file with a line so the editor jumps to it. All logic lives in the
// view model; this file is presentation + event wiring only, so it is not
// unit-tested (mirrors command-palette.ts vs palette-sources.ts).

import type { FlList, ListItemDetail } from '../components'
import { fileIconColor } from '../editor/file-icon-color'
import {
  SearchViewModel,
  type SearchContentFn,
  type SearchDisplayRow,
  type SearchView,
} from './search-view-model'

export interface SearchPanelDeps {
  searchContent: SearchContentFn
  /** The roots to search — the active thread scope's roots. */
  getRoots: () => string[]
}

/** One result row, in pixels — the list is virtualized and needs it twice: to
 *  lay its rows out, and to know how tall it is. */
const SEARCH_ROW_HEIGHT = 28

export class SearchPanel {
  #input: HTMLInputElement
  #status: HTMLDivElement
  #list: FlList<SearchDisplayRow>
  #model: SearchViewModel
  /** The panel's own element — it publishes its state for the pane around it. */
  #container: HTMLElement

  constructor(container: HTMLElement, deps: SearchPanelDeps) {
    this.#container = container
    container.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;'

    // ── Input row ──────────────────────────────────────────────────────────
    const header = document.createElement('div')
    header.className = 'fl-search-header'
    // THE RULE UNDER THE INPUT IS NOT THIS FILE'S TO DECIDE.
    //
    // It was set here, inline — which beats any stylesheet rule — so the pane
    // that holds this panel could not take it off, and a border meant to divide
    // an input from its results kept dividing the search box from the file tree
    // instead (user, 2026-09-18). The panel owns its layout; whether it needs a
    // rule against its neighbour depends on what its neighbour is, and only the
    // pane knows that.
    header.style.cssText = 'flex:none;padding:var(--fl-space-sm);'

    this.#input = document.createElement('input')
    this.#input.type = 'text'
    this.#input.placeholder = 'Search in files'
    this.#input.setAttribute('aria-label', 'Search file contents')
    this.#input.className = 'fl-search-input'
    this.#input.style.cssText =
      'width:100%;box-sizing:border-box;padding:var(--fl-space-xs) var(--fl-space-sm);' +
      'background:var(--fl-color-surface-sunken);color:var(--fl-color-text);' +
      'border:1px solid var(--fl-color-border);border-radius:var(--fl-radius-sm);' +
      'font-size:var(--fl-text-ui-size);outline:none;'
    header.appendChild(this.#input)

    // ── Status / summary line ────────────────────────────────────────────────
    this.#status = document.createElement('div')
    this.#status.className = 'fl-search-status'
    this.#status.style.cssText =
      'flex:none;padding:var(--fl-space-xs) var(--fl-space-sm);' +
      'color:var(--fl-color-text-secondary);font-size:var(--fl-text-caption-size);'

    // ── Results list ─────────────────────────────────────────────────────────
    this.#list = document.createElement('fl-list') as unknown as FlList<SearchDisplayRow>
    // SIZED TO ITS RESULTS, NOT TO ITS SHARE. The panel sits above the file
    // tree now, so a fixed half-pane would leave 200px of dead ground between
    // five matches and the tree. `#render` sets the height from the row count;
    // the pane's CSS caps it.
    this.#list.style.cssText = 'flex:none;min-height:0;'
    this.#list.rowHeight = SEARCH_ROW_HEIGHT
    this.#list.renderItem = (row) => this.#renderRow(row)
    this.#list.addEventListener('fl-list-activate', (event) => {
      const { item } = (event as CustomEvent<ListItemDetail<SearchDisplayRow>>).detail
      this.#activate(item)
    })

    container.append(header, this.#status, this.#list)

    this.#model = new SearchViewModel({
      searchContent: deps.searchContent,
      getRoots: deps.getRoots,
      onUpdate: (view) => this.#render(view),
    })

    this.#input.addEventListener('input', () => this.#model.runQuery(this.#input.value))

    this.#render({
      state: 'idle',
      query: '',
      rows: [],
      truncated: false,
      totalMatches: 0,
      fileCount: 0,
    })
  }

  /** Focus (and select) the input — used when the panel is revealed (⌘⇧F). */
  focusInput(): void {
    this.#input.focus()
    this.#input.select()
  }

  #render(view: SearchView): void {
    this.#list.items = view.rows
    this.#status.textContent = this.#statusText(view)
    // The list is virtualized, so it cannot measure itself — its height is the
    // rows it holds, and the pane's `max-height` is what stops it taking over.
    this.#list.style.height = `${view.rows.length * SEARCH_ROW_HEIGHT}px`
    // WHAT THE PANEL IS DOING, PUBLISHED FOR WHOEVER HOLDS IT.
    //
    // Inside the Files pane the search box shares its height with the tree, and
    // an idle search must take only the row its input needs — a results list
    // reserving half the explorer for "Type to search file contents." would be
    // the gutter this whole layout avoids. The pane's CSS reads this attribute;
    // the panel does not know or care which pane it is in.
    this.#container.dataset['searchState'] = view.state
  }

  #statusText(view: SearchView): string {
    switch (view.state) {
      case 'idle':
        return 'Type to search file contents.'
      case 'searching':
        return 'Searching…'
      case 'empty':
        return `No matches for “${view.query}”.`
      case 'results': {
        const files = `${view.fileCount} file${view.fileCount === 1 ? '' : 's'}`
        const matches = `${view.totalMatches} match${view.totalMatches === 1 ? '' : 'es'}`
        return view.truncated
          ? `Showing first ${matches} in ${files} — refine your search for more.`
          : `${matches} in ${files}.`
      }
    }
  }

  #activate(row: SearchDisplayRow): void {
    const detail =
      row.kind === 'match'
        ? { rootPath: row.rootPath, relPath: row.relPath, line: row.line, column: row.column }
        : { rootPath: row.rootPath, relPath: row.relPath }
    document.dispatchEvent(new CustomEvent('flow:open-file', { detail }))
  }

  // Rows render INSIDE the <fl-list> shadow DOM, so styling is INLINE (custom
  // properties still inherit). Mirrors the file tree / palette rows.
  #renderRow(row: SearchDisplayRow): HTMLElement {
    const el = document.createElement('div')
    el.style.cssText = 'display:flex;align-items:center;gap:var(--fl-space-sm);width:100%;'

    if (row.kind === 'file') {
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', 'file')
      icon.setAttribute('size', '14')
      icon.style.flex = 'none'
      icon.style.color = fileIconColor(row.relPath)

      const name = document.createElement('span')
      name.textContent = baseName(row.relPath)
      name.style.cssText =
        'flex:none;color:var(--fl-color-text);font-size:var(--fl-text-ui-size);white-space:nowrap;'

      const dir = document.createElement('span')
      dir.textContent = dirName(row.relPath)
      dir.style.cssText =
        'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:var(--fl-color-text-secondary);font-size:var(--fl-text-caption-size);'

      const count = document.createElement('span')
      count.textContent = String(row.matchCount)
      count.style.cssText =
        'flex:none;color:var(--fl-color-text-secondary);font-size:var(--fl-text-caption-size);'

      el.append(icon, name, dir, count)
      return el
    }

    // Match row: indented "line  preview" with the matched substring highlighted.
    el.style.paddingLeft = 'var(--fl-space-lg)'
    const lineNo = document.createElement('span')
    lineNo.textContent = String(row.line)
    lineNo.style.cssText =
      'flex:none;min-width:2.5em;text-align:right;color:var(--fl-color-text-secondary);' +
      'font-size:var(--fl-text-caption-size);font-variant-numeric:tabular-nums;'

    const preview = document.createElement('span')
    preview.style.cssText =
      'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:pre;' +
      'color:var(--fl-color-text);font-family:var(--fl-font-mono);font-size:var(--fl-text-caption-size);'
    appendHighlighted(preview, row.preview, row.highlights)

    el.append(lineNo, preview)
    return el
  }

  dispose(): void {
    this.#model.reset()
  }
}

/** Append `text` to `parent`, wrapping each highlight range in a <mark>. */
function appendHighlighted(
  parent: HTMLElement,
  text: string,
  highlights: Array<{ start: number; end: number }>,
): void {
  if (highlights.length === 0) {
    parent.textContent = text
    return
  }
  let cursor = 0
  for (const { start, end } of highlights) {
    if (start > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, start)))
    const mark = document.createElement('mark')
    mark.textContent = text.slice(start, end)
    mark.style.cssText =
      'background:var(--fl-color-accent-soft, rgba(255,214,102,0.35));color:inherit;border-radius:2px;'
    parent.appendChild(mark)
    cursor = end
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)))
}

function baseName(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? relPath : relPath.slice(slash + 1)
}

function dirName(relPath: string): string {
  const slash = relPath.lastIndexOf('/')
  return slash === -1 ? '' : relPath.slice(0, slash)
}
