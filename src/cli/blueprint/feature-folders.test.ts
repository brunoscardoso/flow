import { describe, expect, it } from '@jest/globals';

import {
  conventionalSourceRoots,
  createFolderRowsBuilder,
  folderRowsOf,
  isFolderRowFile,
  MAX_ROWS,
  pathMatchesSlug,
  slugStems,
  startingFolderOf,
  type FolderImportIndex,
} from './feature-folders.js';
import type { SizeHost } from './feature-size.js';
import { resolvePythonImport } from './storyline-languages.js';

/** A world made of literal files: path -> content; every path prefix is a dir. */
function world(files: Record<string, string>): SizeHost {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
  }
  return {
    classify: (path) => (path in files ? 'file' : dirs.has(path) ? 'dir' : null),
    list: (dir) => {
      const names = new Set<string>();
      for (const path of [...Object.keys(files), ...dirs]) {
        if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0]);
      }
      return [...names].map((name) => ({ name, kind: `${dir}/${name}` in files ? 'file' : 'dir' }) as const);
    },
    read: (path) => files[path] ?? null,
  };
}

/** `n` lines of text. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
}

/** An import index over `files`, from a forward edge table (importer → targets). */
function index(files: readonly string[], forward: Record<string, readonly string[]>): FolderImportIndex {
  const reverse = new Map<string, string[]>();
  for (const [importer, targets] of Object.entries(forward)) {
    for (const target of targets) reverse.set(target, [...(reverse.get(target) ?? []), importer]);
  }
  return { sourceFiles: [...files].sort(), importersOf: (target) => reverse.get(target) ?? [] };
}

function rowPaths(result: ReturnType<typeof folderRowsOf>): string[] {
  return (result?.rows ?? []).map((row) => row.path);
}

describe('name matching — a slug names a path by its words', () => {
  it('matches singular, plural, kebab, camel and snake forms on word boundaries', () => {
    const stems = slugStems('automations');
    expect(pathMatchesSlug('src/components/automations/x.tsx', stems)).toBe(true);
    expect(pathMatchesSlug('src/components/automation-builder/x.tsx', stems)).toBe(true);
    expect(pathMatchesSlug('src/components/AutomationBuilder/index.tsx', stems)).toBe(true);
    expect(pathMatchesSlug('src/commands/createAutomation.ts', stems)).toBe(true);
    expect(pathMatchesSlug('src/stores/automation_store.py', stems)).toBe(true);
    expect(pathMatchesSlug('src/components/automaton/x.ts', stems)).toBe(false);
  });

  it('a multi-word slug matches its words in a row, and their compact spelling', () => {
    const stems = slugStems('plan-library');
    expect(pathMatchesSlug('src/components/plan-library/a.tsx', stems)).toBe(true);
    expect(pathMatchesSlug('src/components/PlanLibrary.tsx', stems)).toBe(true);
    expect(pathMatchesSlug('src/plan_libraries/a.py', stems)).toBe(true);
    expect(pathMatchesSlug('src/planlibrary/a.ts', stems)).toBe(true);
    expect(pathMatchesSlug('src/plan/library.ts', stems)).toBe(false);
  });

  it('an `apps` slug never claims `app/`: a stem under four characters never matches', () => {
    const stems = slugStems('apps');
    expect(stems).toEqual([['apps']]);
    expect(pathMatchesSlug('app/src/main.ts', stems)).toBe(false);
    expect(pathMatchesSlug('src/app/page.tsx', stems)).toBe(false);
    expect(pathMatchesSlug('src/apps/list.tsx', stems)).toBe(true);
    expect(slugStems('ui')).toEqual([]);
  });

  it('`chat` and `chats` find each other, but not `chatbot` or `chatter`', () => {
    for (const slug of ['chat', 'chats']) {
      const stems = slugStems(slug);
      expect(pathMatchesSlug('src/components/chat/Panel.tsx', stems)).toBe(true);
      expect(pathMatchesSlug('src/hooks/useChats.ts', stems)).toBe(true);
      expect(pathMatchesSlug('src/chatbot/index.ts', stems)).toBe(false);
      expect(pathMatchesSlug('src/components/Chatter.tsx', stems)).toBe(false);
    }
  });

  it('in a builder, the `apps` feature takes `apps/` and nothing under `app/`', () => {
    const files = {
      'app/src/main.ts': lines(50),
      'app/src/app.ts': lines(50),
      'src/apps/list.ts': lines(10),
    };
    const builder = createFolderRowsBuilder(world(files), {
      coreFeatures: [],
      imports: index(Object.keys(files), {}),
    });
    const result = builder.rowsFor({ slug: 'apps', anchors: [] });
    expect([...builder.filesFor({ slug: 'apps', anchors: [] }).keys()]).toEqual(['src/apps/list.ts']);
    expect(rowPaths(result)).toEqual(['src/apps']);
  });
});

