/**
 * UX sweep — flow 5 (Review), round 25: what the Phases panel's two DESTRUCTIVE
 * controls tell you before they destroy something.
 *
 * Why this was un-probed. Thirty-plus review specs drive the file list, the
 * approve toggle and its re-gate (#1052), approve↔stage sync (#857), commit
 * scope (#1051/#1432), the conflicted (#986) / deleted (#1181) / renamed
 * (#1182) states, the message-draft lifecycle (#282/#342/#1140/#1141), the ✨
 * wand (#1285/#1379/#1380) and every FAILURE toast (#73/#103/#1090/#1332/#1333).
 * Both destructive controls are covered too — that "Discard all" is two-step
 * (review.spec.ts), that its second click really reverts (#124/#136), what the
 * index looks like afterwards (#1090), that a project switch disarms it (#951),
 * that the reject prompt survives a background refresh (#182/#1379), that its
 * Cancel works (#697/#1018) and that it refuses without a thread (#397/#411).
 *
 * Nobody ever ran either control over a path git does NOT know at HEAD and read
 * what the app said. `ReviewService.reject` → `GitManager.revertFile` DELETES
 * such a path (`git rm --cached` + `git clean -fd`, #1054-scoped). So for an
 * untracked file — or a wholly-new directory, which git rolls up into ONE row —
 * "revert" is not what happens: the path is removed from disk permanently, and
 * there is no HEAD version to bring it back.
 *
 *   1. "Discard all" says `Discard N changes? Files revert to HEAD.` — one
 *      fixed string (review-panel.ts #confirmDiscardGroup) that is false for
 *      every untracked row in the set, never says the word delete, never says
 *      it can't be undone, and counts ROWS (a new directory of any size is 1).
 *
 *   2. The per-file ✕ Reject has NO confirm at all. Its prompt REPLACES the
 *      file's row, so the file it is about to destroy is not named anywhere on
 *      screen; the only copy is "Why reject? (feedback for the agent)"; and one
 *      click on `Redo` deletes the file — or the whole new directory — with no
 *      dialog and no toast.
 *
 * The sibling Changes view, one segmented-control click away, same repo, same
 * files, was given exactly this copy in #1054/#1144: it names the deletion
 * ("N untracked path(s) will be DELETED"), scopes it (".gitignore"d files are
 * kept), names the repo, and states irreversibility — for both the bulk action
 * AND every single-row discard.
 *
 * Credential-free: throwaway git repos + the project/review/git IPC. No
 * Claude account, no agent turn, no native OS dialog (the Phases confirm is
 * inline DOM; the Changes confirm is a `window.confirm` Playwright drives via
 * the `dialog` event).
 *
 * The LIVE tests hold before AND after a fix and are chosen so no tripwire can
 * pass vacuously: the rolled-up directory really is one row, Cancel really does
 * preserve the file, the discard really does destroy the new paths while
 * keeping ignored ones, and the sibling view's confirm really does carry the
 * deletion warning. The `test.fixme` tests are fix-agnostic tripwires that flip
 * green when each defect lands a fix.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED } from './fixtures/worktree'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** git round-trip + review:list + render, with headroom. */
const SETTLE_MS = 3500

const seeded: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/**
 * A repo holding all three working-tree shapes at once, built BEFORE the root
 * is handed to the app so the seed's own git calls can't race the watcher:
 *
 *   ` M tracked.ts`   — has a HEAD version; "revert to HEAD" is literally true
 *   `?? brandnew.ts`  — untracked FILE; discard/reject DELETES it
 *   `?? newdir/`      — wholly-new DIRECTORY, rolled up by git into ONE row;
 *                       discard deletes its contents (`.env` inside is ignored
 *                       via info/exclude, so `git clean -fd` must keep it, #1054)
 */
async function seedDiscardRepo(win: Page, tag: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `flow-ux-revdiscard-${tag}-`))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'Flow QA')
  // Keep the IDE's own scaffold out of git status (see fixtures/seed.ts), and
  // make newdir/.env an IGNORED path so `git clean -fd` must preserve it.
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\nnewdir/.env\n')
  writeFileSync(join(dir, 'tracked.ts'), 'export const v = 1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'baseline')

  writeFileSync(join(dir, 'tracked.ts'), 'export const v = 2\n')
  writeFileSync(join(dir, 'brandnew.ts'), 'a whole new file the agent wrote\n')
  mkdirSync(join(dir, 'newdir'), { recursive: true })
  writeFileSync(join(dir, 'newdir', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'newdir', 'b.ts'), 'export const b = 2\n')
  writeFileSync(join(dir, 'newdir', '.env'), 'SECRET=keep-me\n')

  seeded.push(dir)
  await win.evaluate(async (path) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path })
  }, dir)
  await activateProject(win, dir)
  return dir
}

