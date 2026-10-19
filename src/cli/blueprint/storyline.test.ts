/**
 * Tests for the code storyline extractor — pieces, calls, type uses, classes
 * and entries read from one file with the real TypeScript compiler (syntax
 * only), plus the two refusals and the compiler loader's fallbacks.
 */

import { loadTypeScript, type TsModule } from './storyline-compiler.js';
import { extractStoryline } from './storyline.js';
import type { StorylineAnswer, StorylineResult } from './storyline-types.js';

const loaded = loadTypeScript();
if (loaded === null) throw new Error('the typescript devDependency must load for these tests');
const ts: TsModule = loaded;

function read(file: string, text: string, existing: string[] = []): StorylineAnswer {
  const files = new Set(existing);
  return extractStoryline({ ts, file, text, fileExists: (relPath) => files.has(relPath) });
}

function readOk(file: string, text: string, existing: string[] = []): StorylineResult {
  const answer = read(file, text, existing);
  if (!answer.ok) throw new Error(`expected a storyline, got ${answer.reason}: ${answer.sentence}`);
  return answer;
}

function lines(...rows: string[]): string {
  return rows.join('\n');
}

// ── (a) a class shaped like the learn orchestrator ─────────

const ORCHESTRATOR_FILE = 'app/src/main/project/learn-orchestrator.ts';
const ORCHESTRATOR = lines(
  /* 1 */ "import { recordLearnEvent } from './learn-log.js'",
  /* 2 */ "import { join } from 'node:path'",
  /* 3 */ '',
  /* 4 */ 'export interface LearnJob {',
  /* 5 */ '  rootPath: string',
  /* 6 */ '}',
  /* 7 */ '',
  /* 8 */ '/** Pick the next job off the queue. Returns null when empty. */',
  /* 9 */ 'export function takeNext(queue: LearnJob[]): LearnJob | null {',
  /* 10 */ '  return queue[0] ?? null',
  /* 11 */ '}',
  /* 12 */ '',
  /* 13 */ 'interface Deps {',
  /* 14 */ '  notify: (message: string) => void',
  /* 15 */ '}',
  /* 16 */ '',
  /* 17 */ '/** The one orchestrator every learn trigger funnels through. */',
  /* 18 */ 'export class LearnOrchestrator {',
  /* 19 */ '  private readonly queue: LearnJob[] = []',
  /* 20 */ '  private draining = false',
  /* 21 */ '',
  /* 22 */ '  constructor(private readonly deps: Deps) {}',
  /* 23 */ '',
  /* 24 */ '  /**',
  /* 25 */ '   * Enqueue one module. Deliberate items ignore the budget.',
  /* 26 */ '   * @param job the job',
  /* 27 */ '   */',
  /* 28 */ '  enqueueModule(job: LearnJob): void {',
  /* 29 */ '    if (!this.admit(job)) return',
  /* 30 */ '    this.drain()',
  /* 31 */ '  }',
  /* 32 */ '',
  /* 33 */ '  private admit(job: LearnJob): boolean {',
  /* 34 */ '    this.queue.push(job)',
  /* 35 */ '    return true',
  /* 36 */ '  }',
  /* 37 */ '',
  /* 38 */ '  // Drain the queue one job at a time.',
  /* 39 */ '  private drain(): void {',
  /* 40 */ '    if (this.draining) return',
  /* 41 */ '    this.draining = true',
  /* 42 */ '    void this.loop()',
  /* 43 */ '      .catch((error) => this.deps.notify(String(error)))',
  /* 44 */ '      .finally(() => {',
  /* 45 */ '        this.draining = false',
  /* 46 */ '        this.reportIdle()',
  /* 47 */ '      })',
  /* 48 */ '  }',
  /* 49 */ '',
  /* 50 */ '  private async loop(): Promise<void> {',
  /* 51 */ '    const job = takeNext(this.queue)',
  /* 52 */ '    if (job === null) return',
  /* 53 */ "    recordLearnEvent(join(job.rootPath, 'x'))",
  /* 54 */ '    this.deps.notify(job.rootPath)',
  /* 55 */ '  }',
  /* 56 */ '}',
);

