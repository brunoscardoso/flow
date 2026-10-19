import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): the SCOPE of a phase commit, and what the ✓
 * approval mark actually means.
 *
 * The panel is the "phase-grouped review & commit" surface: a plan's `**Files**`
 * declarations split the working tree into per-phase groups, each with its own
 * suggested message and its own "Commit phase" button. Every one of the 15 prior
 * review specs drives the single no-plan "Other changes" fallback group, so the
 * multi-group shape the panel exists for — review phase by phase, commit phase by
 * phase — had no live coverage at all.
 *
 * Two seams are driven here:
 *
 *  A. COMMIT SCOPE (#1051). Approving mirrors into the index (`git add`, #857),
 *     so with several phases approved the index legitimately holds OTHER
 *     phases' files. "Commit phase" is PATH-SCOPED (`git commit -- <phase
 *     files>` via git:commit): it commits exactly that group's files and leaves
 *     every sibling phase staged, pending its own commit with its own message.
 *     (Before the fix it ran `git:stage` → `git:commitIndex`, committing the
 *     whole index — one phase's commit swept every approved phase in.)
 *
 *  B. APPROVAL FRESHNESS (#1052). The ✓ means "I reviewed THIS content": a file
 *     the agent rewrites AFTER approval (`MM` — index holds the reviewed blob,
 *     the disk holds newer edits) loses its green tick and downgrades to an
 *     amber ↻ re-approve, and the phase button re-gates until the current
 *     content is approved. (Before the fix the ✓ derived from staged-ness
 *     alone, so unreviewed content committed as reviewed.)
 *
 * All account-independent: `review:list` groups plain git status, so no Claude
 * account is needed to reach grouping, approve, and commit.
 */

const SCREENS = 'e2e/ux/__screens'
const seededDirs: string[] = []

/** Locate a review group section by its header label. */
function group(win: Page, label: string) {
  return win
    .locator('.fl-review-group')
    .filter({ has: win.locator('.fl-review-group-label', { hasText: label }) })
}

/** Staged paths straight from git — the ground truth behind the ✓ marks. */
function staged(dir: string): string[] {
  return execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
}

/** The files touched by HEAD (`git show --name-only`), or [] on an empty repo. */
function headFiles(dir: string): string[] {
  return execFileSync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
}

function headSubject(dir: string): string {
  return execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir, encoding: 'utf8' }).trim()
}

/** Per-test file names. Every test in this file seeds its OWN project and the
 *  panel re-binds asynchronously on the switch; identical file names across
 *  projects would let an assertion pass against the PREVIOUS project's still-
 *  rendered rows. Unique names make every wait project-specific. */
interface Seeded {
  dir: string
  alpha: string
  beta: string
}

function twoPhasePlan(alpha: string, beta: string): string {
  return `# Plan: Two phase

## Phase 1 — Alpha work

**Files**:
- \`${alpha}\`

## Phase 2 — Beta work

**Files**:
- \`${beta}\`
`
}

/**
 * Seed a repo whose working tree holds one change per plan phase, so the panel
 * renders TWO phase groups. The plan lives under `flow/` and is never committed
 * — flow's own artifacts are filtered out of the review listing (#310), so it
 * shapes the grouping without appearing as a reviewable change.
 *
 * The whole repo is built BEFORE the root is handed to the app: adding a root
 * starts the file watcher, whose `git status` refreshes would otherwise race the
 * seed's `git add` for index.lock (pure test-infra collision).
 */
async function seedTwoPhaseRepo(win: Page, tag: string): Promise<Seeded> {
  const dir = mkdtempSync(join(tmpdir(), `flow-ux-phscope-${tag}-`))
  const alpha = `alpha-${tag}.ts`
  const beta = `beta-${tag}.ts`
  seededDirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), '.claude/\nflow\n')
  writeFileSync(join(dir, alpha), 'export const alpha = 1\n')
  writeFileSync(join(dir, beta), 'export const beta = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(dir, 'flow', 'plans', 'plan_two_phase_v1.md'), twoPhasePlan(alpha, beta))
  // One working-tree change per phase.
  writeFileSync(join(dir, alpha), 'export const alpha = 2\n')
  writeFileSync(join(dir, beta), 'export const beta = 2\n')
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(win, dir)
  return { dir, alpha, beta }
}

