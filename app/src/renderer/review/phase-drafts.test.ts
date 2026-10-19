import { dropCommittedDraft, pruneVanishedDrafts } from './phase-drafts'

describe('pruneVanishedDrafts (#1140)', () => {
  it('drops the draft of a group that is no longer listed', () => {
    // The discard scenario: "Other changes" held app.ts and was thrown away;
    // the listing that comes back holds a different, unrelated changeset.
    const drafts = new Map([['Other changes', 'fix: bump app.ts']])
    expect(pruneVanishedDrafts(drafts, []).has('Other changes')).toBe(false)
  })

  it('keeps the draft of a group that is still listed', () => {
    // A FAILED commit refreshes too — those files are still there and still
    // retryable, so the message the user typed must survive.
    const drafts = new Map([['Other changes', 'fix: bump app.ts']])
    expect(pruneVanishedDrafts(drafts, ['Other changes']).get('Other changes')).toBe(
      'fix: bump app.ts',
    )
  })

  it('prunes per label, leaving live groups alone', () => {
    const drafts = new Map([
      ['Phase 1', 'feat: phase one'],
      ['Phase 2', 'fix: phase two'],
      ['Other changes', 'chore: gone'],
    ])
    const next = pruneVanishedDrafts(drafts, ['Phase 1', 'Phase 2'])
    expect([...next.keys()]).toEqual(['Phase 1', 'Phase 2'])
  })

  it('does not resurrect a draft when the label is recycled later', () => {
    // The heart of the bug: the label comes back for DIFFERENT files.
    const drafts = new Map([['Other changes', 'fix: bump app.ts']])
    const afterDiscard = pruneVanishedDrafts(drafts, [])
    const afterUnrelatedFileAppears = pruneVanishedDrafts(afterDiscard, ['Other changes'])
    expect(afterUnrelatedFileAppears.has('Other changes')).toBe(false)
  })

  it('does not mutate the input map', () => {
    const drafts = new Map([['Other changes', 'msg']])
    pruneVanishedDrafts(drafts, [])
    expect(drafts.has('Other changes')).toBe(true)
  })
})

describe('dropCommittedDraft (#342)', () => {
  it('removes exactly the committed group’s draft', () => {
    const drafts = new Map([['Other changes', 'chore: one-off message for change ONE']])
    const next = dropCommittedDraft(drafts, 'Other changes')
    expect(next.has('Other changes')).toBe(false)
  })

  it('preserves every OTHER group’s in-progress draft', () => {
    const drafts = new Map([
      ['Phase 1', 'feat: phase one'],
      ['Other changes', 'chore: committed'],
      ['Phase 2', 'fix: phase two (still typing)'],
    ])
    const next = dropCommittedDraft(drafts, 'Other changes')
    expect(next.get('Phase 1')).toBe('feat: phase one')
    expect(next.get('Phase 2')).toBe('fix: phase two (still typing)')
    expect(next.has('Other changes')).toBe(false)
  })

  it('does not mutate the input map', () => {
    const drafts = new Map([['Other changes', 'msg']])
    dropCommittedDraft(drafts, 'Other changes')
    expect(drafts.has('Other changes')).toBe(true) // original untouched
  })

  it('is a no-op for a label with no draft', () => {
    const drafts = new Map([['Phase 1', 'feat: x']])
    const next = dropCommittedDraft(drafts, 'Other changes')
    expect(next.get('Phase 1')).toBe('feat: x')
    expect(next.size).toBe(1)
  })
})
