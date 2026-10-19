/**
 * THE CONTEXT METER — how full this conversation's window is, in the footer
 * line that already reports the turn's tokens (#1955).
 *
 * Before this, Flow computed the usage and knew the window and joined neither:
 * `↑ 487.3k (486.9k cached)` with no denominator anywhere on screen. Measured
 * over 7,521 recorded calls, 97% of every token consumed was context being
 * re-read, and the top 10 of 2,357 sessions were 72.9% of the spend — the one
 * number that would have explained the bill was the one nobody could see.
 *
 * THREE RULES THIS KEEPS:
 *
 *  1. **No reading, no meter.** `update(null)` renders nothing at all and the
 *     footer reads exactly as it did before this existed. A provider that does
 *     not publish a window gets no percentage, because a percentage over a
 *     default denominator looks like a measurement and is not one.
 *  2. **A control, not a sentence.** The remedy is a button that does the
 *     thing. UI text here never names a command, a path or a config key
 *     (forbidden-pattern #12) — the whole reason the one pre-existing signal
 *     was useless is that it wrote "run /compact" to a stream the IDE does not
 *     show.
 *  3. **A person presses it.** Shortening sends through the composer's own
 *     send, the same door Generate artifact and Execute the plan use. Nothing
 *     here ever decides on its own that it is time (Critical Rule 1).
 */

import {
  contextMeterLabel,
  formatUsed,
  formatWindow,
  type ContextReading,
} from '../../shared/context-usage'
import { openAnchoredPopover, type AnchoredPopover } from './anchored-popover'

export interface ContextMeterCallbacks {
  /** Send the shorten request. The meter never sends it itself. */
  onShorten: () => void
}

export class ContextMeter {
  readonly element: HTMLButtonElement
  #reading: ContextReading | null = null
  #popover: AnchoredPopover | null = null
  #bar: HTMLSpanElement
  #fill: HTMLSpanElement
  #label: HTMLSpanElement

  constructor(private readonly callbacks: ContextMeterCallbacks) {
    injectContextMeterStyles()

    this.element = document.createElement('button')
    this.element.type = 'button'
    this.element.className = 'fl-ctx-meter'
    this.element.hidden = true

    this.#bar = document.createElement('span')
    this.#bar.className = 'fl-ctx-bar'
    // Decorative: the button's accessible name carries the same fact in words.
    this.#bar.setAttribute('aria-hidden', 'true')
    this.#fill = document.createElement('span')
    this.#fill.className = 'fl-ctx-fill'
    this.#bar.append(this.#fill)

    this.#label = document.createElement('span')
    this.#label.className = 'fl-ctx-label'

    this.element.append(this.#bar, this.#label)
    this.element.addEventListener('click', () => this.#toggle())
  }

  /** The current reading, or null when there is nothing honest to show. */
  update(reading: ContextReading | null): void {
    this.#reading = reading
    if (reading === null) {
      this.element.hidden = true
      // A meter that vanishes must not leave its panel floating over nothing.
      this.#popover?.close()
      return
    }
    this.element.hidden = false
    this.element.dataset['pressure'] = reading.pressure
    this.#fill.style.width = `${reading.percentage}%`
    this.#label.textContent = reading.label
    this.element.setAttribute('aria-label', contextMeterLabel(reading))
    if (this.#popover !== null) this.#fillPanel(this.#popover.panel)
  }

  /** Close anything open — the pane calls this when it drops the thread. */
  dispose(): void {
    this.#popover?.close()
  }

  #toggle(): void {
    if (this.#popover !== null) {
      this.#popover.close()
      return
    }
    if (this.#reading === null) return
    this.#popover = openAnchoredPopover({
      anchor: this.element,
      // The footer row outlives the meter's own redraws; watching the button
      // itself closes the panel on the next usage event (anchored-popover's
      // fourth lesson).
      watch: this.element.parentElement ?? this.element,
      className: 'fl-ctx-panel',
      ariaLabel: 'Context',
      onClose: () => {
        this.#popover = null
      },
    })
    this.#fillPanel(this.#popover.panel)
    this.#popover.reposition()
  }

  #fillPanel(panel: HTMLElement): void {
    const reading = this.#reading
    if (reading === null) return
    panel.replaceChildren()

    const head = document.createElement('div')
    head.className = 'fl-ctx-panel-head'
    const used = document.createElement('span')
    used.textContent = `${formatUsed(reading.totalTokens)} of ${formatWindow(reading.maxTokens)} used`
    const pct = document.createElement('span')
    pct.className = 'fl-ctx-panel-pct'
    pct.textContent = `${reading.percentage}%`
    head.append(used, pct)

    const bar = document.createElement('span')
    bar.className = 'fl-ctx-bar fl-ctx-bar-wide'
    bar.setAttribute('aria-hidden', 'true')
    const fill = document.createElement('span')
    fill.className = 'fl-ctx-fill'
    fill.style.width = `${reading.percentage}%`
    bar.append(fill)

    panel.append(head, bar)

    if (reading.model !== null) {
      const model = document.createElement('div')
      model.className = 'fl-ctx-panel-note'
      model.textContent = `Window of ${reading.model}.`
      panel.append(model)
    }

    const explain = document.createElement('p')
    explain.className = 'fl-ctx-panel-explain'
    explain.textContent =
      reading.pressure === 'healthy'
        ? 'Shortening replaces the earlier turns with a summary and keeps the recent ones in full. Nothing is removed from what you can scroll back to.'
        : 'Most of what each turn costs is this conversation being re-read. Shortening replaces the earlier turns with a summary and keeps the recent ones in full; nothing is removed from what you can scroll back to.'
    panel.append(explain)

    if (!reading.canShorten) {
      // The runtime has no shortening to offer. Say what IS true rather than
      // showing a button that would do nothing — the reading is still worth
      // having, and a dead control is worse than none.
      const none = document.createElement('div')
      none.className = 'fl-ctx-panel-note'
      none.textContent = 'This runtime cannot shorten a conversation yet. Starting a new thread is the way to reset it.'
      panel.append(none)
      return
    }

    const actions = document.createElement('div')
    actions.className = 'fl-ctx-panel-actions'
    const shorten = document.createElement('button')
    shorten.type = 'button'
    shorten.className = 'fl-ctx-panel-go'
    shorten.textContent = 'Shorten the conversation'
    shorten.addEventListener('click', () => {
      this.#popover?.close()
      this.callbacks.onShorten()
    })
    actions.append(shorten)
    panel.append(actions)
  }
}

