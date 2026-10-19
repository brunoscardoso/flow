import type { SideIdentity } from '../../shared/side-identity'
import {
  bulkActions,
  fileActions,
  isMergeBulkAction,
  mergeBulkChoice,
  mergeBulkControl,
  mergeLegend,
  selectionMenuItems,
} from './source-control-actions'

describe('fileActions (#335)', () => {
  it('a staged row can be unstaged + diffed', () => {
    expect(fileActions('staged')).toEqual(['unstage', 'open-diff'])
  })

  it('a working-tree row can be staged, discarded + diffed', () => {
    expect(fileActions('changes')).toEqual(['stage', 'discard', 'open-diff'])
  })

  it('a conflicted row offers per-side accept + merge editor + diff — no direct stage/discard (merge-conflict-resolution)', () => {
    expect(fileActions('merge')).toEqual(['use-ours', 'use-theirs', 'open-merge', 'open-diff'])
    expect(fileActions('merge')).not.toContain('stage')
    expect(fileActions('merge')).not.toContain('discard')
  })
})

describe('bulkActions (#335 + Phase 5 Task 3)', () => {
  it('Changes offers approve-all + revert-all, Staged offers unstage-all', () => {
    expect(bulkActions('changes')).toEqual(['stage-all', 'discard-all'])
    expect(bulkActions('staged')).toEqual(['unstage-all'])
  })
  it('Merge offers the three keep-all conflict actions (was [] before Phase 5)', () => {
    expect(bulkActions('merge')).toEqual(['keep-all-ours', 'keep-all-theirs', 'keep-all-both'])
  })
})

describe('selectionMenuItems (#SCMS FR-5)', () => {
  it('Changes offers Stage + Discard Selected, count-aware', () => {
    expect(selectionMenuItems('changes', 3)).toEqual([
      { action: 'stage-selected', label: 'Stage Selected (3)' },
      { action: 'discard-selected', label: 'Discard Selected (3)' },
    ])
  })
  it('Staged offers Unstage Selected, count-aware', () => {
    expect(selectionMenuItems('staged', 2)).toEqual([
      { action: 'unstage-selected', label: 'Unstage Selected (2)' },
    ])
  })
  it('Merge offers no selection actions — conflicts resolve per-side (FR-11)', () => {
    expect(selectionMenuItems('merge', 4)).toEqual([])
  })
  it('returns nothing when the selection is empty (menu falls back to Reveal only)', () => {
    expect(selectionMenuItems('changes', 0)).toEqual([])
    expect(selectionMenuItems('staged', 0)).toEqual([])
  })
  it('reflects the exact count in the label (1)', () => {
    expect(selectionMenuItems('changes', 1)).toEqual([
      { action: 'stage-selected', label: 'Stage Selected (1)' },
      { action: 'discard-selected', label: 'Discard Selected (1)' },
    ])
  })
})

describe('merge bulk action mapping (Phase 5 Task 3)', () => {
  it('classifies only the keep-all actions as merge bulk actions', () => {
    expect(isMergeBulkAction('keep-all-ours')).toBe(true)
    expect(isMergeBulkAction('keep-all-theirs')).toBe(true)
    expect(isMergeBulkAction('keep-all-both')).toBe(true)
    expect(isMergeBulkAction('stage-all')).toBe(false)
    expect(isMergeBulkAction('unstage-all')).toBe(false)
  })
  it('maps each keep-all action to its hunk choice', () => {
    expect(mergeBulkChoice('keep-all-ours')).toBe('ours')
    expect(mergeBulkChoice('keep-all-theirs')).toBe('theirs')
    expect(mergeBulkChoice('keep-all-both')).toBe('both')
  })
})

