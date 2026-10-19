/**
 * What a project is holding on disk, on the page that now shows it.
 *
 * WHY THIS IS A SPEC AND NOT A UNIT TEST. Every bug this feature's own session
 * uncovered was invisible to unit tests, because the broken state renders
 * something PLAUSIBLE: a list that is internally consistent and simply not
 * showing you the files whose conversation you deleted; a row painted narrower
 * than its own words; a button labelled with a count computed from a selection
 * the list had already thrown away. None of that looks like a failure from
 * inside the code, and all of it looks like a failure on screen.
 *
 * THE SURFACE MOVED; THE INVARIANTS DID NOT. This drove the worktree ledger —
 * a modal of `.fl-workspace-row`s with checkboxes, a Rename button and a
 * dangerous bulk press. That dialog is gone: the inventory lives on the Storage
 * page inside Flow settings, and renaming moved to the branch chip where the
 * name already is (`e2e/branch-naming.spec.ts` drives it there). The two things
 * this file existed to guard are still this page's job, so it is rewritten
 * rather than deleted — a spec removed alongside the feature it guarded proves
 * nothing.
 *
 *  1. EVERY entry is listed, whatever state it is in — including the two that
 *     exist only as drift between what the database believes and what git
 *     reports, which nothing else in Flow will ever mention again.
 *  2. What has landed can be freed, and what holds work that exists nowhere
 *     else CANNOT — and the refusal is now HARD. There is no confirm, no
 *     modifier and no force: the control is off with its reason beside it, and
 *     the entry is still there afterwards.
 *
 * The assertions are the ones a person makes with their eyes: is every row
 * listed, does each say what its state means, is anything painted narrower than
 * its own words, and does the one button that removes things say how many.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  git,
  localBranches,
  registeredWorktrees,
  seedCommittedRepo,
  settleWorktree,
} from './fixtures/worktree'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

/** The real branch name that broke the conflict panel. 53 characters. */
const LONG_BRANCH = 'ACME-2446-rework-the-session-cache-for-the-new-router'

/** Narrow / the width the conflict bug was reported at / wide. */
const WIDTHS = [320, 500, 900]

/** Where the screenshots this run produced are written. */
const SHOTS = '/tmp/worktree-mgmt'

/** Longest the list may take to read six checkouts and measure them. */
const LIST_BUDGET_MS = 60_000

/** The sentence the page refuses with. Said once in the product, once here. */
const HOLDS_WORK =
  'This still holds work that exists nowhere else. Letting it go throws that away for good.'

/** The Flow-settings row that is the one door onto the inventory. */
const STORAGE_DOOR = 'Files kept for conversations'

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/** Make a thread and give it a worktree, returning its id. */
async function threadWithWorktree(
  win: Page,
  root: string,
  title: string,
  start: Record<string, unknown>,
): Promise<string> {
  return win.evaluate(
    async ([projectRoot, name, startJson]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const thread = await flow.threads.create({ projectRoot, title: name })
      await flow.threads.prepareWorktree({
        threadId: thread.id,
        carry: 'clean',
        requested: true,
        start: JSON.parse(startJson),
      })
      return thread.id as string
    },
    [root, title, JSON.stringify(start)],
  )
}

/** Read one thread's checkout path straight from the store. */
async function checkoutOf(win: Page, root: string, threadId: string): Promise<string> {
  const path = await win.evaluate(
    async ([projectRoot, id]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const threads = (await flow.threads.list({ projectRoot })) as {
        id: string
        worktreePath: string | null
      }[]
      return threads.find((thread) => thread.id === id)?.worktreePath ?? null
    },
    [root, threadId],
  )
  if (path === null) throw new Error(`thread ${threadId} never got a checkout`)
  return path
}

/** Force the theme the way the user's toggle does — beats prefers-color-scheme. */
async function useTheme(win: Page, theme: 'light' | 'dark'): Promise<void> {
  await win.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value)
  }, theme)
  await win.waitForTimeout(200)
}

/**
 * Walk to the Storage page the way the app does — the same event the project ⋯
 * menu and the command palette dispatch, then the one door inside it.
 */
async function openStoragePage(win: Page, project: string): Promise<void> {
  await win.evaluate((rootPath: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-flow-settings', { detail: { rootPath } }))
  }, project)
  const settings = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-settings-section)')
  await expect(settings).toBeVisible({ timeout: 20_000 })
  const opener = settings.locator('.fl-fs-row', { hasText: STORAGE_DOOR })
  await expect(opener).toBeVisible()
  await opener.locator('button').click()
  await expect(win.locator('.fl-storage')).toBeVisible({ timeout: LIST_BUDGET_MS })
}

