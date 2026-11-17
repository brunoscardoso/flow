// The Source Control rebuild's main-process half, against real git: the graph's
// parents and refs, a commit's files, one-hunk stage / unstage / revert, fetch,
// and a guarded amend.

import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { GitManager, type GitRootsProvider } from './git-manager'

const noopRoots: GitRootsProvider = { getRoots: () => [], onRootsChanged: () => () => undefined }

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  return repo
}

const TEN = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'

describe('GitManager.log parents and refs (graph)', () => {
  let repo: string
  const manager = new GitManager(noopRoots)
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('carries parents first-parent-first and the refs pointing at each commit', async () => {
    repo = initRepo('flow-scm-log-')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'root')
    git(repo, 'checkout', '-q', '-b', 'feat')
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'on feat')
    git(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'c.txt'), 'c\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'on main')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat')
    git(repo, 'tag', 'v1')

    const commits = await manager.log(repo, { limit: 10 })
    const top = commits[0]
    expect(top?.subject).toBe('merge feat')
    expect(top?.parents).toHaveLength(2)
    expect(top?.refs).toEqual([
      { kind: 'branch', name: 'main', current: true },
      { kind: 'tag', name: 'v1' },
    ])
    const feat = commits.find((commit) => commit.subject === 'on feat')
    expect(feat?.refs).toEqual([{ kind: 'branch', name: 'feat' }])
    expect(top?.parents?.[1]).toBe(feat?.hash)
    const root = commits.find((commit) => commit.subject === 'root')
    expect(root?.parents).toEqual([])
    expect(root?.refs).toBeUndefined()
  })
})

describe('GitManager.commitFiles', () => {
  let repo: string
  const manager = new GitManager(noopRoots)
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('lists a commit’s files with counts, the root commit included', async () => {
    repo = initRepo('flow-scm-files-')
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'root')
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\n')
    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'second')
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    const rootHash = git(repo, 'rev-parse', 'HEAD~1').trim()

    const second = await manager.commitFiles(repo, head)
    expect(second.total).toBe(2)
    expect(second.files).toEqual([
      { filePath: 'a.txt', state: 'modified', added: 2, deleted: 1 },
      { filePath: 'b.txt', state: 'added', added: 1, deleted: 0 },
    ])
    const first = await manager.commitFiles(repo, rootHash)
    expect(first.files).toEqual([{ filePath: 'a.txt', state: 'added', added: 2, deleted: 0 }])
  })

  it('refuses a revision that is not a plain hash (SEC-2)', async () => {
    repo = initRepo('flow-scm-files-sec-')
    await expect(manager.commitFiles(repo, '--output=/tmp/x')).rejects.toThrow()
  })
})

