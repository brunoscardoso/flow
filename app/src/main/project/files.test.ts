// Project file IO containment tests — exercised through the exported
// readProjectFile / writeProjectFile handlers against real temp-dir
// projects. (The module's electron import is inert here: registration is
// never invoked, so no electron APIs are touched.)
//
// Regression coverage (LOG-10): path containment must be symlink-aware — a
// symlink INSIDE the project pointing outside it must be rejected for both
// reads and writes, including writes to not-yet-existing files whose parent
// directory is a symlink (deepest-existing-ancestor realpath).

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  readProjectFile,
  writeProjectFile,
  resolveProjectFileRef,
  renameProjectPath,
  deleteProjectPath,
  createProjectPath,
  sameFile,
  listAllProjectFiles,
  forgetListAllCache,
} from './files'
import { searchProjectContent, forgetContentSearchCache } from './content-search'
import {
  createAddressableRoots,
  type AddressableRoots,
  type ThreadWorktree,
} from './addressable-roots'

/** The address gate for one registered root and no thread checkouts — the
 *  pre-worktree rule, which is what every test below except the worktree
 *  describe block asserts against. */
function stubRoots(rootPath: string): AddressableRoots {
  return createAddressableRoots({ registeredRoots: () => [{ rootPath }] })
}

/** The gate as it stands once a thread owns a checkout of `projectRoot`. */
function stubRootsWithWorktree(rootPath: string, worktree: ThreadWorktree): AddressableRoots {
  return createAddressableRoots({
    registeredRoots: () => [{ rootPath }],
    threadWorktrees: () => [worktree],
  })
}

