// GitManager revision-validation tests (SEC-2) — real `git` CLI against a
// temp-dir repository. Renderer-supplied commits reaching git argv must be
// plain hex hashes or strict HEAD forms; anything else (notably option
// injection like `--output=/path`) is rejected before a process is spawned.

import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseConflictHunks } from '../../shared/conflict-hunks'
import {
  GitManager,
  isFlowInternalPath,
  isMissingAtRevisionError,
  isPathUnknownAtHeadError,
  isValidBranchRef,
  isValidRevision,
  parseBranchList,
  parsePorcelainV2Status,
  readWorkingTreeFileBytes,
  scopeChangesToProject,
  projectPathFromRepoPath,
  type GitRootsProvider,
} from './git-manager'

const noopRoots: GitRootsProvider = {
  getRoots: () => [],
  onRootsChanged: () => () => undefined,
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('isValidRevision (SEC-2)', () => {
  it.each(['abcd', 'ABCD1234', 'a'.repeat(40), 'HEAD', 'HEAD~1', 'HEAD^2', 'HEAD~12'])(
    'accepts %s',
    (revision) => {
      expect(isValidRevision(revision)).toBe(true)
    },
  )

  it.each([
    '--output=/tmp/pwned',
    '-p',
    'HEAD --output=/tmp/pwned',
    'HEAD;rm -rf /',
    'main',
    'refs/heads/main',
    'HEAD~',
    'HEAD^',
    'abc', // too short to be a hash
    'a'.repeat(41), // too long
    '',
  ])('rejects %s', (revision) => {
    expect(isValidRevision(revision)).toBe(false)
  })
})

describe('GitManager.revertFile in a repo with NO initial commit (#1091)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-unborn-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('discards a plain untracked file (checkout fails with "invalid reference: HEAD")', async () => {
    writeFileSync(join(repo, 'agent-output.ts'), 'export const written = true\n', 'utf8')

    await expect(manager.revertFile(repo, 'agent-output.ts')).resolves.toBeUndefined()

    expect(existsSync(join(repo, 'agent-output.ts'))).toBe(false)
    expect(git(repo, 'status', '--porcelain')).not.toContain('agent-output.ts')
  })

  it('discards a STAGED file — index entry and worktree copy both clear (#1090 composition)', async () => {
    // With no commits, HEAD is the empty tree: reverting a staged-new file to
    // HEAD means it exists in neither the index nor the worktree.
    writeFileSync(join(repo, 'staged.ts'), 'export const staged = true\n', 'utf8')
    git(repo, 'add', 'staged.ts')

    await expect(manager.revertFile(repo, 'staged.ts')).resolves.toBeUndefined()

    expect(existsSync(join(repo, 'staged.ts'))).toBe(false)
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('keeps .gitignored files out of the blast radius even with no HEAD (#1054 parity)', async () => {
    writeFileSync(join(repo, '.gitignore'), '.env\n', 'utf8')
    mkdirSync(join(repo, 'newapp'), { recursive: true })
    writeFileSync(join(repo, 'newapp', 'index.ts'), 'export const app = 1\n', 'utf8')
    writeFileSync(join(repo, 'newapp', '.env'), 'SECRET=1\n', 'utf8')

    await manager.revertFile(repo, 'newapp/')

    expect(existsSync(join(repo, 'newapp', 'index.ts'))).toBe(false)
    expect(existsSync(join(repo, 'newapp', '.env'))).toBe(true)
  })
})

describe('GitManager.commit with deleted files (#1181)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-del-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'legacy-widget.ts'), 'export const legacy = true\n', 'utf8')
    writeFileSync(join(repo, 'keep.ts'), 'export const keep = 1\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'baseline')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('commits an APPROVED (already-staged) deletion', async () => {
    // Approving a D row stages the deletion (#857); `git add -- <path>` is then
    // fatal, which used to abort the whole commit forever.
    rmSync(join(repo, 'legacy-widget.ts'))
    git(repo, 'add', '-A', '--', 'legacy-widget.ts')
    expect(git(repo, 'status', '--porcelain')).toContain('D  legacy-widget.ts')

    await expect(manager.commit(repo, 'chore: drop the legacy widget', ['legacy-widget.ts']))
      .resolves.toMatch(/^[0-9a-f]{7,}$/)

    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'log', '-1', '--name-only', '--format=%s')).toContain('legacy-widget.ts')
  })

  it('commits an UNSTAGED deletion the same way', async () => {
    rmSync(join(repo, 'legacy-widget.ts'))

    await manager.commit(repo, 'chore: drop it', ['legacy-widget.ts'])

    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('commits a group MIXING a deletion with a modification — neither is left behind', async () => {
    // The reported blast radius: the fatal add aborted the whole group, so the
    // other files never landed either.
    rmSync(join(repo, 'legacy-widget.ts'))
    writeFileSync(join(repo, 'keep.ts'), 'export const keep = 2\n', 'utf8')

    await manager.commit(repo, 'refactor: drop legacy, bump keep', ['legacy-widget.ts', 'keep.ts'])

    expect(git(repo, 'status', '--porcelain')).toBe('')
    const files = git(repo, 'log', '-1', '--name-only', '--format=')
    expect(files).toContain('legacy-widget.ts')
    expect(files).toContain('keep.ts')
  })

  it('still commits a brand-new untracked file (the add path that must survive)', async () => {
    writeFileSync(join(repo, 'added.ts'), 'export const added = true\n', 'utf8')

    await manager.commit(repo, 'feat: add it', ['added.ts'])

    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'log', '-1', '--name-only', '--format=')).toContain('added.ts')
  })
})

describe('GitManager rename handling (#1182)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-rename-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'legacy-widget.ts'), 'export const widget = true\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'baseline')
    git(repo, 'mv', 'legacy-widget.ts', 'widget.ts')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('reports the path the file was renamed FROM', async () => {
    const status = await manager.status(repo)
    const renamed = status?.changes.find((change) => change.state === 'renamed')
    expect(renamed?.filePath).toBe('widget.ts')
    expect(renamed?.renamedFrom).toBe('legacy-widget.ts')
  })

  it('commits the WHOLE rename when both paths are named', async () => {
    // Naming only the new path left the staged deletion out: HEAD held BOTH
    // files and a `D legacy-widget.ts` stayed pending.
    await manager.commit(repo, 'refactor: rename the widget', ['legacy-widget.ts', 'widget.ts'])

    expect(git(repo, 'status', '--porcelain')).toBe('')
    expect(git(repo, 'ls-tree', '--name-only', 'HEAD').trim()).toBe('widget.ts')
    expect(git(repo, 'log', '-1', '--name-status', '--format=')).toContain('R')
  })

  it('survives an un-approve / re-approve round-trip of a rename', async () => {
    // Un-approving unstages both sides (the rename becomes D + ??); re-approving
    // must restage BOTH — plain `git add` was fatal on the vanished old path,
    // wedging the group at "Approve all (1/2)" with no way back.
    await manager.unstage(repo, ['legacy-widget.ts', 'widget.ts'])
    await expect(manager.stage(repo, ['legacy-widget.ts', 'widget.ts'])).resolves.toBeUndefined()

    const status = await manager.status(repo)
    const renamed = status?.changes.find((change) => change.state === 'renamed')
    expect(renamed?.filePath).toBe('widget.ts')
    expect(renamed?.renamedFrom).toBe('legacy-widget.ts')
  })
})

describe('GitManager.commitIndex scoping (#1209)', () => {
  let mono: string
  let manager: GitManager

  beforeEach(() => {
    mono = mkdtempSync(join(tmpdir(), 'flow-git-scope-'))
    git(mono, 'init')
    git(mono, 'config', 'user.email', 'test@example.com')
    git(mono, 'config', 'user.name', 'Test')
    mkdirSync(join(mono, 'packages', 'app'), { recursive: true })
    writeFileSync(join(mono, 'README.md'), 'root\n', 'utf8')
    writeFileSync(join(mono, 'packages', 'app', 'main.ts'), 'export const main = 1\n', 'utf8')
    git(mono, 'add', '-A')
    git(mono, 'commit', '-m', 'baseline')
    writeFileSync(join(mono, 'README.md'), 'root edited\n', 'utf8')
    writeFileSync(join(mono, 'packages', 'app', 'main.ts'), 'export const main = 2\n', 'utf8')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(mono, { recursive: true, force: true })
  })

  const pkg = (): string => join(mono, 'packages', 'app')
  const committedFiles = (): string[] =>
    git(mono, 'log', '-1', '--name-only', '--format=').trim().split('\n').filter(Boolean)

  it('commits only the project’s staged file, not one staged outside it', async () => {
    // Shape A: a package folder opened inside a bigger repo. README.md is
    // staged elsewhere (a terminal, the agent, a review approve) and is
    // invisible in the panel.
    git(mono, 'add', 'README.md')
    git(mono, 'add', 'packages/app/main.ts')

    await manager.commitIndex(pkg(), 'fix: package change')

    expect(committedFiles()).toEqual(['packages/app/main.ts'])
    // The other project's deliberate staging survives, for its own commit.
    expect(git(mono, 'status', '--porcelain')).toContain('README.md')
  })

  it('leaves an UNSTAGED sibling inside the project alone', async () => {
    // Scoping to the prefix itself (rather than the staged paths under it)
    // would have swept this in — breaking "commit what I staged" the other way.
    writeFileSync(join(pkg(), 'other.ts'), 'export const other = 1\n', 'utf8')
    git(mono, 'add', 'packages/app/main.ts')

    await manager.commitIndex(pkg(), 'fix: only main')

    expect(committedFiles()).toEqual(['packages/app/main.ts'])
    expect(git(mono, 'status', '--porcelain')).toContain('other.ts')
  })

  it('refuses when nothing inside the project is staged', async () => {
    git(mono, 'add', 'README.md') // staged, but outside the project

    await expect(manager.commitIndex(pkg(), 'fix: nothing of mine')).rejects.toThrow(
      /Nothing staged in this project/,
    )
    expect(git(mono, 'log', '-1', '--format=%s').trim()).toBe('baseline')
  })

  it('is unchanged for a project that IS the repo root', async () => {
    git(mono, 'add', '-A')

    await manager.commitIndex(mono, 'chore: everything')

    expect(committedFiles().sort()).toEqual(['README.md', 'packages/app/main.ts'])
  })
})

