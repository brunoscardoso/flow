/**
 * UX sweep — flow 8 (Terminal), round 25: the MULTI-ROOT terminal seam.
 *
 * 36 committed terminal specs drive ONE project root. A multi-project thread
 * puts two repos in one window, and the panel grows a whole extra layer for it
 * (terminal-scope.ts): the + button opens a "New terminal in:" root picker,
 * each tab carries its project's accent dot + tooltip, and visibility is
 * scope-driven (a tab is shown only while its root is in the active thread's
 * scope). None of that has any e2e coverage.
 *
 * What a user expects, and what this drives:
 *  1. + under a 2-root thread offers a root picker, and picking a root spawns a
 *     shell whose cwd IS that root (pwd is the only honest observable).
 *  2. The two shells stay tellable apart in the strip (label / tooltip / dot).
 *  3. Switching to a single-root thread and back does not lose a running shell.
 *
 * Harness traps (each cost a wrong reading first — see the terminal memories):
 *  - the terminal is DOCKED-visible by default; never toggle-to-open (that hides it)
 *  - wait for a real PROMPT before typing (oh-my-zsh here ends "➜ dir git:(main) ")
 *  - the shell ECHOES what you type, so build markers from a shell variable
 *  - `flow.terminal.list()` re-replays scrollback into the live xterm; don't call it
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')
const rootMenu = (win: Page) => win.locator('.fl-term-root-menu')
const activeRows = (win: Page) => win.locator('.fl-term-host:not([hidden]) .xterm-rows')

/** UNCAUGHT exceptions only. `console.error` is deliberately NOT collected
 *  here: a freshly seeded root is auto-provisioned in the background and its
 *  transient warnings made this guard flake once, which is worse in a committed
 *  spec than the extra signal is worth. */
function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  return errors
}

async function createThread(
  win: Page,
  projectRoot: string,
  title: string,
  additionalRoots: string[] = [],
): Promise<string> {
  return win.evaluate(
    async ({ projectRoot, title, additionalRoots }) => {
      const created = await (
        window as unknown as {
          flow: {
            threads: {
              create(i: {
                projectRoot: string
                title: string
                additionalRoots?: string[]
              }): Promise<{ id: string }>
            }
          }
        }
      ).flow.threads.create({ projectRoot, title, additionalRoots })
      return created.id
    },
    { projectRoot, title, additionalRoots },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  const threadsRail = win.locator('[data-rail-item="threads"]')
  const cls = (await threadsRail.getAttribute('class')) ?? ''
  if (!/\bactive\b/.test(cls)) await threadsRail.click()
  const row = win
    .locator('.fl-thread-sidebar .row', { has: win.locator(`span[title="${title}"]`) })
    .first()
  await row.click()
}

/** Wait for a real zsh prompt in the ACTIVE host (never just "non-empty"). */
async function waitForPrompt(win: Page): Promise<void> {
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 25_000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m)
}

/** Run a command in the active shell and return the screen text afterwards.
 *  `marker` is assembled shell-side so only OUTPUT can match it. */
async function runAndRead(win: Page, cmd: string, marker: string): Promise<string> {
  await waitForPrompt(win)
  await win.locator('.fl-term-host:not([hidden])').click()
  await win.keyboard.type(cmd)
  await win.keyboard.press('Enter')
  await expect
    .poll(async () => (await activeRows(win).innerText()) ?? '', { timeout: 20_000 })
    .toContain(marker)
  return (await activeRows(win).innerText()) ?? ''
}

/** `pwd` reported by the ACTIVE shell, un-echoable (assembled shell-side). */
async function shellCwd(win: Page): Promise<string> {
  const text = await runAndRead(win, `P=CWD; printf '%sMARK:%s\\n' "$P" "$(pwd)"`, 'CWDMARK:')
  const line = text
    .split('\n')
    .reverse()
    .find((l) => l.includes('CWDMARK:') && !l.includes('printf'))
  return (line ?? '').split('CWDMARK:')[1]?.trim() ?? ''
}

