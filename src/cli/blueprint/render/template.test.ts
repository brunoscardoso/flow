/**
 * Tests for the title-sheet layout (`layoutTitleSheet`) and HTML renderer
 * (`renderBlueprintHtml`) — column caps with explicit overflow, CLI-surface
 * summarization, endpoint count chips, visible-edge reduction, byte-identical
 * determinism, XSS escaping, dual-theme blocks, stale-claim strikethrough,
 * and self-containment (no external URLs).
 */

import { CLI_COMMAND_CAP, COLUMN_NODE_CAP, layoutTitleSheet } from './layout.js';
import { renderBlueprintHtml, type RenderBlueprintInput } from './template.js';
import type { AnnotationEntry, BlueprintGraph, BlueprintNode } from '../types.js';

// ── Shared fixtures ────────────────────────────────────────

function makeNode(overrides: Partial<BlueprintNode> & Pick<BlueprintNode, 'id' | 'kind'>): BlueprintNode {
  return {
    label: overrides.id,
    sourceFile: 'src/fixture.ts',
    ...overrides,
  };
}

function makeGraph(nodes: BlueprintNode[], edges: BlueprintGraph['edges'] = []): BlueprintGraph {
  return {
    version: 1,
    derivedAt: '2026-07-09T00:00:00.000Z',
    coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['modules'], graphifyEnriched: false },
    nodes,
    edges,
  };
}

function makeAnnotation(overrides: Partial<AnnotationEntry> = {}): AnnotationEntry {
  return {
    ts: '2026-07-09T00:00:00.000Z',
    runId: 'run-1',
    type: 'claim',
    text: 'a recorded claim',
    anchors: [{ kind: 'module', ref: 'core' }],
    provenance: 'test',
    status: 'active',
    ...overrides,
  };
}

function makeRenderInput(graph: BlueprintGraph, overrides: Partial<RenderBlueprintInput> = {}): RenderBlueprintInput {
  return {
    graph,
    prevGraph: null,
    annotations: [],
    layout: layoutTitleSheet(graph),
    projectName: 'fixture-project',
    planContext: null,
    timeline: [],
    ...overrides,
  };
}

// ── layoutTitleSheet ───────────────────────────────────────

