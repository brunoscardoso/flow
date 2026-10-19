import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 8 (Terminal): the OVERFLOWED tab strip.
 *
 * Every prior flow-8 round drove a single shell or two (open/run/close/switch,
 * resize, scoping, theme, cwd title, rename, exit recovery, background drain).
 * None ever opened enough terminals to overflow the strip — yet a shared
 * `fl-tabs` strip is only ~700px wide in the docked panel and each tab is ~190px,
 * so a 4th terminal already pushes the first one off-screen.
 *
 * Live guards here (must stay green):
 *   1. With 8 terminals the strip really is a horizontal scroller, and the
 *      ACTIVE tab is always scrolled into view — the #700 guarantee.
 *   2. Clicking a visible tab activates THAT shell (content follows selection),
 *      with no uncaught errors.
 *
 * Former tripwires, now live guards (fixed):
 *   A. #993 — the strip's scroll position survives ~3s of idle. fl-tabs now
 *      plans none/patch/rebuild via planStripUpdate: background label churn
 *      patches tab DOM in place, rebuilds preserve scrollLeft, and
 *      #scrollActiveIntoView (#700) runs ONLY when the active tab changes.
 *   B. #994 — a plain vertical mouse wheel over the strip scrolls it: the
 *      strip translates deltaY → scrollLeft (with `overflow-y: hidden` so
 *      Blink's orthogonal fallback isn't blocked), and the scrollbar is
 *      thin-but-visible (`scrollbar-width: thin`) for discoverability.
 *
 * Docked-visible by default (terminalVisible defaults on, shell.ts) — start
 * shells with + and never toggle-to-open, per terminal-resize.spec.ts.
 */

const SCREEN_DIR = 'e2e/ux/__screens'
const TAB_COUNT = 8

const activeHost = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const activeRows = (win: Page) => activeHost(win).locator('.xterm-rows')
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')
const newBtn = (win: Page) => win.locator('.fl-term-tool[aria-label="New terminal"]')

/** One atomic read of the strip's scroll geometry (it lives in fl-tabs' open shadow root). */
const stripState = (win: Page) =>
  win.evaluate(() => {
    const host = document.querySelector('.fl-term-tabs') as HTMLElement | null
    const strip = host?.shadowRoot?.querySelector('.strip') as HTMLElement | null
    const cs = strip ? getComputedStyle(strip) : null
    const tabs = [...(strip?.querySelectorAll('.tab') ?? [])] as HTMLElement[]
    const stripRect = strip?.getBoundingClientRect()
    return {
      scrollLeft: Math.round(strip?.scrollLeft ?? -1),
      scrollWidth: Math.round(strip?.scrollWidth ?? -1),
      clientWidth: Math.round(strip?.clientWidth ?? -1),
      overflowX: cs?.overflowX ?? null,
      overflowY: cs?.overflowY ?? null,
      scrollbarWidth: cs?.scrollbarWidth ?? null,
      left: Math.round(stripRect?.left ?? -1),
      right: Math.round(stripRect?.right ?? -1),
      activeIdx: tabs.findIndex((t) => t.classList.contains('active')),
      tabRects: tabs.map((t) => {
        const r = t.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right) }
      }),
      // Every control offered around the strip. The terminal header's tools live
      // OUTSIDE fl-tabs' shadow root, so scan both. Known non-overflow tools are
      // dropped: the two header buttons are "New terminal" (+) and "Hide
      // terminal" (⌄ — the collapse chevron, NOT an overflow menu), and each tab
      // carries its own "Close …" button.
      affordances: [
        ...[...(strip?.parentElement?.querySelectorAll('button') ?? [])],
        ...[...document.querySelectorAll('.fl-term-tool')],
      ]
        .filter((b) => (b as HTMLElement).offsetParent !== null) // visible only
        .map((b) => b.getAttribute('aria-label') ?? '')
        .filter((l) => l !== '' && !/^Close /.test(l))
        .filter((l) => l !== 'New terminal' && l !== 'Hide terminal'),
    }
  })

async function openTerminals(win: Page, total: number): Promise<void> {
  await expect(win.locator(sel.terminalRoot)).toBeVisible()
  if ((await termTabs(win).count()) === 0) {
    await newBtn(win).click()
  }
  await expect(win.locator('.fl-term-host:not([hidden]) .xterm').first()).toBeVisible({
    timeout: 15000,
  })
  while ((await termTabs(win).count()) < total) {
    await newBtn(win).click()
    await win.waitForTimeout(400)
  }
  await expect(termTabs(win)).toHaveCount(total)
}