describe('what counts as a feature file', () => {
  it('leaves out tests, mocks, fixtures, generated and declaration files, and non-code', () => {
    expect(isFolderRowFile('src/a/x.ts')).toBe(true);
    expect(isFolderRowFile('src/a/x.py')).toBe(true);
    for (const path of [
      'src/a/x.test.ts',
      'src/a/__tests__/x.ts',
      'src/a/__mocks__/x.ts',
      'src/a/mocks/x.ts',
      'src/a/x.mock.ts',
      'src/a/fixtures/x.ts',
      'src/a/__generated__/x.ts',
      'src/a/x.generated.ts',
      'src/a/types.d.ts',
      'src/a/test_x.py',
      'src/a/x_test.go',
      'src/a/README.md',
      'src/a/logo.png',
      'src/node_modules/x/index.js',
    ]) {
      expect([path, isFolderRowFile(path)]).toEqual([path, false]);
    }
  });

  it('an anchored folder counts only its product code', () => {
    const files = {
      'src/billing/invoice.ts': lines(30),
      'src/billing/invoice.test.ts': lines(300),
      'src/billing/__mocks__/client.ts': lines(300),
      'src/billing/fixtures/sample.ts': lines(300),
      'src/billing/api.generated.ts': lines(300),
      'src/billing/types.d.ts': lines(300),
      'src/billing/README.md': lines(300),
    };
    const builder = createFolderRowsBuilder(world(files), { coreFeatures: [], imports: null });
    const result = builder.rowsFor({ slug: 'billing', anchors: ['module:src/billing'] });
    expect(result).toMatchObject({ files: 1, lines: 30, rows: [{ path: 'src/billing', lines: 30, files: 1, share: 1 }] });
  });
});

describe('the import trace', () => {
  it('follows anchored files forward up to the depth cap', () => {
    const files = {
      'src/routes/orders/page.ts': lines(10),
      'src/views/a.ts': lines(10),
      'src/views/b.ts': lines(10),
      'src/views/c.ts': lines(10),
      'src/views/d.ts': lines(10),
    };
    const imports = index(Object.keys(files), {
      'src/routes/orders/page.ts': ['src/views/a.ts'],
      'src/views/a.ts': ['src/views/b.ts'],
      'src/views/b.ts': ['src/views/c.ts'],
      'src/views/c.ts': ['src/views/d.ts'],
    });
    const builder = createFolderRowsBuilder(world(files), { coreFeatures: [], imports, importDepth: 3 });
    expect([...builder.filesFor({ slug: 'xyzw', anchors: ['file:src/routes/orders/page.ts'] }).keys()].sort()).toEqual([
      'src/routes/orders/page.ts',
      'src/views/a.ts',
      'src/views/b.ts',
      'src/views/c.ts',
    ]);
  });

  it('reads a Python project through the language resolver', () => {
    const files = {
      'svc/orders/views.py': lines(40),
      'svc/orders/test_views.py': lines(400),
      'svc/payments/gateway.py': lines(20),
      'svc/payments/__init__.py': '',
    };
    const fileExists = (path: string): boolean => path in files;
    const specifiers: Record<string, string[]> = {
      'svc/orders/views.py': ['svc.payments.gateway', 'requests'],
      'svc/orders/test_views.py': ['svc.orders.views'],
    };
    const forward: Record<string, string[]> = {};
    for (const [importer, list] of Object.entries(specifiers)) {
      forward[importer] = list
        .map((specifier) => resolvePythonImport(importer, specifier, fileExists))
        .filter((target): target is string => target !== null);
    }
    const builder = createFolderRowsBuilder(world(files), {
      coreFeatures: [],
      imports: index(Object.keys(files), forward),
    });
    const result = builder.rowsFor({ slug: 'orders', anchors: ['module:svc/orders'] });
    expect(result?.rows).toEqual([
      { path: 'svc/orders', lines: 40, files: 1, share: 0.667 },
      { path: 'svc/payments', lines: 20, files: 1, share: 0.333 },
    ]);
  });
});

