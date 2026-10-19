/**
 * planflow.sh screenshot generator, v2 — NOT a regression test (skipped unless
 * SHOTS=1). Supersedes marketing-shots.spec.ts, which photographs surfaces the
 * app has since replaced: its board frames are the retired ring, and it knows
 * nothing about the Territory, loops, the tasks board or conflicts.
 *
 *   SHOTS=1 npx playwright test e2e/ux/site-shots.spec.ts
 *   SHOTS_OUT=<dir>   where the PNGs land (default: ./site-shots)
 *
 * Everything is seeded from the acme-shop fixture so the whole site tells one
 * story — see plan-flow-lp/SITE-REFRESH.md § "Part 4".
 *
 * ONE SHOT PER TEST, and each seeds its own project. The old generator was a
 * single 180-second test that staged every act in sequence, so one broken
 * selector cost every frame after it — which is exactly how it rotted. Here a
 * surface that moves loses its own frame and nothing else.
 */
import { expect, type Page, type ElectronApplication } from '@playwright/test'
import { test as flowTest, dismissOnboarding } from '../fixtures/electron'
import { statusButtonByText, sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { fakeClaude } from './fixtures/loops'
import {
  seedStructure,
  seedFeatures,
  seedChanges,
  commitBaseline,
  dirtyChangeset,
  seedLoops,
  seedQueue,
  TASKS,
  THREADS,
  gitIn,
  gitTry,
  INVARIANT_RESULT,
  STAGED,
} from './fixtures/acme-shop'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = process.env.SHOTS_OUT ?? resolve(__dirname, '../../site-shots')
const W = 2240
const H = 1400

flowTest.beforeEach(() => {
  flowTest.skip(!process.env.SHOTS, 'site shot generator — run with SHOTS=1')
  mkdirSync(OUT, { recursive: true })
})
flowTest.afterAll(() => cleanupSeeds())

/* ── capture helpers ─────────────────────────────────────────────────────── */

/** Native capturePage honours the display's device pixel ratio, so the PNGs
 *  carry real pixels rather than a CSS-sized rasterisation. */
async function shoot(
  app: ElectronApplication,
  path: string,
  rect?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const b64 = await app.evaluate(async ({ BrowserWindow }, r) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return ''
    const image = r
      ? await win.webContents.capturePage({
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        })
      : await win.webContents.capturePage()
    return image.toPNG().toString('base64')
  }, rect ?? null)
  if (!b64) throw new Error(`capture produced no bytes for ${path}`)
  writeFileSync(path, Buffer.from(b64, 'base64'))
}

/** Crop to an element, padded and clamped to the window. */
async function shootRegion(
  app: ElectronApplication,
  window: Page,
  path: string,
  selector: string,
  pad = 24,
): Promise<void> {
  const box = await window.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  const x = Math.max(0, box.x - pad)
  const y = Math.max(0, box.y - pad)
  await shoot(app, path, {
    x,
    y,
    width: Math.min(W - x, box.width + pad * 2),
    height: Math.min(H - y, box.height + pad * 2),
  })
}

/**
 * Big window, no terminal pane, chat collapsed — the frame every shot starts
 * from. `keepChat` leaves the chat column up for the frames that live IN it
 * (the New-thread page): collapsing and then re-revealing it does not restore
 * the page, so the only reliable order is never to collapse it.
 */
async function stage(
  app: ElectronApplication,
  window: Page,
  opts: { keepChat?: boolean } = {},
): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(2240, 1400)
    win?.center()
  })
  await window.waitForTimeout(700)
  // The first-run wizard can mount AFTER the window fixture dismissed it once
  // (activating a project re-runs provisioning), and it intercepts every click.
  await clearOverlays(window)
  await window.keyboard.press('ControlOrMeta+j') // terminal off
  await window.waitForTimeout(250)
  if (opts.keepChat !== true) {
    await window.keyboard.press('ControlOrMeta+Alt+c') // chat pane collapsed
    await window.waitForTimeout(250)
  }
  await dismissToasts(window)
}

