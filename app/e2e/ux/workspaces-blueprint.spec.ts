/**
 * THE WORKSPACE BLUEPRINT (decision workspace-blueprint, 2026-10-06) — the
 * board's root is the Workspace.
 *
 * Real everywhere it can be: three seeded git repos with features on disk,
 * added through the real project path (so the app's own migration puts them in
 * this run's Default Workspace, in this run's Flow folder), a `links.jsonl`
 * written where the Workspace keeps it, and the board drawing what the bundled
 * CLI's `blueprint workspace graph` returns. Every claim is about rendered
 * geometry or rendered words — counted DOM is how the territory's worst bugs
 * once shipped green.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'
import { expectOnScreen } from '../fixtures/workspaces'

const SCREENS =
  process.env['FLOW_E2E_WS_BOARD_SCREENS'] ?? process.env['FLOW_E2E_SCREENS'] ?? resolve(__dirname, '__screens')

test.afterAll(() => cleanupSeeds())

/** Three projects of deliberately different sizes — area is a claim to measure. */
const PROJECTS: Record<string, Array<[slug: string, name: string, lines: number, learned: boolean]>> = {
  core: [
    ['chat-engine', 'Chat Engine', 1800, true],
    ['auth', 'Auth', 900, false],
    ['tenants', 'Tenants', 600, false],
  ],
  app: [
    ['chats', 'Chats', 700, true],
    ['sign-in', 'Sign In', 400, false],
  ],
  mobile: [['login', 'Login', 300, false]],
}

/** The features that have parts — a level below them to zoom into. */
const PARTED = new Set(['chat-engine', 'chats'])

function seedFeatures(dir: string, features: (typeof PROJECTS)[string]): void {
  const featuresDir = join(dir, 'flow', 'brain', 'features')
  mkdirSync(featuresDir, { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (const [slug, name, lines, learned] of features) {
    writeFileSync(
      join(dir, 'src', `${slug}.ts`),
      Array.from({ length: lines }, (_, n) => `export const v${String(n)} = ${String(n)}`).join('\n') + '\n',
    )
    writeFileSync(
      join(featuresDir, `${slug}.md`),
      [
        '---',
        `id: feature:${slug}`,
        `name: ${name}`,
        'kind: core',
        `anchors: [file:src/${slug}.ts]`,
        'relates: []',
        `lastFullRead: ${learned ? '2026-10-01T00:00:00.000Z' : 'null'}`,
        'patchCount: 0',
        '---',
        '',
        `# ${name}`,
        '',
        // A feature discovery adopted carries only its provenance line — the
        // board shows it as a path, never as a description.
        slug === 'sign-in' ? 'Confirmed from code:module/src/sign_in.' : `What ${name} does.`,
        '',
        // A LEVEL BELOW: a feature with parts zooms in on a press; one with
        // none reads as its code story (plan cell-hover-diagram, FR-6).
        ...(PARTED.has(slug) ? ['## Parts', '', `### ${name} core`, `The heart of ${name}.`, `anchors: src/${slug}.ts`, ''] : []),
      ].join('\n'),
    )
  }
}

interface Placed {
  workspacePath: string
  slugs: Record<string, string>
}

/** Wait until every seeded repo is a project of one Workspace; answer its folder and slugs. */
async function waitForPlacement(page: Page, roots: Record<string, string>): Promise<Placed> {
  let placed: Placed | null = null
  await expect
    .poll(
      async () => {
        const listed = await page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
          return (window as unknown as { flow: any }).flow.workspaces.list()
        })
        if (listed?.ok !== true) return 'not listed'
        for (const workspace of listed.workspaces as Array<{ path: string; projects: Array<{ slug: string; localPath: string | null }> }>) {
          const slugs: Record<string, string> = {}
          for (const [key, root] of Object.entries(roots)) {
            const found = workspace.projects.find((project) => project.localPath !== null && (project.localPath === root || root.endsWith(project.localPath) || project.localPath.endsWith(root.split('/').pop() ?? '')))
            if (found !== undefined) slugs[key] = found.slug
          }
          if (Object.keys(slugs).length === Object.keys(roots).length) {
            placed = { workspacePath: workspace.path, slugs }
            return 'placed'
          }
        }
        return 'waiting'
      },
      { timeout: 120_000 },
    )
    .toBe('placed')
  return placed as unknown as Placed
}

async function screenshot(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  await page.screenshot({ path: join(SCREENS, `wsboard-${name}.png`) })
}

/** Paint the app in one theme — the controller's own attribute. */
async function theme(page: Page, value: 'light' | 'dark'): Promise<void> {
  await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), value)
  await page.waitForTimeout(150)
}

async function area(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  return box === null ? 0 : box.width * box.height
}

