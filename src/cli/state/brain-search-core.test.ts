/**
 * Tests for the layered brain search core — symbols layer (real temp sidecar),
 * merge (RRF fuse + agreement boost + dedupe + cap), and the layered front door
 * end-to-end over a real temp markdown corpus.
 *
 * No database is involved anywhere: the `.brain.sqlite` index, its FTS query
 * rewrite and its hybrid leg were retired with the embedding stack, and the
 * markdown IS the store.
 */

import { jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  WORKSPACE_SEARCH_PROJECT_CAP,
  blendLinkHits,
  clearSymbolCacheForTests,
  codeCardHashOf,
  hitId,
  kindOfSourceFile,
  layeredBrainSearch,
  mergeLayers,
  namespaceHit,
  searchSymbols,
  workspaceProjectsToSearch,
} from './brain-search-core.js';
import type { ChunkHit, LayeredHit, LayeredSearchParams, SymbolHit, WorkspaceSearchContext } from './brain-search-core.js';
import { createWorkspace, linkRepo } from '../handlers/workspace-model.js';
import { linkKnowledge } from '../handlers/workspace-links.js';
import { createFreshnessResolver } from './hit-freshness.js';
import { NOT_IN_WORKSPACE_NOTE, hitPointer, hitSnippet, renderFullHit, renderHits, runBrainSearch } from '../commands/brain-search.js';
import {
  countStemMatches,
  ripgrepCandidates,
  queryStems,
  scoreChunkText,
  stemToken,
  stemWeights,
} from './brain-file-search.js';
import { runBlueprint } from '../commands/blueprint.js';
import { readFeatures } from '../blueprint/feature-store.js';
import { edgeFreshness } from '../blueprint/file-stamps.js';

