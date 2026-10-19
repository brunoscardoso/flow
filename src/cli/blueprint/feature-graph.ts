/**
 * Feature graph + coverage (feature-blueprint) — the board's data source.
 *
 * Three words, one meaning each: a FEATURE (`core`) is a capability, a PART is
 * a piece of it (read from the owner's `## Parts`), a CHANGE (`child`) is a
 * plan or an issue that touched it. Features render on the board's root ring
 * and parts on drill-down; a change is carried for its parent link and drawn on
 * no ring. `relates` becomes edges, so the root is a graph rather than a wall
 * of equal nodes. (This supersedes "two levels only", decision #7 — that was
 * the design before parts became nodes.)
 *
 * Each node carries the two things the card shows (decision #10):
 *   understanding — none | learning | learned | stale
 *   activity      — is a plan touching this right now
 *
 * COVERAGE is the answer to the blind spot the design deliberately did not
 * store (decision #5 + #18). Replacing module learning means code no feature
 * references is invisible AND un-learnable, and there is no bucket reporting
 * it. So it is COMPUTED on demand — code-map nodes minus the union of feature
 * anchors — which costs nothing to maintain and keeps correction conversational.
 * The information exists; only the storage was rejected.
 *
 * Pure and fail-soft: a missing store, a missing graph or a corrupt line yields
 * an empty/partial result, never a throw.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { addressPartNames, edgeKey, featureHome, featureSummary, parseLearnings, resolveFeatureRef, slugifyFeatureName, splitLearned } from './feature-store.js';
import type { FeatureNode, FeaturePart } from './feature-store.js';
import type { BlueprintGraph } from './types.js';
import type { FeatureSize } from './feature-size.js';
import type { FeatureFolders, FolderNodeInput } from './feature-folders.js';

/** Anchors in, files-and-lines out — `createAnchorMeasurer` for the real repo. */
export type AnchorMeasurer = (anchors: readonly string[]) => FeatureSize;

/**
 * A node in, where it lives out — `createFolderRowsBuilder(...).rowsFor`, ONE
 * builder per graph read, so the shared set is computed once over the core
 * features and every node's rows come from the same answer.
 */
export type FolderRowsFor = (input: FolderNodeInput) => FeatureFolders | null;

/** Learning status of a feature, mirroring the module tier it replaces. */
export type FeatureUnderstanding = 'none' | 'learning' | 'learned' | 'stale';

/**
 * One node in the feature graph.
 *
 * THREE KINDS, THREE MEANINGS — the distinction the board used to collapse.
 * A **core** is a capability. A **part** is a piece OF that capability, read
 * from the owning feature's `## Parts` section. A **child** is a CHANGE record
 * — a plan or an issue that touched a capability, mined from the corpus. The
 * board rendered `core ? feature : part`, so every change was drawn as a
 * structural piece and every real part was invisible. Kinds are read
 * explicitly from here on; never re-derive one by negating another.
 */
export interface FeatureGraphNode {
  id: string;
  slug: string;
  name: string;
  kind: 'core' | 'child' | 'part';
  parent?: string;
  /**
   * The owning feature's SLUG, on `kind: 'part'` nodes only. `parent` already
   * carries the owning feature's id, but a consumer that needs to tell a part
   * from a core would otherwise have to re-derive it — and re-deriving a kind
   * from something other than the kind is exactly the bug this widening fixes.
   */
  partOf?: string;
  /** Grouping label for the root ring. HUMAN-OWNED on the feature; absent stays absent. */
  domain?: string;
  understanding: FeatureUnderstanding;
  /** True when a live plan proposal touches one of this feature's anchors. */
  active: boolean;
  anchorCount: number;
  /**
   * What the anchors STAND ON, resolved on disk: distinct files and their
   * lines (`feature-size.ts`). The board's Territory draws area from this —
   * `anchorCount` is how many anchor lines were written, which says nothing
   * about size. Absent when the graph was built without a measurer.
   */
  size?: FeatureSize;
  /**
   * WHERE it lives, in the file explorer's words: its top folders with each
   * one's share (`feature-folders.ts`; plan `feature-home-folders`). Derived on
   * every read, never stored. On features and parts only, and only when the
   * graph was built with a checkout to read — absent when no files were found
   * (no rows rather than a guessed folder), and on a change.
   */
  folders?: FeatureFolders;
  /** One line saying what this feature IS — empty when it says nothing. */
  summary: string;
}

