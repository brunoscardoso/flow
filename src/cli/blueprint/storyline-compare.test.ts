/**
 * Tests for the storyline's Today ⇄ After (`storyline-compare.ts`) through the
 * `blueprint storyline --plan` verb — prediction only on a clean tree, the real
 * diff after edits (added / changed with hunks / removed), the mixed case where
 * a prediction the code has not reached remains, the starting point's
 * precedence (given > recorded run > HEAD), a project with no git, function
 * and file planning, an unknown plan, the Today cache, and the diff's cap.
 * Seeded temp git repos; the real TypeScript compiler; the real git.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { classifyKnowledgePath } from '../handlers/knowledge-classes.js';
import {
  BASE_CACHE_DIRNAME,
  diffLines,
  MAX_DIFF_LINES_PER_PIECE,
  readPlanIntent,
  toHunks,
  parseCaller,
} from './storyline-compare.js';
import type { StorylineCompare, StorylineNotePrediction, StorylineResult } from './storyline-types.js';
import { runStorylineVerb, STORYLINE_CACHE_DIRNAME } from './storyline-verb.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const A_TODAY = [
  'export function alpha(): number {',
  '  return 1;',
  '}',
  '',
  'export function beta(value: number): number {',
  '  const doubled = value * 2;',
  '  return doubled + alpha();',
  '}',
  '',
  'export function keep(): string {',
  "  return 'kept';",
  '}',
  '',
].join('\n');

const PLAN = [
  '# Plan: Demo',
  '',
  '## Story',
  '',
  '### Step: A new function',
  '- kicker: The shape',
  '- anchors: symbol:src/a.ts#gamma',
  '- phases: 2',
  '',
  'Gamma joins the file.',
  '',
  '## Phases',
  '',
  '### Phase 1: Change the file',
  '',
  '**Scope**: change a.ts',
  '**Complexity**: 3/10',
  '**Dependencies**: None',
  '**Files**: `src/a.ts`, `src/fresh.ts`',
  '',
  '- [ ] Rework the module',
  '- [ ] Make `beta` triple its value',
  '',
  '### Phase 2: Add gamma',
  '',
  '**Complexity**: 2/10',
  '**Dependencies**: Phase 1',
  '',
  '- [ ] Add `gamma` to `src/a.ts`',
  '',
].join('\n');

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, 'utf-8');
}

/** A repo holding src/a.ts and the plan, committed once when `withGit`. */
function seed(withGit = true): string {
  const root = mkdtempSync(join(tmpdir(), 'storyline-compare-'));
  roots.push(root);
  write(root, 'src/a.ts', A_TODAY);
  write(root, 'flow/plans/plan_demo_v1.md', PLAN);
  if (withGit) {
    git(root, ['init', '-q', '-b', 'main']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'base']);
  }
  return root;
}

async function story(root: string, extra: { plan?: string; base?: string; file?: string } = {}): Promise<StorylineResult> {
  const output = await runStorylineVerb({ repoRoot: root, file: extra.file ?? 'src/a.ts', plan: extra.plan ?? 'demo', base: extra.base });
  expect(output.exitCode).toBe(0);
  const answer = JSON.parse(output.stdout) as StorylineResult | { ok: false; sentence: string };
  if (!answer.ok) throw new Error(`expected a story: ${answer.sentence}`);
  return answer;
}

function compareOf(result: StorylineResult): StorylineCompare {
  if (result.compare === undefined) throw new Error(`no compare: ${result.compareNote ?? ''}`);
  return result.compare;
}

/** The working tree's After: alpha removed, beta changed, delta added, keep untouched. */
function editAfter(root: string): void {
  write(
    root,
    'src/a.ts',
    [
      'export function beta(value: number): number {',
      '  const tripled = value * 3;',
      '  return tripled;',
      '}',
      '',
      'export function keep(): string {',
      "  return 'kept';",
      '}',
      '',
      'export function delta(): boolean {',
      '  return true;',
      '}',
      '',
    ].join('\n'),
  );
}

