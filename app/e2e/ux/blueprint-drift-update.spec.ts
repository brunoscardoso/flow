import { test, expect, type Page } from '../fixtures/electron'
import type { ElectronApplication } from '@playwright/test'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { callBoard } from '../board-hook'

/**
 * DRIFTED, EASIER TO UPDATE (mockup approved 2026-11-16) — the Learning
 * panel's Drifted group: a summary with Update all, folders each with their
 * own Update, a selection with Update N, the reason on each row, a sort, the
 * progress of a batch while it runs, and the automatic-update switch. Plus the
 * Knowledge pill's drift note, which opens that group.
 *
 * The learner and the staleness check are stubbed IN MAIN (window.flow is a
 * contextBridge proxy — assignment there is a silent no-op), so what is
 * asserted is the IPC the renderer actually sent. The automatic switch is NOT
 * stubbed: it writes the project's real settings file, read back from disk.
 *
 * Screenshots: __screens/drift-{pill,rest,most-changed,selection,updating,auto}.png
 */

const CLI = resolve(__dirname, '../../resources/cli/planflow-ai.mjs')
const SHOTS = join(__dirname, '__screens')
const boardRoot = '.flow-board-root'

/** The drifted modules and how many of their files changed. */
const DRIFT: Record<string, number> = {
  'src/components/chat': 24,
  'src/components/settings': 3,
  'src/components/connections': 6,
  'src/app/api': 9,
  'src/app/auth': 2,
  'src/lib/http': 5,
}
const MODULES = Object.keys(DRIFT)
const NOTED: Record<string, string> = {
  'src/components/chat': '2026-10-29T10:00:00Z',
  'src/components/settings': '2026-10-20T10:00:00Z',
  'src/components/connections': '2026-10-24T10:00:00Z',
  'src/app/api': '2026-11-01T10:00:00Z',
  'src/app/auth': '2026-10-10T10:00:00Z',
  'src/lib/http': '2026-11-05T10:00:00Z',
}

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

function makeRepo(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'drift-probe', version: '1.0.0' }))
  for (const module of MODULES) {
    mkdirSync(join(dir, module), { recursive: true })
    const name = module.split('/').at(-1) ?? 'x'
    writeFileSync(join(dir, module, `${name}.ts`), `export function ${name}(): number {\n  return 1\n}\n`)
  }
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-qm', 'init'])
  mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
  try {
    execFileSync(process.execPath, [CLI, 'blueprint', 'derive'], { cwd: dir, stdio: 'ignore' })
  } catch {
    // the provisioner derives again once the project is added
  }
}

function writeLearning(structure: string, entries: Array<{ module: string; status: string; notedAt?: string }>): void {
  writeFileSync(join(structure, 'learning-state.jsonl'), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)
}

function flowconfig(root: string): string {
  const path = join(root, 'flow', '.flowconfig')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** Stub the learner and the staleness check in main; record every queue. */
async function stubMain(app: ElectronApplication, root: string): Promise<void> {
  const files: Record<string, string[]> = {}
  for (const [module, count] of Object.entries(DRIFT)) {
    files[module] = Array.from({ length: count }, (_, index) => `${module}/file${String(index)}.ts`)
  }
  await app.evaluate(({ ipcMain }, payload) => {
    const g = globalThis as unknown as { __qaQueued: string[]; __qaCancel: string[]; __qaLive: unknown; __qaReasonsAsked: number }
    g.__qaQueued = []
    g.__qaCancel = []
    g.__qaReasonsAsked = 0
    g.__qaLive = { running: false, paused: false, activeModule: null, activeRoot: null, queued: 0, startedAt: null, queuedByRoot: {}, pausedRoots: [] }
    // KEEP THE REAL HANDLER TO PUT BACK: the app is shared with the specs
    // that run after this one, and a learn queue left stubbed here meant the
    // next spec's real learning pass silently never started.
    type Handler = (event: unknown, request: unknown) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const saved = ((globalThis as unknown as { __qaOriginals?: Map<string, Handler> }).__qaOriginals ??= new Map())
    const swap = (channel: string, fn: (request: Record<string, unknown>) => unknown): void => {
      const original = handlers.get(channel)
      if (original !== undefined && !saved.has(channel)) saved.set(channel, original)
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, (_event, request) => fn(request as Record<string, unknown>))
    }
    swap('learn:learnModule', (request) => {
      g.__qaQueued.push(String(request.modulePath))
    })
    swap('learn:driftReasons', () => {
      g.__qaReasonsAsked += 1
      return { ok: true, files: payload.files }
    })
    swap('learn:status', () => g.__qaLive)
    swap('learn:cancel', (request) => {
      g.__qaCancel.push(String(request.rootId))
      return { ok: true }
    })
    // Two finished passes of 90 s each: the only source the estimates read.
    swap('learn:log', () => ({
      entries: [
        { at: 0, kind: 'start', module: 'src/x' },
        { at: 90_000, kind: 'learned', module: 'src/x' },
        { at: 90_000, kind: 'start', module: 'src/y' },
        { at: 180_000, kind: 'learned', module: 'src/y' },
      ],
    }))
    void payload.root
  }, { files, root })
}

