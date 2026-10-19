import { isMergeDecisionCommand } from './merge-guard'

describe('isMergeDecisionCommand (#1135)', () => {
  it.each([
    'git commit -m "resolve conflicts"',
    'git commit --no-verify',
    'git add src/app/page.tsx',
    'git add -A',
    'git stage .',
    'git reset HEAD src/a.ts',
    'git rm src/gone.ts',
    'git merge --continue',
    'git merge --abort',
    'git rebase --continue',
    'git rebase --skip',
    'git cherry-pick --abort',
    'git revert --continue',
    'git am --abort',
    'git checkout --ours src/a.ts',
    'git restore --staged src/a.ts',
  ])('guards %s', (command) => {
    expect(isMergeDecisionCommand(command)).toBe(true)
  })

  it.each([
    'git status',
    'git diff',
    'git log --oneline -5',
    'git show HEAD',
    'git merge origin/main',
    'git checkout -b feat/x',
    'git restore src/a.ts',
    'npm test',
    'gitk',
    'git-crypt status',
    'echo "git commit is a decision"',
  ])('allows %s through untouched', (command) => {
    expect(isMergeDecisionCommand(command)).toBe(false)
  })

  it('inspects EVERY chained segment, not just the first', () => {
    // A guard that reads only argv[0] is side-stepped by one `&&`.
    expect(isMergeDecisionCommand('npm test && git commit -m done')).toBe(true)
    expect(isMergeDecisionCommand('git status; git add -A')).toBe(true)
    expect(isMergeDecisionCommand('git diff | head -20')).toBe(false)
  })

  it('sees through env prefixes and git-level options', () => {
    expect(isMergeDecisionCommand('GIT_EDITOR=true git commit')).toBe(true)
    expect(isMergeDecisionCommand('git -C /repo commit -m x')).toBe(true)
    expect(isMergeDecisionCommand('git --no-pager add .')).toBe(true)
    expect(isMergeDecisionCommand('/usr/bin/git commit -m x')).toBe(true)
  })

  it('is not fooled by a path containing "git"', () => {
    expect(isMergeDecisionCommand('cat /home/digital/notes.txt')).toBe(false)
    expect(isMergeDecisionCommand('legit commit')).toBe(false)
  })
})
