/**
 * UX sweep — flow 8 (Terminal), round 25: what happens to a project's RUNNING
 * SHELLS when the user removes that project from the sidebar.
 *
 * 36 committed terminal specs drive the shell lifecycle (open / run / tabs /
 * close / exit / scope / project switch / reload). None drives the one action
 * that destroys a project: `Remove from sidebar`. Its cascade
 * (`src/main/project/remove-project.ts`) deletes tasks → threads →
 * thread_roots → the project root, and never touches terminals — so the
 * removed project's PTYs keep running for the lifetime of the app process
 * (#1484), the same contract #1024 (CLOSED) bought for the boot shell on a
 * different trigger.
 *
 * Two shapes, because the visibility rule inverts between them
 * (`isTerminalInScope`: `activeProjectRoot === null` → every terminal visible):
 *   - another project remains → the tab vanishes and the shell is unreachable
 *   - it was the last project → the shell stays on screen as a GHOST tab for a
 *     project the sidebar no longer has
 *
 * The green test guards what IS correct: removal is not a crash, the surviving
 * project's shell stays live and usable, and the strip rebinds to it.
 *
 * Harness traps (see the terminal memories — each cost a wrong reading first):
 *  - the terminal is DOCKED-visible by default; never toggle-to-open (it hides it)
 *  - wait for a real PROMPT before typing (this machine's oh-my-zsh prompt ends
 *    "➜ <dir> git:(main) " — no $/%/#, so the common prompt regex times out)
 *  - the project row has no class: locate it via its `Project actions` (⋯) button
 *  - `flow.terminal.list()` re-replays scrollback into the live xterm — don't
 *    call it to introspect; ask the shell (`echo $$`) and the host (`pgrep`)
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { openProjectActions } from './fixtures/project-actions'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const activeRows = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-rows')

/** A long-lived, uniquely identifiable foreground process per test. */
const SLEEP = (tag: string): string => `sleep 9${tag}`

/** UNCAUGHT exceptions only — a seeded root's background auto-provisioning
 *  emits transient `console.error`s that would make a committed guard flake. */
function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

/** Host-side truth: is that command still running right now? */
function alive(pattern: string): string {
  try {
    return execFileSync('/usr/bin/pgrep', ['-fl', pattern], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function killMarker(pattern: string): void {
  try {
    execFileSync('/usr/bin/pkill', ['-f', pattern])
  } catch {
    /* already gone */
  }
}

async function waitForPrompt(win: Page): Promise<void> {
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 25_000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m)
}

async function typeLine(win: Page, cmd: string): Promise<void> {
  await waitForPrompt(win)
  await win.locator('.fl-term-host:not([hidden])').click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
}

/** A live scoped shell in the active project (the strip starts empty after
 *  activation — the boot auto-start was unscoped). */
async function ensureScopedShell(win: Page): Promise<void> {
  if ((await termTabs(win).count()) === 0) await newBtn(win).click()
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 20_000,
  })
}

async function tabLabels(win: Page): Promise<string[]> {
  return termTabs(win).evaluateAll((nodes) =>
    nodes.map((n) =>
      (
        (n as HTMLElement).querySelector('span:not(.dirty-dot):not(.project-dot)')?.textContent ??
        ''
      ).trim(),
    ),
  )
}

/** Remove a project the way the user does: its switcher row's ⋯ → Remove → confirm. */
async function removeProjectViaSidebar(win: Page, rootPath: string): Promise<string> {
  const name = rootPath.split('/').pop() ?? ''
  // The door: the ⋯ on the project's row in the Workspace switcher.
  await openProjectActions(win, name)
  const menu = win.locator('.fl-thread-menu')
  await menu.locator('button', { hasText: /Remove/i }).first().click()
  await win.waitForTimeout(600)
  const confirmText = (await menu.innerText().catch(() => '')).trim()
  await win.locator('.fl-thread-menu button', { hasText: /^Remove$/ }).first().click()
  await win.waitForTimeout(3000)
  return confirmText
}

test.afterAll(() => cleanupSeeds())

