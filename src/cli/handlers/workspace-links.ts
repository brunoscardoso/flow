/**
 * CROSS-PROJECT KNOWLEDGE LINKS — the one writer and the readers of
 * `<workspace>/links.jsonl` (workspaces-knowledge-hub Phase 5, FR-21).
 *
 * A link says how two projects of one Workspace touch: a backend endpoint and
 * the frontend screen that calls it, a shared feature, a library a service
 * consumes. Skills record them as they work (brainstorm, discovery, plan,
 * execute, review); brain search and `blueprint context` read them back, so a
 * person searching the frontend for "orders" finds the backend's endpoint and
 * the note someone left about it.
 *
 * ONE WRITER (forbidden-pattern #18 — a gate reads it, a verb writes it):
 * `planflow-ai workspace link-knowledge`, through `linkKnowledge` below. No
 * skill composes a line of `links.jsonl` by hand.
 *
 * The store:
 *
 *   <Flow folder>/workspaces/<w>/links.jsonl     APPEND-ONLY, one link per line
 *     { ts, author, kind, from, to, note?, source?, evidence? }
 *
 * `source: 'learned'` marks a link CONNECTIONS LEARNING found rather than a
 * person or a skill recorded (`workspace-connections.ts`), with its
 * `evidence`: `code` (a call matched to an endpoint) or `model` (the fast
 * model read both projects and suggested it). Both fields are additive —
 * an older reader simply sees a link.
 *
 * `from` / `to` are ADDRESSES — `<project>/<ref>`, where `<project>` is the
 * project's slug in this Workspace and `<ref>` is either a feature (`orders`,
 * `feature:orders`) or a blueprint anchor (`endpoint:POST /api/orders`,
 * `file:src/screens/Orders.tsx`, `module:src/api`, `symbol:…`, `table:…`).
 * An anchor end is recorded even when no feature note claims it.
 *
 * Idempotent by (from, to, kind): the same link recorded twice is ONE line.
 * Append-only means the file merges as a union across machines (Phase 6 sync).
 *
 * The mirror: every feature note an end resolves to — the named feature, or
 * the features whose anchors cover an anchor end — gains a `relates` edge to
 * the OTHER end, written only through `feature-store.ts`'s `writeForeignEdge`.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findFeatureByRef, parseFeatureId, readFeatures, writeForeignEdge, type FeatureEdge, type FeatureNode } from '../blueprint/feature-store.js';
import type { AnchorKind } from '../blueprint/types.js';
import {
  WorkspaceRefusal,
  defaultWorkspaceGit,
  workspaceStatus,
  type ProjectView,
  type StatusTargetResult,
  type WorkspaceContext,
  type WorkspaceDeps,
  type WorkspaceSummary,
} from './workspace-model.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const WORKSPACE_LINKS_FILENAME = 'links.jsonl';

/** How two ends relate. `from` <kind> `to`. */
export const LINK_KINDS = ['calls', 'exposes', 'consumes', 'relates'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** The same relationship read from the `to` side. Shared with the ports read (`feature-ports.ts`). */
export const INVERSE_KIND: Record<LinkKind, string> = {
  calls: 'called by',
  exposes: 'consumes',
  consumes: 'exposes',
  relates: 'relates',
};

/** The blueprint anchor kinds an address may name (`<kind>:<ref>`). */
export const LINK_ANCHOR_KINDS: readonly AnchorKind[] = ['endpoint', 'file', 'module', 'symbol', 'table'];

const FEATURE_PREFIX = 'feature:';

/** A note is one line a reader takes in at a glance. */
const NOTE_MAX_LENGTH = 300;

/** How many feature notes one anchor end may mirror into — bounded on purpose. */
const MIRROR_FEATURE_CAP = 5;

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** What found a learned link. */
export const LINK_EVIDENCE = ['code', 'model'] as const;
export type LinkEvidence = (typeof LINK_EVIDENCE)[number];

/** One line of `links.jsonl`. */
export interface WorkspaceLinkRecord {
  ts: string;
  author: string | null;
  kind: LinkKind;
  from: string;
  to: string;
  note?: string;
  /** Present only on a link connections learning found. */
  source?: 'learned';
  evidence?: LinkEvidence;
}

/** One end of a link, parsed. */
export interface LinkEnd {
  /** The full address as stored: `<project>/<ref>`. */
  address: string;
  project: string;
  ref: string;
  /** A feature slug, or a blueprint anchor. */
  type: 'feature' | 'anchor';
  /** The feature's slug (type `feature`). */
  feature?: string;
  /** The anchor's kind and reference (type `anchor`). */
  anchorKind?: AnchorKind;
  anchorRef?: string;
}

/** One feature note a link was mirrored into (or could not be). */
export interface LinkMirror {
  project: string;
  /** The feature's slug, or null when the end resolves to no feature note. */
  feature: string | null;
  /** The edge target written — the other end's address. */
  target: string;
  written: boolean;
  /** Why nothing was written, when it was not. */
  detail?: string;
}

export interface LinkKnowledgeResult {
  action: 'link-knowledge';
  workspace: WorkspaceSummary;
  link: WorkspaceLinkRecord;
  /** False when the same from/to/kind was already recorded — nothing appended. */
  recorded: boolean;
  linksPath: string;
  mirrored: LinkMirror[];
}

export interface LinksListResult {
  action: 'links';
  workspace: WorkspaceSummary;
  /** The project filter, or null for every link of the Workspace. */
  project: string | null;
  links: WorkspaceLinkRecord[];
  /** Lines of `links.jsonl` that could not be read — reported, never fatal. */
  unreadable: number;
}

// ─── Addresses ──────────────────────────────────────────────────────────────

/** Collapse to one clean line, or undefined when empty. */
function oneLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return undefined;
  return collapsed.length > NOTE_MAX_LENGTH ? `${collapsed.slice(0, NOTE_MAX_LENGTH - 1)}…` : collapsed;
}

