import { test, expect } from './fixtures/electron'
import type { Page } from '@playwright/test'
import { cleanupSeeds } from './ux/fixtures/seed'
import {
  seedThreadInCleanProject,
  seedThreadInProject,
  seedThreadInPushedProject,
  seedThreadWithChanges,
} from './fixtures/thread-worktree'

/**
 * Thread change-review card, end to end (agent-change-review #1906).
 *
 * Two levels: the IPC read model over a REAL thread worktree with real git
 * changes (the deterministic core), then the card rendering + a click-through to
 * the shared diff. Card-side selectors are the class names the card owns
 * (`.flow-change-review`, `.flow-cr-row`, `.flow-cr-name`, `.flow-cr-keep`,
 * `.flow-cr-reject`); the seed drives the app's own thread + worktree seams (see
 * `fixtures/thread-worktree.ts`).
 */

test.afterAll(() => cleanupSeeds())

test('threads:changeReview returns the worktree’s changes, git-sourced', async ({ window }) => {
  test.setTimeout(120_000)
  const { threadId } = await seedThreadWithChanges(window)

  const review = await window.evaluate(async (id) => {
    return (window as unknown as {
      flow: { git: { changeReview(r: { threadId: string }): Promise<unknown> } }
    }).flow.git.changeReview({ threadId: id })
  }, threadId)

  expect(review, 'no review for a thread that has a worktree with changes').not.toBeNull()
  const files = (review as { files: Array<Record<string, unknown>> }).files
  const byPath = Object.fromEntries(files.map((f) => [f.filePath as string, f]))

  // The tracked-file edit is a real, keep/rejectable change with counts vs HEAD.
  expect(byPath['a.ts'], 'the edited tracked file is missing').toBeTruthy()
  expect(byPath['a.ts'].touchedOnly).toBe(false)
  expect(byPath['a.ts'].added as number).toBeGreaterThanOrEqual(1)

  // The new untracked file is listed (git is the source of truth), no counts.
  expect(byPath['added.ts'], 'the new file is missing').toBeTruthy()
  expect(byPath['added.ts'].touchedOnly).toBe(false)

  // flow/ artifacts never enter the review.
  for (const path of Object.keys(byPath)) {
    expect(path.startsWith('flow/'), `a flow/ artifact leaked in: ${path}`).toBe(false)
  }
})

/** Bind the card to a thread the way the shell does — the DOM event it follows. */
async function activateThread(window: Page, threadId: string): Promise<void> {
  await window.evaluate((id) => {
    document.dispatchEvent(new CustomEvent('flow:active-thread', { detail: { threadId: id } }))
  }, threadId)
}

/** Select a conversation the way a person does — the event every "open this
 *  chat" surface dispatches, which also activates the conversation's project —
 *  and wait until the editor shows that conversation's tab set (a tab opened
 *  before then would belong to the set being left). */
async function selectThread(window: Page, threadId: string): Promise<void> {
  const settled = await window.evaluate(
    (id) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 20_000)
        const onScope = (event: Event): void => {
          if ((event as CustomEvent<{ threadId: string | null } | null>).detail?.threadId !== id) return
          document.removeEventListener('flow:tab-scope', onScope)
          clearTimeout(timer)
          resolve(true)
        }
        document.addEventListener('flow:tab-scope', onScope)
        document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
      }),
    threadId,
  )
  expect(settled, 'the editor never switched to the conversation’s tabs').toBe(true)
}

/**
 * Open the Changes tab — the review lives in the editor area, and deliberately
 * does not open itself, so it has to be asked for before it is on screen.
 *
 * The card used to be mounted permanently below the transcript, which is why
 * this spec did not need this: it was always in the DOM. It moved because a
 * thread with four changed files gave up a band of the reading column for good.
 */
async function openChangeReview(window: Page): Promise<void> {
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-change-review'))
  })
}

