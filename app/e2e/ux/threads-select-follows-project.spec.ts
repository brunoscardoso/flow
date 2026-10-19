import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'

/**
 * UX sweep — flow 2: Threads, the SELECTION-follows-active-project seam
 * (ADR-002 / #405 / #411). This is the "select" verb's dangerous variant.
 *
 * Every sibling flow-2 probe drives selection WITHIN one project (create /
 * search / rename / pin / archive / overflow / delete-open teardown). None drive
 * what happens to the thread selection when the ACTIVE PROJECT changes out from
 * under it — and that seam is a silent-data-loss guard, not cosmetics:
 *
 *   threads/index.ts onActiveProjectChanged (178-201) → resolveThreadSelection:
 *     - the new project HAS a last-active thread  → FOLLOW: load it, rebind the
 *       composer (selectThread), move the bold active-row to it.
 *     - the new project is THREAD-LESS            → CLEAR: tear the composer down
 *       and broadcast the null flow:active-thread signal, so decoupled surfaces
 *       (the review reject guard, #397/#405) never stay armed with a thread from
 *       a project that is no longer active. A stale armed thread here would let a
 *       reject revert uncommitted work against the WRONG project.
 *
 * Both directions are driven through the real activeProjectChanged broadcast
 * (project:setActive — the same event the titlebar switcher fires; the
 * seed helper drives it via the app's IPC bridge, never the native picker).
 *
 * Credential-free: threads.create + project:* are immediate IPC. Watches
 * pageerrors throughout (benign Monaco disposal noise filtered).
 */

const SCREENS = 'e2e/ux/__screens'

/** Monaco throws internal cancellation errors when a model is disposed on a
 *  surface swap; no user-visible effect — framework noise, not an app defect. */
const BENIGN = [/^Canceled: Canceled$/, /no diff result available/i]
function appErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN.some((re) => re.test(e)))
}

function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}
/** Create a thread in a SPECIFIC project and open it. The per-project "+"
 *  this used (fixedRoot) left with the flat Workspace list (6249e622), and the
 *  toolbar "+" now opens the new-thread page; the thread is made over the IPC
 *  that page ends in, with the project named, and opened by its row — creating
 *  and opening is what arms the composer. */
async function createNamedThread(win: Page, projectDir: string, title: string): Promise<void> {
  await win.evaluate(
    async ({ root, title }: { root: string; title: string }) => {
      const flow = (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> } }
        }
      ).flow
      await flow.threads.create({ projectRoot: root, title })
    },
    { root: projectDir, title },
  )
  await openThreadByTitle(win, title)
  await expect(threadRow(win, title).first()).toBeVisible({ timeout: 5000 })
}
/** The computed font-weight of a thread row's title (active = 500, inactive = 400). */
async function rowWeight(win: Page, title: string): Promise<string> {
  return threadRow(win, title)
    .first()
    .evaluate((el) => getComputedStyle(el as HTMLElement).fontWeight)
}

test.afterAll(() => cleanupSeeds())

test('switching to a THREAD-LESS project clears the armed thread (composer tears down, #405)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  // Project A gets a thread; project B stays thread-less.
  const projA = await seedProject(window, 'flow-ux-selA-')
  const projB = await seedProject(window, 'flow-ux-selB-')

  await activateProject(window, projA)
  await createNamedThread(window, projA, 'Alpha thread')
  // Creating auto-selects → the composer is bound and visible (a thread is armed).
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 5000 })

  // Switch the active project to thread-less B (real activeProjectChanged).
  await activateProject(window, projB)

  // The composer MUST tear down — no stale Alpha thread stays armed while B is
  // active. A composer still bound here is the #397/#405 silent-mis-target trap.
  await expect(window.locator('.fl-composer')).toBeHidden({ timeout: 6000 })
  await window.screenshot({ path: `${SCREENS}/threads-select-cleared-on-threadless.png` })

  // Re-selecting A's thread re-arms cleanly (no stuck cleared state).
  await threadRow(window, 'Alpha thread').first().click()
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 6000 })

  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})

test('switching between two projects that each have a thread FOLLOWS the selection', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(String(e)))

  const projA = await seedProject(window, 'flow-ux-folA-')
  const projB = await seedProject(window, 'flow-ux-folB-')

  // Seed B's thread first (records B's last-active), then A's (A ends active).
  await activateProject(window, projB)
  await createNamedThread(window, projB, 'Beta thread')
  await activateProject(window, projA)
  await createNamedThread(window, projA, 'Alpha thread')

  // A is active: Alpha is the bold active row, the composer is bound.
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 5000 })
  await expect(async () => {
    expect(await rowWeight(window, 'Alpha thread')).toBe('500')
    expect(await rowWeight(window, 'Beta thread')).toBe('400')
  }).toPass({ timeout: 6000 })

  // Switch to B — the selection FOLLOWS to B's last-active thread: composer stays
  // bound (never torn down between two thread-having projects) and the bold
  // active-row moves to Beta. A selection stuck on Alpha here would mis-target.
  await activateProject(window, projB)
  await expect(window.locator('.fl-composer')).toBeVisible({ timeout: 6000 })
  await expect(async () => {
    expect(await rowWeight(window, 'Beta thread')).toBe('500')
    expect(await rowWeight(window, 'Alpha thread')).toBe('400')
  }).toPass({ timeout: 6000 })
  await window.screenshot({ path: `${SCREENS}/threads-select-followed-to-B.png` })

  // Round-trip back to A — the active row returns to Alpha (no stuck B state).
  await activateProject(window, projA)
  await expect(async () => {
    expect(await rowWeight(window, 'Alpha thread')).toBe('500')
    expect(await rowWeight(window, 'Beta thread')).toBe('400')
  }).toPass({ timeout: 6000 })

  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})
