import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hashFileContent } from '../blueprint/store.js';
import {
  defaultBranchOf,
  hashFileAtRevision,
  provenanceId,
  provenanceLine,
  readProvenanceRecords,
  recordProvenance,
  stampLearnedAt,
  stampProvenance,
} from './knowledge-provenance.js';

const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_OK ? describe : describe.skip;

describeWithGit('stampProvenance against real git', () => {
  let sandbox: string;
  let repo: string;

  const sh = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };

  function commit(file: string, content: string, message = 'c'): void {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), content);
    sh('add', '-A');
    sh('commit', '-q', '-m', message);
  }

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pf-provenance-'));
    repo = join(sandbox, 'code');
    mkdirSync(join(repo, 'flow'), { recursive: true });
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    sh('config', 'user.name', 'Test Person');
    sh('config', 'user.email', 'test@example.com');
    commit('src/a.ts', 'export const a = 1;\n', 'first');
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('stamps the default branch as onDefault, with the cited file digest', () => {
    const stamp = stampProvenance(repo, ['src/a.ts', 'src', 'missing.ts', './src/a.ts']);
    expect(stamp.branch).toBe('main');
    expect(stamp.commit).toBe(sh('rev-parse', 'HEAD'));
    expect(stamp.onDefault).toBe(true);
    // The directory and the missing file have no digest; the duplicate is one entry.
    expect(stamp.hashes).toEqual([{ path: 'src/a.ts', contentHash: hashFileContent('export const a = 1;\n') }]);
  });

  it('stamps a feature branch with new work as not on the default branch', () => {
    // Positive first (#28): the same repo answers true on main.
    expect(stampProvenance(repo, []).onDefault).toBe(true);
    sh('checkout', '-q', '-b', 'feat/orders');
    commit('src/a.ts', 'export const a = 2;\n');
    const stamp = stampProvenance(repo, ['src/a.ts']);
    expect(stamp.branch).toBe('feat/orders');
    expect(stamp.onDefault).toBe(false);
  });

  it('counts a branch with no new commits as on the default branch (HEAD is an ancestor)', () => {
    sh('checkout', '-q', '-b', 'feat/empty');
    expect(stampProvenance(repo, []).onDefault).toBe(true);
  });

  it('prefers the project Base branch setting over main', () => {
    sh('checkout', '-q', '-b', 'develop');
    commit('src/b.ts', 'b\n');
    sh('checkout', '-q', 'main');
    // Without the setting, main is the default and develop's tip is not on it.
    expect(defaultBranchOf(repo)).toBe('refs/heads/main');
    writeFileSync(join(repo, 'flow', '.flowconfig'), 'branch: develop\n');
    expect(defaultBranchOf(repo)).toBe('refs/heads/develop');
    sh('checkout', '-q', 'develop');
    expect(stampProvenance(repo, []).onDefault).toBe(true);
  });

  it('records a detached HEAD with no branch', () => {
    sh('checkout', '-q', '--detach');
    const stamp = stampProvenance(repo, []);
    expect(stamp.commit).not.toBeNull();
    expect(stamp.branch).toBeNull();
  });

  it('hashes a file at a revision with the same digest as the working tree', () => {
    const first = sh('rev-parse', 'HEAD');
    commit('src/a.ts', 'export const a = 3;\n');
    expect(hashFileAtRevision(repo, 'HEAD', 'src/a.ts')).toBe(hashFileContent(readFileSync(join(repo, 'src/a.ts'))));
    expect(hashFileAtRevision(repo, first, 'src/a.ts')).toBe(hashFileContent('export const a = 1;\n'));
    // Absent at that ref, a directory, an unknown ref, an escaping path: null.
    expect(hashFileAtRevision(repo, first, 'src/missing.ts')).toBeNull();
    expect(hashFileAtRevision(repo, 'HEAD', 'src')).toBeNull();
    expect(hashFileAtRevision(repo, 'no-such-ref', 'src/a.ts')).toBeNull();
    expect(hashFileAtRevision(repo, 'HEAD', '../outside.ts')).toBeNull();
    expect(hashFileAtRevision(repo, '--output=x', 'src/a.ts')).toBeNull();
  });

  it('stores one record per stamp, with the same bytes every time', () => {
    const flowDir = join(repo, 'flow');
    const first = stampLearnedAt(flowDir, repo, ['src/a.ts']);
    const second = stampLearnedAt(flowDir, repo, ['src/a.ts']);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(second).toBe(first);
    const file = join(flowDir, 'brain', '.structure', 'knowledge-provenance.jsonl');
    const lines = readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const records = readProvenanceRecords(flowDir);
    expect(records.get(first as string)?.branch).toBe('main');
  });
});

describe('stampProvenance outside a checkout', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pf-provenance-nogit-'));
    mkdirSync(join(sandbox, 'flow'), { recursive: true });
    writeFileSync(join(sandbox, 'a.ts'), 'x\n');
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('has no branch or commit, and the writers record nothing', () => {
    const stamp = stampProvenance(sandbox, ['a.ts']);
    expect(stamp.hashes).toHaveLength(1);
    expect(stamp.commit).toBeNull();
    expect(stamp.onDefault).toBeNull();
    expect(stampLearnedAt(join(sandbox, 'flow'), sandbox, ['a.ts'])).toBeNull();
    expect(existsSync(join(sandbox, 'flow', 'brain', '.structure', 'knowledge-provenance.jsonl'))).toBe(false);
  });
});

describe('provenance records', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pf-provenance-rec-'));
  });

  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  it('addresses a stamp by content, whatever order its hashes came in', () => {
    const a = { branch: 'x', commit: 'c'.repeat(40), onDefault: false, hashes: [{ path: 'b', contentHash: '2' }, { path: 'a', contentHash: '1' }] };
    const b = { ...a, hashes: [...a.hashes].reverse() };
    expect(provenanceId(a)).toBe(provenanceId(b));
    expect(provenanceLine(a)).toBe(provenanceLine(b));
    expect(provenanceId({ ...a, onDefault: true })).not.toBe(provenanceId(a));
  });

  it('skips a record whose id does not match its body', () => {
    const stamp = { branch: 'x', commit: 'c'.repeat(40), onDefault: false, hashes: [] };
    const id = recordProvenance(sandbox, stamp);
    const file = join(sandbox, 'brain', '.structure', 'knowledge-provenance.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf-8')}{"id":"0000000000000000","branch":"main","commit":null,"onDefault":true,"hashes":[]}\n`);
    const records = readProvenanceRecords(sandbox);
    expect(records.has(id)).toBe(true);
    expect(records.has('0000000000000000')).toBe(false);
  });
});