describe('brain-search-core', () => {
  let projectRoot: string;
  let flowDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'brain-search-core-test-'));
    flowDir = join(projectRoot, 'flow');
    clearSymbolCacheForTests();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // ── fixture helpers ──────────────────────────────────────

  function writeSymbolSidecar(lines: string[]): void {
    const structureDir = join(flowDir, 'brain', '.structure');
    mkdirSync(structureDir, { recursive: true });
    writeFileSync(join(structureDir, 'symbols.jsonl'), lines.join('\n') + '\n', 'utf-8');
  }

  function symbolLine(name: string, path = 'src/thing.ts', line = 10): string {
    return JSON.stringify({
      name,
      kind: 'function',
      path,
      line,
      language: 'typescript',
      fileHash: 'a'.repeat(64),
    });
  }

  function chunk(overrides: Partial<ChunkHit> = {}): ChunkHit {
    return {
      chunkId: 1,
      file: 'flow/brain/features/auth.md',
      heading: 'Auth',
      content: 'auth content',
      score: 0.5,
      chunkType: 'note',
      ...overrides,
    };
  }

  // ── kind + id helpers ────────────────────────────────────

  describe('kindOfSourceFile', () => {
    it.each([
      ['flow/brain/code/src-cli.md', 'code'],
      ['flow/brain/modules/src-cli.md', 'module'],
      ['flow/brain/decisions/x.md', 'decision'],
      ['flow/brain/errors/x.md', 'error'],
      ['flow/brain/features/x.md', 'feature'],
      ['.claude/resources/core/blueprint.md', 'resource'],
      ['.claude/rules/core/allowed-patterns.md', 'rule'],
      ['flow/plans/plan_x_v1.md', 'plan'],
      ['flow/discovery/discovery_x_v1.md', 'discovery'],
      ['CLAUDE.md', 'note'],
    ])('%s → %s', (file, kind) => {
      expect(kindOfSourceFile(file)).toBe(kind);
    });
  });

  describe('hitId', () => {
    it('is stable for the same (file, heading) and 8 hex chars long', () => {
      const a = hitId('flow/plans/x.md', 'Phase 1');
      expect(a).toBe(hitId('flow/plans/x.md', 'Phase 1'));
      expect(a).toMatch(/^[0-9a-f]{8}$/);
    });

    it('differs across files and headings', () => {
      expect(hitId('a.md', 'h')).not.toBe(hitId('b.md', 'h'));
      expect(hitId('a.md', 'h1')).not.toBe(hitId('a.md', 'h2'));
    });
  });

  describe('codeCardHashOf', () => {
    it('extracts the 64-hex hash line from card chunk text', () => {
      const hash = 'b'.repeat(64);
      expect(codeCardHashOf(`symbols: none\n\nimports: none\n\nhash: ${hash}`)).toBe(hash);
    });

    it('returns undefined when no hash line exists', () => {
      expect(codeCardHashOf('just prose')).toBeUndefined();
    });
  });

  // ── symbols layer ────────────────────────────────────────

  describe('searchSymbols', () => {
    it('matches a multi-word query exactly against the concatenated name at 0.9', () => {
      writeSymbolSidecar([symbolLine('ThreadScopeManager', 'src/tsm.ts', 54)]);

      const hits = searchSymbols(flowDir, 'thread scope manager');

      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ name: 'ThreadScopeManager', path: 'src/tsm.ts', line: 54, score: 0.9 });
    });

    it('matches exact name case-insensitively at 0.9', () => {
      writeSymbolSidecar([symbolLine('hashRepoFile')]);
      expect(searchSymbols(flowDir, 'hashrepofile')[0].score).toBe(0.9);
    });

    it('scores prefix matches at 0.75', () => {
      writeSymbolSidecar([symbolLine('ThreadScopeManagerDeps')]);
      expect(searchSymbols(flowDir, 'ThreadScope')[0].score).toBe(0.75);
    });

    it('ignores tokens below the 4-char substring floor', () => {
      writeSymbolSidecar([symbolLine('makeBrainCapture')]);
      expect(searchSymbols(flowDir, 'cap')).toHaveLength(0);
    });

    // ── substring matches are scored by coverage (#1954) ──────────────
    // They used to be flat 0.6 for ANY one token appearing anywhere in a
    // name, which is how four of five slots for `why was the lavish engine
    // retired` went to symbols matching the bare word `engine`.

    it('drops a loose match on half the query and a third of the name', () => {
      writeSymbolSidecar([symbolLine('makeBrainCapture')]);
      // One of two countable tokens ("the" is below the 4-char floor), and 5
      // of 16 name characters. Neither side says the query is about it.
      expect(searchSymbols(flowDir, 'the brain thing')).toEqual([]);
    });

    it('scales a substring match by the share of the NAME it explains', () => {
      writeSymbolSidecar([symbolLine('ThreadScopeManager', 'src/tsm.ts', 54)]);
      // One of three query tokens, but the whole name — the name side is what
      // makes this a real hit, so the better of the two coverages is used.
      expect(searchSymbols(flowDir, 'where is the ThreadScopeManager defined')[0].score)
        .toBeCloseTo(0.6, 5);
    });

    it('drops the single common word matching a long unrelated name', () => {
      // The reported case, verbatim: none of these has anything to do with
      // lavish or with retirement, and together they took four of five slots.
      writeSymbolSidecar([
        symbolLine('LoopDirectiveEngine', 'src/loops/directive-reader.ts', 81),
        symbolLine('createWorkspaceSyncEngine', 'src/sync/engine.ts', 388),
        symbolLine('EngineTimers', 'src/sync/sync-timing.ts', 35),
      ]);
      expect(searchSymbols(flowDir, 'why was the lavish engine retired')).toEqual([]);
    });

    it('still finds a symbol a focused query names, even partially', () => {
      // The floor must not cost the lookups the layer exists for.
      writeSymbolSidecar([symbolLine('createWorkspaceSyncEngine', 'src/sync/engine.ts', 388)]);
      // Every token of the query is in the name: the query is about it.
      expect(searchSymbols(flowDir, 'sync engine')[0].score).toBeCloseTo(0.6, 5);
    });

    it('returns [] when the sidecar is missing', () => {
      expect(searchSymbols(flowDir, 'anything')).toEqual([]);
    });

    it('skips corrupt lines and rows with missing fields', () => {
      writeSymbolSidecar(['not json', '{"name":"x"}', symbolLine('RealSymbol')]);
      expect(searchSymbols(flowDir, 'RealSymbol')).toHaveLength(1);
    });

    it('reloads when the sidecar changes on disk', () => {
      writeSymbolSidecar([symbolLine('FirstSymbol')]);
      expect(searchSymbols(flowDir, 'FirstSymbol')).toHaveLength(1);

      writeSymbolSidecar([symbolLine('SecondSymbolLonger')]);
      // Force a distinct mtime in case the two writes share a clock tick.
      const sidecar = join(flowDir, 'brain', '.structure', 'symbols.jsonl');
      utimesSync(sidecar, new Date(), new Date(Date.now() + 5000));

      expect(searchSymbols(flowDir, 'SecondSymbolLonger')).toHaveLength(1);
      expect(searchSymbols(flowDir, 'FirstSymbol')).toHaveLength(0);
    });
  });

  // ── merge ────────────────────────────────────────────────

  describe('mergeLayers', () => {
    it('RRF-fuses the chunk legs — a chunk in BOTH legs outranks single-leg chunks', () => {
      const shared = chunk({ chunkId: 1, file: 'flow/plans/a.md', heading: 'A' });
      const legAOnly = chunk({ chunkId: 2, file: 'flow/plans/b.md', heading: 'B' });
      const legBOnly = chunk({ chunkId: 3, file: 'flow/plans/c.md', heading: 'C' });

      const merged = mergeLayers([legAOnly, shared], [shared, legBOnly], [], 10, ['files', 'titles']);

      expect(merged[0].file).toBe('flow/plans/a.md');
      expect(merged[0].layers).toEqual(['files', 'titles']);
    });

    it('applies the +0.15 agreement boost when the same source file appears in ≥2 layers', () => {
      // Code-card chunk about src/x.ts (files layer) + symbol in src/x.ts (symbols layer)
      const cardChunk = chunk({
        chunkId: 5,
        file: 'flow/brain/code/src.md',
        heading: 'src/x.ts',
        content: `exports: foo\n\nsymbols:\n- foo (function) — line 1\n\nimports: none\n\nhash: ${'c'.repeat(64)}`,
        chunkType: 'code',
      });
      const symbol: SymbolHit = {
        name: 'foo',
        kind: 'function',
        path: 'src/x.ts',
        line: 1,
        language: 'typescript',
        fileHash: 'c'.repeat(64),
        score: 0.9,
      };
      const unrelated = chunk({ chunkId: 6, file: 'flow/plans/b.md', heading: 'B' });

      const merged = mergeLayers([cardChunk, unrelated], [], [symbol], 10);

      const symbolHit = merged.find((hit) => hit.kind === 'symbol');
      const codeHit = merged.find((hit) => hit.kind === 'code');
      const planHit = merged.find((hit) => hit.kind === 'plan');
      expect(symbolHit?.score).toBeCloseTo(1.05); // 0.9 + 0.15
      expect(codeHit?.score).toBeCloseTo(1.15); // 1.0 normalized + 0.15
      expect(planHit?.score).toBeLessThan(1); // no boost
    });

    it('dedupes by (file, heading) keeping the best score and merging layers', () => {
      const a = chunk({ chunkId: undefined, file: 'flow/plans/a.md', heading: 'Same' });
      const b = chunk({ chunkId: undefined, file: 'flow/plans/a.md', heading: 'Same' });

      const merged = mergeLayers([a], [b], [], 10, ['files', 'titles']);

      expect(merged).toHaveLength(1);
      expect(merged[0].layers).toEqual(['files', 'titles']);
    });

    it('caps at the limit after sorting', () => {
      const chunks = [1, 2, 3, 4, 5, 6].map((n) =>
        chunk({ chunkId: n, file: `flow/plans/${n}.md`, heading: `H${n}` }),
      );
      expect(mergeLayers(chunks, [], [], 3)).toHaveLength(3);
    });

    it('extracts the code-card hash and code file onto code hits', () => {
      const hash = 'd'.repeat(64);
      const cardChunk = chunk({
        file: 'flow/brain/code/src-cli.md',
        heading: 'src/cli/index.ts',
        content: `one liner\n\nsymbols: none\n\nimports: none\n\nhash: ${hash}`,
        chunkType: 'code',
      });

      const [hit] = mergeLayers([cardChunk], [], [], 5);

      expect(hit.kind).toBe('code');
      expect(hit.codeFile).toBe('src/cli/index.ts');
      expect(hit.fileHash).toBe(hash);
    });
  });
});

