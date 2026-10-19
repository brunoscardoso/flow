import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread, waitForWorkspaceLink } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for #658 — switching between chats must not carry another
 * thread's artifact card along. An artifact card (threads/artifact-card.ts)
 * belongs to the thread that was ACTIVE when its flow/ doc-change event
 * arrived (the same ownership rule the story card uses): it renders only
 * there, disappears when another thread is shown, and re-mounts when its
 * owning thread returns.
 *
 * Drives the real app end to end: a real brainstorm .md dropped into
 * `flow/brainstorms/` is picked up by the main-process ArtifactObserver
 * (debounced chokidar watch) and surfaced as a live card in the active
 * thread's feed — then the probe hops between two real threads and asserts
 * the card follows ownership, not the viewport.
 */

test.describe('artifact card thread ownership (#658)', () => {
  test.afterAll(() => cleanupSeeds())

  test('a brainstorm card stays in the thread that observed it — and only there', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window)
    await activateProject(window, root)

    // Thread A — active when the doc change lands, so it becomes the owner.
    // Threads are made directly and opened by their rows: "+" opens the
    // new-thread page, whose Create sends a first message, and this spec is
    // about which open thread a card belongs to, not about starting one.
    const openThread = (title: string) =>
      window.locator('.fl-thread-sidebar').getByText(title, { exact: true }).first().click()
    await openEmptyThread(window, root, 'Thread A')
    await expect(window.locator(sel.composer)).toBeVisible()
    await expect(window.locator('.fl-artifact-card')).toHaveCount(0)

    // A doc written while the project is being placed in its Workspace is
    // only re-listed (history) — write it once the project is placed.
    await waitForWorkspaceLink(root)
    const dir = join(root, 'flow', 'brainstorms')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'brainstorm_widget.md'), '# Widget brainstorm\n\nLoose ideas.\n')

    const card = window.locator('.fl-artifact-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('.fl-artifact-eyebrow')).toHaveText('BRAINSTORM')

    // Thread B — opening it switches the pane. The #658 leak re-mounted the
    // brainstorm card here after B's (empty) history load settled, so wait out
    // that settle window before asserting absence — an instant count-0 pass
    // would be vacuous.
    await openEmptyThread(window, root, 'Thread B')
    await expect(window.locator('fl-list .fl-row-current')).toContainText('Thread B')
    await window.waitForTimeout(600)
    await expect(card).toHaveCount(0)

    // Back to thread A — the surviving model re-mounts in its owning thread.
    await openThread('Thread A')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.locator('.fl-artifact-eyebrow')).toHaveText('BRAINSTORM')

    // Forward to B once more — still no leak.
    await openThread('Thread B')
    await window.waitForTimeout(600)
    await expect(card).toHaveCount(0)

    expect(errors, `uncaught errors during ownership flow:\n${errors.join('\n')}`).toEqual([])
  })
})
