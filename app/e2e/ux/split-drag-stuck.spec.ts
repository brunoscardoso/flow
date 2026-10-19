/**
 * #926 — the resize handle gets stuck in "active" mode: the border stays blue
 * and merely moving the cursor NEAR the handle keeps resizing the pane, until
 * it bottoms out at min/max.
 *
 * Root cause (deterministic once you know it): the drag's pointermove listener
 * lives on the handle and is only removed on pointerup. Any path where that
 * pointerup never reaches the handle — pointer capture lost to a re-render, a
 * mouseup outside the window, an OS-level grab — leaves the listener attached,
 * so every later HOVER (buttons === 0) is treated as a drag.
 *
 * This drives that exact sequence with synthetic events: pointerdown, then a
 * move with NO button held (the state after a missed pointerup). Post-fix the
 * drag self-heals: the class clears and the pane stops following the cursor.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

test('#926: a missed pointerup does not leave the handle dragging', async ({ window }) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-ux-split-')
  await activateProject(window, root)

  const state = await window.evaluate(() => {
    const split = document.querySelector('fl-split') as (HTMLElement & { shadowRoot?: ShadowRoot }) | null
    const handle = split?.shadowRoot?.querySelector('.handle') as HTMLElement | undefined
    if (!handle) return { skipped: true as const }

    const rect = handle.getBoundingClientRect()
    const mk = (type: string, x: number, buttons: number): PointerEvent =>
      new PointerEvent(type, {
        pointerId: 1,
        clientX: x,
        clientY: rect.y + rect.height / 2,
        buttons,
        bubbles: true,
        cancelable: true,
      })

    // Begin a real drag through the component's own entry point.
    handle.dispatchEvent(mk('pointerdown', rect.x + rect.width / 2, 1))
    const draggingAfterDown = handle.classList.contains('dragging')

    // The pointerup NEVER arrives (the #926 state). The next thing the handle
    // sees is a plain hover — no button held.
    handle.dispatchEvent(mk('pointermove', rect.x + 120, 0))
    const draggingAfterHover = handle.classList.contains('dragging')

    // A second hover further away must not move anything either.
    const sizesAfterHeal = (split as unknown as { getSizes(): number[] }).getSizes().join(',')
    handle.dispatchEvent(mk('pointermove', rect.x + 240, 0))
    const sizesAfterSecondHover = (split as unknown as { getSizes(): number[] }).getSizes().join(',')

    return {
      skipped: false as const,
      draggingAfterDown,
      draggingAfterHover,
      sizesStable: sizesAfterHeal === sizesAfterSecondHover,
    }
  })

  test.skip(state.skipped, 'no fl-split handle in this layout')
  expect(state.draggingAfterDown, 'pointerdown should begin a drag').toBe(true)
  expect(state.draggingAfterHover, 'a buttonless move must END the drag (#926)').toBe(false)
  expect(state.sizesStable, 'hovering the handle must not resize the pane').toBe(true)
})
