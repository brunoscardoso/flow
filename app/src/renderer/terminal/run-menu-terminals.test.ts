import {
  filterRunMenuProjects,
  rememberRecentRoot,
  RUN_MENU_MAX_PROJECTS,
  RUN_MENU_TERMINAL_STRINGS,
  runMenuTerminals,
  type RunMenuTerminalsInput,
} from './run-menu-terminals'

const p = (name: string) => ({ rootPath: `/code/${name}`, name })
const FIVE = ['app', 'core', 'keel', 'desktop', 'mobile'].map(p)

function input(extra: Partial<RunMenuTerminalsInput> = {}): RunMenuTerminalsInput {
  return {
    projects: FIVE,
    recent: [],
    focusedRoot: null,
    focusedName: null,
    hasFocused: false,
    splitBlocked: null,
    ...extra,
  }
}

describe('the Run menu New terminal section', () => {
  it('is New terminal and Split terminal with one project or none known', () => {
    expect(runMenuTerminals(input({ projects: null }))).toEqual({ mode: 'single', split: null })
    const one = runMenuTerminals(input({ projects: [p('app')], hasFocused: true, focusedName: 'app', focusedRoot: '/code/app' }))
    expect(one).toEqual({ mode: 'single', split: { label: 'Split terminal', disabledReason: null } })
  })

  it('lists three projects at most: the conversation first, then the most recent, then scope order', () => {
    const menu = runMenuTerminals(input({ recent: ['/code/mobile', '/code/app', '/code/keel'] }))
    if (menu.mode !== 'projects') throw new Error('expected projects')
    expect(menu.shown.map((x) => x.name)).toEqual(['app', 'mobile', 'keel'])
    expect(menu.shown).toHaveLength(RUN_MENU_MAX_PROJECTS)
    expect(menu.more).toBe(2)
    expect(menu.conversationRoot).toBe('/code/app')
    // The full list: the short list on top, then the rest by name.
    expect(menu.all.map((x) => x.name)).toEqual(['app', 'mobile', 'keel', 'core', 'desktop'])
  })

  it('fills from scope order when nothing was opened yet, and has no More row with three or fewer', () => {
    const menu = runMenuTerminals(input({ recent: ['/elsewhere/gone'] }))
    if (menu.mode !== 'projects') throw new Error('expected projects')
    expect(menu.shown.map((x) => x.name)).toEqual(['app', 'core', 'keel'])
    const three = runMenuTerminals(input({ projects: FIVE.slice(0, 3) }))
    if (three.mode !== 'projects') throw new Error('expected projects')
    expect(three.more).toBe(0)
    expect(three.all).toHaveLength(3)
  })

  it('names the project a split opens in, and keeps a blocked split with its reason', () => {
    const named = runMenuTerminals(input({ hasFocused: true, focusedRoot: '/code/core', focusedName: 'core' }))
    expect(named.split).toEqual({ label: 'Split beside core', disabledReason: null })
    const full = runMenuTerminals(input({ hasFocused: true, focusedName: 'core', splitBlocked: 'At most 4 terminals side by side' }))
    expect(full.split?.disabledReason).toBe('At most 4 terminals side by side')
    expect(runMenuTerminals(input()).split).toBeNull()
  })

  it('counts a project listed twice once', () => {
    const menu = runMenuTerminals(input({ projects: [p('app'), p('app'), p('core')] }))
    if (menu.mode !== 'projects') throw new Error('expected projects')
    expect(menu.all.map((x) => x.name)).toEqual(['app', 'core'])
  })
})

describe('the More projects filter', () => {
  it('keeps every project whose name holds every word typed, in any case', () => {
    const all = [p('web-app'), p('api-core'), p('phone-app')]
    expect(filterRunMenuProjects(all, '').map((x) => x.name)).toEqual(['web-app', 'api-core', 'phone-app'])
    expect(filterRunMenuProjects(all, 'APP').map((x) => x.name)).toEqual(['web-app', 'phone-app'])
    expect(filterRunMenuProjects(all, 'api core').map((x) => x.name)).toEqual(['api-core'])
    expect(filterRunMenuProjects(all, 'nothing')).toEqual([])
  })
})

describe('remembering where terminals were opened', () => {
  it('puts the newest first, once, within the limit', () => {
    expect(rememberRecentRoot(['/a', '/b'], '/b')).toEqual(['/b', '/a'])
    expect(rememberRecentRoot(['/a', '/b', '/c'], '/d', 3)).toEqual(['/d', '/a', '/b'])
  })
})

describe('the section text', () => {
  it('holds no command, path or setting name (forbidden-pattern #12)', () => {
    for (const text of Object.values(RUN_MENU_TERMINAL_STRINGS)) {
      expect(text).not.toMatch(/`|planflow-ai|(^|\s)--?[a-z]|(^|\s)\/[a-z]|\b[a-z]+_[a-z_]+\b/i)
    }
  })
})
