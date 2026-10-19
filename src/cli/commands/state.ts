/**
 * State CLI command
 *
 * Outputs deterministic JSON representing current plan-flow state.
 * Composes all parsers: config, session, heartbeat (always),
 * and plan/waves/tiers (when --plan is provided).
 */

import { join } from 'node:path';
import { parseFlowConfig } from '../state/flowconfig-parser.js';
import { getSessionState } from '../state/session-state.js';
import { getHeartbeatSummary } from '../state/heartbeat-state.js';
import { parseStateMd } from '../state/state-md-parser.js';
import { parsePlan } from '../state/plan-parser.js';
import { calculateWaves } from '../state/wave-calculator.js';
import { calculateModelTiers } from '../state/model-router.js';
import type { StateOutput } from '../state/types.js';

export async function runState(options: {
  plan?: string;
  target: string;
}): Promise<void> {
  try {
    const flowDir = join(options.target, 'flow');

    const config = parseFlowConfig(flowDir);
    const session = getSessionState(flowDir);
    const heartbeat = getHeartbeatSummary(flowDir);

    const execution = parseStateMd(flowDir);

    const output: StateOutput = {
      config,
      session,
      heartbeat,
      ...(execution ? { execution } : {}),
    };

    if (options.plan) {
      const phases = parsePlan(options.plan);
      const waves = calculateWaves(phases);
      const model_tiers = calculateModelTiers(phases, config.model_routing);

      output.plan = {
        phases,
        waves,
        model_tiers,
      };
    }

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
    process.exitCode = 1;
  }
}
