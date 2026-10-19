/**
 * Tests for the `blueprint storyline` verb — the argument contract, the path
 * guard, every refusal's sentence, entry ranking across files, the
 * content-keyed cache, part mode's merge, the caps, and the cache folder's
 * registration as generated knowledge. Temp repos seeded with node:fs; the
 * real TypeScript compiler.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { dirname, join } from 'node:path';

import { runBlueprint } from '../commands/blueprint.js';
import { classifyKnowledgePath, KNOWLEDGE_CLASS_TABLE } from '../handlers/knowledge-classes.js';
import { hashFileContent } from './store.js';
import { functionPiecesOf } from './storyline-notes.js';
import { loadTypeScript } from './storyline-compiler.js';
import type { StorylineAnswer, StorylineRefusal, StorylineResult } from './storyline-types.js';
import {
  MAX_PART_FILES,
  MAX_PLAN_STORY_BOXES,
  MAX_STORY_FILE_LINES,
  partLanguage,
  runStorylineVerb,
  storylineCacheKey,
  type StorylineVerbOutput,
} from './storyline-verb.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo(files: Record<string, string>, withFlow = true): string {
  const root = mkdtempSync(join(tmpdir(), 'storyline-verb-'));
  roots.push(root);
  if (withFlow) mkdirSync(join(root, 'flow'), { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf-8');
  }
  return root;
}

function parsed(output: StorylineVerbOutput): StorylineAnswer {
  expect(output.exitCode).toBe(0);
  const lines = output.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as StorylineAnswer;
}

function story(output: StorylineVerbOutput): StorylineResult {
  const answer = parsed(output);
  if (!answer.ok) throw new Error(`expected a story, got ${answer.reason}: ${answer.sentence}`);
  return answer;
}

function refusal(output: StorylineVerbOutput): StorylineRefusal {
  const answer = parsed(output);
  if (answer.ok) throw new Error('expected a refusal');
  return answer;
}

function cacheDir(root: string): string {
  return join(root, 'flow', 'brain', '.structure', 'storyline');
}

function cachedExtractions(root: string): string[] {
  const dir = cacheDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name !== 'imports.json');
}

// ── Fixtures ──────────────────────────────────────────────

const ORDERS = [
  "import { formatPrice } from './money.js'",
  '',
  '/** Place an order. */',
  'export function placeOrder(total: number): string {',
  '  return checkTotal(total) ? formatPrice(total) : "none"',
  '}',
  '',
  'function checkTotal(total: number): boolean {',
  '  return total > 0',
  '}',
  '',
  '/** Cancel one. */',
  'export function cancelOrder(): void {}',
  '',
  'export default function archiveOrders(): void {}',
  '',
].join('\n');

const MONEY = ['/** Price text. */', 'export function formatPrice(total: number): string {', '  return String(total)', '}', ''].join(
  '\n',
);

function rankingRepo(): string {
  return repo({
    'src/orders.ts': ORDERS,
    'src/money.ts': MONEY,
    'src/cart.ts': "import { cancelOrder, placeOrder } from './orders.js'\nexport const a = () => placeOrder(1) && cancelOrder()\n",
    'src/checkout.ts': "import { placeOrder as place } from './orders'\nexport const b = () => place(2)\n",
    'src/admin.ts': "import archive from './orders.js'\nexport const c = () => archive()\n",
    'src/report.ts': "import * as orders from './orders.js'\nexport const d = () => orders.cancelOrder()\n",
    // A test file imports everything it tests and must not lift the rank.
    'src/orders.test.ts': "import { cancelOrder, placeOrder } from './orders.js'\ncancelOrder(); placeOrder(1)\n",
  });
}

// ── Arguments and the path guard ─────────────────────────