describe('shared code is nobody’s home', () => {
  const files = {
    'src/app/alpha/page.ts': lines(10),
    'src/app/bravo/page.ts': lines(10),
    'src/app/charlie/page.ts': lines(10),
    'src/lib/client.ts': lines(500),
    'src/lib/transport.ts': lines(500),
    'src/lib/alpha-only.ts': lines(5),
  };
  const imports = index(Object.keys(files), {
    'src/app/alpha/page.ts': ['src/lib/client.ts', 'src/lib/alpha-only.ts'],
    'src/app/bravo/page.ts': ['src/lib/client.ts'],
    'src/app/charlie/page.ts': ['src/lib/client.ts'],
    'src/lib/client.ts': ['src/lib/transport.ts'],
  });
  const coreFeatures = ['alpha', 'bravo', 'charlie'].map((slug) => ({
    id: `feature:${slug}`,
    slug,
    anchors: [`module:src/app/${slug}`],
  }));

  it('a hub three features import is shared, dropped from all, and the trace stops at it', () => {
    const builder = createFolderRowsBuilder(world(files), { coreFeatures, imports });
    expect(builder.sharedFiles()).toEqual(['src/lib/client.ts']);
    expect([...builder.filesFor(coreFeatures[0]).keys()].sort()).toEqual(['src/app/alpha/page.ts', 'src/lib/alpha-only.ts']);
    expect(rowPaths(builder.rowsFor(coreFeatures[1]))).toEqual(['src/app/bravo']);
    // A part goes through the same stop — the hub never enters its rows either.
    expect([...builder.filesFor({ slug: 'alpha-part', anchors: ['file:src/app/alpha/page.ts'] }).keys()]).not.toContain(
      'src/lib/client.ts',
    );
  });

  it('a file only two features reach stays theirs', () => {
    const builder = createFolderRowsBuilder(world(files), { coreFeatures: coreFeatures.slice(0, 2), imports });
    expect(builder.sharedFiles()).toEqual([]);
    expect([...builder.filesFor(coreFeatures[0]).keys()]).toContain('src/lib/client.ts');
  });
});

