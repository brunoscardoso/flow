import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from '../ux/fixtures/seed'

/**
 * The grouped Launchpad tab — the REAL path. A temp project gets a Launchpad
 * with two trivial running steps (shell loops that print a line a second),
 * started through the app's own Run. The steps share ONE tab; inside it the
 * sub-bar shows All and each step; Side by side holds one live xterm per step;
 * One log labels every line with its step; picking a step shows its terminal
 * alone.
 */

const SHOTS = process.env['FLOW_LAUNCHPAD_SHOTS'] ?? join(tmpdir(), 'flow-launchpad-shots')

test.afterAll(() => cleanupSeeds())

interface RunBridge {
  flow: {
    run: {
      save(request: unknown): Promise<{ ok: boolean; reason?: string }>
      start(request: unknown): Promise<unknown>
      stop(request: unknown): Promise<unknown>
    }
  }
}

async function setUpAndRun(window: Page, root: string): Promise<void> {
  const saved = await window.evaluate(async (rootPath) => {
    const bridge = window as unknown as RunBridge
    const scope = { rootPath, threadId: null }
    const loop = (word: string): string => `while true; do echo ${word}-tick; sleep 1; done`
    const answer = await bridge.flow.run.save({
      scope,
      change: {
        layer: 'shared',
        steps: [
          { id: 'alpha', name: 'alpha', command: loop('alpha'), start: 'now' },
          { id: 'beta', name: 'beta', command: loop('beta'), start: 'now' },
        ],
      },
    })
    if (answer.ok) await bridge.flow.run.start({ scope })
    return answer
  }, root)
  expect(saved.ok).toBe(true)
}

