import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ANCHOR_JACCARD_THRESHOLD,
  anchorJaccard,
  codeFallback,
  discoverFeatures,
  matchCandidate,
  mineCorpus,
  readCandidates,
  writeCandidates,
} from './feature-discover.js';
import { parseFeatureFile, type FeatureNode } from './feature-store.js';
import type { BlueprintGraph } from './types.js';

function tempFlow(): string {
  const dir = mkdtempSync(join(tmpdir(), 'feat-disc-'));
  for (const sub of ['plans', 'discovery', 'archive']) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

function feature(slug: string, anchors: string[], extra: Partial<FeatureNode> = {}): FeatureNode {
  return { ...parseFeatureFile(slug, `# Feature: ${slug}\n`), anchors, ...extra };
}

const graph: BlueprintGraph = {
  version: 1,
  derivedAt: '2026-07-31T00:00:00.000Z',
  coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['modules'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src/auth', kind: 'module', label: 'auth', sourceFile: 'src/auth', meta: {} },
    { id: 'module:src/billing', kind: 'module', label: 'billing', sourceFile: 'src/billing', meta: {} },
    { id: 'module:src/auth/deep/nested', kind: 'module', label: 'nested', sourceFile: 'x', meta: {} },
  ],
  edges: [],
};

describe('mining the corpus', () => {
  it('reads features someone already named, preferring plans over archive', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_auth-sessions_v1.md'), '## Story\n\n- anchors: module:src/auth, file:src/auth/x.ts\n');
    writeFileSync(join(flow, 'archive', 'plan_auth-sessions_v1.md'), '## Story\n\n- anchors: module:src/stale\n');
    writeFileSync(join(flow, 'discovery', 'discovery_billing_v2.md'), 'prose mentioning module:src/billing here\n');

    const mined = mineCorpus(flow);
    expect(mined.map((c) => c.slug)).toEqual(['auth-sessions', 'billing']);
    // The plan wins; the archived duplicate does not overwrite it.
    expect(mined[0].anchors).toEqual(['file:src/auth/x.ts', 'module:src/auth']);
    expect(mined[0].source).toContain('plans/');
    // Bare refs are the fallback when a doc declares no explicit anchors.
    expect(mined[1].anchors).toEqual(['module:src/billing']);
  });

  it('ignores files that are not corpus documents', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'README.md'), '# not a plan\n');
    expect(mineCorpus(flow)).toEqual([]);
  });
});

describe('code fallback', () => {
  it('proposes only depth-1 modules the corpus did not cover', () => {
    const proposed = codeFallback(graph, new Set(['auth']));
    expect(proposed.map((c) => c.slug)).toEqual(['billing']); // auth covered, nested too deep
  });

  it('yields nothing without a graph', () => {
    expect(codeFallback(null, new Set())).toEqual([]);
  });

  it('never proposes an infrastructure directory as a feature', () => {
    const infra: BlueprintGraph = {
      ...graph,
      nodes: [
        { id: 'module:scripts', kind: 'module', label: 'scripts', sourceFile: 'scripts', meta: {} },
        { id: 'module:docs', kind: 'module', label: 'docs', sourceFile: 'docs', meta: {} },
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: {} },
      ],
    };
    expect(codeFallback(infra, new Set())).toEqual([]);
  });

  it('dedupes two directories that share a basename', () => {
    const dup: BlueprintGraph = {
      ...graph,
      nodes: [
        { id: 'module:auth', kind: 'module', label: 'auth', sourceFile: 'auth', meta: {} },
        { id: 'module:app/auth', kind: 'module', label: 'auth', sourceFile: 'app/auth', meta: {} },
      ],
    };
    expect(codeFallback(dup, new Set()).map((c) => c.slug)).toEqual(['auth']);
  });
});

