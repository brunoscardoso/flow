/**
 * Feature discovery (feature-blueprint) — free, deterministic, no LLM.
 *
 * Three sources, and the ORDER carries the design:
 *
 *   1. SURFACES  (`feature-surfaces`)  → core   — what the product DOES
 *   2. CORPUS    (plans / discovery)   → child  — a CHANGE to something it does
 *   3. code dirs (fallback)            → core   — only when 1 and 2 are silent
 *
 * The first version had 1 and 2 the other way round, on the reasoning that a
 * plan doc is a boundary a human already named — true, but it names a boundary
 * of WORK. Shipped, it produced a level-1 board reading "Chat Session Cache Rework,
 * Deprecate Workflows, Duplicate Messages on Chat Switch — ACME-2293": a work
 * log, not a map of the product. The capability names (Chat, Playbooks, Skills,
 * Spaces) were in the repo the whole time, in its routes and its test suites.
 *
 * So plans became children of the capability they touch, and the corpus stopped
 * being able to author a core feature at all.
 *
 * IDENTITY — three keys, in order (decision #6)
 * ============================================
 *   1. `id`     exact, immutable      — the identity of record
 *   2. `slug`   exact, filename       — the human/Obsidian handle
 *   3. anchors  Jaccard ≥ 0.5         — RECOVERY when the name drifted
 *
 * Ordering matters more than the threshold: id and slug are exact, so overlap
 * is only ever a fallback. That is what lets a rename be free (id survives)
 * while a re-run that names the same feature differently still finds it.
 *
 * NEVER A DIRECT WRITE
 * ====================
 * A match UPDATES anchors through `feature-store` (which preserves every
 * human-owned field). A miss becomes a CANDIDATE — staged, never written as a
 * feature. The design has no confirmation gate, so the only thing protecting a
 * boundary the user corrected by hand is that discovery cannot author one.
 *
 * DEVIATION from plan task 2.4: candidates are staged in
 * `flow/brain/.structure/feature-candidates.jsonl` rather than
 * `proposals.jsonl`. `PROPOSAL_KINDS` is a frozen union of graph node kinds
 * (integration/endpoint/datastore/module) validated by the canonical contract;
 * adding `feature` would ripple into that validator and the extractor id
 * grammar for something that is not a graph node. The candidate store is
 * derived and disposable, which is the correct trust tier for a guess.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { CorpusDocRecord } from './corpus-index.js';
import { corpusLinkStats, linkCorpusDoc, type CorpusLink, type CorpusLinkStats, type CorpusOwner } from './corpus-parent.js';
import { mintFeatureId, readParts, sameFeatureId, slugifyFeatureName, type FeatureNode } from './feature-store.js';
import { canonicalKey, mineSurfaces } from './feature-surfaces.js';
import { readEffectiveProposals } from './proposal-store.js';
import type { BlueprintGraph } from './types.js';

/** Anchor-overlap threshold for identity recovery. Named, never inlined. */
export const ANCHOR_JACCARD_THRESHOLD = 0.5;

/** Where staged candidates live — derived and disposable, never precious. */
export const CANDIDATES_FILENAME = 'feature-candidates.jsonl';

/** Corpus directories mined for already-named features, in priority order. */
const CORPUS_DIRS = ['plans', 'discovery', 'archive'] as const;

/** A proposed feature that does not yet exist in the store. */
export interface FeatureCandidate {
  slug: string;
  name: string;
  anchors: string[];
  /** Where the proposal came from — corpus doc path, or 'code:<heuristic>'. */
  source: string;
  /**
   * Level this belongs at. Surfaces name CAPABILITIES (core); the plan/discovery
   * corpus names CHANGES TO capabilities (child). Getting this backwards is what
   * put "Chat Session Cache Rework" on the board next to nothing it was a migration
   * OF — a work log wearing a feature map's clothes.
   */
  kind: 'core' | 'child';
  /** Slug of the core this child belongs under, when one was identified. */
  parentSlug?: string;
}

/** Result of a discovery pass. */
export interface DiscoverResult {
  /** Existing features whose anchors changed, with the new anchor set. */
  updated: Array<{ feature: FeatureNode; anchors: string[]; matchedBy: 'id' | 'slug' | 'anchors' }>;
  /** Features that do not exist yet — staged, never written. */
  candidates: FeatureCandidate[];
  /**
   * Every corpus doc the pass saw, one per FILE (#1532) — where `mineCorpus`
   * dedupes by slug so a live plan beats its archived copy, the index wants
   * both files, the archived one flagged. Dateless here; the corpus-index
   * builder resolves `created`/`indexed`.
   */
  corpusDocs: CorpusDocRecord[];
  /** How the corpus docs were linked to a capability — the derive line reports it. */
  corpusLinks: CorpusLinkStats;
}