test('the Launchpad steps share one tab: Side by side, One log and one step alone', async ({ window }) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-e2e-launchpad-', undefined, { onboarded: true })
  await activateProject(window, root)
  await expect(window.locator('.fl-term-root')).toBeVisible({ timeout: 30_000 })
  await setUpAndRun(window, root)

  // ── One group tab with a dot per step, labelled with what is running ─────
  const groupTab = window.locator('.fl-term-tabs .tab[data-id^="launchpad-group:"]')
  await expect(groupTab).toBeVisible({ timeout: 30_000 })
  await expect(groupTab.locator('.label')).toHaveText('2 running', { timeout: 30_000 })
  await expect(groupTab.locator('.count')).toHaveCount(0)
  await expect(groupTab.locator('.status-dot')).toHaveCount(2)
  // …and the steps have no tabs of their own (positive asserted first, #28).
  await expect(window.locator('.fl-term-tabs .tab', { hasText: 'alpha' })).toHaveCount(0)
  await expect(window.locator('.fl-term-tabs .tab', { hasText: 'beta' })).toHaveCount(0)

  // ── The sub-bar, and Side by side by default ─────────────────────────────
  await groupTab.click()
  const bar = window.locator('.fl-lp-bar')
  await expect(bar).toBeVisible()
  await expect(bar.locator('.fl-lp-pick')).toHaveText(['All', 'alpha', 'beta'])
  await expect(bar.locator('.fl-lp-pick[data-step="all"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(bar.locator('[data-layout="tiles"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(bar.locator('.fl-lp-seg [data-action="restart-all"]')).toHaveText('Restart all')
  await expect(bar.locator('.fl-lp-seg [data-action="stop-all"]')).toHaveText('Stop all')

  const panes = window.locator('.fl-lp-tiles:not([hidden]) .fl-lp-pane:not([hidden])')
  await expect(panes).toHaveCount(2)
  await expect(panes.nth(0).locator('.xterm')).toBeVisible({ timeout: 15_000 })
  await expect(panes.nth(1).locator('.xterm')).toBeVisible()
  await expect(panes.nth(0).locator('.fl-lp-head b')).toHaveText('alpha')
  // The actions are icons, named for screen readers and on hover.
  await expect(panes.nth(0).locator('[data-action="restart"]')).toHaveAttribute('aria-label', 'Restart')
  await expect(panes.nth(0).locator('[data-action="restart"] fl-icon')).toHaveAttribute('name', 'refresh')
  await expect(panes.nth(0).locator('[data-action="restart"]')).toHaveText('')
  await expect(panes.nth(0).locator('[data-action="stop"]')).toBeEnabled()
  await expect(panes.nth(0).locator('.xterm-rows')).toContainText('alpha-tick', { timeout: 15_000 })
  await expect(panes.nth(1).locator('.xterm-rows')).toContainText('beta-tick', { timeout: 15_000 })
  mkdirSync(SHOTS, { recursive: true })
  await window.locator('.fl-term-root').screenshot({ path: join(SHOTS, 'launchpad-side-by-side.png') })

  // ── One log: every line labelled with its step ───────────────────────────
  await bar.locator('[data-layout="log"]').click()
  const log = window.locator('.fl-lp-log')
  await expect(log).toBeVisible()
  await expect(panes).toHaveCount(0)
  await expect(log.locator('.fl-lp-line', { hasText: 'alpha-tick' }).first().locator('.fl-lp-tag')).toHaveText('alpha', {
    timeout: 15_000,
  })
  await expect(log.locator('.fl-lp-line', { hasText: 'beta-tick' }).first().locator('.fl-lp-tag')).toHaveText('beta')
  // Live: more lines arrive while it is on screen.
  const before = await log.locator('.fl-lp-line').count()
  await expect.poll(async () => log.locator('.fl-lp-line').count(), { timeout: 10_000 }).toBeGreaterThan(before)
  await window.locator('.fl-term-root').screenshot({ path: join(SHOTS, 'launchpad-one-log.png') })

  // ── One step alone: its own terminal, typeable ───────────────────────────
  await bar.locator('.fl-lp-pick', { hasText: 'beta' }).click()
  await expect(bar.locator('.fl-lp-pick', { hasText: 'beta' })).toHaveAttribute('aria-pressed', 'true')
  await expect(bar.locator('[data-layout]')).toHaveCount(0)
  const single = window.locator('.fl-lp-tiles.single .fl-lp-pane:not([hidden])')
  await expect(single).toHaveCount(1)
  await expect(single.locator('.fl-lp-head b')).toHaveText('beta')
  await expect(single.locator('.xterm-rows')).toContainText('beta-tick')
  await expect(single.locator('[data-action="open"]')).toHaveCount(0)

  // Back to All: the layout was remembered (One log), and the xterms survived
  // the trip (still holding their earlier output — never re-created).
  await bar.locator('.fl-lp-pick[data-step="all"]').click()
  await expect(log).toBeVisible()
  await bar.locator('[data-layout="tiles"]').click()
  await expect(panes).toHaveCount(2)
  await expect(panes.nth(0).locator('.xterm-rows')).toContainText('alpha-tick')

  // ── The caret menu: jump to a step, then split into separate tabs ────────
  await groupTab.locator('.caret').click()
  const menu = window.locator('.fl-term-root-menu')
  await expect(menu.locator('.fl-term-root-item')).toHaveText([/All steps/, /alpha\s*running/, /beta\s*running/, /Show as separate tabs/])
  await menu.locator('.fl-term-root-item', { hasText: 'Show as separate tabs' }).click()
  await expect(window.locator('.fl-term-tabs .tab', { hasText: 'alpha' })).toHaveCount(1)
  await expect(window.locator('.fl-term-tabs .tab', { hasText: 'beta' })).toHaveCount(1)
  await expect(groupTab).toHaveCount(0)
  // …and back.
  await window.locator('.fl-term-tabs .tab', { hasText: 'alpha' }).locator('.caret').click()
  await menu.locator('.fl-term-root-item', { hasText: 'Group run step tabs' }).click()
  await expect(groupTab).toBeVisible()

  await window.evaluate(async (rootPath) => {
    await (window as unknown as RunBridge).flow.run.stop({ scope: { rootPath, threadId: null } })
  }, root)
})
