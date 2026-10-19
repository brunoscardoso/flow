/**
 * Event writer — appends NotificationEvent records to a JSONL file.
 *
 * Appends are plain `appendFile` calls: JSONL never needs a read-modify-write,
 * and a single O_APPEND write per line is what lets two tasks firing in the
 * same instant both land (#1580 — the old write-to-shared-temp-then-rename
 * sequence lost one of every pair of simultaneous events).
 */

import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { NotificationEvent, NotificationLevel, NotificationType } from '../types.js';

const EVENTS_FILENAME = '.heartbeat-events.jsonl';

/**
 * Build the full path to the events file for a given flow directory.
 */
function eventsPath(flowDir: string): string {
  return join(flowDir, EVENTS_FILENAME);
}

/**
 * Create a NotificationEvent with an auto-generated id and current timestamp.
 */
export function createEvent(
  task: string,
  type: NotificationType,
  level: NotificationLevel,
  message: string,
  phase?: string,
): NotificationEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    task,
    type,
    level,
    phase,
    message,
  };
}

/**
 * Append a single event to the JSONL file.
 *
 * One `appendFile` per event: concurrent callers each append their own line,
 * so overlapping appends both land in either order and neither rejects.
 */
export async function appendEvent(
  flowDir: string,
  event: NotificationEvent,
): Promise<void> {
  const filePath = eventsPath(flowDir);
  const dir = dirname(filePath);

  await mkdir(dir, { recursive: true });

  const line = JSON.stringify({
    ...event,
    timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : event.timestamp,
  });

  await appendFile(filePath, `${line}\n`, 'utf-8');
}

/**
 * Read all events from the JSONL file. Returns an empty array if the file
 * does not exist.
 */
export async function readEvents(flowDir: string): Promise<NotificationEvent[]> {
  const filePath = eventsPath(flowDir);

  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parsed = JSON.parse(line);
      return { ...parsed, timestamp: new Date(parsed.timestamp) };
    });
}
