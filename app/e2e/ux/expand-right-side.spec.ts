/**
 * EXPAND THE RIGHT SIDE — the chat steps aside, the right side fills.
 *
 * Beside the hide-the-right-side toggle in the titlebar's right corner sits a
 * second button: one press takes only the chat column (feed + composer) off
 * screen, the left sidebar stays, and the right side takes the freed width.
 * The next press — or Escape — gives the chat its column back at the width it
 * had. The choice is remembered per thread.
 *
 * "Visible is not on screen": every claim is a measured box clipped to the
 * window.
 *
 * Always hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1, its own profile and its own
 * Flow folder, so nothing reaches the developer's real one.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { dismissOnboarding } from '../fixtures/electron'
import { installBasicDiscoveryStandIn } from '../fixtures/workspaces'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
/** Long enough to outlast the shell's 200 ms layout-save debounce. */
const SAVE_SETTLE_MS = 700
/** Pixel slack for split rounding and the gutters between panes. */
const SLACK_PX = 12

function launch(userDataDir: string, flowHome: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      FLOW_E2E_BACKGROUND: '1',
      PLAN_FLOW_HOME: flowHome,
      DISABLE_AUTO_UPDATE: 'true',
    },
  })
}

async function dismissOverlays(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await overlay.first().waitFor({ state: 'visible', timeout: 1500 })
    } catch {
      return
    }
    const skip = overlay.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
    const close = overlay.locator('.fl-settings-close')
    if (await skip.count()) await skip.first().click()
    else if (await close.count()) await close.first().click()
    else await win.keyboard.press('Escape')
    await win.waitForTimeout(200)
  }
}

interface Box {
  x: number
  width: number
}

interface Measured {
  /** The right side (editor stack) — clipped to the window; width 0 when away. */
  area: Box
  /** The chat column. */
  chat: Box
  /** The left sidebar. */
  sidebar: Box
  /** The composer's on-screen width (0 when it is not on screen). */
  composer: number
  pressed: string | null
  label: string | null
  icon: string | null
  viewport: number
}

async function measure(win: Page): Promise<Measured> {
  return win.evaluate(() => {
    const box = (element: Element | null): { x: number; width: number } => {
      if (element === null || !element.isConnected) return { x: 0, width: 0 }
      const r = element.getBoundingClientRect()
      const left = Math.max(0, r.left)
      const right = Math.min(window.innerWidth, r.right)
      const visibleHeight = Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)
      return visibleHeight > 0 && right > left ? { x: left, width: right - left } : { x: 0, width: 0 }
    }
    const toggle = document.querySelector('[data-testid="expand-right-toggle"]')
    return {
      area: box(document.querySelector('#fl-split-editor-stack')),
      chat: box(document.querySelector('[data-panel-id="conversation"]')),
      sidebar: box(document.querySelector('.fl-activity-sidebar')),
      composer: box(document.querySelector('[data-panel-id="conversation"] .fl-composer-shell')).width,
      pressed: toggle?.getAttribute('aria-pressed') ?? null,
      label: toggle?.getAttribute('aria-label') ?? null,
      icon: toggle?.querySelector('fl-icon')?.getAttribute('name') ?? null,
      viewport: window.innerWidth,
    }
  })
}

async function selectThread(win: Page, title: string, threadId: string): Promise<void> {
  const threadsRail = win.locator('[data-rail-item="threads"]')
  if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()
  await win.locator('.fl-thread-sidebar .row', { has: win.locator(`span[title="${title}"]`) }).first().click()
  await expect
    .poll(() => win.evaluate(async () => {
      const ctx = await (window as unknown as { flow: { project: { active(): Promise<{ activeThreadId?: string | null } | null> } } }).flow.project.active()
      return ctx?.activeThreadId ?? null
    }), { timeout: 15_000 })
    .toBe(threadId)
  await win.waitForTimeout(SAVE_SETTLE_MS)
}

