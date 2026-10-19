/**
 * A GENERATED PAGE OPENS AS A PAGE.
 *
 * An agent writes `docs/playbook-output-contract.html`, says "open it directly
 * in a browser", and clicking the name in the transcript gave a tab of
 * `<!DOCTYPE html>` (user, 2026-09-18). Flow has a browser; the link was
 * pointed at the wrong one of its own surfaces.
 *
 * ASKS THE WEBVIEW WHAT IT LOADED, not the app what it intended
 * (forbidden-pattern #7) — a dispatched event and an opened tab prove nothing
 * about whether the page is on screen.
 */
import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.afterAll(() => cleanupSeeds())

const TITLE = 'Playbook Output Contract'

test('clicking an .html reference in chat opens it in the embedded browser', async ({ window }) => {
  test.setTimeout(300_000)

  const root = await seedProject(window, 'orbit-app-', (dir) => {
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(
      join(dir, 'docs', 'playbook-output-contract.html'),
      `<!DOCTYPE html><html><head><title>${TITLE}</title></head><body><h1>${TITLE}</h1></body></html>\n`,
    )
  })
  await activateProject(window, root)

  const THREAD = 'Output contract thread'
  await window.evaluate(
    async ({ p, title }: { p: string; title: string }) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const thread = await flow.threads.create({ projectRoot: p, title })
      await flow.messages.append({
        threadId: thread.id,
        role: 'assistant',
        // A code span naming a file is what becomes a chip — which is exactly
        // how the agent wrote it in the report that prompted this.
        content:
          'See `docs/playbook-output-contract.html` — open it directly in a browser.',
      })
    },
    { p: root, title: THREAD },
  )
  // Opened the way a person opens it — the row has to exist for the transcript
  // to mount, and a dispatched id does not put one there.
  await window.getByText(THREAD, { exact: true }).first().click()

  const link = window.locator('.fl-md-file', { hasText: 'playbook-output-contract.html' }).first()
  await expect(link).toBeVisible({ timeout: 30_000 })
  // The tooltip is where a person finds the other way in — an inline chip in a
  // paragraph has no room for a second control.
  await expect(link).toHaveAttribute('title', /browser/)

  await link.click()

  // THE BROWSER TAB IS ON SCREEN…
  const webview = window.locator('webview')
  await expect(webview).toBeVisible({ timeout: 60_000 })
  // …and it is showing THIS page. The src is what the guest was pointed at.
  await expect
    .poll(async () => webview.getAttribute('src'), { timeout: 60_000 })
    .toContain('playbook-output-contract.html')
  // The editor did NOT open the source instead — the positive above proves the
  // click landed, so this absence means something (allowed-pattern #28).
  await expect(
    window.locator('.fl-tab', { hasText: 'playbook-output-contract.html' }),
  ).toHaveCount(0)
})
