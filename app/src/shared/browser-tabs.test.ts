import {
  LIVE_TAB_CAP,
  activate,
  activeTab,
  addTab,
  closeTab,
  emptyTabs,
  flatTabs,
  markAsleep,
  moveTab,
  neighbourTab,
  opensInFlow,
  popClosed,
  restoreTabs,
  saveTabs,
  tabAtShortcut,
  tabShortcut,
  tabTitle,
  tabsToSleep,
  type BrowserTabsState,
} from './browser-tabs'

function three(): BrowserTabsState {
  let state = emptyTabs()
  state = addTab(state, { id: 'a', url: 'http://localhost:3000/orders', activate: true, now: 1 })
  state = addTab(state, { id: 'b', url: 'http://localhost:6006', activate: true, now: 2 })
  state = addTab(state, { id: 'c', url: 'http://localhost:3000/settings', activate: true, now: 3 })
  return state
}

describe('adding and closing tabs', () => {
  it('opens a link right after the tab it came from, behind it', () => {
    const state = addTab(activate(three(), 'a', 4), { id: 'd', url: 'http://localhost:3000/orders/4471', after: 'a', activate: false, now: 5 })
    expect(state.tabs.map((tab) => tab.id)).toEqual(['a', 'd', 'b', 'c'])
    expect(state.activeId).toBe('a')
    expect(state.tabs[1]?.live).toBe(false)
  })

  it('closing the active tab moves to its right, else its left', () => {
    let state = activate(three(), 'b', 4)
    state = closeTab(state, 'b')
    expect(state.activeId).toBe('c')
    state = closeTab(state, 'c')
    expect(state.activeId).toBe('a')
    state = closeTab(state, 'a')
    expect(state.activeId).toBeNull()
    expect(state.tabs).toEqual([])
  })

  it('remembers closed tabs for reopening, newest first', () => {
    let state = closeTab(three(), 'a')
    state = closeTab(state, 'b')
    const first = popClosed(state)
    expect(first.tab?.url).toBe('http://localhost:6006')
    expect(popClosed(first.state).tab?.url).toBe('http://localhost:3000/orders')
  })

  it('a blank tab is not remembered when closed', () => {
    const state = addTab(emptyTabs(), { id: 'n', url: null, activate: true, now: 1 })
    expect(closeTab(state, 'n').closed).toEqual([])
  })
})

describe('sleeping', () => {
  it('puts the tabs used longest ago to sleep past the cap, never the active one', () => {
    let state = emptyTabs()
    for (let i = 0; i < LIVE_TAB_CAP + 2; i += 1) state = addTab(state, { id: `t${String(i)}`, url: `http://localhost/${String(i)}`, activate: true, now: i + 1 })
    state = activate(state, 't0', 100)
    expect(tabsToSleep(state)).toEqual(['t1', 't2'])
    state = markAsleep(state, tabsToSleep(state))
    expect(state.tabs.filter((tab) => tab.live)).toHaveLength(LIVE_TAB_CAP)
    expect(activeTab(state)?.live).toBe(true)
  })

  it('opening a sleeping tab wakes it and clears its errors', () => {
    let state = markAsleep(three(), ['a'])
    state = { ...state, tabs: state.tabs.map((tab) => (tab.id === 'a' ? { ...tab, unseenErrors: 2 } : tab)) }
    state = activate(state, 'a', 9)
    expect(activeTab(state)).toMatchObject({ id: 'a', live: true, unseenErrors: 0 })
  })
})

