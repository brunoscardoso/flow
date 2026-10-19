/**
 * Wave calculator — topological sort of phase dependencies into wave groups.
 *
 * Phases with no dependencies land in wave 1. Each subsequent phase lands in
 * wave = max(wave of each dependency) + 1. A "Tests" phase (last phase whose
 * name contains "test", case-insensitive) is always isolated in the final wave.
 *
 * If a circular dependency is detected the fallback is sequential execution:
 * one phase per wave in phase-number order.
 */

import type { PlanPhase, WaveGroup } from './types.js';

/**
 * Find a cycle in the dependency graph using iterative DFS.
 *
 * @returns The phase numbers on the first detected cycle (in DFS-stack
 *   order), or null when the graph is acyclic.
 */
function findCycle(
  phaseNumbers: number[],
  adjacency: Map<number, number[]>,
): number[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<number, number>();
  for (const n of phaseNumbers) color.set(n, WHITE);

  for (const start of phaseNumbers) {
    if (color.get(start) !== WHITE) continue;

    const stack: Array<{ node: number; idx: number }> = [
      { node: start, idx: 0 },
    ];
    color.set(start, GRAY);

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const neighbors = adjacency.get(top.node) ?? [];

      if (top.idx < neighbors.length) {
        const neighbor = neighbors[top.idx];
        top.idx++;
        const c = color.get(neighbor);
        if (c === GRAY) {
          // Back-edge → cycle. GRAY nodes are exactly the DFS stack, so the
          // cycle is the stack slice from the back-edge target to the top.
          const cycleStart = stack.findIndex((frame) => frame.node === neighbor);
          return stack.slice(cycleStart).map((frame) => frame.node);
        }
        if (c === WHITE) {
          color.set(neighbor, GRAY);
          stack.push({ node: neighbor, idx: 0 });
        }
      } else {
        color.set(top.node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

/**
 * Build the successor adjacency (phase → phases that depend on it) used for
 * cycle detection.
 */
function buildSuccessorMap(phases: PlanPhase[]): Map<number, number[]> {
  const successorMap = new Map<number, number[]>();
  for (const p of phases) {
    if (!successorMap.has(p.number)) successorMap.set(p.number, []);
    for (const dep of p.dependencies) {
      if (!successorMap.has(dep)) successorMap.set(dep, []);
      successorMap.get(dep)!.push(p.number);
    }
  }
  return successorMap;
}

/**
 * Report the phases involved in a dependency cycle, if any.
 *
 * Shares `calculateWaves`' cycle detection so both callers agree on what a
 * cycle is. Returns the participating phase numbers sorted ascending, or an
 * empty array when the graph is acyclic.
 */
export function findDependencyCycle(phases: PlanPhase[]): number[] {
  const cycle = findCycle(
    phases.map((p) => p.number),
    buildSuccessorMap(phases),
  );
  return cycle === null ? [] : [...cycle].sort((a, b) => a - b);
}

/**
 * Calculate wave groups from plan phases.
 *
 * @returns Sorted array of WaveGroup objects.
 */
export function calculateWaves(phases: PlanPhase[]): WaveGroup[] {
  if (phases.length === 0) return [];

  // Build adjacency list (phase → phases it depends on, i.e. forward edges
  // point from a phase to its dependencies for the purpose of cycle detection).
  // For cycle detection we need "phase → successors" (who depends on me).
  const phaseNumbers = phases.map((p) => p.number);
  const depMap = new Map<number, number[]>();
  for (const p of phases) {
    depMap.set(p.number, [...p.dependencies]);
  }
  const successorMap = buildSuccessorMap(phases);

  // Cycle detection — use successor adjacency for DFS.
  if (findCycle(phaseNumbers, successorMap) !== null) {
    // Fallback: sequential, one phase per wave.
    const sorted = [...phaseNumbers].sort((a, b) => a - b);
    return sorted.map((n, i) => ({
      wave_number: i + 1,
      phase_numbers: [n],
    }));
  }

  // Assign wave numbers iteratively.
  const waveOf = new Map<number, number>();
  const phaseSet = new Set(phaseNumbers);

  // Iterative assignment: keep going until all phases are assigned.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of phases) {
      if (waveOf.has(p.number)) continue;

      // Filter dependencies to only those that are actual phases in the plan.
      const deps = (depMap.get(p.number) ?? []).filter((d) => phaseSet.has(d));

      if (deps.length === 0) {
        waveOf.set(p.number, 1);
        changed = true;
      } else if (deps.every((d) => waveOf.has(d))) {
        const maxDepWave = Math.max(...deps.map((d) => waveOf.get(d)!));
        waveOf.set(p.number, maxDepWave + 1);
        changed = true;
      }
    }
  }

  // Detect Tests phase: last phase by number whose name contains "test".
  const sortedPhases = [...phases].sort((a, b) => a.number - b.number);
  const lastPhase = sortedPhases[sortedPhases.length - 1];
  const isTestsPhase =
    lastPhase && /test/i.test(lastPhase.name) ? lastPhase.number : null;

  // If the Tests phase shares a wave with other phases, move it to its own final wave.
  if (isTestsPhase !== null) {
    const testWave = waveOf.get(isTestsPhase)!;
    const phasesInSameWave = Array.from(waveOf.entries()).filter(
      ([num, w]) => w === testWave && num !== isTestsPhase,
    );

    if (phasesInSameWave.length > 0) {
      // Move Tests to max_wave + 1
      const maxWave = Math.max(...Array.from(waveOf.values()));
      waveOf.set(isTestsPhase, maxWave + 1);
    }
  }

  // Group phases by wave number.
  const waveMap = new Map<number, number[]>();
  for (const [phaseNum, wave] of Array.from(waveOf.entries())) {
    if (!waveMap.has(wave)) waveMap.set(wave, []);
    waveMap.get(wave)!.push(phaseNum);
  }

  // Build sorted WaveGroup array.
  const waveNumbers = Array.from(waveMap.keys()).sort((a, b) => a - b);
  return waveNumbers.map((wn) => ({
    wave_number: wn,
    phase_numbers: waveMap.get(wn)!.sort((a, b) => a - b),
  }));
}