test('the board opens at the Workspace: a coloured country per project, connections on request, zoom in and back', async ({ window: page }) => {
  test.setTimeout(300_000)

  const roots: Record<string, string> = {}
  for (const key of Object.keys(PROJECTS)) {
    roots[key] = await seedProject(page, `flow-ux-wsb-${key}-`, (dir) => seedFeatures(dir, PROJECTS[key]))
  }
  const { workspacePath, slugs } = await waitForPlacement(page, roots)

  // The links between them, as `workspace link-knowledge` writes them.
  const ts = '2026-10-06T12:00:00.000Z'
  writeFileSync(
    join(workspacePath, 'links.jsonl'),
    [
      { ts, author: null, kind: 'consumes', from: `${slugs.app}/chats`, to: `${slugs.core}/chat-engine`, note: 'chat stream' },
      { ts, author: null, kind: 'calls', from: `${slugs.app}/sign-in`, to: `${slugs.core}/auth` },
      { ts, author: null, kind: 'calls', from: `${slugs.mobile}/login`, to: `${slugs.core}/auth` },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  )

  // Each project's first activation opens its own settings once — not this
  // spec's subject, so every project is visited (and that closed) first.
  for (const key of ['app', 'mobile', 'core']) await activateProject(page, roots[key])
  // The whole stage for the map: put the terminal dock away, as a person would.
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  // The first-run offers to read each project are not this spec's subject.
  for (let i = 0; i < 6; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  // The map button in the editor area's view actions — what a person presses.
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()

  // ── THE WORKSPACE IS THE ROOT: three countries, on screen. ──
  const countries = page.locator('.fb-ws-country')
  await expect(countries).toHaveCount(3, { timeout: 120_000 })
  for (const key of Object.keys(PROJECTS)) {
    await expectOnScreen(page, page.locator(`.fb-ws-country[data-ws-project="${slugs[key]}"]`))
  }
  await page.waitForTimeout(600) // the sheet re-packs on a ResizeObserver tick
  await theme(page, 'light')
  await screenshot(page, 'root-light')
  await theme(page, 'dark')
  await screenshot(page, 'root-dark')
  await theme(page, 'light')

  // THE CURRENT PROJECT LEADS (core, the active one); the others are sized by lines: app (1,100) > mobile (300).
  const core = page.locator(`.fb-ws-country[data-ws-project="${slugs.core}"]`)
  const app = page.locator(`.fb-ws-country[data-ws-project="${slugs.app}"]`)
  const mobile = page.locator(`.fb-ws-country[data-ws-project="${slugs.mobile}"]`)
  expect(await area(core)).toBeGreaterThan((await area(app)) + (await area(mobile)))
  expect(await area(app)).toBeGreaterThan(await area(mobile))

  // COLOURED PER PROJECT — as ONE mark, the project's name (2026-10-06,
  // after a palette study); headers and the countries' borders stay neutral.
  const names = await page.locator('.fb-ws-band .fb-ws-name').evaluateAll((els) => els.map((el) => getComputedStyle(el).color))
  expect(new Set(names).size).toBe(3)
  const borders = await countries.evaluateAll((els) => els.map((el) => getComputedStyle(el).borderTopColor))
  expect(new Set(borders).size).toBe(1)

  // Each country holds its own features, and says what it holds.
  await expect(page.locator('.fb-ws-cell')).toHaveCount(6)
  await expect(app.locator('.fb-ws-meta')).toContainText('2 features')
  await expect(app.locator('.fb-ws-meta')).toContainText('50% understood')
  // The header carries no facts — the counts live on the map.
  await expect(page.locator('.fb-ws-title .fb-terr-title-understood')).toBeHidden()

  // ── CONNECTIONS ARE HIDDEN BY DEFAULT: only a count per project. ──
  await expect(page.locator('svg.fb-ws-links')).toHaveCount(0)
  // No per-project chip — the Workspace's count is on the Connections control,
  // each project's on its header's hover.
  await expect(page.locator('.fb-ws-chip')).toHaveCount(0)
  await expect(core.locator('.fb-ws-band')).toHaveAttribute('title', /· 3 connections$/)
  const toggle = page.locator('.fb-ws-title [data-ws-connections="toggle"]')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // Connections recorded, pairs never checked: the toggle carries an Update.
  await expect(page.locator('.fb-ws-title [data-ws-update]')).toHaveText('Update')

  // ── SHOWN ON TOGGLE, QUIETLY (2026-10-06: "only when hover the mouse"): no
  // lines at rest — the features that have connections are outlined. ──
  await toggle.click()
  await expect(page.locator('.fb-ws-title [data-ws-connections="toggle"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('[data-ws-ribbon]')).toHaveCount(0)
  await expect(page.locator('.fb-ws-link-hit')).toHaveCount(0)
  await expect(page.locator('.fb-ws-cell.fb-ws-linked')).toHaveCount(5)
  await expect(page.locator('.fb-ws-detail')).toContainText('3 connections — hover an outlined feature')
  await expect(page.locator('.fb-ws-detail')).toBeVisible()
  await screenshot(page, 'root-connections-light')

  // HOVER SHOWS that feature's own lines — each from cell to cell, its arrow
  // and its sentence — and leaving takes them away.
  // CONNECTIONS ON, NOTHING GROWS (2026-10-08: "we should not show the
  // diagram, we should not make the selected bigger, only show the edges"):
  // the hovered cell keeps its rectangle and draws no diagram.
  const chatsCell = page.locator('.fb-ws-cell', { hasText: 'Chats' })
  const restingBox = await chatsCell.boundingBox()
  await chatsCell.hover()
  await expect(page.locator('.fb-ws-feature-link[marker-end]')).toHaveCount(1)
  await page.waitForTimeout(900) // well past the hover pause and the slide
  await expect(page.locator('.fb-terr-grown')).toHaveCount(0)
  await expect(chatsCell.locator('.fb-terr-grow')).toHaveCount(0)
  expect(await chatsCell.boundingBox()).toEqual(restingBox)
  await expect(page.locator('.fb-ws-link-hit title')).toHaveText(/^Chats in .+ consumes Chat Engine in .+ \(chat stream\)$/)
  await expect(page.locator('.fb-ws-cell.fb-ws-hot', { hasText: 'Chat Engine' })).toHaveCount(1)
  await screenshot(page, 'hover-connections-light')
  await page.locator('.fb-ws-title').hover()
  await expect(page.locator('.fb-ws-feature-link')).toHaveCount(0)

  // SHIFT+PRESS KEEPS them, and the foot says them in words.
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).click({ modifiers: ['Shift'] })
  await expect(page.locator('.fb-ws-feature-link')).toHaveCount(1)
  await expect(page.locator('[data-ws-ribbon]')).toHaveCount(0)
  await expect(page.locator('.fb-ws-detail')).toContainText('Chats consumes Chat Engine in')
  await expect(page.locator('.fb-ws-cell.fb-ws-hot', { hasText: 'Chat Engine' })).toHaveCount(1)
  await screenshot(page, 'selected-light')

  // DARK, the same sheet.
  await theme(page, 'dark')
  await screenshot(page, 'selected-dark')
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).click({ modifiers: ['Shift'] }) // deselect
  await page.locator('.fb-ws-title').hover()
  await expect(page.locator('.fb-ws-link-hit')).toHaveCount(0)
  await screenshot(page, 'root-connections-dark')
  await theme(page, 'light')

  // ── A DOUBLE-CLICK ZOOMS INTO THE FEATURE (2026-10-08: a single click opens
  // it in place, a double-click goes in); Shift+press shows its connections. ──
  await page.locator('.fb-ws-title [data-ws-connections="toggle"]').click() // Connections off
  await expect(page.locator('.fb-ws-link-hit')).toHaveCount(0)
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).click({ modifiers: ['Shift'] })
  await expect(page.locator('.fb-ws-cell.fb-ws-selected', { hasText: 'Chats' })).toHaveCount(1)
  await expect(page.locator('.fb-ws-detail')).toContainText('Chats consumes Chat Engine in')
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).click({ modifiers: ['Shift'] }) // deselect
  await page.locator('.fb-ws-cell', { hasText: 'Chat Engine' }).dblclick()
  await expect(page.locator('.fb-ws-country')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.fb-terr-foot .fb-terr-crumbs')).toContainText('Chat Engine')
  await screenshot(page, 'zoomed-feature-dark')
  // BACK GOES TO WHERE THE READER CAME FROM — the Workspace, not the project's top.
  await page.locator('.fb-nav-btn').first().click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  // …and Backspace does the same.
  await page.locator('.fb-ws-cell', { hasText: 'Chat Engine' }).dblclick()
  await expect(page.locator('.fb-terr-foot .fb-terr-crumbs')).toContainText('Chat Engine', { timeout: 30_000 })
  await page.locator('.flow-board-root').press('Backspace')
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  // ONE MARK FOR ONE FACT: a cell printing its percentage drops its learn dot.
  // (Chats has parts, so it may already print its fraction: that mark is set
  // aside first, so "before" is the cell without a percentage.)
  const dotShown = await page.locator('.fb-ws-cell', { hasText: 'Chats' }).evaluate((cell) => {
    const existing = [...cell.querySelectorAll('.fb-terr-progress.has-fraction')]
    for (const el of existing) el.classList.remove('has-fraction')
    const dot = cell.querySelector('.fb-learn-dot')
    const before = dot === null ? 'none' : getComputedStyle(dot).display
    const mark = document.createElement('span')
    mark.className = 'fb-terr-progress has-fraction'
    cell.appendChild(mark)
    const after = dot === null ? 'none' : getComputedStyle(dot).display
    mark.remove()
    for (const el of existing) el.classList.add('has-fraction')
    return { before, after }
  })
  expect(dotShown).toEqual({ before: expect.not.stringMatching(/^none$/), after: 'none' })

  // THE SAME LEARN DOOR AS INSIDE A PROJECT, on hover — and no diagram door:
  // the diagram is the opened cell's (plan cell-hover-diagram).
  const engine = page.locator('.fb-ws-cell', { hasText: 'Chat Engine' })
  // From off the map: the pointer resting where the double-click left it is
  // not a hover (the map was re-drawn under it).
  await page.mouse.move(2, 2)
  await engine.hover()
  await expect(engine.locator('[data-learn-feature]')).toBeVisible()
  await expect(engine.locator('[data-open-level]')).toHaveCount(0)
  await screenshot(page, 'cell-doors-dark')
  // Connections off: hovering grows the cell to its DETAILS in place (the
  // positive for the no-grow check above) — its words, no diagram, no pin —
  // and a click opens it.
  await expect(engine).toHaveClass(/fb-terr-grown/, { timeout: 5_000 })
  await expect(engine.locator('.fb-terr-grow-details')).toHaveCount(1)
  await expect(engine.locator('.fb-terr-grow-diagram')).toHaveCount(0)
  await expect(engine).not.toHaveClass(/fb-terr-pinned/)
  await engine.click({ position: { x: 12, y: 12 } })
  await expect(engine).toHaveClass(/fb-terr-grown/, { timeout: 5_000 })
  await expect(engine.locator('.fb-terr-grow-details')).toHaveCount(0, { timeout: 5_000 })
  await engine.focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('.fb-terr-grown')).toHaveCount(0, { timeout: 5_000 })
  // A FEATURE WITH NO PARTS reads as its code story on a double-click, right
  // from the map; one Back returns to the map.
  await page.mouse.move(2, 2)
  await page.locator('.fb-ws-cell', { hasText: 'Auth' }).dblclick()
  await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText('Auth', { timeout: 60_000 })
  await page.locator('.fb-nav-btn').first().click()
  await expect(page.locator('.fb-story')).toHaveCount(0)
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  await page.locator('.fb-ws-title [data-ws-connections="toggle"]').click() // Connections back on

  // ── ZOOM IN: the app's board, as it always was, inside its Workspace. ──
  await app.locator('.fb-ws-name').click()
  await expect(page.locator('.fb-terr-cell', { hasText: 'Chats' })).toBeVisible({ timeout: 120_000 })
  await expect(page.locator('.fb-ws-country')).toHaveCount(0)
  // THE PROJECT'S OWN BOARD, not a read-only picture of it: Ask the brain is there.
  await expect(page.locator('.fb-ws-open')).toHaveCount(0)
  // (Ask the brain is hidden until its design pass — the Connections toggle is the project's own control here.)
  await expect(page.locator('.fb-head-strip [data-ws-connections="toggle"]')).toBeVisible()
  const trail = page.locator('.fb-terr-foot .fb-terr-crumbs')
  await expect(trail.locator('.fb-ws-crumb')).toBeVisible()
  await expect(trail).toContainText(/\/\s*flow-ux-wsb-app-/i)
  // A DESCRIPTION IS PROSE; provenance is a path at the foot, never a description.
  const signIn = page.locator('.fb-terr-cell', { hasText: 'Sign In' })
  await expect(signIn).not.toContainText('Confirmed from')
  // WHERE IT LIVES is the folder its files are in (plan feature-home-folders):
  // the home line or the explorer rows took the provenance path's place.
  const signInHome = signIn.locator('[data-folder-path="src"]').first()
  await expect(signInHome).toBeVisible()
  await expect(signInHome).toContainText('src')
  await expect(signInHome).toContainText('100%')
  await expect(signIn).not.toContainText('src/sign_in')
  // At rest a roomy card shows its description (2026-10-08).
  await expect(page.locator('.fb-terr-cell', { hasText: 'Chats' }).locator('.fb-terr-cell-summary')).toHaveText('What Chats does.')
  // Its links to the other project run off the edge, named. (The pointer left
  // where the zoom's press was would grow the cell under it, shrinking the
  // others to their names — chips and all.)
  await page.mouse.move(2, 2)
  await expect(page.locator('.fb-terr-cell.fb-terr-grown')).toHaveCount(0, { timeout: 5_000 })
  await expect(page.locator('.fb-ws-edge-label').first()).toBeVisible({ timeout: 30_000 })
  // Inside the project with Connections on, hover does not grow a cell either:
  // its links stay where they run off the edge.
  const appChats = page.locator('.fb-terr-cell', { hasText: 'Chats' })
  await appChats.hover()
  await page.waitForTimeout(900)
  await expect(page.locator('.fb-terr-cell.fb-terr-grown')).toHaveCount(0)
  await expect(page.locator('.fb-ws-edge-label').first()).toBeVisible()
  await page.mouse.move(2, 2)
  const labels = await page.locator('.fb-ws-edge-label').allTextContents()
  expect(labels.every((label) => label.startsWith('→ '))).toBe(true)
  await screenshot(page, 'zoomed-app-light')
  await theme(page, 'dark')
  await screenshot(page, 'zoomed-app-dark')
  await theme(page, 'light')

  // ── BACK OUT, three ways (live 2026-10-06: "after the zoom in I'm not able to go back"). ──
  // 1. The back arrow at the project's top level returns to the Workspace.
  const backArrow = page.locator('.fb-nav-btn').first()
  await expect(backArrow).toBeEnabled()
  await backArrow.click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  // 2. The Workspace's name leads the project's title as a link back up.
  await app.locator('.fb-ws-name').click()
  await expect(page.locator('.fb-terr-cell', { hasText: 'Chats' })).toBeVisible({ timeout: 120_000 })
  await page.locator('.fb-ws-title-up').click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  // 3. The breadcrumb.
  await app.locator('.fb-ws-name').click()
  await expect(page.locator('.fb-terr-cell', { hasText: 'Chats' })).toBeVisible({ timeout: 120_000 })
  await trail.locator('.fb-ws-crumb').click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  await expectOnScreen(page, page.locator(`.fb-ws-country[data-ws-project="${slugs.mobile}"]`))

  // ── ONE COLOUR PER PROJECT, EVERYWHERE (2026-10-06) ──
  // The switcher's folder for a project wears the same colour as its bar here.
  const barOf = (key: string): Promise<string> =>
    page.locator(`.fb-ws-country[data-ws-project="${slugs[key]}"]`).evaluate((el) => {
      // The project's own colour, resolved: what its name is mixed from.
      const probe = document.createElement('span')
      probe.style.color = 'var(--fb-ws-hue)'
      el.appendChild(probe)
      const colour = getComputedStyle(probe).color
      probe.remove()
      return colour
    })
  const switcher = page.locator('.fl-ws-switcher button[aria-haspopup="menu"]').first()
  await switcher.click()
  const appFolder = page.locator('.fl-ws-project', { hasText: basename(roots.app) }).locator('.fl-ws-project-icon')
  await expect(appFolder).toBeVisible()
  const folderColour = await appFolder.evaluate((el) => getComputedStyle(el).color)
  expect(await barOf('app')).toContain(folderColour)
  await screenshot(page, 'switcher-colours-dark')
  // Picked in the project's settings, it changes on the map at once.
  await page.locator('.fl-ws-project', { hasText: basename(roots.app) }).click()
  const rose = page.locator('[data-flow-settings="colour"] [data-colour="#e07a9a"]')
  await expect(rose).toBeVisible()
  await screenshot(page, 'settings-colour-dark')
  await rose.click()
  await expect(rose).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Close flow settings' }).click()
  // Rose is theme-aware: lifted on the dark ground, darkened on the light.
  const ROSE = /rgb\(224, 122, 154\)|rgb\(180, 74, 110\)/
  await expect.poll(() => barOf('app')).toMatch(ROSE)
  // …and Auto hands it back to its place in the Workspace.
  await switcher.click()
  await page.locator('.fl-ws-project', { hasText: basename(roots.app) }).click()
  await page.locator('[data-flow-settings="colour"] [data-colour="auto"]').click()
  await page.getByRole('button', { name: 'Close flow settings' }).click()
  await expect.poll(() => barOf('app')).not.toMatch(ROSE)

  // THE BIG GROUND FOLLOWS THE THREAD'S PROJECT (live 2026-10-06): app is active
  // now, so the smaller codebase leads and core steps into the side column.
  await page.waitForTimeout(600)
  expect(await area(app)).toBeGreaterThan((await area(core)) + (await area(mobile)))
  await screenshot(page, 'back-at-root-light')
})

