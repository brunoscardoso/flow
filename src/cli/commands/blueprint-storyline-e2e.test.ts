/**
 * Live E2E for the code storyline — exercises the REAL built CLI
 * (`dist/cli/index.js blueprint storyline`) as a subprocess against a seeded
 * temp project (forbidden-pattern #7: never trust in-process seams for the
 * shipped path). The verb's unit suite (`blueprint/storyline-verb.test.ts`)
 * covers every branch in-process; this file proves the shipped command prints
 * the same answers, with the same exit codes, through the real argv parser.
 *
 * The fixture is shaped like the learn orchestrator the app reads: a class
 * whose private method calls `recordLearnEvent` in a sibling file (the chip),
 * two product files importing it (the ranking — and a test file that must not
 * count), a `.py` file, and a `.ts` file that does not parse.
 *
 * Assertions run against stdout+stderr COMBINED (allowed-pattern #15). Every
 * subprocess runs with an explicit `cwd` inside the sandbox and an explicit
 * `--target` — cwd never drifts into this repo. No test here runs `init`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

const E2E_TIMEOUT_MS = 120_000;

const ORCHESTRATOR = 'src/learn/orchestrator.ts';
const LOG = 'src/learn/learn-log.ts';

const FILES: Record<string, string> = {
  [ORCHESTRATOR]: [
    "import { recordLearnEvent } from './learn-log.js'",
    '',
    '/** What the orchestrator is built with. */',
    'export interface OrchestratorDeps {',
    '  budget: number',
    '}',
    '',
    '/** Runs learn passes one at a time. */',
    'export class LearnOrchestrator {',
    '  constructor(private readonly deps: OrchestratorDeps) {}',
    '',
    '  /** Queue one module. */',
    '  enqueue(path: string): void {',
    '    this.drain(path)',
    '  }',
    '',
    '  private drain(path: string): void {',
    '    recordLearnEvent({ path, budget: this.deps.budget })',
    '  }',
    '}',
    '',
    '/** Start a pass. */',
    'export function startPass(deps: OrchestratorDeps): LearnOrchestrator {',
    '  return new LearnOrchestrator(deps)',
    '}',
    '',
  ].join('\n'),
  [LOG]: [
    '/** One line of the activity log. */',
    'export interface LearnEvent {',
    '  path: string',
    '  budget: number',
    '}',
    '',
    '/** Record what the queue did. */',
    'export function recordLearnEvent(entry: LearnEvent): void {',
    '  void entry',
    '}',
    '',
  ].join('\n'),
  // Two product importers: startPass is used from both, enqueue from one.
  'src/app/main.ts': [
    "import { startPass } from '../learn/orchestrator.js'",
    '',
    'export function boot(): void {',
    '  startPass({ budget: 1 })',
    '}',
    '',
  ].join('\n'),
  'src/app/panel.ts': [
    "import { LearnOrchestrator, startPass } from '../learn/orchestrator.js'",
    '',
    'export function press(orchestrator: LearnOrchestrator): void {',
    "  orchestrator.enqueue('src')",
    '  startPass({ budget: 2 })',
    '}',
    '',
  ].join('\n'),
  // A suite imports everything it tests — it must not move the ranking.
  'src/learn/orchestrator.test.ts': [
    "import { LearnOrchestrator, startPass } from './orchestrator.js'",
    "startPass({ budget: 3 }).enqueue('x')",
    'void LearnOrchestrator',
    '',
  ].join('\n'),
  'src/tool.ex': 'defmodule Tool do\n  def hello, do: 1\nend\n',
  'src/broken.ts': 'export function broken( {\n  return 1\n',
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
  file: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface Answer {
  ok: boolean;
  scope?: string;
  files?: string[];
  language?: string;
  pieces?: Piece[];
  calls?: Array<{ from: string; line: number; to: string | null; external?: { file: string; name: string } }>;
  typeUses?: Array<{ from: string; to: string }>;
  entries?: Array<{ pieceId: string; usedFrom: number }>;
  classes?: Array<{ name: string; file: string; startLine: number; constructorSignature?: string }>;
  reason?: string;
  sentence?: string;
  text?: string;
  file?: string;
}

