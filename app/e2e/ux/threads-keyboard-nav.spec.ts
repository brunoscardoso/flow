/**
 * UX sweep — flow 2 (Threads), round 20: the sidebar's KEYBOARD path.
 *
 * `<fl-list>` advertises itself as "Keyboard-first: Up/Down move selection,
 * Enter/click activate" (components/fl-list.ts header). Every sibling flow-2
 * probe drives the sidebar with the mouse — create, search, rename, pin,
 * archive, delete, multi-select, the fold, the collapse channel — so nobody
 * had ever asked whether the flow is operable from the keyboard at all.
 *
 * Two defects fell out, both silent (zero `pageerror`s):
 *
 *  - #1172 — the "Search threads" box swallows ArrowDown/Enter. It handles
 *    ONLY Escape (thread-sidebar.ts ~142), so a query that narrows the list to
 *    one thread cannot be acted on: focus never leaves the input, the list
 *    cursor stays at -1, nothing opens. The Tab fallback needs 3 Tabs and then
 *    its first ArrowDown lands on the project GROUP HEADER, not a thread.
 *  - #1173 — the row ⋯ menu drops focus to <body> on open; arrows/Enter are
 *    dead and Tab walks the controls BEHIND the still-open popup.
 *
 * The contrast that makes both defects rather than "the app is mouse-first":
 * the ⌘P palette — same app, same threads, same FTS index — wires
 * ArrowDown/ArrowUp/Enter on its own input (palette/command-palette.ts
 * `#onInputKeydown`). Guard 2 pins that working behaviour down.
 *
 * Credential-free: threads.create is immediate IPC, no agent involved.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'
const TITLES = ['alpha one', 'beta two', 'gamma three']

function sidebarList(win: Page) {
  return win.locator('.fl-thread-list fl-list')
}
function searchBox(win: Page) {
  return win.locator('input[aria-label="Search threads"]')
}
function threadRow(win: Page, title: string) {
  return sidebarList(win).getByText(title, { exact: true })
}
function composer(win: Page) {
  return win.locator('.fl-composer')
}

/** The list's keyboard cursor + which row the OPEN thread is, read out of
 *  fl-list's shadow root (the rows are invisible to innerText). */
async function listState(win: Page): Promise<{
  selectedIndex: number
  cursorRow: string | null
  openTitles: string[]
}> {
  return sidebarList(win).evaluate((el) => {
    const list = el as unknown as { selectedIndex: number }
    const shadow = (el as Element).shadowRoot
    const rows = shadow ? Array.from(shadow.querySelectorAll('.row')) : []
    const titleOf = (row: Element): string | null => {
      const span = Array.from(row.querySelectorAll('span')).find((s) =>
        /^(alpha|beta|gamma) /.test(s.textContent ?? ''),
      )
      return span?.textContent ?? null
    }
    const cursor = rows.findIndex((r) => r.classList.contains('selected'))
    return {
      selectedIndex: list.selectedIndex,
      // Group/archived/more headers have no thread title — null marks them.
      cursorRow: cursor >= 0 ? (titleOf(rows[cursor]) ?? '(header row)') : null,
      // The active thread is the bold one (font-weight 500 vs 400).
      openTitles: rows
        .map((r) => {
          const span = Array.from(r.querySelectorAll('span')).find((s) =>
            /^(alpha|beta|gamma) /.test(s.textContent ?? ''),
          )
          return span && getComputedStyle(span).fontWeight === '500' ? span.textContent : null
        })
        .filter((t): t is string => t !== null),
    }
  })
}

/** The really-focused element, walked through shadow roots. */
async function focusedTag(win: Page): Promise<string> {
  return win.evaluate(() => {
    const walk = (root: Document | ShadowRoot): Element | null => {
      const a = root.activeElement
      if (!a) return null
      const sr = (a as HTMLElement).shadowRoot
      return sr && sr.activeElement ? walk(sr) : a
    }
    const a = walk(document)
    if (!a) return '(none)'
    const aria = a.getAttribute('aria-label')
    return aria ? `${a.tagName.toLowerCase()}[${aria}]` : a.tagName.toLowerCase()
  })
}

async function seedThreads(win: Page): Promise<string> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  for (const title of TITLES) {
    await win.evaluate(
      async ({ root, title }: { root: string; title: string }) => {
        const flow = (
          window as unknown as {
            flow: {
              threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> }
            }
          }
        ).flow
        await flow.threads.create({ projectRoot: root, title })
      },
      { root: dir, title },
    )
    await win.waitForTimeout(60)
  }
  await expect(threadRow(win, 'gamma three')).toBeVisible({ timeout: 10000 })
  // The per-project flow-settings overlay can land late and swallow input.
  await dismissFlowOverlay(win)
  return dir
}

