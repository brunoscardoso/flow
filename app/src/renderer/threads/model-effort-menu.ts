/**
 * One control for model AND effort — a trigger that opens a small two-level
 * menu, replacing the pair of bare `<select>`s that used to sit side by side
 * (user call 2026-09-04, against Cursor's).
 *
 * WHY THEY BELONG TOGETHER. They are one decision with two dials: nobody picks
 * an effort without having a model in mind. As two controls they took two slots
 * on a row that is short of them, and on the narrow chat column they wrapped —
 * so the message box grew a second line of chrome to hold settings most people
 * touch once a week.
 *
 * THE SELECTS ARE STILL THE STATE. This is a VIEW over them, not a replacement:
 * they stay in the DOM (hidden), this reads and writes their `value` and fires
 * their `change`, and every rule already hanging off them — the composer's
 * `#pushModelSelection`, its auto-model effort gating, the disabled states —
 * keeps working untouched. Replacing them outright would have meant moving
 * thirty references and re-deciding each one; wrapping them moves none, and
 * leaves exactly one source of truth for what is selected (allowed-pattern
 * #14).
 *
 * Its own popup rules are the app's: Escape closes, an outside mousedown
 * closes, and the trigger says what is chosen rather than what pressing it
 * does.
 */
import '../components'

export interface ModelEffortMenu {
  element: HTMLElement
  /** Re-read the selects — call after anything sets them programmatically. */
  refresh(): void
}

/**
 * The context-window choice (#1929) — a third row beside Model and Effort, but
 * NOT backed by a `<select>`: it is a saved preference the caller reads and
 * writes. Shown only when `isEnabled()` (Copilot, with a concrete model).
 */
export interface ContextChoiceControl {
  isEnabled(): boolean
  get(): 'default' | 'max'
  set(choice: 'default' | 'max'): void
  /** Human label for a choice — e.g. "Default" / "Max (1M)". */
  label(choice: 'default' | 'max'): string
}

/** Panel width and the flyout's offset, shared by the CSS and the placement. */
const MENU_WIDTH = 190
const SIDE_OFFSET = 196

