/**
 * <fl-list> — virtualized dense list (28px rows by default, hover = Surface
 * Raised, no borders between rows). Renders only the visible window plus
 * overscan, so thread lists / file trees / logs stay responsive at 10k+ items.
 *
 * Rows are uniform unless a consumer sets `itemHeight`, in which case each row
 * is measured once per assignment and the window is found by binary search
 * over the cumulative tops (`list-metrics.ts`, which is where that arithmetic
 * is tested — this file cannot be imported under jest).
 *
 * Data-driven: assign `items` and `renderItem`. Keyboard-first: Up/Down move
 * selection, Enter/click activate.
 *
 * Events:
 *   "fl-list-select"   { index, item }  — selection moved
 *   "fl-list-activate" { index, item }  — Enter or click
 */
export interface ListItemDetail<T> {
  index: number
  item: T
  /** True when the activation carried the multi-select modifier (⌘/Ctrl-click,
   *  #730 thread multi-select). Keyboard Enter activations are always false. */
  multiSelect?: boolean
  /** True when the activation carried the range modifier (Shift-click, for
   *  contiguous range selection). Default off and additive — a consumer that
   *  ignores it (thread sidebar, file tree, commit log) is unaffected. Keyboard
   *  Enter activations are always false. */
  range?: boolean
}

import { rowOffsets, scrollToReveal, totalHeight, visibleRange } from './list-metrics'

const OVERSCAN_ROWS = 6