test('the strip announces the changes and opens the Changes tab', async ({ window }) => {
  test.setTimeout(120_000)
  // THE BUG THIS GUARDS, in the user's words: "i was if the thread opened, and
  // I had changes on that thread, but those changes was not being showed". Both
  // earlier placements passed the test below — which opens the surface itself —
  // while there was nothing on screen that said to open it. So this one never
  // dispatches the event: it clicks what a person can see.
  const { threadId } = await seedThreadWithChanges(window)
  await activateThread(window, threadId)

  const strip = window.locator('.fl-changes-strip')
  await expect(strip, 'nothing above the composer said the thread had changes').toBeVisible({
    timeout: 30_000,
  })
  await expect(strip.locator('.fl-changes-strip-added')).toContainText('+')

  await strip.click()
  await expect(
    window.locator('.flow-change-review .flow-cr-row'),
    'pressing the strip did not open the Changes tab',
  ).toHaveCount(2, { timeout: 30_000 })
  await window.screenshot({ path: 'e2e/__screens/change-review-strip.png' })
})

test('the card lists the changes, and a file opens its diff', async ({ window }) => {
  test.setTimeout(120_000)
  const { threadId } = await seedThreadWithChanges(window)
  await activateThread(window, threadId)
  await openChangeReview(window)

  const card = window.locator('.flow-change-review')
  await expect(card, 'the change-review card never appeared').toBeVisible({ timeout: 30_000 })

  const rows = card.locator('.flow-cr-row')
  await expect(rows, 'the card did not list both changed files').toHaveCount(2)
  await expect(card.locator('.flow-cr-name', { hasText: 'a.ts' })).toBeVisible()
  await expect(card.locator('.flow-cr-name', { hasText: 'added.ts' })).toBeVisible()

  // The toolbar: what this list is, how big it is, where a commit would land.
  await expect(card.locator('.flow-cr-scope')).toHaveText('Uncommitted')
  await expect(card.locator('.flow-cr-scope-counts')).toContainText('+2')
  // A freshly-cut thread worktree is DETACHED until its first turn names a
  // branch, so the chip is absent rather than blank — "a branch with no name"
  // is the one thing it must never look like. Its named case is asserted in the
  // project-files test below.
  await expect(card.locator('.flow-cr-branch')).toBeHidden()
  // A file that did not exist before says so, the way the reference does.
  await expect(
    card.locator('.flow-cr-file', { hasText: 'added.ts' }).locator('.flow-cr-badge'),
  ).toHaveText('New')

  await window.screenshot({ path: 'e2e/__screens/change-review-card.png' })

  // The row says it expands BEFORE it is clicked: a disclosure chevron, quiet
  // until the pointer arrives and turned down once the diff is open. Asserted
  // through the row's own aria-expanded, which is what a screen reader is told
  // (the chevron itself is decorative and would pass vacuously).
  const nameButton = card.locator('.flow-cr-name', { hasText: 'a.ts' })
  await expect(nameButton).toHaveAttribute('aria-expanded', 'false')

  // Clicking a file expands ITS diff IN THE LIST — the reference's shape, and
  // the reason reviewing ten files is one scroll rather than ten modals.
  //
  // Clicked on the STATUS LETTER, not the filename: only the name carried the
  // handler, so the chevron, the letter, the counts and every gap between them
  // were dead — "when im clicking on the M icon, nothing is happening",
  // "actually on arrow nothing happens as well" (user, 2026-09-10). The row is
  // one subject; all of it opens the file.
  const fileRow = card.locator('.flow-cr-file', { hasText: 'a.ts' })
  await fileRow.locator('.flow-cr-glyph').click()
  const inline = card.locator('.flow-cr-file', { hasText: 'a.ts' }).locator('.monaco-diff-editor')
  await expect(inline, 'clicking a file did not expand its diff in place').toBeVisible({
    timeout: 30_000,
  })
  // …and it really renders the CHANGE, not just the file. Monaco paints the
  // text first and applies its diff decorations a frame later, so asserting the
  // editor exists proves nothing about whether a diff was computed.
  await expect(
    inline.locator('.line-insert').first(),
    'the inline editor painted the file but no diff',
  ).toBeVisible({ timeout: 30_000 })
  await expect(nameButton).toHaveAttribute('aria-expanded', 'true')
  await window.screenshot({ path: 'e2e/__screens/change-review-diff.png' })

  // The chevron folds it away again — dead before this too.
  await fileRow.locator('.flow-cr-chevron').click()
  await expect(inline).toHaveCount(0)
  await expect(nameButton).toHaveAttribute('aria-expanded', 'false')

  // …and the three controls at the right end do NOT expand the row underneath
  // them: a checkbox that also opened a diff is two actions on one press.
  await fileRow.locator('.flow-cr-check').check()
  await expect(nameButton).toHaveAttribute('aria-expanded', 'false')
})

