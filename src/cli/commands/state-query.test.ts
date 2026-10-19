/**
 * Alias back-compat tests for `state-query` — it must keep its exact args and
 * JSON output shape (skills across `.claude/commands/**` parse
 * `{ results: [...] }`), now that the answer comes from the markdown corpus
 * rather than from an index.
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runStateQuery } from './state-query.js';

describe('state-query alias back-compat', () => {
  let writeSpy: ReturnType<typeof jest.spyOn>;
  let projectRoot: string;

  function seed(relPath: string, content: string): void {
    const full = join(projectRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'state-query-test-'));
    seed(
      '.claude/resources/core/wave-execution.md',
      '# Wave execution\n\n## Architecture\n\nWaves group independent phases and run them in parallel.\n',
    );
    seed(
      'flow/plans/plan_p_v1.md',
      '# Plan\n\n## Phase 1\n\nThe wave architecture is applied here.\n',
    );
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    writeSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function printedJson(): any {
    // The CLI logger also routes warnings through stdout (pattern #15) —
    // parse only the JSON payload the command itself printed.
    const payload = writeSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((text) => text.trimStart().startsWith('{'))
      .join('');
    return JSON.parse(payload);
  }

  it('prints the historical { results: [...] } shape with the same fields', async () => {
    await runStateQuery({ query: 'wave architecture', target: projectRoot });

    const { results } = printedJson();
    expect(results.length).toBeGreaterThan(0);
    expect(Object.keys(results[0]).sort()).toEqual([
      'chunkType',
      'content',
      'file',
      'heading',
      'score',
    ]);
    expect(results[0].file).toBe('.claude/resources/core/wave-execution.md');
    expect(results[0].heading).toBe('Architecture');
  });

  it('applies scope filtering exactly as before', async () => {
    await runStateQuery({ query: 'wave architecture', scope: 'resources', target: projectRoot });

    const { results } = printedJson();
    expect(results.length).toBeGreaterThan(0);
    expect(
      results.every((r: { file: string }) => r.file.startsWith('.claude/resources/')),
    ).toBe(true);
  });

  /**
   * #1801 — a narrowed filter is never silently widened.
   *
   * `--scope` was a bare cast: a compile-time assertion over a string a person
   * typed. Any value reached the search, matched no scope branch, and fell
   * through to unfiltered — so an unrecognized scope behaved exactly like
   * `--scope all`, at exit 0, with results that looked entirely reasonable.
   *
   * That is what makes it worth a test rather than a one-line patch: an empty
   * result is visibly empty, but a full result set from the WRONG corpus is
   * indistinguishable from a correct one. This is the project's own
   * context-loading call — CLAUDE.md and the loop commands invoke
   * `--scope resources` by name — so `resource`, one letter short, put every
   * plan and brainstorm in the repo into agent context under the name of the
   * reference docs.
   */
  describe('an unknown --scope is refused, not widened (#1801)', () => {
    it.each([
      ['a singular slip', 'resource'],
      ['a nonsense value', 'nosuchscope'],
      ['the wrong case', 'Resources'],
    ])('refuses %s and names the values that exist', async (_label, scope) => {
      await runStateQuery({ query: 'wave architecture', scope, target: projectRoot });

      expect(process.exitCode).toBe(1);
      const printed = printedJson();
      expect(printed.error).toContain(`unknown scope "${scope}"`);
      expect(printed.error).toContain('resources|rules|brain|plans|discovery|all');
      // Nothing was searched: the refusal replaces the answer, it does not
      // accompany one.
      expect(printed.results).toBeUndefined();
    });

    it('is NOT the same as searching everything — the regression, stated', async () => {
      // The precise shape of the bug: `resource` used to return what `all`
      // returns. If it ever does again, these two stop differing.
      await runStateQuery({ query: 'wave architecture', scope: 'all', target: projectRoot });
      const all = printedJson().results;
      expect(all.some((r: { file: string }) => r.file.startsWith('flow/plans/'))).toBe(true);

      writeSpy.mockClear();
      process.exitCode = undefined;
      await runStateQuery({ query: 'wave architecture', scope: 'resource', target: projectRoot });

      expect(printedJson().results).toBeUndefined();
      expect(process.exitCode).toBe(1);
    });

    it.each(['all', 'resources', 'rules', 'brain', 'plans', 'discovery'])(
      'still accepts the documented scope %s',
      async (scope) => {
        // The validator is derived from the map that DEFINES the scopes, so
        // this list and the search cannot drift apart (allowed-pattern #14).
        await runStateQuery({ query: 'wave architecture', scope, target: projectRoot });

        expect(process.exitCode).toBeUndefined();
        expect(printedJson().error).toBeUndefined();
      },
    );

    it('an omitted scope still means all', async () => {
      await runStateQuery({ query: 'wave architecture', target: projectRoot });

      expect(process.exitCode).toBeUndefined();
      expect(printedJson().results.length).toBeGreaterThan(0);
    });
  });

  it('applies limit', async () => {
    await runStateQuery({ query: 'wave architecture', limit: 1, target: projectRoot });

    expect(printedJson().results).toHaveLength(1);
  });

  it('a project with nothing to find → { results: [] } and exit 0', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'state-query-bare-'));
    try {
      await runStateQuery({ query: 'q', target: bare });

      expect(printedJson()).toEqual({ results: [] });
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
