import {
  afterCommit,
  commitButtonModel,
  commitMenuItems,
  commitPlaceholder,
  commitScope,
  syncSteps,
  type CommitButtonInput,
} from './commit-action'

const base: CommitButtonInput = {
  stagedCount: 0,
  changesCount: 0,
  conflictCount: 0,
  merging: false,
  hasMessage: true,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  detached: false,
  busy: null,
}

describe('commitButtonModel', () => {
  it('reads Commit All with nothing staged, and Commit once something is', () => {
    const all = commitButtonModel({ ...base, changesCount: 3 })
    expect(all).toMatchObject({ action: 'commit-all', label: 'Commit All', disabled: false })
    const staged = commitButtonModel({ ...base, changesCount: 2, stagedCount: 1 })
    expect(staged).toMatchObject({ action: 'commit', label: 'Commit', disabled: false })
  })

  it('needs a message, and says so', () => {
    const model = commitButtonModel({ ...base, stagedCount: 1, hasMessage: false })
    expect(model).toMatchObject({ disabled: true, reason: 'Enter a commit message' })
  })

  it('becomes Sync Changes on a clean tree that is ahead or behind', () => {
    const model = commitButtonModel({ ...base, ahead: 2, behind: 1, hasMessage: false })
    expect(model).toMatchObject({ action: 'sync', label: 'Sync Changes', counts: { behind: 1, ahead: 2 }, disabled: false })
  })

  it('offers to publish a clean branch with no upstream, never on a detached HEAD', () => {
    expect(commitButtonModel({ ...base, hasUpstream: false })).toMatchObject({ action: 'publish', label: 'Publish Branch' })
    expect(commitButtonModel({ ...base, hasUpstream: false, detached: true })).toMatchObject({
      action: 'commit',
      disabled: true,
    })
  })

  it('is an off Commit on a clean tree in sync', () => {
    expect(commitButtonModel(base)).toMatchObject({ action: 'commit', disabled: true, reason: 'There is nothing to commit' })
  })

  it('is Commit Merge during a merge, off until the conflicts are resolved', () => {
    expect(commitButtonModel({ ...base, merging: true, conflictCount: 2 })).toMatchObject({
      action: 'commit-merge',
      label: 'Commit Merge',
      disabled: true,
      reason: 'Resolve the 2 conflicts first',
    })
    expect(commitButtonModel({ ...base, merging: true, conflictCount: 0, stagedCount: 3 })).toMatchObject({
      action: 'commit-merge',
      disabled: false,
    })
  })

  it('is off and says what it is doing while busy', () => {
    const model = commitButtonModel({ ...base, stagedCount: 1, busy: 'commit' })
    expect(model).toMatchObject({ disabled: true, busyLabel: 'Committing…' })
    expect(commitButtonModel({ ...base, ahead: 1, busy: 'sync' }).busyLabel).toBe('Syncing…')
  })
})

describe('commitMenuItems', () => {
  it('lists the six actions in VS Code order, with separators', () => {
    const items = commitMenuItems({ ...base, stagedCount: 1, changesCount: 1 }, true)
    expect(items.map((item) => item.label)).toEqual([
      'Commit',
      'Commit (Amend)',
      'Commit & Push',
      'Commit & Sync',
      'Commit Staged',
      'Commit All',
    ])
    expect(items.filter((item) => item.separator).map((item) => item.action)).toEqual(['commit-push', 'commit-staged'])
    expect(items[0]?.shortcut).toBe('⌘↵')
    expect(items.every((item) => !item.disabled)).toBe(true)
  })

  it('turns off Commit Staged with nothing staged, and everything without a message', () => {
    const items = commitMenuItems({ ...base, changesCount: 1 }, false)
    expect(items.find((item) => item.action === 'commit-staged')?.disabled).toBe(true)
    expect(items.find((item) => item.action === 'commit-all')?.disabled).toBe(false)
    expect(items[0]?.shortcut).toBe('Ctrl+Enter')
    expect(commitMenuItems({ ...base, changesCount: 1, hasMessage: false }, true).every((item) => item.disabled)).toBe(true)
  })
})

describe('scope, follow-up and wording', () => {
  it('commits everything only when asked or when nothing is staged', () => {
    expect(commitScope('commit', 0)).toBe('all')
    expect(commitScope('commit', 2)).toBe('index')
    expect(commitScope('commit-all', 2)).toBe('all')
    expect(commitScope('commit-staged', 0)).toBe('index')
    expect(commitScope('amend', 0)).toBe('index')
    expect(afterCommit('commit-push')).toBe('push')
    expect(afterCommit('commit-sync')).toBe('sync')
    expect(afterCommit('commit')).toBe('none')
  })

  it('names the branch in the placeholder', () => {
    expect(commitPlaceholder({ branch: 'main', detached: false, mac: true })).toBe("Message (⌘Enter to commit on 'main')")
    expect(commitPlaceholder({ branch: '', detached: true, mac: false })).toBe('Message (Ctrl+Enter to commit on a detached HEAD)')
    expect(commitPlaceholder({ branch: 'main', detached: false, mac: true, mergeMessage: "Merge branch 'x'" })).toBe(
      "Merge branch 'x'",
    )
  })

  it('pulls only when behind and publishes only when ahead', () => {
    expect(syncSteps(1, 2)).toEqual(['pull', 'publish'])
    expect(syncSteps(0, 2)).toEqual(['publish'])
    expect(syncSteps(3, 0)).toEqual(['pull'])
    expect(syncSteps(0, 0)).toEqual([])
  })
})
