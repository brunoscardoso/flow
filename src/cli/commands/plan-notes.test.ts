/**
 * `plan notes` (the reader) and `plan note` (the one writer) — plan change
 * review, Phase 2.
 *
 * In-process for the report and the edit's validation; through the REAL CLI
 * entry (tsx, as `plan.test.ts` does) for the family contract: the JSON
 * payload on stdout, then one `plan refused: <reason> — …` line, exit 1 — and,
 * for every refusal, the plan file byte-identical afterwards (allowed-pattern
 * #24: a refusal test asserts the absence of the side effect too).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const { applyPlanNote, MAX_PLAN_NOTE_ATTEMPTS, notesFailingCheck, planNoteEdit, PlanNotesRefusal, readPlanNotes } = await import('./plan.js');
const { parseChangeNotes, setNoteVerdict } = await import('../state/change-notes.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const E2E_TIMEOUT_MS = 120_000;

const SOURCE = `export function run(flag: boolean): number {
  if (flag) {
    return compute(1);
  }
  return compute(2);
}

export class Store {
  save(value: string): void {
    this.write(value);
  }

  private write(value: string): void {
    console.log(value);
  }
}

function compute(n: number): number {
  return n * 2;
}
`;

const PLAN = `# Plan: Demo

## Phases

### Phase 1: Wire
**Complexity**: 4/10

- [ ] Wire it

#### Change notes

- note: 1 · change · file:src/a.ts:run
    where: \`if (flag) {\`
    what: invert the flag
    why: the caller passes the opposite
- note: 2 · change · file:src/a.ts:Store.save
    where: \`this.write(value);\`
    what: write through the lock
    why: two writers raced
    status: accepted
- note: 3 · new · file:src/a.ts:helper
    signature: helper(): void
    purpose: shared rule
    callers: run
    status: rejected — inline it
- note: 4 · file · web/file:src/b.ts
    what: an import
    why: the helper
`;

/** A plan whose notes all pass `--check`. */
const GOOD_PLAN = PLAN;

/** Note 5's quote is in the function twice; note 6's function does not exist; note 7 is unreadable. */
const BAD_PLAN = `${PLAN}- note: 5 · change · file:src/a.ts:run
    where: \`return compute(\`
    what: x
    why: y
- note: 6 · change · file:src/a.ts:missing
    where: \`x\`
    what: x
    why: y
- note: 7 · tweak · file:src/a.ts:run
`;

interface CliRun {
  stdout: string;
  combined: string;
  status: number | null;
}

function runCli(args: string[], cwd: string): CliRun {
  const result = spawnSync('node', [TSX_BIN, CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: E2E_TIMEOUT_MS,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const stdout = result.stdout ?? '';
  return { stdout, combined: `${stdout}\n${result.stderr ?? ''}`, status: result.status };
}

/** The last JSON object line on stdout (the refusal prose may follow it). */
function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim().startsWith('{'));
  return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
}

let repo: string;
let planPath: string;