describe('blueprint storyline E2E — real built CLI against a seeded project', () => {
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

  function storyline(flag: '--file' | '--part', value: string): Answer {
    const run = runCli(['blueprint', 'storyline', '--target', project, flag, value, '--json']);
    expect(run.status).toBe(0);
    const lines = run.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0] ?? '') as Answer;
  }

  function cacheFiles(): string[] {
    const dir = join(project, 'flow', 'brain', '.structure', 'storyline');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name !== 'imports.json')
      .sort();
  }

  function seed(files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), text, 'utf-8');
    }
  }

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`blueprint-storyline-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`);
    }
  });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'storyline-e2e-'));
    project = join(sandbox, 'proj');
    mkdirSync(join(project, 'flow'), { recursive: true });
    mkdirSync(join(sandbox, 'vault'), { recursive: true });
    seed(FILES);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('reads a class file as a story: pieces, calls, type uses, entries and the class', () => {
    const answer = storyline('--file', ORCHESTRATOR);
    expect(answer.ok).toBe(true);
    expect(answer.scope).toBe('file');
    expect(answer.files).toEqual([ORCHESTRATOR]);
    expect(answer.language).toBe('typescript');

    expect((answer.pieces ?? []).map((piece) => piece.id)).toEqual([
      `${ORCHESTRATOR}#OrchestratorDeps`,
      `${ORCHESTRATOR}#LearnOrchestrator`,
      `${ORCHESTRATOR}#LearnOrchestrator.constructor`,
      `${ORCHESTRATOR}#LearnOrchestrator.enqueue`,
      `${ORCHESTRATOR}#LearnOrchestrator.drain`,
      `${ORCHESTRATOR}#startPass`,
    ]);
    const enqueue = (answer.pieces ?? []).find((piece) => piece.name === 'enqueue');
    expect(enqueue?.kind).toBe('method');
    expect(enqueue?.startLine).toBe(13);
    expect(enqueue?.text).toContain('this.drain(path)');

    // A call inside the file is an arrow; a call into the sibling is a chip.
    expect(answer.calls).toContainEqual({
      from: `${ORCHESTRATOR}#LearnOrchestrator.enqueue`,
      line: 14,
      to: `${ORCHESTRATOR}#LearnOrchestrator.drain`,
    });
    expect(answer.calls).toContainEqual({
      from: `${ORCHESTRATOR}#LearnOrchestrator.drain`,
      line: 18,
      to: null,
      external: { file: LOG, name: 'recordLearnEvent' },
    });

    expect(answer.typeUses).toContainEqual({ from: `${ORCHESTRATOR}#startPass`, to: `${ORCHESTRATOR}#OrchestratorDeps` });
    expect(answer.classes).toEqual([
      {
        name: 'LearnOrchestrator',
        file: ORCHESTRATOR,
        startLine: 9,
        constructorSignature: 'constructor(private readonly deps: OrchestratorDeps)',
      },
    ]);
  });

  it('ranks the ways in by how many product files import them — the test file does not count', () => {
    const answer = storyline('--file', ORCHESTRATOR);
    expect(answer.entries).toEqual([
      { pieceId: `${ORCHESTRATOR}#startPass`, usedFrom: 2 },
      { pieceId: `${ORCHESTRATOR}#LearnOrchestrator.enqueue`, usedFrom: 1 },
    ]);
  });

  it('caches the extraction by content: a second run reuses it, an edit adds a new key', () => {
    expect(cacheFiles()).toEqual([]);
    const first = storyline('--file', ORCHESTRATOR);
    const afterFirst = cacheFiles();
    expect(afterFirst).toHaveLength(1);
    expect(existsSync(join(project, 'flow', 'brain', '.structure', 'storyline', 'imports.json'))).toBe(true);

    const second = storyline('--file', ORCHESTRATOR);
    expect(cacheFiles()).toEqual(afterFirst);
    expect(second).toEqual(first);

    // The same path with new content is a new key — the old answer is never served.
    writeFileSync(
      join(project, ORCHESTRATOR),
      `${FILES[ORCHESTRATOR]}\n/** Stop a pass. */\nexport function stopPass(): void {}\n`,
      'utf-8',
    );
    const edited = storyline('--file', ORCHESTRATOR);
    expect(cacheFiles()).toHaveLength(2);
    expect((edited.pieces ?? []).some((piece) => piece.name === 'stopPass')).toBe(true);
  });

  it('reads a repo with no flow/ folder and writes nothing into it', () => {
    rmSync(join(project, 'flow'), { recursive: true, force: true });
    const answer = storyline('--file', ORCHESTRATOR);
    expect(answer.ok).toBe(true);
    expect(existsSync(join(project, 'flow'))).toBe(false);
  });

  it("reads a part's files as one story through a feature note's file anchors", () => {
    mkdirSync(join(project, 'flow', 'brain', 'features'), { recursive: true });
    writeFileSync(
      join(project, 'flow', 'brain', 'features', 'learning.md'),
      [
        '---',
        'id: feature:learning',
        'name: Learning',
        'kind: core',
        'anchors: [module:src/learn]',
        'relates: []',
        '---',
        '',
        '# Learning',
        '',
        '## Parts',
        '',
        '### Learn queue',
        'The serial queue that runs learn passes.',
        `anchors: ${ORCHESTRATOR}, ${LOG}`,
        '',
      ].join('\n'),
      'utf-8',
    );

    const part = storyline('--part', 'feature:learning/learn-queue');
    expect(part.ok).toBe(true);
    expect(part.scope).toBe('part');
    expect(part.files).toEqual([ORCHESTRATOR, LOG]);
    // Inside a part, the call into the sibling is an arrow, not a chip.
    expect(part.calls).toContainEqual({
      from: `${ORCHESTRATOR}#LearnOrchestrator.drain`,
      line: 18,
      to: `${LOG}#recordLearnEvent`,
    });
    expect((part.calls ?? []).some((call) => call.external !== undefined)).toBe(false);

    // The whole feature: its module anchor expands to the walked files, tests left out.
    const feature = storyline('--part', 'learning');
    expect(feature.ok).toBe(true);
    expect(feature.files).toEqual([LOG, ORCHESTRATOR]);
  });

  it('answers a file in a language with no reader, a file that does not parse, and a missing file as JSON on exit 0', () => {
    const elixir = storyline('--file', 'src/tool.ex');
    expect(elixir).toEqual({
      ok: false,
      reason: 'unsupported-language',
      sentence: "Flow can't read Elixir as a story yet.",
      text: FILES['src/tool.ex'],
      file: 'src/tool.ex',
    });

    const broken = storyline('--file', 'src/broken.ts');
    expect(broken.ok).toBe(false);
    expect(broken.reason).toBe('syntax-error');
    expect(broken.sentence).toMatch(/^This file can't be read as a story yet: line \d+ doesn't parse/);
    expect(broken.text).toBe(FILES['src/broken.ts']);

    const missing = storyline('--file', 'src/nope.ts');
    expect(missing).toEqual({
      ok: false,
      reason: 'not-found',
      sentence: "Flow couldn't find nope.ts in this project.",
      file: 'src/nope.ts',
    });
  });

  it('refuses both flags at once with exit 1 and the refusal line', () => {
    const run = runCli(['blueprint', 'storyline', '--target', project, '--file', ORCHESTRATOR, '--part', 'learning', '--json']);
    expect(run.status).toBe(1);
    expect(run.transcript).toContain(
      'storyline refused: arguments — pass exactly one of --file <path> or --part <feature-ref>',
    );
    expect(run.transcript).not.toContain('"ok"');
  });

  it('refuses a path that leaves the project with exit 1, reading nothing outside it', () => {
    writeFileSync(join(sandbox, 'outside.ts'), 'export function secret(): number { return 42 }\n', 'utf-8');
    const run = runCli(['blueprint', 'storyline', '--target', project, '--file', '../outside.ts', '--json']);
    expect(run.status).toBe(1);
    expect(run.transcript).toContain("storyline refused: outside-project — '../outside.ts' is not inside the project");
    expect(run.transcript).not.toContain('secret');
    expect(cacheFiles()).toEqual([]);
  });
});
