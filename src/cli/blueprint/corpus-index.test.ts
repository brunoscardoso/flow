import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CORPUS_INDEX_RELPATH,
  buildCorpusIndex,
  readCorpusIndex,
  writeCorpusIndex,
  type CorpusDocRecord,
  type CorpusIndex,
  type GitLogExec,
} from './corpus-index.js';
import { discoverFeatures } from './feature-discover.js';

const PASS_TS = '2026-08-13T12:00:00.000Z';
const GIT_TS = '2025-01-02T09:30:00+00:00';

function tempFlow(): string {
  const dir = mkdtempSync(join(tmpdir(), 'corpus-idx-'));
  for (const sub of ['plans', 'discovery', 'archive']) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

function doc(path: string, extra: Partial<CorpusDocRecord> = {}): CorpusDocRecord {
  return {
    path,
    kind: 'change',
    featureSlug: null,
    name: 'A Doc',
    archived: false,
    ...extra,
  };
}

/** A fake git that answers every lookup with one first-commit date. */
const gitAnswers: GitLogExec = (_args, _cwd) => `${GIT_TS}\n2026-01-01T00:00:00+00:00\n`;

/** A fake git that has never heard of any file. */
const gitFails: GitLogExec = () => {
  throw new Error('not a git repository');
};

describe('reading the index — fail-soft by contract', () => {
  it('reads a missing file as an empty index, never a throw', () => {
    expect(readCorpusIndex(tempFlow())).toEqual({ indexedAt: '', entries: [] });
  });

  it('reads corrupt JSON as an empty index', () => {
    const flow = tempFlow();
    mkdirSync(join(flow, 'brain', '.derived'), { recursive: true });
    writeFileSync(join(flow, CORPUS_INDEX_RELPATH), '{not json', 'utf-8');
    expect(readCorpusIndex(flow)).toEqual({ indexedAt: '', entries: [] });
  });

  it('reads a shape-invalid envelope as an empty index', () => {
    const flow = tempFlow();
    mkdirSync(join(flow, 'brain', '.derived'), { recursive: true });
    writeFileSync(join(flow, CORPUS_INDEX_RELPATH), JSON.stringify({ entries: 'nope' }), 'utf-8');
    expect(readCorpusIndex(flow)).toEqual({ indexedAt: '', entries: [] });
  });

  it('drops entries missing their identity fields, keeps the rest', () => {
    const flow = tempFlow();
    const good = { ...doc('flow/plans/plan_a_v1.md'), created: GIT_TS, indexed: PASS_TS };
    mkdirSync(join(flow, 'brain', '.derived'), { recursive: true });
    writeFileSync(
      join(flow, CORPUS_INDEX_RELPATH),
      JSON.stringify({ indexedAt: PASS_TS, entries: [good, { name: 'dateless legacy row' }] }),
      'utf-8',
    );
    expect(readCorpusIndex(flow).entries).toEqual([good]);
  });
});

describe('writing the index — deterministic bytes', () => {
  it('round-trips through write and read', () => {
    const flow = tempFlow();
    const index: CorpusIndex = {
      indexedAt: PASS_TS,
      entries: [{ ...doc('flow/plans/plan_a_v1.md'), created: GIT_TS, indexed: PASS_TS }],
    };
    writeCorpusIndex(flow, index);
    expect(readCorpusIndex(flow)).toEqual(index);
  });

  it('writes identical bytes for the same entries in any insertion order', () => {
    const a = { ...doc('flow/plans/plan_a_v1.md'), created: GIT_TS, indexed: PASS_TS };
    const b = { ...doc('flow/plans/plan_b_v1.md'), created: GIT_TS, indexed: PASS_TS };
    const flowOne = tempFlow();
    const flowTwo = tempFlow();
    writeCorpusIndex(flowOne, { indexedAt: PASS_TS, entries: [a, b] });
    writeCorpusIndex(flowTwo, { indexedAt: PASS_TS, entries: [b, a] });
    expect(readFileSync(join(flowOne, CORPUS_INDEX_RELPATH), 'utf-8')).toBe(
      readFileSync(join(flowTwo, CORPUS_INDEX_RELPATH), 'utf-8'),
    );
  });
});

describe('created resolution — previous index → git → pass timestamp', () => {
  const previous: CorpusIndex = {
    indexedAt: '2026-08-01T00:00:00.000Z',
    entries: [
      {
        ...doc('flow/plans/plan_known_v1.md'),
        created: '2024-06-01T00:00:00.000Z',
        indexed: '2026-08-01T00:00:00.000Z',
      },
    ],
  };

  it('carries a known path\'s created forward across passes, without asking git', () => {
    const exec = jest.fn(gitAnswers);
    const built = buildCorpusIndex([doc('flow/plans/plan_known_v1.md')], previous, PASS_TS, '/repo', exec);
    expect(built.entries[0].created).toBe('2024-06-01T00:00:00.000Z');
    expect(built.entries[0].indexed).toBe(PASS_TS);
    expect(exec).not.toHaveBeenCalled();
  });

  it('dates a new path from its git first commit', () => {
    const exec = jest.fn(gitAnswers);
    const built = buildCorpusIndex([doc('flow/plans/plan_new_v1.md')], previous, PASS_TS, '/repo', exec);
    expect(built.entries[0].created).toBe(GIT_TS);
    // Argv ARRAY, never a command string — nothing here may reach a shell.
    expect(exec).toHaveBeenCalledWith(
      ['log', '--follow', '--format=%aI', '--reverse', '--', 'flow/plans/plan_new_v1.md'],
      '/repo',
    );
  });

  it('falls back to the pass timestamp when git fails', () => {
    const built = buildCorpusIndex([doc('flow/plans/plan_new_v1.md')], previous, PASS_TS, '/repo', gitFails);
    expect(built.entries[0].created).toBe(PASS_TS);
  });

  it('treats empty git output as no answer, not an empty date', () => {
    const built = buildCorpusIndex([doc('flow/plans/plan_new_v1.md')], previous, PASS_TS, '/repo', () => '\n');
    expect(built.entries[0].created).toBe(PASS_TS);
  });

  it('survives a corrupt previous index — every doc simply looks new', () => {
    const flow = tempFlow();
    mkdirSync(join(flow, 'brain', '.derived'), { recursive: true });
    writeFileSync(join(flow, CORPUS_INDEX_RELPATH), '{{{', 'utf-8');
    const built = buildCorpusIndex(
      [doc('flow/plans/plan_known_v1.md')],
      readCorpusIndex(flow),
      PASS_TS,
      '/repo',
      gitAnswers,
    );
    expect(built.entries[0].created).toBe(GIT_TS);
  });

  it('stamps indexedAt with the pass timestamp', () => {
    expect(buildCorpusIndex([], previous, PASS_TS, '/repo', gitFails).indexedAt).toBe(PASS_TS);
  });
});

describe('batched git dating — O(1) spawns per pass (#1654)', () => {
  const empty: CorpusIndex = { indexedAt: '', entries: [] };
  const A_TS = '2025-01-02T09:30:00+00:00';
  const B_TS = '2025-03-04T10:00:00+00:00';

  it('dates N new paths with ONE history walk', () => {
    const exec = jest.fn(
      (_args: readonly string[], _cwd: string) =>
        `\0${A_TS}\n\nflow/plans/plan_a_v1.md\n\n\0${B_TS}\n\nflow/discovery/discovery_b_v1.md\n`,
    );
    const built = buildCorpusIndex(
      [doc('flow/plans/plan_a_v1.md'), doc('flow/discovery/discovery_b_v1.md', { kind: 'discovery' })],
      empty,
      PASS_TS,
      '/repo',
      exec,
    );
    expect(built.entries.map((entry) => entry.created)).toEqual([A_TS, B_TS]);
    expect(exec).toHaveBeenCalledTimes(1);
    // Argv ARRAY, never a command string — nothing here may reach a shell.
    expect(exec).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotepath=false',
        'log',
        '--reverse',
        '--diff-filter=A',
        '--format=%x00%aI',
        '--name-only',
        '--',
        'flow/plans/plan_a_v1.md',
        'flow/discovery/discovery_b_v1.md',
      ],
      '/repo',
    );
  });

  it('reserves the per-path --follow spawn for paths the walk cannot date (renames)', () => {
    const exec = jest.fn((args: readonly string[], _cwd: string) =>
      args.includes('--follow') ? `${B_TS}\n` : `\0${A_TS}\n\nflow/plans/plan_a_v1.md\n`,
    );
    const built = buildCorpusIndex(
      [doc('flow/plans/plan_a_v1.md'), doc('flow/archive/plan_moved_v1.md', { archived: true })],
      empty,
      PASS_TS,
      '/repo',
      exec,
    );
    expect(built.entries.map((entry) => entry.created)).toEqual([A_TS, B_TS]);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenLastCalledWith(
      ['log', '--follow', '--format=%aI', '--reverse', '--', 'flow/archive/plan_moved_v1.md'],
      '/repo',
    );
  });

  it('a batch failure degrades every path to its per-path lookup', () => {
    const exec = jest.fn((args: readonly string[], _cwd: string): string => {
      if (!args.includes('--follow')) throw new Error('git too old');
      return `${GIT_TS}\n`;
    });
    const built = buildCorpusIndex(
      [doc('flow/plans/plan_a_v1.md'), doc('flow/plans/plan_b_v1.md')],
      empty,
      PASS_TS,
      '/repo',
      exec,
    );
    expect(built.entries.map((entry) => entry.created)).toEqual([GIT_TS, GIT_TS]);
    expect(exec).toHaveBeenCalledTimes(3); // one failed batch + two fallbacks
  });

  it("an archived doc inherits its live copy's created by file name, without asking git", () => {
    const previous: CorpusIndex = {
      indexedAt: '2026-08-01T00:00:00.000Z',
      entries: [
        { ...doc('flow/plans/plan_x_v1.md'), created: A_TS, indexed: '2026-08-01T00:00:00.000Z' },
      ],
    };
    const exec = jest.fn(gitAnswers);
    const built = buildCorpusIndex(
      [doc('flow/archive/plan_x_v1.md', { archived: true })],
      previous,
      PASS_TS,
      '/repo',
      exec,
    );
    expect(built.entries[0].created).toBe(A_TS);
    expect(exec).not.toHaveBeenCalled();
  });

  it('an ambiguous file name — two prior dates — carries nothing', () => {
    const previous: CorpusIndex = {
      indexedAt: '2026-08-01T00:00:00.000Z',
      entries: [
        { ...doc('flow/plans/plan_x_v1.md'), created: A_TS, indexed: '2026-08-01T00:00:00.000Z' },
        { ...doc('flow/discovery/plan_x_v1.md'), created: B_TS, indexed: '2026-08-01T00:00:00.000Z' },
      ],
    };
    const built = buildCorpusIndex(
      [doc('flow/archive/plan_x_v1.md', { archived: true })],
      previous,
      PASS_TS,
      '/repo',
      gitFails,
    );
    expect(built.entries[0].created).toBe(PASS_TS); // fell through to the (failing) lookup
  });
});

