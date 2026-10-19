/**
 * UX regression probe — flow 2 (Threads sidebar), round 21.
 *
 * Flow 2 is the most-swept flow in the rotation (36 committed specs: search,
 * archive, rename, pin/unpin, overflow, collapsed groups, multi-select,
 * keyboard nav, the multi-project new-thread chooser, selection-follows-project,
 * relaunch restore…). Every one of them drives the THREAD rows. Nobody had
 * driven the sidebar's other half — the project group header's `⋯` menu, which
 * is where a project is reordered, recolored and removed.
 *
 * This probe drives the two un-probed verbs there:
 *
 *  1. **Move to top / up / down / bottom** — does the reorder land, does the
 *     titlebar switcher (the app's OTHER project list) agree with it, and is the
 *     first/last gating honest? All green; kept as the guard.
 *
 *  2. **Project color…** — the accent picker added 2026-07-28. The picked color
 *     persists and repaints correctly *when the open thread spans 2+ projects*
 *     (guard below). But EVERY consumer of the accent is gated on a multi-root
 *     scope — the file tree's section headers ("Section header row for a
 *     multi-root scope"), the git panel's group heads, the terminal tab dot
 *     ("Multi-root scope only … Single-root scope: no dot"), the editor tab dot
 *     ("Empty for single-root scopes") and the pending-changes strip's root
 *     header ("rendered only when the listing spans more than one root") — while
 *     the menu item itself is offered on EVERY known root, unconditionally. With
 *     an ordinary single-project thread open, picking a color paints nothing
 *     anywhere and reports nothing: the only trace is a ✓ that appears if the
 *     user reopens the same popover. That's the tripwire.
 *
 * Credential-free: every verb here is immediate IPC.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { basename, join } from 'node:path'
import { writeFileSync } from 'node:fs'

const SCREENS = 'e2e/ux/__screens'

/** The magenta swatch (index 3 of the curated pastel palette) — deliberately
 *  far from every hash accent the seeded temp roots can land on. */
const PICKED = '#e3aed6'
const PICKED_RGB = 'rgb(227, 174, 214)'

test.afterAll(() => cleanupSeeds())

// ── harness ────────────────────────────────────────────────────────────────

/** `fl-list` renders its rows inside an OPEN shadow root, so a plain
 *  `document.querySelectorAll` finds nothing. Install a shadow-piercing query
 *  on `window` so later `evaluate` calls can traverse (Playwright locators
 *  pierce, but DOM-order + parentElement walks need real JS). */
async function installDeepQuery(win: Page): Promise<void> {
  await win.evaluate(() => {
    ;(window as unknown as { __dq: (s: string) => Element[] }).__dq = (sel: string): Element[] => {
      const out: Element[] = []
      const walk = (root: Document | ShadowRoot): void => {
        out.push(...Array.from(root.querySelectorAll(sel)))
        root.querySelectorAll('*').forEach((el) => {
          if (el.shadowRoot) walk(el.shadowRoot)
        })
      }
      walk(document)
      return out
    }
  })
}

/** Project group headers in RENDERED order. Each group carries exactly one
 *  ⋯ "Project actions" button, so that button identifies the group. */
async function groupOrder(win: Page): Promise<string[]> {
  await installDeepQuery(win)
  return win.evaluate(() =>
    (window as unknown as { __dq: (s: string) => Element[] })
      .__dq('button[aria-label="Project actions"]')
      .map((btn) => (btn.parentElement?.querySelector('span')?.textContent ?? '').trim()),
  )
}

/** `fl-list` recycles rows, so a handle can detach between the lookup and the
 *  click (a rail switch or a roots broadcast re-renders underneath). Re-resolve
 *  and retry rather than treating that race as a finding. */
