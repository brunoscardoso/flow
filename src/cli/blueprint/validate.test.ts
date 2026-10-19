/**
 * Tests for the canonical schema validator (`validateCanonicalGraph`) — every
 * frozen invariant violated in isolation produces its precise error string,
 * multi-error graphs report every violation sorted, valid graphs (including
 * multi-root spines and the `basic` fallback extractor set) pass, and the
 * validator is pure and deterministic.
 */

import {
  DUAL_SOURCE_EXTRACTORS,
  FALLBACK_EXTRACTORS,
  FROZEN_EDGE_RELATIONS,
  FROZEN_EXTRACTORS,
  FROZEN_NODE_KINDS,
  MODULE_ID_PREFIX,
  validateCanonicalGraph,
} from './validate.js';
import type { BlueprintEdge, BlueprintGraph, BlueprintNode } from './types.js';

/** A module node following every convention: path id, dir sourceFile, depth. */
function moduleNode(dir: string, depth: number): BlueprintNode {
  return {
    id: `${MODULE_ID_PREFIX}${dir}`,
    kind: 'module',
    label: dir.includes('/') ? dir.slice(dir.lastIndexOf('/') + 1) : dir,
    sourceFile: dir,
    meta: { depth, childDirs: 0, fileCount: 1 },
  };
}

/**
 * A valid real-shaped graph with TWO depth-1 spine roots (`src` and
 * `app/src`) — multi-root repos are legal, so the base fixture exercises the
 * no-single-root-assumption path directly.
 */
function buildValidGraph(): BlueprintGraph {
  const nodes: BlueprintNode[] = [
    moduleNode('src', 1),
    moduleNode('src/cli', 2),
    moduleNode('app/src', 1),
    moduleNode('app/src/main', 2),
    {
      id: 'endpoint:GET /users',
      kind: 'endpoint',
      label: 'GET /users',
      sourceFile: 'src/cli/server.ts',
      meta: { method: 'GET', route: '/users' },
    },
    { id: 'integration:stripe', kind: 'integration', label: 'Stripe', sourceFile: 'package.json' },
    { id: 'datastore:sqlite', kind: 'datastore', label: 'sqlite', sourceFile: 'package.json' },
  ];
  const edges: BlueprintEdge[] = [
    { source: 'module:src', target: 'module:src/cli', relation: 'contains' },
    { source: 'module:app/src', target: 'module:app/src/main', relation: 'contains' },
    { source: 'module:src/cli', target: 'endpoint:GET /users', relation: 'exposes' },
    { source: 'module:src/cli', target: 'integration:stripe', relation: 'uses' },
    { source: 'module:app/src/main', target: 'datastore:sqlite', relation: 'uses' },
    { source: 'module:src/cli', target: 'module:app/src/main', relation: 'imports' },
  ];
  return {
    version: 1,
    derivedAt: '2026-07-09T00:00:00.000Z',
    coverage: {
      filesScanned: 4,
      filesTotal: 4,
      extractorsRun: [...FROZEN_EXTRACTORS],
      graphifyEnriched: false,
    },
    nodes,
    edges,
  };
}

