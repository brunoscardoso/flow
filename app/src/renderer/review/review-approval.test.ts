import type { ReviewFile } from '../../shared/ipc-contract'
import {
  allFilesApproved,
  approvedFilePaths,
  commitButtonState,
  commitPaths,
  effectiveGroupApprovals,
  pathsClaimedBySeveralGroups,
  reconcileInGroupApprovals,
} from './review-approval'

const files = ['a.ts', 'b.ts', 'c.ts']

describe('approvedFilePaths (#857, #1052)', () => {
  const file = (over: Partial<ReviewFile>): ReviewFile => ({
    filePath: 'a.ts',
    state: 'modified',
    staged: false,
    ...over,
  })

  it('derives approval from staged-ness', () => {
    expect(
      approvedFilePaths([
        file({ filePath: 'a.ts', staged: true }),
        file({ filePath: 'b.ts', staged: false }),
      ]),
    ).toEqual(new Set(['a.ts']))
  })

  it('excludes a staged file rewritten since approval — the ✓ must downgrade (#1052)', () => {
    expect(
      approvedFilePaths([
        file({ filePath: 'a.ts', staged: true, unreviewedSinceApproval: true }),
        file({ filePath: 'b.ts', staged: true }),
      ]),
    ).toEqual(new Set(['b.ts']))
  })
})

describe('pathsClaimedBySeveralGroups (#1432)', () => {
  const file = (filePath: string): ReviewFile => ({ filePath, state: 'modified', staged: false })

  it('finds only the paths listed under more than one group', () => {
    expect(
      pathsClaimedBySeveralGroups([
        { files: [file('shared.ts'), file('a1.ts')] },
        { files: [file('shared.ts')] },
        { files: [file('loose.ts')] },
      ]),
    ).toEqual(new Set(['shared.ts']))
  })

  it('is empty when every file has one home', () => {
    expect(
      pathsClaimedBySeveralGroups([{ files: [file('a.ts')] }, { files: [file('b.ts')] }]),
    ).toEqual(new Set())
  })
})

describe('effectiveGroupApprovals (#1432)', () => {
  it('a singly-claimed staged file keeps #857: staged means approved, no click needed', () => {
    // e.g. a rename staged by `git mv`, or a file staged from Source Control.
    expect(effectiveGroupApprovals(new Set(), new Set(['widget.ts']), new Set())).toEqual(
      new Set(['widget.ts']),
    )
  })

  it('a multi-group staged file arrives unapproved — a sibling phase’s ✓ satisfies no gate here', () => {
    expect(
      effectiveGroupApprovals(new Set(), new Set(['shared.ts']), new Set(['shared.ts'])),
    ).toEqual(new Set())
  })

  it('a multi-group file counts once THIS group approved it (and staging still backs it)', () => {
    expect(
      effectiveGroupApprovals(new Set(['shared.ts']), new Set(['shared.ts']), new Set(['shared.ts'])),
    ).toEqual(new Set(['shared.ts']))
  })

  it('staged-ness stays authoritative in the negative direction — unstaged (#857) or rewritten (#1052)', () => {
    // `staged` already excludes unreviewedSinceApproval files, so both exits
    // funnel through the same check: no staging backing, no approval.
    expect(
      effectiveGroupApprovals(new Set(['shared.ts']), new Set(), new Set(['shared.ts'])),
    ).toEqual(new Set())
  })
})

describe('reconcileInGroupApprovals (#1432)', () => {
  it('keeps approvals whose files the listing still shows', () => {
    expect(
      reconcileInGroupApprovals(new Set(['a.ts']), new Set(['a.ts', 'b.ts'])),
    ).toEqual(new Set(['a.ts']))
  })

  it('drops an approval whose file left the listing — its review lifecycle ended', () => {
    expect(reconcileInGroupApprovals(new Set(['gone.ts']), new Set(['a.ts']))).toEqual(new Set())
  })

  it('carries a rolled-up directory approval to the staged paths that replace it (#176)', () => {
    // "Approve all" staged the untracked dir `loops/`; the next listing swaps
    // the single `loops/` entry for the concrete staged files beneath it.
    expect(
      reconcileInGroupApprovals(
        new Set(['loops/', 'loose.ts']),
        new Set(['loops/find.md', 'loops/fix.md', 'loose.ts']),
      ),
    ).toEqual(new Set(['loops/find.md', 'loops/fix.md', 'loose.ts']))
  })

  it('does not treat a plain file entry as a directory prefix', () => {
    expect(
      reconcileInGroupApprovals(new Set(['loops']), new Set(['loops/find.md'])),
    ).toEqual(new Set())
  })
})