async function openProjectMenu(win: Page, label: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await installDeepQuery(win)
    const handle = await win.evaluateHandle(
      (wanted) =>
        (window as unknown as { __dq: (s: string) => Element[] })
          .__dq('button[aria-label="Project actions"]')
          .find((b) => (b.parentElement?.querySelector('span')?.textContent ?? '').trim() === wanted) ??
        null,
      label,
    )
    const el = handle.asElement()
    if (el) {
      try {
        // The ⋯ is hover-dimmed (opacity 0.4) but always mounted and hit-testable.
        await el.click({ force: true })
        await expect(win.locator('.fl-thread-menu')).toBeVisible({ timeout: 3000 })
        return
      } catch (error) {
        lastError = error
      }
    }
    await win.waitForTimeout(400)
  }
  throw lastError ?? new Error(`no project group header for ${label}`)
}

async function menuItems(win: Page): Promise<Array<{ text: string; disabled: boolean }>> {
  await installDeepQuery(win)
  return win.evaluate(() =>
    (window as unknown as { __dq: (s: string) => Element[] })
      .__dq('.fl-thread-menu .fl-thread-menu-item')
      .map((el) => ({
        text: (el.textContent ?? '').trim(),
        disabled: (el as HTMLButtonElement).disabled,
      })),
  )
}

/** Open `<project> ⋯ → Project color…` and click a swatch (or "Auto"). */
async function pickColor(win: Page, label: string, swatch: number | 'auto'): Promise<void> {
  await openProjectMenu(win, label)
  await win.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Project color' }).click()
  await expect(win.locator('.fl-accent-swatch').first()).toBeVisible({ timeout: 3000 })
  if (swatch === 'auto') {
    await win.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Auto' }).click()
  } else {
    await win.locator('.fl-accent-swatch').nth(swatch).click()
  }
  await win.waitForTimeout(800)
}

async function rail(win: Page, name: string): Promise<void> {
  await win.locator(`.fl-rail-item[aria-label="${name}"]`).first().click()
  await win.waitForTimeout(900)
}

/** Every surface the project accent is allowed to reach, plus any toast — the
 *  full set of places a user could SEE that their pick landed. */
async function visibleAccentSurfaces(win: Page): Promise<{
  borders: Array<{ text: string; color: string }>
  gitHeads: Array<{ text: string; color: string }>
  dots: string[]
  toasts: string[]
}> {
  await installDeepQuery(win)
  return win.evaluate(() => {
    const w = window as unknown as { __dq: (s: string) => Element[] }
    const visible = (el: Element): boolean => (el as HTMLElement).checkVisibility?.() !== false
    return {
      borders: w
        .__dq('span, div')
        .filter((el) => visible(el) && getComputedStyle(el).borderLeftWidth === '3px')
        .map((el) => ({
          text: (el.textContent ?? '').trim().slice(0, 40),
          color: getComputedStyle(el).borderLeftColor,
        })),
      gitHeads: w.__dq('.gp-group-head').map((el) => ({
        text: (el.textContent ?? '').trim().slice(0, 40),
        color: getComputedStyle(el).borderLeftColor,
      })),
      dots: w
        .__dq('.fl-term-root-dot, .fl-tab-accent, [class*="accent-dot"]')
        .filter(visible)
        .map((el) => getComputedStyle(el).backgroundColor),
      toasts: w
        .__dq('.fl-toast, .fl-notification, [class*="toast"]')
        .filter(visible)
        .map((el) => (el.textContent ?? '').trim())
        .filter(Boolean),
    }
  })
}

/** Titlebar project switcher rows, in order (the app's OTHER project list). */
async function switcherOrder(win: Page): Promise<string[]> {
  await win.locator('.fl-project-current').click()
  await expect(win.locator('.fl-project-menu')).toBeVisible({ timeout: 3000 })
  const items = await win.locator('.fl-project-menu .fl-project-item').allTextContents()
  await win.keyboard.press('Escape')
  return items.map((t) => t.replace('unavailable', '').trim()).filter((t) => !t.startsWith('+'))
}

