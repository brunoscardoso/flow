import { closeTargets, enabledOps } from './tab-close-ops'

const tabs = [
  { id: 'a', closable: true },
  { id: 'b', closable: true },
  { id: 'c', closable: false }, // pinned/non-closable — never targeted
  { id: 'd', closable: true },
  { id: 'e', closable: true },
]

describe('closeTargets (#735)', () => {
  it('close → just the target (when closable)', () => {
    expect(closeTargets(tabs, 'b', 'close')).toEqual(['b'])
    expect(closeTargets(tabs, 'c', 'close')).toEqual([])
  })

  it('others → every closable tab except the target', () => {
    expect(closeTargets(tabs, 'b', 'others')).toEqual(['a', 'd', 'e'])
  })

  it('left → closable tabs strictly before the target, in order', () => {
    expect(closeTargets(tabs, 'd', 'left')).toEqual(['a', 'b'])
    expect(closeTargets(tabs, 'a', 'left')).toEqual([])
  })

  it('right → closable tabs strictly after the target, in order', () => {
    expect(closeTargets(tabs, 'b', 'right')).toEqual(['d', 'e'])
    expect(closeTargets(tabs, 'e', 'right')).toEqual([])
  })

  it('all → every closable tab including the target', () => {
    expect(closeTargets(tabs, 'b', 'all')).toEqual(['a', 'b', 'd', 'e'])
  })

  it('unknown target (strip re-rendered) → nothing', () => {
    expect(closeTargets(tabs, 'zombie', 'all')).toEqual([])
  })
})

describe('enabledOps (#735)', () => {
  it('edges disable their empty directions', () => {
    expect(enabledOps(tabs, 'a').has('left')).toBe(false)
    expect(enabledOps(tabs, 'a').has('right')).toBe(true)
    expect(enabledOps(tabs, 'e').has('right')).toBe(false)
  })

  it('a lone closable tab enables only close/all', () => {
    const lone = [{ id: 'x', closable: true }]
    const ops = enabledOps(lone, 'x')
    expect([...ops].sort()).toEqual(['all', 'close'])
  })
})
