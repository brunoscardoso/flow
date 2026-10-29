/**
 * THE REVIEW TOUR'S STEP BAR — "Step 2 of 6 · Phase 2 · Data", Back / Next /
 * Close, attached beside the focused note block.
 *
 * All changes stay on one canvas (user decision 2026-10-28), and the bar TELLS
 * the step (user decision 2026-10-29): which file, what changes there and why,
 * in a few short lines from the note's own words — the walk-through is the
 * story, not only a pointer. The note block keeps Accept / Reject / Comment.
 * The bar also says why a step has no code and, on the last step, the tally
 * and what is left.
 * Decides nothing: the steps come from `review-tour-model.ts`, the placement
 * and the state from `storyline-view.ts`. Elements are made once and
 * repainted in place, so a focused button keeps its focus across steps.
 */
import { tourStepLabel, type TourStep } from './review-tour-model'

/** What the bar's buttons ask of the tour. */
export interface TourCardActions {
  back(): void
  next(): void
  close(): void
  send(): void
  /** Jump to the step showing note `n`. */
  goTo(n: number): void
}

/** The last step's extra line: the tally, and either Send or the note to go back to. */
export interface TourCardEnd {
  tally: string
  /** The first note left to review that the tour can show, or null. */
  goToN: number | null
  /** Send review — null when the review has no Send here (Verify, no conversation, already sent). */
  send: { enabled: boolean; title: string } | null
  /** A sentence instead of an action (the review was sent), or null. */
  sentence: string | null
}

export interface TourCardHandle {
  element: HTMLElement
  update(step: TourStep, index: number, total: number, end: TourCardEnd | null): void
  destroy(): void
}


function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string, press: () => void): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  node.addEventListener('click', (event) => {
    event.stopPropagation()
    press()
  })
  return node
}

export function mountTourCard(
  host: HTMLElement,
  step: TourStep,
  index: number,
  total: number,
  actions: TourCardActions,
  end: TourCardEnd | null = null,
): TourCardHandle {
  const bar = el('div', 'fb-tour-bar')
  bar.setAttribute('role', 'group')
  bar.setAttribute('aria-label', 'Walking through the changes')
  const head = el('div', 'fb-tour-head')
  const label = el('span', 'fb-tour-label')
  // Read out as the reader moves, without taking the focus off Next.
  label.setAttribute('aria-live', 'polite')
  const close = button('fb-tour-close', '×', () => actions.close())
  close.setAttribute('aria-label', 'Close the walk-through')
  close.title = 'Close the walk-through'
  head.append(label, close)
  const story = el('div', 'fb-tour-story')
  const file = el('div', 'fb-tour-file')
  const action = el('div', 'fb-tour-action')
  const change = el('p', 'fb-tour-change')
  const reason = el('p', 'fb-tour-reason')
  const result = el('p', 'fb-tour-result')
  story.append(file, action, change, reason, result)
  const missing = el('div', 'fb-tour-missing')
  const endRow = el('div', 'fb-tour-end')
  const tally = el('span', 'fb-tour-tally')
  const goTo = button('fb-tour-goto', '', () => {
    const n = goTo.dataset['note']
    if (n !== undefined) actions.goTo(Number(n))
  })
  const send = button('fb-tour-send', 'Send review to the agent', () => actions.send())
  const sentence = el('span', 'fb-tour-sentence')
  endRow.append(tally, sentence, goTo, send)
  const acts = el('div', 'fb-tour-acts')
  const back = button('fb-tour-back', 'Back', () => actions.back())
  const next = button('fb-tour-next', 'Next', () => actions.next())
  const hint = el('span', 'fb-tour-hint', '← → to move · Esc to close')
  acts.append(hint, back, next)
  bar.append(head, story, missing, endRow, acts)

  const paint = (current: TourStep, at: number, count: number, last: TourCardEnd | null): void => {
    bar.dataset['note'] = String(current.n)
    label.textContent = tourStepLabel(current, at, count)
    const told = current.story
    file.textContent = told.file
    file.title = told.file
    action.textContent = told.action
    for (const [line, text] of [[change, told.change], [reason, told.reason], [result, told.result]] as const) {
      line.hidden = text === null
      line.textContent = text ?? ''
    }
    missing.hidden = current.codeFound || current.codeMessage === null
    missing.textContent = current.codeFound ? '' : (current.codeMessage ?? '')
    back.disabled = at <= 0
    next.disabled = at >= count - 1
    endRow.hidden = last === null
    if (last === null) return
    tally.textContent = last.tally
    sentence.hidden = last.sentence === null
    sentence.textContent = last.sentence ?? ''
    goTo.hidden = last.goToN === null
    if (last.goToN !== null) {
      goTo.dataset['note'] = String(last.goToN)
      goTo.textContent = `Go to note ${String(last.goToN)}`
    }
    // GO TO wins: a note left to review comes before sending.
    send.hidden = last.send === null || last.goToN !== null
    send.disabled = last.send?.enabled !== true
    send.title = last.send?.title ?? ''
  }
  paint(step, index, total, end)
  host.appendChild(bar)
  return {
    element: bar,
    update: paint,
    destroy: () => bar.remove(),
  }
}
