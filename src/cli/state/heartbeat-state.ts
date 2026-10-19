/**
 * Heartbeat state parser — reads heartbeat events and calculates unread count.
 *
 * Parses `.heartbeat-state.json` for the last read timestamp,
 * `.heartbeat-events.jsonl` for event records, and checks
 * `.heartbeat-prompt.md` for pending prompt status.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HeartbeatSummary } from './types.js';
import type { HeartbeatState } from '../types.js';

const STATE_FILENAME = '.heartbeat-state.json';
const EVENTS_FILENAME = '.heartbeat-events.jsonl';
const PROMPT_FILENAME = '.heartbeat-prompt.md';

/**
 * Read and parse the heartbeat state file.
 * Returns null if the file is missing, empty, or contains corrupt JSON.
 */
function readHeartbeatState(flowDir: string): HeartbeatState | null {
  const filePath = join(flowDir, STATE_FILENAME);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return null;
    }
    const parsed = JSON.parse(content) as HeartbeatState;
    if (!parsed.lastReadTimestamp || typeof parsed.lastReadTimestamp !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON — treat as missing
    return null;
  }
}

/**
 * Count unread events from the JSONL events file.
 * An event is unread if its timestamp is after the lastReadTimestamp,
 * or if lastReadTimestamp is null (all events are unread).
 */
function countUnreadEvents(flowDir: string, lastReadTimestamp: string | null): number {
  const filePath = join(flowDir, EVENTS_FILENAME);

  if (!existsSync(filePath)) {
    return 0;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }

  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return 0;
  }

  // If no last read timestamp, all events are unread
  if (lastReadTimestamp === null) {
    return lines.length;
  }

  const lastReadDate = new Date(lastReadTimestamp);
  let unreadCount = 0;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { timestamp: string };
      const eventDate = new Date(event.timestamp);
      if (eventDate > lastReadDate) {
        unreadCount++;
      }
    } catch {
      // Skip corrupt lines
    }
  }

  return unreadCount;
}

/**
 * Get the heartbeat summary for a flow directory.
 *
 * Returns unread event count, pending prompt status, and last read timestamp.
 * Handles all edge cases: missing files, empty files, corrupt JSON.
 */
export function getHeartbeatSummary(flowDir: string): HeartbeatSummary {
  const state = readHeartbeatState(flowDir);
  const lastReadTimestamp = state?.lastReadTimestamp ?? null;

  const unreadCount = countUnreadEvents(flowDir, lastReadTimestamp);

  const promptPath = join(flowDir, PROMPT_FILENAME);
  const hasPrompt = existsSync(promptPath);

  return {
    unread_count: unreadCount,
    has_prompt: hasPrompt,
    last_read_timestamp: lastReadTimestamp,
  };
}
