/**
 * THE QUESTION ARRIVES ON THE THIRD DAY, AND NOT BEFORE.
 *
 * The wizard no longer asks, so if this prompt does not appear the app silently
 * never asks at all — and "nothing is collected" would stop being a choice
 * somebody made and become an accident. That is the failure this guards.
 *
 * Days of use are seeded directly in the store, because the alternative is a
 * test that waits three days.
 */
import { test, expect } from '../fixtures/electron'
import { _electron as electron } from '@playwright/test'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const PROMPT = '.fl-consent-overlay'
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

function sql(userDataDir: string, statement: string): string {
  return execFileSync('sqlite3', [join(userDataDir, 'flow.db'), statement], {
    encoding: 'utf8',
  }).trim()
}

/** Pretend this installation has been used on `days` distinct days. */
function seedUseDays(userDataDir: string, days: number, asks = 0): void {
  sql(
    userDataDir,
    `insert or replace into app_settings (key, value) values ('use_days','${days}');` +
      `insert or replace into app_settings (key, value) values ('last_use_day','1999-01-01');` +
      `insert or replace into app_settings (key, value) values ('telemetry_consent_asks','${asks}');`,
  )
}

test('is not raised in the first two days of use', async ({ window, userDataDir }) => {
  test.setTimeout(120_000)
  await expect(window.locator('body')).toBeVisible({ timeout: 60_000 })
  // Day one, straight after a fresh start.
  await window.waitForTimeout(4000)
  await expect(window.locator(PROMPT)).toHaveCount(0)
  // …and the wizard did not ask either, which is the other half of "never
  // asked twice": nothing anywhere has raised it yet.
  expect(sql(userDataDir, "select value from app_settings where key='telemetry_consent'")).toBe('')
})

/**
 * THE DIALOG ITSELF, through a real startup.
 *
 * Seeds the days of use into the store the first app created, closes it (Flow
 * holds a single-instance lock), then launches a SECOND app against the same
 * directory — which is exactly what the third day
 * looks like from the app's point of view. A test that called the view function
 * directly would prove the dialog renders and nothing about whether anything
 * ever calls it, which is the failure that matters here.
 */
test('is raised on a real third-day startup, with both answers offered', async ({
  userDataDir,
  window,
  app,
}) => {
  test.setTimeout(180_000)
  await expect(window.locator('body')).toBeVisible({ timeout: 60_000 })
  seedUseDays(userDataDir, 3)

  // ONE INSTANCE AT A TIME. Flow holds a single-instance lock, so a second app
  // against the same directory quits on sight — the first has to go first.
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 20_000)),
  ])

  const second = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      FLOW_E2E_BACKGROUND: '1',
      DISABLE_AUTO_UPDATE: 'true',
    },
  })
  try {
    const win = await second.firstWindow()
    const prompt = win.locator(PROMPT)
    await expect(prompt).toBeVisible({ timeout: 60_000 })

    // BOTH ANSWERS, AS BUTTONS, weighted the same — a consent obtained by
    // making one answer easier is not worth having.
    await expect(prompt.locator('fl-button', { hasText: "Don't share" })).toBeVisible()
    await expect(prompt.locator('fl-button', { hasText: 'Share usage data' })).toBeVisible()
    // Nothing is pre-selected: there is no checkbox to leave ticked.
    await expect(prompt.locator('input[type="checkbox"]')).toHaveCount(0)

    // WHAT IS SENT is on the screen where the decision is made, derived from
    // the allowlist — including the field sign-in will add.
    await expect(prompt).toContainText('About this installation')
    await expect(prompt).toContainText('Never sent')
    await expect(prompt).toContainText('once you sign in')

    // DECLINING IS ONE CLICK and is recorded as a real answer.
    await prompt.locator('fl-button', { hasText: "Don't share" }).click()
    await expect(prompt).toHaveCount(0)
    await expect
      .poll(() => sql(userDataDir, "select value from app_settings where key='telemetry_consent'"), {
        timeout: 30_000,
      })
      .toBe('false')
  } finally {
    await Promise.race([
      second.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 15_000)),
    ])
  }
})

test('the decision itself moves with days of use and asks', async ({ window, userDataDir }) => {
  test.setTimeout(120_000)
  await expect(window.locator('body')).toBeVisible({ timeout: 60_000 })
  const ask = async () =>
    window.evaluate(async () =>
      (window as unknown as { flow: Record<string, any> }).flow.settings.shouldAskTelemetry(),
    )

  seedUseDays(userDataDir, 2, 0)
  expect(await ask()).toBe(false)

  seedUseDays(userDataDir, 3, 0)
  expect(await ask()).toBe(true)

  // Dismissed on day three: it does not come back the same day.
  seedUseDays(userDataDir, 3, 1)
  expect(await ask()).toBe(false)

  seedUseDays(userDataDir, 7, 1)
  expect(await ask()).toBe(true)

  // Three asks and then never — the question lives in Settings after that.
  seedUseDays(userDataDir, 10_000, 3)
  expect(await ask()).toBe(false)

  // ANSWERED MEANS ANSWERED, whichever way.
  sql(userDataDir, "insert or replace into app_settings (key,value) values ('telemetry_consent','false')")
  seedUseDays(userDataDir, 3, 0)
  sql(userDataDir, "insert or replace into app_settings (key,value) values ('telemetry_consent','false')")
  expect(await ask()).toBe(false)
})
