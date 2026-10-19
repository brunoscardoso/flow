import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * THE REMOTE COLUMN — what a connected tracker says is assigned to YOU.
 *
 * Reported twice: "im not seeing the remote column", then "im still not able to
 * see the column remote on the kanban". Both times the column was reading a
 * LOOP'S QUEUE — a repository's list somebody pointed a loop at, in a committed
 * file — so a project whose loops read a local list could never show it, however
 * many trackers were connected. The question a person is asking is "what is
 * mine", which an integration answers.
 *
 * This drives that path with no network: `integrations:assigned` and
 * `integrations:status` are answered in MAIN, which is the only side a
 * contextBridge proxy can be replaced on.
 *
 * What it guards:
 *  1. no connected tracker → no toggle and no column (an offer nothing can
 *     honour is worse than none);
 *  2. connected → a toggle appears, and the column is OFF until pressed;
 *  3. pressed → the items render verbatim, with the tracker named;
 *  4. clicking one opens the TICKET, and taking it on is a second deliberate
 *     press inside — which adds it to Todo and marks it taken on the tracker's
 *     list, because the issue really is still there;
 *  5. a failed read shows the tracker's own sentence, never an empty list.
 */
test.afterAll(() => cleanupSeeds())

const TOGGLE = '.fl-board-lane-btn[aria-label*="assigned to you"]'

/** Answer the two integration channels in main. */
async function fakeIntegrations(
  app: import('@playwright/test').ElectronApplication,
  options: { connected: string[]; ok?: boolean; reason?: string; delayMs?: number },
): Promise<void> {
  await app.evaluate(({ ipcMain }, opts) => {
    ipcMain.removeHandler('integrations:status')
    ipcMain.handle('integrations:status', (_e: unknown, req: { provider: string }) => ({
      provider: req.provider,
      connected: opts.connected.includes(req.provider),
    }))
    ipcMain.removeHandler('integrations:assigned')
    ipcMain.handle('integrations:assigned', async (_e: unknown, req: { provider: string }) => {
      if (opts.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs))
      }
      if (opts.ok === false) {
        return { ok: false, provider: req.provider, items: [], reason: opts.reason }
      }
      return {
        ok: true,
        provider: req.provider,
        items: [
          {
            key: 'acme/widgets#41',
            title: 'Crash on empty queue',
            description: 'steps',
            status: 'open',
            url: 'https://github.com/acme/widgets/issues/41',
          },
          {
            key: 'acme/widgets#42',
            title: 'Slow board render',
            description: '',
            status: 'open',
            url: 'https://github.com/acme/widgets/issues/42',
          },
        ],
        reason: null,
      }
    })
  }, options)
}

async function openBoard(window: import('@playwright/test').Page, dir: string): Promise<void> {
  await activateProject(window, dir)
  await window.locator('.fl-rail-item[aria-label="Tasks"]').click()
  await expect(window.locator('.fl-board-lane-btn[aria-label="New task"]')).toBeVisible({
    timeout: 20_000,
  })
}

test('no connected tracker means no toggle and no column', async ({ window, app }) => {
  await fakeIntegrations(app, { connected: [] })
  await openBoard(window, await seedProject(window))
  await expect(window.locator(TOGGLE)).toBeHidden()
  await expect(window.locator('.fl-board-remote')).toBeHidden()
})

test('a connected tracker offers the column, off until asked, then lists and promotes', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))
  await fakeIntegrations(app, { connected: ['github'] })
  await openBoard(window, await seedProject(window))

  // OFF UNTIL PRESSED. An extra column costs width on a board whose four lanes
  // are already tight, and a connected tracker is not consent to show it.
  const toggle = window.locator(TOGGLE)
  await expect(toggle).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-board-remote')).toBeHidden()

  await toggle.click()
  await expect(window.locator('.fl-board-remote')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-board-remote .fl-board-count')).toHaveText('2')
  await expect(window.locator('.fl-board-remote-card').first()).toContainText(
    'Crash on empty queue',
  )
  // The tracker's own key and state, verbatim.
  await expect(window.locator('.fl-board-remote-card').first()).toContainText('acme/widgets#41')

  // A CARD FIRST, THEN THE CHOICE. A press used to file the item straight into
  // Todo — a commitment made by a glance, on a title that is somebody else's
  // and often truncated. It opens the ticket instead.
  await window.locator('.fl-board-remote-card').first().click()
  const detail = window.locator('.fl-board-detail')
  await expect(detail).toBeVisible()
  await expect(detail).toContainText('Crash on empty queue')
  await expect(detail).toContainText('acme/widgets#41')
  await expect(detail).toContainText('steps')
  // Nothing has been taken on by reading it.
  await expect(window.locator('.fl-board-remote-card.is-taken')).toHaveCount(0)

  // Leaving takes nothing on either.
  await detail.locator('button', { hasText: 'Close' }).click()
  await expect(detail).toHaveCount(0)
  await expect(window.locator('.fl-board-remote-card.is-taken')).toHaveCount(0)

  // PROMOTING PUTS IT IN TODO AND LEAVES IT ON THE TRACKER'S LIST, marked —
  // the issue really is still there; this column is a copy, not an edit.
  await window.locator('.fl-board-remote-card').first().click()
  // The ticket names no project, so nothing is ticked and Add waits for one;
  // the person ticks the project it is about (remote-task-projects.spec.ts).
  await window.locator('.fl-board-detail .fl-task-project input:not(:disabled)').first().check()
  await window.locator('.fl-board-detail button', { hasText: 'Add to Todo' }).click()
  await expect(
    window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-card', {
      hasText: 'Crash on empty queue',
    }),
  ).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-board-remote-card.is-taken')).toHaveCount(1)
  // …and the card closed itself once it had done the thing.
  await expect(window.locator('.fl-board-detail')).toHaveCount(0)

  // And the answer is remembered: pressing again hides it.
  await toggle.click()
  await expect(window.locator('.fl-board-remote')).toBeHidden()

  expect(errors).toEqual([])
})

