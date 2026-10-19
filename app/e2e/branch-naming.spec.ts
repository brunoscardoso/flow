/**
 * THE NEW PATH, END TO END — naming a conversation's branch, renaming it, and
 * the two refusals that must not be talked past (worktree-ui-removal Phase 6).
 *
 * The surfaces this replaces are gone: the status segment, the ledger dialog
 * and the two modals that asked where a checkout should begin and what should
 * happen to uncommitted work. What replaced all of them is two chips and one
 * page. So this drives what a person now actually does:
 *
 *  1. Start a conversation on a branch of its own with a name they TYPED (not
 *     the one Flow suggested) — and ask GIT whether that is the branch that
 *     exists. A chip that shows one name and cuts another is exactly the bug a
 *     unit test cannot see (allowed-pattern #7).
 *  2. Rename it from the header chip, and ask git again.
 *  3. Type a name git will not take, and watch the field keep the text EXACTLY
 *     as typed. A derived name is sanitized; a typed one is refused and never
 *     rewritten (allowed-pattern #22) — and a control that quietly repairs what
 *     somebody typed renames a branch other than the one on screen.
 *  4. Dismiss the carry question and assert NOTHING WAS MADE — the transcript
 *     and the absence of the effect (allowed-pattern #24). The modal this
 *     replaced resolved a dismissal to "start clean", which still cut a branch;
 *     a menu is dismissed by moving the mouse, and moving the mouse is not
 *     consent.
 *  5. One sweep over the rendered product for the vocabulary this whole change
 *     removed — with a negative control, so it cannot pass by matching nothing.
 */
import { test, expect, type Page } from './fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './ux/fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  git,
  localBranches,
  registeredWorktrees,
  seedCommittedRepo,
  settleWorktree,
} from './ux/fixtures/worktree'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/** Longest a `git worktree add` plus its first paint may take here. */
const CUT_BUDGET_MS = 60_000

/** What the app WOULD have called the branch — the name this spec refuses. */
// `worktree/`, not `thread/`: the namespace says what made the branch, where
// a person is looking at branches rather than at product copy (2026-09-17).
const SUGGESTED = 'worktree/rewrite-the-export-pipeline'
/** What a person types instead. Nothing derives this. */
const TYPED = 'feature/export-pipeline-v2'
/** And what they rename it to afterwards. */
const RENAMED = 'feature/export-pipeline-v3'

/** The ask that produces `SUGGESTED` — so the two names are visibly different. */
const ASK = 'Rewrite the export pipeline'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Open the new-thread page through the control a person presses. */
async function openNewThreadPage(win: Page): Promise<void> {
  await win.locator('fl-button[aria-label="New thread"]').click()
  await expect(win.locator('.fl-newthread')).toBeVisible({ timeout: 20_000 })
}

/** The branch chip on the new-thread page's message box. */
const newThreadChip = (win: Page) => win.locator('.fl-newbranch-chip')

/** The chip in the conversation header. */
/**
 * The branch chip — in the CHANGES TOOLBAR, which is where the name is changed.
 *
 * It lived beside the conversation's title until 2026-09-14 ("dont make sense
 * have the rename here"). The popover itself did not change, so every
 * `.fl-branch-rename*` locator below still reads the same control; only the
 * thing you press to open it moved.
 */
const branchChip = (win: Page) => win.locator('.flow-cr-branch')

/** The review lives in the editor area and does not open itself. */
async function openChangeReview(win: Page): Promise<void> {
  await win.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-change-review'))
  })
}

/** Every thread of a project, straight from the store. */
async function threadsOf(win: Page, projectRoot: string): Promise<
  {
    id: string
    title: string
    status: string
    worktreePath: string | null
    worktreeBranch: string | null
  }[]
> {
  return win.evaluate(async (root: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    return flow.threads.list({ projectRoot: root })
  }, projectRoot) as Promise<
    {
      id: string
      title: string
      status: string
      worktreePath: string | null
      worktreeBranch: string | null
    }[]
  >
}

// ── 1 + 2 + 3: the typed name, the rename, and the refusal ─────────────────

