// THE CLEAN GUARD — Flow's discard paths can never remove an ignored `flow/`.
//
// With knowledge sync on, `flow/` is its own git repository, ignored by the
// code repo. Every note, decision and plan lives there, and some of it may not
// be on GitHub yet. The code repo's Source Control panel offers "Discard" and
// the review panel offers "Reject"; both fall back to removing an untracked
// path with `git clean`. This file proves that fallback cannot reach an ignored
// `flow/` — not as the path itself, not as a file inside it — and that no clean
// in GitManager ever gains `-x` (which is what WOULD reach it).
//
// Real `git` against temp repos, same as git-manager.test.ts.

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { GitManager, type GitRootsProvider } from './git-manager'

const noopRoots: GitRootsProvider = {
  getRoots: () => [],
  onRootsChanged: () => () => undefined,
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'Test')
}

describe('GitManager source: no clean can remove ignored files', () => {
  it('every `clean` argv in git-manager.ts is path-scoped and carries no -x / -X', () => {
    const source = readFileSync(join(__dirname, 'git-manager.ts'), 'utf8')
    const cleans = [...source.matchAll(/\[\s*'clean'[^\]]*\]/g)].map((match) => match[0])
    // The one clean that exists today. A new one must be added here on purpose.
    expect(cleans).toEqual(["['clean', '-fd', '--', toGitPath(repoPath)]"])
    for (const argv of cleans) {
      expect(argv).not.toMatch(/'-[a-zA-Z]*[xX][a-zA-Z]*'/)
      expect(argv).toContain("'--'")
    }
  })
})

describe.each([
  ['a separate knowledge repository (flow/ has its own .git)', true],
  ['a plain ignored folder', false],
])('Discard / Reject never remove an ignored flow/ — %s', (_name, nested) => {
  let repo: string
  let manager: GitManager

  const note = (): string => join(repo, 'flow', 'brain', 'features', 'payments.md')
  const unpushed = (): string => join(repo, 'flow', 'brain', 'decisions', 'not-on-github-yet.md')

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-clean-guard-'))
    initRepo(repo)
    writeFileSync(join(repo, '.gitignore'), 'flow/\n', 'utf8')
    writeFileSync(join(repo, 'index.ts'), 'export const a = 1\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    mkdirSync(join(repo, 'flow', 'brain', 'features'), { recursive: true })
    mkdirSync(join(repo, 'flow', 'brain', 'decisions'), { recursive: true })
    writeFileSync(note(), '# Payments\n', 'utf8')
    if (nested) {
      initRepo(join(repo, 'flow'))
      git(join(repo, 'flow'), 'add', '.')
      git(join(repo, 'flow'), 'commit', '-q', '-m', 'knowledge')
    }
    writeFileSync(unpushed(), 'decided on Tuesday\n', 'utf8')
    // Something the panel legitimately lists, so a discard has real work.
    writeFileSync(join(repo, 'scratch.ts'), 'temp\n', 'utf8')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  function expectKnowledgeIntact(): void {
    expect(existsSync(note())).toBe(true)
    expect(readFileSync(unpushed(), 'utf8')).toBe('decided on Tuesday\n')
    if (nested) expect(existsSync(join(repo, 'flow', '.git'))).toBe(true)
  }

  it('the code repo does not even list flow/ as a change', () => {
    expect(git(repo, 'status', '--porcelain')).not.toContain('flow')
  })

  it.each(['flow', 'flow/', 'flow/brain', 'flow/brain/features/payments.md', 'flow/brain/decisions/not-on-github-yet.md'])(
    'revertFile(%s) leaves the knowledge in place',
    async (target) => {
      // A refusal is as good as a no-op here; what matters is the disk.
      await manager.revertFile(repo, target).catch(() => undefined)
      expectKnowledgeIntact()
    },
  )

  it.each(['flow', 'flow/', 'flow/brain', 'flow/brain/features/payments.md', 'flow/brain/decisions/not-on-github-yet.md'])(
    'discardWorktreeChanges(%s) leaves the knowledge in place',
    async (target) => {
      await manager.discardWorktreeChanges(repo, target).catch(() => undefined)
      expectKnowledgeIntact()
    },
  )

  it('a real discard beside it still works — the guard is not a dead discard', async () => {
    // State the positive before the absence (allowed-pattern #28).
    await manager.discardWorktreeChanges(repo, 'scratch.ts')
    expect(existsSync(join(repo, 'scratch.ts'))).toBe(false)
    expectKnowledgeIntact()
  })
})
