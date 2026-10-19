/**
 * THE WORKSPACE MAP — one read for the board's Workspace level
 * (decision `flow/brain/decisions/workspace-blueprint.md`, 2026-10-06).
 *
 * `planflow-ai blueprint workspace graph [--target <repo>] [--workspace <w>] --json`
 *
 * For the Workspace the target repo belongs to: every project (in
 * `workspace.json` order, which is also its stable colour index), each
 * project's feature graph EXACTLY as `features graph --json` builds it
 * (`readProjectFeatureGraph` — the one assembly), the project's totals, the
 * Workspace's totals, and every link of `links.jsonl` with each end resolved to
 * the feature nodes it touches.
 *
 * NOTHING IS MERGED. Each project keeps its own graph under its own entry; the
 * Workspace level only places them side by side and counts. The CLI is the one
 * source of the combined map (allowed-pattern #14) — the app draws what this
 * returns and derives no Workspace path of its own.
 *
 * A PROJECT NOT ON THIS COMPUTER is still drawn. Its features are read from the
 * Workspace's knowledge folder (`projects/<p>/brain/features`), and its size is
 * the LAST KNOWN one: every time a machine with a checkout measures a project
 * here, the sizes are appended to `brain/.structure/sizes.jsonl` in that
 * project's knowledge folder — an append-only store, so it syncs to teammates
 * by union like every other `.jsonl` there. A project nobody has measured yet
 * carries no size at all, and says so (`size.source: 'none'`).
 *
 * FAIL-SOFT PER PROJECT. One project whose store cannot be read becomes an
 * entry with `state: 'unreadable'` and the reason; the others are unaffected.
 * Links that cannot be read become `links: null` with `linksError`; the
 * projects are unaffected. The map never fails as a whole because one part of
 * it did.
 *
 * BOUNDED: no file lists anywhere (sizes are counts), no limitations report
 * (the zoomed-in board reads its own), and node summaries are trimmed. The
 * files a feature stands on load on drill-down, as they always have.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readProjectFeatureGraph } from './feature-graph-read.js';
import { requestImportIndexWarm } from './storyline-index-warm.js';
import type { FeatureGraphEdge, FeatureGraphNode } from './feature-graph.js';
import type { FeatureNode, FeaturePart } from './feature-store.js';
import { BLUEPRINT_DIRNAME } from './store.js';
import { featuresUnderstood, rollUpUnderstood, type UnderstoodFraction } from './understood.js';
import {
  featureClaimsAnchor,
  parseLinkAddress,
  readWorkspaceLinks,
  workspaceLinksPath,
  type LinkEnd,
  type LinkEvidence,
  type LinkKind,
  type WorkspaceLinkRecord,
} from '../handlers/workspace-links.js';
import { learningTotals, type LearningTotals } from '../handlers/workspace-connections.js';
import {
  WorkspaceRefusal,
  workspaceStatus,
  type ProjectView,
  type WorkspaceContext,
  type WorkspaceSummary,
} from '../handlers/workspace-model.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** Where last-known sizes live, relative to a project's knowledge folder. */
export const SIZES_FILENAME = 'sizes.jsonl';

/** A summary is one glance on a cell; the full text is one click away. */
const SUMMARY_MAX_LENGTH = 200;

/** How many features one anchor end may resolve to — the mirror's own cap. */
const ANCHOR_FEATURE_CAP = 5;

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** Where a project's size came from. */
export type ProjectSizeSource = 'measured' | 'last-known' | 'none';

/** `local` has a checkout here; `remote` is read from the knowledge folder only. */
export type WorkspaceProjectState = 'local' | 'remote' | 'unreadable';

export interface WorkspaceProjectTotals {
  /** Core features — capabilities. */
  features: number;
  parts: number;
  changes: number;
  /** Lines the core features stand on, summed; null when unknown. */
  lines: number | null;
  files: number | null;
  understood: UnderstoodFraction | null;
}

