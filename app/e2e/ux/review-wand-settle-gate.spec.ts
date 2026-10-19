/**
 * UX sweep — flow 5 (Review), round 23: what the ✨ commit-message generation's
 * COMPLETION is allowed to tear down.
 *
 * `ReviewPanel` has exactly one re-render path that does not go through the
 * #182 refresh gate, and one piece of state a project switch does not clear.
 * Both live in `#settleGeneration` (`review-panel.ts:155`), the ~10-13s-later
 * continuation of a ✨ click:
 *
 *   #settleGeneration(label, seq, message) {
 *     …
 *     this.#render()          // ← unconditional; markRendered() lowers the gate
 *   }
 *
 * Every OTHER writer defers: `setGroups` and `setInvariantFlags` both go through
 * `#refreshGate.receive(...)`, which is what keeps a background file-change
 * refresh from wiping an open reject prompt (#182) or an armed "Discard N"
 * confirm. `reset()` — the project-switch teardown that stops one project's
 * commit message from being committed in another (#281) — clears `#drafts` and
 * `#approved` but not `#generating`, so a generation started in project A
 * survives the switch and writes through into project B's same-labelled group.
 *
 * Filed as #1379 (prompt teardown) and #1380 (cross-project message leak).
 *
 * Measured live on main (built app, real repos, real generation):
 *   - reject prompt open with `please keep the original logger signature` typed
 *     → generation settles at t+13.4s → `prompt=0 feedback=null`, the commit box
 *     now holding `feat: add retry/timeout config and Stripe charge helper`.
 *   - armed `Discard 2` confirm → settles → confirm gone, and
 *     `elementFromPoint` at the red button's own centre returns
 *     `.fl-review-commit-btn`.
 *   - project ONE (logger.ts + config.ts) ✨ → switch to project TWO
 *     (invoice.ts only) → t+10s, TWO's commit box reads
 *     `feat(payments): add Stripe charge helper and tune retry/timeout config`.
 *
 * The two LIVE controls below are credential-free and green on main: they prove
 * the gate IS armed for the path it was built for, and that #281's reset DOES
 * still clear a typed draft — so neither tripwire can pass vacuously. The two
 * tripwires need a real generation (the agent's one-shot generate), so they are
 * `test.fixme` here; both were un-fixme'd and confirmed genuinely RED before
 * being restored.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, gitRetry } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SCREENS = 'e2e/ux/__screens'

/** Project ONE: a logger rewritten into a Stripe charge helper + a config tweak.
 *  Deliberately vivid, so a message generated from it is unmistakable if it
 *  turns up over another project's changes. */
const BASE_LOGGER = "export function logDebug(m: string): void {\n  console.log('[debug]', m)\n}\n"
const CHANGED_LOGGER = `import Stripe from 'stripe'

/** Charges a customer's card through Stripe and emails the receipt. */
export async function chargeCustomerCard(customerId: string, amountCents: number) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '')
  const charge = await stripe.charges.create({ customer: customerId, amount: amountCents, currency: 'usd' })
  await sendReceiptEmail(customerId, charge.id)
  return charge
}
`
const BASE_CONFIG = 'export const RETRIES = 3\n'
const CHANGED_CONFIG = 'export const RETRIES = 9\nexport const TIMEOUT_MS = 30000\n'

/** Project TWO: an unrelated domain (invoice rendering). */
const BASE_INVOICE = 'export const GREETING = "hi"\n'
const CHANGED_INVOICE =
  'export function renderInvoicePdf(invoiceId: string): Buffer {\n  return Buffer.from(invoiceId)\n}\n'

const FEEDBACK = 'please keep the original logger signature'

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** A repo with two uncommitted tracked changes (project ONE). */
async function seedOne(win: Page, prefix: string): Promise<string> {
  return seedProject(win, prefix, (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'Flow QA')
    mkdirSync(join(d, 'src'), { recursive: true })
    writeFileSync(join(d, 'src', 'logger.ts'), BASE_LOGGER)
    writeFileSync(join(d, 'src', 'config.ts'), BASE_CONFIG)
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'baseline')
    writeFileSync(join(d, 'src', 'logger.ts'), CHANGED_LOGGER)
    writeFileSync(join(d, 'src', 'config.ts'), CHANGED_CONFIG)
  })
}