/** Create a thread over exactly the given number of the open projects. With 2+
 *  roots the "+" opens the multi-project chooser (#45/#131). */
async function newThread(win: Page, spanAll: boolean): Promise<void> {
  await win.locator('fl-button[aria-label="New thread"]').click()
  await expect(win.getByText('Projects for this thread', { exact: true })).toBeVisible({
    timeout: 5000,
  })
  const boxes = win.locator('input[type="checkbox"]')
  const n = await boxes.count()
  for (let i = 0; i < n; i++) {
    const box = boxes.nth(i)
    if (spanAll && !(await box.isChecked())) await box.check()
  }
  await win.getByRole('button', { name: 'Start thread' }).click()
  await win.waitForTimeout(1500)
}

// ── 1. project reorder (live guard) ────────────────────────────────────────

// FIXME(project menu): the per-project ⋯ "Project actions" button left the
// sidebar with the flat Workspace list (6249e622). The project menu is now asked
// for from the Workspace switcher's project row, which this harness cannot reach
// yet — so this guard waits for a way in rather than being rewritten to a
// different surface.
test.fixme('project ⋯ reorder lands, gates first/last honestly, and the titlebar switcher agrees', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-ord-a-')
  const dirB = await seedProject(window, 'flow-ux-ord-b-')
  const dirC = await seedProject(window, 'flow-ux-ord-c-')
  await activateProject(window, dirA)
  const [a, b, c] = [dirA, dirB, dirC].map((d) => basename(d))

  await expect.poll(() => groupOrder(window), { timeout: 15000 }).toEqual([a, b, c])
  expect(await switcherOrder(window)).toEqual([a, b, c])

  // LAST project: down/bottom are gated off, top/up are live.
  await openProjectMenu(window, c)
  const last = await menuItems(window)
  const gate = (items: typeof last, label: string): boolean =>
    items.find((i) => i.text === label)?.disabled ?? false
  expect(gate(last, 'Move to top')).toBe(false)
  expect(gate(last, 'Move down')).toBe(true)
  expect(gate(last, 'Move to bottom')).toBe(true)

  await window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Move to top' }).click()
  await expect.poll(() => groupOrder(window), { timeout: 5000 }).toEqual([c, a, b])

  // Now FIRST: top/up gated off, and the switcher followed the sidebar.
  await openProjectMenu(window, c)
  const first = await menuItems(window)
  expect(gate(first, 'Move to top')).toBe(true)
  expect(gate(first, 'Move up')).toBe(true)
  expect(gate(first, 'Move down')).toBe(false)

  await window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Move down' }).click()
  await expect.poll(() => groupOrder(window), { timeout: 5000 }).toEqual([a, c, b])
  expect(await switcherOrder(window)).toEqual([a, c, b])

  await window.screenshot({ path: `${SCREENS}/threads-project-reorder.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// ── 2. accent picker, MULTI-root thread (live guard) ───────────────────────

// FIXME(project menu): the per-project ⋯ "Project actions" button left the
// sidebar with the flat Workspace list (6249e622). The project menu is now asked
// for from the Workspace switcher's project row, which this harness cannot reach
// yet — so this guard waits for a way in rather than being rewritten to a
// different surface.
test.fixme('multi-root thread: a picked project color repaints the tree + git section headers, Auto clears it', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-mr-a-')
  const dirB = await seedProject(window, 'flow-ux-mr-b-')
  writeFileSync(join(dirA, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dirB, 'b.ts'), 'export const b = 1\n')
  await activateProject(window, dirA)
  const a = basename(dirA)

  await newThread(window, true)
  await rail(window, 'Files')

  const before = await visibleAccentSurfaces(window)
  // A multi-root scope DOES render per-project section headers with a 3px accent border.
  expect(before.borders.some((row) => row.text.startsWith(a))).toBe(true)
  const hashColor = before.borders.find((row) => row.text.startsWith(a))?.color
  expect(hashColor).not.toBe(PICKED_RGB)

  await rail(window, 'Threads')
  await pickColor(window, a, 3)

  await rail(window, 'Files')
  await expect
    .poll(async () => (await visibleAccentSurfaces(window)).borders.find((r) => r.text.startsWith(a))?.color, {
      timeout: 5000,
    })
    .toBe(PICKED_RGB)

  await rail(window, 'Source Control')
  await expect
    .poll(async () => (await visibleAccentSurfaces(window)).gitHeads.find((r) => r.text.startsWith(a))?.color, {
      timeout: 8000,
    })
    .toBe(PICKED_RGB)
  await window.screenshot({ path: `${SCREENS}/threads-project-color-multiroot.png` })

  // The picker reflects the choice, and Auto clears back to the hash accent.
  await rail(window, 'Threads')
  await openProjectMenu(window, a)
  await window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Project color' }).click()
  await expect(window.locator('.fl-accent-swatch.selected')).toHaveCount(1)
  expect(await window.locator('.fl-accent-swatch.selected').getAttribute('title')).toBe(PICKED)
  await window.locator('.fl-thread-menu .fl-thread-menu-item', { hasText: 'Auto' }).click()

  await rail(window, 'Files')
  await expect
    .poll(async () => (await visibleAccentSurfaces(window)).borders.find((r) => r.text.startsWith(a))?.color, {
      timeout: 5000,
    })
    .toBe(hashColor)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// ── 3. accent picker, SINGLE-root thread — the tripwire ────────────────────

// FIXME(project menu): the per-project ⋯ "Project actions" button left the
// sidebar with the flat Workspace list (6249e622). The project menu is now asked
// for from the Workspace switcher's project row, which this harness cannot reach
// yet — so this guard waits for a way in rather than being rewritten to a
// different surface.
test.fixme('single-root thread: picking a project color must be visible SOMEWHERE', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-sr-a-')
  const dirB = await seedProject(window, 'flow-ux-sr-b-')
  writeFileSync(join(dirA, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dirB, 'b.ts'), 'export const b = 1\n')
  await activateProject(window, dirA)
  const a = basename(dirA)

  // The ordinary case: a thread on ONE project (the chooser's preselection).
  await newThread(window, false)

  await pickColor(window, a, 3)
  await window.screenshot({ path: `${SCREENS}/threads-project-color-singleroot.png` })

  // LIVE FACT (holds either way): the pick IS persisted — this is a rendering /
  // feedback gap, not a lost setting.
  const persisted = await window.evaluate(async (root) => {
    const roots = await (
      window as unknown as {
        flow: { project: { list(): Promise<Array<{ rootPath: string; accentColor?: string | null }>> } }
      }
    ).flow.project.list()
    return roots.find((r) => r.rootPath === root)?.accentColor ?? null
  }, dirA)
  expect(persisted).toBe(PICKED)

  // #1211 (fixed): every accent CONSUMER is still multi-root-only by design, so
  // the pick now confirms itself with a toast that also says where the colour
  // will show — rather than painting nothing and reporting nothing.

  // Fix-agnostic: SOME visible surface — in the sidebar where the pick was made,
  // in the file tree, in the git panel, or a confirmation toast — must carry the
  // colour the user just chose.
  const seenIn = async (): Promise<string[]> => {
    const out: string[] = []
    for (const name of ['Threads', 'Files', 'Source Control']) {
      await rail(window, name)
      const s = await visibleAccentSurfaces(window)
      if (s.borders.some((r) => r.color === PICKED_RGB)) out.push(`${name}:border`)
      if (s.gitHeads.some((r) => r.color === PICKED_RGB)) out.push(`${name}:git-head`)
      if (s.dots.includes(PICKED_RGB)) out.push(`${name}:dot`)
      if (s.toasts.length) out.push(`${name}:toast(${s.toasts.join('|')})`)
    }
    return out
  }
  expect(await seenIn(), 'the picked project color appears on no visible surface').not.toHaveLength(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
