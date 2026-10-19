/**
 * Tests for notification-router — severity routing logic
 */

import { jest } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NotificationEvent } from '../types.js';

// Mock downstream modules before importing the router
const mockAppendLog = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockAppendEvent = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockSendDesktopNotification = jest.fn();

jest.unstable_mockModule('./log-writer.js', () => ({
  appendLog: mockAppendLog,
}));

jest.unstable_mockModule('./event-writer.js', () => ({
  appendEvent: mockAppendEvent,
}));

jest.unstable_mockModule('./desktop-notifier.js', () => ({
  sendDesktopNotification: mockSendDesktopNotification,
}));

// Import after mocks are set up
const { notify } = await import('./notification-router.js');

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: 'test-id',
    timestamp: new Date('2026-03-17T14:30:00'),
    task: 'my-task',
    type: 'task_complete',
    level: 'info',
    message: 'All done',
    ...overrides,
  };
}

describe('notification-router', () => {
  const flowDir = '/tmp/test-flow';

  beforeEach(() => {
    mockAppendLog.mockClear();
    mockAppendEvent.mockClear();
    mockSendDesktopNotification.mockClear();
  });

  it('should always call appendLog and appendEvent for info events', async () => {
    const event = makeEvent({ level: 'info', type: 'task_complete' });

    await notify(event, flowDir);

    expect(mockAppendLog).toHaveBeenCalledTimes(1);
    expect(mockAppendLog).toHaveBeenCalledWith(flowDir, event);
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
    expect(mockAppendEvent).toHaveBeenCalledWith(flowDir, event);
  });

  it('should send desktop notification for task_complete events', async () => {
    const event = makeEvent({ level: 'info', type: 'task_complete' });

    await notify(event, flowDir);

    expect(mockSendDesktopNotification).toHaveBeenCalledTimes(1);
    expect(mockSendDesktopNotification).toHaveBeenCalledWith(event);
  });

  it('should NOT send desktop notification for warn-level task_started', async () => {
    const event = makeEvent({ level: 'warn', type: 'task_started' });

    await notify(event, flowDir);

    expect(mockSendDesktopNotification).not.toHaveBeenCalled();
  });

  it('should send desktop notification for error-level events', async () => {
    const event = makeEvent({ level: 'error', type: 'task_failed' });

    await notify(event, flowDir);

    expect(mockAppendLog).toHaveBeenCalledTimes(1);
    expect(mockAppendEvent).toHaveBeenCalledTimes(1);
    expect(mockSendDesktopNotification).toHaveBeenCalledTimes(1);
    expect(mockSendDesktopNotification).toHaveBeenCalledWith(event);
  });

  it('should send desktop notification for task_blocked events regardless of level', async () => {
    const event = makeEvent({ level: 'warn', type: 'task_blocked' });

    await notify(event, flowDir);

    expect(mockSendDesktopNotification).toHaveBeenCalledTimes(1);
    expect(mockSendDesktopNotification).toHaveBeenCalledWith(event);
  });

  it('should send desktop notification for error-level task_blocked events', async () => {
    const event = makeEvent({ level: 'error', type: 'task_blocked' });

    await notify(event, flowDir);

    expect(mockSendDesktopNotification).toHaveBeenCalledTimes(1);
  });

  it('should NOT send desktop notification for info-level phase_complete', async () => {
    const event = makeEvent({ level: 'info', type: 'phase_complete' });

    await notify(event, flowDir);

    expect(mockSendDesktopNotification).not.toHaveBeenCalled();
  });
});

/**
 * #1806 — no document promises a notification channel the router does not have.
 *
 * `0d997af5` (2026-03-19) deleted webhook delivery and two-way Telegram polling
 * and stripped their three config keys. It touched no documentation file, so
 * `CLAUDE.md`, the heartbeat resource and `/flow` went on describing both as
 * working features for five months — and `/flow` went on offering the keys as
 * settable.
 *
 * That is worse than a stale sentence. A user follows the documented steps,
 * configures a channel, is told nothing is wrong, and never receives anything;
 * in the Telegram case the docs promised that a blocked headless run could be
 * unblocked by replying in Telegram, so someone relying on it waits for a
 * daemon that is not listening.
 *
 * The guard is deliberately two-sided: one half catches the docs drifting back,
 * the other catches the CODE quietly gaining an external channel again without
 * anyone saying so.
 */
