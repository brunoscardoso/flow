import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { _electron as electron, type Page } from '@playwright/test'
import { resolve } from 'node:path'

/**
 * UX sweep — flow 8 (Terminal): the DOCKED PANEL HEIGHT the user drags.
 *
 * The terminal lives in the vertical `fl-split-editor-stack` (editor above,
 * terminal below, shell.ts:296). Dragging its gutter is the ordinary way to
 * give a build/test run more room, and every drag is persisted:
 * `fl-split-resize` → `state.splits['fl-split-editor-stack'] = getSizes()` →
 * `flow.shell.layout.v5` (shell.ts:513-518).
 *
 * Restoring it is the gap. `createSplit` applies stored sizes ONCE, at shell
 * construction, from a `state` that is still empty before the first project
 * hydrates; `hydrate()` re-applies only the ROOT arrangement, and
 * `reconcileEditorStack()` re-appends the terminal element without ever
 * re-applying sizes. So the height resets to 50/50 on hide/show, on a project
 * round-trip, and on relaunch — while the sibling root split (same store, same
 * gesture) restores correctly. See the tripwires below.
 *
 * Live guards here cover what DOES work, so the interaction itself stays
 * regression-tested: the drag resizes the panel AND reflows the live PTY grid
 * (rows follow — the #99 class of bug), and the drag is written to the store.
 *
 * Docked-visible by default (#674) — the shell is started with + rather than the
 * ⌃` toggle, which HIDES the docked panel (see terminal-resize.spec.ts).
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
// Layouts are persisted per SCOPE (a project root plus the thread on screen,
// thread-layout-store.ts) under this key; the per-root `flow.shell.layout.v5`
// record is read-only now — the migration fallback.
const LAYOUT_KEY = 'flow.shell.layout.scoped.v1'
const STACK_SPLIT = 'fl-split-editor-stack'

const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

async function ensureScopedShell(win: Page): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  await expect
    .poll(async () => ((await activeRows(win).innerText()) ?? '').trim().length, { timeout: 10000 })
    .toBeGreaterThan(0)
}

/** Live layout facts, read the way a user perceives them (panel height) plus the
 *  split's own fractions and what got persisted. */
async function stackState(win: Page) {
  return win.evaluate(
    ({ key, splitId }) => {
      const split = document.getElementById(splitId) as
        | (HTMLElement & { getSizes?(): number[] })
        | null
      const panel = document.querySelector('#fl-panel-terminal') as HTMLElement | null
      let persisted: number[] | null = null
      try {
        const entries = JSON.parse(window.localStorage.getItem(key) ?? 'null')?.entries ?? {}
        for (const entry of Object.values(entries)) {
          const splits =
            (entry as { value?: { splits?: Record<string, number[]> } }).value?.splits ?? {}
          if (splits[splitId]) persisted = splits[splitId]
        }
      } catch {
        persisted = null
      }
      return {
        sizes: split?.getSizes?.() ?? null,
        panelHeight: panel ? Math.round(panel.getBoundingClientRect().height) : -1,
        persisted,
      }
    },
    { key: LAYOUT_KEY, splitId: STACK_SPLIT },
  )
}

/** Rows currently rendered by xterm (the visible grid). */
const renderedRows = (win: Page) =>
  win.evaluate(
    () => document.querySelectorAll('.fl-term-host:not([hidden]) .xterm-rows > div').length,
  )

/** Ask the live PTY for its own grid — proves the shell was resized, not just
 *  the DOM (a mismatch is the #99 class: a corrupted grid under a resized box). */
async function ptyLines(win: Page, mark: string): Promise<number> {
  await activeHost(win).click()
  await win.keyboard.type(`echo ${mark}=$(tput lines)`)
  await win.keyboard.press('Enter')
  const pattern = new RegExp(`${mark}=(\\d+)`, 'g')
  let last = -1
  await expect
    .poll(
      async () => {
        const matches = [...((await activeRows(win).innerText()) ?? '').matchAll(pattern)]
        last = matches.length ? Number(matches[matches.length - 1][1]) : -1
        return last
      },
      { timeout: 10000 },
    )
    .toBeGreaterThan(0)
  return last
}

/** Drag the editor|terminal gutter (fl-split's open shadow root) by `dy` px.
 *  Negative dy makes the terminal taller. */
