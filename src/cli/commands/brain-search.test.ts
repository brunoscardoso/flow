/**
 * Tests for the `brain search` verb — capped human renderer (freshness
 * markers, pointers, mandatory drill-down line), --json shape, and the
 * no-index path (which now answers from the markdown).
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  hitPointer,
  hitSnippet,
  renderFullHit,
  renderHits,
  runBrainSearch,
  toJsonHit,
} from './brain-search.js';
import type { LayeredHit } from '../state/brain-search-core.js';

function hit(overrides: Partial<LayeredHit>): LayeredHit {
  return {
    id: 'aaaa1111',
    kind: 'note',
    file: 'CLAUDE.md',
    content: 'some content line',
    score: 0.8,
    layers: ['hybrid'],
    ...overrides,
  };
}

describe('brain-search renderer', () => {
  describe('hitPointer', () => {
    it('symbol hits point at path:line', () => {
      const pointer = hitPointer(
        hit({ kind: 'symbol', file: 'src/x.ts', heading: 'Foo', codeFile: 'src/x.ts', line: 42 }),
      );
      expect(pointer).toBe('src/x.ts:42');
    });

    it('code hits point at the code file with the card in parentheses', () => {
      const pointer = hitPointer(
        hit({ kind: 'code', file: 'flow/brain/code/src.md', heading: 'src/x.ts', codeFile: 'src/x.ts' }),
      );
      expect(pointer).toBe('src/x.ts (flow/brain/code/src.md)');
    });

    it('chunk hits point at file › heading', () => {
      expect(hitPointer(hit({ file: 'flow/plans/p.md', heading: 'Phase 1' }))).toBe('flow/plans/p.md › Phase 1');
      expect(hitPointer(hit({ file: 'CLAUDE.md', heading: undefined }))).toBe('CLAUDE.md');
    });
  });

  describe('hitSnippet (caps)', () => {
    it('keeps at most 3 non-empty lines', () => {
      const snippet = hitSnippet('one\n\ntwo\nthree\nfour\nfive');
      expect(snippet).toEqual(['one', 'two', 'three']);
    });

    it('caps each line and marks the cut', () => {
      const [line] = hitSnippet('x'.repeat(500));
      expect(line.length).toBeLessThanOrEqual(160);
      expect(line.endsWith('…')).toBe(true);
    });
  });

  describe('renderHits', () => {
    const freshnessOf = (h: LayeredHit) =>
      h.kind === 'symbol' ? 'fresh' : h.kind === 'code' ? 'stale' : ('unknown' as const);

    it('renders numbered hits with freshness markers and ALWAYS ends with the drill hint', () => {
      const output = renderHits(
        'my query',
        [
          hit({ id: 'id111111', kind: 'symbol', file: 'src/x.ts', heading: 'Foo', codeFile: 'src/x.ts', line: 4 }),
          hit({ id: 'id222222', kind: 'code', file: 'flow/brain/code/a.md', heading: 'src/y.ts', codeFile: 'src/y.ts' }),
          hit({ id: 'id333333', kind: 'plan', file: 'flow/plans/p.md', heading: 'Phase 1' }),
        ],
        freshnessOf as any,
      );
      const lines = output.split('\n');

      expect(lines[0]).toBe('1. ● fresh symbol src/x.ts:4');
      expect(output).toContain('2. ○ stale code src/y.ts (flow/brain/code/a.md) — verify against code');
      // unknown renders plain — no marker between the number and the kind
      expect(output).toContain('3. plan flow/plans/p.md › Phase 1');
      expect(lines[lines.length - 1]).toBe('drill: planflow-ai brain search "my query" --full id111111');
    });

    it('keeps the drill hint even with zero hits', () => {
      const lines = renderHits('nothing', [], () => 'unknown').split('\n');
      expect(lines[0]).toBe('no hits');
      expect(lines[lines.length - 1]).toBe('drill: planflow-ai brain search "nothing" --full <id>');
    });

    it('stays within the per-hit budget (≤200 tokens ≈ snippet + header only)', () => {
      const bulky = hit({ content: Array(50).fill('word '.repeat(60)).join('\n') });
      const output = renderHits('q', [bulky], () => 'unknown');
      // header + 3 capped snippet lines + id + drill — far below 200 tokens
      expect(output.length).toBeLessThan(800);
    });
  });

  describe('renderFullHit / toJsonHit', () => {
    it('renders the full content with id, layers and stale warning', () => {
      const output = renderFullHit(
        hit({ id: 'ffff0000', kind: 'code', file: 'flow/brain/code/a.md', heading: 'src/y.ts', codeFile: 'src/y.ts', layers: ['fts', 'hybrid'], content: 'FULL BODY' }),
        'stale',
      );
      expect(output).toContain('○ stale code src/y.ts');
      expect(output).toContain('id: ffff0000 · layers: fts+hybrid');
      expect(output).toContain('○ stale — verify against code');
      expect(output).toContain('FULL BODY');
    });

    it('toJsonHit carries the structured fields and the capped snippet', () => {
      const json = toJsonHit(
        hit({ id: 'abcd0000', kind: 'symbol', file: 'src/x.ts', heading: 'Foo', codeFile: 'src/x.ts', line: 9, layers: ['symbols'] }),
        'fresh',
      );
      expect(json).toEqual({
        id: 'abcd0000',
        kind: 'symbol',
        freshness: 'fresh',
        file: 'src/x.ts',
        heading: 'Foo',
        codeFile: 'src/x.ts',
        line: 9,
        score: 0.8,
        layers: ['symbols'],
        snippet: 'some content line',
      });
    });
  });
});

describe('runBrainSearch fail-soft', () => {
  let projectRoot: string;
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'brain-search-cmd-test-'));
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  // "NO INDEX" IS NOT A STATE A USER CAN BE IN. The corpus is the markdown
  // itself, so a project with knowledge and no database gets an answer instead
  // of an apology — which is most of the point of the swap. A leftover
  // `.brain.sqlite` from before the retirement is simply never read.
  it('a project with no index searches its markdown instead of apologising', async () => {
    mkdirSync(join(projectRoot, 'flow', 'brain', 'decisions'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'flow', 'brain', 'decisions', 'proposals.md'),
      '# Proposals\n\n## The proposal store\n\nWritten only through blueprint propose.\n',
      'utf-8',
    );
    // A stale index left on disk by an earlier version — tolerated, unread.
    writeFileSync(join(projectRoot, '.brain.sqlite'), 'not even a database', 'utf-8');

    await runBrainSearch('the proposal store', { target: projectRoot });

    const printed = String(logSpy.mock.calls[0]?.[0]);
    expect(printed).not.toContain('no index');
    expect(printed).toContain('flow/brain/decisions/proposals.md');
    expect(process.exitCode).toBeUndefined();
  });

  it('rejects an unknown scope with exit code 1', async () => {
    await runBrainSearch('anything', { target: projectRoot, scope: 'bogus' });

    expect(String(logSpy.mock.calls[0]?.[0])).toContain('unknown scope "bogus"');
    expect(process.exitCode).toBe(1);
  });

  // #1591: the sibling of the scope refusal above. Drill ids are perishable by
  // design ("re-run the search for fresh ids"), so a stale one is the everyday
  // failure — and it used to exit 0, leaving a caller unable to tell a hit from
  // a miss. Having no test for it is what let the two refusals drift apart.
  it('rejects an unresolvable --full id with exit code 1', async () => {
    await runBrainSearch('anything', { target: projectRoot, full: 'deadbeef' });

    expect(String(logSpy.mock.calls[0]?.[0])).toContain('id deadbeef not found');
    expect(process.exitCode).toBe(1);
  });

  it('emits parseable JSON carrying the refusal when --full is unresolvable under --json', async () => {
    await runBrainSearch('anything', { target: projectRoot, full: 'deadbeef', json: true });

    const printed = String(logSpy.mock.calls[0]?.[0]);
    const parsed = JSON.parse(printed);
    expect(parsed).toEqual({
      query: 'anything',
      full: 'deadbeef',
      error: 'id deadbeef not found — re-run the search for fresh ids',
      hit: null,
    });
    expect(process.exitCode).toBe(1);
  });
});
