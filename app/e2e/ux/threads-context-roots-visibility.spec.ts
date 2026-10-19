import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { statusButtonByText } from '../selectors'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2 (threads sidebar), round 24: the sidebar's story about a
 * thread's EXTRA CONTEXT FOLDERS (#695) — what it shows, and what it writes back.
 *
 * Flow 2 is the most-covered flow in the rotation (43 specs: create, search,
 * rename, pin, archive, delete, multi-select, overflow, collapse, keyboard nav,
 * project menu, put-away modes). Every one of them drives a thread's *own*
 * lifecycle. The two sibling context-root specs stop at creation: `thread-
 * context-roots.spec.ts` adds a folder to a thread and reads the store back;
 * `task-context-roots.spec.ts` creates a task with a folder checked and reads
 * the store back; `tasks-newtask-context-draft.spec.ts` (#996) drives the draft.
 * Nobody had asked what the sidebar SHOWS afterwards, or what happens to that
 * scope when the folder's project is removed.
 *
 * Two confirmed bugs, both silent, both zero-pageerror:
 *
 *  1. **#1413 — a task's extra folders are invisible and unrevocable on its row.**
 *     `#renderTaskRow` has no multi-project badge and `#openTaskMenu` has no
 *     "Add folder to context…", while `#renderThreadRow`/`#openRowMenu` (the
 *     rows one line above, for the same underlying thread) have both. Typing in
 *     the search box flattens the task into a plain thread row — so the SAME
 *     task suddenly shows the `+<folder>` badge and offers the verb.
 *
 *  2. **#1414 — removing a project revokes the scope in the store, then the UI
 *     hands it back.** `removeProject` prunes `thread_roots` by path (the #261
 *     containment fix). The sidebar never re-lists threads on `rootsChanged`, so
 *     the row keeps its `+<removed folder>` badge and the context dialog reopens
 *     with the removed folder TICKED — pressing Apply writes the stale set back
 *     through `threads:setRoots`, re-granting a folder that is no longer a
 *     project root at all.
 *
 * The live guards pin what works today (the thread row's badge + verb, the same
 * pair appearing on the task row under search, and the store-side prune) so the
 * `test.fixme` tripwires below cannot pass vacuously. Each tripwire states the
 * expected UX and is verified RED against current `main`.
 *
 * Credential-free: threads/tasks/project IPC only — no account, no agent turn,
 * no native dialog (Browse… is never touched).
 */

test.afterAll(() => cleanupSeeds())

/** Every sidebar row: its text plus the multi-project badge, if any. The badge
 *  was a "+name" chip titled "Also spans …"; since 146bf3ea it is one mark on
 *  the row whose accessible name carries the whole answer — "Also reaches N
 *  other project(s): <names>" — so that name is what is read here. */
async function sidebarRows(win: Page): Promise<Array<{ text: string; badge: string | null }>> {
  return win.evaluate(() => {
    const list = document.querySelector('.fl-thread-sidebar fl-list')
    return [...(list?.shadowRoot?.querySelectorAll('.row') ?? [])].map((row) => {
      const badge = [...row.querySelectorAll('span')].find((s) =>
        (s.getAttribute('aria-label') ?? '').includes('Also reaches'),
      )
      return {
        text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
        badge: badge ? badge.getAttribute('aria-label') : null,
      }
    })
  })
}

/** The badge on the row whose text contains `needle` (null = row has none). */
async function badgeOf(win: Page, needle: string): Promise<string | null> {
  const rows = await sidebarRows(win)
  return rows.find((r) => r.text.includes(needle))?.badge ?? null
}

/** additionalRoots of every thread in a project, straight from the store. */
async function threadRoots(win: Page, projectRoot: string): Promise<string[]> {
  return win.evaluate(async (root) => {
    const threads = await (
      window as unknown as {
        flow: { threads: { list(r: { projectRoot: string }): Promise<Array<{ additionalRoots: string[] }>> } }
      }
    ).flow.threads.list({ projectRoot: root })
    return threads.flatMap((t) => t.additionalRoots)
  }, projectRoot)
}

/** The registered project roots (a removed project must not be among them). */
async function projectRoots(win: Page): Promise<string[]> {
  return win.evaluate(async () => {
    const roots = await (
      window as unknown as { flow: { project: { list(): Promise<Array<{ rootPath: string }>> } } }
    ).flow.project.list()
    return roots.map((r) => r.rootPath)
  })
}

/** Create a bare thread in the active project. The multi-project chooser "+"
 *  used to open was retired with the new-thread page (2026-09-04); the thread
 *  is made over the IPC that page ends in — these guards are about the row. */
async function newThread(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const flow = (
      window as unknown as {
        flow: {
          project: { active(): Promise<{ rootPath: string } | null> }
          threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> }
        }
      }
    ).flow
    const active = await flow.project.active()
    if (active === null) throw new Error('newThread: no active project')
    await flow.threads.create({ projectRoot: active.rootPath, title: 'New thread' })
  })
  await expect(win.locator('fl-list').getByText('New thread', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })
}

