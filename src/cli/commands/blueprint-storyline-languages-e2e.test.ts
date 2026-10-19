/**
 * Live E2E for the code story in any language (plan `story-any-language`
 * phase 4) — exercises the REAL built CLI (`dist/cli/index.js blueprint
 * storyline`) as a subprocess against a seeded temp project, the same way
 * `blueprint-storyline-e2e.test.ts` does for TypeScript (forbidden-pattern #7:
 * the shipped path, not an in-process seam). The tree-sitter engine is the
 * CLI's own install of `@vscode/tree-sitter-wasm` — the fallback the app's
 * `FLOW_TREESITTER_PATH` stands in front of.
 *
 * The fixture: a Python package (a class with methods calling each other
 * through `self`, docstrings, a dataclass, relative and absolute imports, a
 * test file that must not count), a Go file, a TypeScript file sharing a part
 * with the Python files (a mixed part), and an Elixir file nobody can read.
 * The Today ⇄ After case commits the seed, edits the Python file and asks in a
 * plan's context — HEAD is the starting point because the tree is dirty.
 *
 * Assertions run against stdout+stderr COMBINED (allowed-pattern #15). Every
 * subprocess runs with an explicit `cwd` inside the sandbox and an explicit
 * `--target` — cwd never drifts into this repo. Nothing here reaches the
 * network; no test runs `init`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

const E2E_TIMEOUT_MS = 120_000;

const CART = 'shop/cart.py';
const MODELS = 'shop/models.py';
const PRICING = 'shop/pricing.py';
const GREETER = 'cmd/main.go';
const CLIENT = 'web/client.ts';

const CART_PY = [
  'from .models import Item',
  'from .pricing import apply_discount',
  '',
  '',
  'class Cart:',
  '    """A shopping cart that totals its items."""',
  '',
  '    def __init__(self, owner: str) -> None:',
  '        self.owner = owner',
  '        self.items: list[Item] = []',
  '',
  '    def add(self, item: Item) -> None:',
  '        """Put one item in the cart."""',
  '        self.items.append(item)',
  '        self._touch()',
  '',
  '    def total(self) -> int:',
  '        """Sum every item, discounted."""',
  '        return apply_discount(self._subtotal())',
  '',
  '    def _subtotal(self) -> int:',
  '        return sum(item.price for item in self.items)',
  '',
  '    def _touch(self) -> None:',
  '        pass',
  '',
  '',
  'def open_cart(owner: str) -> Cart:',
  '    """Start a cart for one owner."""',
  '    return Cart(owner)',
  '',
].join('\n');

const FILES: Record<string, string> = {
  'shop/__init__.py': '',
  [CART]: CART_PY,
  [MODELS]: [
    '"""Things the shop keeps."""',
    'from dataclasses import dataclass',
    '',
    '',
    '@dataclass',
    'class Item:',
    '    """One line of a cart."""',
    '',
    '    sku: str',
    '    price: int',
    '',
  ].join('\n'),
  [PRICING]: [
    'def apply_discount(amount: int) -> int:',
    '    """Take ten percent off."""',
    '    return amount - amount // 10',
    '',
  ].join('\n'),
  // Two product importers of open_cart (one relative, one absolute); Cart from one.
  'shop/checkout.py': [
    'from .cart import open_cart, Cart',
    '',
    '',
    'def checkout(owner: str) -> int:',
    '    cart = open_cart(owner)',
    '    return cart.total()',
    '',
  ].join('\n'),
  'shop/admin.py': ['from shop.cart import open_cart', '', '', 'def audit() -> None:', '    open_cart("admin")', ''].join('\n'),
  // A suite imports everything it tests — it must not move the ranking.
  'shop/test_cart.py': 'from .cart import open_cart, Cart\n',
  [GREETER]: [
    'package main',
    '',
    'import "fmt"',
    '',
    '// Greeter says hello.',
    'type Greeter struct {',
    '\tName string',
    '}',
    '',
    '// Greet prints the greeting.',
    'func (g Greeter) Greet() {',
    '\tfmt.Println(format(g.Name))',
    '}',
    '',
    'func format(name string) string {',
    '\treturn "hello " + name',
    '}',
    '',
    'func main() {',
    '\tg := Greeter{Name: "x"}',
    '\tg.Greet()',
    '}',
    '',
  ].join('\n'),
  [CLIENT]: ['/** Ask the shop for a total. */', 'export function fetchTotal(): number {', '  return 1', '}', ''].join('\n'),
  'lib/tool.ex': 'defmodule Tool do\n  def hello, do: 1\nend\n',
};

