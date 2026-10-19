import { boardRoots, boardTagsCards, cardProjectNames, cardProjectTag } from './workspace-board-model'

const membership = new Map<string, string | null>([
  ['/a', 'w'],
  ['/b', 'w'],
  ['/c', null],
])
const workspace = { kind: 'workspace', slug: 'w', name: 'W' } as const

describe('boardRoots', () => {
  it('loads every project of the Workspace, the active one first — and a project in none yet, never hidden', () => {
    expect(boardRoots({ scope: workspace, activeRoot: '/b', registered: ['/a', '/b', '/c'], membership })).toEqual(['/b', '/a', '/c'])
  })
  it('is the active project alone while no Workspace exists yet', () => {
    expect(boardRoots({ scope: { kind: 'none' }, activeRoot: '/c', registered: ['/a', '/b', '/c'], membership })).toEqual(['/c'])
    expect(boardRoots({ scope: { kind: 'none' }, activeRoot: null, registered: ['/a'], membership })).toEqual([])
  })
  it('switching Workspace switches the board', () => {
    const other = new Map<string, string | null>([...membership, ['/c', 'v']])
    expect(boardRoots({ scope: { kind: 'workspace', slug: 'v', name: 'V' }, activeRoot: '/a', registered: ['/a', '/b', '/c'], membership: other })).toEqual(['/c'])
  })
})

describe('card tags', () => {
  it('tags only on a Workspace board', () => {
    expect(boardTagsCards(workspace)).toBe(true)
    expect(boardTagsCards({ kind: 'none' })).toBe(false)
  })
  it('names the card’s project, then its extra projects, once each', () => {
    const names = cardProjectNames({
      projectRoot: '/a',
      extraRoots: ['/b', '/a', '/b'],
      name: (root) => (root === '/a' ? 'Backend' : 'Frontend'),
    })
    expect(names).toEqual(['Backend', 'Frontend'])
    expect(cardProjectTag(names)).toBe('Backend + Frontend')
    expect(cardProjectTag(cardProjectNames({ projectRoot: '/a', extraRoots: undefined, name: () => 'Backend' }))).toBe('Backend')
  })
})
