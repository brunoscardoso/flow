/**
 * FEATURE PORTS — what comes into a feature's diagram and what goes out of it
 * (plan `diagram-entry-exit` phase 1, discovery FR-1..FR-10).
 *
 *   planflow-ai blueprint features ports --feature <ref> [--target <repo>] [--workspace <w>] --json
 *
 * The one read the board draws a diagram's edge columns from (allowed-pattern
 * #14): it gathers every connection that touches the feature (or one of its
 * parts), turns each into a PORT — a direction, what crosses, the far end named
 * as finely as Flow can prove, the internal component it touches, and how far
 * to trust it — and prints ONE JSON line, a `FeaturePorts`. Nothing it computes
 * is written anywhere: the connections stay the only store of links (NFR-2),
 * and ports are derived from them on every read.
 *
 * SOURCES
 *   • the Workspace's `links.jsonl` (`workspace-links.ts`, the one reader) —
 *     every link with this project on one end whose near end names this
 *     feature, or an anchor this feature (or one of its parts) claims through
 *     `featureClaimsAnchor` (the one anchor → feature resolver);
 *   • the feature's own IN-PROJECT `relates` edges, and other features' edges
 *     pointing at it. Edges whose target is another project's address are the
 *     MIRROR of a Workspace link (`writeForeignEdge`) and are skipped — the link
 *     itself is already read, and reading its mirror would draw it twice.
 *   Outside a Workspace only the in-project `relates` edges exist. A PART's
 *   ports come from links only: `relates` edges are recorded per feature, and
 *   attributing one to a part would be a guess.
 *
 * DIRECTION — how `link-knowledge` and connections learning write a link
 * (`workspace-connections.ts`' prompt: "calls = from sends requests to to;
 * exposes = from serves something to uses; consumes = from reads data or
 * events to produces"). One rule covers every kind: the DEPENDENT side reaches
 * out (an exit), the side depended on is reached (an entry).
 *
 *   kind       this feature is `from`    this feature is `to`
 *   ─────────  ────────────────────────  ──────────────────────
 *   calls      out (it sends the call)   in  (the call arrives)
 *   consumes   out (it reads from to)    in  (it is read from)
 *   exposes    in  (its users reach it)  out (it uses from's thing)
 *   relates    linked                    linked
 *   (in-project `relates` edges)         linked, either way round
 *
 * `relates` is undirected, so it is never an entry or an exit — it is a
 * neutral "Linked" port (discovery Q4).
 *
 * FAR END — named only to the grain that is known (FR-3): the project (slug
 * and display name from `workspace.json`); the feature (a feature end by its
 * slug, an anchor end by the ONE core feature that claims it — two claimants
 * is not a resolution, so neither is named); the part, when exactly one part
 * of that feature claims the anchor; the file and symbol, when the address is
 * a `file:` (with an optional `:symbol` locator) or `symbol:` anchor. `local`
 * is true when the far end is in this project.
 *
 * CROSSING — the link's note, else the relationship read from this side
 * (`calls` / `called by`, `exposes` / `consumes`, …).
 *
 * TRUST — `evidence: code` → code, `evidence: model` → model (drawn dashed,
 * "suggested by Flow"), no evidence (a person or a skill recorded it, or a
 * feature note's edge) → declared.
 *
 * INTERNAL NODE — the curated view's component the near end touches (FR-6):
 * the component whose code citation (`code.file`) is the near anchor's file,
 * else (for a feature) the component titled like the one part that claims the
 * near anchor — else null, and the port is drawn to the diagram's edge, never
 * to a guessed component. A feature reads its view's root level; a part reads
 * the level its own component drills into, when it has one.
 *
 * BOUNDED — deduped by direction + far end + crossing (the strongest trust
 * wins), sorted code → declared → model, at most `PORTS_PER_SIDE_CAP` per side,
 * the rest counted in `more` — never dropped silently (NFR-3).
 *
 * VIEW PORTS (phase 2) — the curated view's own `ports` on the matched level:
 * entries and exits the learning pass named, each on one of the level's
 * components (the validator refused any that touched no component, cited a
 * missing file or a function its file never mentions). They are `trust: model`,
 * `source: view`. A view port whose direction and far end a CONNECTION port
 * already covers is dropped — the connection carries evidence, so it wins —
 * and the connection keeps the view's component when it matched none itself.
 *
 * Refusals follow the family: a JSON payload line carrying what the asker
 * needs (allowed-pattern #21), then `features refused: <reason> — <sentence>`,
 * exit 1.
 */