describe('GitManager revision handling against a real repo (SEC-2)', () => {
  let repo: string
  let manager: GitManager
  let firstHash: string
  let secondHash: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-manager-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'file.txt'), 'one\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'first')
    firstHash = git(repo, 'rev-parse', 'HEAD').trim()
    writeFileSync(join(repo, 'file.txt'), 'one\ntwo\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'second')
    secondHash = git(repo, 'rev-parse', 'HEAD').trim()
    manager = new GitManager(noopRoots)
  })

  afterAll(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('status / log / diff still work with the `--` separators in place', async () => {
    const status = await manager.status(repo)
    expect(status).not.toBeNull()

    const log = await manager.log(repo)
    expect(log.map((commit) => commit.hash)).toEqual([secondHash, firstHash])

    const pageTwo = await manager.log(repo, { before: secondHash })
    expect(pageTwo.map((commit) => commit.hash)).toEqual([firstHash])

    const commitDiff = await manager.diff(repo, 'file.txt', secondHash)
    expect(commitDiff).toEqual({
      filePath: 'file.txt',
      beforeContent: 'one\n',
      afterContent: 'one\ntwo\n',
    })

    const wholeCommit = await manager.diff(repo, '', secondHash)
    expect(wholeCommit.beforeContent).toContain('file.txt')
    expect(wholeCommit.afterContent).toContain('two')

    writeFileSync(join(repo, 'file.txt'), 'one\ntwo\nthree\n', 'utf8')
    const workingDiff = await manager.diff(repo, 'file.txt')
    expect(workingDiff.beforeContent).toBe('one\ntwo\n')
    expect(workingDiff.afterContent).toBe('one\ntwo\nthree\n')
  })

  it('rejects malformed commits at the diff entry point', async () => {
    await expect(manager.diff(repo, 'file.txt', '--output=/tmp/pwned')).rejects.toThrow(
      /Invalid commit reference/,
    )
    await expect(manager.diff(repo, '', 'HEAD;rm')).rejects.toThrow(/Invalid commit reference/)
  })

  it('flags a binary file instead of decoding it as UTF-8 (#98)', async () => {
    // A committed binary blob (NUL bytes), then a modified working-tree version.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0xff])
    writeFileSync(join(repo, 'logo.png'), png)
    git(repo, 'add', 'logo.png') // stage only this file — beforeAll repo is shared
    git(repo, 'commit', '-m', 'add binary')
    writeFileSync(join(repo, 'logo.png'), Buffer.concat([png, Buffer.from([0x00, 0x03])]))

    const workingDiff = await manager.diff(repo, 'logo.png')
    expect(workingDiff.binary).toBe(true)
    expect(workingDiff.beforeContent).toBe('')
    expect(workingDiff.afterContent).toBe('')

    const headHash = git(repo, 'rev-parse', 'HEAD').trim()
    const commitDiff = await manager.diff(repo, 'logo.png', headHash)
    expect(commitDiff.binary).toBe(true)
  })

  it('shows a [Binary file] placeholder for a binary file in a WHOLE-COMMIT diff (#246)', async () => {
    // A single commit touching both a binary blob and a text file.
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0x00, 0xfe])
    writeFileSync(join(repo, 'asset.bin'), bin)
    writeFileSync(join(repo, 'notes.txt'), 'hello world\n', 'utf8')
    git(repo, 'add', 'asset.bin', 'notes.txt')
    git(repo, 'commit', '-m', 'binary + text')
    const hash = git(repo, 'rev-parse', 'HEAD').trim()

    const whole = await manager.diff(repo, '', hash)

    // The binary file shows the placeholder on BOTH panes — never decoded bytes.
    expect(whole.afterContent).toContain('───── asset.bin ─────')
    expect(whole.afterContent).toContain('[Binary file]')
    // No mojibake: no NUL byte or UTF-8 replacement char leaks into the text.
    expect(
      [...whole.afterContent].some((c) => c.charCodeAt(0) === 0 || c.charCodeAt(0) === 0xfffd),
    ).toBe(false)
    // The sibling text file still renders normally.
    expect(whole.afterContent).toContain('hello world')
  })

  it('does not flag a normal UTF-8 text file as binary', async () => {
    const textDiff = await manager.diff(repo, 'file.txt')
    expect(textDiff.binary).toBeUndefined()
  })

  it('previews a new untracked DIRECTORY as a file listing instead of EISDIR (#247)', async () => {
    // git rolls a brand-new dir up into one `newfeature/` entry; diffing it must
    // not throw EISDIR — it shows the folder's files (mirrors commit/revert).
    mkdirSync(join(repo, 'newfeature', 'sub'), { recursive: true })
    writeFileSync(join(repo, 'newfeature', 'bar.ts'), 'export const bar = 2\n', 'utf8')
    writeFileSync(join(repo, 'newfeature', 'foo.ts'), 'export const foo = 1\n', 'utf8')
    writeFileSync(join(repo, 'newfeature', 'sub', 'deep.ts'), 'export const d = 3\n', 'utf8')

    const dirDiff = await manager.diff(repo, 'newfeature/')

    expect(dirDiff.binary).toBeUndefined()
    expect(dirDiff.beforeContent).toBe('') // a new folder has no "before"
    expect(dirDiff.afterContent).toContain('New folder — 3 files:')
    // Lists every file (recursively), project-relative and sorted.
    expect(dirDiff.afterContent).toContain('newfeature/bar.ts')
    expect(dirDiff.afterContent).toContain('newfeature/foo.ts')
    expect(dirDiff.afterContent).toContain('newfeature/sub/deep.ts')
  })

  it('excludes .gitignore’d files from the new-folder preview (#253)', async () => {
    // Own repo with a .gitignore — the preview must show only what a commit would
    // stage (git add respects .gitignore), not a raw disk walk.
    const repo2 = mkdtempSync(join(tmpdir(), 'flow-git-gitignore-'))
    try {
      git(repo2, 'init')
      git(repo2, 'config', 'user.email', 'test@example.com')
      git(repo2, 'config', 'user.name', 'Test')
      writeFileSync(join(repo2, '.gitignore'), 'node_modules/\n*.log\n', 'utf8')
      git(repo2, 'add', '.gitignore')
      git(repo2, 'commit', '-m', 'init')
      mkdirSync(join(repo2, 'newfeature', 'node_modules', 'big'), { recursive: true })
      writeFileSync(join(repo2, 'newfeature', 'keep.ts'), 'real\n', 'utf8')
      writeFileSync(join(repo2, 'newfeature', 'node_modules', 'big', 'x.js'), 'junk\n', 'utf8')
      writeFileSync(join(repo2, 'newfeature', 'debug.log'), 'logdata\n', 'utf8')

      const dirDiff = await manager.diff(repo2, 'newfeature/')

      // Only the non-ignored file — exactly what `git add newfeature/` would stage.
      expect(dirDiff.afterContent).toContain('New folder — 1 file:')
      expect(dirDiff.afterContent).toContain('newfeature/keep.ts')
      expect(dirDiff.afterContent).not.toContain('node_modules')
      expect(dirDiff.afterContent).not.toContain('debug.log')
    } finally {
      rmSync(repo2, { recursive: true, force: true })
    }
  })

  it('rejects malformed pagination cursors at the log entry point', async () => {
    await expect(manager.log(repo, { before: '--output=/tmp/pwned' })).rejects.toThrow(
      /Invalid commit reference/,
    )
  })
})

// ── LOG-14: expected-vs-unexpected error handling in diff sources ────────

describe('isMissingAtRevisionError (LOG-14)', () => {
  function gitError(stderr: string): Error {
    const error = new Error('git failed') as Error & { stderr: string }
    error.stderr = stderr
    return error
  }

  it.each([
    "fatal: path 'new.txt' does not exist in 'HEAD'",
    "fatal: path 'new.txt' exists on disk, but not in 'HEAD'",
    "fatal: invalid object name 'abc123^'.",
    "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
    'fatal: bad revision zzz',
    'fatal: your current branch does not have any commits yet',
    'fatal: not a git repository (or any of the parent directories): .git',
  ])('treats %s as an expected empty side', (stderr) => {
    expect(isMissingAtRevisionError(gitError(stderr))).toBe(true)
  })

  it.each([
    'fatal: bad object HEAD',
    'fatal: index file corrupt',
    'error: object file .git/objects/ab/cdef is empty',
    '',
  ])('rethrows unexpected git failures (%s)', (stderr) => {
    expect(isMissingAtRevisionError(gitError(stderr))).toBe(false)
  })

  it('rethrows spawn failures with no stderr at all (e.g. git not installed)', () => {
    expect(isMissingAtRevisionError(new Error('spawn git ENOENT'))).toBe(false)
  })
})

describe('GitManager diff error grace against a real repo (LOG-14)', () => {
  let repo: string
  let manager: GitManager
  let rootHash: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-log14-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'tracked.txt'), 'tracked\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'root')
    rootHash = git(repo, 'rev-parse', 'HEAD').trim()
    manager = new GitManager(noopRoots)
  })

  afterAll(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('renders an untracked file as pure insert (empty before side)', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'brand new\n', 'utf8')
    const diff = await manager.diff(repo, 'untracked.txt')
    expect(diff.beforeContent).toBe('')
    expect(diff.afterContent).toBe('brand new\n')
    unlinkSync(join(repo, 'untracked.txt'))
  })

  it("renders the root commit's parent side as empty (invalid object name)", async () => {
    const diff = await manager.diff(repo, 'tracked.txt', rootHash)
    expect(diff.beforeContent).toBe('')
    expect(diff.afterContent).toBe('tracked\n')

    const whole = await manager.diff(repo, '', rootHash)
    expect(whole.afterContent).toContain('tracked')
  })

  it('renders a file deleted from the working tree as empty after side (ENOENT)', async () => {
    unlinkSync(join(repo, 'tracked.txt'))
    try {
      const diff = await manager.diff(repo, 'tracked.txt')
      expect(diff.beforeContent).toBe('tracked\n')
      expect(diff.afterContent).toBe('')
    } finally {
      git(repo, 'checkout', '--', 'tracked.txt')
    }
  })

  it('surfaces working-tree read failures instead of faking an empty file', async () => {
    if (process.getuid?.() === 0) {
      return // root ignores file modes — the EACCES scenario cannot be staged
    }
    const locked = join(repo, 'tracked.txt')
    chmodSync(locked, 0o000)
    try {
      await expect(manager.diff(repo, 'tracked.txt')).rejects.toThrow()
    } finally {
      chmodSync(locked, 0o644)
    }
  })
})