async function queued(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [...(globalThis as unknown as { __qaQueued: string[] }).__qaQueued])
}

async function resetQueued(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    ;(globalThis as unknown as { __qaQueued: string[] }).__qaQueued = []
  })
}

async function setLive(app: ElectronApplication, live: unknown): Promise<void> {
  await app.evaluate((_electron, next) => {
    ;(globalThis as unknown as { __qaLive: unknown }).__qaLive = next
  }, live)
}

/** The drift rows' modules, top to bottom. */
async function driftOrder(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fb-lp-group[data-lp-group="drift"] .fb-dr-row')].map((row) => row.dataset['module'] ?? ''),
  )
}

const drift = '.fb-lp-group[data-lp-group="drift"]'

/** Every module the Drifted group lists, folded folders opened first. */
async function driftModules(window: Page): Promise<string[]> {
  for (const fold of await window.locator(`${drift} .fb-dr-fold[aria-expanded="false"]`).all()) await fold.click().catch(() => undefined)
  return window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.fb-lp-group[data-lp-group="drift"] .fb-dr-row')].map((row) => row.dataset['module'] ?? '').sort(),
  )
}

/** The app's own offers (a basic discovery) float over the board; set them aside. */
async function dismissOffers(window: Page): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const card = window.locator('fl-card.fl-learn-card fl-button', { hasText: 'Not now' }).first()
    if (!(await card.isVisible().catch(() => false))) break
    await card.click().catch(() => undefined)
    await window.waitForTimeout(150)
  }
}

/** A screenshot of a surface the board may repaint mid-shot: try again. */
async function shot(window: Page, selector: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      // Toasts float over the panel's right edge; the shot is of the panel.
      await window.evaluate(() => {
        for (const toast of document.querySelectorAll('.fl-flow-toast')) (toast as HTMLElement).style.visibility = 'hidden'
      })
      await window.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: 'start' }))
      await window.locator(selector).first().screenshot({ path: join(SHOTS, file), timeout: 5_000 })
      return
    } catch (error) {
      if (attempt >= 4) throw error
      await window.waitForTimeout(400)
    }
  }
}

test.afterEach(async ({ app }) => {
  await app.evaluate(({ ipcMain }) => {
    type Handler = (event: unknown, request: unknown) => unknown
    const g = globalThis as unknown as { __qaOriginals?: Map<string, Handler> }
    for (const [channel, handler] of g.__qaOriginals ?? new Map<string, Handler>()) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    g.__qaOriginals = new Map()
  })
})

test.afterAll(() => cleanupSeeds())

