/**
 * The synced form of an execution record: a summary with file:line
 * references, never quoted source (workspaces-knowledge-hub FR-17).
 */

import { jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  SOURCE_OMITTED,
  archiveRounds,
  summarizeArchivedRounds,
  summarizeRoundsContent,
  summarizeRoundsEntry,
  summarizeRoundsText,
} = await import('./rounds-summary.js');
const { runPlanArchive } = await import('../commands/plan.js');

describe('summarizeRoundsText', () => {
  it('keeps prose, file:line references and short names', () => {
    const text = 'touches `runCagedSession` in app/src/main/agent/learn-session.ts:42 — kept for review';
    expect(summarizeRoundsText(text)).toBe(text);
  });

  it('strips an inline import statement quoted into prose', () => {
    const text = "touches: import { runInBackground } from './background-priority' — used inside runCagedSession (learn-session.ts:88)";
    expect(summarizeRoundsText(text)).toBe(`touches: ${SOURCE_OMITTED} — used inside runCagedSession (learn-session.ts:88)`);
  });

  it('strips fenced blocks, terminated or not', () => {
    expect(summarizeRoundsText('before\n```ts\nconst a = 1;\n```\nafter src/a.ts:3')).toBe(`before\n${SOURCE_OMITTED}\nafter src/a.ts:3`);
    expect(summarizeRoundsText('see:\n```\nsecret()')).toBe(`see:\n${SOURCE_OMITTED}`);
  });

  it('strips diff hunks and their headers, collapsing to one marker', () => {
    const diff = [
      'Changed the guard (src/guard.ts:10):',
      'diff --git a/src/guard.ts b/src/guard.ts',
      'index 1234abc..5678def 100644',
      '--- a/src/guard.ts',
      '+++ b/src/guard.ts',
      '@@ -10,3 +10,4 @@ export function guard() {',
      '-  return false',
      '+  if (x) return true',
      '   const y = 2',
      'Reviewed and kept.',
    ].join('\n');
    expect(summarizeRoundsText(diff)).toBe(`Changed the guard (src/guard.ts:10):\n${SOURCE_OMITTED}\nReviewed and kept.`);
  });

  it('strips statement lines and code-holding backtick spans', () => {
    const text = 'The fix:\nexport function guard(x: string) {\n  return check(x);\n}\nSee `if (x) { return check(x); }` vs `guard`.';
    expect(summarizeRoundsText(text)).toBe(`The fix:\n${SOURCE_OMITTED}\nSee ${SOURCE_OMITTED} vs \`guard\`.`);
  });

  it('is idempotent', () => {
    const once = summarizeRoundsText("a\n```\nb\n```\nimport x from 'y'\nc");
    expect(summarizeRoundsText(once)).toBe(once);
  });
});

describe('summarizeRoundsEntry / Content', () => {
  it('walks every string, replaces raw-text keys, and keeps ids, anchors and numbers', () => {
    const entry = {
      ts: '2026-10-02T21:12:52.558Z',
      type: 'review_verdict',
      phase: 2,
      reason: "touches: import { x } from './y' — in a.ts:3",
      anchors: [{ kind: 'file', ref: 'app/src/a.ts' }],
      evidence: [{ path: 'flow/.evidence/r/p1/out.txt', content: '<html>…</html>' }],
      diff: '@@ -1 +1 @@\n-a\n+b',
    };
    expect(summarizeRoundsEntry(entry)).toEqual({
      ...entry,
      reason: `touches: ${SOURCE_OMITTED} — in a.ts:3`,
      evidence: [{ path: 'flow/.evidence/r/p1/out.txt', content: SOURCE_OMITTED }],
      diff: SOURCE_OMITTED,
    });
  });

  it('checks single-line strings for statements, and raw-text keys case-insensitively, nested included (review fix 7)', () => {
    expect(summarizeRoundsText('const token = readSecret();')).toBe(SOURCE_OMITTED);
    expect(summarizeRoundsText('export function leak() {')).toBe(SOURCE_OMITTED);
    expect(summarizeRoundsText('done — see src/a.ts:3')).toBe('done — see src/a.ts:3');
    expect(
      summarizeRoundsEntry({
        type: 'tool',
        Output: 'some raw text',
        toolOutput: 'more raw text',
        content: [{ type: 'text', text: 'raw prose quoting the file' }],
        id: 'r1',
      }),
    ).toEqual({
      type: 'tool',
      Output: SOURCE_OMITTED,
      toolOutput: SOURCE_OMITTED,
      content: [{ type: 'text', text: SOURCE_OMITTED }],
      id: 'r1',
    });
  });

  it('drops a line that is not a JSON object — it cannot be summarized, so it is not shared', () => {
    const { text, dropped } = summarizeRoundsContent('{"type":"a"}\nconst leaked = 1;\n[1,2]\n\n{"type":"b"}\n');
    expect(text).toBe('{"type":"a"}\n{"type":"b"}\n');
    expect(dropped).toBe(2);
  });
});