/**
 * Parse `<project>/<ref>`. Pure; null when it is not an address at all. The
 * project is everything before the FIRST slash, so a file anchor keeps its own
 * slashes (`app/file:src/screens/Orders.tsx`).
 */
export function parseLinkAddress(raw: string): LinkEnd | null {
  const value = raw.trim();
  const slash = value.indexOf('/');
  if (slash <= 0) return null;
  const project = value.slice(0, slash).trim();
  const ref = value.slice(slash + 1).trim();
  if (project === '' || ref === '') return null;
  const address = `${project}/${ref}`;
  const colon = ref.indexOf(':');
  if (colon > 0) {
    const prefix = ref.slice(0, colon);
    const rest = ref.slice(colon + 1).trim();
    if ((LINK_ANCHOR_KINDS as readonly string[]).includes(prefix)) {
      if (rest === '') return null;
      return { address, project, ref, type: 'anchor', anchorKind: prefix as AnchorKind, anchorRef: rest };
    }
    if (`${prefix}:` === FEATURE_PREFIX) {
      // ONE spelling per feature end, so `backend/feature:orders`,
      // `backend/feature:backend::orders` and `backend/orders` are one link:
      // the address keeps `<project>/<slug>`. A namespaced id must name the
      // address's own project — `backend/feature:frontend::x` names nothing.
      const parsed = parseFeatureId(`${FEATURE_PREFIX}${rest}`);
      if (rest === '' || parsed === null) return null;
      if (parsed.namespace !== null && parsed.namespace !== project) return null;
      return { address: `${project}/${parsed.slug}`, project, ref: parsed.slug, type: 'feature', feature: parsed.slug };
    }
  }
  // A bare word is a feature slug; anything else with a colon is an unknown anchor kind.
  if (colon > 0) return null;
  return { address, project, ref, type: 'feature', feature: ref };
}

function isLinkKind(value: string): value is LinkKind {
  return (LINK_KINDS as readonly string[]).includes(value);
}

// ─── The store ──────────────────────────────────────────────────────────────

export function workspaceLinksPath(workspacePath: string): string {
  return join(workspacePath, WORKSPACE_LINKS_FILENAME);
}