/**
 * Tell the renderer the working tree moved.
 *
 * The app watches `.git` with chokidar, which is unreliable over a temp dir —
 * so a seeded changeset can sit on disk while the board still believes the tree
 * is clean. This is the same IPC event the watcher itself emits; the renderer
 * then re-reads the REAL git state, so nothing here fakes the changeset, it
 * only fixes when the app finds out about it.
 */
async function nudgeGit(app: ElectronApplication, root: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('git:changed', payload)
  }, { rootId: root })
  await new Promise((r) => setTimeout(r, 800))
}

/**
 * Clear the ambient prompts a fresh project raises ("Run a basic discovery?").
 * They are correct product behaviour and wrong in a product shot — a marketing
 * frame should show the surface, not the invitation to populate it.
 */
async function dismissToasts(window: Page): Promise<void> {
  for (const label of ['Not now', 'Dismiss']) {
    const button = window.getByRole('button', { name: label, exact: true })
    for (let i = 0; i < 3 && (await button.count()) > 0; i++) {
      await button.first().click({ timeout: 2000 }).catch(() => {})
      await window.waitForTimeout(250)
    }
  }
}

/**
 * Get every modal out of the way before a click that a modal would swallow.
 *
 * `dismissOnboarding` only knows the WIZARD (it matches `.fl-wizard-body`), so
 * any other `.fl-settings-overlay` left it satisfied while still intercepting
 * pointer events — which is how the Blueprint click timed out against an
 * element Playwright had already reported as "visible, enabled and stable".
 * Escape closes the rest.
 */
async function clearOverlays(window: Page): Promise<void> {
  const overlay = window.locator('.fl-settings-overlay:not([hidden])')
  for (let i = 0; i < 5; i++) {
    if ((await overlay.count()) === 0) return
    await dismissOnboarding(window).catch(() => {})
    if ((await overlay.count()) === 0) return
    await window.keyboard.press('Escape')
    await window.waitForTimeout(400)
  }
}

/** ⌘B toggles, so read before pressing. */
async function setSidebar(window: Page, visible: boolean): Promise<void> {
  const shown = await window.locator('.fl-sidebar').isVisible()
  if (shown !== visible) {
    await window.keyboard.press('ControlOrMeta+b')
    await window.waitForTimeout(350)
  }
}

/** Open the Blueprint and wait for the Territory — the DEFAULT sheet. */
async function openTerritory(window: Page): Promise<void> {
  // The wizard mounts asynchronously after activation, so one dismissal at
  // staging time can land before it exists. Clear it again here, where the
  // very next action is a click it would otherwise swallow.
  await clearOverlays(window)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 20_000 })
  await window.waitForTimeout(900) // motion settles
  // The discovery prompt is raised BY opening the board, so it has to be
  // cleared here rather than once at staging time.
  await dismissToasts(window)
}

/**
 * A seeded acme-shop project, committed clean — optionally with the
 * usage-billing changeset left dirty on top of it.
 *
 * Everything is written BEFORE the root is added, because the app snapshots the
 * project at watch-start and a store that appears later may never be observed.
 */
async function acmeShop(
  window: Page,
  opts: { changeset?: boolean; loops?: boolean; work?: boolean } = {},
) {
  const root = await seedProject(window, 'acme-shop-', (dir) => {
    seedStructure(dir)
    seedFeatures(dir)
    seedChanges(dir)
    // A QUEUE NEEDS A LOOP TO FILE INTO. `loop file --loop find` refuses when
    // no directive names that loop, so asking for work without asking for
    // loops used to fail the whole seed — implied rather than left as a trap.
    if (opts.loops || opts.work) seedLoops(dir)
    if (opts.work) seedQueue(dir)
    commitBaseline(dir)
    if (opts.changeset) dirtyChangeset(dir)
  })
  await activateProject(window, root)
  await window.waitForTimeout(1500)
  if (opts.work) await seedWork(window, root)
  return root
}

