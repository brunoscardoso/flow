/**
 * Tests for the code-card extractor — pure symbol/import/one-liner
 * heuristics (TS/JS + Python + other-language map entries), card render /
 * parse round trip, and the `emitCodeCards` pass against a fixture repo:
 * card + sidecar creation, determinism, hash-gated cache reuse, and stale
 * card removal.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  emitCodeCards,
  extractFileFacts,
  languageOf,
  moduleSlugOf,
  parseModuleCard,
  renderModuleCard,
  type FileFacts,
} from './code-cards.js';
import { hashFileContent, type RepoFileHashHint } from '../store.js';

describe('extractFileFacts (TS/JS)', () => {
  const source = [
    '/**',
    ' * Widget helpers for the fixture.',
    ' *',
    ' * Doc examples stay placeholder-safe: a line like',
    ' * `exportKW function exampleName()` never matches (forbidden-pattern #9).',
    ' */',
    '',
    "import { readFileSync } from 'node:fs';",
    "import type { Widget } from './types.js';",
    "const lazy = await import('./lazy.js');",
    '',
    'export interface WidgetBox {',
    '  widget: Widget;',
    '}',
    '',
    'export type WidgetId = string;',
    '',
    'export enum WidgetState {',
    '  Idle,',
    '}',
    '',
    'export const WIDGET_LIMIT = 3;',
    '',
    'export async function buildWidget(): Promise<void> {}',
    '',
    'export class WidgetFactory {}',
    '',
    'function internalHelper(): void {}',
    '',
    'class InternalRegistry {}',
    '',
    '/*',
    'export function insideBlockComment(): void {}',
    '*/',
    '',
    'export default buildWidget;',
    '',
  ].join('\n');

  it('extracts exported and top-level symbols with kinds and line numbers', () => {
    const facts = extractFileFacts('src/widgets/widget.ts', source);
    expect(facts.symbols).toEqual([
      { name: 'WidgetBox', kind: 'interface', line: 12 },
      { name: 'WidgetId', kind: 'type', line: 16 },
      { name: 'WidgetState', kind: 'enum', line: 18 },
      { name: 'WIDGET_LIMIT', kind: 'const', line: 22 },
      { name: 'buildWidget', kind: 'function', line: 24 },
      { name: 'WidgetFactory', kind: 'class', line: 26 },
      { name: 'internalHelper', kind: 'function', line: 28 },
      { name: 'InternalRegistry', kind: 'class', line: 30 },
      { name: 'default', kind: 'default', line: 36 },
    ]);
  });

  it('never matches declarations inside comments (its own docs included)', () => {
    const facts = extractFileFacts('src/widgets/widget.ts', source);
    const names = facts.symbols.map((symbol) => symbol.name);
    expect(names).not.toContain('insideBlockComment');
    expect(names).not.toContain('exampleName');
  });

  it('collects sorted-unique import specifiers including dynamic import', () => {
    const facts = extractFileFacts('src/widgets/widget.ts', source);
    expect(facts.imports).toEqual(['./lazy.js', './types.js', 'node:fs']);
  });

  it('uses the first doc-comment line as the one-liner', () => {
    const facts = extractFileFacts('src/widgets/widget.ts', source);
    expect(facts.oneLiner).toBe('Widget helpers for the fixture.');
  });

  it('falls back to exports: <top symbols> when there is no doc comment', () => {
    const facts = extractFileFacts(
      'src/a.ts',
      ['export const one = 1;', 'export const two = 2;', 'export const three = 3;', 'export const four = 4;'].join('\n'),
    );
    expect(facts.oneLiner).toBe('exports: one, two, three');
  });

  it('uses a leading line comment as the one-liner', () => {
    const facts = extractFileFacts('src/b.js', ['// Tiny helper module.', 'export const x = 1;'].join('\n'));
    expect(facts.oneLiner).toBe('Tiny helper module.');
  });

  it('captures a named export default function', () => {
    const facts = extractFileFacts('src/c.ts', 'export default function mainEntry(): void {}\n');
    expect(facts.symbols).toEqual([{ name: 'mainEntry', kind: 'function', line: 1 }]);
  });

  it('sanitizes one-liners that would collide with card markup', () => {
    const heading = extractFileFacts(
      'src/d.ts',
      ['/**', ' * ## Refresh Safety Audit', ' */', 'export const audit = 1;'].join('\n'),
    );
    expect(heading.oneLiner).toBe('Refresh Safety Audit');

    const reserved = extractFileFacts(
      'src/e.ts',
      ['// imports: everything the loader needs', 'export const loader = 1;'].join('\n'),
    );
    expect(reserved.oneLiner).toBe('imports — everything the loader needs');
  });
});

