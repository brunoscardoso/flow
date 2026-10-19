/**
 * REVIEW THE CHANGE (plan `plan_change_review`, Phase 8) — a plan's change
 * notes reviewed in the code story, end to end.
 *
 * Real everywhere it can be: a seeded git repo with a committed TS file, a
 * discovery and a plan carrying three change notes (a change quoting real
 * code, a new function with a caller, a file note), the PLAN card's own
 * "Review the change" press, the bundled CLI reading the notes (`plan notes`),
 * drawing the story (`blueprint storyline --plan`) and writing each decision
 * (`plan note`) into the plan file on disk.
 *
 * Nothing reaches an agent: `threads:sendMessage` is answered in MAIN (the
 * contextBridge object cannot be stubbed from the page) and records what the
 * renderer sent; `flow:send-prompt` is counted on document as well.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const SLUG = 'coupons'
const DISCOVERY = `flow/discovery/discovery_${SLUG}_v1.md`
const PLAN = `flow/plans/plan_${SLUG}_v1.md`
const RESULTS = join(__dirname, '..', 'results')

const CART = `import { formatPrice } from './money'

export function checkout(total: number, coupon: string | null): string {
  if (coupon !== null) {
    total = total * 0.9
  }
  return formatPrice(total)
}
`

const MONEY = `export function formatPrice(total: number): string {
  return '$' + total.toFixed(2)
}
`

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
- note: 2 · new · file:src/cart.ts:discountOf
    signature: discountOf(coupon: string): number
    purpose: the rate a coupon gives
    callers: checkout
- note: 3 · file · file:src/money.ts
    what: export a rounding helper
    why: refunds and checkouts round alike

### Phase 2: Tests (Final)
**Complexity**: 2/10

- [ ] Test it
`

test.afterAll(() => cleanupSeeds())

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Flow E2E', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: dir })
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'cart.ts'), CART)
  writeFileSync(join(dir, 'src', 'money.ts'), MONEY)
  git(dir, ['add', 'src'])
  git(dir, ['commit', '-q', '-m', 'seed'])
  // The documents ride the Workspace import (`link --import`) into the project's knowledge.
  mkdirSync(join(dir, 'flow', 'discovery'), { recursive: true })
  mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(dir, DISCOVERY), '# Discovery: Coupons\n\nCoupons carry their own rate.\n')
  writeFileSync(join(dir, PLAN), PLAN_DOC)
}

/** The project's `flow` is a Workspace link and the plan is readable through it. */
async function waitForWorkspaceLink(dir: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(dir, 'flow')).isSymbolicLink() && existsSync(join(dir, PLAN))
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

/** Answer `threads:sendMessage` in main, recording every request — nothing reaches an agent. */
async function spySend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __reviewSends?: unknown[] }
    g.__reviewSends = []
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', (_event, request) => {
      g.__reviewSends?.push(request)
      return { messageId: `review-stub-${g.__reviewSends?.length ?? 0}` }
    })
  })
}

async function sent(app: ElectronApplication): Promise<Array<{ threadId: string; content: string }>> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __reviewSends?: Array<{ threadId: string; content: string }> }).__reviewSends ?? []).map(
      (request) => ({ threadId: request.threadId, content: request.content }),
    ),
  )
}

/** Count `flow:send-prompt` events on document. */
async function watchPromptEvents(win: Page): Promise<void> {
  await win.evaluate(() => {
    const seen: unknown[] = []
    ;(window as unknown as { __prompts: unknown[] }).__prompts = seen
    document.addEventListener('flow:send-prompt', (event) => seen.push((event as CustomEvent).detail))
  })
}

async function promptEvents(win: Page): Promise<Array<{ threadId: string; text: string }>> {
  return win.evaluate(() => (window as unknown as { __prompts: Array<{ threadId: string; text: string }> }).__prompts)
}