export class FlList<T = unknown> extends HTMLElement {
  #scroller: HTMLDivElement
  #spacer: HTMLDivElement
  #internals: ElementInternals | null = null
  #items: T[] = []
  #renderItem: ((item: T, index: number) => HTMLElement) | null = null
  #rowHeight = 28
  /**
   * Per-row height, when a surface needs rows of different sizes.
   *
   * Null — the default — means every row is `rowHeight`, which is what the
   * file tree and every git-panel section want and what this component did
   * exclusively until the thread sidebar needed a second line for the rows
   * that carry context projects (and only those).
   */
  #itemHeight: ((item: T, index: number) => number) | null = null
  /** Cumulative row tops, rebuilt whenever the items or the heights change. */
  #offsets: number[] = [0]
  #selectedIndex = -1
  #resizeObserver: ResizeObserver | null = null
  /** Pending requestAnimationFrame id for the coalesced window render. */
  #renderFrame: number | null = null
  /** Last rendered visible range (-2 sentinel = force next render). */
  #renderedFirst = -2
  #renderedLast = -2

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: block;
        min-height: 0;
        height: 100%;
        outline: none;
      }
      /* The list's focus affordance is the highlighted row (.selected below),
       * not a ring around the whole control. Beat the global :focus-visible
       * rule (equal specificity would otherwise draw a blue box around the
       * list — e.g. hugging the top project group in the sidebar). */
      :host(:focus),
      :host(:focus-visible) {
        outline: none;
      }
      .scroller {
        height: 100%;
        overflow-y: auto;
        position: relative;
      }
      /*
       * FLOW'S SCROLLBAR, RESTATED INSIDE THE SHADOW ROOT.
       *
       * A ::-webkit-scrollbar rule in the document does not cross a shadow
       * boundary, so the app-wide styling in tokens.css reached every scroller
       * except the ones in its own components — and this list, which is the
       * file tree, the thread sidebar and the search results, scrolled with the
       * platform's default bar beside Flow's own everywhere else (user,
       * 2026-09-18: "improve this corner").
       *
       * The COLOUR is not restated: custom properties inherit through the
       * boundary, so the value has one definition and the theme keeps working.
       */
      .scroller::-webkit-scrollbar { width: 8px; height: 8px; }
      .scroller::-webkit-scrollbar-track { background: transparent; }
      .scroller::-webkit-scrollbar-thumb {
        background-color: var(--fl-scrollbar-thumb, rgba(121, 121, 121, 0.35));
        border-radius: 6px;
        /* Clear of both ends, so the cap is never cut off against the edge. */
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      .scroller::-webkit-scrollbar-thumb:hover {
        background-color: var(--fl-scrollbar-thumb-hover, rgba(121, 121, 121, 0.55));
      }
      .scroller::-webkit-scrollbar-corner { background: transparent; }
      .spacer { position: relative; width: 100%; }
      /*
       * A ROW'S HIGHLIGHT IS A PILL, NOT A BAND (2026-09-08).
       *
       * The fill used to run edge to edge with square corners, which on a
       * narrow panel reads as a coloured stripe cut out of the sidebar rather
       * than as one row picked out of a list ("too square … keep it like
       * cursor, something simple, rounded").
       *
       * The inset is a MARGIN and the same 4px comes back as PADDING, so the
       * painted box moves in from both edges while every consumer's content
       * stays exactly where it was — the content box is 8px from the panel on
       * either side, as it has always been, and no list had to be re-measured.
       * Rows still bleed to the padding box, so a header band can match the
       * pill exactly (see .fl-row-band below).
       */
      .row {
        position: absolute;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        margin: 0 var(--fl-space-xs);
        padding: 0 var(--fl-space-xs);
        border-radius: var(--fl-radius-row);
        cursor: default;
        user-select: none;
        white-space: nowrap;
        overflow: hidden;
      }
      .row:hover { background: var(--fl-color-surface-raised); }
      .row.selected { background: var(--fl-color-surface-raised); }

      /*
       * HOVER-REVEAL, offered to whatever a caller renders into a row.
       *
       * Rows live in THIS shadow root, so a consumer's light-DOM stylesheet
       * cannot reach them and every hover affordance in the app's lists had to
       * be wired in JS with mouseenter/mouseleave. That works until the list
       * re-renders under a stationary pointer — a threads:updated batch
       * arrives every 50ms while an agent streams — and the fresh element comes
       * back in its resting state with no pointer movement left to re-trigger
       * it. Measured: hovering a thread row during thread creation showed the
       * row actions for a fraction of a second and then lost them.
       *
       * As CSS it is a state, not an event, so a re-render simply re-matches.
       *
       *   fl-row-reveal      hidden until the row is hovered or holds focus
       *   fl-row-rest        shown only while the row is NOT hovered
       *   fl-row-hover       shown only while it IS
       *
       * The last pair is for a mark that CHANGES on hover (a folder becoming a
       * chevron): both are rendered and CSS picks, because an attribute swap
       * is exactly the kind of imperative step this is here to avoid.
       */
      .row .fl-row-reveal { opacity: 0; transition: opacity var(--fl-transition-fast); }
      .row:hover .fl-row-reveal,
      .row:focus-within .fl-row-reveal { opacity: 1; }
      .row .fl-row-hover { display: none; }
      .row:hover .fl-row-rest { display: none; }
      .row:hover .fl-row-hover { display: inline-flex; }
      :host(:focus) .row.selected {
        background: var(--fl-color-accent-muted);
      }

      /*
       * ONE BOX PER ROW — the consumer MARKS, this paints (2026-09-08).
       *
       * A caller that wants a persistent "this is the one I'm on" decoration
       * used to paint it on the element it rendered INTO the row. That element
       * is not the row: it sits inside the row's 8px padding and is only as
       * tall as its own content, so the paint came out as a second, smaller
       * rectangle floating inside the row's own hover/selected fill —
       * measured in the thread sidebar at 300×20 inside 316×28, which is the
       * "double selection … a blue thing and a gray thing" report.
       *
       * So the caller adds a class to what it renders and the ROW is painted,
       * full-bleed and exactly row-height. Declared after .row:hover and
       * .row.selected on purpose: equal specificity, so source order is what
       * makes the current row keep its accent under the pointer instead of
       * flickering to the hover grey.
       *
       *   fl-row-current   the row this surface is ON — one neutral step past
       *                    hover. NOT an accent bar over an accent fill: that
       *                    turned the one row a person had open into the
       *                    loudest thing on a resting panel, in a sidebar
       *                    whose reference draws it in grey.
       *   fl-row-marked    a row in a multi-selection. This one KEEPS the
       *                    accent, because it is a state a person just created
       *                    with a modifier click and expects to see across
       *                    several rows at once — and it is never the resting
       *                    state of the list.
       */
      .row:has(> .fl-row-current) {
        background: var(--fl-color-surface-selected);
      }
      .row:has(> .fl-row-marked) {
        background: var(--fl-color-accent-muted);
      }

      /*
       * A ROW TALLER THAN ITS BOX. A section header buys its separation from
       * the group above with extra row height (the sidebar's project headers,
       * #1873). That extra is AIR, not part of the header's box — painting the
       * whole row makes a hovered project a visibly bigger target than every
       * thread under it, which is the "too much space" half of the same
       * report. The row paints nothing; the band inside it is the box, and the
       * consumer sizes that band to one row.
       */
      .row:has(> .fl-row-band) { background: transparent; }
      .row:hover > .fl-row-band { background: var(--fl-color-surface-raised); }
      .row > .fl-row-band { border-radius: var(--fl-radius-row); }
    `
    this.#spacer = document.createElement('div')
    this.#spacer.className = 'spacer'
    this.#scroller = document.createElement('div')
    this.#scroller.className = 'scroller'
    this.#scroller.appendChild(this.#spacer)
    this.#scroller.addEventListener('scroll', () => this.#scheduleRender())
    root.appendChild(style)
    root.appendChild(this.#scroller)

    this.addEventListener('keydown', (event) => this.#onKeydown(event))
    // Listbox semantics live HERE, not in consumers (#1755) — every surface
    // rendering through <fl-list> gets them from this one code path. Internals
    // are preferred because `ariaActiveDescendantElement` may lawfully point
    // into this shadow root, which an id-based host attribute cannot.
    if (typeof this.attachInternals === 'function') {
      this.#internals = this.attachInternals()
      this.#internals.role = 'listbox'
    }
  }

  connectedCallback(): void {
    if (!this.hasAttribute('tabindex')) {
      this.tabIndex = 0
    }
    if (this.#internals === null && !this.hasAttribute('role')) {
      this.setAttribute('role', 'listbox')
    }
    this.#resizeObserver = new ResizeObserver(() => this.#scheduleRender())
    this.#resizeObserver.observe(this.#scroller)
    this.#scheduleRender(true)
  }

  disconnectedCallback(): void {
    this.#resizeObserver?.disconnect()
    this.#resizeObserver = null
    if (this.#renderFrame !== null) {
      cancelAnimationFrame(this.#renderFrame)
      this.#renderFrame = null
    }
  }

  get items(): T[] {
    return this.#items
  }

  set items(value: T[]) {
    this.#items = value
    if (this.#selectedIndex >= value.length) {
      this.#selectedIndex = -1
    }
    this.#measure()
    this.#scheduleRender(true)
  }

  get renderItem(): ((item: T, index: number) => HTMLElement) | null {
    return this.#renderItem
  }

  set renderItem(value: ((item: T, index: number) => HTMLElement) | null) {
    this.#renderItem = value
    this.#scheduleRender(true)
  }

  get rowHeight(): number {
    return this.#rowHeight
  }

  set rowHeight(value: number) {
    this.#rowHeight = Math.max(1, value)
    this.#measure()
    this.#scheduleRender(true)
  }

  get itemHeight(): ((item: T, index: number) => number) | null {
    return this.#itemHeight
  }

  set itemHeight(value: ((item: T, index: number) => number) | null) {
    this.#itemHeight = value
    this.#measure()
    this.#scheduleRender(true)
  }

  /**
   * Re-measure the rows — after `items`, `rowHeight` or `itemHeight` changed.
   *
   * The callback is asked ONCE PER ROW HERE and never again during a render:
   * scrolling a 10k list must not re-run a consumer's height function 10k
   * times per frame, and a height that changed without an assignment would put
   * the mounted rows somewhere the offsets do not agree with.
   */
  #measure(): void {
    const heightAt = this.#itemHeight
    this.#offsets = rowOffsets(this.#items.length, (index) => {
      if (heightAt === null) return this.#rowHeight
      const item = this.#items[index]
      return item === undefined ? this.#rowHeight : heightAt(item, index)
    })
  }

  get selectedIndex(): number {
    return this.#selectedIndex
  }

  set selectedIndex(value: number) {
    const clamped = value < 0 || this.#items.length === 0
      ? -1
      : Math.min(Math.max(0, value), this.#items.length - 1)
    if (clamped === this.#selectedIndex) {
      return
    }
    this.#selectedIndex = clamped
    this.#scrollSelectionIntoView()
    this.#scheduleRender(true)
    if (clamped >= 0) {
      this.#emit('fl-list-select', clamped)
    }
  }

  /** Re-render visible rows in place (e.g. after mutating item state). */
  refresh(): void {
    this.#scheduleRender(true)
  }

  #emit(
    name: 'fl-list-select' | 'fl-list-activate',
    index: number,
    multiSelect = false,
    range = false,
  ): void {
    const item = this.#items[index]
    if (item === undefined) {
      return
    }
    this.dispatchEvent(
      new CustomEvent<ListItemDetail<T>>(name, {
        detail: { index, item, multiSelect, range },
        bubbles: true,
        composed: true,
      }),
    )
  }

  #onKeydown(event: KeyboardEvent): void {
    if (this.#items.length === 0) {
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      this.selectedIndex = this.#selectedIndex < 0 ? 0 : this.#selectedIndex + 1
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      this.selectedIndex = this.#selectedIndex < 0 ? 0 : this.#selectedIndex - 1
    } else if (event.key === 'Enter' && this.#selectedIndex >= 0) {
      event.preventDefault()
      this.#emit('fl-list-activate', this.#selectedIndex)
    }
  }

  #scrollSelectionIntoView(): void {
    const target = scrollToReveal(
      this.#offsets,
      this.#selectedIndex,
      this.#scroller.scrollTop,
      this.#scroller.clientHeight,
    )
    if (target !== null) this.#scroller.scrollTop = target
  }

  /** Coalesce window renders to one per animation frame. `force` marks the
   *  rendered range dirty so data/selection changes always rebuild. */
  #scheduleRender(force = false): void {
    if (force) {
      this.#renderedFirst = -2
      this.#renderedLast = -2
    }
    if (this.#renderFrame !== null) {
      return // already scheduled for this frame
    }
    this.#renderFrame = requestAnimationFrame(() => {
      this.#renderFrame = null
      this.#renderWindow()
    })
  }

  #renderWindow(): void {
    const total = this.#items.length
    const viewHeight = this.#scroller.clientHeight || 0
    const { first, last } = visibleRange(
      this.#offsets,
      this.#scroller.scrollTop,
      viewHeight,
      OVERSCAN_ROWS,
    )
    if (first === this.#renderedFirst && last === this.#renderedLast) {
      return // visible range unchanged — nothing to rebuild
    }
    this.#renderedFirst = first
    this.#renderedLast = last

    this.#spacer.style.height = `${totalHeight(this.#offsets)}px`

    // Clear previously rendered rows.
    this.#spacer.textContent = ''

    if (total === 0 || !this.#renderItem) {
      this.#syncActiveDescendant(null)
      return
    }

    let selectedRow: Element | null = null
    for (let index = first; index <= last; index += 1) {
      const item = this.#items[index]
      if (item === undefined) {
        continue
      }
      const row = document.createElement('div')
      row.className = 'row'
      row.classList.toggle('selected', index === this.#selectedIndex)
      row.style.top = `${this.#offsets[index] ?? 0}px`
      row.style.height = `${(this.#offsets[index + 1] ?? 0) - (this.#offsets[index] ?? 0)}px`
      // Option semantics per rendered row; setsize/posinset carry the REAL
      // count, because virtualization means only a window of options exists.
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', index === this.#selectedIndex ? 'true' : 'false')
      row.setAttribute('aria-setsize', String(total))
      row.setAttribute('aria-posinset', String(index + 1))
      row.appendChild(this.#renderItem(item, index))
      row.addEventListener('click', (event) => {
        this.selectedIndex = index
        this.#emit('fl-list-activate', index, event.metaKey || event.ctrlKey, event.shiftKey)
      })
      if (index === this.#selectedIndex) {
        selectedRow = row
      }
      this.#spacer.appendChild(row)
    }
    this.#syncActiveDescendant(selectedRow)
  }

  /** Point the focused host at the selected option so arrowing announces it.
   *  Null when nothing is selected — or when the selected row is scrolled out
   *  of the rendered window, which self-heals on the next selection move. */
  #syncActiveDescendant(row: Element | null): void {
    if (this.#internals !== null && 'ariaActiveDescendantElement' in this.#internals) {
      this.#internals.ariaActiveDescendantElement = row
    }
  }
}

customElements.define('fl-list', FlList)

declare global {
  interface HTMLElementTagNameMap {
    'fl-list': FlList
  }
}