describe('project file IO containment', () => {
  let tempDir: string
  let rootDir: string
  let outsideDir: string
  let manager: AddressableRoots

  const savedVaultEnv = process.env.PLAN_FLOW_VAULT_DIR

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-files-'))
    rootDir = join(tempDir, 'project')
    outsideDir = join(tempDir, 'outside')
    mkdirSync(rootDir)
    mkdirSync(outsideDir)
    writeFileSync(join(outsideDir, 'secret.txt'), 'outside the project')
    // outsideDir stands in for the central vault below; point the vault env at
    // it so a legitimate flow/ → vault link is trusted (#94) while non-`flow`
    // escaping links are still refused.
    process.env.PLAN_FLOW_VAULT_DIR = outsideDir
    manager = stubRoots(rootDir)
  })

  afterEach(() => {
    if (savedVaultEnv === undefined) delete process.env.PLAN_FLOW_VAULT_DIR
    else process.env.PLAN_FLOW_VAULT_DIR = savedVaultEnv
    rmSync(tempDir, { recursive: true, force: true })
  })

  // ── Baseline behavior ────────────────────────────────────────────────

  it('round-trips a write and read inside the root', async () => {
    await writeProjectFile(manager, rootDir, 'notes.txt', 'hello flow')

    const result = await readProjectFile(manager, rootDir, 'notes.txt')

    expect(result).toEqual({ relPath: 'notes.txt', content: 'hello flow', binary: false })
  })

  it('answers missing:true for an absent file when the caller expects it — and still throws when it does not (2026-10-09)', async () => {
    await expect(
      readProjectFile(manager, rootDir, 'flow/plans/plan_gone_v1.md', undefined, { missingOk: true }),
    ).resolves.toEqual({ relPath: 'flow/plans/plan_gone_v1.md', content: '', binary: true, missing: true })
    await expect(readProjectFile(manager, rootDir, 'flow/plans/plan_gone_v1.md')).rejects.toMatchObject({ code: 'ENOENT' })
    // A file that IS there is read as ever, flag or not.
    await writeProjectFile(manager, rootDir, 'here.md', 'x')
    await expect(readProjectFile(manager, rootDir, 'here.md', undefined, { missingOk: true })).resolves.toEqual({
      relPath: 'here.md',
      content: 'x',
      binary: false,
    })
  })

  it('preserves the executable bit when saving over an existing file (#159)', async () => {
    const scriptPath = join(rootDir, 'run.sh')
    writeFileSync(scriptPath, '#!/bin/sh\necho hi\n', 'utf8')
    chmodSync(scriptPath, 0o755)

    await writeProjectFile(manager, rootDir, 'run.sh', '#!/bin/sh\necho bye\n')

    expect(readFileSync(scriptPath, 'utf8')).toBe('#!/bin/sh\necho bye\n')
    expect(statSync(scriptPath).mode & 0o777).toBe(0o755) // executable bit survives
  })

  it('writes THROUGH a symlink — the link survives and the target gets the edit (#1146)', async () => {
    const realPath = join(rootDir, 'real.md')
    const linkPath = join(rootDir, 'link.md')
    writeFileSync(realPath, '# real target\n', 'utf8')
    symlinkSync(realPath, linkPath)

    await writeProjectFile(manager, rootDir, 'link.md', '# real target\nedited\n')

    // The edit reached the file the user actually opened…
    expect(readFileSync(realPath, 'utf8')).toBe('# real target\nedited\n')
    // …and the link is still a link (the atomic rename used to replace it,
    // leaving a detached regular file and a `T` typechange in git).
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(linkPath, 'utf8')).toBe('# real target\nedited\n')
  })

  it('preserves the target’s mode when writing through a symlink (#159 + #1146)', async () => {
    const realPath = join(rootDir, 'run.sh')
    const linkPath = join(rootDir, 'run-link.sh')
    writeFileSync(realPath, '#!/bin/sh\necho hi\n', 'utf8')
    chmodSync(realPath, 0o755)
    symlinkSync(realPath, linkPath)

    await writeProjectFile(manager, rootDir, 'run-link.sh', '#!/bin/sh\necho bye\n')

    expect(statSync(realPath).mode & 0o777).toBe(0o755)
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
  })

  it('still REFUSES a symlink whose target escapes the root (#94 unregressed)', async () => {
    // Following links must not become a way out of the project: the
    // containment check runs on the resolved path, before any write.
    symlinkSync(join(outsideDir, 'secret.txt'), join(rootDir, 'escape.txt'))

    await expect(writeProjectFile(manager, rootDir, 'escape.txt', 'pwned')).rejects.toThrow(
      /escapes the project folder/,
    )
    expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe('outside the project')
  })

  it('preserves a UTF-8 BOM across a save (#1147)', async () => {
    const filePath = join(rootDir, 'settings.ts')
    const BOM = Buffer.from([0xef, 0xbb, 0xbf])
    writeFileSync(filePath, Buffer.concat([BOM, Buffer.from('export const NAME = 1\n', 'utf8')]))

    // The editor never sees the BOM…
    const read = await readProjectFile(manager, rootDir, 'settings.ts')
    expect(read.content).toBe('export const NAME = 1\n')
    expect(read.hasBom).toBe(true)

    // …and saving the (BOM-free) buffer back does not rewrite byte 0.
    await writeProjectFile(manager, rootDir, 'settings.ts', 'export const NAME = 2\n')

    const bytes = readFileSync(filePath)
    expect(bytes.subarray(0, 3)).toEqual(BOM)
    expect(bytes.toString('utf8').slice(1)).toBe('export const NAME = 2\n')
  })

  it('never GIVES a file a BOM it did not have (#1147)', async () => {
    const filePath = join(rootDir, 'plain.ts')
    writeFileSync(filePath, 'export const NAME = 1\n', 'utf8')

    const read = await readProjectFile(manager, rootDir, 'plain.ts')
    expect(read.hasBom).toBeUndefined()

    await writeProjectFile(manager, rootDir, 'plain.ts', 'export const NAME = 2\n')

    expect(readFileSync(filePath)[0]).not.toBe(0xef)
  })

  it('does not double the BOM when the content already carries one (#1147)', async () => {
    const filePath = join(rootDir, 'doubled.ts')
    const BOM = Buffer.from([0xef, 0xbb, 0xbf])
    writeFileSync(filePath, Buffer.concat([BOM, Buffer.from('a\n', 'utf8')]))

    await writeProjectFile(manager, rootDir, 'doubled.ts', '\ufeffb\n')

    const bytes = readFileSync(filePath)
    expect(bytes.subarray(0, 3)).toEqual(BOM)
    expect(bytes.subarray(3, 6)).not.toEqual(BOM)
    expect(bytes.toString('utf8')).toBe('\ufeffb\n')
  })

  it('a brand-new file gets no BOM (nothing to restore) (#1147)', async () => {
    await writeProjectFile(manager, rootDir, 'fresh.ts', 'const x = 1\n')

    expect(readFileSync(join(rootDir, 'fresh.ts'))[0]).not.toBe(0xef)
  })

  it('writes a brand-new file in an existing subdirectory', async () => {
    mkdirSync(join(rootDir, 'sub'))

    await writeProjectFile(manager, rootDir, 'sub/new.txt', 'created')

    expect(readFileSync(join(rootDir, 'sub', 'new.txt'), 'utf8')).toBe('created')
  })

  it('rejects unknown roots', async () => {
    await expect(readProjectFile(manager, outsideDir, 'secret.txt')).rejects.toThrow(
      /Unknown root/,
    )
  })

  // ── Oversized files return a graceful placeholder, never throw (#37/#52) ──

  it('returns a read-only "too large" placeholder instead of throwing on oversize', async () => {
    writeFileSync(join(rootDir, 'huge.bin'), 'x'.repeat(64))

    // Inject a tiny limit so we don't have to write a 10MB fixture.
    const result = await readProjectFile(manager, rootDir, 'huge.bin', 8)

    expect(result).toEqual({ relPath: 'huge.bin', content: '', binary: true, tooLarge: true })
  })

  it('reads a file that is exactly at the limit normally', async () => {
    writeFileSync(join(rootDir, 'atlimit.txt'), 'abcdefgh') // 8 bytes

    const result = await readProjectFile(manager, rootDir, 'atlimit.txt', 8)

    expect(result).toEqual({ relPath: 'atlimit.txt', content: 'abcdefgh', binary: false })
  })

  it('rejects lexical escapes (`..`) for read and write', async () => {
    await expect(readProjectFile(manager, rootDir, '../outside/secret.txt')).rejects.toThrow(
      /escapes the project folder/,
    )
    await expect(
      writeProjectFile(manager, rootDir, '../outside/evil.txt', 'x'),
    ).rejects.toThrow(/escapes the project folder/)
  })

  // ── LOG-10: symlink-aware containment ────────────────────────────────

  it('rejects reading through a symlinked FILE that points outside the root', async () => {
    symlinkSync(join(outsideDir, 'secret.txt'), join(rootDir, 'leak.txt'), 'file')

    await expect(readProjectFile(manager, rootDir, 'leak.txt')).rejects.toThrow(
      /escapes the project folder/,
    )
  })

  it('rejects writing through a symlinked FILE that points outside the root', async () => {
    symlinkSync(join(outsideDir, 'secret.txt'), join(rootDir, 'leak.txt'), 'file')

    await expect(writeProjectFile(manager, rootDir, 'leak.txt', 'overwritten')).rejects.toThrow(
      /escapes the project folder/,
    )
    expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe('outside the project')
  })

  it('rejects reading through a symlinked DIRECTORY that points outside the root', async () => {
    symlinkSync(outsideDir, join(rootDir, 'link'), 'dir')

    await expect(readProjectFile(manager, rootDir, 'link/secret.txt')).rejects.toThrow(
      /escapes the project folder/,
    )
  })

  it('rejects writing a NEW file under a symlinked directory that points outside', async () => {
    symlinkSync(outsideDir, join(rootDir, 'link'), 'dir')

    await expect(
      writeProjectFile(manager, rootDir, 'link/new.txt', 'escape attempt'),
    ).rejects.toThrow(/escapes the project folder/)
    expect(existsSync(join(outsideDir, 'new.txt'))).toBe(false)
  })

  it('still allows symlinks that stay inside the root', async () => {
    writeFileSync(join(rootDir, 'real.txt'), 'inside')
    symlinkSync(join(rootDir, 'real.txt'), join(rootDir, 'alias.txt'), 'file')

    const result = await readProjectFile(manager, rootDir, 'alias.txt')

    expect(result.content).toBe('inside')
  })

  // ── #56: flow/ is a symlink to the central vault, a first-class part of the
  //         project — reads/writes through it must be allowed. ──────────────

  it('allows reading a file through the project flow/ symlink to the vault', async () => {
    // outsideDir stands in for the vault; rootDir/flow → outsideDir (as plan-flow init sets up).
    mkdirSync(join(outsideDir, 'reviewed-pr'), { recursive: true })
    writeFileSync(join(outsideDir, 'reviewed-pr', 'pr-120661.md'), '# PR review')
    symlinkSync(outsideDir, join(rootDir, 'flow'), 'dir')

    const result = await readProjectFile(manager, rootDir, 'flow/reviewed-pr/pr-120661.md')

    expect(result.content).toBe('# PR review')
  })

  it('allows writing a file through the project flow/ symlink', async () => {
    mkdirSync(join(outsideDir, 'plans'), { recursive: true })
    symlinkSync(outsideDir, join(rootDir, 'flow'), 'dir')

    await writeProjectFile(manager, rootDir, 'flow/plans/plan_x.md', '# plan')

    expect(readFileSync(join(outsideDir, 'plans', 'plan_x.md'), 'utf8')).toBe('# plan')
  })

  it('rejects a flow/ link repointed OUTSIDE the vault (#94)', async () => {
    // An attacker repoints the in-root flow/ link at an arbitrary dir that is
    // NOT under the configured vault (outsideDir). The trusted-symlink exception
    // must not fire — otherwise file IPC escapes to the whole filesystem.
    const attacker = join(tempDir, 'attacker')
    mkdirSync(attacker)
    writeFileSync(join(attacker, 'passwd'), 'root:x:0:0')
    symlinkSync(attacker, join(rootDir, 'flow'), 'dir')

    await expect(readProjectFile(manager, rootDir, 'flow/passwd')).rejects.toThrow(
      /escapes the project folder/,
    )
  })

  it('still rejects a DIFFERENTLY-named escaping symlink (only flow/ is trusted)', async () => {
    // A malicious/agent-created symlink NOT named flow must remain blocked.
    symlinkSync(outsideDir, join(rootDir, 'evil'), 'dir')

    await expect(readProjectFile(manager, rootDir, 'evil/secret.txt')).rejects.toThrow(
      /escapes the project folder/,
    )
  })

  // ── resolveProjectFileRef (chat file references) ────────────────────

  describe('resolveProjectFileRef', () => {
    it('resolves a bare plan-flow artifact name to its flow/ path', async () => {
      mkdirSync(join(rootDir, 'flow', 'brainstorms'), { recursive: true })
      writeFileSync(join(rootDir, 'flow', 'brainstorms', 'brainstorm_x_v1.md'), '# x')
      expect(await resolveProjectFileRef(manager, rootDir, 'brainstorm_x_v1.md')).toBe(
        'flow/brainstorms/brainstorm_x_v1.md',
      )
    })

    it('returns an in-root relative path unchanged when it exists', async () => {
      mkdirSync(join(rootDir, 'src'), { recursive: true })
      writeFileSync(join(rootDir, 'src', 'index.ts'), 'x')
      expect(await resolveProjectFileRef(manager, rootDir, 'src/index.ts')).toBe('src/index.ts')
      expect(await resolveProjectFileRef(manager, rootDir, './src/index.ts')).toBe('src/index.ts')
    })

    it('finds a bare source file via bounded recursive search', async () => {
      mkdirSync(join(rootDir, 'app', 'api'), { recursive: true })
      writeFileSync(join(rootDir, 'app', 'api', 'RestAPI.ts'), 'x')
      expect(await resolveProjectFileRef(manager, rootDir, 'RestAPI.ts')).toBe(
        'app/api/RestAPI.ts',
      )
    })

    // THE CHAT LINK THAT SAID "File not found" (2026-09-14). Two shapes, both
    // real: plan-flow puts a project's flow/ dir behind a SYMLINK, and an agent
    // creates subdirectories under it that no hardcoded list can know about.
    it('finds a file in a flow/ SUBDIRECTORY the artifact list does not name', async () => {
      mkdirSync(join(rootDir, 'flow', 'design-system'), { recursive: true })
      writeFileSync(join(rootDir, 'flow', 'design-system', 'design-system.html'), '<!doctype html>')
      expect(await resolveProjectFileRef(manager, rootDir, 'design-system.html')).toBe(
        'flow/design-system/design-system.html',
      )
    })

    it('descends into flow/ when it is a SYMLINK to the vault, as plan-flow init makes it', async () => {
      // outsideDir stands in for the vault, exactly as the #56 tests above.
      mkdirSync(join(outsideDir, 'design-system'), { recursive: true })
      writeFileSync(join(outsideDir, 'design-system', 'linked.html'), '<!doctype html>')
      symlinkSync(outsideDir, join(rootDir, 'flow'), 'dir')
      expect(await resolveProjectFileRef(manager, rootDir, 'linked.html')).toBe(
        'flow/design-system/linked.html',
      )
    })

    it('does NOT follow a link out of the project that is not the trusted flow/ one', async () => {
      mkdirSync(join(outsideDir, 'elsewhere'), { recursive: true })
      writeFileSync(join(outsideDir, 'elsewhere', 'secret.txt'), 'no')
      symlinkSync(outsideDir, join(rootDir, 'escape'), 'dir')
      expect(await resolveProjectFileRef(manager, rootDir, 'secret.txt')).toBeNull()
    })

    // "but that should work to everything" (user, 2026-09-14). A project whose
    // documentation lives in .github/instructions/ had every chat link to it
    // answer "File not found" — the walk skipped any directory whose name began
    // with a dot, which swept up .github, .claude, .vscode and .husky along with
    // the caches those rules were written for.
    it('finds a file inside a dot-directory a person keeps (.github)', async () => {
      mkdirSync(join(rootDir, '.github', 'instructions', 'design-system'), { recursive: true })
      writeFileSync(join(rootDir, '.github', 'instructions', 'design-system', 'HOW-TO.md'), '# how')
      expect(await resolveProjectFileRef(manager, rootDir, 'HOW-TO.md')).toBe(
        '.github/instructions/design-system/HOW-TO.md',
      )
    })

    it('still skips the heavy directories, dot-named or not', async () => {
      mkdirSync(join(rootDir, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(rootDir, 'node_modules', 'pkg', 'buried.md'), 'x')
      mkdirSync(join(rootDir, '.git', 'objects'), { recursive: true })
      writeFileSync(join(rootDir, '.git', 'objects', 'gitfile.md'), 'x')
      expect(await resolveProjectFileRef(manager, rootDir, 'buried.md')).toBeNull()
      expect(await resolveProjectFileRef(manager, rootDir, 'gitfile.md')).toBeNull()
    })

    it('maps an absolute path under the root to a relative one', async () => {
      writeFileSync(join(rootDir, 'README.md'), 'x')
      expect(await resolveProjectFileRef(manager, rootDir, join(rootDir, 'README.md'))).toBe(
        'README.md',
      )
    })

    it('returns null when nothing matches', async () => {
      expect(await resolveProjectFileRef(manager, rootDir, 'does-not-exist.md')).toBeNull()
    })

    it('skips ignored dirs like node_modules in the recursive search', async () => {
      mkdirSync(join(rootDir, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(rootDir, 'node_modules', 'pkg', 'buried.ts'), 'x')
      expect(await resolveProjectFileRef(manager, rootDir, 'buried.ts')).toBeNull()
    })

    it('rejects an unknown root', async () => {
      expect(await resolveProjectFileRef(manager, join(tempDir, 'nope'), 'x.md')).toBeNull()
    })
  })

  // ── rename / delete / create (file-tree context menu) ─────────────────

  describe('renameProjectPath', () => {
    it('renames a file within the root', async () => {
      writeFileSync(join(rootDir, 'a.txt'), 'hi')
      await renameProjectPath(manager, rootDir, 'a.txt', 'b.txt')
      expect(existsSync(join(rootDir, 'a.txt'))).toBe(false)
      expect(readFileSync(join(rootDir, 'b.txt'), 'utf8')).toBe('hi')
    })

    it('creates missing parent dirs when moving into a subfolder', async () => {
      writeFileSync(join(rootDir, 'a.txt'), 'hi')
      await renameProjectPath(manager, rootDir, 'a.txt', 'sub/deep/a.txt')
      expect(readFileSync(join(rootDir, 'sub', 'deep', 'a.txt'), 'utf8')).toBe('hi')
    })

    it('refuses to overwrite a DIFFERENT existing target', async () => {
      writeFileSync(join(rootDir, 'a.txt'), 'a')
      writeFileSync(join(rootDir, 'b.txt'), 'b')
      await expect(renameProjectPath(manager, rootDir, 'a.txt', 'b.txt')).rejects.toThrow(
        /already exists/,
      )
    })

    it('allows a case-only rename (Notes.md → notes.md) (#257)', async () => {
      // On a case-insensitive FS the destination stats to the source; the guard
      // must not fire against the file being renamed.
      writeFileSync(join(rootDir, 'Notes.md'), 'body')
      await renameProjectPath(manager, rootDir, 'Notes.md', 'notes.md')
      // Readable at the new casing on both case-sensitive and -insensitive FS.
      expect(readFileSync(join(rootDir, 'notes.md'), 'utf8')).toBe('body')
    })

    it('rejects a target that escapes the root', async () => {
      writeFileSync(join(rootDir, 'a.txt'), 'a')
      await expect(renameProjectPath(manager, rootDir, 'a.txt', '../escape.txt')).rejects.toThrow(
        /escapes the project folder/,
      )
    })
  })

  describe('sameFile (#257)', () => {
    it('is true for the same path and false for two distinct files', async () => {
      writeFileSync(join(rootDir, 'x.txt'), 'x')
      writeFileSync(join(rootDir, 'y.txt'), 'y')
      expect(await sameFile(join(rootDir, 'x.txt'), join(rootDir, 'x.txt'))).toBe(true)
      expect(await sameFile(join(rootDir, 'x.txt'), join(rootDir, 'y.txt'))).toBe(false)
    })

    it('is false when a path does not exist', async () => {
      writeFileSync(join(rootDir, 'x.txt'), 'x')
      expect(await sameFile(join(rootDir, 'x.txt'), join(rootDir, 'missing.txt'))).toBe(false)
    })
  })

  describe('deleteProjectPath', () => {
    it('deletes a file', async () => {
      writeFileSync(join(rootDir, 'a.txt'), 'a')
      await deleteProjectPath(manager, rootDir, 'a.txt')
      expect(existsSync(join(rootDir, 'a.txt'))).toBe(false)
    })

    it('deletes a directory recursively', async () => {
      mkdirSync(join(rootDir, 'dir', 'nested'), { recursive: true })
      writeFileSync(join(rootDir, 'dir', 'nested', 'f.txt'), 'x')
      await deleteProjectPath(manager, rootDir, 'dir')
      expect(existsSync(join(rootDir, 'dir'))).toBe(false)
    })

    it('rejects deleting outside the root', async () => {
      await expect(deleteProjectPath(manager, rootDir, '../outside')).rejects.toThrow(
        /escapes the project folder/,
      )
    })
  })

  describe('createProjectPath', () => {
    it('creates an empty file (and its parent dirs)', async () => {
      await createProjectPath(manager, rootDir, 'sub/new.ts', 'file')
      expect(readFileSync(join(rootDir, 'sub', 'new.ts'), 'utf8')).toBe('')
    })

    it('creates a directory', async () => {
      await createProjectPath(manager, rootDir, 'components', 'directory')
      expect(existsSync(join(rootDir, 'components'))).toBe(true)
    })

    it('refuses to overwrite an existing path', async () => {
      writeFileSync(join(rootDir, 'exists.ts'), 'x')
      await expect(createProjectPath(manager, rootDir, 'exists.ts', 'file')).rejects.toThrow(
        /already exists/,
      )
    })
  })
})

