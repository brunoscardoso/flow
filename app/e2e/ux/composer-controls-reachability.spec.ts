/**
 * Regression probe for #1469 — at the app's OWN default window size the
 * composer's primary action was laid out outside the pane.
 *
 * `.fl-composer-controls` was a no-wrap flex row holding two selects, three
 * icon buttons, a nowrap model indicator and a `flex: 1` spacer that always
 * claimed the slack. At 1440×900 with the default layout (threads sidebar +
 * docked terminal) the row measured 335px inside a 274px pane, and with nothing
 * allowed to wrap or shrink the overflow landed on the LAST items: Send, and
 * Interrupt while a turn ran. Both were painted over the neighbouring pane —
 * `elementFromPoint` at their centre returned `div.xterm-viewport` — so there
 * was no clickable Send, and no way to stop a running turn by mouse at all
 * (`threads:interrupt` has no keyboard route).
 *
 * The assertions are HIT TESTS on purpose. The buttons were always present,
 * enabled and correctly labelled — every property-only assertion passed while
 * the control sat outside the window, which is exactly how this survived a spec
 * suite that already covered the Send affordance.
 */
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { ElectronApplication, Page } from '@playwright/test'

/** The app's own defaults and floor (src/main/index.ts). */
const WINDOW_DEFAULT = { width: 1440, height: 900 }
const WINDOW_MIN = { width: 960, height: 600 }

async function createThread(win: Page, root: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }) => {
      await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow.threads.create({ projectRoot: root, title })
    },
    { root, title },
  )
}

async function openComposer(win: Page, title: string): Promise<void> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  await createThread(win, dir, title)
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
}

async function resizeWindow(
  app: ElectronApplication,
  size: { width: number; height: number },
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, target) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(target.width, target.height)
  }, size)
}

/**
 * Whether the element at `selector`'s centre point is the element itself (or a
 * descendant) — i.e. a real click would land on it. `isVisible()` is not enough:
 * a control laid out past the pane edge is still "visible" to CSS.
 */
async function isReachable(win: Page, selector: string): Promise<boolean> {
  return win.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (el === null) return false
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return false
    if (rect.right > window.innerWidth || rect.left < 0) return false
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return hit !== null && (el === hit || el.contains(hit) || hit.contains(el))
  }, selector)
}

/** The controls row must not overflow itself — the condition that pushed the
 *  buttons out in the first place. */
async function rowOverflow(win: Page): Promise<number> {
  return win.evaluate(() => {
    const row = document.querySelector('.fl-composer-controls') as HTMLElement | null
    return row === null ? -1 : row.scrollWidth - row.clientWidth
  })
}

const SEND = `${sel.composer} fl-button[variant="primary"]`

test.afterAll(() => cleanupSeeds())

test.describe('composer controls reachability (#1469)', () => {
  test('Send is inside the pane and clickable at the default window size', async ({
    app,
    window,
  }) => {
    test.setTimeout(180_000)
    await resizeWindow(app, WINDOW_DEFAULT)
    await openComposer(window, 'Reach default')

    await window.locator(`${sel.composer} textarea`).fill('hello')
    expect(await rowOverflow(window)).toBeLessThanOrEqual(0)
    expect(await isReachable(window, SEND), 'Send is laid out outside the composer').toBe(true)
  })

  test('Send stays reachable at the window minimum, where there is least room', async ({
    app,
    window,
  }) => {
    test.setTimeout(180_000)
    await resizeWindow(app, WINDOW_MIN)
    await openComposer(window, 'Reach minimum')

    await window.locator(`${sel.composer} textarea`).fill('hello')
    expect(await rowOverflow(window)).toBeLessThanOrEqual(0)
    expect(await isReachable(window, SEND), 'Send is laid out outside the composer').toBe(true)
  })

  test('every control in the row is reachable, not just the ones that fit before', async ({
    app,
    window,
  }) => {
    test.setTimeout(180_000)
    await resizeWindow(app, WINDOW_DEFAULT)
    await openComposer(window, 'Reach all')
    await window.locator(`${sel.composer} textarea`).fill('hello')

    // Every child the row lays out — selects, icon buttons, the action group —
    // must sit within the window. The old row put the last ones past its edge.
    const offscreen = await window.evaluate(() => {
      const row = document.querySelector('.fl-composer-controls')
      const composer = document.querySelector('.fl-composer')
      if (row === null || composer === null) return ['no composer']
      // Bounded by the COMPOSER, not the window: the old row's buttons were
      // still inside the window — painted over the neighbouring pane — which is
      // why a window-relative check passed while the control was unclickable.
      const pane = composer.getBoundingClientRect()
      const bad: string[] = []
      for (const child of Array.from(row.children)) {
        const rect = child.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue // hidden (e.g. Interrupt when idle)
        if (rect.right > pane.right + 1 || rect.left < pane.left - 1) {
          bad.push(
            `${child.className || child.tagName} @ ${Math.round(rect.left)}→${Math.round(rect.right)} (pane ${Math.round(pane.left)}→${Math.round(pane.right)})`,
          )
        }
      }
      return bad
    })
    expect(offscreen, `laid out beyond the window: ${offscreen.join(', ')}`).toEqual([])
  })
})
