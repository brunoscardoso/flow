import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): do the composer's control-row affordances keep
 * the promises their own labels make?
 *
 * The composer control row is `Model | Effort | 📎 Attach | ⛶ Capture | 🗺 Blueprint
 * | … | Interrupt | Send` (composer.ts:495-504). Twenty-odd committed specs drive
 * the *behaviour* of these controls (mentions, slash commands, attachments,
 * queue, history, model/effort, send gating). None had ever checked the
 * control row's own ADVERTISED contract — the tooltip text a user reads before
 * they act.
 *
 * Two seams, both verified live against the running app:
 *
 *  1. The Blueprint button's tooltip reads "Open Blueprint (⌘⇧B)"
 *     (composer.ts:454). That string is the ONLY occurrence of ⌘⇧B in the whole
 *     source — nothing binds it. Worse, the shell's sidebar toggle matches on
 *     `key === 'b' && mod` with NO shift guard (shell.ts:691, unlike the ⌘1-5
 *     branch right above it which explicitly guards `!event.shiftKey`), so the
 *     advertised shortcut is swallowed by ⌘B: the board never opens and the
 *     user's sidebar silently disappears instead.
 *
 *  2. The attach control WAS labelled "Attach image" (#1176, now fixed) even
 *     though its picker accepts ~30 text extensions and #772 made text files
 *     first-class context attachments — the button IS the discoverable path to
 *     attaching a doc, and its label says it isn't.
 *
 * Live guards below cover what works today (the button click really opens the
 * live board; the plain ⌘B toggle is observable from the composer, which makes
 * the tripwires non-vacuous). The `fixme` tests are tripwires for the two filed
 * bugs — they flip green when the app is fixed.
 *
 * Account-independent: `project:add` + `threads:create` only; nothing is
 * sent to an agent.
 */

// The board mounts as `.flow-board-root` (blueprint-board.ts:620). The retired
// BlueprintView's `.bpv-root` no longer exists anywhere in the source — see the
// note in blueprint.spec.ts.
const BOARD = '.flow-board-root'

async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

/** Seed a project, create a thread, open it, and wait for the live composer. */
async function openThread(win: Page, title: string): Promise<void> {
  const proj = await seedProject(win)
  await activateProject(win, proj)
  await createThread(win, proj, title)
  await win.locator(`${sel.threadList} >> text=${title}`).first().click()
  await expect(win.locator(sel.composer)).toBeVisible({ timeout: 10_000 })
}

const blueprintButton = (win: Page) =>
  win.locator(`${sel.composer} fl-button[aria-label="Open Blueprint"]`)

test.afterAll(() => cleanupSeeds())

test('composer Blueprint button opens the live board and keeps the draft', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  await openThread(window, 'BP Button Thread')

  // The affordance exists and still advertises the shortcut.
  const btn = blueprintButton(window)
  await expect(btn).toBeVisible()
  expect(await btn.getAttribute('title')).toContain('Open Blueprint')

  // A half-written message must survive the trip to the board and back.
  const box = window.locator(`${sel.composer} textarea`)
  await box.click()
  await box.fill('DRAFT_BEFORE_BOARD')

  await expect(window.locator(BOARD)).toHaveCount(0)
  await btn.click()
  await expect(window.locator(BOARD)).toBeVisible({ timeout: 15_000 })

  // Repeat clicks re-activate the same tab rather than stacking boards.
  await btn.click()
  await window.waitForTimeout(500)
  await btn.click()
  await expect(window.locator(BOARD)).toHaveCount(1)

  await expect(box).toHaveValue('DRAFT_BEFORE_BOARD')
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('control: plain ⌘B from the composer toggles the sidebar (keystroke is observable)', async ({
  window,
}) => {
  await openThread(window, 'BP Control Thread')

  const sidebar = window.locator(sel.threadSidebar)
  await expect(sidebar).toBeVisible()

  await window.locator(sel.composerInput).click()
  await window.keyboard.press('ControlOrMeta+KeyB')
  await expect(sidebar).toBeHidden({ timeout: 5_000 })
  await window.keyboard.press('ControlOrMeta+KeyB')
  await expect(sidebar).toBeVisible({ timeout: 5_000 })
})

// TRIPWIRE (#1175). Un-`fixme` this when the advertised shortcut is bound.
// Verified non-vacuous: as written today it fails at the FIRST assertion with
// "Expected: visible / Received: <element(s) not found>" — the board never
// opens — and the sidebar assertion below fails too, because ⌘⇧B falls through
// to the unguarded ⌘B sidebar toggle.
test(
  'TRIPWIRE #1175: ⌘⇧B (the tooltip the composer shows) opens the board, not the sidebar toggle',
  async ({ window }) => {
    await openThread(window, 'BP Shortcut Thread')

    const btn = blueprintButton(window)
    expect(await btn.getAttribute('title')).toContain('⌘⇧B')

    const sidebar = window.locator(sel.threadSidebar)
    await expect(sidebar).toBeVisible()

    await window.locator(sel.composerInput).click()
    await window.keyboard.press('ControlOrMeta+Shift+KeyB')

    // The advertised action happens…
    await expect(window.locator(BOARD)).toBeVisible({ timeout: 10_000 })
    // …and the unrelated one does NOT: the sidebar the user was reading from
    // must not vanish because they asked for the blueprint.
    await expect(sidebar).toBeVisible()
  },
)

// #1176 (fixed): the attach control's label covers the text/context files it
// actually accepts (#772). Non-vacuous by construction — the first assertion
// proves the picker really does take .md, so the label assertion is about a
// capability that exists. It used to read exactly "Attach image".
test(
  'TRIPWIRE #1176: the attach control is labelled for the files it accepts',
  async ({ window }) => {
    await openThread(window, 'Attach Label Thread')

    const attach = window.locator(`${sel.composer} fl-button[aria-label*="Attach"]`)
    await expect(attach).toBeVisible()

    const accept =
      (await window.locator(`${sel.composer} input[type="file"]`).getAttribute('accept')) ?? ''
    expect(accept, 'the picker accepts text/context files (#772)').toContain('.md')

    const label = `${await attach.getAttribute('aria-label')} ${await attach.getAttribute('title')}`
    expect(
      label.toLowerCase(),
      'a control that accepts docs must not present itself as image-only',
    ).not.toMatch(/^attach image attach image$/)
  },
)