/**
 * Populate the project with work in flight, over the app's OWN bridge.
 *
 * A board with four empty lanes and a sidebar reading "No threads yet" is an
 * accurate picture of a project nobody has used, and a useless picture of the
 * product. Tasks are created and then moved with `tasks:update`, which is the
 * same write the lane drag performs.
 */
async function seedWork(window: Page, root: string): Promise<void> {
  await window.evaluate(
    async (payload: { root: string; tasks: typeof TASKS; threads: typeof THREADS }) => {
      const flow = (window as unknown as {
        flow: {
          tasks: {
            create(r: { projectRoot: string; title: string; description?: string }): Promise<{ id: string }>
            update(r: { taskId: string; patch: { lane: string } }): Promise<unknown>
          }
          threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> }
          messages: { append(r: { threadId: string; role: string; content: string }): Promise<unknown> }
        }
      }).flow
      for (const task of payload.tasks) {
        const created = await flow.tasks.create({
          projectRoot: payload.root,
          title: task.title,
          description: task.description,
        })
        await flow.tasks.update({ taskId: created.id, patch: { lane: task.lane } })
      }
      for (const thread of payload.threads) {
        const created = await flow.threads.create({ projectRoot: payload.root, title: thread.title })
        if (thread.user) {
          await flow.messages.append({ threadId: created.id, role: 'user', content: thread.user })
          await new Promise((r) => setTimeout(r, 120))
        }
        if (thread.assistant) {
          await flow.messages.append({
            threadId: created.id,
            role: 'assistant',
            content: thread.assistant,
          })
        }
      }
    },
    { root, tasks: TASKS, threads: THREADS },
  )
  await window.waitForTimeout(1200)
}

/* ── the frames ──────────────────────────────────────────────────────────── */

flowTest('territory — the default sheet', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  const root = await acmeShop(window)
  void root
  await stage(app, window)
  await openTerritory(window)
  await setSidebar(window, false)
  await window.waitForTimeout(600)
  await shoot(app, join(OUT, 'territory-root.png'))
})

flowTest('territory — drilled into one feature', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  await acmeShop(window)
  await stage(app, window)
  await openTerritory(window)
  await setSidebar(window, false)
  // Dive the biggest cell — a level is a zoom of the level above.
  await window.locator('.fb-terr-cell').first().dblclick()
  await window.waitForTimeout(1600)
  await shoot(app, join(OUT, 'territory-drilled.png'))
})

flowTest('act 01 — the problem: 26 files, one turn', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  const root = await acmeShop(window, { changeset: true })
  await stage(app, window)
  await nudgeGit(app, root)
  await window.locator('[data-rail-item="source-control"]').click()
  // The Phases view is the grouped review list — the wall of files act 01 is about.
  await window.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(window.locator('.fl-review')).toBeAttached()
  await expect(window.locator('.fl-review-file').first()).toBeVisible({ timeout: 20_000 })
  // Open the hero file's diff over the list. The overlay is a bonus, not the
  // subject — act 01 is about the WALL — so a row that does not open one still
  // produces the frame rather than losing it.
  await window.locator('.fl-review-file-name', { hasText: 'invoice.ts' }).first().click()
  await window
    .locator('.gd-overlay')
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => {})
  await window.waitForTimeout(900)
  await shoot(app, join(OUT, 'story-1-problem.png'), { x: 0, y: 0, width: W, height: 1020 })
})

/**
 * THE CHANGESET LANDS ON THE CODE MAP, NOT THE TERRITORY — and that is a
 * product fact, not a staging convenience (`territory-overlay.ts`, Rule 1):
 *
 *   "a changeset of module ids simply has nothing to say about a sheet of
 *    FEATURES … nothing here invents a path from a file to a feature. The
 *    feature graph carries an anchor COUNT, not the anchors, so a file→feature
 *    answer would have to be guessed."
 *
 * So the board-is-the-review frames are shot where module ids ARE card ids.
 * The site must not claim the default sheet decorates itself with a diff.
 */