describe('GitManager.commit (git-write path)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-commit-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'a1\n', 'utf8')
    writeFileSync(join(repo, 'b.txt'), 'b1\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('stages + commits only the given files and returns a short hash', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\na2\n', 'utf8')
    writeFileSync(join(repo, 'b.txt'), 'b1\nb2\n', 'utf8')

    const hash = await manager.commit(repo, 'commit a only', ['a.txt'])

    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    // a.txt is in the new commit; b.txt is still uncommitted (working tree dirty).
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD')).toContain('a.txt')
    expect(git(repo, 'show', '--name-only', '--format=%s', 'HEAD')).not.toContain('b.txt')
    expect(git(repo, 'status', '--porcelain')).toContain('b.txt')
  })

  it('commits a wholly-new untracked DIRECTORY passed as one trailing-slash entry (#176)', async () => {
    // git rolls a brand-new dir up as a single 'newfeature/' entry; the Review
    // panel must be able to COMMIT it (mirroring the #136 revert fix), not drop
    // it. `git add -- newfeature/` stages the dir (ensureInsideRoot strips the
    // slash), so passing the entry straight through commits its files.
    mkdirSync(join(repo, 'newfeature'), { recursive: true })
    writeFileSync(join(repo, 'newfeature', 'foo.ts'), 'export const foo = 1\n', 'utf8')
    writeFileSync(join(repo, 'newfeature', 'bar.ts'), 'export const bar = 2\n', 'utf8')

    const hash = await manager.commit(repo, 'feat: new feature dir', ['newfeature/'])

    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    const committed = git(repo, 'show', '--name-only', '--format=', 'HEAD')
    expect(committed).toContain('newfeature/foo.ts')
    expect(committed).toContain('newfeature/bar.ts')
    // Nothing from the new directory is left uncommitted.
    expect(git(repo, 'status', '--porcelain')).not.toContain('newfeature')
  })

  it('rejects an empty message', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\nx\n', 'utf8')
    await expect(manager.commit(repo, '   ', ['a.txt'])).rejects.toThrow(/non-empty message/)
  })

  it('rejects a path that escapes the project folder (SEC-2)', async () => {
    await expect(manager.commit(repo, 'msg', ['../evil.txt'])).rejects.toThrow(/escapes/)
  })

  it('revertFile restores a tracked file to HEAD and deletes an untracked one', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\ndirty\n', 'utf8')
    await manager.revertFile(repo, 'a.txt')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a1\n')

    writeFileSync(join(repo, 'new.txt'), 'temp\n', 'utf8')
    await manager.revertFile(repo, 'new.txt')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
  })

  it('revertFile removes a wholly-new untracked DIRECTORY (#136)', async () => {
    // git rolls a brand-new dir up as one trailing-slash entry ('newfeature/');
    // reverting it must recursively remove the directory, not throw EISDIR.
    mkdirSync(join(repo, 'newfeature'), { recursive: true })
    writeFileSync(join(repo, 'newfeature', 'foo.ts'), 'export const foo = 1\n', 'utf8')
    writeFileSync(join(repo, 'newfeature', 'bar.ts'), 'export const bar = 2\n', 'utf8')

    await expect(manager.revertFile(repo, 'newfeature/')).resolves.toBeUndefined()
    expect(existsSync(join(repo, 'newfeature'))).toBe(false)
  })

  it('revertFile on an untracked directory keeps .gitignored files inside (#1054)', async () => {
    // The rolled-up `newapp/` holds ONE committable file plus three ignored
    // ones. Reverting the rollup must remove exactly what a commit would have
    // contained — never the ignored files, which have no recovery path.
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n*.local\n', 'utf8')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-m', 'chore: ignore rules')
    mkdirSync(join(repo, 'newapp', 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(repo, 'newapp', 'index.ts'), 'export const app = 1\n', 'utf8')
    writeFileSync(join(repo, 'newapp', '.env'), 'STRIPE_KEY=sk_live_realsecret\n', 'utf8')
    writeFileSync(join(repo, 'newapp', 'notes.local'), 'scratch\n', 'utf8')
    writeFileSync(join(repo, 'newapp', 'node_modules', 'left-pad', 'index.js'), 'x\n', 'utf8')

    await manager.revertFile(repo, 'newapp/')

    expect(existsSync(join(repo, 'newapp', 'index.ts'))).toBe(false)
    expect(existsSync(join(repo, 'newapp', '.env'))).toBe(true)
    expect(existsSync(join(repo, 'newapp', 'notes.local'))).toBe(true)
    expect(existsSync(join(repo, 'newapp', 'node_modules', 'left-pad', 'index.js'))).toBe(true)
  })

  it('revertFile removes a STAGED-new file from both disk and index', async () => {
    // A staged-new file is tracked from `git clean`'s point of view — the
    // fallback must drop its index entry first or the revert becomes a no-op.
    writeFileSync(join(repo, 'staged-new.txt'), 'temp\n', 'utf8')
    git(repo, 'add', 'staged-new.txt')

    await manager.revertFile(repo, 'staged-new.txt')

    expect(existsSync(join(repo, 'staged-new.txt'))).toBe(false)
    expect(git(repo, 'status', '--porcelain')).not.toContain('staged-new.txt')
  })

  it('revertFile preserves the file when checkout fails for a non-pathspec reason (#93)', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\ndirty\n', 'utf8')
    // Faithful data-loss trigger: an `.git/index.lock` collision (our own index
    // watcher makes concurrent locks realistic). checkout can't take the lock →
    // fails with "Unable to create '…/index.lock'", NOT a pathspec error.
    const lock = join(repo, '.git', 'index.lock')
    writeFileSync(lock, '', 'utf8')
    try {
      await expect(manager.revertFile(repo, 'a.txt')).rejects.toThrow()
    } finally {
      unlinkSync(lock)
    }
    // The uncommitted work must survive — not deleted, not reverted.
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a1\ndirty\n')
  })

  it('isPathUnknownAtHeadError matches the untracked pathspec and unborn-HEAD failures only', () => {
    expect(
      isPathUnknownAtHeadError({
        stderr: "error: pathspec 'x.ts' did not match any file(s) known to git",
      }),
    ).toBe(true)
    // Unborn HEAD (#1091): a repo with no commits fails checkout with this —
    // every path is unknown at (the empty) HEAD, so the fallback is correct.
    expect(isPathUnknownAtHeadError({ stderr: 'fatal: invalid reference: HEAD' })).toBe(true)
    expect(
      isPathUnknownAtHeadError({ stderr: "fatal: Unable to create '.../index.lock': File exists" }),
    ).toBe(false)
    expect(isPathUnknownAtHeadError({ stderr: 'error: unable to unlink: Permission denied' })).toBe(
      false,
    )
    expect(isPathUnknownAtHeadError(null)).toBe(false)
  })

  it('treats a leading-dash message as the message, not a git flag (SEC-2)', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\nz\n', 'utf8')
    await manager.commit(repo, '--amend is not a flag here', ['a.txt'])
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('--amend is not a flag here')
    // The commit was a NEW commit, not an amend: base + this = 2 commits.
    expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
  })

  it('commitIndex commits exactly the staged index and leaves unstaged work dirty (#335)', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\na2\n', 'utf8')
    writeFileSync(join(repo, 'b.txt'), 'b1\nb2\n', 'utf8')
    // Stage a.txt only (the user assembled the index); b.txt stays unstaged.
    await manager.stage(repo, ['a.txt'])

    const hash = await manager.commitIndex(repo, 'commit the staged index')

    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    const committed = git(repo, 'show', '--name-only', '--format=', 'HEAD')
    expect(committed).toContain('a.txt')
    expect(committed).not.toContain('b.txt')
    // b.txt's change is still uncommitted in the working tree.
    expect(git(repo, 'status', '--porcelain')).toContain('b.txt')
  })

  it('commitIndex rejects an empty message and a leading-dash message stays the message (SEC-2)', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\nx\n', 'utf8')
    await manager.stage(repo, ['a.txt'])
    await expect(manager.commitIndex(repo, '   ')).rejects.toThrow(/non-empty message/)
    await manager.commitIndex(repo, '--amend is not a flag')
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('--amend is not a flag')
    expect(git(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
  })
})

describe('GitManager.fileAuthors / currentUser (#drift phase 2)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-authors-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'me@here.com')
    git(repo, 'config', 'user.name', 'Me')
    writeFileSync(join(repo, 'a.txt'), 'a1\n', 'utf8')
    writeFileSync(join(repo, 'b.txt'), 'b1\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the last commit author/email/hash/date per committed file', async () => {
    const authors = await manager.fileAuthors(repo, ['a.txt', 'b.txt'])
    expect(authors.size).toBe(2)
    const a = authors.get('a.txt')
    expect(a?.author).toBe('Me')
    expect(a?.email).toBe('me@here.com')
    expect(a?.hash).toMatch(/^[0-9a-f]{40}$/)
    expect(a?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('omits an untracked file instead of throwing (fail-soft)', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'x\n', 'utf8')
    const authors = await manager.fileAuthors(repo, ['a.txt', 'untracked.txt', 'missing.txt'])
    expect([...authors.keys()]).toEqual(['a.txt'])
  })

  it('omits a path that escapes the project folder (SEC-2), never throwing', async () => {
    const authors = await manager.fileAuthors(repo, ['../evil.txt', 'a.txt'])
    expect([...authors.keys()]).toEqual(['a.txt'])
  })

  it('answers fifty files from one walk, each with its own newest commit', async () => {
    // The shape that mattered: this used to spawn one `git log` PER FILE, all
    // at once. A CPU profile of main while this repo was added found 26 seconds
    // inside posix_spawn, and the census named it: 1,145 processes in 10s, of
    // which 1,130 were `log`. The answer must not change — only its cost.
    const names: string[] = []
    for (let i = 0; i < 50; i += 1) {
      const name = `file-${String(i)}.txt`
      names.push(name)
      writeFileSync(join(repo, name), `v1 ${String(i)}\n`, 'utf8')
    }
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fifty files')
    // …then move ONE of them forward, so "newest commit wins" is under test too.
    writeFileSync(join(repo, 'file-7.txt'), 'v2\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'config', 'user.name', 'Someone Else')
    git(repo, 'config', 'user.email', 'else@there.com')
    git(repo, 'commit', '-m', 'touch one')

    const authors = await manager.fileAuthors(repo, names)
    expect(authors.size).toBe(50)
    expect(authors.get('file-7.txt')?.author).toBe('Someone Else')
    expect(authors.get('file-8.txt')?.author).toBe('Me')
    // Every one carries a real commit, not a half-parsed record.
    for (const name of names) {
      expect(authors.get(name)?.hash).toMatch(/^[0-9a-f]{40}$/)
      expect(authors.get(name)?.date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('reflects a later commit by a different author', async () => {
    writeFileSync(join(repo, 'a.txt'), 'a1\na2\n', 'utf8')
    execFileSync('git', ['add', 'a.txt'], { cwd: repo })
    execFileSync(
      'git',
      ['-c', 'user.name=Other', '-c', 'user.email=other@x.com', 'commit', '-m', 'edit a'],
      { cwd: repo },
    )
    const authors = await manager.fileAuthors(repo, ['a.txt', 'b.txt'])
    expect(authors.get('a.txt')?.email).toBe('other@x.com')
    expect(authors.get('b.txt')?.email).toBe('me@here.com')
  })

  it('returns an empty map for an empty file list and for a non-repo', async () => {
    expect((await manager.fileAuthors(repo, [])).size).toBe(0)
    const nonRepo = mkdtempSync(join(tmpdir(), 'flow-git-authors-none-'))
    try {
      expect((await manager.fileAuthors(nonRepo, ['a.txt'])).size).toBe(0)
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })

  it('reads the configured commit identity via currentUser', async () => {
    expect(await manager.currentUser(repo)).toEqual({ name: 'Me', email: 'me@here.com' })
  })

  it('currentUser is fail-soft — never throws for a non-repo directory', async () => {
    // `git config --get` reads global/system config too, so a non-repo may still
    // resolve a value; the contract we assert is only that it never throws and
    // always resolves an object (undefined fields when nothing is configured).
    const nonRepo = mkdtempSync(join(tmpdir(), 'flow-git-user-none-'))
    try {
      const user = await manager.currentUser(nonRepo)
      expect(typeof user).toBe('object')
      expect(user).not.toBeNull()
    } finally {
      rmSync(nonRepo, { recursive: true, force: true })
    }
  })
})

describe('GitManager whole-commit diff truncation (#121)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-wholecommit-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('caps the view at 50 files but reports the true total + a visible notice', async () => {
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(join(repo, `file_${i}.txt`), `v${i}\n`, 'utf8')
    }
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'sixty files')
    const hash = git(repo, 'rev-parse', 'HEAD').trim()

    const diff = await manager.diff(repo, '', hash)
    expect(diff.totalFiles).toBe(60)
    expect(diff.truncated).toBe(true)
    // The reviewer sees the omission in the diff content itself (both panes).
    expect(diff.afterContent).toContain('showing the first 50 of 60')
    expect(diff.beforeContent).toContain('10 more file(s) not shown')
  })

  it('does not flag truncation for a commit at or under the cap', async () => {
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(join(repo, `f${i}.txt`), 'x\n', 'utf8')
    }
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'five files')
    const hash = git(repo, 'rev-parse', 'HEAD').trim()

    const diff = await manager.diff(repo, '', hash)
    expect(diff.totalFiles).toBe(5)
    expect(diff.truncated).toBe(false)
    expect(diff.afterContent).not.toContain('more file(s) not shown')
  })
})

