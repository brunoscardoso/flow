/**
 * Settings › Guides: the switch for first-open tours, the overview again, and
 * every tour with whether it has run and a button to run it.
 *
 * It only reads and writes the stored state and asks the guide (by document
 * event) to show something; deciding WHEN anything shows stays in the guide's
 * controller.
 */
import { GUIDE_TOURS, type GuidesState } from '../../shared/guides'

const STYLE_ID = 'fl-guides-settings-styles'
const CSS = `
.fl-gset-switch {
  display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; margin: 10px 0 14px;
  background: var(--fl-color-surface-raised); border: 1px solid var(--fl-color-border); border-radius: 8px;
}
.fl-gset-switch label { flex: 1; min-width: 220px; display: flex; align-items: center; gap: 8px; font-size: 13px; }
.fl-gset-list { display: flex; flex-direction: column; border: 1px solid var(--fl-color-border); border-radius: 8px; overflow: hidden; }
.fl-gset-row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; flex-wrap: wrap; }
.fl-gset-row + .fl-gset-row { border-top: 1px solid var(--fl-color-border); }
.fl-gset-text { flex: 1; min-width: 200px; }
.fl-gset-name { font-size: 13px; color: var(--fl-color-text); }
.fl-gset-summary { font-size: 12px; color: var(--fl-color-text-secondary); }
.fl-gset-status { font-size: 12px; color: var(--fl-color-text-secondary); }
.fl-gset-status.seen { color: var(--fl-color-success); }
.fl-gset-btn {
  height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12.5px;
  background: transparent; color: var(--fl-color-text); border: 1px solid var(--fl-color-border);
}
.fl-gset-btn.primary { background: var(--fl-color-accent); color: #fff; border-color: transparent; font-weight: 600; }
.fl-gset-error { color: var(--fl-color-error); font-size: 12px; margin-top: 8px; }
`

export class GuidesSettingsSection {
  readonly element: HTMLElement
  readonly #onClose: () => void
  #state: GuidesState | null = null

  /** `onClose` leaves Settings, so the tour has its screen to point at. */
  constructor(onClose: () => void) {
    this.#onClose = onClose
    if (document.getElementById(STYLE_ID) === null) {
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }
    this.element = document.createElement('div')
    this.element.className = 'fl-settings-section fl-gset'
    document.addEventListener('flow:guides-updated', () => void this.shown())
  }

  /** Read the state and redraw — when the tab is shown, and after a change. */
  async shown(): Promise<void> {
    try {
      this.#state = await window.flow.settings.getGuides()
    } catch {
      this.#state = null
    }
    this.#draw()
  }

  async #write(update: Parameters<typeof window.flow.settings.setGuides>[0]): Promise<void> {
    try {
      this.#state = await window.flow.settings.setGuides(update)
      document.dispatchEvent(new CustomEvent('flow:guides-changed'))
      this.#draw()
    } catch {
      this.#draw("Flow couldn't save that. Try again.")
    }
  }

  #draw(error?: string): void {
    const heading = document.createElement('div')
    heading.className = 'fl-settings-heading'
    heading.textContent = 'Guides'
    const hint = document.createElement('div')
    hint.className = 'fl-settings-hint'
    hint.textContent =
      'Short tours of each part of Flow. Each one starts the first time you open its part. Run any of them again here.'
    this.element.replaceChildren(heading, hint)

    const state = this.#state
    if (state === null) {
      const none = document.createElement('div')
      none.className = 'fl-settings-hint'
      none.textContent = 'Guides are not available in this window. Restart Flow to load them.'
      this.element.appendChild(none)
      return
    }

    const box = document.createElement('div')
    box.className = 'fl-gset-switch'
    const label = document.createElement('label')
    const tick = document.createElement('input')
    tick.type = 'checkbox'
    tick.checked = state.enabled
    tick.dataset.guideSetting = 'enabled'
    tick.addEventListener('change', () => void this.#write({ enabled: tick.checked }))
    label.append(tick, document.createTextNode('Show a tour the first time I open a part'))
    const overview = document.createElement('button')
    overview.type = 'button'
    overview.className = 'fl-gset-btn'
    overview.textContent = 'Show the overview again'
    overview.addEventListener('click', () => {
      this.#onClose()
      document.dispatchEvent(new CustomEvent('flow:guide-overview'))
    })
    box.append(label, overview)
    this.element.appendChild(box)

    const list = document.createElement('div')
    list.className = 'fl-gset-list'
    for (const tour of GUIDE_TOURS) {
      const seen = state.seen.includes(tour.id)
      const row = document.createElement('div')
      row.className = 'fl-gset-row'
      row.dataset.guide = tour.id
      const text = document.createElement('div')
      text.className = 'fl-gset-text'
      const name = document.createElement('div')
      name.className = 'fl-gset-name'
      name.textContent = tour.name
      const summary = document.createElement('div')
      summary.className = 'fl-gset-summary'
      const count = tour.steps.length
      summary.textContent = `${tour.summary} · ${String(count)} ${count === 1 ? 'step' : 'steps'}`
      text.append(name, summary)
      const status = document.createElement('span')
      status.className = seen ? 'fl-gset-status seen' : 'fl-gset-status'
      status.textContent = seen ? 'Seen' : 'Not yet'
      const run = document.createElement('button')
      run.type = 'button'
      run.className = seen ? 'fl-gset-btn' : 'fl-gset-btn primary'
      run.textContent = seen ? 'Replay' : 'Start'
      // A tour with no screen to bring up (a card in the chat, Launchpad in
      // the terminal) can't run from here on demand: it is set to run the
      // next time its part is on screen, and the button says that.
      if (tour.open === undefined) {
        run.textContent = seen ? 'Show next time' : 'Starts when it appears'
        run.className = 'fl-gset-btn'
        run.disabled = !seen
        run.addEventListener('click', () => void this.#write({ unseen: tour.id }))
      } else {
        run.addEventListener('click', () => {
          if (tour.id !== 'settings') this.#onClose()
          document.dispatchEvent(new CustomEvent('flow:guide-replay', { detail: { id: tour.id } }))
        })
      }
      row.append(text, status, run)
      list.appendChild(row)
    }
    this.element.appendChild(list)

    if (error !== undefined) {
      const line = document.createElement('div')
      line.className = 'fl-gset-error'
      line.textContent = error
      this.element.appendChild(line)
    }
  }
}