import { join } from 'node:path';

import { readPartsBySlug } from './feature-graph-read.js';
import { addressableParts } from './feature-graph.js';
import { findFeatureByRef, readFeatures, resolveFeatureRef, FEATURE_ID_PREFIX, type FeatureEdge, type FeatureNode, type FeaturePart } from './feature-store.js';
import { readFeatureView, type ViewLevel, type ViewPort } from './feature-view.js';
import {
  INVERSE_KIND,
  featureClaimsAnchor,
  parseLinkAddress,
  readWorkspaceLinks,
  type LinkEnd,
  type LinkKind,
  type WorkspaceLinkRecord,
} from '../handlers/workspace-links.js';
import {
  WorkspaceRefusal,
  workspaceStatus,
  type ProjectView,
  type WorkspaceContext,
} from '../handlers/workspace-model.js';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** At most this many ports per side; the rest are counted in `more`. */
export const PORTS_PER_SIDE_CAP = 12;

/** The root level of a curated view — what opens. */
const ROOT_LEVEL = 'root';

export type PortDirection = 'in' | 'out' | 'linked';
export type PortTrust = 'code' | 'model' | 'declared';
/** Where a port came from: a connection (link or edge), or — phase 2 — the view's own claim. */
export type PortSource = 'connection' | 'view';

/** Sort order and dedupe strength: code before declared before model. */
const TRUST_RANK: Record<PortTrust, number> = { code: 0, declared: 1, model: 2 };

/** The direction of a link's port, by kind and by which end this feature is. */
export const PORT_DIRECTION: Record<LinkKind, { from: PortDirection; to: PortDirection }> = {
  calls: { from: 'out', to: 'in' },
  consumes: { from: 'out', to: 'in' },
  exposes: { from: 'in', to: 'out' },
  relates: { from: 'linked', to: 'linked' },
};

/** The relationship an in-project `relates` edge reads as, when it has no note. */
const RELATES_PHRASE = INVERSE_KIND.relates;

// ─── Shapes ─────────────────────────────────────────────────────────────────

/** The other end of a port, named only as finely as is known. */
export interface PortFarEnd {
  /** The far project's slug in the Workspace. Absent outside a Workspace. */
  project?: string;
  /** Its display name from `workspace.json`, when the project is listed. */
  projectName?: string;
  /** The far feature's slug. */
  feature?: string;
  /** Its id (`feature:<slug>`), when the far store was read and holds it. */
  featureId?: string;
  featureName?: string;
  /** The far part's id (`<featureId>/<part-slug>`), when exactly one part claims the anchor. */
  part?: string;
  partName?: string;
  /** Repo-relative file in the far project, from a `file:` or `symbol:` anchor. */
  file?: string;
  /** Function / symbol in that file, when the anchor names one. */
  symbol?: string;
  /** The raw anchor (`endpoint:POST /api/x`), when the far end is an anchor. */
  anchor?: string;
  /** True when the far end is in this project. */
  local: boolean;
}

export interface FeaturePort {
  direction: PortDirection;
  /** What crosses — the link note, else the relationship read from this side. */
  crosses: string;
  /** The far end. */
  far: PortFarEnd;
  /** The curated component the near end touches, or null (drawn to the diagram's edge). */
  internalNode: string | null;
  trust: PortTrust;
  source: PortSource;
}

