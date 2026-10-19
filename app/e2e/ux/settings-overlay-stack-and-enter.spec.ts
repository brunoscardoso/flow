import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * UX sweep — flow 11 (Settings / accounts / flow-settings overlays), round 23.
 *
 * Flow 11 owns 23 committed specs. Every one of them drives ONE overlay: its
 * controls, its writes, its keyboard ownership (#1198/#1199), its focus trap.
 * Nothing had ever asked the two questions this spec asks:
 *
 *   1. what happens when a SECOND member of the settings family is opened while
 *      one is already up (the family is Settings / Flow settings / Integrations,
 *      all `.fl-settings-overlay`, all `z-index: 2000`, stacked by DOM order), and
 *   2. what does Enter do in the family's text fields?
 *
 * Both answers were wrong when this probe was filed; #1395 and #1396 have since
 * been FIXED (ce745f7c, PR #1399): the family now registers with an overlay
 * stack — opening one member CLOSES the others rather than stacking underneath
 * — and Enter in the family's text fields does what the button does. The former
 * `test.fixme` tripwires below are live guards now, and the one guard written
 * against the pre-fix stacking behaviour ("a stacked pair…") is restated
 * against the stack's actual contract (#1554 — it was red on main because the
 * pair it drove no longer exists).
 *
 * Live guards:
 *   - with nothing open, the app-menu Settings… (⌘, — #1159) raises exactly one
 *     Settings overlay and it is the one the user sees;
 *   - #1395: ⌘, over an open sibling yields ONE dialog, painted on top — and
 *     dismissing it returns the window, no surprise second modal;
 *   - the stack force-closing a sibling does not break it: reopened, the Flow
 *     panel's Autopilot toggle still writes, and the status bar follows;
 *   - #1396: Enter in the "Account name" field and the Integrations Connect
 *     forms does what the button does (feedback included);
 *   - #834's blank-name feedback on the "Add account" BUTTON still fires;
 *   - the app's other name-a-thing field (the file-tree name bar behind ⌘⇧P →
 *     "New file") commits on Enter — the sibling-parity control for #1396.
 */

const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/**
 * Fire the REAL application-menu item behind ⌘, (`Settings…`, menu.ts #1159).
 * Native key equivalents are not deliverable through Playwright, and the
 * handler resolves `BrowserWindow.getFocusedWindow()`, which is null for a
 * harness window that never takes OS focus; in that case the handler's own
 * message is sent to the app window, so the renderer sees exactly what a real
 * ⌘, produces.
 */
async function fireSettingsMenuItem(app: ElectronApplication): Promise<void> {
  const outcome = await app.evaluate(({ Menu, BrowserWindow }) => {
    let item: Electron.MenuItem | undefined
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const found = (top.submenu?.items ?? []).find((s) => s.label === 'Settings…')
      if (found) {
        item = found
        break
      }
    }
    if (!item) return 'missing'
    const win = BrowserWindow.getAllWindows()[0]
    win?.focus()
    const osFocused = BrowserWindow.getFocusedWindow() !== null
    item.click(undefined as never, win as never, undefined as never)
    if (!osFocused) win?.webContents.send('settings:open', null)
    return item.accelerator ?? 'no-accelerator'
  })
  // The item must exist and still be the ⌘, binding, or this probe proves nothing.
  expect(outcome).toBe('CmdOrCtrl+,')
}

/** Titles of every OPEN overlay in the settings family, in DOM (stacking) order. */
function openOverlayTitles(win: Page): Promise<string[]> {
  return win.evaluate(() =>
    [...document.querySelectorAll('.fl-settings-overlay')]
      .filter((o) => !(o as HTMLElement).hidden)
      .map((o) => o.querySelector('.fl-settings-header span')?.textContent ?? '?')
  )
}

/** Which overlay actually OWNS the pixels where `title`'s panel header sits. */
function overlayPaintedAt(win: Page, title: string): Promise<string> {
  return win.evaluate((wanted) => {
    const target = [...document.querySelectorAll('.fl-settings-overlay')].find(
      (o) =>
        !(o as HTMLElement).hidden &&
        o.querySelector('.fl-settings-header span')?.textContent === wanted
    )
    const panel = target?.querySelector('.fl-settings-panel')
    if (!panel) return 'not-open'
    const rect = panel.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 24)
    const overlay = hit?.closest('.fl-settings-overlay')
    return overlay?.querySelector('.fl-settings-header span')?.textContent ?? 'outside-the-family'
  }, title)
}

