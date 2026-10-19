/**
 * Tab-bar semantics in ONE place.
 *
 * Three surfaces (the corpus browser, the learning panel, the node popover)
 * hand-rolled near-identical rows of buttons — none with `tablist`/`tab`
 * roles, none with `aria-selected`, none reachable by arrow keys. The visual
 * classes stay each caller's own (`fb-learn-tab` / `fb-popover-tab`); what
 * this module owns is the semantics: roles, selection state, roving tabindex,
 * and Arrow/Home/End focus movement (APG manual activation — arrows move
 * focus, click or the button's native Enter/Space selects).
 */

import { roveTab } from './tab-bar-model'

export interface TabBarDef<K extends string> {
  key: K
  label: string
}

/**
 * Arrow/Home/End roving among the bar's visible `[role="tab"]` buttons.
 * Attached by `buildTabBar`, and exported on its own for a bar whose buttons
 * are built elsewhere. Skips hidden tabs — the popover reveals its tabs as
 * their content arrives.
 */
export function attachTabBarKeys(bar: HTMLElement): void {
  bar.addEventListener('keydown', (event) => {
    const tabs = Array.from(bar.querySelectorAll<HTMLButtonElement>('[role="tab"]')).filter(
      (btn) => !btn.hidden,
    )
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
    const next = roveTab(tabs.length, current, event.key)
    if (next === null) return
    event.preventDefault()
    tabs[next]?.focus()
  })
}

/**
 * Mark one tab of an existing bar selected: active class, `aria-selected`,
 * and the roving tab stop. Query-based on purpose — the popover activates
 * tabs from outside the builder, keyed by `data-tab`.
 */
export function syncTabSelection(bar: HTMLElement, activeClass: string, key: string | null): void {
  for (const btn of bar.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const active = btn.dataset['tab'] === key
    btn.classList.toggle(activeClass, active)
    btn.setAttribute('aria-selected', String(active))
    btn.tabIndex = active ? 0 : -1
  }
  // No selection yet (a popover still filling in): the first visible tab
  // keeps a tab stop so the bar stays reachable.
  if (key === null) {
    const first = Array.from(bar.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (btn) => !btn.hidden,
    )
    if (first !== undefined) first.tabIndex = 0
  }
}

/** Build a complete tab bar: container (`tablist`), buttons (`tab`), keys. */
export function buildTabBar<K extends string>(options: {
  barClass: string
  tabClass: string
  activeClass: string
  label: string
  tabs: ReadonlyArray<TabBarDef<K>>
  active: K | null
  onSelect: (key: K) => void
}): HTMLElement {
  const bar = document.createElement('div')
  bar.className = options.barClass
  bar.setAttribute('role', 'tablist')
  bar.setAttribute('aria-label', options.label)
  for (const tab of options.tabs) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = options.tabClass
    btn.dataset['tab'] = tab.key
    btn.textContent = tab.label
    btn.setAttribute('role', 'tab')
    btn.addEventListener('click', () => options.onSelect(tab.key))
    bar.appendChild(btn)
  }
  syncTabSelection(bar, options.activeClass, options.active)
  attachTabBarKeys(bar)
  return bar
}
