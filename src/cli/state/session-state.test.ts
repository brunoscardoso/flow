/**
 * Tests for session state checker
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getSessionState } from './session-state.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'plan-flow-session-test-'));
}

describe('getSessionState', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return all false when no files exist', () => {
    const state = getSessionState(tempDir);
    expect(state).toEqual({
      files_present: {
        ledger: false,
        brain_index: false,
        tasklist: false,
        memory: false,
        scratchpad: false,
        heartbeat_events: false,
        heartbeat_state: false,
        heartbeat_prompt: false,
        state_md: false,
      },
    });
  });

  it('should return all true when all files exist', () => {
    writeFileSync(join(tempDir, 'ledger.md'), '# Ledger');
    mkdirSync(join(tempDir, 'brain'), { recursive: true });
    writeFileSync(join(tempDir, 'brain', 'index.md'), '# Brain');
    writeFileSync(join(tempDir, 'tasklist.md'), '# Tasks');
    writeFileSync(join(tempDir, 'memory.md'), '# Memory');
    writeFileSync(join(tempDir, '.scratchpad.md'), '# Scratchpad');
    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), '');
    writeFileSync(join(tempDir, '.heartbeat-state.json'), '{}');
    writeFileSync(join(tempDir, '.heartbeat-prompt.md'), '# Prompt');
    writeFileSync(join(tempDir, 'STATE.md'), '# Session State');

    const state = getSessionState(tempDir);
    expect(state).toEqual({
      files_present: {
        ledger: true,
        brain_index: true,
        tasklist: true,
        memory: true,
        scratchpad: true,
        heartbeat_events: true,
        heartbeat_state: true,
        heartbeat_prompt: true,
        state_md: true,
      },
    });
  });

  it('should handle partial files (some exist, some do not)', () => {
    writeFileSync(join(tempDir, 'ledger.md'), '# Ledger');
    writeFileSync(join(tempDir, 'tasklist.md'), '# Tasks');
    writeFileSync(join(tempDir, '.heartbeat-prompt.md'), '# Prompt');

    const state = getSessionState(tempDir);
    expect(state.files_present.ledger).toBe(true);
    expect(state.files_present.brain_index).toBe(false);
    expect(state.files_present.tasklist).toBe(true);
    expect(state.files_present.memory).toBe(false);
    expect(state.files_present.scratchpad).toBe(false);
    expect(state.files_present.heartbeat_events).toBe(false);
    expect(state.files_present.heartbeat_state).toBe(false);
    expect(state.files_present.heartbeat_prompt).toBe(true);
  });
});