export interface WorkspaceGraphProject {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  /** Position in `workspace.json` — the stable colour index. */
  colorIndex: number;
  /** True for the project the target repo is. */
  current: boolean;
  /** This machine's checkout, or null. */
  local: string | null;
  state: WorkspaceProjectState;
  /** Why the project could not be read (`state: 'unreadable'`), else null. */
  error: string | null;
  size: { source: ProjectSizeSource; measuredAt: string | null };
  /** The project's feature graph as `features graph` builds it (no limitations). Null when unreadable. */
  graph: { nodes: FeatureGraphNode[]; edges: FeatureGraphEdge[] } | null;
  totals: WorkspaceProjectTotals;
  /** Links with this project on either end. */
  connections: number;
}

/** One end of a link, resolved against the project it names. */
export interface WorkspaceGraphLinkEnd {
  address: string;
  project: string;
  ref: string;
  type: 'feature' | 'anchor';
  /** Core feature node ids this end touches — empty when it resolves to none. */
  features: string[];
}

export interface WorkspaceGraphLink {
  ts: string;
  author: string | null;
  kind: LinkKind;
  note?: string;
  /** Present on a connection connections learning found, with its evidence. */
  source?: 'learned';
  evidence?: LinkEvidence;
  from: WorkspaceGraphLinkEnd;
  to: WorkspaceGraphLinkEnd;
}

export interface WorkspaceGraphResult {
  action: 'workspace-graph';
  workspace: Pick<WorkspaceSummary, 'name' | 'slug'>;
  /** The target repo's project slug. */
  current: string | null;
  projects: WorkspaceGraphProject[];
  totals: {
    projects: number;
    features: number;
    lines: number | null;
    understood: UnderstoodFraction | null;
    connections: number | null;
  };
  /** Null when `links.jsonl` exists and could not be read. */
  links: WorkspaceGraphLink[] | null;
  linksError: string | null;
  /** Lines of `links.jsonl` that were not a link — counted, never fatal. */
  linksUnreadable: number;
  /** How far connections learning has got over the Workspace's pairs; null when it could not be read. */
  learning: LearningTotals | null;
}

// ─── Last-known sizes ───────────────────────────────────────────────────────

interface SizeRecord {
  ts: string;
  files: number;
  lines: number;
  /** node id → [files, lines] */
  nodes: Record<string, [number, number]>;
}

function sizesPath(flowDir: string): string {
  return join(flowDir, BLUEPRINT_DIRNAME, SIZES_FILENAME);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function sizeRecordOf(value: unknown): SizeRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.ts !== 'string' || !isCount(row.files) || !isCount(row.lines)) return null;
  const nodes: Record<string, [number, number]> = {};
  if (row.nodes !== null && typeof row.nodes === 'object' && !Array.isArray(row.nodes)) {
    for (const [id, pair] of Object.entries(row.nodes as Record<string, unknown>)) {
      if (Array.isArray(pair) && pair.length === 2 && isCount(pair[0]) && isCount(pair[1])) nodes[id] = [pair[0], pair[1]];
    }
  }
  return { ts: row.ts, files: row.files, lines: row.lines, nodes };
}

/**
 * The newest size record of a project, or null. Newest by `ts`, not by line
 * order: a union merge interleaves two machines' appends.
 */
export function readLastKnownSizes(flowDir: string): SizeRecord | null {
  let raw: string;
  try {
    raw = readFileSync(sizesPath(flowDir), 'utf-8');
  } catch {
    return null;
  }
  let best: SizeRecord | null = null;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let record: SizeRecord | null;
    try {
      record = sizeRecordOf(JSON.parse(line));
    } catch {
      continue;
    }
    if (record !== null && (best === null || record.ts >= best.ts)) best = record;
  }
  return best;
}

