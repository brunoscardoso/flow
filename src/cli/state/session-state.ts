/**
 * Session state checker — detects which session-start files exist
 * in the flow directory, returning a structured SessionState object.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionState } from './types.js';

/**
 * Checks existence of all session-start files and returns structured state.
 *
 * Files checked:
 * - ledger.md
 * - brain/index.md
 * - tasklist.md
 * - memory.md
 * - .scratchpad.md
 * - .heartbeat-events.jsonl
 * - .heartbeat-state.json
 * - .heartbeat-prompt.md
 * - STATE.md
 */
export function getSessionState(flowDir: string): SessionState {
  return {
    files_present: {
      ledger: existsSync(join(flowDir, 'ledger.md')),
      brain_index: existsSync(join(flowDir, 'brain', 'index.md')),
      tasklist: existsSync(join(flowDir, 'tasklist.md')),
      memory: existsSync(join(flowDir, 'memory.md')),
      scratchpad: existsSync(join(flowDir, '.scratchpad.md')),
      heartbeat_events: existsSync(join(flowDir, '.heartbeat-events.jsonl')),
      heartbeat_state: existsSync(join(flowDir, '.heartbeat-state.json')),
      heartbeat_prompt: existsSync(join(flowDir, '.heartbeat-prompt.md')),
      state_md: existsSync(join(flowDir, 'STATE.md')),
    },
  };
}
