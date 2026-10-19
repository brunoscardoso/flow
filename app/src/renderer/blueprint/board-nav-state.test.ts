import {
  ROOT_BOARD_NAV,
  decodeBoardNav,
  encodeBoardNav,
  sameBoardNav,
  type BoardNavState,
} from './board-nav-state'
import type { FocusNode } from './focus-stack'

const chats: FocusNode = {
  kind: 'feature',
  id: 'chats',
  name: 'Chats',
  kicker: '3 parts',
  drillable: true,
  canDrill: true,
  childCount: 3,
}

describe('board navigation state', () => {
  it('round-trips a drilled Territory', () => {
    const nav: BoardNavState = {
      feature: null,
      trail: [],
      stack: [chats],
    }
    const decoded = decodeBoardNav(encodeBoardNav(nav))
    expect(decoded).toEqual(nav)
    expect(sameBoardNav(decoded, nav)).toBe(true)
  })

  it('round-trips a feature brief with its depth', () => {
    const nav: BoardNavState = { ...ROOT_BOARD_NAV, feature: 'chats', trail: ['engine'] }
    expect(decodeBoardNav(encodeBoardNav(nav))).toEqual(nav)
  })

  it('ignores a row saved while the retired code map was on stage', () => {
    // The code map was replaced by the code storyline; a tab set saved before
    // that still carries `codeMap: true`, and it must land on the board, not throw.
    const decoded = decodeBoardNav({ codeMap: true, feature: 'chats', trail: JSON.stringify(['engine']) })
    expect(decoded).toEqual({ ...ROOT_BOARD_NAV, feature: 'chats', trail: ['engine'] })
    expect(Object.keys(encodeBoardNav(decoded))).not.toContain('codeMap')
  })

  it('stores only flat primitives, as a tab set requires', () => {
    const state = encodeBoardNav({ ...ROOT_BOARD_NAV, stack: [chats], trail: ['a'] })
    for (const value of Object.values(state)) {
      expect(['string', 'boolean', 'number'].includes(typeof value) || value === null).toBe(true)
    }
  })

  it('lands a row saved with a document open (the retired discovery view) on its drill', () => {
    expect(decodeBoardNav({ doc: 'pay', path: 'flow/discovery/discovery_pay_v8.md' })).toEqual(ROOT_BOARD_NAV)
    const saved = { doc: 'pay', feature: 'chats', trail: JSON.stringify(['a']), stack: JSON.stringify([chats]) }
    expect(decodeBoardNav(saved)).toEqual({ ...ROOT_BOARD_NAV, stack: [chats] })
    expect(Object.keys(encodeBoardNav(decodeBoardNav(saved)))).not.toContain('doc')
  })

  it('falls back to the root for anything it cannot read', () => {
    expect(decodeBoardNav({})).toEqual(ROOT_BOARD_NAV)
    expect(decodeBoardNav({ stack: '{not json', trail: '[1,2]', path: 'orphan.md' })).toEqual(ROOT_BOARD_NAV)
    expect(decodeBoardNav({ stack: JSON.stringify([{ id: 'x' }]) }).stack).toEqual([])
  })

  it('tells two places apart', () => {
    expect(sameBoardNav({ ...ROOT_BOARD_NAV, feature: 'a' }, { ...ROOT_BOARD_NAV, feature: 'b' })).toBe(false)
    expect(sameBoardNav(ROOT_BOARD_NAV, { ...ROOT_BOARD_NAV, stack: [chats] })).toBe(false)
  })
})
