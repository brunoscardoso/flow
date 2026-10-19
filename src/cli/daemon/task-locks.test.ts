/**
 * Tests for the daemon's per-task lock map.
 */

import { createTaskLocks } from './task-locks.js';

describe('createTaskLocks', () => {
  it('grants a lock to a task that does not hold one', () => {
    const locks = createTaskLocks();
    expect(locks.acquire('fix')).toBe(true);
    expect(locks.isRunning('fix')).toBe(true);
  });

  it('refuses a second lock for the SAME task', () => {
    const locks = createTaskLocks();
    expect(locks.acquire('fix')).toBe(true);
    expect(locks.acquire('fix')).toBe(false);
    expect(locks.size()).toBe(1);
  });

  it('grants locks to DIFFERENT tasks concurrently', () => {
    const locks = createTaskLocks();
    expect(locks.acquire('fix')).toBe(true);
    expect(locks.acquire('find')).toBe(true);
    expect(locks.acquire('improve')).toBe(true);
    expect(locks.size()).toBe(3);
    expect(locks.running()).toEqual(['fix', 'find', 'improve']);
  });

  it('allows re-acquisition after release', () => {
    const locks = createTaskLocks();
    locks.acquire('fix');
    locks.release('fix');
    expect(locks.isRunning('fix')).toBe(false);
    expect(locks.acquire('fix')).toBe(true);
  });

  it('treats releasing an unheld lock as a no-op', () => {
    const locks = createTaskLocks();
    expect(() => locks.release('never-ran')).not.toThrow();
    expect(locks.size()).toBe(0);
  });

  it('releasing one task does not release another', () => {
    const locks = createTaskLocks();
    locks.acquire('fix');
    locks.acquire('find');
    locks.release('fix');
    expect(locks.isRunning('fix')).toBe(false);
    expect(locks.isRunning('find')).toBe(true);
  });

  it('releaseAll clears every lock', () => {
    const locks = createTaskLocks();
    locks.acquire('fix');
    locks.acquire('find');
    locks.releaseAll();
    expect(locks.size()).toBe(0);
  });
});
