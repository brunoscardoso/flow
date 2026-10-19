import { _electron as electron, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'

/**
 * EACH THREAD IS ITS OWN CONTEXT — "your terminals too" (user, 2026-10-01).
 *
 * A shell a person opens belongs to the conversation it was opened in. Another
 * conversation does not show it; going back shows the SAME shell (same PTY,
 * scrollback intact — never respawned); the project view (no conversation
 * selected) has shells of its own; and each scope's shells come back after a
 * restart.
 *
 * Conversations are selected with `flow:open-thread` (what every "open this
 * chat" surface dispatches) and each step waits for the editor's
 * `flow:tab-scope` announcement — the positive proof that a switch happened
 * before anything is asserted absent (allowed-pattern #28).
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

test.afterAll(() => cleanupSeeds())

interface FlowBridge {
  flow: {
    threads: {
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
      update(r: { threadId: string; patch: { archived?: boolean } }): Promise<unknown>
    }
    terminal: { list(): Promise<Array<{ terminalId: string; kind: string }>> }
  }
}

const visibleHosts = (win: Page) => win.locator('.fl-term-host:not([hidden])')
const hostById = (win: Page, id: string) => win.locator(`.fl-term-host[data-terminal-id="${id}"]`)
const termTabs = (win: Page) => win.locator('.fl-term-tabs .tab')

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) =>
      (await (window as unknown as FlowBridge).flow.threads.create({ projectRoot: root, title })).id,
    { root, title },
  )
}

/** Run `act` and wait for the editor to settle on `threadId`'s scope (null: the project view). */
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
  expect(settled, `never switched to ${threadId ?? 'the project view'}`).toBe(true)
}

const selectThread = (win: Page, threadId: string): Promise<void> =>
  untilScope(win, threadId, { open: threadId })

/** The one shell on screen once it is live (prompt drawn); returns its id. */
async function onlyVisibleShell(win: Page): Promise<string> {
  await expect(visibleHosts(win)).toHaveCount(1, { timeout: 20_000 })
  await expect(visibleHosts(win).locator('.xterm')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => (await visibleHosts(win).locator('.xterm-rows').innerText()).trim().length, {
      timeout: 15_000,
    })
    .toBeGreaterThan(0)
  const id = await visibleHosts(win).getAttribute('data-terminal-id')
  expect(id).toBeTruthy()
  return id as string
}

async function typeMarker(win: Page, terminalId: string, marker: string): Promise<void> {
  const host = hostById(win, terminalId)
  await host.click()
  await win.keyboard.type(`echo ${marker}`)
  await win.keyboard.press('Enter')
  await expect
    .poll(
      async () =>
        ((await host.locator('.xterm-rows').innerText()).match(new RegExp(marker, 'g')) ?? []).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(2)
}

test('a shell belongs to the conversation it was opened in; switching hides and restores it; restarts keep each set', async ({
  app,
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  const root = await seedProject(window, 'flow-ux-term-own-')
  await activateProject(window, root)
  await expect(window.locator(sel.terminalRoot)).toBeVisible({ timeout: 15_000 })

  const threadA = await createThread(window, root, 'Thread A')
  const threadB = await createThread(window, root, 'Thread B')

  // ── Thread A gets its own shell; leave a marker in it.
  await selectThread(window, threadA)
  const shellA = await onlyVisibleShell(window)
  await typeMarker(window, shellA, 'OWN_MARKER_ALPHA')

  // ── Thread B: switched (proven above by the scope event), B gets its own
  //    shell — and A's is not on the strip nor on screen.
  await selectThread(window, threadB)
  const shellB = await onlyVisibleShell(window)
  expect(shellB, 'B got a shell of its own').not.toBe(shellA)
  await expect(hostById(window, shellA)).toBeHidden()
  await expect(termTabs(window)).toHaveCount(1)
  await expect(visibleHosts(window).locator('.xterm-rows')).not.toContainText('OWN_MARKER_ALPHA')
  await typeMarker(window, shellB, 'OWN_MARKER_BETA')

  // ── Back to A: the SAME shell (same id, scrollback intact), B's hidden.
  await selectThread(window, threadA)
  await expect(hostById(window, shellA)).toBeVisible({ timeout: 15_000 })
  await expect(hostById(window, shellA).locator('.xterm-rows')).toContainText('OWN_MARKER_ALPHA')
  await expect(hostById(window, shellB)).toBeHidden()
  await expect(termTabs(window)).toHaveCount(1)
  // Never respawned, never killed: both PTYs are still the ones main holds.
  const live = await window.evaluate(async () =>
    (await (window as unknown as FlowBridge).flow.terminal.list()).map((t) => t.terminalId),
  )
  expect(live).toEqual(expect.arrayContaining([shellA, shellB]))

  // ── Project view (nothing selected): neither thread's shell; its own one.
  await untilScope(window, null, { archive: threadA })
  const shellProject = await onlyVisibleShell(window)
  expect([shellA, shellB]).not.toContain(shellProject)
  await expect(hostById(window, shellA)).toBeHidden()
  await expect(hostById(window, shellB)).toBeHidden()

  // ── B gets a second shell, then the app restarts with B selected.
  await selectThread(window, threadB)
  await expect(hostById(window, shellB)).toBeVisible({ timeout: 15_000 })
  await window.locator('.fl-term-tool[aria-label="New terminal"]').click()
  await expect(termTabs(window)).toHaveCount(2, { timeout: 15_000 })
  await app.close()

  const relaunched = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      FLOW_E2E_BACKGROUND: '1',
      DISABLE_AUTO_UPDATE: 'true',
    },
  })
  try {
    const win = await relaunched.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissFlowOverlay(win)
    await expect(win.locator(sel.terminalRoot)).toBeVisible({ timeout: 30_000 })
    // B's two shells come back — not one auto-started shell.
    await expect(termTabs(win)).toHaveCount(2, { timeout: 30_000 })
    // A's single shell comes back when A is selected again.
    await win.evaluate(
      async (id) =>
        (window as unknown as FlowBridge).flow.threads.update({ threadId: id, patch: { archived: false } }),
      threadA,
    )
    await selectThread(win, threadA)
    await expect(termTabs(win)).toHaveCount(1, { timeout: 20_000 })
    const all = await win.evaluate(async () =>
      (await (window as unknown as FlowBridge).flow.terminal.list()).filter((t) => t.kind === 'user').length,
    )
    expect(all, 'A’s shell and B’s two, nothing doubled').toBe(3)
  } finally {
    await relaunched.close().catch(() => undefined)
  }
})