/**
 * CONNECTIONS LEARNING (discovery workspace-connections-learning) — the map
 * fills itself in. Real CLI, real files: app's calls and core's endpoints are
 * written where a derive leaves them, so the code matcher finds the
 * Chats → Chat Engine connection by itself; the fast model is the e2e stand-in
 * (no hidden run reaches a real one) and suggests Sign In → Auth.
 */
test('Learn connections: code finds one, the model suggests one, the map draws both', async ({ app, window: page }) => {
  test.setTimeout(300_000)

  // REAL CODE, so every derive the app runs finds the same thing: core SERVES
  // the stream (an express-style route), app CALLS it through a setting whose
  // example names core's folder.
  const roots: Record<string, string> = {}
  for (const key of Object.keys(PROJECTS)) {
    roots[key] = await seedProject(page, `flow-ux-wsl-${key}-`, (dir) => {
      seedFeatures(dir, PROJECTS[key])
      if (key === 'core') {
        appendFileSync(join(dir, 'src', 'chat-engine.ts'), "router.get('/api/v1/chats/:id/stream', (req, res) => res.end())\n")
      }
      if (key === 'app') {
        appendFileSync(join(dir, 'src', 'chats.ts'), 'export const stream = (id: string) => fetch(`${process.env.CORE_API_URL}/v1/chats/${id}/stream`)\n')
        writeFileSync(join(dir, '.env.example'), `CORE_API_URL=https://${basename(roots.core ?? '')}.internal.example.com/api\n`)
      }
    })
  }
  const { workspacePath, slugs } = await waitForPlacement(page, roots)

  // What a derive leaves behind: core SERVES the stream, app CALLS it through
  // a setting whose example names core.
  const structureOf = (key: string): string => {
    const dir = join(workspacePath, 'projects', slugs[key], 'brain', '.structure')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const now = '2026-10-06T12:00:00.000Z'
  writeFileSync(
    join(structureOf('core'), 'surface.json'),
    JSON.stringify({ version: 1, project: basename(roots.core), repoPath: roots.core, derivedAt: now, graphHash: 'x', endpoints: [{ method: 'GET', path: '/api/v1/chats/:id/stream' }], graphqlOperations: [] }),
  )
  writeFileSync(
    join(structureOf('core'), 'graph.json'),
    JSON.stringify({ version: 1, derivedAt: now, nodes: [{ id: 'endpoint:GET /api/v1/chats/:id/stream', kind: 'endpoint', label: 'GET /api/v1/chats/:id/stream', sourceFile: 'src/chat-engine.ts', meta: { method: 'GET', route: '/api/v1/chats/:id/stream' } }], edges: [] }),
  )
  writeFileSync(
    join(structureOf('app'), 'outbound.json'),
    JSON.stringify({ version: 1, extractedAt: now, calls: [{ base: 'CORE_API_URL', baseIsEnv: true, path: '/v1/chats/{param}/stream', file: 'src/chats.ts' }], graphqlOperations: [], envHints: { CORE_API_URL: `https://${basename(roots.core)}.internal.example.com/api` } }),
  )

  // The fast model, stood in: it suggests Sign In → Auth, and keeps every prompt.
  await app.evaluate(({}, s) => {
    const prompts: string[] = []
    ;(globalThis as Record<string, unknown>)['__connectionPrompts'] = prompts
    ;(globalThis as Record<string, unknown>)['__flowE2ESeams'] = {
      askFastModel: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt)
        // A real model takes seconds — long enough that the run must SHOW.
        await new Promise((done) => setTimeout(done, 2500))
        return JSON.stringify({ links: [{ from: `${s.app}/sign-in`, to: `${s.core}/auth`, kind: 'calls', note: 'signs people in' }, { from: `${s.app}/made-up`, to: `${s.core}/auth`, kind: 'calls' }] })
      },
    }
  }, slugs)

  for (const key of ['app', 'mobile', 'core']) await activateProject(page, roots[key])
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 6; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 120_000 })
  await theme(page, 'light')

  // BEFORE: nothing recorded, nothing checked.
  const kicker = page.locator('.fb-ws-title .fb-terr-title-kicker')
  // A quiet strip: what the Workspace holds; connections live on their control.
  await expect(kicker).toBeHidden()
  // ONE CONTROL: with nothing to draw it is Learn connections, and no toggle.
  const control = page.locator('.fb-ws-title [data-ws-control]')
  await expect(control).toHaveAttribute('data-ws-control', 'learn')
  await expect(control.locator('[data-ws-connections]')).toHaveCount(1)
  // THE HEADER PATTERN: every control is the app's own ghost button.
  await expect(control.locator('fl-button.fb-head-btn')).toHaveCount(1)
  await expect(control.locator('[data-ws-connections]')).toHaveText('Learn connections')
  await expect(control.locator('[data-ws-connections]')).toHaveAttribute('title', /0 of 3 pairs checked/)

  // LEARN: it counts the run, then it IS the Connections toggle — already on,
  // because what a person asked to learn they want to see — and every pair is
  // up to date, so no Update is attached.
  await control.locator('[data-ws-connections]').click()
  // WHILE IT RUNS, IT SAYS SO — and how far it has got.
  await expect(page.locator('.fb-ws-title [data-ws-control]')).toHaveAttribute('data-ws-control', 'learning', { timeout: 5_000 })
  await expect(page.locator('.fb-ws-title [data-ws-control] [data-ws-connections]')).toHaveText(/^(\d+%|…)$/)
  await expect(page.locator('.fb-ws-title > .fb-ws-learning-line')).toBeVisible()
  // …and once pairs are being checked, a percentage and the pair it is on.
  await expect(page.locator('.fb-ws-title [data-ws-control] [data-ws-connections]')).toHaveText(/^\d+%$/, { timeout: 30_000 })
  await expect(page.locator('.fb-ws-title [data-ws-control] [data-ws-connections]')).toHaveAttribute('title', /^Learning connections — checking .+ ↔ .+, \d of 3 pairs done$/)
  await screenshot(page, 'learning-connections-dark')
  await expect(page.locator('.fb-ws-title [data-ws-connections="toggle"]')).toHaveAttribute('title', /3 of 3 pairs checked/, { timeout: 120_000 })
  await expect(page.locator('.fb-ws-title > .fb-ws-learning-line')).toBeHidden()
  await expect(page.locator('.fb-ws-title [data-ws-connections="toggle"]')).toHaveText('Connections · 2')
  await expect(page.locator('.fb-ws-title [data-ws-control]')).toHaveAttribute('data-ws-control', 'toggle')
  await expect(page.locator('.fb-ws-title [data-ws-connections="toggle"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.fb-ws-title [data-ws-update]')).toHaveCount(0)

  // The model was asked ONCE — only app ↔ core showed a sign — and its invented feature went nowhere.
  const prompts = await app.evaluate(() => (globalThis as Record<string, unknown>)['__connectionPrompts'] as string[])
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('<data>')
  expect(prompts[0]).toContain('- chat-engine: Chat Engine')
  expect(prompts[0]).not.toContain('made-up')

  // DRAWN: the code's connection solid, the model's suggested — and said so.
  await expect(page.locator('.fb-ws-cell.fb-ws-linked')).toHaveCount(4)
  await page.locator('.fb-ws-cell', { hasText: 'Sign In' }).click({ modifiers: ['Shift'] })
  await expect(page.locator('.fb-ws-feature-link')).toHaveCount(1)
  await expect(page.locator('.fb-ws-feature-link.fb-ws-suggested')).toHaveCount(1)
  await expect(page.locator('.fb-ws-detail')).toContainText('Sign In calls Auth in')
  await expect(page.locator('.fb-ws-detail')).toContainText('suggested by Flow')
  await screenshot(page, 'learned-suggested-light')
  await page.locator('.fb-ws-cell', { hasText: 'Sign In' }).click({ modifiers: ['Shift'] }) // deselect
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).click({ modifiers: ['Shift'] })
  await expect(page.locator('.fb-ws-feature-link')).toHaveCount(1)
  await expect(page.locator('.fb-ws-feature-link.fb-ws-suggested')).toHaveCount(0)
  await expect(page.locator('.fb-ws-detail')).toContainText('Chats calls Chat Engine in')
  await expect(page.locator('.fb-ws-detail')).toContainText('1 endpoint matched in code')
  await screenshot(page, 'learned-code-light')
  await theme(page, 'dark')
  await screenshot(page, 'learned-code-dark')
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).click({ modifiers: ['Shift'] }) // deselect

  // A press goes in — here a feature of a sibling project, which becomes the
  // active one and opens on it.
  await page.locator('.fb-ws-cell', { hasText: 'Chats' }).click()
  await expect(page.locator('.fb-terr-foot .fb-terr-crumbs')).toContainText('Chats', { timeout: 60_000 })
  await expect(page.locator('.fb-terr-foot .fb-terr-crumbs')).toContainText(basename(roots.app))
  // Back returns to the Workspace, not to that project's top level.
  await page.locator('.fb-nav-btn').first().click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
  // A SIBLING'S FEATURE WITH PARTS (core is the sibling now) zooms in there
  // too — the cell's diagram is its hover card's; one Back home.
  await page.locator('.fb-ws-cell', { hasText: 'Chat Engine' }).click()
  await expect(page.locator('.fb-terr-foot .fb-terr-crumbs')).toContainText('Chat Engine', { timeout: 60_000 })
  await expect(page.locator('.fb-ws-country')).toHaveCount(0)
  await expect(page.locator('.fb-nav-btn').first()).toBeEnabled({ timeout: 30_000 })
  await page.waitForTimeout(500)
  await page.locator('.fb-nav-btn').first().click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 30_000 })
})

