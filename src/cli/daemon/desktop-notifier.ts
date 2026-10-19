/**
 * Desktop notifier — thin wrapper around node-notifier.
 * Fire-and-forget: never throws, never blocks.
 * Degrades silently on headless servers or when node-notifier is unavailable.
 */

import type { NotificationEvent } from '../types.js';

const NOTIFICATION_TITLE = 'Plan-Flow Heartbeat';

 
type NotifierLike = { notify: (opts: { title: string; message: string }) => void };

/**
 * Lazily resolved notifier instance.
 * `null` means the import failed (headless server, missing native deps, etc.)
 */
let cachedNotifier: NotifierLike | null | undefined;

async function getNotifier(): Promise<NotifierLike | null> {
  if (cachedNotifier !== undefined) return cachedNotifier;

  try {
    // Dynamic import — may fail on headless systems
    const mod = await import('node-notifier');
    // node-notifier exports its instance as both default and named
    cachedNotifier = (mod.default ?? mod) as NotifierLike;
    return cachedNotifier;
  } catch {
    // node-notifier unavailable — degrade silently
    cachedNotifier = null;
    return null;
  }
}

/**
 * Send a desktop notification for the given event.
 *
 * - Title: "Plan-Flow Heartbeat"
 * - Message: "{task}: {message}"
 * - Fire-and-forget — does not await the OS notification result
 * - Catches ALL errors; logs to console.error but never throws
 */
export function sendDesktopNotification(event: NotificationEvent): void {
  // Intentionally not awaited — fire-and-forget
  void (async () => {
    try {
      const notifier = await getNotifier();
      if (!notifier) return;

      notifier.notify({
        title: NOTIFICATION_TITLE,
        message: `${event.task}: ${event.message}`,
      });
    } catch (error) {
      console.error('Desktop notification failed (non-fatal):', error);
    }
  })();
}
