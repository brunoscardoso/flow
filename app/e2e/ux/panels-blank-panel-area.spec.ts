import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * UX sweep — flow 12 (panel toggles & keyboard shortcuts), round 25.
 *
 * The shell declares a **non-empty invariant** in two places, in so many words:
 *
 *   panel-layout.ts:11  "Non-empty: hiding the editor + every panel must never
 *                        yield a blank shell — enforceNonEmpty forces the editor
 *                        back on."
 *   panel-layout.ts:109 "if a layout would render NOTHING … force the editor back
 *                        on so the shell is never blank."
 *
 * It is not enforced. `enforceNonEmpty` reasons about the MODEL flag
 * `layout.editorVisible`, while `applyLayout` separately decides whether to
 * actually PUT the editor stack in the root split (#675: an empty editor —
 * no tab, no docked terminal — collapses when no movable panel is open). Nothing
 * reconciles the two, so a layout with `editorVisible: true` and an editor that
 * renders nothing sails through the guard and the panel area goes empty.
 *
 * A default project window has **zero editor tabs**, so three ordinary put-away
 * actions reach it — each of which has a mouse control AND a shortcut:
 *
 *   1. Hide the chat          (⌘⌥C  /  the thread panel's "Hide the thread list
 *                              and the chat" —)
 *   2. Hide the docked terminal (⌃` or ⌘J  /  the terminal header's "Hide terminal")
 *   3. Hide the sidebar       (⌘B  /  the titlebar sidebar button)
 *
 * MEASURED on main (1440×900, nothing resized), root-split children after each:
 *   default        [sidebar 306 | chat 306 | editor-stack 778 (terminal 778×421)]
 *   after ⌘⌥C + ⌃` [sidebar 1392]                     ← editor stack already gone
 *   after ⌘B       [empty editor stack 1392×842]      ← innerText '', zero pageerrors
 *
 * …and the same three keys on a PROJECT-LESS first-run window wipe the
 * "Open a project to start — ＋ Open Project… in the titlebar" onboarding line
 * with nothing in its place.
 *
 * The layout is persisted per project (`flow.shell.layout.v5`:
 * `{conversation.visible:false, terminalVisible:false, sidebarOpen:false,
 *   editorVisible:true}`) and restored verbatim, so the empty window is what the
 * app comes back to on the next launch.
 *
 * Filed as **#1538**. The two fixme tripwires below pin it — both verified RED
 * against current main before being re-fixmed, so neither can pass vacuously.
 * The live guards pin what any fix must
 * PRESERVE: the three put-away controls must keep working individually (a fix
 * that just makes ⌘B/⌃` inert would be #1351 symptom A all over again), and the
 * rail must keep being a way back out.
 */

const SCREENS = 'e2e/ux/__screens'
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const activitySidebar = '.fl-activity-sidebar'
const railItem = (id: string): string => `.fl-activity-bar .fl-rail-item[data-rail-item="${id}"]`

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => !/Canceled/.test(m))
}

/** What the panel area (the root split) actually renders. */
async function panelArea(win: Page): Promise<{ kids: string[]; text: string }> {
  return win.evaluate(() => {
    const root = document.querySelector('#fl-split-root') as HTMLElement | null
    return {
      kids: root
        ? [...root.children].map((child) => {
            const el = child as HTMLElement
            const rect = el.getBoundingClientRect()
            return `${el.className || el.tagName}:${Math.round(rect.width)}x${Math.round(rect.height)}`
          })
        : [],
      text: root ? root.innerText.trim() : 'NO ROOT SPLIT',
    }
  })
}

/** Put the chat, the docked terminal and the sidebar away — the three ordinary
 *  "I want more room" actions, by their advertised shortcuts. */
async function putEverythingAway(win: Page): Promise<void> {
  await win.keyboard.press('ControlOrMeta+Alt+KeyC') // hide Chat
  await expect(win.locator(sel.conversation)).toHaveCount(0)
  await win.keyboard.press('Control+Backquote') // hide the docked terminal
  await expect(win.locator(sel.terminalPanel)).toHaveCount(0)
  await win.keyboard.press('ControlOrMeta+KeyB') // hide the sidebar
  await expect(win.locator(activitySidebar)).toHaveCount(0)
}

test.describe('flow 12 — the non-empty invariant vs. an empty editor', () => {
  test.afterAll(() => cleanupSeeds())

  // LIVE GUARD. Each put-away control does its own job, and the panel area still
  // renders after the first two. A fix for the blank window must not be "make
  // one of these inert" — that is exactly the dead key #1351 was filed for.
  test('control: chat and terminal go away individually, the sidebar still renders', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(String(event)))

    const root = await seedProject(window)
    await activateProject(window, root)

    await expect(window.locator(activitySidebar)).toBeVisible()
    await expect(window.locator(sel.conversation)).toBeVisible()
    await expect(window.locator(sel.terminalPanel)).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(window.locator(sel.conversation)).toHaveCount(0)
    await expect(window.locator(activitySidebar)).toBeVisible()

    await window.keyboard.press('Control+Backquote')
    await expect(window.locator(sel.terminalPanel)).toHaveCount(0)
    // Two of three away: the sidebar is still on screen and still says something.
    await expect(window.locator(activitySidebar)).toBeVisible()
    expect((await panelArea(window)).text).not.toEqual('')

    expect(appErrors(errors)).toEqual([])
  })

  // LIVE (#1538, fixed). The invariant panel-layout.ts states twice, now enforced
  // on what the editor stack RENDERS rather than on the editorVisible flag: the
  // shell paints its empty-panel watermark as the last-resort root child.
  test(
    'three put-away actions must not leave a blank panel area',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (event) => errors.push(String(event)))

      const root = await seedProject(window)
      await activateProject(window, root)
      await expect(window.locator(sel.terminalPanel)).toBeVisible()

      await putEverythingAway(window)

      const after = await panelArea(window)
      await window.screenshot({ path: `${SCREENS}/panels-blank-panel-area.png` })
      console.log('blank panel area →', JSON.stringify(after))

      // Expected: the shell is never blank. Today: kids = ['FL-SPLIT:1392x842']
      // (an empty editor stack) and text = ''.
      expect(after.text).not.toEqual('')
      expect(appErrors(errors)).toEqual([])
    },
  )

  // LIVE GUARD. However the blank state is prevented, there must remain a way
  // back. The rail used to be that affordance, but it moved INTO the sidebar
  // (4f1ae0e7 — it is the sidebar's first line), so it leaves with it; the
  // titlebar's sidebar toggle is now the recovery path a user has to find.
  test('the titlebar toggle is still a way out of a fully put-away layout', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(String(event)))

    const root = await seedProject(window)
    await activateProject(window, root)
    await expect(window.locator(sel.terminalPanel)).toBeVisible()

    await putEverythingAway(window)

    // The rail went away with the sidebar; the titlebar toggle brings both back.
    await expect(window.locator(railItem('threads'))).toHaveCount(0)
    await window.locator(sel.sidebarToggle).click()
    await expect(window.locator(railItem('threads'))).toBeVisible()
    await expect(window.locator(activitySidebar)).toBeVisible()
    expect((await panelArea(window)).text).not.toEqual('')

    expect(appErrors(errors)).toEqual([])
  })

  // LIVE (#1538, fixed) — the sharp edge: the put-away layout is still persisted
  // per project and restored verbatim, so the guard has to hold on the RESTORE
  // path too, not just on the keystroke that got there.
  test(
    'a fully put-away layout must not be what the app relaunches into',
    async ({ app, window, userDataDir }) => {
      const root = await seedProject(window)
      await activateProject(window, root)
      await expect(window.locator(sel.terminalPanel)).toBeVisible()

      await putEverythingAway(window)
      // Precondition: the layout that USED to be blank is the one being saved.
      expect((await panelArea(window)).text).not.toEqual('')

      await app.close()

      const relaunched: ElectronApplication = await electron.launch({
        args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
      })
      try {
        const win2 = await relaunched.firstWindow()
        await win2.waitForLoadState('domcontentloaded')
        // No account is connected, so the first-run wizard opens on every boot.
        const wizard = win2.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
        if (await wizard.count()) {
          const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
          if (await skip.count()) await skip.first().click()
          else await win2.keyboard.press('Escape')
        }
        await win2.waitForTimeout(3000)
        const after = await panelArea(win2)
        await win2.screenshot({ path: `${SCREENS}/panels-blank-panel-area-relaunch.png` })
        console.log('relaunched into →', JSON.stringify(after))

        // Expected: a relaunch never opens onto an empty panel area.
        expect(after.text).not.toEqual('')
      } finally {
        await relaunched.close().catch(() => undefined)
      }
    },
  )
})
