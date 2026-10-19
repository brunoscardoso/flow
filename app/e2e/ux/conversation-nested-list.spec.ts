import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation NESTED-LIST rendering (round 7).
 *
 * Assistant output leans heavily on nested lists (a numbered step with indented
 * sub-bullets). The conversation markdown renderer (`markdown-renderer.ts`
 * `parseList`) decides ordered-vs-unordered from the FIRST item only, then
 * consumes every following `LIST_ITEM_RE` line as a FLAT sibling of that one
 * list — indentation is ignored (`LIST_ITEM_RE` allows leading whitespace, and
 * the continuation loop explicitly skips lines that match it). So a nested list
 * renders flattened: the indented sub-bullets are promoted to top-level items
 * of the SAME list, and because the parent is ordered they are RENUMBERED —
 *
 *     1. First step          1. First step
 *        - detail a    →      2. detail a      (was a sub-bullet)
 *        - detail b           3. detail b      (was a sub-bullet)
 *     2. Second step          4. Second step   (should be 2, now 4)
 *
 * A real user reading a numbered procedure sees sub-details promoted to
 * top-level steps and the true next step mis-numbered — structured output looks
 * wrong.
 *
 * Fixed in #690: `parseList` recurses on a deeper-indented item and hangs the
 * sublist off the parent `<li>`. The first guard checks the list renders with
 * every item; the second (now live) asserts the STRUCTURE — the ordered list
 * has exactly TWO top-level items ("First step", "Second step") with the
 * sub-bullets in a NESTED list inside the first item.
 */

const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

async function appendMessage(
  win: Page,
  threadId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Promise<void> {
  await win.evaluate(
    async ({ threadId, role, content }) => {
      await (
        window as unknown as {
          flow: { messages: { append(i: { threadId: string; role: string; content: string }): Promise<unknown> } }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** A numbered step with indented sub-bullets — a shape assistant output uses
 *  constantly. */
const NESTED = ['1. First step', '   - detail a', '   - detail b', '2. Second step'].join('\n')

test.afterAll(() => cleanupSeeds())

test('live: an assistant nested list renders as a list with every item present', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Nested render')
  await appendMessage(window, id, 'assistant', NESTED)
  await openThread(window, 'Nested render')

  const md = window.locator('.fl-conv-feed .fl-md').first()
  await expect(md.locator('ol, ul').first()).toBeVisible()
  // No content is dropped — every line survives to the DOM somewhere.
  for (const text of ['First step', 'detail a', 'detail b', 'Second step']) {
    await expect(md.getByText(text, { exact: false }).first()).toBeVisible()
  }
  await window.screenshot({ path: `${SCREENS}/conversation-nested-list.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test(
  '#690: a nested list renders nested — parent has 2 items, sub-bullets are a child list',
  async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    const id = await createThread(window, dir, 'Nested structure')
    await appendMessage(window, id, 'assistant', NESTED)
    await openThread(window, 'Nested structure')

    const md = window.locator('.fl-conv-feed .fl-md').first()
    const shape = await md.evaluate((el) => {
      const topList = el.querySelector('ol, ul')
      const topItems = topList
        ? Array.from(topList.children).filter((c) => c.tagName === 'LI')
        : []
      const firstItemText = topItems[0]?.querySelector('span')?.textContent?.trim() ?? ''
      const secondItemText = topItems[1]?.querySelector('span')?.textContent?.trim() ?? ''
      const nestedList = topItems[0]?.querySelector('ul, ol') ?? null
      const nestedItems = nestedList
        ? Array.from(nestedList.children).filter((c) => c.tagName === 'LI').length
        : 0
      return {
        topItemCount: topItems.length,
        firstItemText,
        secondItemText,
        hasNestedList: nestedList !== null,
        nestedItems,
      }
    })
    // The parent list holds ONLY the two real steps — not the flattened sub-bullets.
    expect(shape.topItemCount, 'ordered list should have exactly 2 top-level items').toBe(2)
    expect(shape.firstItemText).toContain('First step')
    expect(shape.secondItemText).toContain('Second step')
    // The sub-bullets live in a nested list inside the first item.
    expect(shape.hasNestedList, 'sub-bullets should render as a nested list').toBe(true)
    expect(shape.nestedItems).toBe(2)
  },
)
