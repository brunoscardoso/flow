/**
 * The feature store's half of a lock it shares with the Flow app.
 *
 * The app's compaction pass has locked `flow/brain/.structure/features.lock`
 * since Phase 1; these verbs did not. So the interlock worked in exactly one
 * order — app second — and in the other the CLI walked in, read a feature, and
 * rewrote it over whatever compaction had just promoted into it.
 *
 * What has to be true is a FILE, not an API: the two processes share nothing
 * else. So these tests check the file. `does the CLI wait for a holder` is
 * proved against a real lock file held by a real second process — the strongest
 * available short of running Electron, and the only shape that fails when the
 * lock is absent. `is it the same file the app takes` is proved by deriving the
 * app's path from the app's own source rather than restating it here, so a
 * rename on either side breaks this test instead of quietly splitting the two
 * processes into separate locks that each believe they are safe.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileLockTimeoutError } from '../loop/file-lock.js';
import {
  featureStoreLockPath,
  mintFeatureId,
  readFeatures,
  writeFeature,
  type FeatureNode,
} from './feature-store.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** How long the stand-in holder keeps the lock before releasing it. */
const HOLD_MS = 500;
/** The wait we require to have observed — comfortably under HOLD_MS. */
const MIN_BLOCKED_MS = 300;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'feature-store-lock-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function feature(slug: string): FeatureNode {
  return {
    id: mintFeatureId(slug),
    slug,
    name: slug,
    kind: 'core',
    anchors: [],
    relates: [],
    lastFullRead: null,
    patchCount: 0,
    body: `# ${slug}\n\nProse.\n`,
    extra: {},
  };
}

/** Seed a flow dir with one feature, and return it. */
function seedFlowDir(flowDir: string): string {
  mkdirSync(join(flowDir, 'brain', 'features'), { recursive: true });
  mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
  writeFileSync(join(flowDir, 'brain', 'features', 'alpha.md'), '# alpha\n\nProse.\n', 'utf-8');
  return flowDir;
}

/**
 * Take `lockPath` the way another PROCESS would, and release it after HOLD_MS.
 *
 * The release has to come from outside this process: these verbs are
 * synchronous, so a CLI waiting on the lock blocks the event loop and no timer
 * of ours would ever fire. A child holding it is also the honest shape — the
 * writer this lock exists to interlock with is the app, in its own process.
 */
function holdLockInChildProcess(lockPath: string): { kill: () => void } {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, 'stand-in-holder', { flag: 'wx' });
  const script = `setTimeout(() => { try { require('fs').unlinkSync(${JSON.stringify(lockPath)}) } catch {} }, ${HOLD_MS})`;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  child.unref();
  return { kill: () => child.kill() };
}

describe('the CLI takes the same lock the app takes', () => {
  it('waits for a holder of the app-derived lock file, then writes', () => {
    const flowDir = seedFlowDir(join(tempDir, 'flow'));
    // The path the APP computes, spelled the app's way (root + its own
    // subdir constant), NOT via featureStoreLockPath — a CLI that took some
    // other file would sail past this holder.
    const appLockPath = join(tempDir, 'flow/brain/.structure', 'features.lock');
    const holder = holdLockInChildProcess(appLockPath);

    const startedAt = Date.now();
    try {
      writeFeature(flowDir, feature('beta'));
    } finally {
      holder.kill();
    }
    const blockedMs = Date.now() - startedAt;

    expect(blockedMs).toBeGreaterThanOrEqual(MIN_BLOCKED_MS);
    expect(readFeatures(flowDir).map((node) => node.slug).sort()).toEqual(['alpha', 'beta']);
    // Released, not leaked — the next writer must not find a dead lock.
    expect(existsSync(appLockPath)).toBe(false);
  });

  it('contends through a symlinked flow/ — the routes differ, the file does not', () => {
    // This repo's own `flow/` is a symlink into the central vault, so the app
    // and a CLI verb genuinely can arrive by different paths. An exclusive
    // create resolves the link before deciding the file exists, so they still
    // meet on one file — that is what makes the shared lock work at all.
    const vaultFlow = seedFlowDir(join(tempDir, 'vault', 'flow'));
    const projectRoot = join(tempDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    const linkedFlow = join(projectRoot, 'flow');
    symlinkSync(vaultFlow, linkedFlow, 'dir');

    // Held via the SYMLINK route (what the app, running on the project root,
    // would compute); written via the vault route.
    const holder = holdLockInChildProcess(join(linkedFlow, 'brain/.structure', 'features.lock'));
    expect(featureStoreLockPath(vaultFlow)).not.toBe(featureStoreLockPath(linkedFlow));

    const startedAt = Date.now();
    try {
      writeFeature(vaultFlow, feature('gamma'));
    } finally {
      holder.kill();
    }

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(MIN_BLOCKED_MS);
    expect(readFeatures(vaultFlow).map((node) => node.slug).sort()).toEqual(['alpha', 'gamma']);
  });

  it('reclaims a lock whose holder is gone rather than wedging forever', () => {
    const flowDir = seedFlowDir(join(tempDir, 'flow'));
    const lockPath = featureStoreLockPath(flowDir);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '999999', 'utf-8');
    const longDead = new Date(Date.now() - 60_000);
    utimesSync(lockPath, longDead, longDead);

    expect(() => writeFeature(flowDir, feature('delta'))).not.toThrow();
    expect(readFeatures(flowDir).map((node) => node.slug)).toContain('delta');
  });

  it('exports the refusal a caller can tell apart from an I/O failure', () => {
    // Not exercised end-to-end here: the real wait is thirty seconds, and a
    // suite that spends thirty seconds proving a timeout is a suite nobody
    // runs. The waiting path itself is covered by the first test.
    expect(new FileLockTimeoutError('/x/features.lock', 30_000).name).toBe('FileLockTimeoutError');
  });
});

describe('the lock path the app computes and the one the CLI computes', () => {
  /**
   * Derived from the APP'S OWN SOURCE, not restated. The two processes share
   * no code, so the only thing that can keep them on one file is that nobody
   * renames half of it — and the only way a test can notice a rename is to read
   * the other side rather than a copy of it.
   */
  function appFeatureStoreLockPath(rootPath: string): string {
    const storeSource = readFileSync(join(REPO_ROOT, 'app/src/main/brain/store.ts'), 'utf-8');
    const compactionSource = readFileSync(
      join(REPO_ROOT, 'app/src/main/brain/compaction.ts'),
      'utf-8',
    );
    const structureRel = /^\s*structure:\s*'([^']+)'/m.exec(storeSource)?.[1];
    const lockFilename = /BRAIN_SUBDIRS\.structure,\s*'([^']+)'/.exec(compactionSource)?.[1];
    if (structureRel === undefined || lockFilename === undefined) {
      throw new Error(
        'could not read the app’s feature-store lock path from its source — if the app moved or ' +
          'renamed it, the CLI’s featureStoreLockPath has to move with it or the two stop interlocking',
      );
    }
    return join(rootPath, structureRel, lockFilename);
  }

  it('are the same path for the same project root', () => {
    const rootPath = join(tempDir, 'project');
    expect(featureStoreLockPath(join(rootPath, 'flow'))).toBe(appFeatureStoreLockPath(rootPath));
  });
});
