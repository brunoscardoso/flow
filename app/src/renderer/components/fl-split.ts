/**
 * <fl-split> — resizable pane container (the dock-layout primitive).
 *
 * Direct children become panes separated by draggable 1px handles
 * (5px hit area). Sizes are fractions of the container that survive
 * window resizes, exposed via `getSizes()`/`setSizes()` and the
 * "fl-split-resize" event so the shell can persist layout.
 *
 * Attributes:
 *   direction: "horizontal" (row, default) | "vertical" (column)
 *   sizes:     initial fractions, comma-separated (e.g. "0.2,0.5,0.3")
 *   min-size:  minimum pane size in px while dragging (default 120)
 *
 * Methods:
 *   getSizes() / setSizes(fractions)
 *   setPaneCollapsed(index, collapsed) — pane shrinks to content
 *
 * Events:
 *   "fl-split-resize" { sizes } — after a drag completes
 */
export interface SplitResizeDetail {
  sizes: number[]
}

const DEFAULT_MIN_SIZE_PX = 120

export class FlSplit extends HTMLElement {
  static get observedAttributes(): string[] {
    return ['direction']
  }

  #root: ShadowRoot
  #container: HTMLDivElement
  #sizes: number[] = []

  /** Ends the in-flight drag, if any (#926 re-entry guard). */
  #endActiveDrag: (() => void) | null = null
  #collapsed: Set<number> = new Set()
  #observer: MutationObserver | null = null

