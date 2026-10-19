/**
 * Workspaces Phase 11 — the deep end-to-end scenarios, one per requirement.
 *
 * Real everywhere it can be: seeded git repos (a backend, a frontend, …), a
 * temp Flow folder per "machine", every Workspace operation going through main
 * → the bundled CLI, and a Workspace remote that is a LOCAL bare repository
 * behind an ordinary https address (fixtures/workspaces.ts) — so sync really
 * commits, merges and pushes, and git in the app cannot reach the network.
 *
 * STOOD IN FOR, in main, through `e2e-seams.ts` (honoured only under
 * FLOW_E2E=1): the context gate's model call (a fixed answer) and the agent
 * runtime (records each session's folders, answers one line, ends the turn).
 * Nothing here spawns an agent CLI or reaches a model.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import {
  addProjects,
  closeProjectOnboarding,
  expectHittable,
  expectOnScreen,
  gateCalls,
  installStandIns,
  launchFlow,
  lazySandbox,
  openWorkspaceSettings,
  recordedStarts,
  type LaunchedFlow,
} from '../fixtures/workspaces'

const SCREENS = process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')
const DECISION = 'brain/decisions/flag-rollout.md'

/** The preload bridge, untyped here. */
const BRIDGE = 'flow'

/** A thread as `threads.get` answers it (the fields these specs read). */
interface ThreadView {
  id: string
  status: string
  roots?: string[]
}

async function getThread(page: Page, threadId: string): Promise<ThreadView> {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
    async ({ bridge, id }) => (window as unknown as Record<string, any>)[bridge].threads.get({ threadId: id }),
    { bridge: BRIDGE, id: threadId },
  )
}

/** Write a knowledge file through a checkout's own `flow/` link, as an agent or a person would. */
function writeKnowledge(repo: string, path: string, text: string): void {
  const target = join(repo, 'flow', path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

/** Type into the composer as a person does, and send with Enter. */
async function sendFromComposer(page: Page, text: string): Promise<void> {
  await page.locator('.fl-composer-input').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: join(SCREENS, `deep-${name}.png`) })
}

/**
 * New Workspace… from the switcher: name, address, then MOVE the named
 * projects in (every project already lives in a Workspace — Default, once
 * added — so a new Workspace takes projects moved from another).
 */
async function createWorkspaceFromDialog(page: Page, name: string, remote: string | null, expectProjects: string[]): Promise<void> {
  // An added project joins its Workspace once it is provisioned — wait for every one to be placed.
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
          const listed = await (window as unknown as { flow: any }).flow.workspaces.list()
          if (!listed.ok) return []
          return listed.workspaces.flatMap((workspace: { projects: Array<{ name: string }> }) => workspace.projects.map((project) => project.name))
        }),
      { timeout: 90_000 },
    )
    .toEqual(expect.arrayContaining(expectProjects))
  const switcher = page.locator('.fl-ws-switcher')
  await expect(switcher).toBeVisible({ timeout: 30_000 })
  await switcher.locator('.fl-project-current').click()
  await switcher.locator('[data-action="new-workspace"]').click()
  const create = page.locator('.fl-ws-dialog[data-dialog="create"]')
  await expect(create).toBeVisible()
  await create.locator('#fl-ws-create-name').fill(name)
  if (remote !== null) await create.locator('#fl-ws-create-remote').fill(remote)
  await create.locator('.fl-ws-dialog-btn', { hasText: 'Create Workspace' }).click()
  await expect(create.locator('.fl-ws-dialog-title')).toHaveText('Move projects into it?', { timeout: 30_000 })
  const projects = create.locator('.fl-ws-dialog-project')
  for (const project of expectProjects) {
    await projects.filter({ hasText: `${project} — in ` }).locator('input[type="checkbox"]').check()
  }
  await create.locator('.fl-ws-dialog-btn', { hasText: 'Move selected' }).click()
  for (const project of expectProjects) {
    await expect(projects.filter({ hasText: `${project} — in ` }).locator('.fl-ws-dialog-project-status')).toHaveText('Done', {
      timeout: 90_000,
    })
  }
  await create.locator('.fl-ws-dialog-btn', { hasText: 'Done' }).click()
  await expect(create).toHaveCount(0)
  await expect(switcher.locator('.fl-project-name')).toHaveText(name, { timeout: 30_000 })
}

