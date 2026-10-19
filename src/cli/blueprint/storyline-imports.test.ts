/**
 * The import index never blocks a budgeted read, and is built in the
 * background — one build per project at a time.
 *
 * Why it matters: a cold index made `blueprint features graph` open every
 * TS/JS file serially; on a fresh checkout that was 16–19 s, against the app's
 * 30 s timeout. The graph now reads with a budget and answers partial; the
 * warm build (`blueprint index warm`) makes the next read whole.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readProjectFeatureGraph, readProjectFeatureGraphPrefetched } from './feature-graph-read.js';
import {
  IMPORT_INDEX_FILENAME,
  IMPORT_INDEX_LOCK_FILENAME,
  IMPORT_INDEX_LOCK_STALE_MS,
  MAX_SPECIFIER_FILE_BYTES,
  importIndexWarmRunning,
  readProjectImportIndex,
  storylineCacheDir,
  warmProjectImportIndex,
} from './storyline-imports.js';
import { requestImportIndexWarm } from './storyline-index-warm.js';
import { StorylineReaders } from './storyline-reader.js';

let root: string;

/** A repo with `flow/`, a feature anchored at `src/app/main.ts`, and `extra` filler files. */
function makeRepo(extra = 0): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pf-import-index-')));
  mkdirSync(join(dir, 'src', 'app'), { recursive: true });
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app', 'main.ts'), "import { helper } from '../lib/helper';\nexport const main = helper();\n");
  writeFileSync(join(dir, 'src', 'lib', 'helper.ts'), 'export function helper(): number {\n  return 1;\n}\n');
  for (let i = 0; i < extra; i += 1) writeFileSync(join(dir, 'src', 'lib', `filler${i}.ts`), `export const f${i} = ${i};\n`);
  const features = join(dir, 'flow', 'brain', 'features');
  mkdirSync(features, { recursive: true });
  writeFileSync(
    join(features, 'app.md'),
    '---\nid: feature:app\nname: App\nkind: core\nanchors: [file:src/app/main.ts]\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n\n# App\n\nThe app.\n',
  );
  return dir;
}

function cacheDir(): string {
  const dir = storylineCacheDir(root);
  if (dir === null) throw new Error('no cache dir');
  return dir;
}

function read(budget?: number) {
  return readProjectImportIndex(root, new StorylineReaders(), cacheDir(), budget === undefined ? {} : { readBudget: budget });
}

beforeEach(() => {
  root = makeRepo(5);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a budgeted read of a cold index', () => {
  it('answers with the whole file list, no edges, complete: false — and writes nothing', () => {
    const index = read(2);
    expect(index.complete).toBe(false);
    expect(index.sourceFiles).toEqual(expect.arrayContaining(['src/app/main.ts', 'src/lib/helper.ts', 'src/lib/filler0.ts']));
    expect(index.importersOf('src/lib/helper.ts')).toEqual([]);
    expect(existsSync(join(cacheDir(), IMPORT_INDEX_FILENAME))).toBe(false);
  });

  it('reads inline when the files to open fit the budget', () => {
    const index = read(100);
    expect(index.complete).toBe(true);
    expect(index.importersOf('src/lib/helper.ts')).toEqual(['src/app/main.ts']);
    expect(existsSync(join(cacheDir(), IMPORT_INDEX_FILENAME))).toBe(true);
  });

  it('an unbudgeted read (the story verb) still builds it, as before', () => {
    const index = read();
    expect(index.complete).toBe(true);
    expect(index.built).toBe('walk');
    expect(index.importersOf('src/lib/helper.ts')).toEqual(['src/app/main.ts']);
  });
});