/** A second repo with one unrelated uncommitted change (project TWO). */
async function seedTwo(win: Page, prefix: string): Promise<string> {
  return seedProject(win, prefix, (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'Flow QA')
    mkdirSync(join(d, 'src'), { recursive: true })
    writeFileSync(join(d, 'src', 'invoice.ts'), BASE_INVOICE)
    git(d, 'add', '-A')
    git(d, 'commit', '-q', '-m', 'baseline two')
    writeFileSync(join(d, 'src', 'invoice.ts'), CHANGED_INVOICE)
  })
}

/** Reach the Phases review view. The rail item TOGGLES the sidebar, so click it
 *  only when the segmented control isn't already showing. */
async function openPhases(win: Page): Promise<void> {
  const viewBtn = win.locator(sel.scViewBtn).filter({ hasText: 'Phases' })
  if ((await viewBtn.count()) === 0 || !(await viewBtn.first().isVisible())) {
    await win.locator('[data-rail-item="source-control"]').click()
  }
  await viewBtn.first().click()
}

/** The group's commit-message box. Scoped to the commit row on purpose: an open
 *  reject prompt reuses `.fl-review-message` for its feedback input and, sitting
 *  in a file row, matches FIRST. */
const commitMessage = (win: Page) => win.locator('.fl-review-commit .fl-review-message')
const wand = (win: Page) => win.locator('.fl-review-generate')
const rejectPrompt = (win: Page) => win.locator('.fl-review-reject-prompt')

/**
 * Approve every file and wait until git AGREES. The button's "Commit phase" is
 * painted optimistically on click, so it can read armed while the underlying
 * `git add` lost a race with the IDE auto-provisioner's own index.lock — after
 * which the correcting refresh silently drops back to "Approve all (0/N)".
 * Polling the index makes the precondition real.
 */
async function approveAllStaged(win: Page, dir: string, expected: number): Promise<void> {
  const commitBtn = win.locator('.fl-review-commit-btn')
  await expect(async () => {
    if (/Approve all/.test(await commitBtn.innerText())) await commitBtn.click()
    await expect(commitBtn).toContainText('Commit phase')
    const staged = gitRetry(dir, 'diff', '--cached', '--name-only').trim()
    expect(staged.length === 0 ? [] : staged.split('\n')).toHaveLength(expected)
  }).toPass({ timeout: 60_000 })
}

test.afterAll(() => cleanupSeeds())

