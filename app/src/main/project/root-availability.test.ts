import { partitionByAvailability } from './root-availability'
import type { RegisteredProject } from '../../shared/ipc-contract'

const root = (rootPath: string): RegisteredProject => ({
  id: rootPath,
  windowId: 'w1',
  rootPath,
  position: 0,
  addedAt: '2026-07-14T00:00:00Z',
})

describe('partitionByAvailability (#263)', () => {
  it('splits reachable from unreachable and stamps the available flag', () => {
    const reachable = new Set(['/mounted'])
    const { available, unavailable } = partitionByAvailability(
      [root('/mounted'), root('/unmounted')],
      (p) => reachable.has(p),
    )
    expect(available).toEqual([{ ...root('/mounted'), available: true }])
    expect(unavailable).toEqual([{ ...root('/unmounted'), available: false }])
  })

  it('marks every root available when all are reachable', () => {
    const { available, unavailable } = partitionByAvailability(
      [root('/a'), root('/b')],
      () => true,
    )
    expect(available.map((r) => r.available)).toEqual([true, true])
    expect(unavailable).toEqual([])
  })

  it('marks every root unavailable when none are reachable (all drives unmounted)', () => {
    const { available, unavailable } = partitionByAvailability([root('/a')], () => false)
    expect(available).toEqual([])
    expect(unavailable).toEqual([{ ...root('/a'), available: false }])
  })

  it('does not mutate the input roots', () => {
    const input = root('/a')
    partitionByAvailability([input], () => false)
    expect(input.available).toBeUndefined()
  })
})
