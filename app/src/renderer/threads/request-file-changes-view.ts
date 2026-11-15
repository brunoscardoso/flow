/**
 * The files a request changed, drawn — three shapes over one model
 * (`request-file-changes.ts`):
 *
 *   live    a card per file under the live work row, the one being written
 *           highlighted with a pencil and "writing…";
 *   list    for a finished request, between the work row and the answer:
 *           `3 files changed  +209 −40  [Review changes]` over one row per file;
 *   chips   under a step's line in the opened work row, the files THAT step
 *           changed.
 *
 * Every card, row and chip is a real <button>: pressing it opens that file's
 * diff; Review changes opens every changed file. What "open" means belongs to
 * the pane (`FileChangeActions`) — this file only draws.
 *
 * In place, never rebuilt: the live cards reconcile by path, so a stream batch
 * that changes nothing costs no DOM write (NFR-3 of the work row).
 */
import {
  addedText,
  fileChangeLabel,
  fileDisplay,
  filesChangedText,
  removedText,
  type FileChangeView,
  type RequestFileChanges,
} from './request-file-changes'

/** What a press does, and the roots a path is shown relative to. */
export interface FileChangeActions {
  /** The conversation's roots, its own checkout first. */
  roots: () => readonly string[]
  /** Open one file's diff. */
  openFile: (path: string) => void
  /** Open every file this request changed. */
  review: (paths: readonly string[]) => void
}

/** The list header's button. */
export const REVIEW_CHANGES_TEXT = 'Review changes'
const NEW_TEXT = 'new'
const DELETED_TEXT = 'deleted'
const WRITING_TEXT = 'writing' + String.fromCharCode(8230)

type Variant = 'card' | 'row' | 'chip'

interface FileButton {
  element: HTMLButtonElement
  drawn: string
}

