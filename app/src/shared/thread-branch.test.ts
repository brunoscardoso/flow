import {
  branchIsTitleDerived,
  branchSlug,
  threadBranchName,
  isValidRefName,
} from './thread-branch'

describe('threadBranchName', () => {
  it('slugs a title into the thread namespace', () => {
    expect(threadBranchName('Fix the sidebar flicker')).toBe('worktree/fix-the-sidebar-flicker')
  })

  it('is null for a title that slugs to nothing', () => {
    for (const title of [null, '', '   ', '🎉🎉']) {
      expect(threadBranchName(title)).toBeNull()
    }
  })

  it('caps the slug so a long title cannot make an unusable branch', () => {
    const slug = branchSlug('a'.repeat(200))
    expect(slug.length).toBeLessThanOrEqual(48)
  })

  it('never leaves a trailing separator after the cap', () => {
    // A title cut mid-word at the cap used to leave `-` on the end, which is a
    // name git accepts and a person reads as a typo.
    expect(branchSlug('word '.repeat(40)).endsWith('-')).toBe(false)
  })
})

describe('branchIsTitleDerived', () => {
  it('is true when the branch is the title, spelled as a branch', () => {
    expect(branchIsTitleDerived('thread/fix-the-parser', 'Fix the parser')).toBe(true)
  })

  it('is true for the dedupe suffixes naming adds on collision', () => {
    expect(branchIsTitleDerived('thread/fix-the-parser-2', 'Fix the parser')).toBe(true)
    expect(branchIsTitleDerived('thread/fix-the-parser-17', 'Fix the parser')).toBe(true)
  })

  it('is false for a branch the thread did not name', () => {
    // The case the titlebar keeps: nothing about the title implies this.
    expect(
      branchIsTitleDerived('ACME-2446-rework-the-session-cache-for-the-new-router', 'Chat migration'),
    ).toBe(false)
  })

  it('is false once the title and the branch have parted company', () => {
    expect(branchIsTitleDerived('thread/fix-the-parser', 'Something else entirely')).toBe(false)
  })

  it('is false when either side is missing', () => {
    expect(branchIsTitleDerived(null, 'Fix the parser')).toBe(false)
    expect(branchIsTitleDerived('thread/fix-the-parser', null)).toBe(false)
    expect(branchIsTitleDerived('  ', 'Fix the parser')).toBe(false)
  })

  it('does not let a title full of regex characters match by accident', () => {
    // The suffix test builds a pattern from the derived name; an unescaped one
    // would make `a.b` match `axb` and silently hide a real branch.
    expect(branchIsTitleDerived('thread/a-b-2', 'a.b')).toBe(true)
    expect(branchIsTitleDerived('thread/axb', 'a.b')).toBe(false)
  })

  it('is false for a branch that merely starts with the derived name', () => {
    // `thread/fix-the-parser-again` is a DIFFERENT piece of work, not a dedupe.
    expect(branchIsTitleDerived('thread/fix-the-parser-again', 'Fix the parser')).toBe(false)
  })
})

describe('isValidRefName', () => {
  it('accepts the shapes a person actually types', () => {
    // The one that started this: a ticket-derived name whose SHAPE is the
    // point. threadBranchName turns it into thread/feature-pf-42-fix-parser.
    expect(isValidRefName('feature/PF-42-fix-parser')).toBe(true)
    expect(isValidRefName('thread/fix-the-parser')).toBe(true)
    expect(isValidRefName('release/2026.08')).toBe(true)
    expect(isValidRefName('devuser/spike')).toBe(true)
    expect(isValidRefName('ACME-2778')).toBe(true)
  })

  it('refuses what git refuses, rather than repairing it', () => {
    // Each of these has a silent repair available — slug the spaces, drop the
    // dots, strip the tilde. Taking it would hand back a different branch from
    // the one on screen (allowed-pattern #22).
    expect(isValidRefName('fix parser!!')).toBe(false)   // space
    expect(isValidRefName('feat/..up')).toBe(false)      // ..
    expect(isValidRefName('feat/x~1')).toBe(false)       // ~
    expect(isValidRefName('feat/x^')).toBe(false)        // ^
    expect(isValidRefName('feat:x')).toBe(false)         // :
    expect(isValidRefName('feat/x?')).toBe(false)        // ?
    expect(isValidRefName('feat/*')).toBe(false)         // *
    expect(isValidRefName('feat/[x]')).toBe(false)       // [
    expect(isValidRefName('feat/x\\y')).toBe(false)      // backslash
    expect(isValidRefName('feat/x@{y}')).toBe(false)     // @{
  })

  it('refuses the edge shapes that only bite one component deep', () => {
    // A whole-string check passes every one of these.
    expect(isValidRefName('feat/.hidden')).toBe(false)
    expect(isValidRefName('feat/x.lock/y')).toBe(false)
    expect(isValidRefName('feat//x')).toBe(false)
    expect(isValidRefName('/feat/x')).toBe(false)
    expect(isValidRefName('feat/x/')).toBe(false)
    expect(isValidRefName('-feat')).toBe(false)
    expect(isValidRefName('.feat')).toBe(false)
    expect(isValidRefName('feat.')).toBe(false)
    expect(isValidRefName('feat.lock')).toBe(false)
    // Diverges from git ON PURPOSE — `git check-ref-format refs/heads/@` passes.
    // `@` is HEAD shorthand, so the branch is creatable and unusable. See the
    // note on isValidRefName.
    expect(isValidRefName('@')).toBe(false)
    expect(isValidRefName('')).toBe(false)
    expect(isValidRefName('   ')).toBe(false)
  })

  it('is not threadBranchName — the two answer opposite questions', () => {
    // Same input, and that is the whole point: one produces a name, the other
    // says whether the name it was handed is usable as it stands.
    expect(threadBranchName('feature/PF-42')).toBe('worktree/feature-pf-42')
    expect(isValidRefName('feature/PF-42')).toBe(true)
  })
})
