import {
  FALLBACK_BRANCH_NAME,
  suggestBranchName,
  validateBranchName,
} from './branch-name'

/**
 * Titles a person might really type, including the ones that survive none of
 * the slug. Used by the sweeps below rather than by one test, because the
 * promise `suggestBranchName` makes is about ALL of them, not about examples.
 */
const TITLES: Array<string | null> = [
  'Fix the access token refresh',
  'ACME-2204: Error endpoint when spaces is not enabled',
  '  Leading and trailing space  ',
  'MiXeD CaSe And PUNCTUATION!!!',
  'a',
  '2024 release notes',
  'Reduce the payload on threads:list from 6.98 MB to 0.86 MB by bounding tool call output at the IPC boundary',
  '...',
  '---',
  '///',
  '🎉🎉🎉',
  '@',
  '.lock',
  '',
  '   ',
  null,
]

describe('a derived name is sanitized, because refusing here leaves an empty box', () => {
  it('turns an ordinary title into the branch that title would have got anyway', () => {
    // Not a second opinion about the title: the same prefix and the same slug
    // main uses when it names a branch after the first successful turn, shown
    // early enough to be edited.
    expect(suggestBranchName('Fix the access token refresh')).toBe(
      'worktree/fix-the-access-token-refresh',
    )
  })

  it('still yields a usable name for a title made entirely of emoji or punctuation', () => {
    // An emoji-only title is a perfectly ordinary thing for a person to write.
    // The alternative — null, and therefore an empty field — would be the app
    // refusing to suggest anything at the exact moment it asked for a decision.
    for (const title of ['🎉🎉🎉', '...', '---', '///', '', '   ', null]) {
      expect(suggestBranchName(title)).toBe(FALLBACK_BRANCH_NAME)
    }
  })

  it('never returns an empty string, whatever it is handed', () => {
    for (const title of TITLES) {
      expect(suggestBranchName(title).trim()).not.toBe('')
    }
  })

  it('never suggests a name its own validator would refuse', () => {
    // THE PROMISE THE TWO HALVES MAKE TOGETHER. A suggestion that the field
    // beside it rejects is worse than no suggestion at all: the reader is shown
    // a name, presses accept, and is told the app's own answer is wrong.
    for (const title of TITLES) {
      const suggestion = suggestBranchName(title)
      const check = validateBranchName(suggestion)
      expect(check.ok).toBe(true)
      if (check.ok) expect(check.name).toBe(suggestion)
    }
  })

  it('keeps a long title short enough to read, without breaking the name', () => {
    const long = suggestBranchName(TITLES[6] as string)
    expect(long.length).toBeLessThan(64)
    expect(validateBranchName(long).ok).toBe(true)
  })
})

describe('a typed name is validated and refused, never rewritten', () => {
  /** Names git will take, in the shapes people actually type. */
  const ACCEPTED = [
    'thread/fix-the-parser',
    'feature/PF-42-parser',
    'release/v1.2.3',
    'main',
    'devuser/spike',
    'a',
    '2024-release',
  ]

  it('hands back exactly what it was given', () => {
    // THE CONTRACT OF THIS WHOLE MODULE: the branch shown has to be the branch
    // made. Run through the sanitizer above, `feature/PF-42-parser` would come
    // out as `thread/feature-pf-42-parser` — a different branch, created
    // silently, with the ticket shape that was the point of typing it gone.
    for (const typed of ACCEPTED) {
      const check = validateBranchName(typed)
      expect(check).toEqual({ ok: true, name: typed })
    }
  })

  it('does not lowercase, slug, prefix or otherwise improve a name', () => {
    const check = validateBranchName('feature/PF-42-parser')
    expect(check.ok && check.name).toBe('feature/PF-42-parser')
    expect(check.ok && check.name.startsWith('thread/')).toBe(false)
  })

  it('trims the whitespace a text field adds, and touches nothing inside', () => {
    // Whitespace at the ends is not part of any name and is never what the
    // person meant. It is also the ONLY difference this function is allowed to
    // introduce — anything else would have to become a refusal instead.
    const check = validateBranchName('  feature/PF-42-parser  ')
    expect(check).toEqual({ ok: true, name: 'feature/PF-42-parser' })
  })

  it('refuses an empty name with a sentence rather than a silent fallback', () => {
    for (const typed of ['', '   ']) {
      const check = validateBranchName(typed)
      expect(check.ok).toBe(false)
      if (!check.ok) expect(check.detail).toBe('Type a name for this branch.')
    }
  })

  it('refuses every shape git itself refuses, naming the one that was typed', () => {
    // The rules are git's `check-ref-format`, ported once in the shared module
    // and delegated to here — a second grammar in the renderer would start
    // accepting names the push later rejects, and the drift would be invisible.
    const REFUSED = [
      'has space',
      'feat..ure',
      'a//b',
      'trailing/',
      '/leading',
      '-leading',
      '.leading',
      'trailing.',
      'name.lock',
      'feat/.hidden',
      'feat/x.lock/y',
      'star*',
      'question?',
      'tilde~1',
      'caret^',
      'colon:name',
      'back\\slash',
      'ref@{0}',
      '@',
    ]
    for (const typed of REFUSED) {
      const check = validateBranchName(typed)
      expect(check.ok).toBe(false)
      if (!check.ok) {
        expect(check.detail).toContain(typed)
        expect(check.detail.endsWith('.')).toBe(true)
      }
    }
  })
})

describe('the words', () => {
  it('never names a container in anything the module writes itself', () => {
    // The ban covers the module's OWN sentences. A refusal quotes the name the
    // person typed, and that name is theirs — if somebody types `worktree` as a
    // branch name, refusing to repeat it back would be a different bug.
    //
    // A BRANCH NAME IS NOT A SENTENCE EITHER. The namespace is `worktree/` on
    // purpose — it says in git what made the branch, where the reader is
    // looking at branches rather than at product copy (user, 2026-09-17:
    // "instead of thread/name can be worktree/name-branch because the user will
    // understand that better"). So names are held to the naming rule (below)
    // and the PROSE is held to this one.
    const refusals = ['', '   ', 'has space', 'feat..ure', '@'].map((typed) => {
      const check = validateBranchName(typed)
      return check.ok ? check.name : check.detail
    })
    expect(refusals.join(' ')).not.toMatch(/copy|workspace|worktree/i)
  })

  it('puts every derived name in the worktree namespace, and nowhere else', () => {
    const names = [FALLBACK_BRANCH_NAME, ...TITLES.map((title) => suggestBranchName(title))]
    for (const name of names) {
      expect(name).toMatch(/^worktree\//)
      // The word belongs to the namespace, never to the slug — a title
      // containing "copy" would still be slugged, but nothing here adds one.
      expect(name.slice('worktree/'.length)).not.toMatch(/workspace|worktree/i)
    }
  })

  it('names no path, command or config key (forbidden-pattern #12)', () => {
    // A refusal explains what is wrong, never what to run to fix it.
    const refusals = ['', 'has space', 'feat..ure'].map((typed) => {
      const check = validateBranchName(typed)
      return check.ok ? check.name : check.detail
    })
    expect(refusals.join(' ')).not.toMatch(/planflow-ai|\.flowconfig|check-ref-format|git /)
  })
})
