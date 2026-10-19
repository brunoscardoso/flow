/**
 * Tests for heartbeat state parser
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getHeartbeatSummary } from './heartbeat-state.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'plan-flow-heartbeat-state-test-'));
}

describe('getHeartbeatSummary', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return zeros when no heartbeat files exist', () => {
    const summary = getHeartbeatSummary(tempDir);
    expect(summary).toEqual({
      unread_count: 0,
      has_prompt: false,
      last_read_timestamp: null,
    });
  });

  it('should count all events as unread when no state file exists', () => {
    const events = [
      JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', type: 'run', task: 'a' }),
      JSON.stringify({ timestamp: '2026-03-01T11:00:00Z', type: 'run', task: 'b' }),
      JSON.stringify({ timestamp: '2026-03-01T12:00:00Z', type: 'run', task: 'c' }),
    ].join('\n');

    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), events);

    const summary = getHeartbeatSummary(tempDir);
    expect(summary.unread_count).toBe(3);
    expect(summary.last_read_timestamp).toBeNull();
  });

  it('should count only events after last read timestamp', () => {
    const events = [
      JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', type: 'run', task: 'a' }),
      JSON.stringify({ timestamp: '2026-03-01T11:00:00Z', type: 'run', task: 'b' }),
      JSON.stringify({ timestamp: '2026-03-01T12:00:00Z', type: 'run', task: 'c' }),
    ].join('\n');

    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), events);
    writeFileSync(
      join(tempDir, '.heartbeat-state.json'),
      JSON.stringify({ lastReadTimestamp: '2026-03-01T10:30:00Z' }),
    );

    const summary = getHeartbeatSummary(tempDir);
    expect(summary.unread_count).toBe(2);
    expect(summary.last_read_timestamp).toBe('2026-03-01T10:30:00Z');
  });

  it('should return zero unread for empty events file', () => {
    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), '');

    const summary = getHeartbeatSummary(tempDir);
    expect(summary.unread_count).toBe(0);
  });

  it('should handle corrupt state JSON by treating all events as unread', () => {
    const events = [
      JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', type: 'run', task: 'a' }),
    ].join('\n');

    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), events);
    writeFileSync(join(tempDir, '.heartbeat-state.json'), '{{corrupt json}}');

    const summary = getHeartbeatSummary(tempDir);
    expect(summary.unread_count).toBe(1);
    expect(summary.last_read_timestamp).toBeNull();
  });

  it('should detect pending prompt', () => {
    writeFileSync(join(tempDir, '.heartbeat-prompt.md'), '# Question\nWhat should I do?');

    const summary = getHeartbeatSummary(tempDir);
    expect(summary.has_prompt).toBe(true);
  });

  it('should return has_prompt false when no prompt file exists', () => {
    const summary = getHeartbeatSummary(tempDir);
    expect(summary.has_prompt).toBe(false);
  });

  it('should handle state file with missing lastReadTimestamp field', () => {
    writeFileSync(join(tempDir, '.heartbeat-state.json'), JSON.stringify({ foo: 'bar' }));
    const events = [
      JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', type: 'run', task: 'a' }),
    ].join('\n');
    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), events);

    const summary = getHeartbeatSummary(tempDir);
    expect(summary.unread_count).toBe(1);
    expect(summary.last_read_timestamp).toBeNull();
  });

  it('should handle empty state file', () => {
    writeFileSync(join(tempDir, '.heartbeat-state.json'), '');
    const events = [
      JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', type: 'run', task: 'a' }),
    ].join('\n');
    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), events);

    const summary = getHeartbeatSummary(tempDir);
    expect(summary.unread_count).toBe(1);
    expect(summary.last_read_timestamp).toBeNull();
  });

  it('should skip corrupt event lines gracefully when counting with timestamp', () => {
    const events = [
      JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', type: 'run', task: 'a' }),
      'not-valid-json',
      JSON.stringify({ timestamp: '2026-03-01T12:00:00Z', type: 'run', task: 'b' }),
    ].join('\n');

    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), events);
    writeFileSync(
      join(tempDir, '.heartbeat-state.json'),
      JSON.stringify({ lastReadTimestamp: '2026-03-01T09:00:00Z' }),
    );

    const summary = getHeartbeatSummary(tempDir);
    // 2 valid events after timestamp, corrupt line skipped
    expect(summary.unread_count).toBe(2);
  });

  it('should count all lines (including corrupt) when no timestamp exists', () => {
    const events = [
      JSON.stringify({ timestamp: '2026-03-01T10:00:00Z', type: 'run', task: 'a' }),
      'not-valid-json',
      JSON.stringify({ timestamp: '2026-03-01T12:00:00Z', type: 'run', task: 'b' }),
    ].join('\n');

    writeFileSync(join(tempDir, '.heartbeat-events.jsonl'), events);

    const summary = getHeartbeatSummary(tempDir);
    // No timestamp → lines.length = 3 (all counted, including corrupt)
    expect(summary.unread_count).toBe(3);
  });
});