/**
 * THE LEARNING PANEL, PER PROJECT (2026-10-06) — one row per project of the
 * Workspace, the thread's own open and the others folded, so one project can
 * be learned without the others. Nothing here presses Learn: a hidden run never
 * starts a real model pass.
 */
test('the Learning panel lists every project of the Workspace, the thread’s own open', async ({ window: page }) => {
  test.setTimeout(300_000)
  const roots: Record<string, string> = {}
  for (const key of Object.keys(PROJECTS)) {
    roots[key] = await seedProject(page, `flow-ux-wsl-${key}-`, (dir) => seedFeatures(dir, PROJECTS[key]))
  }
  const { slugs } = await waitForPlacement(page, roots)
  for (const key of ['app', 'mobile', 'core']) await activateProject(page, roots[key])
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 6; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 120_000 })

  await page.locator('.fb-header fl-button[title="Show learning progress"]').click()
  const rows = page.locator('.fb-lp-project')
  await expect(rows).toHaveCount(3, { timeout: 30_000 })
  await expect(page.locator('.fb-lp-overall .fb-lp-headline')).toBeVisible()

  // The thread's project (core, activated last) is the open one, tagged.
  const core = page.locator(`.fb-lp-project[data-lp-project="${slugs.core}"]`)
  await expect(core).toHaveClass(/open/)
  await expect(core.locator('.fb-lp-here')).toHaveText('this thread')
  await expectOnScreen(page, core.locator('.fb-lp-head'))
  for (const key of ['app', 'mobile']) {
    const other = page.locator(`.fb-lp-project[data-lp-project="${slugs[key]}"]`)
    await expect(other).not.toHaveClass(/open/)
    await expect(other.locator('.fb-lp-name')).not.toHaveText('')
  }
  await theme(page, 'dark')
  await screenshot(page, 'learn-panel-dark')

  // Opening another project shows ITS modules (or says why not) — never core's.
  const app = page.locator(`.fb-lp-project[data-lp-project="${slugs.app}"]`)
  await app.locator('.fb-lp-head').click()
  await expect(app).toHaveClass(/open/)
  await expect(app.locator('.fb-lp-body')).toBeVisible()
  await expect(app.locator('.fb-lp-body')).not.toContainText('Reading…', { timeout: 30_000 })
  await expect(app.locator('.fb-lp-body')).toContainText(/No modules yet|Not learned|Learned/)
  await expect(app.locator('.fb-learn-tabbar')).toHaveCount(0)
  await theme(page, 'light')
  await screenshot(page, 'learn-panel-two-open-light')

  // And it folds again.
  await app.locator('.fb-lp-head').click()
  await expect(app).not.toHaveClass(/open/)
})