export function createModelEffortMenu(input: {
  modelSelect: HTMLSelectElement
  effortSelect: HTMLSelectElement
  context?: ContextChoiceControl
}): ModelEffortMenu {
  injectStyles()
  const { modelSelect, effortSelect, context } = input

  // Kept in the DOM and out of sight: they are the state, not the surface.
  modelSelect.style.display = 'none'
  effortSelect.style.display = 'none'

  const wrap = document.createElement('span')
  wrap.className = 'fl-me'

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'fl-me-trigger'
  const triggerLabel = document.createElement('span')
  const chevron = document.createElement('fl-icon')
  chevron.setAttribute('name', 'chevron-down')
  chevron.setAttribute('size', '11')
  trigger.append(triggerLabel, chevron)
  wrap.appendChild(trigger)

  const panel = document.createElement('div')
  panel.className = 'fl-me-panel'
  panel.hidden = true
  wrap.appendChild(panel)

  const submenu = document.createElement('div')
  submenu.className = 'fl-me-submenu'
  submenu.hidden = true
  wrap.appendChild(submenu)

  /**
   * Label of a select's current option — what a person actually chose.
   *
   * The effort options are spelled "effort: high" because they used to sit on a
   * row with no heading, where the word was the only thing naming them. Inside a
   * menu whose row already says Effort, that prefix is the label repeated, so it
   * is dropped HERE — at the display boundary, leaving the option values and
   * every rule hanging off them untouched.
   */
  function labelOf(select: HTMLSelectElement): string {
    const raw = select.selectedOptions[0]?.textContent ?? select.value
    return pretty(raw)
  }

  function pretty(raw: string): string {
    const text = raw.replace(/^effort:\s*/i, '')
    return text.charAt(0).toUpperCase() + text.slice(1)
  }

  /**
   * BOTH CHOICES ON THE TRIGGER — "Opus/High", not "High".
   *
   * It showed the effort alone, so the model, which is the bigger of the two
   * decisions, could only be found by opening the menu.
   *
   * The effort is dropped when its control is DISABLED. That is the Auto case:
   * under Auto, plan-flow's routing owns the effort→model tier and the user's
   * pick is not applied (composer #syncEffortEnabled, #332) — so "Auto/Medium"
   * would print a value nothing uses, next to a menu row greyed out for saying
   * exactly that. The trigger reads "Auto" there, and the hover still names the
   * stored effort for anyone who wants to know what pinning a model would
   * restore.
   */
  function paintTrigger(): void {
    const model = labelOf(modelSelect)
    const effort = labelOf(effortSelect)
    triggerLabel.textContent = effortSelect.disabled ? model : `${model}/${effort}`
    trigger.title = `Model: ${model} · Effort: ${effort}${
      effortSelect.disabled ? ' (chosen by routing under Auto)' : ''
    }`
    trigger.setAttribute('aria-label', trigger.title)
    trigger.disabled = modelSelect.disabled && effortSelect.disabled
  }

  /** One row of the first level: a name, its current value, and a disclosure. */
  function row(name: string, select: HTMLSelectElement): HTMLButtonElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'fl-me-row'
    const label = document.createElement('span')
    label.textContent = name
    const value = document.createElement('span')
    value.className = 'fl-me-row-value'
    value.textContent = labelOf(select)
    const arrow = document.createElement('fl-icon')
    arrow.setAttribute('name', 'chevron-right')
    arrow.setAttribute('size', '11')
    item.append(label, value, arrow)
    item.disabled = select.disabled
    // A disabled row owes its reason in its own terms (forbidden-pattern #12).
    if (select.disabled) item.title = `${name} is set by the model you picked.`
    const show = (): void => {
      if (select.disabled) return
      for (const other of panel.querySelectorAll('.fl-me-row')) {
        other.classList.toggle('is-open', other === item)
      }
      openSubmenu(select)
    }
    item.addEventListener('click', show)
    item.addEventListener('mouseenter', show)
    return item
  }

  function renderPanel(): void {
    panel.textContent = ''
    panel.append(row('Effort', effortSelect), row('Model', modelSelect))
    // Context is a preference, not a <select>, and only for runtimes that offer
    // it (Copilot) with a concrete model picked — see the caller's isEnabled.
    if (context?.isEnabled()) panel.append(contextRow(context))
  }

  /** The Context row: a preference-backed twin of `row`, opening a fixed
   *  Default/Max submenu rather than a select's options. */
  function contextRow(ctx: ContextChoiceControl): HTMLButtonElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'fl-me-row'
    const label = document.createElement('span')
    label.textContent = 'Context'
    const value = document.createElement('span')
    value.className = 'fl-me-row-value'
    value.textContent = ctx.label(ctx.get())
    const arrow = document.createElement('fl-icon')
    arrow.setAttribute('name', 'chevron-right')
    arrow.setAttribute('size', '11')
    item.append(label, value, arrow)
    const show = (): void => {
      for (const other of panel.querySelectorAll('.fl-me-row')) {
        other.classList.toggle('is-open', other === item)
      }
      openContextSubmenu(ctx)
    }
    item.addEventListener('click', show)
    item.addEventListener('mouseenter', show)
    return item
  }

  /** The second level for Context: the two fixed choices, tick on the current. */
  function openContextSubmenu(ctx: ContextChoiceControl): void {
    submenu.textContent = ''
    for (const choice of ['default', 'max'] as const) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'fl-me-choice'
      const label = document.createElement('span')
      label.textContent = ctx.label(choice)
      item.appendChild(label)
      if (choice === ctx.get()) {
        const tick = document.createElement('span')
        tick.className = 'fl-me-tick'
        tick.textContent = '✓'
        item.appendChild(tick)
      }
      item.addEventListener('click', () => {
        ctx.set(choice)
        close()
        refresh()
      })
      submenu.appendChild(item)
    }
    submenu.hidden = false
    placeSubmenu()
  }

  /** The second level: every option, with a tick on the chosen one. */
  function openSubmenu(select: HTMLSelectElement): void {
    submenu.textContent = ''
    for (const option of Array.from(select.options)) {
      const choice = document.createElement('button')
      choice.type = 'button'
      choice.className = 'fl-me-choice'
      const label = document.createElement('span')
      label.textContent = pretty(option.textContent ?? option.value)
      choice.appendChild(label)
      if (option.value === select.value) {
        const tick = document.createElement('span')
        tick.className = 'fl-me-tick'
        tick.textContent = '✓'
        choice.appendChild(tick)
      }
      choice.addEventListener('click', () => {
        select.value = option.value
        // The SELECT is the state, so telling it is what makes the choice real —
        // every listener the composer hung on it runs from here.
        select.dispatchEvent(new Event('change', { bubbles: true }))
        close()
        refresh()
      })
      submenu.appendChild(choice)
    }
    submenu.hidden = false
    placeSubmenu()
  }

  /**
   * Beside the panel, or stacked above it when there is no room beside.
   *
   * This control's home is the chat column, which is ~316px wide — a flyout at a
   * fixed 196px offset ran straight off it and the model names were cut in half.
   * Measured at open time rather than guessed from a breakpoint, because the
   * column is user-resizable and the same menu also opens in a full-width one.
   *
   * Against the CLIPPING ANCESTOR, not the window. Measuring the viewport said
   * there was room — there was, on a 1440px screen — while the pane the menu
   * actually lives in ends at 634px and hides everything past it. What clips it
   * is what decides.
   */
  function placeSubmenu(): void {
    const anchor = wrap.getBoundingClientRect()
    const room = clipRight() - anchor.left - SIDE_OFFSET - MENU_WIDTH - 8
    const beside = room >= 0
    submenu.style.left = beside ? `${SIDE_OFFSET}px` : '0'
    // Stacked, it sits above the panel — which is itself above the trigger, so
    // the whole thing still reads bottom-up from the control you pressed.
    submenu.style.bottom = beside
      ? `${anchor.height + 4}px`
      : `${anchor.height + 4 + panel.offsetHeight + 4}px`
  }

  /** Right edge of the nearest ancestor that would crop this menu. */
  function clipRight(): number {
    let node: HTMLElement | null = wrap.parentElement
    while (node) {
      const overflow = getComputedStyle(node).overflowX
      if (overflow !== 'visible') return node.getBoundingClientRect().right
      node = node.parentElement
    }
    return window.innerWidth
  }

  function close(): void {
    panel.hidden = true
    submenu.hidden = true
    for (const other of panel.querySelectorAll('.fl-me-row')) other.classList.remove('is-open')
    document.removeEventListener('mousedown', onOutside)
    document.removeEventListener('keydown', onKey)
  }

  const onOutside = (event: MouseEvent): void => {
    if (!wrap.contains(event.target as Node)) close()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      trigger.focus()
    }
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (!panel.hidden) {
      close()
      return
    }
    renderPanel()
    panel.hidden = false
    // Escape listens at once: deferred, an Escape that landed before the timer
    // was dropped and left the menu open, so the next trigger press closed it.
    document.addEventListener('keydown', onKey)
    // Deferred so the opening click does not immediately close it.
    window.setTimeout(() => {
      document.addEventListener('mousedown', onOutside)
    }, 0)
  })

  function refresh(): void {
    paintTrigger()
    if (!panel.hidden) renderPanel()
  }

  refresh()
  return { element: wrap, refresh }
}

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-me { position: relative; display: inline-flex; flex: none; }
    .fl-me-trigger {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      height: 22px;
      padding: 0 var(--fl-space-xs);
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size);
      white-space: nowrap;
      cursor: pointer;
    }
    .fl-me-trigger:hover:not(:disabled) {
      background: var(--fl-color-surface-raised);
      color: var(--fl-color-text);
    }
    .fl-me-trigger:disabled { opacity: 0.5; cursor: default; }
    /* Both levels open UPWARD: this control lives at the bottom of a message
       box that is itself at the bottom of the window, so a menu dropped below
       it would open off-screen. */
    .fl-me-panel,
    .fl-me-submenu {
      position: absolute;
      bottom: calc(100% + 4px);
      z-index: 40;
      min-width: 190px;
      padding: var(--fl-space-xs);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
      box-shadow: var(--fl-shadow-md);
    }
    .fl-me-panel { left: 0; }
    /* left/bottom are set at open time — see placeSubmenu. */
    .fl-me-submenu { left: 196px; max-height: 240px; overflow-y: auto; }
    .fl-me-panel[hidden], .fl-me-submenu[hidden] { display: none; }
    .fl-me-row,
    .fl-me-choice {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      width: 100%;
      padding: 4px var(--fl-space-sm);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      text-align: left;
      cursor: pointer;
    }
    .fl-me-row:hover:not(:disabled),
    .fl-me-row.is-open,
    .fl-me-choice:hover { background: var(--fl-color-bg); }
    .fl-me-row:disabled { opacity: 0.5; cursor: default; }
    .fl-me-row-value {
      margin-left: auto;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 110px;
    }
    .fl-me-choice span:first-child { flex: 1; min-width: 0; }
    .fl-me-tick { flex: none; color: var(--fl-color-accent); }
  `
  document.head.appendChild(style)
}
