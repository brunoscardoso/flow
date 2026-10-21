import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * EVERY VERSION OF A DISCOVERY KEEPS ITS OWN CARD (user report 2026-10-01).
 *
 * A conversation that generated a discovery eight times showed ONE card — the
 * first — and seven bare "Created: …_v8.md" lines, because every later version
 * was folded into (or adopted by) the first card. The user wants each version
 * where it was written, so any two can be opened and compared.
 *
 * The rule under test: each discovery version is its own card at its own
 * transcript position; a plan has a card of its own at its own position (user,
 * 2026-10-08 — nothing folds); each version's feature view opens as its own tab.
 *
 * The marker rows are seeded directly — the rows main persists when it observes
 * each doc — because the chokidar watcher is unreliable for a seeded macOS temp
 * project (see artifact-card-inline-position.spec.ts for the live path).
 */

const SLUG = 'widget'
const V1 = `flow/discovery/discovery_${SLUG}_v1.md`
const V2 = `flow/discovery/discovery_${SLUG}_v2.md`
const PLAN = `flow/plans/plan_${SLUG}_v1.md`

test.afterAll(() => cleanupSeeds())

async function api<T>(win: Page, fn: string, arg: unknown): Promise<T> {
  return win.evaluate(
    async ({ fn, arg }) => {
      const flow = (window as unknown as { flow: Record<string, Record<string, (i: unknown) => Promise<unknown>>> }).flow
      const [ns, method] = fn.split('.')
      return (await flow[ns]![method]!(arg)) as unknown
    },
    { fn, arg },
  ) as Promise<T>
}