describe('layoutTitleSheet', () => {
  it('should cap columns at COLUMN_NODE_CAP with an explicit moreCount', () => {
    const integrations = Array.from({ length: 10 }, (_, index) =>
      makeNode({ id: `integration:svc-${index}`, kind: 'integration', meta: { degree: index } }),
    );

    const layout = layoutTitleSheet(makeGraph(integrations));
    const column = layout.columns.find((candidate) => candidate.key === 'integrations');

    expect(column?.entries).toHaveLength(COLUMN_NODE_CAP);
    expect(column?.moreCount).toBe(10 - COLUMN_NODE_CAP);
    expect(column?.totalCount).toBe(10);
  });

  it('should select column entries by degree descending, then id ascending', () => {
    const nodes = [
      makeNode({ id: 'integration:b-low', kind: 'integration', meta: { degree: 1 } }),
      makeNode({ id: 'integration:a-low', kind: 'integration', meta: { degree: 1 } }),
      makeNode({ id: 'integration:z-high', kind: 'integration', meta: { degree: 9 } }),
    ];

    const layout = layoutTitleSheet(makeGraph(nodes));
    const column = layout.columns.find((candidate) => candidate.key === 'integrations');
    const ids = column?.entries.map((entry) => (entry.type === 'node' ? entry.node.id : entry.label));

    expect(ids).toEqual(['integration:z-high', 'integration:a-low', 'integration:b-low']);
  });

  it('should roll CLI endpoints into one capped cli-surface pseudo-entry', () => {
    const cliEndpoints = Array.from({ length: 10 }, (_, index) =>
      makeNode({
        id: `endpoint:cli cmd-${String(index).padStart(2, '0')}`,
        kind: 'endpoint',
        meta: { route: `cmd-${String(index).padStart(2, '0')}` },
      }),
    );

    const layout = layoutTitleSheet(makeGraph(cliEndpoints));
    const dataColumn = layout.columns.find((candidate) => candidate.key === 'data');
    const cliSurface = dataColumn?.entries.find((entry) => entry.type === 'cli-surface');

    expect(cliSurface).toBeDefined();
    if (cliSurface?.type !== 'cli-surface') {
      throw new Error('expected a cli-surface entry');
    }
    expect(cliSurface.commands).toHaveLength(CLI_COMMAND_CAP);
    expect(cliSurface.commands[0]).toBe('cmd-00');
    expect(cliSurface.moreCommandCount).toBe(10 - CLI_COMMAND_CAP);
    expect(cliSurface.totalCommandCount).toBe(10);
  });

  it('should put HTTP endpoint count chips on the owning module via exposes edges (CLI excluded)', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'module:api', kind: 'module' }),
        makeNode({ id: 'endpoint:GET /users', kind: 'endpoint' }),
        makeNode({ id: 'endpoint:POST /users', kind: 'endpoint' }),
        makeNode({ id: 'endpoint:cli init', kind: 'endpoint', meta: { route: 'init' } }),
      ],
      [
        { source: 'module:api', target: 'endpoint:GET /users', relation: 'exposes' },
        { source: 'module:api', target: 'endpoint:POST /users', relation: 'exposes' },
        { source: 'module:api', target: 'endpoint:cli init', relation: 'exposes' },
      ],
    );

    const layout = layoutTitleSheet(graph);
    const modulesColumn = layout.columns.find((candidate) => candidate.key === 'modules');
    const moduleEntry = modulesColumn?.entries[0];

    expect(moduleEntry?.type).toBe('node');
    if (moduleEntry?.type !== 'node') {
      throw new Error('expected a node entry');
    }
    expect(moduleEntry.endpointCount).toBe(2);
  });

  it('should show only depth-1 folder nodes in the module column (missing depth = 1)', () => {
    const graph = makeGraph([
      makeNode({ id: 'module:src/cli', kind: 'module', sourceFile: 'src/cli', meta: { depth: 1 } }),
      makeNode({ id: 'module:src/cli/blueprint', kind: 'module', sourceFile: 'src/cli/blueprint', meta: { depth: 2 } }),
      makeNode({ id: 'module:src/cli/blueprint/render', kind: 'module', sourceFile: 'src/cli/blueprint/render', meta: { depth: 3 } }),
      // Pre-hierarchy graphs have no depth meta — treated as depth 1
      makeNode({ id: 'module:legacy', kind: 'module', sourceFile: 'src/legacy' }),
    ]);

    const layout = layoutTitleSheet(graph);
    const modulesColumn = layout.columns.find((candidate) => candidate.key === 'modules');
    const ids = modulesColumn?.entries.map((entry) => (entry.type === 'node' ? entry.node.id : entry.label));

    expect(ids).toEqual(['module:legacy', 'module:src/cli']);
    expect(modulesColumn?.totalCount).toBe(2);
    expect(layout.visibleNodeIds).not.toContain('module:src/cli/blueprint');
  });

  it('should roll endpoint count chips up from nested folder nodes to their depth-1 ancestor', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'module:src/api', kind: 'module', sourceFile: 'src/api', meta: { depth: 1 } }),
        makeNode({ id: 'module:src/api/handlers', kind: 'module', sourceFile: 'src/api/handlers', meta: { depth: 2 } }),
        makeNode({ id: 'endpoint:GET /users', kind: 'endpoint' }),
        makeNode({ id: 'endpoint:POST /users', kind: 'endpoint' }),
      ],
      [
        // Deepest attribution: exposes edges hang off the nested folder node
        { source: 'module:src/api/handlers', target: 'endpoint:GET /users', relation: 'exposes' },
        { source: 'module:src/api/handlers', target: 'endpoint:POST /users', relation: 'exposes' },
      ],
    );

    const layout = layoutTitleSheet(graph);
    const modulesColumn = layout.columns.find((candidate) => candidate.key === 'modules');
    const moduleEntry = modulesColumn?.entries[0];

    if (moduleEntry?.type !== 'node') {
      throw new Error('expected a node entry');
    }
    expect(moduleEntry.node.id).toBe('module:src/api');
    expect(moduleEntry.endpointCount).toBe(2);
  });

  it('should reduce visibleEdges to the visible node set', () => {
    const graph = makeGraph(
      [
        makeNode({ id: 'module:api', kind: 'module' }),
        makeNode({ id: 'integration:stripe', kind: 'integration' }),
        makeNode({ id: 'endpoint:GET /users', kind: 'endpoint' }), // HTTP endpoints are not column nodes
      ],
      [
        { source: 'module:api', target: 'integration:stripe', relation: 'uses' },
        { source: 'module:api', target: 'endpoint:GET /users', relation: 'exposes' },
      ],
    );

    const layout = layoutTitleSheet(graph);

    expect(layout.visibleNodeIds.sort()).toEqual(['integration:stripe', 'module:api']);
    expect(layout.visibleEdges).toEqual([{ source: 'module:api', target: 'integration:stripe', relation: 'uses' }]);
  });
});

