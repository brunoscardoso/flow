/**
 * Tests for the project-scoped brain query module — the engine behind
 * `state-query`.
 *
 * No mocking of a search package, because there is no longer a search package:
 * these run against a REAL temp markdown corpus, which is the whole store.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { queryProjectBrain } from './brain-query.js';

let projectRoot: string;

/** Write a corpus file, creating its directory. */
function seed(relPath: string, content: string): void {
  const full = join(projectRoot, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'brain-query-test-'));
  seed(
    '.claude/resources/core/blueprint.md',
    '# Blueprint\n\n## Derive\n\nThe derive verb rebuilds the graph from extractors.\n',
  );
  seed(
    '.claude/rules/core/allowed-patterns.md',
    '# Allowed\n\n## Derive discipline\n\nEvery derive is gated by the canonical contract validator.\n',
  );
  seed(
    'flow/brain/decisions/derive.md',
    '# Decisions\n\n## Why derive is disposable\n\nThe derive output is rebuilt in full every time.\n',
  );
  seed('flow/plans/plan_x_v1.md', '# Plan\n\n## Phase 1\n\nThe derive step runs first.\n');
  seed('flow/discovery/discovery_x_v1.md', '# Discovery\n\n## Context\n\nderive questions.\n');
  seed('flow/archive/plan_old_v1.md', '# Old\n\n## Archived derive\n\nderive derive derive derive.\n');
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('queryProjectBrain', () => {
  it('returns QueryResult[] with the historical shape', () => {
    const results = queryProjectBrain(projectRoot, 'derive');

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(Object.keys(result).sort()).toEqual([
        'chunkType',
        'content',
        'file',
        'heading',
        'score',
      ]);
      expect(typeof result.file).toBe('string');
      expect(typeof result.score).toBe('number');
    }
  });

  it('applies scope filtering — resources scope only returns .claude/resources/ files', () => {
    const results = queryProjectBrain(projectRoot, 'derive', { scope: 'resources' });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.file.startsWith('.claude/resources/'))).toBe(true);
  });

  it.each([
    ['rules', '.claude/rules/'],
    ['brain', 'flow/brain/'],
    ['plans', 'flow/plans/'],
    ['discovery', 'flow/discovery/'],
  ] as const)('scope "%s" stays inside %s', (scope, prefix) => {
    const results = queryProjectBrain(projectRoot, 'derive', { scope });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.file.startsWith(prefix))).toBe(true);
  });

  it('does not filter when scope is "all" or undefined', () => {
    const scoped = queryProjectBrain(projectRoot, 'derive', { scope: 'all' });
    const unscoped = queryProjectBrain(projectRoot, 'derive');

    expect(new Set(scoped.map((r) => r.file)).size).toBeGreaterThan(1);
    expect(unscoped.map((r) => r.file)).toEqual(scoped.map((r) => r.file));
  });

  it('excludes flow/archive/ — historical noise for every caller', () => {
    const results = queryProjectBrain(projectRoot, 'derive', { limit: 50 });
    expect(results.every((r) => !r.file.startsWith('flow/archive/'))).toBe(true);
  });

  it('boosts authoritative sources — a core resource outranks a plan mentioning it', () => {
    const results = queryProjectBrain(projectRoot, 'derive', { limit: 50 });
    const core = results.findIndex((r) => r.file.startsWith('.claude/resources/core/'));
    const plan = results.findIndex((r) => r.file.startsWith('flow/plans/'));

    expect(core).toBeGreaterThanOrEqual(0);
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(core).toBeLessThan(plan);
  });

  it('applies limit, and defaults to 10', () => {
    expect(queryProjectBrain(projectRoot, 'derive', { limit: 2 })).toHaveLength(2);
    expect(queryProjectBrain(projectRoot, 'derive').length).toBeLessThanOrEqual(10);
  });

  it('filters by chunk type when one is named', () => {
    expect(queryProjectBrain(projectRoot, 'derive', { type: 'markdown' }).length).toBeGreaterThan(0);
    expect(queryProjectBrain(projectRoot, 'derive', { type: 'nonesuch' })).toEqual([]);
  });

  it('returns [] for a project with no corpus at all — never raises', () => {
    const bare = mkdtempSync(join(tmpdir(), 'brain-query-bare-'));
    try {
      expect(queryProjectBrain(bare, 'anything at all')).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('is deterministic — same corpus, same query, same order', () => {
    const first = queryProjectBrain(projectRoot, 'why derive is disposable');
    const second = queryProjectBrain(projectRoot, 'why derive is disposable');
    expect(second.map((r) => `${r.file}#${r.heading}`)).toEqual(
      first.map((r) => `${r.file}#${r.heading}`),
    );
    expect(second.map((r) => r.score)).toEqual(first.map((r) => r.score));
  });
});