async function dragStackGutter(win: Page, dy: number): Promise<void> {
  const handle = win.locator(`#${STACK_SPLIT} .handle`).first()
  const box = await handle.boundingBox()
  expect(box, 'editor|terminal gutter must be draggable').not.toBeNull()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  await win.mouse.move(cx, cy)
  await win.mouse.down()
  await win.mouse.move(cx, cy + dy, { steps: 12 })
  await win.mouse.up()
  await win.waitForTimeout(500)
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

async function openSecondWindow(userDataDir: string) {
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if (await wizard.count()) {
    const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
    if (await skip.count()) await skip.first().click()
  }
  return { app, win }
}

test.afterAll(() => cleanupSeeds())

test.describe('terminal — docked panel height', () => {
  test('dragging the gutter resizes the panel AND reflows the live PTY grid', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await ensureScopedShell(window)

    const before = await stackState(window)
    const rowsBefore = await renderedRows(window)
    const ptyBefore = await ptyLines(window, 'GRID_BEFORE')
    expect(ptyBefore, 'the live PTY must match the rendered grid').toBe(rowsBefore)

    await dragStackGutter(window, -160)

    const after = await stackState(window)
    expect(after.panelHeight, 'dragging up must make the terminal taller').toBeGreaterThan(
      before.panelHeight + 60,
    )
    const rowsAfter = await renderedRows(window)
    expect(rowsAfter, 'a taller panel must render more rows').toBeGreaterThan(rowsBefore)
    // #99 guard: the shell itself must be resized, not just the box around it.
    expect(await ptyLines(window, 'GRID_AFTER'), 'the PTY grid must follow the drag').toBe(
      rowsAfter,
    )

    expect(errors, `uncaught errors while resizing:\n${errors.join('\n')}`).toEqual([])
  })

  test('the dragged height is written to the persisted layout store', async ({ window }) => {
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await ensureScopedShell(window)

    expect((await stackState(window)).sizes).toEqual([0.5, 0.5])
    await dragStackGutter(window, -160)

    const after = await stackState(window)
    expect(after.persisted, 'the drag must reach the persisted layout store').not.toBeNull()
    expect(after.persisted![1]).toBeCloseTo(after.sizes![1], 3)
    expect(after.persisted![1], 'terminal must own the larger share after dragging up').toBeGreaterThan(
      0.6,
    )
  })

  // ── #1059 guards — the persisted height is re-applied (applyStoredStackSizes
  //    in shell.ts: on reconcileEditorStack re-append and on hydrate), so the
  //    dragged height survives hide/show and a relaunch. ────────────────────

  test(
    'hiding and re-showing the terminal keeps the dragged height (#1059)',
    async ({ window }) => {
      const proj = await seedProject(window)
      await activateProject(window, proj)
      await ensureScopedShell(window)

      await dragStackGutter(window, -160)
      const dragged = await stackState(window)
      await window.screenshot({ path: `${SCREEN_DIR}/terminal-height-01-dragged.png` })

      await window.keyboard.press('Control+`') // hide
      await expect(window.locator('#fl-panel-terminal')).toHaveCount(0)
      await window.keyboard.press('Control+`') // show
      await ensureScopedShell(window)
      await window.waitForTimeout(500)

      const reshown = await stackState(window)
      await window.screenshot({ path: `${SCREEN_DIR}/terminal-height-02-reshown.png` })
      expect(reshown.panelHeight, 'the terminal must come back the height it was').toBe(
        dragged.panelHeight,
      )
    },
  )

  test(
    'relaunching restores the dragged terminal height, like the root split (#1059)',
    async ({ window, app, userDataDir }) => {
      const proj = await seedProject(window)
      await activateProject(window, proj)
      await ensureScopedShell(window)

      await dragStackGutter(window, -160)
      const dragged = await stackState(window)
      await app.close()

      const second = await openSecondWindow(userDataDir)
      try {
        await expect(second.win.locator('#fl-panel-terminal')).toBeVisible({ timeout: 20000 })
        await second.win.waitForTimeout(1500)
        const restored = await stackState(second.win)
        expect(restored.persisted, 'the store still holds the dragged fractions').not.toBeNull()
        expect(restored.sizes![1], 'the restored split must match what was persisted').toBeCloseTo(
          dragged.sizes![1],
          2,
        )
      } finally {
        await second.app.close()
      }
    },
  )
})