describe('the discover pass feeds the index — per doc FILE, not per slug', () => {
  it('includes discovery docs and BOTH copies of an archived plan, the archive one flagged', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_auth_v1.md'), '# Auth Hardening\n\n- anchors: module:src/auth\n');
    writeFileSync(join(flow, 'archive', 'plan_auth_v1.md'), '# Auth Hardening\n');
    writeFileSync(join(flow, 'discovery', 'discovery_billing_v1.md'), '# Billing Discovery\n');

    const { corpusDocs } = discoverFeatures(flow, [], null);
    expect(corpusDocs).toEqual([
      {
        path: 'flow/plans/plan_auth_v1.md',
        kind: 'change',
        featureSlug: null,
        name: 'Auth Hardening',
        archived: false,
      },
      {
        path: 'flow/discovery/discovery_billing_v1.md',
        kind: 'discovery',
        featureSlug: null,
        name: 'Billing Discovery',
        archived: false,
      },
      {
        path: 'flow/archive/plan_auth_v1.md',
        kind: 'change',
        featureSlug: null,
        name: 'Auth Hardening',
        archived: true,
      },
    ]);
  });

  it('produces byte-identical index files for the same pass, twice', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_b_v1.md'), '# B\n');
    writeFileSync(join(flow, 'plans', 'plan_a_v1.md'), '# A\n');
    writeFileSync(join(flow, 'discovery', 'discovery_c_v1.md'), '# C\n');
    const { corpusDocs } = discoverFeatures(flow, [], null);

    const flowOne = tempFlow();
    const flowTwo = tempFlow();
    const previous = readCorpusIndex(flowOne);
    writeCorpusIndex(flowOne, buildCorpusIndex(corpusDocs, previous, PASS_TS, '/repo', gitAnswers));
    writeCorpusIndex(flowTwo, buildCorpusIndex(corpusDocs, previous, PASS_TS, '/repo', gitAnswers));
    expect(readFileSync(join(flowOne, CORPUS_INDEX_RELPATH), 'utf-8')).toBe(
      readFileSync(join(flowTwo, CORPUS_INDEX_RELPATH), 'utf-8'),
    );
  });
});