function page(title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`
}

test('each discovery version is its own card at its own position; a plan joins the newest one', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const root = await seedProject(window, 'flow-ux-doc-versions-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
    mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
    writeFileSync(join(dir, V1), '# Widget discovery one\n\nFirst pass.\n')
    writeFileSync(join(dir, V1.replace(/\.md$/, '.walkthrough.html')), page('Widget page one'))
    writeFileSync(join(dir, V2), '# Widget discovery two\n\nSecond pass.\n')
    writeFileSync(join(dir, V2.replace(/\.md$/, '.walkthrough.html')), page('Widget page two'))
    writeFileSync(join(dir, PLAN), '# Widget plan\n\nBuild it.\n')
  })
  await activateProject(window, root)

  const thread = await api<{ id: string }>(window, 'threads.create', { projectRoot: root, title: 'Versions thread' })
  const append = (role: string, content: string): Promise<unknown> =>
    api(window, 'messages.append', { threadId: thread.id, role, content })
  await append('user', 'write the discovery')
  await append('system', `[artifact] discovery ${V1}`)
  await append('user', 'not quite, try again')
  await append('system', `[artifact] discovery ${V2}`)
  await append('user', 'now plan it')
  await append('system', `[artifact] plan ${PLAN}`)
  await append('user', 'thanks')

  await window.getByText('Versions thread', { exact: true }).first().click()
  await expect(window.locator(sel.conversation)).toBeVisible()
  await expect(window.getByText('thanks', { exact: true })).toBeVisible()

  const cards = window.locator('.fl-artifact-card')
  const v1Card = window.locator(`.fl-artifact-card[data-doc-path="${V1}"]`)
  const v2Card = window.locator(`.fl-artifact-card[data-doc-path="${V2}"]`)

  // THREE cards — one per discovery version and one for the plan.
  await expect(cards).toHaveCount(3)
  await expect(v1Card.locator('.fl-artifact-title')).toHaveText('Widget discovery one', { timeout: 10_000 })
  await expect(v2Card.locator('.fl-artifact-title')).toHaveText('Widget discovery two', { timeout: 10_000 })
  await expect(v1Card.locator('.fl-artifact-sub')).toContainText(`${SLUG} · v1`)
  await expect(v2Card.locator('.fl-artifact-sub')).toContainText(`${SLUG} · v2`)

  // EACH AT ITS OWN POSITION in the transcript.
  const shape = await window.evaluate(() =>
    Array.from(document.querySelectorAll('.fl-conv-feed > .fl-conv-entry')).flatMap((entry) => {
      const card = entry.querySelector<HTMLElement>('.fl-artifact-card')
      if (card) return [`card:${card.dataset.docPath ?? ''}`]
      const text = entry.textContent ?? ''
      const said = ['write the discovery', 'not quite, try again', 'now plan it', 'thanks'].find((line) => text.includes(line))
      return said === undefined ? [] : [`user:${said}`]
    }),
  )
  expect(shape).toEqual([
    'user:write the discovery',
    `card:${V1}`,
    'user:not quite, try again',
    `card:${V2}`,
    'user:now plan it',
    `card:${PLAN}`,
    'user:thanks',
  ])

  // THE PLAN IS ITS OWN CARD. Positive first (allowed-pattern #28): it is
  // there, a PLAN…
  await expect(window.locator(`.fl-artifact-card[data-doc-path="${PLAN}"] .fl-artifact-eyebrow`)).toHaveText('PLAN')
  // …and both discovery cards are untouched by it.
  await expect(v2Card.locator('.fl-artifact-eyebrow')).toHaveText('DISCOVERY')
  await expect(v1Card.locator('.fl-artifact-eyebrow')).toHaveText('DISCOVERY')
  await expect(v2Card.locator('.fl-artifact-doc')).toHaveCount(0)

  // BOTH FEATURE VIEWS OPEN, as two tabs side by side.
  const tabs = window.locator('.fl-editor-tabs .tab')
  await v1Card.getByRole('button', { name: 'Open artifact' }).click()
  await expect(tabs.filter({ hasText: `${SLUG} v1` })).toHaveCount(1, { timeout: 10_000 })
  await v2Card.getByRole('button', { name: 'Open artifact' }).click()
  await expect(tabs.filter({ hasText: `${SLUG} v2` })).toHaveCount(1, { timeout: 10_000 })
  // Positive above, then the absence: v2 did not repurpose v1's tab.
  await expect(tabs.filter({ hasText: `${SLUG} v1` })).toHaveCount(1)
  await expect(window.locator('.fl-feature-view')).toHaveCount(2)

  // Each card opens ITS version's document.
  await window.evaluate(() => {
    const seen: unknown[] = []
    ;(window as unknown as { __docOpens: unknown[] }).__docOpens = seen
    document.addEventListener('flow:open-file-path', (event) => seen.push((event as CustomEvent).detail))
  })
  await v1Card.locator('.fl-artifact-title').click()
  const opens = await window.evaluate(() => (window as unknown as { __docOpens: Array<{ path?: string }> }).__docOpens)
  expect(opens.map((detail) => detail.path)).toEqual([V1])

  await window.screenshot({ path: 'e2e/ux/__screens/discovery-versions.png' })
  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})


/**
 * A v2 DISCOVERY KEEPS ITS "Create the plan" BUTTON while the only plan in the
 * thread was written from v1.
 *
 * `deriveFeatureName` strips `_vN`, so `plan_widget_v1.md` and
 * `discovery_widget_v2.md` both derive `widget`. The suppressor compared those
 * stripped names, so the v1 plan answered for a v2 discovery nobody had planned
 * and the button was gone — the only way forward was to type the command by
 * hand. The row now asks the DOCUMENT's question (`planWrittenFromDocument`):
 * same feature AND a plan version not older than the discovery's.
 *
 * Fails before the fix: both discovery cards had `create-plan` suppressed, so
 * the v2 card below carried Open md file and Open artifact and nothing else.
 */
test('a v2 discovery still offers Create the plan while only a v1 plan exists', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const SLUG2 = 'gizmo'
  const D1 = `flow/discovery/discovery_${SLUG2}_v1.md`
  const D2 = `flow/discovery/discovery_${SLUG2}_v2.md`
  const P1 = `flow/plans/plan_${SLUG2}_v1.md`

  const root = await seedProject(window, 'flow-ux-v2-create-plan-', (dir) => {
    mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
    mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
    writeFileSync(join(dir, D1), '# Gizmo discovery one\n\nFirst pass.\n')
    writeFileSync(join(dir, D2), '# Gizmo discovery two\n\nSecond pass.\n')
    writeFileSync(join(dir, P1), '# Gizmo plan\n\nBuild the first pass.\n')
  })
  await activateProject(window, root)

  const thread = await api<{ id: string }>(window, 'threads.create', { projectRoot: root, title: 'Replan thread' })
  const append = (role: string, content: string): Promise<unknown> =>
    api(window, 'messages.append', { threadId: thread.id, role, content })
  await append('user', 'write the discovery')
  await append('system', `[artifact] discovery ${D1}`)
  await append('user', 'now plan it')
  await append('system', `[artifact] plan ${P1}`)
  await append('user', 'the discovery needs another pass')
  await append('system', `[artifact] discovery ${D2}`)
  await append('user', 'done')

  await window.getByText('Replan thread', { exact: true }).first().click()
  await expect(window.locator(sel.conversation)).toBeVisible()
  await expect(window.getByText('done', { exact: true })).toBeVisible()

  const d1Card = window.locator(`.fl-artifact-card[data-doc-path="${D1}"]`)
  const d2Card = window.locator(`.fl-artifact-card[data-doc-path="${D2}"]`)
  const planCard = window.locator(`.fl-artifact-card[data-doc-path="${P1}"]`)

  // THE ALTERNATIVE WAS REACHABLE (allowed-pattern #28). All three documents
  // have their card, the thread really does hold a v1 plan, and the v1
  // discovery's row really is built — so neither absence below is an absent
  // card or an unbuilt row.
  await expect(window.locator('.fl-artifact-card')).toHaveCount(3)
  await expect(planCard.locator('.fl-artifact-eyebrow')).toHaveText('PLAN')
  await expect(d2Card.locator('.fl-artifact-sub')).toContainText(`${SLUG2} · v2`)
  await expect(d1Card.getByRole('button', { name: 'Open md file' })).toBeVisible()

  // THE FIX: the v2 document has no plan of its own, so it can still be planned.
  const create = d2Card.getByRole('button', { name: 'Create the plan' })
  await expect(create).toBeVisible()
  await expect(create).toBeEnabled()

  // …and the v1 document, which that plan WAS written from, does not offer it.
  await expect(d1Card.getByRole('button', { name: 'Create the plan' })).toHaveCount(0)
  // Nor does the plan card itself (it executes, it does not re-plan).
  await expect(planCard.getByRole('button', { name: 'Execute the plan' })).toBeVisible()
  await expect(planCard.getByRole('button', { name: 'Create the plan' })).toHaveCount(0)

  await window.screenshot({ path: 'e2e/ux/__screens/discovery-v2-create-plan.png' })
  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