describe('the flat file list is cached — the palette walks per keystroke', () => {
  // MEASURED on this repo: 2,693 files, 45 ms cold and 10-12 ms warm per walk,
  // plus ~100 KB of paths across IPC — and `fileCandidates` asked for it on
  // EVERY character typed into the command palette, on the main process, where
  // the cost is felt by every window at once.
  let dir: string
  let manager: AddressableRoots

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-listall-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'a')
    writeFileSync(join(dir, 'src', 'b.ts'), 'b')
    manager = stubRoots(dir)
    forgetListAllCache()
  })

  afterEach(() => {
    forgetListAllCache()
    rmSync(dir, { recursive: true, force: true })
  })

  it('walks once and serves the same answer inside the window', async () => {
    const first = await listAllProjectFiles(manager, dir, undefined, () => 1_000)
    writeFileSync(join(dir, 'src', 'c.ts'), 'c')
    const second = await listAllProjectFiles(manager, dir, undefined, () => 2_000)
    // Identity, not just equality: the second call did not walk at all.
    expect(second).toBe(first)
    expect(second.relPaths).toHaveLength(2)
  })

  it('walks again once the window has passed', async () => {
    await listAllProjectFiles(manager, dir, undefined, () => 1_000)
    writeFileSync(join(dir, 'src', 'c.ts'), 'c')
    const later = await listAllProjectFiles(manager, dir, undefined, () => 60_000)
    expect(later.relPaths).toHaveLength(3)
  })

  it('never serves a SMALLER walk to a caller that asked for more', async () => {
    // A truncated answer handed over as if it were complete is the one way a
    // cache here could lie about the project.
    const capped = await listAllProjectFiles(manager, dir, 1, () => 1_000)
    expect(capped.relPaths).toHaveLength(1)
    expect(capped.truncated).toBe(true)
    const full = await listAllProjectFiles(manager, dir, 50, () => 1_100)
    expect(full.relPaths).toHaveLength(2)
    expect(full.truncated).toBe(false)
  })

  it('forgets a root that was removed', async () => {
    const first = await listAllProjectFiles(manager, dir, undefined, () => 1_000)
    forgetListAllCache(dir)
    writeFileSync(join(dir, 'src', 'c.ts'), 'c')
    const after = await listAllProjectFiles(manager, dir, undefined, () => 1_100)
    expect(after).not.toBe(first)
    expect(after.relPaths).toHaveLength(3)
  })

  it('keeps roots apart', async () => {
    const other = mkdtempSync(join(tmpdir(), 'flow-listall-2-'))
    writeFileSync(join(other, 'only.ts'), 'x')
    const otherManager = stubRoots(other)
    const a = await listAllProjectFiles(manager, dir, undefined, () => 1_000)
    const b = await listAllProjectFiles(otherManager, other, undefined, () => 1_000)
    expect(a.relPaths).not.toEqual(b.relPaths)
    rmSync(other, { recursive: true, force: true })
  })
})

