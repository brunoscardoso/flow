/**
 * Forgetting has to actually forget — and stop exactly where the learner's
 * work ends.
 *
 * Reported live, looking at a board that had just been reset: "i reset the
 * learn, why we still having data on the blueprint?" It cleared one file, the
 * status table, while 400 module docs, 506 notes with 2,131 heat ticks, 19
 * generated views and every feature's learned sections stayed on disk.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeForget, forgetLearning } from './forget-learning.js';

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'forget-'));
  const flow = join(root, 'flow');
  const structure = join(flow, 'brain', '.structure');
  mkdirSync(join(flow, 'brain', 'modules'), { recursive: true });
  mkdirSync(join(flow, 'brain', 'features'), { recursive: true });
  mkdirSync(join(flow, 'brain', 'decisions'), { recursive: true });
  mkdirSync(join(structure, 'feature-views'), { recursive: true });

  writeFileSync(join(flow, 'brain', 'modules', 'src-app.md'), '# src/app\n\nWhat it does.\n');
  writeFileSync(join(flow, 'brain', 'modules', 'src-api.md'), '# src/api\n\nWhat it does.\n');
  writeFileSync(
    join(structure, 'investigations.jsonl'),
    [
      JSON.stringify({ kind: 'note', text: 'a finding', anchors: ['module:src/app'] }),
      JSON.stringify({ kind: 'heat', anchor: 'module:src/app' }),
      JSON.stringify({ kind: 'heat', anchor: 'module:src/api' }),
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(structure, 'learning-state.jsonl'),
    `${JSON.stringify({ module: 'src/app', status: 'learned', notedAt: '2026-08-01T00:00:00.000Z' })}\n`,
  );
  writeFileSync(join(structure, 'feature-views', 'auth.json'), '{}');
  writeFileSync(join(structure, 'graph.json'), '{"version":1,"nodes":[],"edges":[]}');
  writeFileSync(join(structure, 'annotations.jsonl'), '{"kind":"decision"}\n');
  writeFileSync(join(flow, 'brain', 'decisions', 'why-postgres.md'), '# Why postgres\n\nBecause.\n');
  writeFileSync(
    join(flow, 'brain', 'features', 'auth.md'),
    [
      '---',
      'name: Auth',
      'kind: core',
      '---',
      '',
      '# Auth',
      '',
      'How a person gets in. Written by a human.',
      '',
      '## Learned',
      '',
      '- Login races a consent modal <!-- learned: code 2026-08-09 -->',
      '',
      '## Parts',
      '',
      '### Browser Client',
      'The browser running the web app.',
      'anchors: e2e/tests/auth/login.spec.ts',
      '',
      '- The modal sets aria-hidden <!-- learned: code 2026-08-09 -->',
      '',
    ].join('\n'),
  );
  return root;
}

describe('blueprint forget', () => {
  let root: string;
  let flow: string;
  beforeEach(() => {
    root = makeProject();
    flow = join(root, 'flow');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('counts everything the learner made, without touching it, on a dry run', () => {
    const tally = forgetLearning(flow, { dryRun: true });
    expect(tally).toMatchObject({
      moduleDocs: 2,
      notes: 1,
      heat: 2,
      learningRows: 1,
      featureViews: 1,
      featuresStripped: 1,
      featuresSkipped: [],
    });
    // Nothing moved.
    expect(existsSync(join(flow, 'brain', 'modules', 'src-app.md'))).toBe(true);
    expect(readFileSync(join(flow, 'brain', 'features', 'auth.md'), 'utf-8')).toContain('## Learned');
  });

  it('forgets the module docs, the notes, the heat, the status and the views', () => {
    forgetLearning(flow);
    expect(existsSync(join(flow, 'brain', 'modules', 'src-app.md'))).toBe(false);
    expect(existsSync(join(flow, 'brain', 'modules', 'src-api.md'))).toBe(false);
    expect(existsSync(join(flow, 'brain', '.structure', 'feature-views', 'auth.json'))).toBe(false);
    expect(readFileSync(join(flow, 'brain', '.structure', 'investigations.jsonl'), 'utf-8')).toBe('');
    expect(readFileSync(join(flow, 'brain', '.structure', 'learning-state.jsonl'), 'utf-8')).toBe('');
  });

  it('keeps the feature — its name, its prose — and drops only what was learned', () => {
    forgetLearning(flow);
    const text = readFileSync(join(flow, 'brain', 'features', 'auth.md'), 'utf-8');
    expect(text).toContain('name: Auth');
    expect(text).toContain('How a person gets in. Written by a human.');
    expect(text).not.toContain('## Learned');
    expect(text).not.toContain('## Parts');
    expect(text).not.toContain('Browser Client');
  });

  it('leaves alone what the learner did not write', () => {
    // A person's own notes, and the derived map, are not things the learner
    // knows — forgetting them would be a different verb with a different name.
    forgetLearning(flow);
    expect(existsSync(join(flow, 'brain', 'decisions', 'why-postgres.md'))).toBe(true);
    expect(existsSync(join(flow, 'brain', '.structure', 'graph.json'))).toBe(true);
    expect(readFileSync(join(flow, 'brain', '.structure', 'annotations.jsonl'), 'utf-8')).toContain(
      'decision',
    );
  });

  it('forgets nothing, and says so, in a project that never learned', () => {
    const empty = mkdtempSync(join(tmpdir(), 'forget-empty-'));
    mkdirSync(join(empty, 'flow', 'brain'), { recursive: true });
    const tally = forgetLearning(join(empty, 'flow'));
    expect(tally.moduleDocs).toBe(0);
    expect(tally.notes).toBe(0);
    expect(describeForget(tally, false)).toContain('0 module docs');
    rmSync(empty, { recursive: true, force: true });
  });

  it('is safe to run twice', () => {
    forgetLearning(flow);
    const second = forgetLearning(flow);
    expect(second.moduleDocs).toBe(0);
    expect(second.featuresStripped).toBe(0);
    expect(existsSync(join(flow, 'brain', 'features', 'auth.md'))).toBe(true);
  });

  it('reads as a sentence, in both moods', () => {
    const tally = forgetLearning(flow, { dryRun: true });
    expect(describeForget(tally, true)).toBe(
      "forget: would forget 2 module docs, 1 note, 2 heat ticks, 1 status row, 1 feature view, 1 feature's learnings",
    );
    expect(describeForget(tally, false)).toContain('forgot 2 module docs');
  });
});
