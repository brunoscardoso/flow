/**
 * THE GROUPED LAUNCHPAD TAB'S BODY — the sub-bar (All, each step, the layout
 * switch, Restart all | Stop all) over one of three views:
 *
 *  - All, Side by side: a grid of live panes, one per step. Each pane holds
 *    that step's REAL xterm host, moved here from the panel's stash — never a
 *    copy, never re-created, so scrollback survives every switch.
 *  - All, One log: every step's recent lines in arrival order, each labelled
 *    with its step in that step's colour. Drawn only while on screen.
 *  - One step: its pane alone, full size, typeable.
 *
 * The panel owns the terminals, the tab strip and which view is remembered;
 * this owns only the DOM inside the group tab. Every sentence comes from
 * launchpad-tabs-model.ts (forbidden-pattern #12).
 */
import type { RunStepState } from '../../shared/run-setup'
import { slotPaint } from '../project-accent'
import { stepColourSlot, type LaunchpadLog, type LogLine } from './launchpad-log'
import {
  LAUNCHPAD_TAB_STRINGS as S,
  paneFace,
  selectedStep,
  subBar,
  type GroupLayout,
  type GroupSelection,
  type GroupView,
  type PaneFace,
} from './launchpad-tabs-model'
import { RUN_TONE_COLOR } from './run-group-view'

export interface LaunchpadGroupDeps {
  /** The live xterm host of a terminal, or null when the panel has no tab for it. */
  hostOf(terminalId: string): HTMLElement | null
  /** A host was just put on screen here: attach its xterm (once) and fit it. */
  attach(terminalId: string): void
  /** A pane changed size: refit its xterm. */
  fit(terminalId: string): void
  select(selection: GroupSelection): void
  setLayout(layout: GroupLayout): void
  restartAll(): void
  stopAll(): void
  restartStep(stepKey: string): void
  startStep(stepKey: string): void
  stopStep(stepKey: string): void
  projectNameOf(projectRoot: string): string
  /** The One log of a group. */
  logOf(scopeKey: string): LaunchpadLog
}

export interface LaunchpadGroupInput {
  scopeKey: string
  steps: RunStepState[]
  view: GroupView
}

interface Pane {
  key: string
  element: HTMLElement
  head: HTMLElement
  slot: HTMLElement
  placeholder: HTMLElement
  signature: string
  terminalId: string | null
}

function button(label: string, title: string, onClick: () => void, className = 'fl-lp-btn'): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.title = title
  element.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return element
}

/** A square button that shows an icon; its name is read out and shown on hover. */
function iconButton(
  iconName: string,
  label: string,
  title: string,
  onClick: () => void,
  className = 'fl-lp-btn fl-lp-icon',
): HTMLButtonElement {
  const element = button('', title, onClick, className)
  element.setAttribute('aria-label', label)
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', iconName)
  glyph.setAttribute('size', '12')
  element.appendChild(glyph)
  return element
}

function dot(tone: keyof typeof RUN_TONE_COLOR): HTMLElement {
  const element = document.createElement('span')
  element.className = 'fl-lp-dot'
  element.style.background = RUN_TONE_COLOR[tone]
  return element
}

/** A joined pair (or more) of buttons with a shared border and a divider between. */
function segment(label: string, buttons: HTMLButtonElement[]): HTMLElement {
  const group = document.createElement('div')
  group.className = 'fl-lp-seg'
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  for (const item of buttons) group.appendChild(item)
  return group
}

export class LaunchpadGroupView {
  readonly element: HTMLElement
  readonly #deps: LaunchpadGroupDeps
  readonly #bar: HTMLElement
  readonly #tiles: HTMLElement
  readonly #log: HTMLElement
  readonly #panes = new Map<string, Pane>()
  readonly #resize: ResizeObserver
  #barSignature = ''
  #input: LaunchpadGroupInput | null = null
  #shown = false
  /** Terminals whose hosts sit in a pane on screen now. */
  #placed: string[] = []
  // The One log's drawing cursor.
  #logScope: string | null = null
  #logSignature = ''
  #logFirst = 0
  #logNext = 0
  #logFrame: number | null = null

