/**
 * THE CHAT CARDS RUN THE NEXT STEP (plan `plan_change_review`, Phase 7/8).
 *
 * A card holding a discovery and its plan is about the PLAN before anyone
 * presses a chip: the plan's note pills show, and Execute the plan with a
 * note still unreviewed asks first — how many, and that they are built as
 * written. Cancel builds nothing; Execute anyway sends `/execute-plan @<plan>`
 * into the card's thread exactly once. A card holding only a discovery offers
 * Create the plan, which sends `/create-plan @<discovery>` exactly once.
 *
 * The notes are read by the bundled CLI (`plan notes`) from the seeded plan;
 * nothing reaches an agent — `threads:sendMessage` is answered in MAIN and
 * records what the renderer sent, and `flow:send-prompt` is counted on document.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const DISCOVERY = 'flow/discovery/discovery_coupons_v1.md'
const PLAN = 'flow/plans/plan_coupons_v1.md'
const LONE = 'flow/discovery/discovery_gizmo_v1.md'
const RESULTS = join(__dirname, '..', 'results')

const CART = `export function checkout(total: number, coupon: string | null): number {
  if (coupon !== null) {
    total = total * 0.9
  }
  return total
}
`

/** Two notes: one accepted, one still to review. */
const PLAN_DOC = `# Plan: Coupons

## Phases

### Phase 1: Coupon rates
**Complexity**: 4/10

- [ ] Read the rate from the coupon

#### Change notes

- note: 1 · change · file:src/cart.ts:checkout
    where: \`total = total * 0.9\`
    what: read the discount from the coupon
    why: coupons carry their own rate
    status: accepted
- note: 2 · file · file:src/cart.ts
    what: export the coupon type
    why: callers name it

### Phase 2: Tests (Final)
**Complexity**: 2/10

- [ ] Test it
`

test.afterAll(() => cleanupSeeds())

function seed(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'cart.ts'), CART)
  execFileSync('git', ['-c', 'user.name=Flow E2E', '-c', 'user.email=e2e@example.invalid', 'add', 'src'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=Flow E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'seed'], { cwd: dir })
  mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
  mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(dir, DISCOVERY), '# Discovery: Coupons\n\nCoupons carry their own rate.\n')
  writeFileSync(join(dir, PLAN), PLAN_DOC)
  writeFileSync(join(dir, LONE), '# Discovery: Gizmo\n\nA gizmo nobody has planned yet.\n')
}

async function waitForWorkspaceLink(dir: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(dir, 'flow')).isSymbolicLink() && existsSync(join(dir, PLAN)) && existsSync(join(dir, LONE))
        } catch {
          return false
        }
      },
      { timeout: 300_000 },
    )
    .toBe(true)
}

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

async function spySend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __cardSends?: unknown[] }
    g.__cardSends = []
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', (_event, request) => {
      g.__cardSends?.push(request)
      return { messageId: `card-stub-${g.__cardSends?.length ?? 0}` }
    })
  })
}

async function sent(app: ElectronApplication): Promise<Array<{ threadId: string; content: string }>> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __cardSends?: Array<{ threadId: string; content: string }> }).__cardSends ?? []).map(
      (request) => ({ threadId: request.threadId, content: request.content }),
    ),
  )
}

async function watchPromptEvents(win: Page): Promise<void> {
  await win.evaluate(() => {
    const seen: unknown[] = []
    ;(window as unknown as { __prompts: unknown[] }).__prompts = seen
    document.addEventListener('flow:send-prompt', (event) => seen.push((event as CustomEvent).detail))
  })
}

async function promptTexts(win: Page): Promise<string[]> {
  return win.evaluate(() => (window as unknown as { __prompts: Array<{ text: string }> }).__prompts.map((p) => p.text))
}

async function expectOnScreen(win: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  expect(box, 'element has a box').not.toBeNull()
  const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.w + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.h + 1)
}