async function tabReport(
  win: Page,
): Promise<{ label: string; title: string; accent: string; active: boolean }[]> {
  return termTabs(win).evaluateAll((nodes) =>
    nodes.map((node) => {
      const el = node as HTMLElement
      const labelSpan = el.querySelector('span:not(.dirty-dot):not(.project-dot)')
      const dot = el.querySelector('.project-dot') as HTMLElement | null
      return {
        label: (labelSpan?.textContent ?? el.textContent ?? '').trim(),
        title: el.getAttribute('title') ?? '',
        accent: dot ? getComputedStyle(dot).backgroundColor : '',
        active: el.classList.contains('active'),
      }
    }),
  )
}

test.afterAll(() => cleanupSeeds())

test('multi-root thread: + offers a root picker and each pick spawns a shell IN that root', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const errors = trackErrors(window)

  const alpha = await seedProject(window, 'flow-tmr-alpha-')
  const beta = await seedProject(window, 'flow-tmr-beta-')
  await activateProject(window, alpha)
  await createThread(window, alpha, 'Terminal multi-root', [beta])
  await openThread(window, 'Terminal multi-root')
  await window.waitForTimeout(1500)

  console.log('ALPHA:', alpha)
  console.log('BETA:', beta)
  console.log('TABS(initial):', JSON.stringify(await tabReport(window)))

  // + is a user gesture under a 2-root scope → the "New terminal in:" picker.
  await newBtn(window).click()
  await expect(rootMenu(window)).toBeVisible({ timeout: 8000 })
  const rows = rootMenu(window).locator('.fl-term-root-item')
  console.log('MENU ROWS:', JSON.stringify(await rows.allInnerTexts()))
  console.log(
    'MENU TITLES:',
    JSON.stringify(await rows.evaluateAll((n) => n.map((e) => e.getAttribute('title')))),
  )
  await window.screenshot({ path: `${SCREENS}/terminal-multiroot-menu.png` })

  // GUARD — the picker names both attached roots, primary first, with the full
  // path as the tooltip (the only thing that tells two same-named repos apart).
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveText(alpha.split('/').pop() ?? '')
  await expect(rows.nth(1)).toHaveText(beta.split('/').pop() ?? '')
  expect(
    await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title'))),
  ).toEqual([alpha, beta])

  const before = await termTabs(window).count()

  // GUARD — picking the SECONDARY root spawns a shell whose cwd IS that root.
  // `pwd` is the only honest observable: the label follows OSC 7, so a shell in
  // the wrong repo would still be labelled with whatever folder it landed in.
  await rows.nth(1).click()
  await expect(rootMenu(window)).toHaveCount(0)
  await expect(termTabs(window)).toHaveCount(before + 1, { timeout: 20_000 })
  expect(await shellCwd(window)).toBe(beta)

  // GUARD — and the PRIMARY root, from the same menu, lands in alpha.
  await newBtn(window).click()
  await expect(rootMenu(window)).toBeVisible({ timeout: 8000 })
  await rootMenu(window).locator('.fl-term-root-item').nth(0).click()
  await expect(termTabs(window)).toHaveCount(before + 2, { timeout: 20_000 })
  expect(await shellCwd(window)).toBe(alpha)

  // GUARD — the two repos' tabs stay tellable apart: distinct labels, distinct
  // project tooltips, and distinct accent dots (the multi-root marker the
  // editor's tab strip does NOT carry once the scope drops a root — #1482).
  const report = await tabReport(window)
  console.log('TABS(both):', JSON.stringify(report, null, 2))
  await window.screenshot({ path: `${SCREENS}/terminal-multiroot-two-shells.png` })
  const alphaTab = report.find((tab) => tab.title === (alpha.split('/').pop() ?? ''))
  const betaTab = report.find((tab) => tab.title === (beta.split('/').pop() ?? ''))
  expect(alphaTab, `no alpha tab in ${JSON.stringify(report)}`).toBeTruthy()
  expect(betaTab, `no beta tab in ${JSON.stringify(report)}`).toBeTruthy()
  expect(alphaTab?.accent).not.toBe('')
  expect(betaTab?.accent).not.toBe('')
  expect(
    alphaTab?.accent,
    `both repos' terminal tabs carry the same accent: ${JSON.stringify(report)}`,
  ).not.toBe(betaTab?.accent)

  expect(errors, `uncaught errors during the multi-root terminal flow:\n${errors.join('\n')}`,
  ).toEqual([])
})

