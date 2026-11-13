import type { WorkspaceBranchesResult } from '../../shared/workspaces-contract'
import { workspaceRefusalDetail } from '../../shared/workspace-refusals'
import { WORKSPACE_REMOTE_SENTENCES } from '../../main/workspaces/workspace-remote'
import {
  BRANCH_FIXED_STRINGS,
  BRANCH_HELP,
  CHOOSE_BRANCH,
  INVALID_BRANCH_NAME,
  NEW_BRANCH_VALUE,
  NEW_REPOSITORY_BRANCH,
  NO_BRANCHES_READ,
  branchChoices,
  branchMoveLine,
  changeBranchTitle,
  looksLikeBranchName,
  pickedBranch,
} from './workspace-branch-model'

const listed = (over: Partial<Extract<WorkspaceBranchesResult, { ok: true }>> = {}): WorkspaceBranchesResult => ({
  ok: true,
  branches: [
    { name: 'knowledge', pullRequestOnly: false },
    { name: 'main', pullRequestOnly: true },
  ],
  defaultBranch: 'main',
  suggestion: { name: 'knowledge', source: 'in-use' },
  ...over,
})

describe('branchChoices', () => {
  it('pre-selects the suggestion and says why; a pull-request-only branch is listed, labelled, not pickable', () => {
    const choices = branchChoices(listed())
    expect(choices.selected).toBe('knowledge')
    expect(choices.help).toBe(BRANCH_HELP)
    expect(choices.options).toEqual([
      { value: 'knowledge', label: 'knowledge — already used by this Workspace', disabled: false },
      { value: 'main', label: 'main — only accepts pull requests', disabled: true },
      { value: NEW_BRANCH_VALUE, label: 'A new branch…', disabled: false },
    ])
  })

  it('a branch a check proved unusable is marked, and the selection moves off it', () => {
    const unusable = new Map([['knowledge', 'declined' as const]])
    const choices = branchChoices(listed(), unusable)
    expect(choices.options[0]).toEqual({ value: 'knowledge', label: 'knowledge — the repository declined changes', disabled: true })
    // Nothing usable is listed: a new branch, with the refused name NOT typed back in.
    expect(choices.selected).toBe(NEW_BRANCH_VALUE)
    expect(choices.newName).toBe('')
  })

  it('an empty repository offers a new branch with the suggested name filled in', () => {
    const choices = branchChoices(listed({ branches: [], defaultBranch: null, suggestion: { name: 'main', source: 'new' } }))
    expect(choices.selected).toBe(NEW_BRANCH_VALUE)
    expect(choices.newName).toBe('main')
    expect(choices.help).toBe(NEW_REPOSITORY_BRANCH)
  })

  it('branches that could not be read leave only a typed name, and say so', () => {
    const choices = branchChoices({ ok: false, reason: 'remote-unreadable', detail: 'x' })
    expect(choices.options.map((option) => option.value)).toEqual([NEW_BRANCH_VALUE])
    expect(choices.help).toBe(NO_BRANCHES_READ)
  })

  it('labels the default when it is not the suggestion', () => {
    const choices = branchChoices(
      listed({
        branches: [
          { name: 'develop', pullRequestOnly: false },
          { name: 'notes', pullRequestOnly: false },
        ],
        defaultBranch: 'develop',
        suggestion: { name: 'notes', source: 'current' },
      }),
    )
    expect(choices.options.map((option) => option.label)).toEqual(['develop — the repository’s default', 'notes — this Workspace syncs here', 'A new branch…'])
    expect(choices.selected).toBe('notes')
  })
})

