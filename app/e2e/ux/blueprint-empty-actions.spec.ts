import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { callBoard } from '../board-hook'

/**
 * THE EMPTY BOARD MUST OFFER THE GESTURE THAT FIXES IT.
 *
 * Every state below is one the board genuinely reaches, and each is measured
 * for the same three things: does it SAY the right thing, does it OFFER the
 * right thing (or refuse out loud), and can the offer be reached by keyboard.
 *
 * The states, and why each is here:
 *  - a repo with no minable surface → the button, pressable, keyboard-reachable
 *  - pressing it → a running state, visible immediately, that ENDS
 *  - a feature fetch that FAILS → different words and NO button (this failure
 *    used to render identically to an empty store)
 *  - a root that is not ready → the button, disabled, saying what it waits for
 *    (this press used to be a silent no-op)
 *  - a domain nothing carries → guidance only; `domain:` is human-owned and no
 *    gesture can fill it
 *  - a feature with no parts → the ONE understand action (it writes the parts)
 *  - `0` / `Esc` after a dive, with no click first
 *
 * SURFACE (territory board): every empty state is re-hosted inside the sheet as
 * `.fb-terr-empty` — over one hatched ghost province when the whole store is
 * empty, because a map of a country nobody has surveyed should look like one.
 * A domain is GROUND (`.fb-terr-group`, click-through) whose LABEL is the way
 * in; a feature is a cell. Discovery populates the cells IN PLACE, which is why
 * the count is asserted on the same sheet rather than after a reopen.
 */

test.afterAll(() => cleanupSeeds())

const SHOT = '/tmp'

function writeFeature(
  root: string,
  slug: string,
  name: string,
  extra: { kind?: 'core' | 'child'; parent?: string; domain?: string; parts?: string[] } = {},
): void {
  const dir = join(root, 'flow', 'brain', 'features')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${slug}.md`),
    [
      '---',
      `id: feature:${slug}`,
      `name: ${name}`,
      `kind: ${extra.kind ?? 'core'}`,
      ...(extra.parent === undefined ? [] : [`parent: ${extra.parent}`]),
      ...(extra.domain === undefined ? [] : [`domain: ${extra.domain}`]),
      'anchors: []',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${name}`,
      '',
      'Seeded by the empty-actions probe.',
      ...(extra.parts === undefined
        ? []
        : ['', '## Parts', '', ...extra.parts.flatMap((part) => [`### ${part}`, `The ${part}.`, ''])]),
    ].join('\n'),
  )
}

interface EmptyState {
  text: string
  note: string
  buttons: Array<{
    label: string
    title: string
    disabled: boolean
    busy: boolean
    running: boolean
  }>
}