/** A `relates` edge between two features. Undirected in meaning, stored once. */
export interface FeatureGraphEdge {
  from: string;
  to: string;
  /**
   * The mechanism changed (or vanished) since the edge was recorded, so the
   * note is a claim to VERIFY rather than a fact to quote. Absent means either
   * fresh or unstamped — `stale-check` is the authority, and it is passed in
   * rather than recomputed here so there is only ever one answer.
   */
  stale?: boolean;
}

export interface FeatureGraph {
  nodes: FeatureGraphNode[];
  edges: FeatureGraphEdge[];
}

/** What no feature covers — computed, never stored. */
export interface CoverageReport {
  /** Graph node ids no feature anchor references. */
  uncovered: string[];
  /** Total graph nodes considered. */
  total: number;
  /** Features contributing anchors. */
  features: number;
}

const LEARNING_STATE_FILE = 'learning-state.jsonl';

/**
 * Read module learning status. Feeds the IN-FLIGHT and STALE halves of
 * `understandingOf` — a module being learned never makes a feature learned
 * (see there); only the feature's own `## Learned` section does.
 */
export function readModuleLearning(structureDir: string): Map<string, FeatureUnderstanding> {
  const out = new Map<string, FeatureUnderstanding>();
  const filePath = join(structureDir, LEARNING_STATE_FILE);
  if (!existsSync(filePath)) return out;
  let raw = '';
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as { module?: unknown; status?: unknown };
      if (typeof entry.module !== 'string') continue;
      const status = entry.status;
      if (status === 'learning' || status === 'learned' || status === 'stale') {
        out.set(entry.module, status);
      }
    } catch {
      continue; // one corrupt line never hides the rest
    }
  }
  return out;
}

/** The module path an anchor points into, or null when it names no module. */
export function moduleOfAnchor(anchor: string): string | null {
  const colon = anchor.indexOf(':');
  if (colon < 0) return null;
  const kind = anchor.slice(0, colon);
  const ref = anchor.slice(colon + 1);
  if (kind === 'module') return ref;
  if (kind === 'file') {
    const slash = ref.lastIndexOf('/');
    return slash > 0 ? ref.slice(0, slash) : null;
  }
  return null;
}

/**
 * A feature's understanding — THE FEATURE'S OWN, not its modules'.
 *
 * This used to be worst-wins over the modules a feature references, with a
 * comment saying feature-keyed state would arrive later. It arrived: the learn
 * pass writes the feature's `## Learned` section. The placeholder outlived it,
 * and the result was a board that lied. Measured on orbit-core: basic
 * discovery learned 29 MODULES, so ~30 feature cards reported `learned` while
 * their body was still the bootstrap stub `Confirmed from code:module/…`. The
 * two features anyone had actually learned looked exactly like the thirty
 * nobody had.
 *
 * The rule now:
 *   • the feature has learnings          → `learned` (or `stale`, below)
 *   • a module it references is in-flight → `learning` — honest about work
 *     happening right now, and it cannot be mistaken for knowledge
 *   • anything else                       → `none`
 *
 * A module being learned NEVER makes the feature learned. Understanding a
 * directory is not understanding what the product does with it — that gap is
 * the entire reason features exist as their own layer.
 *
 * `stale` still comes from the modules: a feature whose own learnings exist but
 * whose referenced code has drifted is exactly the stale case, and the module
 * layer is where drift is detected.
 *
 * A VALID CURATED VIEW ALSO COUNTS — and why that does not re-open `d5ae3b83`
 * ==========================================================================
 * `d5ae3b83` removed a lie: MODULE learning was making features report
 * `learned`, so ~30 cards claimed knowledge nobody had about the product. Its
 * rule is "a feature's understanding is its OWN, not its modules'".
 *
 * A curated view is the feature's OWN artifact. It is produced by reading that
 * feature's code and plans and it is filed under that feature's slug, exactly
 * like its `## Learned` section — the two are the prose and the picture halves
 * of one act, and after the one-button collapse a single pass writes both. So
 * counting it is the same rule applied, not a widening of it: still the
 * feature's own evidence, still never a module's.
 *
 * The guard that keeps it from becoming the old lie is VALIDITY. `viewedSlugs`
 * must hold only slugs whose artifact passed the real `validateFeatureView`
 * and belongs to that feature (see `runFeaturesGraph`, which reuses the
 * inspection `computeFeatureLimitations` already performs). An artifact that
 * merely EXISTS on disk proves nothing: this repo's own stored view was dead
 * for four days with three validator errors nobody ever saw, and a board that
 * counted it would claim knowledge from a broken file. Do not widen this to
 * "a file is there".
 */