describe('partial, then complete', () => {
  it('the warm build makes the next budgeted read whole, from the cache', async () => {
    expect(read(0).complete).toBe(false);
    const result = await warmProjectImportIndex(root, new StorylineReaders(), cacheDir());
    expect(result).toMatchObject({ status: 'built', read: 7, files: 7 });
    const index = read(0);
    expect(index).toMatchObject({ complete: true, built: 'cache' });
    expect(index.importersOf('src/lib/helper.ts')).toEqual(['src/app/main.ts']);
    expect(readdirSync(cacheDir()).sort()).toEqual([IMPORT_INDEX_FILENAME]);
  });

  it('a second warm over a standing cache opens nothing', async () => {
    await warmProjectImportIndex(root, new StorylineReaders(), cacheDir());
    expect(await warmProjectImportIndex(root, new StorylineReaders(), cacheDir())).toMatchObject({ status: 'fresh', read: 0 });
  });

  it('the feature graph marks its folder rows partial, then drops the mark once warmed', async () => {
    const flowDir = join(root, 'flow');
    const cold = readProjectFeatureGraph(flowDir, root, { importReadBudget: 0 });
    expect(cold.importIndex).toBe('partial');
    const coldFolders = cold.graph.nodes.find((node) => node.slug === 'app')?.folders;
    expect(coldFolders?.partial).toBe(true);
    // Anchored file only — the import trace to helper.ts is what was left out.
    expect(coldFolders?.rows.map((row) => row.path)).toEqual(['src/app']);

    await warmProjectImportIndex(root, new StorylineReaders(), cacheDir());
    const warm = readProjectFeatureGraph(flowDir, root, { importReadBudget: 0 });
    expect(warm.importIndex).toBe('complete');
    const warmFolders = warm.graph.nodes.find((node) => node.slug === 'app')?.folders;
    expect(warmFolders?.partial).toBeUndefined();
    expect(warmFolders?.rows.map((row) => row.path).sort()).toEqual(['src/app', 'src/lib']);
  });
});

describe('the cold read prefetches what it measures', () => {
  it('answers exactly what the one-pass read answers, sizes and rows included', async () => {
    const flowDir = join(root, 'flow');
    const prefetched = await readProjectFeatureGraphPrefetched(flowDir, root, { importReadBudget: 0, concurrency: 3 });
    const plain = readProjectFeatureGraph(flowDir, root, { importReadBudget: 0 });
    expect(prefetched.importIndex).toBe('partial');
    expect(prefetched.graph).toEqual(plain.graph);
    expect(prefetched.graph.nodes.find((node) => node.slug === 'app')?.size).toEqual({ files: 1, lines: 2 });
  });
});

describe('cache validity', () => {
  beforeEach(async () => {
    await warmProjectImportIndex(root, new StorylineReaders(), cacheDir());
  });

  it('an edited file is re-read within the budget and its new edges count', () => {
    writeFileSync(join(root, 'src', 'lib', 'filler0.ts'), "import { helper } from './helper';\nexport const f0 = helper();\n");
    const index = read(4);
    expect(index.complete).toBe(true);
    expect(index.importersOf('src/lib/helper.ts')).toEqual(['src/app/main.ts', 'src/lib/filler0.ts']);
  });

  it('more new files than the budget make it partial again, without touching the cache', () => {
    const before = readFileSync(join(cacheDir(), IMPORT_INDEX_FILENAME), 'utf-8');
    for (let i = 0; i < 6; i += 1) writeFileSync(join(root, 'src', 'lib', `added${i}.ts`), `export const a${i} = ${i};\n`);
    const index = read(3);
    expect(index.complete).toBe(false);
    expect(index.sourceFiles).toContain('src/lib/added5.ts');
    expect(readFileSync(join(cacheDir(), IMPORT_INDEX_FILENAME), 'utf-8')).toBe(before);
  });

  it('an oversized file is recorded as importing nothing, never opened for imports', async () => {
    const big = `import { helper } from './helper';\n${'// padding\n'.repeat(Math.ceil(MAX_SPECIFIER_FILE_BYTES / 11) + 10)}`;
    writeFileSync(join(root, 'src', 'lib', 'bundle.ts'), big);
    expect(read(0).complete).toBe(true);
    expect(read(0).importersOf('src/lib/helper.ts')).toEqual(['src/app/main.ts']);
  });
});