/** Open Source Control → Phases (the folded-in review surface, #335). */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await win.waitForTimeout(SETTLE_MS)
}

/** Open Source Control → Changes (the sibling view). */
async function openChanges(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Changes' }).click()
  await win.waitForTimeout(SETTLE_MS)
}

/** A thread must be selected for reject to get past #397's guard. Made
 *  directly and opened by its row — "+" opens the new-thread page, whose Create
 *  sends a first message. */
async function selectThread(win: Page): Promise<void> {
  // In the project the spec just seeded and activated.
  const projectRoot = await win.evaluate(async () => {
    const context = await (
      window as unknown as { flow: { project: { active(): Promise<{ rootPath: string } | null> } } }
    ).flow.project.active()
    return context?.rootPath ?? ''
  })
  await openEmptyThread(win, projectRoot)
  await expect(win.locator(sel.composer)).toBeVisible()
  await win.waitForTimeout(1200)
}

/** Every rendered review row's state letter + path. */
function rows(win: Page): Promise<Array<{ state: string | null; name: string | null }>> {
  return win.evaluate(() =>
    [...document.querySelectorAll('.fl-review-file')].map((row) => ({
      state: row.querySelector('.fl-review-state')?.textContent ?? null,
      name: row.querySelector('.fl-review-file-name')?.textContent ?? null,
    })),
  )
}

/** The inline "Discard N?" confirm's own sentence, or null when not armed. */
function discardConfirmText(win: Page): Promise<string | null> {
  return win.evaluate(
    () => document.querySelector('.fl-review-discard-label')?.textContent ?? null,
  )
}

/** Everything the open reject prompt shows the user (visible text + placeholder). */
function rejectPromptCopy(win: Page): Promise<string | null> {
  return win.evaluate(() => {
    const prompt = document.querySelector('.fl-review-reject-prompt') as HTMLElement | null
    if (prompt === null) return null
    const placeholder = prompt.querySelector('input')?.getAttribute('placeholder') ?? ''
    return `${prompt.innerText} ${placeholder}`.trim()
  })
}

/** Arm the first group's inline two-step discard confirm. */
async function armDiscard(win: Page): Promise<void> {
  await win.locator('.fl-review-discard-btn').first().click()
  await win.waitForTimeout(600)
}

/** Open the ✕ reject prompt on the row naming `file`. */
async function openReject(win: Page, file: string): Promise<void> {
  const row = win.locator('.fl-review-file').filter({ hasText: file })
  await expect(row.first()).toBeVisible({ timeout: 15_000 })
  await row.first().locator('.fl-review-reject').click()
  await expect(win.locator('.fl-review-reject-prompt').first()).toBeVisible()
}

/** The discovery prompt a freshly-seeded project raises is unrelated noise that
 *  would make any "did the app say anything" assertion pass vacuously. */
async function dismissDiscoveryPrompt(win: Page): Promise<void> {
  const notNow = win.locator('.fl-flow-toast button').filter({ hasText: 'Not now' })
  for (let i = 0; i < 3; i += 1) {
    if ((await notNow.count()) === 0) return
    await notNow.first().click().catch(() => undefined)
    await win.waitForTimeout(400)
  }
}

/** Record every `window.confirm` (and never let one fire the destruction). */
function captureDialogs(win: Page): string[] {
  const messages: string[] = []
  win.on('dialog', (dialog) => {
    messages.push(dialog.message())
    void dialog.dismiss()
  })
  return messages
}

const porcelain = (dir: string): string => git(dir, 'status', '--porcelain').trim()


// Redo sends a real message to the thread's agent — never to the developer's account.
test.use({ appEnv: AGENT_AUTH_ISOLATED })
test.afterAll(() => cleanupSeeds())