test('drifted modules update all at once, by folder, or by selection — and the pill points at them', async ({ app, window }) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(String(error)))
  mkdirSync(SHOTS, { recursive: true })

  const root = await seedProject(window, 'flow-ux-drift-', makeRepo)
  await activateProject(window, root)
  const structure = await waitForLinkedStructure(window, root)
  writeLearning(structure, [
    ...MODULES.map((module) => ({ module, status: 'stale', notedAt: NOTED[module] })),
  ])
  await stubMain(app, root)

  // Room for the panel, and no terminal pane under it, so the shots show it whole.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 1500))
  const terminal = window.locator('[data-view-action="terminal"]')
  if ((await terminal.count()) > 0 && (await terminal.first().getAttribute('aria-pressed')) === 'true') await terminal.first().click()
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-blueprint')))
  await window.locator(boardRoot).first().waitFor({ state: 'visible', timeout: 20_000 })
  await window.locator(`${boardRoot} .fb-territory`).first().waitFor({ state: 'visible', timeout: 90_000 })
  await callBoard(window, 'handleChanged', [root])
  await callBoard(window, 'handleRevealed')

  // ── The Knowledge pill says how many drifted, and opens the Drifted group. ──
  const pillDrift = window.locator(`${boardRoot} .fb-knowledge-pill:visible .fb-knowledge-drift`).first()
  await expect(pillDrift).toHaveText('6 drifted', { timeout: 20_000 })
  await dismissOffers(window)
  await shot(window, `${boardRoot} .fb-float-bottom:visible`, 'drift-pill.png')
  await pillDrift.click()
  const panel = window.locator('.fb-learn-panel')
  await expect(panel).toBeVisible({ timeout: 15_000 })
  const group = panel.locator(drift)
  await expect(group).toHaveClass(/open/, { timeout: 15_000 })

  // ── At rest: summary with Update all, folders, and the reason on each row. ──
  // Diagnostic on failure: which modules the group lists.
  await expect.poll(() => driftModules(window), { timeout: 15_000 }).toEqual([...MODULES].sort())
  await expect(group.locator('.fb-dr-bar')).toContainText('6 modules changed since Flow last read them · 49 files changed', { timeout: 15_000 })
  await expect(group.locator('.fb-dr-update-all')).toHaveText('Update all 6')
  await expect(group.locator('.fb-dr-fold[data-folder="src/components"]')).toContainText('3 modules · 33 files')
  await expect(group.locator('.fb-dr-row[data-module="src/components/chat"] .fb-dr-why')).toHaveText('24 files changed')
  // The reasons were read once for the group, not once per row.
  expect(await app.evaluate(() => (globalThis as unknown as { __qaReasonsAsked: number }).__qaReasonsAsked)).toBe(1)
  await shot(window, `.fb-learn-panel ${drift}`, 'drift-rest.png')

  // ── The sort changes the order. ─────────────────────────────────────────
  const folderOrder = await driftOrder(window)
  expect(folderOrder[0]).toBe('src/components/chat')
  await group.locator('.fb-dr-seg-btn[data-sort="changed"]').click()
  await expect
    .poll(() => driftOrder(window))
    .toEqual(['src/components/chat', 'src/app/api', 'src/components/connections', 'src/lib/http', 'src/components/settings', 'src/app/auth'])
  await shot(window, `.fb-learn-panel ${drift}`, 'drift-most-changed.png')
  await group.locator('.fb-dr-seg-btn[data-sort="oldest"]').click()
  await expect.poll(async () => (await driftOrder(window))[0]).toBe('src/app/auth')
  await group.locator('.fb-dr-seg-btn[data-sort="folder"]').click()

  // ── Selecting two rows and pressing Update 2 queues exactly those two. ──────
  await group.locator('.fb-dr-row[data-module="src/components/chat"] .fb-dr-cb').click()
  await group.locator('.fb-dr-row[data-module="src/lib/http"] .fb-dr-cb').click()
  const selbar = group.locator('.fb-dr-selbar')
  await expect(selbar).toContainText('2 selected · about 3 min')
  await expect(selbar.locator('.fb-dr-sel-ignore')).toHaveText('Ignore 2')
  await shot(window, `.fb-learn-panel ${drift}`, 'drift-selection.png')
  await selbar.locator('.fb-dr-sel-update').click()
  await expect.poll(() => queued(app)).toEqual(['src/components/chat', 'src/lib/http'])
  // The learner (idle in this stub) never took them, so they are drifted again.
  await expect(group.locator('.fb-dr-row[data-module="src/lib/http"]')).toBeVisible({ timeout: 10_000 })
  await expect(selbar).toHaveCount(0)

  // ── A folder's Update queues only that folder. ───────────────────────────
  await resetQueued(app)
  await group.locator('.fb-dr-fold[data-folder="src/app"] .fb-dr-fold-update').click()
  await expect.poll(async () => (await queued(app)).sort()).toEqual(['src/app/api', 'src/app/auth'])
  await expect(group.locator('.fb-dr-fold[data-folder="src/app"]')).toBeVisible({ timeout: 10_000 })

  // ── Update all queues every drifted module, then shows the batch's progress. ──
  await resetQueued(app)
  await setLive(app, {
    running: true,
    paused: false,
    activeModule: 'src/components/chat',
    activeRoot: root,
    queued: 3,
    startedAt: Date.now(),
    queuedByRoot: { [root]: 3 },
    pausedRoots: [],
  })
  await group.locator('.fb-dr-update-all').click()
  await expect.poll(async () => (await queued(app)).sort()).toEqual([...MODULES].sort())
  const now = new Date().toISOString()
  writeLearning(structure, [
    { module: 'src/components/chat', status: 'learning', notedAt: now },
    { module: 'src/components/settings', status: 'queued', notedAt: now },
    { module: 'src/components/connections', status: 'queued', notedAt: now },
    { module: 'src/lib/http', status: 'queued', notedAt: now },
    { module: 'src/app/api', status: 'learned', notedAt: now },
    { module: 'src/app/auth', status: 'learned', notedAt: now },
  ])
  // The learner's rows changed: the board's small learning-only re-read.
  await callBoard(window, 'handleChanged', [root, true])
  const updating = panel.locator('.fb-lp-group[data-lp-group="updating"]')
  await expect(updating.locator('.fb-dr-progress-text')).toHaveText('2 of 6 updated · about 6 min left', { timeout: 20_000 })
  await expect(updating.locator('.fb-dr-batch-row[data-module="src/components/chat"] .fb-dr-state')).toHaveText('reading 24 changed files now')
  await expect(updating.locator('.fb-dr-next .fb-dr-state')).toHaveText('next')
  await expect(updating.locator('.fb-dr-waiting .fb-dr-state').first()).toHaveText('waiting · 3rd')
  await expect(updating.locator('.fb-dr-updated').first()).toContainText('updated')
  await shot(window, '.fb-learn-panel .fb-lp-group[data-lp-group="updating"]', 'drift-updating.png')

  // ── Stop drops this project's queue through the learner's own stop. ────────
  await updating.locator('.fb-dr-stop').click()
  await expect.poll(() => app.evaluate(() => [...(globalThis as unknown as { __qaCancel: string[] }).__qaCancel])).toEqual([root])

  // ── The automatic switch writes the project's real setting. ───────────────
  await setLive(app, { running: false, paused: false, activeModule: null, activeRoot: null, queued: 0, startedAt: null, queuedByRoot: {}, pausedRoots: [] })
  writeLearning(structure, [
    ...MODULES.map((module) => ({ module, status: 'stale', notedAt: NOTED[module] })),
  ])
  await callBoard(window, 'handleChanged', [root, true])
  const sw = panel.locator(`${drift} .fb-dr-switch`)
  await expect(sw).toHaveAttribute('aria-checked', 'true', { timeout: 20_000 })
  await expect(panel.locator(`${drift} .fb-dr-auto`)).toContainText('on for this project')
  expect(flowconfig(root)).not.toContain('learn_auto: false')
  await sw.click()
  await expect.poll(() => flowconfig(root), { timeout: 15_000 }).toContain('learn_auto: false')
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await shot(window, `.fb-learn-panel ${drift} .fb-dr-auto`, 'drift-auto.png')
  // UI copy never names the setting's key.
  await expect(panel.locator(drift)).not.toContainText('learn_auto')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