function makeRepo(planText: string): void {
  repo = mkdtempSync(join(tmpdir(), 'plan-flow-plan-notes-'));
  mkdirSync(join(repo, 'flow', 'plans'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), SOURCE);
  planPath = join(repo, 'flow', 'plans', 'plan_demo_v1.md');
  writeFileSync(planPath, planText);
}

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('readPlanNotes — the reader', () => {
  it('reports every note, its counts, and each change quote inside its own function', async () => {
    makeRepo(GOOD_PLAN);
    const result = await readPlanNotes('demo', { target: repo });
    expect(result.plan).toBe('demo');
    expect(result.path).toBe(join('flow', 'plans', 'plan_demo_v1.md'));
    expect(result.counts).toEqual({ total: 4, accepted: 1, rejected: 1, unreviewed: 2 });
    expect(result.unreadable).toEqual([]);
    const [one, two, three, four] = result.notes;
    expect(one).toMatchObject({
      n: 1,
      phase: 1,
      kind: 'change',
      target: 'file:src/a.ts:run',
      file: 'src/a.ts',
      symbol: 'run',
      where: 'if (flag) {',
      status: 'proposed',
      comments: [],
      quote: { found: 'once', startLine: 2, endLine: 2 },
    });
    expect(two).toMatchObject({ symbol: 'Store.save', status: 'accepted', quote: { found: 'once', startLine: 10, endLine: 10 } });
    expect(three).toMatchObject({ kind: 'new', signature: 'helper(): void', callers: ['run'], status: 'rejected', reason: 'inline it' });
    expect(three?.quote).toBeUndefined();
    // A sibling project's note is reported; its code is the storyline's to read.
    expect(four).toMatchObject({ kind: 'file', project: 'web', file: 'src/b.ts' });
    expect(four?.quote).toBeUndefined();
    expect(notesFailingCheck(result)).toEqual([]);
  });

  it('says which quotes cannot be placed, and why', async () => {
    makeRepo(BAD_PLAN);
    const result = await readPlanNotes('plan_demo_v1.md', { target: repo });
    expect(result.notes.find((note) => note.n === 5)?.quote).toEqual({ found: 'many', count: 2 });
    expect(result.notes.find((note) => note.n === 6)).toMatchObject({ quote: { found: 'none' }, symbolMissing: true });
    expect(notesFailingCheck(result).map((entry) => entry.n)).toEqual([5, 6, 7]);
  });

  it('refuses a plan with more notes than the main changes need', () => {
    const note = (n: number) => ({ n, phase: 1, kind: 'file' as const, target: 'file:src/a.ts', file: 'src/a.ts', status: 'proposed' as const, comments: [] })
    const within = { plan: 'demo', path: 'p', notes: Array.from({ length: 10 }, (_, i) => note(i + 1)), counts: { total: 10, accepted: 0, rejected: 0, unreviewed: 10 }, unreadable: [] }
    // Positive first: ten notes pass…
    expect(notesFailingCheck(within as never)).toEqual([])
    // …the eleventh is refused, with the reason in words.
    const over = { ...within, notes: [...within.notes, note(11)] }
    const failing = notesFailingCheck(over as never)
    expect(failing).toHaveLength(1)
    expect(failing[0]?.reason).toContain('keep only the main changes')
  });

  it("resolves a file note's quote in the whole file, and --check refuses one it cannot place", async () => {
    makeRepo(
      `${PLAN}- note: 8 · file · file:src/a.ts
    where: \`function compute(n: number)\`
    what: export it
    why: shared
- note: 9 · file · file:src/a.ts
    where: \`not in the file\`
    what: x
    why: y
- note: 10 · file · file:src/a.ts
    what: no quote
    why: the file as a whole
`,
    );
    const result = await readPlanNotes('demo', { target: repo });
    expect(result.unreadable).toEqual([]);
    expect(result.notes.find((note) => note.n === 8)).toMatchObject({ kind: 'file', quote: { found: 'once', startLine: 18, endLine: 18 } });
    expect(result.notes.find((note) => note.n === 9)?.quote).toEqual({ found: 'none' });
    expect(result.notes.find((note) => note.n === 10)?.quote).toBeUndefined();
    expect(notesFailingCheck(result).map((entry) => entry.n)).toEqual([9]);
  });

  it('a missing file is none with fileMissing', async () => {
    makeRepo(PLAN.replace('file:src/a.ts:run', 'file:src/gone.ts:run'));
    const result = await readPlanNotes('demo', { target: repo });
    expect(result.notes[0]).toMatchObject({ quote: { found: 'none' }, fileMissing: true });
  });

  it('an unknown plan refuses with its own reason', async () => {
    makeRepo(PLAN);
    await expect(readPlanNotes('nope', { target: repo })).rejects.toMatchObject({ reason: 'unknown-plan' });
  });
});