test.describe('Review (Phases): what the destructive controls say vs what they destroy', () => {
  // ---------------------------------------------------------------- LIVE ----

  test('LIVE: a wholly-new directory is ONE row, and the two-step confirm arms', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    const dir = await seedDiscardRepo(win, 'shape')
    await openReview(win)
    await dismissDiscoveryPrompt(win)

    const listed = await rows(win)
    const names = listed.map((row) => row.name)
    // git rolls the brand-new directory up: newdir/a.ts + newdir/b.ts are ONE
    // `??` row. This is the shape the confirm's count is computed from.
    expect(names, `panel rows: ${JSON.stringify(listed)}`).toContain('newdir/')
    expect(names).toContain('brandnew.ts')
    expect(names).toContain('tracked.ts')
    expect(names).not.toContain('newdir/a.ts')

    // Destructive → two-step. The first click must ARM, never act.
    const before = porcelain(dir)
    await armDiscard(win)
    const confirm = await discardConfirmText(win)
    expect(confirm, 'the first Discard all click must arm an inline confirm').not.toBeNull()
    expect(porcelain(dir), 'arming must not touch the working tree').toBe(before)
    await win.screenshot({ path: join(SHOTS, 'review-discard-confirm-copy.png') })

    // eslint-disable-next-line no-console
    console.log('[probe] Phases confirm =', JSON.stringify(confirm))
    expect(errors).toEqual([])
  })

  test('LIVE: the sibling Changes view warns that untracked paths are DELETED (#1054)', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    await seedDiscardRepo(win, 'sibling')
    await openChanges(win)
    await dismissDiscoveryPrompt(win)

    const messages = captureDialogs(win)
    await win
      .locator('button')
      .filter({ hasText: /Discard all|Revert all/ })
      .first()
      .click()
    await win.waitForTimeout(1200)

    expect(messages.length, 'the Changes bulk discard must confirm').toBeGreaterThan(0)
    const copy = messages.join(' | ')
    // eslint-disable-next-line no-console
    console.log('[probe] Changes confirm =', JSON.stringify(copy))
    // This is the bar the sibling surface already meets (#1054): the deletion is
    // named, its scope is named, and irreversibility is stated.
    expect(copy).toMatch(/DELETED/)
    expect(copy).toMatch(/gitignore/i)
    expect(copy).toMatch(/can't be undone/i)
    expect(errors).toEqual([])
  })

  test('LIVE: firing Discard all really destroys the new paths (and keeps ignored ones)', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    const dir = await seedDiscardRepo(win, 'fire')
    await openReview(win)
    await dismissDiscoveryPrompt(win)

    await armDiscard(win)
    await win.locator('.fl-review-discard-btn.confirm').first().click()
    await win.waitForTimeout(SETTLE_MS * 2)

    // The tracked file came back from HEAD — for THIS row the copy was true.
    expect(existsSync(join(dir, 'tracked.ts'))).toBe(true)
    // The new paths are gone from disk. There is no HEAD version to restore.
    expect(existsSync(join(dir, 'brandnew.ts')), 'untracked file was deleted').toBe(false)
    expect(existsSync(join(dir, 'newdir', 'a.ts')), 'new directory content deleted').toBe(false)
    // …but the ignored file inside it survives (#1054's scoping, review side).
    expect(existsSync(join(dir, 'newdir', '.env')), 'ignored file must survive').toBe(true)
    expect(errors).toEqual([])
  })

  test('LIVE: Cancel on the ✕ reject prompt leaves the untracked file untouched (#697)', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    const dir = await seedDiscardRepo(win, 'cancel')
    await selectThread(win)
    await openReview(win)
    await dismissDiscoveryPrompt(win)

    await openReject(win, 'brandnew.ts')
    const copy = await rejectPromptCopy(win)
    // eslint-disable-next-line no-console
    console.log('[probe] reject prompt copy =', JSON.stringify(copy))
    await win.screenshot({ path: join(SHOTS, 'review-reject-untracked-prompt.png') })

    await win.locator('.fl-review-reject-prompt button').filter({ hasText: 'Cancel' }).click()
    await win.waitForTimeout(SETTLE_MS)
    expect(existsSync(join(dir, 'brandnew.ts')), 'Cancel must never destroy the file').toBe(true)
    expect(errors).toEqual([])
  })

  test('LIVE: ✕ Redo on a never-committed file deletes it with no OS-level confirm', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    const dialogs = captureDialogs(win)
    const dir = await seedDiscardRepo(win, 'redo')
    await selectThread(win)
    await openReview(win)
    await dismissDiscoveryPrompt(win)

    await openReject(win, 'brandnew.ts')
    await win.locator('.fl-review-reject-prompt input').fill('wrong approach')
    await win.locator('.fl-review-reject-prompt button').filter({ hasText: 'Redo' }).click()
    await win.waitForTimeout(SETTLE_MS)

    // The destruction itself is the documented behaviour of reject (revert +
    // agent redo) — asserted here so the tripwires below can never pass because
    // the action silently stopped working.
    expect(existsSync(join(dir, 'brandnew.ts')), 'reject reverts/deletes the file').toBe(false)
    // eslint-disable-next-line no-console
    console.log('[probe] dialogs during reject =', JSON.stringify(dialogs))
    await win.screenshot({ path: join(SHOTS, 'review-reject-untracked-after.png') })
    expect(errors).toEqual([])
  })

  // ------------------------------------------------------------- TRIPWIRE ----

  test(
    'the Discard all confirm must say untracked paths are DELETED, not "revert to HEAD"',
    async ({ window: win }) => {
      await seedDiscardRepo(win, 'copy')
      await openReview(win)
      await dismissDiscoveryPrompt(win)
      await armDiscard(win)

      const confirm = (await discardConfirmText(win)) ?? ''
      // The set contains two untracked paths. "Files revert to HEAD" is false
      // for both; the sentence must name the deletion, as #1054 does one click
      // away in the Changes view.
      expect(confirm, `Phases confirm: ${JSON.stringify(confirm)}`).toMatch(/delete/i)
      expect(confirm).not.toMatch(/revert to HEAD\.?$/)
    },
  )

  test(
    'the Discard all confirm must state that the discard cannot be undone',
    async ({ window: win }) => {
      await seedDiscardRepo(win, 'undo')
      await openReview(win)
      await dismissDiscoveryPrompt(win)
      await armDiscard(win)

      const confirm = (await discardConfirmText(win)) ?? ''
      expect(confirm).toMatch(/can't be undone|cannot be undone/i)
    },
  )

  test(
    'the Discard all count must not under-report a rolled-up new directory',
    async ({ window: win }) => {
      const dir = await seedDiscardRepo(win, 'count')
      await openReview(win)
      await dismissDiscoveryPrompt(win)
      await armDiscard(win)

      const confirm = (await discardConfirmText(win)) ?? ''
      // 3 rows, but 5 paths are affected (tracked.ts reverted; brandnew.ts,
      // newdir/a.ts, newdir/b.ts deleted). The user is told "3".
      const onDisk = [
        'tracked.ts',
        'brandnew.ts',
        'newdir/a.ts',
        'newdir/b.ts',
      ].filter((path) => existsSync(join(dir, path))).length
      expect(onDisk).toBe(4)
      expect(confirm).not.toMatch(/Discard 3 changes\?/)
    },
  )

  test(
    'the ✕ reject prompt must name the file it is about to destroy',
    async ({ window: win }) => {
      await seedDiscardRepo(win, 'named')
      await selectThread(win)
      await openReview(win)
      await dismissDiscoveryPrompt(win)
      await openReject(win, 'brandnew.ts')

      const copy = (await rejectPromptCopy(win)) ?? ''
      expect(copy, `reject prompt copy: ${JSON.stringify(copy)}`).toContain('brandnew.ts')
    },
  )

  test(
    'rejecting a never-committed file must warn that it will be deleted',
    async ({ window: win }) => {
      const dialogs = captureDialogs(win)
      const dir = await seedDiscardRepo(win, 'warn')
      await selectThread(win)
      await openReview(win)
      await dismissDiscoveryPrompt(win)
      await openReject(win, 'brandnew.ts')

      const copy = (await rejectPromptCopy(win)) ?? ''
      await win.locator('.fl-review-reject-prompt button').filter({ hasText: 'Redo' }).click()
      await win.waitForTimeout(SETTLE_MS)

      // Either the inline prompt names the deletion up front, or a confirm gates
      // it the way the sibling Changes view's single-row discard does (#1054).
      const gatedByDialog = dialogs.some((text) => /delete/i.test(text))
      const warnedInline = /delete/i.test(copy)
      expect(
        warnedInline || gatedByDialog,
        `prompt copy ${JSON.stringify(copy)} / dialogs ${JSON.stringify(dialogs)}`,
      ).toBe(true)
      // The two branches settle differently, and the difference is the point.
      //
      // A DIALOG gate is a question asked after the click, and Playwright
      // dismisses it — a dismissed warning must leave the file alone.
      //
      // The INLINE warning (#1476, the shape the issue's own suggested fix
      // describes, and the panel's own idiom for the group discard since #124)
      // is on screen BEFORE the click, on a button that reads "Delete & redo".
      // The click IS the informed confirmation, so the file is gone — that is
      // the action working, not a missing gate. Cancel is the back-out, and
      // the LIVE spec above guards that it preserves the file.
      expect(existsSync(join(dir, 'brandnew.ts'))).toBe(gatedByDialog)
    },
  )
})
