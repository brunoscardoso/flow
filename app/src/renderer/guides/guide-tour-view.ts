/**
 * ONE TOUR ON SCREEN: the part being explained is lit, the rest is dimmed, and
 * a small card beside it says what it is.
 *
 * NOTHING IS TRAPPED. The dimming lets clicks through, so a person can use the
 * screen the moment they want to, and the tour never stands between them and
 * their work. Escape, ×, and "Skip tour" all end it.
 *
 * THE ANCHOR IS RE-FOUND, NOT HELD. Lists repaint, boards rebuild their lane
 * heads, panes resize; the step looks its anchor up again on every reposition.
 * When a step's anchor has gone from the screen for good (the person moved
 * on), the tour ends instead of pointing at nothing.
 */
import { placeCard, type GuideStep, type GuideTour } from '../../shared/guides'
import { firstOnScreen, visibleRect } from './guide-dom'

export type TourEnd = 'done' | 'skipped' | 'gone'

const STYLE_ID = 'fl-guide-styles'

const CSS = `
.fl-guide { position: fixed; inset: 0; z-index: 9000; pointer-events: none; }
.fl-guide-spot {
  position: fixed; border-radius: 8px; pointer-events: none;
  box-shadow: 0 0 0 3px var(--fl-color-focus-ring);
  transition: left 160ms ease, top 160ms ease, width 160ms ease, height 160ms ease;
}
.fl-guide-spot[hidden] { display: none; }
.fl-guide-shade { position: fixed; background: rgba(0, 0, 0, 0.5); pointer-events: none; }
.fl-guide-card {
  position: fixed; width: 340px; box-sizing: border-box; pointer-events: auto;
  background: var(--fl-color-surface-raised); color: var(--fl-color-text);
  border: 1px solid var(--fl-color-island-border); border-radius: 10px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45); padding: 16px 18px;
  display: flex; flex-direction: column; gap: 8px; font-family: var(--fl-font-ui);
}
.fl-guide-head { display: flex; align-items: center; gap: 8px; }
.fl-guide-step { flex: 1; font-size: 11.5px; color: var(--fl-color-text-secondary); }
.fl-guide-x {
  background: transparent; border: 0; color: var(--fl-color-text-secondary); cursor: pointer;
  font: inherit; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 4px;
}
.fl-guide-x:hover { color: var(--fl-color-text); }
.fl-guide-title { margin: 0; font-size: 15px; font-weight: 600; }
.fl-guide-body { margin: 0; font-size: 13px; line-height: 1.5; color: var(--fl-color-text-secondary); }
.fl-guide-dots { display: flex; gap: 5px; padding-top: 2px; }
.fl-guide-dots span { width: 16px; height: 3px; border-radius: 2px; background: var(--fl-color-border); }
.fl-guide-dots span.on { background: var(--fl-color-accent); }
.fl-guide-foot { display: flex; align-items: center; gap: 8px; padding-top: 4px; }
.fl-guide-skip {
  flex: 1; text-align: left; background: transparent; border: 0; padding: 0; cursor: pointer;
  font: inherit; font-size: 12.5px; color: var(--fl-color-text-secondary);
}
.fl-guide-skip:hover { color: var(--fl-color-text); }
.fl-guide-btn {
  height: 30px; padding: 0 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12.5px;
  background: transparent; color: var(--fl-color-text); border: 1px solid var(--fl-color-island-border);
}
.fl-guide-btn.primary { background: var(--fl-color-accent); color: #fff; border-color: transparent; font-weight: 600; }
.fl-guide-btn:focus-visible, .fl-guide-skip:focus-visible, .fl-guide-x:focus-visible {
  outline: 2px solid var(--fl-color-focus-ring); outline-offset: 2px;
}
`

