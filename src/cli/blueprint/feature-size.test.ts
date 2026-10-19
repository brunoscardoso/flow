import { describe, expect, it } from '@jest/globals';

import {
  anchorTarget,
  countLines,
  createAnchorMeasurer,
  filesUnderAnchor,
  measureAnchors,
  MAX_FILES_PER_ANCHOR,
  type SizeHost,
} from './feature-size.js';

/** A world made of literal files: path -> content; every path prefix is a dir. */
function world(files: Record<string, string>): SizeHost & { reads: string[] } {
  const dirs = new Set<string>();
  for (const path of Object.keys(files)) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i += 1) dirs.add(segments.slice(0, i).join('/'));
  }
  const reads: string[] = [];
  return {
    reads,
    classify: (path) => (path in files ? 'file' : dirs.has(path) ? 'dir' : null),
    list: (dir) => {
      const names = new Set<string>();
      for (const path of [...Object.keys(files), ...dirs]) {
        if (path.startsWith(`${dir}/`)) names.add(path.slice(dir.length + 1).split('/')[0]);
      }
      // Half the entries come back as `other`, so the walker's one-stat
      // fallback is exercised alongside the listing's own kinds.
      return [...names].map((name, index) => {
        const path = `${dir}/${name}`;
        const kind = path in files ? 'file' : 'dir';
        return { name, kind: index % 2 === 0 ? kind : 'other' } as const;
      });
    },
    read: (path) => {
      reads.push(path);
      return files[path] ?? null;
    },
  };
}

describe('anchorTarget — the path an anchor names', () => {
  it('strips the kind, a locator suffix and markdown dressing', () => {
    expect(anchorTarget('file:src/a.ts')).toBe('src/a.ts');
    expect(anchorTarget('file:src/a.ts:fetchThing')).toBe('src/a.ts');
    expect(anchorTarget('module:app/src/renderer/')).toBe('app/src/renderer');
    expect(anchorTarget('`src/lib/x.ts`')).toBe('src/lib/x.ts');
    expect(anchorTarget('  file: ./src/a.ts ')).toBe('src/a.ts');
  });
  it('keeps a directory whose last segment has a dot-less name intact', () => {
    expect(anchorTarget('module:src/cli/blueprint')).toBe('src/cli/blueprint');
  });
});

describe('countLines', () => {
  it('counts lines the way an editor does', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\n')).toBe(1);
    expect(countLines('one\ntwo')).toBe(2);
    expect(countLines('one\ntwo\n')).toBe(2);
  });
  it('treats a binary as zero lines rather than counting its bytes', () => {
    expect(countLines('PNG\u0000\n\n\n\n')).toBe(0);
  });
});

describe('measureAnchors — files and lines a feature stands on', () => {
  const host = world({
    'src/a.ts': 'a\nb\nc\n',
    'src/lib/x.ts': 'x\n',
    'src/lib/y.ts': 'y\ny\n',
    'src/lib/node_modules/dep/index.js': 'never\ncounted\n',
    'src/lib/dist/bundle.js': 'never\n',
    'docs/readme.md': 'hello\n',
  });

  it('resolves a file anchor to one file and its lines', () => {
    expect(measureAnchors(['file:src/a.ts'], host)).toEqual({ files: 1, lines: 3 });
  });

  it('walks a module anchor and skips dependency and build directories', () => {
    expect(measureAnchors(['module:src/lib'], host)).toEqual({ files: 2, lines: 3 });
  });

  it('counts a file once however many anchors reach it', () => {
    expect(measureAnchors(['module:src', 'file:src/a.ts', 'file:src/lib/x.ts'], host)).toEqual({
      files: 3,
      lines: 6,
    });
  });

  it('contributes nothing for an anchor that resolves to nothing', () => {
    expect(measureAnchors(['file:src/missing.ts', 'module:nowhere', ''], host)).toEqual({
      files: 0,
      lines: 0,
    });
  });

  it('counts a non-code file as a file with its lines — size is size', () => {
    expect(measureAnchors(['file:docs/readme.md'], host)).toEqual({ files: 1, lines: 1 });
  });

  it('is deterministic — same anchors, deep-equal answer', () => {
    const anchors = ['module:src', 'file:docs/readme.md'];
    expect(measureAnchors(anchors, host)).toEqual(measureAnchors(anchors, host));
  });
});

describe('createAnchorMeasurer — one walk per anchor path per run', () => {
  it('reads a shared directory once across features', () => {
    const host = world({ 'src/lib/x.ts': 'x\n', 'src/lib/y.ts': 'y\n' });
    const measure = createAnchorMeasurer(host);
    expect(measure(['module:src/lib'])).toEqual({ files: 2, lines: 2 });
    expect(measure(['module:src/lib', 'file:src/lib/x.ts'])).toEqual({ files: 2, lines: 2 });
    // Two files, read exactly once each (the second call served from the memo;
    // the direct file anchor is its own path and is read once too).
    expect(host.reads.filter((path) => path === 'src/lib/y.ts')).toHaveLength(1);
  });
});

describe('filesUnderAnchor — the cap', () => {
  it('stops at MAX_FILES_PER_ANCHOR rather than reading a whole tree', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_FILES_PER_ANCHOR + 5; i += 1) files[`big/f${String(i)}.ts`] = 'x\n';
    const host = world(files);
    expect(filesUnderAnchor('big', host).size).toBe(MAX_FILES_PER_ANCHOR);
  });
});