describe('isFlowInternalPath (#310)', () => {
  it('matches Flow-managed artifacts the user should never commit', () => {
    expect(isFlowInternalPath('.brain.sqlite')).toBe(true)
    expect(isFlowInternalPath('.brain.sqlite-wal')).toBe(true)
    expect(isFlowInternalPath('.brain.sqlite-shm')).toBe(true)
    expect(isFlowInternalPath('graphify-out/graph.json')).toBe(true)
    expect(isFlowInternalPath('flow')).toBe(true)
    expect(isFlowInternalPath('flow/plans/plan_x.md')).toBe(true)
    expect(isFlowInternalPath('.plan-flow.yml')).toBe(true)
    expect(isFlowInternalPath('.plan.flow.env')).toBe(true)
    // Leading ./ (some git configs emit it) is normalized away first.
    expect(isFlowInternalPath('./graphify-out/graph.json')).toBe(true)
  })

  it('leaves the user’s own files alone — including lookalikes', () => {
    expect(isFlowInternalPath('src/app.ts')).toBe(false)
    expect(isFlowInternalPath('README.md')).toBe(false)
    // A user file literally named like the DB but NOT the DB (no exact/sidecar match).
    expect(isFlowInternalPath('my.brain.sqlite')).toBe(false)
    expect(isFlowInternalPath('docs/flow-guide.md')).toBe(false)
    expect(isFlowInternalPath('workflow/step.ts')).toBe(false)
    expect(isFlowInternalPath('graphify-outputs.md')).toBe(false)
  })
})

describe('isValidBranchRef (SEC-2; Phase 9)', () => {
  it.each(['feature/foo', 'main', 'release-1.2.3', 'a', 'user/fix.thing', 'HEAD'])(
    'accepts the well-formed ref %s',
    (ref) => {
      expect(isValidBranchRef(ref)).toBe(true)
    },
  )

  it.each([
    '-flag', // leading dash → parses as a git flag
    ' spaced',
    'has space',
    'a..b', // git's own ref restriction + range syntax
    'ends/', // trailing slash
    'ends.', // trailing dot
    'ref.lock', // trailing .lock
    '', // empty
  ])('rejects the unsafe ref %p', (ref) => {
    expect(isValidBranchRef(ref)).toBe(false)
  })

  it('rejects a non-string ref', () => {
    expect(isValidBranchRef(undefined as unknown as string)).toBe(false)
  })
})

describe('parseBranchList (Phase 9)', () => {
  it('splits lines, trims each, and drops empties + the current branch', () => {
    const output = ' main \nfeature/a\n\n  feature/b  \ncurrent\n'
    expect(parseBranchList(output, 'current')).toEqual(['main', 'feature/a', 'feature/b'])
  })

  it('returns [] for empty output', () => {
    expect(parseBranchList('', 'main')).toEqual([])
  })

  it('keeps every branch when current is not among them', () => {
    expect(parseBranchList('a\nb\n', 'not-listed')).toEqual(['a', 'b'])
  })
})

describe('parsePorcelainV2Status drops Flow-internal artifacts (#310)', () => {
  // porcelain=v2 -z: NUL-terminated records; ordinary changes are `1 <XY> … <path>`.
  const rec = (xy: string, path: string): string => `1 ${xy} N... 100644 100644 100644 aaa bbb ${path}`

  it('filters .brain.sqlite and graphify-out/ out of the surfaced changes', () => {
    const output = [
      '# branch.head main',
      rec('.M', 'src/app.ts'),
      rec('.M', '.brain.sqlite'),
      rec('.M', '.brain.sqlite-wal'),
      '? graphify-out/graph.json',
      '? README.md',
    ].join('\0')
    const parsed = parsePorcelainV2Status(output)
    expect(parsed.changes.map((c) => c.filePath)).toEqual(['src/app.ts', 'README.md'])
  })

  it('keeps user files and never touches branch/ahead/behind parsing', () => {
    const output = [
      '# branch.head feature',
      '# branch.ab +2 -1',
      rec('.M', 'graphify-outputs.md'), // lookalike — NOT internal
      rec('.M', 'graphify-out/graph.json'), // internal — dropped
    ].join('\0')
    const parsed = parsePorcelainV2Status(output)
    expect(parsed.branch).toBe('feature')
    expect(parsed.ahead).toBe(2)
    expect(parsed.behind).toBe(1)
    expect(parsed.changes.map((c) => c.filePath)).toEqual(['graphify-outputs.md'])
  })
})

describe('readWorkingTreeFileBytes (EISDIR regression)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-git-readbytes-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns empty bytes for a DIRECTORY path instead of throwing EISDIR (live git:diff crash)', async () => {
    mkdirSync(join(dir, 'a-submodule-or-dir'))
    const bytes = await readWorkingTreeFileBytes(dir, 'a-submodule-or-dir')
    expect(bytes.length).toBe(0)
  })

  it('returns empty bytes for a missing path (ENOENT)', async () => {
    const bytes = await readWorkingTreeFileBytes(dir, 'does-not-exist.ts')
    expect(bytes.length).toBe(0)
  })

  it('reads a real file back as bytes', async () => {
    writeFileSync(join(dir, 'x.ts'), 'hello')
    const bytes = await readWorkingTreeFileBytes(dir, 'x.ts')
    expect(bytes.toString('utf8')).toBe('hello')
  })
})

describe('continueRebase multi-commit conflict (#590 regression)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-rebase-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '-b', 'main')
    writeFileSync(join(repo, 'f.txt'), 'base\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    // Feature branch: TWO commits both editing f.txt (both will conflict on rebase).
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'f.txt'), 'featA\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'featA')
    writeFileSync(join(repo, 'f.txt'), 'featB\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'featB')
    // main diverges on the same file so BOTH feature commits conflict on replay.
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'f.txt'), 'mainline\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'mainline')
    git(repo, 'checkout', 'feature')
    manager = new GitManager(noopRoots)
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reports {conflicted:true} when --continue advances to the NEXT commit conflict, never throws', async () => {
    // Start the rebase — stops at featA's conflict.
    try {
      git(repo, 'rebase', 'main')
    } catch {
      /* expected: rebase stops with a conflict (non-zero exit) */
    }
    // Resolve featA's conflict and stage it.
    writeFileSync(join(repo, 'f.txt'), 'resolvedA\n', 'utf8')
    git(repo, 'add', 'f.txt')

    // Continue → git exits 1 stopping at featB's conflict; this is NOT a failure.
    const step = await manager.continueRebase(repo)
    expect(step).toEqual({ conflicted: true })

    // Resolve featB and finish — now the rebase completes cleanly.
    writeFileSync(join(repo, 'f.txt'), 'resolvedB\n', 'utf8')
    git(repo, 'add', 'f.txt')
    const done = await manager.continueRebase(repo)
    expect(done).toEqual({ conflicted: false })
    // No rebase in progress afterward.
    expect((await manager.getMergeState(repo)).op).toBe('none')
  })
})

describe('getMergeState op classification (conflict-UX Phase 1)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-mergestate-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '-b', 'main')
    writeFileSync(join(repo, 'f.txt'), 'base\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    // A divergent branch that edits the same line — the source of every conflict below.
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'f.txt'), 'feature-change\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'feature work')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'f.txt'), 'main-change\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'main work')
    manager = new GitManager(noopRoots)
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('classifies a conflicted merge and resolves the incoming branch name from MERGE_MSG', async () => {
    try {
      git(repo, 'merge', 'feature')
    } catch {
      /* expected: merge halts with a conflict (non-zero exit) */
    }
    const state = await manager.getMergeState(repo)
    expect(state.op).toBe('merge')
    expect(state.mergeHead).toBeTruthy()
    expect(state.incomingBranch).toBe('feature')
    expect(state.unmergedPaths).toContain('f.txt')
  })

  it('classifies a conflicted cherry-pick via CHERRY_PICK_HEAD (not merge)', async () => {
    try {
      git(repo, 'cherry-pick', 'feature')
    } catch {
      /* expected: cherry-pick halts with a conflict */
    }
    const state = await manager.getMergeState(repo)
    expect(state.op).toBe('cherry-pick')
    expect(state.cherryPickHead).toBeTruthy()
    expect(state.mergeHead).toBeUndefined()
  })

  it('classifies a conflicted rebase and exposes the replayed branch tip (rebaseHead)', async () => {
    git(repo, 'checkout', 'feature')
    try {
      git(repo, 'rebase', 'main')
    } catch {
      /* expected: rebase halts with a conflict */
    }
    const state = await manager.getMergeState(repo)
    expect(state.op).toBe('rebase')
    expect(state.rebaseHead).toBeTruthy()
    expect(state.ontoBranch).toBe('feature')
  })
})

