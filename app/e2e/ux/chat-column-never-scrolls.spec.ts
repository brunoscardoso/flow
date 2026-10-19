/**
 * THE CHAT COLUMN NEVER SCROLLS AS A WHOLE (user, 2026-10-09: "sometimes we
 * are adding that big space here on the bottom of the text input").
 *
 * The boxes around the column clip their content but can be scrolled by code;
 * one scrolled box slid the whole column up and left an empty band under the
 * input. The trigger was not reproduced, so this scrolls each box directly —
 * what a focus or caret move would do — and asserts the input is back at the
 * column's foot.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

test.afterAll(() => cleanupSeeds())

test('a scrolled box around the chat column snaps back, leaving no gap under the input', async ({ window: page }) => {
  test.setTimeout(240_000)
  const root = await seedProject(page, 'flow-ux-column-scroll-')
  await activateProject(page, root)
  const thread = await page.evaluate(
    async (projectRoot) =>
      (await (window as unknown as { flow: { threads: { create(r: unknown): Promise<{ id: string }> } } }).flow.threads.create({
        projectRoot,
        title: 'Column scroll thread',
      })),
    root,
  )
  await page.evaluate(
    async (threadId) =>
      (window as unknown as { flow: { messages: { append(r: unknown): Promise<unknown> } } }).flow.messages.append({
        threadId,
        role: 'user',
        content: 'hello',
      }),
    thread.id,
  )
  await page.getByText('Column scroll thread', { exact: true }).first().click()
  await expect(page.locator(sel.composer)).toBeVisible()

  const result = await page.evaluate(async () => {
    const composer = document.querySelector('.fl-composer') as HTMLElement
    const footBefore = composer.getBoundingClientRect().bottom
    // Every clipping box between the column and its split pane.
    const boxes: HTMLElement[] = []
    let el: Element | null = composer.parentElement
    while (el) {
      const style = getComputedStyle(el)
      if (style.overflowY !== 'visible') boxes.push(el as HTMLElement)
      if (el.classList.contains('pane')) break
      el = (el as HTMLElement).assignedSlot ?? el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null)
    }
    // Give them something to scroll: content taller than the column.
    const column = composer.parentElement!
    column.style.position = 'relative'
    const poke = document.createElement('div')
    poke.style.cssText = 'position:absolute;left:0;top:100%;width:1px;height:400px'
    column.appendChild(poke)
    const moved: number[] = []
    for (const box of boxes) {
      box.scrollTop = 200
      moved.push(box.scrollTop)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    const after = boxes.map((box) => box.scrollTop)
    poke.remove()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    return { count: boxes.length, moved, after, footBefore, footAfter: composer.getBoundingClientRect().bottom }
  })

  // POSITIVE FIRST (allowed-pattern #28): there were boxes, and at least one
  // really did scroll when told to.
  expect(result.count).toBeGreaterThan(0)
  expect(result.moved.some((top) => top > 0)).toBe(true)
  // … and every one is back at the top, with the input where it was.
  expect(result.after.every((top) => top === 0)).toBe(true)
  expect(Math.round(result.footAfter)).toBe(Math.round(result.footBefore))
})
