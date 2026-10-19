/**
 * Plan change review — end to end through the REAL CLI entry, on a temp git
 * repository (plan `plan_change_review`, Phase 8).
 *
 * The person's path, in order: a plan's notes pass `plan notes --check`; an
 * ambiguous or missing quote is refused (transcript on stdout+stderr combined,
 * AND the plan file byte-identical — allowed-patterns #15 and #24); `plan note`
 * accepts, rejects with a reason and records a verdict, each rewrite touching
 * only that note's lines; and `blueprint storyline --plan` draws the notes on
 * the story — the change note's quoted lines, the new note's callers' pieces.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const E2E_TIMEOUT_MS = 120_000;

const CART = `import { formatPrice } from './money.js';

export function checkout(total: number, coupon: string | null): string {
  if (coupon !== null) {
    total = total * 0.9;
  }
  return formatPrice(total);
}

export function refund(total: number): string {
  return formatPrice(-total);
}
`;

const MONEY = `export function formatPrice(total: number): string {
  return '$' + total.toFixed(2);
}
`;

const NOTES = `- note: 1 · change · file:src/cart.ts:checkout
    where: \`total = total * 0.9;\`
    what: read the discount from the coupon
    why: coupons carry their own rate
- note: 2 · new · file:src/cart.ts:discountOf
    signature: discountOf(coupon: string): number
    purpose: the rate a coupon gives
    callers: checkout
- note: 3 · file · file:src/money.ts
    what: export a rounding helper
    why: refunds and checkouts round alike
`;

const planWith = (notes: string): string => `# Plan: Coupons

## Phases

### Phase 1: Coupon rates
**Complexity**: 4/10

- [ ] Read the rate from the coupon

#### Change notes

${notes}
### Phase 2: Tests (Final)
**Complexity**: 2/10

- [ ] Test it
`;

/** `total` is in checkout's lines more than once — ambiguous, never the first of two. */
const AMBIGUOUS_NOTE = `- note: 4 · change · file:src/cart.ts:checkout
    where: \`total\`
    what: x
    why: y
`;