describe('identity matching — three keys in order', () => {
  const existing = [feature('auth-sessions', ['module:src/auth', 'file:a.ts'])];

  it('matches by id first', () => {
    const match = matchCandidate({ slug: 'auth-sessions', name: 'x', anchors: [], source: 's' }, existing);
    expect(match?.matchedBy).toBe('id');
  });

  it('recovers a RENAMED feature by anchor overlap', () => {
    // Different slug (so id and slug both miss) but the same code.
    const match = matchCandidate(
      { slug: 'sessions-and-auth', name: 'x', anchors: ['module:src/auth', 'file:a.ts'], source: 's' },
      existing,
    );
    expect(match?.matchedBy).toBe('anchors');
    expect(match?.feature.slug).toBe('auth-sessions');
  });

  it('does NOT match below the threshold — a genuinely new feature stays new', () => {
    const match = matchCandidate(
      { slug: 'unrelated', name: 'x', anchors: ['module:src/other', 'file:z.ts', 'file:y.ts'], source: 's' },
      existing,
    );
    expect(match).toBeNull();
  });

  it('treats empty anchor sets as no evidence, never a perfect match', () => {
    expect(anchorJaccard([], [])).toBe(0);
    expect(matchCandidate({ slug: 'nothing', name: 'x', anchors: [], source: 's' }, existing)).toBeNull();
  });

  it('matches exactly AT the threshold', () => {
    // 1 shared of 2 union = 0.5
    expect(anchorJaccard(['a'], ['a', 'b'])).toBe(ANCHOR_JACCARD_THRESHOLD);
    const match = matchCandidate({ slug: 'other', name: 'x', anchors: ['module:src/auth'], source: 's' }, [
      feature('auth-sessions', ['module:src/auth', 'file:a.ts']),
    ]);
    expect(match?.matchedBy).toBe('anchors');
  });
});

describe('discoverFeatures', () => {
  it('updates anchors on a match and NEVER drops one a human added', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_auth-sessions_v1.md'), '## Story\n\n- anchors: module:src/auth\n');
    const existing = [feature('auth-sessions', ['file:human-added.ts'])];

    const result = discoverFeatures(flow, existing, null);
    expect(result.candidates).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].anchors).toEqual(['file:human-added.ts', 'module:src/auth']);
  });

  it('stages an unmatched candidate rather than authoring a feature', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_brand-new_v1.md'), '## Story\n\n- anchors: module:src/new\n');
    const result = discoverFeatures(flow, [], null);
    expect(result.updated).toEqual([]);
    expect(result.candidates.map((c) => c.slug)).toEqual(['brand-new']);
  });

  it('reports no update when a match adds nothing', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_auth_v1.md'), '## Story\n\n- anchors: module:src/auth\n');
    const result = discoverFeatures(flow, [feature('auth', ['module:src/auth'])], null);
    expect(result.updated).toEqual([]);
  });

  it('is deterministic — same inputs yield deep-equal output', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_b_v1.md'), '## Story\n\n- anchors: module:src/b\n');
    writeFileSync(join(flow, 'plans', 'plan_a_v1.md'), '## Story\n\n- anchors: module:src/a\n');
    const once = discoverFeatures(flow, [], graph);
    const twice = discoverFeatures(flow, [], graph);
    expect(once).toEqual(twice);
    expect(once.candidates.map((c) => c.slug)).toEqual([...once.candidates.map((c) => c.slug)].sort());
  });
});

describe('candidate staging', () => {
  it('round-trips and skips corrupt lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cand-'));
    writeCandidates(dir, [{ slug: 'a', name: 'A', anchors: ['module:x'], source: 's' }]);
    expect(readCandidates(dir)).toHaveLength(1);
    writeFileSync(join(dir, 'feature-candidates.jsonl'), '{bad json\n{"slug":"ok","name":"O","anchors":[],"source":"s"}\n');
    expect(readCandidates(dir).map((c) => c.slug)).toEqual(['ok']);
  });

  it('reads empty when nothing is staged', () => {
    expect(readCandidates(mkdtempSync(join(tmpdir(), 'cand-')))).toEqual([]);
  });
});

/**
 * The inversion: surfaces name capabilities (core), the corpus names changes
 * to them (child). Getting this backwards is what put "Chat Session Cache Rework"
 * on the board as a top-level feature.
 */
