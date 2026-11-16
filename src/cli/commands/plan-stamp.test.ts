/** `plan stamp <doc>` — the one writer of a document's `branch:` and `commit:`. */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { stampDocument } from './plan.js';
import { readKnowledgeStamp } from '../state/knowledge-status.js';

const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_OK ? describe : describe.skip;

describeWithGit('stampDocument', () => {
  let repo: string;
  const sh = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'pf-plan-stamp-')));
    sh('init', '-q', '-b', 'main');
    sh('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'first');
    sh('checkout', '-q', '-b', 'feat/orders');
    mkdirSync(join(repo, 'flow', 'plans'), { recursive: true });
    writeFileSync(join(repo, 'flow', 'plans', 'plan_orders_v1.md'), '---\nauthor: A Person\n---\n# Plan\n\nBody.\n');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('writes the branch and HEAD read off the checkout, keeping every other key and the body', () => {
    const result = stampDocument(repo, 'flow/plans/plan_orders_v1.md');
    const head = sh('rev-parse', 'HEAD');
    expect(result).toEqual({ action: 'stamp', document: join('flow', 'plans/plan_orders_v1.md'), branch: 'feat/orders', commit: head, changed: true });
    const text = readFileSync(join(repo, 'flow', 'plans', 'plan_orders_v1.md'), 'utf-8');
    expect(readKnowledgeStamp(text)).toEqual({ readiness: null, branch: 'feat/orders', commit: head });
    expect(text).toContain('author: A Person');
    expect(text.endsWith('# Plan\n\nBody.\n')).toBe(true);
    // Idempotent.
    expect(stampDocument(repo, 'flow/plans/plan_orders_v1.md').changed).toBe(false);
  });

  it('refuses anything but a discovery or plan document, and a folder that is not a checkout — writing nothing', () => {
    writeFileSync(join(repo, 'flow', 'notes.md'), '# Notes\n');
    expect(() => stampDocument(repo, 'flow/notes.md')).toThrow(/^stamp refused:/);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'pf-plan-stamp-plain-')));
    try {
      mkdirSync(join(plain, 'flow', 'discovery'), { recursive: true });
      writeFileSync(join(plain, 'flow', 'discovery', 'discovery_x_v1.md'), '# X\n');
      expect(() => stampDocument(plain, 'flow/discovery/discovery_x_v1.md')).toThrow(/not a git checkout/);
      expect(readFileSync(join(plain, 'flow', 'discovery', 'discovery_x_v1.md'), 'utf-8')).toBe('# X\n');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
