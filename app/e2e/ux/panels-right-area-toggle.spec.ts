/**
 * THE RIGHT-HAND AREA TOGGLE — the mirror of the sidebar toggle.
 *
 * The titlebar's right corner carries a `sidebar-right` toggle that puts away
 * the whole editor area (its tabs, its chrome icons, the terminal docked under
 * it); the conversation takes the freed width, and the next press brings the
 * area back. ⌘⌥B does the same. Anything that needs the area (Settings here)
 * brings it back, and the state survives a relaunch.
 *
 * "Visible is not on screen": every claim is a measured box — the area's box
 * is gone (or zero-wide / outside the window), the conversation's is wider.
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
const SCREENS = 'e2e/ux/__screens'
/** Long enough to outlast the shell's 200 ms layout-save debounce. */
const SAVE_SETTLE_MS = 700
/** The reading column's cap with the area put away (right-area-model.ts). */
const READING_COLUMN_MAX_PX = 680

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

async function firstWindow(app: ElectronApplication): Promise<Page> {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  // A project's basic discovery is stood in for (it never finishes): this
  // spec must not start a real agent run.
  await installBasicDiscoveryStandIn(app)
  await dismissOnboarding(win)
  return win
}

/** Close any settings / onboarding overlay that would swallow clicks. */
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

interface Measured {
  /** The editor area's on-screen width (0 when it is not in the window). */
  area: number
  /** The conversation column's on-screen width. */
  chat: number
  /** The activity sidebar's on-screen width. */
  sidebar: number
  /** The conversation's reading column (the feed) and the composer's box,
   *  each with its margins inside the conversation column. */
  column: { width: number; left: number; right: number } | null
  composer: { width: number; left: number; right: number } | null
  pressed: string | null
  viewport: number
}

/** What a person sees: boxes clipped to the window, not "is in the DOM". */
async function measure(win: Page): Promise<Measured> {
  return win.evaluate(() => {
    const onScreenWidth = (element: Element | null): number => {
      if (element === null || !element.isConnected) return 0
      const r = element.getBoundingClientRect()
      const left = Math.max(0, r.left)
      const right = Math.min(window.innerWidth, r.right)
      const visibleHeight = Math.min(window.innerHeight, r.bottom) - Math.max(0, r.top)
      return visibleHeight > 0 ? Math.max(0, right - left) : 0
    }
    const chat = document.querySelector('[data-panel-id="conversation"]')
    const inChat = (element: Element | null): { width: number; left: number; right: number } | null => {
      if (chat === null || element === null || !element.isConnected) return null
      const outer = chat.getBoundingClientRect()
      const r = element.getBoundingClientRect()
      if (r.width === 0) return null
      return { width: r.width, left: r.left - outer.left, right: outer.right - r.right }
    }
    return {
      area: onScreenWidth(document.querySelector('#fl-split-editor-stack')),
      chat: onScreenWidth(document.querySelector('[data-panel-id="conversation"]')),
      sidebar: onScreenWidth(document.querySelector('.fl-activity-sidebar')),
      column: inChat(document.querySelector('[data-panel-id="conversation"] .fl-conv-feed')),
      composer: inChat(document.querySelector('[data-panel-id="conversation"] .fl-composer-shell')),
      pressed: document.querySelector('[data-testid="right-area-toggle"]')?.getAttribute('aria-pressed') ?? null,
      viewport: window.innerWidth,
    }
  })
}