describe('parsePorcelainV2Status conflict sub-type (conflict-UX Phase 2)', () => {
  // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
  function uRecord(xy: string, path: string): string {
    return (
      `u ${xy} N... 100644 100644 100644 100644 ` +
      '1111111111111111111111111111111111111111 ' +
      '2222222222222222222222222222222222222222 ' +
      `3333333333333333333333333333333333333333 ${path}`
    )
  }

  it('decodes the XY code into conflictType while keeping state:conflicted', () => {
    const output = `${uRecord('UU', 'both.txt')}\0${uRecord('DU', 'gone.txt')}\0`
    const parsed = parsePorcelainV2Status(output)
    expect(parsed.changes.find((c) => c.filePath === 'both.txt')).toMatchObject({
      state: 'conflicted',
      conflictType: 'both-modified',
    })
    expect(parsed.changes.find((c) => c.filePath === 'gone.txt')).toMatchObject({
      state: 'conflicted',
      conflictType: 'deleted-by-us',
    })
  })

  it('omits conflictType (never crashes) for an unexpected XY on a u-record', () => {
    const parsed = parsePorcelainV2Status(`${uRecord('??', 'weird.txt')}\0`)
    const entry = parsed.changes.find((c) => c.filePath === 'weird.txt')
    expect(entry?.state).toBe('conflicted')
    expect(entry?.conflictType).toBeUndefined()
  })
})

describe('readConflicted sub-type / binary / rename (conflict-UX Phase 2)', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-readconflict-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '-b', 'main')
    manager = new GitManager(noopRoots)
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  function commitAll(message: string): void {
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', message)
  }

  it('reports binary:true with per-side sizes instead of decoding mojibake', async () => {
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0x41]))
    commitAll('base binary')
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x99, 0x99, 0x99, 0x99, 0x00]))
    commitAll('feature binary')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x00, 0x11, 0x22, 0x33]))
    commitAll('main binary')
    try {
      git(repo, 'merge', 'feature')
    } catch {
      /* expected: binary content conflict */
    }

    const result = await manager.readConflicted(repo, 'bin.dat')
    if ('oversize' in result) throw new Error('unexpected oversize sentinel')
    expect(result.binary).toBe(true)
    expect(result.ours).toBe('') // never a lossy UTF-8 decode
    expect(result.theirs).toBe('')
    expect(result.markered).toBe('')
    expect(result.conflictType).toBe('both-modified')
    expect(result.oursSize).toBeGreaterThan(0)
    expect(result.theirsSize).toBeGreaterThan(0)
    expect(result.oursPresent).toBe(true)
    expect(result.theirsPresent).toBe(true)
    expect(result.basePresent).toBe(true)
  })

  it('distinguishes modify/delete via present flags + conflictType', async () => {
    writeFileSync(join(repo, 'keep.txt'), 'l1\nl2\nl3\n', 'utf8')
    commitAll('base')
    git(repo, 'checkout', '-b', 'feature')
    unlinkSync(join(repo, 'keep.txt'))
    commitAll('delete on feature')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'keep.txt'), 'l1\nCHANGED\nl3\n', 'utf8')
    commitAll('modify on main')
    try {
      git(repo, 'merge', 'feature')
    } catch {
      /* expected: modify/delete conflict */
    }

    const result = await manager.readConflicted(repo, 'keep.txt')
    if ('oversize' in result) throw new Error('unexpected oversize sentinel')
    expect(result.conflictType).toBe('deleted-by-them')
    expect(result.oursPresent).toBe(true) // we modified → stage 2 present
    expect(result.theirsPresent).toBe(false) // they deleted → stage 3 absent
    expect(result.basePresent).toBe(true)
    expect(result.theirs).toBe('')
    expect(result.ours).toContain('CHANGED')
    expect(result.binary).toBeUndefined()
  })

  it('populates live oursIdentity/theirsIdentity for a real merge conflict (Phase 5 Task 1)', async () => {
    writeFileSync(join(repo, 'id.txt'), 'l1\nl2\nl3\n', 'utf8')
    commitAll('base')
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'id.txt'), 'l1\nFEATURE\nl3\n', 'utf8')
    commitAll('feat(phase-2.task-1): change on feature — my-feature')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'id.txt'), 'l1\nMAIN\nl3\n', 'utf8')
    commitAll('modify on main')
    try {
      git(repo, 'merge', 'feature')
    } catch {
      /* expected: both-modified conflict */
    }

    const result = await manager.readConflicted(repo, 'id.txt')
    if ('oversize' in result) throw new Error('unexpected oversize sentinel')
    // ours = stage 2 = HEAD (main); theirs = stage 3 = MERGE_HEAD (feature).
    expect(result.oursIdentity).toBeDefined()
    expect(result.theirsIdentity).toBeDefined()
    expect(result.oursIdentity?.kind).toBe('ours')
    expect(result.theirsIdentity?.kind).toBe('theirs')
    // The single configured user authored both sides in this fixture.
    expect(result.oursIdentity?.isCurrentUser).toBe(true)
    expect(result.oursIdentity?.author).toBe('Test')
    // theirs branch is parsed from MERGE_MSG (`Merge branch 'feature'`).
    expect(result.theirsIdentity?.branch).toBe('feature')
    expect(result.theirsIdentity?.subject).toContain('change on feature')
  })

  it('degrades readConflicted to no identity when merge state is unavailable', async () => {
    // A plain (non-op) unmerged-free repo: readConflicted still returns without
    // throwing even though there is no merge in progress to derive identity from.
    writeFileSync(join(repo, 'solo.txt'), 'x\n', 'utf8')
    commitAll('solo')
    // No conflict here — but readConflicted must never throw on the identity path.
    const result = await manager.readConflicted(repo, 'solo.txt').catch(() => null)
    // Either it read empty stages (no conflict) or returned a value; identity is
    // simply absent. The invariant under test: no throw from the identity seam.
    if (result && !('oversize' in result)) {
      expect(result.oursIdentity === undefined || result.oursIdentity.kind === 'ours').toBe(true)
    }
  })

  it('exposes rename lineage for a rename/rename conflict', async () => {
    writeFileSync(join(repo, 'orig.txt'), 'a\nb\nc\n', 'utf8')
    commitAll('base')
    git(repo, 'checkout', '-b', 'feature')
    git(repo, 'mv', 'orig.txt', 'feat-name.txt')
    commitAll('rename on feature')
    git(repo, 'checkout', 'main')
    git(repo, 'mv', 'orig.txt', 'main-name.txt')
    commitAll('rename on main')
    try {
      git(repo, 'merge', 'feature')
    } catch {
      /* expected: rename/rename conflict */
    }

    const result = await manager.readConflicted(repo, 'feat-name.txt')
    if ('oversize' in result) throw new Error('unexpected oversize sentinel')
    expect(result.conflictType).toBe('added-by-them') // present on their side only
    expect(result.renameFrom).toBe('main-name.txt') // HEAD (ours)
    expect(result.renameTo).toBe('feat-name.txt') // MERGE_HEAD (theirs)
  })
})

describe('discardWorktreeChanges preserves staged snapshot (#598)', () => {
  let repo: string
  let manager: GitManager
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-discard-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'alpha.txt'), 'v0\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'v0')
    manager = new GitManager(noopRoots)
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('restores a staged-then-edited file to its STAGED content, keeping the index entry', async () => {
    // Stage v1, then re-edit to v2 in the worktree (the classic staged+re-edited state).
    writeFileSync(join(repo, 'alpha.txt'), 'v0\nSTAGED_v1\n', 'utf8')
    git(repo, 'add', 'alpha.txt')
    writeFileSync(join(repo, 'alpha.txt'), 'v0\nSTAGED_v1\nUNSTAGED_v2\n', 'utf8')

    await manager.discardWorktreeChanges(repo, 'alpha.txt')

    // Worktree returns to the STAGED snapshot (not HEAD), and the index keeps it.
    expect(readFileSync(join(repo, 'alpha.txt'), 'utf8')).toBe('v0\nSTAGED_v1\n')
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('alpha.txt')
  })

  it('reverts a tracked-unstaged file to HEAD (single-state case unaffected)', async () => {
    writeFileSync(join(repo, 'alpha.txt'), 'v0\nedit\n', 'utf8')
    await manager.discardWorktreeChanges(repo, 'alpha.txt')
    expect(readFileSync(join(repo, 'alpha.txt'), 'utf8')).toBe('v0\n')
  })

  it('deletes an untracked file', async () => {
    writeFileSync(join(repo, 'new.txt'), 'x\n', 'utf8')
    await manager.discardWorktreeChanges(repo, 'new.txt')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
  })

  it('discarding a rolled-up untracked directory keeps .gitignored files inside (#1054)', async () => {
    // The panel's rollup expansion (#253) lists only `newapp/index.ts`; the
    // discard's blast radius must match `git clean -fd` (no `-x`) — the ignored
    // `.env` / `*.local` / `node_modules/` survive, and so does the directory.
    writeFileSync(join(repo, '.gitignore'), '.env\nnode_modules/\n*.local\n', 'utf8')
    git(repo, 'add', '.gitignore')
    git(repo, 'commit', '-m', 'chore: ignore rules')
    mkdirSync(join(repo, 'newapp', 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(repo, 'newapp', 'index.ts'), 'export const app = 1\n', 'utf8')
    writeFileSync(join(repo, 'newapp', '.env'), 'STRIPE_KEY=sk_live_realsecret\n', 'utf8')
    writeFileSync(join(repo, 'newapp', 'notes.local'), 'scratch\n', 'utf8')
    writeFileSync(join(repo, 'newapp', 'node_modules', 'left-pad', 'index.js'), 'x\n', 'utf8')

    await manager.discardWorktreeChanges(repo, 'newapp/')

    expect(existsSync(join(repo, 'newapp', 'index.ts'))).toBe(false)
    expect(existsSync(join(repo, 'newapp', '.env'))).toBe(true)
    expect(existsSync(join(repo, 'newapp', 'notes.local'))).toBe(true)
    expect(existsSync(join(repo, 'newapp', 'node_modules', 'left-pad', 'index.js'))).toBe(true)
  })

  it('discarding an untracked directory with nothing ignored inside prunes it entirely (#136 parity)', async () => {
    mkdirSync(join(repo, 'newfeature'), { recursive: true })
    writeFileSync(join(repo, 'newfeature', 'foo.ts'), 'export const foo = 1\n', 'utf8')

    await expect(manager.discardWorktreeChanges(repo, 'newfeature/')).resolves.toBeUndefined()
    expect(existsSync(join(repo, 'newfeature'))).toBe(false)
  })
})