test('CONTROL: #182’s gate still shields an open reject prompt from an ordinary refresh', async ({
  window,
}) => {
  test.setTimeout(180_000) // seeds + provisions a repo before the panels paint
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(String(error)))

  const dir = await seedOne(window, 'flow-ux-settlegate-ctl1-')
  await activateProject(window, dir)
  await openPhases(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(2)

  // Open the reject prompt and type the feedback the agent would receive.
  await window.locator('.fl-review-file').first().locator('.fl-review-reject').click()
  await expect(rejectPrompt(window)).toHaveCount(1)
  await rejectPrompt(window).locator('input').fill(FEEDBACK)

  // A third change appears on disk, then an ordinary listing refresh runs. The
  // gate must DEFER it: the prompt (and the typed feedback) survives untouched
  // and the panel still lists the two files it was showing.
  writeFileSync(join(dir, 'src', 'extra.ts'), 'export const EXTRA = true\n')
  await window.locator('.fl-review-refresh').click()
  await window.waitForTimeout(1500)
  await expect(rejectPrompt(window)).toHaveCount(1)
  await expect(rejectPrompt(window).locator('input')).toHaveValue(FEEDBACK)
  await expect(window.locator('.fl-review-file')).toHaveCount(2)

  // Backing out flushes the deferred update — so the deferral was real, not a
  // refresh that never happened.
  await rejectPrompt(window).getByRole('button', { name: 'Cancel' }).click()
  await expect(rejectPrompt(window)).toHaveCount(0)
  await expect(window.locator('.fl-review-file')).toHaveCount(3, { timeout: 15_000 })

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('CONTROL: #281’s reset still clears a TYPED commit message across a project switch', async ({
  window,
}) => {
  test.setTimeout(180_000) // seeds + provisions two repos
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(String(error)))

  const one = await seedOne(window, 'flow-ux-settlegate-ctl2a-')
  const two = await seedTwo(window, 'flow-ux-settlegate-ctl2b-')
  await activateProject(window, one)
  await openPhases(window)
  await expect(window.locator('.fl-review-file')).toHaveCount(2)

  const typed = 'MESSAGE TYPED FOR PROJECT ONE'
  await commitMessage(window).fill(typed)
  await expect(commitMessage(window)).toHaveValue(typed)

  await activateProject(window, two)
  await expect(window.locator('.fl-review-file-name')).toHaveText(/invoice\.ts/, { timeout: 30_000 })
  await expect(
    commitMessage(window),
    'a message typed for project ONE must not be pre-filled over project TWO’s changes (#281)',
  ).not.toHaveValue(typed)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #1379 — needs a real ✨ generation (the agent's one-shot generate), so it is
// parked rather than run on every CI pass. Confirmed genuinely RED on main.
test.fixme(
  'a resolving ✨ generation must not tear down an open reject prompt (#1379)',
  async ({ window }) => {
    test.setTimeout(300_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(String(error)))

    const dir = await seedOne(window, 'flow-ux-settlegate-tw1-')
    await activateProject(window, dir)
    await openPhases(window)
    await expect(window.locator('.fl-review-file')).toHaveCount(2)
    await approveAllStaged(window, dir, 2)
    await expect(wand(window)).toBeEnabled({ timeout: 15_000 })

    // Start the ~10s generation, then do what the panel invites next: reject one
    // of the files and write the agent its feedback.
    await wand(window).click()
    await expect(wand(window)).toBeDisabled()
    await window.locator('.fl-review-file').first().locator('.fl-review-reject').click()
    await expect(rejectPrompt(window)).toHaveCount(1)
    await rejectPrompt(window).locator('input').fill(FEEDBACK)
    await window.screenshot({ path: `${SCREENS}/review-wand-settle-typed.png` })

    // Let the generation resolve. Break the moment the prompt vanishes so the
    // failure screenshot catches the state the user is left in.
    for (let i = 0; i < 90 && (await rejectPrompt(window).count()) > 0; i += 1) {
      await window.waitForTimeout(500)
    }
    await window.screenshot({ path: `${SCREENS}/review-wand-settle-destroyed.png` })

    await expect(
      rejectPrompt(window),
      'the ✨ generation resolved and its unconditional re-render destroyed the open reject prompt — the feedback typed for the agent is gone, with no toast and no way back',
    ).toHaveCount(1)
    await expect(rejectPrompt(window).locator('input')).toHaveValue(FEEDBACK)

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

// #1380 — same dependency on a real generation. Confirmed genuinely RED on main.
test.fixme(
  'a ✨ generation in flight must not write its message into the NEXT project (#1380)',
  async ({ window }) => {
    test.setTimeout(300_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(String(error)))

    const one = await seedOne(window, 'flow-ux-settlegate-tw2a-')
    const two = await seedTwo(window, 'flow-ux-settlegate-tw2b-')
    await activateProject(window, one)
    await openPhases(window)
    await expect(window.locator('.fl-review-file')).toHaveCount(2)
    await approveAllStaged(window, one, 2)
    await expect(wand(window)).toBeEnabled({ timeout: 15_000 })

    // Generation starts in project ONE…
    await wand(window).click()
    await expect(wand(window)).toBeDisabled()

    // …and the user moves on to project TWO while it runs. The switch drops the
    // sidebar back to its default rail, so come back to Phases — the leaked
    // message has to be asserted (and screenshotted) where it is ON SCREEN, not
    // merely present in a hidden panel's DOM.
    await activateProject(window, two)
    await openPhases(window)
    await expect(window.locator('.fl-review-file-name')).toHaveText(/invoice\.ts/, {
      timeout: 30_000,
    })
    await expect(commitMessage(window)).toBeVisible()
    const own = await commitMessage(window).inputValue()

    // Give the generation the whole of its run to land somewhere it shouldn't.
    for (let i = 0; i < 90; i += 1) {
      await window.waitForTimeout(500)
      if ((await commitMessage(window).inputValue()) !== own) break
    }
    await window.screenshot({ path: `${SCREENS}/review-wand-settle-project-leak.png` })

    await expect(window.locator('.fl-review-file-name')).toHaveText(/invoice\.ts/)
    await expect(
      commitMessage(window),
      'a commit message generated from project ONE’s staged diff was pre-filled over project TWO’s unrelated changes — reset() clears #drafts but not #generating, so the in-flight generation outlives the switch (#281 class)',
    ).toHaveValue(own)

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