test('expand the right side: the chat steps aside, comes back, and is remembered per thread', async () => {
  test.setTimeout(240_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-expand-right-'))
  const flowHome = mkdtempSync(join(tmpdir(), 'flow-e2e-expand-right-home-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'flow-expand-right-proj-'))
  execFileSync('git', ['init', '-q'], { cwd: projectDir })
  writeFileSync(join(projectDir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nloops/\n')
  execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: projectDir })
  writeFileSync(join(projectDir, 'a.ts'), 'export const a = 1\n')
  mkdirSync(join(projectDir, 'flow'), { recursive: true })
  writeFileSync(join(projectDir, 'flow', '.flowconfig'), 'autopilot: false\ncommit: false\npush: false\n')
  execFileSync('git', ['add', '-A'], { cwd: projectDir })
  execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: projectDir })

  let app: ElectronApplication | null = null
  try {
    app = await launch(userDataDir, flowHome)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await installBasicDiscoveryStandIn(app)
    await dismissOnboarding(win)
    await win.evaluate(async (p: string) => {
      const flow = (window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown>; setActive(r: { rootPath: string }): Promise<unknown> } }
      }).flow
      await flow.project.add({ path: p })
      await flow.project.setActive({ rootPath: p })
    }, projectDir)
    await dismissOverlays(win)
    const [first, second] = await win.evaluate(async (p: string) => {
      const flow = (window as unknown as {
        flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> } }
      }).flow
      const a = await flow.threads.create({ projectRoot: p, title: 'Coupon thread' })
      const b = await flow.threads.create({ projectRoot: p, title: 'Playbooks sort' })
      return [a.id, b.id]
    }, projectDir)
    // Visit both threads once, so each has a layout of its own.
    await selectThread(win, 'Playbooks sort', second)
    await selectThread(win, 'Coupon thread', first)
    await dismissOverlays(win)

    const toggle = win.locator('[data-testid="expand-right-toggle"]')
    const hideToggle = win.locator('[data-testid="right-area-toggle"]')

    // ── The positive first: the chat with its composer, and the right side.
    await expect(toggle).toBeVisible()
    await expect.poll(async () => (await measure(win)).composer, { timeout: 15_000 }).toBeGreaterThan(100)
    await expect.poll(async () => (await measure(win)).area.width, { timeout: 15_000 }).toBeGreaterThan(100)
    const before = await measure(win)
    expect(before.chat.width).toBeGreaterThan(100)
    expect(before.sidebar.width).toBeGreaterThan(100)
    expect(before.pressed).toBe('false')
    expect(before.label).toBe('Expand the right side')
    expect(before.icon).toBe('expand-diagonal')
    // The button sits beside the hide toggle, in the titlebar's right corner.
    const toggleBox = await toggle.boundingBox()
    const hideBox = await hideToggle.boundingBox()
    expect(toggleBox).not.toBeNull()
    expect(hideBox).not.toBeNull()
    expect(toggleBox!.x).toBeGreaterThan(before.viewport / 2)
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(hideBox!.x + 1)
    expect(hideBox!.x - (toggleBox!.x + toggleBox!.width)).toBeLessThan(16)

    // ── Press: the chat steps aside, the sidebar stays, the right side fills.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).chat.width, { timeout: 10_000 }).toBe(0)
    const expanded = await measure(win)
    expect(expanded.composer).toBe(0)
    expect(Math.abs(expanded.sidebar.width - before.sidebar.width)).toBeLessThan(SLACK_PX)
    // The right side moved left by about the chat's width and grew by it.
    expect(Math.abs(before.area.x - expanded.area.x - before.chat.width)).toBeLessThan(SLACK_PX)
    expect(Math.abs(expanded.area.width - (before.area.width + before.chat.width))).toBeLessThan(SLACK_PX)
    expect(expanded.area.x + expanded.area.width).toBeLessThanOrEqual(expanded.viewport + 1)
    expect(expanded.area.x).toBeGreaterThanOrEqual(expanded.sidebar.x + expanded.sidebar.width - 1)
    expect(expanded.pressed).toBe('true')
    expect(expanded.label).toBe('Show the chat')
    expect(expanded.icon).toBe('collapse-diagonal')
    await toggle.hover()
    await win.waitForTimeout(300)
    await win.screenshot({ path: 'e2e/results/expand-right-side.png' })

    // ── Press again: the chat is back at the width it had.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).composer, { timeout: 10_000 }).toBeGreaterThan(100)
    const restored = await measure(win)
    expect(Math.abs(restored.chat.width - before.chat.width)).toBeLessThan(4)
    expect(Math.abs(restored.area.width - before.area.width)).toBeLessThan(4)
    expect(Math.abs(restored.area.x - before.area.x)).toBeLessThan(4)
    expect(Math.abs(restored.sidebar.width - before.sidebar.width)).toBeLessThan(4)
    expect(restored.pressed).toBe('false')

    // ── Expand, then Escape: back too.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).chat.width, { timeout: 10_000 }).toBe(0)
    // Focus off any field, so the key is the window's to take.
    await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await win.keyboard.press('Escape')
    await expect.poll(async () => (await measure(win)).composer, { timeout: 10_000 }).toBeGreaterThan(100)
    expect(Math.abs((await measure(win)).chat.width - before.chat.width)).toBeLessThan(4)

    // ── Hiding the right side while expanded leaves the mode; the chat stays.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).chat.width, { timeout: 10_000 }).toBe(0)
    await hideToggle.click()
    await expect.poll(async () => (await measure(win)).area.width, { timeout: 10_000 }).toBe(0)
    const hidden = await measure(win)
    expect(hidden.chat.width).toBeGreaterThan(100)
    expect(hidden.pressed).toBe('false')
    // …and expanding from there shows the right side first, then expands.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).chat.width, { timeout: 10_000 }).toBe(0)
    expect((await measure(win)).area.width).toBeGreaterThan(before.area.width)
    // Back to the start for the per-thread check.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).composer, { timeout: 10_000 }).toBeGreaterThan(100)

    // ── Remembered per thread: expand here, the other thread keeps its chat.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).chat.width, { timeout: 10_000 }).toBe(0)
    await win.waitForTimeout(SAVE_SETTLE_MS)
    await selectThread(win, 'Playbooks sort', second)
    await expect.poll(async () => (await measure(win)).composer, { timeout: 10_000 }).toBeGreaterThan(100)
    expect((await measure(win)).pressed).toBe('false')
    await selectThread(win, 'Coupon thread', first)
    await expect.poll(async () => (await measure(win)).pressed, { timeout: 10_000 }).toBe('true')
    expect((await measure(win)).chat.width).toBe(0)
    expect((await measure(win)).sidebar.width).toBeGreaterThan(100)
    await selectThread(win, 'Playbooks sort', second)
    await expect.poll(async () => (await measure(win)).pressed, { timeout: 10_000 }).toBe('false')
    expect((await measure(win)).composer).toBeGreaterThan(100)
  } finally {
    if (app !== null) await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(flowHome, { recursive: true, force: true })
    removeTempDir(projectDir)
  }
})
