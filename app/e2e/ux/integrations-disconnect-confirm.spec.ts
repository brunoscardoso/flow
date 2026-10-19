/**
 * Regression probe for #1505 — Disconnect destroyed a stored credential on ONE
 * unconfirmed click, then said nothing at all.
 *
 * The settings family already settled this question: #216 gated "Remove account"
 * behind an inline `Remove <label>? [Cancel] [Remove]` because the thing being
 * destroyed cannot be handed back. An API token is strictly worse — a Claude
 * login can be re-run from the button beside it, while GitHub and Atlassian show
 * a PAT exactly once at creation. The field is write-only by design, so the panel
 * can neither show what it is about to destroy nor give it back.
 *
 * ── Why this spec boots its own app ──────────────────────────────────────────
 *
 * Integration secrets live at `~/.flow/credentials.json`, which is OUTSIDE the
 * `--user-data-dir` every other spec is sandboxed by. A spec that connects a
 * provider through the shared fixture would write the real developer's
 * credential file — and this one deletes what it finds. So it launches with
 * `HOME` pointed at a throwaway directory (Node's `homedir()` follows `$HOME` on
 * POSIX, which is what `DEFAULT_CREDENTIALS_PATH` is built from) and asserts
 * against that copy.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { dismissOnboarding } from '../fixtures/electron'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
// INTEGRATIONS IS A SETTINGS GROUP NOW, not an overlay: it used to be a modal
// reached from Settings by pressing a button — a door inside a door — and the
// provider sections render on the page itself. The name is kept so the walk
// below reads unchanged; what it names is the group that is showing.
const OVERLAY = '.fl-settings-group:not([hidden])'
const JIRA_EMAIL = 'me@acme.example'
const JIRA_TOKEN = 'super-secret-api-token'

const dirs: string[] = []

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'flow-int-home-'))
  dirs.push(home)
  return home
}

function credentialsPath(home: string): string {
  return join(home, '.flow', 'credentials.json')
}

/** Pre-store a Jira credential, so the panel opens already Connected. */
function seedJira(home: string): void {
  const file = credentialsPath(home)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      services: {
        jira: { site: 'acme.atlassian.net', email: JIRA_EMAIL, apiToken: JIRA_TOKEN },
      },
    }),
    { mode: 0o600 },
  )
}

function storedJira(home: string): unknown {
  try {
    return (JSON.parse(readFileSync(credentialsPath(home), 'utf8')) as {
      services?: Record<string, unknown>
    }).services?.['jira']
  } catch {
    return undefined
  }
}

async function boot(home: string): Promise<{ app: ElectronApplication; window: Page }> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-int-udd-'))
  dirs.push(userDataDir)
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      HOME: home, // the whole point — never touch the real credentials file
      USERPROFILE: home,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
    },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await dismissOnboarding(window)
  return { app, window }
}

/** Open Integrations without needing a project: the overlay listens for this. */
async function openIntegrations(window: Page): Promise<void> {
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-integrations'))
  })
  await expect(window.locator(OVERLAY)).toBeVisible({ timeout: 30_000 })
}

function jiraSection(window: Page) {
  return window.locator(`${OVERLAY} .fl-settings-section`).filter({ hasText: 'Jira' })
}

test.afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test.describe('Integrations — Disconnect (#1505)', () => {
  test('one click asks instead of destroying, and Cancel keeps the token', async () => {
    test.setTimeout(180_000)
    const home = makeHome()
    seedJira(home)
    let app: ElectronApplication | null = null
    try {
      const session = await boot(home)
      app = session.app
      const { window } = session
      await openIntegrations(window)

      const jira = jiraSection(window)
      await expect(jira.locator('.fl-int-pill')).toContainText('Connected', { timeout: 30_000 })

      // ONE click. Before the fix this was already the end of the token.
      await jira.locator('.fl-int-disconnect').click()

      const confirm = jira.locator('.fl-int-confirm')
      await expect(confirm).toBeVisible({ timeout: 10_000 })
      // It names what is going: "Disconnect Jira (me@acme.example)?"
      await expect(confirm).toContainText(JIRA_EMAIL)
      // …and nothing has been destroyed yet.
      expect(storedJira(home)).toMatchObject({ apiToken: JIRA_TOKEN })

      await confirm.locator('button', { hasText: 'Cancel' }).click()
      await expect(jira.locator('.fl-int-disconnect')).toBeVisible()
      expect(storedJira(home)).toMatchObject({ apiToken: JIRA_TOKEN })
      await expect(jira.locator('.fl-int-pill')).toContainText('Connected')
    } finally {
      if (app) await app.close().catch(() => undefined)
    }
  })

  test('confirming disconnects, clears the stored token, and says so', async () => {
    test.setTimeout(180_000)
    const home = makeHome()
    seedJira(home)
    let app: ElectronApplication | null = null
    try {
      const session = await boot(home)
      app = session.app
      const { window } = session
      await openIntegrations(window)

      const jira = jiraSection(window)
      await expect(jira.locator('.fl-int-pill')).toContainText('Connected', { timeout: 30_000 })

      await jira.locator('.fl-int-disconnect').click()
      await jira.locator('.fl-int-confirm button', { hasText: 'Disconnect' }).click()

      await expect(jira.locator('.fl-int-pill')).toContainText('Not connected', { timeout: 15_000 })
      await expect
        .poll(() => storedJira(home), { timeout: 15_000 })
        .toBeUndefined()
      // The destruction is announced — the only previous signal was the pill
      // going grey, which is what a plain refresh looks like too.
      await expect(window.locator('.fl-flow-toast')).toContainText(/disconnected/i, {
        timeout: 15_000,
      })
    } finally {
      if (app) await app.close().catch(() => undefined)
    }
  })
})
