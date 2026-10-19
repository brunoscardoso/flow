import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation FENCED CODE-BLOCK rendering + copy (round 11).
 *
 * Assistant answers lean on fenced code blocks constantly — read the code, copy
 * it. Prior flow-4 rounds covered states, lifecycle, file-ref spans, nested
 * lists, external links, tool cards and mid-turn errors, but NEVER drove a
 * fenced code block: that it renders as a real `<pre><code>` (raw — markdown
 * chars inside stay literal), that the "Copy" affordance gives feedback, and how
 * an info-string fence (```lang title="x") is handled. All drivable through the
 * raw `messages:append` IPC (no Claude account).
 *
 * The suspected defect (markdown-renderer.ts FENCE_RE = /^(`{3,}|~{3,})\s*
 * (\S*)\s*$/): the info string after the language must be whitespace-only. A
 * fence carrying a common info string beyond the bare language — ```ts title=
 * "x", ```bash {2,4}, ```python showLineNumbers — FAILS the fence regex, so the
 * opening ``` is NOT recognised. The block scanner falls through to paragraph
 * parsing: the code lines render as PROSE with their markdown interpreted (`#`
 * → heading, `- ` → list, `|` → table). A real user pasting such an answer sees
 * their code shredded into garbled markdown instead of a copyable code block.
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

test.afterAll(() => cleanupSeeds())

// A bare-language fence carrying markdown-flavoured code — the baseline every
// assistant answer produces.
const BARE_FENCE = [
  'Here is the config:',
  '',
  '```python',
  '# heading-looking comment',
  '- not a bullet',
  'total = a | b',
  '```',
].join('\n')

test('baseline: a bare-language fence renders as a raw code block with a copy control', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Bare fence')
  await appendMessage(window, id, 'assistant', BARE_FENCE)
  await openThread(window, 'Bare fence')

  const md = window.locator('.fl-conv-feed .fl-md').first()
  const block = md.locator('.fl-md-codeblock')
  await expect(block).toHaveCount(1)
  // The code is RAW: markdown chars inside the fence stay literal — no <h1>,
  // no <ul>/<li>, no <table> was synthesised from the code body.
  const shredded = await block.evaluate(
    (el) => el.querySelectorAll('h1,h2,h3,ul,ol,li,table').length,
  )
  expect(shredded, 'code inside a fence must not be parsed as markdown').toBe(0)
  const codeText = await block.locator('pre code').innerText()
  expect(codeText).toContain('# heading-looking comment')
  expect(codeText).toContain('- not a bullet')
  expect(codeText).toContain('total = a | b')

  await window.screenshot({ path: `${SCREENS}/conversation-codeblock-bare.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('copy: the code-block Copy control gives feedback (label flips to Copied)', async ({
  window,
}) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Copy fence')
  await appendMessage(window, id, 'assistant', BARE_FENCE)
  await openThread(window, 'Copy fence')

  const block = window.locator('.fl-conv-feed .fl-md .fl-md-codeblock').first()
  const copyBtn = block.locator('.fl-md-code-header fl-button')
  await expect(copyBtn).toBeVisible()
  await expect(copyBtn).toContainText('Copy')
  await copyBtn.click()
  // A copy affordance with no confirmation is a dead click to the user. Either
  // the label flips to "Copied" (success feedback) OR — if the sandbox denies
  // clipboard — this surfaces as an error we would want to see, not silence.
  await expect(copyBtn).toContainText('Copied', { timeout: 2000 })
})

// A fence whose info string carries more than the bare language — an extremely
// common shape in real answers (syntax-highlight directives, titles, line
// ranges). CommonMark/GFM treat everything after the first word as an ignored
// info string; the block is STILL a code block.
const INFO_STRING_FENCE = [
  'Update the workflow file:',
  '',
  '```yaml title=".github/workflows/ci.yml"',
  'name: CI',
  '# run on push',
  'on:',
  '  - push',
  '```',
].join('\n')

// Guard for #789 (fixed): an info-string fence (```yaml title="…", ```bash
// {2,4}) is recognised — fenceInfo() accepts an arbitrary info string and the
// language is its first word — so the code renders as ONE copyable block.
test(
  'info-string: ```yaml title="..." still renders as ONE code block, not shredded prose (bug #789)',
  async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Info string fence')
  await appendMessage(window, id, 'assistant', INFO_STRING_FENCE)
  await openThread(window, 'Info string fence')

  const md = window.locator('.fl-conv-feed .fl-md').first()

  const shape = await md.evaluate((el) => ({
    codeBlocks: el.querySelectorAll('.fl-md-codeblock').length,
    headings: el.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
    lists: el.querySelectorAll('ul,ol').length,
    // A literal ``` leaking into rendered text means the fence was never
    // recognised and its markers became prose.
    rawFenceInText: (el.textContent ?? '').includes('```'),
  }))

  await window.screenshot({ path: `${SCREENS}/conversation-codeblock-infostring.png` })

  // Expected UX: exactly one code block, no markdown synthesised from the code
  // body, and no stray ``` markers rendered as text.
  expect(shape.codeBlocks, 'an info-string fence should render as one code block').toBe(1)
  expect(shape.headings, 'the "# run on push" comment must not become a heading').toBe(0)
  expect(shape.lists, 'the "  - push" line must not become a bullet list').toBe(0)
  expect(shape.rawFenceInText, 'the ``` fence markers must not leak into rendered text').toBe(false)
  expect(errors, errors.join(', ')).toHaveLength(0)
})