export function understandingOf(
  feature: FeatureNode,
  moduleLearning: ReadonlyMap<string, FeatureUnderstanding>,
  /** Slugs whose curated view passed the validator AND names this feature. */
  viewedSlugs: ReadonlySet<string> = new Set(),
): FeatureUnderstanding {
  // #1346 (main) counts a THIRD piece of the feature's own evidence: the
  // `lastFullRead` stamp a complete, successful pass writes onto the FEATURE
  // file. A pass that finished but whose prose was later edited away still
  // read the code, so the stamp is knowledge the other two signals can miss.
  //
  // It joins the `learned` predicate rather than early-returning on its own,
  // which is how main wrote it: an early return would report a feature as
  // `learned` while the code its evidence was drawn from has since drifted.
  // Staleness is one fact about the feature and does not depend on which of
  // the three signals produced the evidence — see the note below.
  const fullyRead = feature.lastFullRead !== null && feature.lastFullRead !== '';
  const learned =
    parseLearnings(splitLearned(feature.body).learned).length > 0 ||
    viewedSlugs.has(feature.slug) ||
    fullyRead;

  let sawModule = false;
  let anyLearning = false;
  let anyStale = false;
  for (const anchor of feature.anchors) {
    const modulePath = moduleOfAnchor(anchor);
    if (modulePath === null) continue;
    sawModule = true;
    const status = moduleLearning.get(modulePath) ?? 'none';
    if (status === 'learning') anyLearning = true;
    if (status === 'stale') anyStale = true;
  }

  // STALE MEANS THE SAME THING FOR EITHER ARTIFACT: the code this feature's
  // evidence was drawn from has drifted since it was written. That is one fact
  // about the feature, and it does not become a different fact depending on
  // which half of the pass produced the evidence — both halves read the same
  // ranked files in the same session.
  //
  // If anything the picture is the MORE code-bound of the two: a curated view
  // cites file-and-line excerpts, so drift can invalidate it outright while
  // prose about behaviour often survives. Reporting a drifted view as `learned`
  // would be the stronger claim, so the shared rule is also the conservative
  // one.
  if (learned) return sawModule && anyStale ? 'stale' : 'learned';
  return anyLearning ? 'learning' : 'none';
}

/**
 * The module a PART anchor points into.
 *
 * Part anchors are written as BARE repo-relative paths — `src/components/chat/
 * ChatPanelWrapper.tsx`, `e2e/tests/chats/table-output.spec.ts` —
 * rather than the `module:` / `file:` refs a feature's frontmatter carries. Run
 * through `moduleOfAnchor` alone, every one of them reports "names no module",
 * so the in-flight and drift signals would be dead for parts by construction.
 *
 * A prefixed anchor still goes through `moduleOfAnchor`: a part is free to
 * write either form, and this must not become a second grammar.
 */
export function moduleOfPartAnchor(anchor: string): string | null {
  const trimmed = anchor.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(':')) return moduleOfAnchor(normalizeAnchorRef(trimmed));
  const slash = trimmed.lastIndexOf('/');
  const last = slash < 0 ? trimmed : trimmed.slice(slash + 1);
  // A trailing extension means the anchor names a FILE, so the module is the
  // directory holding it; anything else is already a directory.
  if (!/\.[A-Za-z0-9]+$/.test(last)) return trimmed;
  return slash > 0 ? trimmed.slice(0, slash) : null;
}

/**
 * A PART's understanding — the PART's own, never inherited from its feature.
 *
 * This is `d5ae3b83`'s rule one level down. That commit removed a board that
 * reported ~30 features as `learned` because their MODULES were; inheriting a
 * feature's status here would report ten parts as learned because ONE sibling
 * was, which is the same lie with a smaller blast radius and a straighter face
 * — the reader would be told the SSE stream is understood because somebody
 * learned the Chats list.
 *
 * So: only the part's own non-superseded learnings count as knowledge, and only
 * its own anchors carry the in-flight and drift signals. A SUPERSEDED learning
 * is retained prose about something that is no longer true; counting it would
 * make a part that has been explicitly corrected still claim to be understood.
 *
 * NO ANCHORS IS ALWAYS `none`. The CLI already refuses to learn such a part —
 * "names no anchors, nothing to learn it from, and nothing to re-check when the
 * code drifts" — so a part that cannot be learned must never be able to say it
 * has been.
 */
export function partUnderstandingOf(
  part: FeaturePart,
  moduleLearning: ReadonlyMap<string, FeatureUnderstanding>,
): FeatureUnderstanding {
  if (part.anchors.length === 0) return 'none';
  const learned = part.learnings.some((entry) => entry.supersededReason === undefined);

  let sawModule = false;
  let anyLearning = false;
  let anyStale = false;
  for (const anchor of part.anchors) {
    const modulePath = moduleOfPartAnchor(anchor);
    if (modulePath === null) continue;
    sawModule = true;
    const status = moduleLearning.get(modulePath) ?? 'none';
    if (status === 'learning') anyLearning = true;
    if (status === 'stale') anyStale = true;
  }

  if (learned) return sawModule && anyStale ? 'stale' : 'learned';
  return anyLearning ? 'learning' : 'none';
}

