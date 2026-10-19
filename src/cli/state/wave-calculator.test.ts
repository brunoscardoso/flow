/**
 * Tests for wave calculator
 */

import { calculateWaves } from './wave-calculator.js';
import type { PlanPhase } from './types.js';

function makePhase(
  number: number,
  name: string,
  dependencies: number[] = [],
  complexity = 5,
): PlanPhase {
  return { number, name, complexity, dependencies, tasks: [] };
}

describe('calculateWaves', () => {
  it('should return empty array for empty phases', () => {
    const waves = calculateWaves([]);
    expect(waves).toEqual([]);
  });

  it('should place a single phase in wave 1', () => {
    const phases = [makePhase(1, 'Setup')];
    const waves = calculateWaves(phases);
    expect(waves).toEqual([{ wave_number: 1, phase_numbers: [1] }]);
  });

  it('should group independent phases into the same wave', () => {
    const phases = [
      makePhase(1, 'Types', []),
      makePhase(2, 'Config', []),
      makePhase(3, 'Utils', []),
    ];

    const waves = calculateWaves(phases);
    expect(waves).toEqual([{ wave_number: 1, phase_numbers: [1, 2, 3] }]);
  });

  it('should place sequential dependencies in separate waves', () => {
    const phases = [
      makePhase(1, 'First', []),
      makePhase(2, 'Second', [1]),
      makePhase(3, 'Third', [2]),
    ];

    const waves = calculateWaves(phases);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual({ wave_number: 1, phase_numbers: [1] });
    expect(waves[1]).toEqual({ wave_number: 2, phase_numbers: [2] });
    expect(waves[2]).toEqual({ wave_number: 3, phase_numbers: [3] });
  });

  it('should handle mixed dependencies with correct wave assignment', () => {
    // Phase 1 and 2 are independent, Phase 3 depends on both
    const phases = [
      makePhase(1, 'Types', []),
      makePhase(2, 'Config', []),
      makePhase(3, 'Implementation', [1, 2]),
    ];

    const waves = calculateWaves(phases);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toEqual({ wave_number: 1, phase_numbers: [1, 2] });
    expect(waves[1]).toEqual({ wave_number: 2, phase_numbers: [3] });
  });

  it('should fall back to sequential execution on circular dependency', () => {
    // Create a cycle: 1 → 2 → 3 → 1
    const phases = [
      makePhase(1, 'A', [3]),
      makePhase(2, 'B', [1]),
      makePhase(3, 'C', [2]),
    ];

    const waves = calculateWaves(phases);
    // Sequential fallback: each phase in its own wave
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual({ wave_number: 1, phase_numbers: [1] });
    expect(waves[1]).toEqual({ wave_number: 2, phase_numbers: [2] });
    expect(waves[2]).toEqual({ wave_number: 3, phase_numbers: [3] });
  });

  it('should isolate tests phase in the last wave alone', () => {
    // Phase 1 and 2 independent, Phase 3 is Tests (also independent)
    const phases = [
      makePhase(1, 'Types', []),
      makePhase(2, 'Config', []),
      makePhase(3, 'Tests', []),
    ];

    const waves = calculateWaves(phases);
    // Phases 1 and 2 in wave 1, Tests alone in wave 2
    expect(waves).toHaveLength(2);
    expect(waves[0]).toEqual({ wave_number: 1, phase_numbers: [1, 2] });
    expect(waves[1]).toEqual({ wave_number: 2, phase_numbers: [3] });
  });

  it('should isolate tests phase even when it has dependencies', () => {
    const phases = [
      makePhase(1, 'Setup', []),
      makePhase(2, 'Implementation', [1]),
      makePhase(3, 'Unit Tests', [1, 2]),
    ];

    const waves = calculateWaves(phases);
    // Phase 1 in wave 1, Phase 2 in wave 2, Tests in wave 3
    expect(waves).toHaveLength(3);
    expect(waves[0].phase_numbers).toEqual([1]);
    expect(waves[1].phase_numbers).toEqual([2]);
    expect(waves[2].phase_numbers).toEqual([3]);
  });

  it('should handle diamond dependency pattern', () => {
    // 1 → 2, 1 → 3, 2+3 → 4
    const phases = [
      makePhase(1, 'Base', []),
      makePhase(2, 'Left', [1]),
      makePhase(3, 'Right', [1]),
      makePhase(4, 'Merge', [2, 3]),
    ];

    const waves = calculateWaves(phases);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toEqual({ wave_number: 1, phase_numbers: [1] });
    expect(waves[1]).toEqual({ wave_number: 2, phase_numbers: [2, 3] });
    expect(waves[2]).toEqual({ wave_number: 3, phase_numbers: [4] });
  });

  it('should only treat last phase as tests phase if its name contains "test"', () => {
    // Phase 2 has "test" in name but is not the last phase
    const phases = [
      makePhase(1, 'Setup', []),
      makePhase(2, 'Test Fixtures', [1]),
      makePhase(3, 'Implementation', [1]),
    ];

    const waves = calculateWaves(phases);
    // Phase 3 is the last phase and does NOT contain "test"
    // So no tests-phase isolation — normal wave calculation
    expect(waves[0].phase_numbers).toContain(1);
  });
});
