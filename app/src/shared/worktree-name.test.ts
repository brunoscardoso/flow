import {
  FALLBACK_WORKTREE_NAME,
  folderForBranch,
  MAX_WORKTREE_NAME_LENGTH,
  WORKTREE_FOLDER_PREFIX,
  isUnnamedCheckoutPath,
  uniqueWorktreeName,
  validateWorktreeName,
  worktreeNameFor,
  worktreeNameFromTitle,
} from './worktree-name'

const UUID = 'e2265b48-03e9-43e3-8f76-ff887a48615e'

describe('worktreeNameFromTitle — the derived half', () => {
  it('turns a title into a folder name', () => {
    expect(worktreeNameFromTitle('Data Contract Guard')).toBe('data-contract-guard')
    expect(worktreeNameFromTitle('  Two   spaces & symbols!  ')).toBe('two-spaces-symbols')
  })

  it('never ends on a separator, even after truncation', () => {
    const name = worktreeNameFromTitle('a'.repeat(30) + ' ' + 'b'.repeat(30))
    expect(name).not.toMatch(/-$/)
    expect(name.length).toBeLessThanOrEqual(MAX_WORKTREE_NAME_LENGTH)
  })

  it('falls back rather than returning nothing', () => {
    for (const title of ['🎉🎉🎉', '...', '---', '///', '', '   ', null]) {
      expect(worktreeNameFromTitle(title)).toBe(FALLBACK_WORKTREE_NAME)
    }
  })

  it('NEVER returns a uuid — the whole point of the feature', () => {
    // A uuid passes the folder grammar (lowercase alphanumerics joined by `-`),
    // which is why nothing ever refused one. The guard was doing its job; its
    // job was never "is this a name a person can read".
    expect(worktreeNameFromTitle(UUID)).toBe(FALLBACK_WORKTREE_NAME)
    expect(worktreeNameFromTitle(UUID.toUpperCase())).toBe(FALLBACK_WORKTREE_NAME)
  })

  it('produces only names the folder grammar accepts', () => {
    for (const title of ['Fix THE parser!!', 'ACME-2446: spaces', '  ---  ', '2024 release notes']) {
      expect(worktreeNameFromTitle(title)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })
})

describe('validateWorktreeName — the typed half', () => {
  it('returns a good name exactly as typed', () => {
    expect(validateWorktreeName('data-contract-guard')).toEqual({
      ok: true,
      name: 'data-contract-guard',
    })
    // Whitespace at the ends is not part of a name and a field adds it by accident.
    expect(validateWorktreeName('  parser  ')).toEqual({ ok: true, name: 'parser' })
  })

  it('refuses rather than repairs', () => {
    // The difference that matters: a sanitizer would hand back
    // `data-contract-guard` and the person would get a folder they were never
    // shown (allowed-pattern #22).
    const verdict = validateWorktreeName('Data Contract Guard')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.detail).toContain('lowercase words')
  })

  it('refuses everything a path could be steered with', () => {
    // `a/b` is now a legal shape — one level — so the traversal cases are the
    // ones that matter: a segment that is not a name can never become a path.
    for (const bad of ['../escape', 'a/b/c', '.hidden', 'trailing-', '-leading', 'UPPER', 'a..b', 'a//b', '/a', 'a/']) {
      expect(validateWorktreeName(bad).ok).toBe(false)
    }
  })

  it('refuses a uuid with a sentence about names, not about ids', () => {
    const verdict = validateWorktreeName(UUID)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.detail).toContain('recognise')
  })

  it('names no command, path or config key in any refusal (forbidden-pattern #12)', () => {
    const refusals = ['', 'Data Contract Guard', '../escape', UUID].map((typed) => {
      const verdict = validateWorktreeName(typed)
      return verdict.ok ? '' : verdict.detail
    })
    expect(refusals.join(' ')).not.toMatch(/planflow-ai|requireOwnerName|--|\.flowconfig|git /)
  })
})

describe('uniqueWorktreeName — two conversations, one title', () => {
  it('leaves a free name alone', () => {
    expect(uniqueWorktreeName('parser', ['other'])).toBe('parser')
  })

  it('counts the way a person counts: the second is -2', () => {
    expect(uniqueWorktreeName('parser', ['parser'])).toBe('parser-2')
    expect(uniqueWorktreeName('parser', ['parser', 'parser-2'])).toBe('parser-3')
  })

  it('ignores blanks in the taken set rather than colliding with them', () => {
    expect(uniqueWorktreeName('parser', ['', '   '])).toBe('parser')
  })
})