test('a typed branch name is the branch git gets — and renaming moves it', async ({ window }) => {
  test.setTimeout(300_000)

  const project = await seedCommittedRepo(window, 'flow-branch-naming-')
  await activateProject(window, project)
  await settleWorktree(window, project)

  await openNewThreadPage(window)
  await window.locator('.fl-newthread-body').fill(ASK)

  // THE CHIP OPENS ON THE PROJECT, and isolation is a press.
  //
  // This assertion used to read `toHaveText(SUGGESTED)`, because the chip
  // opened on a branch of its own. That default is what put 22 of this
  // machine's 23 checkouts on disk without anybody choosing one, so it now
  // opens on the project — and this spec has to ASK for the branch, which is
  // the whole point of the change.
  await expect(newThreadChip(window)).not.toHaveText(SUGGESTED)
  await newThreadChip(window).click()
  const menu = window.locator('.fl-fmenu')
  await expect(menu).toBeVisible()

  // THE SWITCH, thrown deliberately. The menu used to be three rungs — two of
  // them a binary wearing a list's clothes — and is now the same switch the
  // explorer's panel carries, so one decision has one shape wherever it is met.
  // The name field is unchanged by the flip: the suggestion is there in full,
  // prefix included — a box showing half a branch refuses edits to the half it
  // hid.
  await menu.locator('.fl-wt-track').click()
  // THE FOLDER'S FIELD IS FIRST, and its prefix is drawn beside it; the BRANCH
  // is the one this spec is about, so it takes its own field via the link.
  await menu.locator('.fl-wt-link').click()
  // By its name: a "Starts from" select (also `.fl-fmenu-input`) now sits
  // below it, so the branch field is no longer the menu's last input.
  const nameField = menu.locator('input[aria-label="Branch name"]')
  await expect(nameField).toHaveValue(SUGGESTED)

  // A REFUSAL, FIRST — and the field keeps every character of it. Two spaces in
  // a row is not a name a branch can have, and nothing repairs it into one.
  const refused = 'feature/export pipeline'
  await nameField.fill(refused)
  // The BRANCH's refusal — the folder's own problem element sits above it and
  // is hidden while the folder is fine.
  const problem = menu.locator('.fl-fmenu-problem').last()
  await expect(problem).toBeVisible()
  await expect(problem).toContainText('isn’t a name a branch can have')
  await expect(nameField, 'a typed name was rewritten instead of refused').toHaveValue(refused)
  // …and the chip still shows a branch that COULD exist — the refused string
  // never became the answer.
  await expect(newThreadChip(window)).toHaveText(SUGGESTED)

  // Then the name they actually want.
  await nameField.fill(TYPED)
  await expect(problem).toBeHidden()
  await nameField.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(newThreadChip(window)).toHaveText(TYPED)

  await window.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }).click()
  // The page is HIDDEN, not removed: its column is swapped back to the
  // conversation and the one instance is reused. Asserting a count here would
  // wait forever on an element that is always in the tree.
  await expect(window.locator('.fl-newthread')).toBeHidden({ timeout: 30_000 })

  // ── GIT IS THE ANSWER, not the chip's own sentence about itself ──────────

  await expect
    .poll(() => localBranches(project), { timeout: CUT_BUDGET_MS })
    .toContain(TYPED)
  expect(
    localBranches(project),
    'the SUGGESTED name was cut instead of the typed one',
  ).not.toContain(SUGGESTED)

  // The store catches up a moment after git does — the branch exists before the
  // record naming it is written — so this polls rather than reading once.
  await expect
    .poll(async () => (await threadsOf(window, project))[0]?.worktreeBranch, {
      timeout: CUT_BUDGET_MS,
    })
    .toBe(TYPED)
  const [thread] = await threadsOf(window, project)
  expect(registeredWorktrees(project)).toContain(thread.worktreePath)

  // ── 2. Renaming from the header chip ────────────────────────────────────

  // A BRANCH IS NOT RENAMED UNDER A RUNNING TURN, and main refuses it in so
  // many words. The description typed above IS the thread's first message, so
  // there is one in flight; with no credentials it ends quickly, and waiting
  // for it is what a person does too.
  await expect
    .poll(async () => (await threadsOf(window, project))[0]?.status, { timeout: CUT_BUDGET_MS })
    .not.toMatch(/^(working|needs-decision)$/)

  // THE TOOLBAR NEEDS SOMETHING TO REVIEW. The chip that renames the branch
  // lives in the Changes toolbar, and that toolbar is hidden when the review is
  // empty — deliberately ("a review with nothing to review shows no controls at
  // all"). A freshly cut worktree has no changes, so without this the chip is
  // rendered, correct, and invisible.
  writeFileSync(join(thread.worktreePath ?? '', 'renamed-from-chip.txt'), 'something to review\n')

  await openChangeReview(window)
  await expect(branchChip(window)).toContainText(TYPED, { timeout: 30_000 })
  await branchChip(window).click()
  const rename = window.locator('.fl-branch-rename')
  await expect(rename).toBeVisible()
  const renameField = rename.locator('.fl-branch-rename-input')
  await expect(renameField).toHaveValue(TYPED)

  // 3. The same refusal, on the other surface, in the same words — and the same
  //    promise: what was typed is what stays in the box.
  const badRename = 'feature/../escape'
  await renameField.fill(badRename)
  await rename.locator('.fl-branch-rename-confirm').click()
  const renameProblem = rename.locator('.fl-branch-rename-problem')
  await expect(renameProblem).toBeVisible()
  await expect(renameProblem).toContainText('isn’t a name a branch can have')
  await expect(renameField, 'a typed name was rewritten instead of refused').toHaveValue(badRename)
  // NOTHING MOVED: the refusal is a refusal in git too, not only on screen.
  expect(localBranches(project)).toContain(TYPED)

  await renameField.fill(RENAMED)
  await rename.locator('.fl-branch-rename-confirm').click()
  // A refusal keeps the box open, so read it out loud rather than timing out on
  // an element whose whole job is to still be there.
  await expect(renameProblem, await renameProblem.textContent() ?? '').toBeHidden({
    timeout: 30_000,
  })
  await expect(rename).toHaveCount(0, { timeout: 30_000 })

  await expect.poll(() => localBranches(project), { timeout: CUT_BUDGET_MS }).toContain(RENAMED)
  // …and the old name is gone rather than left behind beside it.
  expect(localBranches(project)).not.toContain(TYPED)
  await expect(branchChip(window)).toContainText(RENAMED, { timeout: 30_000 })
})