describe('commitPaths (#176)', () => {
  it('KEEPS trailing-slash directory entries so new dirs commit (not a no-op)', () => {
    // A wholly-new untracked directory is one `newfeature/` entry — dropping it
    // made a directory-only group a silent no-op.
    expect(commitPaths(['newfeature/'])).toEqual(['newfeature/'])
  })
  it('keeps directory entries alongside files in a mixed group', () => {
    expect(commitPaths(['app/src/api.ts', 'newfeature/'])).toEqual(['app/src/api.ts', 'newfeature/'])
  })
  it('drops blank/whitespace entries so the emptiness guard stays real', () => {
    expect(commitPaths(['', '   ', 'a.ts'])).toEqual(['a.ts'])
    expect(commitPaths([])).toEqual([])
  })
})

describe('allFilesApproved', () => {
  it('is true only when every file is approved', () => {
    expect(allFilesApproved(files, new Set(files))).toBe(true)
    expect(allFilesApproved(files, new Set(['a.ts', 'b.ts']))).toBe(false)
  })
  it('is false for an empty group', () => {
    expect(allFilesApproved([], new Set())).toBe(false)
  })
})

describe('commitButtonState', () => {
  it('offers "Approve all" (enabled) while files remain unapproved', () => {
    expect(commitButtonState(files, new Set(['a.ts']), '')).toEqual({
      label: 'Approve all (1/3)',
      disabled: false,
      action: 'approve-all',
    })
  })

  it('is "Approve all" and clickable even with zero approved (the #50 fix)', () => {
    const state = commitButtonState(files, new Set(), 'my message')
    expect(state.action).toBe('approve-all')
    expect(state.disabled).toBe(false)
    expect(state.label).toBe('Approve all (0/3)')
  })

  it('becomes "Commit phase" once all are approved, disabled without a message', () => {
    expect(commitButtonState(files, new Set(files), '   ')).toEqual({
      label: 'Commit phase',
      disabled: true,
      action: 'none',
    })
  })

  it('commits when all approved and a message is present', () => {
    expect(commitButtonState(files, new Set(files), 'feat: x')).toEqual({
      label: 'Commit phase',
      disabled: false,
      action: 'commit',
    })
  })

  it('counts only approved files that belong to the group', () => {
    expect(commitButtonState(files, new Set(['a.ts', 'stale.ts']), '').label).toBe(
      'Approve all (1/3)',
    )
  })
})

describe('commitButtonState with unresolved conflicts (#986)', () => {
  it('a conflicted-only group is never approvable — it demands resolution', () => {
    expect(commitButtonState(['app.ts'], new Set(), 'feat: x', new Set(['app.ts']))).toEqual({
      label: 'Resolve 1 conflict first',
      disabled: false,
      action: 'resolve-conflicts',
    })
  })

  it('excludes conflicted files from the Approve all count', () => {
    const state = commitButtonState(files, new Set(['a.ts']), '', new Set(['c.ts']))
    expect(state).toEqual({ label: 'Approve all (1/2)', disabled: false, action: 'approve-all' })
  })

  it('blocks the commit once approvable files are approved but conflicts remain', () => {
    const state = commitButtonState(files, new Set(['a.ts', 'b.ts']), 'feat: x', new Set(['c.ts']))
    expect(state).toEqual({
      label: 'Resolve 1 conflict first',
      disabled: false,
      action: 'resolve-conflicts',
    })
  })

  it('pluralizes multiple conflicts', () => {
    const state = commitButtonState(files, new Set(['a.ts']), '', new Set(['b.ts', 'c.ts']))
    expect(state.label).toBe('Resolve 2 conflicts first')
    expect(state.action).toBe('resolve-conflicts')
  })

  it('behaves exactly as before when nothing is conflicted (default arg)', () => {
    expect(commitButtonState(files, new Set(files), 'feat: x')).toEqual({
      label: 'Commit phase',
      disabled: false,
      action: 'commit',
    })
  })
})