describe('extractStoryline — a class', () => {
  const result = readOk(ORCHESTRATOR_FILE, ORCHESTRATOR, ['app/src/main/project/learn-log.ts']);
  const id = (name: string): string => `${ORCHESTRATOR_FILE}#${name}`;
  const piece = (pieceId: string) => result.pieces.find((candidate) => candidate.id === pieceId);

  it('reads every declaration as a piece, in file order', () => {
    expect(result.pieces.map((candidate) => [candidate.id.split('#')[1], candidate.kind])).toEqual([
      ['LearnJob', 'interface'],
      ['takeNext', 'function'],
      ['Deps', 'interface'],
      ['LearnOrchestrator', 'class'],
      ['LearnOrchestrator.constructor', 'method'],
      ['LearnOrchestrator.enqueueModule', 'method'],
      ['LearnOrchestrator.admit', 'method'],
      ['LearnOrchestrator.drain', 'method'],
      ['LearnOrchestrator.loop', 'method'],
    ]);
    expect(result.scope).toBe('file');
    expect(result.files).toEqual([ORCHESTRATOR_FILE]);
    expect(result.language).toBe('typescript');
  });

  it('places each piece on its exact lines, without its doc comment', () => {
    expect(piece(id('takeNext'))).toMatchObject({ startLine: 9, endLine: 11, exported: true });
    expect(piece(id('LearnOrchestrator'))).toMatchObject({ startLine: 18, endLine: 56, exported: true });
    expect(piece(id('LearnOrchestrator.enqueueModule'))).toMatchObject({
      startLine: 28,
      endLine: 31,
      className: 'LearnOrchestrator',
      exported: true,
    });
    expect(piece(id('LearnOrchestrator.drain'))).toMatchObject({ startLine: 39, endLine: 48 });
    expect(piece(id('LearnOrchestrator.constructor'))).toMatchObject({ startLine: 22, isConstructor: true });
    expect(piece(id('Deps'))?.exported).toBe(false);
    expect(piece(id('takeNext'))?.text).toBe(ORCHESTRATOR.split('\n').slice(8, 11).join('\n'));
  });

  it('keeps the first sentence of a doc comment, JSDoc or line comments', () => {
    expect(piece(id('takeNext'))?.doc).toBe('Pick the next job off the queue.');
    expect(piece(id('LearnOrchestrator.enqueueModule'))?.doc).toBe('Enqueue one module.');
    expect(piece(id('LearnOrchestrator.drain'))?.doc).toBe('Drain the queue one job at a time.');
    expect(piece(id('LearnOrchestrator.admit'))?.doc).toBeNull();
  });

  it('follows this-calls, nested callbacks, module functions and relative imports', () => {
    const callsOf = (from: string) =>
      result.calls.filter((call) => call.from === id(from)).map(({ from: _from, ...rest }) => rest);
    expect(callsOf('LearnOrchestrator.enqueueModule')).toEqual([
      { line: 29, to: id('LearnOrchestrator.admit') },
      { line: 30, to: id('LearnOrchestrator.drain') },
    ]);
    expect(callsOf('LearnOrchestrator.drain')).toEqual([
      { line: 42, to: id('LearnOrchestrator.loop') },
      { line: 46, to: null, unresolvedName: 'this.reportIdle' },
    ]);
    expect(callsOf('LearnOrchestrator.loop')).toEqual([
      { line: 51, to: id('takeNext') },
      { line: 53, to: null, external: { file: 'app/src/main/project/learn-log.ts', name: 'recordLearnEvent' } },
    ]);
  });

  it('draws the class frame with its constructor signature', () => {
    expect(result.classes).toEqual([
      {
        name: 'LearnOrchestrator',
        file: ORCHESTRATOR_FILE,
        startLine: 18,
        constructorSignature: 'constructor(private readonly deps: Deps)',
      },
    ]);
  });

  it('links pieces to the data structures they name', () => {
    expect(result.typeUses).toEqual(
      expect.arrayContaining([
        { from: id('takeNext'), to: id('LearnJob') },
        { from: id('LearnOrchestrator'), to: id('LearnJob') },
        { from: id('LearnOrchestrator.constructor'), to: id('Deps') },
        { from: id('LearnOrchestrator.enqueueModule'), to: id('LearnJob') },
      ]),
    );
  });

  it('offers exported functions, classes and public methods as entries', () => {
    expect(result.entries).toEqual([
      { pieceId: id('takeNext'), usedFrom: 0 },
      { pieceId: id('LearnOrchestrator'), usedFrom: 0 },
      { pieceId: id('LearnOrchestrator.enqueueModule'), usedFrom: 0 },
    ]);
  });
});

