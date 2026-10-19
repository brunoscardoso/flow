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
