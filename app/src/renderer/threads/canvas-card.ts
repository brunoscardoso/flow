/**
 * The chat's canvas card: a UI drafts canvas a request wrote, with an Open
 * canvas button. What it says comes from `canvasCardView`; this file only
 * draws it.
 */
import '../components'
import { canvasCardView, type CanvasCardInfo, type WrittenCanvas } from './canvas-card-model'

const STYLE_ID = 'fl-canvas-card-styles'

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .fl-canvas-card {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin: 6px 0;
      padding: 10px 12px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface-raised);
      font-family: var(--fl-font-ui);
    }
    .fl-canvas-card-thumbs { display: flex; gap: 4px; flex: none; }
    .fl-canvas-card-thumbs span {
      position: relative;
      width: 22px;
      height: 30px;
      border-radius: 3px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      background: var(--fl-color-surface);
    }
    .fl-canvas-card-thumbs span::before {
      content: '';
      position: absolute;
      left: 4px; right: 4px; top: 5px;
      height: 3px;
      border-radius: 2px;
      background: var(--fl-color-border);
    }
    .fl-canvas-card-thumbs span::after {
      content: '';
      position: absolute;
      left: 4px; right: 7px; top: 11px;
      height: 12px;
      border-radius: 2px;
      background: color-mix(in srgb, var(--fl-color-accent) 22%, transparent);
    }
    .fl-canvas-card-text { flex: 1 1 160px; min-width: 0; display: grid; gap: 1px; }
    .fl-canvas-card-title {
      color: var(--fl-color-text);
      font-weight: var(--fl-text-ui-weight-medium, 500);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fl-canvas-card-detail { color: var(--fl-color-text-secondary); font-size: 12px; }
  `
  document.head.appendChild(style)
}

export class CanvasCard {
  readonly element: HTMLElement
  readonly written: WrittenCanvas
  #title: HTMLElement
  #detail: HTMLElement
  #button: HTMLElement
  #live: boolean

  constructor(written: WrittenCanvas, live: boolean, onOpen: (written: WrittenCanvas) => void) {
    ensureStyles()
    this.written = written
    this.#live = live
    this.element = document.createElement('div')
    this.element.className = 'fl-canvas-card'
    this.element.dataset['canvas'] = written.canvas

    const thumbs = document.createElement('div')
    thumbs.className = 'fl-canvas-card-thumbs'
    thumbs.setAttribute('aria-hidden', 'true')
    thumbs.append(document.createElement('span'), document.createElement('span'), document.createElement('span'))

    const text = document.createElement('div')
    text.className = 'fl-canvas-card-text'
    this.#title = document.createElement('div')
    this.#title.className = 'fl-canvas-card-title'
    this.#detail = document.createElement('div')
    this.#detail.className = 'fl-canvas-card-detail'
    text.append(this.#title, this.#detail)

    this.#button = document.createElement('fl-button')
    this.#button.setAttribute('variant', 'primary')
    this.#button.setAttribute('small', '')
    this.#button.dataset['action'] = 'open-canvas'
    this.#button.textContent = 'Open canvas'
    this.#button.addEventListener('click', () => {
      if (!this.#button.hasAttribute('disabled')) onOpen(this.written)
    })

    this.element.append(thumbs, text, this.#button)
    this.update(undefined)
  }

  /** Redraw from what `drafts:list` knows (undefined: not read yet). */
  update(info: CanvasCardInfo | undefined, live: boolean = this.#live): void {
    this.#live = live
    const view = canvasCardView(this.written.canvas, info, live)
    this.#title.textContent = view.title
    this.#title.title = view.title
    this.#detail.textContent = view.detail
    this.#button.toggleAttribute('disabled', !view.canOpen)
  }
}
