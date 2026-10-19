/**
 * Tests for file utilities
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getPackageRoot,
  copyDir,
  copyFile,
  ensureDir,
  fileExists,
  getVaultDir,
  createSymlink,
  readSymlinkTarget,
  getProjectName,
  isSymlink,
  moveContents,
  classifyLinkTarget,
  danglingLinkOrigin,
  describeDanglingLink,
  inspectFlowLink,
} from './files';

function createTempDir(): string {
  const dir = join(tmpdir(), `plan-flow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('getPackageRoot', () => {
  it('should resolve to a directory containing package.json', () => {
    const root = getPackageRoot();
    expect(existsSync(join(root, 'package.json'))).toBe(true);
  });
});

describe('ensureDir', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create nested directories', () => {
    const nested = join(tempDir, 'a', 'b', 'c');
    expect(existsSync(nested)).toBe(false);

    ensureDir(nested);

    expect(existsSync(nested)).toBe(true);
  });

  it('should not throw if directory already exists', () => {
    expect(() => ensureDir(tempDir)).not.toThrow();
  });
});

describe('fileExists', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should return true for existing file', () => {
    const file = join(tempDir, 'test.txt');
    writeFileSync(file, 'hello');
    expect(fileExists(file)).toBe(true);
  });

  it('should return false for non-existing file', () => {
    expect(fileExists(join(tempDir, 'nonexistent.txt'))).toBe(false);
  });
});

describe('copyFile', () => {
  let tempDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    srcDir = join(tempDir, 'src');
    destDir = join(tempDir, 'dest');
    mkdirSync(srcDir, { recursive: true });
    mkdirSync(destDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should copy a file to destination', () => {
    const src = join(srcDir, 'file.txt');
    const dest = join(destDir, 'file.txt');
    writeFileSync(src, 'content');

    const result = copyFile(src, dest, { force: false });

    expect(result.created).toEqual([dest]);
    expect(result.skipped).toEqual([]);
    expect(readFileSync(dest, 'utf-8')).toBe('content');
  });

  it('should skip existing files when force is false', () => {
    const src = join(srcDir, 'file.txt');
    const dest = join(destDir, 'file.txt');
    writeFileSync(src, 'new content');
    writeFileSync(dest, 'old content');

    const result = copyFile(src, dest, { force: false });

    expect(result.skipped).toEqual([dest]);
    expect(result.created).toEqual([]);
    expect(readFileSync(dest, 'utf-8')).toBe('old content');
  });

  it('should overwrite existing files when force is true', () => {
    const src = join(srcDir, 'file.txt');
    const dest = join(destDir, 'file.txt');
    writeFileSync(src, 'new content');
    writeFileSync(dest, 'old content');

    const result = copyFile(src, dest, { force: true });

    expect(result.updated).toEqual([dest]);
    expect(readFileSync(dest, 'utf-8')).toBe('new content');
  });

  it('should create parent directories if needed', () => {
    const src = join(srcDir, 'file.txt');
    const dest = join(destDir, 'sub', 'dir', 'file.txt');
    writeFileSync(src, 'content');

    const result = copyFile(src, dest, { force: false });

    expect(result.created).toEqual([dest]);
    expect(readFileSync(dest, 'utf-8')).toBe('content');
  });
});

describe('copyDir', () => {
  let tempDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    srcDir = join(tempDir, 'src');
    destDir = join(tempDir, 'dest');
    mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should copy files preserving directory structure', () => {
    // Create source structure
    mkdirSync(join(srcDir, 'sub'), { recursive: true });
    writeFileSync(join(srcDir, 'root.txt'), 'root');
    writeFileSync(join(srcDir, 'sub', 'nested.txt'), 'nested');

    const result = copyDir(srcDir, destDir, { force: false });

    expect(result.created).toHaveLength(2);
    expect(readFileSync(join(destDir, 'root.txt'), 'utf-8')).toBe('root');
    expect(readFileSync(join(destDir, 'sub', 'nested.txt'), 'utf-8')).toBe('nested');
  });

  it('should skip existing files when force is false', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'new');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'file.txt'), 'old');

    const result = copyDir(srcDir, destDir, { force: false });

    expect(result.skipped).toHaveLength(1);
    expect(result.created).toHaveLength(0);
    expect(readFileSync(join(destDir, 'file.txt'), 'utf-8')).toBe('old');
  });

  it('should overwrite when force is true', () => {
    writeFileSync(join(srcDir, 'file.txt'), 'new');
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, 'file.txt'), 'old');

    const result = copyDir(srcDir, destDir, { force: true });

    expect(result.updated).toHaveLength(1);
    expect(readFileSync(join(destDir, 'file.txt'), 'utf-8')).toBe('new');
  });

  it('should return empty result for non-existing source', () => {
    const result = copyDir(join(tempDir, 'nonexistent'), destDir, { force: false });

    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
  });
});

describe('getVaultDir', () => {
  const originalEnv = process.env.PLAN_FLOW_VAULT_DIR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PLAN_FLOW_VAULT_DIR;
    } else {
      process.env.PLAN_FLOW_VAULT_DIR = originalEnv;
    }
  });

  it('should return a path ending with plan-flow/brain when env var is not set', () => {
    delete process.env.PLAN_FLOW_VAULT_DIR;
    const dir = getVaultDir();
    expect(dir).toMatch(/plan-flow[/\\]brain$/);
  });

  it('should return env var value when PLAN_FLOW_VAULT_DIR is set', () => {
    process.env.PLAN_FLOW_VAULT_DIR = '/tmp/custom-vault';
    const dir = getVaultDir();
    expect(dir).toBe('/tmp/custom-vault');
  });
});

describe('getProjectName', () => {
  it('should return the basename of a path', () => {
    expect(getProjectName('/home/user/projects/my-app')).toBe('my-app');
  });

  it('should handle trailing slashes', () => {
    expect(getProjectName('/home/user/projects/my-app/')).toBe('my-app');
  });
});

describe('createSymlink and readSymlinkTarget', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create a symlink and read its target', () => {
    const targetDir = join(tempDir, 'target');
    const linkPath = join(tempDir, 'link');
    mkdirSync(targetDir, { recursive: true });

    createSymlink(targetDir, linkPath);

    expect(existsSync(linkPath)).toBe(true);
    const stat = lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);

    const target = readSymlinkTarget(linkPath);
    expect(target).toBe(targetDir);
  });

  it('should replace an existing symlink', () => {
    const target1 = join(tempDir, 'target1');
    const target2 = join(tempDir, 'target2');
    const linkPath = join(tempDir, 'link');
    mkdirSync(target1, { recursive: true });
    mkdirSync(target2, { recursive: true });

    createSymlink(target1, linkPath);
    expect(readSymlinkTarget(linkPath)).toBe(target1);

    createSymlink(target2, linkPath);
    expect(readSymlinkTarget(linkPath)).toBe(target2);
  });

  it('leaves a link that already points to the target untouched (live 2026-10-06: a re-link left orbit-app without flow/ for a moment)', () => {
    const target = join(tempDir, 'target')
    const linkPath = join(tempDir, 'link')
    mkdirSync(target, { recursive: true })
    createSymlink(target, linkPath)
    const before = lstatSync(linkPath)
    createSymlink(target, linkPath)
    const after = lstatSync(linkPath)
    // The same link entry — never removed and re-made.
    expect(after.ino).toBe(before.ino)
    expect(readSymlinkTarget(linkPath)).toBe(target)
  });

  it('swaps a link to a new target in one step and leaves no temporary link behind', () => {
    const target1 = join(tempDir, 'one')
    const target2 = join(tempDir, 'two')
    const linkPath = join(tempDir, 'link')
    mkdirSync(target1, { recursive: true })
    mkdirSync(target2, { recursive: true })
    createSymlink(target1, linkPath)
    createSymlink(target2, linkPath)
    expect(readSymlinkTarget(linkPath)).toBe(target2)
    expect(readdirSync(tempDir).sort()).toEqual(['link', 'one', 'two'])
  });

  it('should return null for non-symlink paths', () => {
    const filePath = join(tempDir, 'file.txt');
    writeFileSync(filePath, 'hello');

    expect(readSymlinkTarget(filePath)).toBeNull();
  });

  it('should return null for non-existent paths', () => {
    expect(readSymlinkTarget(join(tempDir, 'nonexistent'))).toBeNull();
  });

  it('should create parent directories for symlink', () => {
    const targetDir = join(tempDir, 'target');
    const linkPath = join(tempDir, 'nested', 'deep', 'link');
    mkdirSync(targetDir, { recursive: true });

    createSymlink(targetDir, linkPath);

    expect(existsSync(linkPath)).toBe(true);
  });
});

describe('isSymlink', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should return true for symlinks', () => {
    const targetDir = join(tempDir, 'target');
    const linkPath = join(tempDir, 'link');
    mkdirSync(targetDir, { recursive: true });
    createSymlink(targetDir, linkPath);

    expect(isSymlink(linkPath)).toBe(true);
  });

  it('should return false for regular directories', () => {
    const dir = join(tempDir, 'regular');
    mkdirSync(dir, { recursive: true });

    expect(isSymlink(dir)).toBe(false);
  });

  it('should return false for non-existent paths', () => {
    expect(isSymlink(join(tempDir, 'nonexistent'))).toBe(false);
  });
});

// ── Dangling `flow` link detection (FR9) ─────────────────────────────────────
// The two link kinds are a WSL-created POSIX symlink (dangles from Windows) and
// a Windows-created junction (dangles from WSL/macOS). The classification and
// message functions take a platform argument so BOTH kinds are asserted from
// whichever host happens to run the suite.

describe('classifyLinkTarget', () => {
  it('classifies POSIX-absolute targets', () => {
    expect(classifyLinkTarget('/home/dev/plan-flow/brain/projects/x/flow')).toBe('posix');
  });

  it('classifies Windows drive and UNC targets', () => {
    expect(classifyLinkTarget('C:\\Users\\devuser\\plan-flow\\brain')).toBe('windows');
    expect(classifyLinkTarget('C:/Users/devuser/plan-flow/brain')).toBe('windows');
    expect(classifyLinkTarget('\\\\wsl.localhost\\Ubuntu\\home\\devuser')).toBe('windows');
  });

  it('classifies relative targets', () => {
    expect(classifyLinkTarget('../vault/flow')).toBe('relative');
  });

  it('classifies an unreadable reparse point', () => {
    expect(classifyLinkTarget(null)).toBe('unreadable');
    expect(classifyLinkTarget('')).toBe('unreadable');
  });
});

describe('danglingLinkOrigin', () => {
  it('names WSL for a POSIX target seen from Windows', () => {
    expect(danglingLinkOrigin('posix', 'win32')).toBe('wsl');
  });

  it('names WSL for a reparse point Windows cannot decode', () => {
    expect(danglingLinkOrigin('unreadable', 'win32')).toBe('wsl');
  });

  it('names Windows for a Windows target seen from a POSIX host', () => {
    expect(danglingLinkOrigin('windows', 'darwin')).toBe('windows');
    expect(danglingLinkOrigin('windows', 'linux')).toBe('windows');
  });

  it('claims no origin for a same-environment broken link', () => {
    // A Windows target that dangles ON Windows is just a moved directory.
    expect(danglingLinkOrigin('windows', 'win32')).toBe('unknown');
    // Likewise a POSIX target that dangles on a POSIX host.
    expect(danglingLinkOrigin('posix', 'darwin')).toBe('unknown');
    expect(danglingLinkOrigin('relative', 'win32')).toBe('unknown');
    expect(danglingLinkOrigin('unreadable', 'darwin')).toBe('unknown');
  });
});

describe('describeDanglingLink', () => {
  it('names WSL, the cause, and a Windows removal command', () => {
    const msg = describeDanglingLink('C:\\repo\\flow', '/home/dev/flow', 'wsl', 'win32');
    expect(msg).toContain('flow link does not resolve');
    expect(msg).toContain('/home/dev/flow');
    expect(msg).toContain('WSL');
    expect(msg).toContain('rmdir "C:\\repo\\flow"');
    expect(msg).toContain('planflow-ai init');
  });

  it('names Windows and a POSIX removal command from a POSIX host', () => {
    const msg = describeDanglingLink('/repo/flow', 'C:\\Users\\devuser\\brain\\flow', 'windows', 'linux');
    expect(msg).toContain('Windows');
    expect(msg).toContain('rm "/repo/flow"');
    expect(msg).toContain('planflow-ai init');
  });

  it('labels an unreadable reparse point rather than printing null', () => {
    const msg = describeDanglingLink('C:\\repo\\flow', null, 'wsl', 'win32');
    expect(msg).toContain('(unreadable reparse point)');
    expect(msg).not.toContain('null');
  });

  it('stays generic when no origin can be claimed', () => {
    const msg = describeDanglingLink('/repo/flow', '/gone/flow', 'unknown', 'linux');
    expect(msg).toContain('does not exist in this environment');
    expect(msg).not.toContain('WSL');
  });
});

describe('inspectFlowLink', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('reports a resolving link', () => {
    const targetDir = join(tempDir, 'vault');
    const linkPath = join(tempDir, 'flow');
    mkdirSync(targetDir, { recursive: true });
    createSymlink(targetDir, linkPath);

    const report = inspectFlowLink(linkPath);

    expect(report.status).toBe('resolves');
    expect(report.message).toBeNull();
    expect(report.target).toBe(targetDir);
  });

  it('reports a real directory as not-a-link', () => {
    const dir = join(tempDir, 'flow');
    mkdirSync(dir, { recursive: true });

    expect(inspectFlowLink(dir).status).toBe('not-a-link');
  });

  it('reports a missing path as absent', () => {
    const report = inspectFlowLink(join(tempDir, 'nope'));
    expect(report.status).toBe('absent');
    expect(report.message).toBeNull();
  });

  // Link kind 1: created under WSL, read from Windows.
  it('identifies a WSL-created POSIX symlink as dangling from Windows', () => {
    const linkPath = join(tempDir, 'flow');
    symlinkSync('/home/dev/plan-flow/brain/projects/demo/flow', linkPath);

    const report = inspectFlowLink(linkPath, 'win32');

    expect(report.status).toBe('dangling');
    expect(report.origin).toBe('wsl');
    expect(report.target).toBe('/home/dev/plan-flow/brain/projects/demo/flow');
    expect(report.message).toContain('WSL');
    expect(report.message).toContain('rmdir');
  });

  // Link kind 2: created on Windows (junction), read from WSL/macOS.
  it('identifies a Windows-created link as dangling from a POSIX host', () => {
    const linkPath = join(tempDir, 'flow');
    symlinkSync('C:\\Users\\devuser\\plan-flow\\brain\\projects\\demo\\flow', linkPath);

    const report = inspectFlowLink(linkPath, 'linux');

    expect(report.status).toBe('dangling');
    expect(report.origin).toBe('windows');
    expect(report.message).toContain('Windows');
    expect(report.message).toContain('rm "');
  });

  it('reports a same-environment broken link without blaming another OS', () => {
    const linkPath = join(tempDir, 'flow');
    symlinkSync(join(tempDir, 'deleted-vault'), linkPath);

    const report = inspectFlowLink(linkPath, 'linux');

    expect(report.status).toBe('dangling');
    expect(report.origin).toBe('unknown');
    expect(report.message).not.toContain('WSL');
  });
});

describe('createSymlink with a dangling link in the way', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('replaces a dangling cross-environment link and reports what it replaced', () => {
    const linkPath = join(tempDir, 'flow');
    const targetDir = join(tempDir, 'vault');
    mkdirSync(targetDir, { recursive: true });
    // The live shape: a POSIX symlink into WSL sitting where flow/ belongs.
    symlinkSync('/home/dev/plan-flow/brain/projects/demo/flow', linkPath);

    const replaced = createSymlink(targetDir, linkPath);

    expect(replaced?.status).toBe('dangling');
    expect(replaced?.target).toBe('/home/dev/plan-flow/brain/projects/demo/flow');
    expect(existsSync(linkPath)).toBe(true);
    expect(readSymlinkTarget(linkPath)).toBe(targetDir);
  });

  it('returns null when there was no dangling link to replace', () => {
    const linkPath = join(tempDir, 'flow');
    const targetDir = join(tempDir, 'vault');
    mkdirSync(targetDir, { recursive: true });

    expect(createSymlink(targetDir, linkPath)).toBeNull();
  });
});

describe('moveContents', () => {
  let tempDir: string;
  let srcDir: string;
  let destDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    srcDir = join(tempDir, 'src');
    destDir = join(tempDir, 'dest');
    mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should move files and directories', () => {
    writeFileSync(join(srcDir, 'file1.txt'), 'content1');
    writeFileSync(join(srcDir, 'file2.txt'), 'content2');
    mkdirSync(join(srcDir, 'subdir'));
    writeFileSync(join(srcDir, 'subdir', 'nested.txt'), 'nested');

    moveContents(srcDir, destDir);

    expect(existsSync(join(destDir, 'file1.txt'))).toBe(true);
    expect(existsSync(join(destDir, 'file2.txt'))).toBe(true);
    expect(existsSync(join(destDir, 'subdir', 'nested.txt'))).toBe(true);

    // Source should be empty (directory itself remains, but contents moved)
    const remaining = readdirSync(srcDir);
    expect(remaining).toHaveLength(0);
  });

  it('should handle dotfiles', () => {
    writeFileSync(join(srcDir, '.hidden'), 'secret');
    writeFileSync(join(srcDir, '.config'), 'settings');

    moveContents(srcDir, destDir);

    expect(existsSync(join(destDir, '.hidden'))).toBe(true);
    expect(existsSync(join(destDir, '.config'))).toBe(true);
    expect(readFileSync(join(destDir, '.hidden'), 'utf-8')).toBe('secret');
  });

  it('should return correct count', () => {
    writeFileSync(join(srcDir, 'a.txt'), 'a');
    writeFileSync(join(srcDir, 'b.txt'), 'b');
    mkdirSync(join(srcDir, 'subdir'));
    writeFileSync(join(srcDir, 'subdir', 'c.txt'), 'c');

    const result = moveContents(srcDir, destDir);

    // moveContents moves top-level entries: a.txt, b.txt, subdir = 3
    expect(result.moved).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it('should preserve file contents', () => {
    const knownContent = 'Hello, world! Special chars: é à ü 日本語 🎉';
    writeFileSync(join(srcDir, 'data.txt'), knownContent, 'utf-8');

    moveContents(srcDir, destDir);

    const readBack = readFileSync(join(destDir, 'data.txt'), 'utf-8');
    expect(readBack).toBe(knownContent);
  });
});