export interface FeaturePorts {
  action: 'features-ports';
  /** The feature's id. */
  feature: string;
  slug: string;
  name: string;
  /** The part, when the reference named one. */
  part: { id: string; name: string } | null;
  /** This project's slug in its Workspace, or null outside one. */
  project: string | null;
  workspace: { name: string; slug: string } | null;
  in: FeaturePort[];
  out: FeaturePort[];
  linked: FeaturePort[];
  /** How many ports past the cap each side holds. */
  more: { in: number; out: number; linked: number };
  /** Lines of `links.jsonl` that could not be read — reported, never fatal. */
  unreadableLinks: number;
}

/** A question the read cannot answer, with what the asker needs to ask again. */
export class PortsRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly sentence: string,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(`${reason} — ${sentence}`);
    this.name = 'PortsRefusal';
  }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/** Direction of a link's port from one side of it. */
export function portDirection(kind: LinkKind, side: 'from' | 'to'): PortDirection {
  return PORT_DIRECTION[kind][side];
}

/** What crosses: the note, else the relationship as this side reads it. */
export function portCrossing(kind: LinkKind, side: 'from' | 'to', note: string | undefined): string {
  if (note !== undefined && note.trim() !== '') return note.trim();
  return side === 'from' ? kind : INVERSE_KIND[kind];
}

/** Trust from a link's evidence: none means a person or a skill declared it. */
export function portTrust(record: Pick<WorkspaceLinkRecord, 'evidence'>): PortTrust {
  if (record.evidence === 'code') return 'code';
  if (record.evidence === 'model') return 'model';
  return 'declared';
}

/** `foo.ts:sym` — a locator after a file extension. */
const FILE_LOCATOR = /^(.*\.[A-Za-z0-9]+):([^/]+)$/;
/** `foo.ts#sym`. */
const SYMBOL_HASH = /^(.+)#([^#/]+)$/;

/**
 * The file (and symbol) an anchor names. `file:src/a.ts` → file; `file:src/a.ts:run`
 * → file + symbol; `symbol:src/a.ts#run` or `symbol:src/a.ts:run` → file +
 * symbol; a bare `symbol:run` → symbol only. Other kinds name no file.
 */
export function anchorLocation(kind: string | undefined, ref: string | undefined): { file?: string; symbol?: string } {
  if (ref === undefined || ref.trim() === '') return {};
  const value = ref.trim();
  if (kind === 'file') {
    const locator = FILE_LOCATOR.exec(value);
    return locator === null ? { file: value } : { file: locator[1], symbol: locator[2] };
  }
  if (kind === 'symbol') {
    const hash = SYMBOL_HASH.exec(value);
    if (hash !== null) return { file: hash[1], symbol: hash[2] };
    const locator = FILE_LOCATOR.exec(value);
    if (locator !== null) return { file: locator[1], symbol: locator[2] };
    return { symbol: value };
  }
  return {};
}

