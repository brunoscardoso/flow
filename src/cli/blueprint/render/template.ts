/**
 * Blueprint HTML renderer — a deterministic TEMPLATE, not narration.
 *
 * `renderBlueprintHtml` maps structured inputs (graph, layout, annotations,
 * timeline) onto one self-contained HTML title sheet: same inputs → same
 * HTML, byte-identical. Hard rules:
 * - NO clock or randomness at render time — `derivedAt` comes from the graph.
 * - NO external requests: all CSS/JS inline, valid without a network.
 * - Every interpolated string is escaped (labels/annotation text are
 *   untrusted).
 * - Every cap emits an explicit "…and K more" line — no silent truncation.
 *
 * Visual language: "Drafting / Blueprint" — token-driven CSS custom
 * properties, dark mode via `prefers-color-scheme` token redefinition plus
 * `:root[data-theme=…]` overrides so the viewer toggle wins both ways.
 */

import { resolveAnchor } from '../anchors.js';
import type {
  AnnotationEntry,
  BlueprintEdge,
  BlueprintGraph,
  BlueprintNode,
  MustReviewItem,
} from '../types.js';
import type { TitleSheetColumn, TitleSheetEntry, TitleSheetLayout } from './layout.js';

/** Plan context passed by the caller when rendering inside a plan lifecycle. */
export interface RenderPlanContext {
  planName: string;
  phase: 'before' | 'during' | 'after';
}

/** One entry in the run timeline strip (oldest first; last entry = current). */
export interface RenderTimelineEntry {
  runId: string;
  label: string;
}

/** Full input to the renderer. */
export interface RenderBlueprintInput {
  graph: BlueprintGraph;
  prevGraph: BlueprintGraph | null;
  annotations: AnnotationEntry[];
  layout: TitleSheetLayout;
  projectName: string;
  planContext?: RenderPlanContext | null;
  timeline: RenderTimelineEntry[];
}

/** Escape a value for safe interpolation into HTML text or attributes. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Annotation type → claim accent class (left-border color per type). */
const CLAIM_CLASS_BY_TYPE: Record<AnnotationEntry['type'], string> = {
  claim: 'claim-good',
  decision: 'claim-accent',
  rule: 'claim-accent',
  pin: 'claim-ask',
};

/** Severity → chip class for must-review items. */
const SEVERITY_CHIP_CLASS: Record<MustReviewItem['severity'], string> = {
  crit: 'chip-crit',
  high: 'chip-warn',
  ask: 'chip-ask',
  info: 'chip-muted',
};