function recordOf(value: unknown): WorkspaceLinkRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.ts !== 'string' || typeof row.from !== 'string' || typeof row.to !== 'string') return null;
  if (typeof row.kind !== 'string' || !isLinkKind(row.kind)) return null;
  const from = parseLinkAddress(row.from);
  const to = parseLinkAddress(row.to);
  if (from === null || to === null) return null;
  // Read back in the normalized spelling, so a line written the long way (or
  // merged in from another machine) dedupes against the short one.
  const record: WorkspaceLinkRecord = {
    ts: row.ts,
    author: typeof row.author === 'string' ? row.author : null,
    kind: row.kind,
    from: from.address,
    to: to.address,
  };
  const note = typeof row.note === 'string' ? oneLine(row.note) : undefined;
  if (note !== undefined) record.note = note;
  if (row.source === 'learned') {
    record.source = 'learned';
    if (typeof row.evidence === 'string' && (LINK_EVIDENCE as readonly string[]).includes(row.evidence)) {
      record.evidence = row.evidence as LinkEvidence;
    }
  }
  return record;
}

/** Same from/to/kind = the same link. */
function linkKey(record: Pick<WorkspaceLinkRecord, 'from' | 'to' | 'kind'>): string {
  return `${record.from}\u0000${record.to}\u0000${record.kind}`;
}

/**
 * Every link of a Workspace, oldest first, deduplicated by from/to/kind (the
 * first recording wins — a union merge may bring the same link in twice).
 * Fail-soft: a missing file is no links, an unreadable line is counted.
 */
export function readWorkspaceLinks(workspacePath: string): { links: WorkspaceLinkRecord[]; unreadable: number } {
  const path = workspaceLinksPath(workspacePath);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { links: [], unreadable: 0 };
  }
  const seen = new Set<string>();
  const links: WorkspaceLinkRecord[] = [];
  let unreadable = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadable += 1;
      continue;
    }
    const record = recordOf(parsed);
    if (record === null) {
      unreadable += 1;
      continue;
    }
    const key = linkKey(record);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(record);
  }
  return { links, unreadable };
}

/** The links one project takes part in (either end). */
export function linksOfProject(links: readonly WorkspaceLinkRecord[], projectSlug: string): WorkspaceLinkRecord[] {
  return links.filter(
    (link) => parseLinkAddress(link.from)?.project === projectSlug || parseLinkAddress(link.to)?.project === projectSlug,
  );
}

/**
 * The project's own end and the other end of a link, from `projectSlug`'s side.
 * Null when the project is on neither end.
 */
export function linkFromSide(
  link: WorkspaceLinkRecord,
  projectSlug: string,
): { own: LinkEnd; other: LinkEnd; kind: string } | null {
  const from = parseLinkAddress(link.from);
  const to = parseLinkAddress(link.to);
  if (from === null || to === null) return null;
  if (from.project === projectSlug) return { own: from, other: to, kind: link.kind };
  if (to.project === projectSlug) return { own: to, other: from, kind: INVERSE_KIND[link.kind] };
  return null;
}

/** One human line: `backend/endpoint:POST /api/orders —exposes→ app/file:src/Orders.tsx`. */
export function describeLink(link: WorkspaceLinkRecord): string {
  return `${link.from} —${link.kind}→ ${link.to}`;
}

// ─── Resolution ─────────────────────────────────────────────────────────────

function resolveWorkspace(options: { target?: string; workspace?: string } & WorkspaceContext): StatusTargetResult {
  const target = options.target ?? process.cwd();
  const status = workspaceStatus({
    ...(options.flowFolder === undefined ? {} : { flowFolder: options.flowFolder }),
    ...(options.deps === undefined ? {} : { deps: options.deps }),
    target,
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
  });
  if (!('target' in status) || status.workspace === null || status.project === null) {
    throw new WorkspaceRefusal('no-workspace', 'this repository is in no Workspace, so there are no sibling projects to link it with', {
      target,
    });
  }
  return status;
}

function projectsOf(status: StatusTargetResult): ProjectView[] {
  return status.project === null ? [...status.siblings] : [status.project, ...status.siblings];
}