describe('extractFileFacts (Python)', () => {
  const source = [
    '"""Fixture math helpers."""',
    'import os',
    'import sys, json',
    'from collections import abc',
    '',
    'def add(a, b):',
    '    return a + b',
    '',
    'async def fetch_all():',
    '    pass',
    '',
    'class Calculator:',
    '    def multiply(self, a, b):',
    '        return a * b',
    '',
  ].join('\n');

  it('extracts top-level def/class only (methods excluded)', () => {
    const facts = extractFileFacts('lib/calc.py', source);
    expect(facts.symbols).toEqual([
      { name: 'add', kind: 'function', line: 6 },
      { name: 'fetch_all', kind: 'function', line: 9 },
      { name: 'Calculator', kind: 'class', line: 12 },
    ]);
  });

  it('uses the module docstring first line and collects imports', () => {
    const facts = extractFileFacts('lib/calc.py', source);
    expect(facts.oneLiner).toBe('Fixture math helpers.');
    expect(facts.imports).toEqual(['collections', 'json', 'os', 'sys']);
    expect(facts.language).toBe('python');
  });
});

describe('extractFileFacts (other languages)', () => {
  it('yields an empty map entry — no symbols, no imports', () => {
    const facts = extractFileFacts('src/main.go', 'package main\n\nfunc main() {}\n');
    expect(facts.symbols).toEqual([]);
    expect(facts.imports).toEqual([]);
    expect(facts.oneLiner).toBe('');
    expect(facts.language).toBe('go');
  });
});

describe('languageOf / moduleSlugOf', () => {
  it('maps extensions to language tags', () => {
    expect(languageOf('a/b.ts')).toBe('typescript');
    expect(languageOf('a/b.tsx')).toBe('typescript');
    expect(languageOf('a/b.mjs')).toBe('javascript');
    expect(languageOf('a/b.pyi')).toBe('python');
    expect(languageOf('a/b.rs')).toBe('rs');
  });

  it('slugs module paths like flow/brain/modules does', () => {
    expect(moduleSlugOf('src/cli/blueprint')).toBe('src-cli-blueprint');
    expect(moduleSlugOf('src')).toBe('src');
  });
});

describe('renderModuleCard / parseModuleCard round trip', () => {
  const facts: FileFacts[] = [
    {
      path: 'src/widgets/widget.ts',
      language: 'typescript',
      oneLiner: 'Widget helpers for the fixture.',
      symbols: [
        { name: 'buildWidget', kind: 'function', line: 24 },
        { name: 'WidgetFactory', kind: 'class', line: 26 },
      ],
      imports: ['./types.js', 'node:fs'],
      hash: 'a'.repeat(64),
    },
    {
      path: 'src/widgets/empty.sql',
      language: 'sql',
      oneLiner: '',
      symbols: [],
      imports: [],
      hash: 'b'.repeat(64),
    },
  ];

  it('renders frontmatter and parses back the exact facts', () => {
    const card = renderModuleCard('src/widgets', facts);
    expect(card.startsWith('---\ntype: code\nmodule: src/widgets\n---\n')).toBe(true);
    expect(card).toContain('## src/widgets/widget.ts');
    expect(card).toContain('- buildWidget (function) — line 24');
    expect(card).toContain('imports: ./types.js, node:fs');
    expect(card).toContain(`hash: ${'a'.repeat(64)}`);
    expect(card).toContain('symbols: none');

    const parsed = parseModuleCard(card);
    expect([...parsed.keys()].sort()).toEqual(['src/widgets/empty.sql', 'src/widgets/widget.ts']);
    expect(parsed.get('src/widgets/widget.ts')).toEqual(facts[0]);
    expect(parsed.get('src/widgets/empty.sql')).toEqual(facts[1]);
  });

  it('round-trips to byte-identical re-rendered cards', () => {
    const card = renderModuleCard('src/widgets', facts);
    const reparsed = [...parseModuleCard(card).values()];
    expect(renderModuleCard('src/widgets', reparsed)).toBe(card);
  });

  it('skips corrupt sections instead of throwing', () => {
    const parsed = parseModuleCard('---\ntype: code\nmodule: x\n---\n\n## src/x/a.ts\n\nhash: nothex\n');
    expect(parsed.size).toBe(0);
  });
});

