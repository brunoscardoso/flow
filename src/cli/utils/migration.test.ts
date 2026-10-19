/**
 * Tests for migration flow logic (centralize flow in brain)
 *
 * Tests the three-way detection and migration logic by simulating
 * the building blocks: moveContents, isSymlink, createSymlink.
 */

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isSymlink,
  moveContents,
  createSymlink,
  ensureDir,
  removeDir,
} from './files';

function createTempDir(): string {
  const dir = join(tmpdir(), `plan-flow-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('migration: new project setup', () => {
  let tempDir: string;
  let brainDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    brainDir = join(tempDir, 'brain');
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create brain dir and symlink for new project', () => {
    const projectFlowDir = join(tempDir, 'project', 'flow');
    const brainProjectDir = join(brainDir, 'project-flow');

    // Simulate new project: no flow/ exists yet
    // Step 1: Create brain directory
    ensureDir(brainProjectDir);
    expect(existsSync(brainProjectDir)).toBe(true);

    // Step 2: Create symlink from project/flow -> brain/project-flow
    createSymlink(brainProjectDir, projectFlowDir);

    expect(existsSync(projectFlowDir)).toBe(true);
    expect(isSymlink(projectFlowDir)).toBe(true);
    expect(lstatSync(projectFlowDir).isSymbolicLink()).toBe(true);
  });
});

describe('migration: existing project with real flow/ dir', () => {
  let tempDir: string;
  let brainDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    brainDir = join(tempDir, 'brain');
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should move contents from flow/ to brain and create symlink', () => {
    const projectDir = join(tempDir, 'project');
    const flowDir = join(projectDir, 'flow');
    const brainProjectDir = join(brainDir, 'project-flow');

    // Create existing flow/ with real files
    mkdirSync(join(flowDir, 'plans'), { recursive: true });
    mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
    writeFileSync(join(flowDir, 'tasklist.md'), '# Tasklist\n- [ ] Task 1\n');
    writeFileSync(join(flowDir, 'plans', 'plan_auth_v1.md'), '# Plan: Auth\n');
    writeFileSync(join(flowDir, 'brain', 'features', 'auth.md'), '# Auth Feature\n');
    writeFileSync(join(flowDir, '.flowconfig'), 'autopilot: false\n');

    // Verify it is NOT a symlink (real directory)
    expect(isSymlink(flowDir)).toBe(false);

    // Step 1: Create brain target directory
    ensureDir(brainProjectDir);

    // Step 2: Move contents from flow/ to brain
    const result = moveContents(flowDir, brainProjectDir);
    expect(result.errors).toHaveLength(0);
    expect(result.moved).toBeGreaterThan(0);

    // Step 3: Remove the now-empty flow directory
    removeDir(flowDir);
    expect(existsSync(flowDir)).toBe(false);

    // Step 4: Create symlink
    createSymlink(brainProjectDir, flowDir);

    // Verify: symlink exists
    expect(isSymlink(flowDir)).toBe(true);

    // Verify: files accessible through the symlink
    expect(existsSync(join(flowDir, 'tasklist.md'))).toBe(true);
    expect(existsSync(join(flowDir, 'plans', 'plan_auth_v1.md'))).toBe(true);
    expect(existsSync(join(flowDir, 'brain', 'features', 'auth.md'))).toBe(true);
    expect(existsSync(join(flowDir, '.flowconfig'))).toBe(true);

    // Verify: file contents preserved after migration
    expect(readFileSync(join(flowDir, 'tasklist.md'), 'utf-8')).toBe('# Tasklist\n- [ ] Task 1\n');
    expect(readFileSync(join(flowDir, 'plans', 'plan_auth_v1.md'), 'utf-8')).toBe('# Plan: Auth\n');

    // Verify: brain directory has the files
    expect(existsSync(join(brainProjectDir, 'tasklist.md'))).toBe(true);
    expect(existsSync(join(brainProjectDir, 'plans', 'plan_auth_v1.md'))).toBe(true);
  });
});

describe('migration: already migrated project', () => {
  let tempDir: string;
  let brainDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    brainDir = join(tempDir, 'brain');
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should skip migration when flow/ is already a symlink', () => {
    const projectDir = join(tempDir, 'project');
    const flowDir = join(projectDir, 'flow');
    const brainProjectDir = join(brainDir, 'project-flow');

    // Setup: brain dir with content, flow/ is already a symlink
    ensureDir(brainProjectDir);
    writeFileSync(join(brainProjectDir, 'tasklist.md'), '# Tasklist\n');

    mkdirSync(join(projectDir), { recursive: true });
    createSymlink(brainProjectDir, flowDir);

    // Verify it IS a symlink
    expect(isSymlink(flowDir)).toBe(true);

    // Migration check: if isSymlink, skip
    // This is the detection logic used in the init handler
    const needsMigration = !isSymlink(flowDir);
    expect(needsMigration).toBe(false);

    // Symlink is preserved, content accessible
    expect(existsSync(join(flowDir, 'tasklist.md'))).toBe(true);
    expect(readFileSync(join(flowDir, 'tasklist.md'), 'utf-8')).toBe('# Tasklist\n');
  });
});

describe('migration: old symlink cleanup', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should detect and remove old-style individual symlinks', () => {
    const vaultProjectDir = join(tempDir, 'vault', 'projects', 'my-project');
    const flowDir = join(tempDir, 'project', 'flow');

    // Create the flow directory structure
    mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
    mkdirSync(join(flowDir, 'brain', 'errors'), { recursive: true });
    mkdirSync(join(flowDir, 'plans'), { recursive: true });
    mkdirSync(join(flowDir, 'discovery'), { recursive: true });

    // Create old-style individual symlinks in vault project dir
    mkdirSync(vaultProjectDir, { recursive: true });
    symlinkSync(join(flowDir, 'brain', 'features'), join(vaultProjectDir, 'features'));
    symlinkSync(join(flowDir, 'brain', 'errors'), join(vaultProjectDir, 'errors'));
    symlinkSync(join(flowDir, 'plans'), join(vaultProjectDir, 'plans'));
    symlinkSync(join(flowDir, 'discovery'), join(vaultProjectDir, 'discovery'));

    // Verify old symlinks exist
    expect(isSymlink(join(vaultProjectDir, 'features'))).toBe(true);
    expect(isSymlink(join(vaultProjectDir, 'errors'))).toBe(true);
    expect(isSymlink(join(vaultProjectDir, 'plans'))).toBe(true);
    expect(isSymlink(join(vaultProjectDir, 'discovery'))).toBe(true);

    // Simulate cleanup: remove old-style individual symlinks
    const oldLinks = ['features', 'errors', 'plans', 'discovery'];
    for (const linkName of oldLinks) {
      const linkPath = join(vaultProjectDir, linkName);
      if (isSymlink(linkPath)) {
        unlinkSync(linkPath);
      }
    }

    // Verify old symlinks are removed
    expect(existsSync(join(vaultProjectDir, 'features'))).toBe(false);
    expect(existsSync(join(vaultProjectDir, 'errors'))).toBe(false);
    expect(existsSync(join(vaultProjectDir, 'plans'))).toBe(false);
    expect(existsSync(join(vaultProjectDir, 'discovery'))).toBe(false);

    // Vault project directory still exists
    expect(existsSync(vaultProjectDir)).toBe(true);
  });
});
