import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow 2 (Threads): the core thread VERBS while #1219's new
 * put-away modes are on.
 *
 * #1219 shipped two controls (collapse the list · hide the list AND the chat)
 * and a spec that drives the controls themselves. Nothing drove what the
 * toolbar's remaining, still-armed buttons DO once the surfaces they act on
 * are off screen — which is where both of this round's findings live:
 *
 *  - #1324 (High): the sidebar's own "+ New thread" never joined #1071's
 *    `flow:show-chat` reveal funnel. It calls `#createThread()` directly while
 *    the palette's identical verb goes through `flow:new-thread`. In the hidden
 *    mode the click is a zero-pixel no-op that still creates a thread AND
 *    switches the open conversation to it.
 *  - #1325 (Medium): the search box stays armed over the hidden list — a query
 *    filters rows nobody can see, and the "No threads match …" hint that would
 *    be the feedback is inside the hidden wrapper.
 *
 * The live test guards what DOES hold today (put-away recovers; the palette
 * route reveals the chat from the hidden mode), so the contract's existence is
 * pinned next door to the gap. The two `fixme`s assert the fixed behavior and
 * flip to `test(...)` when the issues are closed.
 */
const list = (win: Page) => win.locator('.fl-thread-list')
const chat = (win: Page) => win.locator('.fl-conversation').first()
/**
 * THE PUT-AWAY MODE CAN NO LONGER BE ENTERED (2026-09-03).
 *
 * Every scenario below starts by clicking the chat's `—`, and that control was
 * removed on the user's report. The mode itself survives — it is persisted, so
 * a window put away before the removal still boots into it — but a cold boot
 * into it does NOT reliably hide the chat (the sidebar's flow:hide-chat ask
 * races the shell's listener), so the precondition these tests need cannot be
 * established through any supported path.
 *
 * They are SKIPPED rather than deleted or quietly rewritten: #1324 and #1325
 * are real, still-open findings about armed verbs over hidden surfaces, and a
 * test that passes because its precondition silently never happened is worse
 * than one that says why it cannot run. `threads-collapse.spec.ts` guards what
 * does still hold — the control is gone, and the way back out survived it.
 */
const hideBtn = (win: Page) => win.locator('.fl-conversation .fl-chat-hide').first()
const newThreadBtn = (win: Page) =>
  win.locator('.fl-thread-toolbar fl-button[aria-label="New thread"]').first()
const searchBox = (win: Page) => win.locator('.fl-thread-search input').first()
const restore = (win: Page) => win.locator('.fl-thread-restore')

/** Thread titles straight from the store — the app's own truth, not the DOM. */
async function threadTitles(win: Page, root: string): Promise<string[]> {
  return win.evaluate(async (p) => {
    const flow = (
      window as unknown as {
        flow: { threads: { list(r: { projectRoot: string }): Promise<{ title: string }[]> } }
      }
    ).flow
    return (await flow.threads.list({ projectRoot: p })).map((t) => t.title)
  }, root)
}

/** Everything the user can actually read on screen, whitespace-normalised. */
const screenText = (win: Page): Promise<string> =>
  win.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim())

/** Seed a project with one thread open and the Threads pane on screen.
 *  NOTE: Threads is the DEFAULT rail — clicking its rail item would toggle the
 *  sidebar shut (shell.ts), so there is nothing to click here. */
async function seedWithThread(win: Page, prefix: string): Promise<string> {
  const root = await seedProject(win, prefix)
  await activateProject(win, root)
  await expect(list(win)).toBeVisible()
  await newThreadBtn(win).click()
  await expect(win.locator('fl-list').getByText('New thread', { exact: true }).first()).toBeVisible({
    timeout: 15000,
  })
  return root
}

test.afterAll(() => cleanupSeeds())