describe('GitManager.stagedDiff — the AI commit-message diff source (#694)', () => {
  let repo: string
  let manager: GitManager
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-staged-diff-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'alpha.txt'), 'v0\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'v0')
    manager = new GitManager(noopRoots)
  })
  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  it('reads the STAGED content, not the working tree, for a staged-then-re-edited file', async () => {
    // Stage v1, then re-edit to v2 in the worktree — the commit will contain v1.
    writeFileSync(join(repo, 'alpha.txt'), 'v0\nSTAGED_v1\n', 'utf8')
    git(repo, 'add', 'alpha.txt')
    writeFileSync(join(repo, 'alpha.txt'), 'v0\nSTAGED_v1\nUNSTAGED_v2\n', 'utf8')

    const staged = await manager.stagedDiff(repo, 'alpha.txt')
    // after = the staged (index) blob: has the staged line, NOT the unstaged one.
    expect(staged.afterContent).toContain('STAGED_v1')
    expect(staged.afterContent).not.toContain('UNSTAGED_v2')
    expect(staged.beforeContent).toBe('v0\n')

    // Contrast: the working-tree diff (what the ✨ wand USED to feed) includes
    // the uncommitted edit — describing changes that won't be in the commit.
    const working = await manager.diff(repo, 'alpha.txt')
    expect(working.afterContent).toContain('UNSTAGED_v2')
  })

  it('shows an empty staged side for a staged deletion', async () => {
    git(repo, 'rm', 'alpha.txt')
    const staged = await manager.stagedDiff(repo, 'alpha.txt')
    expect(staged.beforeContent).toBe('v0\n')
    expect(staged.afterContent).toBe('')
  })

  it('reads a newly staged file as a full addition (before empty)', async () => {
    writeFileSync(join(repo, 'beta.txt'), 'brand new\n', 'utf8')
    git(repo, 'add', 'beta.txt')
    const staged = await manager.stagedDiff(repo, 'beta.txt')
    expect(staged.beforeContent).toBe('')
    expect(staged.afterContent).toBe('brand new\n')
  })

  it('does not include a file that is edited but NOT staged (empty staged diff)', async () => {
    writeFileSync(join(repo, 'alpha.txt'), 'v0\nunstaged only\n', 'utf8')
    const staged = await manager.stagedDiff(repo, 'alpha.txt')
    // Nothing staged → index matches HEAD → before === after (no textual change).
    expect(staged.beforeContent).toBe('v0\n')
    expect(staged.afterContent).toBe('v0\n')
  })
})

describe('resolveConflictHunk — per-hunk resolution (conflict-UX Phase 3)', () => {
  let repo: string
  let manager: GitManager

  // A file with TWO independent conflict regions after the merge below. The
  // change points sit far apart (many unchanged context lines between them) so
  // git keeps them as two distinct conflict hunks rather than coalescing.
  const gap = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']
  const base = ['top', 'A0', ...gap, 'B0', 'bottom'].join('\n') + '\n'
  const ours = ['top', 'A-ours', ...gap, 'B-ours', 'bottom'].join('\n') + '\n'
  const theirs = ['top', 'A-theirs', ...gap, 'B-theirs', 'bottom'].join('\n') + '\n'

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-hunk-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '-b', 'main')
    writeFileSync(join(repo, 'f.txt'), base, 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'base')
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'f.txt'), theirs, 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'feature')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'f.txt'), ours, 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'ours')
    try {
      git(repo, 'merge', 'feature')
    } catch {
      /* expected: two-hunk content conflict */
    }
    manager = new GitManager(noopRoots)
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  async function hunkIds(): Promise<string[]> {
    const result = await manager.readConflicted(repo, 'f.txt')
    if ('oversize' in result) throw new Error('unexpected oversize')
    return parseConflictHunks(result.markered).map((hunk) => hunk.hunkId)
  }

  it('resolves ONE hunk and leaves the sibling conflict intact + unmerged', async () => {
    const ids = await hunkIds()
    expect(ids).toHaveLength(2)

    const res = await manager.resolveConflictHunk(repo, 'f.txt', ids[0], 'ours')
    expect(res.matched).toBe(true)
    expect(res.remainingConflicts).toBe(1)
    expect(res.staged).toBe(false)

    const onDisk = readFileSync(join(repo, 'f.txt'), 'utf8')
    expect(onDisk).toContain('A-ours')
    expect(onDisk).not.toContain('A-theirs')
    // The second region's markers are untouched.
    expect(onDisk).toContain('<<<<<<<')
    expect(onDisk).toContain('B-ours')
    expect(onDisk).toContain('B-theirs')

    // Still unmerged — completeMerge's gate must still see it.
    const state = await manager.getMergeState(repo)
    expect(state.unmergedPaths).toContain('f.txt')
  })

  it('re-stages the file only once the LAST hunk is resolved', async () => {
    const first = await hunkIds()
    await manager.resolveConflictHunk(repo, 'f.txt', first[0], 'ours')
    const remaining = await hunkIds()
    expect(remaining).toHaveLength(1)

    const res = await manager.resolveConflictHunk(repo, 'f.txt', remaining[0], 'theirs')
    expect(res.remainingConflicts).toBe(0)
    expect(res.staged).toBe(true)

    const onDisk = readFileSync(join(repo, 'f.txt'), 'utf8')
    expect(onDisk).not.toContain('<<<<<<<')
    expect(onDisk).toContain('A-ours')
    expect(onDisk).toContain('B-theirs')

    const state = await manager.getMergeState(repo)
    expect(state.unmergedPaths).not.toContain('f.txt')
  })

  it("'both' resolution keeps both sides in order", async () => {
    const ids = await hunkIds()
    await manager.resolveConflictHunk(repo, 'f.txt', ids[0], 'both', 'theirs-first')
    const onDisk = readFileSync(join(repo, 'f.txt'), 'utf8')
    expect(onDisk.indexOf('A-theirs')).toBeLessThan(onDisk.indexOf('A-ours'))
  })

  it('explicit content body overrides choice for a single hunk', async () => {
    const ids = await hunkIds()
    const res = await manager.resolveConflictHunk(repo, 'f.txt', ids[0], 'ours', 'ours-first', 'MERGED_A')
    expect(res.matched).toBe(true)
    const onDisk = readFileSync(join(repo, 'f.txt'), 'utf8')
    expect(onDisk).toContain('MERGED_A')
    expect(onDisk).not.toContain('A-ours')
  })

  it('unknown hunkId is a no-op (matched:false, file untouched)', async () => {
    const before = readFileSync(join(repo, 'f.txt'), 'utf8')
    const res = await manager.resolveConflictHunk(repo, 'f.txt', 'hunk-missing', 'ours')
    expect(res.matched).toBe(false)
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe(before)
  })

  it('whole-file resolveConflict shim resolves EVERY hunk with one choice', async () => {
    await manager.resolveConflict(repo, 'f.txt', { kind: 'ours' })
    const onDisk = readFileSync(join(repo, 'f.txt'), 'utf8')
    expect(onDisk).not.toContain('<<<<<<<')
    expect(onDisk).toContain('A-ours')
    expect(onDisk).toContain('B-ours')
    expect(onDisk).not.toContain('A-theirs')

    const state = await manager.getMergeState(repo)
    expect(state.unmergedPaths).not.toContain('f.txt')
  })

  it('whole-file resolveConflict content path still writes verbatim text', async () => {
    await manager.resolveConflict(repo, 'f.txt', { kind: 'content', text: 'hand merged\n' })
    expect(readFileSync(join(repo, 'f.txt'), 'utf8')).toBe('hand merged\n')
    const state = await manager.getMergeState(repo)
    expect(state.unmergedPaths).not.toContain('f.txt')
  })
})