/** `- anchors: a, b, c` lines inside a doc's `## Story` section. */
const ANCHOR_LINE = /^-\s+anchors:\s*(.+)$/;
/** A bare `module:`/`file:`/`datastore:`/`endpoint:` reference anywhere in prose. */
const ANCHOR_REF = /\b((?:module|file|datastore|integration):[^\s,`)\]]+)/g;
/** `plan_<name>_vN.md` / `discovery_<name>_vN.md` / `brainstorm_<name>_vN.md`. */
const CORPUS_NAME = /^(?:plan|discovery|brainstorm)_(.+?)(?:_v\d+)?\.md$/;

/** Jaccard similarity of two anchor sets. Empty ∩ empty is 0, never 1. */
export function anchorJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/** Anchor envelope kinds the store uses. Anything else is a bare path. */
const ANCHOR_KINDS = new Set(['module', 'file', 'symbol', 'table', 'endpoint', 'datastore', 'integration']);

/**
 * Normalize an anchor to envelope form. The Story grammar accepts BARE PATHS
 * (`- anchors: src/cli/blueprint/x.ts`) and converts them to `file:` when it
 * parses; storing the raw string instead left every anchor unresolvable —
 * `nodeIdOfAnchor` saw no prefix and returned null, so features claimed
 * nothing. Normalizing here keeps one spelling in the store.
 */
export function normalizeAnchor(raw: string): string {
  const item = raw.trim();
  const colon = item.indexOf(':');
  if (colon > 0 && ANCHOR_KINDS.has(item.slice(0, colon))) return item;
  return `file:${item}`;
}

/** Extract anchors from one doc: explicit Story anchors, then bare refs. */
function anchorsFromDoc(markdown: string): string[] {
  const found = new Set<string>();
  for (const line of markdown.split('\n')) {
    const explicit = ANCHOR_LINE.exec(line.trim());
    if (explicit !== null) {
      for (const item of explicit[1].split(',')) {
        const ref = item.trim();
        if (ref.length > 0) found.add(normalizeAnchor(ref));
      }
    }
  }
  // Bare references are a weaker signal; only used when a doc declared none.
  if (found.size === 0) {
    for (const match of markdown.matchAll(ANCHOR_REF)) found.add(match[1]);
  }
  return [...found].sort();
}

/** Title-case a slug for a display name when the doc has no heading. */
function nameFromSlug(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** A doc's `# ` title line — the display name a human actually wrote. */
const DOC_HEADING = /^#\s+(.+?)\s*$/m;

/** One corpus doc file, as walked — the shared input for candidates + index. */
interface CorpusWalkDoc {
  dirName: (typeof CORPUS_DIRS)[number];
  fileName: string;
  slug: string;
  /** The doc's `# ` heading, when it has one. */
  heading: string | null;
  anchors: string[];
  /** The doc's text — the corpus parenting reads its declared feature and its paths. */
  markdown: string;
}

/**
 * Walk the corpus dirs once, one record per readable doc FILE. Deterministic:
 * dirs in `CORPUS_DIRS` order, sorted entries. Both `mineCorpus` (per-slug
 * candidates) and the corpus index (per-doc entries, #1532) derive from this,
 * so the two can never disagree about what a pass saw.
 */
function walkCorpus(flowDir: string): CorpusWalkDoc[] {
  const docs: CorpusWalkDoc[] = [];
  for (const dirName of CORPUS_DIRS) {
    const dir = join(flowDir, dirName);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).sort()) {
      const match = CORPUS_NAME.exec(entry);
      if (match === null) continue;
      let markdown = '';
      try {
        markdown = readFileSync(join(dir, entry), 'utf-8');
      } catch {
        continue;
      }
      docs.push({
        dirName,
        fileName: entry,
        slug: slugifyFeatureName(match[1]),
        heading: DOC_HEADING.exec(markdown)?.[1] ?? null,
        anchors: anchorsFromDoc(markdown),
        markdown,
      });
    }
  }
  return docs;
}