describe('moving between tabs', () => {
  it('wraps with the next and previous shortcuts', () => {
    const state = three()
    expect(neighbourTab(state, 1)).toBe('a')
    expect(neighbourTab(state, -1)).toBe('b')
  })

  it('goes to a tab by position, ⌘9 to the last', () => {
    const state = three()
    expect(tabAtShortcut(state, 1)).toBe('a')
    expect(tabAtShortcut(state, 2)).toBe('b')
    expect(tabAtShortcut(state, 7)).toBeNull()
    expect(tabAtShortcut(state, 9)).toBe('c')
  })

  it('reorders by dragging', () => {
    expect(moveTab(three(), 'c', 0).tabs.map((tab) => tab.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('saving and restoring a conversation’s tabs', () => {
  it('round-trips addresses, titles and the active tab, all asleep', () => {
    let n = 0
    const saved = saveTabs(activate(three(), 'b', 9))
    expect(saved.active).toBe(1)
    const restored = restoreTabs(saved, () => `r${String((n += 1))}`)
    expect(restored.tabs.map((tab) => tab.url)).toEqual(['http://localhost:3000/orders', 'http://localhost:6006', 'http://localhost:3000/settings'])
    expect(restored.activeId).toBe('r2')
    expect(restored.tabs.every((tab) => !tab.live)).toBe(true)
  })

  it('round-trips through the flat saved record, which older builds read as one page', () => {
    const flat = flatTabs(saveTabs(activate(three(), 'c', 9)))
    expect(flat.url).toBe('http://localhost:3000/settings')
    expect(typeof flat.tabs).toBe('string')
    const restored = restoreTabs(flat, (() => { let n = 0; return () => `f${String((n += 1))}` })())
    expect(restored.tabs).toHaveLength(3)
    expect(restored.activeId).toBe('f3')
    // A broken list falls back to the one page older builds saved.
    expect(restoreTabs({ tabs: '{not json', url: 'http://localhost:1' }, () => 'x').tabs.map((tab) => tab.url)).toEqual(['http://localhost:1'])
  })

  it('reads the older single-page shape, and nothing from garbage', () => {
    const restored = restoreTabs({ url: 'http://localhost:3000' }, () => 'x')
    expect(restored.tabs.map((tab) => tab.url)).toEqual(['http://localhost:3000'])
    expect(restoreTabs({ url: null }, () => 'x').tabs).toEqual([])
    expect(restoreTabs('nope', () => 'x').tabs).toEqual([])
  })
})

describe('titles', () => {
  it('uses the page title, else the address, else New tab', () => {
    expect(tabTitle('http://localhost:3000/orders', 'Orders · Acme')).toBe('Orders · Acme')
    expect(tabTitle('http://localhost:3000/orders', '')).toBe('localhost:3000/orders')
    expect(tabTitle('http://localhost:3000/', null)).toBe('localhost:3000')
    expect(tabTitle(null, null)).toBe('New tab')
    expect(tabTitle('about:blank', null)).toBe('New tab')
  })
})

describe('which new windows stay in Flow', () => {
  it('keeps the same site and local servers, sends other sites out', () => {
    expect(opensInFlow('http://localhost:3000/orders', 'http://localhost:3000/orders/1')).toBe(true)
    expect(opensInFlow('http://localhost:3000', 'http://127.0.0.1:6006')).toBe(true)
    expect(opensInFlow('https://app.acme.test/a', 'https://app.acme.test/b')).toBe(true)
    expect(opensInFlow('http://localhost:3000', 'https://github.com/acme')).toBe(false)
    expect(opensInFlow('http://localhost:3000', 'mailto:a@b.c')).toBe(false)
    expect(opensInFlow(null, 'https://docs.acme.test')).toBe(false)
    expect(opensInFlow(null, 'http://api.localhost:8080')).toBe(true)
  })
})

describe('tab shortcuts', () => {
  const keys = (key: string, mods: Partial<{ meta: boolean; control: boolean; shift: boolean; alt: boolean }> = {}) => ({
    key, meta: false, control: false, shift: false, alt: false, ...mods,
  })
  it('reads ⌘ on macOS and Ctrl elsewhere', () => {
    expect(tabShortcut(keys('t', { meta: true }), true)).toEqual({ kind: 'new' })
    expect(tabShortcut(keys('T', { meta: true, shift: true }), true)).toEqual({ kind: 'reopen' })
    expect(tabShortcut(keys('w', { meta: true }), true)).toEqual({ kind: 'close' })
    expect(tabShortcut(keys('3', { meta: true }), true)).toEqual({ kind: 'goto', digit: 3 })
    expect(tabShortcut(keys('t', { control: true }), false)).toEqual({ kind: 'new' })
    expect(tabShortcut(keys('t', { control: true }), true)).toBeNull()
  })
  it('moves with ⌃Tab everywhere, and ignores other keys', () => {
    expect(tabShortcut(keys('Tab', { control: true }), true)).toEqual({ kind: 'next' })
    expect(tabShortcut(keys('Tab', { control: true, shift: true }), true)).toEqual({ kind: 'previous' })
    expect(tabShortcut(keys('l', { meta: true }), true)).toBeNull()
    expect(tabShortcut(keys('t', { meta: true, alt: true }), true)).toBeNull()
    expect(tabShortcut(keys('t'), true)).toBeNull()
  })
})
