import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation FILE-REFERENCE links (round 6).
 *
 * The conversation markdown renderer turns an inline code span that
 * `looksLikeFilePath` into a clickable `.fl-md-file` chip that opens the file in
 * the editor (and toasts "File not found" when it can't resolve). This probe
 * locks down that affordance from the deterministic, credential-less surface a
 * user hits (history pre-populated through `messages:append`):
 *
 *  - a real project file reference (`package.json`, `src/index.ts`) renders as a
 *    clickable file chip with an "Open <path>" title,
 *  - a genuine code symbol (`window.opener`, `useAuth()`) renders as PLAIN code,
 *    never a clickable file chip (the heuristic's exclusion guard),
 *  - clicking a file chip that doesn't resolve surfaces a "File not found" toast
 *    (the click is never a silent dead-end),
 *  - a code block's Copy button flips Copy → Copied on click.
 *
 * The `test.fixme` at the end is the tripwire for issue #656: ordinary framework
 * names in backticks (`Node.js`, `Vue.js`, `Next.js`) end in a recognized
 * extension (`.js`) with no whitespace, so they slip through `looksLikeFilePath`
 * and render as clickable "Open <name>" file chips — visually identical to a
 * real file ref — and clicking one throws a red "File not found" error toast for
 * a term that was never a file. Flip it to a live test once the heuristic
 * excludes bare `<name>.js` framework tokens.
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

test('file-ref: a real project file path renders as a clickable "Open <path>" chip', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Real file ref')
  await appendMessage(
    window,
    id,
    'assistant',
    'Edit `package.json` and then look at `src/index.ts` for the entry point.',
  )
  await openThread(window, 'Real file ref')

  const links = window.locator('.fl-md-file')
  await expect(links).toHaveCount(2)
  await expect(links.nth(0)).toHaveText('package.json')
  await expect(links.nth(0)).toHaveAttribute('title', 'Open package.json')
  await expect(links.nth(1)).toHaveText('src/index.ts')
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('code-symbol: a real code symbol renders as plain code, never a file chip', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Code symbol')
  await appendMessage(
    window,
    id,
    'assistant',
    'Call `useAuth()` and check `window.opener` before you set `MAX = 8192`.',
  )
  await openThread(window, 'Code symbol')

  // These are code, not files — they must NOT become clickable file chips.
  await expect(window.locator('.fl-md-file')).toHaveCount(0)
  await expect(window.locator('.fl-conv-feed code')).not.toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('click: an unresolvable file chip surfaces a "File not found" toast (no dead-end)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Missing file ref')
  // A legitimately file-named ref that does not exist in the seeded repo.
  await appendMessage(window, id, 'assistant', 'See `does-not-exist-in-repo.ts` for details.')
  await openThread(window, 'Missing file ref')

  const link = window.locator('.fl-md-file', { hasText: 'does-not-exist-in-repo.ts' })
  await expect(link).toBeVisible()
  await link.click()
  // The click is acknowledged with feedback, not silently swallowed.
  await expect(window.getByText('File not found').first()).toBeVisible({ timeout: 3000 })
  await window.screenshot({ path: `${SCREENS}/conversation-filelink-notfound.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('copy: a code block Copy button flips to "Copied" on click', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Copy code')
  await appendMessage(window, id, 'assistant', 'Run:\n\n```bash\nnpm install\n```')
  await openThread(window, 'Copy code')

  const copy = window.locator('.fl-md-code-header fl-button').first()
  await expect(copy).toHaveText('Copy')
  await copy.click()
  await expect(copy).toHaveText('Copied')
  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Fixed in #656: `looksLikeFilePath` now rejects BARE well-known `<Brand>.js`
// names (`Node.js`, `Vue.js`, `Next.js`, …) — they render as plain code, while
// the same names WITH a path (`vendor/three.js`) and real bare files
// (`App.js`, `package.json`) stay clickable file chips.
test('framework names in backticks stay plain code, not clickable file chips', async ({
  window,
}) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'Framework names')
  await appendMessage(
    window,
    id,
    'assistant',
    'Build it with `Node.js` and `Vue.js`, or migrate to `Next.js`.',
  )
  await openThread(window, 'Framework names')

  // Expected (currently fails — all three become clickable file chips): none of
  // these framework names render as a `.fl-md-file` link.
  await expect(window.locator('.fl-md-file')).toHaveCount(0)
})