// GREEN — removal itself is sound from the surviving project's side: no crash,
// the strip rebinds to the remaining project, and its shell still runs commands.
test('removing a project leaves the SURVIVING project with a live, usable shell', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const errors = trackErrors(window)

  const alpha = await seedProject(window, 'flow-tpr-alpha-')
  const beta = await seedProject(window, 'flow-tpr-beta-')
  await activateProject(window, beta)
  await window.waitForTimeout(1200)
  await ensureScopedShell(window)
  await typeLine(window, 'echo BETA_SHELL_UP')

  await removeProjectViaSidebar(window, beta)

  // The strip rebinds to alpha (not to a dead or foreign tab) and it works.
  const labels = await tabLabels(window)
  expect(labels.join('|')).toContain(alpha.split('/').pop() ?? '')
  await typeLine(window, 'echo ALPHA_STILL_WORKS')
  await expect
    .poll(async () => (await activeRows(window).innerText()) ?? '', { timeout: 20_000 })
    .toContain('ALPHA_STILL_WORKS')
  await window.screenshot({ path: `${SCREENS}/terminal-removal-survivor.png` })

  expect(errors, `uncaught errors during project removal:\n${errors.join('\n')}`).toEqual([])
})

// TRIPWIRE (currently RED — #1484). The removal cascade never disposes the
// project's terminals, so its shell (and whatever it was running) keeps going
// with no tab, no menu entry and no toast — reachable only by re-adding the
// project the removal just emptied.
test(
  'a removed project must not leave a shell running with no route back',
  async ({ window }) => {
    test.setTimeout(240_000)
    const marker = SLEEP('87651')
    const errors = trackErrors(window)

    try {
      const alpha = await seedProject(window, 'flow-tpo-alpha-')
      const beta = await seedProject(window, 'flow-tpo-beta-')
      await activateProject(window, beta)
      await window.waitForTimeout(1200)
      await ensureScopedShell(window)
      await typeLine(window, marker) // a long-running foreground command
      await expect.poll(() => alive(marker), { timeout: 20_000 }).not.toBe('')

      const confirmText = await removeProjectViaSidebar(window, beta)
      const labels = await tabLabels(window)
      await window.screenshot({ path: `${SCREENS}/terminal-removal-orphan.png` })

      // Either the command was closed with the project, or a tab still leads to
      // it. "Still running, with no tab anywhere" is the state a user cannot act
      // on — and the confirm never warned them.
      const stillRunning = alive(marker)
      const hasTab = labels.some((label) => label.includes(beta.split('/').pop() ?? ''))
      expect(
        stillRunning === '' || hasTab,
        `orphaned shell: pgrep "${stillRunning}", tabs ${JSON.stringify(labels)}, confirm ${JSON.stringify(confirmText)}`,
      ).toBe(true)

      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      killMarker(marker)
    }
  },
)

// TRIPWIRE (currently RED — #1484, second shape). With no project left the
// scope rule inverts and the orphan becomes VISIBLE: the strip shows a live tab
// for a project the sidebar says does not exist ("No project" / "Open a project
// to start").
test(
  'removing the LAST project must not leave a ghost tab for it in the strip',
  async ({ window }) => {
    test.setTimeout(240_000)
    const marker = SLEEP('87652')
    const errors = trackErrors(window)

    try {
      const only = await seedProject(window, 'flow-tpg-only-')
      await activateProject(window, only)
      await window.waitForTimeout(1200)
      await ensureScopedShell(window)
      await typeLine(window, marker)
      await expect.poll(() => alive(marker), { timeout: 20_000 }).not.toBe('')

      await removeProjectViaSidebar(window, only)
      const labels = await tabLabels(window)
      const sidebar = await window.locator('.fl-thread-sidebar').innerText().catch(() => '')
      await window.screenshot({ path: `${SCREENS}/terminal-removal-ghost.png` })

      // The sidebar is back to the no-project state — the strip must agree.
      // (Inside a Workspace that state reads "None of <W>'s projects are open
      // in Flow yet"; outside one, "Open a project to start".)
      expect(sidebar).toMatch(/Open a project to start|projects are open in Flow yet/i)
      expect(
        labels.filter((label) => label.includes(only.split('/').pop() ?? '')),
        `ghost tab for a removed project: ${JSON.stringify(labels)}`,
      ).toHaveLength(0)

      expect(errors, errors.join('\n')).toEqual([])
    } finally {
      killMarker(marker)
    }
  },
)
