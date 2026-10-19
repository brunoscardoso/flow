/**
 * Heartbeat file parser
 *
 * Parses flow/heartbeat.md into structured HeartbeatTask objects.
 */

import type { HeartbeatTask, ScheduleConfig } from '../types.js';

const DAY_MAP: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * Parses a human-readable schedule string into a ScheduleConfig.
 *
 * Supported formats:
 *   "daily at 10:00 PM"
 *   "every 6 hours"
 *   "every 30 minutes"
 *   "weekly on Monday at 9:00 AM"
 *   "in 2 hours" (one-shot)
 *   "in 30 minutes" (one-shot)
 */
export function parseSchedule(schedule: string): ScheduleConfig | null {
  const s = schedule.trim().toLowerCase();

  // daily at HH:MM AM/PM
  const dailyMatch = s.match(
    /^daily\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)$/
  );
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1], 10);
    const minute = parseInt(dailyMatch[2], 10);
    const period = dailyMatch[3];

    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;

    return { type: 'daily', hour, minute };
  }

  // every N hours
  const hoursMatch = s.match(/^every\s+(\d+)\s+hours?$/);
  if (hoursMatch) {
    const n = parseInt(hoursMatch[1], 10);
    return { type: 'interval', intervalMs: n * 60 * 60 * 1000 };
  }

  // every N minutes
  const minutesMatch = s.match(/^every\s+(\d+)\s+minutes?$/);
  if (minutesMatch) {
    const n = parseInt(minutesMatch[1], 10);
    return { type: 'interval', intervalMs: n * 60 * 1000 };
  }

  // in N hours (one-shot)
  const inHoursMatch = s.match(/^in\s+(\d+)\s+hours?$/);
  if (inHoursMatch) {
    const n = parseInt(inHoursMatch[1], 10);
    return { type: 'once', intervalMs: n * 60 * 60 * 1000 };
  }

  // in N minutes (one-shot)
  const inMinutesMatch = s.match(/^in\s+(\d+)\s+minutes?$/);
  if (inMinutesMatch) {
    const n = parseInt(inMinutesMatch[1], 10);
    return { type: 'once', intervalMs: n * 60 * 1000 };
  }

  // weekly on {day} at HH:MM AM/PM
  const weeklyMatch = s.match(
    /^weekly\s+on\s+(\w+)\s+at\s+(\d{1,2}):(\d{2})\s*(am|pm)$/
  );
  if (weeklyMatch) {
    const dayName = weeklyMatch[1];
    let hour = parseInt(weeklyMatch[2], 10);
    const minute = parseInt(weeklyMatch[3], 10);
    const period = weeklyMatch[4];

    if (period === 'pm' && hour !== 12) hour += 12;
    if (period === 'am' && hour === 12) hour = 0;

    const dayOfWeek = DAY_MAP[dayName];
    if (dayOfWeek === undefined) return null;

    return { type: 'weekly', hour, minute, dayOfWeek };
  }

  return null;
}

/**
 * Strips HTML comment blocks (`<!-- ... -->`) from markdown content.
 *
 * The heartbeat.md template ships a commented-out example task. Without this,
 * that example parses as a real enabled task and the daemon dispatches it.
 * Unterminated comments swallow the rest of the file — matching how markdown
 * renderers treat them, so what the user sees is what the daemon runs.
 */
function stripHtmlComments(content: string): string {
  let result = '';
  let rest = content;

  for (;;) {
    const open = rest.indexOf('<!--');
    if (open === -1) {
      result += rest;
      break;
    }

    result += rest.slice(0, open);
    const close = rest.indexOf('-->', open + 4);
    if (close === -1) break; // unterminated: drop the remainder
    rest = rest.slice(close + 3);
  }

  return result;
}

/**
 * Parses the content of a heartbeat.md file into an array of HeartbeatTask objects.
 */
export function parseHeartbeatFile(content: string): HeartbeatTask[] {
  const tasks: HeartbeatTask[] = [];
  const lines = stripHtmlComments(content).split('\n');

  let currentTask: Partial<HeartbeatTask> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Task heading: ### task-name
    const headingMatch = trimmed.match(/^###\s+(.+)$/);
    if (headingMatch) {
      // Save previous task if valid
      if (currentTask?.name) {
        const task = finalizeTask(currentTask);
        if (task) tasks.push(task);
      }
      currentTask = { name: headingMatch[1].trim() };
      continue;
    }

    if (!currentTask) continue;

    // Parse task fields
    const scheduleMatch = trimmed.match(/^-\s+\*\*Schedule\*\*:\s*(.+)$/);
    if (scheduleMatch) {
      currentTask.schedule = scheduleMatch[1].trim();
      continue;
    }

    const commandMatch = trimmed.match(/^-\s+\*\*Command\*\*:\s*(.+)$/);
    if (commandMatch) {
      currentTask.command = commandMatch[1].trim();
      continue;
    }

    const enabledMatch = trimmed.match(/^-\s+\*\*Enabled\*\*:\s*(.+)$/);
    if (enabledMatch) {
      currentTask.enabled = enabledMatch[1].trim().toLowerCase() === 'true';
      continue;
    }

    const descMatch = trimmed.match(/^-\s+\*\*Description\*\*:\s*(.+)$/);
    if (descMatch) {
      currentTask.description = descMatch[1].trim();
      continue;
    }

    const oneShotMatch = trimmed.match(/^-\s+\*\*One-Shot\*\*:\s*(.+)$/);
    if (oneShotMatch) {
      currentTask.oneShot = oneShotMatch[1].trim().toLowerCase() === 'true';
      continue;
    }

    const tasklistLinkMatch = trimmed.match(/^-\s+\*\*Tasklist Link\*\*:\s*(.+)$/);
    if (tasklistLinkMatch) {
      currentTask.tasklistLink = tasklistLinkMatch[1].trim();
      continue;
    }

    const addDirsMatch = trimmed.match(/^-\s+\*\*Add Dirs\*\*:\s*(.+)$/);
    if (addDirsMatch) {
      currentTask.addDirs = addDirsMatch[1].trim().split(/[,\s]+/).filter(Boolean);
      continue;
    }
  }

  // Save the last task
  if (currentTask?.name) {
    const task = finalizeTask(currentTask);
    if (task) tasks.push(task);
  }

  return tasks;
}

function finalizeTask(partial: Partial<HeartbeatTask>): HeartbeatTask | null {
  if (!partial.name || !partial.schedule || !partial.command) return null;

  const scheduleConfig = parseSchedule(partial.schedule);
  if (!scheduleConfig) return null;

  return {
    name: partial.name,
    schedule: partial.schedule,
    scheduleConfig,
    command: partial.command,
    enabled: partial.enabled ?? true,
    description: partial.description ?? '',
    oneShot: partial.oneShot,
    tasklistLink: partial.tasklistLink,
    addDirs: partial.addDirs,
  };
}