describe('notifications are local, and the docs say only that (#1806)', () => {
  const REPO_ROOT = join(process.cwd());

  /** The three keys the removal took with it. */
  const RETIRED_KEYS = ['webhook_url', 'telegram_bot_token', 'telegram_chat_id'] as const;

  /** Docs that described the removed channels, and now must not offer them. */
  const SHIPPED_DOCS = [
    'CLAUDE.md',
    '.claude/resources/core/heartbeat.md',
    '.claude/commands/flow.md',
  ] as const;

  it.each(SHIPPED_DOCS)('%s does not offer a retired key as a setting', (doc) => {
    const text = readFileSync(join(REPO_ROOT, doc), 'utf-8');
    // The `/flow <key>=<value>` form is the one that INVITES the user to set
    // it. Naming a key while explaining that it was removed is the point of
    // the replacement text, so only the settable form is an offence.
    const offered = RETIRED_KEYS.filter((key) => text.includes(`${key}=`));
    expect({ doc, offered }).toEqual({ doc, offered: [] });
  });

  it.each(SHIPPED_DOCS)('%s does not describe sending a notification anywhere', (doc) => {
    const text = readFileSync(join(REPO_ROOT, doc), 'utf-8');
    const claims = [
      { pattern: /sent as HTTP POST/i, why: 'there is no HTTP client in src/cli' },
      { pattern: /hooks\.slack\.com/i, why: 'Slack delivery was removed' },
      { pattern: /discord\.com\/api\/webhooks/i, why: 'Discord delivery was removed' },
      { pattern: /polls for incoming|getUpdates/i, why: 'Telegram polling was removed' },
    ]
      .filter((claim) => claim.pattern.test(text))
      .map((claim) => `${claim.pattern.source} — ${claim.why}`);
    expect({ doc, claims }).toEqual({ doc, claims: [] });
  });

  it('the daemon reaches no network at all — the claim the docs now rest on', () => {
    // THE OTHER DIRECTION. If an external channel is ever restored, this fails
    // and whoever restores it is sent back to the docs that promise notifications
    // are local.
    //
    // Scoped to `daemon/`, which is where notifications live and where the three
    // deleted files were. A repo-wide `fetch(` scan reads as stricter and is
    // actually WEAKER: it trips on `github-queue`'s own private `this.fetch(id)`
    // (which shells out to `gh`) and on an extractor's doc-comment examples
    // (forbidden-pattern #9), so it would have been silenced within a week.
    const offenders = walkTs(join(REPO_ROOT, 'src', 'cli', 'daemon')).filter((file) => {
      if (file.endsWith('.test.ts')) return false;
      return /\bfetch\(|node:https?|\baxios\b|\bundici\b/.test(readFileSync(file, 'utf-8'));
    });
    expect(offenders).toEqual([]);
  });

  it('nothing in the CLI imports an HTTP client', () => {
    // The import form has no false positives anywhere in the tree, so this one
    // can be repo-wide: a webhook sender has to get its transport from
    // somewhere, and every route but bare `fetch` shows up here.
    const offenders = walkTs(join(REPO_ROOT, 'src', 'cli')).filter((file) => {
      // Tests are excluded, this file included: its own regex source matches it.
      if (file.endsWith('.test.ts')) return false;
      return /from '(node:)?https?'|require\('(node:)?https?'\)|from 'axios'|from 'undici'|from 'node-fetch'/.test(
        readFileSync(file, 'utf-8'),
      );
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the secret guard for a key nobody reads any more', () => {
    // DELIBERATELY NOT SWEPT, against the report's own suggestion. A project
    // that configured Telegram before the removal still has that token sitting
    // in `.flowconfig`; dropping it from the share command's secret list would
    // commit somebody's bot token the first time they shared their brain. A
    // guard for a retired feature costs nothing and protects a real value.
    const share = readFileSync(join(REPO_ROOT, 'src', 'cli', 'commands', 'share.ts'), 'utf-8');
    expect(share).toContain("'telegram_bot_token'");
    expect(share).toContain("'webhook_url'");
  });
});

/** Every `.ts` file under a directory, recursively. */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
