import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4 (conversation), round 25: the full-size image viewer
 * (`.fl-image-viewer`, added by #1138) versus the app's SHARED MODAL GUARD.
 *
 * `modal-overlay.ts` exists because this exact bug kept recurring on new
 * surfaces: #525 (flow-settings), #1002 (tasks-board modals), #1006 (first-run
 * wizard), #1198 (⌘W through a dialog). Its fix was "a convention set at
 * creation" — an overlay calls `markModalOverlay()`, and three guards then ask
 * the registry rather than a class list:
 *
 *   shell.ts:721            global panel shortcuts (⌃`, ⌘B, …) go inert
 *   terminal-panel.ts:811   the terminal will not steal focus
 *   overlay-focus-trap.ts   Tab is contained inside the overlay
 *
 * The image viewer declares `role="dialog"` + `aria-modal="true"` — it is the
 * ONLY element in the renderer that does — and calls none of them. So the
 * guards do not see it and every #525 symptom is live again on a surface a
 * reader reaches with one click on their own screenshot.
 *
 * Guards (LIVE, green — chosen so no tripwire below can pass vacuously):
 *  - MECHANISM: a *marked* overlay (the ⌘⇧P command palette) really does
 *    register, really does make ⌃` inert, and really does contain Tab. The
 *    isolation works; the viewer is the surface that opted out.
 *  - VIEWER OPENS: the #1138 contract still holds — a transcript thumbnail
 *    opens the overlay and Escape closes it, returning focus to the thumbnail.
 *
 * Guards (LIVE since #1430's fix — the viewer now calls `markModalOverlay()`):
 *  - the open viewer is a registered modal overlay,
 *  - ⌃` behind it neither opens a terminal nor hands it the keyboard,
 *  - Tab stays inside it,
 *  - ⌘B does not drop the sidebar behind it.
 */

const SCREENS = 'e2e/ux/__screens'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

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

async function persistedAttachmentCount(win: Page, threadId: string): Promise<number> {
  return win.evaluate(async (id) => {
    const rows = (await (
      window as unknown as {
        flow: { messages: { list(i: { threadId: string }): Promise<{ attachments?: unknown[] }[]> } }
      }
    ).flow.messages.list({ threadId: id })) as { attachments?: unknown[] }[]
    return rows.reduce((n, r) => n + (r.attachments?.length ?? 0), 0)
  }, threadId)
}

interface Shape {
  viewerOpen: boolean
  markedModals: number
  viewerMarked: boolean | null
  termRoots: number
  activeClass: string | null
  activeInViewer: boolean | null
  activeInTerm: boolean
  sidebarPresent: boolean
}

async function shape(win: Page): Promise<Shape> {
  return win.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    const overlay = document.querySelector('.fl-image-viewer') as HTMLElement | null
    return {
      viewerOpen: overlay !== null,
      markedModals: document.querySelectorAll('[data-fl-modal]:not([hidden])').length,
      viewerMarked: overlay?.hasAttribute('data-fl-modal') ?? null,
      termRoots: document.querySelectorAll('.fl-term-root').length,
      activeClass: active?.className?.toString().slice(0, 60) ?? null,
      activeInViewer: overlay !== null && active !== null ? overlay.contains(active) : null,
      activeInTerm: active?.closest('.fl-term-root') != null,
      sidebarPresent: document.querySelector('.fl-thread-sidebar') !== null,
    }
  })
}

/** Text the PTY has actually echoed — the destructive end of a stolen keyboard. */
async function terminalTail(win: Page): Promise<string> {
  return win.evaluate(() => {
    const rows = document.querySelector('.fl-term-root .xterm-rows') as HTMLElement | null
    return (rows?.innerText ?? '').replace(/\s+/g, ' ')
  })
}

/** Seed a project + thread carrying one real image attachment, and open the
 *  full-size viewer from its transcript thumbnail. */
async function openViewerFromTranscript(win: Page, title: string, file: string): Promise<void> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.composer)).toBeVisible()

  const shot = join(tmpdir(), file)
  await win.screenshot({ path: shot })
  await win.locator(`${sel.composer} input[type="file"]`).setInputFiles([shot])
  await expect(win.locator('.fl-composer-attachment')).toHaveCount(1, { timeout: 5000 })
  // No Claude account needed: sendMessage persists message + attachments before
  // it ever reaches ensureSession(), so the history row is real either way.
  await win.locator(`${sel.composer} textarea`).press('Enter')
  await expect.poll(() => persistedAttachmentCount(win, threadId), { timeout: 20_000 }).toBe(1)

  // The project may auto-start a docked terminal during activation. The modal
  // guards are only measurable from a known state, and ⌃` is (correctly) inert
  // once the viewer owns the keyboard — so hide it BEFORE opening the viewer.
  if ((await win.locator('.fl-term-root').count()) > 0) {
    await win.keyboard.press('Control+`')
    await expect.poll(() => win.locator('.fl-term-root').count()).toBe(0)
  }

  const thumb = win.locator('.fl-conv-attachments .fl-conv-attachment-thumb').first()
  await expect(thumb).toBeVisible({ timeout: 15_000 })
  await thumb.click()
  await expect(win.locator('.fl-image-viewer')).toBeVisible({ timeout: 5000 })
}

test.afterAll(() => cleanupSeeds())

// ── LIVE GUARD 1 — the isolation mechanism really works on a MARKED overlay ──
test('a marked modal overlay really does isolate the keyboard', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await createThread(window, dir, 'Palette mechanism')
  await window.getByText('Palette mechanism', { exact: true }).first().click()
  await expect(window.locator(sel.composer)).toBeVisible()

  await window.keyboard.press(`${MOD}+Shift+p`)
  await expect(window.locator('.fl-palette-panel')).toBeVisible({ timeout: 5000 })

  const open = await shape(window)
  expect(open.markedModals, 'the palette registers itself as a modal overlay').toBeGreaterThan(0)

  const termsBefore = open.termRoots
  await window.keyboard.press('Control+`')
  await window.waitForTimeout(1200)
  const afterToggle = await shape(window)
  // The whole point of the registry: a marked overlay owns the keyboard.
  expect(afterToggle.termRoots, '⌃` is inert behind a marked overlay').toBe(termsBefore)
  expect(afterToggle.activeInTerm, 'the terminal does not take focus').toBe(false)

  // (The palette overlay is kept in the DOM and toggled `hidden`, like the
  // settings family — so assert visibility, not element count.)
  await window.keyboard.press('Escape')
  await expect(window.locator('.fl-palette-panel')).toBeHidden({ timeout: 5000 })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// ── LIVE GUARD 2 — #1138's own contract still holds ─────────────────────────
test('a transcript thumbnail opens the full-size viewer, Escape closes it', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openViewerFromTranscript(window, 'Viewer contract', 'flow-viewer-contract.png')
  const open = await shape(window)
  expect(open.activeInViewer, 'the overlay takes focus so Escape reaches it').toBe(true)
  await window.screenshot({ path: `${SCREENS}/conv-image-viewer-open.png` })

  await window.keyboard.press('Escape')
  await expect(window.locator('.fl-image-viewer')).toHaveCount(0, { timeout: 5000 })
  const closed = await shape(window)
  expect(closed.activeClass, 'focus returns to the thumbnail').toContain(
    'fl-conv-attachment-thumb',
  )
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// ── GUARD 3 — the viewer joins the registry (#1430) ─────────────────────────
test('the open image viewer is a registered modal overlay', async ({ window }) => {
  await openViewerFromTranscript(window, 'Viewer registry', 'flow-viewer-registry.png')
  const open = await shape(window)
  expect(
    open.viewerMarked,
    'the viewer declares aria-modal="true" but never calls markModalOverlay(), so no guard can see it',
  ).toBe(true)
})

// ── GUARD 4 — ⌃` must not open a terminal behind the backdrop nor hand it the
//    keyboard; typed text must never reach a shell prompt (#525/#1002/#1430)
test('⌃` behind the image viewer neither opens a terminal nor takes the keyboard', async ({
  window,
}) => {
  // The helper leaves the docked terminal hidden, so ⌃` behind the overlay is
  // an OPEN — the destructive direction (#1002's stolen-keyboard shape).
  await openViewerFromTranscript(window, 'Viewer terminal', 'flow-viewer-terminal.png')
  expect((await shape(window)).termRoots).toBe(0)

  await window.keyboard.press('Control+`')
  await window.waitForTimeout(2500)
  const after = await shape(window)
  await window.screenshot({ path: `${SCREENS}/conv-image-viewer-terminal-behind.png` })

  expect(after.termRoots, '⌃` opened a terminal behind an opaque backdrop').toBe(0)
  expect(after.activeInTerm, 'xterm took the keyboard from the overlay').toBe(false)

  await window.keyboard.type('echo pwned')
  await window.waitForTimeout(800)
  expect(
    await terminalTail(window),
    'what the reader typed at a full-screen image reached the shell prompt',
  ).not.toContain('echo pwned')
})

// ── GUARD 5 — Tab is contained inside the aria-modal overlay (#1430) ────────
test('Tab stays inside the image viewer', async ({ window }) => {
  await openViewerFromTranscript(window, 'Viewer tab', 'flow-viewer-tab.png')

  const escaped: string[] = []
  for (let i = 0; i < 4; i++) {
    await window.keyboard.press('Tab')
    await window.waitForTimeout(120)
    const s = await shape(window)
    if (s.activeInViewer === false) escaped.push(s.activeClass ?? '<none>')
  }
  await window.screenshot({ path: `${SCREENS}/conv-image-viewer-tab-escape.png` })
  expect(
    escaped,
    'focus left the overlay onto controls hidden behind its backdrop',
  ).toEqual([])
})

// ── GUARD 6 — ⌘B must not mutate the layout behind the backdrop (#1430) ─────
test('⌘B does not drop the sidebar behind the image viewer', async ({ window }) => {
  await openViewerFromTranscript(window, 'Viewer sidebar', 'flow-viewer-sidebar.png')
  expect((await shape(window)).sidebarPresent).toBe(true)

  await window.keyboard.press(`${MOD}+b`)
  await window.waitForTimeout(800)
  const after = await shape(window)
  await window.screenshot({ path: `${SCREENS}/conv-image-viewer-sidebar-behind.png` })
  expect(after.sidebarPresent, '⌘B leaked through the overlay and collapsed the sidebar').toBe(true)
})