test('the plan card executes after a confirm; the discovery card creates the plan — each one message', async ({ app, window: page }) => {
  test.setTimeout(480_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  mkdirSync(RESULTS, { recursive: true })

  const root = await seedProject(page, 'flow-ux-card-next-', seed)
  await activateProject(page, root)
  await waitForWorkspaceLink(root)
  await spySend(app)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: root, title: 'Next step thread' })
  const append = (role: string, content: string): Promise<unknown> => api(page, 'messages.append', { threadId: thread.id, role, content })
  await append('user', 'discover and plan coupons')
  await append('system', `[artifact] discovery ${DISCOVERY}`)
  await append('system', `[artifact] plan ${PLAN}`)
  await append('user', 'and a gizmo')
  await append('system', `[artifact] discovery ${LONE}`)
  await append('user', 'done')

  await page.getByText('Next step thread', { exact: true }).first().click()
  await expect(page.locator(sel.conversation)).toBeVisible()
  await expect(page.getByText('done', { exact: true })).toBeVisible()
  // POSITIVE FIRST (allowed-pattern #28): the thread is live with its composer.
  await expect(page.locator(sel.composer)).toBeVisible()
  await watchPromptEvents(page)

  const planCard = page.locator(`.fl-artifact-card[data-doc-path="${PLAN}"]`)
  const discoveryCard = page.locator(`.fl-artifact-card[data-doc-path="${DISCOVERY}"]`)
  const lone = page.locator(`.fl-artifact-card[data-doc-path="${LONE}"]`)
  await expect(planCard).toHaveCount(1, { timeout: 30_000 })
  await expect(lone).toHaveCount(1, { timeout: 30_000 })

  // ── THE PLAN HAS ITS OWN CARD; THE DISCOVERY'S IS UNCHANGED ─────────────────
  await expect(planCard.locator('.fl-artifact-eyebrow')).toHaveText('PLAN')
  await expect(discoveryCard).toHaveCount(1)
  await expect(discoveryCard.locator('.fl-artifact-eyebrow')).toHaveText('DISCOVERY')
  await expect(discoveryCard.locator('.fl-artifact-doc')).toHaveCount(0)
  // Its plan is written, so the discovery's card no longer offers to create it.
  await expect(discoveryCard.locator('.fl-artifact-title')).toHaveText('Discovery: Coupons')
  await expect(discoveryCard.getByRole('button', { name: 'Create the plan' })).toHaveCount(0)
  await expect(planCard.locator('.fl-artifact-pill')).toHaveCount(0)
  await expect(planCard.getByRole('button', { name: 'Review the change' })).toBeVisible()
  // The plan exists, so this card no longer offers to create it.
  await expect(planCard.getByRole('button', { name: 'Create the plan' })).toHaveCount(0)
  const execute = planCard.getByRole('button', { name: 'Execute the plan' })
  await expect(execute).toBeVisible()
  await expectOnScreen(page, execute)

  // ── EXECUTE WITH A NOTE UNREVIEWED ASKS FIRST ────────────────────────────
  await execute.click()
  const confirm = planCard.locator('.fl-artifact-confirm')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText('1 note has not been reviewed. It is built as written.')
  await expect(confirm.getByRole('button', { name: 'Execute anyway' })).toBeVisible()
  await expect(confirm.getByRole('button', { name: 'Review first' })).toBeVisible()
  await expect(execute).toBeDisabled()
  await page.mouse.move(2, 2)
  await planCard.screenshot({ path: join(RESULTS, 'chat-card-plan-confirm.png') })

  // Cancel: the box goes, nothing is sent.
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(planCard.locator('.fl-artifact-confirm')).toHaveCount(0)
  await expect(planCard.locator('.fl-artifact-run')).toBeHidden()
  await expect(execute).toBeEnabled()
  await page.waitForTimeout(1_000)
  expect(await promptTexts(page)).toEqual([])
  expect(await sent(app)).toEqual([])

  // Execute anyway: ONE message, into this thread.
  await execute.click()
  await planCard.locator('.fl-artifact-confirm').getByRole('button', { name: 'Execute anyway' }).click()
  const executeCommand = `/execute-plan @${PLAN}`
  await expect.poll(() => sent(app), { timeout: 10_000 }).toEqual([{ threadId: thread.id, content: executeCommand }])
  await expect(page.locator('.fl-conv-feed').getByText(executeCommand, { exact: true })).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1_500)
  expect(await promptTexts(page)).toEqual([executeCommand])
  expect(await sent(app)).toHaveLength(1)
  await page.mouse.move(2, 2)
  await planCard.screenshot({ path: join(RESULTS, 'chat-card-plan-executing.png') })

  // ── A DISCOVERY ALONE OFFERS CREATE THE PLAN ─────────────────────────────
  await expect(lone.locator('.fl-artifact-eyebrow')).toHaveText('DISCOVERY')
  await expect(lone.locator('.fl-artifact-pill')).toHaveCount(0)
  await expect(lone.getByRole('button', { name: 'Execute the plan' })).toHaveCount(0)
  const create = lone.getByRole('button', { name: 'Create the plan' })
  await expect(create).toBeVisible()
  await lone.scrollIntoViewIfNeeded()
  await expectOnScreen(page, create)
  await page.mouse.move(2, 2)
  await lone.screenshot({ path: join(RESULTS, 'chat-card-discovery.png') })
  await create.click()
  const createCommand = `/create-plan @${LONE}`
  await expect.poll(() => sent(app), { timeout: 10_000 }).toHaveLength(2)
  expect((await sent(app))[1]).toEqual({ threadId: thread.id, content: createCommand })
  // Sent once: the button now says so and cannot send again.
  await expect(create).toBeDisabled()
  await create.click({ force: true }).catch(() => undefined)
  await page.waitForTimeout(1_500)
  expect(await promptTexts(page)).toEqual([executeCommand, createCommand])
  expect(await sent(app)).toHaveLength(2)

  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