/**
 * The id of one part — the owning feature's id plus the slugified part name.
 *
 * DERIVED FROM THE NAME, NOT THE POSITION, on purpose. A part is addressable:
 * the composer's reference chip stores this string and `blueprint context`
 * resolves it, so an id keyed on ordinal position would silently break every
 * saved reference the moment a human inserted a part above it — and nothing
 * detects a broken reference. Slugifying reuses `slugifyFeatureName` rather
 * than growing a second slug grammar for the same job.
 */
export function partNodeId(featureId: string, partName: string): string {
  return `${featureId}/${slugifyFeatureName(partName)}`;
}

/**
 * A feature's parts with the id each is addressed by, in document order.
 *
 * The ONE place a part's id is minted (allowed-pattern #14): the board's part
 * nodes and every verb that takes a part reference (`blueprint storyline
 * --part`) resolve through here, so a reference the board handed out always
 * names the same part on the way back in. An unnamed part is unaddressable and
 * skipped; a duplicate name gets a deterministic `-2`, `-3` suffix.
 */
export function addressableParts(
  featureId: string,
  parts: readonly FeaturePart[],
): Array<{ id: string; name: string; part: FeaturePart }> {
  // The rule itself lives in the store (`addressPartNames`), which also has
  // to find a part by its address when it writes the part's `home:` line.
  const named = parts.filter((part) => part.name.trim().length > 0);
  const ids = addressPartNames(featureId, named.map((part) => part.name));
  return named.map((part, index) => ({ id: ids[index], name: part.name.trim(), part }));
}

/**
 * Build the part nodes for one feature, in DOCUMENT ORDER.
 *
 * Order is the human's, not the machine's. Parts are prose someone sequenced
 * deliberately — `Chat UI → SDK client → BFF stream → SSE endpoint → engine`
 * traces a message through the system — and sorting them alphabetically would
 * shred that narrative into `Chat SDK client, Chat UI, Chats list, Chat control
 * API…`. Features sort by id because nobody authored their order; parts do not
 * because someone did.
 *
 * A duplicate name gets a deterministic `-2`, `-3` suffix rather than being
 * dropped: two parts a human named the same thing is a fixable mistake in a
 * precious file, while a node that silently vanishes from the board is not
 * even visible as one (NFR2).
 */
function buildPartNodes(
  feature: FeatureNode,
  parts: readonly FeaturePart[],
  moduleLearning: ReadonlyMap<string, FeatureUnderstanding>,
  activeAnchors: ReadonlySet<string>,
  measure: AnchorMeasurer | undefined,
  folders: FolderRowsFor | undefined,
): FeatureGraphNode[] {
  const nodes: FeatureGraphNode[] = [];
  for (const { id, name, part } of addressableParts(feature.id, parts)) {
    // A part name-matches by ITS OWN name (the last segment of its address),
    // never its owner's slug — that would hand it the whole feature's files.
    const rows =
      folders === undefined
        ? null
        : folders({ slug: id.slice(id.lastIndexOf('/') + 1), anchors: part.anchors, home: part.home ?? null });
    nodes.push({
      id,
      slug: feature.slug,
      name,
      kind: 'part',
      parent: feature.id,
      partOf: feature.slug,
      understanding: partUnderstandingOf(part, moduleLearning),
      active: part.anchors.some((anchor) => activeAnchors.has(anchor)),
      anchorCount: part.anchors.length,
      ...(measure === undefined ? {} : { size: measure(part.anchors) }),
      ...(rows === null ? {} : { folders: rows }),
      summary: part.summary.trim(),
    });
  }
  return nodes;
}

/**
 * Build the feature graph. `activeAnchors` are anchors a live plan touches —
 * a feature is ACTIVE when the plan overlaps its own anchors, which is what
 * makes live work float to the top of the board.
 *
 * `viewedSlugs` carries the OTHER half of understanding — see `understandingOf`.
 * It is passed in rather than computed here because the caller has already
 * inspected the view store to report its gaps, and inspecting twice would let
 * the two answers disagree about which artifacts are valid.
 *
 * `partsBySlug` carries each feature's `## Parts`, keyed by SLUG (the handle
 * `readParts` takes). It is passed in for the same reason as `viewedSlugs` and
 * one more: this function stays I/O-FREE, so the whole graph is testable from
 * literals and no disk read can make it throw. An absent or empty map yields
 * exactly today's graph — parts are SURFACED by this, never created, so a store
 * whose features have never been learned gains no nodes and that is correct.
 */