function stripDotSlash(path: string): string {
  return path.replace(/^\.\//, '');
}

/** The component whose code citation is `file`, or null. */
function nodeCitingFile(level: ViewLevel | null, file: string | undefined): string | null {
  if (level === null || file === undefined) return null;
  const wanted = stripDotSlash(file);
  const hit = level.nodes.find((node) => node.code !== undefined && stripDotSlash(node.code.file) === wanted);
  return hit?.id ?? null;
}

/**
 * The component that IS a part — the same rule the app's `matchCuratedComponent`
 * uses (raw title, trimmed, equal to the part's name).
 */
export function componentTitled(level: ViewLevel | null, name: string): string | null {
  const wanted = name.trim();
  if (level === null || wanted === '') return null;
  return level.nodes.find((node) => node.title.trim() === wanted)?.id ?? null;
}

// ─── The near side ──────────────────────────────────────────────────────────

interface AddressedPart {
  id: string;
  name: string;
  part: FeaturePart;
}

interface NearSide {
  /** This project's slug, or null outside a Workspace. */
  project: string | null;
  feature: FeatureNode;
  /** The part the reference named, or null for the whole feature. */
  part: AddressedPart | null;
  /** All of the feature's addressable parts. */
  parts: AddressedPart[];
  /** The view level ports are matched against. */
  level: ViewLevel | null;
}

/** Whether a link end is this feature (or part) — by name, or by a claimed anchor. */
function isNearEnd(end: LinkEnd, near: NearSide): boolean {
  if (near.project === null || end.project !== near.project) return false;
  if (near.part !== null) return end.type === 'anchor' && featureClaimsAnchor(near.part.part, end);
  if (end.type === 'feature') return findFeatureByRef([near.feature], end.feature ?? end.ref) !== undefined;
  return featureClaimsAnchor(near.feature, end) || near.parts.some((entry) => featureClaimsAnchor(entry.part, end));
}

/** The internal component a near anchor end touches (FR-6), or null. */
function internalNodeOf(end: LinkEnd, near: NearSide): string | null {
  if (end.type !== 'anchor') return null;
  const byFile = nodeCitingFile(near.level, anchorLocation(end.anchorKind, end.anchorRef).file);
  if (byFile !== null) return byFile;
  if (near.part !== null) return null;
  for (const entry of near.parts) {
    if (!featureClaimsAnchor(entry.part, end)) continue;
    const component = componentTitled(near.level, entry.name);
    if (component !== null) return component;
  }
  return null;
}

/** The internal component an in-project edge's `via` names, or null. */
function internalNodeOfVia(via: string | undefined, near: NearSide): string | null {
  if (via === undefined || via.trim() === '') return null;
  const raw = via.trim();
  const ref = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
  return nodeCitingFile(near.level, anchorLocation('file', ref).file);
}

// ─── The far side ───────────────────────────────────────────────────────────

interface ProjectStore {
  features: FeatureNode[];
  parts: Map<string, AddressedPart[]>;
}

function storeOf(flowDir: string, features?: FeatureNode[]): ProjectStore | null {
  try {
    const list = features ?? readFeatures(flowDir);
    const partsBySlug = readPartsBySlug(flowDir, list);
    const parts = new Map<string, AddressedPart[]>();
    for (const feature of list) parts.set(feature.slug, addressableParts(feature.id, partsBySlug.get(feature.slug) ?? []));
    return { features: list, parts };
  } catch {
    return null;
  }
}

interface FarContext {
  current: string | null;
  /** This project's own store, for naming a view port's local far feature. */
  ownStore: ProjectStore | null;
  projects: Map<string, ProjectView>;
  stores: Map<string, ProjectStore | null>;
}

function farStore(project: string, context: FarContext): ProjectStore | null {
  if (context.stores.has(project)) return context.stores.get(project) ?? null;
  const view = context.projects.get(project);
  const store = view === undefined ? null : storeOf(view.flowPath);
  context.stores.set(project, store);
  return store;
}

/** Name the far end of a link as finely as is known — never guessed. */
function resolveFar(end: LinkEnd, context: FarContext): PortFarEnd {
  const far: PortFarEnd = { project: end.project, local: end.project === context.current };
  const projectName = context.projects.get(end.project)?.name;
  if (projectName !== undefined) far.projectName = projectName;
  const store = farStore(end.project, context);

  if (end.type === 'feature') {
    const slug = end.feature ?? end.ref;
    far.feature = slug;
    const found = store === null ? undefined : findFeatureByRef(store.features, slug);
    if (found !== undefined) {
      far.feature = found.slug;
      far.featureId = found.id;
      far.featureName = found.name;
    }
    return far;
  }

  far.anchor = `${end.anchorKind ?? ''}:${end.anchorRef ?? ''}`;
  const location = anchorLocation(end.anchorKind, end.anchorRef);
  if (location.file !== undefined) far.file = location.file;
  if (location.symbol !== undefined) far.symbol = location.symbol;
  if (store === null) return far;

  const claimants = store.features.filter(
    (feature) =>
      feature.kind === 'core' &&
      (featureClaimsAnchor(feature, end) || (store.parts.get(feature.slug) ?? []).some((entry) => featureClaimsAnchor(entry.part, end))),
  );
  // Two features claiming one anchor is not a resolution: name neither.
  if (claimants.length !== 1) return far;
  const owner = claimants[0];
  far.feature = owner.slug;
  far.featureId = owner.id;
  far.featureName = owner.name;
  const parts = (store.parts.get(owner.slug) ?? []).filter((entry) => featureClaimsAnchor(entry.part, end));
  if (parts.length === 1) {
    far.part = parts[0].id;
    far.partName = parts[0].name;
  }
  return far;
}

// ─── Dedupe, sort, cap ──────────────────────────────────────────────────────

function farKey(far: PortFarEnd): string {
  return [far.project, far.feature, far.part, far.file, far.symbol, far.anchor].map((value) => value ?? '').join('\u0000');
}

function portKey(port: FeaturePort): string {
  return `${port.direction}\u0000${farKey(port.far)}\u0000${port.crosses}`;
}

/** The label a port sorts by — the far end as a reader would name it. */
function farLabel(far: PortFarEnd): string {
  return [far.projectName ?? far.project, far.featureName ?? far.feature, far.partName, far.file, far.symbol, far.anchor]
    .filter((value): value is string => value !== undefined)
    .join(' ');
}

/** One port per direction + far end + crossing; the strongest trust wins, then a matched node. */
export function dedupePorts(ports: readonly FeaturePort[]): FeaturePort[] {
  const byKey = new Map<string, FeaturePort>();
  for (const port of ports) {
    const key = portKey(port);
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, port);
      continue;
    }
    const stronger = TRUST_RANK[port.trust] < TRUST_RANK[seen.trust];
    byKey.set(key, {
      ...(stronger ? port : seen),
      internalNode: seen.internalNode ?? port.internalNode,
    });
  }
  return [...byKey.values()];
}

