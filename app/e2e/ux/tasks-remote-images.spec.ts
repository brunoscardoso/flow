import { test, expect, type Page } from '../fixtures/electron'
import type { ElectronApplication } from '@playwright/test'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * THE SCREENSHOTS ON A TICKET.
 *
 * "can we add support to see screenshoots on the task item? from remote, the
 * items that has shared imgs we should show on the component."
 *
 * A bug report is mostly its picture, and the card showed none — not because
 * nobody drew them, but because it could not: the page's policy is
 * `img-src 'self' data:`, and a tracker's attachment sits behind the issue's
 * own credential, which the renderer deliberately never holds. Main fetches
 * each one and answers with a data URI.
 *
 * THE GUARD THAT MATTERS IS THE FIRST ONE. The strip loads three pictures at a
 * time and skipped any tile whose card was not in the document — an
 * optimisation that is always true at the moment the batch is claimed, because
 * a ticket dialog is BUILT before it is MOUNTED. Against a real four-screenshot
 * Jira ticket, exactly three tiles sat on "Loading…" for ever and the fourth
 * appeared normally. Every unit test passed. So this spec uses MORE pictures
 * than the concurrency limit and requires all of them, which is the only shape
 * that can fail.
 *
 * No network: `integrations:status`, `:assigned` and `:imageData` are all
 * answered in MAIN, the one side a contextBridge proxy can be replaced on.
 */
test.afterAll(() => cleanupSeeds())

const TOGGLE = '.fl-board-lane-btn[aria-label*="assigned to you"]'

/** A 1×1 PNG — the smallest thing that is really an image. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** More pictures than the strip fetches at once — see the header. */
const IMAGE_NAMES = ['one.png', 'two.png', 'three.png', 'four.png', 'gone.png']

async function fakeIntegrations(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, { names, pixel }) => {
    ipcMain.removeHandler('integrations:status')
    ipcMain.handle('integrations:status', (_e: unknown, req: { provider: string }) => ({
      provider: req.provider,
      connected: req.provider === 'jira',
    }))
    ipcMain.removeHandler('integrations:assigned')
    ipcMain.handle('integrations:assigned', (_e: unknown, req: { provider: string }) => ({
      ok: true,
      provider: req.provider,
      items: [
        {
          key: 'PRJ-7',
          title: 'Skills tab shows nothing',
          description: 'Steps to reproduce…',
          status: 'Backlog',
          url: 'https://acme.atlassian.net/browse/PRJ-7',
          images: names.map((name: string) => ({
            url: `https://acme.atlassian.net/rest/api/3/attachment/content/${name}`,
            name,
          })),
        },
      ],
      reason: null,
    }))
    ipcMain.removeHandler('integrations:imageData')
    ipcMain.handle('integrations:imageData', (_e: unknown, req: { url: string }) =>
      // ONE OF THEM FAILS, on purpose: a picture that cannot be fetched is the
      // ordinary case (an expired token, a deleted attachment) and it must read
      // as a sentence rather than as a broken frame.
      req.url.endsWith('gone.png')
        ? { ok: false, dataUri: null, bytes: 0, reason: 'the attachment is gone' }
        : { ok: true, dataUri: pixel, bytes: 68, reason: null },
    )
  }, { names: IMAGE_NAMES, pixel: PIXEL })
}

/** Open the board, reveal the Remote column, and open its one ticket. */
async function openRemoteTicket(window: Page, dir: string): Promise<void> {
  await activateProject(window, dir)
  await window.locator('.fl-rail-item[aria-label="Tasks"]').click()
  await expect(window.locator('.fl-board-lane-btn[aria-label="New task"]')).toBeVisible({
    timeout: 20_000,
  })
  await window.locator(TOGGLE).click()
  await window.locator('.fl-board-remote .fl-board-card', { hasText: 'PRJ-7' }).click()
  await expect(window.locator('.fl-ticket')).toBeVisible()
}

test('every screenshot on a ticket loads — not just the ones past the first batch', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))
  await fakeIntegrations(app)
  await openRemoteTicket(window, await seedProject(window, 'flow-ux-ticketimg-'))

  const tiles = window.locator('.fl-ticket-image')
  await expect(tiles).toHaveCount(IMAGE_NAMES.length)
  // The section counts what it holds.
  await expect(window.locator('.fl-ticket-label', { hasText: 'Images' })).toHaveText(
    `Images (${String(IMAGE_NAMES.length)})`,
  )

  // THE REGRESSION. Four of the five must arrive; the tile that stays behind is
  // the one main refused, and it stays behind with a reason.
  await expect(tiles.locator('img')).toHaveCount(IMAGE_NAMES.length - 1, { timeout: 15_000 })
  await expect(window.locator('.fl-ticket-image.is-loading')).toHaveCount(0)
  for (const name of IMAGE_NAMES.slice(0, -1)) {
    await expect(
      window.locator(`.fl-ticket-image[aria-label="Open ${name} full size"] img`),
    ).toBeVisible()
  }

  // A FAILURE IS A SENTENCE, not a grey rectangle — and it still names which
  // picture, which on a five-screenshot ticket is the whole of the answer.
  const failed = window.locator('.fl-ticket-image.is-failed')
  await expect(failed).toHaveCount(1)
  await expect(failed.locator('.fl-ticket-image-why')).toHaveText('the attachment is gone')
  await expect(failed).toBeDisabled()
  await expect(failed).toHaveAttribute('title', 'gone.png — the attachment is gone')

  expect(errors, errors.join(', ')).toEqual([])
})

