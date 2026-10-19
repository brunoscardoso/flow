/**
 * WHAT A DOCUMENT TOUCHES — the features (and their parts) a discovery, plan
 * or brainstorm's `## Story` anchors land in, across the Workspace.
 *
 * A fresh discovery has no proposals yet, so the board could not tell which
 * feature it is about and fell back to an empty brief. Its anchors already
 * say: `orbit-app/src/components/artifacts/ArtifactViewer.tsx` is a file of
 * orbit-app's Artifacts feature. This module answers that question for
 * `blueprint brief`, as an additive `touches` field.
 *
 * WHERE AN ANCHOR LIVES. A Workspace doc may name a sibling project's file by
 * prefixing the project's slug (`<project>/<path>`). A leading segment is read
 * as a project prefix only when (a) it is the slug of a project in this repo's
 * Workspace — resolved by `workspace status`'s own lookup, never derived here —
 * and (b) the path as written does NOT exist in this project's checkout (a
 * monorepo may well have a folder named like a sibling). Everything else
 * resolves in this project.
 *
 * WHICH FEATURE CLAIMS A FILE. Two sources, no third invented here:
 *   1. the feature's (or part's) own anchors — the doc path equals an anchor,
 *      sits under an anchored folder, or is a folder holding an anchor
 *      (`anchorTarget`, the size measurer's own reading of an anchor);
 *   2. the feature's FILE SET from the folder rows (`createFolderRowsBuilder`
 *      `filesFor`): anchored + name-matched + import-traced files, shared code
 *      left out — exactly what the board shows as where the feature lives.
 * A feature touches an anchor when it or any of its parts claims it. Only core
 * features count — a change (`kind: child`) gets no rectangle anywhere.
 *
 * RANKING. Most SPECIFIC claims first, then most anchors, then name. Found
 * live: orbit-core has a `Orbit Core` feature anchored at the whole
 * package (`module:orbit_core`), which holds every file a doc there can name
 * and so out-counted the features that actually own the folders (`Db`,
 * `Services`, and the sibling's `Apps`). It is still reported — it IS touched —
 * but `specific` (claims no other feature of the project makes more narrowly)
 * ranks the owners first.
 *
 * A project with no checkout on this machine is read from its knowledge folder
 * with anchors alone (no file sets: there is no code to read) and reported
 * with `root: null`.
 *
 * The matcher (`matchDocTouches`) is pure; `computeDocTouches` gathers its
 * inputs and is FAIL-SOFT: any error yields `touches: []` plus a notice, never
 * a refused brief.
 */
import { existsSync } from 'node:fs';

import { workspaceContextOf } from '../handlers/workspace-model.js';
import { readFolderImportIndex, readPartsBySlug } from './feature-graph-read.js';
import { addressableParts } from './feature-graph.js';
import { createFolderRowsBuilder, pathMatchesSlug, slugStems, type FolderNodeInput } from './feature-folders.js';
import { anchorTarget, repoSizeHost, type SizeHost } from './feature-size.js';
import { featureHome, readFeaturesWithExclusions, type FeatureNode, type FeaturePart } from './feature-store.js';
import { parseFlowItem } from './story-grammar.js';
import type { StoryStep } from './types.js';

/** One part of a touched feature that claims at least one of the doc's anchors. */
export interface DocTouchPart {
  id: string;
  name: string;
}

/** One feature a document touches. */
export interface DocTouch {
  /** The Workspace project's slug, or null for THIS project. */
  project: string | null;
  /** The project's checkout on this machine, or null when it has none. */
  root: string | null;
  featureId: string;
  featureName: string;
  parts: DocTouchPart[];
  /** How many of the doc's (distinct) anchors fall inside this feature. */
  anchors: number;
  /**
   * How many of those this feature claims MOST narrowly in its project — no
   * other feature owns a deeper folder (or the file itself). A package-wide
   * catch-all touches everything and is specific about nothing.
   */
  specific: number;
}

/** A doc anchor placed in the project it names. */
export interface PlacedAnchor {
  /** The anchor's path as the doc wrote it (kind and locator stripped). */
  raw: string;
  /** The project it resolves in: a Workspace slug, or null for this project. */
  project: string | null;
  /** The path inside that project. */
  path: string;
}

/** One Workspace project as touches reads it. */
export interface TouchWorkspaceProject {
  slug: string;
  /** Checkout on this machine, or null. */
  localPath: string | null;
  /** Knowledge folder (what `<repo>/flow` links to). */
  flowPath: string;
}

/** The Workspace around this repo — `workspace status`'s answer, narrowed. */
export interface TouchWorkspace {
  selfSlug: string;
  siblings: TouchWorkspaceProject[];
}