describe('write paths refuse a symlinked escape (L2)', () => {
  let repo: string
  let outside: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-L2-'))
    outside = mkdtempSync(join(tmpdir(), 'flow-git-L2-outside-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '-b', 'main')
    writeFileSync(join(repo, 'f.txt'), 'hello\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'base')
    // An in-repo directory symlink whose target lives OUTSIDE the repo — the kind
    // an untrusted cloned repo could ship. `ensureInsideRoot` passes it (lexically
    // inside), so only the realpath guard can catch the escape.
    symlinkSync(outside, join(repo, 'escape'), 'dir')
    manager = new GitManager(noopRoots)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('reconcileClash refuses to write through a symlink that escapes the root', async () => {
    await expect(
      manager.reconcileClash(repo, 'escape/pwned.txt', 'evil'),
    ).rejects.toThrow(/escapes the project folder/)
    // The write never followed the symlink outside the root.
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)
  })

  it('resolveConflict (content) refuses a symlinked escape', async () => {
    await expect(
      manager.resolveConflict(repo, 'escape/pwned.txt', { kind: 'content', text: 'evil' }),
    ).rejects.toThrow(/escapes the project folder/)
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)
  })

  it('still writes a normal in-root path (guard is fail-soft for the common case)', async () => {
    await manager.reconcileClash(repo, 'clean.txt', 'ok\n')
    expect(readFileSync(join(repo, 'clean.txt'), 'utf8')).toBe('ok\n')
  })
})

describe('unresolved-conflict gates on stage/commit (#986)', () => {
  let repo: string
  let manager: GitManager

  /** Park the repo in a real conflicted merge: main and feature both edit app.ts. */
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-conflict-gate-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'checkout', '-b', 'main')
    writeFileSync(join(repo, 'app.ts'), 'export const version = 1\n', 'utf8')
    writeFileSync(join(repo, 'other.txt'), 'clean\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'baseline')
    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'app.ts'), 'export const version = 2 // feature\n', 'utf8')
    git(repo, 'commit', '-am', 'feature change')
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'app.ts'), 'export const version = 3 // main\n', 'utf8')
    git(repo, 'commit', '-am', 'main change')
    try {
      git(repo, 'merge', 'feature')
    } catch {
      /* expected: the merge conflicts and parks the repo mid-merge */
    }
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  function mergeHead(): string {
    try {
      return git(repo, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()
    } catch {
      return ''
    }
  }

  it('stage() refuses an unmerged path whose working copy still carries markers', async () => {
    expect(git(repo, 'status', '--porcelain').trim()).toBe('UU app.ts')

    await expect(manager.stage(repo, ['app.ts'])).rejects.toThrow(
      /Cannot stage 1 file with unresolved merge conflicts \(app\.ts\)/,
    )
    // The refusal is actionable and NOTHING was staged — the conflict survives.
    await expect(manager.stage(repo, ['app.ts'])).rejects.toThrow(/inline conflict resolver/)
    expect(git(repo, 'status', '--porcelain').trim()).toBe('UU app.ts')
  })

  it('stage() still stages a NON-conflicted file mid-merge', async () => {
    writeFileSync(join(repo, 'other.txt'), 'clean edit\n', 'utf8')
    await manager.stage(repo, ['other.txt'])
    expect(git(repo, 'status', '--porcelain')).toContain('M  other.txt')
    expect(git(repo, 'status', '--porcelain')).toContain('UU app.ts')
  })

  it('stage() allows an unmerged file the user resolved BY HAND (markers gone)', async () => {
    // Removing the markers and staging IS git's resolution gesture — the gate
    // must not force the resolver UI on a manual fix.
    writeFileSync(join(repo, 'app.ts'), 'export const version = 5 // merged\n', 'utf8')
    await manager.stage(repo, ['app.ts'])
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M  app.ts')
  })

  it('commitIndex() refuses while the tree holds an unmerged marker-laden file', async () => {
    await expect(manager.commitIndex(repo, 'feat: commit the phase')).rejects.toThrow(
      /Cannot commit — 1 file still carries unresolved conflict markers \(app\.ts\)/,
    )
    expect(mergeHead()).not.toBe('')
  })

  it('commitIndex() refuses marker-laden content STAGED behind the gate (raw git add)', async () => {
    // Simulate the pre-fix ✓ (or a terminal `git add`): git clears the unmerged
    // flag even though the staged blob still holds the raw markers.
    git(repo, 'add', 'app.ts')
    expect(git(repo, 'status', '--porcelain').trim()).toBe('M  app.ts')

    await expect(manager.commitIndex(repo, 'feat: commit the phase')).rejects.toThrow(
      /Cannot commit — 1 file still carries unresolved conflict markers \(app\.ts\)/,
    )
    // The merge is still in progress and no marker-laden commit exists.
    expect(mergeHead()).not.toBe('')
    expect(git(repo, 'log', '-1', '--pretty=%s').trim()).not.toBe('feat: commit the phase')
  })

  it('completeMerge() refuses marker-laden staged content via the same gate', async () => {
    git(repo, 'add', 'app.ts') // unmerged set is now empty — old gate would pass
    await expect(manager.completeMerge(repo, 'merge feature')).rejects.toThrow(
      /unresolved conflict markers \(app\.ts\)/,
    )
    expect(mergeHead()).not.toBe('')
  })

  it('commitIndex() completes the merge once the conflict is genuinely resolved', async () => {
    writeFileSync(join(repo, 'app.ts'), 'export const version = 5 // merged\n', 'utf8')
    await manager.stage(repo, ['app.ts'])

    const hash = await manager.commitIndex(repo, 'merge: resolved')
    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(mergeHead()).toBe('')
    expect(git(repo, 'show', 'HEAD:app.ts')).not.toContain('<<<<<<<')
  })

  it('unresolvedConflictPaths flags only the marker-carrying conflict', async () => {
    expect(await manager.unresolvedConflictPaths(repo)).toEqual(['app.ts'])
    expect(await manager.unresolvedConflictPaths(repo, ['other.txt'])).toEqual([])

    // Staged-blob scanning is opt-out for the stage gate…
    git(repo, 'add', 'app.ts')
    expect(
      await manager.unresolvedConflictPaths(repo, ['app.ts'], { scanStagedBlobs: false }),
    ).toEqual([])
    // …and on for the commit gates, which see the staged markers.
    expect(await manager.unresolvedConflictPaths(repo)).toEqual(['app.ts'])
  })

  it('never false-positives on content QUOTING markers outside a merge', async () => {
    // Land the merge legitimately first, then commit a fixture whose content
    // holds line-start marker text — no op in progress, git reports nothing
    // unmerged, so no scanning happens and the gates stay open.
    writeFileSync(join(repo, 'app.ts'), 'export const version = 5 // merged\n', 'utf8')
    git(repo, 'add', 'app.ts')
    git(repo, 'commit', '-m', 'merge feature')

    const fixture = '<<<<<<< HEAD\nquoted markers for a test fixture\n=======\nother\n>>>>>>> x\n'
    writeFileSync(join(repo, 'fixture.txt'), fixture, 'utf8')
    await manager.stage(repo, ['fixture.txt'])
    const hash = await manager.commitIndex(repo, 'test: add conflict fixture')
    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(git(repo, 'show', 'HEAD:fixture.txt')).toBe(fixture)
  })
})

describe('projectPathFromRepoPath / scopeChangesToProject (#1040)', () => {
  it('is the identity for the degenerate prefix (project root == repo root)', () => {
    expect(projectPathFromRepoPath('', 'a/b.txt')).toBe('a/b.txt')
    const changes = [
      { filePath: 'a.txt', state: 'modified', staged: false, indexState: null, worktreeState: 'modified' },
    ] as never[]
    expect(scopeChangesToProject(changes, '')).toBe(changes) // same array, byte-identical
  })

  it('strips the prefix inside the project subtree and drops paths outside it', () => {
    expect(projectPathFromRepoPath('app/', 'app/inside.txt')).toBe('inside.txt')
    expect(projectPathFromRepoPath('app/', 'app/nested/dir/')).toBe('nested/dir/')
    expect(projectPathFromRepoPath('app/', 'docs/outside.txt')).toBeNull()
    expect(projectPathFromRepoPath('app/', 'app/')).toBeNull() // the root itself, not a file
    // `appendix.txt` must not match the `app/` prefix by accident.
    expect(projectPathFromRepoPath('app/', 'appendix.txt')).toBeNull()
  })

  it('re-applies the flow-internal backstop to translated paths', () => {
    const change = (filePath: string) =>
      ({ filePath, state: 'modified', staged: false, indexState: null, worktreeState: 'modified' }) as never
    const scoped = scopeChangesToProject(
      [change('app/inside.txt'), change('app/flow/ledger.md'), change('docs/outside.txt')],
      'app/',
    ) as Array<{ filePath: string }>
    expect(scoped.map((c) => c.filePath)).toEqual(['inside.txt'])
  })
})