describe('emitCodeCards', () => {
  let repoRoot: string;
  let flowDir: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'code-cards-test-'));
    flowDir = join(repoRoot, 'flow');
    mkdirSync(flowDir, { recursive: true });
    writeFixture('package.json', JSON.stringify({ name: 'fixture-app' }));
    writeFixture(
      'src/widgets/widget.ts',
      ['/** Widget helpers. */', "import { x } from './x.js';", 'export function buildWidget(): void {}', ''].join('\n'),
    );
    writeFixture('src/widgets/x.ts', 'export const x = 1;\n');
    writeFixture('src/cli/main.py', '"""CLI entry."""\ndef main():\n    pass\n');
    writeFixture('src/cli/schema.sql', 'CREATE TABLE widgets (id INTEGER);\n');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeFixture(relPath: string, content: string): void {
    const absPath = join(repoRoot, relPath);
    mkdirSync(join(absPath, '..'), { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  }

  it('writes one card per module and the symbol sidecar', () => {
    const notes = emitCodeCards(repoRoot, flowDir);

    const widgetCard = readFileSync(join(flowDir, 'brain', 'code', 'src-widgets.md'), 'utf-8');
    expect(widgetCard).toContain('module: src/widgets');
    expect(widgetCard).toContain('## src/widgets/widget.ts');
    expect(widgetCard).toContain('- buildWidget (function) — line 3');

    const cliCard = readFileSync(join(flowDir, 'brain', 'code', 'src-cli.md'), 'utf-8');
    expect(cliCard).toContain('- main (function) — line 2');
    expect(cliCard).toContain('## src/cli/schema.sql'); // other language: map entry, no symbols
    expect(cliCard).toContain('symbols: none');

    const sidecar = readFileSync(join(flowDir, 'brain', '.structure', 'symbols.jsonl'), 'utf-8');
    const rows = sidecar.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows).toHaveLength(3); // main, buildWidget, x
    const buildRow = rows.find((row) => row.name === 'buildWidget');
    expect(buildRow).toMatchObject({
      kind: 'function',
      path: 'src/widgets/widget.ts',
      line: 3,
      language: 'typescript',
    });
    expect(typeof buildRow?.fileHash).toBe('string');
    expect(String(buildRow?.fileHash)).toMatch(/^[0-9a-f]{64}$/);

    expect(notes.some((note) => note.startsWith('code-cards: 2 card(s)'))).toBe(true);
  });

  it('is deterministic and hash-gated — a re-run reuses every file and rewrites nothing', () => {
    emitCodeCards(repoRoot, flowDir);
    const firstCard = readFileSync(join(flowDir, 'brain', 'code', 'src-widgets.md'), 'utf-8');
    const firstSidecar = readFileSync(join(flowDir, 'brain', '.structure', 'symbols.jsonl'), 'utf-8');

    const notes = emitCodeCards(repoRoot, flowDir);
    expect(readFileSync(join(flowDir, 'brain', 'code', 'src-widgets.md'), 'utf-8')).toBe(firstCard);
    expect(readFileSync(join(flowDir, 'brain', '.structure', 'symbols.jsonl'), 'utf-8')).toBe(firstSidecar);
    expect(notes).toContain('code-cards: 0 file(s) extracted, 4 reused from cache');
    expect(notes.some((note) => note.includes('(0 rewritten, 2 unchanged)'))).toBe(true);
  });

  it('re-extracts only the changed file', () => {
    emitCodeCards(repoRoot, flowDir);
    writeFixture('src/widgets/x.ts', 'export const x = 2;\nexport const y = 3;\n');

    const notes = emitCodeCards(repoRoot, flowDir);
    expect(notes).toContain('code-cards: 1 file(s) extracted, 3 reused from cache');
    expect(notes.some((note) => note.includes('(1 rewritten, 1 unchanged)'))).toBe(true);

    const sidecar = readFileSync(join(flowDir, 'brain', '.structure', 'symbols.jsonl'), 'utf-8');
    expect(sidecar).toContain('"name":"y"');
  });

  it('removes cards whose module vanished', () => {
    emitCodeCards(repoRoot, flowDir);
    expect(existsSync(join(flowDir, 'brain', 'code', 'src-cli.md'))).toBe(true);
    rmSync(join(repoRoot, 'src', 'cli'), { recursive: true, force: true });

    const notes = emitCodeCards(repoRoot, flowDir);
    expect(existsSync(join(flowDir, 'brain', 'code', 'src-cli.md'))).toBe(false);
    expect(notes).toContain('code-cards: 1 stale card(s) removed');
  });

  it('accepts a pre-computed repo scan and only processes files that scan lists', () => {
    const notes = emitCodeCards(repoRoot, flowDir, {
      repoScan: {
        files: ['package.json', 'src/widgets/widget.ts', 'src/widgets/x.ts'],
        unreadableDirs: [],
      },
    });
    // src/cli files exist on disk but are absent from the provided scan — a
    // re-walk would find them; the shared scan must be the only source.
    expect(existsSync(join(flowDir, 'brain', 'code', 'src-cli.md'))).toBe(false);
    expect(notes.some((note) => note.startsWith('code-cards: 1 card(s)'))).toBe(true);
    expect(notes).toContain('code-cards: 2 file(s) extracted, 0 reused from cache');
  });

  describe('stat pre-filter (stampHints)', () => {
    const FIXED_MTIME = new Date(1700000000000);
    const TARGET = 'src/widgets/x.ts';
    const OLD_CONTENT = 'export const x = 1;\n';
    const POISON_CONTENT = 'export const z = 9;\n'; // SAME byte length

    it('a matching stat hint reuses the cached card facts with zero reads', () => {
      emitCodeCards(repoRoot, flowDir); // build the card cache
      const absPath = join(repoRoot, TARGET);
      utimesSync(absPath, FIXED_MTIME, FIXED_MTIME);
      const stat = statSync(absPath);

      // Poison the content (same size), restore the mtime — extraction would
      // surface `z`; the stat short-circuit must keep the cached `x` facts,
      // proving the file was neither read nor re-hashed.
      writeFileSync(absPath, POISON_CONTENT, 'utf-8');
      utimesSync(absPath, FIXED_MTIME, FIXED_MTIME);
      const stampHints = new Map<string, RepoFileHashHint>([
        [TARGET, { contentHash: hashFileContent(OLD_CONTENT), mtimeMs: stat.mtimeMs, size: stat.size }],
      ]);

      const notes = emitCodeCards(repoRoot, flowDir, { stampHints });
      expect(notes).toContain('code-cards: 0 file(s) extracted, 4 reused from cache');
      const card = readFileSync(join(flowDir, 'brain', 'code', 'src-widgets.md'), 'utf-8');
      expect(card).toContain('- x (const) — line 1');
      expect(card).not.toContain('- z (const)');
    });

    it('an mtime mismatch falls through to the content read — the changed file re-extracts', () => {
      emitCodeCards(repoRoot, flowDir);
      const absPath = join(repoRoot, TARGET);
      const stat = statSync(absPath);

      writeFileSync(absPath, POISON_CONTENT, 'utf-8');
      utimesSync(absPath, FIXED_MTIME, FIXED_MTIME); // differs from the hint's recorded mtime
      const stampHints = new Map<string, RepoFileHashHint>([
        [TARGET, { contentHash: hashFileContent(OLD_CONTENT), mtimeMs: stat.mtimeMs, size: stat.size }],
      ]);

      const notes = emitCodeCards(repoRoot, flowDir, { stampHints });
      expect(notes).toContain('code-cards: 1 file(s) extracted, 3 reused from cache');
      const card = readFileSync(join(flowDir, 'brain', 'code', 'src-widgets.md'), 'utf-8');
      expect(card).toContain('- z (const) — line 1');
      expect(card).not.toContain('- x (const)');
    });

    it('a hint whose stored hash disagrees with the card cache never short-circuits', () => {
      emitCodeCards(repoRoot, flowDir);
      const absPath = join(repoRoot, TARGET);
      utimesSync(absPath, FIXED_MTIME, FIXED_MTIME);
      const stat = statSync(absPath);
      // Hint stat matches but its hash is NOT the cached hash — the gate
      // requires hint hash === cached hash, so the file is read (content
      // unchanged → still reused via the content-hash check).
      const stampHints = new Map<string, RepoFileHashHint>([
        [TARGET, { contentHash: 'f'.repeat(64), mtimeMs: stat.mtimeMs, size: stat.size }],
      ]);

      const notes = emitCodeCards(repoRoot, flowDir, { stampHints });
      expect(notes).toContain('code-cards: 0 file(s) extracted, 4 reused from cache');
    });
  });
});