/** The measured sizes of a graph as a record body (ids sorted — same graph, same bytes). */
function sizeBodyOf(nodes: readonly FeatureGraphNode[]): Omit<SizeRecord, 'ts'> | null {
  const entries: [string, [number, number]][] = [];
  let files = 0;
  let lines = 0;
  for (const node of nodes) {
    if (node.size === undefined || node.kind === 'child') continue;
    entries.push([node.id, [node.size.files, node.size.lines]]);
    if (node.kind === 'core') {
      files += node.size.files;
      lines += node.size.lines;
    }
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return { files, lines, nodes: Object.fromEntries(entries) };
}

/**
 * Append this measurement when it differs from the newest one on record.
 * Fail-soft: a size that cannot be recorded costs teammates a fresher number,
 * never this read its answer.
 */
export function recordProjectSizes(flowDir: string, nodes: readonly FeatureGraphNode[], now: Date): void {
  const body = sizeBodyOf(nodes);
  if (body === null) return;
  const last = readLastKnownSizes(flowDir);
  if (last !== null) {
    const previous = { files: last.files, lines: last.lines, nodes: last.nodes };
    if (JSON.stringify(previous) === JSON.stringify(body)) return;
  }
  try {
    mkdirSync(join(flowDir, BLUEPRINT_DIRNAME), { recursive: true });
    appendFileSync(sizesPath(flowDir), `${JSON.stringify({ ts: now.toISOString(), ...body })}\n`, 'utf-8');
  } catch {
    // a read-only knowledge folder still answers the read
  }
}

/** Lay a size record over an unmeasured graph — only nodes it names gain a size. */
function withSizes(nodes: readonly FeatureGraphNode[], record: SizeRecord): FeatureGraphNode[] {
  return nodes.map((node) => {
    const pair = record.nodes[node.id];
    return pair === undefined ? node : { ...node, size: { files: pair[0], lines: pair[1] } };
  });
}

// ─── Projects ───────────────────────────────────────────────────────────────

function trimSummary(node: FeatureGraphNode): FeatureGraphNode {
  if (node.summary.length <= SUMMARY_MAX_LENGTH) return node;
  return { ...node, summary: `${node.summary.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…` };
}

function totalsOf(nodes: readonly FeatureGraphNode[] | null): WorkspaceProjectTotals {
  if (nodes === null) return { features: 0, parts: 0, changes: 0, lines: null, files: null, understood: null };
  let features = 0;
  let parts = 0;
  let changes = 0;
  let lines = 0;
  let files = 0;
  let measured = false;
  for (const node of nodes) {
    if (node.kind === 'part') parts += 1;
    else if (node.kind === 'child') changes += 1;
    else {
      features += 1;
      if (node.size !== undefined) {
        measured = true;
        lines += node.size.lines;
        files += node.size.files;
      }
    }
  }
  return {
    features,
    parts,
    changes,
    lines: measured ? lines : null,
    files: measured ? files : null,
    understood: featuresUnderstood(nodes),
  };
}

/** What a project read hands the link resolver. */
interface ProjectStore {
  coreIds: Map<string, string>; // slug → core node id
  features: FeatureNode[];
  partsBySlug: Map<string, FeaturePart[]>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ReadProject {
  entry: WorkspaceGraphProject;
  store: ProjectStore | null;
}

function readOneProject(project: ProjectView, index: number, current: string | null, now: Date): ReadProject {
  const local = project.localPath;
  const base = {
    id: project.id,
    slug: project.slug,
    name: project.name,
    description: project.description,
    colorIndex: index,
    current: project.slug === current,
    local,
    connections: 0,
  };
  if (!existsSync(project.flowPath)) {
    return {
      entry: {
        ...base,
        state: 'unreadable',
        error: 'its knowledge folder is not on this computer yet',
        size: { source: 'none', measuredAt: null },
        graph: null,
        totals: totalsOf(null),
      },
      store: null,
    };
  }
  try {
    const read = readProjectFeatureGraph(project.flowPath, local);
    // A cold import index made this project's folder rows partial; build it in
    // the background rather than in this read (`storyline-index-warm.ts`).
    if (read.importIndex === 'partial' && local !== null) requestImportIndexWarm(local);
    let nodes = read.graph.nodes;
    let source: ProjectSizeSource = 'none';
    let measuredAt: string | null = null;
    if (local !== null) {
      source = 'measured';
      measuredAt = now.toISOString();
      recordProjectSizes(project.flowPath, nodes, now);
    } else {
      const known = readLastKnownSizes(project.flowPath);
      if (known !== null) {
        nodes = withSizes(nodes, known);
        source = 'last-known';
        measuredAt = known.ts;
      }
    }
    const coreIds = new Map<string, string>();
    for (const node of nodes) if (node.kind === 'core') coreIds.set(node.slug, node.id);
    return {
      entry: {
        ...base,
        state: local === null ? 'remote' : 'local',
        error: null,
        size: { source, measuredAt },
        graph: { nodes: nodes.map(trimSummary), edges: read.graph.edges },
        totals: totalsOf(nodes),
      },
      store: { coreIds, features: read.features, partsBySlug: read.partsBySlug },
    };
  } catch (error) {
    return {
      entry: {
        ...base,
        state: 'unreadable',
        error: errorText(error),
        size: { source: 'none', measuredAt: null },
        graph: null,
        totals: totalsOf(null),
      },
      store: null,
    };
  }
}

// ─── Links ──────────────────────────────────────────────────────────────────

/**
 * The core features one end touches: the named feature, or the features (and
 * the owners of the parts) whose anchors claim an anchor end. An end in a
 * project that could not be read, or that nothing claims, touches none — it is
 * kept with its address so it can still be drawn to the project's block.
 */
export function resolveLinkEnd(end: LinkEnd, store: ProjectStore | null): WorkspaceGraphLinkEnd {
  const out: WorkspaceGraphLinkEnd = { address: end.address, project: end.project, ref: end.ref, type: end.type, features: [] };
  if (store === null) return out;
  if (end.type === 'feature') {
    const slug = end.feature ?? end.ref;
    const id = store.coreIds.get(slug) ?? store.features.find((feature) => feature.id === slug)?.id;
    if (id !== undefined && [...store.coreIds.values()].includes(id)) out.features = [id];
    return out;
  }
  const hits: string[] = [];
  for (const feature of store.features) {
    const id = store.coreIds.get(feature.slug);
    if (id === undefined || hits.includes(id)) continue;
    const parts = store.partsBySlug.get(feature.slug) ?? [];
    if (featureClaimsAnchor(feature, end) || parts.some((part) => featureClaimsAnchor(part, end))) hits.push(id);
    if (hits.length >= ANCHOR_FEATURE_CAP) break;
  }
  out.features = hits;
  return out;
}

function readLinks(workspacePath: string): { links: WorkspaceLinkRecord[] | null; error: string | null; unreadable: number } {
  const path = workspaceLinksPath(workspacePath);
  if (existsSync(path)) {
    // `readWorkspaceLinks` is fail-soft by design (a reader of links must
    // never fail a search) and so cannot tell "no links" from "could not
    // read". The map needs that difference: a disabled Connections button
    // with a reason is honest, an empty map of connections is not.
    try {
      readFileSync(path, 'utf-8');
    } catch (error) {
      return { links: null, error: errorText(error), unreadable: 0 };
    }
  }
  const { links, unreadable } = readWorkspaceLinks(workspacePath);
  return { links, error: null, unreadable };
}

// ─── The read ───────────────────────────────────────────────────────────────

export interface WorkspaceGraphOptions extends WorkspaceContext {
  target?: string;
  workspace?: string;
  /** The clock a size record is stamped with. */
  now?: () => Date;
}

/** Build the Workspace map for the target repo's Workspace. */
export function buildWorkspaceGraph(options: WorkspaceGraphOptions = {}): WorkspaceGraphResult {
  const context = {
    ...(options.flowFolder === undefined ? {} : { flowFolder: options.flowFolder }),
    ...(options.deps === undefined ? {} : { deps: options.deps }),
  };
  const target = options.target ?? process.cwd();
  const status = workspaceStatus({ ...context, target, ...(options.workspace === undefined ? {} : { workspace: options.workspace }) });
  if (!('target' in status) || status.workspace === null || status.project === null) {
    throw new WorkspaceRefusal('no-workspace', 'this repository is in no Workspace, so there is no Workspace map to draw', { target });
  }
  const summary = status.workspace;
  // WORKSPACE.JSON ORDER — the list read, not the target read, which puts the
  // target first. A project's position there is its colour on every machine.
  const listing = workspaceStatus({ ...context, workspace: summary.slug });
  const ordered = 'workspaces' in listing ? (listing.workspaces[0]?.projects ?? []) : [];
  const projectsInOrder = ordered.length > 0 ? ordered : [status.project, ...status.siblings];
  const current = status.project.slug;
  const now = (options.now ?? (() => new Date()))();

  const reads = projectsInOrder.map((project, index) => readOneProject(project, index, current, now));
  const storeBySlug = new Map(reads.map((read) => [read.entry.slug, read.store]));
  const entryBySlug = new Map(reads.map((read) => [read.entry.slug, read.entry]));

  const linkRead = readLinks(summary.path);
  let links: WorkspaceGraphLink[] | null = null;
  if (linkRead.links !== null) {
    links = [];
    for (const record of linkRead.links) {
      const from = parseLinkAddress(record.from);
      const to = parseLinkAddress(record.to);
      if (from === null || to === null) continue;
      links.push({
        ts: record.ts,
        author: record.author,
        kind: record.kind,
        ...(record.note === undefined ? {} : { note: record.note }),
        ...(record.source === undefined ? {} : { source: record.source }),
        ...(record.evidence === undefined ? {} : { evidence: record.evidence }),
        from: resolveLinkEnd(from, storeBySlug.get(from.project) ?? null),
        to: resolveLinkEnd(to, storeBySlug.get(to.project) ?? null),
      });
      // A link to a project no longer in the Workspace still counts for the
      // end that IS here — it is a real connection that has lost a side.
      for (const slug of new Set([from.project, to.project])) {
        const entry = entryBySlug.get(slug);
        if (entry !== undefined) entry.connections += 1;
      }
    }
  }

  const projects = reads.map((read) => read.entry);
  const readable = projects.filter((project) => project.graph !== null);
  const knownLines = projects.map((project) => project.totals.lines).filter((lines): lines is number => lines !== null);
  return {
    action: 'workspace-graph',
    workspace: { name: summary.name, slug: summary.slug },
    current,
    projects,
    totals: {
      projects: projects.length,
      features: readable.reduce((sum, project) => sum + project.totals.features, 0),
      lines: knownLines.length === 0 ? null : knownLines.reduce((sum, lines) => sum + lines, 0),
      understood: rollUpUnderstood(projects.map((project) => project.totals.understood)),
      connections: links === null ? null : links.length,
    },
    links,
    linksError: linkRead.error,
    linksUnreadable: linkRead.unreadable,
    learning: learningOf(summary.path, projectsInOrder),
  };
}

/** Connections learning's progress — fail-soft: a map never fails because this could not be read. */
function learningOf(workspacePath: string, views: readonly ProjectView[]): LearningTotals | null {
  try {
    return learningTotals(workspacePath, views);
  } catch {
    return null;
  }
}

/** The human lines `blueprint workspace graph` prints without `--json`. */
export function describeWorkspaceGraph(result: WorkspaceGraphResult): string[] {
  const percent = (fraction: UnderstoodFraction | null): string =>
    fraction === null ? '' : ` · ${String(Math.round((fraction.done / fraction.total) * 100))}% understood`;
  const lines = [
    `workspace: ${result.workspace.name} — ${String(result.totals.projects)} project(s) · ${String(result.totals.features)} feature(s)` +
      (result.totals.lines === null ? '' : ` · ${String(result.totals.lines)} lines`) +
      percent(result.totals.understood) +
      (result.totals.connections === null ? ' · links unreadable' : ` · ${String(result.totals.connections)} connection(s)`),
  ];
  for (const project of result.projects) {
    const where = project.state === 'local' ? '' : project.state === 'remote' ? ' (not on this computer)' : ` (unreadable: ${project.error ?? '?'})`;
    lines.push(
      `  ${project.slug}${project.current ? ' *' : ''}: ${String(project.totals.features)} feature(s)` +
        (project.totals.lines === null ? '' : ` · ${String(project.totals.lines)} lines`) +
        percent(project.totals.understood) +
        ` · ${String(project.connections)} connection(s)${where}`,
    );
  }
  return lines;
}
