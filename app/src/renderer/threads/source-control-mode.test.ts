import type { GitMergeState } from '../../shared/ipc-contract'
import {
  isConflicted,
  nextRequest,
  sourceControlTab,
  type SourceControlRequest,
} from './source-control-mode'

function merge(over: Partial<GitMergeState> = {}): GitMergeState {
  return { op: 'none', unmergedPaths: [], ...over } as GitMergeState
}

describe('whether a repository is actually stopped on a conflict', () => {
  it('is not, when nothing is going on', () => {
    expect(isConflicted(merge())).toBe(false)
  })

  it('is not, when there is no repository to ask about', () => {
    expect(isConflicted(null)).toBe(false)
  })

  it('is, when an operation has left files unmerged', () => {
    expect(isConflicted(merge({ op: 'merge', unmergedPaths: ['a.ts'] }))).toBe(true)
  })

  it('is NOT, for a merge that is going fine', () => {
    // An operation in progress with nothing unmerged is success in motion.
    // Shouting "Conflicts" at it is how a tab teaches people to ignore it.
    expect(isConflicted(merge({ op: 'merge', unmergedPaths: [] }))).toBe(false)
  })

  it('is, when kept work clashed after a pull finished its merge', () => {
    // A non-repository is `op: 'none'` with nothing unmerged, and stays out…
    expect(isConflicted(merge({ op: 'none', unmergedPaths: [] }))).toBe(false)
    // …while an autostash re-apply that clashed is `op: 'none'` WITH paths.
    expect(isConflicted(merge({ op: 'none', unmergedPaths: ['f.txt'] }))).toBe(true)
    expect(sourceControlTab(merge({ op: 'none', unmergedPaths: ['f.txt'] }))).toEqual({
      mode: 'conflicts',
      label: 'Conflicts',
    })
  })

  it.each(['rebase', 'cherry-pick', 'stash'] as const)('covers %s too', (op) => {
    expect(isConflicted(merge({ op, unmergedPaths: ['a.ts'] }))).toBe(true)
  })
})

describe('the tab names itself', () => {
  it('is Changes by default', () => {
    expect(sourceControlTab(merge())).toEqual({ mode: 'changes', label: 'Changes' })
  })

  it('is History when that is what was asked for', () => {
    expect(sourceControlTab(merge(), 'history')).toEqual({ mode: 'history', label: 'History' })
  })

  it('is Conflicts when the repository is stopped on one', () => {
    const tab = sourceControlTab(merge({ op: 'merge', unmergedPaths: ['a.ts'] }))
    expect(tab).toEqual({ mode: 'conflicts', label: 'Conflicts' })
  })

  it('lets a conflict win over what the reader was looking at', () => {
    // The positive first (allowed-pattern #28): History IS reachable here…
    expect(sourceControlTab(merge(), 'history').mode).toBe('history')
    // …and a conflict still takes the tab.
    const tab = sourceControlTab(merge({ op: 'merge', unmergedPaths: ['a.ts'] }), 'history')
    expect(tab.mode).toBe('conflicts')
  })

  it('never returns a label that disagrees with its mode', () => {
    const cases: Array<[GitMergeState, SourceControlRequest]> = [
      [merge(), 'changes'],
      [merge(), 'history'],
      [merge({ op: 'merge', unmergedPaths: ['a.ts'] }), 'changes'],
      [merge({ op: 'rebase', unmergedPaths: ['b.ts'] }), 'history'],
    ]
    const expected = { changes: 'Changes', conflicts: 'Conflicts', history: 'History' }
    for (const [state, requested] of cases) {
      const tab = sourceControlTab(state, requested)
      expect(tab.label).toBe(expected[tab.mode])
    }
  })
})

describe('what the reader is left asking for', () => {
  it('remembers History through a conflict and gives it back when it resolves', () => {
    const conflicted = merge({ op: 'merge', unmergedPaths: ['a.ts'] })
    // Reader is in History; a conflict seizes the tab.
    expect(sourceControlTab(conflicted, 'history').mode).toBe('conflicts')
    // The seizure is never recorded as a request…
    const still = nextRequest('history', 'conflicts')
    expect(still).toBe('history')
    // …so resolving puts them back where they were, not in Changes.
    expect(sourceControlTab(merge(), still).mode).toBe('history')
  })

  it('records an actual choice', () => {
    expect(nextRequest('changes', 'history')).toBe('history')
    expect(nextRequest('history', 'changes')).toBe('changes')
  })
})