// ── The file engine ────────────────────────────────────────────────────────

describe('file-based brain search', () => {
  let projectRoot: string;
  let flowDir: string;

  /** Write a corpus file, creating its directory. */
  function seed(relPath: string, content: string): void {
    const full = join(projectRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  /** The whole corpus the tests below search — one place, so a change shows. */
  function seedCorpus(): void {
    seed(
      'CLAUDE.md',
      [
        '# Project',
        '',
        '## Brain',
        '',
        'The tier boundary — `.raw/` is never indexed or surfaced — is enforced in',
        'one code path.',
        '',
        '## Unrelated',
        '',
        'Webhooks and telegram polling.',
      ].join('\n'),
    );
    seed(
      'flow/brain/decisions/proposals.md',
      [
        '# Proposals',
        '',
        '## How a proposal reaches the store',
        '',
        'Every proposal is written through `blueprint propose`, which is the only',
        'writer of proposals.jsonl.',
      ].join('\n'),
    );
    seed(
      'flow/brain/.derived/INDEX.md',
      [
        '<!-- GENERATED — DO NOT EDIT -->',
        '',
        '# Feature Index (derived)',
        '',
        '## Playbooks — feature:playbooks',
        '',
        'kind: core · file: flow/brain/features/playbooks.md',
        '',
        'summary: Runs a saved sequence of steps against a project.',
        '',
        'relates:',
        '- Skills (feature:skills) via src/main/skills/binder.ts — a playbook step',
        '  names a skill slug, which the binder resolves',
        '',
        '## Skills — feature:skills',
        '',
        'kind: core · file: flow/brain/features/skills.md',
      ].join('\n'),
    );
    // Never read: the tier boundary is a boundary for grep too.
    seed('flow/brain/.raw/thread-abc.md', '# Working set\n\nplaybooks skills binder raw boundary\n');
    // Never read: archived plans are historical noise for every caller.
    seed('flow/archive/plan_old_v1.md', '# Old\n\n## Playbooks and skills\n\nplaybooks skills\n');
  }

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'brain-file-search-test-'));
    flowDir = join(projectRoot, 'flow');
    clearSymbolCacheForTests();
    seedCorpus();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function search(query: string, overrides: Partial<LayeredSearchParams> = {}): Promise<LayeredHit[]> {
    return layeredBrainSearch({
      projectRoot,
      flowDir,
      query,
      scope: 'all',
      limit: 5,
      ...overrides,
    });
  }

  it('answers from the markdown with NO index present at all', async () => {
    expect(existsSync(join(projectRoot, '.brain.sqlite'))).toBe(false);

    const hits = await search('what enforces the raw boundary');

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].file).toBe('CLAUDE.md');
    expect(hits[0].heading).toBe('Brain');
  });

  it('answers the RELATIONAL question from the generated index — with the note', async () => {
    const hits = await search('how do skills relate to playbooks');

    const indexHit = hits.find((hit) => hit.file === 'flow/brain/.derived/INDEX.md');
    expect(indexHit).toBeDefined();
    // The mechanism AND the reason travel with the edge — the whole point of
    // the structured `relates` shape.
    expect(indexHit?.content).toContain('via src/main/skills/binder.ts');
    expect(indexHit?.content).toContain('names a skill slug, which the binder resolves');
    // It is the FEATURE layer, not a stray note.
    expect(indexHit?.kind).toBe('feature');
  });

  it('never reads .raw/ — the tier boundary holds for grep too', async () => {
    const hits = await search('playbooks skills binder', { limit: 25 });
    expect(hits.every((hit) => !hit.file.includes('/.raw/'))).toBe(true);
  });

  it('never reads flow/archive/ — the same exclusion the index applied', async () => {
    const hits = await search('playbooks skills', { limit: 25 });
    expect(hits.every((hit) => !hit.file.startsWith('flow/archive/'))).toBe(true);
  });

  // WORD BOUNDARIES, ASSERTED WHERE THEY LIVE. The end-to-end version of this
  // test passed with the anchor deliberately removed, because ripgrep's own
  // `\\b` narrowing kept the offending file out of the candidate set — a guard
  // that green-lights a broken scorer. The scorer is asserted directly, and the
  // end-to-end case is kept as the integration check it actually is.
  it('matches at word boundaries in the SCORER — "raw" is not a hit on "drawer"', () => {
    expect(countStemMatches('the drawer opens and the drawer closes', 'raw')).toBe(0);
    expect(countStemMatches('files under .raw/ and raw drafts', 'raw')).toBe(2);
    expect(countStemMatches('an explanation of the plan', 'plan')).toBe(1);
    // A stem is a PREFIX at a word start, which is what folds plurals and
    // tenses together without a dictionary.
    expect(countStemMatches('boundary, boundaries and bound', 'bound')).toBe(3);
    expect(stemToken('boundaries')).toBe(stemToken('boundary'));
    expect(stemToken('skills')).toBe(stemToken('skill'));
    expect(stemToken('raw')).toBe('raw');
  });

  it('scores coverage over repetition — both sides of a relation beat one side shouted', () => {
    const stems = ['skill', 'playb'];
    const bothOnce = scoreChunkText('skills resolve inside playbooks', stems);
    const oneManyTimes = scoreChunkText('playbooks playbooks playbooks playbooks playbooks', stems);
    expect(bothOnce).toBeGreaterThan(oneManyTimes);
    expect(scoreChunkText('nothing relevant here', stems)).toBe(0);
  });

  it('weights a rare term above a common one, up to a ceiling', () => {
    const corpus = ['bound bound bound', 'bound', 'bound', 'raw'];
    const weights = stemWeights(corpus, ['bound', 'raw']);
    // `raw` appears in one chunk of four, `bound` in three — so `raw` is worth
    // more, which is the difference between a ranking and a guess.
    expect(weights.get('raw')).toBeGreaterThan(weights.get('bound') as number);

    // …but never without limit. Uncapped, a stem in one chunk of two thousand
    // is worth ~7.6 and decides the answer alone — which is exactly how "what
    // happens when verification fails TWICE" ranked five documents containing
    // the word "twice" and none describing the retry loop.
    const rare = stemWeights([...Array(2000)].map((_, n) => (n === 0 ? 'twice' : 'other')), ['twice']);
    expect(rare.get('twice')).toBeLessThanOrEqual(2.5);
  });

  it('drops auxiliary verbs that are grammar in the question and content in the corpus', () => {
    // "where does a turn GET persisted" ranked a `GET /users` contract example
    // first until `get` joined the stoplist. It carries no subject either side.
    expect(queryStems('where does a turn get persisted')).not.toContain('get');
    expect(queryStems('where does a turn get persisted')).toEqual(['turn', 'persi']);
    // The stoplist is abandoned wholesale rather than returning nothing, when a
    // question is made ENTIRELY of common words.
    expect(queryStems('what can it do').length).toBeGreaterThan(0);
  });

  it('tells "ripgrep is unavailable" apart from "nothing matched"', () => {
    // Opposite facts. Conflating them is how a search returns nothing forever.
    expect(ripgrepCandidates(projectRoot, [], ['CLAUDE.md'])).toBeNull();
    expect(ripgrepCandidates(projectRoot, ['zzzznotinthecorpus'], ['CLAUDE.md'])).toEqual([]);
    expect(ripgrepCandidates(projectRoot, ['enfor'], ['CLAUDE.md'])).toEqual(['CLAUDE.md']);
  });

  it('matches at word boundaries end-to-end too', async () => {
    seed('flow/brain/decisions/ui.md', '# UI\n\n## Drawer\n\nThe drawer opens and the drawer closes.\n');

    const hits = await search('raw', { limit: 25 });

    expect(hits.every((hit) => hit.heading !== 'Drawer')).toBe(true);
  });

  it('is deterministic — the same corpus and query rank identically every time', async () => {
    const first = await search('how a proposal reaches the store');
    const second = await search('how a proposal reaches the store');
    expect(second.map((hit) => hit.id)).toEqual(first.map((hit) => hit.id));
    expect(second.map((hit) => hit.score)).toEqual(first.map((hit) => hit.score));
  });

  it('honours scope by directory, exactly as the index did', async () => {
    const hits = await search('proposal store', { scope: 'decisions', limit: 25 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.file.startsWith('flow/brain/decisions/'))).toBe(true);
  });

  it('still runs the symbols layer — it was never in the index', async () => {
    mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
    writeFileSync(
      join(flowDir, 'brain', '.structure', 'symbols.jsonl'),
      JSON.stringify({
        name: 'ThreadScopeManager',
        kind: 'class',
        path: 'src/tsm.ts',
        line: 54,
        language: 'typescript',
        fileHash: 'a'.repeat(64),
      }) + '\n',
      'utf-8',
    );

    const hits = await search('ThreadScopeManager');

    expect(hits.find((hit) => hit.kind === 'symbol')).toMatchObject({
      heading: 'ThreadScopeManager',
      codeFile: 'src/tsm.ts',
      line: 54,
    });
  });

  it('returns nothing — not everything — for a question the corpus does not answer', async () => {
    expect(await search('kubernetes helm chart rollout')).toEqual([]);
  });

  it('survives a corpus that is not there', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'brain-file-search-bare-'));
    try {
      const hits = await layeredBrainSearch({
        projectRoot: bare,
        flowDir: join(bare, 'flow'),
        query: 'anything at all',
        scope: 'all',
        limit: 5,
      });
      expect(hits).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  // ── THE CONTRACT (task 5.5) ───────────────────────────────────────────────
  //
  // `.claude/resources/core/brain-first.md` is referenced by 16 files across
  // `.claude/commands/**` and `.claude/resources/**`. Every promise it makes is
  // asserted HERE, directly, so a break names itself in one failing test
  // instead of surfacing as sixteen skills quietly getting worse.
  describe('the brain-first contract, promise by promise', () => {
    async function ranked(query = 'what enforces the raw boundary'): Promise<{
      hits: LayeredHit[];
      rendered: string;
    }> {
      const hits = await search(query, { limit: 5 });
      const resolve = createFreshnessResolver({ repoRoot: projectRoot, flowDir });
      return { hits, rendered: renderHits(query, hits, resolve) };
    }

    it('PROMISE 1 — at most 5 hits, and they are RANKED', async () => {
      // Seed enough matching sections that an uncapped search would return more.
      for (let n = 0; n < 12; n += 1) {
        seed(
          `flow/brain/decisions/boundary-${n}.md`,
          `# B${n}\n\n## Boundary ${n}\n\nThe raw boundary is enforced here.\n`,
        );
      }

      const hits = await search('what enforces the raw boundary', { limit: 5 });

      expect(hits.length).toBeLessThanOrEqual(5);
      expect(hits.length).toBeGreaterThan(1);
      // Ranked: scores are non-increasing, so hit 1 is the best answer.
      const scores = hits.map((hit) => hit.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    });

    it('PROMISE 2 — every hit carries a FRESHNESS flag', async () => {
      const { hits } = await ranked();
      const resolve = createFreshnessResolver({ repoRoot: projectRoot, flowDir });

      for (const hit of hits) {
        expect(['fresh', 'stale', 'unknown']).toContain(resolve(hit));
      }
    });

    it('PROMISE 3 — every hit carries a KIND', async () => {
      const { hits, rendered } = await ranked();
      for (const hit of hits) {
        expect(typeof hit.kind).toBe('string');
        expect(hit.kind.length).toBeGreaterThan(0);
        // …and it is rendered, not merely present in the object.
        expect(rendered).toContain(hit.kind);
      }
    });

    it('PROMISE 4 — every hit carries a file:line POINTER', async () => {
      const { hits } = await ranked();

      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.line).toBeGreaterThan(0);
        // The rendered pointer is the one a reader actually uses.
        expect(hitPointer(hit)).toMatch(/:\d+/);
      }
    });

    it('PROMISE 5 — every hit carries a SNIPPET', async () => {
      const { hits, rendered } = await ranked();
      for (const hit of hits) {
        const snippet = hitSnippet(hit.content);
        expect(snippet.length).toBeGreaterThan(0);
        expect(rendered).toContain(snippet[0]);
      }
    });

    it('PROMISE 6 — every hit carries a stable, unique HIT ID', async () => {
      const { hits, rendered } = await ranked();

      for (const hit of hits) {
        expect(hit.id).toMatch(/^[0-9a-f]{8}$/);
        expect(rendered).toContain(`id: ${hit.id}`);
      }
      expect(new Set(hits.map((hit) => hit.id)).size).toBe(hits.length);
      // Stable across runs — a drill id from a previous answer must still work.
      const again = await ranked();
      expect(again.hits.map((hit) => hit.id)).toEqual(hits.map((hit) => hit.id));
    });

    it('PROMISE 7 — the last line is ALWAYS the drill hint, and --full <id> resolves', async () => {
      const query = 'what enforces the raw boundary';
      const { hits, rendered } = await ranked(query);

      const lines = rendered.split('\n');
      expect(lines[lines.length - 1]).toBe(
        `drill: planflow-ai brain search "${query}" --full ${hits[0].id}`,
      );

      // The id the hint offers must resolve to ONE hit, printed in full — the
      // whole point of drilling instead of opening the file.
      const wider = await search(query, { limit: 25 });
      const target = wider.find((hit) => hit.id === hits[0].id);
      expect(target).toBeDefined();
      const full = renderFullHit(target as LayeredHit, 'unknown');
      expect(full).toContain((target as LayeredHit).content);
      expect(full).toContain(`id: ${hits[0].id}`);
    });

    // THE DOC AND THE CODE, PINNED TO EACH OTHER. `brain-first.md` is the ONE
    // canonical definition and 17 files under `.claude/commands/**` and
    // `.claude/resources/**` reference it. This asserts the doc still promises
    // exactly what the tests above prove, so a promise ADDED to the doc fails
    // here until the code satisfies it — rather than becoming seventeen files
    // describing a search that does not do that.
    it('the canonical contract document promises exactly what is asserted above', () => {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
      const doc = readFileSync(
        join(repoRoot, '.claude', 'resources', 'core', 'brain-first.md'),
        'utf-8',
      );

      for (const promise of [
        '≤5 ranked hits',
        'freshness flag',
        'kind',
        'file:line',
        'snippet',
        'hit id',
        '--full <id>',
        'drill hint',
      ]) {
        expect(doc).toContain(promise);
      }
      // The verb itself, unchanged — the string every one of those files types.
      expect(doc).toContain('planflow-ai brain search "<question>"');
    });

    it('the drill hint is present even when NOTHING matched', async () => {
      const query = 'kubernetes helm chart rollout';
      const rendered = renderHits(query, [], () => 'unknown');

      expect(rendered.split('\n')[0]).toBe('no hits');
      expect(rendered.split('\n').pop()).toBe(
        `drill: planflow-ai brain search "${query}" --full <id>`,
      );
    });
  });
});