  constructor() {
    super()
    this.#root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: block;
        min-width: 0;
        min-height: 0;
        height: 100%;
      }
      .container {
        display: flex;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
      }
      :host([direction='vertical']) .container { flex-direction: column; }
      .pane {
        display: flex;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }
      slot::slotted(*) { flex: 1; min-width: 0; min-height: 0; }
      .pane.collapsed { flex: 0 0 auto !important; }
      /* The seam between two panes, not a rule drawn on top of them: the
         separator token is darker than either ground, so the boundary is
         carried by the fill step and this reads as its shadow. It still
         highlights to the accent on hover/drag, which is the only moment a
         resize handle needs to announce itself. */
      .handle {
        flex: none;
        position: relative;
        z-index: 1;
        background: var(--fl-color-separator);
      }
      :host(:not([direction='vertical'])) .handle {
        width: var(--fl-border-width);
        cursor: col-resize;
      }
      :host([direction='vertical']) .handle {
        height: var(--fl-border-width);
        cursor: row-resize;
      }
      /* Widen the hit area beyond the 1px visual line. */
      .handle::after {
        content: '';
        position: absolute;
      }
      :host(:not([direction='vertical'])) .handle::after {
        top: 0; bottom: 0;
        left: calc(-1 * (var(--fl-split-handle-size) - var(--fl-border-width)) / 2);
        width: var(--fl-split-handle-size);
      }
      :host([direction='vertical']) .handle::after {
        left: 0; right: 0;
        top: calc(-1 * (var(--fl-split-handle-size) - var(--fl-border-width)) / 2);
        height: var(--fl-split-handle-size);
      }
      .handle:hover, .handle.dragging {
        background: var(--fl-color-accent);
        transition: background-color var(--fl-transition-medium);
      }
      .handle.disabled { cursor: default; pointer-events: none; }
    `
    this.#container = document.createElement('div')
    this.#container.className = 'container'
    this.#root.appendChild(style)
    this.#root.appendChild(this.#container)
  }

  connectedCallback(): void {
    this.#rebuild()
    this.#observer = new MutationObserver(() => this.#rebuild())
    this.#observer.observe(this, { childList: true })
  }

  disconnectedCallback(): void {
    this.#observer?.disconnect()
    this.#observer = null
  }

  get #vertical(): boolean {
    return this.getAttribute('direction') === 'vertical'
  }

  get #minSizePx(): number {
    const raw = this.getAttribute('min-size')
    const parsed = raw === null ? Number.NaN : parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_SIZE_PX
  }

  getSizes(): number[] {
    return [...this.#sizes]
  }

  setSizes(fractions: number[]): void {
    const paneCount = this.#paneElements().length
    if (fractions.length !== paneCount) {
      return
    }
    this.#sizes = normalizeFractions(fractions)
    this.#applySizes()
  }

  setPaneCollapsed(index: number, collapsed: boolean): void {
    if (collapsed) {
      this.#collapsed.add(index)
    } else {
      this.#collapsed.delete(index)
    }
    this.#applySizes()
  }

  isPaneCollapsed(index: number): boolean {
    return this.#collapsed.has(index)
  }

  #paneElements(): Element[] {
    return Array.from(this.children)
  }

  #initialSizes(count: number): number[] {
    const attr = this.getAttribute('sizes')
    if (attr) {
      const parsed = attr.split(',').map((part) => parseFloat(part.trim()))
      if (parsed.length === count && parsed.every((n) => Number.isFinite(n) && n > 0)) {
        return normalizeFractions(parsed)
      }
    }
    return new Array<number>(count).fill(1 / count)
  }

  #rebuild(): void {
    const panes = this.#paneElements()
    if (this.#sizes.length !== panes.length) {
      this.#sizes = this.#initialSizes(panes.length)
    }

    this.#container.textContent = ''
    panes.forEach((pane, index) => {
      pane.setAttribute('slot', `pane-${index}`)

      if (index > 0) {
        const handle = document.createElement('div')
        handle.className = 'handle'
        handle.dataset['index'] = String(index - 1)
        handle.addEventListener('pointerdown', (event) => this.#startDrag(event, index - 1, handle))
        this.#container.appendChild(handle)
      }

      const wrapper = document.createElement('div')
      wrapper.className = 'pane'
      wrapper.dataset['index'] = String(index)
      const slot = document.createElement('slot')
      slot.name = `pane-${index}`
      wrapper.appendChild(slot)
      this.#container.appendChild(wrapper)
    })

    this.#applySizes()
  }

  #applySizes(): void {
    const wrappers = Array.from(this.#container.querySelectorAll<HTMLDivElement>('.pane'))
    wrappers.forEach((wrapper, index) => {
      const collapsed = this.#collapsed.has(index)
      wrapper.classList.toggle('collapsed', collapsed)
      wrapper.style.flex = collapsed ? '' : `${this.#sizes[index] ?? 1} 1 0px`
    })
    // A handle can't resize into a collapsed neighbor.
    const handles = Array.from(this.#container.querySelectorAll<HTMLDivElement>('.handle'))
    handles.forEach((handle) => {
      const leftIndex = parseInt(handle.dataset['index'] ?? '0', 10)
      const disabled = this.#collapsed.has(leftIndex) || this.#collapsed.has(leftIndex + 1)
      handle.classList.toggle('disabled', disabled)
    })
  }

  #startDrag(event: PointerEvent, leftIndex: number, handle: HTMLDivElement): void {
    event.preventDefault()
    // #926: never stack drags. A stale one (whose end we missed) would keep its
    // own move listener alive and fight this one.
    this.#endActiveDrag?.()
    const vertical = this.#vertical
    const containerSize = vertical
      ? this.#container.clientHeight
      : this.#container.clientWidth
    if (containerSize <= 0) {
      return
    }

    const startPos = vertical ? event.clientY : event.clientX
    const startSizes = [...this.#sizes]
    const startLeft = startSizes[leftIndex] ?? 0
    const pairTotal = startLeft + (startSizes[leftIndex + 1] ?? 0)
    // min-size expressed as a fraction, capped so the pair always has a
    // non-empty legal range even in small windows.
    const minFraction = Math.min(this.#minSizePx / containerSize, 0.45, pairTotal / 2)
    // A pane that already violates min-size (small window, restored layout)
    // must not pin the drag dead: include the start position in the range so
    // movement in the legal direction always works, while never shrinking a
    // pane further below its minimum.
    const lowerBound = Math.min(minFraction, startLeft)
    const upperBound = Math.max(pairTotal - minFraction, startLeft)

    handle.classList.add('dragging')
    handle.setPointerCapture(event.pointerId)
    this.#endActiveDrag = () => onUp()

    const onMove = (moveEvent: PointerEvent): void => {
      // #926: SELF-HEAL a missed pointerup. If the drag ends where we never
      // hear it (capture lost to a re-render, mouseup outside the window, an
      // OS-level grab), the listeners used to stay attached — and because they
      // live on the handle, every later HOVER over it kept resizing the pane
      // "by itself" until it hit min/max. No button held ⇒ the drag is over.
      if (moveEvent.buttons === 0) {
        onUp()
        return
      }
      const pos = vertical ? moveEvent.clientY : moveEvent.clientX
      const deltaFraction = (pos - startPos) / containerSize
      let left = startLeft + deltaFraction
      left = Math.min(Math.max(left, lowerBound), upperBound)
      this.#sizes[leftIndex] = left
      this.#sizes[leftIndex + 1] = pairTotal - left
      this.#applySizes()
    }

    let ended = false
    const onUp = (): void => {
      if (ended) return // pointerup + lostpointercapture can both fire
      ended = true
      this.#endActiveDrag = null
      handle.classList.remove('dragging')
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      handle.removeEventListener('lostpointercapture', onUp)
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId)
      }
      this.dispatchEvent(
        new CustomEvent<SplitResizeDetail>('fl-split-resize', {
          detail: { sizes: this.getSizes() },
          bubbles: true,
          composed: true,
        }),
      )
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
    // Losing capture (element re-rendered, another element grabs the pointer)
    // is an END, not a pause — without this the handle stayed 'dragging'.
    handle.addEventListener('lostpointercapture', onUp)
  }
}

function normalizeFractions(fractions: number[]): number[] {
  const total = fractions.reduce((sum, n) => sum + n, 0)
  if (total <= 0) {
    return fractions.map(() => 1 / fractions.length)
  }
  return fractions.map((n) => n / total)
}

customElements.define('fl-split', FlSplit)

declare global {
  interface HTMLElementTagNameMap {
    'fl-split': FlSplit
  }
}
