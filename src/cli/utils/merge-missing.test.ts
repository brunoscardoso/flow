import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mergeMissingContents } from './files.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'pf-merge-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const abs = join(base, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe('mergeMissingContents (#908)', () => {
  it('moves precious stores missing in dest, recursing into shared dirs', () => {
    write('old/brain/.structure/learning-state.jsonl', 'learned!');
    write('old/brain/.structure/investigations.jsonl', 'notes!');
    write('old/plans/plan_x.md', 'plan');
    write('new/brain/.structure/graph.json', '{}'); // dest-only file survives
    const result = mergeMissingContents(join(base, 'old'), join(base, 'new'));
    expect(result.errors).toEqual([]);
    expect(result.moved).toBe(3);
    expect(readFileSync(join(base, 'new/brain/.structure/learning-state.jsonl'), 'utf8')).toBe('learned!');
    expect(readFileSync(join(base, 'new/brain/.structure/investigations.jsonl'), 'utf8')).toBe('notes!');
    expect(readFileSync(join(base, 'new/plans/plan_x.md'), 'utf8')).toBe('plan');
    expect(existsSync(join(base, 'new/brain/.structure/graph.json'))).toBe(true);
  });

  it('never overwrites a file that exists in dest (dest wins)', () => {
    write('old/tasklist.md', 'OLD');
    write('new/tasklist.md', 'NEW');
    const result = mergeMissingContents(join(base, 'old'), join(base, 'new'));
    expect(result.kept).toBe(1);
    expect(result.moved).toBe(0);
    expect(readFileSync(join(base, 'new/tasklist.md'), 'utf8')).toBe('NEW');
  });

  it('missing src is a no-op', () => {
    expect(mergeMissingContents(join(base, 'ghost'), join(base, 'new'))).toEqual({
      moved: 0,
      kept: 0,
      errors: [],
    });
  });
});