flowTest('act 02 — the changeset on the map', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  const root = await acmeShop(window, { changeset: true })
  await stage(app, window)
  await openTerritory(window)
  await setSidebar(window, false)
  await nudgeGit(app, root)
  await expect(window.locator('.fb-changeset-chip')).toBeVisible({ timeout: 20_000 })
  await window.waitForTimeout(700)
  await shoot(app, join(OUT, 'story-2-map.png'))
})

flowTest('act 03 — the learned module doc', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  const root = await acmeShop(window)
  await stage(app, window)
  await window.evaluate((r) => {
    document.dispatchEvent(
      new CustomEvent('flow:open-file', {
        detail: { rootPath: r, relPath: 'flow/brain/modules/payments.md' },
      }),
    )
  }, root)
  await window.waitForTimeout(1500)
  // The wizard can mount late and swallow the click (it is a modal overlay).
  await dismissOnboarding(window)
  await dismissToasts(window)
  const preview = window.getByText('Preview', { exact: true })
  if (await preview.isVisible().catch(() => false)) {
    await preview.click({ timeout: 8000 }).catch(() => {})
    await window.waitForTimeout(900)
  }
  await shoot(app, join(OUT, 'story-4-knowledge.png'), { x: 0, y: 0, width: 1560, height: 860 })
})

flowTest('act 03b — the sync panel: staleness + trust tiers', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  await acmeShop(window)
  await stage(app, window)
  await openTerritory(window)
  await setSidebar(window, false)
  // The panel's own deep-link — the same one the learning notification fires.
  // Clicking the header chip is not reliable: it stays hidden until the learn
  // progress read resolves, and a board with no counted modules never shows it.
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-learning-panel'))
  })
  await expect(window.locator('.fb-learn-panel')).toBeVisible({ timeout: 15_000 })
  await window.waitForTimeout(900)
  await shootRegion(app, window, join(OUT, 'story-4b-sync.png'), '.fb-learn-panel', 40)
})

flowTest('act 05 — the board is the review', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  const root = await acmeShop(window, { changeset: true })
  await stage(app, window)
  await openTerritory(window)
  await setSidebar(window, false)
  await nudgeGit(app, root)

  // Partial approval — approval IS git staging.
  await window.evaluate(async (r) => {
    const flow = (window as unknown as {
      flow: { git: { stage(i: { rootId: string; filePaths: string[] }): Promise<void> } }
    }).flow
    await flow.git.stage({
      rootId: r.root,
      filePaths: r.staged,
    })
  }, { root, staged: STAGED })
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('git:changed', payload)
  }, { rootId: root })
  await expect(window.locator('.fb-changeset-chip')).toBeVisible({ timeout: 20_000 })

  // The checker's advisory verdicts, over the real IPC event the service uses.
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('blueprint:invariantVerdicts', payload)
  }, { rootId: root, checkedAt: new Date().toISOString(), result: INVARIANT_RESULT })
  await window.waitForTimeout(900)

  // Open payments — its Changes tab leads: staged ✓s, Approve all, and the
  // amber findings with their evidence underneath.
  // Prefer the exact node id; fall back to the card carrying the name, because
  // the code map rolls modules up and a nested payments card carries a
  // district-scoped id rather than the graph's own.
  const byId = window.locator('.fb-node[data-node-id="module:payments"]')
  const payments = (await byId.count()) > 0
    ? byId.first()
    : window.locator('.fb-node').filter({ hasText: 'payments' }).first()
  await payments.click()
  await expect(window.locator('.fb-popover')).toBeVisible({ timeout: 10_000 })
  await window.waitForTimeout(800)
  await shoot(app, join(OUT, 'story-6-approve.png'), { x: 0, y: 28, width: W, height: H - 28 })

  // Close-up of the Changes tab itself — the reviewer's cockpit.
  await shootRegion(app, window, join(OUT, 'story-6b-changes.png'), '.fb-popover', 200)
})

