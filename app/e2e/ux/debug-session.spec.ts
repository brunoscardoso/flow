/**
 * THE WHOLE FEATURE, END TO END: press Debug, make something happen in the
 * browser AND in a terminal, press Finish, and find both in one artifact —
 * interleaved in the order they really happened.
 *
 * This is the claim everything else serves. The unit tests cover what a window
 * holds, what it drops and what the summary says; none of them can show that a
 * real shell's output and a real page's traffic land on the same timeline,
 * because that is exactly the thing that was not true before this feature.
 *
 * Harness traps (each cost a wrong reading first — see the terminal memories):
 *  - the terminal is DOCKED-visible by default; never toggle-to-open
 *  - wait for a real PROMPT before typing (oh-my-zsh here ends "➜ dir git:(main) ")
 *  - the shell ECHOES what you type, so build markers from a shell variable
 *  - a page's own load-time requests are NOT captured (the debugger attaches
 *    after them), so traffic must be caused after the session starts
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject, openThreadByTitle } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'

test.afterAll(() => cleanupSeeds())

// THE BUTTON IS IN THE BROWSER TOOLBAR now, beside Inspect (user, 2026-09-21)
// — it began in the status bar and landed directly under the browser's own
// Console/Network tabs, reading as part of them.
const control = (win: Page) => win.locator('fl-button.fl-debug-btn')
const activeRows = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-rows')

async function waitForPrompt(win: Page): Promise<void> {
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 30_000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 30_000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m)
}

test('a session records the browser and a terminal onto one timeline', async ({ window }) => {
  test.setTimeout(300_000)

  const root = await seedProject(window, 'flow-dbg-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'base'], { cwd: dir })
  })
  await activateProject(window, root)

  const threadId = await window.evaluate(async (projectRoot: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    return (await flow.threads.create({ projectRoot, title: 'Debug session e2e' })).id
  }, root)
  // SELECTED THE WAY A PERSON SELECTS ONE — by clicking the row.
  //
  // This spec used to dispatch `flow:open-thread` instead, and passed while the
  // feature was broken in the app: that event is fired only by TASK surfaces,
  // never by the sidebar, so the renderer's idea of the active thread was null
  // in normal use and nothing was ever posted to the conversation. Driving the
  // real path is the only reason this spec now means anything.
  // A real press on the row's title (the row no longer carries a titled
  // span), waiting until that row is the CURRENT one and its composer is up.
  await openThreadByTitle(window, 'Debug session e2e')

  // A terminal in the thread's project, with a live shell.
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-terminal')))
  await waitForPrompt(window)

  // The browser, on a local page. Its LOAD traffic will not be captured — that
  // is measured and pinned in browser-capture-clock.spec.ts — so the request
  // this test asserts on is fired after the session starts.
  const page = `file://${resolve('e2e/fixtures/pages/clock-probe.html')}`
  await window.evaluate((url: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-browser', { detail: { url } }))
  }, page)
  await expect(window.locator('webview')).toBeVisible({ timeout: 60_000 })
  await window.waitForTimeout(3000)

  // ── START ───────────────────────────────────────────────────────────────
  // An icon, so the STATE is the assertion rather than a label: ghost when
  // idle, primary while a session is live.
  await expect(control(window)).toHaveAttribute('variant', 'ghost')
  await expect(control(window)).not.toContainText('Capturing')
  await control(window).click()
  // A RED TAG THAT SAYS THE WORD, not just a pressed icon. A colour says a
  // toggle is on; it does not say what is on, and a session left running is
  // this feature's failure mode (user, 2026-09-21). The word is CAPTURING,
  // which is the verb the outcome sentence and the summary already use.
  await expect(control(window)).toHaveAttribute('variant', 'primary', { timeout: 30_000 })
  await expect(control(window)).toContainText('Capturing')
  await expect(control(window)).toHaveClass(/is-recording/)

  // Something in the BROWSER…
  await window.evaluate(async () => {
    const view = document.querySelector('webview') as unknown as {
      executeJavaScript(code: string): Promise<unknown>
    } | null
    await view?.executeJavaScript(
      `console.error('DBGSESSION browser error'); fetch('http://127.0.0.1:8099/dbg').catch(() => {}); 1`,
    )
  })

  // …and something in the TERMINAL, after it, so the order is a real fact and
  // not an artefact of how the sources are concatenated.
  await window.waitForTimeout(1200)
  await window.locator('.fl-term-host:not([hidden])').click()
  await window.keyboard.type(`M=DBG; printf '%sSESSION terminal marker\\n' "$M"`)
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => (await activeRows(window).innerText()) ?? '', { timeout: 30_000 })
    .toContain('DBGSESSION terminal marker')

  // ── FINISH ──────────────────────────────────────────────────────────────
  // THROUGH THE CONTROL, not the IPC. Calling `debug.stop()` directly skips the
  // runner — the layer that opens the record and attaches the chip — so a test
  // that did that asserted against a path the app never takes.
  await control(window).click()
  await expect(control(window)).toHaveAttribute('variant', 'ghost', { timeout: 30_000 })

  // The record is found on disk, in the seeded project, because the button's
  // path consumes its own result.
  const sessionsDir = join(root, 'flow', 'debug-sessions')
  await expect
    .poll(() => (existsSync(sessionsDir) ? readdirSync(sessionsDir).filter((n) => n.startsWith('dbg-')).length : 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0)
  const sessionId = readdirSync(sessionsDir).filter((n) => n.startsWith('dbg-'))[0] as string
  const artifactDir = join(sessionsDir, sessionId)

  // BOTH FILES. The summary is what opens and what the chip cites; the timeline
  // is the source of truth it is a reading of, and the one asserted below —
  // "both sources on one clock" is a claim about the RECORD.
  const written = readdirSync(artifactDir)
  expect(written).toContain('summary.md')
  expect(written).toContain('timeline.md')
  const summary = readFileSync(join(artifactDir, 'summary.md'), 'utf8')
  expect(summary).toContain('# Debug session')
  expect(summary).toContain('timeline.md')
  const file = readFileSync(join(artifactDir, 'timeline.md'), 'utf8')

  // THE RECORDED WINDOW ONLY, NOT THE WHOLE FILE.
  //
  // The artifact also carries an untimed PRE-ROLL — the tail of each terminal's
  // display scrollback from before recording began — and the marker this test
  // types appears there too. Asserting against the whole file therefore passes
  // even when the terminal is not being recorded at all: found by disabling
  // `observeTerminalOutput` and watching this spec go green anyway. Everything
  // below is scoped to the timeline section, which is the thing under test.
  const preRollAt = file.indexOf('Before recording started')
  const timeline = preRollAt === -1 ? file : file.slice(0, preRollAt)
  expect(timeline).toContain('── Timeline')

  // ── BOTH SOURCES, ONE TIMELINE ──────────────────────────────────────────
  expect(timeline, 'the terminal half is missing from the recorded window').toContain(
    'DBGSESSION terminal marker',
  )
  expect(timeline, 'the browser half is missing from the recorded window').toContain(
    'DBGSESSION browser error',
  )

  // …AND IN THE ORDER THEY HAPPENED. The browser error was caused first; if the
  // merge were concatenating sources rather than sorting on one clock, the
  // terminal block would sit wholly before or after the browser block and this
  // is the assertion that would fail.
  expect(timeline.indexOf('DBGSESSION browser error')).toBeLessThan(
    timeline.indexOf('DBGSESSION terminal marker'),
  )

  // The terminal is named by its PROJECT, so a reader can tell two shells apart.
  expect(timeline).toContain('flow-dbg-')

  // THE SUMMARY IS A REFERENCE, NOT A TRANSCRIPT.
  //
  // It used to be appended to the thread as a system message, and a real
  // session's — 3,720 records across two worktrees, twelve failures — filled
  // the conversation with a wall nobody could read (user, 2026-09-21). It
  // attaches as a context CHIP instead: the next message carries it, and a
  // reader who did not want it can take it off. The full record is a file.
  const chip = window.locator('.fl-composer-chips', { hasText: 'Debug session' }).first()
  await expect(chip).toBeVisible({ timeout: 30_000 })

  // …and nothing was dumped into the transcript.
  expect(await window.locator('.fl-conv-system', { hasText: 'Debug session' }).count()).toBe(0)
  void threadId

  // The control is idle again — icon only, no word, no red.
  await expect(control(window)).toHaveAttribute('variant', 'ghost', { timeout: 30_000 })
  await expect(control(window)).not.toContainText('Capturing')
  await expect(control(window)).not.toHaveClass(/is-recording/)
})
