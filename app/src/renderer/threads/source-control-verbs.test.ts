import type { GitMergeState } from '../../shared/ipc-contract'
import { completeMergeMessage, headerVerbs } from './source-control-verbs'

function merge(over: Partial<GitMergeState> = {}): GitMergeState {
  return { op: 'none', unmergedPaths: [], ...over } as GitMergeState
}

const ids = (verbs: ReturnType<typeof headerVerbs>): string[] => verbs.map((v) => v.id)

describe('the four capabilities that have only one door today', () => {
  // C1, verified: pull, merge branch, complete merge and abort merge have no
  // caller outside the Git panel. Each must arrive somewhere before it goes.
  it('rehouses all four across the modes', () => {
    const inChanges = ids(headerVerbs('changes', merge()))
    const inConflicts = ids(headerVerbs('conflicts', merge({ op: 'merge', unmergedPaths: ['a'] })))
    expect([...inChanges, ...inConflicts].sort()).toEqual([
      'abort-merge',
      'complete-merge',
      'merge-branch',
      'pull',
    ])
  })
})

describe('Changes mode', () => {
  it('offers the two that bring work in', () => {
    expect(ids(headerVerbs('changes', merge()))).toEqual(['pull', 'merge-branch'])
    expect(headerVerbs('changes', merge()).every((v) => v.enabled)).toBe(true)
  })

  it('blocks both while a merge is still in progress, and says why', () => {
    const verbs = headerVerbs('changes', merge({ op: 'merge', unmergedPaths: [] }))
    expect(ids(verbs)).toEqual(['pull', 'merge-branch'])
    expect(verbs.every((v) => !v.enabled)).toBe(true)
    expect(verbs[0].reason).toContain('Finish the merge')
  })
})

describe('Conflicts mode', () => {
  const conflicted = merge({ op: 'merge', unmergedPaths: ['a.ts', 'b.ts'] })

  it('offers the two that end the operation', () => {
    expect(ids(headerVerbs('conflicts', conflicted))).toEqual(['complete-merge', 'abort-merge'])
  })

  it('shows Complete but blocks it while anything is unresolved', () => {
    const verbs = headerVerbs('conflicts', conflicted)
    const complete = verbs.find((v) => v.id === 'complete-merge')
    // PRESENT, not hidden: it is what the reader is working toward, and hiding
    // it makes the mode look like it has no exit.
    expect(complete?.enabled).toBe(false)
    expect(complete?.reason).toContain('2 files')
  })

  it('counts one conflict in the singular', () => {
    const verbs = headerVerbs('conflicts', merge({ op: 'merge', unmergedPaths: ['a.ts'] }))
    expect(verbs.find((v) => v.id === 'complete-merge')?.reason).toContain('One file')
  })

  it('enables Complete once everything is resolved', () => {
    const verbs = headerVerbs('conflicts', merge({ op: 'merge', unmergedPaths: [] }))
    expect(verbs.find((v) => v.id === 'complete-merge')?.enabled).toBe(true)
  })

  it('always allows Abort — it is the way out', () => {
    expect(headerVerbs('conflicts', conflicted).find((v) => v.id === 'abort-merge')?.enabled).toBe(
      true,
    )
  })

  it('names Continue rebase rather than Complete merge during a rebase', () => {
    const verbs = headerVerbs('conflicts', merge({ op: 'rebase', unmergedPaths: [] }))
    expect(verbs.find((v) => v.id === 'complete-merge')?.label).toBe('Continue rebase')
  })

  // The inherited refusal that matters: offering merge's buttons mid-cherry-pick
  // would run `git merge --abort` on a cherry-pick. deriveMergeBanner already
  // refuses this, and calling it rather than copying it is how that stays true.
  it.each(['cherry-pick', 'stash'] as const)('offers nothing during a %s', (op) => {
    expect(headerVerbs('conflicts', merge({ op, unmergedPaths: ['a.ts'] }))).toEqual([])
  })
})

describe('History mode', () => {
  it('offers no verbs at all', () => {
    // The positive first (allowed-pattern #28): these modes DO carry verbs…
    expect(headerVerbs('changes', merge()).length).toBeGreaterThan(0)
    expect(headerVerbs('conflicts', merge({ op: 'merge', unmergedPaths: [] })).length)
      .toBeGreaterThan(0)
    // …and History carries none, in every merge state.
    expect(headerVerbs('history', merge())).toEqual([])
    expect(headerVerbs('history', merge({ op: 'merge', unmergedPaths: ['a.ts'] }))).toEqual([])
  })
})

describe('the message a completed merge carries', () => {
  it('is the prepared one when git has it', () => {
    expect(completeMergeMessage(merge({ op: 'merge', mergeMsg: 'Merge branch x' }))).toBe(
      'Merge branch x',
    )
  })

  it('is empty rather than invented when there is none', () => {
    expect(completeMergeMessage(merge({ op: 'merge' }))).toBe('')
    expect(completeMergeMessage(null)).toBe('')
  })
})

describe('every reason reads as a sentence', () => {
  it('names no command, path or config key (forbidden-pattern #12)', () => {
    const states = [
      merge(),
      merge({ op: 'merge', unmergedPaths: [] }),
      merge({ op: 'merge', unmergedPaths: ['a.ts'] }),
      merge({ op: 'rebase', unmergedPaths: ['a.ts'] }),
    ]
    for (const state of states) {
      for (const mode of ['changes', 'conflicts', 'history'] as const) {
        for (const verb of headerVerbs(mode, state)) {
          if (verb.reason === null) continue
          expect(verb.reason).not.toMatch(/git |planflow-ai|`|--|\.flowconfig/)
        }
      }
    }
  })
})
