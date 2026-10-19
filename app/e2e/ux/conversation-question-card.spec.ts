import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation QUESTION CARD (AskUserQuestion) — round 15.
 *
 * Prior flow-4 probes drove persisted history, states, file links, nested lists,
 * external links, tool cards, code blocks, streaming scroll (#823), the failed-turn
 * error card (#846) and the permission card (#949). The permission-card probe only
 * checked that a question raised for a BACKGROUND thread surfaces when the user
 * opens it — nothing drove the card's ANSWERING surface: the carousel pager (#400),
 * the digit shortcuts + auto-advance (#465), the completeness cue (#414) or Submit.
 *
 * The whole card is drivable credential-lessly by emitting the real
 * `threads:dialogRequest` the dialog broker sends when the agent calls
 * AskUserQuestion and parks the turn (`app/src/main/agent/dialogs.ts`) — the
 * renderer can't tell an injected request from a live one. Submitting an injected
 * request hits the genuine "session gone" path (`threads:respondDialog` finds no
 * parked dialog → throws, #290/#301), so the failure UX is real, never faked.
 *
 * Live guards: the click path (pager, hide/show, auto-advance, Back preserves the
 * pick, honest terminal failure + Dismiss) and the digit shortcuts under the
 * one-owner scope model (#983/#984, question-key-dispatcher): a digit routes to
 * exactly one card — the card holding focus, else the newest visible unanswered
 * one — and fires from the EMPTY composer without leaking into the draft.
 */

const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

async function appendMessage(
  win: Page,
  threadId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Promise<void> {
  await win.evaluate(
    async ({ threadId, role, content }) => {
      await (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** Emit a real `threads:dialogRequest`, exactly as the dialog broker does when the
 *  agent calls AskUserQuestion and parks the turn on the answer. */
async function emitDialog(
  app: ElectronApplication,
  request: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, req) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:dialogRequest', req)
  }, request)
}

const card = (win: Page) => win.locator('.fl-qcard')

/** A two-question request: single-select first (auto-advances), multi-select second. */
const rolloutQuestions = [
  {
    question: 'Which rollout strategy should I use?',
    header: 'Rollout',
    multiSelect: false,
    options: [
      { label: 'Canary', description: 'Ship to 5% of traffic first' },
      { label: 'Blue/green', description: 'Swap all traffic at once' },
      { label: 'Big bang', description: 'Ship to everyone now' },
    ],
  },
  {
    question: 'Which environments should it cover?',
    header: 'Environments',
    multiSelect: true,
    options: [
      { label: 'Staging', description: 'Pre-prod mirror' },
      { label: 'Production', description: 'Live traffic' },
    ],
  },
]

const composerValue = (win: Page): Promise<string | undefined> =>
  win.evaluate(
    () =>
      (document.querySelector('.fl-composer-input textarea') as HTMLTextAreaElement | null)?.value,
  )

/** Every card's currently-selected option labels, in feed order. */
const selectionsPerCard = (win: Page): Promise<string[][]> =>
  win.evaluate(() =>
    [...document.querySelectorAll('.fl-qcard')].map((el) =>
      [...el.querySelectorAll('.fl-qcard-option.selected')].map(
        (o) => o.querySelector('.fl-qcard-option-label')?.textContent ?? '',
      ),
    ),
  )

test.afterAll(() => cleanupSeeds())

test('carousel answers by click, and a dead session fails honestly', async ({ window, app }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Ask Thread')
  await appendMessage(window, threadId, 'user', 'Plan the rollout.')
  await openThread(window, 'Ask Thread')

  await emitDialog(app, { requestId: 'ask-carousel-1', threadId, questions: rolloutQuestions })

  await expect(card(window)).toHaveCount(1)
  const q = card(window).locator('.fl-qcard-q')
  // The carousel (#400) shows ONE question with a pager, not a stacked wall.
  await expect(q.nth(0)).toBeVisible()
  await expect(q.nth(1)).toBeHidden()
  await expect(card(window).locator('.fl-qcard-pager-label')).toHaveText('1 of 2')
  // `.first()` — the terminal dead-end appends a second .fl-qcard-submit (Dismiss).
  const submit = card(window).locator('.fl-qcard-submit').first()
  await expect(submit).toBeDisabled()
  await window.screenshot({ path: `${SCREENS}/qcard-01-q1.png` })

  // Single-select: the pick highlights, then the carousel auto-advances (#465).
  await q.nth(0).locator('.fl-qcard-option').nth(1).click()
  await expect(q.nth(0).locator('.fl-qcard-option').nth(1)).toHaveClass(/selected/)
  await expect(card(window).locator('.fl-qcard-pager-label')).toHaveText('2 of 2')
  await expect(q.nth(1)).toBeVisible()

  // Multi-select: picking does NOT advance (there is nowhere to go) and completing
  // every question is what enables Submit.
  await q.nth(1).locator('.fl-qcard-option').nth(1).click()
  await expect(q.nth(1).locator('.fl-qcard-option').nth(1)).toHaveClass(/selected/)
  await expect(submit).toBeEnabled()
  await window.screenshot({ path: `${SCREENS}/qcard-02-q2.png` })

  // Paging back must not lose an answer.
  // By its accessible name, not its face: the pager reads "‹ 1 of 2 ›" now that
  // the count between the arrows already says what they move through, and a
  // locator keyed on display text breaks every time the words change.
  await card(window).locator('.fl-qcard-nav[aria-label="Previous question"]').click()
  await expect(card(window).locator('.fl-qcard-pager-label')).toHaveText('1 of 2')
  await expect(q.nth(0).locator('.fl-qcard-option').nth(1)).toHaveClass(/selected/)

  // No dialog is parked for an injected request — the real "session gone" case
  // (#290/#301): terminal copy + a Dismiss, never a lying "Answered".
  await submit.click()
  await expect(card(window).locator('.fl-qcard-error')).toContainText('This session ended')
  await expect(submit, 'no retry affordance on a terminal failure').toBeHidden()
  await window.screenshot({ path: `${SCREENS}/qcard-03-submitted.png` })

  await card(window).locator('.fl-qcard-submit', { hasText: 'Dismiss' }).click()
  await expect(card(window)).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a feed wipe keeps the picks and the page of a half-answered card', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Wipe Thread')
  await appendMessage(window, threadId, 'user', 'Plan the rollout.')
  const otherId = await createThread(window, dir, 'Elsewhere Thread')
  await appendMessage(window, otherId, 'user', 'Something else.')
  await openThread(window, 'Wipe Thread')

  await emitDialog(app, { requestId: 'ask-wipe-1', threadId, questions: rolloutQuestions })
  const q = card(window).locator('.fl-qcard-q')
  await q.nth(0).locator('.fl-qcard-option').nth(1).click()
  await expect(card(window).locator('.fl-qcard-pager-label')).toHaveText('2 of 2')

  // Leaving the thread wipes the feed through the same path a turn's reconcile
  // takes; the card is re-rendered when the thread is shown again.
  await openThread(window, 'Elsewhere Thread')
  await expect(card(window)).toHaveCount(0)
  await openThread(window, 'Wipe Thread')

  await expect(card(window)).toHaveCount(1)
  await expect(card(window).locator('.fl-qcard-pager-label')).toHaveText('2 of 2')
  await card(window).locator('.fl-qcard-nav[aria-label="Previous question"]').click()
  await expect(q.nth(0).locator('.fl-qcard-option').nth(1)).toHaveClass(/selected/)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('digit shortcut picks the badged option once focus is off a text field', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Shortcut Thread')
  await appendMessage(window, threadId, 'user', 'Plan the rollout.')
  await openThread(window, 'Shortcut Thread')

  await emitDialog(app, { requestId: 'ask-shortcut-1', threadId, questions: rolloutQuestions })
  await expect(card(window)).toHaveCount(1)

  const q = card(window).locator('.fl-qcard-q')
  // Every option advertises its shortcut.
  await expect(q.nth(0).locator('.fl-qcard-option-key').nth(0)).toHaveText('1')
  await expect(q.nth(0).locator('.fl-qcard-option-key').nth(2)).toHaveText('3')

  // Clicking an option takes focus off the composer textarea — from here the
  // document-level digit handler is live (#465).
  await q.nth(0).locator('.fl-qcard-option').nth(0).click()
  await expect(q.nth(1)).toBeVisible()
  await window.keyboard.press('2')
  await expect(q.nth(1).locator('.fl-qcard-option').nth(1)).toHaveClass(/selected/)
  await expect(card(window).locator('.fl-qcard-submit')).toBeEnabled()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #983 — the card is born with the composer focused (threads/index.ts focuses it
// on thread select). The dispatcher routes a digit from the EMPTY composer to the
// pending card, so the badge works immediately and never leaks into the draft.
test(
  'badge digit picks the option instead of typing into the composer draft (#983)',
  async ({ window, app }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Badge Thread')
    await appendMessage(window, threadId, 'user', 'Plan the rollout.')
    await openThread(window, 'Badge Thread')

    await emitDialog(app, { requestId: 'ask-badge-1', threadId, questions: rolloutQuestions })
    await expect(card(window)).toHaveCount(1)

    // The user presses the shortcut printed on the option they want, without
    // clicking anything first.
    await window.keyboard.press('2')

    await expect(
      card(window).locator('.fl-qcard-q').nth(0).locator('.fl-qcard-option').nth(1),
    ).toHaveClass(/selected/)
    expect(await composerValue(window), 'the digit must not leak into the message draft').toBe('')

    // The flip side: once a draft is in progress, digits TYPE — the card never
    // steals a keystroke out of the user's message.
    await window.locator('.fl-composer-input textarea').fill('use option ')
    await window.keyboard.press('1')
    expect(await composerValue(window), 'a draft keeps its keystrokes').toBe('use option 1')
    await expect(
      card(window).locator('.fl-qcard-q').nth(1).locator('.fl-qcard-option.selected'),
      'the pending question is untouched while the user types',
    ).toHaveCount(0)
  },
)

// #984 — digits belong to exactly ONE card: the one holding focus (here, the card
// the user clicked into), else the newest visible unanswered one. The other pending
// card must stay untouched — no silently-selected answer the user never made.
test(
  'a digit answers only the card the user is working in (#984)',
  async ({ window, app }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Two Asks')
    await appendMessage(window, threadId, 'user', 'Set up the new service.')
    await openThread(window, 'Two Asks')

    await emitDialog(app, {
      requestId: 'ask-multi-1',
      threadId,
      questions: [
        {
          question: 'Which database should the service use?',
          header: 'Database',
          multiSelect: false,
          options: [
            { label: 'Postgres', description: 'Relational' },
            { label: 'DynamoDB', description: 'Managed key-value' },
          ],
        },
      ],
    })
    await emitDialog(app, {
      requestId: 'ask-multi-2',
      threadId,
      questions: [
        {
          question: 'Which cache should it use?',
          header: 'Cache',
          multiSelect: false,
          options: [
            { label: 'Redis', description: 'Shared cluster' },
            { label: 'In-process', description: 'No extra infra' },
          ],
        },
      ],
    })
    await expect(card(window)).toHaveCount(2)

    // The user works in the SECOND card: click an option (focus leaves the
    // composer), then change the pick with its badge shortcut.
    await card(window).nth(1).locator('.fl-qcard-option').nth(0).click()
    await window.keyboard.press('2')

    expect(await selectionsPerCard(window)).toEqual([[], ['In-process']])
  },
)

test('the recommendation reads as a badge, and the answer keeps the label it was sent', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Recommend Thread')
  await appendMessage(window, threadId, 'user', 'Pick a locale fallback.')
  await openThread(window, 'Recommend Thread')

  await emitDialog(app, {
    requestId: 'ask-recommended-1',
    threadId,
    questions: [
      {
        question: 'How should the locale fall back?',
        header: 'Fallback',
        multiSelect: false,
        options: [
          {
            label: 'Bundle en-US locally (Recommended)',
            description: 'Always renders, even with no network',
          },
          { label: 'Fetch on demand', description: 'Smaller bundle, needs the network' },
        ],
      },
    ],
  })

  await expect(card(window)).toHaveCount(1)
  const recommended = card(window).locator('.fl-qcard-option').nth(0)

  // The "(Recommended)" the agent appended is lifted OUT of the label line and
  // rendered as its own badge — the cue the user could previously miss.
  await expect(recommended.locator('.fl-qcard-option-badge')).toHaveText('Recommended')
  await expect(recommended.locator('.fl-qcard-option-label')).toHaveText('Bundle en-US locally')
  // Only the marked option carries one — an unmarked label is untouched.
  await expect(card(window).locator('.fl-qcard-option-badge')).toHaveCount(1)
  await expect(
    card(window).locator('.fl-qcard-option').nth(1).locator('.fl-qcard-option-label'),
  ).toHaveText('Fetch on demand')
  await card(window).screenshot({ path: `${SCREENS}/qcard-04-recommended.png` })

  // Capture what actually crosses the IPC boundary. Stripping the marker is a
  // DISPLAY concern: the answer must still be the label the agent sent, or the
  // agent cannot match the response to the option it offered.
  //
  // Observed from the MAIN process, not the page: `contextBridge` exposes a
  // deep-frozen `window.flow`, so a renderer-side spy silently no-ops. The `app`
  // fixture is per-test, so swapping this one handler is contained to this test
  // (and it also lets the submit SUCCEED, instead of the injected-request
  // "session gone" dead-end the other probes drive).
  await app.evaluate(({ ipcMain }) => {
    const captured: unknown[] = []
    ;(globalThis as unknown as { __sentAnswers: unknown[] }).__sentAnswers = captured
    ipcMain.removeHandler('threads:respondDialog')
    ipcMain.handle('threads:respondDialog', (_event, payload: unknown) => {
      captured.push(payload)
    })
  })

  await recommended.click()
  await card(window).locator('.fl-qcard-submit').first().click()
  await expect(card(window).locator('.fl-qcard-submit').first()).toHaveText('Answered')

  const sent = await app.evaluate(
    () => (globalThis as unknown as { __sentAnswers: { answers: unknown }[] }).__sentAnswers,
  )
  expect(sent).toHaveLength(1)
  expect(sent[0]?.answers).toEqual([
    { header: 'Fallback', selected: ['Bundle en-US locally (Recommended)'] },
  ])

  expect(errors).toEqual([])
})
