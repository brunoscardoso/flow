/**
 * `flow/brain/index.md` is generated from the notes — never edited in place —
 * so two machines rebuilding it from the same notes get the same file, and
 * neither ever has to merge it (workspaces-knowledge-hub FR-15).
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { buildBrainIndex, writeBrainIndex } = await import('./brain-index.js');
const { runBrain } = await import('../commands/brain.js');

const NOW = new Date('2026-10-06T12:00:00Z');

let root: string;
let flowDir: string;

function seed(rel: string, content: string, mtime?: Date): void {
  const path = join(flowDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mtime !== undefined) utimesSync(path, mtime, mtime);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pf-brain-index-'));
  flowDir = join(root, 'flow');
  mkdirSync(flowDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildBrainIndex', () => {
  it('lists features by status, struck-through when done, from the notes and the live documents', () => {
    seed('brain/features/dark-mode.md', '---\nstatus: active\ncreated: 2026-10-01\n---\n\n# [[dark-mode]]\n\nA dark theme for every screen.\n');
    seed('brain/features/old-thing.md', '---\nstatus: archived\ncreated: 2026-09-01\n---\n\n# [[old-thing]]\n\nRetired.\n');
    seed('brain/features/orders.md', '---\ncapture: brain\nname: orders\ndescription: Discovery — orders get idempotency keys\n---\n\n# orders\n', new Date('2026-09-20T00:00:00Z'));
    seed('plans/plan_orders_v1.md', '# Plan: Orders\n');
    seed('brain/features/shipped.md', '---\ncapture: brain\nname: shipped\n---\n\n# shipped\n\nShipped last month.\n', new Date('2026-08-01T00:00:00Z'));
    seed('archive/plan_shipped_v1.md', '# Plan: Shipped\n');
    seed('brain/features/blueprint.md', '---\nid: feature:blueprint\nname: Blueprint\nkind: core\nanchors: []\nrelates: []\n---\n# Blueprint\n\nThe living map.\n');
    seed('brain/features/thread-7f3a.md', '---\nthread_id: 7f3a\n---\nWorking set for a thread\n');

    const index = buildBrainIndex(flowDir, { now: NOW });
    expect(index).toBe(
      [
        '# Brain Index',
        '',
        '**Last Updated**: 2026-10-06',
        '',
        '> Generated from the brain notes on this machine — edit the notes, not this file.',
        '',
        '## Active Features',
        '- dark-mode [active] - A dark theme for every screen.',
        `- orders [active] - Discovery — orders get idempotency keys`,
        '- ~~old-thing~~ [archived] - Retired.',
        '- ~~shipped~~ [archived] - Shipped last month.',
        '',
        '## Capabilities',
        '- [[blueprint]]',
        '',
        '## Recent Errors (max 5)',
        '',
        '## Recent Decisions (max 3)',
        '',
      ].join('\n'),
    );
    expect(index).not.toContain('thread-7f3a');
  });

  it('keeps the newest five errors and three decisions', () => {
    for (let n = 1; n <= 7; n += 1) {
      seed(`brain/errors/error-${n}.md`, `---\ndescription: fix ${n}\n---\n# E${n}\n`, new Date(2026, 8, n));
      seed(`brain/decisions/decision-${n}.md`, `# Decision ${n}\n`, new Date(2026, 8, n));
    }
    const index = buildBrainIndex(flowDir, { now: NOW });
    const errors = index.split('## Recent Errors (max 5)\n')[1].split('\n\n')[0].split('\n');
    expect(errors).toEqual(['- [[error-7]] - fix 7', '- [[error-6]] - fix 6', '- [[error-5]] - fix 5', '- [[error-4]] - fix 4', '- [[error-3]] - fix 3']);
    expect(index).toContain('## Recent Decisions (max 3)\n- [[decision-7]] - Decision 7\n- [[decision-6]] - Decision 6\n- [[decision-5]] - Decision 5\n');
  });

  it('carries over a section another tool keeps, and drops the old generated ones', () => {
    const existing = '# Brain Index\n\n## Active Features\n- stale [active] - hand-inserted\n\n## Global Patterns\n- GLB-1 retry with jitter\n\n## Recent Errors (max 5)\n- [[gone]]\n';
    const index = buildBrainIndex(flowDir, { now: NOW, existing });
    expect(index).not.toContain('stale');
    expect(index).not.toContain('[[gone]]');
    expect(index.trimEnd().endsWith('## Global Patterns\n- GLB-1 retry with jitter')).toBe(true);
  });

  it('is a function of the notes: two rebuilds are byte-identical', () => {
    seed('brain/features/dark-mode.md', '---\nstatus: active\n---\n# dark mode\n\nDark.\n');
    const first = readFileSync(writeBrainIndex(flowDir, NOW), 'utf-8');
    const second = readFileSync(writeBrainIndex(flowDir, NOW), 'utf-8');
    expect(second).toBe(first);
  });
});

describe('brain index (the verb)', () => {
  it('rebuilds flow/brain/index.md for the target project', async () => {
    seed('brain/features/dark-mode.md', '---\nstatus: active\n---\n# dark mode\n\nDark.\n');
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runBrain('index', [], { target: root });
    } finally {
      write.mockRestore();
    }
    expect(readFileSync(join(flowDir, 'brain', 'index.md'), 'utf-8')).toContain('- dark-mode [active] - Dark.');
  });
});
