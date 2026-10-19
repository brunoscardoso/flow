import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation, external-link safety.
 *
 * An assistant answer routinely contains a Markdown link. In an Electron
 * renderer a plain same-frame anchor click NAVIGATES the whole window to the
 * external URL — the entire app is replaced by the remote page and the user is
 * stranded with no way back short of a reload. The app defends against this two
 * ways that must BOTH hold: markdown links render with `target="_blank"` +
 * `rel="noreferrer noopener"`, and main's `setWindowOpenHandler` denies the new
 * window and hands the URL to `shell.openExternal`. Existing conversation specs
 * assert the link merely *renders* (an `a[href]` is visible) — none assert the
 * safety attributes or that CLICKING it leaves the app intact. This probe locks
 * down the user-facing invariant: clicking an in-transcript external link must
 * NOT navigate the conversation away.
 */

const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
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
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
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

test('external-link: an assistant link is _blank+rel and clicking it never navigates the app away', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const id = await createThread(window, dir, 'External link probe')
  await appendMessage(window, id, 'user', 'Where are the docs?')
  await appendMessage(
    window,
    id,
    'assistant',
    'The docs live at [the Flow guide](https://example.com/flow-guide). Have a look.',
  )
  await openThread(window, 'External link probe')

  // The link renders as a real anchor inside the transcript.
  const link = window.locator('.fl-conv-feed a[href="https://example.com/flow-guide"]').first()
  await expect(link).toBeVisible()

  // Safety attributes: a new-window target (so main's setWindowOpenHandler
  // intercepts it) plus the anti-tabnabbing rel — both must be present.
  await expect(link).toHaveAttribute('target', '_blank')
  const rel = (await link.getAttribute('rel')) ?? ''
  expect(rel, `rel was "${rel}"`).toContain('noopener')
  expect(rel, `rel was "${rel}"`).toContain('noreferrer')

  // The URL the app is showing before the click — its own file:// renderer.
  const urlBefore = window.url()
  expect(urlBefore, 'app should be on its own renderer, not a remote URL').not.toContain(
    'example.com',
  )

  // The real user action: click the link. It must NOT replace the app — the
  // conversation surface stays mounted and the window never navigates to the
  // external host (setWindowOpenHandler denies + hands off to the OS browser).
  await link.click()
  await window.waitForTimeout(400)

  await expect(window.locator(sel.conversation)).toBeVisible()
  expect(window.url(), 'clicking an external link must not navigate the app').not.toContain(
    'example.com',
  )
  // The assistant bubble (and its link) is still there — nothing got torn down.
  await expect(link).toBeVisible()

  await window.screenshot({ path: `${SCREENS}/conversation-external-link.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})