// THE RUNNING PERCENTAGE ON THE WORKSPACE MAP (2026-10-08: "we are not showing
// the loading percentage indicator on the workspace page, only inside the
// project"). The press is real; the pass's progress is the event main sends.
test('a feature being learned shows its percentage on the Workspace map too', async ({ app: electronApp, window: page }) => {
  test.setTimeout(300_000)
  const roots: Record<string, string> = {}
  for (const key of Object.keys(PROJECTS)) {
    roots[key] = await seedProject(page, `flow-ux-wsp-${key}-`, (dir) => seedFeatures(dir, PROJECTS[key]))
  }
  await waitForPlacement(page, roots)
  for (const key of ['app', 'mobile', 'core']) await activateProject(page, roots[key])
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  for (let i = 0; i < 6; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click()
  }
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.fb-ws-country')).toHaveCount(3, { timeout: 120_000 })

  // Learn Auth (core, the current project) from its card on the Workspace map.
  const auth = page.locator('.fb-ws-cell', { hasText: 'Auth' })
  await auth.hover()
  await auth.locator('[data-learn-feature]').click()
  await expect(auth).toHaveClass(/fb-terr-inflight/, { timeout: 10_000 })
  await expect(auth.locator(':scope > .fb-terr-progress')).toHaveCount(1)

  // Main reports 3 of 5 files read: the card prints the same figure the
  // project's own board would.
  const featureRef = await auth.getAttribute('data-feature-id')
  expect(featureRef).not.toBeNull()
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('learn:featureReadProgress', payload)
  }, { rootId: roots.core, featureRef: featureRef ?? '', read: 3, total: 5 })
  await expect(auth.locator('.fb-terr-progress-figure')).toHaveText('60%', { timeout: 10_000 })
  await screenshot(page, 'learning-percent-dark')

  // Opened, its words say how far along too.
  await auth.click({ position: { x: 12, y: 12 } })
  await expect(auth).toHaveClass(/fb-terr-grown/, { timeout: 5_000 })
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('learn:featureReadProgress', payload)
  }, { rootId: roots.core, featureRef: featureRef ?? '', read: 3, total: 5 })
  // The centred dial and figure stay on the grown card, above its words.
  await expect(auth.locator(':scope > .fb-terr-progress .fb-terr-progress-figure')).toHaveText(/^\d+%$/, { timeout: 10_000 })
  await expect(auth.locator(':scope > .fb-terr-progress .fb-terr-progress-figure')).toBeVisible()
  await expect(auth.locator('.fb-terr-grow-learn-running')).toHaveText('Learning this feature…')
  await screenshot(page, 'learning-percent-grown')
})