async function readEmpty(win: Page): Promise<EmptyState> {
  return win.evaluate(() => {
    const block = document.querySelector('.fb-terr-empty')
    const buttons = [...(block?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    return {
      text: block?.querySelector('.fb-terr-empty-text')?.textContent ?? '',
      note: block?.querySelector('.fb-terr-empty-note')?.textContent ?? '',
      buttons: buttons.map((b) => ({
        label: b.textContent ?? '',
        title: b.title,
        disabled: b.disabled,
        busy: b.getAttribute('aria-busy') === 'true',
        running: b.classList.contains('fb-brief-draw-running'),
      })),
    }
  })
}

async function openBoard(win: Page, root: string): Promise<void> {
  await activateProject(win, root)
  await win.locator(statusButtonByText('Blueprint')).click()
  await expect(win.locator('.flow-board-root')).toBeVisible()
}

/** The feature fetch spawns the bundled CLI — slow on a cold profile. */
async function waitForEmpty(win: Page): Promise<void> {
  await expect(win.locator('.fb-terr-empty')).toBeVisible({ timeout: 120_000 })
}

/** blueprint:changed's own path — re-reads WITHOUT resetting the focus stack. */
async function reload(win: Page, root: string): Promise<void> {
  await callBoard(win, 'handleChanged', [root])
  await win.waitForTimeout(2500)
}

const depthOf = (win: Page): Promise<number> =>
  win.evaluate(() => document.querySelectorAll('.fb-terr-crumb').length - 1)

test('a repo with nothing minable offers the discovery, and running says so', async ({
  window,
}) => {
  test.setTimeout(300_000)
  // A git repo with ONE unremarkable file: no routes, no e2e/tests/<name>, no
  // features/ dir, no plans. Nothing a surface miner can name twice over.
  const root = await seedProject(window, 'flow-empty-basic-', (dir) => {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'util.ts'), 'export const noop = (): void => undefined\n')
  })
  await openBoard(window, root)
  await waitForEmpty(window)

  const before = await readEmpty(window)
  await window.screenshot({ path: `${SHOT}/empty-root.png` })
  console.log(`[measured] root empty state: ${JSON.stringify(before)}`)
  // THE SENTENCE names what is missing and never sends the reader elsewhere.
  expect(before.text).toContain('No features yet')
  expect(before.text).not.toContain('Settings')
  expect(before.text).not.toContain('planflow-ai')
  // THE BUTTON is the instruction.
  const discovery = before.buttons.find((b) => b.label === 'Run basic discovery')
  expect(
    discovery,
    `no discovery button; buttons were ${JSON.stringify(before.buttons)}`,
  ).toBeDefined()
  expect(discovery?.disabled).toBe(false)
  expect(discovery?.title).toMatch(/minutes/)

  // KEYBOARD REACHABLE — a real <button>, so a tab stop that answers Enter.
  const reachable = await window.evaluate(() => {
    const btn = [...document.querySelectorAll<HTMLButtonElement>('.fb-terr-empty button')].find(
      (b) => b.textContent === 'Run basic discovery',
    )
    if (!btn) return { focused: false, tag: '' }
    btn.focus()
    return { focused: document.activeElement === btn, tag: btn.tagName }
  })
  expect(reachable.tag).toBe('BUTTON')
  expect(reachable.focused).toBe(true)

  // PRESS IT. The running state must be up in the same tick as the dispatch.
  const pressedAt = Date.now()
  await window.keyboard.press('Enter')
  await expect(window.locator('.fb-terr-empty button[aria-busy="true"]')).toBeVisible({
    timeout: 5_000,
  })
  const running = await readEmpty(window)
  await window.screenshot({ path: `${SHOT}/empty-running.png` })
  const spinner = running.buttons.find((b) => b.busy)
  expect(spinner?.label).toBe('Finding features…')
  expect(spinner?.disabled).toBe(true)
  expect(spinner?.running).toBe(true) // the pulsing-dot class, same as "Drawing…"

  // AND IT ENDS. `learn:featuresDiscovered` is raised on every exit of the
  // feature-generation step, including the ones that create nothing — so this
  // settles rather than spinning forever.
  await expect(window.locator('.fb-terr-empty button[aria-busy="true"]')).toHaveCount(0, {
    timeout: 180_000,
  })
  const elapsed = Date.now() - pressedAt
  const after = await readEmpty(window)
  const cellsNow = await window.locator('.fb-terr-cell').count()
  await window.screenshot({ path: `${SHOT}/empty-settled.png` })
  console.log(`[measured] running state visible for ${String(elapsed)}ms`)
  console.log(`[measured] settled: cells=${String(cellsNow)} ${JSON.stringify(after)}`)
  // Either features appeared, or the board SAYS it ran and found nothing. What
  // it must never do is repaint identically and read as a dead button.
  if (cellsNow === 0) expect(after.note).toContain('found no capability')
})

