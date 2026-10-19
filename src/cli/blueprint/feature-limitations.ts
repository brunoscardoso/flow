/**
 * WHAT THE FEATURE STORE IS NOT SAYING (plan_constellation-board_v1, Phase 8).
 *
 * WHY THIS EXISTS
 * ===============
 * The board draws 28 features and every one of them looks equally complete. It
 * is not. Measured on this repo at the time of writing:
 *
 *   - `## Parts`   on  0 of 28 features
 *   - `## Learned` on  0 of 28 features
 *   - curated views: 1 stored, 0 valid — and the one has been dead since
 *     2026-08-04 with three specific validator errors nobody ever saw
 *
 * A surface that renders that state identically to a fully-documented one is
 * not neutral; it is a claim, and the claim is false. The gaps ARE the message,
 * so they are computed here, in one place, from the same readers the store
 * itself uses — never from a second, drifting notion of what "documented" means.
 *
 * WHY IT IS THE CLI THAT COUNTS
 * =============================
 * Only the CLI can see the store: it holds the markdown readers (`splitParts` /
 * `parseLearnings`) and it holds the ONE validator (`validateFeatureView`). A
 * renderer-side reimplementation would be a second opinion about what a valid
 * view is, and two opinions is exactly one more than this repo allows. The
 * board receives the verdict and renders it; it does not re-derive it.
 *
 * NOTHING HERE ASSUMES. A feature body that refuses to split (an ambiguous
 * `## Learned`) is counted as UNREADABLE, not as "has no learnings" — those are
 * different facts and only one of them is a documentation gap.
 */
import { inspectFeatureViews, type FeatureViewInspection } from './feature-view.js';
import { addressPartNames, featureHome, parseLearnings, parseParts, splitParts } from './feature-store.js';
import type { ExcludedFeatureFile, FeatureNode } from './feature-store.js';

/** What the feature store does and does not say about itself. */
export interface FeatureContentGaps {
  /** Features in the store. */
  features: number;
  /** Features carrying at least one parsed part. */
  withParts: number;
  /** Features carrying at least one parsed learning. */
  withLearned: number;
  /**
   * Feature bodies that REFUSE to split (an ambiguous `## Learned`, an
   * unterminated fence). Counted apart: unreadable is not undocumented.
   */
  unreadable: number;
}

/** One stored artifact that is broken, orphaned, or both. */
export interface ViewFailure {
  slug: string;
  /** Full path, so a reader is told which file to open. */
  path: string;
  state: 'invalid' | 'unreadable';
  orphaned: boolean;
  /** Why it belongs to no feature. Empty when it does. */
  orphanReason: string;
  /** The validator's own messages, VERBATIM. */
  errors: string[];
}

/** The state of the curated-view store. */
export interface ViewGaps {
  /** Artifacts stored (rotations and in-flight writes excluded). */
  total: number;
  /** Artifacts that pass the validator. */
  valid: number;
  /** Artifacts that do not. */
  broken: number;
  /** Artifacts belonging to no feature. Overlaps `broken` — an orphan is
   *  usually also invalid, and both facts are worth their own count. */
  orphaned: number;
  /** Every artifact that is broken or orphaned, filed-slug order. */
  failures: ViewFailure[];
  /**
   * Slugs whose artifact PASSES the validator and belongs to that feature.
   *
   * This is the feature-graph's second source of understanding (see
   * `understandingOf`). It is emitted from THIS inspection rather than
   * recomputed there so the board can never be told a view is valid by one
   * reader and broken by another — one inspection, one verdict.
   *
   * Orphans are excluded even when they validate: an artifact filed as `a`
   * that names `b` is not `a`'s evidence, and counting it would let a renamed
   * feature inherit a stranger's picture.
   */
  validSlugs: string[];
}

/**
 * A home a person pinned (`home:`) that is not a folder of the project any
 * more (plan `feature-home-folders`, NFR-4). The rows ignore it and compute
 * the home instead; this is where the board says so, so the person can choose
 * another one rather than wonder why their choice is not shown.
 */
export interface MissingHome {
  /** The feature's id, or the part's address (`addressableParts`). */
  id: string;
  /** The owning feature's slug. */
  feature: string;
  /** The part's name, or null for the feature itself. */
  part: string | null;
  /** The folder as written. */
  home: string;
}

export interface FeatureLimitations {
  content: FeatureContentGaps;
  views: ViewGaps;
  /**
   * Pinned homes that are not folders of the project. Empty when every pin
   * resolves — and when there is no checkout to check them against (nothing
   * can be called missing from a disk that is not here).
   */
  missingHomes: MissingHome[];
  /**
   * Files in the feature directory the board did NOT draw, and files it drew on
   * a guess — each with the reason, so "what is missing" is answerable rather
   * than merely countable. A number cannot be acted on: the failure this guards
   * is a real capability quietly not appearing, and a reader who sees only
   * `3 excluded` has no way to tell which three.
   */
  excluded: ExcludedFeatureFile[];
}

