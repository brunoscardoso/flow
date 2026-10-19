import { test, expect, type Page } from '@playwright/test'
import { test as flowTest } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow `tasks` (round 19). Flow 9 has 20+ committed specs, and every
 * one of them drives a control that EXISTS: the drag, the New-task modal, the
 * import error banner, the detail modal's Open chat / brief / file link, the
 * rail action, the no-project empty state. This round asked the opposite
 * question — what are the ways OUT of a surface, and what are the ways IN to an
 * action — and found two board surfaces with exactly one route each.
 *
 * 1. The inline "Connect <provider>" form (#renderConnect, kanban-board.ts) is
 *    reached by pressing Import on an unconnected provider. It does
 *    `card.textContent = ''` and rebuilds: the source tabs, the reference field,
 *    "Start with", the skip checkbox and — critically — the modal's own Cancel
 *    button are all destroyed, leaving ONE button ("Connect"). There is no
 *    Cancel and no Back: the only exits are Escape/backdrop, which throw away
 *    the whole New-task modal. Filed as #1152.
 *
 * 2. On the board, an HTML5 mouse drag is the ONLY way to change a task's lane.
 *    Cards are `tabIndex -1` and unfocusable (Tab skips every lane), right-click
 *    opens nothing, and the detail modal — the board's ticket view — neither
 *    names the current lane nor offers a control for it (only Close / Open chat).
 *    The SAME task in the thread sidebar has a 7-item menu including "Move to
 *    Todo/Doing/Done" with the current lane marked. Filed as #1153.
 *
 * Two live controls (pass on `main`, guard the working halves) + two fix-agnostic
 * `test.fixme` tripwires (fail on `main`; un-fixme when the issues are fixed).
 *
 * NOTE: this spec never clicks "Connect". Integration credentials live in
 * `~/.flow/credentials.json` — OUTSIDE the sandboxed userData dir — so storing a
 * token here would mutate the developer's real machine state.
 */

const test_ = flowTest
test_.afterAll(() => cleanupSeeds())

/** Seed a project, open the Tasks board, and create `titles` as manual tasks. */
async function boardWith(window: Page, titles: string[]): Promise<string> {
  const root = await seedProject(window, 'flow-task-routes-')
  await activateProject(window, root)
  for (const title of titles) {
    await window.evaluate(
      async ([p, t]) =>
        await (
          window as unknown as {
            flow: { tasks: { create(r: { projectRoot: string; title: string }): Promise<unknown> } }
          }
        ).flow.tasks.create({ projectRoot: p, title: t }),
      [root, title],
    )
  }
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await expect(window.locator('.fl-board-card')).toHaveCount(titles.length)
  return root
}

/** Open the New-task modal on a fresh board and fill the Jira tab's reference. */
async function newTaskModalOnJiraTab(window: Page): Promise<void> {
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
  await window.locator('.fl-board-modal-body input[type="text"]').first().fill('MY TYPED TITLE')
  await window.locator('.fl-board-modal-tab', { hasText: 'Jira' }).click()
  await window.locator('.fl-board-modal-body input[type="text"]').first().fill('PRJ-123')
}

/** True when Jira already has stored credentials on this machine — the inline
 *  connect form is then unreachable (the import fails with a fetch error
 *  instead), so the connect-form tripwire has no precondition to assert. */
async function jiraConnected(window: Page): Promise<boolean> {
  return window.evaluate(async () =>
    (
      window as unknown as {
        flow: { integrations: { status(r: { provider: string }): Promise<{ connected: boolean }> } }
      }
    ).flow.integrations
      .status({ provider: 'jira' })
      .then((s) => s.connected)
      .catch(() => false),
  )
}

// ── LIVE CONTROL 1 ──────────────────────────────────────────────────────────
// The New-task modal the connect form REPLACES has a real Cancel, and it
// preserves the typed draft (#561). This is the convention #1152 breaks: one
// click before the connect form, an explicit non-destructive exit exists.
test_('control: the New-task modal has a Cancel that exits without losing the draft', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  await boardWith(window, [])
  await newTaskModalOnJiraTab(window)

  const cancel = window.locator('.fl-board-modal button', { hasText: 'Cancel' })
  await expect(cancel).toHaveCount(1)
  await cancel.click()
  await expect(window.locator('.fl-board-modal')).toHaveCount(0)

  // Non-destructive: reopening restores the tab and everything typed.
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
  await expect(window.locator('.fl-board-modal-tab.active')).toHaveText('Jira')
  await expect(window.locator('.fl-board-modal-body input[type="text"]').first()).toHaveValue(
    'PRJ-123',
  )

  expect(errors).toEqual([])
})