// ── renderBlueprintHtml ────────────────────────────────────

describe('renderBlueprintHtml', () => {
  const BASE_GRAPH = makeGraph([
    makeNode({ id: 'module:core', kind: 'module', label: 'core', sourceFile: 'src/core' }),
    makeNode({ id: 'integration:stripe', kind: 'integration', label: 'Stripe', sourceFile: 'src/core/pay.ts' }),
  ]);

  it('should be deterministic — two renders of the same input are byte-identical', () => {
    const input = makeRenderInput(BASE_GRAPH, {
      annotations: [makeAnnotation()],
      timeline: [
        { runId: 'run-1', label: 'feature-a' },
        { runId: 'run-2', label: 'current' },
      ],
    });

    expect(renderBlueprintHtml(input)).toBe(renderBlueprintHtml(input));
  });

  it('should escape untrusted node labels and annotation text', () => {
    const graph = makeGraph([
      makeNode({
        id: 'module:evil',
        kind: 'module',
        label: '<script>alert(1)</script>',
        sourceFile: 'src/evil',
      }),
    ]);
    const html = renderBlueprintHtml(
      makeRenderInput(graph, {
        annotations: [
          makeAnnotation({
            text: '<img src=x onerror=alert(2)>',
            anchors: [{ kind: 'module', ref: 'evil' }],
          }),
        ],
      }),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('should render explicit overflow lines from layout moreCounts', () => {
    const integrations = Array.from({ length: COLUMN_NODE_CAP + 3 }, (_, index) =>
      makeNode({ id: `integration:svc-${String(index).padStart(2, '0')}`, kind: 'integration' }),
    );
    const html = renderBlueprintHtml(makeRenderInput(makeGraph(integrations)));

    expect(html).toContain('…and 3 more integrations');
    // Overflow is also surfaced in the coverage footer — never silent
    expect(html).toContain('sheet overflow: …and 3 more integrations');
  });

  it('should render the CLI-surface command overflow line', () => {
    const cliEndpoints = Array.from({ length: CLI_COMMAND_CAP + 2 }, (_, index) =>
      makeNode({
        id: `endpoint:cli cmd-${String(index).padStart(2, '0')}`,
        kind: 'endpoint',
        meta: { route: `cmd-${String(index).padStart(2, '0')}` },
      }),
    );
    const html = renderBlueprintHtml(makeRenderInput(makeGraph(cliEndpoints)));

    expect(html).toContain('…and 2 more command(s)');
  });

  it('should include both dual-theme blocks (media query + data-theme overrides)', () => {
    const html = renderBlueprintHtml(makeRenderInput(BASE_GRAPH));

    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain(':root[data-theme="light"]');
  });

  it('should render stale claims with the strikethrough stale class', () => {
    const html = renderBlueprintHtml(
      makeRenderInput(BASE_GRAPH, {
        annotations: [
          makeAnnotation({ status: 'stale', text: 'a stale claim', anchors: [{ kind: 'module', ref: 'core' }] }),
        ],
      }),
    );

    expect(html).toContain('claim claim-stale');
    expect(html).toContain('STALE — anchor no longer resolves in the current derive');
    // The stale class strikes through the claim text via CSS
    expect(html).toMatch(/\.claim\.claim-stale \.claim-text \{ text-decoration: line-through/);
  });

  it('should contain no external URLs or remote references', () => {
    const html = renderBlueprintHtml(
      makeRenderInput(BASE_GRAPH, {
        annotations: [makeAnnotation()],
        timeline: [{ runId: 'run-1', label: 'current' }],
      }),
    );

    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toMatch(/\b(?:src|href)\s*=\s*["']/);
  });

  it('should mark only the last timeline entry as CURRENT', () => {
    const html = renderBlueprintHtml(
      makeRenderInput(BASE_GRAPH, {
        timeline: [
          { runId: 'run-1', label: 'feature-a' },
          { runId: 'run-2', label: 'feature-b' },
        ],
      }),
    );

    expect(html.split('CURRENT')).toHaveLength(2); // exactly one occurrence
    expect(html.indexOf('CURRENT')).toBeGreaterThan(html.indexOf('run-2'));
  });

  it('should mark nodes absent from the previous derive with a NEW chip', () => {
    const prevGraph = makeGraph([makeNode({ id: 'module:core', kind: 'module', sourceFile: 'src/core' })]);
    const html = renderBlueprintHtml(makeRenderInput(BASE_GRAPH, { prevGraph }));

    expect(html.split('>NEW<')).toHaveLength(2); // only integration:stripe is new
  });
});
