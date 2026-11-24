/**
 * THE OVERVIEW — once, after setup: what Flow can do, in six cards, and the
 * promise that each part teaches itself the first time it opens.
 *
 * Every way out counts as an answer (Start, Explore on my own, Escape, the
 * backdrop): the question is "have you seen this?", and all of them say yes.
 * Only Start keeps the per-screen tours on. Every other way out turns them off
 * (user, 2026-11-24: "when the user click explore my own to skip the tutorial,
 * we are still showing anyway"). Skipping means skipping; the (i) beside each
 * feature still runs its tour, and Settings › Guides turns them back on.
 */
import { markModalOverlay } from '../modal-overlay'
import { injectGuideStyles } from './guide-tour-view'

export interface OverviewAnswer {
  /** Show a tour the first time each part opens. */
  tips: boolean
  /** Start the Threads tour now. */
  startTour: boolean
}

const CARDS: Array<{ icon: string; title: string; body: string }> = [
  { icon: 'message', title: 'Threads', body: 'Talk to the agent. Add projects, files and connectors as context.' },
  { icon: 'checklist', title: 'Tasks and Loops', body: 'A board of work. Press play and the agent works the cards on its own.' },
  { icon: 'map', title: 'Blueprint and Brain', body: 'A map of what your code does. Ask it questions and get answers with sources.' },
  { icon: 'git-branch', title: 'Changes and plan review', body: 'Review a plan before it runs, then see every change it made.' },
  { icon: 'rocket', title: 'Launchpad', body: 'Start your dev servers and scripts together, in one click.' },
  { icon: 'globe', title: 'Browser and UI drafts', body: 'Open your app beside the code, inspect it, and see drafts of new screens.' },
]

const STYLE_ID = 'fl-guide-overview-styles'
const CSS = `
.fl-guide-ov {
  position: fixed; inset: 0; z-index: 9000; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; padding: 16px; box-sizing: border-box;
}
.fl-guide-ov-panel {
  width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto; box-sizing: border-box;
  background: var(--fl-color-surface); color: var(--fl-color-text); font-family: var(--fl-font-ui);
  border: 1px solid var(--fl-color-island-border); border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5); padding: 28px 30px; display: flex; flex-direction: column; gap: 20px;
}
.fl-guide-ov-kicker { font-size: 11.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fl-color-text-secondary); }
.fl-guide-ov-title { margin: 4px 0 6px; font-size: 22px; font-weight: 600; }
.fl-guide-ov-lede { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--fl-color-text-secondary); }
.fl-guide-ov-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
.fl-guide-ov-card {
  background: var(--fl-color-surface-raised); border: 1px solid var(--fl-color-border); border-radius: 8px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 5px;
}
.fl-guide-ov-card fl-icon { color: var(--fl-color-accent); }
.fl-guide-ov-card-title { font-size: 13.5px; font-weight: 600; }
.fl-guide-ov-card-body { font-size: 12.5px; line-height: 1.45; color: var(--fl-color-text-secondary); }
.fl-guide-ov-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.fl-guide-ov-foot-gap { flex: 1; }
.fl-guide-ov .fl-guide-btn { height: 34px; padding: 0 14px; }
`

export class GuideOverview {
  readonly #overlay: HTMLElement
  #answered = false
  readonly #onAnswer: (answer: OverviewAnswer) => void
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    // Window capture, and immediate: a dialog under the tour (the Ask panel)
    // must not close on the same key that closes the tour.
    event.stopImmediatePropagation()
    this.#answer(false)
  }

  constructor(onAnswer: (answer: OverviewAnswer) => void) {
    injectGuideStyles()
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }
    this.#onAnswer = onAnswer
    this.#overlay = document.createElement('div')
    this.#overlay.className = 'fl-guide-ov'
    markModalOverlay(this.#overlay)
    this.#overlay.addEventListener('click', (event) => {
      if (event.target === this.#overlay) this.#answer(false)
    })

    const panel = document.createElement('div')
    panel.className = 'fl-guide-ov-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'true')
    panel.setAttribute('aria-labelledby', 'fl-guide-ov-title')

    const head = document.createElement('div')
    const kicker = document.createElement('div')
    kicker.className = 'fl-guide-ov-kicker'
    kicker.textContent = 'Welcome to Flow'
    const title = document.createElement('h1')
    title.className = 'fl-guide-ov-title'
    title.id = 'fl-guide-ov-title'
    title.textContent = 'Here is what Flow can do'
    const lede = document.createElement('p')
    lede.className = 'fl-guide-ov-lede'
    lede.textContent =
      'Each part has a short tour that starts the first time you open it. To skip them, choose Explore on my own: the (i) beside each feature still shows its tour.'
    head.append(kicker, title, lede)

    const grid = document.createElement('div')
    grid.className = 'fl-guide-ov-grid'
    for (const card of CARDS) {
      const el = document.createElement('div')
      el.className = 'fl-guide-ov-card'
      const icon = document.createElement('fl-icon')
      icon.setAttribute('name', card.icon)
      icon.setAttribute('size', '16')
      const t = document.createElement('div')
      t.className = 'fl-guide-ov-card-title'
      t.textContent = card.title
      const b = document.createElement('div')
      b.className = 'fl-guide-ov-card-body'
      b.textContent = card.body
      el.append(icon, t, b)
      grid.appendChild(el)
    }

    const foot = document.createElement('div')
    foot.className = 'fl-guide-ov-foot'
    const gap = document.createElement('span')
    gap.className = 'fl-guide-ov-foot-gap'
    const explore = document.createElement('button')
    explore.type = 'button'
    explore.className = 'fl-guide-btn'
    explore.dataset.guideAction = 'explore'
    explore.textContent = 'Explore on my own'
    explore.addEventListener('click', () => this.#answer(false))
    const start = document.createElement('button')
    start.type = 'button'
    start.className = 'fl-guide-btn primary'
    start.dataset.guideAction = 'start'
    start.textContent = 'Start with Threads'
    start.addEventListener('click', () => this.#answer(true))
    foot.append(gap, explore, start)

    panel.append(head, grid, foot)
    this.#overlay.appendChild(panel)
  }

  open(): void {
    document.body.appendChild(this.#overlay)
    window.addEventListener('keydown', this.#onKey, true)
    this.#overlay.querySelector<HTMLButtonElement>('[data-guide-action="start"]')?.focus()
  }

  close(): void {
    window.removeEventListener('keydown', this.#onKey, true)
    this.#overlay.remove()
  }

  #answer(startTour: boolean): void {
    if (this.#answered) return
    this.#answered = true
    this.close()
    this.#onAnswer({ tips: startTour, startTour })
  }
}