function comparePorts(a: FeaturePort, b: FeaturePort): number {
  const byTrust = TRUST_RANK[a.trust] - TRUST_RANK[b.trust];
  if (byTrust !== 0) return byTrust;
  const byFar = farLabel(a.far).localeCompare(farLabel(b.far));
  if (byFar !== 0) return byFar;
  return a.crosses.localeCompare(b.crosses);
}

/** Sort a side and cap it; `more` is what the cap left out. */
export function capPorts(ports: readonly FeaturePort[], cap = PORTS_PER_SIDE_CAP): { shown: FeaturePort[]; more: number } {
  const sorted = [...ports].sort(comparePorts);
  return { shown: sorted.slice(0, cap), more: Math.max(0, sorted.length - cap) };
}

// ─── View ports ─────────────────────────────────────────────────────────────

/** One view port as a `FeaturePort`, its far end named from what the stores hold. */
function viewPortOf(port: ViewPort, direction: 'in' | 'out', context: FarContext): FeaturePort {
  const project = port.far.project ?? context.current ?? undefined;
  const far: PortFarEnd = { local: port.far.project === undefined || port.far.project === context.current };
  if (project !== undefined) {
    far.project = project;
    const projectName = context.projects.get(project)?.name;
    if (projectName !== undefined) far.projectName = projectName;
  }
  if (port.far.feature !== undefined) {
    far.feature = port.far.feature;
    const store = project === undefined ? context.ownStore : farStore(project, context);
    const found = store === null ? undefined : findFeatureByRef(store.features, port.far.feature);
    if (found !== undefined) {
      far.feature = found.slug;
      far.featureId = found.id;
      far.featureName = found.name;
    }
  }
  if (port.far.file !== undefined) far.file = port.far.file;
  if (port.far.symbol !== undefined) far.symbol = port.far.symbol;
  return {
    direction,
    crosses: port.crosses.trim(),
    far,
    internalNode: port.node,
    trust: 'model',
    source: 'view',
  };
}