// ── (b) module functions, (d) recursion ────────────────────

describe('extractStoryline — module functions', () => {
  const FILE = 'src/math.ts';
  const SOURCE = lines(
    /* 1 */ 'const double = (n: number): number => n * 2',
    /* 2 */ '',
    /* 3 */ 'function factorial(n: number): number {',
    /* 4 */ '  return n <= 1 ? 1 : n * factorial(n - 1)',
    /* 5 */ '}',
    /* 6 */ '',
    /* 7 */ 'export function compute(n: number): number {',
    /* 8 */ '  const values = [n].map((value) => double(value))',
    /* 9 */ '  setTimeout(() => undefined, 0)',
    /* 10 */ '  helperFromNowhere()',
    /* 11 */ '  return factorial(values[0] ?? 0)',
    /* 12 */ '}',
    /* 13 */ '',
    /* 14 */ 'export { double }',
  );
  const result = readOk(FILE, SOURCE);

  it('reads an arrow-function const as a function and honours export lists', () => {
    expect(result.pieces.find((piece) => piece.name === 'double')).toMatchObject({
      kind: 'function',
      startLine: 1,
      endLine: 1,
      exported: true,
    });
    expect(result.pieces.find((piece) => piece.name === 'factorial')?.exported).toBe(false);
  });

  it('records a self-call once and terminates', () => {
    expect(result.calls.filter((call) => call.from === `${FILE}#factorial`)).toEqual([
      { from: `${FILE}#factorial`, line: 4, to: `${FILE}#factorial` },
    ]);
  });

  it('keeps calls in callbacks, skips built-ins and method calls, keeps unknown names as text', () => {
    expect(result.calls.filter((call) => call.from === `${FILE}#compute`)).toEqual([
      { from: `${FILE}#compute`, line: 8, to: `${FILE}#double` },
      { from: `${FILE}#compute`, line: 10, to: null, unresolvedName: 'helperFromNowhere' },
      { from: `${FILE}#compute`, line: 11, to: `${FILE}#factorial` },
    ]);
  });
});

// ── (c) imports ────────────────────────────────────────────

describe('extractStoryline — imports', () => {
  const FILE = 'src/learn/run.ts';
  const SOURCE = lines(
    "import { recordLearnEvent as record } from './learn-log.js'",
    "import * as state from '../state/index.js'",
    "import chalk from 'chalk'",
    "import { readFile } from 'node:fs/promises'",
    "import { missing } from './gone.js'",
    '',
    'export async function run(): Promise<void> {',
    "  record('start')",
    '  state.load()',
    "  chalk.red('x')",
    "  await readFile('x')",
    '  missing()',
    '}',
  );
  const result = readOk(FILE, SOURCE, ['src/learn/learn-log.ts', 'src/state/index.ts']);

  it('resolves relative imports to project files and drops package calls', () => {
    expect(result.calls).toEqual([
      { from: `${FILE}#run`, line: 8, to: null, external: { file: 'src/learn/learn-log.ts', name: 'recordLearnEvent' } },
      { from: `${FILE}#run`, line: 9, to: null, external: { file: 'src/state/index.ts', name: 'load' } },
      { from: `${FILE}#run`, line: 12, to: null, unresolvedName: 'missing' },
    ]);
  });

  it('resolves an extensionless specifier and a directory index', () => {
    const answer = readOk(
      'src/a.ts',
      lines("import { b } from './b'", "import { c } from './c'", 'export function a() {', '  b()', '  c()', '}'),
      ['src/b.tsx', 'src/c/index.js'],
    );
    expect(answer.calls.map((call) => call.external?.file)).toEqual(['src/b.tsx', 'src/c/index.js']);
  });
});

