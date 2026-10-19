/**
 * Tests for event-writer — JSONL append, file creation, atomic write, readEvents
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEvent, appendEvent, readEvents } from './event-writer.js';
import type { NotificationEvent } from '../types.js';

describe('event-writer', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'event-writer-test-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  describe('createEvent', () => {
    it('should create an event with auto-generated id and timestamp', () => {
      const event = createEvent('my-task', 'task_started', 'info', 'Task started');

      expect(event.id).toBeDefined();
      expect(typeof event.id).toBe('string');
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.task).toBe('my-task');
      expect(event.type).toBe('task_started');
      expect(event.level).toBe('info');
      expect(event.message).toBe('Task started');
      expect(event.phase).toBeUndefined();
    });

    it('should include optional phase when provided', () => {
      const event = createEvent('my-task', 'phase_complete', 'info', 'Phase done', 'phase-1');

      expect(event.phase).toBe('phase-1');
    });

    it('should generate unique ids for each event', () => {
      const event1 = createEvent('t', 'task_started', 'info', 'm1');
      const event2 = createEvent('t', 'task_started', 'info', 'm2');

      expect(event1.id).not.toBe(event2.id);
    });
  });

  describe('appendEvent', () => {
    it('should create the events file if it does not exist', async () => {
      const event = createEvent('task-a', 'task_started', 'info', 'Started');

      await appendEvent(flowDir, event);

      const content = await readFile(join(flowDir, '.heartbeat-events.jsonl'), 'utf-8');
      expect(content.trim().length).toBeGreaterThan(0);

      const parsed = JSON.parse(content.trim());
      expect(parsed.task).toBe('task-a');
      expect(parsed.message).toBe('Started');
    });

    it('should append multiple events as separate JSONL lines', async () => {
      const event1 = createEvent('task-a', 'task_started', 'info', 'Started');
      const event2 = createEvent('task-a', 'phase_complete', 'info', 'Phase 1 done');
      const event3 = createEvent('task-a', 'task_complete', 'info', 'All done');

      await appendEvent(flowDir, event1);
      await appendEvent(flowDir, event2);
      await appendEvent(flowDir, event3);

      const content = await readFile(join(flowDir, '.heartbeat-events.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(3);

      expect(JSON.parse(lines[0]).message).toBe('Started');
      expect(JSON.parse(lines[1]).message).toBe('Phase 1 done');
      expect(JSON.parse(lines[2]).message).toBe('All done');
    });

    it('lands both events when two calls overlap, with neither rejecting (#1580)', async () => {
      // Two heartbeat tasks scheduled at the same interval dispatch
      // milliseconds apart — the daemon's real access pattern.
      const a = appendEvent(flowDir, createEvent('loop-fix', 'task_started', 'info', 'Starting task: loop-fix'));
      const b = appendEvent(flowDir, createEvent('loop-find', 'task_started', 'info', 'Starting task: loop-find'));

      const results = await Promise.allSettled([a, b]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);

      const events = await readEvents(flowDir);
      expect(events.map((e) => e.task).sort()).toEqual(['loop-find', 'loop-fix']);
    });

    it('should serialize timestamp as ISO string', async () => {
      const event = createEvent('task-a', 'task_started', 'info', 'Started');

      await appendEvent(flowDir, event);

      const content = await readFile(join(flowDir, '.heartbeat-events.jsonl'), 'utf-8');
      const parsed = JSON.parse(content.trim());
      expect(typeof parsed.timestamp).toBe('string');
      // Should be a valid ISO date string
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });
  });

  describe('readEvents', () => {
    it('should return an empty array if the file does not exist', async () => {
      const events = await readEvents(flowDir);
      expect(events).toEqual([]);
    });

    it('should read back events with Date timestamps', async () => {
      const event = createEvent('task-a', 'task_complete', 'info', 'Done');
      await appendEvent(flowDir, event);

      const events = await readEvents(flowDir);
      expect(events).toHaveLength(1);
      expect(events[0].task).toBe('task-a');
      expect(events[0].message).toBe('Done');
      expect(events[0].timestamp).toBeInstanceOf(Date);
    });

    it('should read back multiple events in order', async () => {
      await appendEvent(flowDir, createEvent('t', 'task_started', 'info', 'first'));
      await appendEvent(flowDir, createEvent('t', 'task_complete', 'info', 'second'));

      const events = await readEvents(flowDir);
      expect(events).toHaveLength(2);
      expect(events[0].message).toBe('first');
      expect(events[1].message).toBe('second');
    });

    it('should preserve all event fields through write-read cycle', async () => {
      const original = createEvent('my-task', 'phase_complete', 'warn', 'Slow phase', 'phase-3');
      await appendEvent(flowDir, original);

      const events = await readEvents(flowDir);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(original.id);
      expect(events[0].task).toBe('my-task');
      expect(events[0].type).toBe('phase_complete');
      expect(events[0].level).toBe('warn');
      expect(events[0].message).toBe('Slow phase');
      expect(events[0].phase).toBe('phase-3');
    });
  });
});
