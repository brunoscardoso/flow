/**
 * UX sweep — flow 5 (Review), round 21: what the ✨ commit-message wand is
 * allowed to describe.
 *
 * Filed as #1285.
 *
 * The generator reads the **staged** (index-vs-HEAD) diff — deliberately, so
 * the suggestion describes exactly what the commit will contain and not
 * working-tree edits that won't be (#694, wired at
 * `main/index.ts:1348` → `gitManager.stagedDiff`). Its two callers gate
 * differently:
 *
 *  - **Changes** (git panel): `generate.disabled = stagedCount === 0`
 *    (`git-panel.ts:919`) — the wand is offered only when there IS staged
 *    content to describe.
 *  - **Phases** (review panel, added by #1141):
 *    `generate.disabled = filePaths.length === 0` (`review-panel.ts:411`) —
 *    offered as soon as the group lists a file, approved (staged) or not.
 *
 * With nothing approved, every file's staged diff is empty, so
 * `summarizeDiff` sends `(no textual change)` for each one
 * (`commit-message.ts:11`) and the model writes a message from the file NAMES
 * alone. Observed live (a `src/logger.ts` whose uncommitted content is a full
 * Stripe charge helper): `chore(logger): touch file with no functional
 * changes` — which then commits verbatim.
 *
 * FIXED (#1285) by giving the Phases wand the sibling's gate — it is offered
 * only once the group has APPROVED (⇒ staged) content, and it is passed only
 * those files. Belt and braces, `generateCommitMessage` now refuses outright
 * when every file's staged diff is `(no textual change)`: a guess about
 * content nobody showed the model is worse than no suggestion. Both guards
 * below are live.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCREENS = 'e2e/ux/__screens'

/** Baseline holds a logger; the uncommitted change is a payments client, so a
 *  content-aware message and a filename-only guess are trivially distinct. */
const BASE = "export function logDebug(message: string): void {\n  console.log('[debug]', message)\n}\n"
const CHANGED = `import Stripe from 'stripe'

/** Charges a customer's card through Stripe and emails the receipt. */
export async function chargeCustomerCard(customerId: string, amountCents: number) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '')
  const charge = await stripe.charges.create({ customer: customerId, amount: amountCents, currency: 'usd' })
  await sendReceiptEmail(customerId, charge.id)
  return charge
}
`

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

async function seedRepo(win: Page, prefix: string): Promise<string> {
  const dir = await seedProject(win, prefix, (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'Flow QA')
    mkdirSync(join(d, 'src'), { recursive: true })
    writeFileSync(join(d, 'src', 'logger.ts'), BASE)
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'baseline')
    writeFileSync(join(d, 'src', 'logger.ts'), CHANGED)
  })
  await activateProject(win, dir)
  return dir
}

/** Reach a Source Control view. The rail item TOGGLES the sidebar, so clicking
 *  it again when the panel is already up would collapse it — click it only when
 *  the segmented control isn't showing. */
async function openSourceControl(win: Page, view: 'Changes' | 'Phases'): Promise<void> {
  const viewBtn = win.locator(sel.scViewBtn).filter({ hasText: view })
  if ((await viewBtn.count()) === 0 || !(await viewBtn.first().isVisible())) {
    await win.locator('[data-rail-item="source-control"]').click()
  }
  await viewBtn.first().click()
}

const reviewWand = (win: Page) => win.locator('.fl-review-generate')
const changesWand = (win: Page) => win.locator('.gp-commit-generate')

/** Approve every file in the group (mirrors into the index, #857) and settle on
 *  the armed state — the app's own git activity can transiently reject a stage. */
async function approveAll(win: Page): Promise<void> {
  const commitBtn = win.locator('.fl-review-commit-btn')
  await expect(async () => {
    if (/Approve all/.test(await commitBtn.innerText())) await commitBtn.click()
    await expect(commitBtn).toContainText('Commit phase')
  }).toPass({ timeout: 30_000 })
}

test.afterAll(() => cleanupSeeds())

test('CONTROL: the sibling "Changes" wand is offered only once something is staged', async ({
  window,
}) => {
  test.setTimeout(150_000) // seeds + provisions a repo before the panels paint
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(String(error)))

  await seedRepo(window, 'flow-ux-wand-ctrl-')
  await openSourceControl(window, 'Changes')
  await expect(changesWand(window)).toBeAttached()

  // Nothing staged → the generator has no content to describe, so it is gated.
  await expect(changesWand(window)).toBeDisabled()

  // Stage the file through the Phases ✓ (approve ↔ stage, #857) and come back:
  // the same wand is now enabled — the gate is state-driven, not a constant.
  await openSourceControl(window, 'Phases')
  await expect(window.locator('.fl-review-file')).toHaveCount(1)
  await approveAll(window)
  await openSourceControl(window, 'Changes')
  await expect(changesWand(window)).toBeEnabled({ timeout: 15_000 })

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test(
  'the "Phases" wand must not be offered while the staged diff it reads is empty',
  async ({ window }) => {
    test.setTimeout(150_000) // seeds + provisions a repo before the panels paint
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(String(error)))

    await seedRepo(window, 'flow-ux-wand-')
    await openSourceControl(window, 'Phases')
    await expect(window.locator('.fl-review-file-name')).toHaveText(/logger\.ts/)
    await expect(window.locator('.fl-review-commit-btn')).toContainText('Approve all (0/1)')
    await window.screenshot({ path: `${SCREENS}/review-wand-unapproved.png` })

    // Nothing is approved, so `stagedDiff` reports "(no textual change)" for
    // every file: any message generated now is written from the path alone.
    await expect(
      reviewWand(window),
      'the ✨ is offered over a group with nothing approved — its only input, the staged diff, is empty, so it invents a message (observed: "chore(logger): touch file with no functional changes" over a full rewrite)',
    ).toBeDisabled()

    // …and once the content IS staged, the wand must be offered — the gate is
    // about having something to describe, not about disabling the feature.
    await approveAll(window)
    await expect(reviewWand(window)).toBeEnabled({ timeout: 15_000 })

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
