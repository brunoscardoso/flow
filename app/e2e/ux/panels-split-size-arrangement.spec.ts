import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Flow 12 — what panel toggles do to the user's PANE WIDTHS (#1110 / #1111).
 *
 * Every prior flow-12 spec asks whether a toggle produced the right *set* of
 * panels. These ask what the toggle does to the widths the user configured.
 *
 * #1110/#1111 (fixed): the root split now stores its fractions PER COMPOSITION —
 * `splits['fl-split-root:<signature>']` with signatures like
 * 'sidebar|conversation|editor' — and `rootSizesFor` picks stored sizes and
 * defaults by that same signature (never by child count). So:
 *
 *   #1110 — hiding Chat (⌘⌥C) with the sidebar open lands on the
 *           'sidebar|editor' default [0.22, 0.78]: the freed width goes to the
 *           EDITOR and the activity sidebar keeps its ~22% share.
 *   #1111 — a drag in one arrangement writes its own key, so it can never evict
 *           another arrangement's tuned widths.
 *
 * The live guards pin the parts that always worked (persistence round-trips);
 * the two former `test.fixme`s below are now live regression guards.
 */

const rootSplit = '#fl-split-root'

interface RootState {
  sizes: number[]
  ids: string[]
  widths: number[]
}

async function rootState(win: Page): Promise<RootState> {
  return win.evaluate((selector) => {
    const root = document.querySelector(selector) as HTMLElement
    const kids = Array.from(root.children) as HTMLElement[]
    return {
      sizes: (root as unknown as { getSizes(): number[] }).getSizes(),
      ids: kids.map((k) => k.getAttribute('data-panel-id') ?? (k.className || k.id)),
      widths: kids.map((k) => Math.round(k.getBoundingClientRect().width)),
    }
  }, rootSplit)
}

/** Grab points of the ROOT split's own shadow-DOM drag handles (the nested
 *  editor-stack split has its own, which must not be driven here). The y sits at
 *  a QUARTER of the handle's height, not its centre: the editor-stack's 50/50
 *  editor|terminal divider crosses the root handle exactly at mid-height and
 *  wins the hit test in that narrow band, turning a centre-grab into a no-op. */
async function rootHandles(win: Page): Promise<{ x: number; y: number }[]> {
  return win.evaluate((selector) => {
    const sr = (document.querySelector(selector) as HTMLElement).shadowRoot
    if (!sr) return []
    return Array.from(sr.querySelectorAll('.handle')).map((h) => {
      const r = h.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 4 }
    })
  }, rootSplit)
}

async function dragRootHandle(win: Page, index: number, dx: number): Promise<void> {
  const handles = await rootHandles(win)
  const handle = handles[index]
  expect(handle, `root split handle ${index} (have ${handles.length})`).toBeTruthy()
  await win.mouse.move(handle.x, handle.y)
  await win.mouse.down()
  await win.mouse.move(handle.x + dx, handle.y, { steps: 14 })
  await win.mouse.up()
  await win.waitForTimeout(300)
}

/** Open a project with the Files tree showing, so the sidebar has real content. */
async function openTunableProject(win: Page): Promise<void> {
  const root = await seedProject(win)
  await activateProject(win, root)
  await expect(win.locator(sel.panelById('conversation'))).toBeVisible()
  await win.keyboard.press('ControlOrMeta+Digit2')
  await expect(win.locator(rootSplit)).toHaveCount(1)
  await win.waitForTimeout(400)
}