/** Ports the matched view level names itself. */
function viewPorts(level: ViewLevel | null, context: FarContext): FeaturePort[] {
  if (level?.ports === undefined) return [];
  const ports: FeaturePort[] = [];
  for (const port of level.ports.in ?? []) ports.push(viewPortOf(port, 'in', context));
  for (const port of level.ports.out ?? []) ports.push(viewPortOf(port, 'out', context));
  return ports;
}

const VIEW_FAR_FIELDS = ['feature', 'file', 'symbol'] as const;

/**
 * Whether a connection port covers a view port: same direction, same project,
 * and every far field the VIEW names (feature, file, symbol) equal to the
 * connection's. The crossing is not compared — two phrasings of one call are
 * one port, and the connection's phrasing is the one with evidence behind it.
 */
export function connectionCovers(connection: FeaturePort, view: FeaturePort): boolean {
  if (connection.direction !== view.direction) return false;
  if ((connection.far.project ?? '') !== (view.far.project ?? '')) return false;
  return VIEW_FAR_FIELDS.every((field) => view.far[field] === undefined || connection.far[field] === view.far[field]);
}

/**
 * Merge view ports into connection ports. A covered view port is dropped; the
 * first covering connection keeps the view's component when it had none.
 */
export function mergeViewPorts(connections: readonly FeaturePort[], fromView: readonly FeaturePort[]): FeaturePort[] {
  const merged = connections.map((port) => ({ ...port }));
  const kept: FeaturePort[] = [];
  for (const port of fromView) {
    const cover = merged.find((connection) => connectionCovers(connection, port));
    if (cover === undefined) {
      kept.push(port);
      continue;
    }
    if (cover.internalNode === null) cover.internalNode = port.internalNode;
  }
  return [...merged, ...kept];
}

// ─── The read ───────────────────────────────────────────────────────────────

export interface ReadFeaturePortsInput extends WorkspaceContext {
  /** The project's checkout. */
  repoRoot: string;
  /** A feature reference (slug, id, address) or a part id (`feature:<slug>/<part>`). */
  feature: string;
  /** Which Workspace, when the repo is in more than one. */
  workspace?: string;
}

function resolveNear(features: FeatureNode[], flowDir: string, ref: string): { feature: FeatureNode; part: AddressedPart | null } | null {
  const feature = findFeatureByRef(features, ref);
  if (feature !== undefined) return { feature, part: null };
  const wanted = ref.includes(':') ? ref : `${FEATURE_ID_PREFIX}${ref}`;
  for (const candidate of features) {
    if (!wanted.startsWith(`${candidate.id}/`)) continue;
    const parts = storeOf(flowDir, [candidate])?.parts.get(candidate.slug) ?? [];
    const match = parts.find((entry) => entry.id === wanted);
    if (match !== undefined) return { feature: candidate, part: match };
  }
  return null;
}

/** The level a feature's (or part's) ports are matched against. */
function levelOf(flowDir: string, feature: FeatureNode, part: AddressedPart | null): ViewLevel | null {
  const view = readFeatureView(flowDir, feature.slug);
  if (view === null) return null;
  const root = view.views[ROOT_LEVEL] ?? null;
  if (part === null) return root;
  const component = root === null ? undefined : root.nodes.find((node) => node.id === componentTitled(root, part.name));
  if (component?.view === undefined) return null;
  return view.views[component.view] ?? null;
}

function workspaceOf(input: ReadFeaturePortsInput): { project: ProjectView; siblings: ProjectView[]; workspace: { name: string; slug: string; path: string } } | null {
  let status;
  try {
    status = workspaceStatus({
      ...(input.flowFolder === undefined ? {} : { flowFolder: input.flowFolder }),
      ...(input.deps === undefined ? {} : { deps: input.deps }),
      target: input.repoRoot,
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
    });
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw new PortsRefusal(error.reason, error.sentence, error.payload);
    throw error;
  }
  if (!('target' in status) || status.workspace === null || status.project === null) return null;
  return {
    project: status.project,
    siblings: status.siblings,
    workspace: { name: status.workspace.name, slug: status.workspace.slug, path: status.workspace.path },
  };
}

