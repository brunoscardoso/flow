import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, activeProjectName } from './fixtures/seed'

/**
 * Flow 1 — the "Run a basic discovery?" ask that fires when a project is ADDED.
 *
 * Adding a project is where progressive learning introduces itself: the moment
 * auto-provisioning reports `ready`, main pushes `learn:basicDiscoveryAsk` and
 * the renderer (learn/index.ts) drops a one-time card bottom-right. Answering it
 * is recorded on the root (`basicDiscoveryAnswer`) and NEVER re-asked, and a
 * 'yes' enqueues a real agent run over the project's modules. Two live guards
 * pin the healthy path; two tripwires pin what this sweep found broken.
 *
 * Coverage here:
 *  - test 1 (LIVE): a project with real modules — the ask appears on add, and
 *    "Run discovery" answers it with the "Basic discovery started · Learning N
 *    module(s)" toast AND an inbox entry. This is the contrast that proves the
 *    silence in test 3 is specific, not a dead probe.
 *  - test 2 (LIVE): the documented recovery route (Flow settings → "Run basic
 *    discovery") re-fires the same request and produces the same toast, so the
 *    one-shot card is not the only way in.
 *  - test 3 (#1169): a project whose only modules are scaffolding (tests/,
 *    __mocks__/, dot-dirs) selects ZERO modules, and BOTH routes go completely
 *    silent — no toast, no inbox entry, no status change — while the one-time
 *    ask is spent forever. `enqueueBasicDiscovery` only notifies inside
 *    `if (modules.length > 0)`, so the branch that has nothing to run is the one
 *    branch that says nothing; the "skipped N scaffolding module(s) … configure
 *    via learn_ignore" sentence it already composes is unreachable exactly when
 *    it is the only thing to say.
 *  - test 4 (#1170): neither the ask card nor the started toast names the
 *    project. The ask fires per ROOT on provisioning-ready, so a project added
 *    in the BACKGROUND (`project:add` never steals the active project,
 *    #382) raises a card while the user is still in another project — clicking
 *    it spends an agent run on a project nothing on screen identifies.
 *    `buildProjectChip` exists in notification-center.ts but is applied only to
 *    blocked-prompt/sticky cards (#1074's fix), not to this state-change toast.
 *
 * No native dialog is involved: the ask is a renderer card, and roots are added
 * through the real `project:add` IPC the folder picker calls after a pick.
 */
const SCREENS = 'e2e/ux/__screens'

/** A repo with `src/<name>` module dirs — the shape onboarding selects. */
function withModules(names: string[]) {
  return (dir: string): void => {
    for (const name of names) {
      mkdirSync(join(dir, 'src', name), { recursive: true })
      writeFileSync(join(dir, 'src', name, 'index.ts'), `export const ${name} = 1\n`)
    }
    writeFileSync(join(dir, 'package.json'), `{"name":"probe","version":"1.0.0"}\n`)
  }
}

/** A repo whose ONLY directories are scaffolding the selection skips. */
function scaffoldingOnly(dir: string): void {
  for (const name of ['tests', '__mocks__']) {
    mkdirSync(join(dir, name), { recursive: true })
    writeFileSync(join(dir, name, 'a.test.ts'), 'test("x", () => {})\n')
  }
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"scaffold","version":"1.0.0"}\n')
}

interface Feedback {
  toasts: string[]
  inbox: string[]
}

/** Everything the user could possibly read as "something happened". */
async function feedback(win: Page): Promise<Feedback> {
  return win.evaluate(() => ({
    toasts: Array.from(document.querySelectorAll('.fl-flow-toast')).map((node) =>
      (node.textContent ?? '').trim(),
    ),
    inbox: Array.from(document.querySelectorAll('.fl-flow-inbox-entry')).map((node) =>
      (node.textContent ?? '').trim(),
    ),
  }))
}

/** Wait for the one-time ask card (it follows provisioning `ready`). */
async function waitForAsk(win: Page): Promise<void> {
  await win.locator('.fl-learn-card').waitFor({ state: 'visible', timeout: 60000 })
}

async function clickAsk(win: Page, label: 'Run discovery' | 'Not now'): Promise<void> {
  await win.locator('.fl-learn-card fl-button', { hasText: label }).click()
}

test.afterAll(() => cleanupSeeds())