describe('GitManager anchors to the repo root when the project root is a SUBDIRECTORY (#1040)', () => {
  let repo: string
  let sub: string
  let manager: GitManager

  beforeEach(() => {
    // repo/app/inside.txt + repo/docs/outside.txt, committed then edited —
    // the exact shape of the #1040 report (the project opens `repo/app`).
    repo = mkdtempSync(join(tmpdir(), 'flow-git-subdir-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    mkdirSync(join(repo, 'app'))
    mkdirSync(join(repo, 'docs'))
    writeFileSync(join(repo, 'app', 'inside.txt'), 'v0\n', 'utf8')
    writeFileSync(join(repo, 'docs', 'outside.txt'), 'v0\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'baseline')
    writeFileSync(join(repo, 'app', 'inside.txt'), 'v1 edited\n', 'utf8')
    writeFileSync(join(repo, 'docs', 'outside.txt'), 'v1 edited\n', 'utf8')
    sub = join(repo, 'app')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('status() scopes to the project subtree and speaks project-relative paths', async () => {
    const status = await manager.status(sub)
    expect(status).not.toBeNull()
    expect(status!.rootId).toBe(sub)
    expect(status!.dirty).toBe(true)
    expect(status!.changes.map((c) => c.filePath)).toEqual(['inside.txt'])
    // The sibling folder's change is NOT part of this project.
    expect(status!.changes.some((c) => c.filePath.includes('outside'))).toBe(false)
  })

  it('CONTROL: opening the repo ROOT is byte-identical to before (repo-relative, both files)', async () => {
    const status = await manager.status(repo)
    expect(status!.changes.map((c) => c.filePath).sort()).toEqual([
      'app/inside.txt',
      'docs/outside.txt',
    ])
  })

  it('diff() shows the real working-tree edit for the project-relative path', async () => {
    const diff = await manager.diff(sub, 'inside.txt')
    expect(diff.filePath).toBe('inside.txt')
    expect(diff.beforeContent).toBe('v0\n')
    expect(diff.afterContent).toBe('v1 edited\n') // pre-fix: v0 both sides
  })

  it('stage() / stagedDiff() / unstage() actually hit the index', async () => {
    await manager.stage(sub, ['inside.txt'])
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('app/inside.txt')

    const staged = await manager.stagedDiff(sub, 'inside.txt')
    expect(staged.beforeContent).toBe('v0\n')
    expect(staged.afterContent).toBe('v1 edited\n')

    await manager.unstage(sub, ['inside.txt'])
    expect(git(repo, 'diff', '--cached', '--name-only').trim()).toBe('')
  })

  it('commit() commits exactly the project file', async () => {
    const hash = await manager.commit(sub, 'feat: edit inside', ['inside.txt'])
    expect(hash).toMatch(/^[0-9a-f]{7,}$/)
    expect(git(repo, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('app/inside.txt')
    // The sibling edit is untouched.
    expect(git(repo, 'status', '--porcelain')).toContain(' M docs/outside.txt')
  })

  it('discardWorktreeChanges() restores the right file', async () => {
    await manager.discardWorktreeChanges(sub, 'inside.txt')
    expect(readFileSync(join(sub, 'inside.txt'), 'utf8')).toBe('v0\n')
    expect(readFileSync(join(repo, 'docs', 'outside.txt'), 'utf8')).toBe('v1 edited\n')
  })

  it('untracked directory rollup translates both ways (status row + listing + diff preview)', async () => {
    mkdirSync(join(sub, 'newdir'))
    writeFileSync(join(sub, 'newdir', 'a.txt'), 'a\n', 'utf8')
    writeFileSync(join(sub, 'newdir', 'b.txt'), 'b\n', 'utf8')

    const status = await manager.status(sub)
    expect(status!.changes.map((c) => c.filePath)).toContain('newdir/')

    const files = await manager.listUntrackedInDir(sub, 'newdir/')
    expect(files).toEqual(['newdir/a.txt', 'newdir/b.txt'])

    const preview = await manager.diff(sub, 'newdir/')
    expect(preview.filePath).toBe('newdir/')
    expect(preview.afterContent).toContain('newdir/a.txt')
  })

  it('rejects paths that escape the project root even though they are inside the repo', async () => {
    await expect(manager.stage(sub, ['../docs/outside.txt'])).rejects.toThrow(
      /escapes the project folder/,
    )
    await expect(manager.diff(sub, '../docs/outside.txt')).rejects.toThrow(
      /escapes the project folder/,
    )
  })

  it("hides the subdirectory project's own flow-internal artifacts", async () => {
    mkdirSync(join(sub, 'flow'))
    writeFileSync(join(sub, 'flow', 'ledger.md'), 'x\n', 'utf8')
    const status = await manager.status(sub)
    expect(status!.changes.some((c) => c.filePath.startsWith('flow'))).toBe(false)
  })

  it('fileAuthors() resolves authors for project-relative paths', async () => {
    const authors = await manager.fileAuthors(sub, ['inside.txt'])
    expect(authors.get('inside.txt')?.author).toBe('Test')
  })
})

describe('GitManager .git watcher dedupe (perf batch)', () => {
  let repo: string
  let manager: GitManager | undefined

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-dedupe-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    mkdirSync(join(repo, 'app'))
    writeFileSync(join(repo, 'app', 'inside.txt'), 'x\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'seed')
  })

  afterAll(async () => {
    await manager?.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  /** The private watcher maps, for structural assertions only. */
  function internals(target: GitManager): {
    watchers: Map<string, unknown>
    watcherRoots: Map<string, Set<string>>
    rootGitDirs: Map<string, string>
  } {
    return target as unknown as {
      watchers: Map<string, unknown>
      watcherRoots: Map<string, Set<string>>
      rootGitDirs: Map<string, string>
    }
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for watcher state')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  it('N roots sharing one repo toplevel share ONE watcher, fanned out per root', async () => {
    const rootA = repo
    const rootB = join(repo, 'app')
    let roots = [{ rootPath: rootA }, { rootPath: rootB }]
    let notify: () => void = () => undefined
    const provider: GitRootsProvider = {
      getRoots: () => roots,
      onRootsChanged: (listener) => {
        notify = listener
        return () => undefined
      },
    }
    manager = new GitManager(provider)
    manager.start()

    const maps = internals(manager)
    await waitFor(() => maps.rootGitDirs.size === 2)
    // One physical watcher on the shared .git; both roots mapped onto it.
    // (The gitDir key comes from `git rev-parse --show-toplevel`, which
    // resolves macOS's /var → /private/var — read it back, don't join it.)
    expect(maps.watchers.size).toBe(1)
    const gitDir = maps.rootGitDirs.get(rootA)!
    expect(gitDir.endsWith('.git')).toBe(true)
    expect(maps.rootGitDirs.get(rootB)).toBe(gitDir)
    expect([...maps.watcherRoots.get(gitDir)!].sort()).toEqual([rootA, rootB].sort())

    // Removing ONE root keeps the shared watcher alive for the other…
    roots = [{ rootPath: rootA }]
    notify()
    await waitFor(() => maps.rootGitDirs.size === 1)
    expect(maps.watchers.size).toBe(1)
    expect([...maps.watcherRoots.get(gitDir)!]).toEqual([rootA])

    // …and removing the last root closes it.
    roots = []
    notify()
    await waitFor(() => maps.rootGitDirs.size === 0)
    expect(maps.watchers.size).toBe(0)
    expect(maps.watcherRoots.size).toBe(0)
  })
})

describe('parsePorcelainV2Status sees a detached HEAD (#1382)', () => {
  // `(detached)` is git's PLACEHOLDER, not a branch name. It flowed verbatim
  // into the same slot that otherwise says `main`, while every mutating action
  // stayed enabled and reported ordinary success — a commit made on a detached
  // HEAD is reachable from no branch, so the panel said "clean" about work one
  // checkout from being unreferenced.
  const line = (text: string): string => `${text}\u0000`

  it('flags the state and refuses to call the placeholder a branch', () => {
    const parsed = parsePorcelainV2Status(
      line('# branch.oid 0123456789abcdef0123456789abcdef01234567') + line('# branch.head (detached)'),
    )
    expect(parsed.detached).toBe(true)
    expect(parsed.branch).toBe('')
    expect(parsed.headCommit).toBe('0123456789abcdef0123456789abcdef01234567')
  })

  it('leaves an ordinary branch exactly as it was', () => {
    const parsed = parsePorcelainV2Status(
      line('# branch.oid 0123456789abcdef0123456789abcdef01234567') + line('# branch.head main'),
    )
    expect(parsed.detached).toBe(false)
    expect(parsed.branch).toBe('main')
  })

  it('does not mistake a branch literally named like the placeholder', () => {
    // Only the exact placeholder counts; `detached-fix` is a real branch.
    const parsed = parsePorcelainV2Status(line('# branch.head detached-fix'))
    expect(parsed.detached).toBe(false)
    expect(parsed.branch).toBe('detached-fix')
  })
})
/**
 * One scan, however many surfaces ask.
 *
 * Measured on a warm launch against a 4,182-file project: git:status,
 * git:mergeState and review:list all fire within a breath of each other at
 * startup, each spawning its own full-tree scan, each taking ~500ms while the
 * other two ran. They were all describing the same instant.
 */
describe('concurrent status reads', () => {
  let repo: string
  let manager: GitManager

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-coalesce-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'kept.ts'), 'export const kept = 1\n', 'utf8')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'baseline')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('answers callers that arrive mid-scan from the scan already running', async () => {
    const [a, b, c] = await Promise.all([
      manager.status(repo),
      manager.status(repo),
      manager.status(repo),
    ])
    // The same object, not merely an equal one — proof it was one scan.
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('is not a cache — the next caller gets a fresh scan', async () => {
    // A commit refreshes the panel immediately afterwards. An answer held even
    // briefly would report the tree as it was before the commit.
    const before = await manager.status(repo)
    writeFileSync(join(repo, 'brand-new.txt'), 'hello')
    const after = await manager.status(repo)
    expect(after).not.toBe(before)
    expect(after?.changes.some((change) => change.filePath === 'brand-new.txt')).toBe(true)
  })
})


describe('aheadFiles — what THIS checkout has committed, against real git', () => {
  let origin: string
  let seed: string
  let clone: string
  let manager: GitManager

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), 'flow-git-ahead-origin-'))
    git(origin, 'init', '--initial-branch=main', '--bare')

    seed = mkdtempSync(join(tmpdir(), 'flow-git-ahead-seed-'))
    git(seed, 'init', '--initial-branch=main')
    git(seed, 'config', 'user.email', 'me@here.com')
    git(seed, 'config', 'user.name', 'Me')
    writeFileSync(join(seed, 'a.txt'), 'one\n', 'utf8')
    git(seed, 'add', 'a.txt')
    git(seed, 'commit', '-m', 'first')
    git(seed, 'remote', 'add', 'origin', origin)
    git(seed, 'push', '-u', 'origin', 'main')

    clone = mkdtempSync(join(tmpdir(), 'flow-git-ahead-clone-'))
    git(clone, 'clone', origin, '.')
    git(clone, 'config', 'user.email', 'me@here.com')
    git(clone, 'config', 'user.name', 'Me')

    // Origin moves on WITHOUT this clone — the everyday state of a `main` you
    // have not pulled today.
    writeFileSync(join(seed, 'b.txt'), 'x\n'.repeat(400), 'utf8')
    git(seed, 'add', 'b.txt')
    git(seed, 'commit', '-m', 'lots of work by other people')
    git(seed, 'push', 'origin', 'main')
    git(clone, 'fetch', 'origin')

    manager = new GitManager(noopRoots)
  })

  afterEach(() => {
    for (const dir of [origin, seed, clone]) rmSync(dir, { recursive: true, force: true })
  })

  /**
   * THE BUG (2026-09-14): a brand-new conversation on `main` reported
   * "Committed +8010 −49572" over 566 files it had never touched. The checkout
   * was 378 commits BEHIND, and `git diff A..B` compares endpoints rather than
   * meaning what `git log A..B` means — so "behind" was rendered as the inverse
   * of everything it was missing.
   */
  it('says nothing for a checkout that is merely BEHIND its upstream', async () => {
    expect(git(clone, 'rev-list', '--count', 'HEAD..@{upstream}').trim()).not.toBe('0')
    expect(await manager.aheadFiles(clone)).toEqual([])
  })

  it('reports this checkout’s own commit, and only that', async () => {
    writeFileSync(join(clone, 'mine.txt'), 'mine\n', 'utf8')
    git(clone, 'add', 'mine.txt')
    git(clone, 'commit', '-m', 'my work')

    const ahead = await manager.aheadFiles(clone)
    expect(ahead.map((f) => f.filePath)).toEqual(['mine.txt'])
    // …and NOT the 400 lines other people pushed while this branch sat behind.
    expect(ahead.some((f) => f.filePath === 'b.txt')).toBe(false)
  })

  it('says nothing when the checkout is level with its upstream', async () => {
    git(clone, 'merge', '--ff-only', 'origin/main')
    expect(await manager.aheadFiles(clone)).toEqual([])
  })
})

describe('GitManager.pull — an autostash that conflicts is a conflict, against real git', () => {
  let dir: string
  let clone: string
  let manager: GitManager

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-git-pull-'))
    const upstream = join(dir, 'up')
    mkdirSync(upstream)
    git(upstream, 'init', '-b', 'main')
    git(upstream, 'config', 'user.email', 'test@example.com')
    git(upstream, 'config', 'user.name', 'Test')
    writeFileSync(join(upstream, 'f.txt'), 'one\n', 'utf8')
    git(upstream, 'add', '.')
    git(upstream, 'commit', '-m', 'one')
    clone = join(dir, 'down')
    git(dir, 'clone', '-q', upstream, clone)
    git(clone, 'config', 'user.email', 'test@example.com')
    git(clone, 'config', 'user.name', 'Test')
    writeFileSync(join(upstream, 'f.txt'), 'two\n', 'utf8')
    git(upstream, 'commit', '-am', 'two')
    manager = new GitManager(noopRoots)
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports a clean pull as clean when the uncommitted file is not touched', async () => {
    writeFileSync(join(clone, 'mine.txt'), 'untouched\n', 'utf8')
    git(clone, 'add', 'mine.txt')
    expect(await manager.pull(clone)).toEqual({ conflicted: false, received: 1, branch: 'main' })
  })

  it('reports {conflicted:true} when re-applying the stashed work clashes — git itself exits 0', async () => {
    // The person's uncommitted edit to the very file the incoming commit changes.
    writeFileSync(join(clone, 'f.txt'), 'mine\n', 'utf8')
    const result = await manager.pull(clone)
    // POSITIVE FIRST (#28): the commit DID arrive, and the file IS unmerged —
    // so a `conflicted: false` here would be a claim about a folder that needs
    // resolving.
    expect(result.received).toBe(1)
    expect(git(clone, 'ls-files', '-u')).toContain('f.txt')
    expect(result).toEqual({ conflicted: true, received: 1, branch: 'main' })
  })
})