describe('the archived copy', () => {
  let root: string;
  let flowDir: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pf-rounds-summary-')));
    flowDir = join(root, 'flow');
    mkdirSync(join(flowDir, 'archive'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const LINE = JSON.stringify({ type: 'phase_result', summary: 'done\n```\nconst a = 1;\n```' });

  it('summarizes every archived record once, never the live one', () => {
    writeFileSync(join(flowDir, 'archive', 'rounds_plan_a_v1.jsonl'), `${LINE}\n`);
    writeFileSync(join(flowDir, '.rounds.jsonl'), `${LINE}\n`);
    expect(summarizeArchivedRounds(flowDir)).toEqual([join(flowDir, 'archive', 'rounds_plan_a_v1.jsonl')]);
    expect(readFileSync(join(flowDir, 'archive', 'rounds_plan_a_v1.jsonl'), 'utf-8')).not.toContain('const a');
    expect(summarizeArchivedRounds(flowDir)).toEqual([]);
    expect(readFileSync(join(flowDir, '.rounds.jsonl'), 'utf-8')).toBe(`${LINE}\n`);
  });

  it('archiveRounds moves the live record; summarized, the full one stays on this machine', () => {
    writeFileSync(join(flowDir, '.rounds.jsonl'), `${LINE}\n`);
    const destination = archiveRounds(flowDir, 'plan_a_v1.md', { summarize: true });
    expect(destination).toBe(join(flowDir, 'archive', 'rounds_plan_a_v1.jsonl'));
    expect(readFileSync(destination as string, 'utf-8')).not.toContain('const a');
    expect(readFileSync(join(flowDir, '.evidence', 'rounds', 'rounds_plan_a_v1.jsonl'), 'utf-8')).toBe(`${LINE}\n`);
    expect(existsSync(join(flowDir, '.rounds.jsonl'))).toBe(false);
    expect(archiveRounds(flowDir, 'plan_a_v1.md', { summarize: true })).toBeNull();
  });

  it('plan archive summarizes the archived records in a Workspace project, and only there', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // Not a Workspace project: the archive is left exactly as written.
      writeFileSync(join(flowDir, 'archive', 'rounds_plan_a_v1.jsonl'), `${LINE}\n`);
      await runPlanArchive('a', { target: root });
      expect(readFileSync(join(flowDir, 'archive', 'rounds_plan_a_v1.jsonl'), 'utf-8')).toBe(`${LINE}\n`);

      // A Workspace project behind a flow link.
      const workspace = join(root, 'flow-folder', 'workspaces', 'team');
      const project = join(workspace, 'projects', 'backend');
      mkdirSync(join(project, 'archive'), { recursive: true });
      writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ name: 'Team', slug: 'team', projects: [{ id: 'x', name: 'backend', slug: 'backend', remotes: [] }] }));
      writeFileSync(join(project, 'archive', 'rounds_plan_a_v1.jsonl'), `${LINE}\n`);
      const repo = join(root, 'repo');
      mkdirSync(repo, { recursive: true });
      symlinkSync(project, join(repo, 'flow'));
      await runPlanArchive('a', { target: repo });
      expect(readFileSync(join(project, 'archive', 'rounds_plan_a_v1.jsonl'), 'utf-8')).not.toContain('const a');
      expect(write.mock.calls.map((call) => String(call[0])).join('')).toContain(`summarized: ${join('flow', 'archive', 'rounds_plan_a_v1.jsonl')}`);
    } finally {
      write.mockRestore();
    }
  });

  it('plan archive routes the LIVE record through archiveRounds — summarized in a Workspace, the full one kept here (review fix 7)', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const workspace = join(root, 'flow-folder', 'workspaces', 'team');
      const project = join(workspace, 'projects', 'backend');
      mkdirSync(join(project, 'archive'), { recursive: true });
      writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ name: 'Team', slug: 'team', projects: [{ id: 'x', name: 'backend', slug: 'backend', remotes: [] }] }));
      writeFileSync(join(project, 'archive', 'plan_b_v2.md'), '# B\n');
      writeFileSync(join(project, '.rounds.jsonl'), `${LINE}\n`);
      const repo = join(root, 'repo-b');
      mkdirSync(repo, { recursive: true });
      symlinkSync(project, join(repo, 'flow'));
      await runPlanArchive('b', { target: repo });
      expect(existsSync(join(project, '.rounds.jsonl'))).toBe(false);
      expect(readFileSync(join(project, 'archive', 'rounds_plan_b_v2.jsonl'), 'utf-8')).not.toContain('const a');
      expect(readFileSync(join(project, '.evidence', 'rounds', 'rounds_plan_b_v2.jsonl'), 'utf-8')).toBe(`${LINE}\n`);

      // Outside a Workspace the live record moves as it is.
      mkdirSync(join(flowDir, 'plans'), { recursive: true });
      mkdirSync(join(flowDir, 'plans'), { recursive: true });
      writeFileSync(join(flowDir, 'plans', 'plan_c_v1.md'), '# C\n');
      writeFileSync(join(flowDir, '.rounds.jsonl'), `${LINE}\n`);
      await runPlanArchive('flow/plans/plan_c_v1.md', { target: root });
      expect(readFileSync(join(flowDir, 'archive', 'rounds_plan_c_v1.jsonl'), 'utf-8')).toBe(`${LINE}\n`);
      expect(existsSync(join(flowDir, '.rounds.jsonl'))).toBe(false);
    } finally {
      write.mockRestore();
    }
  });
});