/** Static stylesheet — tokens per the approved Drafting/Blueprint language. */
const STYLES = `
:root {
  --accent: #2f6fb0;
  --bg: #f4f6f9;
  --surface: #ffffff;
  --canvas: #eef2f7;
  --ink: #1d3450;
  --muted: #5b7391;
  --good: #2e8b5f;
  --warn: #a4700e;
  --crit: #b3442f;
  --ask: #7a4fa3;
  --grid-line: rgba(47, 111, 176, 0.07);
  --grid-line-major: rgba(47, 111, 176, 0.14);
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --accent: #6db3f2;
    --bg: #0c1320;
    --surface: #121c2c;
    --canvas: #0f1828;
    --ink: #d7e3f2;
    --muted: #8ba1bd;
    --good: #5ec98f;
    --warn: #e0b154;
    --crit: #e07a68;
    --ask: #b48ae0;
    --grid-line: rgba(109, 179, 242, 0.06);
    --grid-line-major: rgba(109, 179, 242, 0.12);
  }
}
:root[data-theme="dark"] {
  --accent: #6db3f2;
  --bg: #0c1320;
  --surface: #121c2c;
  --canvas: #0f1828;
  --ink: #d7e3f2;
  --muted: #8ba1bd;
  --good: #5ec98f;
  --warn: #e0b154;
  --crit: #e07a68;
  --ask: #b48ae0;
  --grid-line: rgba(109, 179, 242, 0.06);
  --grid-line-major: rgba(109, 179, 242, 0.12);
}
:root[data-theme="light"] {
  --accent: #2f6fb0;
  --bg: #f4f6f9;
  --surface: #ffffff;
  --canvas: #eef2f7;
  --ink: #1d3450;
  --muted: #5b7391;
  --good: #2e8b5f;
  --warn: #a4700e;
  --crit: #b3442f;
  --ask: #7a4fa3;
  --grid-line: rgba(47, 111, 176, 0.07);
  --grid-line-major: rgba(47, 111, 176, 0.14);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  line-height: 1.45;
}
.mono, .chip, .col-title, .card-kind, .card-meta, .title-block, .anchor-chip,
.timeline-entry, .coverage, .mr-rank, header .brand {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
header {
  display: flex; align-items: baseline; justify-content: space-between;
  padding: 14px 20px; border-bottom: 2px solid var(--accent);
}
header .brand { text-transform: uppercase; letter-spacing: 0.14em; font-size: 15px; }
header .brand small { color: var(--muted); letter-spacing: 0.1em; margin-left: 10px; }
#theme-toggle {
  font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.08em;
  font-size: 11px; color: var(--accent); background: transparent;
  border: 1px solid var(--accent); padding: 3px 10px; cursor: pointer;
}
main { padding: 16px 20px 32px; max-width: 1280px; margin: 0 auto; }
section { margin-bottom: 22px; }
h2 {
  font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.12em;
  font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--grid-line-major);
  padding-bottom: 4px; margin: 0 0 10px;
}
.sheet {
  position: relative;
  border: 1.5px solid var(--accent);
  background:
    linear-gradient(var(--grid-line-major) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line-major) 1px, transparent 1px),
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px),
    var(--canvas);
  background-size: 80px 80px, 80px 80px, 16px 16px, 16px 16px, auto;
  padding: 18px 18px 96px;
}
.columns { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.col-title {
  text-transform: uppercase; letter-spacing: 0.12em; font-size: 11px;
  color: var(--accent); margin-bottom: 8px;
}
.card {
  background: var(--surface); border: 1px solid var(--muted);
  padding: 8px 10px; margin-bottom: 8px;
}
.card.state-planned { border: 1.5px dashed var(--accent); }
.card.state-executing { border: 1.5px solid var(--warn); animation: pulse 1.6s ease-in-out infinite; }
.card.state-done {
  border: 1.5px solid var(--good);
  background: color-mix(in srgb, var(--good) 8%, var(--surface));
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
@media (prefers-reduced-motion: reduce) {
  .card.state-executing { animation: none; }
}
.card-kind {
  text-transform: uppercase; letter-spacing: 0.1em; font-size: 9px; color: var(--muted);
}
.card-name { font-family: var(--mono); font-size: 13px; margin: 2px 0; word-break: break-word; }
.card-meta { font-size: 10px; color: var(--muted); word-break: break-word; }
.chip {
  display: inline-block; font-size: 9px; text-transform: uppercase;
  letter-spacing: 0.08em; padding: 1px 6px; border: 1px solid currentColor; margin-left: 6px;
}
.chip-new { color: var(--good); }
.chip-count { color: var(--accent); }
.chip-crit { color: var(--crit); }
.chip-warn { color: var(--warn); }
.chip-ask { color: var(--ask); }
.chip-muted { color: var(--muted); }
.chip-current { color: var(--good); }
.more-line { font-family: var(--mono); font-size: 11px; color: var(--muted); margin: 4px 0 0; }
.empty-line { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.edges-list { list-style: none; margin: 12px 0 0; padding: 0; }
.edges-list li { font-family: var(--mono); font-size: 11px; color: var(--muted); }
.title-block {
  position: absolute; right: 14px; bottom: 14px;
  border: 1.5px solid var(--accent); background: var(--surface);
  font-size: 10px; min-width: 300px;
}
.title-block .tb-row { display: flex; border-top: 1px solid var(--grid-line-major); }
.title-block .tb-row:first-child { border-top: none; }
.title-block .tb-key {
  width: 82px; padding: 4px 8px; color: var(--muted);
  text-transform: uppercase; letter-spacing: 0.1em;
  border-right: 1px solid var(--grid-line-major);
}
.title-block .tb-val { padding: 4px 8px; text-transform: uppercase; letter-spacing: 0.06em; }
.mr-list { list-style: none; margin: 0; padding: 0; }
.mr-list li {
  display: flex; align-items: baseline; gap: 10px;
  background: var(--surface); border: 1px solid var(--muted);
  padding: 8px 10px; margin-bottom: 6px;
}
.mr-rank { font-size: 15px; color: var(--accent); min-width: 26px; text-align: right; }
.mr-title { font-weight: 600; }
.mr-detail { color: var(--muted); font-size: 12px; }
.mr-node { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.claims details {
  background: var(--surface); border: 1px solid var(--muted); margin-bottom: 6px;
}
.claims summary {
  cursor: pointer; padding: 6px 10px; font-family: var(--mono); font-size: 12px;
}
.claim {
  border-left: 3px solid var(--good); margin: 6px 10px; padding: 4px 8px; font-size: 12px;
}
.claim.claim-good { border-left-color: var(--good); }
.claim.claim-accent { border-left-color: var(--accent); }
.claim.claim-ask { border-left-color: var(--ask); }
.claim.claim-stale { border-left-color: var(--warn); }
.claim.claim-stale .claim-text { text-decoration: line-through; color: var(--muted); }
.claim-type {
  font-family: var(--mono); font-size: 9px; text-transform: uppercase;
  letter-spacing: 0.1em; color: var(--muted); margin-right: 6px;
}
.anchor-chip {
  display: inline-block; font-size: 10px; color: var(--accent);
  border: 1px solid var(--grid-line-major); padding: 0 5px; margin: 2px 4px 0 0;
}
.claim-stale-reason { font-family: var(--mono); font-size: 10px; color: var(--warn); }
.timeline { display: flex; flex-wrap: wrap; gap: 8px; }
.timeline-entry {
  font-size: 11px; border: 1px solid var(--muted); padding: 4px 8px; background: var(--surface);
}
.timeline-entry .run-id { color: var(--muted); }
.coverage { font-size: 11px; color: var(--muted); }
.coverage div { margin-bottom: 2px; }
`;