/** refund returns `formatPrice(-total)` — this quote is not in it. */
const MISSING_NOTE = `- note: 4 · change · file:src/cart.ts:refund
    where: \`return formatPrice(total);\`
    what: x
    why: y
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

/** The last JSON object line on stdout (refusal prose may follow it). */
function lastJson(stdout: string): Record<string, unknown> {
  const lines = stdout.split('\n').filter((line) => line.trim().startsWith('{'));
  return JSON.parse(lines[lines.length - 1] ?? '{}') as Record<string, unknown>;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

let repo: string;

function planPathOf(slug: string): string {
  return join(repo, 'flow', 'plans', `plan_${slug}_v1.md`);
}

function makeRepo(plans: Record<string, string>): void {
  repo = mkdtempSync(join(tmpdir(), 'plan-flow-notes-e2e-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'flow', 'plans'), { recursive: true });
  writeFileSync(join(repo, 'src', 'cart.ts'), CART);
  writeFileSync(join(repo, 'src', 'money.ts'), MONEY);
  for (const [slug, text] of Object.entries(plans)) writeFileSync(planPathOf(slug), text);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'add', '-A');
  git(repo, '-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', 'commit', '-q', '-m', 'seed');
}

/** Line indexes that differ between two same-length texts. */
function changedLines(before: string[], after: string[]): number[] {
  return after.flatMap((line, index) => (line === before[index] ? [] : [index]));
}

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('plan notes --check on a real repository', () => {
  it(
    'passes a plan whose every quote is found once in its own function',
    () => {
      makeRepo({ coupons: planWith(NOTES) });
      const run = runCli(['plan', 'notes', 'coupons', '--check', '--json', '--target', repo], repo);
      expect(run.status).toBe(0);
      expect(run.combined).not.toContain('plan refused:');
      const report = lastJson(run.stdout);
      expect(report).toMatchObject({ plan: 'coupons', counts: { total: 3, accepted: 0, rejected: 0, unreviewed: 3 }, unreadable: [] });
      const notes = report.notes as Array<Record<string, unknown>>;
      expect(notes[0]).toMatchObject({ n: 1, kind: 'change', symbol: 'checkout', quote: { found: 'once', startLine: 5, endLine: 5 } });
      expect(notes[1]).toMatchObject({ n: 2, kind: 'new', callers: ['checkout'] });
      expect(notes[2]).toMatchObject({ n: 3, kind: 'file', file: 'src/money.ts' });
    },
    E2E_TIMEOUT_MS,
  );

  it.each([
    ['a quote found twice in its function', AMBIGUOUS_NOTE, { found: 'many' }],
    ['a quote its function does not hold', MISSING_NOTE, { found: 'none' }],
  ])(
    'refuses %s — the payload and the line, exit 1, and the plan file byte-identical',
    (_label, extra, quote) => {
      makeRepo({ coupons: planWith(`${NOTES}${extra}`) });
      const planPath = planPathOf('coupons');
      const before = readFileSync(planPath);
      const run = runCli(['plan', 'notes', 'coupons', '--check', '--json', '--target', repo], repo);
      expect(run.status).toBe(1);
      expect(run.combined).toMatch(/plan refused: notes — 1 note\(s\) need fixing/);
      const payload = lastJson(run.stdout);
      expect(payload.refused).toBe('notes');
      const failing = payload.failing as Array<{ n: number }>;
      expect(failing.map((entry) => entry.n)).toEqual([4]);
      const note4 = (payload.notes as Array<{ n: number; quote?: unknown }>).find((note) => note.n === 4);
      expect(note4?.quote).toMatchObject(quote);
      expect(readFileSync(planPath).equals(before)).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );
});

describe('plan note — one note, one rewrite', () => {
  it(
    'accept, reject with a reason, and a verdict each touch only that note',
    () => {
      makeRepo({ coupons: planWith(NOTES) });
      const planPath = planPathOf('coupons');
      const original = readFileSync(planPath, 'utf-8').split('\n');

      // Accept note 1: one inserted status line, inside note 1's block.
      const accepted = runCli(['plan', 'note', 'coupons', '--note', '1', '--status', 'accepted', '--json', '--target', repo], repo);
      expect(accepted.status).toBe(0);
      expect(lastJson(accepted.stdout)).toMatchObject({ note: { n: 1, status: 'accepted' } });
      const afterAccept = readFileSync(planPath, 'utf-8').split('\n');
      expect(afterAccept).toHaveLength(original.length + 1);
      const statusAt = afterAccept.indexOf('    status: accepted');
      const note1At = afterAccept.indexOf('- note: 1 · change · file:src/cart.ts:checkout');
      const note2At = afterAccept.indexOf('- note: 2 · new · file:src/cart.ts:discountOf');
      expect(statusAt).toBeGreaterThan(note1At);
      expect(statusAt).toBeLessThan(note2At);
      expect([...afterAccept.slice(0, statusAt), ...afterAccept.slice(statusAt + 1)]).toEqual(original);

      // Reject note 2 with a reason: one inserted line, inside note 2's block.
      const rejected = runCli(
        ['plan', 'note', 'coupons', '--note', '2', '--status', 'rejected', '--reason', 'inline the rate', '--json', '--target', repo],
        repo,
      );
      expect(rejected.status).toBe(0);
      expect(lastJson(rejected.stdout)).toMatchObject({ note: { n: 2, status: 'rejected', reason: 'inline the rate' } });
      const afterReject = readFileSync(planPath, 'utf-8').split('\n');
      const rejectAt = afterReject.indexOf('    status: rejected — inline the rate');
      expect(rejectAt).toBeGreaterThan(afterReject.indexOf('- note: 2 · new · file:src/cart.ts:discountOf'));
      expect(rejectAt).toBeLessThan(afterReject.indexOf('- note: 3 · file · file:src/money.ts'));
      expect([...afterReject.slice(0, rejectAt), ...afterReject.slice(rejectAt + 1)]).toEqual(afterAccept);

      // Re-accept note 2: the status line is REWRITTEN in place, nothing else moves.
      const flipped = runCli(['plan', 'note', 'coupons', '--note', '2', '--status', 'accepted', '--json', '--target', repo], repo);
      expect(flipped.status).toBe(0);
      const afterFlip = readFileSync(planPath, 'utf-8').split('\n');
      expect(afterFlip).toHaveLength(afterReject.length);
      expect(changedLines(afterReject, afterFlip)).toEqual([rejectAt]);
      expect(afterFlip[rejectAt]).toBe('    status: accepted');

      // A verdict on note 3: one inserted line inside note 3's block.
      const verdict = runCli(
        ['plan', 'note', 'coupons', '--note', '3', '--verdict', 'differs', '--why', 'the helper went in cart.ts', '--json', '--target', repo],
        repo,
      );
      expect(verdict.status).toBe(0);
      expect(lastJson(verdict.stdout)).toMatchObject({ note: { n: 3, verdict: 'differs', verdictWhy: 'the helper went in cart.ts' } });
      const afterVerdict = readFileSync(planPath, 'utf-8').split('\n');
      const verdictAt = afterVerdict.indexOf('    verdict: differs — the helper went in cart.ts');
      expect(verdictAt).toBeGreaterThan(afterVerdict.indexOf('- note: 3 · file · file:src/money.ts'));
      expect(verdictAt).toBeLessThan(afterVerdict.indexOf('### Phase 2: Tests (Final)'));
      expect([...afterVerdict.slice(0, verdictAt), ...afterVerdict.slice(verdictAt + 1)]).toEqual(afterFlip);

      // The reader sees all three decisions.
      const report = lastJson(runCli(['plan', 'notes', 'coupons', '--json', '--target', repo], repo).stdout);
      expect(report.counts).toEqual({ total: 3, accepted: 2, rejected: 0, unreviewed: 1 });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'a bad value refuses with the line and leaves the file byte-identical',
    () => {
      makeRepo({ coupons: planWith(NOTES) });
      const planPath = planPathOf('coupons');
      const before = readFileSync(planPath);
      const run = runCli(['plan', 'note', 'coupons', '--note', '1', '--status', 'maybe', '--json', '--target', repo], repo);
      expect(run.status).toBe(1);
      expect(run.combined).toContain('plan refused: bad-value');
      expect(readFileSync(planPath).equals(before)).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );
});

describe('blueprint storyline --plan draws the notes', () => {
  it(
    'a change note carries its quoted lines; a new note its callers’ pieces; a file note its file',
    () => {
      makeRepo({ coupons: planWith(NOTES) });
      const run = runCli(['blueprint', 'storyline', '--target', repo, '--file', 'src/cart.ts', '--plan', 'coupons', '--json'], repo);
      expect(run.status).toBe(0);
      const answer = lastJson(run.stdout) as {
        ok: boolean;
        files: string[];
        bands?: Array<{ project: string | null; files: string[] }>;
        compare?: { predicted: Array<Record<string, unknown>> };
        compareNote?: string;
      };
      expect(answer.ok).toBe(true);
      expect(answer.compareNote).toBeUndefined();
      expect(answer.files).toEqual(expect.arrayContaining(['src/cart.ts', 'src/money.ts']));
      expect(answer.bands?.[0]?.project ?? null).toBeNull();
      const predicted = answer.compare?.predicted ?? [];
      const byNote = (n: number): Record<string, unknown> | undefined =>
        predicted.find((prediction) => (prediction.note as { n?: number } | undefined)?.n === n);
      expect(byNote(1)).toMatchObject({
        kind: 'note-change',
        pieceId: 'src/cart.ts#checkout',
        symbol: 'checkout',
        quoteLines: { startLine: 5, endLine: 5 },
      });
      expect(byNote(1)?.quoteMissing).toBeUndefined();
      expect(byNote(2)).toMatchObject({
        kind: 'note-new',
        symbol: 'discountOf',
        signature: 'discountOf(coupon: string): number',
        callers: ['checkout'],
        callerPieces: { checkout: 'src/cart.ts#checkout' },
      });
      expect(byNote(3)).toMatchObject({ kind: 'note-file', file: 'src/money.ts' });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'a quote that is not there is said, never highlighted',
    () => {
      makeRepo({ coupons: planWith(`${NOTES}${MISSING_NOTE}`) });
      const run = runCli(['blueprint', 'storyline', '--target', repo, '--file', 'src/cart.ts', '--plan', 'coupons', '--json'], repo);
      expect(run.status).toBe(0);
      const answer = lastJson(run.stdout) as { compare?: { predicted: Array<Record<string, unknown>> } };
      const note4 = (answer.compare?.predicted ?? []).find((prediction) => (prediction.note as { n?: number }).n === 4);
      expect(note4).toMatchObject({ kind: 'note-change', pieceId: 'src/cart.ts#refund', quoteMissing: true });
      expect(note4?.quoteLines).toBeUndefined();
    },
    E2E_TIMEOUT_MS,
  );
});