test.describe('flow 12 — pane widths across panel toggles (#1110/#1111)', () => {
  test.afterAll(() => cleanupSeeds())

  test('the default 3-pane arrangement gives the sidebar and Chat equal shares', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    await openTunableProject(window)

    const state = await rootState(window)
    expect(state.ids).toEqual(['fl-activity-sidebar', 'conversation', 'fl-split-editor-stack'])
    // `root-3` — the sidebar is a fifth of the window, not a third.
    expect(state.sizes.map((s) => +s.toFixed(2))).toEqual([0.22, 0.22, 0.56])
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test('a drag is persisted and survives a plain ⌘B round-trip (#1111 control)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    await openTunableProject(window)

    // Tune the layout: narrow sidebar, wide Chat.
    await dragRootHandle(window, 0, -120)
    await dragRootHandle(window, 1, +180)
    const tuned = await rootState(window)
    expect(tuned.sizes).toHaveLength(3)
    // The drag really moved things (guards against a vacuous pass).
    expect(tuned.sizes[0]).toBeLessThan(0.2)
    expect(tuned.sizes[1]).toBeGreaterThan(0.3)

    // It reaches the persisted store under the composition-keyed root key (#1111).
    // Layouts persist per SCOPE now (a project plus the conversation on
    // screen, `flow.shell.layout.scoped.v1`); the per-root v5 record is only
    // the migration fallback. The write is debounced, so poll.
    await expect
      .poll(
        () =>
          window.evaluate(() => {
            const raw = localStorage.getItem('flow.shell.layout.scoped.v1')
            if (!raw) return null
            const parsed = JSON.parse(raw) as {
              entries?: Record<string, { value?: { splits?: Record<string, number[]> } }>
            }
            const found = Object.values(parsed.entries ?? {})
              .map((entry) => entry.value?.splits?.['fl-split-root:sidebar|conversation|editor'])
              .filter((sizes): sizes is number[] => Array.isArray(sizes))
            return found.at(-1)?.length ?? null
          }),
        { timeout: 5000 },
      )
      .toBe(3)

    // Hide and re-show the sidebar WITHOUT dragging in between — the layout
    // comes back exactly. This is the control: persistence itself works.
    await window.keyboard.press('ControlOrMeta+KeyB')
    await expect
      .poll(async () => (await rootState(window)).ids.length, { timeout: 5000 })
      .toBe(2)
    await window.keyboard.press('ControlOrMeta+KeyB')
    await expect
      .poll(async () => (await rootState(window)).ids.length, { timeout: 5000 })
      .toBe(3)

    const restored = await rootState(window)
    expect(restored.sizes).toEqual(tuned.sizes)
    expect(restored.widths).toEqual(tuned.widths)
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test('⌘⌥C round-trips the Chat panel and restores the 3-pane widths (#1110 control)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    await openTunableProject(window)

    const before = await rootState(window)
    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(window.locator(sel.panelById('conversation'))).toHaveCount(0)
    await window.keyboard.press('ControlOrMeta+Alt+KeyC')
    await expect(window.locator(sel.panelById('conversation'))).toBeVisible()

    // The panel comes back and so do the 3-pane widths — the damage in #1110 is
    // confined to the hidden-Chat arrangement, which is what makes it a
    // wrong-default bug rather than a persistence bug.
    const after = await rootState(window)
    expect(after.ids).toEqual(before.ids)
    expect(after.widths).toEqual(before.widths)
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test(
    'hiding Chat must not hand the activity sidebar the conversation panel’s width (#1110)',
    async ({ window }) => {
      await openTunableProject(window)

      const before = await rootState(window)
      const sidebarBefore = before.widths[0]

      await window.keyboard.press('ControlOrMeta+Alt+KeyC')
      await expect(window.locator(sel.panelById('conversation'))).toHaveCount(0)
      await window.waitForTimeout(400)

      const after = await rootState(window)
      expect(after.ids).toEqual(['fl-activity-sidebar', 'fl-split-editor-stack'])

      // Pre-fix this ballooned 306px -> 529px: the count-keyed default handed
      // the sidebar the conversation's 0.38. The 'sidebar|editor' composition
      // default now keeps the sidebar at ~22% and gives the freed width to the editor.
      expect(
        after.widths[0],
        `hiding the Chat panel widened the activity sidebar from ${sidebarBefore}px to ${after.widths[0]}px — it inherited the conversation panel's 38% share`,
      ).toBeLessThanOrEqual(Math.round(sidebarBefore * 1.15))
    },
  )

  test(
    'a drag in the sidebar-hidden arrangement must not destroy the tuned 3-pane widths (#1111)',
    async ({ window }) => {
      await openTunableProject(window)

      await dragRootHandle(window, 0, -120)
      await dragRootHandle(window, 1, +180)
      const tuned = await rootState(window)

      // Hide the sidebar, nudge the remaining divider — an entirely ordinary act.
      await window.keyboard.press('ControlOrMeta+KeyB')
      await expect
        .poll(async () => (await rootState(window)).ids.length, { timeout: 5000 })
        .toBe(2)
      await dragRootHandle(window, 0, +60)

      // Bring the sidebar back.
      await window.keyboard.press('ControlOrMeta+KeyB')
      await expect
        .poll(async () => (await rootState(window)).ids.length, { timeout: 5000 })
        .toBe(3)

      const back = await rootState(window)
      expect(
        back.widths,
        `one drag with the sidebar hidden reset the tuned layout ${tuned.widths.join('/')} to defaults ${back.widths.join('/')} — every arrangement shares splits['fl-split-root']`,
      ).toEqual(tuned.widths)
    },
  )
})