test('a discovery that DOES find features populates the sheet in place', async ({ window }) => {
  test.setTimeout(300_000)
  // Two distinct surface kinds naming ONE capability — a route segment and an
  // `e2e/tests/<name>` suite — which is exactly the CLI's rule for promoting a
  // name to a core feature. Verified against the live CLI before seeding.
  const root = await seedProject(window, 'flow-empty-found-')
  await openBoard(window, root)
  await waitForEmpty(window)
  expect((await readEmpty(window)).text).toContain('No features yet')

  // The surfaces arrive AFTER the board is already empty — which is the case
  // the board's own button exists for. (Provisioning's first derive bootstraps
  // features once, on an empty store; a project that grows a capability later
  // had no way back to feature generation at all, which is the hole
  // `enqueueBasicDiscovery` fills and this control reaches.)
  mkdirSync(join(root, 'src', 'app', 'playbooks'), { recursive: true })
  writeFileSync(join(root, 'src', 'app', 'playbooks', 'page.tsx'), 'export default function P() {}\n')
  mkdirSync(join(root, 'e2e', 'tests', 'playbooks'), { recursive: true })
  writeFileSync(join(root, 'e2e', 'tests', 'playbooks', 'a.spec.ts'), "test('x', () => {})\n")
  mkdirSync(join(root, 'src', 'features', 'playbooks'), { recursive: true })
  writeFileSync(join(root, 'src', 'features', 'playbooks', 'index.ts'), 'export const x = 1\n')

  await window.locator('.fb-terr-empty button', { hasText: 'Run basic discovery' }).click()
  await expect(window.locator('.fb-terr-empty button[aria-busy="true"]')).toBeVisible({
    timeout: 5_000,
  })
  await window.screenshot({ path: `${SHOT}/empty-running-found.png` })

  // POPULATED IN PLACE — no refresh, no reopen, no manual anything.
  await expect(window.locator('.fb-terr-cell')).toHaveCount(1, { timeout: 180_000 })
  await expect(window.locator('.fb-terr-empty')).toHaveCount(0)
  await window.screenshot({ path: `${SHOT}/empty-populated.png` })
  const names = await window.evaluate(() =>
    [...document.querySelectorAll('.fb-terr-cell-name')].map((n) => n.textContent ?? ''),
  )
  console.log(`[measured] sheet after discovery: ${JSON.stringify(names)}`)
})

test('a feature fetch that FAILS says so, and offers no discovery', async ({ window }) => {
  test.setTimeout(180_000)
  // A REAL FAILURE, not a stub. `blueprint features graph --json` refuses when
  // it cannot read the store, and `runFeatures` turns any refusal line into
  // `available: false` + that reason — the same shape a 30-second timeout or a
  // missing bundled CLI produces, and the shape that used to render as
  // "No features yet".
  //
  // BROKEN AFTER THE PROJECT IS PLACED. Adding a project moves its knowledge
  // into its Workspace's folder (the hard migration), which starts from a fresh
  // `brain/features/` — a store broken BEFORE the move is not the store the
  // board reads after it. So the move is waited for, and the store the board
  // will read is the one broken.
  const root = await seedProject(window, 'flow-empty-fail-')
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(root, 'flow')).isSymbolicLink()
        } catch {
          return false
        }
      },
      { timeout: 120_000 },
    )
    .toBe(true)
  const store = join(root, 'flow', 'brain', 'features')
  rmSync(store, { recursive: true, force: true })
  mkdirSync(join(root, 'flow', 'brain'), { recursive: true })
  writeFileSync(store, 'not a directory\n')
  await openBoard(window, root)
  await expect(window.locator('.fb-terr-empty-text')).toContainText('Couldn’t read', {
    timeout: 120_000,
  })

  const state = await readEmpty(window)
  await window.screenshot({ path: `${SHOT}/empty-fetch-failed.png` })
  console.log(`[measured] fetch-failure state: ${JSON.stringify(state)}`)
  // THE DISTINCTION, stated: a failed read is not an empty store.
  expect(state.text).toContain('not the same as having none')
  expect(state.text).not.toContain('No features yet')
  // AND NO BUTTON — pressing discovery here could re-mine a project that is
  // merely unreadable at this instant.
  expect(state.buttons.map((b) => b.label)).toEqual([])
})