export function injectGuideStyles(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

/** The steps of `tour` whose anchor is on screen now, in order. */
export function availableSteps(tour: GuideTour): GuideStep[] {
  return tour.steps.filter((step) => firstOnScreen(step.anchor) !== null)
}

export class GuideTourView {
  readonly #tour: GuideTour
  readonly #steps: GuideStep[]
  readonly #onEnd: (end: TourEnd) => void
  readonly #root: HTMLElement
  readonly #spot: HTMLElement
  /** Four panels around the lit area: above, below, left and right of it. */
  readonly #shades: HTMLElement[]
  readonly #card: HTMLElement
  #index = 0
  #timer: ReturnType<typeof setInterval> | null = null
  #missing = 0
  #ended = false
  readonly #returnFocus: Element | null
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    // Window capture, and immediate: a dialog under the tour (the Ask panel)
    // must not close on the same key that closes the tour.
    event.stopImmediatePropagation()
    this.end('skipped')
  }
  readonly #onResize = (): void => this.#position()
  /**
   * A PRESS ON THE CARD IS NOT A PRESS OUTSIDE ANYTHING. Panels under a tour
   * close on a press outside themselves (the Ask panel, popovers), and they
   * listen on the document. Stopping the press here, at the window, keeps them
   * open; the card's own buttons still get their click, which is a separate
   * event.
   */
  readonly #onPress = (event: Event): void => {
    if (event.target instanceof Node && this.#card.contains(event.target)) event.stopImmediatePropagation()
  }

  readonly #keepFocus: boolean

  /**
   * `keepFocus`: the tour is about a dialog that holds the keyboard (the Ask
   * panel). The card then never takes focus — not on open, not on a press —
   * so the dialog's own focus rules stay untouched and typing carries on.
   */
  constructor(tour: GuideTour, steps: GuideStep[], options: { keepFocus: boolean }, onEnd: (end: TourEnd) => void) {
    injectGuideStyles()
    this.#keepFocus = options.keepFocus
    this.#tour = tour
    this.#steps = steps
    this.#onEnd = onEnd
    this.#returnFocus = document.activeElement
    this.#root = document.createElement('div')
    this.#root.className = 'fl-guide'
    this.#root.dataset.guide = tour.id
    this.#shades = [0, 1, 2, 3].map(() => {
      const shade = document.createElement('div')
      shade.className = 'fl-guide-shade'
      return shade
    })
    this.#spot = document.createElement('div')
    this.#spot.className = 'fl-guide-spot'
    this.#card = document.createElement('div')
    this.#card.className = 'fl-guide-card'
    this.#card.setAttribute('role', 'dialog')
    if (options.keepFocus) this.#card.addEventListener('mousedown', (event) => event.preventDefault())
    this.#root.append(...this.#shades, this.#spot, this.#card)
  }

  get tourId(): string {
    return this.#tour.id
  }

  open(): void {
    document.body.appendChild(this.#root)
    window.addEventListener('keydown', this.#onKey, true)
    window.addEventListener('pointerdown', this.#onPress, true)
    window.addEventListener('mousedown', this.#onPress, true)
    window.addEventListener('resize', this.#onResize)
    this.#timer = setInterval(() => this.#position(), 300)
    this.#render()
  }

  end(reason: TourEnd): void {
    if (this.#ended) return
    this.#ended = true
    if (this.#timer !== null) clearInterval(this.#timer)
    window.removeEventListener('keydown', this.#onKey, true)
    window.removeEventListener('pointerdown', this.#onPress, true)
    window.removeEventListener('mousedown', this.#onPress, true)
    window.removeEventListener('resize', this.#onResize)
    this.#root.remove()
    if (!this.#keepFocus && this.#returnFocus instanceof HTMLElement && this.#returnFocus.isConnected) {
      this.#returnFocus.focus()
    }
    this.#onEnd(reason)
  }

  #go(index: number): void {
    if (index >= this.#steps.length) {
      this.end('done')
      return
    }
    this.#index = Math.max(0, index)
    this.#missing = 0
    this.#render()
  }

  #render(): void {
    const step = this.#steps[this.#index]
    if (step === undefined) return
    const total = this.#steps.length
    const last = this.#index === total - 1
    const titleId = `fl-guide-title-${this.#tour.id}`
    this.#card.setAttribute('aria-labelledby', titleId)
    this.#card.replaceChildren()

    const head = document.createElement('div')
    head.className = 'fl-guide-head'
    const where = document.createElement('div')
    where.className = 'fl-guide-step'
    where.textContent = total > 1 ? `${this.#tour.name} · ${String(this.#index + 1)} of ${String(total)}` : this.#tour.name
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'fl-guide-x'
    close.setAttribute('aria-label', 'Close tour')
    close.textContent = '×'
    close.addEventListener('click', () => this.end('skipped'))
    head.append(where, close)

    const title = document.createElement('h2')
    title.className = 'fl-guide-title'
    title.id = titleId
    title.textContent = step.title
    const body = document.createElement('p')
    body.className = 'fl-guide-body'
    body.textContent = step.body
    this.#card.append(head, title, body)

    if (total > 1) {
      const dots = document.createElement('div')
      dots.className = 'fl-guide-dots'
      dots.setAttribute('aria-hidden', 'true')
      for (let i = 0; i < total; i += 1) {
        const dot = document.createElement('span')
        if (i === this.#index) dot.className = 'on'
        dots.appendChild(dot)
      }
      this.#card.appendChild(dots)
    }

    const foot = document.createElement('div')
    foot.className = 'fl-guide-foot'
    const skip = document.createElement('button')
    skip.type = 'button'
    skip.className = 'fl-guide-skip'
    skip.textContent = last ? '' : 'Skip tour'
    skip.hidden = last
    skip.addEventListener('click', () => this.end('skipped'))
    foot.appendChild(skip)
    if (last) {
      const spacer = document.createElement('span')
      spacer.style.flex = '1'
      foot.appendChild(spacer)
    }
    if (this.#index > 0) {
      const back = document.createElement('button')
      back.type = 'button'
      back.className = 'fl-guide-btn'
      back.textContent = 'Back'
      back.addEventListener('click', () => this.#go(this.#index - 1))
      foot.appendChild(back)
    }
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'fl-guide-btn primary'
    next.dataset.guideAction = 'next'
    next.textContent = last ? 'Done' : 'Next'
    next.addEventListener('click', () => this.#go(this.#index + 1))
    foot.appendChild(next)
    this.#card.appendChild(foot)

    this.#position()
    if (!this.#keepFocus) next.focus({ preventScroll: true })
  }

  #position(): void {
    if (this.#ended) return
    const step = this.#steps[this.#index]
    if (step === undefined) return
    const anchor = firstOnScreen(step.anchor)
    if (anchor === null) {
      // A beat of grace: a list repainting is gone for one look, not for good.
      this.#missing += 1
      if (this.#missing >= 4) this.end('gone')
      return
    }
    this.#missing = 0
    const rect = visibleRect(anchor)
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    // AN ANCHOR AS BIG AS THE SCREEN gets no spotlight — a ring around the
    // whole window says nothing — and the window is dimmed evenly instead.
    const huge = rect.width * rect.height > viewport.width * viewport.height * 0.45
    this.#spot.hidden = huge
    if (!huge) {
      this.#spot.style.left = `${String(rect.left)}px`
      this.#spot.style.top = `${String(rect.top)}px`
      this.#spot.style.width = `${String(rect.width)}px`
      this.#spot.style.height = `${String(rect.height)}px`
    }
    // The hole the shades leave: the lit area, or nothing for a huge anchor
    // (the whole window is shaded evenly then).
    const hole = huge ? { left: 0, top: 0, width: 0, height: 0 } : rect
    const right = hole.left + hole.width
    const bottom = hole.top + hole.height
    const boxes = [
      { left: 0, top: 0, width: viewport.width, height: hole.top },
      { left: 0, top: bottom, width: viewport.width, height: Math.max(0, viewport.height - bottom) },
      { left: 0, top: hole.top, width: hole.left, height: hole.height },
      { left: right, top: hole.top, width: Math.max(0, viewport.width - right), height: hole.height },
    ]
    if (huge) boxes[0] = { left: 0, top: 0, width: viewport.width, height: viewport.height }
    this.#shades.forEach((shade, i) => {
      const box = boxes[i] ?? { left: 0, top: 0, width: 0, height: 0 }
      shade.style.left = `${String(box.left)}px`
      shade.style.top = `${String(box.top)}px`
      shade.style.width = `${String(box.width)}px`
      shade.style.height = `${String(box.height)}px`
    })
    const card = { width: this.#card.offsetWidth || 340, height: this.#card.offsetHeight || 180 }
    // The card stays clear of the whole popup a step points into (the
    // Launchpad menu), not just the row that is lit — or it hides the rows
    // the tour is talking about.
    const around = this.#tour.avoid === undefined ? null : firstOnScreen([this.#tour.avoid])
    const avoidBox = around === null ? rect : unionRect(rect, around.getBoundingClientRect())
    const place = placeCard(huge ? null : avoidBox, card, viewport)
    this.#card.style.left = `${String(Math.round(place.left))}px`
    this.#card.style.top = `${String(Math.round(place.top))}px`
    this.#card.dataset.side = place.side
  }
}

function unionRect(a: { left: number; top: number; width: number; height: number }, b: DOMRect) {
  const left = Math.min(a.left, b.left)
  const top = Math.min(a.top, b.top)
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.right) - left,
    height: Math.max(a.top + a.height, b.bottom) - top,
  }
}