/** Everything the pure matcher needs of one project. */
export interface TouchProjectData {
  project: string | null;
  root: string | null;
  features: readonly FeatureNode[];
  partsBySlug: ReadonlyMap<string, readonly FeaturePart[]>;
  /** A node's file set (the folder rows' own), or null when there is no checkout. */
  filesFor: ((input: FolderNodeInput) => ReadonlyMap<string, number>) | null;
}

/** Flow ids whose ref is a path (`module:src/a`). Other kinds name no file. */
const PATH_FLOW_PREFIX = 'module:';

/**
 * Every distinct path a story's steps name: each step's anchors (file, module,
 * and symbol anchors that carry a path) and its `module:` flow ids — in
 * first-seen order.
 */
export function docAnchorPaths(
  steps: ReadonlyArray<Pick<StoryStep, 'anchors' | 'flow' | 'flowBefore' | 'flowAfter'>>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (path: string): void => {
    if (path.length === 0 || seen.has(path)) return;
    seen.add(path);
    out.push(path);
  };
  for (const step of steps) {
    for (const anchor of step.anchors) {
      if (anchor.kind !== 'file' && anchor.kind !== 'module' && anchor.kind !== 'symbol') continue;
      const path = anchorTarget(`${anchor.kind}:${anchor.ref}`);
      // A bare symbol name (`MyClass`) is not a place in the tree.
      if (anchor.kind === 'symbol' && !path.includes('/')) continue;
      add(path);
    }
    for (const item of [...(step.flowBefore ?? []), ...(step.flowAfter ?? []), ...(step.flow ?? [])]) {
      const { id } = parseFlowItem(item);
      if (id.startsWith(PATH_FLOW_PREFIX)) add(anchorTarget(id));
    }
  }
  return out;
}

/**
 * Place one doc path in the project it names. A leading Workspace slug is a
 * project prefix only when the path as written does not exist here (see the
 * module note); this project's own slug is stripped by the same rule.
 */
export function placeDocAnchor(
  raw: string,
  workspace: TouchWorkspace | null,
  existsHere: (path: string) => boolean,
): PlacedAnchor {
  const slash = raw.indexOf('/');
  if (workspace === null || slash <= 0 || slash === raw.length - 1) return { raw, project: null, path: raw };
  const head = raw.slice(0, slash);
  const rest = raw.slice(slash + 1);
  const isSelf = head === workspace.selfSlug;
  const isSibling = workspace.siblings.some((sibling) => sibling.slug === head);
  if ((!isSelf && !isSibling) || existsHere(raw)) return { raw, project: null, path: raw };
  return { raw, project: isSelf ? null : head, path: rest };
}

/** Segments in a repo-relative path. */
function depthOf(path: string): number {
  return path.split('/').filter((segment) => segment.length > 0).length;
}

/**
 * The depth of the DEEPEST path segment carrying the slug's name (the folder
 * rows' own name-matching rule), or 0 when none does.
 */
function nameMatchDepth(path: string, slug: string): number {
  const stems = slugStems(slug);
  if (stems.length === 0) return 0;
  const segments = path.split('/');
  for (let i = segments.length; i >= 1; i -= 1) {
    if (pathMatchesSlug(segments[i - 1], stems)) return i;
  }
  return 0;
}

/** The weakest evidence: in the node's file set by import trace alone. */
const TRACED_DEPTH = 1;

/**
 * How SPECIFICALLY a node (slug + anchors + file set) claims `path` — 0 when
 * it does not. The depth of the narrowest evidence:
 *   - an anchor holding the path counts the ANCHOR's depth (`orbit_core` = 1,
 *     `orbit_core/db` = 2); an anchor the doc path holds, or an exact match,
 *     counts the path's depth;
 *   - membership of the node's file set counts the depth of the deepest
 *     segment that carries the node's name (`src/components/artifacts/X.tsx`
 *     for `artifacts` = 3), or `TRACED_DEPTH` when only the import trace put it
 *     there.
 * So a package-wide catch-all feature still TOUCHES everything under it, but
 * never out-ranks the feature that owns the folder — whether by anchor or by a
 * name on the root folder (`orbit-core` name-matches every `orbit_core/…`
 * file, at depth 1).
 */
function claimDepth(
  path: string,
  slug: string,
  anchors: readonly string[],
  files: ReadonlyMap<string, number> | null,
): number {
  let best = files?.has(path) === true ? Math.max(TRACED_DEPTH, nameMatchDepth(path, slug)) : 0;
  for (const anchor of anchors) {
    const target = anchorTarget(anchor);
    if (target.length === 0) continue;
    if (path === target || target.startsWith(`${path}/`)) best = Math.max(best, depthOf(path));
    else if (path.startsWith(`${target}/`)) best = Math.max(best, depthOf(target));
  }
  return best;
}

