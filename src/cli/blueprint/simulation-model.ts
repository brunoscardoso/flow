/**
 * Change-simulation pure model (blueprint-simulation).
 *
 * Given a compiled story (steps carrying `anchors` + `phases`), the derived
 * graph, and the effective proposal set, produce — per plan phase — the union
 * of nodes that phase touches, each tagged with a DERIVED change-kind:
 *
 *   graph node  → 'modify'   (it exists today)
 *   ghost/proposal → 'new'   (it doesn't exist yet)
 *   unresolved  → not a touched node (but it drives the coverage gate)
 *
 * The mapping is deterministic and side-effect-free: same inputs → deep-equal
 * output. It reuses `resolveStoryAnchors` (the single anchor→target resolver)
 * so change-kind is never guessed — the board only claims what resolution can
 * prove. See `.claude/resources/core/blueprint.md` and the feature discovery
 * `flow/discovery/discovery_blueprint-simulation_v1.md`.
 *
 * On 'remove': there is no honest deterministic signal in a story ANCHOR that a
 * node will be deleted, so THIS model never emits `kind: 'remove'` — an anchor
 * says "this step touches that node", never "this step deletes it".
 *
 * The signal does exist, but it lives in a different input: a before/after flow
 * PAIR. `computeBriefDelta` (`brief-model.ts`) derives removals from
 * `flowBefore` minus `flowAfter`, which is sound only because `story-compile.ts`
 * resolves `flow_before` against the derived graph alone (ghosts refused), so a
 * node named there is provably present today. A node in before and in no after
 * is provably gone. Nothing here needs to guess.
 */
import { resolveStoryAnchors } from './anchors.js';
import type { EffectiveProposal } from './proposal-store.js';
import type {
  BlueprintGraph,
  CompiledStory,
  TouchedChangeKind,
  TouchedNode,
  TouchedSet,
} from './types.js';

/** Map a resolution target to a change-kind. Only 'node'/'ghost' produce a kind. */
function kindForTarget(target: 'node' | 'ghost' | null): TouchedChangeKind | null {
  if (target === 'node') return 'modify';
  if (target === 'ghost') return 'new';
  return null;
}

/**
 * The set of plan phase numbers a step narrates. A step with no `phases` covers
 * nothing mechanically (it's a pure-narrative beat) and contributes to no
 * phase's touched set.
 */
function stepPhases(phases: number[]): number[] {
  return phases.filter((p) => Number.isInteger(p) && p >= 0);
}

/**
 * Compute, for every phase referenced by any story step, the union of touched
 * nodes across all steps that cover that phase. Deduplicated by `nodeId`
 * (first resolution wins — a node cannot be both an existing node and a ghost).
 * Phases are returned in ascending order; touched nodes in first-seen order for
 * determinism.
 */
export function computeTouchedSets(
  story: CompiledStory,
  graph: BlueprintGraph | null,
  proposals: EffectiveProposal[],
): TouchedSet[] {
  // phase → (nodeId → TouchedNode), insertion-ordered by Map semantics.
  const byPhase = new Map<number, Map<string, TouchedNode>>();

  for (const step of story.steps) {
    const phases = stepPhases(step.phases);
    if (phases.length === 0) continue;
    const resolutions = resolveStoryAnchors(step.anchors, graph, proposals);
    const touched: TouchedNode[] = [];
    for (const resolution of resolutions) {
      const kind = kindForTarget(resolution.target);
      if (kind === null || resolution.targetId === null) continue;
      touched.push({ nodeId: resolution.targetId, kind, anchor: resolution.anchor });
    }
    for (const phase of phases) {
      let nodes = byPhase.get(phase);
      if (nodes === undefined) {
        nodes = new Map<string, TouchedNode>();
        byPhase.set(phase, nodes);
      }
      for (const node of touched) {
        if (!nodes.has(node.nodeId)) nodes.set(node.nodeId, node);
      }
    }
  }

  return [...byPhase.keys()]
    .sort((a, b) => a - b)
    .map((phase) => ({ phase, touched: [...byPhase.get(phase)!.values()] }));
}

/**
 * The anchor-coverage gate (FR3). Given the plan's phase numbers, return those
 * with NO resolvable anchor — either no story step references the phase at all,
 * or every anchor on the covering steps failed to resolve. These are the phases
 * the board must render as *unmapped* (never as "no changes"), and the ones
 * `/create-plan` refuses to finalize on. Returned sorted ascending.
 */
export function phaseCoverageGaps(
  planPhases: number[],
  story: CompiledStory,
  graph: BlueprintGraph | null,
  proposals: EffectiveProposal[],
): number[] {
  const covered = new Set<number>();
  for (const set of computeTouchedSets(story, graph, proposals)) {
    if (set.touched.length > 0) covered.add(set.phase);
  }
  const gaps = new Set<number>();
  for (const phase of planPhases) {
    if (!Number.isInteger(phase) || phase < 0) continue;
    if (!covered.has(phase)) gaps.add(phase);
  }
  return [...gaps].sort((a, b) => a - b);
}