test('a root that is not ready shows the button disabled, with the reason', async ({
  window,
}) => {
  test.setTimeout(180_000)
  const root = await seedProject(window, 'flow-empty-notready-')
  await openBoard(window, root)
  await waitForEmpty(window)

  // `enqueueBasicDiscovery` refuses while `provisioningState !== 'ready'` —
  // silently. Drive the board through the same setter the rootsChanged
  // broadcast uses, so the control is decided on the real signal.
  // 'idle' — the assets are not in place. NOT 'provisioning': that state has
  // its own full-pane "Setting up plan-flow…" wait screen (`resolvePane`), so
  // the board is not on show at all and there is no button to disable.
  await callBoard(window, 'setProvisioningState', ['idle'])
  await window.waitForTimeout(1500)
  await waitForEmpty(window)
  const state = await readEmpty(window)
  await window.screenshot({ path: `${SHOT}/empty-not-ready.png` })
  console.log(`[measured] not-ready state: ${JSON.stringify(state)}`)
  const discovery = state.buttons.find((b) => b.label === 'Run basic discovery')
  expect(discovery, 'the button vanished instead of explaining itself').toBeDefined()
  expect(discovery?.disabled, 'a control that would silently no-op is pressable').toBe(true)
  expect(discovery?.title).toMatch(/not set up for plan-flow yet/i)
})

test('a domain nothing carries gets guidance, and a feature with no parts gets learn', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const root = await seedProject(window, 'flow-empty-levels-', (dir) => {
    writeFeature(dir, 'ingest-pipeline', 'Ingest Pipeline', { domain: 'Ingest' })
    writeFeature(dir, 'ghost-holder', 'Ghost Holder', { domain: 'Ghost' })
  })
  await openBoard(window, root)
  await expect(window.locator('.fb-terr-group[data-feature-id="domain:Ghost"]')).toBeVisible({
    timeout: 120_000,
  })

  // ── A FEATURE WITH NO PARTS. Parts come from learning, so that is the offer.
  //
  // It used to be a level of its own (a double-click dove into an empty band
  // offering "Understand this feature"). Since plan cell-hover-diagram (FR-6) a
  // feature with no parts has no level below it: a double-click reads it as a
  // code story, and a press OPENS the cell in place — which is where the offer
  // now lives, in the cell's own words.
  await window
    .locator('.fb-terr-group[data-feature-id="domain:Ingest"] .fb-terr-group-label')
    .click()
  await window.waitForTimeout(900)
  const cell = window.locator('.fb-terr-cell[data-feature-id="feature:ingest-pipeline"]')
  await cell.click()
  await expect(cell).toContainText("hasn't learned this feature yet", { timeout: 30_000 })
  await window.screenshot({ path: `${SHOT}/empty-feature-level.png` })
  const offers = await cell.evaluate((el) =>
    [...el.querySelectorAll('button')].map((b) => ({ label: (b.textContent ?? '').trim(), title: b.title })),
  )
  console.log(`[measured] feature cell: ${JSON.stringify(offers)}`)
  const labels = offers.map((b) => b.label)
  // A whole-project discovery would be answering a question nobody asked here.
  expect(labels).not.toContain('Run basic discovery')
  // ONE named control, not a Learn/Draw pair.
  expect(labels.filter((l) => l === 'Learn this feature')).toHaveLength(1)
  expect(labels).not.toContain('Draw this feature')
  const learn = offers.find((b) => b.label === 'Learn this feature')
  // It says what pressing it does — read the feature — never a silent press.
  expect(learn?.title).toMatch(/Read Ingest Pipeline/)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(600)

  // ── A DOMAIN WITH NO FEATURES. Reached by drilling one and then removing
  // the only feature that carried it — the same state a deleted feature file
  // leaves behind.
  await window.keyboard.press('Escape')
  await window.waitForTimeout(900)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(900)
  await window
    .locator('.fb-terr-group[data-feature-id="domain:Ghost"] .fb-terr-group-label')
    .click()
  await window.waitForTimeout(1200)
  expect(await depthOf(window)).toBe(1)
  rmSync(join(root, 'flow', 'brain', 'features', 'ghost-holder.md'), { force: true })
  await reload(window, root)
  await waitForEmpty(window)
  const domain = await readEmpty(window)
  await window.screenshot({ path: `${SHOT}/empty-domain.png` })
  console.log(`[measured] domain level: ${JSON.stringify(domain)}`)
  expect(domain.text).toContain('no features carry this domain')
  expect(domain.text).toContain('frontmatter')
  // GUIDANCE ONLY. There is no machine gesture that fills a domain.
  expect(domain.buttons.map((b) => b.label)).toEqual([])
})