// ── A thread's own checkout (Phase 3.5) ──────────────────────────────────
//
// `thread-scope-manager` reports a thread's git worktree as its primary root,
// and a worktree is deliberately NEVER a registered project root. Every
// assertion here failed before the address gate existed: the first worktree a
// thread got made the editor throw "Unknown root", and the untracked set linked
// in from the main checkout (node_modules, .env*, flow/) read as an escape.
describe("a thread's worktree is addressable, its main checkout's links readable", () => {
  let tempDir: string
  let mainDir: string
  let worktreeDir: string
  let elsewhereDir: string
  let vaultDir: string
  let gate: AddressableRoots

  const savedVaultEnv = process.env.PLAN_FLOW_VAULT_DIR

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-worktree-'))
    mainDir = join(tempDir, 'project')
    worktreeDir = join(tempDir, '.project-threads', 'thread-a')
    elsewhereDir = join(tempDir, 'elsewhere')
    vaultDir = join(tempDir, 'vault')
    mkdirSync(mainDir)
    mkdirSync(worktreeDir, { recursive: true })
    mkdirSync(elsewhereDir)
    mkdirSync(join(vaultDir, 'projects', 'project', 'flow'), { recursive: true })
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir

    // The main checkout: real files, plus the vault link every plan-flow
    // project has.
    writeFileSync(join(mainDir, 'README.md'), 'main checkout')
    mkdirSync(join(mainDir, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(mainDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    writeFileSync(join(mainDir, '.env'), 'TOKEN=main\n')
    symlinkSync(join(vaultDir, 'projects', 'project', 'flow'), join(mainDir, 'flow'))
    writeFileSync(join(vaultDir, 'projects', 'project', 'flow', 'tasklist.md'), '# tasks\n')

    // The worktree: its own tracked tree, with the untracked set LINKED in from
    // the checkout it was cut from — exactly what `linkUntrackedSet` creates.
    writeFileSync(join(worktreeDir, 'README.md'), 'thread checkout')
    symlinkSync(join(mainDir, 'node_modules'), join(worktreeDir, 'node_modules'))
    symlinkSync(join(mainDir, '.env'), join(worktreeDir, '.env'))
    symlinkSync(join(mainDir, 'flow'), join(worktreeDir, 'flow'))
    // …and one link that is NOT part of that set.
    writeFileSync(join(elsewhereDir, 'secret.txt'), 'another project entirely')
    symlinkSync(join(elsewhereDir, 'secret.txt'), join(worktreeDir, 'leak.txt'))

    gate = stubRootsWithWorktree(mainDir, {
      worktreePath: worktreeDir,
      projectRoot: mainDir,
    })
    forgetListAllCache()
  })

  afterEach(() => {
    if (savedVaultEnv === undefined) delete process.env.PLAN_FLOW_VAULT_DIR
    else process.env.PLAN_FLOW_VAULT_DIR = savedVaultEnv
    forgetListAllCache()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('reads and writes inside the worktree, which is no project root', async () => {
    expect(await readProjectFile(gate, worktreeDir, 'README.md')).toMatchObject({
      content: 'thread checkout',
    })
    await writeProjectFile(gate, worktreeDir, 'notes.md', '# thread notes\n')
    expect(readFileSync(join(worktreeDir, 'notes.md'), 'utf8')).toBe('# thread notes\n')
  })

  it('lists the worktree for the palette', async () => {
    const listed = await listAllProjectFiles(gate, worktreeDir, undefined, () => 1_000)
    expect(listed.relPaths).toContain('README.md')
  })

  it('opens the linked entries the worktree was created with', async () => {
    expect(await readProjectFile(gate, worktreeDir, '.env')).toMatchObject({
      content: 'TOKEN=main\n',
    })
    expect(
      await readProjectFile(gate, worktreeDir, 'node_modules/left-pad/index.js'),
    ).toMatchObject({ content: 'module.exports = 1\n' })
    expect(await readProjectFile(gate, worktreeDir, 'flow/tasklist.md')).toMatchObject({
      content: '# tasks\n',
    })
  })

  it('still refuses a link out of the worktree that is not its own checkout', async () => {
    await expect(readProjectFile(gate, worktreeDir, 'leak.txt')).rejects.toThrow(
      /escapes the project folder/,
    )
    await expect(writeProjectFile(gate, worktreeDir, 'leak.txt', 'pwned')).rejects.toThrow(
      /escapes the project folder/,
    )
    expect(readFileSync(join(elsewhereDir, 'secret.txt'), 'utf8')).toBe('another project entirely')
  })

  it('still refuses a root that is neither registered nor any thread’s checkout', async () => {
    await expect(readProjectFile(gate, elsewhereDir, 'secret.txt')).rejects.toThrow(
      /Unknown root/,
    )
    await expect(listAllProjectFiles(gate, elsewhereDir)).rejects.toThrow(/Unknown root/)
  })

  it('widens nothing at all without a thread-worktree source', async () => {
    const narrow = stubRoots(mainDir)
    await expect(readProjectFile(narrow, worktreeDir, 'README.md')).rejects.toThrow(
      /Unknown root/,
    )
    // …and the main checkout's own links stay refused, because a registered
    // root is a project, not a checkout of one.
    await expect(readProjectFile(gate, mainDir, 'README.md')).resolves.toMatchObject({
      content: 'main checkout',
    })
  })

  it('does not let one thread’s worktree reach another project’s tree', async () => {
    // The owner checkout is the ONLY widening: a second registered project is
    // still off-limits from inside this thread's worktree.
    symlinkSync(elsewhereDir, join(worktreeDir, 'other-project'))
    await expect(readProjectFile(gate, worktreeDir, 'other-project/secret.txt')).rejects.toThrow(
      /escapes the project folder/,
    )
  })
})

// ── Content search (project:searchContent) ─────────────────────────────────
//
// The fs-backed wrapper over the pure searchFiles core (unit-tested in
// content-search.test.ts). Here we assert the real-fs behavior: matches from a
// temp-dir root, root validation, that a symlink out of the root is not read,
// and the short-TTL cache with an injected clock.
describe('searchProjectContent', () => {
  let tempDir: string
  let rootDir: string
  let outsideDir: string
  let manager: AddressableRoots

  const savedVaultEnv = process.env.PLAN_FLOW_VAULT_DIR

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-search-'))
    rootDir = join(tempDir, 'project')
    outsideDir = join(tempDir, 'outside')
    mkdirSync(rootDir)
    mkdirSync(join(rootDir, 'src'))
    mkdirSync(outsideDir)
    process.env.PLAN_FLOW_VAULT_DIR = outsideDir
    writeFileSync(join(rootDir, 'a.ts'), 'const needle = 1\n')
    writeFileSync(join(rootDir, 'src', 'b.ts'), 'no match here\n')
    writeFileSync(join(rootDir, 'src', 'c.ts'), 'another needle line\n')
    writeFileSync(join(outsideDir, 'secret.txt'), 'needle outside the root\n')
    manager = stubRoots(rootDir)
    forgetContentSearchCache()
  })

  afterEach(() => {
    if (savedVaultEnv === undefined) delete process.env.PLAN_FLOW_VAULT_DIR
    else process.env.PLAN_FLOW_VAULT_DIR = savedVaultEnv
    forgetContentSearchCache()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns the files that contain the query, with line matches', async () => {
    const result = await searchProjectContent(manager, rootDir, { query: 'needle' }, () => 1_000)
    expect(result.files.map((f) => f.relPath)).toEqual(['a.ts', 'src/c.ts'])
    expect(result.files[0].matches[0]).toEqual({ line: 1, column: 6, preview: 'const needle = 1' })
    expect(result.truncated).toBe(false)
  })

  it('rejects an unknown / unaddressable root (untrusted renderer input)', async () => {
    await expect(
      searchProjectContent(manager, outsideDir, { query: 'needle' }),
    ).rejects.toThrow(/Unknown root/)
  })

  it('returns no matches for an empty or whitespace query without touching the fs', async () => {
    expect(await searchProjectContent(manager, rootDir, { query: '' })).toEqual({
      files: [],
      truncated: false,
    })
    expect(await searchProjectContent(manager, rootDir, { query: '   ' })).toEqual({
      files: [],
      truncated: false,
    })
  })

  it('does not read a file linked out of the root', async () => {
    // A symlink inside the root pointing at a file outside it must not be read —
    // the fs dir reader classifies only real files, so the link is skipped.
    // Symlink creation needs privilege on Windows; skip the assertion (rather
    // than fail spuriously) where the OS refuses it — the guarantee is the fs
    // reader's, exercised on platforms that allow the link.
    try {
      symlinkSync(join(outsideDir, 'secret.txt'), join(rootDir, 'leak.txt'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return
      throw error
    }
    forgetContentSearchCache()
    const result = await searchProjectContent(manager, rootDir, { query: 'needle' }, () => 1_000)
    expect(result.files.map((f) => f.relPath)).not.toContain('leak.txt')
    expect(result.files.map((f) => f.relPath)).toEqual(['a.ts', 'src/c.ts'])
  })

  it('serves a cached result inside the TTL window and re-walks after it', async () => {
    const first = await searchProjectContent(manager, rootDir, { query: 'needle' }, () => 1_000)
    writeFileSync(join(rootDir, 'src', 'd.ts'), 'needle added later\n')
    const cached = await searchProjectContent(manager, rootDir, { query: 'needle' }, () => 2_000)
    // Identity: the second call did not re-walk.
    expect(cached).toBe(first)
    const later = await searchProjectContent(manager, rootDir, { query: 'needle' }, () => 60_000)
    expect(later.files.map((f) => f.relPath)).toContain('src/d.ts')
  })

  it('forgets a root that was removed', async () => {
    const first = await searchProjectContent(manager, rootDir, { query: 'needle' }, () => 1_000)
    forgetContentSearchCache(rootDir)
    writeFileSync(join(rootDir, 'src', 'd.ts'), 'needle added later\n')
    const after = await searchProjectContent(manager, rootDir, { query: 'needle' }, () => 1_100)
    expect(after).not.toBe(first)
    expect(after.files.map((f) => f.relPath)).toContain('src/d.ts')
  })
})
