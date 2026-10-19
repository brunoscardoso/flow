/**
 * Blueprint prose report — a deterministic graph→prose→search bridge.
 *
 * `renderProseReport` maps ONE structured input (the derived graph) onto a
 * markdown report written to `flow/brain/blueprint-report.md`, which puts the
 * graph into the searched markdown corpus: same graph → same markdown,
 * byte-identical. Hard rules:
 * - NO clock or randomness at render time — and unlike the HTML title sheet,
 *   `graph.derivedAt` is deliberately NOT embedded: the report is a pure
 *   function of nodes/edges/coverage minus the derive timestamp, so repeated
 *   derives of an unchanged repo rewrite an identical file.
 * - NO LLM narration — every line is templated from extractor output.
 * - All lists stable-sorted; every cap emits an explicit "…and K more" line —
 *   no silent truncation.
 */

import { BLUEPRINT_GRAPH_DISPLAY_PATH } from '../store.js';
import type { BlueprintGraph, BlueprintNode, BlueprintNodeKind } from '../types.js';

/** Maximum module nodes listed in the `## Modules` section. */
export const MODULE_REPORT_CAP = 15;

/** Node-kind order for the Structure counts line (canonical, fixed). */
const KIND_ORDER: readonly BlueprintNodeKind[] = ['integration', 'endpoint', 'datastore', 'module'];

/** Placeholder line for a section with no derived nodes. */
const EMPTY_SECTION_LINE = '_none derived_';

/** Codepoint string comparison — locale-independent, deterministic. */
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Numeric degree from a node's meta, or null when absent. */
function degreeOf(node: BlueprintNode): number | null {
  const degree = node.meta?.degree;
  return typeof degree === 'number' ? degree : null;
}

/** Count of `contains` edges leaving a node (its direct children). */
function containsChildrenCount(node: BlueprintNode, graph: BlueprintGraph): number {
  return graph.edges.filter((edge) => edge.relation === 'contains' && edge.source === node.id).length;
}

/**
 * Ranking score for a module node: `meta.degree` when the enrichment ran,
 * otherwise the contains-children count (native fallback). Ties break on id.
 */
function moduleScoreOf(node: BlueprintNode, graph: BlueprintGraph): number {
  const degree = degreeOf(node);
  return degree !== null ? degree : containsChildrenCount(node, graph);
}

/** One `## Modules` line: label, dir, depth/fileCount/degree/community when present. */
function moduleLineOf(node: BlueprintNode): string {
  const parts: string[] = [`- **${node.label}** — \`${node.sourceFile}\``];
  const meta = node.meta;
  if (typeof meta?.depth === 'number') {
    parts.push(`depth ${meta.depth}`);
  }
  if (typeof meta?.fileCount === 'number') {
    parts.push(`${meta.fileCount} file(s)`);
  }
  const degree = degreeOf(node);
  if (degree !== null) {
    parts.push(`deg ${degree}`);
  }
  if (typeof meta?.community === 'string' || typeof meta?.community === 'number') {
    parts.push(`community ${meta.community}`);
  }
  return parts.join(' · ');
}

/** One line for an integration/datastore/endpoint node. */
function nodeLineOf(node: BlueprintNode): string {
  const parts: string[] = [`- **${node.label}** — \`${node.sourceFile}\``];
  const meta = node.meta;
  if (typeof meta?.method === 'string' && typeof meta?.route === 'string') {
    parts.push(`${meta.method} ${meta.route}`);
  } else if (typeof meta?.route === 'string') {
    parts.push(meta.route);
  } else if (typeof meta?.method === 'string') {
    parts.push(meta.method);
  }
  if (Array.isArray(meta?.tables) && meta.tables.length > 0) {
    parts.push(`tables: ${meta.tables.join(', ')}`);
  }
  return parts.join(' · ');
}

/** The `## Modules` section body: top modules by score, capped explicitly. */
function modulesSection(graph: BlueprintGraph): string[] {
  const modules = graph.nodes
    .filter((node) => node.kind === 'module')
    .sort((a, b) => {
      const byScore = moduleScoreOf(b, graph) - moduleScoreOf(a, graph);
      if (byScore !== 0) {
        return byScore;
      }
      return compareStrings(a.id, b.id);
    });

  if (modules.length === 0) {
    return [EMPTY_SECTION_LINE];
  }

  const lines = modules.slice(0, MODULE_REPORT_CAP).map(moduleLineOf);
  const overflow = modules.length - MODULE_REPORT_CAP;
  if (overflow > 0) {
    lines.push(`…and ${overflow} more module(s)`);
  }
  return lines;
}

/** A one-line-per-node section body for a non-module kind, sorted by id. */
function kindSection(graph: BlueprintGraph, kind: BlueprintNodeKind): string[] {
  const nodes = graph.nodes
    .filter((node) => node.kind === kind)
    .sort((a, b) => compareStrings(a.id, b.id));
  if (nodes.length === 0) {
    return [EMPTY_SECTION_LINE];
  }
  return nodes.map(nodeLineOf);
}

/** The `## Structure` section body: node/edge counts plus the coverage line. */
function structureSection(graph: BlueprintGraph): string[] {
  const nodeCounts = KIND_ORDER.map(
    (kind) => `${kind} ${graph.nodes.filter((node) => node.kind === kind).length}`,
  );

  const edgesByRelation = new Map<string, number>();
  for (const edge of graph.edges) {
    edgesByRelation.set(edge.relation, (edgesByRelation.get(edge.relation) ?? 0) + 1);
  }
  const relationCounts = [...edgesByRelation.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([relation, count]) => `${relation} ${count}`);
  const edgesLine =
    relationCounts.length > 0
      ? `- Edges: ${graph.edges.length} (${relationCounts.join(', ')})`
      : `- Edges: 0`;

  const { coverage } = graph;
  return [
    `- Nodes: ${graph.nodes.length} (${nodeCounts.join(', ')})`,
    edgesLine,
    `- Coverage: ${coverage.filesScanned}/${coverage.filesTotal} files scanned · extractors: ${coverage.extractorsRun.join(', ')} · graphify enriched: ${coverage.graphifyEnriched ? 'yes' : 'no'}`,
  ];
}

/**
 * Render the full prose report as one markdown document. Deterministic: no
 * clock, no randomness, no `derivedAt` — same graph structure, byte-identical
 * markdown.
 */
export function renderProseReport(graph: BlueprintGraph): string {
  const lines: string[] = [
    '# Blueprint Report',
    '',
    `> Auto-generated by \`planflow-ai blueprint derive\` — do not edit; source of truth is \`${BLUEPRINT_GRAPH_DISPLAY_PATH}\`.`,
    '',
    '## Modules',
    '',
    ...modulesSection(graph),
    '',
    '## Integrations',
    '',
    ...kindSection(graph, 'integration'),
    '',
    '## Datastores',
    '',
    ...kindSection(graph, 'datastore'),
    '',
    '## Endpoints',
    '',
    ...kindSection(graph, 'endpoint'),
    '',
    '## Structure',
    '',
    ...structureSection(graph),
  ];
  return `${lines.join('\n')}\n`;
}