function projectSlugs(status: StatusTargetResult): string[] {
  return projectsOf(status).map((project) => project.slug).sort();
}

function parseEnd(raw: string | undefined, flag: 'from' | 'to', status: StatusTargetResult): LinkEnd {
  const projects = projectSlugs(status);
  const end = raw === undefined ? null : parseLinkAddress(raw);
  if (end === null) {
    throw new WorkspaceRefusal(
      'invalid-link-address',
      `--${flag} must be <project>/<feature-or-anchor> — a project of this Workspace, then a feature (orders) or an anchor (${LINK_ANCHOR_KINDS.map((kind) => `${kind}:…`).join(', ')})`,
      { flag, value: raw ?? null, projects, anchorKinds: [...LINK_ANCHOR_KINDS] },
    );
  }
  if (!projects.includes(end.project)) {
    throw new WorkspaceRefusal('unknown-project', `${end.project} is not a project of the Workspace ${status.workspace?.name ?? ''}`.trim(), {
      flag,
      project: end.project,
      projects,
    });
  }
  return end;
}

function gitAuthor(git: WorkspaceDeps['git'], cwd: string): string | null {
  try {
    const name = git(['config', '--get', 'user.name'], cwd).trim();
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

/** `src/a.ts:run` — a symbol locator after a file extension. */
const FILE_LOCATOR = /^(.*\.[A-Za-z0-9]+):[^/]+$/;

/** Whether a feature's anchors cover an anchor end — exact, or a file under a module anchor. */
export function featureClaimsAnchor(feature: Pick<FeatureNode, 'anchors'>, end: LinkEnd): boolean {
  if (end.type !== 'anchor' || end.anchorRef === undefined) return false;
  const exact = `${end.anchorKind}:${end.anchorRef}`;
  // A file end may carry a symbol locator (`src/a.ts:run`); the file it names
  // is still the file a feature's `file:src/a.ts` anchor claims.
  const located = end.anchorKind === 'file' ? FILE_LOCATOR.exec(end.anchorRef)?.[1] : undefined;
  return feature.anchors.some((anchor) => {
    if (anchor === exact || anchor === end.anchorRef) return true;
    if (located !== undefined && (anchor === `file:${located}` || anchor === located)) return true;
    if (end.anchorKind === 'file' && anchor.startsWith('module:')) {
      const dir = anchor.slice('module:'.length).replace(/\/+$/, '');
      return dir !== '' && end.anchorRef?.startsWith(`${dir}/`) === true;
    }
    return false;
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Mirror one link into the feature notes `own` resolves to, as an edge to
 * `other`. Fail-soft per feature: a note that cannot be written is reported,
 * never fatal — `links.jsonl` already holds the link.
 */
function mirrorEnd(project: ProjectView, own: LinkEnd, other: LinkEnd, kind: string, note: string | undefined): LinkMirror[] {
  const flowDir = project.flowPath;
  const base = { project: project.slug, target: other.address };
  if (!isDirectory(flowDir)) {
    return [{ ...base, feature: null, written: false, detail: 'this project has no knowledge folder on this machine yet' }];
  }
  let features: FeatureNode[];
  try {
    features = readFeatures(flowDir);
  } catch (error) {
    return [{ ...base, feature: null, written: false, detail: error instanceof Error ? error.message : String(error) }];
  }
  const owners =
    own.type === 'feature'
      ? [findFeatureByRef(features, own.feature ?? own.ref)].filter((feature): feature is FeatureNode => feature !== undefined)
      : features.filter((feature) => featureClaimsAnchor(feature, own)).slice(0, MIRROR_FEATURE_CAP);
  if (owners.length === 0) {
    return [
      {
        ...base,
        feature: null,
        written: false,
        detail: own.type === 'feature' ? `no feature note '${own.feature}' in ${project.slug}` : `no feature note in ${project.slug} claims ${own.ref}`,
      },
    ];
  }
  const edge: FeatureEdge = {
    target: other.address,
    ...(own.type === 'anchor' ? { via: own.ref } : {}),
    note: `workspace link — ${kind} ${other.address}${note === undefined ? '' : `: ${note}`}`,
  };
  return owners.map((feature) => {
    try {
      writeForeignEdge(flowDir, feature.slug, edge);
      return { ...base, feature: feature.slug, written: true };
    } catch (error) {
      return { ...base, feature: feature.slug, written: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
}

// ─── link-knowledge ─────────────────────────────────────────────────────────

export interface LinkKnowledgeOptions extends WorkspaceContext {
  /** The repo the caller stands in. Defaults to the working directory. */
  target?: string;
  workspace?: string;
  from?: string;
  to?: string;
  kind?: string;
  note?: string;
  /** Connections learning only: the link was learned, from this evidence. */
  learned?: LinkEvidence;
}

/**
 * THE ONE WRITER of `links.jsonl`. Every refusal is decided before anything is
 * written; the payload carries what the asker needs to retry (the valid
 * project slugs, the kind vocabulary — allowed-pattern #21).
 */
export function linkKnowledge(options: LinkKnowledgeOptions): LinkKnowledgeResult {
  const status = resolveWorkspace(options);
  const workspace = status.workspace as WorkspaceSummary;

  const kind = options.kind?.trim() ?? '';
  if (!isLinkKind(kind)) {
    throw new WorkspaceRefusal('invalid-link-kind', `--kind must be one of ${LINK_KINDS.join(', ')}`, {
      value: options.kind ?? null,
      kinds: [...LINK_KINDS],
    });
  }
  const from = parseEnd(options.from, 'from', status);
  const to = parseEnd(options.to, 'to', status);
  if (from.project === to.project) {
    throw new WorkspaceRefusal('same-project', `both ends are in ${from.project} — a Workspace link connects two different projects`, {
      projects: projectSlugs(status),
    });
  }

  const deps = { git: defaultWorkspaceGit, now: () => new Date(), ...options.deps };
  const linksPath = workspaceLinksPath(workspace.path);
  const { links } = readWorkspaceLinks(workspace.path);
  const existing = links.find((link) => linkKey(link) === linkKey({ from: from.address, to: to.address, kind }));

  let record: WorkspaceLinkRecord;
  if (existing === undefined) {
    record = {
      ts: deps.now().toISOString(),
      author: gitAuthor(deps.git, status.target),
      kind,
      from: from.address,
      to: to.address,
    };
    const note = oneLine(options.note);
    if (note !== undefined) record.note = note;
    if (options.learned !== undefined) {
      record.source = 'learned';
      record.evidence = options.learned;
    }
    mkdirSync(workspace.path, { recursive: true });
    appendFileSync(linksPath, `${JSON.stringify(record)}\n`, 'utf-8');
  } else {
    record = existing;
  }

  const projectBySlug = new Map(projectsOf(status).map((project) => [project.slug, project]));
  const fromProject = projectBySlug.get(from.project) as ProjectView;
  const toProject = projectBySlug.get(to.project) as ProjectView;
  const mirrored = [
    ...mirrorEnd(fromProject, from, to, record.kind, record.note),
    ...mirrorEnd(toProject, to, from, INVERSE_KIND[record.kind], record.note),
  ];

  return { action: 'link-knowledge', workspace, link: record, recorded: existing === undefined, linksPath, mirrored };
}

// ─── links ──────────────────────────────────────────────────────────────────

export interface LinksListOptions extends WorkspaceContext {
  target?: string;
  workspace?: string;
  /** Only the links this project (slug) takes part in. */
  project?: string;
}

export function listWorkspaceLinks(options: LinksListOptions): LinksListResult {
  const status = resolveWorkspace(options);
  const workspace = status.workspace as WorkspaceSummary;
  const projects = projectSlugs(status);
  if (options.project !== undefined && !projects.includes(options.project)) {
    throw new WorkspaceRefusal('unknown-project', `${options.project} is not a project of the Workspace ${workspace.name}`, {
      project: options.project,
      projects,
    });
  }
  const { links, unreadable } = readWorkspaceLinks(workspace.path);
  return {
    action: 'links',
    workspace,
    project: options.project ?? null,
    links: options.project === undefined ? links : linksOfProject(links, options.project),
    unreadable,
  };
}