describe('prediction only — a clean tree', () => {
  it('names every piece of a listed file, a planned function and a planned file, with no facts', async () => {
    const root = seed();
    const compare = compareOf(await story(root));
    expect(compare.base).toBeNull();
    expect(compare.baseSource).toBeNull();
    expect(compare.pieces).toEqual({});
    expect(compare.removed).toEqual([]);

    const byId = new Map(compare.predicted.map((prediction) => [prediction.pieceId ?? `${prediction.kind}:${prediction.symbol ?? prediction.file}`, prediction]));
    expect(byId.get('src/a.ts#alpha')).toMatchObject({ kind: 'changes', phase: 1, task: 'Rework the module' });
    expect(byId.get('src/a.ts#beta')).toMatchObject({ kind: 'changes', phase: 1, task: 'Make `beta` triple its value' });
    expect(byId.get('src/a.ts#keep')).toMatchObject({ kind: 'changes', phase: 1 });
    expect(byId.get('planned:gamma')).toEqual({
      file: 'src/a.ts',
      symbol: 'gamma',
      phase: 2,
      task: 'Add `gamma` to `src/a.ts`',
      kind: 'planned',
    });
    expect(byId.get('planned-file:src/fresh.ts')).toMatchObject({ kind: 'planned-file', phase: 1, file: 'src/fresh.ts' });
    expect(compare.summary).toEqual({ changed: 0, added: 0, removed: 0, predicted: 3, planned: 2 });
  });
});

describe('the real diff', () => {
  it('marks added, changed (with hunks) and removed, and keeps an untouched prediction (mixed)', async () => {
    const root = seed();
    const head = git(root, ['rev-parse', 'HEAD']);
    editAfter(root);
    const compare = compareOf(await story(root));

    expect(compare.base).toBe(head);
    expect(compare.baseSource).toBe('head');
    expect(compare.pieces).toEqual({
      'src/a.ts#beta': 'changed',
      'src/a.ts#keep': 'same',
      'src/a.ts#delta': 'added',
      'src/a.ts#alpha': 'removed',
    });
    expect(compare.removed.map((piece) => piece.id)).toEqual(['src/a.ts#alpha']);
    expect(compare.removed[0]?.text).toContain('return 1;');

    const hunks = compare.hunks['src/a.ts#beta'] ?? [];
    expect(hunks).toHaveLength(1);
    const lines = hunks[0]?.lines ?? [];
    expect(lines.filter((line) => line.op === 'removed').map((line) => line.text)).toEqual([
      '  const doubled = value * 2;',
      '  return doubled + alpha();',
    ]);
    expect(lines.filter((line) => line.op === 'added').map((line) => line.text)).toEqual([
      '  const tripled = value * 3;',
      '  return tripled;',
    ]);
    // Today's beta started on line 5, After's on line 1; the hunk opens on its first context line.
    expect(hunks[0]).toMatchObject({ todayStart: 5, afterStart: 1 });
    expect(compare.hunks['src/a.ts#keep']).toBeUndefined();

    // FACT WINS: beta and delta are not predicted; keep (untouched) still is, gamma is still planned.
    const predictedIds = compare.predicted.map((prediction) => prediction.pieceId ?? prediction.symbol ?? prediction.file);
    expect(predictedIds).toEqual(['src/a.ts#keep', 'src/fresh.ts', 'gamma']);
    expect(compare.summary).toEqual({ changed: 1, added: 1, removed: 1, predicted: 1, planned: 2 });
  });

  it('a new story file reads as all added; a planned function that now exists is fact, not plan', async () => {
    const root = seed();
    write(root, 'src/fresh.ts', 'export function gammaHelper(): void {}\n');
    write(root, 'src/a.ts', `${A_TODAY}export function gamma(): void {}\n`);
    const fresh = compareOf(await story(root, { file: 'src/fresh.ts' }));
    expect(fresh.baseSource).toBe('head');
    expect(fresh.pieces).toEqual({ 'src/fresh.ts#gammaHelper': 'added' });
    expect(fresh.predicted).toEqual([]);

    const a = compareOf(await story(root));
    expect(a.pieces['src/a.ts#gamma']).toBe('added');
    expect(a.predicted.some((prediction) => prediction.symbol === 'gamma')).toBe(false);
  });
});