function span(className: string, text = ''): HTMLSpanElement {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

function icon(name: string, size: number): HTMLElement {
  const node = document.createElement('fl-icon')
  node.setAttribute('name', name)
  node.setAttribute('size', String(size))
  node.setAttribute('aria-hidden', 'true')
  node.className = 'fl-file-change-icon'
  return node
}

/** Fill (or refill) one file's button. A chip names no folder. */
function drawFile(button: FileButton, file: FileChangeView, variant: Variant, actions: FileChangeActions): void {
  const display = fileDisplay(file.path, actions.roots())
  const drawn = [
    display.name,
    display.folder,
    file.counted,
    file.added,
    file.removed,
    file.isNew,
    file.deleted,
    file.writing,
  ].join('|')
  if (drawn === button.drawn) return
  button.drawn = drawn
  const element = button.element
  element.classList.toggle('writing', file.writing)
  element.replaceChildren()
  element.appendChild(icon(file.writing ? 'pencil' : 'file', variant === 'chip' ? 12 : 14))
  const name = span('fl-file-change-name', display.name)
  element.appendChild(name)
  if (file.isNew) element.appendChild(span('fl-file-change-tag', NEW_TEXT))
  if (file.deleted) element.appendChild(span('fl-file-change-tag fl-file-change-tag-deleted', DELETED_TEXT))
  if (file.writing) element.appendChild(span('fl-file-change-writing', WRITING_TEXT))
  if (variant !== 'chip' && display.folder !== '') {
    element.appendChild(span('fl-file-change-folder', display.folder))
  }
  if (variant !== 'chip') element.appendChild(span('fl-file-change-gap'))
  if (file.counted) {
    const added = addedText(file.added)
    const removed = removedText(file.removed)
    if (added !== '') element.appendChild(span('fl-file-change-added', added))
    if (removed !== '') element.appendChild(span('fl-file-change-removed', removed))
  }
  const label = fileChangeLabel(file, display)
  element.title = display.root === null ? file.path : display.relative
  element.setAttribute('aria-label', `Open the diff of ${label}`)
}

function fileButton(file: FileChangeView, variant: Variant, actions: FileChangeActions): FileButton {
  injectFileChangeStyles()
  const element = document.createElement('button')
  element.type = 'button'
  element.className = `fl-file-change fl-file-change-${variant}`
  const button: FileButton = { element, drawn: '' }
  drawFile(button, file, variant, actions)
  element.addEventListener('click', (event) => {
    event.stopPropagation()
    actions.openFile(file.path)
  })
  return button
}

/** The chips of one step — null when the step changed no file. */
export function fileChangeChips(files: readonly FileChangeView[], actions: FileChangeActions): HTMLElement | null {
  if (files.length === 0) return null
  injectFileChangeStyles()
  const host = document.createElement('div')
  host.className = 'fl-file-change-chips'
  for (const file of files) host.appendChild(fileButton(file, 'chip', actions).element)
  return host
}

/** A chips signature, so a row redraws a step's chips only when they change. */
export function fileChipsKey(files: readonly FileChangeView[]): string {
  return files.map((file) => [file.path, file.counted, file.added, file.removed, file.isNew, file.deleted].join('|')).join('\n')
}

/**
 * The finished request's list: header with the totals and Review changes,
 * then a row per file. Null when the request changed no file.
 */
export function fileChangeList(changes: RequestFileChanges, actions: FileChangeActions): HTMLElement | null {
  if (changes.files.length === 0) return null
  injectFileChangeStyles()
  const list = document.createElement('section')
  list.className = 'fl-file-change-list'
  const title = filesChangedText(changes.files.length)
  list.setAttribute('aria-label', title)

  const header = document.createElement('div')
  header.className = 'fl-file-change-list-header'
  header.appendChild(span('fl-file-change-list-title', title))
  const added = addedText(changes.added)
  const removed = removedText(changes.removed)
  if (added !== '') header.appendChild(span('fl-file-change-added', added))
  if (removed !== '') header.appendChild(span('fl-file-change-removed', removed))
  header.appendChild(span('fl-file-change-gap'))
  const review = document.createElement('button')
  review.type = 'button'
  review.className = 'fl-file-change-review'
  review.textContent = REVIEW_CHANGES_TEXT
  const paths = changes.files.map((file) => file.path)
  review.addEventListener('click', (event) => {
    event.stopPropagation()
    actions.review(paths)
  })
  header.appendChild(review)
  list.appendChild(header)

  const rows = document.createElement('div')
  rows.className = 'fl-file-change-rows'
  for (const file of changes.files) rows.appendChild(fileButton(file, 'row', actions).element)
  list.appendChild(rows)
  return list
}

/** The live cards under a running request's work row, reconciled by path. */
export class LiveFileCards {
  readonly element: HTMLElement
  #actions: FileChangeActions
  #cards = new Map<string, FileButton>()

  constructor(actions: FileChangeActions) {
    injectFileChangeStyles()
    this.#actions = actions
    this.element = document.createElement('div')
    this.element.className = 'fl-file-change-live'
    this.element.hidden = true
  }

  update(files: readonly FileChangeView[]): void {
    files.forEach((file, index) => {
      let card = this.#cards.get(file.path)
      if (card === undefined) {
        card = fileButton(file, 'card', this.#actions)
        this.#cards.set(file.path, card)
      } else {
        drawFile(card, file, 'card', this.#actions)
      }
      // First-touch order is stable, so this only moves a card the first time.
      if (this.element.children[index] !== card.element) {
        this.element.insertBefore(card.element, this.element.children[index] ?? null)
      }
    })
    const keep = new Set(files.map((file) => file.path))
    for (const [path, card] of this.#cards) {
      if (keep.has(path)) continue
      card.element.remove()
      this.#cards.delete(path)
    }
    this.element.hidden = files.length === 0
  }
}

// ── Styles (light DOM) ───────────────────────────────────────────────────────
// Flow tokens only, so light and dark both come from the theme.

let stylesInjected = false

function injectFileChangeStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-file-change {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      min-width: 0;
      margin: 0;
      font: inherit;
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
      text-align: left;
      cursor: pointer;
      white-space: nowrap;
    }
    .fl-file-change:focus-visible,
    .fl-file-change-review:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring);
      outline-offset: -2px;
    }
    .fl-file-change-card,
    .fl-file-change-row {
      width: 100%;
      min-height: 32px;
      padding: 0 var(--fl-space-sm);
    }
    .fl-file-change-card {
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-row);
      background: var(--fl-color-surface-raised);
    }
    .fl-file-change-card.writing {
      border-color: var(--fl-color-accent);
      background: var(--fl-color-accent-soft);
    }
    .fl-file-change-card.writing .fl-file-change-icon { color: var(--fl-color-accent); }
    .fl-file-change-row {
      border: 0;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: 0;
      background: transparent;
    }
    .fl-file-change-card:hover,
    .fl-file-change-row:hover,
    .fl-file-change-chip:hover { background: var(--fl-color-surface-selected); }
    .fl-file-change-chip {
      flex: 0 1 auto;
      max-width: 100%;
      min-height: 24px;
      padding: 0 var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-row);
      background: var(--fl-color-surface-raised);
      font-size: var(--fl-text-caption-size);
    }
    .fl-file-change-icon { flex: none; color: var(--fl-color-text-secondary); }
    /* The name ellipsizes last: the folder gives way first (flex-shrink 6 vs 1),
       then the name, and the numbers never do. */
    .fl-file-change-name {
      flex: 0 1 auto;
      min-width: 3ch;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-file-change-folder {
      flex: 0 6 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-file-change-gap { flex: 1 1 0; min-width: 0; }
    .fl-file-change-tag {
      flex: none;
      padding: 0 5px;
      border-radius: 4px;
      background: var(--fl-color-accent-soft);
      color: var(--fl-color-accent);
      font-size: var(--fl-text-caption-size);
      line-height: 16px;
    }
    .fl-file-change-tag-deleted {
      background: transparent;
      color: var(--fl-color-error);
      border: var(--fl-border-width) solid currentColor;
    }
    .fl-file-change-writing {
      flex: none;
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-accent);
    }
    .fl-file-change-added,
    .fl-file-change-removed {
      flex: none;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
      font-variant-numeric: tabular-nums;
    }
    .fl-file-change-added { color: var(--fl-color-success); }
    .fl-file-change-removed { color: var(--fl-color-error); }
    .fl-file-change-live {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      margin-top: var(--fl-space-xs);
    }
    .fl-file-change-live[hidden] { display: none; }
    .fl-file-change-chips {
      display: flex;
      flex-wrap: wrap;
      gap: var(--fl-space-xs);
      padding: 2px 0 var(--fl-space-xs) calc(18px + var(--fl-space-sm) + var(--fl-space-xs));
      min-width: 0;
    }
    .fl-file-change-list {
      margin-top: var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-row);
      overflow: hidden;
    }
    .fl-file-change-list-header {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      min-height: 34px;
      padding: 0 var(--fl-space-sm);
      background: var(--fl-color-surface-raised);
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
    }
    .fl-file-change-list-title {
      flex: none;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-file-change-review {
      flex: none;
      min-height: 24px;
      padding: 0 var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-row);
      background: transparent;
      color: var(--fl-color-text);
      font: inherit;
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .fl-file-change-review:hover { background: var(--fl-color-surface-selected); }
    .fl-file-change-rows { display: flex; flex-direction: column; }
  `
  document.head.appendChild(style)
}