describe('levels — capability vs change', () => {
  /** A miniature repo whose routes and tests name one capability: chat. */
  function repoNamingChat(): string {
    const root = mkdtempSync(join(tmpdir(), 'feat-repo-'));
    for (const dir of ['src/app/app/chats', 'src/app/api/chat', 'e2e/tests/chats']) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    return root;
  }

  it('proposes a surface capability as CORE', () => {
    const result = discoverFeatures(tempFlow(), [], null, repoNamingChat());
    expect(result.candidates.map((c) => [c.slug, c.kind])).toEqual([['chats', 'core']]);
  });

  it('does NOT promote a corpus to capabilities when nothing names one', () => {
    // THE DEFECT, reproduced. A project whose store has no cores yet used to
    // have every plan and ticket promoted to `core` — and re-runs then saw them
    // as existing capabilities and kept them. On one real project that put
    // "Coderabbit 124545" and "Chat Preenable Hardening" on the board beside
    // Chats and Playbooks.
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_coderabbit-124545_v1.md'), '# Coderabbit\n');
    writeFileSync(join(flow, 'plans', 'plan_chat-preenable-hardening_v1.md'), '# Hardening\n');
    const bare = mkdtempSync(join(tmpdir(), 'feat-bare-'));
    mkdirSync(join(bare, 'src'), { recursive: true });
    const result = discoverFeatures(flow, [], null, bare);
    expect(result.candidates.filter((c) => c.kind === 'core').map((c) => c.slug)).toEqual([]);
    expect(result.candidates.map((c) => c.kind)).toEqual(['child', 'child']);
  });

  it('still gives a corpus-only project a board — from its code, not its tickets', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_coderabbit-124545_v1.md'), '# Coderabbit\n');
    const result = discoverFeatures(flow, [], graph, mkdtempSync(join(tmpdir(), 'feat-bare-')));
    // The documented last resort: top-level code dirs. Coarse, but every name
    // on it is a description of the code.
    expect(result.candidates.filter((c) => c.kind === 'core').map((c) => c.slug).sort()).toEqual([
      'auth',
      'billing',
    ]);
  });

  it('proposes a plan as a CHILD of the capability it touches', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_chat-session-cache-rework_v1.md'), '## Story\n\n- anchors: module:src/x\n');
    const result = discoverFeatures(flow, [], null, repoNamingChat());
    const plan = result.candidates.find((c) => c.slug === 'chat-session-cache-rework');
    expect(plan?.kind).toBe('child');
    expect(plan?.parentSlug).toBe('chats');
  });

  it('leaves a plan unparented rather than guessing a capability', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_deprecate-workflows_v1.md'), '## Story\n\n- anchors: module:src/x\n');
    const result = discoverFeatures(flow, [], null, repoNamingChat());
    const plan = result.candidates.find((c) => c.slug === 'deprecate-workflows');
    expect(plan?.kind).toBe('child');
    expect(plan?.parentSlug).toBeUndefined();
  });

  it('parents to a capability ALREADY in the store, not only to fresh surfaces', () => {
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_billing-retries_v1.md'), '## Story\n\n- anchors: module:src/x\n');
    const existing = [feature('billing', ['module:src/billing'], { kind: 'core' })];
    const result = discoverFeatures(flow, existing, null, repoNamingChat());
    expect(result.candidates.find((c) => c.slug === 'billing-retries')?.parentSlug).toBe('billing');
  });

  it('keeps the corpus a CHANGE even when the repo names no capability at all', () => {
    // SUPERSEDED RULE, kept as its own case. This used to assert the opposite —
    // "a plan is the best name available" — on the premise that an empty board
    // is worse than a coarse one. The premise still holds and is now answered by
    // `codeFallback` (the case above); what changed is that the coarse answer
    // has to describe the CODE. A plan name never did, and the promoted rows
    // then survived every later run as existing capabilities.
    const flow = tempFlow();
    writeFileSync(join(flow, 'plans', 'plan_anything_v1.md'), '## Story\n\n- anchors: module:src/x\n');
    const result = discoverFeatures(flow, [], null, mkdtempSync(join(tmpdir(), 'bare-')));
    expect(result.candidates.map((c) => [c.slug, c.kind])).toEqual([['anything', 'child']]);
  });

  it('does not fall back to code directories once surfaces answered', () => {
    const flow = tempFlow();
    const result = discoverFeatures(flow, [], graph, repoNamingChat());
    expect(result.candidates.map((c) => c.slug)).toEqual(['chats']);
  });
});