describe('mergeBulkControl — fixed labels, because a branch name has no width limit', () => {
  const ours: SideIdentity = { kind: 'ours', ref: 'HEAD', branch: 'main', isCurrentUser: true }
  const theirs: SideIdentity = { kind: 'theirs', ref: 'MERGE_HEAD', branch: 'feature', isCurrentUser: false }
  const LONG = 'ACME-2446-rework-the-session-cache-for-the-new-router'
  const longTheirs: SideIdentity = { kind: 'theirs', ref: 'MERGE_HEAD', branch: LONG, isCurrentUser: false }

  it('names the role, never the branch and never a stage word', () => {
    expect(mergeBulkControl('keep-all-ours', ours, theirs).text).toBe('Use current')
    expect(mergeBulkControl('keep-all-theirs', ours, theirs).text).toBe('Use incoming')
    expect(mergeBulkControl('keep-all-both', ours, theirs).text).toBe('Keep both')
    for (const action of ['keep-all-ours', 'keep-all-theirs', 'keep-all-both'] as const) {
      const text = mergeBulkControl(action, ours, longTheirs).text.toLowerCase()
      expect(text).not.toContain('ours')
      expect(text).not.toContain('theirs')
      expect(text).not.toContain('main')
      expect(text).not.toContain('acme-2446')
    }
  })

  it('has a width the repository cannot change — the whole bug in one assertion', () => {
    // Before the fix the label carried the branch, so a 500px sidebar clipped it
    // to "Keep all from both (ACME-2446-rework-the-session-cac…" — the branch name alone is 53 characters.
    for (const action of ['keep-all-ours', 'keep-all-theirs', 'keep-all-both'] as const) {
      const short = mergeBulkControl(action, ours, theirs).text
      const long = mergeBulkControl(action, ours, longTheirs).text
      expect(long).toBe(short)
      expect(long.length).toBeLessThanOrEqual(12)
    }
  })

  it('keeps the real names in the title and in the destructive confirm', () => {
    const control = mergeBulkControl('keep-all-theirs', ours, longTheirs)
    expect(control.title).toContain(LONG)
    // A modal has the room a 500px button does not, and this one is irreversible.
    expect(control.confirmLabel).toBe(`Keep ${LONG}`)
    expect(mergeBulkControl('keep-all-both', ours, theirs).confirmLabel).toBe(
      'Keep both main and feature',
    )
  })

  it('falls back to neutral Side A/B in the title when identity is absent', () => {
    expect(mergeBulkControl('keep-all-ours').title).toContain('Side A')
    expect(mergeBulkControl('keep-all-theirs').title).toContain('Side B')
    // …and the button still reads the same.
    expect(mergeBulkControl('keep-all-ours').text).toBe('Use current')
  })
})

describe('mergeLegend — identity appears exactly once, as a caption', () => {
  const ours: SideIdentity = { kind: 'ours', ref: 'HEAD', branch: 'main', isCurrentUser: true }
  const theirs: SideIdentity = { kind: 'theirs', ref: 'MERGE_HEAD', branch: 'feature', isCurrentUser: false }

  it('binds each role word to the branch every control means by it', () => {
    const [current, incoming] = mergeLegend(ours, theirs)
    expect(current.role).toBe('current')
    expect(current.branch).toBe('main')
    expect(incoming.role).toBe('incoming')
    expect(incoming.branch).toBe('feature')
  })

  it('carries the untruncated name in the title, because the chip may ellipsize', () => {
    const LONG = 'ACME-2446-rework-the-session-cache-for-the-new-router'
    const [, incoming] = mergeLegend(ours, { ...theirs, branch: LONG })
    expect(incoming.title).toContain(LONG)
  })

  it('describes each side by what the control keeps — a rebase swaps the stages', () => {
    // "the branch you are merging into" is false during a rebase; this wording
    // stays true for every operation because it points at the button.
    const [current, incoming] = mergeLegend(ours, theirs)
    expect(current.title).toContain('Use current')
    expect(incoming.title).toContain('Use incoming')
  })

  it('gives the two chips different glyphs and accents', () => {
    const [current, incoming] = mergeLegend(ours, theirs)
    expect(current.icon).not.toBe(incoming.icon)
    expect(current.accent).toBe('a')
    expect(incoming.accent).toBe('b')
  })
})
