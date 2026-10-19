/**
 * Tests for anchor resolution — per-kind graph resolution rules, ghost
 * (proposal) resolution for the story layer, lifecycle-state gating
 * (proposed/accepted resolve; rejected/stale/cleared/confirmed do not),
 * null-graph behavior, and backward compatibility of every existing
 * two-argument `resolveAnchor` call shape.
 */

import {
  anchorFromEndpoint,
  anchorFromFile,
  anchorFromModule,
  anchorFromSymbol,
  anchorFromTable,
  resolveAnchor,
  resolveStoryAnchors,
} from './anchors.js';
import type { EffectiveProposal, ProposalEventName } from './proposal-store.js';
import type { Anchor, BlueprintGraph, BlueprintNode } from './types.js';

// ── Helpers ──────────────────────────────────────────────

function makeGraph(nodes: BlueprintNode[]): BlueprintGraph {
  return {
    version: 1,
    derivedAt: '2026-07-15T00:00:00.000Z',
    coverage: { filesScanned: 0, filesTotal: 0, extractorsRun: [], graphifyEnriched: false },
    nodes,
    edges: [],
  };
}

function makeProposal(predictedNodeId: string, state: ProposalEventName): EffectiveProposal {
  const kind = predictedNodeId.startsWith('endpoint:') ? 'endpoint' : 'module';
  return {
    fingerprint: `plan-x+${predictedNodeId}`,
    plan: 'plan-x',
    predictedNodeId,
    kind,
    label: predictedNodeId,
    anchors: [],
    state,
    provenance: 'cli:propose',
    proposedAt: '2026-07-15T00:00:00.000Z',
  };
}

const MODULE_NODE: BlueprintNode = {
  id: 'module:src/cli',
  kind: 'module',
  label: 'cli',
  sourceFile: 'src/cli',
};

const ENDPOINT_NODE: BlueprintNode = {
  id: 'endpoint:GET /users',
  kind: 'endpoint',
  label: 'GET /users',
  sourceFile: 'src/api/users.ts',
};

const DATASTORE_NODE: BlueprintNode = {
  id: 'datastore:src/db.ts',
  kind: 'datastore',
  label: 'db',
  sourceFile: 'src/db.ts',
  meta: { tables: ['users'] },
};

const SYMBOL_NODE: BlueprintNode = {
  id: 'integration:src/api/stripe.ts:chargeCard',
  kind: 'integration',
  label: 'chargeCard',
  sourceFile: 'src/api/stripe.ts',
  symbol: 'chargeCard',
};

describe('resolveAnchor', () => {
  // ── Backward compat: two-argument (graph-only) shapes ────

  it('should resolve a symbol anchor against a node symbol (two-arg shape)', () => {
    const graph = makeGraph([SYMBOL_NODE]);
    expect(resolveAnchor(anchorFromSymbol('chargeCard'), graph)).toBe(true);
    expect(resolveAnchor(anchorFromSymbol('missing'), graph)).toBe(false);
  });

  it('should resolve a file anchor per fileMatchesNode containment (two-arg shape)', () => {
    const graph = makeGraph([MODULE_NODE]);
    expect(resolveAnchor(anchorFromFile('src/cli/blueprint/store.ts'), graph)).toBe(true);
    expect(resolveAnchor(anchorFromFile('app/other.ts'), graph)).toBe(false);
  });

  it('should resolve a table anchor against datastore meta.tables (two-arg shape)', () => {
    const graph = makeGraph([DATASTORE_NODE]);
    expect(resolveAnchor(anchorFromTable('users'), graph)).toBe(true);
    expect(resolveAnchor(anchorFromTable('orders'), graph)).toBe(false);
  });

  it('should resolve an endpoint anchor against id `endpoint:<ref>` (two-arg shape)', () => {
    const graph = makeGraph([ENDPOINT_NODE]);
    expect(resolveAnchor(anchorFromEndpoint('GET /users'), graph)).toBe(true);
    expect(resolveAnchor(anchorFromEndpoint('DELETE /users'), graph)).toBe(false);
  });

  it('should resolve a module anchor via path id, legacy label, or sourceFile (two-arg shape)', () => {
    const graph = makeGraph([MODULE_NODE]);
    expect(resolveAnchor(anchorFromModule('src/cli'), graph)).toBe(true);
    expect(resolveAnchor(anchorFromModule('cli'), graph)).toBe(true);
    expect(resolveAnchor(anchorFromModule('ghost'), graph)).toBe(false);
  });

  it('should not resolve an unknown anchor kind (forward-compat data)', () => {
    const anchor = { kind: 'mystery', ref: 'anything' } as unknown as Anchor;
    expect(resolveAnchor(anchor, makeGraph([MODULE_NODE]))).toBe(false);
  });

  // ── Ghost resolution per kind ────────────────────────────

  it('should resolve an endpoint anchor against a proposed ghost `endpoint:<ref>`', () => {
    const graph = makeGraph([]);
    const proposals = [makeProposal('endpoint:POST /stories', 'proposed')];
    expect(resolveAnchor(anchorFromEndpoint('POST /stories'), graph, proposals)).toBe(true);
    expect(resolveAnchor(anchorFromEndpoint('GET /stories'), graph, proposals)).toBe(false);
  });

  it('should resolve a module anchor against a proposed ghost `module:<ref>`', () => {
    const graph = makeGraph([]);
    const proposals = [makeProposal('module:src/story', 'proposed')];
    expect(resolveAnchor(anchorFromModule('src/story'), graph, proposals)).toBe(true);
    expect(resolveAnchor(anchorFromModule('src/other'), graph, proposals)).toBe(false);
  });

  it('should never resolve table anchors against ghosts — proposals carry no tables', () => {
    const proposals = [makeProposal('module:src/story', 'proposed')];
    expect(resolveAnchor(anchorFromTable('src/story'), makeGraph([]), proposals)).toBe(false);
  });

  it('should never resolve symbol anchors against ghosts — proposals carry no symbols', () => {
    const proposals = [makeProposal('module:src/story', 'proposed')];
    expect(resolveAnchor(anchorFromSymbol('src/story'), makeGraph([]), proposals)).toBe(false);
  });

  it('should never resolve file anchors against ghosts — proposals are not files', () => {
    const proposals = [makeProposal('module:src/story', 'proposed')];
    expect(resolveAnchor(anchorFromFile('src/story'), makeGraph([]), proposals)).toBe(false);
  });

  // ── Lifecycle-state gating ───────────────────────────────

  it.each<ProposalEventName>(['proposed', 'accepted'])(
    'should resolve against a ghost in the %s state',
    (state) => {
      const proposals = [makeProposal('module:src/story', state)];
      expect(resolveAnchor(anchorFromModule('src/story'), makeGraph([]), proposals)).toBe(true);
    },
  );

  it.each<ProposalEventName>(['rejected', 'stale', 'cleared', 'confirmed'])(
    'should NOT resolve against a ghost in the %s state',
    (state) => {
      const proposals = [makeProposal('module:src/story', state)];
      expect(resolveAnchor(anchorFromModule('src/story'), makeGraph([]), proposals)).toBe(false);
    },
  );

  it('should keep graph resolution working when proposals are also supplied', () => {
    const graph = makeGraph([MODULE_NODE]);
    const proposals = [makeProposal('module:src/story', 'rejected')];
    expect(resolveAnchor(anchorFromModule('src/cli'), graph, proposals)).toBe(true);
  });
});

