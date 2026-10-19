import { describe, expect, it } from '@jest/globals';

import type { FeatureNode } from './feature-store.js';
import { computeFeatureMap, scanImports, type FeatureMapHost } from './feature-map.js';

function feature(anchors: string[]): FeatureNode {
  return {
    id: 'ft-test0001',
    slug: 'test-feature',
    name: 'Test Feature',
    kind: 'core',
    anchors,
    relates: [],
    lastFullRead: null,
    patchCount: 0,
    body: '',
    extra: {},
  };
}

/** A world made of literal files: path -> content, plus a set of dirs. */
function world(files: Record<string, string>, dirs: string[] = []): FeatureMapHost {
  return {
    classify: (path) => (path in files ? 'file' : dirs.includes(path) ? 'dir' : null),
    read: (path) => files[path] ?? null,
  };
}

describe('anchor resolution', () => {
  it('resolves file anchors, folder anchors, and counts what does not exist', () => {
    const host = world({ 'src/a.ts': '' }, ['src/lib']);
    const map = computeFeatureMap(
      feature(['file:src/a.ts', 'module:src/lib', 'file:src/gone.ts']),
      [],
      host,
    );
    expect(map.files).toEqual([
      { path: 'src/a.ts', part: null, kind: 'file', badges: [] },
      { path: 'src/lib', part: null, kind: 'folder', badges: [] },
    ]);
    expect(map.unresolved).toEqual([
      { anchor: 'file:src/gone.ts', reason: 'no such file or directory' },
    ]);
  });

  it('accepts bare part-anchor paths with no kind prefix', () => {
    const host = world({ 'src/a.ts': '' });
    const map = computeFeatureMap(
      feature([]),
      [{ name: 'Store', summary: '', anchors: ['src/a.ts'], learnings: [] }],
      host,
    );
    expect(map.files).toEqual([{ path: 'src/a.ts', part: 'Store', kind: 'file', badges: [] }]);
  });

  it('gives a multiply-anchored file to the first claimant and badges the rest (FR5)', () => {
    const host = world({ 'src/a.ts': '' });
    const map = computeFeatureMap(
      feature(['file:src/a.ts']),
      [
        { name: 'Store', summary: '', anchors: ['file:src/a.ts'], learnings: [] },
        { name: 'View', summary: '', anchors: ['file:src/a.ts'], learnings: [] },
      ],
      host,
    );
    expect(map.files).toEqual([
      { path: 'src/a.ts', part: null, kind: 'file', badges: ['Store', 'View'] },
    ]);
  });
});

describe('import edges', () => {
  it('draws an edge only when both endpoints are in the feature set', () => {
    const host = world({
      'src/a.ts': "import { b } from './b.js'\nimport { out } from './outside.js'\n",
      'src/b.ts': '',
      'src/outside.ts': '',
    });
    const map = computeFeatureMap(feature(['file:src/a.ts', 'file:src/b.ts']), [], host);
    expect(map.edges).toEqual([{ from: 'src/a.ts', to: 'src/b.ts' }]);
  });

  it('resolves the compiled-extension and index fallbacks', () => {
    const host = world({
      'src/a.ts': "import { b } from './lib'\nimport { c } from '../src/c.js'\n",
      'src/lib/index.ts': '',
      'src/c.ts': '',
    });
    const map = computeFeatureMap(
      feature(['file:src/a.ts', 'file:src/lib/index.ts', 'file:src/c.ts']),
      [],
      host,
    );
    expect(map.edges).toEqual([
      { from: 'src/a.ts', to: 'src/c.ts' },
      { from: 'src/a.ts', to: 'src/lib/index.ts' },
    ]);
  });

  it('never scans non-code files — they are nodes without edges', () => {
    const host = world({
      'docs/readme.md': "import { a } from './a.js'",
      'src/a.ts': '',
    });
    const map = computeFeatureMap(feature(['file:docs/readme.md', 'file:src/a.ts']), [], host);
    expect(map.edges).toEqual([]);
    expect(map.files.map((f) => f.path)).toEqual(['docs/readme.md', 'src/a.ts']);
  });

  it('ignores bare package specifiers', () => {
    expect(scanImports("import { join } from 'node:path'\nrequire('./x.js')\n")).toEqual([
      'node:path',
      './x.js',
    ]);
    const host = world({ 'src/a.ts': "import { join } from 'node:path'", 'src/b.ts': '' });
    const map = computeFeatureMap(feature(['file:src/a.ts', 'file:src/b.ts']), [], host);
    expect(map.edges).toEqual([]);
  });
});

describe('determinism', () => {
  it('sorts files, edges and unresolved regardless of claim order', () => {
    const host = world({
      'src/z.ts': "import { a } from './a.js'",
      'src/a.ts': "import { z } from './z.js'",
    });
    const map = computeFeatureMap(
      feature(['file:src/z.ts', 'file:src/a.ts', 'file:zz/gone.ts', 'file:aa/gone.ts']),
      [],
      host,
    );
    expect(map.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/z.ts']);
    expect(map.edges).toEqual([
      { from: 'src/a.ts', to: 'src/z.ts' },
      { from: 'src/z.ts', to: 'src/a.ts' },
    ]);
    expect(map.unresolved.map((u) => u.anchor)).toEqual(['file:aa/gone.ts', 'file:zz/gone.ts']);
  });
});
