/**
 * UX-sweep regression probe — flow 11 (Settings), round 26: the Integrations
 * overlay's CREDENTIAL-TRUTH contract.
 *
 * 25 prior flow-11 rounds drove this overlay's render lifecycle (#1068 double
 * paint, #1069 pending pill), its failure toasts (#217), its CLI-derived
 * Disconnect note (#419) and its Enter handling (#1396) — always with the
 * happy/empty path. Nobody ever asked the two questions a user asks of a
 * credential form:
 *
 *   1. "It says Connected — is it?"   The panel never checks. `setToken` only
 *      refuses an EMPTY string; `status()` then reports `connected: true`
 *      because a string is present. Any nonsense — a Jira `site` of
 *      "hello world not a site", an `email` of "nonsense-not-an-email", a
 *      one-character API token — flips the pill green and prints the bogus
 *      value as the identity hint. The sibling section one overlay away (app
 *      Settings → Claude accounts) was fixed to do exactly the opposite: it
 *      probes live and says "○ signed out — sessions will fail until you
 *      re-login" (#965). — #1503
 *
 *   2. "Disconnect — is that reversible?"  It deletes the stored secret with
 *      no confirm and no undo, while its sibling destructive control in the
 *      settings family (account Remove) is confirm-gated precisely because the
 *      thing it destroys can't be handed back (#216). — #1505
 *
 * SANDBOXING: integration tokens live at `~/.flow/credentials.json`, which is
 * OUTSIDE `--user-data-dir` — a spec that connects a provider writes the real
 * user's file. Every launch here overrides `HOME` to a throwaway dir, so the
 * credential store is per-test.
 */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { test } from '../fixtures/electron'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SCREENS = 'e2e/ux/__screens'
/** gh/az CLI probes take ~5s; give the overlay room to settle. */
const PROBE_SETTLE_MS = 11_000

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

interface Ctx {
  app: ElectronApplication
  win: Page
  home: string
  errors: string[]
}

function launch(userDataDir: string, home: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      HOME: home, // keeps ~/.flow/credentials.json out of the real home dir
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
    },
  })
}

/** Boot the app with a seeded project and open the Integrations overlay. */
async function boot(): Promise<Ctx> {
  const home = mkdtempSync(join(tmpdir(), 'flow-int-home-'))
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-int-udd-'))
  const repo = mkdtempSync(join(tmpdir(), 'flow-int-repo-'))
  execFileSync('git', ['init', '-q'], { cwd: repo })
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')

  const app = await launch(userDataDir, home)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))
  await win.waitForTimeout(2500)
  await win.evaluate(() => {
    const skip = Array.from(document.querySelectorAll('button')).find((b) =>
      /skip|close|✕/i.test(b.textContent || ''),
    )
    skip?.click()
  })
  await win.waitForTimeout(500)
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: {
          project: {
            add(r: { path: string }): Promise<unknown>
            setActive(r: { rootPath: string }): Promise<unknown>
          }
        }
      }
    ).flow.project.add({ path: p })
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, repo)
  await win.waitForTimeout(2500)
  // The first-selection flow-settings onboarding overlay auto-opens — dismiss it.
  await win.keyboard.press('Escape')
  await win.waitForTimeout(800)
  return { app, win, home, errors }
}

async function openIntegrations(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))
  await expect(win.locator('.fl-settings-page')).toBeVisible()
  await win.waitForTimeout(PROBE_SETTLE_MS)
}

/** Quitting can hang (#1284) — never let teardown eat the test's budget. */
async function closeApp(app: ElectronApplication): Promise<void> {
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((r) => setTimeout(r, 20_000)),
  ])
}

/** One provider card, by its visible title. */
const card = (win: Page, title: string) =>
  // A provider section is one with a heading — the group's own settings section
  // (closing the remote ticket on Done) mentions the trackers too.
  win.locator('.fl-settings-group:not([hidden]) .fl-settings-section:has(.fl-settings-heading)', {
    hasText: title,
  })

/** The status pill text of a provider card. */
const pill = (win: Page, title: string) => card(win, title).locator('.fl-int-pill')

/** Everything the overlay is currently saying, whitespace-collapsed. */
const overlayText = (win: Page) =>
  win.evaluate(
    () =>
      (
        document.querySelector('.fl-settings-page') as HTMLElement
      )?.innerText?.replace(/\s+/g, ' ') ?? '',
  )

