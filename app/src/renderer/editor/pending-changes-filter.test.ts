import type { PendingFileChange } from '../../shared/ipc-contract'
import { filterByActiveThread } from './pending-changes-filter'

const change = (threadId: string, filePath: string): PendingFileChange => ({
  rootId: '/proj',
  filePath,
  threadId,
  hunks: [],
})

describe('filterByActiveThread', () => {
  const all = [
    change('t1', 'a.ts'),
    change('t2', 'b.ts'),
    change('t1', 'c.ts'),
    change('t3', 'flow/notes.md'),
  ]

  it('keeps only the active thread’s changes', () => {
    expect(filterByActiveThread(all, 't1').map((c) => c.filePath)).toEqual(['a.ts', 'c.ts'])
    expect(filterByActiveThread(all, 't2').map((c) => c.filePath)).toEqual(['b.ts'])
  })

  it('returns empty when no thread is active (nothing to review out of context)', () => {
    expect(filterByActiveThread(all, null)).toEqual([])
  })

  it('returns empty when the active thread has no changes', () => {
    expect(filterByActiveThread(all, 'unknown-thread')).toEqual([])
  })

  it('does not mutate the input', () => {
    const snapshot = [...all]
    filterByActiveThread(all, 't1')
    expect(all).toEqual(snapshot)
  })
})