describe('resolveStoryAnchors', () => {
  it('should resolve against the graph first, reporting target node and its id', () => {
    const graph = makeGraph([MODULE_NODE]);
    // A ghost that ALSO matches — graph must win
    const proposals = [makeProposal('module:src/cli', 'proposed')];

    const results = resolveStoryAnchors([anchorFromModule('src/cli')], graph, proposals);

    expect(results).toEqual([
      {
        anchor: anchorFromModule('src/cli'),
        resolved: true,
        target: 'node',
        targetId: 'module:src/cli',
      },
    ]);
  });

  it('should fall back to ghosts when the graph has no match, reporting the predicted id', () => {
    const graph = makeGraph([MODULE_NODE]);
    const proposals = [makeProposal('endpoint:POST /stories', 'accepted')];

    const results = resolveStoryAnchors([anchorFromEndpoint('POST /stories')], graph, proposals);

    expect(results).toEqual([
      {
        anchor: anchorFromEndpoint('POST /stories'),
        resolved: true,
        target: 'ghost',
        targetId: 'endpoint:POST /stories',
      },
    ]);
  });

  it('should report unresolved anchors with null target and targetId', () => {
    const results = resolveStoryAnchors([anchorFromModule('ghost')], makeGraph([]), []);

    expect(results).toEqual([
      { anchor: anchorFromModule('ghost'), resolved: false, target: null, targetId: null },
    ]);
  });

  it('should apply only ghost resolution when the graph is null', () => {
    const proposals = [makeProposal('module:src/story', 'proposed')];

    const results = resolveStoryAnchors(
      [anchorFromModule('src/story'), anchorFromModule('src/cli')],
      null,
      proposals,
    );

    expect(results).toEqual([
      {
        anchor: anchorFromModule('src/story'),
        resolved: true,
        target: 'ghost',
        targetId: 'module:src/story',
      },
      { anchor: anchorFromModule('src/cli'), resolved: false, target: null, targetId: null },
    ]);
  });

  it('should not resolve dead ghosts under a null graph', () => {
    const proposals = [makeProposal('module:src/story', 'cleared')];

    const results = resolveStoryAnchors([anchorFromModule('src/story')], null, proposals);

    expect(results[0]).toEqual({
      anchor: anchorFromModule('src/story'),
      resolved: false,
      target: null,
      targetId: null,
    });
  });

  it('should preserve anchor order deterministically across mixed targets', () => {
    const graph = makeGraph([ENDPOINT_NODE]);
    const proposals = [makeProposal('module:src/story', 'accepted')];

    const results = resolveStoryAnchors(
      [anchorFromEndpoint('GET /users'), anchorFromModule('src/story'), anchorFromTable('nope')],
      graph,
      proposals,
    );

    expect(results.map((entry) => entry.target)).toEqual(['node', 'ghost', null]);
    expect(results.map((entry) => entry.targetId)).toEqual([
      'endpoint:GET /users',
      'module:src/story',
      null,
    ]);
  });
});