test('the checkbox is the file’s staged state, and it really stages', async ({ window }) => {
  test.setTimeout(120_000)
  // "Keep" was a verb on a button, which said what Flow calls the action but not
  // what git had already recorded. Across ten rows the state is the thing you
  // need to see, so it is a checkbox — and it has to be the REAL index state,
  // not a local toggle that drifts from what a commit would contain.
  const { threadId } = await seedThreadWithChanges(window)
  await activateThread(window, threadId)
  await openChangeReview(window)

  const card = window.locator('.flow-change-review')
  const row = card.locator('.flow-cr-file', { hasText: 'added.ts' })
  const check = row.locator('.flow-cr-check')
  await expect(check).not.toBeChecked()
  await check.check()
  await expect(check, 'the checkbox did not survive the refresh that follows staging').toBeChecked({
    timeout: 30_000,
  })

  // The status letter is git's, so a staged untracked file now reads as added.
  await expect(row.locator('.flow-cr-glyph')).toHaveText('A')
})

test('a thread with no copy of its own reviews the project’s uncommitted work', async ({
  window,
}) => {
  test.setTimeout(120_000)
  // THE NORMAL THREAD after the worktree gate (automatic copies are loops-only).
  // Its review used to resolve to null — `worktreePathFor` returned null and the
  // whole surface went quiet — so almost every conversation had a Changes strip
  // that never appeared and a Changes tab that said nothing had been changed,
  // while Source Control two columns away listed the very same files.
  const { threadId } = await seedThreadInProject(window)
  await activateThread(window, threadId)

  const strip = window.locator('.fl-changes-strip')
  await expect(strip, 'a thread working in the project announced nothing').toBeVisible({
    timeout: 30_000,
  })
  // …and it does NOT claim the conversation made them: this is the project's
  // tree, where the agent's work, yours, and whatever was already there are
  // indistinguishable.
  await expect(strip).toHaveAttribute('title', /uncommitted/)

  await strip.click()
  const card = window.locator('.flow-change-review')
  await expect(card.locator('.flow-cr-scope')).toHaveText('Uncommitted', { timeout: 30_000 })
  // The project's HEAD is on a real branch, so the toolbar names where a commit
  // of these files would land.
  await expect(card.locator('.flow-cr-branch-name')).toHaveText(/^(main|master)$/)
  await window.screenshot({ path: 'e2e/__screens/change-review-toolbar.png' })
})

test('the Changes tab is remembered per conversation', async ({ window }) => {
  test.setTimeout(180_000)
  // "the thread 1 have changes, when i click the other thread, the changes
  // still opened there … all the tabs and things opened should be remembered
  // according to the thread" (user, 2026-09-10). The card follows the active
  // thread, so a tab left open across a switch quietly became the OTHER
  // thread's review — usually an empty one, on a conversation opened to read
  // rather than to review.
  //
  // The two threads live in DIFFERENT projects, so they are selected the way a
  // person selects them (`flow:open-thread`), which also activates each one's
  // project: every editor tab now belongs to a (project, conversation) tab set,
  // and a bare thread signal for a conversation in another project is left to
  // that project's activation.
  const withChanges = await seedThreadWithChanges(window)
  const other = await seedThreadInProject(window)

  await selectThread(window, withChanges.threadId)
  await openChangeReview(window)
  // The editor's own tab strip (the terminal has one too), pierced by role —
  // `fl-tabs` is a shadow-DOM component, so a class selector on the button
  // would match nothing and every absence assertion would pass vacuously.
  const tab = window.locator('.fl-editor-tabs').getByRole('tab', { name: /^Changes/ })
  await expect(tab).toHaveCount(1, { timeout: 30_000 })

  // Away: the tab goes with the thread it belonged to.
  await selectThread(window, other.threadId)
  await expect(tab, 'the review stayed open on a conversation that never asked for it').toHaveCount(
    0,
    { timeout: 30_000 },
  )

  // Back: it is where it was left.
  await selectThread(window, withChanges.threadId)
  await expect(tab, 'the review was not restored on the thread it was opened in').toHaveCount(1, {
    timeout: 30_000,
  })
})