describe('validateCanonicalGraph', () => {
  // ── Valid graphs ─────────────────────────────────────────

  it('should accept a valid real-shaped graph with two depth-1 spine roots', () => {
    const result = validateCanonicalGraph(buildValidGraph());

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('should accept extractorsRun order-insensitively', () => {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = ['modules', 'datastores', 'integrations', 'endpoints'];

    expect(validateCanonicalGraph(graph).ok).toBe(true);
  });

  it("should accept the ['basic'] fallback extractor set", () => {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = [...FALLBACK_EXTRACTORS];

    expect(validateCanonicalGraph(graph).ok).toBe(true);
  });

  it('should accept the dual-source backbone extractor set', () => {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = [...DUAL_SOURCE_EXTRACTORS];

    expect(validateCanonicalGraph(graph)).toEqual({ ok: true, errors: [] });
  });

  it('should accept an empty graph (no nodes, no edges)', () => {
    const graph = buildValidGraph();
    graph.nodes = [];
    graph.edges = [];

    expect(validateCanonicalGraph(graph)).toEqual({ ok: true, errors: [] });
  });

  // ── Coverage invariant ───────────────────────────────────

  it('should reject an unknown extractor set with the precise error', () => {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = ['bespoke'];

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        'coverage.extractorsRun [bespoke] matches none of the frozen extractor set [integrations, endpoints, datastores, modules], the dual-source backbone set [graphify, integrations, endpoints, datastores, modules], the fallback set [basic], or their convention-pack extensions (+ [nextjs, graphql, fastapi])',
      ],
    });
  });

  it('should reject a MIXTURE of native and fallback extractors', () => {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = ['basic', 'integrations', 'endpoints', 'datastores', 'modules'];

    const result = validateCanonicalGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      'coverage.extractorsRun [basic, integrations, endpoints, datastores, modules] matches none of the frozen extractor set [integrations, endpoints, datastores, modules], the dual-source backbone set [graphify, integrations, endpoints, datastores, modules], the fallback set [basic], or their convention-pack extensions (+ [nextjs, graphql, fastapi])',
    ]);
  });

  it('should reject a MIXTURE of dual-source and fallback extractors', () => {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = [...DUAL_SOURCE_EXTRACTORS, 'basic'];

    const result = validateCanonicalGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('coverage.extractorsRun [graphify, integrations, endpoints, datastores, modules, basic]');
  });

  it('should reject a partial native extractor set', () => {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = ['integrations', 'endpoints'];

    const result = validateCanonicalGraph(graph);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('coverage.extractorsRun [integrations, endpoints]');
  });

  // ── Node invariants ──────────────────────────────────────

  it('should reject a node kind outside the frozen enum with the precise error', () => {
    const graph = buildValidGraph();
    graph.nodes.push({ id: 'ghost:1', kind: 'ghost' as never, label: 'ghost', sourceFile: 'x.ts' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        "node 'ghost:1' has kind 'ghost' outside the frozen enum [datastore, endpoint, integration, module]",
      ],
    });
  });

  it('should reject duplicate node ids with an occurrence count', () => {
    const graph = buildValidGraph();
    graph.nodes.push(moduleNode('src', 1));

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: ["duplicate node id 'module:src' (2 occurrences)"],
    });
  });

  // ── Edge invariants ──────────────────────────────────────

  it('should reject a dangling edge target with the precise error', () => {
    const graph = buildValidGraph();
    graph.edges.push({ source: 'module:src', target: 'integration:gone', relation: 'uses' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        "edge 'module:src -> integration:gone' (uses) references missing target node 'integration:gone'",
      ],
    });
  });

  it('should reject a dangling edge source with the precise error', () => {
    const graph = buildValidGraph();
    graph.edges.push({ source: 'module:phantom', target: 'module:src', relation: 'imports' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        "edge 'module:phantom -> module:src' (imports) references missing source node 'module:phantom'",
      ],
    });
  });

  it('should reject a relation outside the frozen vocabulary with the precise error', () => {
    const graph = buildValidGraph();
    graph.edges.push({ source: 'module:src', target: 'module:src/cli', relation: 'reads' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        "edge 'module:src -> module:src/cli' (reads) has relation 'reads' outside the frozen set [calls, contains, exposes, imports, uses]",
      ],
    });
  });

  // ── Module spine invariants ──────────────────────────────

  it('should reject a module id violating the module:<sourceFile> convention', () => {
    const graph = buildValidGraph();
    // Standalone bad module (no edges reference it) — the id error in isolation
    graph.nodes.push({
      id: 'module:oops',
      kind: 'module',
      label: 'oops',
      sourceFile: 'src/oops',
      meta: { depth: 2 },
    });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: ["module node 'module:oops' violates the id convention — expected 'module:src/oops'"],
    });
  });

  it.each([
    [0, '0'],
    [17, '17'],
    [2.5, '2.5'],
  ])('should reject module meta.depth %p as outside 1..16 or non-integer', (depth, rendered) => {
    const graph = buildValidGraph();
    graph.nodes.push({
      id: 'module:src/bad',
      kind: 'module',
      label: 'bad',
      sourceFile: 'src/bad',
      meta: { depth },
    });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        `module node 'module:src/bad' has invalid meta.depth ${rendered} — expected an integer in 1..16`,
      ],
    });
  });

  // The ceiling bounds CORRUPTION, not policy. Capability directories are
  // pinned past the extractor's default depth cap of 4 on purpose, so a depth-5
  // module is legal — mirroring the cap here once made every real derive fail
  // hard and write nothing.
  it('should accept a module deeper than the extractor default depth cap', () => {
    const graph = buildValidGraph();
    // src/cli is depth 2 — extend the chain to a pinned capability at depth 5.
    graph.nodes.push(
      moduleNode('src/cli/app', 3),
      moduleNode('src/cli/app/(protected)', 4),
      moduleNode('src/cli/app/(protected)/playbooks', 5),
    );
    graph.edges.push(
      { source: 'module:src/cli', target: 'module:src/cli/app', relation: 'contains' },
      { source: 'module:src/cli/app', target: 'module:src/cli/app/(protected)', relation: 'contains' },
      {
        source: 'module:src/cli/app/(protected)',
        target: 'module:src/cli/app/(protected)/playbooks',
        relation: 'contains',
      },
    );

    expect(validateCanonicalGraph(graph)).toEqual({ ok: true, errors: [] });
  });

  it('should reject a module node with no depth at all', () => {
    const graph = buildValidGraph();
    graph.nodes.push({ id: 'module:src/bare', kind: 'module', label: 'bare', sourceFile: 'src/bare' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        "module node 'module:src/bare' has invalid meta.depth undefined — expected an integer in 1..16",
      ],
    });
  });

  it('should reject a contains edge touching a non-module node', () => {
    const graph = buildValidGraph();
    graph.edges.push({ source: 'module:src/cli', target: 'endpoint:GET /users', relation: 'contains' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        "contains edge 'module:src/cli -> endpoint:GET /users' connects non-module node(s) — contains is module-to-module only",
      ],
    });
  });

  it('should reject a contains edge whose child directory is not under the parent', () => {
    const graph = buildValidGraph();
    // Depths 1 → 2 are consistent, so ONLY the path violation is reported
    graph.edges.push({ source: 'module:src', target: 'module:app/src/main', relation: 'contains' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: [
        "contains edge 'module:src -> module:app/src/main' child directory 'app/src/main' is not under parent directory 'src'",
      ],
    });
  });

  it('should reject a contains edge whose child depth is not parent depth + 1', () => {
    const graph = buildValidGraph();
    graph.nodes.push(moduleNode('src/cli/deep', 4)); // path-legal child of src/cli, but skips depth 3
    graph.edges.push({ source: 'module:src/cli', target: 'module:src/cli/deep', relation: 'contains' });

    expect(validateCanonicalGraph(graph)).toEqual({
      ok: false,
      errors: ["contains edge 'module:src/cli -> module:src/cli/deep' child depth 4 is not parent depth 2 + 1"],
    });
  });

  it('should report ONE error for a bad depth, not a cascade into the depth-pair check', () => {
    const graph = buildValidGraph();
    const src = graph.nodes.find((node) => node.id === 'module:src') as BlueprintNode;
    src.meta = { ...src.meta, depth: 0 }; // src contains src/cli — pair check must be skipped

    const result = validateCanonicalGraph(graph);

    expect(result.errors).toEqual([
      "module node 'module:src' has invalid meta.depth 0 — expected an integer in 1..16",
    ]);
  });

  it('should detect a contains cycle via Kahn peeling, reporting every stuck module', () => {
    const graph = buildValidGraph();
    graph.nodes.push(moduleNode('cyc', 1), moduleNode('cyc/inner', 2));
    graph.edges.push(
      { source: 'module:cyc', target: 'module:cyc/inner', relation: 'contains' },
      { source: 'module:cyc/inner', target: 'module:cyc', relation: 'contains' },
    );

    const result = validateCanonicalGraph(graph);

    expect(result.ok).toBe(false);
    // A 2-cycle necessarily also violates path/depth rules on the back edge;
    // the cycle detector still reports EVERY module stuck on the cycle.
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "contains cycle detected — module 'module:cyc' is on or downstream of a cycle",
        "contains cycle detected — module 'module:cyc/inner' is on or downstream of a cycle",
      ]),
    );
  });

  // ── Multi-error reporting and determinism ────────────────

  function buildMultiErrorGraph(): BlueprintGraph {
    const graph = buildValidGraph();
    graph.coverage.extractorsRun = ['bespoke'];
    graph.nodes.push({ id: 'ghost:1', kind: 'ghost' as never, label: 'ghost', sourceFile: 'x.ts' });
    graph.nodes.push(moduleNode('app/src', 1)); // duplicate id
    graph.edges.push({ source: 'module:src', target: 'missing:n', relation: 'uses' });
    graph.edges.push({ source: 'module:src', target: 'module:src/cli', relation: 'reads' });
    return graph;
  }

  it('should report every violation of a multi-error graph as a sorted list', () => {
    const result = validateCanonicalGraph(buildMultiErrorGraph());

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      [
        'coverage.extractorsRun [bespoke] matches none of the frozen extractor set [integrations, endpoints, datastores, modules], the dual-source backbone set [graphify, integrations, endpoints, datastores, modules], the fallback set [basic], or their convention-pack extensions (+ [nextjs, graphql, fastapi])',
        "node 'ghost:1' has kind 'ghost' outside the frozen enum [datastore, endpoint, integration, module]",
        "duplicate node id 'module:app/src' (2 occurrences)",
        "edge 'module:src -> missing:n' (uses) references missing target node 'missing:n'",
        "edge 'module:src -> module:src/cli' (reads) has relation 'reads' outside the frozen set [calls, contains, exposes, imports, uses]",
      ].sort(),
    );
    // Errors come back pre-sorted — deterministic ordering is part of the contract
    expect(result.errors).toEqual([...result.errors].sort());
  });

  it('should be deterministic — the same input twice yields identical error arrays', () => {
    const first = validateCanonicalGraph(buildMultiErrorGraph());
    const second = validateCanonicalGraph(buildMultiErrorGraph());

    expect(second).toEqual(first);
    expect(JSON.stringify(second.errors)).toBe(JSON.stringify(first.errors));
  });

  it('should never mutate the input graph', () => {
    const graph = buildMultiErrorGraph();
    const before = JSON.stringify(graph);

    validateCanonicalGraph(graph);

    expect(JSON.stringify(graph)).toBe(before);
  });

  // ── Frozen constants ─────────────────────────────────────

  it('should expose the frozen contract constants', () => {
    expect(FROZEN_NODE_KINDS).toEqual(['datastore', 'endpoint', 'integration', 'module']);
    expect(FROZEN_EDGE_RELATIONS).toEqual(['calls', 'contains', 'exposes', 'imports', 'uses']);
    expect(FROZEN_EXTRACTORS).toEqual(['integrations', 'endpoints', 'datastores', 'modules']);
    expect(FALLBACK_EXTRACTORS).toEqual(['basic']);
    expect(DUAL_SOURCE_EXTRACTORS).toEqual(['graphify', 'integrations', 'endpoints', 'datastores', 'modules']);
    expect(MODULE_ID_PREFIX).toBe('module:');
    expect(Object.isFrozen(FROZEN_NODE_KINDS)).toBe(true);
    expect(Object.isFrozen(FALLBACK_EXTRACTORS)).toBe(true);
    expect(Object.isFrozen(DUAL_SOURCE_EXTRACTORS)).toBe(true);
  });
});