describe('readPlanNotes — notes with a Workspace project prefix', () => {
  const previousHome = process.env.PLAN_FLOW_HOME;
  const extra: string[] = [];
  afterEach(() => {
    process.env.PLAN_FLOW_HOME = previousHome;
    for (const dir of extra.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** Workspace `team`: argo (this repo), web (checked out here), gone (not on this computer). */
  function seedWorkspace(planText: string): void {
    makeRepo(planText);
    const home = mkdtempSync(join(tmpdir(), 'plan-notes-home-'));
    const web = mkdtempSync(join(tmpdir(), 'plan-notes-web-'));
    extra.push(home, web);
    mkdirSync(join(web, 'src'), { recursive: true });
    writeFileSync(join(web, 'src', 'b.ts'), 'export function send(): number {\n  return 1;\n}\n');
    const project = (slug: string): Record<string, unknown> => ({ id: `local:${slug}`, name: slug, slug, remotes: [] });
    mkdirSync(join(home, 'workspaces', 'team'), { recursive: true });
    writeFileSync(
      join(home, 'workspaces', 'team', 'workspace.json'),
      JSON.stringify({ name: 'Team', slug: 'team', projects: [project('argo'), project('web'), project('gone')] }),
    );
    writeFileSync(join(home, 'projects.local.json'), JSON.stringify({ projects: { 'local:argo': repo, 'local:web': web } }));
    process.env.PLAN_FLOW_HOME = home;
  }

  const PREFIXED = `# Plan: Demo

### Phase 1: Wire

- [ ] Wire it

#### Change notes

- note: 1 · change · argo/file:src/a.ts:run
    where: \`not in run at all\`
    what: x
    why: y
- note: 2 · change · web/file:src/b.ts:send
    where: \`return 1;\`
    what: x
    why: y
- note: 3 · change · web/file:src/b.ts:send
    where: \`return 2;\`
    what: x
    why: y
- note: 4 · change · gone/file:src/c.ts:far
    where: \`anything\`
    what: x
    why: y
`;

  it("checks a note under this project's own slug here, a sibling's in its checkout, and says which it could not check", async () => {
    seedWorkspace(PREFIXED);
    const result = await readPlanNotes('demo', { target: repo });
    const byN = (n: number) => result.notes.find((note) => note.n === n);
    // This project's own slug is local — its quote is checked here, and it is not here.
    expect(byN(1)?.quote).toEqual({ found: 'none' });
    // A sibling's quote is looked for in the sibling's checkout.
    expect(byN(2)?.quote).toMatchObject({ found: 'once' });
    expect(byN(3)?.quote).toEqual({ found: 'none' });
    // No checkout on this computer: reported unchecked, never vouched for.
    expect(byN(4)?.quote).toBeUndefined();
    expect(byN(4)?.quoteUnchecked).toBe(true);
    expect(notesFailingCheck(result).map((entry) => entry.n)).toEqual([1, 3]);
  });
});

describe('planNoteEdit — validation before any write', () => {
  const refusalOf = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (error) {
      return error instanceof PlanNotesRefusal ? error.reason : `not a refusal: ${String(error)}`;
    }
  };

  it.each([
    [{ note: '1', status: 'accepted', verdict: 'done', why: 'x' }, 'status-and-verdict'],
    [{ note: '1' }, 'nothing-to-set'],
    [{ note: 'one', status: 'accepted' }, 'bad-value'],
    [{ note: '99', status: 'accepted' }, 'unknown-note'],
    [{ note: '1', status: 'maybe' }, 'bad-value'],
    [{ note: '1', verdict: 'kinda', why: 'x' }, 'bad-value'],
    [{ note: '1', verdict: 'done' }, 'missing-why'],
    [{ note: '1', verdict: 'done', why: '   ' }, 'missing-why'],
  ])('%j refuses %s', (request, reason) => {
    makeRepo(PLAN);
    expect(refusalOf(() => planNoteEdit({ target: repo, ...request }, 'demo'))).toBe(reason);
  });

  it('an unreadable note refuses with the reason it cannot be read', () => {
    makeRepo(BAD_PLAN);
    expect(refusalOf(() => planNoteEdit({ target: repo, note: '7', status: 'accepted' }, 'demo'))).toBe('unreadable-note');
  });
});

describe('applyPlanNote — two writers at once', () => {
  it('re-applies its edit to a plan another writer changed between its read and its write: both decisions land', () => {
    makeRepo(PLAN);
    let interleaved = 0;
    const result = applyPlanNote('demo', { target: repo, note: '1', status: 'accepted' }, {
      beforeCommit: (attempt) => {
        if (attempt !== 1) return;
        // Another `plan note` lands its verdict on note 2 after this one read the plan.
        interleaved += 1;
        writeFileSync(planPath, setNoteVerdict(readFileSync(planPath, 'utf-8'), 2, 'done', 'the lock is in'));
      },
    });
    expect(interleaved).toBe(1);
    expect(result).toMatchObject({ changed: true, note: { n: 1, status: 'accepted' } });
    const notes = parseChangeNotes(readFileSync(planPath, 'utf-8')).notes;
    expect(notes.find((note) => note.n === 1)?.status).toBe('accepted');
    expect(notes.find((note) => note.n === 2)).toMatchObject({ verdict: 'done', verdictWhy: 'the lock is in' });
    expect(readdirSync(join(repo, 'flow', 'plans'))).toEqual(['plan_demo_v1.md']);
  });

  it('refuses plan-changed when the plan never settles — and leaves it as the other writer left it', () => {
    makeRepo(PLAN);
    let calls = 0;
    let last = '';
    let caught: unknown = null;
    try {
      applyPlanNote('demo', { target: repo, note: '1', status: 'accepted' }, {
        beforeCommit: () => {
          calls += 1;
          last = `${readFileSync(planPath, 'utf-8')}\n`;
          writeFileSync(planPath, last);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(calls).toBe(MAX_PLAN_NOTE_ATTEMPTS);
    expect(caught).toBeInstanceOf(PlanNotesRefusal);
    expect(caught).toMatchObject({ reason: 'plan-changed', payload: { plan: 'demo', note: '1', attempts: MAX_PLAN_NOTE_ATTEMPTS } });
    expect(readFileSync(planPath, 'utf-8')).toBe(last);
    expect(parseChangeNotes(last).notes.find((note) => note.n === 1)?.status).toBe('proposed');
    expect(readdirSync(join(repo, 'flow', 'plans'))).toEqual(['plan_demo_v1.md']);
  });
});

describe('plan notes / plan note — the real CLI', () => {
  it(
    'notes --json prints the report; --check passes a good plan',
    () => {
      makeRepo(GOOD_PLAN);
      const plain = runCli(['plan', 'notes', 'demo', '--json', '--target', repo], repo);
      expect(plain.status).toBe(0);
      expect(lastJson(plain.stdout)).toMatchObject({ plan: 'demo', counts: { total: 4 } });
      const checked = runCli(['plan', 'notes', 'demo', '--check', '--json', '--target', repo], repo);
      expect(checked.status).toBe(0);
      expect(checked.combined).not.toContain('plan refused:');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'notes --check refuses ambiguous, missing and unreadable notes: payload, then the line — and writes nothing',
    () => {
      makeRepo(BAD_PLAN);
      const before = readFileSync(planPath);
      const listing = readdirSync(join(repo, 'flow', 'plans')).sort();
      const run = runCli(['plan', 'notes', 'demo', '--check', '--json', '--target', repo], repo);
      expect(run.status).toBe(1);
      expect(run.combined).toMatch(/plan refused: notes — 3 note\(s\) need fixing/);
      const payload = lastJson(run.stdout);
      expect(payload.refused).toBe('notes');
      expect((payload.failing as Array<{ n: number }>).map((entry) => entry.n)).toEqual([5, 6, 7]);
      expect(readFileSync(planPath).equals(before)).toBe(true);
      expect(readdirSync(join(repo, 'flow', 'plans')).sort()).toEqual(listing);
      // Without --check the same plan is reported, never refused.
      expect(runCli(['plan', 'notes', 'demo', '--json', '--target', repo], repo).status).toBe(0);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'note --status rewrites that one line; --verdict inserts its line; the rest of the file is unchanged',
    () => {
      makeRepo(PLAN);
      const before = readFileSync(planPath, 'utf-8').split('\n');
      const rejected = runCli(['plan', 'note', 'demo', '--note', '2', '--status', 'rejected', '--reason', 'not now', '--json', '--target', repo], repo);
      expect(rejected.status).toBe(0);
      expect(lastJson(rejected.stdout)).toMatchObject({ changed: true, note: { n: 2, status: 'rejected', reason: 'not now' } });
      const after = readFileSync(planPath, 'utf-8').split('\n');
      const changed = after.flatMap((line, index) => (line === before[index] ? [] : [index]));
      expect(after).toHaveLength(before.length);
      expect(changed.map((index) => after[index])).toEqual(['    status: rejected — not now']);

      const verdict = runCli(['plan', 'note', 'demo', '--note', '1', '--verdict', 'done', '--why', 'the flag is inverted', '--json', '--target', repo], repo);
      expect(verdict.status).toBe(0);
      expect(lastJson(verdict.stdout)).toMatchObject({ note: { n: 1, verdict: 'done', verdictWhy: 'the flag is inverted' } });
      const final = readFileSync(planPath, 'utf-8').split('\n');
      expect(final).toHaveLength(after.length + 1);
      // Note 1 ends on line 15 (its `why:`); the verdict lands right after it.
      expect(final[15]).toBe('    verdict: done — the flag is inverted');
      expect([...final.slice(0, 15), ...final.slice(16)]).toEqual(after);
      expect(readdirSync(join(repo, 'flow', 'plans'))).toEqual(['plan_demo_v1.md']);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'note refuses an unknown note and a verdict without why: payload, the line, exit 1 — the file byte-identical',
    () => {
      makeRepo(PLAN);
      const before = readFileSync(planPath);

      const unknown = runCli(['plan', 'note', 'demo', '--note', '42', '--status', 'accepted', '--target', repo], repo);
      expect(unknown.status).toBe(1);
      expect(unknown.combined).toContain('plan refused: unknown-note — this plan has no note 42');
      expect(lastJson(unknown.stdout)).toMatchObject({ refused: 'unknown-note', note: 42, notes: [1, 2, 3, 4] });
      expect(readFileSync(planPath).equals(before)).toBe(true);

      const noWhy = runCli(['plan', 'note', 'demo', '--note', '1', '--verdict', 'done', '--target', repo], repo);
      expect(noWhy.status).toBe(1);
      expect(noWhy.combined).toContain('plan refused: missing-why');
      expect(readFileSync(planPath).equals(before)).toBe(true);

      const noPlan = runCli(['plan', 'note', 'ghost', '--note', '1', '--status', 'accepted', '--target', repo], repo);
      expect(noPlan.status).toBe(1);
      expect(noPlan.combined).toContain('plan refused: unknown-plan');
      expect(readFileSync(planPath).equals(before)).toBe(true);
      expect(readdirSync(join(repo, 'flow', 'plans'))).toEqual(['plan_demo_v1.md']);
    },
    E2E_TIMEOUT_MS,
  );
});