/** Ports from the Workspace's links. */
function linkPorts(links: readonly WorkspaceLinkRecord[], near: NearSide, context: FarContext): FeaturePort[] {
  const ports: FeaturePort[] = [];
  for (const record of links) {
    const from = parseLinkAddress(record.from);
    const to = parseLinkAddress(record.to);
    if (from === null || to === null) continue;
    const fromIsNear = isNearEnd(from, near);
    const toIsNear = isNearEnd(to, near);
    // Neither end is this feature — or both, which a cross-project link cannot be.
    if (fromIsNear === toIsNear) continue;
    const side = fromIsNear ? 'from' : 'to';
    const nearEnd = fromIsNear ? from : to;
    const farEnd = fromIsNear ? to : from;
    ports.push({
      direction: portDirection(record.kind, side),
      crosses: portCrossing(record.kind, side, record.note),
      far: resolveFar(farEnd, context),
      internalNode: internalNodeOf(nearEnd, near),
      trust: portTrust(record),
      source: 'connection',
    });
  }
  return ports;
}

/** Linked ports from the feature's in-project `relates` edges, both ways round. */
function relatesPorts(features: readonly FeatureNode[], near: NearSide, context: FarContext): FeaturePort[] {
  const self = near.feature;
  const ids = features.map((feature) => feature.id);
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const ports: FeaturePort[] = [];
  const add = (other: FeatureNode, edge: FeatureEdge): void => {
    const far: PortFarEnd = { feature: other.slug, featureId: other.id, featureName: other.name, local: true };
    if (context.current !== null) {
      far.project = context.current;
      const projectName = context.projects.get(context.current)?.name;
      if (projectName !== undefined) far.projectName = projectName;
    }
    ports.push({
      direction: 'linked',
      crosses: edge.note?.trim() || RELATES_PHRASE,
      far,
      // Matched against THIS feature's view only, so a `via` naming the other
      // side's file simply finds nothing — never a wrong component.
      internalNode: internalNodeOfVia(edge.via, near),
      trust: 'declared',
      source: 'connection',
    });
  };
  // Only `feature:` targets are in-project; an address target is a link's mirror.
  const inProject = (target: string): FeatureNode | undefined => {
    if (!target.startsWith(FEATURE_ID_PREFIX)) return undefined;
    const id = resolveFeatureRef(target, ids);
    return id === null ? undefined : byId.get(id);
  };
  for (const edge of self.relates) {
    const other = inProject(edge.target);
    if (other !== undefined && other.id !== self.id) add(other, edge);
  }
  for (const other of features) {
    if (other.id === self.id) continue;
    for (const edge of other.relates) {
      if (inProject(edge.target)?.id === self.id) add(other, edge);
    }
  }
  return ports;
}

