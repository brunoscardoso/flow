import {
  availableRoots,
  firstAvailableRoot,
  hasAvailableRoot,
  nextActiveRootAfterRemove,
} from './root-availability-select'
import type { RegisteredProject } from '../../shared/ipc-contract'

const root = (rootPath: string, available?: boolean): RegisteredProject => ({
  id: rootPath,
  windowId: 'w1',
  rootPath,
  position: 0,
  addedAt: '2026-07-14T00:00:00Z',
  ...(available === undefined ? {} : { available }),
})

describe('root-availability-select (#350)', () => {
  it('availableRoots filters out unavailable roots (absent flag = available)', () => {
    const roots = [root('/a'), root('/b', false), root('/c', true)]
    expect(availableRoots(roots).map((r) => r.rootPath)).toEqual(['/a', '/c'])
  })

  it('firstAvailableRoot skips a leading unavailable root', () => {
    expect(firstAvailableRoot([root('/gone', false), root('/here')])).toBe('/here')
  })

  it('firstAvailableRoot is null when every root is unavailable', () => {
    expect(firstAvailableRoot([root('/gone', false)])).toBeNull()
  })

  it('hasAvailableRoot reflects whether any root is reachable', () => {
    expect(hasAvailableRoot([root('/a')])).toBe(true)
    expect(hasAvailableRoot([root('/gone', false)])).toBe(false)
    expect(hasAvailableRoot([])).toBe(false)
  })

  it('nextActiveRootAfterRemove picks the first available root that is not the removed one', () => {
    const roots = [root('/active'), root('/gone', false), root('/sibling')]
    expect(nextActiveRootAfterRemove(roots, '/active')).toBe('/sibling')
  })

  it('nextActiveRootAfterRemove returns null rather than an unavailable sibling', () => {
    const roots = [root('/active'), root('/gone', false)]
    expect(nextActiveRootAfterRemove(roots, '/active')).toBeNull()
  })
})