// ── 4: the carry question, dismissed ───────────────────────────────────────

test('dismissing the carry question makes nothing', async ({ window }) => {
  test.setTimeout(300_000)

  const project = await seedCommittedRepo(window, 'flow-carry-dismiss-')
  await activateProject(window, project)
  await settleWorktree(window, project)

  // Uncommitted work in the project itself — the ONLY state in which main
  // refuses to decide and asks.
  writeFileSync(join(project, 'README.md'), '# seeded\n\nhalf a thought\n')
  expect(git(project, 'status', '--porcelain')).toContain('README.md')

  const threadId = await window.evaluate(async (projectRoot: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const created = await flow.threads.create({ projectRoot, title: 'Working in the project' })
    return created.id as string
  }, project)

  const branchesBefore = localBranches(project)
  const worktreesBefore = registeredWorktrees(project)

  // The row's own menu — right-click, the way the app offers it.
  const row = window.locator('fl-list').getByText('Working in the project', { exact: true }).first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click({ button: 'right' })
  const rowMenu = window.locator('.fl-thread-menu')
  await expect(rowMenu).toBeVisible()
  await rowMenu.locator('.fl-thread-menu-item', { hasText: 'Give it its own branch' }).click()

  // THE QUESTION, in the menu rather than over it.
  const carry = window.locator('.fl-fmenu')
  await expect(carry).toBeVisible({ timeout: CUT_BUDGET_MS })
  // THE QUESTION IS THE EXPLANATION NOW. It carried a three-sentence paragraph
  // about what a worktree is and where it starts, in front of somebody who
  // asked to start working; the count moved into the question itself.
  await expect(carry.locator('.fl-fmenu-title')).toHaveText(/Bring your 1 file with you\?/)
  // TWO answers, not three: bring them, or do not. The middle one stashed —
  // a third outcome, a place to remember it, and a thing to undo later.
  await expect(carry.locator('.fl-fmenu-item')).toHaveCount(2)

  // …and then nobody answers it.
  await window.keyboard.press('Escape')
  await expect(carry).toHaveCount(0)

  // THE ABSENCE OF THE EFFECT. Not "no error was shown" — no branch, no
  // checkout, and the conversation is still working in the project's own files.
  await window.waitForTimeout(2000)
  expect(localBranches(project), 'a dismissal cut a branch').toEqual(branchesBefore)
  expect(registeredWorktrees(project), 'a dismissal made a checkout').toEqual(worktreesBefore)
  const after = (await threadsOf(window, project)).find((t) => t.id === threadId)
  expect(after?.worktreePath, 'a dismissal gave the thread files of its own').toBeNull()
  // The person's own uncommitted work is exactly where they left it.
  expect(git(project, 'status', '--porcelain')).toContain('README.md')
  expect(git(project, 'stash', 'list').trim()).toBe('')
})

// ── 5: the vocabulary ──────────────────────────────────────────────────────

