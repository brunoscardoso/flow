/**
 * planflow.sh screenshot generator — shot against FLOW'S OWN CODEBASE.
 *
 *   SHOTS=1 npx playwright test e2e/ux/self-shots.spec.ts
 *   SHOTS_OUT=<dir>   where the PNGs land (default: ./site-shots)
 *
 * Companion to site-shots.spec.ts, which uses the invented acme-shop world.
 * That world turned out to be too small for the UI to look like anything — ten
 * capabilities over ~150 generated files is a handful of enormous empty
 * rectangles — so the frames the site actually ships come from here: 1,868
 * files, 57 modules, 20 capabilities the team named itself.
 *
 * Everything runs against a throwaway clone (see fixtures/flow-self.ts). The
 * working tree is never touched.
 */
import { expect, type Page, type ElectronApplication } from '@playwright/test'
import { test as flowTest, dismissOnboarding } from '../fixtures/electron'
import { statusButtonByText, sel } from '../selectors'
import { activateProject } from './fixtures/seed'
import { flowSelfRepo, SELF_TASKS, SELF_THREADS, SELF_VAULT } from './fixtures/flow-self'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OUT = process.env.SHOTS_OUT ?? resolve(__dirname, '../../site-shots')
const W = 2240
const H = 1400

// The app resolves a project's `flow/` into a central vault keyed on the
// project's directory name, so a clone called `plan-flow` reads the REAL one.
// Every launch here gets a vault of its own instead.
flowTest.use({ appEnv: { PLAN_FLOW_VAULT_DIR: SELF_VAULT } })

flowTest.beforeEach(() => {
  flowTest.skip(!process.env.SHOTS, 'site shot generator — run with SHOTS=1')
  mkdirSync(OUT, { recursive: true })
})

/* ── capture helpers (mirrors site-shots.spec.ts) ─────────────────────────── */

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

async function dismissToasts(window: Page): Promise<void> {
  for (const label of ['Not now', 'Dismiss']) {
    const button = window.getByRole('button', { name: label, exact: true })
    for (let i = 0; i < 3 && (await button.count()) > 0; i++) {
      await button.first().click({ timeout: 2000 }).catch(() => {})
      await window.waitForTimeout(250)
    }
  }
}

async function setSidebar(window: Page, visible: boolean): Promise<void> {
  const shown = await window.locator('.fl-sidebar').isVisible()
  if (shown !== visible) {
    await window.keyboard.press('ControlOrMeta+b')
    await window.waitForTimeout(350)
  }
}

async function stage(app: ElectronApplication, window: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setSize(2240, 1400)
    win?.center()
  })
  await window.waitForTimeout(700)
  await clearOverlays(window)
  await window.keyboard.press('ControlOrMeta+j')
  await window.waitForTimeout(250)
  await window.keyboard.press('ControlOrMeta+Alt+c')
  await window.waitForTimeout(250)
  await dismissToasts(window)
}

async function openTerritory(window: Page): Promise<void> {
  await clearOverlays(window)
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator('.flow-board-root')).toBeVisible()
  // A real repo's first derive/read is slower than a seeded one.
  await expect(window.locator('.fb-terr-cell').first()).toBeVisible({ timeout: 45_000 })
  await window.waitForTimeout(1400)
  await dismissToasts(window)
}

/** Open the throwaway clone of this repository and let its stores load. */
async function openSelf(window: Page): Promise<string> {
  const root = flowSelfRepo()
  await window.evaluate(async (p: string) => {
    await (
      window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }
    ).flow.project.add({ path: p })
  }, root)
  await activateProject(window, root)
  await window.waitForTimeout(3000)
  return root
}

/** Work in flight, over the app's own bridge. */
async function seedWork(window: Page, root: string): Promise<void> {
  await window.evaluate(
    async (payload: { root: string; tasks: typeof SELF_TASKS; threads: typeof SELF_THREADS }) => {
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
    { root, tasks: SELF_TASKS, threads: SELF_THREADS },
  )
  await window.waitForTimeout(1500)
}

/* ── the frames ──────────────────────────────────────────────────────────── */

flowTest('self — the feature view', async ({ window, app }) => {
  flowTest.setTimeout(240_000)
  await openSelf(window)
  await stage(app, window)
  await openTerritory(window)
  await setSidebar(window, false)
  await window.waitForTimeout(800)
  await shoot(app, join(OUT, 'self-features.png'))
})

flowTest('self — inside one capability', async ({ window, app }) => {
  flowTest.setTimeout(240_000)
  await openSelf(window)
  await stage(app, window)
  await openTerritory(window)
  await setSidebar(window, false)
  await window.locator('.fb-terr-cell').first().dblclick()
  await window.waitForTimeout(2000)
  await shoot(app, join(OUT, 'self-feature-inside.png'))
})

flowTest('self — the learned document', async ({ window, app }) => {
  flowTest.setTimeout(240_000)
  const root = await openSelf(window)
  await stage(app, window)
  await clearOverlays(window)
  await window.evaluate((r) => {
    document.dispatchEvent(
      new CustomEvent('flow:open-file', {
        detail: { rootPath: r, relPath: 'flow/brain/code/tasks.md' },
      }),
    )
  }, root)
  // Wait for the document itself. The previous version shot a fixed rectangle
  // after a fixed pause and captured an empty threads panel, because the file
  // had not opened yet and the crop never looked at the editor at all.
  await window
    .getByText('re-learns automatically on drift')
    .first()
    .waitFor({ state: 'visible', timeout: 25_000 })
    .catch(() => {})
  const preview = window.getByText('Preview', { exact: true })
  if (await preview.isVisible().catch(() => false)) {
    await preview.click({ timeout: 8000 }).catch(() => {})
    await window.waitForTimeout(1200)
  }
  await setSidebar(window, false)
  await window.waitForTimeout(700)
  await shoot(app, join(OUT, 'self-knowledge.png'))
})

flowTest('self — search across code and knowledge', async ({ window, app }) => {
  flowTest.setTimeout(240_000)
  await openSelf(window)
  await stage(app, window)
  await window.locator('[data-rail-item="search"]').click()
  const input = window.locator('.fl-search-input')
  await expect(input).toBeVisible({ timeout: 20_000 })
  await input.fill('agent_blocked_from')
  await window.waitForTimeout(5000)
  await dismissToasts(window)
  await shoot(app, join(OUT, 'self-search.png'), { x: 0, y: 0, width: 1560, height: 940 })
})

flowTest('self — the board and a ticket', async ({ window, app }) => {
  flowTest.setTimeout(240_000)
  const root = await openSelf(window)
  await seedWork(window, root)
  await stage(app, window)
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible({ timeout: 30_000 })
  await window.waitForTimeout(2000)
  await setSidebar(window, false)
  await window.waitForTimeout(700)
  await dismissToasts(window)
  // Crop to where the cards actually are. A 1400px-tall board holding four
  // rows of cards is mostly empty lane, and empty lane is not the subject.
  await shoot(app, join(OUT, 'self-board.png'), { x: 0, y: 0, width: W, height: 720 })

  await window.locator('.fl-board-card').first().dblclick()
  const detail = window.locator('.fl-board-detail')
  await detail.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  await window.waitForTimeout(1000)
  if (await detail.isVisible().catch(() => false)) {
    await shootRegion(app, window, join(OUT, 'self-ticket.png'), '.fl-board-detail', 70)
  }
})