flowTest('tasks — the board, four lanes', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  await acmeShop(window, { loops: true, work: true })
  await stage(app, window)
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible({ timeout: 20_000 })
  // TODO IS A WINDOW onto the ledger, and that read is a CLI round trip the
  // board performs after it mounts — so the lane is legitimately empty for a
  // second or two. Shooting on a fixed timeout caught it mid-read and produced
  // a board advertising "Nothing here yet" over a queue with five items in it.
  // Give the read its round trip, but do not FAIL on it: the ledger items are
  // verifiably filed (`loop list` returns all five from the seeded repo), yet
  // the board's Todo window stays empty under the test build — so this waits
  // for the lane and shoots the three record lanes regardless.
  await window
    .locator('.fl-board-column')
    .first()
    .locator('.fl-board-card')
    .first()
    .waitFor({ state: 'visible', timeout: 25_000 })
    .catch(() => {})
  await setSidebar(window, false)
  await window.waitForTimeout(600)
  await dismissToasts(window)
  await shoot(app, join(OUT, 'tasks-board.png'))

  // The ticket itself — "a ticket that reads like a ticket": chips, air, one
  // scroller, real typography. Double-click is the board's own open gesture.
  await window.locator('.fl-board-card').first().dblclick()
  const detail = window.locator('.fl-board-detail')
  await detail.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {})
  await window.waitForTimeout(900)
  if (await detail.isVisible().catch(() => false)) {
    await shootRegion(app, window, join(OUT, 'ticket-detail.png'), '.fl-board-detail', 70)
  }
})

/**
 * THE LOOPS SCREEN IS RETIRED, and its replacement is a different idea rather
 * than a moved control. A hunt used to be a standing producer with a play
 * button on a control centre — "a thing you switched on and then had to
 * remember to switch off; nothing on that screen ever ended one". It is now an
 * OPTION ON A PIECE OF WORK, created beside the task or thread that prompted
 * it and carrying its stop rule from the moment it exists.
 *
 * So the frame is the New-thread page: the work's own words, the task-board
 * chip, and — only once that is on — the hunt and the sentence that ends it.
 */
flowTest('hunt — created with the work, carrying its stop rule', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  // NO THREADS SEEDED, deliberately: a project with no conversation opens ON
  // the New-thread page, so the frame needs no navigation at all. Clicking the
  // rail to get there is actively wrong — the rail item TOGGLES its panel, so
  // pressing the already-active Threads item collapses the sidebar and takes
  // the page with it (measured: `[data-rail-item]` goes 1 → 0).
  await acmeShop(window, { loops: true })
  // Never let a press reach a real background agent.
  await fakeClaude(app, { kind: 'list', entries: [] })
  await stage(app, window, { keepChat: true })
  await window.waitForTimeout(700)
  await expect(window.locator('.fl-newthread')).toBeVisible({ timeout: 15_000 })
  await window.waitForTimeout(800)

  // The work's own words — a hunt reuses them rather than asking twice.
  const box = window.locator('.fl-newthread textarea, .fl-newthread [contenteditable="true"]').first()
  await box.click().catch(() => {})
  await box
    .fill('Audit the checkout path for Stripe writes that skip an idempotency key')
    .catch(() => {})
  await window.waitForTimeout(400)

  // On the task board first: off the board there is no list for a hunt to file
  // into, so the hunt switch is not offered until this is on.
  for (const label of [/task board/i, /Loop o[nf]/i]) {
    const chip = window.getByRole('button', { name: label }).first()
    if ((await chip.count()) > 0) {
      await chip.click({ timeout: 4000 }).catch(() => {})
      await window.waitForTimeout(500)
    }
  }
  await window.waitForTimeout(700)
  await dismissToasts(window)
  await shootRegion(app, window, join(OUT, 'hunt-option.png'), '.fl-newthread-card', 90)
})

/**
 * Settings became a PAGE with tabs — "one element for the life of the window,
 * handed to editorApi.openView" — replacing a 560px modal that held every
 * decision the app can make in one scrolling column.
 */
flowTest('settings — a page with tabs, not a modal', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  await acmeShop(window, { loops: true, work: true })
  await stage(app, window)
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-settings'))
  })
  await window.waitForTimeout(2200)
  await setSidebar(window, false)
  await window.waitForTimeout(600)
  await dismissToasts(window)
  await shoot(app, join(OUT, 'settings-page.png'))
})

