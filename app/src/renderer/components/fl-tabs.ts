/**
 * <fl-tabs> — Stark tab strip: flat text tabs, active = Text Primary on
 * Surface, no borders except the 1px bottom separator.
 *
 * Data-driven: assign `tabs` and `activeId`; the component renders and emits
 * selection/close events. Content switching is the owner's responsibility
 * (tabs strip only — panes vary too much across editor/terminal use).
 *
 * Light-DOM children slot into a right-aligned ACTIONS area after the tabs —
 * the home for strip-level action buttons (e.g. the editor's Blueprint
 * opener). The tab list itself stays data-driven and scrolls independently.
 *
 * Events:
 *   "fl-tab-select" { id }
 *   "fl-tab-close"  { id }          (only for tabs with closable: true)
 *   "fl-tab-rename" { id, label }   (only for tabs with renamable: true —
 *                                    double-click opens an inline editor;
 *                                    Enter/blur commit, Escape cancels, #719
 *                                    rename-on-blur convention)
 *
 * Right-click on a tab opens a close-operations menu (#735: Close / Close
 * Others / Close to the Left / Close to the Right / Close All) that emits one
 * "fl-tab-close" per affected closable tab — owners' existing close handlers
 * work unchanged, so every fl-tabs surface (editor, terminal, …) gets it.
 */
import { TAB_CLOSE_OPS, closeTargets, enabledOps } from './tab-close-ops'
import { planStripUpdate, type StripSnapshot, type StripUpdatePlan } from './tab-strip-update'
import { revealLabel } from '../reveal-label'
export interface TabDescriptor {
  id: string
  label: string
  /** Optional fl-icon name rendered before the label. */
  icon?: string
  closable?: boolean
  /** Dirty indicator (dot) — e.g. unsaved editor buffers. */
  dirty?: boolean
  /** Double-click opens an inline rename editor (#774 — terminal tabs). */
  renamable?: boolean
  /** Project accent dot color (CSS color or var() reference) rendered before
   *  the icon — multi-project threads mark tabs from secondary scope roots.
   *  Structural: a change rebuilds the strip (rare — scope changes only). */
  accent?: string
  /** Title-attribute tooltip (e.g. the full path of a secondary-root file).
   *  Structural, same rationale as `accent`. */
  tooltip?: string
  /** #1063 — the tab's id maps to a real file on disk, so its context menu
   *  offers "Reveal in Finder/Explorer" (emits fl-tab-reveal). Editor tabs set
   *  this; terminal tabs (whose id is not a path) leave it off. */
  revealable?: boolean
  /** #1442 — why reveal is unavailable for THIS tab right now (e.g. an unsaved
   *  note has no file yet). Set alongside `revealable`, it renders the row
   *  greyed with the reason as its tooltip instead of hiding it: the tab sits
   *  among ordinary file tabs, so a silently missing row reads as a glitch,
   *  while a dead one that reveals nothing breaks the #412/#709
   *  inert-not-silent invariant. Absent → the row is live. */
  revealBlockedReason?: string
}

export interface TabSelectDetail {
  id: string
}

export interface TabCloseDetail {
  id: string
}

export interface TabRevealDetail {
  id: string
}

export interface TabRenameDetail {
  id: string
  /** The committed name, trimmed. Empty = the owner should reset to its automatic title. */
  label: string
}

export class FlTabs extends HTMLElement {
  #strip: HTMLDivElement
  #tabs: TabDescriptor[] = []
  #activeId: string | null = null