export function buildFeatureGraph(
  features: readonly FeatureNode[],
  moduleLearning: ReadonlyMap<string, FeatureUnderstanding>,
  activeAnchors: ReadonlySet<string> = new Set(),
  viewedSlugs: ReadonlySet<string> = new Set(),
  partsBySlug: ReadonlyMap<string, FeaturePart[]> = new Map(),
  staleEdges: ReadonlySet<string> = new Set(),
  measure?: AnchorMeasurer,
  folders?: FolderRowsFor,
): FeatureGraph {
  const byId = new Set(features.map((feature) => feature.id));
  const nodes: FeatureGraphNode[] = [...features]
    .map((feature) => {
      const node: FeatureGraphNode = {
        id: feature.id,
        slug: feature.slug,
        name: feature.name,
        kind: feature.kind,
        understanding: understandingOf(feature, moduleLearning, viewedSlugs),
        active: feature.anchors.some((anchor) => activeAnchors.has(anchor)),
        anchorCount: feature.anchors.length,
        summary: featureSummary(feature.body),
      };
      // SIZE IS MEASURED, NEVER STORED: the feature file owns its anchors, the
      // disk owns how much code they reach, and this function stays I/O-free
      // by taking the measurer the way it takes the parts.
      if (measure !== undefined) node.size = measure(feature.anchors);
      // WHERE IT LIVES — derived like the size, through the caller's one
      // builder. A change gets no rectangle, so it gets no rows either.
      if (folders !== undefined && feature.kind === 'core') {
        const rows = folders({ slug: feature.slug, anchors: feature.anchors, home: featureHome(feature) });
        if (rows !== null) node.folders = rows;
      }
      // A child whose parent is missing renders at level 1 rather than
      // vanishing — losing a node is worse than misplacing one.
      // `resolveFeatureRef` reads `feature:x` and `feature:<project>/x` as one
      // feature inside a Workspace project (FR-20), and is exact everywhere else.
      if (feature.parent !== undefined) {
        const parent = resolveFeatureRef(feature.parent, byId);
        if (parent !== null) node.parent = parent;
      }
      if (feature.domain !== undefined) node.domain = feature.domain;
      return { feature, node };
    })
    .sort((a, b) => a.node.id.localeCompare(b.node.id))
    // Each feature is followed by its own parts: the features are ordered by
    // id, the parts inside each one by the order they were written. Sorting
    // the flattened list would have to choose one of those two orders and lose
    // the other.
    .flatMap(({ feature, node }) => [
      node,
      ...buildPartNodes(
        feature,
        partsBySlug.get(feature.slug) ?? [],
        moduleLearning,
        activeAnchors,
        measure,
        folders,
      ),
    ]);

  const seen = new Set<string>();
  const edges: FeatureGraphEdge[] = [];
  for (const feature of features) {
    for (const edge of feature.relates) {
      const other = resolveFeatureRef(edge.target, byId);
      if (other === null || other === feature.id) continue;
      // Store one edge per unordered pair.
      const key = [feature.id, other].sort().join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      // ONLY the staleness verdict rides along. `via`/`note` stay OUT of the
      // graph on purpose (Phase 1's rule, and the test that names it): they are
      // for a reader of the FEATURE, and the graph is a shape. But a reader
      // must never quote an edge whose mechanism moved as a verified fact, so
      // the verdict is not optional decoration — it is the warning.
      edges.push({
        from: feature.id,
        to: other,
        ...(staleEdges.has(edgeKey(feature.id, other)) || staleEdges.has(edgeKey(feature.id, edge.target)) ? { stale: true } : {}),
      });
    }
  }
  edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  return { nodes, edges };
}

// ── The roster ──────────────────────────────────────────────────────────────
//
// THE ONE INPUT AN EDGE WRITER CANNOT WORK WITHOUT.
//
// A relationship is a semantic fact, so it has to be read and recorded — and
// recording one means NAMING THE OTHER SIDE. When a pass learns Playbooks it
// reads code and sees a skill slug resolved by a binder; it can only write
// `feature:skills` if it knows that Skills is a named capability in THIS
// store. Without the roster it writes a sentence about a binder, records no
// edge, and the store stays exactly as empty as it has been across all 101
// features. That is the measured failure this exists to remove.
//
// It reuses `featureSummary` deliberately: the one-liner a card shows is the
// same one-liner a writer needs to recognise a capability by. A second summary
// would be a second thing to keep true.