async function stripCenter(win: Page): Promise<{ x: number; y: number }> {
  const box = await win.locator('.fl-term-tabs').boundingBox()
  return { x: (box?.x ?? 0) + (box?.width ?? 0) / 2, y: (box?.y ?? 0) + (box?.height ?? 0) / 2 }
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

test.afterAll(() => cleanupSeeds())

test.describe('terminal — overflowed tab strip', () => {
  test('8 terminals overflow the strip; the active tab stays in view and selection works', async ({
    window,
  }) => {
    const errors = trackErrors(window)
    const proj = await seedProject(window)
    await activateProject(window, proj)
    await openTerminals(window, TAB_COUNT)

    const state = await stripState(window)
    // The strip really is overflowing — otherwise the rest of this file proves nothing.
    expect(state.scrollWidth).toBeGreaterThan(state.clientWidth)
    expect(state.overflowX).toBe('auto')
    // #700: the ACTIVE tab must be scrolled into view, never clipped.
    expect(state.activeIdx).toBeGreaterThanOrEqual(0)
    const active = state.tabRects[state.activeIdx]
    expect(active.left).toBeGreaterThanOrEqual(state.left - 1)
    expect(active.right).toBeLessThanOrEqual(state.right + 1)
    await window.screenshot({ path: `${SCREEN_DIR}/terminal-tab-overflow-01-strip.png` })

    // A tab that IS visible selects its own shell: mark the last-but-one tab's
    // shell, switch away, switch back, and read the marker off the active host.
    //
    // Tab widths follow the shells' cwd titles (OSC 7 → the seeded tmpdir
    // basename), so at the active tab's scroll anchor the number of tabs
    // landing FULLY inside the viewport is borderline — occasionally just 1.
    // The selection check needs two fully-visible tabs, not any particular
    // scroll position: anchor the strip at its start deterministically (the
    // #993 guard means nothing scrolls it back until a tab activation), then
    // count from fresh geometry.
    await window.evaluate(() => {
      const host = document.querySelector('.fl-term-tabs') as HTMLElement | null
      const strip = host?.shadowRoot?.querySelector('.strip') as HTMLElement | null
      if (strip) strip.scrollLeft = 0
    })
    const anchored = await stripState(window)
    const visible = anchored.tabRects
      .map((r, i) => ({ i, ...r }))
      .filter((r) => r.left >= anchored.left && r.right <= anchored.right)
    expect(visible.length, 'at least two tabs must be visible to test selection').toBeGreaterThan(1)

    const target = visible[0].i
    await termTabs(window).nth(target).click()
    await activeHost(window).click()
    await window.keyboard.type('echo TABSTRIP_TARGET_5C3')
    await window.keyboard.press('Enter')
    await expect
      .poll(async () => /TABSTRIP_TARGET_5C3/.test(await activeRows(window).innerText()), {
        timeout: 8000,
      })
      .toBe(true)

    const other = visible[visible.length - 1].i
    await termTabs(window).nth(other).click()
    await expect
      .poll(async () => /TABSTRIP_TARGET_5C3/.test(await activeRows(window).innerText()), {
        timeout: 5000,
      })
      .toBe(false) // a different shell — no scrollback bleed

    await termTabs(window).nth(target).click()
    await expect
      .poll(async () => /TABSTRIP_TARGET_5C3/.test(await activeRows(window).innerText()), {
        timeout: 5000,
      })
      .toBe(true) // back to the marked shell

    expect(errors, `uncaught errors driving the overflowed strip:\n${errors.join('\n')}`).toEqual([])
  })

  // ── Guard A (#993): the strip stays where the user scrolled it ───────────
  test(
    'a manual scroll of the tab strip survives idle time (strip does not snap back)',
    async ({ window }) => {
      const proj = await seedProject(window)
      await activateProject(window, proj)
      await openTerminals(window, TAB_COUNT)
      await window.waitForTimeout(2000) // let shell startup settle

      // Scroll the strip to its start (a trackpad horizontal swipe — the ONLY
      // route that moves it today).
      const c = await stripCenter(window)
      await window.mouse.move(c.x, c.y)
      for (let i = 0; i < 10; i++) {
        await window.mouse.wheel(-300, 0)
        await window.waitForTimeout(40)
      }
      const scrolled = await stripState(window)
      expect(scrolled.scrollLeft, 'the strip must be scrollable at all').toBeLessThan(200)

      // Now do NOTHING for 3s. Every shell is idle; the user is reading the tabs.
      await window.waitForTimeout(3000)
      const after = await stripState(window)
      await window.screenshot({ path: `${SCREEN_DIR}/terminal-tab-overflow-02-snapback.png` })
      expect(
        after.scrollLeft,
        `strip scrolled itself back to the active tab while idle ` +
          `(${scrolled.scrollLeft} -> ${after.scrollLeft}); every onTitleChange rebuilds the ` +
          `strip and re-runs #scrollActiveIntoView, so an off-screen tab can't be reached`,
      ).toBeLessThan(200)
    },
  )

  // ── Guard B (#994): a mouse route to the overflowed tabs ─────────────────
  test(
    'the overflowed strip offers a mouse-reachable route to off-screen tabs',
    async ({ window }) => {
      const proj = await seedProject(window)
      await activateProject(window, proj)
      await openTerminals(window, TAB_COUNT)
      await window.waitForTimeout(2000)

      const before = await stripState(window)
      const hidden = before.tabRects.filter((r) => r.right <= before.left || r.left >= before.right)
      expect(hidden.length, 'this test needs tabs off-screen').toBeGreaterThan(0)

      // A plain vertical mouse wheel — what a user with a regular mouse does.
      const c = await stripCenter(window)
      await window.mouse.move(c.x, c.y)
      for (let i = 0; i < 8; i++) {
        await window.mouse.wheel(0, -200)
        await window.waitForTimeout(40)
      }
      const afterWheel = await stripState(window)
      const wheelWorks = afterWheel.scrollLeft !== before.scrollLeft
      // …or any visible overflow affordance (scrollbar, chevrons, overflow menu).
      const hasAffordance =
        afterWheel.affordances.length > 0 || afterWheel.scrollbarWidth !== 'none'

      expect(
        wheelWorks || hasAffordance,
        `with ${hidden.length} of ${TAB_COUNT} tabs off-screen there is no mouse route to them: ` +
          `vertical wheel moved scrollLeft ${before.scrollLeft} -> ${afterWheel.scrollLeft} ` +
          `(computed overflow-y: ${afterWheel.overflowY} blocks Blink's orthogonal fallback), ` +
          `scrollbar-width: ${afterWheel.scrollbarWidth}, extra controls: ` +
          `${JSON.stringify(afterWheel.affordances)}`,
      ).toBe(true)
    },
  )
})