/**
 * The four phrases this change removed from the running product.
 *
 * They are the ones a reader actually met: a status segment's menu item, a
 * settings section heading, a ledger's intro line, and the noun the delete
 * confirm used for a directory nobody had been told existed.
 */
const RETIRED = ['copy of the project', 'own copy', 'thread workspaces', 'copies of this project']

/**
 * WHAT IS *NOT* BANNED, AND WHY — read this before adding to the list above.
 *
 * `worktree` is deliberately absent. The four phrases above are euphemisms: they
 * described a directory to a reader who had never been told it existed, which is
 * what made them bad. The word `worktree` is the opposite — it is the real name
 * of the real thing, and the Worktrees panel exists precisely to let a person
 * manage them on purpose (user, 2026-09-16: "the idea was manage worktree").
 *
 * Adding it here would not tighten this rule; it would break a surface whose
 * whole job is to name the concept. If a euphemism creeps back in, add the
 * euphemism.
 */

/** Every user-visible string on screen: text, plus the titles and labels. */
function visibleStrings(): string[] {
  const out: string[] = []
  const body = document.body
  if (body === null) return out
  out.push(body.innerText ?? '')
  for (const el of Array.from(body.querySelectorAll('*')) as HTMLElement[]) {
    const title = el.getAttribute('title')
    if (title !== null && title !== '') out.push(title)
    const label = el.getAttribute('aria-label')
    if (label !== null && label !== '') out.push(label)
    if (el.shadowRoot !== null) out.push(el.shadowRoot.textContent ?? '')
  }
  return out
}

/** The phrases a sweep found. Empty means the product is clean. */
function offenders(strings: readonly string[]): string[] {
  const haystack = strings.join('\n').toLowerCase()
  return RETIRED.filter((phrase) => haystack.includes(phrase))
}

test('the retired vocabulary is nowhere on screen', async ({ window }) => {
  test.setTimeout(300_000)

  const project = await seedProject(window, 'flow-vocab-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'QA Bot'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    writeFileSync(join(dir, 'README.md'), '# seeded\n')
    execFileSync('git', ['add', 'README.md'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
  })
  await activateProject(window, project)

  const sweep = async (where: string): Promise<void> => {
    const found = offenders(await window.evaluate(visibleStrings))
    expect(found, `retired vocabulary on screen (${where})`).toEqual([])
  }

  // 1. The conversation list and the shell it sits in.
  await sweep('the shell')

  // 2. The new-thread page, with the branch chip's menu open — the surface that
  //    took over the two dialogs that used the words most.
  await openNewThreadPage(window)
  await window.locator('.fl-newthread-body').fill('Something to name a branch after')
  await newThreadChip(window).click()
  await expect(window.locator('.fl-fmenu')).toBeVisible()
  await sweep('the new-thread branch menu')
  await window.keyboard.press('Escape')
  await window.keyboard.press('Escape')

  // 3. Flow settings, including the section that used to be called by one of
  //    these names, and the page behind its one door.
  await window.evaluate((rootPath: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-flow-settings', { detail: { rootPath } }))
  }, project)
  const settings = window.locator('.fl-settings-overlay:not([hidden]):has(.fl-settings-section)')
  await expect(settings).toBeVisible({ timeout: 20_000 })
  await sweep('Flow settings')

  await settings.locator('.fl-fs-row', { hasText: 'Files kept for conversations' }).locator('button').click()
  await expect(window.locator('.fl-storage')).toBeVisible({ timeout: 30_000 })
  await expect(window.locator('.fl-storage-head')).toBeVisible({ timeout: 30_000 })
  await sweep('the Storage page')

  // ── THE NEGATIVE CONTROL ────────────────────────────────────────────────
  //
  // A matcher that finds nothing is indistinguishable from a matcher that
  // cannot find anything. So the same sweep is run once more with a near-miss
  // string put on screen on purpose; it MUST report it, and the sentence used
  // is one the product would genuinely have shown before this change.
  await window.evaluate(() => {
    const probe = document.createElement('div')
    probe.id = 'qa-vocab-probe'
    probe.textContent = 'This thread has its own copy of the project.'
    document.body.appendChild(probe)
  })
  const caught = offenders(await window.evaluate(visibleStrings))
  expect(caught.sort(), 'the sweep cannot see what it claims to look for').toEqual(
    ['copy of the project', 'own copy'].sort(),
  )
  await window.evaluate(() => document.getElementById('qa-vocab-probe')?.remove())

  // …and with the probe gone, clean again.
  await sweep('after the negative control')
})