/** Static viewer script — theme toggle stamping data-theme on the root. */
const SCRIPT = `
(function () {
  var root = document.documentElement;
  var button = document.getElementById('theme-toggle');
  if (button === null) { return; }
  button.addEventListener('click', function () {
    var current = root.getAttribute('data-theme');
    var next;
    if (current === 'dark') {
      next = 'light';
    } else if (current === 'light') {
      next = 'dark';
    } else {
      var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      next = prefersDark ? 'light' : 'dark';
    }
    root.setAttribute('data-theme', next);
  });
})();
`;

/** The meta line of a node card: degree/community/tables/method/route. */
function metaLineOf(node: BlueprintNode): string {
  const parts: string[] = [];
  const meta = node.meta;
  if (typeof meta?.degree === 'number') {
    parts.push(`deg ${meta.degree}`);
  }
  if (typeof meta?.community === 'string' || typeof meta?.community === 'number') {
    parts.push(`community ${meta.community}`);
  }
  if (Array.isArray(meta?.tables) && meta.tables.length > 0) {
    parts.push(`tables: ${meta.tables.join(', ')}`);
  }
  if (typeof meta?.method === 'string') {
    parts.push(meta.method);
  }
  if (typeof meta?.route === 'string') {
    parts.push(meta.route);
  }
  return parts.join(' · ');
}

/**
 * Graph-delta node state class: nodes absent from the previous derive render
 * as 'done' (fresh ink) with a NEW chip. States come only from provided data
 * — a null previous graph marks nothing as new.
 */
function nodeStateOf(node: BlueprintNode, prevIds: Set<string> | null): { className: string; isNew: boolean } {
  if (prevIds !== null && !prevIds.has(node.id)) {
    return { className: ' state-done', isNew: true };
  }
  return { className: '', isNew: false };
}

/** Render one column entry (node card or the CLI-surface pseudo-entry). */
function renderEntry(entry: TitleSheetEntry, prevIds: Set<string> | null): string {
  if (entry.type === 'cli-surface') {
    const commands = entry.commands.map((command) => escapeHtml(command)).join(', ');
    const moreLine =
      entry.moreCommandCount > 0
        ? `<p class="more-line">…and ${entry.moreCommandCount} more command(s)</p>`
        : '';
    return `<div class="card">
<span class="card-kind">endpoint group</span><span class="chip chip-count">${entry.totalCommandCount} commands</span>
<p class="card-name">CLI surface</p>
<p class="card-meta">${commands}</p>
${moreLine}
</div>`;
  }

  const { node, endpointCount } = entry;
  const state = nodeStateOf(node, prevIds);
  const newChip = state.isNew ? '<span class="chip chip-new">NEW</span>' : '';
  const countChip =
    endpointCount !== undefined
      ? `<span class="chip chip-count">${endpointCount} endpoint(s)</span>`
      : '';
  const metaLine = metaLineOf(node);
  const metaHtml = metaLine.length > 0 ? `<p class="card-meta">${escapeHtml(metaLine)}</p>` : '';
  return `<div class="card${state.className}">
<span class="card-kind">${escapeHtml(node.kind)}</span>${newChip}${countChip}
<p class="card-name">${escapeHtml(node.label)}</p>
${metaHtml}
<p class="card-meta">${escapeHtml(node.sourceFile)}</p>
</div>`;
}