/** The last segment of a part's address — the slug its files name-match by. */
function partSlugOf(partId: string): string {
  return partId.slice(partId.lastIndexOf('/') + 1);
}

/**
 * The features of ONE project that claim any of `paths` (paths inside that
 * project). Pure: every input is handed over.
 */
export function matchDocTouches(paths: readonly string[], data: TouchProjectData): DocTouch[] {
  return matchWithClaims(paths, data).touches;
}

/** `matchDocTouches`, plus which of `paths` any feature claimed. */
function matchWithClaims(
  paths: readonly string[],
  data: TouchProjectData,
): { touches: DocTouch[]; claimed: Set<string> } {
  const distinct = [...new Set(paths)];
  const claimed = new Set<string>();
  const touches: DocTouch[] = [];
  if (distinct.length === 0) return { touches, claimed };
  const found: Array<{ touch: DocTouch; depths: Map<string, number> }> = [];
  /** Per path, the narrowest claim any feature of this project makes. */
  const deepest = new Map<string, number>();
  for (const feature of data.features) {
    if (feature.kind !== 'core') continue;
    const featureFiles =
      data.filesFor === null
        ? null
        : data.filesFor({ slug: feature.slug, anchors: feature.anchors, home: featureHome(feature) });
    const parts = addressableParts(feature.id, data.partsBySlug.get(feature.slug) ?? []).map((entry) => ({
      ...entry,
      files:
        data.filesFor === null
          ? null
          : data.filesFor({ slug: partSlugOf(entry.id), anchors: entry.part.anchors, home: entry.part.home ?? null }),
    }));
    const inside = new Map<string, number>();
    const touchedParts = new Map<string, DocTouchPart>();
    for (const path of distinct) {
      let depth = claimDepth(path, feature.slug, feature.anchors, featureFiles);
      for (const part of parts) {
        const partDepth = claimDepth(path, partSlugOf(part.id), part.part.anchors, part.files);
        if (partDepth === 0) continue;
        depth = Math.max(depth, partDepth);
        touchedParts.set(part.id, { id: part.id, name: part.name });
      }
      if (depth > 0) {
        inside.set(path, depth);
        claimed.add(path);
        deepest.set(path, Math.max(deepest.get(path) ?? 0, depth));
      }
    }
    if (inside.size === 0) continue;
    found.push({
      touch: {
        project: data.project,
        root: data.root,
        featureId: feature.id,
        featureName: feature.name,
        parts: [...touchedParts.values()],
        anchors: inside.size,
        specific: 0,
      },
      depths: inside,
    });
  }
  // A claim is SPECIFIC when no other feature of this project claims the same
  // path more narrowly.
  for (const { touch, depths } of found) {
    let specific = 0;
    for (const [path, depth] of depths) if (depth >= (deepest.get(path) ?? 0)) specific += 1;
    touches.push({ ...touch, specific });
  }
  return { touches, claimed };
}

/** Most specific anchors first, then most anchors, then by name, then this project before siblings. */
export function rankTouches(touches: readonly DocTouch[]): DocTouch[] {
  return [...touches].sort(
    (a, b) =>
      b.specific - a.specific ||
      b.anchors - a.anchors ||
      a.featureName.localeCompare(b.featureName) ||
      (a.project ?? '').localeCompare(b.project ?? '') ||
      a.featureId.localeCompare(b.featureId),
  );
}

/** Read one project's features, parts and (with a checkout) its file sets. */
export function readTouchProject(project: string | null, root: string | null, flowDir: string): TouchProjectData {
  const { features } = readFeaturesWithExclusions(flowDir);
  const partsBySlug = readPartsBySlug(flowDir, features);
  let filesFor: TouchProjectData['filesFor'] = null;
  if (root !== null) {
    const builder = createFolderRowsBuilder(repoSizeHost(root), {
      coreFeatures: features
        .filter((feature) => feature.kind === 'core')
        .map((feature) => ({ id: feature.id, slug: feature.slug, anchors: feature.anchors, home: featureHome(feature) })),
      imports: readFolderImportIndex(root),
    });
    filesFor = (input) => builder.filesFor(input);
  }
  return { project, root, features, partsBySlug, filesFor };
}

/** What `blueprint brief` adds to its result. */
export interface DocTouchesResult {
  touches: DocTouch[];
  /** One line when something could not be read (or nothing could). */
  notice?: string;
  /**
   * Every doc path, placed. `exists`: on disk where it was placed (null: that
   * project has no checkout here). `claimed`: some feature there claims it.
   */
  placements: Array<PlacedAnchor & { exists: boolean | null; claimed: boolean }>;
}