describe('the starting point', () => {
  function twoCommits(): { root: string; first: string; second: string } {
    const root = seed();
    const first = git(root, ['rev-parse', 'HEAD']);
    write(root, 'src/a.ts', `${A_TODAY}export function later(): void {}\n`);
    git(root, ['commit', '-q', '-am', 'later']);
    const second = git(root, ['rev-parse', 'HEAD']);
    return { root, first, second };
  }

  function recordRun(root: string, base: string): void {
    const lines = [
      { ts: '2026-10-07T10:00:00Z', run_id: 'other', type: 'run_intent', plan: 'other-plan', base: 'deadbeef' },
      { ts: '2026-10-07T10:01:00Z', run_id: 'demo-1', type: 'run_intent', plan: 'demo', base: 'not-a-commit' },
      { ts: '2026-10-07T10:02:00Z', run_id: 'demo-2', type: 'run_intent', plan: 'demo', base },
    ];
    write(root, 'flow/.rounds.jsonl', `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  }

  it('a given base wins over the recorded run, which wins over HEAD', async () => {
    const { root, first, second } = twoCommits();
    recordRun(root, first);
    editAfter(root);

    const given = compareOf(await story(root, { base: second }));
    expect(given).toMatchObject({ base: second, baseSource: 'given' });
    expect(given.pieces['src/a.ts#later']).toBe('removed');

    const run = compareOf(await story(root));
    expect(run).toMatchObject({ base: first, baseSource: 'run' });
    expect(run.pieces['src/a.ts#later']).toBeUndefined();

    write(root, 'flow/.rounds.jsonl', '');
    const head = compareOf(await story(root));
    expect(head).toMatchObject({ base: second, baseSource: 'head' });
  });

  it('a recorded run base is read even when the tree is clean; a base that is no commit is said, not guessed', async () => {
    const { root, first } = twoCommits();
    recordRun(root, first);
    const run = compareOf(await story(root));
    expect(run).toMatchObject({ base: first, baseSource: 'run' });
    expect(run.pieces['src/a.ts#later']).toBe('added');

    const unknown = compareOf(await story(root, { base: 'no-such-branch' }));
    expect(unknown.base).toBeNull();
    expect(unknown.baseSource).toBeNull();
    expect(unknown.baseNote).toContain('no-such-branch');
    expect(unknown.pieces).toEqual({});
    expect(unknown.predicted.length).toBeGreaterThan(0);
  });

  it('a project with no git answers the prediction only', async () => {
    const root = seed(false);
    editAfter(root);
    const compare = compareOf(await story(root));
    expect(compare.base).toBeNull();
    expect(compare.baseSource).toBeNull();
    expect(compare.pieces).toEqual({});
    expect(compare.summary.predicted).toBe(3);
  });

  it("caches Today's text by commit and path in a generated folder", async () => {
    const root = seed();
    editAfter(root);
    compareOf(await story(root));
    const folder = join(root, 'flow', 'brain', '.structure', STORYLINE_CACHE_DIRNAME, BASE_CACHE_DIRNAME);
    expect(existsSync(folder)).toBe(true);
    const entries = readdirSync(folder);
    expect(entries).toHaveLength(1);
    expect(classifyKnowledgePath(`brain/.structure/${STORYLINE_CACHE_DIRNAME}/${BASE_CACHE_DIRNAME}/${entries[0]}`)).toBe('generated');
    // A second read is served from the cache — same answer.
    expect(compareOf(await story(root)).pieces).toEqual(compareOf(await story(root)).pieces);
  });
});

describe('the plan', () => {
  it('an unknown plan answers the story with a note, never a refusal', async () => {
    const root = seed();
    const result = await story(root, { plan: 'nobody' });
    expect(result.compare).toBeUndefined();
    expect(result.compareNote).toContain('nobody');
    expect(result.pieces.length).toBe(3);
  });

  it('reads the newest active version and accepts the file name', async () => {
    const root = seed();
    write(root, 'flow/plans/plan_demo_v2.md', PLAN.replace('Rework the module', 'Rework it again'));
    const compare = compareOf(await story(root, { plan: 'plan_demo_v1.md' }));
    expect(compare.plan).toBe('demo');
    expect(compare.predicted.find((prediction) => prediction.pieceId === 'src/a.ts#alpha')?.task).toBe('Rework it again');
  });

  it('a story outside the plan gets no predictions; outside any plan the answer has no compare at all', async () => {
    const root = seed();
    write(root, 'lib/other.ts', 'export function other(): void {}\n');
    const other = compareOf(await story(root, { file: 'lib/other.ts' }));
    expect(other.predicted).toEqual([]);

    const plain = await runStorylineVerb({ repoRoot: root, file: 'src/a.ts' });
    const parsed = JSON.parse(plain.stdout) as StorylineResult;
    expect(parsed.compare).toBeUndefined();
    expect(parsed.compareNote).toBeUndefined();
  });

  it('reads files from prose when a phase declares none, and function anchors from proposals', async () => {
    const intent = readPlanIntent(
      'demo',
      ['### Phase 1: Prose only', '', '- [ ] Touch `src/x.ts` and `notes.ts` and `src/y.md`', ''].join('\n'),
      [
        {
          fingerprint: 'demo+feature:a/b',
          plan: 'demo',
          phase: 1,
          predictedNodeId: 'feature:a/b',
          kind: 'part',
          label: 'b',
          anchors: [{ kind: 'symbol', ref: 'src/x.ts#run' }],
          state: 'proposed',
          provenance: 'cli:propose',
          proposedAt: '2026-10-07T00:00:00Z',
        },
        {
          fingerprint: 'demo+feature:a/c',
          plan: 'demo',
          predictedNodeId: 'feature:a/c',
          kind: 'part',
          label: 'c',
          anchors: [{ kind: 'symbol', ref: 'src/x.ts#gone' }],
          state: 'rejected',
          provenance: 'cli:propose',
          proposedAt: '2026-10-07T00:00:00Z',
        },
      ],
    );
    expect(intent.phases[0]?.files).toEqual(['src/x.ts', 'src/y.md']);
    expect(intent.symbols).toEqual([{ file: 'src/x.ts', symbol: 'run', phases: [1] }]);
  });
});

describe('the line diff', () => {
  it('is minimal, and its hunks keep a little context', async () => {
    const ops = diffLines(['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['a', 'b', 'c', 'X', 'e', 'f', 'g']);
    expect(ops.filter((op) => op.op !== 'context').map((op) => `${op.op}:${op.text}`)).toEqual(['removed:d', 'added:X']);
    const { hunks, hidden } = toHunks(ops, 10, 20);
    expect(hidden).toBe(0);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.todayStart).toBe(11);
    expect(hunks[0]?.afterStart).toBe(21);
    expect(hunks[0]?.lines.map((line) => line.text)).toEqual(['b', 'c', 'd', 'X', 'e', 'f']);
  });

  it('caps a large change and counts what it left out', async () => {
    const today = Array.from({ length: MAX_DIFF_LINES_PER_PIECE }, (_, index) => `old ${index}`);
    const after = Array.from({ length: MAX_DIFF_LINES_PER_PIECE }, (_, index) => `new ${index}`);
    const { hunks, hidden } = toHunks(diffLines(today, after), 1, 1);
    const shown = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
    expect(shown).toBe(MAX_DIFF_LINES_PER_PIECE);
    expect(hidden).toBe(MAX_DIFF_LINES_PER_PIECE);
  });

  it('the verb reports the cap per piece', async () => {
    const root = seed();
    const body = (word: string): string =>
      Array.from({ length: MAX_DIFF_LINES_PER_PIECE }, (_, index) => `  const ${word}${index} = ${index};`).join('\n');
    write(root, 'src/a.ts', `export function big(): void {\n${body('old')}\n}\n`);
    git(root, ['commit', '-q', '-am', 'big']);
    write(root, 'src/a.ts', `export function big(): void {\n${body('fresh')}\n}\n`);
    const compare = compareOf(await story(root));
    expect(compare.pieces['src/a.ts#big']).toBe('changed');
    expect(compare.hiddenLines['src/a.ts#big']).toBeGreaterThan(0);
  });

  it('a story file deleted from the tree answers not-found, with or without a plan', async () => {
    const root = seed();
    unlinkSync(join(root, 'src/a.ts'));
    const output = await runStorylineVerb({ repoRoot: root, file: 'src/a.ts', plan: 'demo' });
    expect(JSON.parse(output.stdout)).toMatchObject({ ok: false, reason: 'not-found' });
  });
});

// ── Change notes (plan `plan_change_review` phase 3) ──────

const NOTES_PLAN = [
  '# Plan: Notes',
  '',
  '## Story',
  '',
  '### Step: Ignored once notes exist',
  '- kicker: The shape',
  '- anchors: symbol:src/a.ts#storyOnly',
  '',
  '## Phases',
  '',
  '### Phase 1: Change beta',
  '',
  '**Complexity**: 3/10',
  '**Dependencies**: None',
  '',
  '- [ ] Triple beta, see `src/other/prose.ts`',
  '',
  '#### Change notes',
  '',
  '- note: 1 · change · file:src/a.ts:beta',
  '    where: `const doubled = value * 2;`',
  '    what: triple the value',
  '    why: the spec says so — see `src/inside/note.ts`',
  '    verdict: done — tripled as written',
  '- note: 2 · change · file:src/a.ts:keep',
  "    where: `return 'gone';`",
  '    what: nothing',
  '    why: the quote is not there',
  '- note: 3 · new · file:src/a.ts:gamma',
  '    signature: gamma(): number',
  '    purpose: a third helper',
  '    callers: useAlpha, nobodyCallsThis',
  '- note: 4 · file · file:src/routes.ts',
  '    what: register the route',
  '    why: the app calls it',
  '    status: accepted',
  '- note: 5 · change · file:src/a.ts:vanished',
  '    where: `x`',
  '    what: change it',
  '    why: because',
  '',
].join('\n');

const C_TODAY = ["import { alpha } from './a.js';", '', 'export function useAlpha(): number {', '  return alpha();', '}', ''].join('\n');
const ROUTES_TODAY = ['export function register(): string {', "  return '/route';", '}', ''].join('\n');

function seedNotes(): string {
  const root = mkdtempSync(join(tmpdir(), 'storyline-notes-'));
  roots.push(root);
  write(root, 'src/a.ts', A_TODAY);
  write(root, 'src/c.ts', C_TODAY);
  write(root, 'src/routes.ts', ROUTES_TODAY);
  write(root, 'flow/plans/plan_notes_v1.md', NOTES_PLAN);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function notePrediction(compare: StorylineCompare, n: number): StorylineNotePrediction {
  const found = compare.predicted.find((prediction) => 'note' in prediction && prediction.note.n === n);
  if (found === undefined || !('note' in found)) throw new Error(`no prediction for note ${n}`);
  return found;
}

describe('change notes', () => {
  it('a plan with notes predicts from its notes only, and the story draws every note file and caller', async () => {
    const root = seedNotes();
    const result = await story(root, { plan: 'notes' });
    const compare = compareOf(result);
    expect(compare.base).toBeNull();
    expect(compare.predicted.map((prediction) => prediction.kind)).toEqual([
      'note-change',
      'note-change',
      'note-new',
      'note-file',
      'note-change',
    ]);
    // No phase-file sweep, no Story symbol anchors.
    expect(compare.predicted.some((prediction) => prediction.kind === 'changes' || prediction.kind === 'planned')).toBe(false);

    expect(notePrediction(compare, 1)).toEqual({
      kind: 'note-change',
      file: 'src/a.ts',
      pieceId: 'src/a.ts#beta',
      symbol: 'beta',
      quoteLines: { startLine: 6, endLine: 6 },
      note: {
        n: 1,
        phase: 1,
        kind: 'change',
        target: 'file:src/a.ts:beta',
        file: 'src/a.ts',
        symbol: 'beta',
        where: 'const doubled = value * 2;',
        what: 'triple the value',
        why: 'the spec says so — see `src/inside/note.ts`',
        status: 'proposed',
        comments: [],
        verdict: 'done',
        verdictWhy: 'tripled as written',
      },
    });
    expect(notePrediction(compare, 2)).toMatchObject({ pieceId: 'src/a.ts#keep', quoteMissing: true });
    expect(notePrediction(compare, 2)).not.toHaveProperty('quoteLines');
    expect(notePrediction(compare, 3)).toMatchObject({
      kind: 'note-new',
      file: 'src/a.ts',
      symbol: 'gamma',
      signature: 'gamma(): number',
      purpose: 'a third helper',
      callers: ['useAlpha', 'nobodyCallsThis'],
      callerPieces: { useAlpha: 'src/c.ts#useAlpha' },
    });
    expect(notePrediction(compare, 3)).not.toHaveProperty('pieceId');
    expect(notePrediction(compare, 4)).toMatchObject({ kind: 'note-file', file: 'src/routes.ts', note: { status: 'accepted' } });
    expect(notePrediction(compare, 5)).toMatchObject({ kind: 'note-change', symbol: 'vanished', pieceMissing: true, quoteMissing: true });
    expect(compare.summary).toMatchObject({ predicted: 3, planned: 2 });

    // The note files and the caller's file joined the story, in this project's band.
    expect(result.files).toEqual(['src/a.ts', 'src/routes.ts', 'src/c.ts']);
    expect(result.pieces.map((piece) => piece.id)).toEqual(
      expect.arrayContaining(['src/routes.ts#register', 'src/c.ts#useAlpha']),
    );
    // A call into another story file is an arrow, not an outward chip.
    expect(result.calls.find((call) => call.from === 'src/c.ts#useAlpha')?.to).toBe('src/a.ts#alpha');
    expect(result.bands).toEqual([{ project: null, files: ['src/a.ts', 'src/routes.ts', 'src/c.ts'] }]);
  });

  it('a backticked path inside a note block is not a file the phase lists', () => {
    const intent = readPlanIntent('notes', NOTES_PLAN, []);
    expect(intent.phases[0]?.files).toEqual(['src/other/prose.ts']);
    expect(intent.notes.map((note) => note.n)).toEqual([1, 2, 3, 4, 5]);
  });

  it('after a real diff every note is kept and carries the fact beside its verdict', async () => {
    const root = seedNotes();
    write(
      root,
      'src/a.ts',
      A_TODAY.replace('const doubled = value * 2;', 'const doubled = value * 3;') + 'export function gamma(): number {\n  return 3;\n}\n',
    );
    const compare = compareOf(await story(root, { plan: 'notes' }));
    expect(compare.baseSource).toBe('head');
    expect(compare.pieces['src/a.ts#beta']).toBe('changed');
    expect(compare.predicted).toHaveLength(5);

    // FACT DOES NOT DROP A NOTE: beta changed, and its note is still here.
    expect(notePrediction(compare, 1)).toMatchObject({ pieceId: 'src/a.ts#beta', fact: 'changed', quoteMissing: true, note: { verdict: 'done' } });
    expect(compare.hunks['src/a.ts#beta']).toBeDefined();
    expect(notePrediction(compare, 2)).toMatchObject({ fact: 'unchanged' });
    expect(notePrediction(compare, 3)).toMatchObject({ pieceId: 'src/a.ts#gamma', fact: 'added' });
    expect(notePrediction(compare, 4)).toMatchObject({ fact: 'unchanged' });
    expect(notePrediction(compare, 5)).not.toHaveProperty('fact');
  });

  it('a removed function reads as removed on its note', async () => {
    const root = seedNotes();
    write(root, 'src/a.ts', A_TODAY.replace(/export function keep[\s\S]*$/, ''));
    const compare = compareOf(await story(root, { plan: 'notes' }));
    expect(notePrediction(compare, 2)).toMatchObject({ pieceMissing: true, fact: 'removed' });
  });

  it('an old plan with Story symbols predicts exactly as before and has no bands', async () => {
    const root = seed();
    const result = await story(root);
    expect(result.bands).toBeUndefined();
    expect(compareOf(result).predicted.map((prediction) => prediction.kind)).toEqual(['changes', 'changes', 'changes', 'planned-file', 'planned']);
    expect(readPlanIntent('demo', PLAN, []).notes).toEqual([]);
  });
});

describe('change notes in sibling projects', () => {
  const previousHome = process.env.PLAN_FLOW_HOME;
  afterEach(() => {
    process.env.PLAN_FLOW_HOME = previousHome;
  });

  const SIBLING_PLAN = [
    '# Plan: Across',
    '',
    '### Phase 1: Wire it',
    '',
    '**Complexity**: 3/10',
    '**Dependencies**: None',
    '',
    '- [ ] Wire the route',
    '',
    '#### Change notes',
    '',
    '- note: 1 · change · api/file:src/routes.ts:register',
    "    where: `return '/route';`",
    '    what: a new path',
    '    why: the web app calls it',
    '- note: 2 · file · mobile/file:src/app.ts',
    '    what: call it',
    '    why: parity',
    '- note: 3 · change · web/file:src/a.ts:beta',
    '    where: `return doubled + alpha();`',
    '    what: own project by slug',
    '    why: a prefix naming this project is this project',
    '',
  ].join('\n');

  /** A Workspace `team` of web (this repo), api (checked out) and mobile (no checkout). */
  function seedWorkspace(): { web: string; api: string; home: string } {
    const home = mkdtempSync(join(tmpdir(), 'storyline-flow-home-'));
    roots.push(home);
    const web = mkdtempSync(join(tmpdir(), 'storyline-web-'));
    const api = mkdtempSync(join(tmpdir(), 'storyline-api-'));
    roots.push(web, api);
    write(web, 'src/a.ts', A_TODAY);
    write(web, 'flow/plans/plan_across_v1.md', SIBLING_PLAN);
    write(api, 'src/routes.ts', ROUTES_TODAY);
    for (const repoRoot of [web, api]) {
      git(repoRoot, ['init', '-q', '-b', 'main']);
      git(repoRoot, ['add', '-A']);
      git(repoRoot, ['commit', '-q', '-m', 'base']);
    }
    const project = (slug: string, name: string): Record<string, unknown> => ({ id: `local:${slug}`, name, slug, remotes: [] });
    write(
      home,
      'workspaces/team/workspace.json',
      JSON.stringify({ name: 'Team', slug: 'team', projects: [project('web', 'Web'), project('api', 'Api'), project('mobile', 'Mobile')] }),
    );
    write(home, 'projects.local.json', JSON.stringify({ projects: { 'local:web': web, 'local:api': api } }));
    return { web, api, home };
  }

  it("reads a sibling's note in its checkout, says when there is none, and bands the story by project", async () => {
    const { web, api, home } = seedWorkspace();
    process.env.PLAN_FLOW_HOME = home;
    // A change in the sibling's working tree is not this project's diff.
    write(api, 'src/routes.ts', ROUTES_TODAY.replace("'/route'", "'/route'; // touched"));
    write(web, 'src/a.ts', `${A_TODAY}// touched\n`);
    const result = await story(web, { plan: 'across' });
    const compare = compareOf(result);
    // There IS a starting point here, so a missing fact on the sibling note means something.
    expect(compare.baseSource).toBe('head');
    expect(compare.pieces['src/a.ts#beta']).toBe('same');

    expect(notePrediction(compare, 1)).toMatchObject({
      kind: 'note-change',
      project: 'api',
      file: 'api/src/routes.ts',
      pieceId: 'api/src/routes.ts#register',
      symbol: 'register',
      quoteLines: { startLine: 2, endLine: 2 },
    });
    expect(notePrediction(compare, 1)).not.toHaveProperty('fact');
    expect(notePrediction(compare, 1)).not.toHaveProperty('codeUnavailable');
    expect(notePrediction(compare, 2)).toMatchObject({ kind: 'note-file', project: 'mobile', file: 'mobile/src/app.ts', codeUnavailable: true });
    expect(notePrediction(compare, 3)).toMatchObject({ project: 'web', file: 'src/a.ts', pieceId: 'src/a.ts#beta', quoteLines: { startLine: 7, endLine: 7 } });
    expect(compare.pieces['api/src/routes.ts#register']).toBeUndefined();

    expect(result.files).toEqual(['src/a.ts', 'api/src/routes.ts']);
    expect(result.bands).toEqual([
      { project: null, colorIndex: 0, files: ['src/a.ts'] },
      { project: 'api', colorIndex: 1, files: ['api/src/routes.ts'] },
      { project: 'mobile', colorIndex: 2, files: [] },
    ]);
  });

  it('outside a Workspace a sibling note comes back without code', async () => {
    const { web } = seedWorkspace();
    const compare = compareOf(await story(web, { plan: 'across' }));
    expect(notePrediction(compare, 1)).toMatchObject({ project: 'api', file: 'api/src/routes.ts', codeUnavailable: true });
    expect(notePrediction(compare, 1)).not.toHaveProperty('pieceId');
  });
});

describe('parseCaller', () => {
  it('reads a path-qualified caller with #private segments, as a note symbol may be written', () => {
    expect(parseCaller('src/store.ts:Store.#write')).toEqual({ file: 'src/store.ts', symbol: 'Store.#write' });
    expect(parseCaller('file:src/store.ts:#flush')).toEqual({ file: 'src/store.ts', symbol: '#flush' });
    expect(parseCaller('src/a.ts:run')).toEqual({ file: 'src/a.ts', symbol: 'run' });
    expect(parseCaller('Store.#write')).toEqual({ symbol: 'Store.#write' });
  });
});
