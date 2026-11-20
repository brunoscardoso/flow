import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PENDING_RESET_FILE,
  RESET_OUTCOME_FILE,
  takePendingReset,
  takeResetOutcome,
  writePendingReset,
  writeResetOutcome,
} from './pending-reset'
import { runReset, type ResetSteps } from './run-reset'
import { RESET_ITEMS } from '../../shared/reset-items'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flow-reset-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a reset carried across a restart', () => {
  it('is written, then taken once', () => {
    writePendingReset(dir, ['tasks', 'app-settings'], new Date('2026-11-20T10:00:00Z'))
    expect(takePendingReset(dir)).toEqual(['app-settings', 'tasks'])
    expect(existsSync(join(dir, PENDING_RESET_FILE))).toBe(false)
    expect(takePendingReset(dir)).toBeNull()
  })

  it('refuses to record an empty request', () => {
    expect(() => writePendingReset(dir, [], new Date())).toThrow()
    expect(existsSync(join(dir, PENDING_RESET_FILE))).toBe(false)
  })

  it('drops a damaged request without guessing', () => {
    writeFileSync(join(dir, PENDING_RESET_FILE), '{ not json')
    expect(takePendingReset(dir)).toBeNull()
    expect(existsSync(join(dir, PENDING_RESET_FILE))).toBe(false)
    writeFileSync(join(dir, PENDING_RESET_FILE), JSON.stringify({ items: ['everything'] }))
    expect(takePendingReset(dir)).toBeNull()
  })

  it('keeps the outcome until it is taken', () => {
    writeResetOutcome(dir, { at: 'now', done: ['tasks'], failed: [{ item: 'logs-caches', detail: 'locked' }] })
    expect(takeResetOutcome(dir)).toEqual({
      at: 'now',
      done: ['tasks'],
      failed: [{ item: 'logs-caches', detail: 'locked' }],
    })
    expect(existsSync(join(dir, RESET_OUTCOME_FILE))).toBe(false)
  })
})

describe('running the steps', () => {
  function steps(calls: string[], failing: string | null): ResetSteps {
    return Object.fromEntries(
      RESET_ITEMS.map((item) => [
        item,
        () => {
          calls.push(item)
          if (item === failing) throw new Error(`${item} is locked`)
        },
      ]),
    ) as ResetSteps
  }

  it('runs only the requested steps, and a failure does not stop the rest', async () => {
    const calls: string[] = []
    const outcome = await runReset({
      items: ['app-settings', 'tasks', 'logs-caches'],
      steps: steps(calls, 'tasks'),
      confirmed: true,
      now: () => new Date('2026-11-20T10:00:00Z'),
    })
    expect(calls).toEqual(['app-settings', 'tasks', 'logs-caches'])
    expect(outcome.done).toEqual(['app-settings', 'logs-caches'])
    expect(outcome.failed).toEqual([{ item: 'tasks', detail: 'tasks is locked' }])
  })

  it('deletes nothing without the confirmation', async () => {
    const calls: string[] = []
    await expect(
      runReset({
        items: ['tasks'],
        steps: steps(calls, null),
        confirmed: false as unknown as true,
        now: () => new Date(),
      }),
    ).rejects.toThrow('explicit confirmation')
    expect(calls).toEqual([])
  })
})
