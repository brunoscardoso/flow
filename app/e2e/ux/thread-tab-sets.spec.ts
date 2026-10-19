import { _electron as electron, type Page } from '@playwright/test'
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'

/**
 * EACH THREAD SEPARATES THE WORK (user, 2026-10-01): files, feature views and
 * the other editor tabs opened while one conversation is selected belong to
 * it. Switching to another conversation shows none of them; switching back
 * restores them; with no conversation selected the project shows its own set;
 * and all of it survives a restart.
 *
 * Driven through the real renderer: files open via the decoupled
 * `flow:open-file` event, the feature view via the event its DISCOVERY card's
 * press dispatches (no wait on the file watcher), and conversations are
 * selected with `flow:open-thread` — the event every "open this chat" surface
 * uses. Clearing the selection is done the way a person does it: archiving the
 * open conversation.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SLUG = 'ledger-sync'
const PAGE = `discovery_${SLUG}_v1.walkthrough.html`
const TITLE = 'Discovery: Ledger Sync'

test.afterAll(() => cleanupSeeds())

interface FlowBridge {
  flow: {
    threads: {
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
      update(r: { threadId: string; patch: { archived?: boolean } }): Promise<unknown>
    }
  }
}

function tab(win: Page, name: string) {
  return win.locator('.fl-editor-tabs .tab', { hasText: name })
}

async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent('flow:open-file', { detail })),
    { rootPath, relPath },
  )
}

async function openFeatureView(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent('flow:open-feature-view', { detail })),
    { rootPath, path: `flow/discovery/${PAGE}`, slug: SLUG, title: TITLE },
  )
}

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) =>
      (await (window as unknown as FlowBridge).flow.threads.create({ projectRoot: root, title })).id,
    { root, title },
  )
}

/**
 * Run `act` and wait until the editor shows the tab set of `threadId` (null:
 * the project's own). A tab opened before then would belong to the set being
 * left, which is not what a person clicking a moment later does.
 */
async function untilScope(
  win: Page,
  threadId: string | null,
  act: { open?: string; archive?: string },
): Promise<void> {
  const settled = await win.evaluate(
    ({ threadId, act }) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 20_000)
        const onScope = (event: Event): void => {
          const detail = (event as CustomEvent<{ threadId: string | null } | null>).detail
          if (detail === null || detail.threadId !== threadId) return
          document.removeEventListener('flow:tab-scope', onScope)
          clearTimeout(timer)
          resolve(true)
        }
        document.addEventListener('flow:tab-scope', onScope)
        const flow = (window as unknown as FlowBridge).flow
        if (act.open !== undefined) {
          document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: act.open } }))
        } else if (act.archive !== undefined) {
          void flow.threads.update({ threadId: act.archive, patch: { archived: true } })
        }
      }),
    { threadId, act },
  )
  expect(settled, `the editor never switched to the tabs of ${threadId ?? 'the project'}`).toBe(true)
}

const selectThread = (win: Page, threadId: string): Promise<void> =>
  untilScope(win, threadId, { open: threadId })

const archiveThread = (win: Page, threadId: string): Promise<void> =>
  untilScope(win, null, { archive: threadId })

test('each conversation keeps its own tabs; the project keeps its own; all of it survives a restart', async ({
  app,
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  const root = await seedProject(window, 'flow-ux-tabsets-')
  writeFileSync(join(root, 'project.ts'), 'export const P = "project-level"\n')
  writeFileSync(join(root, 'alpha.ts'), 'export const A = "thread-a"\n')
  writeFileSync(join(root, 'beta.ts'), 'export const B = "thread-b"\n')
  await activateProject(window, root)
  // Provisioning ends with `flow` linked into the project's Workspace folder
  // (the hard migration, 2026-10-06 — it no longer seeds tasklist.md, which is
  // what this used to wait for). Write nothing under flow/ before the link
  // lands, or the migration's import races the page written below.
  await expect
    .poll(() => existsSync(join(root, 'flow')) && lstatSync(join(root, 'flow')).isSymbolicLink(), {
      timeout: 30_000,
    })
    .toBe(true)
  const discoveryDir = join(root, 'flow', 'discovery')
  mkdirSync(discoveryDir, { recursive: true })
  writeFileSync(
    join(discoveryDir, PAGE),
    '<!doctype html><html><body><h1>Ledger Sync</h1></body></html>\n',
  )

  // ── No conversation selected: the project's own set.
  await openFile(window, root, 'project.ts')
  await expect(tab(window, 'project.ts')).toBeVisible({ timeout: 15_000 })

  const threadA = await createThread(window, root, 'Thread A')
  const threadB = await createThread(window, root, 'Thread B')

  // ── Thread A: starts empty, then gets a file and a feature view.
  await selectThread(window, threadA)
  await expect(tab(window, 'project.ts')).toHaveCount(0, { timeout: 15_000 })
  await openFile(window, root, 'alpha.ts')
  await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 15_000 })
  await openFeatureView(window, root)
  await expect(tab(window, SLUG)).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('.fl-feature-view').filter({ hasText: TITLE })).toBeVisible()

  // ── Thread B: none of A's things.
  await selectThread(window, threadB)
  // Positive first (allowed-pattern #28): B's own file opens and shows…
  await openFile(window, root, 'beta.ts')
  await expect(tab(window, 'beta.ts')).toBeVisible({ timeout: 15_000 })
  // …and A's file and feature view are not in the strip, nor on screen.
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  await expect(tab(window, SLUG)).toHaveCount(0)
  await expect(window.locator('.fl-feature-view').filter({ hasText: TITLE })).toBeHidden()

  // ── Back to A: its file and feature view return, B's file is gone.
  await selectThread(window, threadA)
  await expect(tab(window, 'alpha.ts')).toBeVisible({ timeout: 15_000 })
  await expect(tab(window, SLUG)).toBeVisible({ timeout: 15_000 })
  await expect(tab(window, 'beta.ts')).toHaveCount(0)

  // ── Archive the open conversation → nothing selected → the project's set.
  await archiveThread(window, threadA)
  await expect(tab(window, 'project.ts')).toBeVisible({ timeout: 15_000 })
  await expect(tab(window, 'alpha.ts')).toHaveCount(0)
  await expect(tab(window, SLUG)).toHaveCount(0)
  await expect(tab(window, 'beta.ts')).toHaveCount(0)

  // ── Restart: B selected before quitting comes back with B's tab only.
  await selectThread(window, threadB)
  await expect(tab(window, 'beta.ts')).toBeVisible({ timeout: 15_000 })
  await expect(tab(window, 'project.ts')).toHaveCount(0)
  await app.close()

  const relaunched = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      DISABLE_AUTO_UPDATE: 'true',
    },
  })
  try {
    const win = await relaunched.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissFlowOverlay(win)
    await expect(tab(win, 'beta.ts')).toBeVisible({ timeout: 30_000 })
    await expect(tab(win, 'alpha.ts')).toHaveCount(0)
    await expect(tab(win, 'project.ts')).toHaveCount(0)
    // A's set is still on disk across the restart: unarchive and select it.
    await win.evaluate(
      async (id) =>
        (window as unknown as FlowBridge).flow.threads.update({ threadId: id, patch: { archived: false } }),
      threadA,
    )
    await selectThread(win, threadA)
    await expect(tab(win, 'alpha.ts')).toBeVisible({ timeout: 15_000 })
    await expect(tab(win, SLUG)).toBeVisible({ timeout: 15_000 })
    await expect(tab(win, 'beta.ts')).toHaveCount(0)
  } finally {
    await relaunched.close().catch(() => undefined)
  }
})
