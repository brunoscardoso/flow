import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { FrameLocator, Locator } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject, waitForWorkspaceLink } from '../ux/fixtures/seed'
import { observeAgentWrite } from './drafts-observer-handle'

/**
 * A draft screen inside a discovery's artifact (plan `ui_drafts`, phase 7),
 * in the real app.
 *
 * A temp project gets a discovery, its artifact page with two draft slots (one
 * screen that is drawn, one that is not), the canvas, and a plan whose
 * `## Draft screens` block is written by the REAL `plan screens` verb of the
 * bundled CLI — the one writer of that block. The artifact is opened the way
 * the DISCOVERY card's press opens it (`flow:open-feature-view`).
 *
 *  1. The drawn screen renders in a frame INSIDE the artifact's frame, with
 *     the canvas tokens applied; the missing one says so.
 *  2. No "Changed since the plan" badge while the screen is the plan's version.
 *  3. The screen changes on disk: the open artifact reloads by itself and
 *     shows the badge (and the new content).
 *
 * The file watcher on a macOS temp folder is not reliable enough to wait on, so
 * the change is run through the drafts observer's own processing from main —
 * the broadcast the artifact listens to is the real one.
 */

test.afterAll(() => cleanupSeeds())

const SLUG = 'demo'
const DOC = `discovery_${SLUG}_v1.md`
const PAGE = `discovery_${SLUG}_v1.walkthrough.html`
const PLAN = `plan_${SLUG}_v1.md`
const TITLE = 'Discovery: Demo'

const TOKENS = ':root { --brand: rgb(10, 120, 30); }\nbody { margin: 0; font-family: sans-serif; }\nh1 { color: var(--brand); }\n'
const HOME =
  '<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head>' +
  '<body data-flow-id="hbody"><h1 data-flow-id="htitle">Welcome home</h1></body></html>'

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Demo</title></head><body>
<section class="step"><h2>Step one: the home screen</h2><p>People land here first.</p>
<div data-flow-draft="demo/home"></div></section>
<section class="step"><h2>Step two: checkout</h2><p>Then they pay.</p>
<div data-flow-draft="demo/checkout"></div></section>
</body></html>\n`

function seedCanvas(root: string): void {
  const dir = join(root, 'flow', 'drafts', 'demo')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'layout.json'),
    JSON.stringify({
      name: 'Demo',
      tokenSources: [],
      screens: [
        { id: 'home', title: 'Home', order: 1, frame: { x: 0, y: 0, w: 390, h: 500 } },
        { id: 'checkout', title: 'Checkout', order: 2, frame: { x: 470, y: 0, w: 390, h: 500 } },
      ],
    }),
  )
  writeFileSync(join(dir, 'tokens.css'), TOKENS)
  writeFileSync(join(dir, 'home.html'), HOME)
}

/** The bundled CLI the app ships (`build:cli` writes it). */
const BUNDLED_CLI = join(__dirname, '..', '..', 'resources', 'cli', 'planflow-ai.mjs')

test('an artifact step shows a draft screen live, says when one is not drawn, and badges a change since the plan', async ({
  app,
  window,
}) => {
  test.setTimeout(150_000)
  const root = await seedProject(window, 'flow-e2e-drafts-artifact-', seedCanvas, { onboarded: true })
  await activateProject(window, root)
  // Write the docs only once the background scaffold is in place (a doc written
  // while it runs can be lost with the folder it landed in).
  await waitForWorkspaceLink(root)
  mkdirSync(join(root, 'flow', 'discovery'), { recursive: true })
  mkdirSync(join(root, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(root, 'flow', 'discovery', DOC), `# ${TITLE}\n\nA demo.\n`)
  writeFileSync(join(root, 'flow', 'discovery', PAGE), PAGE_HTML)
  writeFileSync(join(root, 'flow', 'plans', PLAN), `# Plan: Demo\n\n## Intent\n\n**Goal** — a demo.\n\n---\n\n### Phase 1: Build\n\n1. Build it.\n`)

  // The plan records the screen versions it read — through the real verb.
  const recorded = JSON.parse(
    execFileSync(process.execPath, [BUNDLED_CLI, 'plan', 'screens', PLAN, '--target', root, '--json'], {
      encoding: 'utf8',
    }).trim().split('\n').pop() ?? '{}',
  ) as { screens?: Array<{ canvas: string; screen: string; hash: string }>; changed?: boolean }
  expect(recorded.changed).toBe(true)
  expect(recorded.screens?.map((entry) => `${entry.canvas}/${entry.screen}`)).toEqual(['demo/home'])
  expect(readFileSync(join(root, 'flow', 'plans', PLAN), 'utf8')).toMatch(/## Draft screens\n+- demo\/home · sha256:[0-9a-f]{64}/)

  await window.evaluate(
    (detail) => document.dispatchEvent(new CustomEvent('flow:open-feature-view', { detail })),
    { rootPath: root, path: `flow/discovery/${PAGE}`, slug: SLUG, title: TITLE },
  )
  const view = window.locator('.fl-feature-view').filter({ hasText: TITLE })
  await expect(view).toBeVisible({ timeout: 15_000 })
  const artifact: FrameLocator = view.frameLocator('iframe.fl-feature-frame')
  await expect(artifact.getByText('Step one: the home screen')).toBeVisible({ timeout: 15_000 })

  // ── The drawn screen: a frame inside the artifact frame, tokens applied ──
  const figure: Locator = artifact.locator('figure[data-flow-draft-screen]')
  await expect(figure).toHaveCount(1)
  await expect(figure.locator('figcaption')).toContainText('Home')
  const screen = artifact.frameLocator('figure[data-flow-draft-screen] iframe')
  const heading = screen.locator('h1')
  await expect(heading).toHaveText('Welcome home', { timeout: 15_000 })
  // The colour comes from the canvas tokens stylesheet, not from the screen.
  await expect(heading).toHaveCSS('color', 'rgb(10, 120, 30)')

  // ── The screen that is not drawn says so ──────────────────────────────
  await expect(artifact.locator('[data-flow-draft-missing]')).toHaveText('This screen is not drawn yet.')
  // No slot is left bare.
  await expect(artifact.locator('[data-flow-draft]')).toHaveCount(0)

  // ── The screen is the plan's version: no badge yet ────────────────────
  // (the positive first: the figure IS rendered, so the absence is evidence)
  await expect(figure).toBeVisible()
  await expect(artifact.locator('[data-flow-draft-changed]')).toHaveCount(0)

  // ── The screen changes on disk: the artifact reloads live, with the badge ──
  const homeFile = join(root, 'flow', 'drafts', 'demo', 'home.html')
  writeFileSync(homeFile, HOME.replace('Welcome home', 'Welcome back'))
  await observeAgentWrite(app, root, homeFile)
  await expect(artifact.locator('[data-flow-draft-changed]')).toHaveText('Changed since the plan', { timeout: 20_000 })
  await expect(screen.locator('h1')).toHaveText('Welcome back', { timeout: 15_000 })
  await expect(screen.locator('h1')).toHaveCSS('color', 'rgb(10, 120, 30)')
  // The missing screen is still the quiet sentence after the reload.
  await expect(artifact.locator('[data-flow-draft-missing]')).toHaveText('This screen is not drawn yet.')
})