// ── LIVE CONTROL 2 ──────────────────────────────────────────────────────────
// A non-drag lane route DOES exist — in the sidebar. Its menu names every lane,
// marks the current one, and the board follows the change. This is what #1153
// says the board itself never offers.
test_('control: the sidebar task menu moves a lane, and the board follows', async ({ window }) => {
  await boardWith(window, ['Alpha task'])

  const title = window.locator('.fl-thread-sidebar').getByText('Alpha task', { exact: true })
  await expect(title).toBeVisible({ timeout: 8000 })
  await title.click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  const items = await menu.locator('.fl-thread-menu-item').allInnerTexts()
  // Every lane is offered by name, plus the rest of the task's actions.
  expect(items.join(' | ')).toMatch(/Move to Todo/)
  expect(items.join(' | ')).toMatch(/Move to Doing/)
  expect(items.join(' | ')).toMatch(/Move to Done/)
  // The current lane is marked (● prefix) — the sidebar also SHOWS the status.
  expect(items.some((item) => item.startsWith('●'))).toBe(true)

  await menu.locator('.fl-thread-menu-item', { hasText: 'Move to Doing' }).click()

  // The board reflects it: Todo empties, Doing holds the card.
  const doing = window.locator('.fl-board-column:not(.fl-board-remote)').nth(1)
  await expect(doing.locator('.fl-board-card')).toHaveCount(1, { timeout: 8000 })
  await expect(window.locator('.fl-board-column:not(.fl-board-remote)').first().locator('.fl-board-card')).toHaveCount(0)
})

// ── TRIPWIRE A (#1152) ──────────────────────────────────────────────────────
test_(
  'the inline Connect form keeps a way back to the task you were creating (#1152)',
  async ({ window }) => {
    await boardWith(window, [])
    test.skip(await jiraConnected(window), 'Jira already connected on this machine')
    await newTaskModalOnJiraTab(window)
    await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Import' }).click()
    await expect(window.locator('.fl-board-modal-title', { hasText: 'Connect Jira' })).toBeVisible({
      timeout: 10000,
    })

    // Fix-agnostic: SOMETHING must lead back without destroying the modal —
    // a Cancel/Back button, or the source tabs / reference field left in place.
    const back = window.locator('.fl-board-modal button', { hasText: /Cancel|Back|Never mind/ })
    const tabsSurvive = await window.locator('.fl-board-modal-tab').count()
    expect(
      (await back.count()) + tabsSurvive,
      'the Connect form destroys the whole New-task form and offers no Cancel/Back',
    ).toBeGreaterThan(0)

    // And that route must be non-destructive: the modal is still open after it.
    if (await back.count()) {
      await back.first().click()
      await expect(window.locator('.fl-board-modal')).toBeVisible()
      await expect(window.locator('.fl-board-modal-tab')).toHaveCount(4)
      // …with the work intact — the point of "never mind" is not starting over.
      await expect(window.locator('.fl-board-modal-tab.active')).toHaveText('Jira')
      await expect(
        window.locator('.fl-board-modal-body input[type="text"]').first(),
        'the reference typed before Import survives the trip through Connect',
      ).toHaveValue('PRJ-123')
    }
  },
)

// ── TRIPWIRE B (#1153) ──────────────────────────────────────────────────────
test_(
  'a board card offers a non-drag route to its lane (#1153)',
  async ({ window }) => {
    await boardWith(window, ['Alpha task'])
    const card = window.locator('.fl-board-card').first()

    // Route 1 — a context menu on the card (the sidebar row has one).
    await card.click({ button: 'right' })
    await window.waitForTimeout(500)
    const contextRoute = await window.locator('.fl-thread-menu, [role="menu"]').count()

    // Route 2 — the detail modal names the lane and offers a control for it.
    await card.click()
    await expect(window.locator('.fl-board-detail')).toBeVisible()
    const detail = await window.locator('.fl-board-detail').innerText()
    const modalRoute = /\b(todo|doing|done)\b/i.test(detail) ? 1 : 0
    await window.keyboard.press('Escape')

    // Route 3 — the card is keyboard-reachable at all.
    const keyboardRoute = await window.evaluate(() => {
      const el = document.querySelector('.fl-board-card') as HTMLElement | null
      return el && el.tabIndex >= 0 ? 1 : 0
    })

    expect(
      contextRoute + modalRoute + keyboardRoute,
      'the board offers NO route to a task’s lane other than a mouse drag: no card context menu, no lane in/on the detail modal, no keyboard-focusable card',
    ).toBeGreaterThan(0)
  },
)