/** A body that will not split tells us nothing — not "nothing to tell". */
interface BodyRead {
  parts: number;
  learnings: number;
  readable: boolean;
}

function readBody(body: string): BodyRead {
  try {
    const split = splitParts(body);
    return {
      parts: parseParts(split.parts).length,
      learnings: parseLearnings(split.learned).length,
      readable: true,
    };
  } catch {
    // `splitLearned` REFUSES rather than guesses on an ambiguous file, and that
    // refusal is a finding in its own right — not a zero.
    return { parts: 0, learnings: 0, readable: false };
  }
}

function toFailure(inspection: FeatureViewInspection): ViewFailure {
  return {
    slug: inspection.slug,
    path: inspection.path,
    state: inspection.state === 'unreadable' ? 'unreadable' : 'invalid',
    orphaned: inspection.orphaned,
    orphanReason: inspection.orphanReason,
    errors: inspection.errors,
  };
}

export interface ComputeLimitationsOptions {
  /** Check code excerpts against the repo's real files. */
  repoRoot?: string;
  /**
   * What the same read declined to admit — handed in for the same reason the
   * feature list is: the caller already has it, and reading the directory twice
   * would let the two answers disagree.
   */
  excluded?: readonly ExcludedFeatureFile[];
  /**
   * Whether a pinned `home:` names an existing folder of the project
   * (`pinnedHomeExists` over the checkout). Omitted without a checkout — pins
   * are then left unchecked rather than all reported missing.
   */
  homeExists?: (home: string) => boolean;
}

/** Every pinned home — the feature's own, then its parts' — that `exists` says is not a folder. */
export function computeMissingHomes(
  features: readonly FeatureNode[],
  exists: (home: string) => boolean,
): MissingHome[] {
  const missing: MissingHome[] = [];
  for (const feature of features) {
    const home = featureHome(feature);
    if (home !== null && !exists(home)) missing.push({ id: feature.id, feature: feature.slug, part: null, home });
    let parts;
    try {
      parts = parseParts(splitParts(feature.body).parts).filter((part) => part.name.trim().length > 0);
    } catch {
      continue; // an unreadable body is already counted as such
    }
    const ids = addressPartNames(feature.id, parts.map((part) => part.name));
    parts.forEach((part, index) => {
      if (part.home !== undefined && !exists(part.home)) {
        missing.push({ id: ids[index], feature: feature.slug, part: part.name.trim(), home: part.home });
      }
    });
  }
  return missing.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Compute what the store is not saying.
 *
 * The feature list is passed IN rather than read here: the caller has already
 * read it to build the graph, and reading it twice would let the two answers
 * disagree about how many features there are — the single most confusing thing
 * a report about missing content could do.
 */
export function computeFeatureLimitations(
  features: readonly FeatureNode[],
  flowDir: string,
  options: ComputeLimitationsOptions = {},
): FeatureLimitations {
  const content: FeatureContentGaps = {
    features: features.length,
    withParts: 0,
    withLearned: 0,
    unreadable: 0,
  };
  for (const feature of features) {
    const read = readBody(feature.body);
    if (!read.readable) {
      content.unreadable += 1;
      continue;
    }
    if (read.parts > 0) content.withParts += 1;
    if (read.learnings > 0) content.withLearned += 1;
  }

  // The store's OWN slugs decide whether an artifact still has an owner — the
  // orphan rule cannot be applied without them, and applying it with a guess
  // would call a live view dead.
  const knownFeatures = features.map((feature) => feature.slug);
  const inspections = inspectFeatureViews(flowDir, {
    knownFeatures,
    ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
  });
  const failures = inspections
    .filter((entry) => entry.state !== 'valid' || entry.orphaned)
    .map(toFailure);

  return {
    content,
    views: {
      total: inspections.length,
      valid: inspections.filter((entry) => entry.state === 'valid').length,
      broken: inspections.filter((entry) => entry.state !== 'valid').length,
      orphaned: inspections.filter((entry) => entry.orphaned).length,
      failures,
      validSlugs: inspections
        .filter((entry) => entry.state === 'valid' && !entry.orphaned)
        .map((entry) => entry.slug),
    },
    excluded: [...(options.excluded ?? [])].sort((a, b) => a.slug.localeCompare(b.slug)),
    missingHomes: options.homeExists === undefined ? [] : computeMissingHomes(features, options.homeExists),
  };
}