/** Visible toasts (the app's only out-of-band feedback channel). */
const toasts = (win: Page) =>
  win.evaluate(() =>
    Array.from(document.querySelectorAll('.fl-flow-toast')).map((t) => (t.textContent || '').trim()),
  )

/** The on-disk credential store for a sandboxed HOME. */
function credentials(home: string): Record<string, unknown> {
  const path = join(home, '.flow', 'credentials.json')
  if (!existsSync(path)) return {}
  return (JSON.parse(readFileSync(path, 'utf8')) as { services?: Record<string, unknown> })
    .services ?? {}
}

// ── Green guard: the overlay's shape is correct ────────────────────────────
test('Integrations overlay renders one settled card per provider', async () => {
  const { app, win, errors } = await boot()
  try {
    await openIntegrations(win)
    for (const title of ['GitHub', 'Jira', 'Azure DevOps']) {
      await expect(card(win, title)).toHaveCount(1)
      // Every probe has settled — no card is still stuck on the pending pill.
      await expect(pill(win, title)).not.toHaveText('Checking…')
    }
    // Jira is token-only, so with no HOME credentials it must read as absent.
    await expect(pill(win, 'Jira')).toHaveText('Not connected')
    await expect(card(win, 'Jira').locator('.fl-int-save')).toHaveText('Connect')
    expect(errors).toEqual([])
  } finally {
    await closeApp(app)
  }
})

// ── #1503: "Connected" is asserted, never verified ─────────────────────────
test('a nonsense Jira credential is not reported as Connected (#1503)', async () => {
  const { app, win, home, errors } = await boot()
  try {
    await openIntegrations(win)
    await expect(pill(win, 'Jira')).toHaveText('Not connected')

    const jira = card(win, 'Jira')
    await jira.locator('input').nth(0).fill('hello world not a site')
    await jira.locator('input').nth(1).fill('nonsense-not-an-email')
    await jira.locator('input').nth(2).fill('x')
    await jira.locator('.fl-int-save').click()
    await win.waitForTimeout(PROBE_SETTLE_MS)

    await win.screenshot({ path: `${SCREENS}/int-connected-lie.png` })
    console.log('[#1503] overlay says: ' + (await overlayText(win)))
    console.log('[#1503] toasts: ' + JSON.stringify(await toasts(win)))
    console.log('[#1503] stored: ' + JSON.stringify(credentials(home)))

    // A credential that cannot possibly work must not be presented as a working
    // connection — either refuse the obviously-malformed site/email, or verify
    // the credential and say so (the Claude-accounts contract, #965).
    await expect(pill(win, 'Jira')).not.toHaveText(/^Connected/)
    expect(errors).toEqual([])
  } finally {
    await closeApp(app)
  }
})

// ── #1505: Disconnect is a one-click unconfirmed credential delete ─────────
test.fixme('Disconnect confirms before destroying a stored token (#1505)', async () => {
  const { app, win, home, errors } = await boot()
  try {
    await openIntegrations(win)
    // Connect Jira so there is a stored secret to destroy.
    const jira = card(win, 'Jira')
    await jira.locator('input').nth(0).fill('acme.atlassian.net')
    await jira.locator('input').nth(1).fill('me@acme.example')
    await jira.locator('input').nth(2).fill('super-secret-api-token')
    await jira.locator('.fl-int-save').click()
    await win.waitForTimeout(PROBE_SETTLE_MS)
    expect(credentials(home)['jira']).toBeTruthy()

    const dialogs: string[] = []
    win.on('dialog', (d) => {
      dialogs.push(d.message())
      void d.dismiss()
    })
    await card(win, 'Jira').locator('.fl-int-disconnect').click()
    await win.waitForTimeout(1200)
    await win.screenshot({ path: `${SCREENS}/int-disconnect-no-confirm.png` })
    console.log('[#1505] dialogs: ' + JSON.stringify(dialogs))
    console.log('[#1505] overlay: ' + (await overlayText(win)))
    console.log('[#1505] stored after one click: ' + JSON.stringify(credentials(home)))

    // The secret must survive an unconfirmed single click — the settings
    // family's own contract for a destructive, unrecoverable action (#216).
    expect(credentials(home)['jira']).toBeTruthy()
    expect(errors).toEqual([])
  } finally {
    await closeApp(app)
  }
})
