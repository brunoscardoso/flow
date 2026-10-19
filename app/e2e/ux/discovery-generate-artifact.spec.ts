import { test, expect } from '../fixtures/electron'
import type { ElectronApplication } from '@playwright/test'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * THE ARTIFACT IS GENERATED ON REQUEST (user request 2026-10-08: "rename the
 * feature view to artifact and stop generating that automatic, and add a
 * button here to generate artifact").
 *
 * A discovery no longer writes its walkthrough page. Its DISCOVERY card offers
 * "Generate artifact" instead, and pressing it sends `/artifact @<doc>` into
 * the card's thread through the composer's own send — so it is echoed as a
 * message like anything typed. A discovery that has a page offers
 * "Open artifact".
 *
 * Nothing reaches an agent: `threads:sendMessage` is answered in MAIN (the
 * contextBridge object cannot be stubbed from the page), and records what the
 * renderer sent.
 */

const NO_PAGE = 'flow/discovery/discovery_gadget_v1.md'
const WITH_PAGE = 'flow/discovery/discovery_widget_v1.md'

test.afterAll(() => cleanupSeeds())

async function api<T>(win: Page, fn: string, arg: unknown): Promise<T> {
  return win.evaluate(
    async ({ fn, arg }) => {
      const flow = (window as unknown as { flow: Record<string, Record<string, (i: unknown) => Promise<unknown>>> }).flow
      const [ns, method] = fn.split('.')
      return (await flow[ns]![method]!(arg)) as unknown
    },
    { fn, arg },
  ) as Promise<T>
}

async function spySend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __artifactSends?: unknown[] }
    g.__artifactSends = []
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', (_event, request) => {
      g.__artifactSends?.push(request)
      return { messageId: `artifact-stub-${g.__artifactSends?.length ?? 0}` }
    })
  })
}

async function sent(app: ElectronApplication): Promise<Array<{ threadId: string; content: string }>> {
  return app.evaluate(
    () =>
      ((globalThis as unknown as { __artifactSends?: Array<{ threadId: string; content: string }> }).__artifactSends ?? []).map(
        (request) => ({ threadId: request.threadId, content: request.content }),
      ),
  )
}

test('a discovery without a page offers Generate artifact, which sends /artifact into its thread', async ({ app, window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedProject(window, 'flow-ux-generate-artifact-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
    writeFileSync(join(dir, NO_PAGE), '# Gadget discovery\n\nNo page yet.\n')
    writeFileSync(join(dir, WITH_PAGE), '# Widget discovery\n\nHas a page.\n')
    writeFileSync(
      join(dir, WITH_PAGE.replace(/\.md$/, '.walkthrough.html')),
      '<!doctype html><html><head><meta charset="utf-8"><title>Widget</title></head><body><h1>Widget</h1></body></html>',
    )
  })
  await activateProject(window, root)
  await spySend(app)

  const thread = await api<{ id: string }>(window, 'threads.create', { projectRoot: root, title: 'Artifact thread' })
  const append = (role: string, content: string): Promise<unknown> =>
    api(window, 'messages.append', { threadId: thread.id, role, content })
  await append('user', 'write the gadget discovery')
  await append('system', `[artifact] discovery ${NO_PAGE}`)
  await append('user', 'and the widget one')
  await append('system', `[artifact] discovery ${WITH_PAGE}`)
  await append('user', 'done')

  await window.getByText('Artifact thread', { exact: true }).first().click()
  await expect(window.locator(sel.conversation)).toBeVisible()
  await expect(window.getByText('done', { exact: true })).toBeVisible()

  const noPage = window.locator(`.fl-artifact-card[data-doc-path="${NO_PAGE}"]`)
  const withPage = window.locator(`.fl-artifact-card[data-doc-path="${WITH_PAGE}"]`)

  // Positive first (allowed-pattern #28): the discovery WITH a page opens it…
  await expect(withPage.getByRole('button', { name: 'Open artifact' })).toBeVisible({ timeout: 10_000 })
  await expect(withPage.getByRole('button', { name: 'Generate artifact' })).toHaveCount(0)
  // …and the one without a page offers to generate it, never a dead door.
  const generate = noPage.getByRole('button', { name: 'Generate artifact' })
  await expect(generate).toBeVisible({ timeout: 10_000 })
  await expect(noPage.getByRole('button', { name: 'Open artifact' })).toHaveCount(0)
  // The old wording is gone from both cards.
  await expect(window.locator('.fl-artifact-card', { hasText: /feature view/i })).toHaveCount(0)

  // PRESSING IT SENDS THE COMMAND INTO THIS THREAD — and only that: the card's
  // own press (open the document) must not fire as well.
  await window.evaluate(() => {
    const seen: unknown[] = []
    ;(window as unknown as { __docOpens: unknown[] }).__docOpens = seen
    document.addEventListener('flow:open-file-path', (event) => seen.push((event as CustomEvent).detail))
  })
  await generate.click()
  const command = `/artifact @${NO_PAGE}`
  await expect.poll(() => sent(app), { timeout: 10_000 }).toEqual([{ threadId: thread.id, content: command }])
  // Echoed like a typed message.
  await expect(window.locator('.fl-conv-feed').getByText(command, { exact: true })).toBeVisible({ timeout: 10_000 })
  const opens = await window.evaluate(() => (window as unknown as { __docOpens: unknown[] }).__docOpens)
  expect(opens).toEqual([])

  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
