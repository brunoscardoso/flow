/**
 * Bringing an old knowledge folder into a Workspace project: a clash never
 * overwrites. A document is kept beside the one already there; an append-only
 * store is JOINED into it, because no reader opens `<name>.imported.jsonl`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { applyKnowledgeImport, planKnowledgeImport } = await import('./workspace-import.js');

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-import-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(base: string, rel: string, text: string): void {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

describe('a clash on import', () => {
  it('joins an append-only store line by line, and still keeps a clashing document beside the original', () => {
    const source = join(root, 'old-flow');
    const destination = join(root, 'workspace', 'projects', 'app');
    put(destination, 'brain/.structure/investigations.jsonl', '{"id":1}\n{"id":2}\n');
    put(source, 'brain/.structure/investigations.jsonl', '{"id":2}\n{"id":3}\n');
    put(destination, 'references/business-context.md', '# Ours\n');
    put(source, 'references/business-context.md', '# Theirs\n');

    const report = applyKnowledgeImport(planKnowledgeImport(source, destination));

    // The document is still kept beside the original (the positive: renaming still works)…
    expect(readFileSync(join(destination, 'references/business-context.imported.md'), 'utf-8')).toBe('# Theirs\n');
    expect(report.renamed).toEqual([{ from: 'references/business-context.md', to: 'references/business-context.imported.md' }]);
    // …and the store is joined: every line once, the original's lines first and untouched.
    expect(readFileSync(join(destination, 'brain/.structure/investigations.jsonl'), 'utf-8')).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
    expect(existsSync(join(destination, 'brain/.structure/investigations.imported.jsonl'))).toBe(false);
    expect(report.joined).toEqual(['brain/.structure/investigations.jsonl']);
  });

  it('joins onto a store whose last line has no newline without gluing two lines together', () => {
    const source = join(root, 'old-flow');
    const destination = join(root, 'workspace', 'projects', 'app');
    put(destination, 'brain/.structure/annotations.jsonl', '{"a":1}');
    put(source, 'brain/.structure/annotations.jsonl', '{"a":2}\n');
    applyKnowledgeImport(planKnowledgeImport(source, destination));
    expect(readFileSync(join(destination, 'brain/.structure/annotations.jsonl'), 'utf-8')).toBe('{"a":1}\n{"a":2}\n');
  });
});