/** Open Source Control → Phases (the folded-in review, #335). */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

/**
 * Click something until an observable effect lands. The review panel rebuilds its
 * whole DOM on every background refresh (`ReviewPanel.#render`, and the app's own
 * provisioning touches files right after a root is added), so a click dispatched
 * as the row is being replaced can land on a detached node and do nothing. That
 * is a harness hazard, not the behavior under test — so retry rather than let it
 * masquerade as a product failure.
 */
async function clickUntil(
  click: () => Promise<void>,
  landed: () => Promise<boolean> | boolean,
  attempts = 6,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    await click()
    for (let waited = 0; waited < 4000; waited += 250) {
      await new Promise((r) => setTimeout(r, 250))
      if (await landed()) return
    }
  }
  expect(await landed(), 'the click never took effect').toBe(true)
}

/** Click a group's phase button to approve every file in it, then wait for the
 *  staging round-trip to actually land (the ✓ paints optimistically). */
async function approveAll(win: Page, dir: string, label: string, expected: string[]): Promise<void> {
  const btn = group(win, label).locator('.fl-review-commit-btn')
  await expect(btn).toHaveText(/Approve all/)
  await clickUntil(
    async () => {
      if (/Approve all/.test(await btn.innerText())) await btn.click()
    },
    () => expected.every((f) => staged(dir).includes(f)),
  )
  await expect(btn).toHaveText(/Commit phase/, { timeout: 8000 })
}

/** Click a group's "Commit phase" button until HEAD actually moves. */
async function commitPhase(win: Page, dir: string, label: string): Promise<void> {
  const before = headSubject(dir)
  const btn = group(win, label).locator('.fl-review-commit-btn')
  await expect(btn).toHaveText(/Commit phase/)
  await clickUntil(
    async () => {
      if (await btn.count()) await btn.click().catch(() => undefined)
    },
    () => headSubject(dir) !== before,
  )
}

test.afterAll(() => {
  while (seededDirs.length) {
    const d = seededDirs.pop()
    if (!d) continue
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // Best-effort: the app provisions `.claude/` and the `flow` symlink into a
      // freshly-added root, so teardown can race those writes (ENOTEMPTY). A
      // leftover temp dir must never fail the run.
    }
  }
})