/** Candidates from walked docs — split out so `discoverFeatures` walks once. */
function corpusCandidates(docs: readonly CorpusWalkDoc[]): FeatureCandidate[] {
  const bySlug = new Map<string, FeatureCandidate>();
  for (const doc of docs) {
    if (bySlug.has(doc.slug)) continue;
    bySlug.set(doc.slug, {
      slug: doc.slug,
      name: nameFromSlug(doc.slug),
      anchors: doc.anchors,
      source: join(doc.dirName, doc.fileName),
      // A plan is a change to a feature, never the feature. Parenting happens
      // in `discoverFeatures`, which is the only place that knows the cores.
      kind: 'child',
    });
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Mine the corpus for features someone already named. Deterministic: sorted
 * directory walk, sorted anchors, first-seen wins on duplicate slugs (so a
 * plan beats an archived copy of itself).
 */
export function mineCorpus(flowDir: string): FeatureCandidate[] {
  return corpusCandidates(walkCorpus(flowDir));
}

/**
 * Per-doc index records (#1532). Kind follows the SOURCE DIR — plans and
 * archived docs are changes, discovery docs are discovery. `featureSlug` is
 * the parenting the caller computed for the doc's slug (null = unparented).
 */
function corpusDocRecords(docs: readonly CorpusWalkDoc[], links: readonly CorpusLink[]): CorpusDocRecord[] {
  return docs.map((doc, index) => ({
    path: `flow/${doc.dirName}/${doc.fileName}`,
    kind: doc.dirName === 'discovery' ? ('discovery' as const) : ('change' as const),
    featureSlug: links[index]?.featureSlug ?? null,
    name: doc.heading ?? nameFromSlug(doc.slug),
    archived: doc.dirName === 'archive',
  }));
}

/**
 * Directory names that are never a feature. Not cleverness — an explicit list,
 * because a heuristic that proposes `scripts` and `docs` as product features
 * teaches the user to distrust every candidate it produces. Found by running
 * the fallback against this repo, which proposed exactly these.
 */
const NON_FEATURE_DIRS = new Set([
  'app', 'src', 'lib', 'cli', 'bin', 'dist', 'build', 'out', 'public', 'static',
  'docs', 'doc', 'scripts', 'script', 'tools', 'config', 'configs', 'resources',
  'assets', 'test', 'tests', '__tests__', 'e2e', 'fixtures', 'types', 'utils',
  'shared', 'common', 'node_modules', 'vendor', 'examples', 'templates',
]);

/**
 * Code fallback — proposes a feature per top-level source module the corpus
 * did not already cover. Deliberately conservative: this is the path for repos
 * with NO plan-flow history, and a wrong guess costs a human a correction. On a
 * repo that has a corpus, this should propose almost nothing.
 *
 * Dedupes by slug: two different directories can share a basename
 * (`app/docs` and `docs`), and emitting both produced literal duplicate
 * candidates before this was fixed.
 */
export function codeFallback(graph: BlueprintGraph | null, covered: ReadonlySet<string>): FeatureCandidate[] {
  const bySlug = new Map<string, FeatureCandidate>();
  for (const node of graph?.nodes ?? []) {
    if (node.kind !== 'module') continue;
    const dir = node.id.slice('module:'.length);
    // Depth-1 directories only — deeper ones are detail, not features.
    if (dir.split('/').length > 2) continue;
    const leaf = basename(dir);
    if (NON_FEATURE_DIRS.has(leaf.toLowerCase())) continue;
    const slug = slugifyFeatureName(leaf);
    if (covered.has(slug) || bySlug.has(slug)) continue;
    bySlug.set(slug, {
      slug,
      name: nameFromSlug(slug),
      anchors: [node.id],
      source: `code:module/${dir}`,
      kind: 'core',
    });
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Match a candidate against the existing store: id → slug → anchor overlap.
 * Returns null when nothing matches, which makes the candidate genuinely new.
 */
export function matchCandidate(
  candidate: FeatureCandidate,
  existing: readonly FeatureNode[],
): { feature: FeatureNode; matchedBy: 'id' | 'slug' | 'anchors' } | null {
  const wantId = mintFeatureId(candidate.slug);
  // `sameFeatureId`: a Workspace project's ids are namespaced (FR-20).
  const byId = existing.find((feature) => sameFeatureId(feature.id, wantId));
  if (byId !== undefined) return { feature: byId, matchedBy: 'id' };

  const bySlug = existing.find((feature) => feature.slug === candidate.slug);
  if (bySlug !== undefined) return { feature: bySlug, matchedBy: 'slug' };

  // Recovery: the same feature under a different name. Best overlap wins, and
  // ties break on slug so the result never depends on store iteration order.
  let best: { feature: FeatureNode; score: number } | null = null;
  for (const feature of existing) {
    const score = anchorJaccard(candidate.anchors, feature.anchors);
    if (score < ANCHOR_JACCARD_THRESHOLD) continue;
    if (best === null || score > best.score || (score === best.score && feature.slug < best.feature.slug)) {
      best = { feature, score };
    }
  }
  return best === null ? null : { feature: best.feature, matchedBy: 'anchors' };
}

/**
 * Run a discovery pass. PURE — reads inputs, returns intent; writing is the
 * caller's job through `feature-store` (matches) and `writeCandidates` (misses).
 */
export function discoverFeatures(
  flowDir: string,
  existing: readonly FeatureNode[],
  graph: BlueprintGraph | null,
  repoRoot?: string,
): DiscoverResult {
  // 1. CAPABILITIES first — the repo's surfaces name what the product does.
  const surfaces: FeatureCandidate[] =
    repoRoot === undefined
      ? []
      : mineSurfaces(repoRoot).map((surface) => ({
          slug: surface.slug,
          name: surface.name,
          anchors: surface.anchors,
          source: `surface:${[...new Set(surface.signals.map((s) => s.kind))].sort().join('+')}`,
          kind: 'core' as const,
        }));

  // 2. CHANGES second, parented to the capability they touch. A core already in
  //    the store counts as a parent target too, so re-runs stay stable.
  const coreKeys = [
    ...new Set([
      ...surfaces.map((surface) => canonicalKey(surface.slug)),
      ...existing.filter((feature) => feature.kind === 'core').map((feature) => canonicalKey(feature.slug)),
    ]),
  ];
  const coreSlugByKey = new Map<string, string>();
  for (const surface of surfaces) coreSlugByKey.set(canonicalKey(surface.slug), surface.slug);
  for (const feature of existing) {
    if (feature.kind === 'core') coreSlugByKey.set(canonicalKey(feature.slug), feature.slug);
  }
  // A PLAN IS NEVER A CAPABILITY, INCLUDING WHEN NOTHING ELSE IS ONE.
  //
  // This used to promote every corpus doc to `core` when the store had no cores
  // yet, reasoning that an empty board is worse than a coarse one. The premise
  // holds; the choice of coarse answer did not. A directory is a coarse
  // description OF THE CODE — a ticket number is a description of a week's
  // work, and once written it was read back on the next run as an existing
  // capability and kept. One real project carried "Coderabbit 124545" and
  // "ACME-2778 — Tenant Id…" as provinces beside Chats and Playbooks because of
  // this line.
  //
  // The non-empty board still happens, from `codeFallback` below — which is
  // already the documented last resort, already fires exactly when no surface
  // named anything, and names only things that exist in the repo.
  const walkedDocs = walkCorpus(flowDir);
  // ONE DECISION PER DOC (corpus-parent.ts): declared → name → code. The
  // candidate a slug produces takes the decision of its first doc (a live plan
  // beats its archived copy, as `corpusCandidates` already orders them), so the
  // board's change records and the corpus index can never disagree.
  const owners = corpusOwners(flowDir, existing, surfaces);
  const proposalPaths = proposalPathsByPlan(flowDir);
  const links = walkedDocs.map((doc) =>
    linkCorpusDoc({
      slug: doc.slug,
      markdown: doc.markdown,
      proposalPaths: proposalPaths.get(canonicalKey(doc.slug)) ?? [],
      anchors: doc.anchors,
      coreKeys,
      coreSlugByKey,
      owners,
    }),
  );
  const parentBySlug = new Map<string, string>();
  walkedDocs.forEach((doc, index) => {
    const parent = links[index].featureSlug;
    if (parent !== null && !parentBySlug.has(doc.slug)) parentBySlug.set(doc.slug, parent);
  });
  const corpus = corpusCandidates(walkedDocs).map((candidate) => {
    const parentSlug = parentBySlug.get(candidate.slug);
    return parentSlug === undefined ? candidate : { ...candidate, parentSlug };
  });
  const corpusDocs = corpusDocRecords(walkedDocs, links);

  // 3. Code fallback ONLY where neither found anything — a repo with no route,
  //    test or plan conventions still gets a board, just a coarser one.
  const coveredSlugs = new Set<string>([
    ...surfaces.map((candidate) => candidate.slug),
    ...corpus.map((candidate) => candidate.slug),
    ...existing.map((feature) => feature.slug),
  ]);
  const fallback = surfaces.length > 0 ? [] : codeFallback(graph, coveredSlugs);
  const all = [...surfaces, ...corpus, ...fallback];

  const updated: DiscoverResult['updated'] = [];
  const candidates: FeatureCandidate[] = [];
  for (const candidate of all) {
    const match = matchCandidate(candidate, existing);
    if (match === null) {
      candidates.push(candidate);
      continue;
    }
    // Union, sorted — discovery ADDS anchors and never drops one a human added.
    const merged = [...new Set([...match.feature.anchors, ...candidate.anchors])].sort();
    if (merged.length !== match.feature.anchors.length) {
      updated.push({ feature: match.feature, anchors: merged, matchedBy: match.matchedBy });
    }
  }
  return {
    updated,
    candidates: candidates.sort((a, b) => a.slug.localeCompare(b.slug)),
    corpusDocs,
    corpusLinks: corpusLinkStats(links),
  };
}

/**
 * Every core and the repo paths it owns — its own anchors plus its PARTS'
 * anchors (a core usually anchors only its routes; the code a change touches
 * lives in its parts). Surfaces not yet in the store own their mined anchors.
 * A part file that cannot be read just contributes nothing.
 */
function corpusOwners(
  flowDir: string,
  existing: readonly FeatureNode[],
  surfaces: readonly FeatureCandidate[],
): CorpusOwner[] {
  const strip = (anchor: string): string => anchor.replace(/^(?:module|file):/, '');
  const owners: CorpusOwner[] = [];
  const seen = new Set<string>();
  for (const feature of existing) {
    if (feature.kind !== 'core') continue;
    let partPaths: string[] = [];
    try {
      partPaths = readParts(flowDir, feature.slug).flatMap((part) => part.anchors);
    } catch {
      partPaths = [];
    }
    owners.push({ slug: feature.slug, paths: [...feature.anchors, ...partPaths].map(strip) });
    seen.add(canonicalKey(feature.slug));
  }
  for (const surface of surfaces) {
    if (seen.has(canonicalKey(surface.slug))) continue;
    owners.push({ slug: surface.slug, paths: surface.anchors.map(strip) });
  }
  return owners;
}

/**
 * The files each plan's blueprint proposals predicted, keyed like a doc slug.
 * Proposals are recorded at discovery and planning time with real anchors —
 * the most structured statement of what a change touches. Fail-soft: no file
 * or an unreadable one means no proposal paths, never a failed discover.
 */
function proposalPathsByPlan(flowDir: string): Map<string, string[]> {
  const byPlan = new Map<string, string[]>();
  let proposals: ReturnType<typeof readEffectiveProposals> = [];
  try {
    proposals = readEffectiveProposals(flowDir);
  } catch {
    return byPlan;
  }
  for (const proposal of proposals) {
    const key = canonicalKey(slugifyFeatureName(proposal.plan));
    const list = byPlan.get(key) ?? [];
    for (const anchor of proposal.anchors) list.push(anchor.file ?? anchor.ref);
    byPlan.set(key, list);
  }
  return byPlan;
}

/** Write the staged candidate list. Derived + disposable: a full rewrite. */
export function writeCandidates(structureDir: string, candidates: readonly FeatureCandidate[]): void {
  mkdirSync(structureDir, { recursive: true });
  const filePath = join(structureDir, CANDIDATES_FILENAME);
  const body = candidates.map((candidate) => JSON.stringify(candidate)).join('\n');
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, body.length > 0 ? `${body}\n` : '', 'utf-8');
  renameSync(temp, filePath);
}

/** Read staged candidates. Fail-soft: a corrupt line is skipped, not fatal. */
export function readCandidates(structureDir: string): FeatureCandidate[] {
  const filePath = join(structureDir, CANDIDATES_FILENAME);
  if (!existsSync(filePath)) return [];
  const out: FeatureCandidate[] = [];
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as FeatureCandidate;
      if (typeof parsed.slug === 'string' && Array.isArray(parsed.anchors)) out.push(parsed);
    } catch {
      continue;
    }
  }
  return out;
}
