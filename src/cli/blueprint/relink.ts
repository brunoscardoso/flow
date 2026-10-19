/**
 * Annotation relink pass — run after each derive to keep annotation status
 * honest against the fresh graph.
 *
 * For every effective annotation (status events already folded by the store):
 * - ACTIVE entries whose anchors ALL fail to resolve are stale-flagged.
 * - STALE entries whose anchors ALL resolve again are reactivated.
 * - Entries with zero anchors are never staled (nothing to lose).
 *
 * Append-only: transitions are recorded as status events — annotation
 * history is never rewritten. No fuzzy re-matching — an anchor either
 * resolves structurally or the annotation is honestly flagged stale.
 */

import { resolveAnchor } from './anchors.js';
import { annotationFingerprint, appendStatusEvent, readAnnotations } from './store.js';
import type { AnnotationEntry, BlueprintGraph } from './types.js';

const RECOVERY_REASON = 'anchors resolved again';

/** Counts of status transitions applied by a relink pass. */
export interface RelinkResult {
  /** Active annotations flagged stale (no anchor resolved). */
  staled: number;
  /** Stale annotations reactivated (all anchors resolve again). */
  recovered: number;
}

/** Refs of the entry's anchors that do not resolve against the graph. */
function unresolvedRefs(entry: AnnotationEntry, graph: BlueprintGraph): string[] {
  return entry.anchors
    .filter((anchor) => !resolveAnchor(anchor, graph))
    .map((anchor) => anchor.ref);
}

/**
 * Re-check every effective annotation against a fresh graph, appending
 * stale/active status events for entries whose resolution changed.
 *
 * Iteration follows the store's append order (deterministic). Returns the
 * number of annotations staled and recovered.
 */
export function relinkAnnotations(
  flowDir: string,
  graph: BlueprintGraph,
): RelinkResult {
  let staled = 0;
  let recovered = 0;

  for (const entry of readAnnotations(flowDir)) {
    if (entry.anchors.length === 0) {
      // Nothing anchoring this entry to the graph — never staled
      continue;
    }

    const unresolved = unresolvedRefs(entry, graph);

    if (entry.status === 'active' && unresolved.length === entry.anchors.length) {
      appendStatusEvent(flowDir, {
        ts: new Date().toISOString(),
        targetFingerprint: annotationFingerprint(entry),
        status: 'stale',
        reason: `anchors lost: ${unresolved.join(', ')}`,
      });
      staled += 1;
      continue;
    }

    if (entry.status === 'stale' && unresolved.length === 0) {
      appendStatusEvent(flowDir, {
        ts: new Date().toISOString(),
        targetFingerprint: annotationFingerprint(entry),
        status: 'active',
        reason: RECOVERY_REASON,
      });
      recovered += 1;
    }
  }

  return { staled, recovered };
}