let stylesInjected = false

function injectContextMeterStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-ctx-meter {
      display: inline-flex; align-items: center; gap: 8px;
      background: none; border: 1px solid var(--fl-color-border);
      border-radius: 4px; padding: 2px 7px; margin-left: 10px;
      cursor: pointer; font: inherit; color: var(--fl-color-text-secondary);
    }
    .fl-ctx-meter:hover { border-color: var(--fl-color-text-secondary); }
    .fl-ctx-bar {
      display: block; width: 56px; height: 4px; border-radius: 3px;
      background: var(--fl-color-border); overflow: hidden;
    }
    .fl-ctx-bar-wide { width: 100%; height: 6px; }
    .fl-ctx-fill {
      display: block; height: 100%; border-radius: 3px;
      background: var(--fl-color-text-secondary);
    }
    .fl-ctx-label { font-size: 11px; font-variant-numeric: tabular-nums; }
    /* Pressure is carried by colour AND by the fill's length, never by colour
       alone — the bar is readable without distinguishing amber from grey. */
    .fl-ctx-meter[data-pressure='filling'] { border-color: var(--fl-color-warning); }
    .fl-ctx-meter[data-pressure='filling'] .fl-ctx-fill { background: var(--fl-color-warning); }
    .fl-ctx-meter[data-pressure='filling'] .fl-ctx-label { color: var(--fl-color-warning); }
    .fl-ctx-meter[data-pressure='nearly-full'] { border-color: var(--fl-color-error); }
    .fl-ctx-meter[data-pressure='nearly-full'] .fl-ctx-fill { background: var(--fl-color-error); }
    .fl-ctx-meter[data-pressure='nearly-full'] .fl-ctx-label { color: var(--fl-color-error); }

    .fl-ctx-panel {
      width: 320px; padding: 14px 16px;
      display: flex; flex-direction: column; gap: 10px;
      background: var(--fl-color-bg-elevated, var(--fl-color-bg));
      border: 1px solid var(--fl-color-border); border-radius: 6px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      color: var(--fl-color-text); font-size: 13px;
    }
    .fl-ctx-panel-head {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    }
    .fl-ctx-panel-pct { font-variant-numeric: tabular-nums; color: var(--fl-color-text-secondary); }
    .fl-ctx-panel-note { font-size: 12px; color: var(--fl-color-text-secondary); }
    .fl-ctx-panel-explain {
      margin: 0; font-size: 12px; line-height: 1.5; color: var(--fl-color-text-secondary);
    }
    .fl-ctx-panel-actions { display: flex; gap: 8px; }
    .fl-ctx-panel-go {
      background: var(--fl-color-accent); color: #ffffff; border: none;
      border-radius: 4px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer;
    }
  `
  document.head.append(style)
}