test('a plan splits the working tree into per-phase groups, each with its own message', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { alpha, beta } = await seedTwoPhaseRepo(window, 'a')
  await openReview(window)

  const p1 = group(window, 'Phase 1')
  const p2 = group(window, 'Phase 2')
  await expect(p1).toHaveCount(1, { timeout: 10000 })
  await expect(p2).toHaveCount(1)
  // The label carries the plan's feature slug so two plans' Phase 2 differ (#144).
  await expect(p1.locator('.fl-review-group-label')).toContainText('Phase 1 · two-phase')
  await expect(p2.locator('.fl-review-group-label')).toContainText('Phase 2 · two-phase')
  // Each phase groups only its own declared file …
  await expect(p1.locator('.fl-review-file-name')).toHaveText([alpha])
  await expect(p2.locator('.fl-review-file-name')).toHaveText([beta])
  // … and gets a conventional-commit message built from that phase's title.
  await expect(p1.locator('.fl-review-message')).toHaveValue('feat(two-phase): alpha work')
  await expect(p2.locator('.fl-review-message')).toHaveValue('feat(two-phase): beta work')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('committing a phase with only that phase approved commits exactly its files', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  const dialogs: string[] = []
  window.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.accept()
  })

  const { dir, alpha, beta } = await seedTwoPhaseRepo(window, 'b')
  await openReview(window)
  await expect(group(window, 'Phase 1').locator('.fl-review-file-name')).toHaveText([alpha], {
    timeout: 10000,
  })

  // Approve ONLY Phase 1, then commit it.
  await approveAll(window, dir, 'Phase 1', [alpha])
  await commitPhase(window, dir, 'Phase 1')

  expect(headSubject(dir)).toBe('feat(two-phase): alpha work')
  expect(headFiles(dir)).toEqual([alpha])
  // Phase 2's change is untouched and still pending review.
  await expect(group(window, 'Phase 2').locator('.fl-review-file-name')).toHaveText([beta])
  // No "other staged changes" warning — nothing outside the phase was in the index.
  expect(dialogs, dialogs.join(' | ')).toHaveLength(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test(
  'committing one phase must not commit a sibling phase you also approved (#1051)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))
    window.on('dialog', (d) => void d.accept())

    const { dir, alpha, beta } = await seedTwoPhaseRepo(window, 'c')
    await openReview(window)
    await expect(group(window, 'Phase 1').locator('.fl-review-file-name')).toHaveText([alpha], {
      timeout: 10000,
    })

    // The ordinary review gesture: tick everything off, phase by phase …
    await approveAll(window, dir, 'Phase 1', [alpha])
    await approveAll(window, dir, 'Phase 2', [beta])
    await window.screenshot({ path: `${SCREENS}/review-phase-scope-approved-both.png` })

    // … then commit the first phase.
    await commitPhase(window, dir, 'Phase 1')
    expect(headSubject(dir)).toBe('feat(two-phase): alpha work')

    // The commit named "alpha work" must contain alpha work — not Phase 2's file.
    expect(headFiles(dir)).toEqual([alpha])
    // And Phase 2 must still be there to review and commit on its own.
    await expect(group(window, 'Phase 2').locator('.fl-review-file-name')).toHaveText([beta])

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

test(
  'a file rewritten after you approve it must not still read as approved (#1052)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const { dir, alpha } = await seedTwoPhaseRepo(window, 'd')
    await openReview(window)
    const row = group(window, 'Phase 1').locator('.fl-review-file').filter({ hasText: alpha })
    await expect(row).toHaveCount(1, { timeout: 10000 })

    await clickUntil(
      () => row.locator('.fl-review-approve').click(),
      () => staged(dir).includes(alpha),
    )
    await expect(row).toHaveClass(/fl-review-file-approved/)

    // The agent keeps working and rewrites the file the user just reviewed.
    writeFileSync(join(dir, alpha), 'export const alpha = 3\nexport const unreviewed = true\n')
    await expect
      .poll(
        () =>
          execFileSync('git', ['status', '--porcelain', alpha], {
            cwd: dir,
            encoding: 'utf8',
          }).trim(),
        { timeout: 10000 },
      )
      .toBe(`MM ${alpha}`)

    // The approval is stale — the row must not keep claiming the file is reviewed.
    await expect(row).not.toHaveClass(/fl-review-file-approved/)

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

test('the sibling Changes tab does distinguish approved-then-edited content', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { dir, alpha } = await seedTwoPhaseRepo(window, 'e')
  await openReview(window)
  const row = group(window, 'Phase 1').locator('.fl-review-file').filter({ hasText: alpha })
  await expect(row).toHaveCount(1, { timeout: 10000 })

  await clickUntil(
    () => row.locator('.fl-review-approve').click(),
    () => staged(dir).includes(alpha),
  )

  writeFileSync(join(dir, alpha), 'export const alpha = 3\nexport const unreviewed = true\n')
  await expect
    .poll(
      () =>
        execFileSync('git', ['status', '--porcelain', alpha], {
          cwd: dir,
          encoding: 'utf8',
        }).trim(),
      { timeout: 10000 },
    )
    .toBe(`MM ${alpha}`)

  // Changes (the git surface) lists the file under BOTH sections — the partial
  // state the Phases surface collapses into one green row (#1052).
  await window.locator(sel.scViewBtn).filter({ hasText: 'Changes' }).click()
  await expect
    .poll(
      async () =>
        (await window.locator('.gp-name').allInnerTexts()).filter((n) => n === alpha).length,
      { timeout: 10000 },
    )
    .toBe(2)

  expect(errors, errors.join(', ')).toHaveLength(0)
})