describe('GitManager.applyHunk', () => {
  let repo: string
  const manager = new GitManager(noopRoots)

  beforeEach(() => {
    repo = initRepo('flow-scm-hunk-')
    writeFileSync(join(repo, 'f.txt'), TEN)
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'root')
    // Two separate edits → two -U0 hunks.
    writeFileSync(join(repo, 'f.txt'), TEN.replace('line 2\n', 'line 2 EDITED\n').replace('line 9\n', 'line 9 EDITED\n'))
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  async function hunks(staged: boolean) {
    const diff = staged
      ? await manager.stagedDiff(repo, 'f.txt', { hunks: true })
      : await manager.diff(repo, 'f.txt', undefined, 'index', { hunks: true })
    return diff.hunks ?? []
  }

  it('offers both hunks, stages exactly one, and unstages it again', async () => {
    const before = await hunks(false)
    expect(before).toHaveLength(2)
    const second = before[1]
    if (second === undefined) throw new Error('no second hunk')

    const staged = await manager.applyHunk(repo, {
      filePath: 'f.txt',
      action: 'stage',
      hunkIndex: 1,
      expectedHeader: second.header,
      expectedDigest: second.digest,
    })
    expect(staged).toEqual({ status: 'applied' })
    const cached = git(repo, 'diff', '--cached', '-U0')
    expect(cached).toContain('+line 9 EDITED')
    expect(cached).not.toContain('line 2 EDITED')
    // The working tree still carries both edits; only one is left unstaged.
    expect(await hunks(false)).toHaveLength(1)

    const stagedHunks = await hunks(true)
    expect(stagedHunks).toHaveLength(1)
    const only = stagedHunks[0]
    if (only === undefined) throw new Error('no staged hunk')
    const unstaged = await manager.applyHunk(repo, {
      filePath: 'f.txt',
      action: 'unstage',
      hunkIndex: 0,
      expectedHeader: only.header,
      expectedDigest: only.digest,
    })
    expect(unstaged).toEqual({ status: 'applied' })
    expect(git(repo, 'diff', '--cached')).toBe('')
  })

  it('refuses a hunk the file no longer has, and applies nothing', async () => {
    const before = await hunks(false)
    const first = before[0]
    if (first === undefined) throw new Error('no hunk')
    // The file changes after the diff was shown.
    writeFileSync(join(repo, 'f.txt'), TEN.replace('line 2\n', 'line 2 SOMETHING ELSE\n'))
    const result = await manager.applyHunk(repo, {
      filePath: 'f.txt',
      action: 'stage',
      hunkIndex: 0,
      expectedHeader: first.header,
      expectedDigest: first.digest,
    })
    expect(result.status).toBe('stale')
    expect(git(repo, 'diff', '--cached')).toBe('')
  })

  it('reverts one hunk only with an explicit confirmation', async () => {
    const before = await hunks(false)
    const first = before[0]
    if (first === undefined) throw new Error('no hunk')
    const request = {
      filePath: 'f.txt',
      action: 'revert' as const,
      hunkIndex: 0,
      expectedHeader: first.header,
      expectedDigest: first.digest,
    }
    // Positive first: the hunk IS there to revert (allowed #28).
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toContain('line 2 EDITED')
    const refused = await manager.applyHunk(repo, request)
    expect(refused.status).toBe('unconfirmed')
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toContain('line 2 EDITED')

    const reverted = await manager.applyHunk(repo, { ...request, confirmed: true })
    expect(reverted).toEqual({ status: 'applied' })
    const text = readFileSync(join(repo, 'f.txt'), 'utf8')
    expect(text).not.toContain('line 2 EDITED')
    expect(text).toContain('line 9 EDITED')
  })
})

describe('GitManager.fetch and amend', () => {
  let repo: string
  let remote: string
  const manager = new GitManager(noopRoots)
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    if (remote) rmSync(remote, { recursive: true, force: true })
  })

  it('says so in words when there is no remote', async () => {
    repo = initRepo('flow-scm-fetch-')
    remote = ''
    const result = await manager.fetch(repo)
    expect(result).toEqual({ status: 'failed', detail: 'This repository has no remote to fetch from.' })
  })

  it('amends an unpublished commit, refuses a published one, and refuses without confirmation', async () => {
    remote = mkdtempSync(join(tmpdir(), 'flow-scm-remote-'))
    git(remote, 'init', '-q', '--bare')
    repo = initRepo('flow-scm-amend-')
    git(repo, 'remote', 'add', 'origin', remote)
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    expect(await manager.fetch(repo)).toEqual({ status: 'fetched' })

    // Published: refused, history untouched.
    const published = git(repo, 'rev-parse', 'HEAD').trim()
    await expect(manager.commitIndex(repo, 'rewrite', { amend: true, confirmed: true })).rejects.toThrow(
      /already published/,
    )
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(published)

    writeFileSync(join(repo, 'b.txt'), 'b\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'second')
    await expect(manager.commitIndex(repo, 'second, amended', { amend: true })).rejects.toThrow(
      /explicit confirmation/,
    )
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('second')
    await manager.commitIndex(repo, 'second, amended', { amend: true, confirmed: true })
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('second, amended')
    expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
  })
})