test('an open Changes tab is renamed when it is asked for another job', async ({ window }) => {
  test.setTimeout(120_000)
  // The tab's label IS its mode (`sourceControlTab`), and it renames itself by
  // reopening its view. `openView` only labelled a tab it was ADDING, so an
  // open tab kept the name it was first opened with: asking it for History
  // left it reading Changes. History is asked for by event, as the view does.
  const { threadId } = await seedThreadWithChanges(window)
  await selectThread(window, threadId)
  await openChangeReview(window)
  const tabs = window.locator('.fl-editor-tabs')
  const changes = tabs.getByRole('tab', { name: /^Changes/ })
  const history = tabs.getByRole('tab', { name: /^History/ })
  // The positive first: the tab is open, under its first name.
  await expect(changes).toHaveCount(1, { timeout: 30_000 })

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-history')))
  await expect(history, 'the open tab was asked for History and kept its old name').toHaveCount(1, {
    timeout: 10_000,
  })
  await expect(changes).toHaveCount(0)

  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-git')))
  await expect(changes, 'the tab did not take its name back').toHaveCount(1, { timeout: 10_000 })
  await expect(history).toHaveCount(0)
})

test('a review with nothing to review shows no controls at all', async ({ window }) => {
  test.setTimeout(120_000)
  // "if nothing was changed, why we are showing all that information" — a Keep
  // all with nothing to keep, a Reject all with nothing to reject and a Commit
  // over an empty list, above one sentence saying there is nothing (user,
  // 2026-09-10).
  const { threadId } = await seedThreadInCleanProject(window)
  await activateThread(window, threadId)
  await openChangeReview(window)

  const card = window.locator('.flow-change-review')
  await expect(card.locator('.flow-cr-empty')).toBeVisible({ timeout: 30_000 })
  // Asserted by reading the toolbar's own visibility AND the button count —
  // a `not.toBeVisible` on a selector that never matched would pass either way.
  await expect(card.locator('.flow-cr-toolbar')).toBeHidden()
  // Three in the TOOLBAR: Keep all, Reject all and Push. Commit left it when the
  // message box arrived — the button that commits sits with the words it sends.
  // The count is what makes the hidden-ness below mean something, so it tracks
  // the toolbar rather than being loosened to a range — and it is scoped to the
  // toolbar so a control added elsewhere in the card cannot silently change
  // what this test is asserting.
  const toolbarButtons = '.flow-cr-toolbar .flow-cr-tool, .flow-cr-toolbar .flow-cr-primary'
  await expect(card.locator(toolbarButtons)).toHaveCount(3)
  await expect(card.locator('.flow-cr-toolbar .flow-cr-tool:visible, .flow-cr-toolbar .flow-cr-primary:visible')).toHaveCount(0)
  // The commit row goes with it: with nothing to review there is nothing to
  // describe, and a message box over an empty list is the same chrome arguing
  // with the sentence underneath that the toolbar was hidden to stop.
  await expect(card.locator('.flow-cr-commit')).toBeHidden()
  await expect(card.locator('.flow-cr-tool').first()).toBeHidden()
})

