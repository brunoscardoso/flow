import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer): a QUEUED prompt draining is a BACKGROUND event.
 *
 * The user queues a follow-up while the agent works (#472), then goes back to
 * work somewhere else in the app (search box, editor, terminal…). When the turn
 * ends the queue auto-sends — the user pressed nothing. `#dispatchContent`'s
 * `finally { this.#textarea.focus() }` is shared by the LIVE send (where a
 * refocus is correct — the user just hit Enter) and by `#drainNext` (where it
 * is a background focus steal): the caret jumps into the composer and the next
 * keystrokes land in the chat box instead of where the user was typing (#1045).
 *
 * Driven without a Claude account: `threads:create` needs only a project root,
 * and `working`/`done` are injected on the real `threads:stream` channel the
 * agent-manager emits on. The refocus lives in the shared `finally`, so it runs
 * on both the success and the failure leg of the send.
 */

const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const t = await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })
      return t.id
    },
    { root, title },
  )
}

/** Describe the deeply-focused element (pierces shadow roots). */
async function focused(win: Page): Promise<string> {
  return win.evaluate(() => {
    let el: Element | null = document.activeElement
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement
    if (!el) return 'none'
    const cls = (el as HTMLElement).className
    return `${el.tagName}${typeof cls === 'string' && cls ? `.${cls.split(' ')[0]}` : ''}`
  })
}

test.afterAll(() => cleanupSeeds())

test.describe('composer — background queue drain vs. the user', () => {
  test('a working→done transition with an EMPTY queue leaves focus alone (control)', async ({
    app,
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    writeFileSync(join(dir, 'README.md'), '# seeded\n')
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'DrainControl')
    await window.getByText('DrainControl', { exact: true }).click()
    await expect(window.locator(sel.composer)).toBeVisible()

    const setStatus = async (status: string) =>
      app.evaluate(
        ({ BrowserWindow }, { threadId, status }) => {
          const w = BrowserWindow.getAllWindows()[0]
          w?.webContents.send('threads:stream', { kind: 'status', threadId, status })
        },
        { threadId, status },
      )

    // The user is typing in the thread search box while a turn runs.
    await setStatus('working')
    const search = window.locator('.fl-thread-search input').first()
    await search.click()
    await window.keyboard.type('ab')
    expect(await focused(window)).toContain('INPUT')

    // Turn ends with NOTHING queued — no dispatch, so the composer must not grab
    // the keyboard (asserted as "not the composer" so an unrelated surface taking
    // focus can't masquerade as this bug).
    await setStatus('done')
    await window.waitForTimeout(1500)
    expect(await focused(window)).not.toContain('TEXTAREA')
    expect(await search.inputValue()).toBe('ab')

    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  test('the queue really drains on `done` (the flow this guards is live)', async ({
    app,
    window,
  }) => {
    const dir = await seedProject(window)
    writeFileSync(join(dir, 'README.md'), '# seeded\n')
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'DrainLive')
    await window.getByText('DrainLive', { exact: true }).click()
    await expect(window.locator(sel.composer)).toBeVisible()
    const textarea = window.locator(`${sel.composer} textarea`)

    const setStatus = async (status: string) =>
      app.evaluate(
        ({ BrowserWindow }, { threadId, status }) => {
          const w = BrowserWindow.getAllWindows()[0]
          w?.webContents.send('threads:stream', { kind: 'status', threadId, status })
        },
        { threadId, status },
      )

    await setStatus('working')
    await expect(window.locator(`${sel.composer} fl-button`, { hasText: 'Interrupt' })).toBeVisible()
    await textarea.click()
    await textarea.type('follow-up while the agent works')
    await textarea.press('Enter')
    const items = window.locator(`${sel.composer} .fl-composer-queue-item`)
    await expect(items).toHaveCount(1)

    // The turn ends → the queued prompt is dispatched by itself (#472).
    await setStatus('done')
    await expect(items).toHaveCount(0)
  })

  // #1045 — fixed: the background drain must NOT move focus, and keystrokes must
  // keep landing where the user put the caret.
  test(
    'a background drain does not steal the keyboard from where the user is typing (#1045)',
    async ({ app, window }) => {
      const dir = await seedProject(window)
      writeFileSync(join(dir, 'README.md'), '# seeded\n')
      await activateProject(window, dir)
      const threadId = await createThread(window, dir, 'DrainFocus')
      await window.getByText('DrainFocus', { exact: true }).click()
      await expect(window.locator(sel.composer)).toBeVisible()
      const textarea = window.locator(`${sel.composer} textarea`)

      const setStatus = async (status: string) =>
        app.evaluate(
          ({ BrowserWindow }, { threadId, status }) => {
            const w = BrowserWindow.getAllWindows()[0]
            w?.webContents.send('threads:stream', { kind: 'status', threadId, status })
          },
          { threadId, status },
        )

      await setStatus('working')
      await expect(
        window.locator(`${sel.composer} fl-button`, { hasText: 'Interrupt' }),
      ).toBeVisible()
      await textarea.click()
      await textarea.type('follow-up while the agent works')
      await textarea.press('Enter')
      await expect(window.locator(`${sel.composer} .fl-composer-queue-item`)).toHaveCount(1)

      // Back to work elsewhere: half a search query typed into the sidebar.
      const search = window.locator('.fl-thread-search input').first()
      await search.click()
      await window.keyboard.type('READ')

      // Background event: the turn ends and the queue auto-sends.
      await setStatus('done')
      await window.waitForTimeout(1500)

      // The rest of the query must land in the search box, not in the chat box.
      await window.keyboard.type('ME')
      await window.screenshot({ path: `${SCREENS}/composer-drain-focus.png` })
      expect(await focused(window)).toContain('INPUT')
      // Observed on main: search keeps "READ", the composer swallows "ME".
      expect(await search.inputValue()).toBe('README')
      expect(await textarea.inputValue()).toBe('')
    },
  )
})