test('a screenshot opens full size, and Escape closes the picture — not the ticket', async ({
  app,
  window,
}) => {
  await fakeIntegrations(app)
  await openRemoteTicket(window, await seedProject(window, 'flow-ux-ticketview-'))

  const ready = window.locator('.fl-ticket-image[aria-label="Open one.png full size"]')
  await expect(ready.locator('img')).toBeVisible({ timeout: 15_000 })
  await ready.click()

  const viewer = window.locator('.fl-ticket-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.locator('img')).toHaveAttribute('alt', 'one.png')
  await expect(viewer.locator('.fl-ticket-viewer-name')).toHaveText('one.png')

  // ONE KEYSTROKE DISMISSES ONE THING. The ticket behind this also closes on
  // Escape; if the viewer did not capture the key, both would go at once and
  // the reader would lose the ticket they were reading.
  await window.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(window.locator('.fl-ticket')).toBeVisible()

  // …and a second Escape then closes the ticket, as it always did.
  await window.keyboard.press('Escape')
  await expect(window.locator('.fl-ticket')).toHaveCount(0)
})

test('a ticket with no pictures grows no gallery', async ({ app, window }) => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('integrations:status')
    ipcMain.handle('integrations:status', (_e: unknown, req: { provider: string }) => ({
      provider: req.provider,
      connected: req.provider === 'jira',
    }))
    ipcMain.removeHandler('integrations:assigned')
    ipcMain.handle('integrations:assigned', (_e: unknown, req: { provider: string }) => ({
      ok: true,
      provider: req.provider,
      items: [
        {
          key: 'PRJ-7',
          title: 'Skills tab shows nothing',
          description: 'no pictures here',
          status: 'Backlog',
          url: 'https://acme.atlassian.net/browse/PRJ-7',
        },
      ],
      reason: null,
    }))
  })
  await openRemoteTicket(window, await seedProject(window, 'flow-ux-ticketnoimg-'))

  await expect(window.locator('.fl-ticket-images')).toHaveCount(0)
  await expect(window.locator('.fl-ticket-label', { hasText: 'Images' })).toHaveCount(0)
  // The rest of the ticket is unchanged — an absent gallery is not a broken one.
  await expect(window.locator('.fl-ticket-title')).toHaveText('Skills tab shows nothing')
})

/**
 * THE ANSWER IS GIVEN WHERE THE DECISION IS MADE.
 *
 * "that option should be visible on the remote card list, because when I add
 * that to todo, I already wanna that information there."
 *
 * Taking work on and saying whether it should be worked is one decision.
 * Splitting it into two gestures — add it, then open the card and tick a box —
 * means the second one is the one people forget, and the loop then skips work
 * somebody thought they had queued.
 */
test('ticking the remote ticket carries the choice into the card it becomes', async ({
  app,
  window,
}) => {
  await fakeIntegrations(app)
  const dir = await seedProject(window, 'flow-ux-remoteauto-')
  await openRemoteTicket(window, dir)

  // Off by default: a board is also a notebook.
  const box = window.locator('.fl-board-autofix input[type="checkbox"]')
  await expect(box).not.toBeChecked()
  // It says what it will mean, in the future tense — the ticket is not a card
  // yet, and claiming "▶ will work this card" would describe a state it has
  // not reached.
  await expect(window.locator('.fl-board-autofix-why')).toHaveText(
    'It will be added as a note. ▶ on Todo will skip it.',
  )
  await box.check()
  await expect(window.locator('.fl-board-autofix-why')).toHaveText(
    'It will be added ready to work — ▶ on Todo will pick it up.',
  )

  // The ticket names no project, so nothing is ticked and Add waits for one;
  // the person ticks the project it is about (remote-task-projects.spec.ts).
  await window.locator('.fl-board-detail .fl-task-project input:not(:disabled)').first().check()
  await window.locator('.fl-board-new', { hasText: 'Add to Todo' }).click()

  // THE CARD REMEMBERS. Without this the answer dies with the dialog.
  await expect
    .poll(
      async () =>
        (await window.evaluate(
          async (p) => window.flow.tasks.list({ projectRoot: p, includeArchived: false }),
          dir,
        )).find((t) => t.title.includes('Skills tab shows nothing'))?.autoFix ?? null,
      { timeout: 10_000 },
    )
    .toBe(true)

  // …AND THE COLUMN SAYS SO without anybody opening the card, which is what
  // makes the play button's own count checkable from the board. A glyph, not a
  // phrase: the meta row is 150px and "▶ auto" pushed every chip on the card
  // into an ellipsis.
  const mark = window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-badge-auto')
  await expect(mark).toHaveCount(1)
  await expect(mark).toHaveText('▶')
  await expect(mark).toHaveAttribute(
    'title',
    'Pressing ▶ on Todo will work this card in its own chat.',
  )
})