/** Render one capped column with its explicit overflow line. */
function renderColumn(column: TitleSheetColumn, prevIds: Set<string> | null): string {
  const cards = column.entries.map((entry) => renderEntry(entry, prevIds)).join('\n');
  const body = column.entries.length > 0 ? cards : '<p class="empty-line">none derived</p>';
  const moreLine =
    column.moreCount > 0
      ? `<p class="more-line">…and ${column.moreCount} more ${escapeHtml(column.title.toLowerCase())}</p>`
      : '';
  return `<div class="column">
<div class="col-title">${escapeHtml(column.title)} · ${column.totalCount}</div>
${body}
${moreLine}
</div>`;
}

/** Render the visible-edge list beneath the columns. */
function renderEdges(edges: BlueprintEdge[]): string {
  if (edges.length === 0) {
    return '<ul class="edges-list"><li>no connections among visible nodes</li></ul>';
  }
  const items = edges
    .map(
      (edge) =>
        `<li>${escapeHtml(edge.source)} —${escapeHtml(edge.relation)}→ ${escapeHtml(edge.target)}</li>`,
    )
    .join('\n');
  return `<ul class="edges-list">\n${items}\n</ul>`;
}

/** Render the bottom-right drafting title block. */
function renderTitleBlock(input: RenderBlueprintInput): string {
  const revision = input.planContext?.planName ?? '—';
  const latestRunId =
    input.timeline.length > 0 ? input.timeline[input.timeline.length - 1].runId : '—';
  const rows: Array<[string, string]> = [
    ['Project', input.projectName],
    ['Sheet', 'A-1 · TITLE SHEET'],
    ['Rev', revision],
    ['Derived', `${input.graph.derivedAt} · ${latestRunId}`],
  ];
  const rowsHtml = rows
    .map(
      ([key, value]) =>
        `<div class="tb-row"><span class="tb-key">${escapeHtml(key)}</span><span class="tb-val">${escapeHtml(value)}</span></div>`,
    )
    .join('\n');
  return `<div class="title-block">\n${rowsHtml}\n</div>`;
}

/** Render the ranked must-review panel (with explicit empty state). */
function renderMustReview(items: MustReviewItem[]): string {
  if (items.length === 0) {
    return '<p class="empty-line">no must-review items — nothing ranked for your eyes this derive</p>';
  }
  const rows = items
    .map((item) => {
      const nodeRef =
        item.nodeId !== undefined ? `<span class="mr-node">⟶ ${escapeHtml(item.nodeId)}</span>` : '';
      return `<li>
<span class="mr-rank">${item.rank}</span>
<span class="chip ${SEVERITY_CHIP_CLASS[item.severity]}">${escapeHtml(item.severity)}</span>
<span><span class="mr-title">${escapeHtml(item.title)}</span><br>
<span class="mr-detail">${escapeHtml(item.detail)} <span class="mr-node">[${escapeHtml(item.source)}]</span></span> ${nodeRef}</span>
</li>`;
    })
    .join('\n');
  return `<ol class="mr-list">\n${rows}\n</ol>`;
}

/** Render one annotation as a claim row. */
function renderClaim(entry: AnnotationEntry): string {
  const stale = entry.status === 'stale';
  const claimClass = stale ? 'claim-stale' : CLAIM_CLASS_BY_TYPE[entry.type] ?? 'claim-accent';
  const anchorChips = entry.anchors
    .map((anchor) => `<span class="anchor-chip">⟶ ${escapeHtml(anchor.ref)}</span>`)
    .join('');
  const staleReason = stale
    ? '<div class="claim-stale-reason">STALE — anchor no longer resolves in the current derive</div>'
    : '';
  return `<div class="claim ${claimClass}">
<span class="claim-type">${escapeHtml(entry.type)}${stale ? ' · stale' : ''}</span>
<span class="claim-text">${escapeHtml(entry.text)}</span>
<div>${anchorChips}</div>
${staleReason}
</div>`;
}

/**
 * Render the claims panel: one <details> per visible node that has matching
 * annotations. Matching reuses `resolveAnchor` against a single-node subgraph
 * so panel membership is exactly anchor-resolution semantics.
 */