  constructor(deps: LaunchpadGroupDeps) {
    injectLaunchpadStyles()
    this.#deps = deps
    this.element = document.createElement('div')
    this.element.className = 'fl-lp'
    this.element.hidden = true
    this.#bar = document.createElement('div')
    this.#bar.className = 'fl-lp-bar'
    const body = document.createElement('div')
    body.className = 'fl-lp-body'
    this.#tiles = document.createElement('div')
    this.#tiles.className = 'fl-lp-tiles'
    this.#log = document.createElement('div')
    this.#log.className = 'fl-lp-log'
    this.#log.setAttribute('role', 'log')
    this.#log.tabIndex = 0
    this.#log.hidden = true
    body.append(this.#tiles, this.#log)
    this.element.append(this.#bar, body)
    this.#resize = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset['terminalId']
        if (id !== undefined && id.length > 0) this.#deps.fit(id)
      }
    })
  }

  /** Terminal ids whose hosts this view has on screen. */
  get placed(): readonly string[] {
    return this.#placed
  }

  /** Hide the group (another tab is shown). The hosts go back to the panel's stash. */
  hide(): void {
    if (!this.#shown) return
    this.#shown = false
    this.element.hidden = true
    this.#placed = []
    this.#cancelLogFrame()
  }

  /** Show / redraw the group. Returns the terminal ids whose hosts are on screen here. */
  render(input: LaunchpadGroupInput): readonly string[] {
    const scopeChanged = this.#input?.scopeKey !== input.scopeKey
    this.#input = input
    this.#shown = true
    this.element.hidden = false
    if (scopeChanged) {
      for (const pane of this.#panes.values()) {
        if (pane.terminalId !== null) this.#resize.unobserve(pane.slot)
        pane.element.remove()
      }
      this.#panes.clear()
      this.#barSignature = ''
      this.#logScope = null
    }
    this.#renderBar(input)
    const selected = selectedStep(input.view)
    if (selected === null && input.view.layout === 'log') {
      this.#tiles.hidden = true
      this.#log.hidden = false
      this.#placed = []
      this.#renderLog(true)
      return this.#placed
    }
    this.#log.hidden = true
    this.#cancelLogFrame()
    this.#tiles.hidden = false
    this.#tiles.classList.toggle('single', selected !== null)
    this.#placed = this.#renderPanes(input, selected)
    return this.#placed
  }

  /** New output arrived for a group: redraw the One log on the next frame — only if it is on screen. */
  logChanged(scopeKey: string): void {
    if (!this.#shown || this.#log.hidden || this.#input?.scopeKey !== scopeKey) return
    if (this.#logFrame !== null) return
    this.#logFrame = requestAnimationFrame(() => {
      this.#logFrame = null
      this.#renderLog(false)
    })
  }

  // ─── the sub-bar ───────────────────────────────────────────────────────────

  #renderBar(input: LaunchpadGroupInput): void {
    const bar = subBar(input.steps, input.view, (root) => this.#deps.projectNameOf(root))
    const signature = JSON.stringify(bar)
    if (signature === this.#barSignature) return
    this.#barSignature = signature
    this.#bar.textContent = ''
    const picks = document.createElement('div')
    picks.className = 'fl-lp-picks'
    for (const item of bar.items) {
      const pick = document.createElement('button')
      pick.type = 'button'
      pick.className = 'fl-lp-pick'
      pick.dataset['step'] = item.key
      pick.setAttribute('aria-pressed', String(item.pressed))
      if (item.tone !== null) pick.appendChild(dot(item.tone))
      const name = document.createElement('span')
      name.textContent = item.label
      pick.appendChild(name)
      if (item.project !== null) pick.title = item.project
      pick.addEventListener('click', () => this.#deps.select(item.key === 'all' ? 'all' : { step: item.key }))
      picks.appendChild(pick)
    }
    this.#bar.appendChild(picks)
    const spacer = document.createElement('span')
    spacer.className = 'fl-lp-spacer'
    this.#bar.appendChild(spacer)
    if (bar.showLayout) {
      const tiles = button(S.sideBySide, S.sideBySide, () => this.#deps.setLayout('tiles'))
      tiles.dataset['layout'] = 'tiles'
      tiles.setAttribute('aria-pressed', String(bar.layout === 'tiles'))
      const log = button(S.oneLog, S.oneLog, () => this.#deps.setLayout('log'))
      log.dataset['layout'] = 'log'
      log.setAttribute('aria-pressed', String(bar.layout === 'log'))
      this.#bar.appendChild(segment(S.layoutGroup, [tiles, log]))
    }
    const restart = button(S.restartAll, S.restartAllTitle, () => this.#deps.restartAll())
    restart.dataset['action'] = 'restart-all'
    const stop = button(S.stopAll, S.stopAllTitle, () => this.#deps.stopAll())
    stop.dataset['action'] = 'stop-all'
    this.#bar.appendChild(segment(S.wholeGroup, [restart, stop]))
  }

  // ─── panes ─────────────────────────────────────────────────────────────────

  #renderPanes(input: LaunchpadGroupInput, selected: string | null): string[] {
    const keep = new Set(input.steps.map((step) => step.key))
    for (const [key, pane] of this.#panes) {
      if (keep.has(key)) continue
      this.#resize.unobserve(pane.slot)
      pane.element.remove()
      this.#panes.delete(key)
    }
    const placed: string[] = []
    const shown: HTMLElement[] = []
    for (const step of input.steps) {
      const face = paneFace(step, (root) => this.#deps.projectNameOf(root))
      const pane = this.#paneFor(step.key)
      this.#updateHead(pane, face, selected !== null)
      const visible = selected === null || selected === step.key
      pane.element.hidden = !visible
      if (!visible) {
        // Its host goes back to the stash (the panel's sweep), so nothing off
        // screen holds a terminal.
        this.#unplace(pane)
        continue
      }
      shown.push(pane.element)
      const host = step.terminalId === null ? null : this.#deps.hostOf(step.terminalId)
      if (host === null || step.terminalId === null) {
        this.#unplace(pane)
        pane.placeholder.hidden = false
        pane.placeholder.textContent = face.tooltip.length > 0 && step.status !== 'idle' ? face.tooltip : S.notStarted
        continue
      }
      pane.placeholder.hidden = true
      if (pane.terminalId !== step.terminalId || host.parentElement !== pane.slot) {
        this.#unplace(pane)
        host.hidden = false
        pane.slot.appendChild(host)
        pane.terminalId = step.terminalId
        pane.slot.dataset['terminalId'] = step.terminalId
        this.#resize.observe(pane.slot)
        this.#deps.attach(step.terminalId)
      }
      placed.push(step.terminalId)
    }
    // Keep the grid in step order without moving panes that are already in place.
    const current = [...this.#tiles.children]
    const ordered = input.steps.map((step) => this.#panes.get(step.key)?.element).filter((el): el is HTMLElement => el !== undefined)
    if (current.length !== ordered.length || ordered.some((el, index) => current[index] !== el)) {
      for (const el of ordered) this.#tiles.appendChild(el)
    }
    this.#tiles.style.setProperty('--fl-lp-count', String(Math.max(1, shown.length)))
    return placed
  }

  #paneFor(key: string): Pane {
    const existing = this.#panes.get(key)
    if (existing !== undefined) return existing
    const element = document.createElement('div')
    element.className = 'fl-lp-pane'
    element.dataset['step'] = key
    const head = document.createElement('div')
    head.className = 'fl-lp-head'
    const slot = document.createElement('div')
    slot.className = 'fl-lp-slot'
    const placeholder = document.createElement('div')
    placeholder.className = 'fl-lp-placeholder'
    placeholder.hidden = true
    slot.appendChild(placeholder)
    element.append(head, slot)
    const pane: Pane = { key, element, head, slot, placeholder, signature: '', terminalId: null }
    this.#panes.set(key, pane)
    return pane
  }

  #unplace(pane: Pane): void {
    if (pane.terminalId === null) return
    this.#resize.unobserve(pane.slot)
    pane.terminalId = null
    delete pane.slot.dataset['terminalId']
    // The host itself is moved to the stash by the panel's sweep.
  }

  #updateHead(pane: Pane, face: PaneFace, single: boolean): void {
    const signature = JSON.stringify([face, single])
    if (signature === pane.signature) return
    pane.signature = signature
    const head = pane.head
    head.textContent = ''
    head.title = face.tooltip
    head.appendChild(dot(face.tone))
    const name = document.createElement('b')
    name.textContent = face.name
    head.appendChild(name)
    const project = document.createElement('span')
    project.className = 'fl-lp-project'
    project.textContent = face.project
    head.appendChild(project)
    // The state lives on the dot and the header's tooltip; the actions are
    // icons (user decision 2026-11-18). The spacer pushes them right.
    const spacer = document.createElement('span')
    spacer.className = 'fl-lp-head-grow'
    head.appendChild(spacer)
    if (!single) {
      const open = iconButton('expand-diagonal', S.open, S.openTitle, () => this.#deps.select({ step: face.key }), 'fl-lp-btn fl-lp-icon fl-lp-open')
      open.dataset['action'] = 'open'
      head.appendChild(open)
    }
    const starting = face.primary === S.start
    const primary = iconButton(starting ? 'play' : 'refresh', face.primary, face.primaryTitle, () => {
      if (starting) this.#deps.startStep(face.key)
      else this.#deps.restartStep(face.key)
    })
    primary.dataset['action'] = starting ? 'start' : 'restart'
    const stop = iconButton('square', S.stop, face.stopTitle, () => this.#deps.stopStep(face.key))
    stop.dataset['action'] = 'stop'
    stop.disabled = !face.canStop
    head.appendChild(segment(face.name, [primary, stop]))
  }

  // ─── the One log ───────────────────────────────────────────────────────────

  #cancelLogFrame(): void {
    if (this.#logFrame === null) return
    cancelAnimationFrame(this.#logFrame)
    this.#logFrame = null
  }

  /** Draw what is new since the last frame — or everything, after a hide, a scope change or a renamed step. */
  #renderLog(full: boolean): void {
    const input = this.#input
    if (input === null) return
    const log = this.#deps.logOf(input.scopeKey)
    const keys = input.steps.map((step) => step.key)
    const signature = JSON.stringify(input.steps.map((step) => [step.key, step.name]))
    const atBottom = this.#log.scrollHeight - this.#log.scrollTop - this.#log.clientHeight < 24
    const redraw =
      full || this.#logScope !== input.scopeKey || signature !== this.#logSignature || log.firstSeq > this.#logNext
    if (redraw) {
      this.#log.textContent = ''
      this.#logScope = input.scopeKey
      this.#logSignature = signature
      this.#logFirst = log.firstSeq
      this.#logNext = log.firstSeq
      const widest = input.steps.reduce((most, step) => Math.max(most, step.name.length), 4)
      this.#log.style.setProperty('--fl-lp-tag-width', `${widest + 2}ch`)
    } else {
      // Lines the ring let go of leave the top.
      if (log.firstSeq > this.#logFirst) {
        let first = this.#log.firstElementChild as HTMLElement | null
        while (first !== null && Number(first.dataset['seq'] ?? Infinity) < log.firstSeq) {
          first.remove()
          first = this.#log.firstElementChild as HTMLElement | null
        }
      }
      this.#logFirst = log.firstSeq
    }
    const names = new Map(input.steps.map((step) => [step.key, step.name]))
    const fresh = log.since(this.#logNext)
    const empty = this.#log.querySelector('.fl-lp-log-empty')
    if (fresh.some((line) => names.has(line.source))) empty?.remove()
    const fragment = document.createDocumentFragment()
    for (const line of fresh) {
      // A line from a terminal this group does not name (another Run's action) is not drawn.
      if (names.has(line.source)) fragment.appendChild(this.#lineElement(line, names, keys))
    }
    this.#log.appendChild(fragment)
    this.#logNext = log.nextSeq
    if (this.#log.querySelector('.fl-lp-line') === null && this.#log.querySelector('.fl-lp-log-empty') === null) {
      const note = document.createElement('div')
      note.className = 'fl-lp-log-empty'
      note.textContent = S.logEmpty
      this.#log.appendChild(note)
    }
    if (redraw || atBottom) this.#log.scrollTop = this.#log.scrollHeight
  }

  #lineElement(line: LogLine, names: ReadonlyMap<string, string>, keys: readonly string[]): HTMLElement {
    const row = document.createElement('div')
    row.className = 'fl-lp-line'
    row.dataset['seq'] = String(line.seq)
    const tag = document.createElement('span')
    tag.className = 'fl-lp-tag'
    const slot = stepColourSlot(keys, line.source)
    tag.textContent = names.get(line.source) ?? ''
    if (slot >= 0) tag.style.color = slotPaint(slot)
    row.appendChild(tag)
    row.appendChild(document.createTextNode(line.text))
    return row
  }
}

// ─── styles ──────────────────────────────────────────────────────────────────

let stylesInjected = false

function injectLaunchpadStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-lp {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--fl-color-surface);
    }
    .fl-lp[hidden] { display: none; }
    .fl-lp-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: var(--fl-space-xs);
      flex: none;
      padding: 4px 8px;
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-ui);
      font-size: 12px;
    }
    .fl-lp-picks { display: flex; flex-wrap: wrap; gap: 2px; min-width: 0; }
    .fl-lp-pick {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 22px;
      padding: 0 8px;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .fl-lp-pick:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-lp-pick[aria-pressed='true'] { background: var(--fl-color-surface-selected); color: var(--fl-color-text); }
    .fl-lp-project { color: var(--fl-color-text-secondary); font-size: 11px; opacity: 0.8; }
    .fl-lp-spacer { flex: 1; }
    .fl-lp-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
    .fl-lp-seg {
      display: inline-flex;
      flex: none;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      overflow: hidden;
    }
    .fl-lp-seg > .fl-lp-btn {
      border: none;
      border-radius: 0;
    }
    .fl-lp-seg > .fl-lp-btn + .fl-lp-btn {
      border-left: var(--fl-border-width) solid var(--fl-color-border);
    }
    .fl-lp-btn {
      height: 22px;
      padding: 0 9px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: 11.5px;
      cursor: pointer;
      white-space: nowrap;
    }
    .fl-lp-btn.fl-lp-icon { width: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .fl-lp-head-grow { flex: 1 1 auto; }
    .fl-lp-btn:hover:not(:disabled) { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-lp-btn[aria-pressed='true'] { background: var(--fl-color-surface-selected); color: var(--fl-color-text); }
    .fl-lp-btn:disabled { opacity: 0.45; cursor: default; }
    .fl-lp-btn:focus-visible, .fl-lp-pick:focus-visible { outline: 2px solid var(--fl-color-accent); outline-offset: -2px; }
    .fl-lp-head .fl-lp-btn { height: 20px; font-size: 11px; padding: 0 7px; }
    .fl-lp-open { border-color: transparent; background: transparent; }
    .fl-lp-body { position: relative; flex: 1; min-height: 0; }
    /* Two columns while the panel is wide enough for two readable panes, one
       when it is narrow; rows share the height and scroll past four. */
    .fl-lp-tiles {
      position: absolute;
      inset: 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(max(320px, calc(50% - 1px)), 1fr));
      grid-auto-rows: minmax(140px, 1fr);
      gap: 1px;
      overflow-y: auto;
      background: var(--fl-color-border);
    }
    .fl-lp-tiles[hidden] { display: none; }
    .fl-lp-tiles.single { grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); }
    .fl-lp-pane {
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
      background: var(--fl-color-surface);
    }
    .fl-lp-pane[hidden] { display: none; }
    .fl-lp-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: none;
      height: 28px;
      padding: 0 6px 0 10px;
      border-bottom: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-ui);
      font-size: 12px;
      color: var(--fl-color-text);
      white-space: nowrap;
      overflow: hidden;
    }
    .fl-lp-head b { flex: none; max-width: 40%; font-weight: 500; overflow: hidden; text-overflow: ellipsis; }
    .fl-lp-head .fl-lp-project { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .fl-lp-head .fl-lp-seg, .fl-lp-head .fl-lp-open { flex: none; }
    .fl-lp-slot { position: relative; flex: 1; min-height: 0; min-width: 0; }
    .fl-lp-slot > .fl-term-host { position: absolute; inset: 0; height: auto; }
    .fl-lp-placeholder {
      padding: 10px 12px;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: 12px;
    }
    .fl-lp-log {
      position: absolute;
      inset: 0;
      overflow: auto;
      padding: 6px 10px;
      font-family: 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 18px;
      color: var(--fl-color-text);
      user-select: text;
    }
    .fl-lp-log[hidden] { display: none; }
    .fl-lp-line { white-space: pre-wrap; overflow-wrap: anywhere; }
    .fl-lp-tag {
      display: inline-block;
      min-width: var(--fl-lp-tag-width, 14ch);
      font-weight: 500;
      color: var(--fl-color-text-secondary);
    }
    .fl-lp-log-empty { color: var(--fl-color-text-secondary); font-family: var(--fl-font-ui); }
  `
  document.head.appendChild(style)
}