describe('pickedBranch / looksLikeBranchName', () => {
  it('a listed branch is taken as it is', () => {
    expect(pickedBranch('knowledge', 'ignored', { required: true })).toEqual({ ok: true, branch: 'knowledge' })
  })

  it('a blank new name is "Flow decides" unless a branch is required', () => {
    expect(pickedBranch(NEW_BRANCH_VALUE, '  ', { required: false })).toEqual({ ok: true, branch: undefined })
    expect(pickedBranch(NEW_BRANCH_VALUE, '', { required: true })).toEqual({ ok: false, message: CHOOSE_BRANCH })
  })

  it('refuses an obvious non-name before anything is sent', () => {
    for (const bad of ['has space', '-flag', 'a..b', 'end.', 'x.lock', 'a:b', 'a~1', 'a^', '/lead', 'trail/', 'a@{b']) {
      expect([bad, looksLikeBranchName(bad)]).toEqual([bad, false])
    }
    expect(pickedBranch(NEW_BRANCH_VALUE, 'has space', { required: false })).toEqual({ ok: false, message: INVALID_BRANCH_NAME })
    for (const good of ['knowledge', 'team/notes', 'feature/PF-42']) expect(looksLikeBranchName(good)).toBe(true)
  })
})

describe('branchMoveLine', () => {
  it('names where it came from, when, and why', () => {
    expect(branchMoveLine({ from: 'main', to: 'knowledge', reason: 'pull-request-required', at: '2026-11-13T12:00:00Z' })).toBe(
      'Moved from main on Nov 13: main only accepts pull requests.',
    )
    expect(branchMoveLine({ from: 'main', to: 'knowledge', reason: 'followed', at: '2026-11-13T12:00:00Z' })).toBe(
      'Moved from main on Nov 13 to the branch your team already uses.',
    )
  })

  it('says nothing for no move or a time it cannot read', () => {
    expect(branchMoveLine(null)).toBeNull()
    expect(branchMoveLine({ from: 'a', to: 'b', reason: 'followed', at: 'not a time' })).toBeNull()
  })
})

// ── forbidden-pattern #12 ───────────────────────────────────────────────────

describe('forbidden-pattern #12: the branch surface says nothing of commands, paths, keys or internals', () => {
  const strings = [
    ...BRANCH_FIXED_STRINGS,
    changeBranchTitle('Shared'),
    branchMoveLine({ from: 'main', to: 'knowledge', reason: 'pull-request-required', at: '2026-11-13T12:00:00Z' }) ?? '',
    branchMoveLine({ from: 'main', to: 'knowledge', reason: 'followed', at: '2026-11-13T12:00:00Z' }) ?? '',
    WORKSPACE_REMOTE_SENTENCES.branchUnusable('main', 'pull-request-required', null),
    WORKSPACE_REMOTE_SENTENCES.branchUnusable('notes', 'declined', 'knowledge'),
    WORKSPACE_REMOTE_SENTENCES.branchUnusable('notes', 'unrelated-history', 'knowledge'),
    workspaceRefusalDetail('invalid-branch'),
    workspaceRefusalDetail('branch-diverged'),
    workspaceRefusalDetail('remote-unreadable'),
  ]

  it('collected a real surface to scan (the positive before the absence)', () => {
    expect(strings.length).toBeGreaterThan(25)
    expect(strings).toContain('main only accepts changes through pull requests, so Flow can’t save knowledge there. Choose another branch.')
    expect(strings).toContain('notes already holds something other than this Workspace. The Workspace stays on knowledge. Choose another branch.')
  })

  const FORBIDDEN: [string, RegExp][] = [
    ['a slash path', /[A-Za-z0-9_.~-]\/[A-Za-z0-9_.~-]|^\/|\s\/|\\/],
    ['a git command', /\bgit\s/i],
    ['the CLI', /planflow|plan-flow|set-branch|ls-remote/i],
    ['a flag', /(^|\s)--?[a-z][a-z-]*/],
    ['a backtick', /`/],
    ['a config key', /\b[a-z]+_[a-z_]+\b|\bflow\.[a-z]/],
    ['an internal word', /\b(slug|payload|refus(al|ed)|CLI|IPC|JSON|origin|ref|HEAD|upstream)\b/],
    ['an emoji', /\p{Extended_Pictographic}/u],
  ]

  it.each(FORBIDDEN)('contains no %s', (_what, pattern) => {
    expect(strings.filter((text) => pattern.test(text))).toEqual([])
  })
})