test('a failed read shows the tracker’s own sentence, never an empty list', async ({
  window,
  app,
}) => {
  await fakeIntegrations(app, {
    connected: ['github'],
    ok: false,
    reason: 'github request failed — check your token / permissions',
  })
  await openBoard(window, await seedProject(window))
  await window.locator(TOGGLE).click()
  await expect(window.locator('.fl-board-remote .fl-board-lane-banner')).toContainText(
    'check your token / permissions',
    { timeout: 15_000 },
  )
  // "You have nothing" and "nobody could ask" are different answers.
  await expect(window.locator('.fl-board-remote .fl-board-empty')).toHaveCount(0)
})

test('a read in flight shows a loader, not a blank column', async ({ window, app }) => {
  // "is taking a long time and there no loader". The read goes to somebody
  // else's server; a column that showed nothing for those seconds looked
  // broken, and its empty state — which doubles as the "nothing assigned"
  // ANSWER — was the thing being shown.
  await fakeIntegrations(app, { connected: ['github'], delayMs: 2500 })
  await openBoard(window, await seedProject(window))
  await window.locator(TOGGLE).click()

  const loading = window.locator('.fl-board-remote-loading')
  await expect(loading).toBeVisible({ timeout: 5_000 })
  await expect(loading).toContainText('Reading your list')
  // NO COUNT WHILE READING: "0" is an answer, and printing it over a list
  // nobody has finished asking for is the same lie the empty state was.
  await expect(window.locator('.fl-board-remote .fl-board-count')).toHaveText('…')
  // The pressed control says it is working too.
  await expect(window.locator(TOGGLE)).toHaveClass(/is-busy/)

  // …and it clears when the answer lands.
  await expect(window.locator('.fl-board-remote-card').first()).toBeVisible({ timeout: 15_000 })
  await expect(loading).toHaveCount(0)
  await expect(window.locator('.fl-board-remote .fl-board-count')).toHaveText('2')
  await expect(window.locator(TOGGLE)).not.toHaveClass(/is-busy/)
})

test('a spinner left spinning after a failure is worse than none', async ({ window, app }) => {
  await fakeIntegrations(app, {
    connected: ['github'],
    delayMs: 800,
    ok: false,
    reason: 'github request failed — check your token / permissions',
  })
  await openBoard(window, await seedProject(window))
  await window.locator(TOGGLE).click()
  await expect(window.locator('.fl-board-remote .fl-board-lane-banner')).toBeVisible({
    timeout: 15_000,
  })
  await expect(window.locator('.fl-board-remote-loading')).toHaveCount(0)
  await expect(window.locator(TOGGLE)).not.toHaveClass(/is-busy/)
})

test('every press paints in the same frame, including the second one', async ({ window, app }) => {
  // THE PRESS THAT PAINTED NOTHING. `#toggleRemote` used to delegate its
  // repaint to the read, and the read has four early returns — no provider, no
  // bridge, an answer already in hand — every one of which rendered nothing. So
  // switching the column back ON after switching it off changed the state and
  // not the screen, until some unrelated repaint came along. Reported as
  // "taking long to appear and there no indicator that is something loading".
  await fakeIntegrations(app, { connected: ['github'], delayMs: 1500 })
  await openBoard(window, await seedProject(window))
  const toggle = window.locator(TOGGLE)
  const column = window.locator('.fl-board-remote')

  // First press: the column and its loader, immediately.
  await toggle.click()
  await expect(column).toBeVisible({ timeout: 2_000 })
  await expect(window.locator('.fl-board-remote-loading')).toBeVisible({ timeout: 2_000 })
  await expect(window.locator('.fl-board-remote-card').first()).toBeVisible({ timeout: 15_000 })

  // Off — and gone, in the same frame.
  await toggle.click()
  await expect(column).toBeHidden({ timeout: 2_000 })

  // ON AGAIN, with an answer already in hand. The read returns early and paints
  // nothing; the press has to paint anyway, and what it shows is the answer it
  // already has rather than a spinner for a request nobody is making.
  await toggle.click()
  await expect(column).toBeVisible({ timeout: 2_000 })
  await expect(window.locator('.fl-board-remote-card').first()).toBeVisible({ timeout: 2_000 })
  await expect(window.locator('.fl-board-remote-loading')).toHaveCount(0)
})