describe('worktreeNameFor — the one entry point', () => {
  it('prefers what was typed', () => {
    expect(worktreeNameFor({ typed: 'mine', title: 'Something else' })).toBe('mine')
  })

  it('derives from the title when nothing was typed', () => {
    expect(worktreeNameFor({ typed: '  ', title: 'Data Contract Guard' })).toBe(
      'data-contract-guard',
    )
  })

  it('is unique either way', () => {
    expect(worktreeNameFor({ typed: 'mine', title: null, taken: ['mine'] })).toBe('mine-2')
    expect(
      worktreeNameFor({ title: 'Data Contract Guard', taken: ['data-contract-guard'] }),
    ).toBe('data-contract-guard-2')
  })
})

describe('isUnnamedCheckoutPath — the migration’s subject', () => {
  it('knows a checkout nobody named', () => {
    expect(isUnnamedCheckoutPath(`/Users/me/.orbit-app-threads/${UUID}`)).toBe(true)
    expect(isUnnamedCheckoutPath(`/Users/me/.orbit-app-threads/${UUID}/`)).toBe(true)
  })

  it('leaves a named one alone, however odd the name', () => {
    expect(isUnnamedCheckoutPath('/Users/me/.orbit-app-threads/data-contract-guard')).toBe(false)
    expect(isUnnamedCheckoutPath('/Users/me/.orbit-app-threads/work-2')).toBe(false)
    // A name that merely CONTAINS a uuid was chosen by somebody.
    expect(isUnnamedCheckoutPath(`/Users/me/.orbit-app-threads/fix-${UUID}`)).toBe(false)
  })
})

describe('folderForBranch — one name, two things', () => {
  it('prefixes the folder and leaves the branch alone', () => {
    // A person types the name once: the branch is exactly that, and the folder
    // wears the prefix that says which of the two it is (user, 2026-09-17).
    expect(folderForBranch('data-contract-guard')).toBe('worktree/data-contract-guard')
  })

  it('slugs a branch that is not already a folder name', () => {
    // `feat/data-contract-guard` is a perfectly good ref and not a directory.
    expect(folderForBranch('feat/data-contract-guard')).toBe('worktree/feat-data-contract-guard')
  })

  it('never doubles the prefix', () => {
    expect(folderForBranch('worktree/parser')).toBe('worktree/parser')
  })

  it('still answers for a branch that slugs to nothing', () => {
    expect(folderForBranch('🎉')).toBe('worktree/work')
    expect(folderForBranch(null)).toBe('worktree/work')
  })

  it('produces only names the folder grammar accepts', () => {
    // One nested level, each segment held to the same grammar.
    for (const branch of ['feat/PF-42', 'release/9.1', '🎉', 'a']) {
      expect(folderForBranch(branch)).toMatch(
        /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/,
      )
    }
  })
})

describe('the length limit counts what a person typed', () => {
  it('does not charge for the prefix they never typed', () => {
    // The field holds the STEM; the prefix sits beside it as fixed text. So a
    // 40-character stem must be accepted even though the full folder name is 49
    // — charging for the prefix left 31 usable and a refusal quoting 40, a
    // limit nobody could count against their own screen.
    const stem = 'a'.repeat(MAX_WORKTREE_NAME_LENGTH)
    const verdict = validateWorktreeName(`${WORKTREE_FOLDER_PREFIX}${stem}`)
    // The detail is surfaced by failing on it, since this repo's jest expect
    // takes no message argument.
    expect(verdict.ok ? 'ok' : verdict.detail).toBe('ok')
  })

  it('still refuses a stem longer than the limit', () => {
    const stem = 'a'.repeat(MAX_WORKTREE_NAME_LENGTH + 1)
    const verdict = validateWorktreeName(`${WORKTREE_FOLDER_PREFIX}${stem}`)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.detail).toContain(String(MAX_WORKTREE_NAME_LENGTH))
  })

  it('measures an unprefixed name as itself', () => {
    expect(validateWorktreeName('a'.repeat(MAX_WORKTREE_NAME_LENGTH)).ok).toBe(true)
    expect(validateWorktreeName('a'.repeat(MAX_WORKTREE_NAME_LENGTH + 1)).ok).toBe(false)
  })
})