test.afterAll(() => cleanupSeeds())

test('the focused thread list moves by arrow keys and opens the cursor row on Enter', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedThreads(window)
  await expect(composer(window)).toBeHidden()

  // Focus the list itself — it is tabindex=0 (fl-list connectedCallback).
  await sidebarList(window).evaluate((el) => (el as HTMLElement).focus())
  await expect.poll(() => focusedTag(window), { timeout: 5000 }).toBe('fl-list')

  // The list is flat since the Workspaces sidebar (no project group header), so
  // the first ArrowDown lands on the newest thread and a second walks down.
  await window.keyboard.press('ArrowDown')
  await expect.poll(async () => (await listState(window)).cursorRow, { timeout: 5000 }).toBe(
    'gamma three',
  )
  await window.keyboard.press('ArrowDown')
  await expect.poll(async () => (await listState(window)).cursorRow, { timeout: 5000 }).toBe(
    'beta two',
  )

  // Enter opens exactly the cursor row: it goes bold and the composer binds.
  await window.keyboard.press('Enter')
  await expect(composer(window)).toBeVisible({ timeout: 10000 })
  await expect.poll(async () => (await listState(window)).openTitles, { timeout: 8000 }).toEqual([
    'beta two',
  ])

  expect(errors, errors.join(', ')).toEqual([])
})

test('CONTRAST: the ⌘P palette input drives its results by keyboard and opens the thread', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedThreads(window)
  await expect(composer(window)).toBeHidden()

  const panel = window.locator('.fl-palette-panel')
  await window.keyboard.press('ControlOrMeta+p')
  await expect(panel).toBeVisible({ timeout: 10000 })
  await panel.locator('.fl-palette-input').fill('beta two')
  await expect(window.locator('.fl-palette-row', { hasText: 'beta two' })).toBeVisible({
    timeout: 10000,
  })

  // The same three keystrokes that are dead in the sidebar search box.
  await window.keyboard.press('ArrowDown')
  await window.keyboard.press('Enter')

  await expect(panel).toBeHidden({ timeout: 10000 })
  await expect(composer(window)).toBeVisible({ timeout: 10000 })
  await expect.poll(async () => (await listState(window)).openTitles, { timeout: 10000 }).toEqual([
    'beta two',
  ])

  expect(errors, errors.join(', ')).toEqual([])
})

test(
  'the search box must act on its own results — ArrowDown/Enter open the single match (#1172)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await seedThreads(window)

    // Narrow the list to exactly one thread.
    await searchBox(window).click()
    await searchBox(window).fill('beta')
    await expect(threadRow(window, 'beta two')).toBeVisible({ timeout: 10000 })
    await expect(threadRow(window, 'alpha one')).toHaveCount(0)

    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('Enter')
    await window.screenshot({ path: `${SCREENS}/threads-search-keyboard-dead.png` })

    // Today: focus never leaves the input, selectedIndex stays -1, nothing opens.
    await expect(composer(window)).toBeVisible({ timeout: 8000 })
    await expect.poll(async () => (await listState(window)).openTitles, { timeout: 8000 }).toEqual([
      'beta two',
    ])

    expect(errors, errors.join(', ')).toEqual([])
  },
)

test(
  'the row menu must take focus and respond to arrows/Enter (#1173)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await seedThreads(window)

    // The row's ⋯ column was retired (2026-09-04); its menu is the right-click.
    await threadRow(window, 'gamma three').first().click({ button: 'right' })
    const menu = window.locator('.fl-thread-menu')
    await expect(menu).toBeVisible({ timeout: 5000 })
    await window.screenshot({ path: `${SCREENS}/threads-rowmenu-keyboard-dead.png` })

    // Today: focus is on <body>, so this is 'body'.
    await expect.poll(() => focusedTag(window), { timeout: 5000 }).toBe('button')

    // ArrowDown → Rename, Enter → the inline rename field appears.
    await window.keyboard.press('ArrowDown')
    await window.keyboard.press('Enter')
    await expect(menu.locator('input[aria-label="Thread name"]')).toBeVisible({ timeout: 5000 })

    expect(errors, errors.join(', ')).toEqual([])
  },
)