/**
 * THE BOARD OPENS WHERE IT WAS LEFT.
 *
 * "lets add a config to remember witch one was the last remote list opened on
 * the board and always open the last one opened."
 *
 * The column always opened on whichever provider came first in the list, so
 * somebody whose work lives on one tracker re-picked it every single time the
 * board mounted. The choice is remembered per project, next to the on/off flag
 * it deliberately does NOT share a key with — hiding the column is not a change
 * of mind about whose list is yours.
 */
test('the tracker picked on the board is the one it opens on next time', async ({
  app,
  window,
}) => {
  await fakeIntegrations(app, { connected: ['github', 'jira'] })
  const dir = await seedProject(window, 'flow-ux-remotemem-')
  await openBoard(window, dir)

  await window.locator(TOGGLE).click()
  const picker = window.locator('.fl-board-remote-picker')
  // GitHub is merely first in the list; nobody chose it.
  await expect(picker).toHaveValue('github')

  await picker.selectOption('jira')
  await expect(picker).toHaveValue('jira')

  // IT REACHED STORAGE. Asserting the picker after a rail switch proves
  // nothing: the board is a singleton view, so leaving and returning never
  // remounts it and the choice survives in memory whether or not it was ever
  // written. (Verified — the first draft of this test passed against the code
  // that had no persistence at all.) The stored value is the fact.
  await expect
    .poll(() =>
      window.evaluate((root) => window.localStorage.getItem(`flow.board.remote-source:${root}`), dir),
    )
    .toBe('jira')

  // AND THE COLUMN BEING HIDDEN DOES NOT LOSE IT, which is why this is not kept
  // in the on/off key: closing the column is not a change of mind about whose
  // list is yours.
  await window.locator(TOGGLE).click()
  await expect(window.locator('.fl-board-remote-picker')).toBeHidden()
  expect(
    await window.evaluate(
      (root) => window.localStorage.getItem(`flow.board.remote-source:${root}`),
      dir,
    ),
  ).toBe('jira')
})

test('a fresh window opens the board on the tracker it was left on', async ({ app, window }) => {
  await fakeIntegrations(app, { connected: ['github', 'jira'] })
  const dir = await seedProject(window, 'flow-ux-remotemem2-')
  await openBoard(window, dir)
  await window.locator(TOGGLE).click()
  await window.locator('.fl-board-remote-picker').selectOption('jira')
  await expect(window.locator('.fl-board-remote-picker')).toHaveValue('jira')

  // THE ONLY WAY TO TEST THE RESTORE is to lose the memory the board is holding
  // — the renderer reload does that, and the stored preference is what has to
  // survive it. Without this the board would open on GitHub, which is merely
  // first in the list and which nobody chose.
  await window.reload()
  await fakeIntegrations(app, { connected: ['github', 'jira'] })
  await openBoard(window, dir)
  await window.locator(TOGGLE).click()
  await expect(window.locator('.fl-board-remote-picker')).toHaveValue('jira')
})

/**
 * CONNECTING A TRACKER WHILE THE BOARD IS OPEN REVEALS THE TOGGLE — no project
 * switch, no restart.
 *
 * Reported as "im not seeing the icon to show the remote list board on the tasks
 * anymore", with the tracker already connected. The board read connection state
 * ONLY on a project switch (`setActiveRoot` → `#loadRemoteConnections`), and
 * Settings dispatched nothing the board listened to — so a tracker connected
 * with the board already open stayed invisible until you left the project and
 * came back. Settings now dispatches `flow:integrations-changed`, which the
 * board answers by re-reading; this drives that signal (what a successful
 * setToken/clearToken emits) with no project switch in between.
 */
test('a tracker connected with the board open reveals the toggle at once', async ({
  window,
  app,
}) => {
  await fakeIntegrations(app, { connected: [] })
  await openBoard(window, await seedProject(window, 'flow-ux-remoteconnect-'))
  // Nothing connected: no toggle, exactly as the board was left.
  await expect(window.locator(TOGGLE)).toBeHidden()

  // The tracker connects (in Settings, in real life) — the status channel now
  // answers connected, and Settings fires the signal the board listens for.
  await fakeIntegrations(app, { connected: ['github'] })
  await window.evaluate(() =>
    document.dispatchEvent(new CustomEvent('flow:integrations-changed')),
  )

  // The toggle appears WITHOUT switching projects — the whole point of the fix.
  await expect(window.locator(TOGGLE)).toBeVisible({ timeout: 15_000 })
})