test.skip('the put-away panel recovers, and the palette create reveals the chat through it (#1219, #1071)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedWithThread(window, 'flow-threads-hidden-')

  // Put both away: the state names its own way back rather than going blank.
  await hideBtn(window).click()
  await expect(list(window)).toBeHidden()
  await expect(chat(window)).toBeHidden()
  await expect(restore(window)).toContainText('hidden')

  // The reveal contract EXISTS — the palette's "New thread" (flow:new-thread)
  // dispatches flow:show-chat, so the conversation it opens is on screen. This
  // is the sibling that #1324's toolbar button is measured against.
  const before = await threadTitles(window, root)
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:new-thread')))
  await expect(chat(window)).toBeVisible({ timeout: 15000 })
  expect((await threadTitles(window, root)).length).toBe(before.length + 1)

  // …AND THE CREATE BRINGS THE LIST BACK BY ITSELF — nothing to click.
  //
  // This used to click the restore hint here and had been failing for a long
  // time; verified failing at `d8e2ab32^`, before any of this session's work,
  // so it is rot rather than a regression. The click can never succeed: since
  // #1324 (2026-08-07) `#createThread` restores a put-away panel, on the same
  // reasoning as the `flow:show-chat` above — "a thread list put away can't
  // show what was just created either". By the time this line runs the panel is
  // already back and the hint is correctly hidden, so the test was clicking a
  // control whose absence is the feature working.
  //
  // Asserting the state instead is the STRONGER claim, not the convenient one:
  // it says the reveal happened without the user doing anything, which is what
  // #1324 promises. A click here could only ever have proved the panel was
  // still put away.
  await expect(list(window)).toBeVisible()
  await expect(chat(window)).toBeVisible()
  await expect(restore(window)).toBeHidden()

  expect(errors, `renderer errors:\n${errors.join('\n')}`).toEqual([])
})

test.fixme(
  'the toolbar + creates a thread the user can SEE, even with the panel hidden (#1324)',
  async ({ window }) => {
    const root = await seedWithThread(window, 'flow-threads-plus-')
    await window.evaluate(async (p) => {
      const flow = (
        window as unknown as {
          flow: {
            threads: {
              list(r: unknown): Promise<{ id: string }[]>
              update(r: unknown): Promise<unknown>
            }
          }
        }
      ).flow
      const threads = await flow.threads.list({ projectRoot: p })
      if (threads[0]) await flow.threads.update({ threadId: threads[0].id, patch: { title: 'MY-WORK-THREAD' } })
    }, root)
    await expect(window.locator('fl-list').getByText('MY-WORK-THREAD', { exact: true })).toBeVisible()

    await hideBtn(window).click()
    await expect(chat(window)).toBeHidden()
    const screenBefore = await screenText(window)

    await newThreadBtn(window).click()
    // A create is the user asking to open a conversation: it must land somewhere
    // visible. Today the store gains a thread, the new thread becomes active,
    // and the screen is byte-identical.
    await expect(chat(window)).toBeVisible({ timeout: 10000 })
    expect(await screenText(window)).not.toBe(screenBefore)
    expect(await threadTitles(window, root)).toContain('MY-WORK-THREAD')
  },
)

/**
 * #1325 SURVIVES THE CARET'S REMOVAL, in the one state that is left.
 *
 * It used to be reached the easy way: collapse the list with the toolbar's `⌄`
 * and type. That caret is gone (2026-08-24), and with it the list-only state —
 * so the only way to a hidden list is now `all-hidden`, where the search box
 * is STILL in the toolbar, still typeable, still filtering a list nobody can
 * see. Fixme, not deleted: the affordance is worse here than it was, because
 * the box now sits directly above a hint saying the panel is put away.
 */
test.fixme('searching reveals the hidden thread list (#1325, #1010s contract)', async ({ window }) => {
  const root = await seedWithThread(window, 'flow-threads-search-')
  await window.evaluate(async (p) => {
    const flow = (
      window as unknown as {
        flow: {
          threads: {
            list(r: unknown): Promise<{ id: string }[]>
            update(r: unknown): Promise<unknown>
          }
        }
      }
    ).flow
    const threads = await flow.threads.list({ projectRoot: p })
    if (threads[0]) await flow.threads.update({ threadId: threads[0].id, patch: { title: 'ZEBRAFISH-REPORT' } })
  }, root)
  await expect(window.locator('fl-list').getByText('ZEBRAFISH-REPORT', { exact: true })).toBeVisible()

  await hideBtn(window).click()
  await expect(list(window)).toBeHidden()

  // Typing a query is the user asking to SEE threads — the same reason #1010
  // force-reveals past a collapsed project group.
  await searchBox(window).click()
  await searchBox(window).fill('ZEBRA')
  await expect(list(window)).toBeVisible({ timeout: 10000 })
  await expect(window.locator('fl-list').getByText('ZEBRAFISH-REPORT', { exact: true })).toBeVisible()
})
