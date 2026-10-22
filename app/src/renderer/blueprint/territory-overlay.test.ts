import { territoryFlowHops, territoryOverlayFor, type OverlaySheet } from './territory-overlay'
import type { TerritoryCell, TerritoryGroup } from './territory-view'

function cell(id: string, rect: { x: number; y: number; w: number; h: number }): TerritoryCell {
  return {
    id,
    kind: 'feature',
    name: id,
    understanding: 'none',
    active: false,
    secondLine: null,
    links: 0,
    summary: null,
    description: null,
    path: null,
    folders: null,
    hasControl: true,
    controlTitle: null,
    stale: false,
    role: null,
    roleSource: null,
    showRoleIcon: false,
    labelClass: '',
    roomy: true,
    rect,
    lit: false,
    dim: false,
  }
}

function group(id: string, cellIds: string[]): TerritoryGroup {
  return {
    id,
    label: id,
    summary: '',
    rect: { x: 0, y: 0, w: 100, h: 100 },
    inner: { x: 0, y: 12, w: 100, h: 88 },
    cellIds,
    lit: false,
    dim: false,
  }
}

const SHEET: OverlaySheet = {
  cells: [
    cell('feature:chats', { x: 0, y: 0, w: 100, h: 50 }),
    cell('feature:board', { x: 100, y: 0, w: 60, h: 50 }),
    cell('feature:threads', { x: 0, y: 50, w: 160, h: 30 }),
  ],
  groups: [group('domain:Conversation', ['feature:chats', 'feature:threads'])],
}

describe('territoryOverlayFor', () => {
  it('lights the ids the sheet draws, and dims the rest', () => {
    expect(territoryOverlayFor(SHEET, ['feature:chats'])).toEqual({
      lit: ['feature:chats'],
      dimOthers: true,
    })
  })

  /**
   * RULE 1. A story anchored to file paths, or a changeset of module ids, names
   * nothing on a sheet of FEATURES — and a sheet with every cell dim and none
   * lit says "the answer is nowhere", which is not what the overlay claimed.
   */
  it('decorates NOTHING when it recognises none of the ids', () => {
    expect(territoryOverlayFor(SHEET, ['app/src/main/index.ts', 'module:app/src'])).toBeNull()
    expect(territoryOverlayFor(SHEET, [])).toBeNull()
  })

  it('a country the overlay named is part of the answer', () => {
    expect(territoryOverlayFor(SHEET, ['domain:Conversation'])).toEqual({
      lit: ['domain:Conversation'],
      dimOthers: true,
    })
  })

  it('keeps drawn order — cells first, then groups — whatever order it was asked in', () => {
    const overlay = territoryOverlayFor(SHEET, [
      'domain:Conversation',
      'feature:threads',
      'feature:chats',
    ])
    expect(overlay?.lit).toEqual(['feature:chats', 'feature:threads', 'domain:Conversation'])
  })

  it('ignores ids one depth away without discarding the ones that are here', () => {
    const overlay = territoryOverlayFor(SHEET, ['feature:board', 'feature:chats/some-part'])
    expect(overlay).toEqual({ lit: ['feature:board'], dimOthers: true })
  })

  it('never names the same id twice', () => {
    const overlay = territoryOverlayFor(SHEET, ['feature:chats', 'feature:chats'])
    expect(overlay?.lit).toEqual(['feature:chats'])
  })
})

describe('territoryFlowHops', () => {
  it('joins cell centres in the narrated order', () => {
    expect(territoryFlowHops(SHEET, ['feature:chats', 'feature:board'])).toEqual([
      { x: 50, y: 25 },
      { x: 130, y: 25 },
    ])
  })

  /**
   * RULE 2. A numbered path that silently skips a hop tells the reader the flow
   * goes 1 → 2 → 4 — a different story from the one that was narrated.
   */
  it('refuses the whole path when ONE hop is off the sheet', () => {
    expect(territoryFlowHops(SHEET, ['feature:chats', 'feature:gone'])).toBeNull()
  })

  it('draws nothing for no flow, or a flow of one', () => {
    expect(territoryFlowHops(SHEET, null)).toBeNull()
    expect(territoryFlowHops(SHEET, ['feature:chats'])).toBeNull()
  })

  it('collapses a repeated hop — two numbered discs on one centre is a drawing bug', () => {
    expect(
      territoryFlowHops(SHEET, ['feature:chats', 'feature:chats', 'feature:board']),
    ).toEqual([
      { x: 50, y: 25 },
      { x: 130, y: 25 },
    ])
  })

  it('a path that collapses to a single hop is not a path', () => {
    expect(territoryFlowHops(SHEET, ['feature:chats', 'feature:chats'])).toBeNull()
  })

  // A GROUP IS NOT A HOP. Countries are ground; a flow steps through the things
  // standing on it, and taking a country's centre would put a numbered disc in
  // the middle of a region rather than on a province.
  it('does not step through a country', () => {
    expect(territoryFlowHops(SHEET, ['feature:chats', 'domain:Conversation'])).toBeNull()
  })
})