/** The lines of one note's block in the plan file on disk. */
function noteBlockOnDisk(root: string, n: number): string {
  const text = readFileSync(join(root, PLAN), 'utf-8')
  const start = text.indexOf(`- note: ${String(n)} ·`)
  if (start < 0) return ''
  const rest = text.slice(start + 1)
  const next = rest.search(/\n- note: |\n### /)
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next)
}

/** The element's box lies inside the window (toBeVisible passes off screen). */
async function expectOnScreen(win: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  expect(box, 'element has a box').not.toBeNull()
  const size = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(size.w + 1)
  expect(box!.y + box!.height).toBeLessThanOrEqual(size.h + 1)
}

test('Review the change: Proposal draws the notes, decisions land in the plan file, the review is sent once', async ({ app, window: page }) => {
  test.setTimeout(480_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  mkdirSync(RESULTS, { recursive: true })

  const root = await seedProject(page, 'flow-ux-plan-review-', seed)
  await activateProject(page, root)
  await waitForWorkspaceLink(root)
  await spySend(app)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: root, title: 'Coupon thread' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'plan the coupons' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'system', content: `[artifact] discovery ${DISCOVERY}` })
  await api(page, 'messages.append', { threadId: thread.id, role: 'system', content: `[artifact] plan ${PLAN}` })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'ready' })

  await page.getByText('Coupon thread', { exact: true }).first().click()
  await expect(page.locator(sel.conversation)).toBeVisible()
  await expect(page.getByText('ready', { exact: true })).toBeVisible()
  // POSITIVE FIRST (allowed-pattern #28): the thread is live and its composer is here,
  // so "nothing was sent" later means nothing was sent, not that nothing could be.
  await expect(page.locator(sel.composer)).toBeVisible()
  await watchPromptEvents(page)

  const card = page.locator(`.fl-artifact-card[data-doc-path="${PLAN}"]`)
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  // The card's notes are read: three to review.
  await expect(card.locator('.fl-artifact-pill')).toHaveCount(0)
  const review = card.getByRole('button', { name: 'Review the change' })
  await expect(review).toBeVisible()
  await review.click()

  // ── PROPOSAL ───────────────────────────────────────────────────────────────
  const board = page.locator('.flow-board-root')
  await expect(board).toBeVisible({ timeout: 30_000 })
  await expect(board.locator('.fb-nr-modes [data-review-mode="proposal"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 })
  await expect(board.locator('.fb-nr-plan-chip')).toHaveText(`Reviewing ${SLUG}`)

  // The change note's box: "Proposed change", the quoted line highlighted — and only it.
  const changed = board.locator('.fb-nr-box', { has: page.locator('.fb-note[data-note="1"]') })
  await expect(changed).toHaveCount(1, { timeout: 60_000 })
  await expect(changed.locator('.fb-nr-badge')).toHaveText(/proposed change/i)
  await expect(changed.locator('.fb-nr-hit')).toHaveCount(1)
  await expect(changed.locator('.fb-nr-hit')).toContainText('total = total * 0.9')
  await expect(changed.locator('.fb-nr-hit')).toHaveAttribute('data-line', '5')
  // The new function: a dashed planned box, its signature and its caller.
  const added = board.locator('.fb-nr-box.fb-nr-box-new', { has: page.locator('.fb-note[data-note="2"]') })
  await expect(added).toHaveCount(1)
  await expect(added.locator('.fb-story-bname')).toHaveText('discountOf')
  await expect(added).toContainText('discountOf(coupon: string): number')
  await expect(added).toContainText('checkout')
  const addedStyle = await added.evaluate((el) => getComputedStyle(el).borderStyle)
  expect(addedStyle).toContain('dashed')
  // The file note is on the sheet too.
  await expect(board.locator('.fb-note[data-note="3"]')).toHaveCount(1)
  // The strip names every note.
  await expect(board.locator('.fb-nr-pill')).toHaveCount(3)

  const accept1 = changed.locator('.fb-note[data-note="1"] .fb-note-accept').first()
  await expect(accept1).toBeVisible()
  await expectOnScreen(page, accept1)
  await page.mouse.move(2, 2)
  await page.screenshot({ path: join(RESULTS, 'plan-change-review-proposal.png') })

  const send = board.locator('.fb-nr-send')
  await expect(send).toBeVisible()
  await expect(send).toBeDisabled()

  // ── ACCEPT writes the plan file at once ───────────────────────────────────
  await accept1.click()
  await expect.poll(() => noteBlockOnDisk(root, 1), { timeout: 30_000 }).toContain('status: accepted')
  await expect(board.locator('.fb-note[data-note="1"] .fb-note-status')).toHaveText(/accepted/i, { timeout: 30_000 })
  await expect(send).toBeDisabled()

  // ── REJECT with a reason ──────────────────────────────────────────────────
  const note2 = board.locator('.fb-note[data-note="2"]')
  await note2.locator('.fb-note-acts .fb-note-reject').click()
  const reason = note2.locator('.fb-note-reason input')
  await expect(reason).toBeVisible()
  await reason.fill('inline the rate')
  await note2.locator('.fb-note-reason .fb-note-reject').click()
  await expect.poll(() => noteBlockOnDisk(root, 2), { timeout: 30_000 }).toContain('status: rejected — inline the rate')
  await expect(send).toBeDisabled()

  // ── ADD TO CONTEXT: a line in the review, nothing sent ───────────────────
  const note3 = board.locator('.fb-note[data-note="3"]')
  const before3 = noteBlockOnDisk(root, 3)
  await note3.locator('.fb-note-comment-btn').click()
  await note3.locator('.fb-note-textarea').fill('name the helper roundCents')
  await note3.locator('.fb-note-add').click()
  await expect(note3.locator('.fb-note-context')).toBeVisible()
  await expect(note3.locator('.fb-note-context')).toContainText('In context:')
  await expect(note3.locator('.fb-note-context')).toContainText('name the helper roundCents')
  await page.waitForTimeout(1_500)
  // The composer is still mounted for this thread (the positive) — and nothing went to it.
  await expect(page.locator(sel.composer)).toHaveCount(1)
  expect(await promptEvents(page)).toEqual([])
  expect(await sent(app)).toEqual([])
  // A comment is context, never a write to the plan.
  expect(noteBlockOnDisk(root, 3)).toBe(before3)
  // Still one unreviewed note: Send waits.
  await expect(send).toBeDisabled()

  // ── THE LAST DECISION enables Send review; one press, ONE message ────────
  await note3.locator('.fb-note-acts .fb-note-accept').click()
  await expect.poll(() => noteBlockOnDisk(root, 3), { timeout: 30_000 }).toContain('status: accepted')
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await expectOnScreen(page, send)
  await page.mouse.move(2, 2)
  await board.locator('.fb-nr-bar').screenshot({ path: join(RESULTS, 'plan-change-review-bar.png') })

  await send.click()
  await expect.poll(() => promptEvents(page), { timeout: 10_000 }).toHaveLength(1)
  const [prompt] = await promptEvents(page)
  expect(prompt!.threadId).toBe(thread.id)
  expect(prompt!.text).toContain('name the helper roundCents')
  expect(prompt!.text).toContain('inline the rate')
  // The composer's own send carried it to main — once.
  await expect.poll(() => sent(app), { timeout: 10_000 }).toHaveLength(1)
  await page.waitForTimeout(2_000)
  expect(await promptEvents(page)).toHaveLength(1)
  const messages = await sent(app)
  expect(messages).toHaveLength(1)
  expect(messages[0]!.threadId).toBe(thread.id)
  expect(messages[0]!.content).toBe(prompt!.text)
  // No command, path or config key in the message (forbidden-pattern #12).
  expect(messages[0]!.content).not.toMatch(/planflow-ai|flow\/plans|\.md\b/)
  await expect(board.locator('.fb-nr-sum')).toContainText('Review sent', { timeout: 10_000 })

  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