describe('blueprint storyline — the question', () => {
  it('refuses neither and both of --file/--part, writing nothing', async () => {
    const root = rankingRepo();
    for (const input of [{ repoRoot: root }, { repoRoot: root, file: 'src/orders.ts', part: 'orders' }]) {
      const output = await runStorylineVerb(input);
      expect(output.exitCode).toBe(1);
      expect(output.stdout).toBe('storyline refused: arguments — pass exactly one of --file <path> or --part <feature-ref> (or --plan <name> alone)\n');
    }
    expect(existsSync(cacheDir(root))).toBe(false);
  });

  it('refuses through the real command on the combined transcript, exit 1', async () => {
    const root = rankingRepo();
    const written: string[] = [];
    const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const err = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const before = process.exitCode;
    try {
      await runBlueprint('storyline', undefined, { target: root, file: 'src/orders.ts', part: 'orders' });
      expect(written.join('')).toContain('storyline refused: arguments');
      expect(process.exitCode).toBe(1);
    } finally {
      out.mockRestore();
      err.mockRestore();
      process.exitCode = before;
    }
    expect(existsSync(cacheDir(root))).toBe(false);
  });

  it('refuses a path that climbs out of the project, or names one outside it', async () => {
    const root = rankingRepo();
    const outside = repo({ 'secret.ts': 'export const x = 1\n' });
    for (const file of ['../secret.ts', join(outside, 'secret.ts')]) {
      const output = await runStorylineVerb({ repoRoot: root, file });
      expect(output.exitCode).toBe(1);
      expect(output.stdout).toContain('storyline refused: outside-project');
      expect(output.stdout).not.toContain('{');
    }
    expect(existsSync(cacheDir(root))).toBe(false);
  });

  it('answers a missing file with a not-found refusal, exit 0', async () => {
    const root = rankingRepo();
    const answer = refusal(await runStorylineVerb({ repoRoot: root, file: 'src/nope.ts' }));
    expect(answer).toEqual({
      ok: false,
      reason: 'not-found',
      sentence: "Flow couldn't find nope.ts in this project.",
      file: 'src/nope.ts',
    });
  });

  it('answers a file that is not TypeScript or JavaScript with its text', async () => {
    const root = repo({ 'notes.md': '# hi\n' });
    const answer = refusal(await runStorylineVerb({ repoRoot: root, file: 'notes.md' }));
    expect(answer.reason).toBe('unsupported-language');
    expect(answer.sentence).toBe("Flow can't read Markdown as a story yet.");
    expect(answer.text).toBe('# hi\n');
  });

  it('answers no-compiler with the plain text when the code reader cannot load', async () => {
    const root = rankingRepo();
    const answer = refusal(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' }, { loadTs: () => null }));
    expect(answer.reason).toBe('no-compiler');
    expect(answer.sentence).toBe("Flow couldn't load its code reader, so this file is shown as plain code.");
    expect(answer.text).toBe(MONEY);
    expect(existsSync(cacheDir(root))).toBe(false);
  });

  it('answers a file that does not parse with a syntax-error refusal', async () => {
    const root = repo({ 'src/bad.ts': 'export function (\n' });
    const answer = refusal(await runStorylineVerb({ repoRoot: root, file: 'src/bad.ts' }));
    expect(answer.reason).toBe('syntax-error');
    expect(answer.sentence).toMatch(/^This file can't be read as a story yet: line 1 doesn't parse/);
  });
});

// ── Ranking ───────────────────────────────────────────────

describe('blueprint storyline — the ways in, ranked', () => {
  it('counts other files importing each piece by name, default and namespace included', async () => {
    const root = rankingRepo();
    const result = story(await runStorylineVerb({ repoRoot: root, file: 'src/orders.ts' }));
    expect(result.entries).toEqual([
      // cart + checkout (aliased); the test file does not count
      { pieceId: 'src/orders.ts#placeOrder', usedFrom: 2 },
      // cart + report (through `orders.cancelOrder`)
      { pieceId: 'src/orders.ts#cancelOrder', usedFrom: 2 },
      // admin's default import
      { pieceId: 'src/orders.ts#archiveOrders', usedFrom: 1 },
    ]);
  });

  it('keeps file order for ties and for pieces nobody imports', async () => {
    const root = repo({
      'src/a.ts': 'export function first(): void {}\nexport function second(): void {}\nexport function third(): void {}\n',
      'src/b.ts': "import { third } from './a.js'\nthird()\n",
    });
    const result = story(await runStorylineVerb({ repoRoot: root, file: 'src/a.ts' }));
    expect(result.entries.map((entry) => [entry.pieceId.split('#')[1], entry.usedFrom])).toEqual([
      ['third', 1],
      ['first', 0],
      ['second', 0],
    ]);
  });

  it('ranks a class method by the importers of its class that mention it', async () => {
    const root = repo({
      'src/queue.ts': 'export class Queue {\n  push(): void {}\n  drain(): void {}\n  private hidden(): void {}\n}\n',
      'src/one.ts': "import { Queue } from './queue.js'\nnew Queue().drain()\n",
      'src/two.ts': "import type { Queue } from './queue.js'\nexport const go = (q: Queue) => q.drain()\n",
      'src/three.ts': "import { Queue } from './queue.js'\nnew Queue().push()\n",
    });
    const result = story(await runStorylineVerb({ repoRoot: root, file: 'src/queue.ts' }));
    // The class itself is not a way in: its methods are.
    expect(result.entries).toEqual([
      { pieceId: 'src/queue.ts#Queue.drain', usedFrom: 2 },
      { pieceId: 'src/queue.ts#Queue.push', usedFrom: 1 },
    ]);
  });

  it('breaks a tie by how much of the file the story reaches, then by file order', async () => {
    const root = repo({
      'src/flow.ts': [
        'export function helper(): void {}',
        'export function small(): void { helper() }',
        'export function big(): void { step() }',
        'function step(): void { helper(); last() }',
        'function last(): void {}',
        '',
      ].join('\n'),
      'src/use.ts': "import { helper, small, big } from './flow.js'\nhelper(); small(); big()\n",
    });
    const result = story(await runStorylineVerb({ repoRoot: root, file: 'src/flow.ts' }));
    expect(result.entries.map((entry) => entry.pieceId.split('#')[1])).toEqual(['big', 'small', 'helper']);
  });
});

// ── Cache ─────────────────────────────────────────────────

describe('blueprint storyline — cached by content', () => {
  it('writes the extraction under the content key, reads it back, and re-keys after an edit', async () => {
    const root = rankingRepo();
    const first = story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' }));
    const key = storylineCacheKey('src/money.ts', hashFileContent(MONEY));
    expect(cachedExtractions(root)).toEqual([`${key}.json`]);

    // A cache hit is what is served: doctor the stored record and see it come back.
    const path = join(cacheDir(root), `${key}.json`);
    const record = JSON.parse(readFileSync(path, 'utf-8')) as { result: StorylineResult };
    record.result.pieces[0] = { ...record.result.pieces[0], doc: 'from the cache' } as StorylineResult['pieces'][number];
    writeFileSync(path, JSON.stringify(record), 'utf-8');
    const second = story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' }));
    expect(second.pieces[0]?.doc).toBe('from the cache');
    expect(first.pieces[0]?.doc).toBe('Price text.');

    // An edit is a new key and a fresh read.
    const edited = MONEY.replace('Price text.', 'Price as text.');
    writeFileSync(join(root, 'src/money.ts'), edited, 'utf-8');
    const third = story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' }));
    expect(third.pieces[0]?.doc).toBe('Price as text.');
    expect(cachedExtractions(root)).toContain(`${storylineCacheKey('src/money.ts', hashFileContent(edited))}.json`);
    expect(cachedExtractions(root)).toHaveLength(2);
  });

  it('re-extracts over a corrupt cache entry', async () => {
    const root = rankingRepo();
    story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' }));
    const key = storylineCacheKey('src/money.ts', hashFileContent(MONEY));
    writeFileSync(join(cacheDir(root), `${key}.json`), '{not json', 'utf-8');
    expect(story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' })).pieces[0]?.doc).toBe('Price text.');
  });

  it('notices a new importer through the cached import index', async () => {
    const root = rankingRepo();
    expect(story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' })).entries[0]?.usedFrom).toBe(1);
    writeFileSync(join(root, 'src/tax.ts'), "import { formatPrice } from './money.js'\nformatPrice(3)\n", 'utf-8');
    expect(story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' })).entries[0]?.usedFrom).toBe(2);
  });

  it('re-resolves a cached file\'s imports: a sibling renamed foo.js → foo.ts is not served stale', async () => {
    const root = repo({
      'src/main.ts': "import { helper } from './foo'\nexport function run(): void { helper() }\n",
      'src/foo.js': 'export function helper() {}\n',
    });
    const first = story(await runStorylineVerb({ repoRoot: root, file: 'src/main.ts' }));
    expect(first.calls.find((call) => call.external !== undefined)?.external).toEqual({ file: 'src/foo.js', name: 'helper' });
    // The file's own bytes did not change, so the content key is the same one…
    renameSync(join(root, 'src/foo.js'), join(root, 'src/foo.ts'));
    const second = story(await runStorylineVerb({ repoRoot: root, file: 'src/main.ts' }));
    expect(cachedExtractions(root)).toHaveLength(1);
    // …and still the chip names the file that is there now.
    expect(second.calls.find((call) => call.external !== undefined)?.external).toEqual({ file: 'src/foo.ts', name: 'helper' });
  });

  it('writes nothing into a project without a flow folder', async () => {
    const root = repo({ 'src/money.ts': MONEY }, false);
    story(await runStorylineVerb({ repoRoot: root, file: 'src/money.ts' }));
    expect(existsSync(join(root, 'flow'))).toBe(false);
  });

  it('registers the cache folder as generated knowledge — rebuilt per machine, never synced', async () => {
    const row = KNOWLEDGE_CLASS_TABLE.find((entry) => entry.pattern === 'brain/.structure/storyline/');
    expect(row?.class).toBe('generated');
    expect(row?.why).toMatch(/\S/);
    expect(classifyKnowledgePath('brain/.structure/storyline/abc.json')).toBe('generated');
  });
});

// ── Part mode ─────────────────────────────────────────────

function feature(root: string, slug: string, anchors: string[], parts = ''): void {
  const dir = join(root, 'flow', 'brain', 'features');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\nid: feature:${slug}\nname: ${slug}\nkind: core\nanchors: [${anchors.join(', ')}]\n---\n# ${slug}\n${parts}`,
    'utf-8',
  );
}

describe('blueprint storyline --part', () => {
  it("merges the part's files and turns a call between them into an arrow", async () => {
    const root = rankingRepo();
    feature(root, 'orders', ['module:src', 'file:README.md']);
    const result = story(await runStorylineVerb({ repoRoot: root, part: 'orders' }));
    expect(result.scope).toBe('part');
    expect(result.language).toBe('typescript');
    // Test files are left out of a module's story.
    expect(result.files).toEqual(['src/admin.ts', 'src/cart.ts', 'src/checkout.ts', 'src/money.ts', 'src/orders.ts', 'src/report.ts']);
    const call = result.calls.find((entry) => entry.from === 'src/orders.ts#placeOrder' && entry.line === 5 && entry.to !== null && entry.to.startsWith('src/money.ts'));
    expect(call).toEqual({ from: 'src/orders.ts#placeOrder', line: 5, to: 'src/money.ts#formatPrice' });
    expect(result.calls.some((entry) => entry.external !== undefined)).toBe(false);
    // Every importer is inside the part, so nothing is used from outside.
    expect(result.entries.every((entry) => entry.usedFrom === 0)).toBe(true);
  });

  it('resolves one part of a feature by the id the board gives it', async () => {
    const root = rankingRepo();
    feature(root, 'orders', ['module:src'], '\n## Parts\n\n### Money\nThe price text.\nanchors: src/money.ts\n');
    const result = story(await runStorylineVerb({ repoRoot: root, part: 'feature:orders/money' }));
    expect(result.files).toEqual(['src/money.ts']);
    // Counted from outside the part: orders.ts imports formatPrice.
    expect(result.entries).toEqual([{ pieceId: 'src/money.ts#formatPrice', usedFrom: 1 }]);
  });

  it('skips a part file that is a symlink out of the repo — the same guard --file gets', async () => {
    const outside = repo({ 'secret.ts': 'export function leak(): string { return "outside" }\n' }, false);
    const root = rankingRepo();
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'linked.ts'));
    // Positive first: --file refuses the same link as outside the project.
    const direct = await runStorylineVerb({ repoRoot: root, file: 'src/linked.ts' });
    expect(direct.exitCode).toBe(1);
    expect(direct.stdout).toContain('storyline refused: outside-project');
    feature(root, 'orders', ['module:src'], '\n## Parts\n\n### Linked\nA link.\nanchors: src/money.ts, src/linked.ts\n');
    const result = story(await runStorylineVerb({ repoRoot: root, part: 'feature:orders/linked' }));
    expect(result.files).toEqual(['src/money.ts']);
    expect(result.pieces.some((piece) => piece.name === 'leak')).toBe(false);
  });

  it('refuses an unknown part as a bad question', async () => {
    const root = rankingRepo();
    feature(root, 'orders', ['module:src']);
    // Positive first: the features directory IS read — a real ref resolves.
    expect(story(await runStorylineVerb({ repoRoot: root, part: 'orders' })).files.length).toBeGreaterThan(0);
    const output = await runStorylineVerb({ repoRoot: root, part: 'ghost' });
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe("storyline refused: unknown-part — no feature or part named 'ghost'\n");
  });

  it('never calls a part gone when no features could be read at all', async () => {
    const root = rankingRepo();
    feature(root, 'orders', ['module:src']);
    expect(story(await runStorylineVerb({ repoRoot: root, part: 'orders' })).files.length).toBeGreaterThan(0);
    // The features directory goes away — as it does while `flow/` is re-linked.
    rmSync(join(root, 'flow', 'brain', 'features'), { recursive: true });
    const output = await runStorylineVerb({ repoRoot: root, part: 'orders' });
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toBe("storyline refused: knowledge-unreadable — no features could be read for 'orders'\n");
    expect(output.stdout).not.toContain('unknown-part');
  });

  it('answers a part with no file any reader covers', async () => {
    const root = repo({ 'docs/a.md': '# a\n' });
    feature(root, 'docs', ['module:docs']);
    const answer = refusal(await runStorylineVerb({ repoRoot: root, part: 'docs' }));
    expect(answer).toEqual({
      ok: false,
      reason: 'unsupported-language',
      sentence: "Flow can't read any of this part's files as a story yet.",
    });
  });

  it('answers a part that is one file with no reader as that file: its language named, its text kept', async () => {
    const root = repo({ 'lib/tool.ex': 'defmodule Tool do\nend\n', 'lib/other.ex': 'x\n' });
    feature(root, 'tool', ['file:lib/tool.ex']);
    expect(refusal(await runStorylineVerb({ repoRoot: root, part: 'tool' }))).toEqual({
      ok: false,
      reason: 'unsupported-language',
      sentence: "Flow can't read Elixir as a story yet.",
      text: 'defmodule Tool do\nend\n',
      file: 'lib/tool.ex',
    });
    // Two such files, or a folder, stay the part's own sentence.
    feature(root, 'both', ['file:lib/tool.ex', 'file:lib/other.ex']);
    expect(refusal(await runStorylineVerb({ repoRoot: root, part: 'both' })).sentence).toBe(
      "Flow can't read any of this part's files as a story yet.",
    );
    feature(root, 'lib', ['module:lib']);
    expect(refusal(await runStorylineVerb({ repoRoot: root, part: 'lib' })).file).toBeUndefined();
  });

  it('answers no-compiler without text for a part', async () => {
    const root = rankingRepo();
    feature(root, 'orders', ['module:src']);
    const answer = refusal(await runStorylineVerb({ repoRoot: root, part: 'orders' }, { loadTs: () => null }));
    expect(answer.reason).toBe('no-compiler');
    expect(answer.text).toBeUndefined();
  });
});

// ── Caps ──────────────────────────────────────────────────

describe('blueprint storyline — caps', () => {
  it('shows a file over the line cap as plain code', async () => {
    const big = 'export const x = 1\n'.repeat(MAX_STORY_FILE_LINES + 1);
    const root = repo({ 'src/big.ts': big });
    const answer = refusal(await runStorylineVerb({ repoRoot: root, file: 'src/big.ts' }));
    expect(answer.reason).toBe('too-large');
    expect(answer.sentence).toBe('big.ts is 5,001 lines — longer than Flow reads as a story (5,000), so it is shown as plain code.');
    expect(answer.text).toBe(big);
    expect(cachedExtractions(root)).toEqual([]);
  });

  it('refuses a part over the file cap, without text', async () => {
    const files: Record<string, string> = {};
    for (let n = 0; n <= MAX_PART_FILES; n += 1) files[`src/f${n}.ts`] = `export const v${n} = 1\n`;
    const root = repo(files);
    feature(root, 'many', ['module:src']);
    const answer = refusal(await runStorylineVerb({ repoRoot: root, part: 'many' }));
    expect(answer.reason).toBe('too-large');
    expect(answer.sentence).toContain(`This part spans ${MAX_PART_FILES + 1} files`);
    expect(answer.text).toBeUndefined();
  });

  it('refuses a part over the total line cap', async () => {
    const chunk = 'export const x = 1\n'.repeat(3_000);
    const root = repo({ 'src/a.ts': chunk, 'src/b.ts': chunk, 'src/c.ts': chunk });
    feature(root, 'long', ['module:src']);
    const answer = refusal(await runStorylineVerb({ repoRoot: root, part: 'long' }));
    expect(answer.reason).toBe('too-large');
    expect(answer.sentence).toContain('more than 8,000 lines');
  });
});

describe('the compiler the suite reads with', () => {
  it('loads', async () => {
    expect(loadTypeScript()).not.toBeNull();
  });
});

// ── Any language (plan `story-any-language` phase 3) ─────

const PRICING_PY = [
  'from dataclasses import dataclass',
  '',
  '',
  '@dataclass',
  'class Price:',
  '    amount: int',
  '',
  '',
  'def total(price: Price) -> int:',
  '    """Sum one price."""',
  '    return rounded(price.amount)',
  '',
  '',
  'def rounded(value: int) -> int:',
  '    return value',
  '',
].join('\n');

function pythonRepo(): string {
  return repo({
    'app/pricing.py': PRICING_PY,
    'app/__init__.py': '',
    'app/orders.py': 'from .pricing import total\n\n\ndef place(p):\n    return total(p)\n',
    'app/report.py': 'from . import pricing\n\n\ndef show(p):\n    return pricing.total(p) + pricing.rounded(1)\n',
    'app/cli.py': 'import app.pricing\n\n\ndef main():\n    return app.pricing.rounded(2)\n',
    'app/test_pricing.py': 'from .pricing import total, rounded\n',
    'web/main.ts': "import { x } from './x.js'\nexport function run(): number { return x() }\n",
    'web/x.ts': 'export function x(): number { return 1 }\n',
  });
}

describe('blueprint storyline — any language', () => {
  it('reads a Python file as a story through tree-sitter, ranked by its Python importers', async () => {
    const root = pythonRepo();
    const result = story(await runStorylineVerb({ repoRoot: root, file: 'app/pricing.py' }));
    expect(result.language).toBe('python');
    expect(result.pieces.map((piece) => piece.name)).toEqual(['Price', 'total', 'rounded']);
    expect(result.calls).toContainEqual({ from: 'app/pricing.py#total', line: 11, to: 'app/pricing.py#rounded' });
    // orders + report import total; report and cli reach rounded; the test file is not counted.
    const used = Object.fromEntries(result.entries.map((entry) => [entry.pieceId, entry.usedFrom]));
    expect(used['app/pricing.py#total']).toBe(2);
    expect(used['app/pricing.py#rounded']).toBe(2);
    expect(result.entries[0]?.pieceId).toBe('app/pricing.py#total');
  });

  it('caches a Python story under its engine, apart from the TypeScript key', async () => {
    const root = pythonRepo();
    story(await runStorylineVerb({ repoRoot: root, file: 'app/pricing.py' }));
    const bytes = readFileSync(join(root, 'app/pricing.py'));
    expect(cachedExtractions(root)).toHaveLength(1);
    expect(cachedExtractions(root)).not.toContain(`${storylineCacheKey('app/pricing.py', hashFileContent(bytes))}.json`);
    const again = story(await runStorylineVerb({ repoRoot: root, file: 'app/pricing.py' }));
    expect(again.pieces).toHaveLength(3);
    expect(cachedExtractions(root)).toHaveLength(1);
  });

  it('names the language it cannot read, keeping the text for the plain view', async () => {
    const root = repo({ 'lib/tool.ex': 'defmodule Tool do\nend\n', 'lib/x.unknownext': 'x' });
    const elixir = refusal(await runStorylineVerb({ repoRoot: root, file: 'lib/tool.ex' }));
    expect(elixir).toEqual({
      ok: false,
      reason: 'unsupported-language',
      sentence: "Flow can't read Elixir as a story yet.",
      text: 'defmodule Tool do\nend\n',
      file: 'lib/tool.ex',
    });
    const unknown = refusal(await runStorylineVerb({ repoRoot: root, file: 'lib/x.unknownext' }));
    expect(unknown.sentence).toBe("Flow can't read this kind of file as a story yet.");
  });

  it('answers the no-reader refusal, with text, when the engine cannot be found', async () => {
    const root = pythonRepo();
    const answer = refusal(await runStorylineVerb({ repoRoot: root, file: 'app/pricing.py' }, { loadTreeSitter: () => null }));
    expect(answer).toMatchObject({ reason: 'no-compiler', text: PRICING_PY, file: 'app/pricing.py' });
    expect(answer.sentence).toBe("Flow couldn't load its Python reader, so this file opens as plain code.");
    // A TypeScript file never needs the engine.
    expect(story(await runStorylineVerb({ repoRoot: root, file: 'web/main.ts' }, { loadTreeSitter: () => null })).language).toBe('typescript');
  });

  it('a part mixing languages reads each file with its own reader and is "mixed"', async () => {
    const root = pythonRepo();
    feature(root, 'shop', ['module:app', 'module:web']);
    const result = story(await runStorylineVerb({ repoRoot: root, part: 'shop' }));
    expect(result.language).toBe('mixed');
    expect(result.files).toEqual([
      'app/__init__.py', 'app/cli.py', 'app/orders.py', 'app/pricing.py', 'app/report.py', 'web/main.ts', 'web/x.ts',
    ]);
    // A Python call into another file of the part is an arrow, as a TypeScript one is.
    expect(result.calls).toContainEqual({ from: 'app/orders.py#place', line: 5, to: 'app/pricing.py#total' });
    expect(result.calls).toContainEqual({ from: 'web/main.ts#run', line: 2, to: 'web/x.ts#x' });
  });

  it('a part of one tree-sitter language answers that language; a missing engine names its reader', async () => {
    const root = pythonRepo();
    feature(root, 'py', ['module:app']);
    expect(story(await runStorylineVerb({ repoRoot: root, part: 'py' })).language).toBe('python');
    const answer = refusal(await runStorylineVerb({ repoRoot: root, part: 'py' }, { loadTreeSitter: () => null }));
    expect(answer).toEqual({
      ok: false,
      reason: 'no-compiler',
      sentence: "Flow couldn't load its Python reader, so this part can't be read as a story.",
    });
  });

  it('partLanguage: one family is that language, TS with JS is typescript, anything else is mixed', () => {
    expect(partLanguage(['javascript', 'javascript'])).toBe('javascript');
    expect(partLanguage(['javascript', 'typescript'])).toBe('typescript');
    expect(partLanguage(['go', 'go'])).toBe('go');
    expect(partLanguage(['go', 'typescript'])).toBe('mixed');
  });
});

// ── A plan's change notes widen the story (plan `plan_change_review` phase 3) ──

describe('a plan with change notes', () => {
  const plan = [
    '# Plan: Notes',
    '',
    '### Phase 1: Touch',
    '',
    '- [ ] Touch them',
    '',
    '#### Change notes',
    '',
    '- note: 1 · change · file:lib/money.ts:formatPrice',
    '    where: `return`',
    '    what: round it',
    '    why: cents',
    '- note: 2 · file · file:docs/readme.md',
    '    what: say so',
    '    why: users read it',
    '- note: 3 · change · file:lib/missing.ts:gone',
    '    where: `x`',
    '    what: change it',
    '    why: because',
    '',
  ].join('\n');

  it('draws each readable note file, leaves out what cannot be read, and says which note is not on the story', async () => {
    const root = repo({
      'src/orders.ts': ORDERS,
      'lib/money.ts': 'export function formatPrice(total: number): string {\n  return `$${total}`;\n}\n',
      'docs/readme.md': '# Readme\n',
      'flow/plans/plan_notes_v1.md': plan,
    });
    const result = story(await runStorylineVerb({ repoRoot: root, file: 'src/orders.ts', plan: 'notes' }));
    expect(result.scope).toBe('file');
    expect(result.files).toEqual(['src/orders.ts', 'lib/money.ts']);
    expect(result.bands).toEqual([{ project: null, files: ['src/orders.ts', 'lib/money.ts'] }]);
    const predicted = result.compare?.predicted ?? [];
    expect(predicted.find((p) => 'note' in p && p.note.n === 1)).toMatchObject({ pieceId: 'lib/money.ts#formatPrice', quoteLines: { startLine: 2, endLine: 2 } });
    expect(predicted.find((p) => 'note' in p && p.note.n === 2)).toMatchObject({ kind: 'note-file', file: 'docs/readme.md' });
    expect(predicted.find((p) => 'note' in p && p.note.n === 3)).toMatchObject({ pieceMissing: true, fileMissing: true });
  });
});

describe("a plan's own story (--plan alone)", () => {
  const previousHome = process.env.PLAN_FLOW_HOME;
  afterEach(() => {
    process.env.PLAN_FLOW_HOME = previousHome;
  });

  const VIEWS = [
    'from core.service import Service',
    '',
    '',
    'async def list_plans(service: Service, page: int):',
    '    result = await service.list_for_user(page=page)',
    '    return result',
    '',
  ].join('\n');
  const SERVICE = [
    'class Service:',
    '    def list_for_user(self, page):',
    '        rows = self._filter(page)',
    '        return rows',
    '',
    '    def _filter(self, page):',
    '        return self._paginate(page)',
    '',
    '    def _paginate(self, page):',
    '        return [page]',
    '',
    '    def unrelated(self):',
    '        return None',
    '',
  ].join('\n');
  const API = [
    'export class Api {',
    '  async getPlans(page: number): Promise<number[]> {',
    '    return [page];',
    '  }',
    '}',
    '',
  ].join('\n');
  const LIB = [
    "import type { Api } from './api';",
    '',
    'export async function getLib(api: Api): Promise<number[]> {',
    '  const plans = await api.getPlans(1);',
    '  return plans;',
    '}',
    '',
    'export function unused(): void {}',
    '',
  ].join('\n');
  const PLAN = [
    '# Plan: Sort',
    '',
    '### Phase 1: Core',
    '',
    '- [ ] Sort on the server',
    '',
    '#### Change notes',
    '',
    '- note: 1 · new · core/file:core/service.py:_sort',
    '    signature: _sort(rows, key)',
    '    purpose: one sort for every list',
    '    callers: list_for_user',
    '- note: 2 · change · core/file:core/service.py:_paginate',
    '    where: `return [page]`',
    '    what: sort first',
    '    why: order',
    '- note: 3 · change · core/file:core/service.py:list_for_user',
    '    where: `rows = self._filter(page)`',
    '    what: pass the sort',
    '    why: order',
    '- note: 4 · change · core/file:core/views.py:list_plans',
    '    where: `await service.list_for_user(page=page)`',
    '    what: read the sort',
    '    why: the table asks',
    '- note: 5 · file · core/file:core/README.md',
    '    what: say so',
    '    why: docs',
    '',
    '### Phase 2: Web',
    '',
    '- [ ] Pass the sort',
    '',
    '#### Change notes',
    '',
    '- note: 6 · change · web/file:src/lib.ts:getLib',
    '    where: `await api.getPlans(1)`',
    '    what: pass the sort',
    '    why: the table asks',
    '- note: 7 · change · web/file:src/api.ts:getPlans',
    '    where: `return [page];`',
    '    what: send the sort',
    '    why: the server reads it',
    '',
  ].join('\n');

  /** Workspace `team`: argo (this repo — the plan only), core (Python) and web (TypeScript) checked out. */
  function seedWorkspace(): { argo: string; core: string; web: string } {
    const home = mkdtempSync(join(tmpdir(), 'storyline-plan-home-'));
    roots.push(home);
    const argo = repo({ 'flow/plans/plan_sort_v1.md': PLAN, 'deploy/values.yaml': 'a: 1\n' });
    // A sibling with its own flow folder: the story must never cache into it.
    const core = repo({ 'core/views.py': VIEWS, 'core/service.py': SERVICE, 'core/README.md': '# core\n' });
    const web = repo({ 'src/api.ts': API, 'src/lib.ts': LIB }, false);
    const project = (slug: string): Record<string, unknown> => ({ id: `local:${slug}`, name: slug, slug, remotes: [] });
    mkdirSync(join(home, 'workspaces', 'team'), { recursive: true });
    writeFileSync(
      join(home, 'workspaces', 'team', 'workspace.json'),
      JSON.stringify({ name: 'Team', slug: 'team', projects: [project('web'), project('core'), project('argo')] }),
    );
    writeFileSync(join(home, 'projects.local.json'), JSON.stringify({ projects: { 'local:argo': argo, 'local:core': core, 'local:web': web } }));
    process.env.PLAN_FLOW_HOME = home;
    return { argo, core, web };
  }

  it('draws every noted function from the sibling checkouts with its code, wired by calls, a linking function included', async () => {
    const { argo, core } = seedWorkspace();
    const result = story(await runStorylineVerb({ repoRoot: argo, plan: 'sort' }));

    expect(result.scope).toBe('part');
    expect(result.language).toBe('mixed');
    // Projects in note order; in each, files in the order the calls reach them. A file no reader reads is left out.
    expect(result.files).toEqual(['core/core/views.py', 'core/core/service.py', 'web/src/lib.ts', 'web/src/api.ts']);
    const ids = result.pieces.map((piece) => piece.id).sort();
    expect(ids).toEqual(
      [
        'core/core/service.py#Service._filter',
        'core/core/service.py#Service._paginate',
        'core/core/service.py#Service.list_for_user',
        'core/core/views.py#list_plans',
        'web/src/api.ts#Api.getPlans',
        'web/src/lib.ts#getLib',
      ].sort(),
    );
    // Real code, not just a name.
    expect(result.pieces.find((piece) => piece.name === 'list_for_user')?.text).toContain('rows = self._filter(page)');

    const edges = result.calls
      .filter((call) => call.to !== null)
      .map((call) => `${call.from.split('#')[1] ?? ''} -> ${(call.to ?? '').split('#')[1] ?? ''} @${String(call.line)}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        'list_plans -> Service.list_for_user @5',
        'Service.list_for_user -> Service._filter @3',
        'Service._filter -> Service._paginate @7',
        'getLib -> Api.getPlans @4',
      ]),
    );
    // A call to a function the story does not draw keeps its name, never an arrow to nowhere.
    for (const call of result.calls) if (call.to !== null) expect(ids).toContain(call.to);

    // Each project's story opens where nothing drawn calls in; projects in note order.
    expect(result.entries[0]?.pieceId).toBe('core/core/views.py#list_plans');
    expect(result.entries.find((entry) => entry.pieceId.startsWith('web/'))?.pieceId).toBe('web/src/lib.ts#getLib');
    expect(result.bands?.map((band) => [band.project, band.colorIndex, band.files.length])).toEqual([
      [null, 2, 0],
      ['core', 1, 2],
      ['web', 0, 2],
    ]);

    const predicted = result.compare?.predicted ?? [];
    const byNote = (n: number): Record<string, unknown> | undefined =>
      predicted.find((prediction) => 'note' in prediction && prediction.note.n === n) as Record<string, unknown> | undefined;
    expect(byNote(3)).toMatchObject({ kind: 'note-change', pieceId: 'core/core/service.py#Service.list_for_user', quoteLines: { startLine: 3, endLine: 3 } });
    expect(byNote(4)).toMatchObject({ pieceId: 'core/core/views.py#list_plans', quoteLines: { startLine: 5, endLine: 5 } });
    expect(byNote(7)).toMatchObject({ pieceId: 'web/src/api.ts#Api.getPlans', quoteLines: { startLine: 3, endLine: 3 } });
    expect(byNote(1)).toMatchObject({ kind: 'note-new', callerPieces: { list_for_user: 'core/core/service.py#Service.list_for_user' } });
    expect(byNote(5)).toMatchObject({ kind: 'note-file', file: 'core/core/README.md' });

    // Nothing is written into a sibling's checkout — not even into its own flow folder.
    expect(existsSync(cacheDir(core))).toBe(false);
  });

  it("reads a sibling's file by its story path with --file", async () => {
    const { argo, core } = seedWorkspace();
    const result = story(await runStorylineVerb({ repoRoot: argo, file: 'core/core/service.py' }));
    expect(result.files).toEqual(['core/core/service.py']);
    expect(result.pieces.map((piece) => piece.id)).toContain('core/core/service.py#Service._paginate');
    expect(result.calls.find((call) => call.from === 'core/core/service.py#Service._filter')?.to).toBe('core/core/service.py#Service._paginate');
    expect(existsSync(cacheDir(core))).toBe(false);
    // A local file is still the local file, and an unknown project is still not found.
    expect(refusal(await runStorylineVerb({ repoRoot: argo, file: 'nobody/core/service.py' })).reason).toBe('not-found');
  });

  it('answers not-found for a plan with no notes or no active plan, and refuses no subject without a plan', async () => {
    const root = repo({ 'flow/plans/plan_bare_v1.md': '# Plan: Bare\n\n### Phase 1: X\n\n- [ ] do it\n' });
    expect(refusal(await runStorylineVerb({ repoRoot: root, plan: 'bare' })).sentence).toBe('This plan has no change notes to show in the code.');
    expect(refusal(await runStorylineVerb({ repoRoot: root, plan: 'nope' })).sentence).toBe("Flow couldn't find an active plan named nope.");
    expect((await runStorylineVerb({ repoRoot: root })).exitCode).toBe(1);
  });

  it("a note's bare name finds the method only when exactly one class of the file has it", () => {
    const at = (id: string, name: string, className?: string): { id: string; file: string; name: string; className?: string } => ({
      id: `a.py#${id}`,
      file: 'a.py',
      name,
      ...(className === undefined ? {} : { className }),
    });
    const one = [at('S.run', 'run', 'S'), at('S.stop', 'stop', 'S')];
    expect(functionPiecesOf(one, 'a.py', 'run').map((piece) => piece.id)).toEqual(['a.py#S.run']);
    const two = [...one, at('T.run', 'run', 'T')];
    expect(functionPiecesOf(two, 'a.py', 'run')).toEqual([]);
    expect(functionPiecesOf([...two, at('run', 'run')], 'a.py', 'run').map((piece) => piece.id)).toEqual(['a.py#run']);
  });

  it('keeps a plan with --file in this project exactly as before', async () => {
    const root = repo({ 'src/orders.ts': ORDERS, 'flow/plans/plan_sort_v1.md': PLAN });
    const result = story(await runStorylineVerb({ repoRoot: root, file: 'src/orders.ts', plan: 'sort' }));
    expect(result.scope).toBe('file');
    expect(result.files[0]).toBe('src/orders.ts');
  });
});