test('committing moves the review to Committed, read-only', async ({ window }) => {
  test.setTimeout(120_000)
  // "even there after I commit, I'm still seeing Uncommitted and I'm seeing the
  // files there … We should see that as Committed just as a view, not in
  // interacted mode" (user, 2026-09-10).
  //
  // Two defects in one report. A commit changes `.git` and nothing in the
  // working tree, so none of the signals the review listens to fire for it —
  // and the fan-out that does exist was keyed on a thread's own checkout, which
  // after the worktree gate almost no thread has. Then, once it did notice, the
  // work simply vanished from the list, which reads as "nothing happened here".
  const { threadId } = await seedThreadInPushedProject(window)
  await activateThread(window, threadId)
  await openChangeReview(window)

  const card = window.locator('.flow-change-review')
  await expect(card.locator('.flow-cr-row')).toHaveCount(1, { timeout: 30_000 })
  await expect(card.locator('.flow-cr-scope')).toHaveText('Uncommitted')
  // SCOPED TO THE ROW. `.flow-cr-check` alone now matches two controls — the
  // per-file box and the select-all in the header — so the bare locator became
  // a strict-mode violation the day select-all landed.
  await expect(card.locator('.flow-cr-row .flow-cr-check')).toBeVisible()
  await expect(card.locator('.flow-cr-check-all')).toBeVisible()

  // Commit through the SAME channel the Source Control panel uses.
  await window.evaluate(async (id: string) => {
    const flow = (
      window as unknown as {
        flow: {
          git: {
            changeReview(r: { threadId: string }): Promise<{ rootId: string } | null>
            commit(r: { rootId: string; message: string; filePaths: string[] }): Promise<unknown>
          }
        }
      }
    ).flow
    const review = await flow.git.changeReview({ threadId: id })
    if (review === null) throw new Error('no review to commit')
    await flow.git.commit({ rootId: review.rootId, message: 'e2e commit', filePaths: ['a.ts'] })
  }, threadId)

  // No click, no reopen: the tab has to notice on its own.
  await expect(card.locator('.flow-cr-scope'), 'the review went on saying Uncommitted').toHaveText(
    'Committed',
    { timeout: 30_000 },
  )
  // The work is still THERE — and still readable.
  await expect(card.locator('.flow-cr-row')).toHaveCount(1)
  await expect(card.locator('.flow-cr-ahead')).toHaveText('↑1')

  // …and it is a record, not a decision: nothing left to keep, reject or commit.
  await expect(card.locator('.flow-cr-row .flow-cr-check')).toBeHidden()
  // The header's select-all is a decision too, and a record has none.
  await expect(card.locator('.flow-cr-check-all')).toBeHidden()
  await expect(card.locator('.flow-cr-row .flow-cr-icon.flow-cr-danger')).toBeHidden()
  // Counted, not asserted absent: the buttons are still in the DOM, so a
  // `not.toBeVisible` that matched nothing would pass for the wrong reason.
  //
  // THREE BUTTONS, ONE VISIBLE. Keep all and Reject all are put away because
  // committed work is a record rather than a decision — and Push is not,
  // because this is the one state where publishing is the thing left to do.
  // (Commit is no longer in the toolbar at all; its box hides with the list.) Its own end-to-end behaviour is publish.spec.ts;
  // here it only has to be the one control that survives the read-only sweep.
  await expect(card.locator('.flow-cr-toolbar button')).toHaveCount(3)
  await expect(card.locator('.flow-cr-toolbar button:visible')).toHaveCount(1)
  await expect(card.getByRole('button', { name: 'Push', exact: true })).toBeVisible()

  // Reading is the whole point of the state, so the diff still opens — and it
  // is a REAL diff. Against the working tree it would be empty (the change is
  // already in a commit), so the row would expand into a copy of the file with
  // nothing marked, which is worse than not opening.
  await card.locator('.flow-cr-glyph').first().click()
  const inline = card.locator('.monaco-diff-editor')
  await expect(inline).toBeVisible({ timeout: 30_000 })
  await expect(
    inline.locator('.line-insert').first(),
    'the committed file opened with no diff — it was compared against the wrong base',
  ).toBeVisible({ timeout: 30_000 })
  await window.screenshot({ path: 'e2e/__screens/change-review-committed.png' })
})