/** Search across file CONTENTS, with line snippets that open at the line. */
flowTest('search — in files, across the project', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  await acmeShop(window, { changeset: true, work: true })
  await stage(app, window)
  await window.locator('[data-rail-item="search"]').click()
  const input = window.locator('.fl-search-input')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill('idempotencyKey')
  // The search is debounced and fans out per root; give it the round trip.
  await window.waitForTimeout(3500)
  await dismissToasts(window)
  await shoot(app, join(OUT, 'content-search.png'), { x: 0, y: 0, width: 1500, height: 900 })
})

flowTest('loops — the directive is a committed file', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  const root = await acmeShop(window, { loops: true, work: true })
  await stage(app, window)
  await window.evaluate((r) => {
    document.dispatchEvent(
      new CustomEvent('flow:open-file', { detail: { rootPath: r, relPath: 'loops/find.md' } }),
    )
  }, root)
  await window.waitForTimeout(1800)
  await shoot(app, join(OUT, 'loops-directive.png'), { x: 0, y: 0, width: 1560, height: 900 })
})

flowTest('conflicts — per-hunk resolution with side identity', async ({ window, app }) => {
  flowTest.setTimeout(180_000)
  const file = 'billing/invoice.ts'
  // A real two-hunk conflict in the money path: two branches both edit the
  // invoice builder. Ten pad lines keep git from coalescing the two hunks.
  // Seeded BEFORE the root is added — the git watcher starts polling the moment
  // it is, and races these commits for the index lock.
  const root = await seedProject(window, 'acme-conflict-', (dir) => {
    const pad = Array.from({ length: 10 }, (_v, i) => `  // ... step ${String(i + 1)}`)
    const base = [
      'export async function buildInvoice(tenant, period) {',
      '  const usage = await rollupUsage(tenant.id, period)',
      ...pad,
      '  return stripe.invoices.create(items)',
      '}',
    ]
    const write = (second: string, last: string): void => {
      writeFileSync(join(dir, file), [base[0], second, ...pad, last, '}'].join('\n') + '\n')
    }
    mkdirSync(join(dir, 'billing'), { recursive: true })
    gitIn(dir, ['config', 'user.email', 'shots@flow.test'])
    gitIn(dir, ['config', 'user.name', 'Flow'])
    writeFileSync(join(dir, file), base.join('\n') + '\n')
    gitIn(dir, ['add', '-A'])
    gitIn(dir, ['commit', '-q', '-m', 'invoice builder'])
    gitIn(dir, ['branch', '-M', 'main'])
    gitIn(dir, ['checkout', '-q', '-b', 'metered-billing'])
    write(
      '  const usage = await rollupUsage(tenant.id, period, { metered: true })',
      '  return stripe.invoices.create(items, { idempotencyKey: key(tenant) })',
    )
    gitIn(dir, ['commit', '-qam', 'meter the invoice'])
    gitIn(dir, ['checkout', '-q', 'main'])
    write(
      '  const usage = await rollupUsage(tenant.id, period, { cached: true })',
      '  return stripe.invoices.create(items, { auto_advance: true })',
    )
    gitIn(dir, ['commit', '-qam', 'cache the rollup'])
    gitTry(dir, ['merge', 'metered-billing']) // exits non-zero — the conflict IS the fixture
  })
  await activateProject(window, root)
  await window.waitForTimeout(1800)
  // Threads, so the panel beside the conflict is a project somebody works in
  // rather than an empty "No threads yet".
  await seedWork(window, root)
  await stage(app, window)
  await window.evaluate((r) => {
    document.dispatchEvent(
      new CustomEvent('flow:open-file', { detail: { rootPath: r.root, relPath: r.file } }),
    )
  }, { root, file })
  await window.waitForTimeout(2500) // monaco + codelens paint
  await shoot(app, join(OUT, 'conflict-hunks.png'), { x: 0, y: 0, width: 1760, height: 980 })
})