describe("a plan's own story carries the code around its notes", () => {
  const CART = [
    "import { formatPrice } from './money';",
    '',
    'export class Cart {',
    '  private total = 0;',
    '  constructor(private readonly currency: string) {',
    '    this.total = this.opening();',
    '  }',
    '  opening(): number {',
    '    return 0;',
    '  }',
    '  unrelated(): number {',
    '    return 1;',
    '  }',
    '}',
    '',
    'export function checkout(cart: Cart, coupon: Coupon | null): string {',
    '  const total = applyDiscount(10, coupon);',
    '  return formatPrice(total);',
    '}',
    '',
    'function applyDiscount(total: number, coupon: Coupon | null): number {',
    '  return coupon === null ? total : total * coupon.rate;',
    '}',
    '',
    'export function submit(cart: Cart): string {',
    '  return checkout(cart, null);',
    '}',
    '',
    'export function lonely(): number {',
    '  return 2;',
    '}',
    '',
    'interface Coupon {',
    '  rate: number;',
    '}',
    '',
  ].join('\n');
  const TYPES = [
    'export interface Order {',
    '  id: string;',
    '  total: number;',
    '}',
    '',
    'export type OrderId = string;',
    '',
  ].join('\n');
  const FIXTURES = [
    "import { test as base } from '@playwright/test';",
    "import {",
    "  Cart,",
    "} from './cart';",
    '',
    '/**',
    ' * Fixtures for the cart.',
    ' */',
    'export const test = base.extend({',
    '  cart: async ({}, use) => {',
    "    await use(new Cart('EUR'));",
    '  },',
    '});',
    '',
  ].join('\n');
  const SPEC = [
    "import { test } from './fixtures';",
    '',
    "test.describe('cart', () => {",
    "  test('checks out', async ({ cart }) => {",
    '    expect(cart).toBeTruthy();',
    '  });',
    '});',
    '',
  ].join('\n');
  const PLAN = [
    '# Plan: Cart',
    '',
    '### Phase 1: Cart',
    '',
    '- [ ] Discount',
    '',
    '#### Change notes',
    '',
    '- note: 1 · change · file:src/cart.ts:checkout',
    '    where: `const total = applyDiscount(10, coupon);`',
    '    what: pass the currency',
    '    why: rounding differs',
    '- note: 2 · file · file:src/types.ts',
    '    where: `total: number;`',
    '    what: add a currency field',
    '    why: orders carry one',
    '- note: 3 · file · file:src/fixtures.ts',
    '    what: add a member fixture',
    '    why: the spec needs a second user',
    '- note: 4 · file · file:src/cart.spec.ts',
    "    where: `test('checks out'`",
    '    what: add a denied case',
    '    why: the regression guard',
    '- note: 5 · new · file:src/fixtures.ts:memberCart',
    '    signature: memberCart(): Cart',
    '    purpose: a cart for a second user',
    '    callers: checkout',
    '- note: 6 · change · file:src/cart.ts:Cart.constructor',
    '    where: `this.total = this.opening();`',
    '    what: read the currency',
    '    why: rounding',
    '',
  ].join('\n');

  async function cartStory(): Promise<StorylineResult> {
    const root = repo({
      'src/cart.ts': CART,
      'src/types.ts': TYPES,
      'src/fixtures.ts': FIXTURES,
      'src/cart.spec.ts': SPEC,
      'flow/plans/plan_cart_v1.md': PLAN,
    });
    return story(await runStorylineVerb({ repoRoot: root, plan: 'cart' }));
  }

  it('draws what the noted functions call and what calls them, so the story has arrows — never the unrelated code', async () => {
    const result = await cartStory();
    const ids = result.pieces.map((piece) => piece.id);
    // The noted functions, their callee and their caller, the constructor's callee, and the data they use.
    expect(ids).toEqual(
      expect.arrayContaining([
        'src/cart.ts#checkout',
        'src/cart.ts#applyDiscount',
        'src/cart.ts#submit',
        'src/cart.ts#Cart.constructor',
        'src/cart.ts#Cart.opening',
        'src/cart.ts#Coupon',
      ]),
    );
    expect(ids).not.toContain('src/cart.ts#lonely');
    expect(ids).not.toContain('src/cart.ts#Cart.unrelated');
    const edges = result.calls.filter((call) => call.to !== null).map((call) => `${call.from.split('#')[1] ?? ''} -> ${(call.to ?? '').split('#')[1] ?? ''}`);
    expect(edges).toEqual(expect.arrayContaining(['checkout -> applyDiscount', 'submit -> checkout', 'Cart.constructor -> Cart.opening']));
    // Every arrow lands on a drawn piece.
    for (const call of result.calls) if (call.to !== null) expect(ids).toContain(call.to);
    // The story opens on the caller nothing drawn calls.
    expect(result.entries[0]?.pieceId).toBe('src/cart.ts#submit');
  });

  it("puts every file note on code: its quote's piece, else an excerpt of the file — the quote's lines or its first statement", async () => {
    const result = await cartStory();
    const predicted = result.compare?.predicted ?? [];
    const byNote = (n: number): Record<string, unknown> | undefined =>
      predicted.find((prediction) => 'note' in prediction && prediction.note.n === n) as Record<string, unknown> | undefined;
    // A quote inside a declaration marks that declaration — of the file's pieces, only it is drawn.
    expect(byNote(2)).toMatchObject({ kind: 'note-file', pieceId: 'src/types.ts#Order', quoteLines: { startLine: 3, endLine: 3 } });
    expect(result.pieces.filter((piece) => piece.file === 'src/types.ts').map((piece) => piece.id)).toEqual(['src/types.ts#Order']);
    // No declaration in the file: its first statement after the imports and the header comment.
    const fixtures = result.pieces.find((piece) => piece.file === 'src/fixtures.ts');
    expect(fixtures).toMatchObject({ kind: 'excerpt', name: 'fixtures.ts', startLine: 9 });
    expect(fixtures?.text.split('\n')[0]).toBe('export const test = base.extend({');
    expect(byNote(3)).not.toHaveProperty('pieceId');
    // A quote no declaration holds: the lines around it, named as the note's piece.
    const spec = result.pieces.find((piece) => piece.file === 'src/cart.spec.ts');
    expect(spec?.kind).toBe('excerpt');
    expect(byNote(4)).toMatchObject({ pieceId: spec?.id, quoteLines: { startLine: 4, endLine: 4 } });
    expect(spec?.text).toContain("test('checks out'");
    expect(spec !== undefined && spec.startLine <= 4 && spec.endLine >= 4).toBe(true);
  });

  it('keeps the story bounded: the noted functions always, the code around them up to the cap', async () => {
    const callees = Array.from({ length: 20 }, (_, index) => `step${String(index)}`);
    const BIG = [
      'export function run(): void {',
      ...callees.map((name) => `  ${name}();`),
      '}',
      '',
      ...callees.flatMap((name) => [`function ${name}(): void {}`, '']),
    ].join('\n');
    const root = repo({
      'src/big.ts': BIG,
      'flow/plans/plan_big_v1.md': [
        '# Plan: Big',
        '',
        '### Phase 1: Run',
        '',
        '- [ ] Run',
        '',
        '#### Change notes',
        '',
        '- note: 1 · change · file:src/big.ts:run',
        '    where: `step0();`',
        '    what: log',
        '    why: tracing',
        '',
      ].join('\n'),
    });
    const result = story(await runStorylineVerb({ repoRoot: root, plan: 'big' }));
    expect(result.pieces.map((piece) => piece.id)).toContain('src/big.ts#run');
    expect(result.pieces).toHaveLength(MAX_PLAN_STORY_BOXES);
    // The calls past the cap are chips into the file, never arrows to nowhere.
    const chips = result.calls.filter((call) => call.external !== undefined);
    expect(chips.length).toBe(20 - (MAX_PLAN_STORY_BOXES - 1));
    expect(chips[0]?.external?.file).toBe('src/big.ts');
  });
});