describe('folder rows — the depth rule', () => {
  const roots = ['src'];

  it('starts at the layer folder’s child, and at the layer folder for its own files', () => {
    expect(startingFolderOf('src/components/automations/Builder/x.tsx', roots)).toBe('src/components/automations');
    expect(startingFolderOf('src/commands/createAutomation.ts', roots)).toBe('src/commands');
    expect(startingFolderOf('src/index.ts', roots)).toBe('src');
    expect(startingFolderOf('scripts/build/x.ts', roots)).toBe('scripts/build');
    expect(startingFolderOf('main.go', [])).toBe('.');
    expect(conventionalSourceRoots(['src/a.ts', 'app/src/b.ts', 'packages/ui/src/c.ts', 'src/lib/d.ts'])).toEqual([
      'src',
      'app/src',
      'packages/ui/src',
    ]);
  });

  it('descends while one subfolder holds ≥ 80%, keeping what it leaves behind as its own row', () => {
    const files = new Map([
      ['src/components/automations/Builder/a.tsx', 90],
      ['src/components/automations/index.ts', 10],
    ]);
    const result = folderRowsOf(files, roots);
    expect(result?.rows).toEqual([
      { path: 'src/components/automations/Builder', lines: 90, files: 1, share: 0.9 },
      { path: 'src/components/automations', lines: 10, files: 1, share: 0.1 },
    ]);
  });

  it('stops when no subfolder holds 80%', () => {
    const files = new Map([
      ['src/components/automations/Builder/a.tsx', 70],
      ['src/components/automations/List/b.tsx', 30],
      ['src/commands/createAutomation.ts', 25],
    ]);
    const result = folderRowsOf(files, roots);
    expect(result?.rows).toEqual([
      { path: 'src/components/automations', lines: 100, files: 2, share: 0.8 },
      { path: 'src/commands', lines: 25, files: 1, share: 0.2 },
    ]);
    expect(result?.spread).toBe(false);
  });

  it('is spread when no folder holds 40%, and still lists the real shares', () => {
    const files = new Map([
      ['src/a/one/x.ts', 30],
      ['src/b/two/x.ts', 30],
      ['src/c/three/x.ts', 20],
      ['src/d/four/x.ts', 20],
    ]);
    const result = folderRowsOf(files, roots);
    expect(result?.spread).toBe(true);
    expect(result?.rows.map((row) => row.share)).toEqual([0.3, 0.3, 0.2, 0.2]);
  });

  it(`keeps the top ${MAX_ROWS} rows and counts every folder`, () => {
    const files = new Map(['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => [`src/${name}/x/y.ts`, 60 - i * 10] as const));
    const result = folderRowsOf(files, roots);
    expect(result?.rows).toHaveLength(MAX_ROWS);
    expect(result?.folderCount).toBe(6);
    expect(rowPaths(result)).toEqual(['src/a/x', 'src/b/x', 'src/c/x', 'src/d/x']);
  });

  it('no files → no rows', () => {
    expect(folderRowsOf(new Map(), roots)).toBeNull();
    const builder = createFolderRowsBuilder(world({ 'src/a.ts': 'x' }), { coreFeatures: [], imports: null });
    expect(builder.rowsFor({ slug: 'nothing-here', anchors: ['module:src/missing'] })).toBeNull();
  });
});

describe('a pinned home', () => {
  const files = {
    'src/components/automations/a.tsx': lines(80),
    'src/commands/createAutomation.ts': lines(20),
    'src/automations/empty/README.md': 'docs',
  };
  const imports = index(Object.keys(files), {});

  it('comes first with its real share — even 0 — and the rest are still computed', () => {
    const builder = createFolderRowsBuilder(world(files), { coreFeatures: [], imports });
    const pinned = builder.rowsFor({ slug: 'automations', anchors: [], home: 'src/commands/' });
    expect(pinned).toMatchObject({ pinned: true, pinMissing: null, spread: false, folderCount: 2 });
    expect(pinned?.rows).toEqual([
      { path: 'src/commands', lines: 20, files: 1, share: 0.2, pinned: true },
      { path: 'src/components/automations', lines: 80, files: 1, share: 0.8 },
    ]);
    const empty = builder.rowsFor({ slug: 'automations', anchors: [], home: 'src/automations/empty' });
    expect(empty?.rows[0]).toEqual({ path: 'src/automations/empty', lines: 0, files: 0, share: 0, pinned: true });
  });

  it('that no longer exists is ignored and reported', () => {
    const builder = createFolderRowsBuilder(world(files), { coreFeatures: [], imports });
    for (const home of ['src/gone', '../outside', 'src/commands/createAutomation.ts']) {
      const result = builder.rowsFor({ slug: 'automations', anchors: [], home });
      expect(result).toMatchObject({ pinned: false, pinMissing: home });
      expect(rowPaths(result)).toEqual(['src/components/automations', 'src/commands']);
    }
  });
});