test('the advertised keys survive a dive — 0 and Esc without clicking first', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const root = await seedProject(window, 'flow-empty-keys-', (dir) => {
    // PARTS, so the feature has a level below it to dive into (a feature
    // with none reads as its code story instead — cell-hover-diagram FR-6).
    writeFeature(dir, 'ingest-pipeline', 'Ingest Pipeline', {
      domain: 'Ingest',
      parts: ['Reader', 'Writer'],
    })
    writeFeature(dir, 'ingest-reader', 'Ingest Reader', {
      kind: 'child',
      parent: 'feature:ingest-pipeline',
    })
    writeFeature(dir, 'billing-engine', 'Billing Engine', { domain: 'Billing' })
  })
  await openBoard(window, root)
  await expect(window.locator('.fb-terr-group[data-feature-id="domain:Ingest"]')).toBeVisible({
    timeout: 120_000,
  })

  // DIVE. The re-render destroys the focused cell; nothing used to hand the
  // keys back, so `0` / `Esc` were dead until the sheet was clicked.
  await window
    .locator('.fb-terr-group[data-feature-id="domain:Ingest"] .fb-terr-group-label')
    .click()
  await window.waitForTimeout(1200)
  expect(await depthOf(window)).toBe(1)
  const holder = await window.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return {
      tag: el?.tagName ?? '',
      cls: el?.getAttribute('class') ?? '',
      inBoard: document.querySelector('.flow-board-root')?.contains(el ?? null) ?? false,
    }
  })
  console.log(`[measured] focus after dive: ${JSON.stringify(holder)}`)
  expect(holder.inBoard, 'the board lost the keyboard after a dive').toBe(true)

  // NO CLICK. Straight to the keys the board advertises. The pointer is moved
  // OFF the sheet first: a cell under a resting pointer shows its details, and
  // Escape rightly closes the thing on top first (`#onEscape`, "a grown cell
  // shrinks first") — this test is about the keyboard, not the hover.
  await window.mouse.move(0, 0)
  await window.waitForTimeout(600)
  await window.keyboard.press('0')
  await window.waitForTimeout(600)
  expect(await depthOf(window), '0 changed depth').toBe(1)
  await window.screenshot({ path: `${SHOT}/empty-keys-after-dive.png` })

  await window.keyboard.press('Escape')
  await window.waitForTimeout(1200)
  expect(await depthOf(window), 'Escape did not drill up without a click first').toBe(0)

  // …and again two levels down.
  await window
    .locator('.fb-terr-group[data-feature-id="domain:Ingest"] .fb-terr-group-label')
    .click()
  await window.waitForTimeout(1200)
  await window.locator('.fb-terr-cell[data-feature-id="feature:ingest-pipeline"]').dblclick()
  await window.waitForTimeout(1500)
  expect(await depthOf(window)).toBe(2)
  await window.mouse.move(0, 0)
  await window.waitForTimeout(600)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(1200)
  expect(await depthOf(window), 'Escape died again at depth 2').toBe(1)
})