/** Attach `dirB` to a row via its ⋯ menu → "Add folder to context…" → Apply. */
async function attachContextFolder(win: Page, rowText: string): Promise<void> {
  await win.locator('fl-list').getByText(rowText, { exact: true }).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Add folder to context' }).click()
  const overlay = win.locator('.fl-context-roots-overlay')
  await expect(overlay).toBeVisible()
  await overlay.locator('input[type="checkbox"]').first().check()
  await overlay.locator('.fl-context-roots-apply').click()
  await expect(overlay).toHaveCount(0)
}

/** Create a task in the active project with the other project checked as context. */
async function newTaskWithContext(win: Page, title: string, otherDir: string): Promise<void> {
  await win.locator(statusButtonByText('Tasks')).click()
  await win.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(win.locator('.fl-board-modal')).toBeVisible()
  await win.locator('.fl-board-modal-body input[type="text"]').first().fill(title)
  const ctxRow = win.locator('.fl-board-modal-context-row', { hasText: otherDir.split('/').pop()! })
  await expect(ctxRow).toBeVisible()
  await ctxRow.locator('input[type="checkbox"]').check()
  await win.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(win.locator('.fl-board-modal')).toBeHidden()
  await expect(win.locator('fl-list').getByText(title, { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })
}

/** Remove a seeded project through its group ⋯ menu (cascade + prune, #261). */
async function removeProject(win: Page, dir: string): Promise<void> {
  const name = dir.split('/').pop()!
  await win.locator('fl-list').getByText(name, { exact: true }).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' }).click()
  await expect(menu.locator('.fl-thread-menu-confirm')).toBeVisible()
  await menu.locator('button', { hasText: /^Remove$/ }).first().click()
  await expect(menu).toHaveCount(0)
  await expect.poll(async () => (await projectRoots(win)).includes(dir), { timeout: 5000 }).toBe(false)
}

// ── LIVE guards ─────────────────────────────────────────────────────────────

test('a thread spanning another project shows the +badge and offers the context verb (#695)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-ctxvisA-')
  const dirB = await seedProject(window, 'flow-ux-ctxvisB-')
  await activateProject(window, dirA)

  await newThread(window)
  // Before: no extra scope, so no badge.
  expect(await badgeOf(window, 'New thread')).toBeNull()

  await attachContextFolder(window, 'New thread')
  await expect.poll(async () => (await threadRoots(window, dirA)).includes(dirB), { timeout: 5000 }).toBe(true)

  // The row advertises the span, and the verb that manages it is one click away.
  await expect
    .poll(async () => await badgeOf(window, 'New thread'), { timeout: 5000 })
    .toContain(dirB.split('/').pop()!)
  await window.locator('fl-list').getByText('New thread', { exact: true }).first().click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  expect(await menu.innerText()).toContain('Add folder to context')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test("under search, a task's row DOES carry the badge and the context verb (#1413 control)", async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-ctxsA-')
  const dirB = await seedProject(window, 'flow-ux-ctxsB-')
  await activateProject(window, dirA)
  await newTaskWithContext(window, 'Cross repo task', dirB)

  // Searching flattens the task's thread into an ordinary thread row — which is
  // exactly where the renderer proves it CAN show the span and offer the verb.
  await window.locator('input[placeholder*="Search"]').first().fill('Cross')
  await expect
    .poll(async () => await badgeOf(window, 'Cross repo task'), { timeout: 10_000 })
    .toContain(dirB.split('/').pop()!)

  await window
    .locator('fl-list')
    .getByText('Cross repo task', { exact: true })
    .first()
    .click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  expect(await menu.innerText()).toContain('Add folder to context')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// FIXME(project menu): `removeProject` right-clicks the project's group header,
// which left the sidebar with the flat Workspace list (6249e622). "Remove from
// sidebar" now lives in the project menu, asked for from the Workspace
// switcher's project row, which this harness cannot reach yet.
test.fixme('removing a project prunes it out of other threads\' context roots (#261)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dirA = await seedProject(window, 'flow-ux-ctxprA-')
  const dirB = await seedProject(window, 'flow-ux-ctxprB-')
  await activateProject(window, dirA)

  await newThread(window)
  await attachContextFolder(window, 'New thread')
  await expect.poll(async () => (await threadRoots(window, dirA)).includes(dirB), { timeout: 5000 }).toBe(true)

  await removeProject(window, dirB)

  // The store-side containment property #261 was closed to guarantee.
  await expect
    .poll(async () => await threadRoots(window, dirA), { timeout: 5000 })
    .not.toContain(dirB)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// ── Tripwires — expected UX, RED against current main ───────────────────────

test.fixme(
  '#1413: a task row shows the same +badge as a thread spanning the same folder',
  async ({ window }) => {
    const dirA = await seedProject(window, 'flow-ux-ctxt1A-')
    const dirB = await seedProject(window, 'flow-ux-ctxt1B-')
    await activateProject(window, dirA)
    await newTaskWithContext(window, 'Cross repo task', dirB)

    const badge = await badgeOf(window, 'Cross repo task')
    expect(
      badge,
      `the task's extra context folder is invisible on its row — rows: ${JSON.stringify(
        await sidebarRows(window),
      )}`,
    ).toContain(dirB.split('/').pop()!)
  },
)

test.fixme('#1413: a task row\'s ⋯ menu offers "Add folder to context…"', async ({ window }) => {
  const dirA = await seedProject(window, 'flow-ux-ctxt2A-')
  const dirB = await seedProject(window, 'flow-ux-ctxt2B-')
  await activateProject(window, dirA)
  await newTaskWithContext(window, 'Cross repo task', dirB)

  await window
    .locator('fl-list')
    .getByText('Cross repo task', { exact: true })
    .first()
    .click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  const items = (await menu.innerText()).replace(/\n/g, ' | ')
  expect(items, `the task's context folders cannot be reviewed or revoked from its row (showing: ${items})`).toContain(
    'Add folder to context',
  )
})

test.fixme('#1414: removing a project clears the stale +badge from the threads that spanned it', async ({
  window,
}) => {
  const dirA = await seedProject(window, 'flow-ux-ctxt3A-')
  const dirB = await seedProject(window, 'flow-ux-ctxt3B-')
  await activateProject(window, dirA)
  await newThread(window)
  await attachContextFolder(window, 'New thread')
  await removeProject(window, dirB)

  // The store already dropped it (guarded above) — the row must not keep claiming it.
  const badge = await badgeOf(window, 'New thread')
  expect(
    badge,
    `the row still advertises a context folder the store dropped when its project was removed (badge: ${badge})`,
  ).toBeNull()
})

test.fixme('#1414: reopening the context dialog after a removal does not re-grant the revoked folder', async ({
  window,
}) => {
  const dirA = await seedProject(window, 'flow-ux-ctxt4A-')
  const dirB = await seedProject(window, 'flow-ux-ctxt4B-')
  await activateProject(window, dirA)
  await newThread(window)
  await attachContextFolder(window, 'New thread')
  await removeProject(window, dirB)
  expect(await threadRoots(window, dirA)).not.toContain(dirB) // precondition: revoked

  // Open "Add folder to context…" and Apply without touching anything.
  await window.locator('fl-list').getByText('New thread', { exact: true }).first().click({ button: 'right' })
  const menu = window.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Add folder to context' }).click()
  const overlay = window.locator('.fl-context-roots-overlay')
  await expect(overlay).toBeVisible()
  await overlay.locator('.fl-context-roots-apply').click()
  await expect(overlay).toHaveCount(0)
  await window.waitForTimeout(1000)

  expect(
    await threadRoots(window, dirA),
    'Apply re-granted the agent a folder whose project the user removed (and which is not a project root)',
  ).not.toContain(dirB)
})