/**
 * Every leaf inside the page painted narrower than its own text.
 *
 * The conversation's own name is the ONE element designed to give way — it is
 * identity, and a name that shortens is still recognisably the name. Everything
 * else that clips is a bug, and this is what proves it at a width no unit test
 * has.
 */
function clippedOnPage(): { cls: string; text: string }[] {
  const root = document.querySelector('.fl-storage') as HTMLElement | null
  if (root === null) return [{ cls: 'MISSING', text: 'no page' }]
  const clipped: { cls: string; text: string }[] = []
  for (const el of Array.from(root.querySelectorAll('*')) as HTMLElement[]) {
    if (el.childElementCount > 0) continue
    const text = (el.textContent ?? '').trim()
    if (text === '' || el.offsetParent === null) continue
    if (el.scrollWidth > el.clientWidth + 1) clipped.push({ cls: el.className || el.tagName, text })
  }
  return clipped
}

test('every conversation’s files are listed, whatever state they are in', async ({
  app,
  window,
}) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  window.on('pageerror', (event) => errors.push(event.message))

  const project = await seedCommittedRepo(window, 'flow-wt-manage-')
  // The branches the checkouts will take. Real refs, so nothing below is a
  // fixture pretending to be git.
  for (const branch of [LONG_BRANCH, 'feature/rename-me', 'feature/tidy-up', 'feature/spare']) {
    git(project, 'branch', branch)
  }
  await activateProject(window, project)
  await settleWorktree(window, project)

  // ── Six sets of files, six states ─────────────────────────────────────────

  // 1. The width hazard: a 53-character branch, holding work nobody saved. It
  //    is retargeted onto `main` first so its branch and its base differ.
  const long = await threadWithWorktree(window, project, 'Chat Migration to Engine Internals', {
    kind: 'checkout',
    branch: LONG_BRANCH,
  })
  const longCheckout = await checkoutOf(window, project, long)
  writeFileSync(join(longCheckout, 'half-done.ts'), 'export const wip = true\n')
  await window.evaluate(
    async (id: string) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.threads.retargetWorktree({ threadId: id, start: { kind: 'branch', branch: 'main' } })
    },
    long,
  )

  // 2 & 3. Two that have landed — clean, nothing their branch has not got.
  await threadWithWorktree(window, project, 'Rename the settings rows', {
    kind: 'checkout',
    branch: 'feature/rename-me',
  })
  await threadWithWorktree(window, project, 'Tidy up the toolbar', {
    kind: 'checkout',
    branch: 'feature/tidy-up',
  })

  // 4. One whose first turn never named it — a real, temporary, nameless state.
  await threadWithWorktree(window, project, 'Never finished its first turn', {
    kind: 'branch',
    branch: 'main',
  })

  // 5. Files whose CONVERSATION RECORD IS GONE while the files stayed. Nothing
  //    a person can press produces this any more, but the state is still
  //    reachable: a crash between two steps, a record removed by an older
  //    build, a release that failed while the delete went through. So this
  //    drives the RAW record channel on purpose — the one thing that still
  //    removes a thread without dealing with its files — and the list must go
  //    on surfacing what it leaves.
  const ghost = await threadWithWorktree(window, project, 'Deleted while it still had files', {
    kind: 'checkout',
    branch: 'feature/spare',
  })
  const ghostCheckout = await checkoutOf(window, project, ghost)
  // HOLDING WORK, or the copy would not outlive its record: a thread's delete
  // now releases its checkout from the one place every delete passes through
  // (checkout-on-thread-deleted.ts) — unless it holds something nobody saved,
  // which is refused, kept, and exactly what this page exists to surface.
  writeFileSync(join(ghostCheckout, 'notes-nobody-saved.md'), 'only here\n')
  await window.evaluate(async (id: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.threads.delete({ threadId: id })
  }, ghost)
  expect(
    existsSync(ghostCheckout),
    'the raw record channel leaves the files behind — the drift this page exists to surface',
  ).toBe(true)

  // 6. A conversation pointing at files somebody removed by hand outside Flow.
  const missing = await threadWithWorktree(window, project, 'Its files were deleted by hand', {
    kind: 'branch',
    branch: 'main',
  })
  const missingCheckout = await checkoutOf(window, project, missing)
  rmSync(missingCheckout, { recursive: true, force: true })
  git(project, 'worktree', 'prune')

  // ── The door: Flow settings → Files kept for conversations → Open ────────

  await openStoragePage(window, project)

  const page = window.locator('.fl-storage')
  const rows = page.locator('.fl-storage-row')
  await expect(rows).toHaveCount(6, { timeout: LIST_BUDGET_MS })

  // ── What the eye checks ──────────────────────────────────────────────────

  // The header leads with the number, which is why anyone opened this.
  await expect(page.locator('.fl-storage-count')).toHaveText(/^\d+ of \d+/)
  // …and the promise under it, which is what makes the page quick to read.
  await expect(page.locator('.fl-storage-note').first()).toContainText(
    'Nothing holding work that exists nowhere else is ever removed',
  )

  // Every state says what it MEANS, in the words a person reads. The nine
  // labels the ledger printed are gone; the nuance they carried is told.
  expect(
    await page.locator('.fl-storage-mark[data-tone="working"]').count(),
    'the one holding unsaved work',
  ).toBe(1)
  expect(
    await page.locator('.fl-storage-mark[data-tone="orphaned"]').count(),
    'THE TWO DRIFT ROWS — the whole reason this is the union of two truths',
  ).toBe(2)
  expect(await page.locator('.fl-storage-mark[data-tone="landed"]').count()).toBe(3)

  // The files whose conversation is gone are named as that, not as a blank row.
  await expect(rows.filter({ hasText: 'A conversation that no longer exists' })).toHaveCount(1)

  // The row pointing at nothing says there is nothing left to free, and its
  // control is off — there is no act available on it.
  const missingRow = rows.filter({ hasText: 'already gone' })
  await expect(missingRow).toHaveCount(1)
  await expect(missingRow.locator('button')).toBeDisabled()

  // THE HARD REFUSAL, on the row holding work nobody saved: off, with the
  // reason where the press is. No confirm, no modifier, no force.
  const longRow = rows.filter({ hasText: 'Chat Migration to Engine Internals' })
  await expect(longRow).toHaveCount(1)
  await expect(longRow.locator('button')).toBeDisabled()
  await expect(longRow.locator('button')).toHaveAttribute('title', HOLDS_WORK)

  // NOT A PATH, NOT A COMMAND, NOT A CONFIG KEY — on the surface most likely to
  // leak one, because a list of checkouts is made of paths on the other side.
  const shown = (await page.allTextContents()).join(' ')
  // Non-vacuity: the sweep really is reading this page's words, so the refusal
  // below is an absence in something rather than the absence of everything.
  expect(shown).toContain('A conversation that no longer exists')
  expect(shown).not.toMatch(/planflow-ai|\/Users\/|\/private\/|-threads\/|`|--target/)

  // ── The one bulk press, which cannot contain anything dangerous ──────────

  const bulk = page.locator('.fl-storage-head button')
  await expect(bulk).toBeEnabled()
  await expect(bulk).toHaveText(/^Free what has landed — \d+$/)

  // ── Screenshots: three widths, both themes ───────────────────────────────

  mkdirSync(SHOTS, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await useTheme(window, theme)
    for (const width of WIDTHS) {
      // The app's own window has a 960px floor, which is right for the app and
      // wrong for measuring a panel: without lifting it, every "narrow" request
      // silently clamps and the widths below all render identically — a check
      // that passes by measuring the same picture three times. The floor is
      // lifted for the measurement and the ACTUAL width is asserted, so a
      // clamp can never be mistaken for a pass again.
      await app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows()[0]
        win?.setMinimumSize(1, 1)
        win?.setSize(w, 900)
      }, width)
      await window.waitForTimeout(600)
      const viewport = await window.evaluate(() => window.innerWidth)
      expect(Math.abs(viewport - width), `window refused ${String(width)}px`).toBeLessThanOrEqual(2)
      await window.screenshot({ path: `${SHOTS}/storage-${theme}-${String(width)}.png` })

      // NOTHING IS PAINTED NARROWER THAN ITS OWN WORDS — except the
      // conversation's name, the one string designed to give way.
      const clipped = await window.evaluate(clippedOnPage)
      expect(
        clipped.filter((entry) => !entry.cls.includes('fl-storage-title')),
        `clipped at ${String(width)}px in ${theme}: ${JSON.stringify(clipped)}`,
      ).toEqual([])

      // And the page itself never scrolls sideways.
      const box = await window.evaluate(() => {
        const root = document.querySelector('.fl-storage') as HTMLElement
        return { scroll: root.scrollWidth, client: root.clientWidth }
      })
      expect(box.scroll, `sideways scroll at ${String(width)}px in ${theme}`).toBeLessThanOrEqual(
        box.client + 1,
      )
    }
  }

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setMinimumSize(960, 600)
    win?.setSize(1280, 900)
  })

  expect(errors, errors.join(', ')).toEqual([])
})

/**
 * Freeing what has landed, and the refusal that has no way past it.
 *
 * WHY THIS IS HERE AND NOT A UNIT TEST. The model that decides is pure and
 * tested — and a pure model deciding "free it" proves nothing about whether a
 * directory left the disk. What this drives is the whole path: a real press on
 * a real page, and everything asserted afterwards read from GIT and from the
 * DISK (allowed-pattern #7), never from the page's own sentence about itself.
 *
 * THE REFUSAL CHANGED SHAPE, AND THAT IS THE POINT. It used to be a confirm
 * that warned and went ahead; it is now a control that is OFF with its reason
 * beside it, and there is no second click that gets past it. So the assertion
 * is the disabled control AND the absence of the effect (allowed-pattern #24):
 * the files, their untracked change and their branch are all still exactly
 * where they were.
 */
test('the Storage page frees what has landed, and never what holds work', async ({ window }) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  window.on('pageerror', (event) => errors.push(event.message))

  const project = await seedCommittedRepo(window, 'flow-wt-delete-')
  for (const branch of ['feature/landed', 'feature/holds-work']) git(project, 'branch', branch)
  await activateProject(window, project)
  await settleWorktree(window, project)

  // One conversation whose work is already on its branch, one still holding
  // files nobody saved. Both take a branch DIRECTLY, so "landed" is a fact
  // about the repository rather than a state the test asserted into existence.
  const landed = await threadWithWorktree(window, project, 'Tidied the toolbar', {
    kind: 'checkout',
    branch: 'feature/landed',
  })
  const landedCheckout = await checkoutOf(window, project, landed)

  const holding = await threadWithWorktree(window, project, 'Half a parser rewrite', {
    kind: 'checkout',
    branch: 'feature/holds-work',
  })
  const holdingCheckout = await checkoutOf(window, project, holding)
  writeFileSync(join(holdingCheckout, 'half-done.ts'), 'export const wip = true\n')

  expect(registeredWorktrees(project)).toContain(landedCheckout)
  expect(registeredWorktrees(project)).toContain(holdingCheckout)

  await openStoragePage(window, project)
  const page = window.locator('.fl-storage')
  const rows = page.locator('.fl-storage-row')
  await expect(rows).toHaveCount(2, { timeout: LIST_BUDGET_MS })

  const landedRow = rows.filter({ hasText: 'Tidied the toolbar' })
  const holdingRow = rows.filter({ hasText: 'Half a parser rewrite' })
  await expect(landedRow).toHaveCount(1)
  await expect(holdingRow).toHaveCount(1)

  // ── The refusal: off, with the reason where the press is ─────────────────

  // NON-VACUITY: the sibling row's control IS enabled, so "disabled" below is
  // read off a locator that really can report both answers on this page.
  await expect(landedRow.locator('button')).toBeEnabled()
  await expect(holdingRow.locator('button')).toBeDisabled()
  await expect(holdingRow.locator('button')).toHaveAttribute('title', HOLDS_WORK)
  await expect(holdingRow.locator('.fl-storage-detail')).toContainText(
    'work that exists nowhere else',
  )

  // The bulk press cannot contain it either: it names the landed one only.
  const bulk = page.locator('.fl-storage-head button')
  await expect(bulk).toHaveText('Free what has landed — 1')

  // ── The safe press really removes files ──────────────────────────────────

  await bulk.click()
  await expect(page.locator('.fl-storage-status')).toContainText('branch keeps the record', {
    timeout: LIST_BUDGET_MS,
  })

  await expect
    .poll(() => existsSync(landedCheckout), {
      timeout: LIST_BUDGET_MS,
      message: 'the landed conversation’s files should be gone from the disk',
    })
    .toBe(false)
  expect(registeredWorktrees(project), 'git should no longer know the checkout').not.toContain(
    landedCheckout,
  )
  // THE BRANCH IS THE RECORD, and it outlives the files.
  expect(localBranches(project)).toContain('feature/landed')

  // ── …and the refused one is untouched, entry and all ─────────────────────

  await expect(rows.filter({ hasText: 'Half a parser rewrite' })).toHaveCount(1)
  expect(existsSync(holdingCheckout), 'a press meant for landed files destroyed work').toBe(true)
  expect(existsSync(join(holdingCheckout, 'half-done.ts'))).toBe(true)
  expect(registeredWorktrees(project)).toContain(holdingCheckout)
  expect(localBranches(project)).toContain('feature/holds-work')

  expect(errors, errors.join(', ')).toEqual([])
})