describe("a plan's own story compared with a starting point", () => {
  const MATH = [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export function lonelyOne(): number {',
    '  return 1;',
    '}',
    '',
    'export function lonelyTwo(): number {',
    '  return 2;',
    '}',
    '',
  ].join('\n');
  const PLAN = [
    '# Plan: Add',
    '',
    '### Phase 1: Math',
    '',
    '- [ ] Round the sum',
    '',
    '#### Change notes',
    '',
    '- note: 1 · change · file:src/math.ts:add',
    '    where: `return a + b;`',
    '    what: round it',
    '    why: cents',
    '',
  ].join('\n');

  it('never reads an undrawn function of a noted file as removed', async () => {
    const root = repo({ 'src/math.ts': MATH, 'flow/plans/plan_add_v1.md': PLAN });
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: root, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(root, 'src/math.ts'), MATH.replace('return a + b;', 'return Math.round(a + b);'), 'utf-8');

    const result = story(await runStorylineVerb({ repoRoot: root, plan: 'add', base, baseSource: 'given' }));
    // The positive first: the comparison ran against the base and saw the change.
    expect(result.compare?.base).toBe(base);
    expect(result.compare?.pieces['src/math.ts#add']).toBe('changed');
    expect(result.pieces.map((piece) => piece.id)).not.toContain('src/math.ts#lonelyOne');
    // …and the functions the story leaves undrawn are not phantom removals.
    expect(result.compare?.removed).toEqual([]);
    expect(result.compare?.summary.removed).toBe(0);
  });
});
