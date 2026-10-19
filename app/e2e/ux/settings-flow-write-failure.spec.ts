import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import { chmodSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 19.
 *
 * The flow-settings overlay is the project's config surface: 13 live-edited
 * controls, no Save button, every change written straight through
 * `flow:setConfig`. `FlowSettingsView.#change` updates `#values`, PATCHES the
 * controls optimistically, and then fires the write with
 * `.catch((error) => console.error(...))` — a rejection reaches nothing the user
 * can see. Every sibling surface already learned this lesson (#216 remove
 * account, #217 integration tokens, #226 project→account assign, #229 the
 * onboarding wizard's autopilot write, #307 model routing); the panel's OWN
 * account select reverts and says "Couldn't change the account — try again."
 * The 13 config controls right below it were left behind.
 *
 * Covered here:
 *  - live guard 1: a write that SUCCEEDS is truthful — the guardrail cascade
 *    (Auto-create PR ⇒ push + commit) lands on disk and survives a reopen.
 *  - live guard 2: a write preserves the rest of `.flowconfig` — comments,
 *    blank lines and keys the overlay does not render (webhook_url, dotted
 *    engine/command keys) all survive byte-for-byte.
 *  - guard A (#1158, fixed): a REJECTED write says something.
 *  - guard B (#1158, fixed): a REJECTED write does not leave the control showing
 *    a value that is not on disk — one click on "Auto-create PR" used to leave
 *    three toggles asserting state that never reached `.flowconfig`.
 *
 * The rejection is produced the way a real user hits it — `flow/.flowconfig`
 * not writable (read-only checkout, a vault symlink whose target lost write
 * permission, an unmounted share). Permissions are restored in `afterAll` so
 * the temp dirs can be cleaned up.
 */

const OVERLAY = '.fl-settings-overlay:not([hidden])'

const RICH_CONFIG = `# Flow config for the payments service
# keep autopilot OFF here — prod repo
autopilot: false

commit: true
push: false

# webhooks (Slack #eng-flow)
webhook_url: https://hooks.slack.com/services/T000/B000/secret
commands.lint: npm run lint -- --max-warnings 0
max_verify_retries: 3
`

const PLAIN_CONFIG = 'autopilot: false\ncommit: false\npush: false\npr: false\nbranch: keepme\nmax_verify_retries: 2\n'

/** Write `flow/.flowconfig` into a repo BEFORE it is added as a root (the main
 *  process snapshots it at watch-start — see seed.ts `prepare`). */
function writeConfig(config: string): (dir: string) => void {
  return (dir: string) => {
    mkdirSync(join(dir, 'flow'), { recursive: true })
    writeFileSync(join(dir, 'flow', '.flowconfig'), config)
  }
}

const configPath = (root: string): string => join(root, 'flow', '.flowconfig')
const readConfig = (root: string): string => readFileSync(configPath(root), 'utf8')

/** Roots whose config was locked — restored in afterAll so cleanup can rm them. */
const locked: string[] = []

function lockConfig(root: string): void {
  locked.push(root)
  chmodSync(configPath(root), 0o444)
  chmodSync(join(root, 'flow'), 0o555)
}

async function seedAndOpen(win: Page, config: string): Promise<string> {
  const root = await seedProject(win, 'flow-ux-fscfg-', writeConfig(config))
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, root)
  // The per-project onboarding auto-open (and the provisioner's own config
  // write) settle first; dismiss whatever is up, then open deliberately.
  await win.waitForTimeout(1200)
  if (await win.locator(OVERLAY).count()) {
    await win.keyboard.press('Escape')
    await expect(win.locator(OVERLAY)).toHaveCount(0)
  }
  return root
}

async function openFlowSettings(win: Page, root: string): Promise<void> {
  await win.evaluate(
    (r) =>
      document.dispatchEvent(
        new CustomEvent('flow:open-flow-settings', { detail: { rootPath: r } }),
      ),
    root,
  )
  await expect(win.locator(OVERLAY)).toBeVisible()
  await expect(win.locator(`${OVERLAY} .fl-fs-row`).first()).toBeVisible()
}

const row = (win: Page, label: string) => win.locator(`${OVERLAY} .fl-fs-row`, { hasText: label })
const toggle = (win: Page, label: string) => row(win, label).locator('.fl-fs-toggle').first()

/*
 * GIT & PR LIVE ON THE SETTINGS PAGE NOW. The three cascade toggles (commit /
 * push / PR) moved off the per-project overlay onto the unified Settings page's
 * Conversation files group, for the ACTIVE project (88edc2a8). The page writes
 * them through the same `flow:setConfig` with the same optimistic-then-rollback
 * rule (#1158), so the two cascade cases below drive them there.
 */
const GIT_PR_GROUP = '.fl-settings-page .fl-settings-group:not([hidden])'
const gitPrToggle = (win: Page, label: string) =>
  win.locator(`${GIT_PR_GROUP} .fl-fs-row`, { hasText: label }).locator('.fl-fs-toggle').first()

async function openGitPr(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator('.fl-settings-page')).toBeVisible({ timeout: 15_000 })
  await win.locator('.fl-settings-tab', { hasText: 'Conversation files' }).click()
  await expect(gitPrToggle(win, 'Auto-create PR')).toBeVisible()
}

async function closeSettingsPage(win: Page): Promise<void> {
  await win.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close').first().click()
  await expect(win.locator('.fl-settings-page')).toBeHidden()
}

async function toggleStates(win: Page): Promise<Record<string, string | null>> {
  return {
    commit: await gitPrToggle(win, 'Auto-commit per task').getAttribute('aria-checked'),
    push: await gitPrToggle(win, 'Auto-push when done').getAttribute('aria-checked'),
    pr: await gitPrToggle(win, 'Auto-create PR').getAttribute('aria-checked'),
  }
}

test.afterAll(() => {
  for (const root of locked) {
    try {
      chmodSync(join(root, 'flow'), 0o755)
      chmodSync(configPath(root), 0o644)
    } catch {
      // Best-effort — cleanupSeeds retries the removal anyway.
    }
  }
  locked.length = 0
  cleanupSeeds()
})

test('flow settings: a successful write is truthful on disk and after a reopen', async ({ window }) => {
  const root = await seedAndOpen(window, PLAIN_CONFIG)
  await openGitPr(window)

  // The page paints first and patches once `flow:state` answers — wait for it.
  await expect.poll(() => toggleStates(window)).toEqual({ commit: 'false', push: 'false', pr: 'false' })

  // "Auto-create PR" carries a guardrail cascade: it implies push + commit.
  await gitPrToggle(window, 'Auto-create PR').click()
  await expect(gitPrToggle(window, 'Auto-create PR')).toHaveAttribute('aria-checked', 'true')
  await expect(gitPrToggle(window, 'Auto-push when done')).toHaveAttribute('aria-checked', 'true')
  await expect(gitPrToggle(window, 'Auto-commit per task')).toHaveAttribute('aria-checked', 'true')

  // …and all three reach disk, so the optimistic UI told the truth.
  await expect.poll(() => readConfig(root)).toContain('pr: true')
  const onDisk = readConfig(root)
  expect(onDisk).toContain('push: true')
  expect(onDisk).toContain('commit: true')

  // Reopening reads from disk — the page must still agree with it.
  await closeSettingsPage(window)
  await openGitPr(window)
  await expect.poll(() => toggleStates(window)).toEqual({ commit: 'true', push: 'true', pr: 'true' })
  await window.screenshot({ path: 'e2e/ux/__screens/settings-flow-write-ok.png' })
})

test('flow settings: a write preserves comments and keys the overlay never renders', async ({
  window,
}) => {
  const root = await seedAndOpen(window, RICH_CONFIG)
  await openFlowSettings(window, root)

  await toggle(window, 'Phase isolation').click()
  await expect.poll(() => readConfig(root)).toContain('phase_isolation:')

  const after = readConfig(root)
  expect(after).toContain('# keep autopilot OFF here — prod repo')
  expect(after).toContain('# webhooks (Slack #eng-flow)')
  expect(after).toContain('webhook_url: https://hooks.slack.com/services/T000/B000/secret')
  expect(after).toContain('commands.lint: npm run lint -- --max-warnings 0')
  expect(after).toContain('max_verify_retries: 3')
})

test(
  'flow settings: a rejected config write tells the user something',
  async ({ window }) => {
    const root = await seedAndOpen(window, PLAIN_CONFIG)
    lockConfig(root)
    await openFlowSettings(window, root)

    await toggle(window, 'Autopilot').click()
    await window.waitForTimeout(1500)

    const feedback = await window.evaluate(() => {
      const overlay = document.querySelector('.fl-settings-overlay:not([hidden])') as HTMLElement | null
      const inPanel = overlay
        ? Array.from(overlay.querySelectorAll('.error, [class*="error"], .fl-settings-hint'))
            .map((node) => (node as HTMLElement).innerText.trim())
            .filter((text) => /couldn.t|failed|error|not saved|permission/i.test(text))
        : []
      const toasts = Array.from(document.querySelectorAll('[class*="toast"], [class*="notification"]'))
        .map((node) => (node as HTMLElement).innerText.trim())
        .filter((text) => text.length > 0)
      return [...inPanel, ...toasts]
    })
    await window.screenshot({ path: 'e2e/ux/__screens/settings-flow-write-failed.png' })

    // The panel's OWN account select does this (#226); the config controls do not.
    expect(
      feedback,
      'a rejected flow:setConfig produced no user-visible message anywhere',
    ).not.toHaveLength(0)
  },
)

test(
  'flow settings: a rejected config write does not leave the control showing an unsaved value',
  async ({ window }) => {
    const root = await seedAndOpen(window, PLAIN_CONFIG)
    const before = readConfig(root)
    lockConfig(root)
    await openGitPr(window)
    await expect.poll(() => toggleStates(window)).toEqual({ commit: 'false', push: 'false', pr: 'false' })

    await gitPrToggle(window, 'Auto-create PR').click()
    await window.waitForTimeout(1500)

    // Nothing was written…
    expect(readConfig(root)).toBe(before)
    // …so nothing may claim it was (pre-#1158 all three read "true").
    expect(await toggleStates(window)).toEqual({ commit: 'false', push: 'false', pr: 'false' })
  },
)