// ── Task 7.2: the relational question, end to end on REAL DATA ──────────────
//
// This is the capability the whole plan exists for, and until now it was
// unproven ON DATA: the Phase 5 side-by-side ran against a corpus where all 33
// features carried `relates: []`, so "the new path answers relational
// questions" rested on a hand-written INDEX.md fixture rather than on an edge
// that had travelled the production path.
//
// Nothing is hand-placed here. The edge enters through the SAME CLI call the
// learn pass makes (`blueprint features learned --relates`), which is what
// validates it against the roster and stamps its `via`; the index is built by
// `blueprint features index`; and the answer comes back through
// `layeredBrainSearch`. Every link in the chain is the production one — only
// the model is replaced, by a literal, because what is under test is the
// pipeline, not the model's judgement.

describe('the relational question, end to end (task 7.2)', () => {
  let repoRoot: string;
  let flowDir: string;
  let originalCwd: string;
  let stdout: string[];
  let realWrite: typeof process.stdout.write;

  /** The mechanism the edge points at — a REAL file, so the stamp is real. */
  const BINDER_PATH = 'src/main/skills/binder.ts';
  const NOTE = 'a playbook step names a skill by slug; the binder resolves it at authoring time';

  function put(relPath: string, content: string): void {
    const full = join(repoRoot, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  function feature(slug: string, name: string, lead: string): void {
    put(
      `flow/brain/features/${slug}.md`,
      [
        '---',
        `id: feature:${slug}`,
        `name: ${name}`,
        'kind: core',
        'anchors: []',
        'relates: []',
        'lastFullRead: null',
        'patchCount: 0',
        '---',
        `# ${name}`,
        '',
        lead,
        '',
      ].join('\n'),
    );
  }

  /** Run a blueprint verb exactly as the CLI does — from the project's cwd. */
  async function blueprint(action: string, target: string, options: Record<string, unknown>): Promise<void> {
    process.chdir(repoRoot);
    try {
      await runBlueprint(action, target, options as never);
    } finally {
      process.chdir(originalCwd);
    }
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    repoRoot = mkdtempSync(join(tmpdir(), 'brain-relational-e2e-'));
    flowDir = join(repoRoot, 'flow');
    clearSymbolCacheForTests();

    feature('playbooks', 'Playbooks', 'Runs a saved sequence of steps against a project.');
    feature('skills', 'Skills', 'Packaged instructions the agent can invoke by slug.');
    put(
      BINDER_PATH,
      'export function bindPlaybookStep(slug: string) {\n  return resolveSkill(slug)\n}\n',
    );

    // The CLI reports refusals on stdout, and a refusal nobody sees is
    // indistinguishable from a write — so it is captured and asserted.
    stdout = [];
    realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = realWrite;
    process.chdir(originalCwd);
    rmSync(repoRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  /** The learn pass's write, verbatim: one learning plus one edge, one call. */
  function learnPass(relates: unknown[]): Promise<void> {
    return blueprint('features', 'learned', {
      feature: 'playbooks',
      entry: JSON.stringify({
        text: 'A playbook is a saved step sequence, resolved at authoring time.',
        provenance: 'code',
        date: '2026-08-11',
      }),
      relates: JSON.stringify(relates),
    });
  }

  it('learn writes the edge → index carries it → search answers WITH THE NOTE', async () => {
    // 1. THE LEARN PASS. The same CLI invocation `learn-session.ts` builds.
    await learnPass([{ target: 'feature:skills', via: BINDER_PATH, note: NOTE }]);
    expect(process.exitCode ?? 0).toBe(0);

    // 2. THE STORE. The edge is on disk, in the feature that recorded it, with
    //    its mechanism AND its reason — and stamped, so a changed binder can
    //    mark it stale instead of leaving a confident wrong statement behind.
    const playbooks = readFeatures(flowDir).find((node) => node.slug === 'playbooks');
    expect(playbooks?.relates).toHaveLength(1);
    const edge = (playbooks as NonNullable<typeof playbooks>).relates[0];
    expect(edge.target).toBe('feature:skills');
    expect(edge.via).toBe(BINDER_PATH);
    expect(edge.note).toBe(NOTE);
    expect(edgeFreshness(repoRoot, edge)).toBe('fresh');

    // 3. THE INDEX. Generated from the store, not written by this test.
    await blueprint('features', 'index', {});
    const indexPath = join(flowDir, 'brain', '.derived', 'INDEX.md');
    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, 'utf-8');
    expect(index).toContain(`Skills (feature:skills) via ${BINDER_PATH} — ${NOTE}`);

    // 4. THE ANSWER. Asked the way a person asks it.
    const hits = await layeredBrainSearch({
      projectRoot: repoRoot,
      flowDir,
      query: 'how do skills impact playbooks',
      scope: 'all',
      limit: 5,
    });

    const answer = hits.find((hit) => hit.file === 'flow/brain/.derived/INDEX.md');
    expect(answer).toBeDefined();
    // THE WHOLE POINT: a reader of this ONE hit can answer the question. The
    // mechanism and the reason are both in the returned text — no second file,
    // no second search.
    expect(answer?.content).toContain(BINDER_PATH);
    expect(answer?.content).toContain(NOTE);
    expect(answer?.content).toContain('Playbooks');
    expect(answer?.content).toContain('Skills');
  });

  it('the answer travels from the RECORDING side — Skills is never opened', async () => {
    await learnPass([{ target: 'feature:skills', via: BINDER_PATH, note: NOTE }]);
    await blueprint('features', 'index', {});

    const hits = await layeredBrainSearch({
      projectRoot: repoRoot,
      flowDir,
      query: 'how do skills impact playbooks',
      scope: 'all',
      limit: 5,
    });

    const answer = hits.find((hit) => hit.file === 'flow/brain/.derived/INDEX.md');
    expect(answer?.heading).toContain('Playbooks');
    // Skills' own file records nothing — the edge is directed, and the side
    // that read the code is the side that carries the mechanism.
    const skills = readFeatures(flowDir).find((node) => node.slug === 'skills');
    expect(skills?.relates).toEqual([]);
  });

  it('a HALLUCINATED target is refused, and never reaches the index or the search', async () => {
    await learnPass([
      { target: 'feature:skills', via: BINDER_PATH, note: NOTE },
      { target: 'feature:telemetry-pipeline', via: BINDER_PATH, note: 'invented out of thin air' },
    ]);

    const transcript = stdout.join('');
    expect(transcript).toContain(
      'features: refused edge to feature:telemetry-pipeline — no feature with that id exists in this project',
    );
    // The refusal costs the batch nothing: the real edge is still written.
    const playbooks = readFeatures(flowDir).find((node) => node.slug === 'playbooks');
    expect(playbooks?.relates.map((each) => each.target)).toEqual(['feature:skills']);

    await blueprint('features', 'index', {});
    const index = readFileSync(join(flowDir, 'brain', '.derived', 'INDEX.md'), 'utf-8');
    expect(index).not.toContain('telemetry-pipeline');
    expect(index).not.toContain('invented out of thin air');

    const hits = await layeredBrainSearch({
      projectRoot: repoRoot,
      flowDir,
      query: 'invented out of thin air telemetry pipeline',
      scope: 'all',
      limit: 5,
    });
    expect(hits.every((hit) => !hit.content.includes('invented out of thin air'))).toBe(true);
  });

  it('with NO edge recorded, the same question cannot be answered — the edge is what answers it', async () => {
    // The corpus Phase 5's comparison actually ran on: features present, all
    // `relates: []`. This is the control, and it is why the test above matters.
    await blueprint('features', 'index', {});
    const index = readFileSync(join(flowDir, 'brain', '.derived', 'INDEX.md'), 'utf-8');
    expect(index).not.toContain('relates:');

    const hits = await layeredBrainSearch({
      projectRoot: repoRoot,
      flowDir,
      query: 'how do skills impact playbooks',
      scope: 'all',
      limit: 5,
    });

    // Something may still match on the two names — but nothing anywhere in the
    // corpus states the CONNECTION, because nobody wrote it down.
    expect(hits.every((hit) => !hit.content.includes(BINDER_PATH))).toBe(true);
    for (const hit of hits) {
      expect(hit.content).not.toContain('resolves it at authoring time');
    }
  });

  it('a changed mechanism marks the edge STALE rather than leaving it quoted as fact', async () => {
    await learnPass([{ target: 'feature:skills', via: BINDER_PATH, note: NOTE }]);
    const before = readFeatures(flowDir).find((node) => node.slug === 'playbooks');
    expect(edgeFreshness(repoRoot, (before as NonNullable<typeof before>).relates[0])).toBe('fresh');

    put(BINDER_PATH, 'export function bindPlaybookStep() {\n  return null // the binder no longer resolves\n}\n');

    const after = readFeatures(flowDir).find((node) => node.slug === 'playbooks');
    expect(edgeFreshness(repoRoot, (after as NonNullable<typeof after>).relates[0])).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// Workspace scope + cross-project links (workspaces-knowledge-hub Phase 5)
// ---------------------------------------------------------------------------

describe('brain search across a Workspace', () => {
  let base: string;
  let appRoot: string;
  let coreRoot: string;
  let jobsFlow: string;

  function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf-8');
  }

  const LINK = {
    ts: '2026-10-06T12:00:00.000Z',
    author: 'Test Person',
    kind: 'exposes' as const,
    from: 'core/endpoint:POST /api/orders',
    to: 'app/file:src/screens/Orders.tsx',
    note: 'the checkout screen posts the cart here',
  };

  function context(overrides: Partial<WorkspaceSearchContext> = {}): WorkspaceSearchContext {
    return {
      workspace: 'team',
      selfSlug: 'app',
      projects: [
        { slug: 'app', self: true, flowDir: join(appRoot, 'flow'), repoRoot: appRoot },
        { slug: 'core', self: false, flowDir: join(base, 'ws', 'projects', 'core'), repoRoot: coreRoot },
        { slug: 'jobs', self: false, flowDir: jobsFlow, repoRoot: null },
      ],
      links: [LINK],
      ...overrides,
    };
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'brain-search-ws-'));
    appRoot = join(base, 'code', 'app');
    coreRoot = join(base, 'code', 'core');
    jobsFlow = join(base, 'ws', 'projects', 'jobs');
    clearSymbolCacheForTests();
    write(join(appRoot, 'flow', 'brain', 'features', 'checkout.md'), '# Checkout\n\n## Orders screen\n\nThe orders screen lists orders.\n');
    // core's knowledge lives in the Workspace folder; its checkout's flow/ is NOT linked here.
    write(join(base, 'ws', 'projects', 'core', 'brain', 'decisions', 'orders-api.md'), '# Orders API\n\n## Order creation\n\nOrders are created by POST /api/orders.\n');
    write(join(coreRoot, 'flow', 'brain', 'decisions', 'stale.md'), '# Old\n\n## Orders\n\nan old pre-workspace orders note\n');
    write(
      join(base, 'ws', 'projects', 'core', 'brain', '.structure', 'symbols.jsonl'),
      `${JSON.stringify({ name: 'ordersController', kind: 'function', path: 'src/orders.ts', line: 3, language: 'typescript', fileHash: 'h' })}\n`,
    );
    // jobs has no checkout here — its knowledge folder only, and its symbols are not offered.
    write(join(jobsFlow, 'plans', 'plan_orders-export_v1.md'), '# Orders export\n\n## Nightly orders export\n\nExports orders nightly.\n');
    write(join(jobsFlow, 'brain', '.structure', 'symbols.jsonl'), `${JSON.stringify({ name: 'ordersExport', kind: 'function', path: 'src/x.ts', line: 1, language: 'typescript', fileHash: 'h' })}\n`);
    // Generic plan-flow assets in a sibling checkout are NOT its knowledge.
    write(join(coreRoot, '.claude', 'resources', 'orders.md'), '# Orders\n\n## Orders\n\norders orders orders\n');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('searches every project and namespaces each hit <project>/…', async () => {
    const hits = await layeredBrainSearch({
      projectRoot: appRoot,
      flowDir: join(appRoot, 'flow'),
      query: 'orders',
      scope: 'workspace',
      limit: 10,
      workspace: context(),
    });
    const files = hits.map((hit) => hit.file);
    expect(files).toContain('app/flow/brain/features/checkout.md');
    expect(files).toContain('core/flow/brain/decisions/orders-api.md');
    expect(files).toContain('jobs/flow/plans/plan_orders-export_v1.md');
    expect(files).toContain('team/links.jsonl');
    // The sibling's pre-Workspace flow/ and its generic assets are not read.
    expect(files.some((file) => file.includes('stale.md') || file.includes('.claude/'))).toBe(false);
    for (const hit of hits.filter((entry) => entry.kind !== 'link')) {
      expect(hit.file.startsWith(`${hit.project}/`)).toBe(true);
      expect(hit.id).toBe(hitId(hit.file, hit.heading));
    }
    // Symbols come from a sibling WITH a checkout, namespaced to it.
    const symbol = hits.find((hit) => hit.kind === 'symbol');
    expect(symbol).toMatchObject({ project: 'core', codeFile: 'core/src/orders.ts', heading: 'ordersController' });
    expect(hits.some((hit) => hit.heading === 'ordersExport')).toBe(false);
  });

  it('per-project search stays the default, and surfaces this project’s links from its own side', async () => {
    const hits = await layeredBrainSearch({
      projectRoot: appRoot,
      flowDir: join(appRoot, 'flow'),
      query: 'orders',
      scope: 'all',
      limit: 5,
      workspace: context(),
    });
    expect(hits.every((hit) => hit.kind === 'link' || hit.project === undefined)).toBe(true);
    expect(hits.some((hit) => hit.file.includes('orders-api'))).toBe(false);
    const link = hits.find((hit) => hit.kind === 'link');
    expect(link).toMatchObject({
      file: 'team/links.jsonl',
      heading: 'app/file:src/screens/Orders.tsx —consumes→ core/endpoint:POST /api/orders',
      project: 'core',
    });
    expect(link?.content).toContain('the checkout screen posts the cart here');
  });

  it('a link that does not match the query, or does not involve this project, is not a hit', async () => {
    const elsewhere = { ...LINK, from: 'core/a', to: 'jobs/b' };
    const hits = await layeredBrainSearch({
      projectRoot: appRoot,
      flowDir: join(appRoot, 'flow'),
      query: 'orders',
      scope: 'all',
      limit: 5,
      workspace: context({ links: [elsewhere, { ...LINK, note: undefined, from: 'core/billing', to: 'app/invoices' }] }),
    });
    expect(hits.some((hit) => hit.kind === 'link')).toBe(false);
  });

  it('a link keeps a slot even when the project’s own corpus fills the cap', () => {
    const own = Array.from({ length: 5 }, (_, index) => ({
      id: `id${index}`, kind: 'note' as const, file: `f${index}.md`, content: '', score: 1, layers: ['files'],
    }));
    const links = [{ id: 'l', kind: 'link' as const, file: 'team/links.jsonl', content: '', score: 0.6, layers: ['links'] }];
    const blended = blendLinkHits(own, links, 5);
    expect(blended).toHaveLength(5);
    expect(blended.map((hit) => hit.kind)).toContain('link');
    expect(blendLinkHits(own, [], 5)).toHaveLength(5);
  });

  it('caps how many projects one search reads, self always first', () => {
    const projects = Array.from({ length: WORKSPACE_SEARCH_PROJECT_CAP + 3 }, (_, index) => ({
      slug: `p${String(index).padStart(2, '0')}`, self: index === 7, flowDir: '/x', repoRoot: null,
    }));
    const { searched, skipped } = workspaceProjectsToSearch(context({ projects, selfSlug: 'p07' }));
    expect(searched[0].slug).toBe('p07');
    expect(searched).toHaveLength(WORKSPACE_SEARCH_PROJECT_CAP);
    expect(skipped).toHaveLength(3);
  });

  it('namespaceHit re-mints the id from the namespaced path', () => {
    const hit = namespaceHit({ id: 'x', kind: 'code', file: 'flow/brain/code/a.md', heading: 'src/a.ts', codeFile: 'src/a.ts', content: '', score: 1, layers: [] }, 'core');
    expect(hit).toMatchObject({ file: 'core/flow/brain/code/a.md', codeFile: 'core/src/a.ts', project: 'core', id: hitId('core/flow/brain/code/a.md', 'src/a.ts') });
  });
});

const GIT_FOR_E2E = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_FOR_E2E ? describe : describe.skip;

describeWithGit('brain search --scope workspace through a real Workspace', () => {
  const KEYS = ['PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
  let sandbox: string;
  let logSpy: ReturnType<typeof jest.spyOn>;

  function repo(name: string, origin: string): string {
    const path = join(sandbox, 'code', name);
    mkdirSync(path, { recursive: true });
    for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', origin]]) {
      const result = spawnSync('git', args, { cwd: path, encoding: 'utf-8' });
      if (result.status !== 0) throw new Error(result.stderr);
    }
    return path;
  }

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'brain-search-ws-e2e-')));
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = t@example.com\n');
    process.env.PLAN_FLOW_HOME = join(sandbox, 'plan-flow');
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    logSpy.mockRestore();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('the frontend finds the backend’s knowledge and the link someone recorded', async () => {
    const flowFolder = join(sandbox, 'plan-flow');
    createWorkspace({ flowFolder, name: 'Team' });
    const backend = repo('backend', 'https://github.com/acme/backend.git');
    const frontend = repo('frontend', 'https://github.com/acme/frontend.git');
    linkRepo({ flowFolder, target: backend });
    linkRepo({ flowFolder, target: frontend });
    mkdirSync(join(backend, 'flow', 'brain', 'decisions'), { recursive: true });
    writeFileSync(join(backend, 'flow', 'brain', 'decisions', 'orders.md'), '# Orders\n\n## Orders endpoint\n\nPOST /api/orders creates an order.\n');
    linkKnowledge({
      flowFolder,
      target: frontend,
      from: 'backend/endpoint:POST /api/orders',
      to: 'frontend/file:src/screens/Orders.tsx',
      kind: 'exposes',
      note: 'checkout posts the cart',
    });

    await runBrainSearch('orders', { target: frontend, scope: 'workspace', json: true, limit: 10 });
    const out = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as { workspace: string; hits: Array<{ file: string; kind: string; project?: string; snippet: string }> };
    expect(out.workspace).toBe('team');
    expect(out.hits.map((hit) => hit.file)).toContain('backend/flow/brain/decisions/orders.md');
    expect(out.hits.find((hit) => hit.kind === 'link')?.snippet).toContain('checkout posts the cart');

    // Default scope from the frontend: its own corpus, plus the link from its side.
    logSpy.mockClear();
    await runBrainSearch('orders', { target: frontend, json: true });
    const plain = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as { hits: Array<{ file: string; kind: string }> };
    expect(plain.hits.some((hit) => hit.file.startsWith('backend/'))).toBe(false);
    expect(plain.hits.find((hit) => hit.kind === 'link')).toBeDefined();
  });

  it('outside a Workspace, --scope workspace says so in one line and searches this project', async () => {
    const loner = repo('loner', 'https://github.com/acme/loner.git');
    mkdirSync(join(loner, 'flow', 'brain', 'decisions'), { recursive: true });
    writeFileSync(join(loner, 'flow', 'brain', 'decisions', 'orders.md'), '# Orders\n\n## Orders\n\norders here\n');
    await runBrainSearch('orders', { target: loner, scope: 'workspace' });
    const printed = logSpy.mock.calls.map((call) => String(call[0]));
    expect(printed[0]).toBe(`brain search: ${NOT_IN_WORKSPACE_NOTE}`);
    expect(printed[1]).toContain('flow/brain/decisions/orders.md');
    expect(process.exitCode).toBeUndefined();
  });
});
