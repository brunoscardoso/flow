import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation, BARE URLs in an assistant answer.
 *
 * Round 9 (`conversation-external-link.spec.ts`) locked down the safety of the
 * Markdown link form `[text](https://…)`. Nobody drove the OTHER — and far more
 * common — way a URL reaches the transcript: written bare in prose ("opened
 * https://github.com/org/repo/pull/42", "see https://docs.example.com/guide").
 * Agents emit that shape constantly, and this app's own flows end in one (the
 * PR URL `gh pr create` prints).
 *
 * The inline renderer (`markdown-renderer.ts` INLINE_RULES) has exactly one URL
 * rule — the bracketed Markdown form — so a bare URL falls through to a plain
 * text node. GFM autolinks it (verified against `gh api /markdown`); here it is
 * dead text the user cannot click.
 *
 * Live guard: the bracketed form still renders a safe external anchor.
 * `test.fixme` tripwire: the bare form renders an anchor too — RED today.
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

const PR_URL = 'https://github.com/acme/widgets/pull/42'
const DOCS_URL = 'https://docs.example.com/guide/setup'

test.afterAll(() => cleanupSeeds())

test.describe('conversation bare URLs', () => {
  test('a bracketed markdown link renders as a safe external anchor', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Linked URL Thread')
    await appendMessage(window, threadId, 'user', 'Did you open the PR?')
    await appendMessage(window, threadId, 'assistant', `Opened [PR #42](${PR_URL}) for review.`)
    await openThread(window, 'Linked URL Thread')

    const anchor = window.locator(`.fl-conv-feed a[href="${PR_URL}"]`)
    await expect(anchor).toHaveCount(1)
    await expect(anchor).toBeVisible()
    // Same external-link safety round 9 locked in.
    await expect(anchor).toHaveAttribute('target', '_blank')
    await expect(anchor).toHaveAttribute('rel', /noopener/)
    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  // TRIPWIRE — the same URL written bare (the shape agents actually emit) is
  // rendered as inert text: no anchor, nothing to click. Flip to a live
  // `test(...)` once bare URLs autolink like GFM.
  test.fixme('a bare URL in prose is clickable', async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Bare URL Thread')
    await appendMessage(window, threadId, 'user', 'Did you open the PR?')
    await appendMessage(
      window,
      threadId,
      'assistant',
      [
        `Opened the PR: ${PR_URL}`,
        '',
        `The setup guide is at ${DOCS_URL} if you need the background.`,
      ].join('\n'),
    )
    await openThread(window, 'Bare URL Thread')

    // The URL text IS on screen — it just isn't a link.
    await expect(window.locator('.fl-conv-feed')).toContainText(PR_URL)
    await window.screenshot({ path: `${SCREENS}/conversation-bare-url.png` })

    await expect(
      window.locator(`.fl-conv-feed a[href="${PR_URL}"]`),
      'a bare URL in an assistant answer must be clickable',
    ).toHaveCount(1)
    await expect(window.locator(`.fl-conv-feed a[href="${DOCS_URL}"]`)).toHaveCount(1)
  })
})