  constructor() {
    super()
    const root = this.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        display: flex;
        align-items: stretch;
        flex: none;
        background: var(--fl-color-bg);
        /* A region seam (the strip's chrome fill against the content below it),
           not an object edge — see --fl-color-separator. */
        border-bottom: var(--fl-border-width) solid var(--fl-color-separator);
      }
      .strip {
        display: flex;
        align-items: stretch;
        flex: 1 1 auto;
        min-width: 0;
        height: var(--fl-tab-height);
        overflow-x: auto;
        /* #994: overflow-y must be hidden — a lone overflow-x makes overflow-y
           compute to auto, which stops Blink from redirecting a vertical wheel
           to the horizontal axis. And the scrollbar is thin-but-visible (was
           none) so an overflowed strip is discoverable at all. */
        overflow-y: hidden;
        scrollbar-width: thin;
        scrollbar-color: var(--fl-color-border) transparent;
      }
      .strip::-webkit-scrollbar { height: 4px; }
      .strip::-webkit-scrollbar-thumb { background: var(--fl-color-border); border-radius: 2px; }
      .strip::-webkit-scrollbar-track { background: transparent; }
      .actions {
        display: inline-flex;
        align-items: center;
        gap: var(--fl-space-xs);
        flex: none;
        height: var(--fl-tab-height);
        padding: 0 var(--fl-space-xs);
      }
      .tab {
        display: inline-flex;
        align-items: center;
        gap: var(--fl-space-xs);
        padding: 0 var(--fl-space-md);
        border: none;
        background: transparent;
        color: var(--fl-color-text-secondary);
        font-family: var(--fl-font-ui);
        font-size: var(--fl-text-ui-size);
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }
      .tab:hover { color: var(--fl-color-text); }
      .tab.active {
        color: var(--fl-color-text);
        background: var(--fl-color-surface);
      }
      .dirty-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--fl-color-accent);
        flex: none;
      }
      .project-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        flex: none;
      }
      .close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border: none;
        border-radius: var(--fl-radius-sm);
        background: transparent;
        color: var(--fl-color-text-secondary);
        cursor: pointer;
        padding: 0;
        visibility: hidden;
      }
      .tab:hover .close, .tab.active .close { visibility: visible; }
      .close:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
      .rename-input {
        border: var(--fl-border-width) solid var(--fl-color-accent);
        border-radius: var(--fl-radius-sm);
        background: var(--fl-color-surface);
        color: var(--fl-color-text);
        font-family: var(--fl-font-ui);
        font-size: var(--fl-text-ui-size);
        padding: 1px var(--fl-space-xs);
        width: 10ch;
        min-width: 6ch;
        outline: none;
      }
      .ctx-menu {
        position: fixed;
        z-index: 3000;
        min-width: 160px;
        display: flex;
        flex-direction: column;
        padding: var(--fl-space-xs);
        background: var(--fl-color-surface);
        border: var(--fl-border-width) solid var(--fl-color-border);
        border-radius: var(--fl-radius-md);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      }
      .ctx-item {
        border: none;
        background: transparent;
        color: var(--fl-color-text);
        font-family: var(--fl-font-ui);
        font-size: var(--fl-text-ui-size);
        text-align: left;
        padding: var(--fl-space-xs) var(--fl-space-sm);
        border-radius: var(--fl-radius-sm);
        cursor: pointer;
      }
      .ctx-item:hover:not(:disabled) { background: var(--fl-color-surface-raised); }
      .ctx-item:disabled { opacity: 0.4; cursor: default; }
    `
    this.#strip = document.createElement('div')
    this.#strip.className = 'strip'
    this.#strip.setAttribute('role', 'tablist')
    // #994: a plain mouse has no horizontal-scroll gesture — translate a
    // vertical wheel over the strip into horizontal scrolling (the standard
    // tab-strip idiom). preventDefault stops Blink's own orthogonal-axis
    // fallback (enabled by overflow-y: hidden above) from double-scrolling.
    // Horizontal gestures (trackpad swipes, deltaX ≠ 0) scroll natively.
    this.#strip.addEventListener(
      'wheel',
      (event) => {
        if (event.deltaY === 0 || event.deltaX !== 0) return
        if (this.#strip.scrollWidth <= this.#strip.clientWidth) return
        this.#strip.scrollLeft += event.deltaY
        event.preventDefault()
      },
      { passive: false },
    )
    // Right-aligned actions area — light-DOM children render here.
    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(document.createElement('slot'))
    root.appendChild(style)
    root.appendChild(this.#strip)
    root.appendChild(actions)
  }

  get tabs(): TabDescriptor[] {
    return this.#tabs
  }

  set tabs(value: TabDescriptor[]) {
    this.#tabs = value
    this.#render()
  }

  get activeId(): string | null {
    return this.#activeId
  }

  set activeId(value: string | null) {
    this.#activeId = value
    this.#render()
  }

  /** Snapshot of what the strip currently shows — the baseline for
   *  planStripUpdate's none/patch/rebuild decision (#993). */
  #rendered: StripSnapshot = { tabs: [], activeId: null }

  /** A render arrived while an inline rename editor was open (#959) — replayed
   *  when the editor closes, so the strip catches up without ever having torn
   *  the editor out from under the user. */
  #renderDeferred = false

  /**
   * Apply the cheapest sufficient DOM update (#993): background re-renders
   * that change nothing are skipped, label/dirty/active churn patches the
   * existing tab DOM in place (user scrollLeft untouched), and only
   * structural changes rebuild the strip — with scrollLeft preserved.
   * Auto-scroll-into-view (#700) runs ONLY when the active tab changed.
   */
  #render(): void {
    // #959: an open rename editor owns its tab button — any rebuild (and even a
    // relabel patch of the edited tab) while the user is typing would blur the
    // input, COMMIT a half-typed name and swallow the rest of the keystrokes.
    // The terminal strip re-renders on ordinary background activity (OSC 7 cwd
    // reports, window titles, sibling exits), so defer the whole update until
    // the editor closes — a briefly-stale label is strictly better than
    // destroying the user's edit (#719 rename-on-blur is the USER's click-away,
    // never the app's).
    if (this.#strip.querySelector('.rename-input')) {
      this.#renderDeferred = true
      return
    }
    const plan = planStripUpdate(this.#rendered, { tabs: this.#tabs, activeId: this.#activeId })
    if (plan.kind === 'none') return
    if (plan.kind === 'rebuild') {
      this.#rebuild()
    } else {
      this.#patch(plan)
    }
    if (plan.scrollActiveIntoView) {
      const active = this.#activeButton()
      if (active) this.#scrollActiveIntoView(active)
    }
    this.#rendered = { tabs: this.#tabs.map((tab) => ({ ...tab })), activeId: this.#activeId }
  }

  #activeButton(): HTMLElement | null {
    const index = this.#tabs.findIndex((tab) => tab.id === this.#activeId)
    return index >= 0 ? (this.#strip.children[index] as HTMLElement) : null
  }

  /** In-place update for label / dirty / active changes — never touches
   *  scrollLeft and never tears down tab DOM (also keeps an open inline
   *  rename editor alive across background label churn). */
  #patch(plan: Extract<StripUpdatePlan, { kind: 'patch' }>): void {
    const buttons = [...this.#strip.children] as HTMLElement[]
    if (buttons.length !== this.#tabs.length) {
      this.#rebuild() // defensive — snapshot drifted from the DOM somehow
      return
    }
    for (const i of plan.relabel) {
      const tab = this.#tabs[i]
      const label = buttons[i].querySelector<HTMLElement>('.label')
      if (label) label.textContent = tab.label
      buttons[i].querySelector('.close')?.setAttribute('aria-label', `Close ${tab.label}`)
    }
    for (const i of plan.redirty) {
      const tab = this.#tabs[i]
      const existing = buttons[i].querySelector('.dirty-dot')
      if (tab.dirty && !existing) {
        const dot = document.createElement('span')
        dot.className = 'dirty-dot'
        const close = buttons[i].querySelector('.close')
        if (close) {
          buttons[i].insertBefore(dot, close)
        } else {
          buttons[i].appendChild(dot)
        }
      } else if (!tab.dirty && existing) {
        existing.remove()
      }
    }
    if (plan.activeChanged) {
      this.#tabs.forEach((tab, i) => {
        const isActive = tab.id === this.#activeId
        buttons[i].classList.toggle('active', isActive)
        buttons[i].setAttribute('aria-selected', String(isActive))
      })
    }
  }

  #rebuild(): void {
    // #993: a rebuild resets scrollLeft to 0 — capture and restore the user's
    // position (the browser clamps it). #render scrolls the active tab into
    // view separately, and ONLY when the active tab actually changed.
    const previousScrollLeft = this.#strip.scrollLeft
    this.#strip.textContent = ''
    for (const tab of this.#tabs) {
      const tabId = tab.id
      const button = document.createElement('button')
      button.className = 'tab'
      button.setAttribute('role', 'tab')
      // Stable per-tab identity on the DOM — lets owners/tests map a rendered
      // tab back to its descriptor without relying on label text.
      button.dataset['id'] = tabId
      button.setAttribute('aria-selected', String(tab.id === this.#activeId))
      button.classList.toggle('active', tab.id === this.#activeId)
      if (tab.tooltip) {
        button.title = tab.tooltip
      }

      // Project accent dot (multi-project threads) — leftmost, so the project
      // marker never collides with the dirty dot on the right.
      if (tab.accent) {
        const projectDot = document.createElement('span')
        projectDot.className = 'project-dot'
        projectDot.style.background = tab.accent
        button.appendChild(projectDot)
      }

      if (tab.icon) {
        const icon = document.createElement('fl-icon')
        icon.setAttribute('name', tab.icon)
        icon.setAttribute('size', '14')
        button.appendChild(icon)
      }

      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = tab.label
      button.appendChild(label)

      if (tab.dirty) {
        const dot = document.createElement('span')
        dot.className = 'dirty-dot'
        button.appendChild(dot)
      }

      if (tab.closable) {
        const close = document.createElement('button')
        close.className = 'close'
        close.setAttribute('aria-label', `Close ${tab.label}`)
        const closeIcon = document.createElement('fl-icon')
        closeIcon.setAttribute('name', 'close')
        closeIcon.setAttribute('size', '10')
        close.appendChild(closeIcon)
        close.addEventListener('click', (event) => {
          event.stopPropagation()
          this.dispatchEvent(
            new CustomEvent<TabCloseDetail>('fl-tab-close', {
              detail: { id: tabId },
              bubbles: true,
              composed: true,
            }),
          )
        })
        button.appendChild(close)
      }

      button.addEventListener('click', () => {
        if (tabId !== this.#activeId) {
          this.activeId = tabId
          this.dispatchEvent(
            new CustomEvent<TabSelectDetail>('fl-tab-select', {
              detail: { id: tabId },
              bubbles: true,
              composed: true,
            }),
          )
        }
      })

      // Inline rename (#774): double-click swaps the label for an input. Enter
      // AND blur commit (#719 rename-on-blur convention — click-away must never
      // silently discard); Escape cancels. Commit emits fl-tab-rename; the
      // owner updates its descriptors, and the next render patches the strip.
      // Resolve the descriptor at event time — background label patches (#993)
      // update #tabs without rebuilding, so the built-time `tab` can be stale.
      if (tab.renamable) {
        button.addEventListener('dblclick', () => {
          const current = this.#tabs.find((t) => t.id === tabId)
          if (current) this.#startRename(current, button, label)
        })
      }

      // Close-operations context menu (#735) — for any strip with a closable tab.
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        this.#openContextMenu(tabId, event.clientX, event.clientY)
      })

      this.#strip.appendChild(button)
    }
    this.#strip.scrollLeft = previousScrollLeft
  }

  /** The open context menu, one at a time. */
  #ctxMenu: HTMLElement | null = null

  /** Right-click close-operations menu (#735). Emits one fl-tab-close per
   *  affected closable tab, so owners' existing handlers work unchanged. */
  #openContextMenu(targetId: string, x: number, y: number): void {
    this.#closeContextMenu()
    const enabled = enabledOps(this.#tabs, targetId)
    const canReveal = this.#tabs.find((tab) => tab.id === targetId)?.revealable === true
    if (enabled.size === 0 && !canReveal) return // nothing to show — no dead menu
    const menu = document.createElement('div')
    menu.className = 'ctx-menu'
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    // Skip the close-ops rows entirely when nothing is closable — otherwise a
    // reveal-only menu (revealable tab, no closable target) would render five
    // dead greyed rows above the reveal item.
    if (enabled.size > 0)
      for (const { op, label } of TAB_CLOSE_OPS) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'ctx-item'
        item.textContent = label
        item.disabled = !enabled.has(op)
        item.addEventListener('click', (event) => {
          event.stopPropagation()
          const targets = closeTargets(this.#tabs, targetId, op)
          this.#closeContextMenu()
          for (const id of targets) {
            this.dispatchEvent(
              new CustomEvent<TabCloseDetail>('fl-tab-close', {
                detail: { id },
                bubbles: true,
                composed: true,
              }),
            )
          }
        })
        menu.appendChild(item)
      }
    // #1063 — reveal the tab's file in the OS file manager. Gated on the tab's
    // `revealable` flag so terminal tabs (non-path ids) never show it. The host
    // (editor-tabs) maps the absolute id to {rootPath, relPath} and calls
    // project:revealPath — fl-tabs stays generic and only emits the intent.
    if (canReveal) {
      const revealItem = document.createElement('button')
      revealItem.type = 'button'
      revealItem.className = 'ctx-item'
      revealItem.textContent = revealLabel()
      // #1442: a tab that COULD reveal but can't right now (an unsaved note has
      // no file yet) gets the row greyed with the reason, never a live control
      // that reveals nothing — the same treatment the close ops above get.
      const blockedReason = this.#tabs.find((tab) => tab.id === targetId)?.revealBlockedReason
      if (blockedReason !== undefined) {
        revealItem.disabled = true
        revealItem.title = blockedReason
      } else {
        revealItem.addEventListener('click', (event) => {
          event.stopPropagation()
          this.#closeContextMenu()
          this.dispatchEvent(
            new CustomEvent<TabRevealDetail>('fl-tab-reveal', {
              detail: { id: targetId },
              bubbles: true,
              composed: true,
            }),
          )
        })
      }
      menu.appendChild(revealItem)
    }
    this.shadowRoot?.appendChild(menu)
    // Clamp into the viewport (#827): the menu opens at the cursor, and the
    // rightmost tab — exactly where "Close to the Right"/"Close All" get used —
    // put it past the window edge, truncating both directional labels to an
    // indistinguishable "Close to the". Measured after append so offsetWidth/
    // Height are real (position: fixed → viewport coordinates).
    const CTX_MENU_VIEWPORT_MARGIN_PX = 8
    if (x + menu.offsetWidth > window.innerWidth - CTX_MENU_VIEWPORT_MARGIN_PX) {
      menu.style.left = `${Math.max(CTX_MENU_VIEWPORT_MARGIN_PX, window.innerWidth - CTX_MENU_VIEWPORT_MARGIN_PX - menu.offsetWidth)}px`
    }
    if (y + menu.offsetHeight > window.innerHeight - CTX_MENU_VIEWPORT_MARGIN_PX) {
      menu.style.top = `${Math.max(CTX_MENU_VIEWPORT_MARGIN_PX, window.innerHeight - CTX_MENU_VIEWPORT_MARGIN_PX - menu.offsetHeight)}px`
    }
    this.#ctxMenu = menu
    // Outside mousedown / Escape dismiss — deferred so the opening click
    // doesn't self-close (composed events reach the document listener).
    const dismiss = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return
      if (event instanceof MouseEvent && event.composedPath().includes(menu)) return
      // This Escape was the menu's: say so, so the shell's own Escape
      // handlers (leave the expanded view, focus mode) do not ALSO act on it.
      if (event instanceof KeyboardEvent) event.preventDefault()
      this.#closeContextMenu()
    }
    //
    // CAPTURE phase: the menu is usually opened over a focused terminal or
    // editor, and xterm/Monaco stop the propagation of the keys they handle —
    // Escape among them — so a bubble-phase listener on document never heard
    // it and the menu ignored Escape whenever focus sat in one of them.
    //
    // Only the MOUSE listener is deferred (the opening click must not close
    // it). Escape is listened for at once: deferring it too let an Escape that
    // arrived before the timer ran fall on nothing, so the menu sometimes
    // ignored it.
    document.addEventListener('keydown', dismiss, true)
    let mouseArmed = false
    const armMouse = setTimeout(() => {
      if (this.#ctxMenu !== menu) return
      document.addEventListener('mousedown', dismiss, true)
      mouseArmed = true
    }, 0)
    this.#ctxDismiss = () => {
      clearTimeout(armMouse)
      document.removeEventListener('keydown', dismiss, true)
      if (mouseArmed) document.removeEventListener('mousedown', dismiss, true)
    }
  }

  #ctxDismiss: (() => void) | null = null

  #closeContextMenu(): void {
    this.#ctxMenu?.remove()
    this.#ctxMenu = null
    this.#ctxDismiss?.()
    this.#ctxDismiss = null
  }

  /** Swap a tab's label for the inline rename editor (#774). */
  #startRename(tab: TabDescriptor, button: HTMLElement, label: HTMLElement): void {
    if (button.querySelector('.rename-input')) return // already editing
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'rename-input'
    input.value = tab.label
    input.setAttribute('aria-label', `Rename ${tab.label}`)
    // One-shot guard: Enter/Escape tear the editor down, which fires blur —
    // without it blur would re-commit (or resurrect a deliberate Escape).
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      const next = input.value.trim()
      input.remove()
      label.hidden = false
      if (commit && next !== tab.label) {
        this.dispatchEvent(
          new CustomEvent<TabRenameDetail>('fl-tab-rename', {
            detail: { id: tab.id, label: next },
            bubbles: true,
            composed: true,
          }),
        )
      }
      // Replay any render deferred while the editor was open (#959) — the
      // strip catches up on background changes it withheld. (The commit
      // dispatch above may already have re-rendered synchronously via the
      // owner; the replay is then a cheap 'none' plan.)
      if (this.#renderDeferred) {
        this.#renderDeferred = false
        this.#render()
      }
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation() // keep tab-strip/global shortcuts out of typing
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
    // A click inside the editor must not re-trigger tab select/dblclick.
    input.addEventListener('click', (event) => event.stopPropagation())
    input.addEventListener('dblclick', (event) => event.stopPropagation())
    label.hidden = true
    label.after(input)
    input.focus()
    input.select()
  }

  /**
   * Keep the active tab visible when the ACTIVE TAB CHANGES (#700, scoped by
   * #993): scroll its box into the visible window minimally (nearest-edge,
   * like VS Code). Never runs on background re-renders — those must not
   * disturb the user's manual scroll position.
   * Skips when the strip has no layout yet (hidden pane, clientWidth 0).
   */
  #scrollActiveIntoView(button: HTMLElement): void {
    const strip = this.#strip
    if (strip.clientWidth === 0) return // not laid out / hidden — nothing to scroll
    const left = button.offsetLeft
    const right = left + button.offsetWidth
    if (left < strip.scrollLeft) {
      strip.scrollLeft = left
    } else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth
    }
  }
}

customElements.define('fl-tabs', FlTabs)

declare global {
  interface HTMLElementTagNameMap {
    'fl-tabs': FlTabs
  }
}