test('adding a project with modules asks, and "Run discovery" reports it started', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(String(error)))

  const project = await seedProject(window, 'flow-ux-bd-mods-', withModules(['api', 'core', 'ui']))
  await activateProject(window, project)

  await waitForAsk(window)
  const card = window.locator('.fl-learn-card')
  await expect(card).toContainText('Run a basic discovery?')
  await window.screenshot({ path: `${SCREENS}/project-basic-discovery-ask.png` })

  await clickAsk(window, 'Run discovery')
  // The card is one-shot: it goes away immediately, so the toast is the only
  // acknowledgement the user gets.
  await expect(card).toHaveCount(0)
  const toast = window.locator('.fl-flow-toast', { hasText: 'Basic discovery started' })
  await expect(toast).toBeVisible({ timeout: 20000 })
  await expect(toast).toContainText('Learning 3 module(s)')
  const seen = await feedback(window)
  expect(seen.inbox.join('\n')).toContain('Basic discovery started')

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})

test('Flow settings → "Run basic discovery" re-fires the same request', async ({ window }) => {
  const project = await seedProject(window, 'flow-ux-bd-again-', withModules(['api', 'core']))
  await activateProject(window, project)

  await waitForAsk(window)
  await clickAsk(window, 'Not now') // spend the one-time ask
  await expect(window.locator('.fl-learn-card')).toHaveCount(0)

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-flow-settings')))
  const button = window.locator('.fl-settings-btn', { hasText: 'Run basic discovery' })
  await expect(button).toBeVisible({ timeout: 10000 })
  await expect(button).toBeEnabled()
  await button.click()

  const toast = window.locator('.fl-flow-toast', { hasText: 'Basic discovery started' })
  await expect(toast).toBeVisible({ timeout: 20000 })
  await expect(toast).toContainText('Learning 2 module(s)')
})

test(
  '#1169 — "Run discovery" on a scaffolding-only project says SOMETHING',
  async ({ window }) => {
    const project = await seedProject(window, 'flow-ux-bd-scaffold-', scaffoldingOnly)
    await activateProject(window, project)

    await waitForAsk(window)
    await clickAsk(window, 'Run discovery')
    await window.waitForTimeout(8000)
    const afterCard = await feedback(window)
    await window.screenshot({ path: `${SCREENS}/project-basic-discovery-silent.png` })
    expect(
      [...afterCard.toasts, ...afterCard.inbox],
      'clicking "Run discovery" produced no user-visible feedback anywhere (the project HAS module nodes — tests/ and __mocks__/ — they are all skipped as scaffolding, and the app already composes a sentence saying exactly that)',
    ).not.toEqual([])

    // The documented recovery route is silent in the same way.
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-flow-settings')))
    const button = window.locator('.fl-settings-btn', { hasText: 'Run basic discovery' })
    await expect(button).toBeVisible({ timeout: 10000 })
    await button.click()
    await window.waitForTimeout(8000)
    const afterSettings = await feedback(window)
    expect(
      [...afterSettings.toasts, ...afterSettings.inbox],
      'the Flow settings "Run basic discovery" button is a silent dead click on the same project',
    ).not.toEqual([])
  },
)

test(
  '#1170 — the ask (and its toast) name the project they will learn',
  async ({ window }) => {
    // The user is working in A and answers its ask.
    const a = await seedProject(window, 'flow-ux-bd-A-', withModules(['alpha', 'alphatwo']))
    await activateProject(window, a)
    await waitForAsk(window)
    await clickAsk(window, 'Not now')
    await expect(window.locator('.fl-learn-card')).toHaveCount(0)

    // B is added in the BACKGROUND — #382 keeps the user inside A.
    const b = await seedProject(
      window,
      'flow-ux-bd-B-',
      withModules(['beta', 'betatwo', 'betathree']),
    )
    await waitForAsk(window)
    await expect.poll(() => activeProjectName(window)).toBe(basename(a))
    const cardText = (await window.locator('.fl-learn-card').textContent()) ?? ''
    await window.screenshot({ path: `${SCREENS}/project-basic-discovery-named.png` })
    expect(
      cardText,
      `the ask card names no project, and the one it belongs to (${basename(b)}) is NOT the one the titlebar shows (${basename(a)})`,
    ).toContain(basename(b))

    await clickAsk(window, 'Run discovery')
    const toast = window.locator('.fl-flow-toast', { hasText: 'Basic discovery started' })
    await expect(toast).toBeVisible({ timeout: 20000 })
    // "Learning 3 module(s)" is B's module count — the run really did target the
    // project the user is not in; only the count betrays it.
    await expect(toast).toContainText('Learning 3 module(s)')
    expect(
      (await toast.textContent()) ?? '',
      'the "Basic discovery started" toast carries rootId but renders no project chip (buildProjectChip is applied only to blocked-prompt/sticky cards, #1074)',
    ).toContain(basename(b))
  },
)