/** Assemble one feature's (or part's) ports. Throws `PortsRefusal`. */
export function readFeaturePorts(input: ReadFeaturePortsInput): FeaturePorts {
  const ref = input.feature.trim();
  if (ref === '') throw new PortsRefusal('arguments', 'pass --feature <id|slug> — the feature or part whose ports to read');
  const flowDir = join(input.repoRoot, 'flow');
  let features: FeatureNode[];
  try {
    features = readFeatures(flowDir);
  } catch {
    features = [];
  }
  const resolved = resolveNear(features, flowDir, ref);
  if (resolved === null) {
    throw new PortsRefusal('unknown-feature', `no feature or part named '${ref}' in this project`, {
      feature: ref,
      features: features.filter((feature) => feature.kind === 'core').map((feature) => feature.slug).sort(),
    });
  }

  const ws = workspaceOf(input);
  const current = ws?.project.slug ?? null;
  const ownStore = storeOf(flowDir, features);
  const near: NearSide = {
    project: current,
    feature: resolved.feature,
    part: resolved.part,
    parts: ownStore?.parts.get(resolved.feature.slug) ?? [],
    level: levelOf(flowDir, resolved.feature, resolved.part),
  };
  const projects = new Map<string, ProjectView>();
  if (ws !== null) for (const project of [ws.project, ...ws.siblings]) projects.set(project.slug, project);
  const context: FarContext = { current, ownStore, projects, stores: new Map() };
  if (current !== null) context.stores.set(current, ownStore);

  let unreadableLinks = 0;
  const ports: FeaturePort[] = [];
  if (ws !== null) {
    const read = readWorkspaceLinks(ws.workspace.path);
    unreadableLinks = read.unreadable;
    ports.push(...linkPorts(read.links, near, context));
  }
  if (near.part === null) ports.push(...relatesPorts(features, near, context));

  const unique = dedupePorts(mergeViewPorts(dedupePorts(ports), viewPorts(near.level, context)));
  const side = (direction: PortDirection) => capPorts(unique.filter((port) => port.direction === direction));
  const incoming = side('in');
  const outgoing = side('out');
  const linked = side('linked');

  return {
    action: 'features-ports',
    feature: resolved.feature.id,
    slug: resolved.feature.slug,
    name: resolved.feature.name,
    part: resolved.part === null ? null : { id: resolved.part.id, name: resolved.part.name },
    project: current,
    workspace: ws === null ? null : { name: ws.workspace.name, slug: ws.workspace.slug },
    in: incoming.shown,
    out: outgoing.shown,
    linked: linked.shown,
    more: { in: incoming.more, out: outgoing.more, linked: linked.more },
    unreadableLinks,
  };
}

// ─── The verb ───────────────────────────────────────────────────────────────

export interface FeaturePortsVerbInput extends WorkspaceContext {
  repoRoot: string;
  feature?: string;
  workspace?: string;
  /** `--json`: one JSON line; otherwise one human line per port. */
  json?: boolean;
}

export interface FeaturePortsVerbOutput {
  exitCode: number;
  /** Exactly what the command prints on stdout. */
  stdout: string;
}

const ARROW: Record<PortDirection, string> = { in: '→ in ', out: 'out →', linked: '— linked' };

/** One human line per port, for a terminal reader. */
export function describeFeaturePorts(ports: FeaturePorts): string[] {
  const title = ports.part === null ? ports.name : `${ports.name} › ${ports.part.name}`;
  const lines = [`ports of ${title}: ${ports.in.length + ports.more.in} in, ${ports.out.length + ports.more.out} out, ${ports.linked.length + ports.more.linked} linked`];
  for (const port of [...ports.in, ...ports.out, ...ports.linked]) {
    const node = port.internalNode === null ? '' : ` (at ${port.internalNode})`;
    lines.push(`  ${ARROW[port.direction]} ${farLabel(port.far)} — ${port.crosses} [${port.trust}]${node}`);
  }
  return lines;
}

export function runFeaturePortsVerb(input: FeaturePortsVerbInput): FeaturePortsVerbOutput {
  try {
    const ports = readFeaturePorts({
      repoRoot: input.repoRoot,
      feature: typeof input.feature === 'string' ? input.feature : '',
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      ...(input.flowFolder === undefined ? {} : { flowFolder: input.flowFolder }),
      ...(input.deps === undefined ? {} : { deps: input.deps }),
    });
    const stdout = input.json === true ? `${JSON.stringify(ports)}\n` : `${describeFeaturePorts(ports).join('\n')}\n`;
    return { exitCode: 0, stdout };
  } catch (error) {
    if (error instanceof PortsRefusal) {
      const payload = JSON.stringify({ action: 'features-ports', refused: error.reason, ...error.payload });
      return { exitCode: 1, stdout: `${payload}\nfeatures refused: ${error.reason} — ${error.sentence}\n` };
    }
    throw error;
  }
}
