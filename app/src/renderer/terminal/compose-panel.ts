/**
 * THE MANAGE CONTAINERS PANEL — over the terminal area, for the thread on
 * screen: its services and their state, its data with sizes, and Restart,
 * Reset data… and Delete data… (each removal after a confirm that lists what
 * goes and its size). Opened from the Run menu.
 *
 * Thin by design: every sentence comes from `compose-panel-model.ts` (pure,
 * tested), every action is one request main decides (allowed-pattern #14).
 *
 * Cost (allowed-pattern #17): it reads only while it is open AND on screen —
 * on open, after each action, and on a slow interval; never while hidden.
 */
import type { FlowApi } from '../../shared/ipc-contract'
import type { RunThreadData } from '../../shared/run-setup'
import { markModalOverlay } from '../modal-overlay'
import {
  composePanelFace,
  COMPOSE_PANEL_REFRESH_MS,
  COMPOSE_PANEL_STRINGS,
  dataRemoveConfirm,
  shouldRefreshPanel,
  type ComposePanelFace,
} from './compose-panel-model'
import type { RunDotTone } from './run-group-model'

export interface ComposePanelDeps {
  api: FlowApi
  /** The terminal area the panel docks in (positioned). */
  host: HTMLElement
  isOnScreen(): boolean
  /** The panel closed. */
  onClosed(): void
}

const TONE: Record<RunDotTone, string> = {
  ok: 'var(--fl-color-success)',
  busy: 'var(--fl-color-warning)',
  bad: 'var(--fl-color-error)',
  off: 'var(--fl-color-text-secondary)',
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, className: string, title?: string): HTMLButtonElement {
  const node = el('button', className, label)
  node.type = 'button'
  if (title !== undefined) node.title = title
  return node
}

export class ComposePanel {
  readonly #deps: ComposePanelDeps
  #element: HTMLElement | null = null
  #threadId: string | null = null
  #title: string | null = null
  #data: RunThreadData | null = null
  #face: ComposePanelFace | null = null
  #state: 'loading' | 'ready' | 'none' | 'failed' = 'loading'
  #error: string | null = null
  #busy = false
  #inflight = false
  #lastReadAt: number | null = null
  #seq = 0
  #timer: ReturnType<typeof setInterval> | null = null
  #confirm: { close: () => void } | null = null
  /** Open the reset confirm as soon as the first read lands. */
  #resetOnRead = false

  constructor(deps: ComposePanelDeps) {
    injectComposeStyles()
    this.#deps = deps
  }

  get isOpen(): boolean {
    return this.#element !== null
  }