/** Open the per-project Flow settings overlay the way the sidebar ⋯ menu does. */
async function openFlowSettings(win: Page, root: string): Promise<void> {
  await win.evaluate(
    (p) =>
      document.dispatchEvent(
        new CustomEvent('flow:open-flow-settings', { detail: { rootPath: p } })
      ),
    root
  )
  await expect(win.locator(ANY_OVERLAY)).toHaveCount(1)
}

/** Open the app Settings overlay the way the status-bar control does. */
/** Open the Settings PAGE — not a dialog since it moved into the editor area. */
async function openSettings(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  await expect(win.locator(SETTINGS_PAGE)).toBeVisible({ timeout: 15_000 })
}

const SETTINGS_PAGE = '.fl-settings-page'

test.afterEach(() => cleanupSeeds())

test.describe('flow 11 — the settings family: stacking and Enter', () => {
  test('⌘, raises Settings as a page, and raises no dialog at all', async ({ app, window }) => {
    // THE STACK PROBLEM CANNOT HAPPEN TO IT ANY MORE, which is the honest thing
    // for this case to assert now. It used to ask whether ⌘, raised exactly one
    // DIALOG and whether that dialog was the one painted on top — a question
    // about three overlays sharing a class and a z-index. Settings left that
    // family: it is a tab in the editor area, so it cannot be drawn under a
    // sibling, and Escape does not close it.
    //
    // The stack still matters for the two that ARE dialogs, and the case below
    // this one still drives them.
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const root = await seedProject(window)
    await activateProject(window, root)

    await fireSettingsMenuItem(app)
    await expect(window.locator('.fl-settings-page')).toBeVisible()
    await expect(window.locator(ANY_OVERLAY)).toHaveCount(0)

    // A tab does not answer Escape — it is not covering anything.
    await window.keyboard.press('Escape')
    await expect(window.locator('.fl-settings-page')).toBeVisible()
    expect(appErrors(errors)).toEqual([])
  })

  test('the stack force-closing a sibling does not break it — reopened, its writes still land', async ({
    app,
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const root = await seedProject(window)
    await activateProject(window, root)
    // #1554: this guard used to drive a STACKED pair (pre-#1395 behaviour) and
    // click the Flow panel while Settings sat invisibly underneath. The stack
    // (ce745f7c) closes the sibling instead, so that pair no longer exists —
    // what is worth pinning now is that being force-closed leaves the sibling
    // healthy.
    await openFlowSettings(window, root)
    await fireSettingsMenuItem(app)
    // Settings is a PAGE, so the force-close leaves no dialog at all — the
    // sibling went and nothing took its place on screen.
    await expect(window.locator(SETTINGS_PAGE)).toBeVisible()
    expect(await openOverlayTitles(window)).toEqual([])

    // Reopened after the force-close, the Flow panel stays live: its Autopilot
    // toggle writes flow/.flowconfig.
    //
    // THE FILE, NOT THE STATUS BAR. Autopilot left the status bar — it is a
    // control in the composer now, where the turn it affects is being typed —
    // so the bar stopped carrying the word and this assertion had been red
    // since. The config file is the store either way, and asserting it is what
    // the case was always really about: the write still lands.
    await openFlowSettings(window, root)
    await window
      .locator('.fl-fs-row', { hasText: 'Autopilot' })
      .locator('.fl-fs-toggle')
      .first()
      .click()
    // A missing file reads as '' so the poll keeps waiting: expect.poll gives up
    // at once on a thrown error, and the toggle's write lands asynchronously, so
    // a bare readFileSync failed with ENOENT whenever the first read won the race.
    const flowconfig = join(root, 'flow', '.flowconfig')
    await expect
      .poll(() => (existsSync(flowconfig) ? readFileSync(flowconfig, 'utf-8') : ''), {
        timeout: 10_000,
      })
      .toContain('autopilot: true')

    expect(appErrors(errors)).toEqual([])
  })

  test('the "Add account" BUTTON still refuses a blank name out loud (#834)', async ({
    window,
  }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await openSettings(window)

    const overlay = window.locator(SETTINGS_PAGE)
    await overlay.locator('button', { hasText: 'Add account' }).first().click()
    await expect(overlay.locator('.fl-settings-add .fl-settings-add-status')).toContainText(
      'Enter an account name first.'
    )
  })

  test('control: the app’s other name-a-thing field commits on Enter', async ({ window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)

    await window.keyboard.press('ControlOrMeta+Shift+p')
    await window.locator('.fl-palette-panel .fl-palette-input').fill('>new file')
    await expect(window.locator('.fl-palette-row', { hasText: 'New file' })).toBeVisible()
    await window.keyboard.press('Enter')

    const nameBar = window.locator('.fl-tree-menu input')
    await expect(nameBar).toBeVisible({ timeout: 10_000 })
    await nameBar.fill('enter-control.ts')
    await nameBar.press('Enter')

    await expect(() => {
      expect(existsSync(join(root, 'enter-control.ts'))).toBe(true)
    }).toPass({ timeout: 8_000 })
  })

  // ── Live guards for the two fixed defects — #1395 and #1396 (ce745f7c) ─────

  test(
    '#1395: opening Settings closes the dialog that was over it, rather than hiding under it',
    async ({ app, window }) => {
      const root = await seedProject(window)
      await activateProject(window, root)
      await openFlowSettings(window, root)

      await fireSettingsMenuItem(app)
      await window.waitForTimeout(600)
      await window.screenshot({ path: `${SCREENS}/settings-stack-after-cmd-comma.png` })

      // THE DEFECT CANNOT RECUR IN ITS ORIGINAL FORM — Settings is a tab, so it
      // has no rect to be painted under. What #1395's rule still buys is this:
      // a dialog left open over the page it is about would cover the tabs the
      // person is now navigating, so opening Settings closes it.
      await expect(window.locator(SETTINGS_PAGE)).toBeVisible()
      expect(await openOverlayTitles(window)).toEqual([])
    }
  )

  test(
    '#1396: Enter in the "Account name" field must do what the button does',
    async ({ window }) => {
      const root = await seedProject(window)
      await activateProject(window, root)
      await openSettings(window)

      const overlay = window.locator(SETTINGS_PAGE)
      const nameInput = overlay.locator('input[placeholder^="Account name"]')
      await nameInput.click()
      // The BLANK case is asserted deliberately: it is the one branch of the
      // add handler that reaches feedback without starting a real interactive
      // `claude auth login`. If Enter reached the handler at all, #834's hint
      // would appear — exactly as it does for the button one test up.
      await nameInput.press('Enter')
      await window.waitForTimeout(800)
      await window.screenshot({ path: `${SCREENS}/settings-enter-account-name.png` })

      await expect(overlay.locator('.fl-settings-add .fl-settings-add-status')).toContainText(
        'Enter an account name first.'
      )
    }
  )

  test(
    '#1396 (integrations): Enter in a Connect form must do what Connect does',
    async ({ window }) => {
      const root = await seedProject(window)
      await activateProject(window, root)
      await window.evaluate(() =>
        document.dispatchEvent(new CustomEvent('flow:open-integrations'))
      )
      // Integrations is a group of the Settings PAGE now, not an overlay; the
      // Connect form and its Enter handling are unchanged.
      const overlay = window.locator('.fl-settings-page')
      await expect(overlay).toBeVisible({ timeout: 15_000 })
      await expect(window.locator('.fl-settings-tab.active')).toHaveText('Integrations')

      // An INCOMPLETE Jira form: the only branch of Connect that gives feedback
      // without sending a credential anywhere.
      const site = overlay.locator('input[placeholder="your-team.atlassian.net"]')
      await site.click()
      await site.fill('qa-probe.atlassian.net')
      await site.press('Enter')
      await window.waitForTimeout(800)

      // Pre-fix: nothing at all. Enter now reaches Connect's own handler, so
      // the incomplete form gets the button's feedback — "Fill every field".
      await expect(overlay.locator('button', { hasText: 'Fill every field' })).toHaveCount(1)
    }
  )
})
