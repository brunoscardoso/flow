/**
 * Tests for state CLI command (integration)
 */

import { jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock all parser modules
const mockParseFlowConfig = jest.fn();
const mockGetSessionState = jest.fn();
const mockGetHeartbeatSummary = jest.fn();
const mockParsePlan = jest.fn();
const mockCalculateWaves = jest.fn();
const mockCalculateModelTiers = jest.fn();

jest.unstable_mockModule(
  resolve(__dirname, '../state/flowconfig-parser'),
  () => ({ parseFlowConfig: mockParseFlowConfig }),
);
jest.unstable_mockModule(
  resolve(__dirname, '../state/session-state'),
  () => ({ getSessionState: mockGetSessionState }),
);
jest.unstable_mockModule(
  resolve(__dirname, '../state/heartbeat-state'),
  () => ({ getHeartbeatSummary: mockGetHeartbeatSummary }),
);
jest.unstable_mockModule(
  resolve(__dirname, '../state/plan-parser'),
  () => ({ parsePlan: mockParsePlan }),
);
jest.unstable_mockModule(
  resolve(__dirname, '../state/wave-calculator'),
  () => ({ calculateWaves: mockCalculateWaves }),
);
jest.unstable_mockModule(
  resolve(__dirname, '../state/model-router'),
  () => ({ calculateModelTiers: mockCalculateModelTiers }),
);

const { runState } = await import('./state');

const DEFAULT_CONFIG = {
  autopilot: false,
  commit: false,
  push: false,
  branch: '',
  wave_execution: true,
  phase_isolation: true,
  model_routing: true,
  max_verify_retries: 2,
};

const DEFAULT_SESSION = {
  files_present: {
    ledger: false,
    brain_index: false,
    tasklist: false,
    memory: false,
    scratchpad: false,
    heartbeat_events: false,
    heartbeat_state: false,
    heartbeat_prompt: false,
  },
};

const DEFAULT_HEARTBEAT = {
  unread_count: 0,
  has_prompt: false,
  last_read_timestamp: null,
};

describe('runState', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockParseFlowConfig.mockReturnValue(DEFAULT_CONFIG);
    mockGetSessionState.mockReturnValue(DEFAULT_SESSION);
    mockGetHeartbeatSummary.mockReturnValue(DEFAULT_HEARTBEAT);

    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Reset exitCode
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('should output state JSON without plan section when --plan is not provided', async () => {
    await runState({ target: '/tmp/test-project' });

    expect(mockParseFlowConfig).toHaveBeenCalledWith('/tmp/test-project/flow');
    expect(mockGetSessionState).toHaveBeenCalledWith('/tmp/test-project/flow');
    expect(mockGetHeartbeatSummary).toHaveBeenCalledWith('/tmp/test-project/flow');
    expect(mockParsePlan).not.toHaveBeenCalled();

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.config).toEqual(DEFAULT_CONFIG);
    expect(output.session).toEqual(DEFAULT_SESSION);
    expect(output.heartbeat).toEqual(DEFAULT_HEARTBEAT);
    expect(output.plan).toBeUndefined();
  });

  it('should include plan section when --plan is provided', async () => {
    const mockPhases = [
      { number: 1, name: 'Setup', complexity: 3, dependencies: [], tasks: [] },
    ];
    const mockWaves = [{ wave_number: 1, phase_numbers: [1] }];
    const mockTiers: never[] = [];

    mockParsePlan.mockReturnValue(mockPhases);
    mockCalculateWaves.mockReturnValue(mockWaves);
    mockCalculateModelTiers.mockReturnValue(mockTiers);

    await runState({ target: '/tmp/test-project', plan: '/tmp/test-project/flow/plans/plan_test_v1.md' });

    expect(mockParsePlan).toHaveBeenCalledWith('/tmp/test-project/flow/plans/plan_test_v1.md');
    expect(mockCalculateWaves).toHaveBeenCalledWith(mockPhases);
    // Routing on by default (#1957): state passes the resolved config through.
    expect(mockCalculateModelTiers).toHaveBeenCalledWith(mockPhases, true);

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.plan).toEqual({
      phases: mockPhases,
      waves: mockWaves,
      model_tiers: mockTiers,
    });
  });

  it('should output error JSON and set exitCode on failure', async () => {
    mockParseFlowConfig.mockImplementation(() => {
      throw new Error('Config file corrupted');
    });

    await runState({ target: '/tmp/test-project' });

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.error).toBe('Config file corrupted');
    expect(process.exitCode).toBe(1);
  });

  // ── Phase 5.4: FR-4 — what `/resume-work` reads ──────────

  /**
   * `/resume-work`'s first act is to read `flow/STATE.md` and report the active
   * skill, plan and phase. `state-md-parser` is deliberately NOT mocked in this
   * file, so these run the real reader against a real file — which is the only
   * way they can prove FR-4, because the failure this plan exists for is a
   * parser that fail-softs a drifted file to empty and a consumer that reports
   * "nothing in flight" confidently and wrongly.
   */
  describe('the execution state /resume-work reports (FR-4)', () => {
    const temps: string[] = [];

    /** A project whose STATE.md is written in the pinned grammar. */
    function projectWithStateMd(body: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'state-cmd-'));
      temps.push(dir);
      mkdirSync(join(dir, 'flow'), { recursive: true });
      writeFileSync(join(dir, 'flow', 'STATE.md'), body, 'utf-8');
      return dir;
    }

    /** The canonical example from `.claude/resources/core/state-md.md`. */
    const CANONICAL = [
      '# Session State',
      '',
      '**Updated**: 2026-08-14T09:12:00.000Z',
      '',
      '## Execution State',
      '- **Active Skill**: execute-plan',
      '- **Active Plan**: flow/plans/plan_user_auth_v1.md',
      '- **Current Phase**: 3 — API Integration',
      '- **Current Task**: Create the API route handler',
      '- **Completed Phases**:',
      '  - Phase 1: Types and Schemas — done',
      '  - Phase 2: Backend Setup — done with warnings',
      '',
      '## Next Action',
      'Continue with Phase 3, Task 2: add rate limiting to the API routes',
      '',
    ].join('\n');

    afterAll(() => {
      for (const dir of temps) rmSync(dir, { recursive: true, force: true });
    });

    it('reports the active skill, plan and phase', async () => {
      await runState({ target: projectWithStateMd(CANONICAL) });

      const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
      expect(output.execution).toMatchObject({
        active_skill: 'execute-plan',
        active_plan: 'flow/plans/plan_user_auth_v1.md',
        current_phase: { number: 3, name: 'API Integration' },
        current_task: 'Create the API route handler',
      });
      expect(output.execution.completed_phases).toHaveLength(2);
      expect(output.execution.next_action).toContain('rate limiting');
      expect(output.execution.updated_at).toBe('2026-08-14T09:12:00.000Z');
    });

    it('omits `execution` when there is no STATE.md — which is what "nothing to resume" looks like', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'state-cmd-'));
      temps.push(dir);
      mkdirSync(join(dir, 'flow'), { recursive: true });

      await runState({ target: dir });

      const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
      expect(output.execution).toBeUndefined();
    });

    it('reports the phase even when the skill wrote no plan path', async () => {
      const target = projectWithStateMd(
        [
          '# Session State',
          '',
          '## Execution State',
          '- **Active Skill**: discovery-plan',
          '- **Current Phase**: 1 — Requirements',
          '',
        ].join('\n'),
      );

      await runState({ target });

      const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
      expect(output.execution).toMatchObject({
        active_skill: 'discovery-plan',
        current_phase: { number: 1, name: 'Requirements' },
      });
      expect(output.execution.active_plan).toBeNull();
    });
  });
});
