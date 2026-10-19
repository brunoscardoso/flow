import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation BLOCK-STRUCTURE rendering (round 16).
 *
 * Prior flow-4 rounds drove persisted history/states, streaming text (#823),
 * tool cards, the error card (#846), permission (#949) and question (#983/#984)
 * cards, file-ref spans (#656), external links, top-level fenced code (#789) and
 * nested lists (#690). What was never driven is how the block parser
 * (`markdown-renderer.ts` `parseBlocks` / `parseList`) handles the two block
 * shapes an assistant answer produces most: a **comparison table** and a
 * **numbered procedure with a command in it**.
 *
 * Both are verified against GitHub's own GFM renderer (`gh api /markdown`),
 * which is the contract users expect from markdown:
 *
 *  - TABLE (this file's live guards): a table separated by a blank line renders
 *    correctly, and a table wider than the chat column scrolls INSIDE its
 *    `.fl-md-table-wrap` instead of stretching the pane. Both hold today.
 *
 *  - `#1015` (fixme): a table on the line immediately AFTER prose is swallowed
 *    by the paragraph and renders as raw pipe text. Every other block type
 *    (fence, heading, hr, list, blockquote) already interrupts a paragraph in
 *    `parseBlocks`; the table check is the one missing from that break list.
 *
 *  - `#1016` (fixme): an indented fenced code block inside a list item never
 *    becomes a code block — `parseList`'s continuation loop swallows the fence
 *    lines as inline prose (literal ``` and the command flattened onto one
 *    line), and with blank lines around the fence the list splits in two so the
 *    following step renumbers back to 1.
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

async function appendAssistant(win: Page, threadId: string, content: string): Promise<void> {
  await win.evaluate(
    async ({ threadId, content }) => {
      await (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role: 'assistant', content })
    },
    { threadId, content },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** A table with the blank line markdown authors usually leave — the shape that works. */
const TABLE_SPACED = [
  'Here is the comparison:',
  '',
  '| Option | Cost |',
  '| --- | --- |',
  '| A | low |',
  '| B | high |',
].join('\n')

/** The same table written WITHOUT the blank line. GFM renders this identically. */
const TABLE_TIGHT = [
  'Here is the comparison:',
  '| Option | Cost |',
  '| --- | --- |',
  '| A | low |',
  '| B | high |',
].join('\n')

/** Wider than the chat column — must scroll inside the table wrapper. */
const TABLE_WIDE = [
  '| Column one is long | Column two is long | Column three is long | Column four is long | Column five is long | Column six is long |',
  '| --- | --- | --- | --- | --- | --- |',
  '| value aaaaaaaaaaaa | value bbbbbbbbbbbb | value cccccccccccc | value dddddddddddd | value eeeeeeeeeeee | value ffffffffffff |',
].join('\n')

/** "Run these steps" — the single most common shape a coding agent emits. */
const STEPS_WITH_CODE = [
  '1. Install the deps:',
  '',
  '   ```bash',
  '   npm install',
  '   npm run build',
  '   ```',
  '',
  '2. Then run the tests',
].join('\n')

test.afterAll(() => cleanupSeeds())

test('live: a blank-line-separated table renders as a real table', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'MD table spaced')
  await appendAssistant(window, id, TABLE_SPACED)
  await openThread(window, 'MD table spaced')

  const md = window.locator('.fl-conv-feed .fl-md').first()
  const shape = await md.evaluate((el) => {
    const table = el.querySelector('table')
    return {
      headers: table ? Array.from(table.querySelectorAll('th')).map((t) => t.textContent) : [],
      rows: table
        ? Array.from(table.querySelectorAll('tbody tr')).map((r) =>
            Array.from(r.querySelectorAll('td')).map((c) => c.textContent),
          )
        : [],
    }
  })
  expect(shape.headers).toEqual(['Option', 'Cost'])
  expect(shape.rows).toEqual([
    ['A', 'low'],
    ['B', 'high'],
  ])
  // The prose above it stays prose — it is not absorbed into the table.
  await expect(md.locator('p').first()).toHaveText('Here is the comparison:')
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('live: a table wider than the chat column scrolls in place, it does not stretch the pane', async ({
  window,
}) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'MD table wide')
  await appendAssistant(window, id, TABLE_WIDE)
  await openThread(window, 'MD table wide')

  const md = window.locator('.fl-conv-feed .fl-md').first()
  const metrics = await md.evaluate((el) => {
    const wrap = el.querySelector('.fl-md-table-wrap') as HTMLElement | null
    const scroller = document.querySelector('.fl-conv-scroller') as HTMLElement | null
    return {
      wrapClientW: wrap?.clientWidth ?? -1,
      wrapScrollW: wrap?.scrollWidth ?? -1,
      scrollerClientW: scroller?.clientWidth ?? -1,
      scrollerScrollW: scroller?.scrollWidth ?? -1,
      docClientW: document.documentElement.clientWidth,
      docScrollW: document.documentElement.scrollWidth,
    }
  })
  // The overflow is confined to the table wrapper …
  expect(metrics.wrapScrollW).toBeGreaterThan(metrics.wrapClientW)
  // … and never escapes into the conversation scroller or the window.
  expect(metrics.scrollerScrollW).toBe(metrics.scrollerClientW)
  expect(metrics.docScrollW).toBe(metrics.docClientW)
})

test(
  '#1015: a table on the line right after prose renders as a table, not raw pipe text',
  async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    const id = await createThread(window, dir, 'MD table tight')
    await appendAssistant(window, id, TABLE_TIGHT)
    await openThread(window, 'MD table tight')

    const md = window.locator('.fl-conv-feed .fl-md').first()
    const shape = await md.evaluate((el) => ({
      hasTable: el.querySelector('table') !== null,
      showsRawPipes: (el.textContent ?? '').includes('| Option | Cost |'),
    }))
    // GFM (verified with `gh api /markdown`) renders this as <p> + <table>.
    expect(shape.showsRawPipes, 'the table markup is shown to the user verbatim').toBe(false)
    expect(shape.hasTable, 'a table without a preceding blank line still renders').toBe(true)
  },
)

test(
  '#1016: a fenced code block inside a numbered step renders as code and keeps the numbering',
  async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    const id = await createThread(window, dir, 'MD steps with code')
    await appendAssistant(window, id, STEPS_WITH_CODE)
    await openThread(window, 'MD steps with code')

    const md = window.locator('.fl-conv-feed .fl-md').first()
    const shape = await md.evaluate((el) => {
      const lists = Array.from(el.querySelectorAll(':scope > ol'))
      return {
        codeBlocks: el.querySelectorAll('.fl-md-codeblock').length,
        literalFence: (el.textContent ?? '').includes('```'),
        topLevelLists: lists.length,
        firstListItems: lists[0]
          ? Array.from(lists[0].children).filter((c) => c.tagName === 'LI').length
          : 0,
      }
    })
    // The command must be a real, copyable code block — not inline prose.
    expect(shape.codeBlocks, 'the indented fence became a code block').toBe(1)
    expect(shape.literalFence, 'literal ``` is shown to the user').toBe(false)
    // One procedure, two steps — not two lists with the second restarting at 1.
    expect(shape.topLevelLists, 'the procedure stays a single ordered list').toBe(1)
    expect(shape.firstListItems).toBe(2)
  },
)

test('evidence: side-by-side capture of both block-parser defects', async ({ window }) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)

  const tableId = await createThread(window, dir, 'MD evidence table')
  await appendAssistant(
    window,
    tableId,
    ['**WITH a blank line — correct:**', '', TABLE_SPACED].join('\n'),
  )
  await appendAssistant(
    window,
    tableId,
    ['**WITHOUT a blank line — broken:**', '', TABLE_TIGHT].join('\n'),
  )
  await openThread(window, 'MD evidence table')
  await window
    .locator(sel.conversation)
    .screenshot({ path: `${SCREENS}/conversation-md-table-tight.png` })

  const stepsId = await createThread(window, dir, 'MD evidence steps')
  await appendAssistant(window, stepsId, STEPS_WITH_CODE)
  await openThread(window, 'MD evidence steps')
  await window
    .locator(sel.conversation)
    .screenshot({ path: `${SCREENS}/conversation-md-list-fence.png` })
})
