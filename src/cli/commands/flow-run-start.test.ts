/**
 * `planflow-ai flow run-start` — the one writer of a run's starting commit.
 *
 * In-process against a REAL temp git repository: the sha in the record must be
 * the one git reports, and `blueprint storyline` must read it back as the base.
 * Refusals are asserted on the COMBINED transcript (allowed-pattern #15) and
 * with the record checked byte-for-byte afterwards (allowed-pattern #24).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { runFlow } = await import('./flow.js');
const { resolveStoryBase } = await import('../blueprint/storyline-compare.js');

type FlowOptions = Parameters<typeof runFlow>[2];

interface Invocation {
  transcript: string;
  refusals: string[];
  exitCode: number;
  json: Record<string, unknown> | null;
}

type StdoutLike = { write: (chunk: unknown) => boolean };

let project: string;

function invoke(args: string[], options: Partial<FlowOptions> = {}): Invocation {
  const chunks: string[] = [];
  const logged: string[] = [];
  const stdout = process.stdout as unknown as StdoutLike;
  const realWrite = stdout.write;
  const realLog = console.log;
  stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  console.log = (...parts: unknown[]): void => {
    logged.push(parts.map(String).join(' '));
  };
  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    runFlow('run-start', args, { target: project, json: true, ...options } as FlowOptions);
  } finally {
    stdout.write = realWrite;
    console.log = realLog;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = previousExit;
  const text = chunks.join('');
  let json: Record<string, unknown> | null = null;
  for (const line of text.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      json = JSON.parse(line) as Record<string, unknown>;
      break;
    } catch {
      // not the payload line — keep scanning
    }
  }
  return {
    transcript: [text, ...logged].join('\n'),
    refusals: logged.filter((line) => line.includes('flow refused:')),
    exitCode,
    json,
  };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: project, encoding: 'utf-8' }).trim();
}

function initRepo(): void {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  writeFileSync(join(project, 'a.ts'), 'export const a = 1\n');
  git('add', 'a.ts');
  git('commit', '-q', '-m', 'first');
}

function seedPlan(slug = 'story-today-after'): void {
  mkdirSync(join(project, 'flow', 'plans'), { recursive: true });
  writeFileSync(join(project, 'flow', 'plans', `plan_${slug}_v1.md`), '# Plan\n');
}

const roundsPath = (): string => join(project, 'flow', '.rounds.jsonl');
const rounds = (): string => (existsSync(roundsPath()) ? readFileSync(roundsPath(), 'utf-8') : '');

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'plan-flow-run-start-'));
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe('flow run-start', () => {
  it('appends one run_intent carrying HEAD as base, which storyline reads back', () => {
    initRepo();
    seedPlan();
    const head = git('rev-parse', 'HEAD');

    const result = invoke([], { plan: 'plan_story-today-after_v1.md', run: 'story-20261007-1' });

    expect(result.exitCode).toBe(0);
    const lines = rounds().trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({
      run_id: 'story-20261007-1',
      type: 'run_intent',
      phase: null,
      plan: 'story-today-after',
      base: head,
    });
    expect(entry['planHash']).toBeUndefined();
    expect(typeof entry['ts']).toBe('string');
    expect(result.json?.['runStart']).toEqual(entry);

    // The reader it exists for: a later commit does not move Today.
    writeFileSync(join(project, 'a.ts'), 'export const a = 2\n');
    git('commit', '-qam', 'second');
    const base = resolveStoryBase({
      repoRoot: project,
      flowDir: join(project, 'flow'),
      plan: 'story-today-after',
      files: ['a.ts'],
    });
    expect(base).toEqual({ base: head, source: 'run' });
  });

  it("copies the compiled run script's planHash when there is one", () => {
    initRepo();
    seedPlan();
    writeFileSync(
      join(project, 'flow', 'plans', 'story-today-after.run.json'),
      JSON.stringify({ version: 1, plan: 'story-today-after', planHash: 'abc123', phases: [] }),
    );

    const result = invoke([], { plan: 'story-today-after', run: 'r1' });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(rounds().trim())).toMatchObject({ planHash: 'abc123', plan: 'story-today-after' });
  });

  it.each([
    ['--plan is missing', { run: 'r1' }, 'run-start needs --plan <name>'],
    ['--run is missing', { plan: 'story-today-after' }, 'run-start needs --run <run-id>'],
    ['the plan is unknown', { plan: 'nope', run: 'r1' }, "no active plan named 'nope'"],
  ])('refuses when %s, and writes nothing', (_label, options, reason) => {
    initRepo();
    seedPlan();

    const result = invoke([], options);

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain(`flow refused: ${reason}`);
    expect(result.refusals).toHaveLength(1);
    expect(existsSync(roundsPath())).toBe(false);
  });

  it('refuses outside a git repository, and leaves an existing record byte-identical', () => {
    seedPlan();
    const before = '{"type":"phase_result","run_id":"old"}\n';
    writeFileSync(roundsPath(), before);

    const result = invoke([], { plan: 'story-today-after', run: 'r1' });

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('is not a git repository with a commit');
    expect(rounds()).toBe(before);
  });

  it('refuses a repository with no commit yet', () => {
    git('init', '-q');
    seedPlan();

    const result = invoke([], { plan: 'story-today-after', run: 'r1' });

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused:');
    expect(existsSync(roundsPath())).toBe(false);
  });

  it('refuses a positional argument', () => {
    initRepo();
    seedPlan();

    const result = invoke(['story-today-after'], { run: 'r1' });

    expect(result.exitCode).toBe(1);
    expect(result.transcript).toContain('flow refused: run-start takes no arguments');
    expect(existsSync(roundsPath())).toBe(false);
  });
});
