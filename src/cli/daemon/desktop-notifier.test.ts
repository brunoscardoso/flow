/**
 * Tests for desktop-notifier — notification dispatch and graceful fallback
 */

import { jest } from '@jest/globals';
import type { NotificationEvent } from '../types.js';

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: 'test-id',
    timestamp: new Date('2026-03-17T14:30:00'),
    task: 'my-task',
    type: 'task_failed',
    level: 'error',
    message: 'Something broke',
    ...overrides,
  };
}

describe('desktop-notifier', () => {
  let mockNotify: jest.Mock;

  beforeEach(() => {
    // Reset module registry so cachedNotifier is cleared between tests
    jest.resetModules();
    mockNotify = jest.fn();
  });

  it('should call node-notifier with correct title and message', async () => {
    jest.unstable_mockModule('node-notifier', () => ({
      default: { notify: mockNotify },
    }));

    const { sendDesktopNotification } = await import('./desktop-notifier.js');
    const event = makeEvent({ task: 'research', message: 'Failed to fetch' });

    sendDesktopNotification(event);

    // Allow the async IIFE to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith({
      title: 'Plan-Flow Heartbeat',
      message: 'research: Failed to fetch',
    });
  });

  it('should not throw when node-notifier is unavailable', async () => {
    jest.unstable_mockModule('node-notifier', () => {
      throw new Error('Cannot find module node-notifier');
    });

    const { sendDesktopNotification } = await import('./desktop-notifier.js');
    const event = makeEvent();

    // Should not throw
    expect(() => sendDesktopNotification(event)).not.toThrow();

    // Allow the async IIFE to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('should not throw when notifier.notify throws', async () => {
    const throwingNotify = jest.fn().mockImplementation(() => {
      throw new Error('OS notification failed');
    });

    jest.unstable_mockModule('node-notifier', () => ({
      default: { notify: throwingNotify },
    }));

    const { sendDesktopNotification } = await import('./desktop-notifier.js');
    const event = makeEvent();

    // Suppress console.error for this test
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => sendDesktopNotification(event)).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));

    consoleSpy.mockRestore();
  });
});
