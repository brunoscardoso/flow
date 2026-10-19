/**
 * Change-simulation reconciliation model (blueprint-simulation).
 *
 * Diffs the predicted touched-sets (the stored baseline) against what a run
 * ACTUALLY touched (node ids resolved from each `phase_result`'s anchors) and
 * classifies every node, per phase:
 *
 *   confirmed — predicted for this phase AND landed in it (the plan held)
 *   missed    — predicted for this phase but never landed in it
 *   surprise  — landed in this phase but not predicted for it
 *
 * Pure/deterministic. Anchor→node-id resolution is graph-dependent and happens
 * at the call site (Phase 6) via the shared resolver; this model diffs already-
 * resolved node ids so it stays a pure set operation.
 *
 * Two notions of "surprise", deliberately distinct:
 *  - PER-PHASE `surprise` (above) drives the board scrubber's phase-accurate
 *    styling — a node touched in a phase it wasn't predicted for.
 *  - GLOBAL `surpriseNodes` (below) is the RISK signal: nodes touched that were
 *    predicted in NO phase at all. A node merely touched a phase early/late was
 *    still foreseen blast radius, so it must NOT raise risk — only genuinely
 *    unforeseen nodes do. Conflating the two would make every timing shift look
 *    dangerous.
 */
import type { TouchedChangeKind, TouchedSet } from './types.js';

/** Actual nodes a run touched in one phase — node ids resolved from phase_result anchors. */
export interface ActualTouched {
  phase: number;
  nodeIds: string[];
}

/** Reconciliation state of one node in one phase. */
export type ReconcileState = 'confirmed' | 'missed' | 'surprise';

/** One reconciled node in one phase. */
export interface ReconcileNode {
  nodeId: string;
  phase: number;
  state: ReconcileState;
  /** Predicted change-kind, when the node was predicted for this phase. */
  kind?: TouchedChangeKind;
}

function predictedByPhase(predicted: TouchedSet[]): Map<number, Map<string, TouchedChangeKind>> {
  const map = new Map<number, Map<string, TouchedChangeKind>>();
  for (const set of predicted) {
    let nodes = map.get(set.phase);
    if (nodes === undefined) {
      nodes = new Map<string, TouchedChangeKind>();
      map.set(set.phase, nodes);
    }
    for (const node of set.touched) {
      if (!nodes.has(node.nodeId)) nodes.set(node.nodeId, node.kind);
    }
  }
  return map;
}

function actualByPhase(actual: ActualTouched[]): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>();
  for (const item of actual) {
    let ids = map.get(item.phase);
    if (ids === undefined) {
      ids = new Set<string>();
      map.set(item.phase, ids);
    }
    for (const id of item.nodeIds) ids.add(id);
  }
  return map;
}

/**
 * Reconcile predicted vs actual, per phase. Phases and nodes are emitted in
 * ascending / first-seen deterministic order. Nodes confirmed first, then
 * missed, then surprise, within each phase.
 */
export function reconcile(predicted: TouchedSet[], actual: ActualTouched[]): ReconcileNode[] {
  const pred = predictedByPhase(predicted);
  const act = actualByPhase(actual);
  const phases = [...new Set([...pred.keys(), ...act.keys()])].sort((a, b) => a - b);

  const out: ReconcileNode[] = [];
  for (const phase of phases) {
    const predNodes = pred.get(phase) ?? new Map<string, TouchedChangeKind>();
    const actNodes = act.get(phase) ?? new Set<string>();
    // confirmed + missed, iterating predicted in insertion order
    for (const [nodeId, kind] of predNodes) {
      out.push({
        nodeId,
        phase,
        state: actNodes.has(nodeId) ? 'confirmed' : 'missed',
        kind,
      });
    }
    // surprise: actual not predicted for this phase
    for (const nodeId of actNodes) {
      if (!predNodes.has(nodeId)) {
        out.push({ nodeId, phase, state: 'surprise' });
      }
    }
  }
  return out;
}

/**
 * The RISK signal: distinct node ids a run touched that were predicted in NO
 * phase — genuinely unforeseen blast radius. Deterministic first-seen order.
 * Feeds the post-execution risk assessment, raise-only (Phase 6).
 */
export function surpriseNodes(predicted: TouchedSet[], actual: ActualTouched[]): string[] {
  const predictedAnywhere = new Set<string>();
  for (const set of predicted) {
    for (const node of set.touched) predictedAnywhere.add(node.nodeId);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of actual) {
    for (const id of item.nodeIds) {
      if (!predictedAnywhere.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
