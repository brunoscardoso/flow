/**
 * Feature bootstrap (feature-blueprint) — the board is populated on day one.
 *
 * A project added to the IDE used to land on an EMPTY feature board: `init`
 * derived the code graph and stopped, so "what does this project do" stayed
 * blank until somebody ran three CLI verbs nobody knew about. The capability
 * names are free and deterministic to mine, so there is no reason to wait.
 *
 * WHAT IT WRITES, AND WHAT IT WILL NOT
 * ====================================
 * It CREATES feature files for capabilities the repo names in its own surfaces.
 * It never edits an existing one: `confirmCandidate` skips any slug already in
 * the store, and anchor updates go through `writeFeature`, which preserves every
 * human-owned field. So a re-provision of a project someone has been curating
 * adds what is new and touches nothing else.
 *
 * `confirmCandidate` is shared with `blueprint features confirm` rather than
 * reimplemented here — one code path for what a confirmed feature looks like
 * (allowed-pattern #14). A stub body naming its provenance, never invented prose.
 */
import { discoverFeatures, writeCandidates, type FeatureCandidate } from './feature-discover.js';
import {
  mintFeatureId,
  parseFeatureFile,
  readFeatures,
  seedFeatures,
  writeFeature,
} from './feature-store.js';
import type { BlueprintGraph } from './types.js';

/** What a bootstrap did, for a one-line report. */
export interface BootstrapResult {
  /** Legacy files adopted in place (frontmatter added, prose untouched). */
  adopted: number;
  /** Capabilities written as new core features. */
  cores: number;
  /** Change records staged as children, awaiting execution to confirm them. */
  staged: number;
  /** Existing features whose anchors gained a reference. */
  updated: number;
}

/**
 * Promote one staged candidate into a real feature file. Returns false when the
 * slug is already taken — confirming must never overwrite an existing feature.
 *
 * `parentExists` decides whether the child's `parent` is written at all: a
 * dangling parent id renders the child at level 1, which is precisely the bug
 * the two-level model exists to prevent.
 */
export function confirmCandidate(
  flowDir: string,
  candidate: FeatureCandidate,
  taken: ReadonlySet<string>,
): boolean {
  if (taken.has(candidate.slug)) return false;
  const body = `# ${candidate.name}\n\nConfirmed from ${candidate.source}.\n`;
  const node = parseFeatureFile(candidate.slug, body);
  node.id = mintFeatureId(candidate.slug);
  node.name = candidate.name;
  node.kind = candidate.kind;
  if (candidate.parentSlug !== undefined && taken.has(candidate.parentSlug)) {
    node.parent = mintFeatureId(candidate.parentSlug);
  }
  writeFeature(flowDir, node, { anchors: candidate.anchors });
  return true;
}

/**
 * Bootstrap a project's feature store: adopt what exists, mine capabilities,
 * write the cores, stage the rest.
 *
 * CORES are written; CHILDREN are only staged. A child is a change record, and
 * "plan proposes, execution confirms" still holds — a plan that was never
 * executed must not leave a feature claiming work that never happened.
 *
 * PURE-ish and fail-soft by construction: every write goes through the store,
 * and a repo naming no capability simply yields zero cores rather than guesses.
 */
export function bootstrapFeatures(
  repoRoot: string,
  flowDir: string,
  structureDir: string,
  graph: BlueprintGraph | null,
): BootstrapResult {
  const adopted = seedFeatures(flowDir);
  const existing = readFeatures(flowDir);
  const result = discoverFeatures(flowDir, existing, graph, repoRoot);

  for (const update of result.updated) {
    writeFeature(flowDir, update.feature, { anchors: update.anchors });
  }

  const taken = new Set(existing.map((feature) => feature.slug));
  let cores = 0;
  for (const candidate of result.candidates) {
    if (candidate.kind !== 'core') continue;
    if (!confirmCandidate(flowDir, candidate, taken)) continue;
    taken.add(candidate.slug);
    cores += 1;
  }

  const remaining = result.candidates.filter((candidate) => !taken.has(candidate.slug));
  writeCandidates(structureDir, remaining);
  return { adopted: adopted.length, cores, staged: remaining.length, updated: result.updated.length };
}

/** One-line summary for init's log. Never a silent no-op. */
export function describeBootstrap(result: BootstrapResult): string {
  if (result.cores === 0 && result.adopted === 0) {
    return 'Features: no capability surfaces found — the feature board starts empty';
  }
  const parts = [`${result.cores} capability feature(s)`];
  if (result.adopted > 0) parts.push(`${result.adopted} adopted`);
  if (result.staged > 0) parts.push(`${result.staged} staged`);
  return `Features: ${parts.join(' · ')}`;
}