/** Settings → Workspaces → the Workspace's card → Sync now, until it says it synced (or `expect`). */
async function syncNowInSettings(page: Page, slug: string, expectText: RegExp = /^(Synced|Up to date)/): Promise<void> {
  const section = await openWorkspaceSettings(page)
  const card = section.locator(`.fl-wss-card[data-workspace="${slug}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  const syncNow = card.locator('[data-part="sync-now"]')
  await expect(syncNow).toBeEnabled({ timeout: 60_000 })
  await syncNow.click()
  await expect(card.locator('[data-part="sync-status"]')).toHaveText(expectText, { timeout: 60_000 })
}

// ── 1. Sync: create → knowledge → bare remote → a second machine joins → a collision ──

test.describe('sync', () => {
  const seeded = lazySandbox('deep-sync', (sandbox) => ({
    backend: sandbox.seedRepo('backend'),
    frontend: sandbox.seedRepo('frontend'),
  }))
  test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })
  test.afterAll(async () => seeded.cleanup())

  test('a Workspace syncs to its shared repository, a second machine joins it, and a decision collision asks', async ({ window }) => {
    const { sandbox, backend, frontend } = seeded.get()
    test.setTimeout(300_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(error.message))

    // ── Machine 1: create the Workspace from the New dialog, with both open projects ──
    await addProjects(window, [backend, frontend])
    await closeProjectOnboarding(window, 3_000)
    await createWorkspaceFromDialog(window, 'Acme', sandbox.remoteUrl, ['backend', 'frontend'])
    expect(lstatSync(join(backend, 'flow')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(frontend, 'flow')).isSymbolicLink()).toBe(true)

    // Knowledge written through the project's own flow/ lands in the Workspace…
    writeKnowledge(backend, DECISION, 'Roll flags out team by team.\n')
    const workspaceFolder =
      (sandbox.cli(['status']).workspaces as Array<{ slug: string; path: string }>).find((workspace) => workspace.slug === 'acme')?.path ?? ''
    expect(readFileSync(join(workspaceFolder, 'projects', 'backend', DECISION), 'utf8')).toBe('Roll flags out team by team.\n')
    // …and Sync now sends it to the shared repository (positive first: nothing there yet).
    expect(sandbox.remoteFiles()).not.toContain(`projects/backend/${DECISION}`)
    await syncNowInSettings(window, 'acme')
    await screenshot(window, 'sync-synced')
    expect(sandbox.remoteFile(`projects/backend/${DECISION}`)).toBe('Roll flags out team by team.\n')
    expect(sandbox.remoteFiles()).toEqual(expect.arrayContaining(['workspace.json', 'projects/frontend/brain/.gitkeep']))

    // ── Machine 2: its own profile, Flow folder and checkouts — joins from the dialog ──
    const machine2 = sandbox.newMachine('machine-2')
    const backend2 = sandbox.cloneRepo(backend, machine2)
    const frontend2 = sandbox.cloneRepo(frontend, machine2)
    let second: LaunchedFlow | null = null
    try {
      second = await launchFlow(sandbox.appEnv({ machine: machine2 }))
      const win2 = second.window
      win2.on('pageerror', (error) => errors.push(`machine 2: ${error.message}`))
      // Joined FIRST, then the projects opened: every project opened joins the
      // Workspace being looked at — the joined one. (A project opened before the
      // join already lives in Default, and moving it into a Workspace that lists
      // the same project needs the CLI to merge the two — not offered yet.)
      const switcher2 = win2.locator('.fl-ws-switcher')
      await expect(switcher2).toBeVisible({ timeout: 30_000 })
      await switcher2.locator('.fl-project-current').click()
      await switcher2.locator('[data-action="join-workspace"]').click()
      const join2 = win2.locator('.fl-ws-dialog[data-dialog="join"]')
      await expect(join2).toBeVisible()
      await join2.locator('#fl-ws-join-address').fill(sandbox.remoteUrl)
      await join2.locator('.fl-ws-dialog-btn', { hasText: /^Join$/ }).click()
      await expect(join2.locator('.fl-ws-dialog-title')).toHaveText('Joined Acme.', { timeout: 60_000 })
      await screenshot(win2, 'join-second-machine')
      await join2.locator('.fl-ws-dialog-btn', { hasText: 'Done' }).click()
      await expect(join2).toHaveCount(0)
      await expect(switcher2.locator('.fl-project-name')).toHaveText('Acme', { timeout: 30_000 })
      // Positive first: nothing of this machine is in the Workspace yet.
      const workspacesDir2 = realpathSync(join(machine2.flowHome, 'workspaces'))
      expect(existsSync(join(backend2, 'flow'))).toBe(false)
      await addProjects(win2, [backend2, frontend2])
      await closeProjectOnboarding(win2, 3_000)
      await expect
        .poll(() => (existsSync(join(backend2, 'flow')) ? realpathSync(join(backend2, 'flow')) : ''), { timeout: 90_000 })
        .toContain(join(workspacesDir2, 'acme'))
      expect(lstatSync(join(backend2, 'flow')).isSymbolicLink()).toBe(true)
      // The first machine's knowledge, read through the second machine's own checkout.
      expect(readFileSync(join(backend2, 'flow', DECISION), 'utf8')).toBe('Roll flags out team by team.\n')
      await expect(switcher2.locator('.fl-project-name')).toHaveText('Acme', { timeout: 30_000 })

      // ── The same decision changed on both machines: machine 2 syncs first… ──
      writeKnowledge(backend2, DECISION, 'Roll flags out by percentage of users.\n')
      await syncNowInSettings(win2, 'acme')
      expect(sandbox.remoteFile(`projects/backend/${DECISION}`)).toBe('Roll flags out by percentage of users.\n')

      // …so machine 1's sync pauses and asks, from a notification.
      writeKnowledge(backend, DECISION, 'Roll flags out by region.\n')
      await syncNowInSettings(window, 'acme', /choose|paused|waiting/i)
        // The notification — not the settings card's own button — is the way in here.
      const toast = window.locator('.fl-flow-toast', { hasText: 'Workspace sync paused' })
      await expect(toast).toBeVisible({ timeout: 30_000 })
      await expect(toast).toContainText('Acme')
      const review = toast.getByRole('button', { name: 'Review the changes' })
      await expect(review).toBeVisible({ timeout: 30_000 })
      // Pressable — not under another card in the same corner (the learn ask covered it).
      await expectHittable(window, review)
      await screenshot(window, 'collision-notification')
      // Nothing was pushed while it waits.
      expect(sandbox.remoteFile(`projects/backend/${DECISION}`)).toBe('Roll flags out by percentage of users.\n')
      await review.click()
      const collision = window.locator('.fl-collision')
      await expect(collision).toBeVisible({ timeout: 15_000 })
      const item = collision.locator('.fl-collision-item.decision')
      await expect(item).toContainText('What the Workspace already says')
      await expect(item).toContainText('Roll flags out by percentage of users.')
      await expect(item).toContainText('Roll flags out by region.')
      await screenshot(window, 'collision-card')
      await item.locator('button[data-choice="theirs"]').click()
      await expect(collision).toContainText('All settled. The Workspace syncs again on its own.', { timeout: 60_000 })
      // Kept the Workspace's: the shared repository and this machine agree on it.
      await expect.poll(() => readFileSync(join(backend, 'flow', DECISION), 'utf8'), { timeout: 30_000 }).toBe(
        'Roll flags out by percentage of users.\n',
      )
      expect(sandbox.remoteFile(`projects/backend/${DECISION}`)).toBe('Roll flags out by percentage of users.\n')
      await expect
        .poll(
          async () =>
            (
              (await window.evaluate(async () =>
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
                (window as unknown as { flow: any }).flow.workspaces.syncStatus({ slug: 'acme' }),
              )) as { state: string }
            ).state,
          { timeout: 60_000 },
        )
        .toBe('synced')
      expect(sandbox.remoteFile(`projects/backend/${DECISION}`)).toBe('Roll flags out by percentage of users.\n')
    } finally {
      await second?.close()
    }
    expect(errors, errors.join('\n')).toEqual([])
  })
})

// ── 2/3. The context gate, chips and the session's folders ───────────────────

test.describe('context gate', () => {
  const seeded = lazySandbox('deep-gate', (sandbox) => {
    const repos = { backend: sandbox.seedRepo('backend'), frontend: sandbox.seedRepo('frontend'), mobile: sandbox.seedRepo('mobile') }
    sandbox.cli(['create', '--name=Acme', `--remote=${sandbox.remoteUrl}`])
    for (const repo of Object.values(repos)) sandbox.cli(['link', `--target=${repo}`, '--workspace=acme'])
    return repos
  })
  test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })
  test.afterAll(async () => seeded.cleanup())

  /** A folder of the session that is `repo` — its own tree, or the thread checkout cut from it. */
  function isCheckoutOf(folder: string, repo: string): boolean {
    const name = repo.split('/').pop() as string
    try {
      const real = realpathSync(folder)
      if (real === realpathSync(repo)) return true
      // A thread checkout: a worktree of `repo`, whose .git file points into repo/.git/worktrees.
      const gitFile = join(real, '.git')
      if (existsSync(gitFile) && lstatSync(gitFile).isFile()) {
        return readFileSync(gitFile, 'utf8').includes(join(realpathSync(repo), '.git', 'worktrees'))
      }
    } catch {
      return false
    }
    return folder.includes(`/${name}`)
  }

  test('the first message attaches what the gate chose before the session starts; chips change the next turn', async ({ app, window }) => {
    const { sandbox, backend, frontend, mobile } = seeded.get()
    test.setTimeout(240_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(error.message))
    await installStandIns(app, {
      gateAnswer: '{"primary": "backend", "attached": ["frontend"]}',
      knowledgeWrite: { path: 'brain/decisions/orders-endpoint.md', text: 'POST /api/orders returns the order id.\n' },
    })

    await addProjects(window, [backend, frontend, mobile])
    await closeProjectOnboarding(window, 3_000)
    const thread = await window.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
      async (root) => (window as unknown as { flow: any }).flow.threads.create({ projectRoot: root, title: 'Orders endpoint' }) as Promise<{ id: string }>,
      backend,
    )
    const sidebar = window.locator('.fl-thread-sidebar')
    await expect(window.locator('.fl-ws-switcher .fl-project-name')).toHaveText('Acme', { timeout: 30_000 })
    await sidebar.getByText('Orders endpoint', { exact: true }).click()

    // Before the first message: only the thread's own project.
    const chips = window.locator('.fl-project-chips')
    await expect(chips).toBeVisible({ timeout: 15_000 })
    await expect(chips.locator('.fl-project-chip')).toHaveText(['backend'])

    // ── The first message: the gate (stood in) picks the frontend ──────────
    await sendFromComposer(window, 'Add a POST /api/orders endpoint and show the new order on the orders screen.')
    await expect.poll(async () => (await recordedStarts(app)).length, { timeout: 30_000 }).toBe(1)
    const [first] = await recordedStarts(app)
    // The gate was asked — and answered before the session started with its folders.
    expect((await gateCalls(app)).some((prompt) => prompt.includes('"primary"'))).toBe(true)
    expect(first?.threadId).toBe(thread.id)
    expect(isCheckoutOf(first?.cwd ?? '', backend)).toBe(true)
    expect(first?.additionalRoots.some((root) => isCheckoutOf(root, frontend))).toBe(true)
    expect(first?.additionalRoots.some((root) => isCheckoutOf(root, mobile))).toBe(false)
    await expect(chips.locator('.fl-project-chip:not(.fl-project-chip-add)')).toHaveText(['backend', 'frontend'], { timeout: 15_000 })
    await expectOnScreen(window, chips.locator('.fl-project-chip', { hasText: 'frontend' }))
    await screenshot(window, 'gate-chips')

    // ── The person adds a third project and removes one ────────────────────
    await chips.locator('.fl-project-chip-add').click()
    const addMenu = window.locator('.fl-project-chip-menu')
    await expect(addMenu.locator('button', { hasText: 'mobile' })).toBeVisible()
    // Something unrelated changes while the menu is open (live: the finished turn's
    // sync) — the menu stays open under the person's pointer.
    await app.evaluate(({ BrowserWindow }) => {
      const status = { state: 'syncing', lastSyncedAt: null, detail: null, asks: [], reviews: [] }
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('workspaces:syncChanged', { slug: 'acme', status })
    })
    await window.waitForTimeout(300)
    await expect(addMenu).toBeVisible()
    // Chosen from the keyboard: the menu took focus, and choosing redraws the
    // chips under it — the keyboard lands on the new "+", not on <body>.
    await expect(addMenu.locator('button', { hasText: 'mobile' })).toBeFocused()
    await window.keyboard.press('Enter')
    await expect(chips.locator('.fl-project-chip', { hasText: 'mobile' })).toBeVisible({ timeout: 15_000 })
    await expect(chips.locator('.fl-project-chip-add')).toBeFocused()
    // Removed from the keyboard: the redraw destroys the focused remove button,
    // and the keyboard lands on "+", not on <body>.
    const removeFrontend = chips.locator('.fl-project-chip', { hasText: 'frontend' }).locator('.fl-composer-chip-dismiss')
    await removeFrontend.focus()
    await expect(removeFrontend).toBeFocused()
    await window.keyboard.press('Enter')
    await expect(chips.locator('.fl-project-chip', { hasText: 'frontend' })).toHaveCount(0, { timeout: 15_000 })
    await expect(chips.locator('.fl-project-chip-add')).toBeFocused()
    await screenshot(window, 'gate-chips-changed')

    // Wait for the first turn to rest, then the next turn's session follows the chips.
    await expect
      .poll(async () => (await getThread(window, thread.id)).status, { timeout: 30_000 })
      .not.toBe('working')
    await sendFromComposer(window, 'Now the mobile app should show it too.')
    await expect.poll(async () => (await recordedStarts(app)).length, { timeout: 30_000 }).toBe(2)
    const second = (await recordedStarts(app))[1]
    await expect.poll(async () => (await getThread(window, thread.id)).status, { timeout: 30_000 }).not.toBe('working')
    expect(second?.additionalRoots.some((root) => isCheckoutOf(root, mobile))).toBe(true)
    expect(second?.additionalRoots.some((root) => isCheckoutOf(root, frontend))).toBe(false)

    // ── An offer from a later message: "Add frontend?", accepted ──────────
    await app.evaluate(({ BrowserWindow }, event) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('threads:contextOffer', event)
    }, { threadId: thread.id, project: { root: frontend, name: 'frontend' }, reason: 'This message looks like it involves frontend.' })
    const offer = chips.locator('.fl-project-chip.offer')
    await expect(offer).toBeVisible({ timeout: 15_000 })
    await expect(offer).toContainText('frontend')
    await expectOnScreen(window, offer)
    // The offer names its project in full — the reason is what gives way in a narrow
    // conversation column, never "Add fro…" (live: both texts shrank alike).
    const offerLabel = offer.locator('.fl-composer-chip-label').first()
    await expect(offerLabel).toHaveText('Add frontend?')
    expect(await offerLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await expectHittable(window, offer.locator('.fl-project-chip-accept'))
    await screenshot(window, 'gate-offer')
    await offer.locator('.fl-project-chip-accept').focus()
    await expect(offer.locator('.fl-project-chip-accept')).toBeFocused()
    await window.keyboard.press('Enter')
    await expect(offer).toHaveCount(0)
    await expect(chips.locator('.fl-project-chip:not(.offer)', { hasText: 'frontend' })).toBeVisible({ timeout: 15_000 })
    await expect(chips.locator('.fl-project-chip-add')).toBeFocused()
    // The thread now carries the frontend again (the ordinary attach).
    const after = await getThread(window, thread.id)
    expect(JSON.stringify(after)).toContain(frontend)

    // ── The agent's knowledge write, through the session's flow/, reaches the shared repository after the turn ──
    await expect
      .poll(() => sandbox.remoteFile('projects/backend/brain/decisions/orders-endpoint.md'), { timeout: 120_000, intervals: [2_000] })
      .toBe('POST /api/orders returns the order id.\n')
    expect(errors, errors.join('\n')).toEqual([])
  })
})

// ── 4. One board per Workspace, tagged by project; switching switches it ─────

test.describe('board', () => {
  const seeded = lazySandbox('deep-board', (sandbox) => {
    const repos = {
      backend: sandbox.seedRepo('backend'),
      frontend: sandbox.seedRepo('frontend'),
      tools: sandbox.seedRepo('tools'),
      loose: sandbox.seedRepo('loose'),
    }
    sandbox.cli(['create', '--name=Acme'])
    sandbox.cli(['link', `--target=${repos.backend}`, '--workspace=acme'])
    sandbox.cli(['link', `--target=${repos.frontend}`, '--workspace=acme'])
    sandbox.cli(['create', '--name=Labs'])
    sandbox.cli(['link', `--target=${repos.tools}`, '--workspace=labs'])
    // Every project lives in a Workspace: the "loose" one is Labs'.
    sandbox.cli(['link', `--target=${repos.loose}`, '--workspace=labs'])
    return repos
  })
  test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })
  test.afterAll(async () => seeded.cleanup())

  test('tasks of both projects on the Workspace board, none from another; switching Workspace switches board and threads', async ({ window }) => {
    const { backend, frontend, tools, loose } = seeded.get()
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(error.message))
    await addProjects(window, [backend, frontend, tools, loose])
    await closeProjectOnboarding(window, 3_000)
    await window.evaluate(
      async (roots) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
        const api = (window as unknown as { flow: any }).flow
        const [b, f, t, l] = roots
        await api.tasks.create({ projectRoot: b, title: 'Expose the orders API' })
        await api.tasks.create({ projectRoot: f, title: 'Draw the orders list' })
        await api.tasks.create({ projectRoot: t, title: 'Lint the build scripts' })
        await api.tasks.create({ projectRoot: l, title: 'Loose spike' })
        await api.threads.create({ projectRoot: b, title: 'Orders API thread' })
        await api.threads.create({ projectRoot: t, title: 'Build scripts thread' })
      },
      [backend, frontend, tools, loose],
    )
    const switcher = window.locator('.fl-ws-switcher')
    await switcher.locator('.fl-project-current').click()
    await switcher.locator('.fl-ws-item', { hasText: 'Acme' }).click()
    await expect(switcher.locator('.fl-project-name')).toHaveText('Acme', { timeout: 30_000 })
    await closeProjectOnboarding(window, 3_000)

    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-board')))
    const card = (title: string) => window.locator('.fl-board-card', { hasText: title })
    // Positive first: both projects' tasks, each tagged with its project…
    await expect(card('Expose the orders API')).toBeVisible({ timeout: 15_000 })
    await expect(card('Draw the orders list')).toBeVisible()
    await expect(card('Expose the orders API').locator('.fl-board-project-tag')).toHaveText('backend')
    await expect(card('Draw the orders list').locator('.fl-board-project-tag')).toHaveText('frontend')
    await expectOnScreen(window, card('Draw the orders list'))
    // …and nothing from another Workspace.
    await expect(card('Loose spike')).toHaveCount(0)
    await expect(card('Lint the build scripts')).toHaveCount(0)
    await screenshot(window, 'board-acme')

    const sidebar = window.locator('.fl-thread-sidebar')
    const threadsRail = window.locator('[data-rail-item="threads"]')
    if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()
    await expect(sidebar.getByText('Orders API thread', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(sidebar.getByText('Build scripts thread', { exact: true })).toHaveCount(0)
    // The list's task rows belong to the Workspace too (positive first) — live, the
    // threads were scoped and every project's tasks were not.
    await expect(sidebar.getByText('Expose the orders API', { exact: true })).toBeVisible()
    await expect(sidebar.getByText('Draw the orders list', { exact: true })).toBeVisible()
    await expect(sidebar.getByText('Loose spike', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('Lint the build scripts', { exact: true })).toHaveCount(0)

    // ── Switch to Labs: the board and the thread list follow ───────────────
    await switcher.locator('.fl-project-current').click()
    await switcher.locator('.fl-ws-item', { hasText: 'Labs' }).click()
    await expect(switcher.locator('.fl-project-name')).toHaveText('Labs', { timeout: 30_000 })
    await closeProjectOnboarding(window, 3_000)
    if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()
    await expect(sidebar.getByText('Build scripts thread', { exact: true })).toBeVisible({ timeout: 15_000 })
    await expect(sidebar.getByText('Orders API thread', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('Lint the build scripts', { exact: true })).toBeVisible()
    await expect(sidebar.getByText('Expose the orders API', { exact: true })).toHaveCount(0)
    await expect(sidebar.getByText('Loose spike', { exact: true })).toBeVisible()
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-board')))
    await expect(card('Lint the build scripts')).toBeVisible({ timeout: 15_000 })
    await expect(card('Lint the build scripts').locator('.fl-board-project-tag')).toHaveText('tools')
    await expect(card('Expose the orders API')).toHaveCount(0)
    await expect(card('Draw the orders list')).toHaveCount(0)
    await expect(card('Loose spike')).toBeVisible()
    await screenshot(window, 'board-labs')
    expect(errors, errors.join('\n')).toEqual([])
  })
})

// The onboarding Workspace step (always present since the hard migration) is
// covered by workspaces-settings.spec.ts; the old "Use Workspaces / Not now"
// offer it replaced is gone with the switch.

test.describe('CLI and app agree', () => {
  const seeded = lazySandbox('deep-cli', (sandbox) => ({ backend: sandbox.seedRepo('backend') }))
  test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })
  test.afterAll(async () => seeded.cleanup())

  test('a Workspace made in the app is in the CLI, and one made in the CLI shows up in the app', async ({ window }) => {
    const { sandbox, backend } = seeded.get()
    test.setTimeout(180_000)
    await addProjects(window, [backend])
    await closeProjectOnboarding(window, 3_000)
    await createWorkspaceFromDialog(window, 'Atlas', null, ['backend'])
    const status = sandbox.cli(['status']) as { workspaces: Array<{ name: string; projects: Array<{ name: string }> }> }
    // Default is always there (it held the backend until it moved); Atlas holds it now.
    expect(status.workspaces.map((workspace) => workspace.name).sort()).toEqual(['Atlas', 'Default'])
    expect(status.workspaces.find((workspace) => workspace.name === 'Atlas')?.projects.map((project) => project.name)).toEqual(['backend'])
    const membership = sandbox.cli(['status', `--target=${backend}`]) as { workspace: { slug: string } | null; linked: boolean }
    expect(membership.workspace?.slug).toBe('atlas')
    expect(membership.linked).toBe(true)

    // The other way: a terminal makes a Workspace while the app runs.
    const switcher = window.locator('.fl-ws-switcher')
    await switcher.locator('.fl-project-current').click()
    // Positive first: the menu lists the app's own Workspace…
    await expect(switcher.locator('.fl-ws-item', { hasText: 'Atlas' })).toBeVisible()
    await expect(switcher.locator('.fl-ws-item', { hasText: 'Borealis' })).toHaveCount(0)
    await window.keyboard.press('Escape')
    sandbox.cli(['create', '--name=Borealis'])
    // …and, reopened, the one the terminal just made.
    await expect
      .poll(
        async () => {
          await switcher.locator('.fl-project-current').click()
          const found = await switcher.locator('.fl-ws-item', { hasText: 'Borealis' }).count()
          await window.keyboard.press('Escape')
          return found
        },
        { timeout: 30_000, intervals: [1_000] },
      )
      .toBe(1)
    await switcher.locator('.fl-project-current').click()
    await screenshot(window, 'cli-created-in-switcher')
    await window.keyboard.press('Escape')
  })
})