  /** Open for a thread (or show it again); `reset` opens the Reset data confirm once the data is read. */
  open(threadId: string, options: { reset?: boolean } = {}): void {
    if (this.#threadId !== threadId) this.close()
    this.#threadId = threadId
    this.#resetOnRead = options.reset === true
    if (this.#element === null) {
      this.#element = el('div', 'fl-compose')
      this.#element.setAttribute('role', 'dialog')
      this.#element.setAttribute('aria-label', COMPOSE_PANEL_STRINGS.title)
      this.#element.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          this.close()
        }
      })
      this.#deps.host.appendChild(this.#element)
      this.#state = 'loading'
      this.#render()
      void this.#deps.api.threads
        .get({ threadId })
        .then((thread) => {
          if (this.#threadId !== threadId) return
          this.#title = thread?.title ?? null
          this.#render()
        })
        .catch(() => undefined)
      // A slow interval, and only while open and on screen.
      this.#timer = setInterval(() => this.#refresh(false), COMPOSE_PANEL_REFRESH_MS)
    }
    this.#refresh(true)
    this.#element.focus()
  }

  close(): void {
    this.#confirm?.close()
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
    this.#seq += 1
    const had = this.#element !== null
    this.#element?.remove()
    this.#element = null
    this.#threadId = null
    this.#title = null
    this.#data = null
    this.#face = null
    this.#error = null
    this.#lastReadAt = null
    this.#inflight = false
    if (had) this.#deps.onClosed()
  }

  /** The terminal area came back on screen: re-read when the last read is old. */
  shown(): void {
    this.#refresh(false)
  }

  #refresh(force: boolean): void {
    const threadId = this.#threadId
    const run = this.#deps.api.run
    if (threadId === null || run === undefined) return
    const go = shouldRefreshPanel({
      open: this.#element !== null,
      onScreen: this.#deps.isOnScreen() && document.visibilityState !== 'hidden',
      inflight: this.#inflight,
      lastReadAt: this.#lastReadAt,
      now: Date.now(),
      force,
    })
    if (!go) return
    const seq = ++this.#seq
    this.#inflight = true
    run
      .threadData({ threadId })
      .then((data) => {
        if (seq !== this.#seq) return
        this.#lastReadAt = Date.now()
        this.#data = data
        this.#state = data === null ? 'none' : 'ready'
        this.#render()
        if (this.#resetOnRead && this.#face !== null && this.#face.canRemove) {
          this.#resetOnRead = false
          this.#openConfirm('reset')
        }
      })
      .catch(() => {
        if (seq !== this.#seq) return
        this.#state = 'failed'
        this.#render()
      })
      .finally(() => {
        if (seq === this.#seq) this.#inflight = false
      })
  }

  #act(run: () => Promise<{ ok: boolean; detail?: string }>): void {
    if (this.#busy) return
    this.#busy = true
    this.#error = null
    this.#render()
    run()
      .then((answer) => {
        if (!answer.ok) this.#error = answer.detail ?? COMPOSE_PANEL_STRINGS.actionFailed
      })
      .catch(() => {
        this.#error = COMPOSE_PANEL_STRINGS.actionFailed
      })
      .finally(() => {
        this.#busy = false
        this.#render()
        this.#refresh(true)
      })
  }

  #render(): void {
    const root = this.#element
    if (root === null) return
    root.textContent = ''
    root.tabIndex = -1
    const card = el('section', 'fl-compose-card')
    root.appendChild(card)

    const head = el('div', 'fl-compose-head')
    const titles = el('div', 'fl-compose-titles')
    const data = this.#data
    this.#face = data === null ? null : composePanelFace(this.#title, data)
    const face = this.#face
    const untitled = `${COMPOSE_PANEL_STRINGS.title} · ${this.#title ?? COMPOSE_PANEL_STRINGS.untitled}`
    titles.appendChild(el('div', 'fl-compose-title', face?.title ?? untitled))
    const status = el('div', 'fl-compose-status')
    if (face !== null) {
      const dot = el('span', 'fl-compose-dot')
      dot.style.background = face.live ? TONE.ok : TONE.off
      status.append(dot, document.createTextNode(face.status))
    } else {
      status.textContent =
        this.#state === 'loading' ? COMPOSE_PANEL_STRINGS.loading : this.#state === 'none' ? COMPOSE_PANEL_STRINGS.none : COMPOSE_PANEL_STRINGS.failed
    }
    titles.appendChild(status)
    const close = button('', 'fl-compose-close', COMPOSE_PANEL_STRINGS.close)
    close.setAttribute('aria-label', COMPOSE_PANEL_STRINGS.close)
    const glyph = document.createElement('fl-icon')
    glyph.setAttribute('name', 'close')
    glyph.setAttribute('size', '12')
    close.appendChild(glyph)
    close.addEventListener('click', () => this.close())
    head.append(titles, close)
    card.appendChild(head)

    if (face === null) return

    const services = el('div', 'fl-compose-block')
    services.appendChild(el('div', 'fl-compose-heading', COMPOSE_PANEL_STRINGS.servicesHeading))
    const grid = el('div', 'fl-compose-services')
    for (const row of face.services) {
      const cell = el('div', 'fl-compose-service')
      const dot = el('span', 'fl-compose-dot')
      dot.style.background = TONE[row.tone]
      cell.append(dot, el('span', 'fl-compose-name', row.name), el('span', 'fl-compose-muted', row.state))
      grid.appendChild(cell)
    }
    services.appendChild(grid)
    for (const note of face.notes) services.appendChild(el('p', 'fl-compose-note', note))
    card.appendChild(services)

    const volumes = el('div', 'fl-compose-block')
    const volumesHead = el('div', 'fl-compose-heading-row')
    volumesHead.appendChild(el('span', 'fl-compose-heading', face.dataHeading))
    if (face.total !== null) volumesHead.appendChild(el('span', 'fl-compose-muted', face.total))
    volumes.appendChild(volumesHead)
    if (face.noData !== null) volumes.appendChild(el('p', 'fl-compose-note', face.noData))
    const list = el('div', 'fl-compose-volumes')
    for (const row of face.volumes) {
      const line = el('div', 'fl-compose-volume')
      line.append(el('span', 'fl-compose-name', row.label), el('span', 'fl-compose-size', row.size))
      list.appendChild(line)
    }
    if (face.volumes.length > 0) volumes.appendChild(list)
    if (face.sharedNote !== null) volumes.appendChild(el('p', 'fl-compose-note', face.sharedNote))
    card.appendChild(volumes)

    if (face.problem !== null) card.appendChild(el('p', 'fl-compose-error', face.problem))
    if (this.#error !== null) card.appendChild(el('p', 'fl-compose-error', this.#error))

    const foot = el('div', 'fl-compose-foot')
    const restart = button(face.restart.label, 'fl-run-btn', face.restart.title)
    restart.disabled = this.#busy
    restart.addEventListener('click', () => {
      const threadId = this.#threadId
      const run = this.#deps.api.run
      if (threadId === null || run === undefined) return
      this.#act(() => run.restartThreadDocker({ threadId }))
    })
    const grow = el('span', 'fl-compose-grow')
    const reset = button(COMPOSE_PANEL_STRINGS.reset, 'fl-run-btn', COMPOSE_PANEL_STRINGS.resetTitle)
    reset.disabled = this.#busy || !face.canRemove
    reset.addEventListener('click', () => this.#openConfirm('reset'))
    const del = button(COMPOSE_PANEL_STRINGS.delete, 'fl-run-btn danger', COMPOSE_PANEL_STRINGS.deleteTitle)
    del.disabled = this.#busy || !face.canRemove
    del.addEventListener('click', () => this.#openConfirm('delete'))
    foot.append(restart, grow, reset, del)
    card.appendChild(foot)
  }

  /** The confirm before Reset data / Delete data: what goes and its size. Cancel has the keyboard. */
  #openConfirm(kind: 'reset' | 'delete'): void {
    const face = this.#face
    const threadId = this.#threadId
    const run = this.#deps.api.run
    if (face === null || threadId === null || run === undefined) return
    this.#confirm?.close()
    const copy = dataRemoveConfirm(kind, face)
    const overlay = el('div', 'fl-run-ask-overlay')
    markModalOverlay(overlay)
    const box = el('div', 'fl-run-ask fl-compose-confirm')
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    const title = el('div', 'fl-run-ask-title', copy.title)
    title.id = `fl-compose-confirm-${Date.now()}`
    box.setAttribute('aria-labelledby', title.id)
    const body = el('p', 'fl-run-ask-where', copy.body)
    const list = el('div', 'fl-compose-volumes')
    for (const row of copy.volumes) {
      const line = el('div', 'fl-compose-volume')
      line.append(el('span', 'fl-compose-name', row.label), el('span', 'fl-compose-size', row.size))
      list.appendChild(line)
    }
    const note = el('p', 'fl-run-ask-where', copy.note)
    const actions = el('div', 'fl-run-ask-actions')
    const cancel = button(copy.cancel, 'fl-run-btn')
    const go = button(copy.confirm, 'fl-run-btn danger-fill')
    actions.append(cancel, go)
    box.append(title, body, list, note, actions)
    overlay.appendChild(box)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const close = (): void => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      if (this.#confirm?.close === close) this.#confirm = null
      previous?.focus?.()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        ;(document.activeElement === go ? cancel : go).focus()
      }
    }
    cancel.addEventListener('click', close)
    go.addEventListener('click', () => {
      close()
      // `confirmed: true` is said here, by the press, and nowhere else (forbidden-pattern #15).
      this.#act(() =>
        kind === 'reset'
          ? run.emptyThreadData({ threadId, confirmed: true })
          : this.#deps.api.threads.releaseDataVolumes({ threadId, confirmed: true }),
      )
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    this.#confirm = { close }
    // A destructive confirm focuses its SAFE answer (#1173).
    cancel.focus()
  }
}

// ─── styles (Flow tokens only) ───────────────────────────────────────────────

let composeStylesInjected = false

function injectComposeStyles(): void {
  if (composeStylesInjected) return
  composeStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-compose {
      position: absolute; inset: 0; z-index: 6; overflow-y: auto; box-sizing: border-box;
      display: flex; justify-content: center; align-items: flex-start; padding: var(--fl-space-lg);
      background: var(--fl-color-bg); color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-compose:focus { outline: none; }
    .fl-compose-card {
      width: min(640px, 100%); box-sizing: border-box; padding: var(--fl-space-lg);
      display: flex; flex-direction: column; gap: var(--fl-space-md);
      background: var(--fl-color-surface); border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-compose-head { display: flex; align-items: flex-start; gap: var(--fl-space-sm); }
    .fl-compose-titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .fl-compose-title { font-weight: var(--fl-text-ui-weight-medium); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-compose-status { display: inline-flex; align-items: center; gap: var(--fl-space-xs); color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-compose-close {
      flex: none; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0;
      border: none; border-radius: var(--fl-radius-sm); background: transparent; color: var(--fl-color-text-secondary); cursor: pointer;
    }
    .fl-compose-close:hover, .fl-compose-close:focus-visible { background: var(--fl-color-surface-raised); color: var(--fl-color-text); outline: none; }
    .fl-compose-block {
      display: flex; flex-direction: column; gap: var(--fl-space-sm); padding: var(--fl-space-md);
      background: var(--fl-color-bg); border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
    }
    .fl-compose-heading { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-compose-heading-row { display: flex; align-items: baseline; justify-content: space-between; gap: var(--fl-space-sm); }
    .fl-compose-services { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--fl-space-xs) var(--fl-space-md); }
    .fl-compose-service { display: flex; align-items: center; gap: var(--fl-space-sm); min-width: 0; }
    .fl-compose-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .fl-compose-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-compose-muted { flex: none; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-compose-volumes { display: flex; flex-direction: column; gap: 2px; }
    .fl-compose-volume { display: flex; align-items: center; gap: var(--fl-space-sm); padding: 4px 0; }
    .fl-compose-size { flex: none; color: var(--fl-color-text-secondary); font-variant-numeric: tabular-nums; }
    .fl-compose-note { margin: 0; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); line-height: 1.5; }
    .fl-compose-error { margin: 0; color: var(--fl-color-error); font-size: var(--fl-text-caption-size); line-height: 1.5; }
    .fl-compose-foot { display: flex; align-items: center; gap: var(--fl-space-sm); flex-wrap: wrap; }
    .fl-compose-grow { flex: 1; }
    .fl-run-btn.danger { color: var(--fl-color-error); }
    .fl-run-btn.danger-fill { background: var(--fl-color-error); border-color: var(--fl-color-error); color: var(--fl-color-on-accent); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-compose-confirm .fl-compose-volumes {
      padding: var(--fl-space-xs) var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      background: var(--fl-color-bg); border: var(--fl-border-width) solid var(--fl-color-border);
    }
  `
  document.head.appendChild(style)
}