// ── (e) data structures ────────────────────────────────────

describe('extractStoryline — data structures', () => {
  const FILE = 'src/orders.ts';
  const SOURCE = lines(
    'export enum Status { Open, Closed }',
    'export interface OrderItem { sku: string; status: Status }',
    'export interface Order extends Base { items: OrderItem[]; next?: Order }',
    'interface Base { id: string }',
    'export type Orders = ReadonlyArray<Order>',
    'export function total(orders: Orders): number {',
    '  return (orders as Order[]).length',
    '}',
  );
  const result = readOk(FILE, SOURCE);
  const id = (name: string): string => `${FILE}#${name}`;

  it('links structures to each other and to the functions that use them, without self-edges', () => {
    expect(result.typeUses).toEqual([
      { from: id('OrderItem'), to: id('Status') },
      { from: id('Order'), to: id('Base') },
      { from: id('Order'), to: id('OrderItem') },
      { from: id('Orders'), to: id('Order') },
      { from: id('total'), to: id('Orders') },
      { from: id('total'), to: id('Order') },
    ]);
    expect(result.pieces.map((piece) => piece.kind)).toEqual(['enum', 'interface', 'interface', 'interface', 'type', 'function']);
  });
});

// ── (f, g) refusals ────────────────────────────────────────

describe('extractStoryline — refusals', () => {
  it('refuses a file that does not parse, naming the line and keeping the text', () => {
    const text = lines('export function ok() {}', 'const broken = ;', '');
    const answer = read('src/broken.ts', text);
    expect(answer).toMatchObject({ ok: false, reason: 'syntax-error', text, file: 'src/broken.ts' });
    if (!answer.ok) expect(answer.sentence).toBe("This file can't be read as a story yet: line 2 doesn't parse (Expression expected).");
  });

  it('refuses a language it cannot read, in plain words', () => {
    const answer = read('tools/run.ex', 'def run, do: 1\n');
    expect(answer).toMatchObject({ ok: false, reason: 'unsupported-language', text: 'def run, do: 1\n' });
    if (!answer.ok) expect(answer.sentence).toBe("Flow can't read Elixir as a story yet.");
    const unknown = read('tools/run.xyz', 'x');
    if (!unknown.ok) expect(unknown.sentence).toBe("Flow can't read this kind of file as a story yet.");
  });

  it('reads JavaScript as javascript', () => {
    expect(readOk('src/x.mjs', 'export function x() {}').language).toBe('javascript');
  });
});

// ── (h) the loader ─────────────────────────────────────────

describe('loadTypeScript', () => {
  it('answers null and never throws when every rung fails', () => {
    const requireFn = (): unknown => {
      throw new Error('not here');
    };
    expect(loadTypeScript({ env: { FLOW_TYPESCRIPT_PATH: '/nowhere/typescript.js' }, requireFn })).toBeNull();
  });

  it('prefers the configured compiler and rejects something that is not one', () => {
    const asked: string[] = [];
    const requireFn = (moduleId: string): unknown => {
      asked.push(moduleId);
      return moduleId === '/app/typescript.js' ? ts : { notACompiler: true };
    };
    expect(loadTypeScript({ env: { FLOW_TYPESCRIPT_PATH: '/app/typescript.js' }, requireFn })).toBe(ts);
    expect(loadTypeScript({ env: {}, requireFn })).toBeNull();
    expect(asked).toEqual(['/app/typescript.js', 'typescript']);
  });
});