/** One feature as the vocabulary an edge writer may draw from. */
export interface FeatureRosterEntry {
  /** The id an edge's `target` must name — this is the point of the roster. */
  id: string;
  slug: string;
  name: string;
  /** `core` (a capability) or `child` (a change record). */
  kind: 'core' | 'child';
  /** `featureSummary` of the body — empty when the feature says nothing. */
  summary: string;
}

/**
 * Build the roster: every feature in the store, by id.
 *
 * PURE and total — no disk, no clock, no filtering by understanding. A feature
 * nobody has learned yet is still a name an edge may point at, and dropping it
 * would make the vocabulary depend on the order things happened to be learned
 * in.
 *
 * Sorted by id so a prompt built from the same store twice is the same prompt
 * (and, once these files are tracked, so is anything generated from it).
 */
export function buildFeatureRoster(features: readonly FeatureNode[]): FeatureRosterEntry[] {
  return [...features]
    .map((feature) => ({
      id: feature.id,
      slug: feature.slug,
      name: feature.name,
      kind: feature.kind,
      summary: featureSummary(feature.body),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Explicit bucket for core features carrying no `domain` — grouped, never
 * dropped. A silent count would be indistinguishable from a bug; this bucket
 * makes "not yet seeded/labelled" a visible, addressable group on the board.
 */
export const UNASSIGNED_DOMAIN = 'Unassigned';

/** One domain's core features — the board's root-ring grouping. */
export interface DomainGroup {
  domain: string;
  features: FeatureGraphNode[];
}

/**
 * Group CORE nodes by `domain` for the board's root ring. Domains group the
 * ring only — they are not a node kind and never render their own
 * feature-view (`VIEW_NODE_KINDS` stays frozen). Children are grouped with
 * their parent's card, not independently, so only `kind: 'core'` nodes are
 * considered here.
 *
 * A core feature with no `domain` — never seeded, or a human cleared it —
 * lands in the explicit `UNASSIGNED_DOMAIN` bucket rather than disappearing
 * from the board or the count.
 *
 * Deterministic: groups sort by domain name, with `Unassigned` always last so
 * a fully-labelled board reads real domains first.
 */
export function groupByDomain(nodes: readonly FeatureGraphNode[]): DomainGroup[] {
  const byDomain = new Map<string, FeatureGraphNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'core') continue;
    const domain = node.domain ?? UNASSIGNED_DOMAIN;
    const list = byDomain.get(domain);
    if (list === undefined) byDomain.set(domain, [node]);
    else list.push(node);
  }
  return [...byDomain.entries()]
    .map(([domain, features]) => ({ domain, features }))
    .sort((a, b) => {
      if (a.domain === UNASSIGNED_DOMAIN) return b.domain === UNASSIGNED_DOMAIN ? 0 : 1;
      if (b.domain === UNASSIGNED_DOMAIN) return -1;
      return a.domain.localeCompare(b.domain);
    });
}

// ── The generated index ─────────────────────────────────────────────────────
//
// THE SEARCHABLE PROJECTION OF THE FEATURE STORE — one file carrying every
// feature's summary, parts and EDGES, so a relational question ("how do skills
// impact playbooks") can be answered by grepping ONE file instead of opening
// thirty-three.
//
// WHERE IT LIVES, AND WHY THAT IS THE WHOLE POINT.
//
// `flow/brain/` is precious, human-editable and Obsidian-visible. A generated
// file sitting among hand-owned ones WILL be edited — it looks exactly like the
// notes beside it — and the next rebuild eats the edit with no diff, no warning
// and no way to get it back. This project has already paid for that confusion
// once: `.structure/` holds a 2.7 MB disposable `graph.json` beside 635 KB of
// irreplaceable investigation notes, which is why its ignore rules have to be
// written one file at a time and why deleting the directory is never safe.
//
// So the index does NOT go in `flow/brain/` and does NOT go in `.structure/`.
// It goes in `flow/brain/.derived/`, a directory with ONE rule: every byte in
// it is regenerable. That makes it ignorable with a single entry, deletable
// without thought, and — dot-prefixed like `.raw/` and `.structure/` — invisible
// in the Obsidian vault, so nobody is ever offered it as a note to edit. The
// banner at the top of the file says the same thing again for whoever arrives
// through a grep result rather than through the directory.
//
// DETERMINISM IS NOT A NICETY HERE. In `shared` mode this layer is generated on
// every teammate's machine; a rebuild that reorders a list or stamps a clock
// turns `git status` into noise, and noise is how a real change gets waved
// through. Same store in, byte-identical file out — no timestamps, no map
// iteration order, no locale-dependent sort.

/** Where the generated index lives, relative to the project's `flow/` dir. */
export const FEATURE_INDEX_RELPATH = 'brain/.derived/INDEX.md';

/**
 * The banner every generated index opens with.
 *
 * Deliberately the FIRST thing in the file and deliberately blunt: a grep hit
 * drops a reader into the middle of a file with no directory context, and
 * "DO NOT EDIT" three screens up is the same as no banner at all. It names the
 * source (the feature markdown) and the regenerating command, because a reader
 * told not to edit something needs to be told where to edit instead.
 */
export const FEATURE_INDEX_BANNER = [
  '<!-- GENERATED — DO NOT EDIT. Rebuilt in full by: planflow-ai blueprint features index -->',
  '',
  '# Feature Index (derived)',
  '',
  'Every line below is a copy. The source is `flow/brain/features/<slug>.md`, which is',
  'human-owned; this file is derived, disposable, and overwritten in full by the next',
  'rebuild. To correct anything here, edit the feature file it came from.',
].join('\n');

/** Render one anchor list as a stable, comma-joined line fragment. */
function joinAnchors(anchors: readonly string[]): string {
  return [...anchors].sort().join(', ');
}

/**
 * One feature's section.
 *
 * FLAT ON PURPOSE — one `##` heading per feature and bullets underneath, no
 * deeper headings. Every consumer of this file (the search chunker, a reader
 * scrolling it, a grep with `-A`) treats a heading as a boundary, so putting
 * `### Relates` under `## Playbooks` would cut the edges away from the name of
 * the thing they belong to and hand back a chunk that says "via the binder"
 * without saying via the binder to WHAT.
 */
function renderFeatureSection(
  feature: FeatureNode,
  nameById: ReadonlyMap<string, string>,
  parts: readonly FeaturePart[],
): string[] {
  const lines: string[] = [`## ${feature.name} — ${feature.id}`, ''];

  const facts = [`kind: ${feature.kind}`];
  if (feature.domain !== undefined) facts.push(`domain: ${feature.domain}`);
  if (feature.parent !== undefined) facts.push(`parent: ${feature.parent}`);
  facts.push(`file: flow/brain/features/${feature.slug}.md`);
  lines.push(facts.join(' · '), '');

  const summary = featureSummary(feature.body);
  if (summary.length > 0) lines.push(`summary: ${summary}`, '');

  if (feature.anchors.length > 0) lines.push(`anchors: ${joinAnchors(feature.anchors)}`, '');

  if (parts.length > 0) {
    lines.push('parts:');
    for (const part of parts) {
      const name = part.name.trim();
      if (name.length === 0) continue; // an unnamed part is unaddressable
      const summaryText = part.summary.trim();
      const anchorText = part.anchors.length > 0 ? ` [anchors: ${joinAnchors(part.anchors)}]` : '';
      lines.push(`- ${name}${summaryText.length > 0 ? ` — ${summaryText}` : ''}${anchorText}`);
    }
    lines.push('');
  }

  // The relational layer — the reason this file exists at all. `via` and `note`
  // ride along (unlike the graph, which carries the shape only): a reader of
  // Playbooks must be able to answer a question about Skills WITHOUT opening
  // Skills, and a bare id sends them into both.
  if (feature.relates.length > 0) {
    lines.push('relates:');
    const rendered = feature.relates
      .map((edge) => {
        const targetName = nameById.get(edge.target);
        const label = targetName === undefined ? edge.target : `${targetName} (${edge.target})`;
        const via = edge.via !== undefined && edge.via.length > 0 ? ` via ${edge.via}` : '';
        const note = edge.note !== undefined && edge.note.length > 0 ? ` — ${edge.note}` : '';
        return `- ${label}${via}${note}`;
      })
      .sort();
    lines.push(...rendered, '');
  }

  return lines;
}

/**
 * Build the whole index. PURE and I/O-FREE — the caller reads the store and
 * hands it in, exactly as `buildFeatureGraph` and `buildFeatureRoster` do, so
 * the generator is testable from literals and no disk read can make it throw.
 *
 * Features sort by id (nobody authored their order); parts keep DOCUMENT ORDER
 * (someone did — `Chat UI → SDK client → BFF stream` traces a message through
 * the system, and alphabetising it shreds that narrative). Edges sort by their
 * rendered line so a store rewritten in a different order still produces the
 * same bytes.
 */
export function buildFeatureIndexMarkdown(
  features: readonly FeatureNode[],
  partsBySlug: ReadonlyMap<string, FeaturePart[]> = new Map(),
): string {
  const ordered = [...features].sort((a, b) => a.id.localeCompare(b.id));
  const nameById = new Map(ordered.map((feature) => [feature.id, feature.name]));

  const edgeCount = ordered.reduce((sum, feature) => sum + feature.relates.length, 0);
  const lines: string[] = [
    FEATURE_INDEX_BANNER,
    '',
    `${String(ordered.length)} feature(s) · ${String(edgeCount)} relationship(s)`,
    '',
  ];

  for (const feature of ordered) {
    lines.push(...renderFeatureSection(feature, nameById, partsBySlug.get(feature.slug) ?? []));
  }

  // Exactly one trailing newline — a generated file that sometimes ends with
  // two is a diff on a machine that never changed anything.
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** One anchor judged against reality, for the brief's verification ledger. */
export interface AnchorResolution {
  /** The anchor exactly as authored — never rewritten. */
  ref: string;
  resolved: boolean;
}

/**
 * Strip the formatting that leaks in when an anchor is promoted out of prose:
 * surrounding backticks and square brackets from a markdown link or code span.
 * A `file:` ref may also carry a trailing `:symbol` or `:42` locator, which
 * names a place INSIDE the file rather than a different file.
 *
 * `file:\`src/hooks/useMessageCatchup.ts:findByClientId\`` names a real
 * file. Judged raw it is unresolvable forever.
 */
export function normalizeAnchorRef(ref: string): string {
  const colon = ref.indexOf(':');
  if (colon < 0) return ref;
  const kind = ref.slice(0, colon);
  let target = ref.slice(colon + 1).replace(/^[`[\s]+/, '').replace(/[`\]\s]+$/, '');
  if (kind === 'file') {
    // A locator suffix follows the extension: `foo.ts:sym`, not `foo.ts`.
    const locator = target.match(/^(.*\.[A-Za-z0-9]+):[^/]*$/);
    if (locator !== null) target = locator[1];
  }
  return `${kind}:${target}`;
}

/**
 * Judge each anchor against reality, BY KIND — the distinction the first cut
 * missed.
 *
 * A `module:` anchor names a graph node, so the graph decides. A `file:` anchor
 * names a path, and the graph has no file nodes at all (its kinds are module /
 * endpoint / integration / datastore) — so checking one against node ids marks
 * every file anchor unresolved no matter how plainly the file exists. The disk
 * decides that one.
 *
 * An unresolvable anchor is reported UNRESOLVED, never dropped: "8 anchors, 0
 * resolved" says the derive has not caught up, while an empty ledger says
 * nothing at all. `repoRoot` is optional — with none, file anchors fall back to
 * the graph and the ledger simply stays conservative.
 */
export function resolveAnchors(
  anchors: readonly string[],
  graph: BlueprintGraph | null,
  repoRoot: string | null = null,
  fileExists: (path: string) => boolean = existsSync,
): AnchorResolution[] {
  const ids = new Set((graph?.nodes ?? []).map((node) => node.id));
  return [...anchors].sort().map((ref) => {
    const normalized = normalizeAnchorRef(ref);
    if (ids.has(ref) || ids.has(normalized)) return { ref, resolved: true };
    if (repoRoot !== null && normalized.startsWith('file:')) {
      return { ref, resolved: fileExists(join(repoRoot, normalized.slice('file:'.length))) };
    }
    return { ref, resolved: false };
  });
}

/**
 * What no feature covers. Only MODULE nodes are considered: endpoints and
 * datastores are detail reached through a module, and counting them would
 * inflate the gap with things nobody expects a feature to claim.
 */
export function computeCoverage(
  features: readonly FeatureNode[],
  graph: BlueprintGraph | null,
): CoverageReport {
  const claimed = new Set<string>();
  for (const feature of features) {
    for (const anchor of feature.anchors) {
      const modulePath = moduleOfAnchor(anchor);
      if (modulePath !== null) claimed.add(`module:${modulePath}`);
    }
  }
  const modules = (graph?.nodes ?? []).filter((node) => node.kind === 'module');
  const uncovered = modules
    .filter((node) => {
      if (claimed.has(node.id)) return false;
      // A module whose ANCESTOR is claimed counts as covered — claiming
      // `module:src/auth` should not leave `module:src/auth/tokens` orphaned.
      const path = node.id.slice('module:'.length);
      for (const claimedId of claimed) {
        const claimedPath = claimedId.slice('module:'.length);
        if (path.startsWith(`${claimedPath}/`)) return false;
      }
      return true;
    })
    .map((node) => node.id)
    .sort();
  return { uncovered, total: modules.length, features: features.length };
}