/**
 * The pane keystrokes go to, once there are two.
 *
 * `.fl-term-host:not([hidden])` matches BOTH panes after a split, so the
 * single-pane helpers above go strict-mode ambiguous. The panel marks the
 * focused one (`.focused`) precisely so "where do my keystrokes go" has a
 * visible answer; this reads the same mark.
 */
// ONE SELECTOR, NOT A LIST WITH A FALLBACK. A CSS selector list does not
// prioritise, so `.first()` over "focused, or any visible" returns whichever
// comes first in the DOM — which is the pane being split FROM, still holding
// its own output. The panel guarantees the mark once there are two panes.
const focusedRows = (win: Page) => win.locator('.fl-term-host.focused .xterm-rows')

async function focusedCwd(win: Page): Promise<string> {
  await expect
    .poll(async () => (await focusedRows(win).innerText()) ?? '', { timeout: 25_000 })
    .toMatch(/(?:[$%#>]\s*$)|(?:➜[^\n]*$)/m)
  await win.locator('.fl-term-host.focused').click()
  // THE BASENAME, NOT THE PATH. A split pane is half as wide, and a seeded
  // temp path wraps across two rows there — which truncates any single-line
  // read of it. The folder's name is the fact under test and it always fits.
  await win.keyboard.type(`P=CWD; printf '%sMARK:%s\\n' "$P" "$(basename "$(pwd)")"`)
  await win.keyboard.press('Enter')
  await expect
    .poll(async () => (await focusedRows(win).innerText()) ?? '', { timeout: 20_000 })
    .toContain('CWDMARK:')
  const text = (await focusedRows(win).innerText()) ?? ''
  const line = text
    .split('\n')
    .reverse()
    .find((l) => l.includes('CWDMARK:') && !l.includes('printf'))
  return (line ?? '').split('CWDMARK:')[1]?.trim() ?? ''
}

/**
 * SPLITTING INTO A DIFFERENT PROJECT.
 *
 * The split button took the anchor's project with no say in it, so a person
 * splitting to watch a backend beside a frontend got the same project twice and
 * had to move the tab afterwards (user, 2026-09-18: "probably they want to run,
 * for example, the backend on one side and the frontend on another").
 *
 * It asks wherever the + asks, and `pwd` is the only honest observable — a tab
 * label is a name somebody chose, while the shell's own directory is where the
 * command would actually run.
 */
test('multi-root thread: split offers the same picker, and the pane lands in the picked root', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const errors = trackErrors(window)

  const alpha = await seedProject(window, 'flow-tsplit-alpha-')
  const beta = await seedProject(window, 'flow-tsplit-beta-')
  await activateProject(window, alpha)
  await createThread(window, alpha, 'Split across projects', [beta])
  await openThread(window, 'Split across projects')

  // One terminal to split FROM, in alpha.
  await newBtn(window).click()
  await expect(rootMenu(window)).toBeVisible({ timeout: 20_000 })
  await rootMenu(window).locator('.fl-term-root-item', { hasText: 'flow-tsplit-alpha' }).first().click()
  await waitForPrompt(window)
  expect(await shellCwd(window)).toContain('flow-tsplit-alpha')

  // THE SPLIT ASKS. This is the whole change: it used to spawn immediately,
  // in the anchor's project.
  const splitBtn = window.locator('.fl-term-tool[aria-label="Split terminal"]')
  await splitBtn.click()
  await expect(rootMenu(window)).toBeVisible({ timeout: 20_000 })
  await expect(rootMenu(window)).toContainText('Split with:')
  // Both projects are offered — the anchor's included, because splitting into
  // the same project is still the common case.
  await expect(rootMenu(window).locator('.fl-term-root-item')).toHaveCount(2)

  await rootMenu(window).locator('.fl-term-root-item', { hasText: 'flow-tsplit-beta' }).first().click()

  // TWO PANES, and the new one is where it was asked to be. `pwd` in the
  // focused pane is the answer; the label is not.
  await expect(window.locator('.fl-term-host:not([hidden])')).toHaveCount(2, { timeout: 30_000 })
  expect(await focusedCwd(window)).toContain('flow-tsplit-beta')

  expect(errors, errors.join('\n')).toEqual([])
})
