/**
 * THE BOOTSTRAP WIRING ACTUALLY RUNS.
 *
 * Everything else about Phase 2 is unit-tested: the payload, the derived id,
 * the consent gate, the session boundary. None of that says the service is
 * CONSTRUCTED when the app starts — and a service nobody constructs is the
 * exact shape of the three bugs this feature's neighbourhood already shipped,
 * each behind a green suite.
 *
 * The observable proof is the first-run stamp. It is written on every launch
 * whatever the consent answer is (so that somebody who declines today and
 * agrees next year reports a real install date), which makes it the one visible
 * side effect of the service having been built and started at all.
 *
 * Nothing leaves the machine here and nothing can: the transport has no host
 * until Phase 4, and consent on a fresh profile is unanswered, which is not a
 * yes.
 */
import { test, expect } from '../fixtures/electron'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

function settingsRow(userDataDir: string, key: string): string {
  return execFileSync(
    'sqlite3',
    [join(userDataDir, 'flow.db'), `SELECT value FROM app_settings WHERE key = '${key}';`],
    { encoding: 'utf8' },
  ).trim()
}

test('starting the app stamps the install, and answers nothing on its own', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(120_000)
  // The app is up by the time the window fixture resolves; bootstrap has run.
  await expect(window.locator('body')).toBeVisible({ timeout: 60_000 })

  // ── THE SERVICE WAS BUILT AND STARTED ────────────────────────────────────
  await expect
    .poll(() => settingsRow(userDataDir, 'first_run_at'), { timeout: 30_000 })
    .toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)

  // ── AND THE GATE HELD, VISIBLY ───────────────────────────────────────────
  // The coordination id is minted LAZILY, on first read. Telemetry never read
  // it here, because consent is unanswered and the service returns before it
  // touches the store — so on this profile the id does not exist at all.
  //
  // That absence is the gate's own footprint. Written the other way round, an
  // assertion that the id EXISTS would have quietly passed the day somebody
  // moved the payload back in front of the consent check.
  expect(settingsRow(userDataDir, 'loop_owner_id')).toBe('')

  // ── AND NOBODY WAS ANSWERED FOR ──────────────────────────────────────────
  // A fresh profile has not been asked. Unanswered must read as unanswered:
  // an empty row here is the store never having been written, which is exactly
  // right, and is NOT the same as a stored 'false'.
  expect(settingsRow(userDataDir, 'telemetry_consent')).toBe('')
})

test('an answer of yes is stored as a real answer, not an absence', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(120_000)
  await expect(window.locator('body')).toBeVisible({ timeout: 60_000 })

  // Answer through the real channel the settings panel uses.
  await window.evaluate(async () =>
    (
      window as unknown as { flow: Record<string, any> }
    ).flow.settings.setTelemetryConsent({ agreed: true }),
  )
  await expect
    .poll(async () => window.evaluate(async () =>
      (window as unknown as { flow: Record<string, any> }).flow.settings.getTelemetryConsent(),
    ), { timeout: 30_000 })
    .toBe(true)

  // WHAT THIS DOES AND DOES NOT SHOW. The install report runs at START, behind
  // the consent check — and consent was given after that, so the coordination
  // id is deliberately NOT minted in this run and is not asserted here. What is
  // shown is that a yes is recorded as a stored 'true', which is the value the
  // boundary reads at send time and the privacy panel renders as sharing.
  //
  // The report itself arriving on the next launch is not observable until there
  // is somewhere for it to arrive — that is Phase 4's, along with its test.
  await window.evaluate(async () =>
    (window as unknown as { flow: Record<string, any> }).flow.threads.create({
      projectRoot: process.cwd(),
      title: 'telemetry seam',
    }),
  ).catch(() => undefined)

  // Consent is stored as a real answer, not an absence — which is the state the
  // privacy panel renders as "sharing", and the one the boundary lets through.
  expect(settingsRow(userDataDir, 'telemetry_consent')).toBe('true')
  expect(settingsRow(userDataDir, 'first_run_at')).toMatch(/^\d{4}-/)
})