describe('one build at a time', () => {
  it('two warms started together: one builds, the other answers busy', async () => {
    const [a, b] = await Promise.all([
      warmProjectImportIndex(root, new StorylineReaders(), cacheDir()),
      warmProjectImportIndex(root, new StorylineReaders(), cacheDir()),
    ]);
    expect([a.status, b.status].sort()).toEqual(['built', 'busy']);
    expect(existsSync(join(cacheDir(), IMPORT_INDEX_LOCK_FILENAME))).toBe(false);
  });

  it('a live lock is respected; a dead or expired one is taken over', async () => {
    mkdirSync(cacheDir(), { recursive: true });
    const lock = join(cacheDir(), IMPORT_INDEX_LOCK_FILENAME);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    expect(importIndexWarmRunning(cacheDir())).toBe(true);
    expect((await warmProjectImportIndex(root, new StorylineReaders(), cacheDir())).status).toBe('busy');
    expect(existsSync(join(cacheDir(), IMPORT_INDEX_FILENAME))).toBe(false);

    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - IMPORT_INDEX_LOCK_STALE_MS - 1 }));
    expect(importIndexWarmRunning(cacheDir())).toBe(false);
    expect((await warmProjectImportIndex(root, new StorylineReaders(), cacheDir())).status).toBe('built');

    // A pid that cannot be alive (beyond any pid_max).
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 30, startedAt: Date.now() }));
    expect(importIndexWarmRunning(cacheDir())).toBe(false);
    expect((await warmProjectImportIndex(root, new StorylineReaders(), cacheDir())).status).toBe('fresh');
  });

  it('never writes a project back into being after it was deleted', async () => {
    const gone = root;
    rmSync(gone, { recursive: true, force: true });
    const result = await warmProjectImportIndex(gone, new StorylineReaders(), join(gone, 'flow', 'brain', '.structure', 'storyline'));
    expect(result.status).toBe('busy');
    expect(existsSync(gone)).toBe(false);
  });
});

describe('requesting a background build', () => {
  it('is off in a test process unless a spawner is injected', () => {
    expect(requestImportIndexWarm(root)).toBe('disabled');
  });

  it('spawns the CLI entry with `blueprint index warm`, and not while a build runs', () => {
    const calls: Array<{ execPath: string; args: string[]; cwd: string }> = [];
    const spawnDetached = (execPath: string, args: string[], cwd: string): void => {
      calls.push({ execPath, args, cwd });
    };
    const cliEntry = join(root, 'src', 'app', 'main.ts');
    expect(requestImportIndexWarm(root, { spawnDetached, cliEntry, execPath: '/bin/node' })).toBe('spawned');
    expect(calls).toEqual([{ execPath: '/bin/node', args: [cliEntry, 'blueprint', 'index', 'warm', '--target', root], cwd: root }]);

    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(join(cacheDir(), IMPORT_INDEX_LOCK_FILENAME), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    expect(requestImportIndexWarm(root, { spawnDetached, cliEntry })).toBe('running');
    expect(calls).toHaveLength(1);
  });

  it('asks for nothing without a runnable entry or a flow folder', () => {
    const spawnDetached = (): void => {
      throw new Error('must not spawn');
    };
    expect(requestImportIndexWarm(root, { spawnDetached, cliEntry: undefined })).toBe('unavailable');
    expect(requestImportIndexWarm(root, { spawnDetached, cliEntry: join(root, 'missing.js') })).toBe('unavailable');
    rmSync(join(root, 'flow'), { recursive: true, force: true });
    expect(requestImportIndexWarm(root, { spawnDetached, cliEntry: join(root, 'src', 'app', 'main.ts') })).toBe('unavailable');
  });
});