function renderClaimsPanel(input: RenderBlueprintInput): string {
  const visibleIds = new Set(input.layout.visibleNodeIds);
  const visibleNodes = input.graph.nodes.filter((node) => visibleIds.has(node.id));

  const sections: string[] = [];
  for (const node of visibleNodes) {
    const singleNodeGraph: BlueprintGraph = { ...input.graph, nodes: [node], edges: [] };
    const matching = input.annotations.filter((entry) =>
      entry.anchors.some((anchor) => resolveAnchor(anchor, singleNodeGraph)),
    );
    if (matching.length === 0) {
      continue;
    }
    const claims = matching.map(renderClaim).join('\n');
    sections.push(
      `<details>
<summary>${escapeHtml(node.id)} · ${matching.length} annotation(s)</summary>
${claims}
</details>`,
    );
  }

  if (sections.length === 0) {
    return '<p class="empty-line">no annotations anchored to visible nodes</p>';
  }
  return sections.join('\n');
}

/** Render the run timeline strip; the last entry is the current run. */
function renderTimeline(timeline: RenderTimelineEntry[]): string {
  if (timeline.length === 0) {
    return '<p class="empty-line">no recorded runs</p>';
  }
  const entries = timeline
    .map((entry, index) => {
      const isCurrent = index === timeline.length - 1;
      const currentChip = isCurrent ? '<span class="chip chip-current">CURRENT</span>' : '';
      return `<span class="timeline-entry">${escapeHtml(entry.label)} <span class="run-id">${escapeHtml(entry.runId)}</span>${currentChip}</span>`;
    })
    .join('\n');
  return `<div class="timeline">\n${entries}\n</div>`;
}

/** Render the coverage footer, including explicit layout overflow lines. */
function renderCoverage(input: RenderBlueprintInput): string {
  const { coverage } = input.graph;
  const lines: string[] = [
    `files scanned: ${coverage.filesScanned}/${coverage.filesTotal}`,
    `extractors: ${coverage.extractorsRun.map((name) => escapeHtml(name)).join(', ')}`,
    `graphify enriched: ${coverage.graphifyEnriched ? 'yes' : 'no'}`,
  ];
  for (const column of input.layout.columns) {
    if (column.moreCount > 0) {
      lines.push(
        `sheet overflow: …and ${column.moreCount} more ${escapeHtml(column.title.toLowerCase())} beyond the ${escapeHtml(column.title.toLowerCase())} column cap`,
      );
    }
    for (const entry of column.entries) {
      if (entry.type === 'cli-surface' && entry.moreCommandCount > 0) {
        lines.push(`sheet overflow: …and ${entry.moreCommandCount} more CLI command(s) beyond the CLI surface cap`);
      }
    }
  }
  return lines.map((line) => `<div>${line}</div>`).join('\n');
}

/**
 * Render the full blueprint title sheet as one self-contained HTML document.
 * Deterministic: no clock, no randomness — same inputs, byte-identical HTML.
 */
export function renderBlueprintHtml(input: RenderBlueprintInput): string {
  const prevIds = input.prevGraph === null ? null : new Set(input.prevGraph.nodes.map((node) => node.id));
  const columnsHtml = input.layout.columns
    .map((column) => renderColumn(column, prevIds))
    .join('\n');
  const phaseNote =
    input.planContext !== null && input.planContext !== undefined
      ? ` <small>· ${escapeHtml(input.planContext.phase)} ${escapeHtml(input.planContext.planName)}</small>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.projectName)} — Blueprint Title Sheet</title>
<style>${STYLES}</style>
</head>
<body>
<header>
<span class="brand">${escapeHtml(input.projectName)} <small>SHEET A-1 · TITLE SHEET${phaseNote}</small></span>
<button id="theme-toggle" type="button">Theme</button>
</header>
<main>
<section class="must-review">
<h2>Needs Your Eyes</h2>
${renderMustReview(input.graph.mustReview ?? [])}
</section>
<section>
<h2>System Map</h2>
<div class="sheet">
<div class="columns">
${columnsHtml}
</div>
${renderEdges(input.layout.visibleEdges)}
${renderTitleBlock(input)}
</div>
</section>
<section class="claims">
<h2>Claims &amp; Decisions</h2>
${renderClaimsPanel(input)}
</section>
<section>
<h2>Run Timeline</h2>
${renderTimeline(input.timeline)}
</section>
<section>
<h2>Coverage</h2>
<div class="coverage">
${renderCoverage(input)}
</div>
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}