interface CliRun {
  stdout: string;
  /** stdout + stderr combined — what the user actually sees (pattern #15). */
  transcript: string;
  status: number | null;
}

interface Piece {
  id: string;
  kind: string;
  name: string;
  className?: string;
  file: string;
  startLine: number;
  endLine: number;
  doc: string | null;
  text: string;
  isConstructor?: boolean;
}

interface Compare {
  plan: string;
  base: string | null;
  baseSource: string | null;
  pieces: Record<string, string>;
  removed: Piece[];
  hunks: Record<string, Array<{ lines: Array<{ op: string; text: string }> }>>;
  summary: { changed: number; added: number; removed: number };
}

interface Answer {
  ok: boolean;
  scope?: string;
  files?: string[];
  language?: string;
  pieces?: Piece[];
  calls?: Array<{ from: string; line: number; to: string | null; external?: { file: string; name: string } }>;
  entries?: Array<{ pieceId: string; usedFrom: number }>;
  classes?: Array<{ name: string; file: string; startLine: number; constructorSignature?: string }>;
  compare?: Compare;
  compareNote?: string;
  reason?: string;
  sentence?: string;
  text?: string;
  file?: string;
}

describe('blueprint storyline E2E — any language, real built CLI against a seeded project', () => {
  let sandbox: string;
  let project: string;

  function runCli(args: string[]): CliRun {
    const result = spawnSync('node', [CLI_PATH, ...args], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, PLAN_FLOW_VAULT_DIR: join(sandbox, 'vault') },
      timeout: E2E_TIMEOUT_MS,
    });
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? '',
      transcript: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      status: result.status,
    };
  }

  function storyline(flag: '--file' | '--part', value: string, extra: string[] = []): Answer {
    const run = runCli(['blueprint', 'storyline', '--target', project, flag, value, ...extra, '--json']);
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? '') as Answer;
  }

  function seed(files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), text, 'utf-8');
    }
  }

  function git(args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: project,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  function piece(answer: Answer, id: string): Piece | undefined {
    return (answer.pieces ?? []).find((candidate) => candidate.id === id);
  }

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `blueprint-storyline-languages-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`,
      );
    }
  });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'storyline-lang-e2e-'));
    project = join(sandbox, 'proj');
    mkdirSync(join(project, 'flow'), { recursive: true });
    mkdirSync(join(sandbox, 'vault'), { recursive: true });
    seed(FILES);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('reads a Python class file as a story: the class, its methods, self-calls, docstrings and the chip', () => {
    const answer = storyline('--file', CART);
    expect(answer.ok).toBe(true);
    expect(answer.scope).toBe('file');
    expect(answer.files).toEqual([CART]);
    expect(answer.language).toBe('python');

    expect((answer.pieces ?? []).map((p) => p.id)).toEqual([
      `${CART}#Cart`,
      `${CART}#Cart.__init__`,
      `${CART}#Cart.add`,
      `${CART}#Cart.total`,
      `${CART}#Cart._subtotal`,
      `${CART}#Cart._touch`,
      `${CART}#open_cart`,
    ]);
    expect(piece(answer, `${CART}#Cart`)).toMatchObject({ kind: 'class', startLine: 5, endLine: 25 });
    expect(piece(answer, `${CART}#Cart.__init__`)).toMatchObject({ kind: 'method', isConstructor: true, className: 'Cart' });
    const add = piece(answer, `${CART}#Cart.add`);
    expect(add).toMatchObject({ kind: 'method', className: 'Cart', startLine: 12, endLine: 15 });
    expect(add?.text).toContain('self._touch()');

    // The docstring is the doc line; a method without one has none.
    expect(piece(answer, `${CART}#Cart`)?.doc).toBe('A shopping cart that totals its items.');
    expect(add?.doc).toBe('Put one item in the cart.');
    expect(piece(answer, `${CART}#open_cart`)?.doc).toBe('Start a cart for one owner.');
    expect(piece(answer, `${CART}#Cart._subtotal`)?.doc).toBeNull();

    // self.<method>() is an arrow; a call into a relative import is a chip;
    // calling the class is its constructor; a call on a list is not drawn.
    expect(answer.calls).toContainEqual({ from: `${CART}#Cart.add`, line: 15, to: `${CART}#Cart._touch` });
    expect(answer.calls).toContainEqual({ from: `${CART}#Cart.total`, line: 19, to: `${CART}#Cart._subtotal` });
    expect(answer.calls).toContainEqual({
      from: `${CART}#Cart.total`,
      line: 19,
      to: null,
      external: { file: PRICING, name: 'apply_discount' },
    });
    expect(answer.calls).toContainEqual({ from: `${CART}#open_cart`, line: 30, to: `${CART}#Cart.__init__` });
    expect((answer.calls ?? []).some((call) => call.line === 14)).toBe(false);

    expect(answer.classes).toEqual([
      { name: 'Cart', file: CART, startLine: 5, constructorSignature: '__init__(self, owner: str)' },
    ]);
  });

  it('ranks the ways in by how many product files import them — relative and absolute — and not the test', () => {
    const answer = storyline('--file', CART);
    const used = Object.fromEntries((answer.entries ?? []).map((entry) => [entry.pieceId, entry.usedFrom]));
    // checkout (relative) + admin (absolute) import open_cart; test_cart does not count.
    expect(used[`${CART}#open_cart`]).toBe(2);
    // Only checkout imports Cart and reaches total through it.
    expect(used[`${CART}#Cart.total`]).toBe(1);
    expect(answer.entries?.[0]).toEqual({ pieceId: `${CART}#open_cart`, usedFrom: 2 });
  });

  it('reads a dataclass as a data structure with its docstring', () => {
    const answer = storyline('--file', MODELS);
    expect(answer.ok).toBe(true);
    expect(answer.language).toBe('python');
    expect(answer.pieces).toHaveLength(1);
    expect(answer.pieces?.[0]).toMatchObject({ id: `${MODELS}#Item`, kind: 'type', doc: 'One line of a cart.' });
  });

  it('reads a Go file: its struct, its method, functions, doc comments and the call between them', () => {
    const answer = storyline('--file', GREETER);
    expect(answer.ok).toBe(true);
    expect(answer.language).toBe('go');
    expect((answer.pieces ?? []).map((p) => [p.id, p.kind])).toEqual([
      [`${GREETER}#Greeter`, 'type'],
      [`${GREETER}#Greeter.Greet`, 'method'],
      [`${GREETER}#format`, 'function'],
      [`${GREETER}#main`, 'function'],
    ]);
    expect(piece(answer, `${GREETER}#Greeter`)?.doc).toBe('Greeter says hello.');
    expect(piece(answer, `${GREETER}#Greeter.Greet`)?.doc).toBe('Greet prints the greeting.');
    expect(answer.calls).toContainEqual({ from: `${GREETER}#Greeter.Greet`, line: 12, to: `${GREETER}#format` });
    // `g.Greet()` goes through a variable — dynamic dispatch is never guessed.
    expect((answer.calls ?? []).some((call) => call.from === `${GREETER}#main` && call.to !== null)).toBe(false);
  });

  it("reads a part mixing Python and TypeScript as one 'mixed' story, Python calls across its files as arrows", () => {
    mkdirSync(join(project, 'flow', 'brain', 'features'), { recursive: true });
    writeFileSync(
      join(project, 'flow', 'brain', 'features', 'shop.md'),
      [
        '---',
        'id: feature:shop',
        'name: Shop',
        'kind: core',
        'anchors: [module:shop]',
        'relates: []',
        '---',
        '',
        '# Shop',
        '',
        '## Parts',
        '',
        '### Totals',
        'How a cart reaches its total, from the web client to the discount.',
        `anchors: ${CART}, ${PRICING}, ${CLIENT}`,
        '',
      ].join('\n'),
      'utf-8',
    );

    const part = storyline('--part', 'feature:shop/totals');
    expect(part.ok).toBe(true);
    expect(part.scope).toBe('part');
    expect(part.language).toBe('mixed');
    expect(part.files).toEqual([CART, PRICING, CLIENT]);
    // Inside the part, the call into the sibling Python file is an arrow, not a chip.
    expect(part.calls).toContainEqual({ from: `${CART}#Cart.total`, line: 19, to: `${PRICING}#apply_discount` });
    expect((part.calls ?? []).some((call) => call.external !== undefined)).toBe(false);
    // Each file read by its own reader: the TypeScript piece is there with its JSDoc.
    expect(piece(part, `${CLIENT}#fetchTotal`)?.doc).toBe('Ask the shop for a total.');
    expect(piece(part, `${PRICING}#apply_discount`)?.doc).toBe('Take ten percent off.');
  });

  it('answers a language with no reader honestly, keeping the text, on exit 0', () => {
    const elixir = storyline('--file', 'lib/tool.ex');
    expect(elixir).toEqual({
      ok: false,
      reason: 'unsupported-language',
      sentence: "Flow can't read Elixir as a story yet.",
      text: FILES['lib/tool.ex'],
      file: 'lib/tool.ex',
    });

    // A part that is only that file — the board's door to it — answers the same.
    mkdirSync(join(project, 'flow', 'brain', 'features'), { recursive: true });
    writeFileSync(
      join(project, 'flow', 'brain', 'features', 'tooling.md'),
      ['---', 'id: feature:tooling', 'name: Tooling', 'kind: core', 'anchors: [file:lib/tool.ex]', 'relates: []', '---', '', '# Tooling', ''].join('\n'),
      'utf-8',
    );
    expect(storyline('--part', 'tooling')).toEqual(elixir);
  });

  it("compares a Python story's Today and After in a plan's context", () => {
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);
    const head = git(['rev-parse', 'HEAD']);

    seed({
      'flow/plans/plan_cart-tax_v1.md': [
        '# Plan: Cart tax',
        '',
        '## Phases',
        '',
        '### Phase 1: Tax',
        '',
        '**Scope**: Add tax to the cart.',
        '**Complexity**: 3/10',
        `**Files**: \`${CART}\``,
        '',
        '- [ ] Add `_tax` to the cart and use it in `total`',
        '',
      ].join('\n'),
      // After: total gains the tax, add stops touching, _touch becomes _tax.
      [CART]: CART_PY.replace(
        '        return apply_discount(self._subtotal())',
        '        return apply_discount(self._subtotal()) + self._tax()',
      )
        .replace('        self._touch()\n', '')
        .replace('    def _touch(self) -> None:\n        pass\n', '    def _tax(self) -> int:\n        return 1\n'),
    });

    // The dirty tree makes HEAD the starting point.
    const dirty = storyline('--file', CART, ['--plan', 'cart-tax']);
    expect(dirty.ok).toBe(true);
    expect(dirty.language).toBe('python');
    expect(dirty.compareNote).toBeUndefined();
    const compare = dirty.compare;
    expect(compare).toMatchObject({ plan: 'cart-tax', base: head, baseSource: 'head' });
    expect(compare?.pieces).toMatchObject({
      [`${CART}#Cart.total`]: 'changed',
      [`${CART}#Cart.add`]: 'changed',
      [`${CART}#Cart._tax`]: 'added',
      [`${CART}#Cart._touch`]: 'removed',
      [`${CART}#Cart._subtotal`]: 'same',
      [`${CART}#open_cart`]: 'same',
    });
    expect((compare?.removed ?? []).map((p) => p.id)).toEqual([`${CART}#Cart._touch`]);
    expect(compare?.removed[0]?.text).toContain('def _touch(self) -> None:');
    const totalLines = (compare?.hunks[`${CART}#Cart.total`] ?? []).flatMap((hunk) => hunk.lines);
    expect(totalLines).toContainEqual({ op: 'removed', text: '        return apply_discount(self._subtotal())' });
    expect(totalLines).toContainEqual({ op: 'added', text: '        return apply_discount(self._subtotal()) + self._tax()' });
    expect(compare?.summary).toMatchObject({ added: 1, removed: 1 });

    // Naming the starting point gives the same Today, labelled as given.
    const given = storyline('--file', CART, ['--plan', 'cart-tax', '--base', head]);
    expect(given.compare).toMatchObject({ base: head, baseSource: 'given' });
    expect(given.compare?.pieces).toEqual(compare?.pieces);
  });
});