export interface DocTouchesDeps {
  /** The Workspace around `repoRoot`; defaults to `workspace status`'s lookup. */
  workspace?: (repoRoot: string) => TouchWorkspace | null;
  /** A project's touch data; defaults to `readTouchProject`. */
  readProject?: (project: string | null, root: string | null, flowDir: string) => TouchProjectData;
  /** A checkout's file view; defaults to the disk. */
  host?: (root: string) => SizeHost;
}

/** `workspace status` for `repoRoot`, narrowed — the one Workspace lookup. */
export function workspaceForTouches(repoRoot: string): TouchWorkspace | null {
  const status = workspaceContextOf(repoRoot);
  if (status === null || status.project === null) return null;
  return {
    selfSlug: status.project.slug,
    siblings: status.siblings.map((sibling) => ({
      slug: sibling.slug,
      localPath: sibling.localPath,
      flowPath: sibling.flowPath,
    })),
  };
}

/**
 * The features a document's story touches, across this repo's Workspace.
 * Fail-soft: never throws; an error costs the touches, never the brief.
 */
export function computeDocTouches(
  repoRoot: string,
  flowDir: string,
  steps: ReadonlyArray<Pick<StoryStep, 'anchors' | 'flow' | 'flowBefore' | 'flowAfter'>>,
  deps: DocTouchesDeps = {},
): DocTouchesResult {
  try {
    const raws = docAnchorPaths(steps);
    if (raws.length === 0) return { touches: [], placements: [] };
    const hostOf = deps.host ?? repoSizeHost;
    const readProject = deps.readProject ?? readTouchProject;
    const selfHost = hostOf(repoRoot);
    const existsIn = (host: SizeHost, path: string): boolean => host.classify(path) !== null;
    let workspace: TouchWorkspace | null = null;
    const notes: string[] = [];
    try {
      workspace = (deps.workspace ?? workspaceForTouches)(repoRoot);
    } catch (error) {
      notes.push(`workspace unreadable (${(error as Error).message}) — anchors resolved in this project only`);
    }
    const placed = raws.map((raw) => placeDocAnchor(raw, workspace, (path) => existsIn(selfHost, path)));

    // Group by project; read only projects some anchor lands in.
    const byProject = new Map<string | null, string[]>();
    for (const anchor of placed) byProject.set(anchor.project, [...(byProject.get(anchor.project) ?? []), anchor.path]);

    const touches: DocTouch[] = [];
    const claimedIn = new Map<string | null, Set<string>>();
    const rootOf = new Map<string | null, string | null>([[null, repoRoot]]);
    for (const [project, paths] of byProject) {
      const sibling = project === null ? null : (workspace?.siblings.find((entry) => entry.slug === project) ?? null);
      const root = project === null ? repoRoot : (sibling?.localPath ?? null);
      const knowledge = project === null ? flowDir : (sibling?.flowPath ?? null);
      rootOf.set(project, root);
      if (knowledge === null || !existsSync(knowledge)) {
        if (project !== null) notes.push(`${project}: no knowledge folder here — its anchors were skipped`);
        continue;
      }
      try {
        const matched = matchWithClaims(paths, readProject(project, root, knowledge));
        touches.push(...matched.touches);
        claimedIn.set(project, matched.claimed);
      } catch (error) {
        notes.push(`${project ?? 'this project'}: features unreadable (${(error as Error).message})`);
      }
    }

    const hosts = new Map<string, SizeHost>([[repoRoot, selfHost]]);
    const placements = placed.map((anchor) => {
      const root = rootOf.get(anchor.project) ?? null;
      const claimed = claimedIn.get(anchor.project)?.has(anchor.path) === true;
      if (root === null) return { ...anchor, exists: null, claimed };
      let host = hosts.get(root);
      if (host === undefined) {
        host = hostOf(root);
        hosts.set(root, host);
      }
      return { ...anchor, exists: existsIn(host, anchor.path), claimed };
    });
    return {
      touches: rankTouches(touches),
      placements,
      ...(notes.length > 0 ? { notice: notes.join('; ') } : {}),
    };
  } catch (error) {
    return { touches: [], placements: [], notice: `touches unavailable — ${(error as Error).message}` };
  }
}

/**
 * Whether an anchor the graph could not resolve still resolves in a SIBLING:
 * a project-prefixed path that exists in that sibling's checkout, or — with no
 * checkout — one some sibling feature claims. Returns the sibling's slug.
 */
export function siblingResolution(raw: string, result: DocTouchesResult): string | null {
  const placed = result.placements.find((entry) => entry.raw === raw);
  if (placed === undefined || placed.project === null) return null;
  if (placed.exists === true) return placed.project;
  // No checkout: proven only when a feature of that project claims it.
  if (placed.exists === null && placed.claimed) return placed.project;
  return null;
}
