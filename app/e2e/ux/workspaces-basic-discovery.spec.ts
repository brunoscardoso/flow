/**
 * A conversation starts only on a project Flow has learned (decision
 * 2026-10-06).
 *
 * A project added to a Workspace gets its basic discovery on its own — no
 * "Run a basic discovery?" card — and the FIRST message of a thread on a
 * project that has not finished it is stored and held: the thread says
 * "Learning backend first — your message will be sent when it's done", no
 * session starts, and the message goes out the moment the discovery ends.
 *
 * STOOD IN FOR, in main, through `e2e-seams.ts` (honoured only under
 * FLOW_E2E=1): the agent runtime (records each session, answers one line) and
 * the basic discovery itself (waits until the spec ends it). Nothing here
 * spawns an agent CLI or reaches a model.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import {
  addProjects,
  basicDiscoveryRuns,
  closeProjectOnboarding,
  finishBasicDiscovery,
  installBasicDiscoveryStandIn,
  installStandIns,
  lazySandbox,
  recordedStarts,
} from '../fixtures/workspaces'

const SCREENS = process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')

async function sendFromComposer(page: Page, text: string): Promise<void> {
  await page.locator('.fl-composer-input').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: join(SCREENS, `basic-discovery-${name}.png`) })
}

test.describe('basic discovery before a conversation', () => {
  const seeded = lazySandbox('basic-discovery', (sandbox) => ({ backend: sandbox.seedRepo('backend') }))
  test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })
  test.afterAll(async () => seeded.cleanup())

  test('the first message waits for the project to be learned, then goes out by itself', async ({ app, window }) => {
    const { backend } = seeded.get()
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(error.message))
    await installStandIns(app, { gateAnswer: '{"primary": "backend", "attached": []}' })
    await installBasicDiscoveryStandIn(app)

    await addProjects(window, [backend])
    await closeProjectOnboarding(window, 3_000)

    // Joining the Workspace started the project's basic discovery on its own…
    await expect.poll(async () => (await basicDiscoveryRuns(app)).length, { timeout: 90_000 }).toBe(1)
    const [sweptRoot] = await basicDiscoveryRuns(app)
    expect(resolve(sweptRoot ?? '')).toBe(resolve(backend))
    // …and asked nobody first.
    await expect(window.locator('.fl-learn-card')).toHaveCount(0)

    const thread = await window.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
      async (root) => (window as unknown as { flow: any }).flow.threads.create({ projectRoot: root, title: 'Orders endpoint' }) as Promise<{ id: string }>,
      backend,
    )
    await window.locator('.fl-thread-sidebar').getByText('Orders endpoint', { exact: true }).click()

    await sendFromComposer(window, 'Add a POST /api/orders endpoint.')
    // Held: the thread says why, and no session has started.
    const line = window.locator('.fl-conv-activity-label')
    await expect(line).toHaveText("Learning backend first — your message will be sent when it's done", { timeout: 30_000 })
    await expect(window.locator('.fl-conv-activity')).toBeVisible()
    await screenshot(window, 'held')
    await window.waitForTimeout(1_000)
    expect(await recordedStarts(app)).toEqual([])
    // The message itself is in the conversation already.
    await expect(window.locator('.fl-conv-entry-user', { hasText: 'Add a POST /api/orders endpoint.' })).toHaveCount(1)
    // Still one sweep: the send joined the one running.
    expect(await basicDiscoveryRuns(app)).toHaveLength(1)

    // The discovery ends: the message goes out on its own.
    expect(await finishBasicDiscovery(app, sweptRoot as string, { kind: 'done', learned: 2, failed: 0 })).toBe(true)
    await expect.poll(async () => (await recordedStarts(app)).length, { timeout: 30_000 }).toBe(1)
    const [start] = await recordedStarts(app)
    expect(start?.threadId).toBe(thread.id)
    expect(start?.prompt).toContain('Add a POST /api/orders endpoint.')
    await expect(line).not.toHaveText(/Learning backend first/, { timeout: 15_000 })
    await expect(window.locator('.fl-conv-entry-assistant', { hasText: 'Stand-in answer' })).toBeVisible({ timeout: 30_000 })

    // The completion is recorded with the project's knowledge: no second sweep.
    const record = join(backend, 'flow', 'brain', '.structure', 'basic-discovery.jsonl')
    expect(existsSync(record)).toBe(true)
    expect(readFileSync(record, 'utf-8')).toContain('"learned":2')
    expect(await basicDiscoveryRuns(app)).toHaveLength(1)
    await screenshot(window, 'delivered')
    expect(errors).toEqual([])
  })
})
