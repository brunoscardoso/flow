/**
 * Renaming a branch — ANY branch, on any checkout.
 *
 * This used to be offered only on a thread's own checkout and refused on a
 * project's branch. Nobody reading the panel could see the rule: a pencil on
 * one branch line and none on the next. The user's words: "the only thing
 * that matters is have a way to rename any branch when needed."
 *
 * Against real git, because the thing under test is what git does.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { GitManager, type GitRootsProvider } from './git-manager'

const noopRoots: GitRootsProvider = { getRoots: () => [], onRootsChanged: () => () => undefined }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('GitManager.renameBranch', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-rename-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'me@here.com')
    git(repo, 'config', 'user.name', 'Me')
    writeFileSync(join(repo, 'a.txt'), 'hello\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'first')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  const current = (): string => git(repo, 'branch', '--show-current').trim()

  it('renames the project’s OWN branch — the case that used to be refused', async () => {
    const result = await manager.renameBranch(repo, 'feature/PF-42', { confirmed: true })
    expect(result.status).toBe('renamed')
    expect(current()).toBe('feature/PF-42')
  })

  it('runs no git that writes without an explicit say-so (forbidden-pattern #15)', async () => {
    const result = await manager.renameBranch(repo, 'whatever')
    expect(result.status).toBe('refused')
    expect(current()).toBe('main') // the branch did not move
  })

  it('takes a typed name exactly as typed — never slugged, never prefixed', async () => {
    await manager.renameBranch(repo, 'ACME-2778-tenant-id', { confirmed: true })
    expect(current()).toBe('ACME-2778-tenant-id')
  })

  it('refuses a name git would refuse, and moves nothing', async () => {
    for (const bad of ['a name', 'x..y', '-lead', 'trail.lock', '']) {
      const result = await manager.renameBranch(repo, bad, { confirmed: true })
      expect(result.status).toBe('refused')
    }
    expect(current()).toBe('main')
  })

  it('refuses a name something already answers to — never a silent -2', async () => {
    git(repo, 'branch', 'taken')
    const result = await manager.renameBranch(repo, 'taken', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('already works under that name')
    expect(current()).toBe('main')
  })

  it('says nothing changed rather than moving a branch onto itself', async () => {
    const result = await manager.renameBranch(repo, 'main', { confirmed: true })
    expect(result.status).toBe('unchanged')
    expect(current()).toBe('main')
  })

  it('refuses a detached HEAD, which has no name to change', async () => {
    git(repo, 'checkout', '--detach')
    const result = await manager.renameBranch(repo, 'somewhere', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('on a commit rather than a branch')
  })

  it('never puts a path, a command or a config key in what it says (#12)', async () => {
    const said: string[] = []
    for (const [name, opts] of [
      ['a name', { confirmed: true }],
      ['main', { confirmed: true }],
      ['fine', {}],
    ] as const) {
      said.push((await manager.renameBranch(repo, name, opts)).detail)
    }
    for (const text of said) {
      expect(text).not.toMatch(/git |planflow-ai|\/(tmp|Users|var)\/|`/)
    }
  })
})