test('the right-area toggle puts the editor area away, brings it back, and keeps it across a relaunch', async () => {
  test.setTimeout(240_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-right-area-'))
  const flowHome = mkdtempSync(join(tmpdir(), 'flow-e2e-right-area-home-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'flow-right-area-proj-'))
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
    let win = await firstWindow(app)
    await win.evaluate(async (p: string) => {
      const flow = (window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown>; setActive(r: { rootPath: string }): Promise<unknown> } }
      }).flow
      await flow.project.add({ path: p })
      await flow.project.setActive({ rootPath: p })
    }, projectDir)
    await dismissOverlays(win)
    // A thread open, so the conversation has a transcript and a composer.
    const threadId = await win.evaluate(async (p: string) => {
      const flow = (window as unknown as {
        flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> } }
      }).flow
      return (await flow.threads.create({ projectRoot: p, title: 'Reading column' })).id
    }, projectDir)
    const threadsRail = win.locator('[data-rail-item="threads"]')
    if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()
    await win.locator('.fl-thread-sidebar .row', { has: win.locator('span[title="Reading column"]') }).first().click()
    await expect
      .poll(() => win.evaluate(async () => {
        const ctx = await (window as unknown as { flow: { project: { active(): Promise<{ activeThreadId?: string | null } | null> } } }).flow.project.active()
        return ctx?.activeThreadId ?? null
      }), { timeout: 15_000 })
      .toBe(threadId)
    await dismissOverlays(win)

    const toggle = win.locator('[data-testid="right-area-toggle"]')
    // The toggle is on screen, in the titlebar's right corner.
    await expect(toggle).toBeVisible()
    const toggleBox = await toggle.boundingBox()
    const viewport = (await measure(win)).viewport
    expect(toggleBox).not.toBeNull()
    expect(toggleBox!.x).toBeGreaterThan(viewport / 2)
    expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(viewport + 1)

    // ── The positive first: the area and the conversation are both on screen.
    await expect.poll(async () => (await measure(win)).area, { timeout: 15_000 }).toBeGreaterThan(100)

    // The person widens the sidebar by hand: that is the width it must keep.
    const defaultSidebar = (await measure(win)).sidebar
    const handle = win.locator('#fl-split-root .handle').first()
    const handleBox = await handle.boundingBox()
    expect(handleBox).not.toBeNull()
    const hx = handleBox!.x + handleBox!.width / 2
    const hy = handleBox!.y + handleBox!.height / 2
    await win.mouse.move(hx, hy)
    await win.mouse.down()
    await win.mouse.move(hx + 60, hy, { steps: 6 })
    await win.mouse.move(hx + 120, hy, { steps: 6 })
    await win.mouse.up()
    await expect.poll(async () => (await measure(win)).sidebar, { timeout: 5_000 }).toBeGreaterThan(defaultSidebar + 60)
    const before = await measure(win)
    expect(before.chat).toBeGreaterThan(100)
    expect(before.pressed).toBe('true')
    await win.screenshot({ path: `${SCREENS}/right-area-shown.png` })

    // ── Press: the area is gone and the conversation took its width.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).area, { timeout: 10_000 }).toBe(0)
    const collapsed = await measure(win)
    expect(collapsed.chat).toBeGreaterThan(before.chat + 100)
    // The freed width went to the conversation, not the sidebar.
    expect(before.sidebar).toBeGreaterThan(100)
    expect(Math.abs(collapsed.sidebar - before.sidebar)).toBeLessThan(8)
    // …and became MARGIN: the reading column and the composer stay a readable
    // width, centred in the wider conversation column.
    for (const box of [collapsed.column, collapsed.composer]) {
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThan(400)
      expect(box!.width).toBeLessThanOrEqual(READING_COLUMN_MAX_PX + 1)
      expect(Math.abs(box!.left - box!.right)).toBeLessThan(4)
      expect(box!.left).toBeGreaterThan(100)
    }
    expect(collapsed.pressed).toBe('false')
    await win.screenshot({ path: `${SCREENS}/right-area-collapsed.png` })

    // ── Press again: back, the conversation at its old width.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).area, { timeout: 10_000 }).toBeGreaterThan(100)
    const restored = await measure(win)
    expect(restored.pressed).toBe('true')
    expect(Math.abs(restored.chat - before.chat)).toBeLessThan(8)
    expect(Math.abs(restored.sidebar - before.sidebar)).toBeLessThan(8)

    // ── ⌘⌥B does the same.
    await win.keyboard.press('ControlOrMeta+Alt+KeyB')
    await expect.poll(async () => (await measure(win)).area, { timeout: 10_000 }).toBe(0)
    await win.keyboard.press('ControlOrMeta+Alt+KeyB')
    await expect.poll(async () => (await measure(win)).area, { timeout: 10_000 }).toBeGreaterThan(100)

    // ── Something that needs the area brings it back: Settings.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).area, { timeout: 10_000 }).toBe(0)
    await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
    await expect.poll(async () => (await measure(win)).area, { timeout: 15_000 }).toBeGreaterThan(100)
    await expect(win.locator('.fl-settings-page').first()).toBeVisible()
    expect((await measure(win)).pressed).toBe('true')

    // ── Put it away and relaunch: it stays away.
    await toggle.click()
    await expect.poll(async () => (await measure(win)).area, { timeout: 10_000 }).toBe(0)
    await win.waitForTimeout(SAVE_SETTLE_MS)
    await app.close()
    app = await launch(userDataDir, flowHome)
    win = await firstWindow(app)
    await dismissOverlays(win)
    // The positive: the shell is up and the conversation fills the window.
    await expect(win.locator('[data-panel-id="conversation"]')).toBeVisible({ timeout: 60_000 })
    await expect.poll(async () => (await measure(win)).pressed, { timeout: 15_000 }).toBe('false')
    // Settle: a late restore must not bring it back.
    await win.waitForTimeout(1500)
    const relaunched = await measure(win)
    expect(relaunched.area).toBe(0)
    expect(relaunched.chat).toBeGreaterThan(before.chat + 100)
    expect(Math.abs(relaunched.sidebar - before.sidebar)).toBeLessThan(8)
    expect(relaunched.column).not.toBeNull()
    expect(relaunched.column!.width).toBeLessThanOrEqual(READING_COLUMN_MAX_PX + 1)
    await win.screenshot({ path: `${SCREENS}/right-area-relaunched.png` })

    // …and one press brings it back after the relaunch too.
    await win.locator('[data-testid="right-area-toggle"]').click()
    await expect.poll(async () => (await measure(win)).area, { timeout: 10_000 }).toBeGreaterThan(100)
  } finally {
    if (app !== null) await app.close().catch(() => undefined)
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(flowHome, { recursive: true, force: true })
    removeTempDir(projectDir)
  }
})
