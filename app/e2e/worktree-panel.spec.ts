/**
 * THE WORKTREE PANEL, END TO END.
 *
 * Every assertion here is a thing that was reported broken on screen and could
 * not be caught by a unit test, because each failure was in the wiring rather
 * than in a decision:
 *
 *  1. The switch reports whether THIS conversation has a copy — decided by
 *     comparing its path with the project's, not by asking git.
 *  2. Turning it on actually makes one. It did not: the panel called the
 *     channel and discarded the answer, so a dirty project tree returned
 *     `needs-choice` to nobody and the press did nothing.
 *  3. Turning it on with a DIRTY tree asks the carry question and survives
 *     being asked. The panel repainted itself while that question was open,
 *     destroying the element it was anchored to — the menu closed before it
 *     could be read and the switch fell back. On screen: a blink.
 *  4. The explorer names which copy it is showing.
 */
import { expect, test } from './fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './ux/fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.afterAll(() => {
  cleanupSeeds()
})

const SWITCH = '.fl-wt-track'
const STATE = '.fl-wt-state'

/** A project with one committed file and a thread in it. */
async function seed(win: import('@playwright/test').Page, prefix: string, dirty: boolean) {
  const root = await seedProject(win, prefix, (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
    if (dirty) writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
  })
  await activateProject(win, root)
  const threadId = await win.evaluate(async (projectRoot: string) => {
    const flow = (window as unknown as {
      flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> } }
    }).flow
    return (await flow.threads.create({ projectRoot, title: 'Worktree panel spec' })).id
  }, root)
  return { root, threadId }
}


/**
 * Turn the switch on and answer the naming ask.
 *
 * TURNING IT ON IS TWO STEPS NOW. The press opens a field with the name already
 * filled in from the conversation's title; Create cuts the copy (user,
 * 2026-09-17: "that didn't ask the name of the worktree"). Passing `name`
 * types a different one; passing '' clears the field, which is how a person
 * asks for a detached checkout named later.
 */
async function turnOn(win: import('@playwright/test').Page, name?: string) {
  await win.locator(SWITCH).click()
  const ask = win.locator('.fl-wt-ask')
  await expect(ask).toBeVisible({ timeout: 30_000 })
  // ONE FIELD: the folder's stem, which the branch follows. `name` sets it —
  // '' is how a test asks for a detached checkout named from the title later.
  if (name !== undefined) await ask.locator('input[type="text"]').first().fill(name)
  await ask.locator('button', { hasText: 'Create' }).click()
  await expect(win.locator(SWITCH)).toHaveAttribute('data-on', 'true', { timeout: 120_000 })
}

/**
 * Open the conversation and show the explorer. The panel is simply there.
 *
 * NOTHING IS PRESSED TO REVEAL IT. It was a rail item, then a control on the
 * project row that opened a popover, and both were a door in front of a thing
 * that has no reason to be behind one (user, 2026-09-17: "the user should not
 * have to click, lets always show it"). It now sits at the top of the files
 * pane whenever a conversation is open in a project.
 */
async function openPanel(win: import('@playwright/test').Page, threadId: string) {
  await win.evaluate((id: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
  }, threadId)
  await win.locator('[data-rail-item="files"]').click()
  await expect(win.locator(SWITCH)).toBeVisible({ timeout: 30_000 })

  // AND IT HAS REAL SIZE. The panel's CSS was written for the rail pane it used
  // to fill (`height:100%`), and inside a popover — whose height comes from its
  // content — 100% of nothing is nothing. A panel that opens as a sliver is
  // indistinguishable from one that does not open at all.
  const box = await win.locator('.fl-wt').boundingBox()
  expect(box, 'the worktree panel opened with no size').not.toBeNull()
  if (box !== null) {
    expect(box.height).toBeGreaterThan(40)
    expect(box.width).toBeGreaterThan(160)
  }

  // AND IT IS INSIDE THE EXPLORER, WHERE IT CANNOT BE MISPLACED.
  //
  // It used to float: an anchored popover over the app. A popover is a promise
  // about coordinates, and this one broke it three different ways — a styling
  // class with no CSS left it statically positioned and it rendered off the
  // bottom of the window, which every size-and-visibility assertion here
  // happily passed. Docked into the files pane there are no coordinates to get
  // wrong: it is in the pane, above the tree, or it is nowhere.
  const placed = await win.evaluate(() => {
    const panel = document.querySelector('.fl-wt')
    const pane = document.querySelector('.fl-sidebar-files')
    if (panel === null || pane === null) return null
    const p = panel.getBoundingClientRect()
    const q = pane.getBoundingClientRect()
    return {
      insidePane: pane.contains(panel),
      withinPaneBox: p.top >= q.top - 1 && p.bottom <= q.bottom + 1 && p.left >= q.left - 1,
      inViewport:
        p.top >= 0 && p.left >= 0 && p.bottom <= window.innerHeight && p.right <= window.innerWidth,
    }
  })
  expect(placed, 'the worktree panel is not in the document').not.toBeNull()
  if (placed !== null) {
    expect(placed.insidePane, 'the panel is not inside the files pane').toBe(true)
    expect(placed.withinPaneBox, 'the panel is drawn outside the pane it docks in').toBe(true)
    expect(placed.inViewport, 'the worktree panel opened outside the window').toBe(true)
  }
}

test('the rail carries only sidebar surfaces, and the editor carries the view openers', async ({
  window,
}) => {
  test.setTimeout(120_000)
  // Three surfaces. Worktree is NOT among them — it moved onto the explorer's
  // project row, beside the branch name it was always reporting — and neither
  // is Search, which moved INTO the files pane on 2026-09-18.
  for (const item of ['threads', 'files', 'source-control']) {
    await expect(window.locator(`[data-rail-item="${item}"]`)).toBeVisible({ timeout: 30_000 })
  }
  await expect(window.locator('[data-rail-item="worktrees"]')).toHaveCount(0)
  await expect(window.locator('[data-rail-item="search"]')).toHaveCount(0)
  // …and the four that open a tab live where the tabs are.
  for (const action of ['tasks', 'blueprint', 'browser', 'terminal']) {
    await expect(window.locator(`[data-view-action="${action}"]`)).toBeVisible({ timeout: 30_000 })
  }
  // The row survives an empty editor — it is how the first tab gets opened.
  const bar = window.locator('.fl-editor-topbar')
  await expect(bar).toBeVisible()

  // AND THEY DO NOT MOVE. With no tabs open the strip beside them is
  // display:none and takes no space, so the icons used to sit at the LEFT edge
  // and jump right the moment a tab appeared.
  const barBox = await bar.boundingBox()
  const actionsBox = await window.locator('.fl-editor-actions').boundingBox()
  expect(barBox).not.toBeNull()
  expect(actionsBox).not.toBeNull()
  if (barBox !== null && actionsBox !== null) {
    const gapFromRight = barBox.x + barBox.width - (actionsBox.x + actionsBox.width)
    expect(gapFromRight, 'the view controls are not against the right edge').toBeLessThan(24)
  }
})

test('a conversation working in the project reads Off, and one press makes a copy', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { threadId } = await seed(window, 'flow-wt-panel-clean-', false)
  await openPanel(window, threadId)

  // OFF, decided from the thread's own path — no inventory, no git.
  await expect(window.locator(STATE)).toContainText('Off')
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'false')

  // THE PRESS ASKS FOR A NAME, filled in from the conversation's title — it
  // used to cut the copy on the press and name it later, which read as the app
  // doing something irreversible without a word.
  await window.locator(SWITCH).click()
  const naming = window.locator('.fl-wt-ask')
  await expect(naming).toBeVisible({ timeout: 30_000 })
  // ONE FIELD, PREFIX SHOWN: the typed stem names the folder, and the branch
  // follows it on a muted line. The link is what splits them into two.
  await expect(naming.locator('input[type="text"]')).toHaveCount(1)
  await expect(naming.locator('.fl-wt-fixed')).toHaveText('worktree/')
  // Still Off while it is being answered — armed is not on.
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'false')

  // EMPTY IS AN ANSWER: cut it detached, named later from the title. A clean
  // tree has nothing to carry, so nothing else is asked.
  // Emptied: no branch cuts detached, and the folder falls back to the title.
  await naming.locator('input[type="text"]').first().fill('')
  await naming.locator('button', { hasText: 'Create' }).click()

  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true', { timeout: 120_000 })
  // THE KNOB SAYS ON (asserted above); the line that used to say it again is
  // gone, and the FOLDER has its place. The name field was cleared, so the
  // folder came from the conversation's title — and it wears the prefix, which
  // is the whole point of showing it (2026-09-18).
  await expect(window.locator(STATE)).toHaveCount(0)
  await expect(window.locator('.fl-wt-branch')).toContainText('worktree/')

  // AND GIT AGREES — the switch is not reporting its own hope.
  const path = await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: { threads: { get(r: { threadId: string }): Promise<{ worktreePath: string | null } | null> } }
    }).flow
    return (await flow.threads.get({ threadId: id }))?.worktreePath ?? null
  }, threadId)
  expect(path, 'the switch said On but no worktree was recorded').not.toBeNull()
})

test('a dirty project asks what to do with the work, and survives being asked', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { threadId } = await seed(window, 'flow-wt-panel-dirty-', true)
  await openPanel(window, threadId)
  await expect(window.locator(STATE)).toContainText('Off')

  // Name it first — the carry question comes after, from main.
  await window.locator(SWITCH).click()
  const naming = window.locator('.fl-wt-ask')
  await expect(naming).toBeVisible({ timeout: 30_000 })
  await naming.locator('button', { hasText: 'Create' }).click()

  // THE QUESTION STAYS OPEN, and it is asked BY the panel rather than by a menu
  // of its own. It used to be a nested anchored popover — one menu inside
  // another, where the inner one's overlay closed the outer and took the
  // question with it. On screen that was a blink and no worktree.
  const ask = window.locator('.fl-wt-ask')
  await expect(ask, 'the carry question closed before it could be answered').toBeVisible({
    timeout: 60_000,
  })
  // Still Off while the question is open — armed is not on.
  await expect(window.locator(STATE)).toContainText('Off')

  // Answer it with the option that moves nothing — the second of the two.
  await ask.locator('.fl-wt-carry').last().click()

  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true', { timeout: 120_000 })
})

test('the explorer names the PROJECT — the branch is on the panel above it', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { root, threadId } = await seed(window, 'flow-wt-panel-name-', false)
  const project = root.split('/').pop() ?? ''

  // WITH A BRANCH, WHICH IS THE ONLY CASE THAT PROVES ANYTHING.
  //
  // This used to press the switch, which cuts a DETACHED checkout — and a
  // detached checkout has no branch to put in parentheses, so the assertion
  // below passed against the old naming rule too. A test that cannot fail for
  // the thing it is named after is not a test (2026-09-17).
  await window.evaluate(
    async ({ id, branch }: { id: string; branch: string }) => {
      const flow = (window as unknown as {
        flow: {
          threads: {
            prepareWorktree(r: {
              threadId: string
              branch: string
              requested: boolean
              carry: string
            }): Promise<unknown>
          }
        }
      }).flow
      await flow.threads.prepareWorktree({ threadId: id, branch, requested: true, carry: 'clean' })
    },
    { id: threadId, branch: 'worktree/named-in-the-tree' },
  )
  await openPanel(window, threadId)
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true', { timeout: 120_000 })
  // THE BRANCH IS NOT ON THIS PANEL ANY MORE (2026-09-18: "dont need to have
  // the branch name here, only the worktree"). The one row names the FOLDER —
  // and this checkout was made with a branch and NO folder name, so it proves
  // the other half too: a name nobody typed is taken from the conversation's
  // title rather than left as the thread's id.
  // ONE ROW, AND IT IS THE NAME ITSELF — no `Folder` label in front of a name
  // that opens with the word, under a switch called Worktree (2026-09-18).
  const row = window.locator('.fl-wt-branch')
  await expect(row).toHaveText('worktree/worktree-panel-spec')
  await expect(row, 'the branch came back onto the worktree panel').not.toContainText(
    'named-in-the-tree',
  )

  // THE TREE, NOT THE PANEL. Both live in the files pane now, so this reads the
  // tree itself rather than the pane that also contains the worktree panel.
  // THE TREE'S OWN LIST. The files pane also holds the search panel's list now,
  // and it comes first — `.fl-sidebar-files fl-list` used to mean one thing.
  const files = window.locator('.fl-files-tree fl-list').first()
  await expect(files).toContainText(project, { timeout: 30_000 })
  // AND NOTHING IN PARENTHESES. The row carried the branch back when reading it
  // there was the only way to know a conversation was isolated. The panel sits
  // two lines above it and says so, so the suffix became a second answer to an
  // answered question — while eating the width the project's own name needs.
  await expect(files).not.toContainText('(')
})

test('turning it on covers EVERY project the conversation carries', async ({ window }) => {
  test.setTimeout(300_000)
  // THE BUG THIS PINS. `prepare` answered `ready` from the primary checkout
  // alone, and only the CUT path prepared the attached projects — so a project
  // added AFTER a conversation was isolated stayed in the real files for ever,
  // under a switch reading On. On screen: `orbit-core — still your main folder`
  // (user, 2026-09-17: "if the worktree is enabled, is enabled for all the
  // projects on that thread").
  const { threadId } = await seed(window, 'flow-wt-panel-all-a-', false)
  await openPanel(window, threadId)
  await turnOn(window)

  // A second project joins the conversation AFTER it was isolated.
  const second = await seedProject(window, 'flow-wt-panel-all-b-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
  })
  await window.evaluate(
    async ({ id, r }: { id: string; r: string }) => {
      const flow = (window as unknown as {
        flow: { threads: { setRoots(x: { threadId: string; roots: string[] }): Promise<unknown> } }
      }).flow
      await flow.threads.setRoots({ threadId: id, roots: [r] })
    },
    { id: threadId, r: second },
  )

  // Asking for the thread scope again is what a turn does, and it must now cover
  // the newcomer rather than answering "ready" for the one project it knew.
  const copies = await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: {
        threads: { prepareWorktree(r: { threadId: string; requested: boolean }): Promise<unknown> }
        project: { getThreadScope(): Promise<{ list: Array<{ threadCopy?: boolean }> }> }
      }
    }).flow
    await flow.threads.prepareWorktree({ threadId: id, requested: true })
    const scope = await flow.project.getThreadScope()
    return scope.roots.map((r) => r.threadCopy === true)
  }, threadId)

  // The positive first: the conversation really does carry two projects…
  expect(copies.length).toBe(2)
  // …and BOTH of them are copies.
  expect(copies).toEqual([true, true])
})

test('a fresh worktree has no branch yet, so removing it is a plain second press', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { threadId } = await seed(window, 'flow-wt-panel-rm-', false)
  await openPanel(window, threadId)
  // EMPTY NAME → DETACHED, which is what this test is about.
  await turnOn(window, '')

  // DETACHED, BECAUSE THE NAME FIELD WAS LEFT EMPTY — and the folder still has
  // a name, taken from the conversation's title. (The confirm must not demand a
  // branch that does not exist — it did, and `Remove` stayed disabled for ever.)
  await expect(window.locator('.fl-wt-branch')).toContainText('worktree/')

  await window.locator(SWITCH).click()
  const confirm = window.locator('.fl-wt-ask')
  await expect(confirm).toBeVisible({ timeout: 30_000 })
  // NOTHING TO TYPE, ANY MORE, EVER. The confirmation used to demand the branch
  // name transcribed — which a detached worktree does not have, so `Remove`
  // stayed disabled for ever and the panel could make worktrees it could never
  // remove. The ask now says what is deleted and what survives.
  await expect(confirm.locator('input')).toHaveCount(0)
  await expect(confirm).toContainText('folder is deleted')

  const remove = confirm.locator('button', { hasText: 'Delete' })
  await expect(remove, 'a detached worktree could not be removed at all').toBeEnabled()
  await remove.click()

  // Gone for real — asked of the record, not of the switch's own opinion.
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'false', { timeout: 120_000 })
  const path = await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: { threads: { get(r: { threadId: string }): Promise<{ worktreePath: string | null } | null> } }
    }).flow
    return (await flow.threads.get({ threadId: id }))?.worktreePath ?? null
  }, threadId)
  expect(path, 'the switch said Off but the worktree record survived').toBeNull()
})

test('the button says it is working while the copy is being cut', async ({ window }) => {
  test.setTimeout(300_000)
  const { threadId } = await seed(window, 'flow-wt-panel-busy-', false)
  await openPanel(window, threadId)
  await window.locator(SWITCH).click()
  const ask = window.locator('.fl-wt-ask')
  await expect(ask).toBeVisible({ timeout: 30_000 })

  // `git worktree add` on a real repository takes seconds, and the panel
  // deliberately does NOT repaint while a verb is in flight (a repaint destroys
  // the elements an open question is anchored to). So the switch's "Setting it
  // up…" line never reached the screen, and the pressed button sat there
  // looking untouched (user, 2026-09-17).
  const create = ask.locator('button', { hasText: 'Create' })
  await create.click()
  const working = ask.locator('button[data-working="true"]')
  await expect(working).toHaveText(/Creating/, { timeout: 5_000 })
  await expect(working).toBeDisabled()
  // The way out goes with it: cancelling cannot stop a checkout already being cut.
  await expect(ask.locator('button', { hasText: 'Cancel' })).toBeDisabled()

  // …and it finishes, rather than staying stuck on the busy state.
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true', { timeout: 120_000 })
  await expect(window.locator('.fl-wt-ask')).toHaveCount(0)
})

test('the removal says what is deleted and what survives, and asks for no typing', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { threadId } = await seed(window, 'flow-wt-panel-named-', false)
  // Named at the cut, which is the path the new-thread chip takes.
  const BRANCH = 'feature/named-copy'
  await window.evaluate(
    async ({ id, branch }: { id: string; branch: string }) => {
      const flow = (window as unknown as {
        flow: {
          threads: {
            prepareWorktree(r: {
              threadId: string
              branch: string
              requested: boolean
              carry: string
            }): Promise<unknown>
          }
        }
      }).flow
      await flow.threads.prepareWorktree({
        threadId: id,
        branch,
        requested: true,
        carry: 'clean',
      })
    },
    { id: threadId, branch: BRANCH },
  )
  await openPanel(window, threadId)
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true', { timeout: 120_000 })
  // The branch is not on this panel; the checkout it made is what it reports.
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true')

  await window.locator(SWITCH).click()
  const confirm = window.locator('.fl-wt-ask')
  await expect(confirm).toBeVisible({ timeout: 30_000 })

  // THE CONSEQUENCE, IN THE TERMS OF THE THING ON SCREEN. Typing the branch
  // name was guarding the one part a removal does NOT destroy; what is at risk
  // is what is in the folder and uncommitted, and only saying so protects it.
  await expect(confirm).toContainText('folder is deleted')
  await expect(confirm).toContainText('haven’t committed')
  // …and the branch is named as surviving, which is what makes that credible.
  await expect(confirm).toContainText(BRANCH)
  await expect(confirm.locator('input')).toHaveCount(0)

  // STILL NOT ONE CLICK: the switch armed the question, the question acts.
  await expect(confirm.locator('button', { hasText: 'Delete' })).toBeEnabled()
  await expect(confirm.locator('button', { hasText: 'Cancel' })).toBeEnabled()
})

test('cancelling the removal leaves the worktree exactly where it was', async ({ window }) => {
  test.setTimeout(300_000)
  const { threadId } = await seed(window, 'flow-wt-panel-cancel-', false)
  await openPanel(window, threadId)
  await turnOn(window)

  await window.locator(SWITCH).click()
  const confirm = window.locator('.fl-wt-ask')
  await expect(confirm).toBeVisible({ timeout: 30_000 })
  // ARMED IS NOT OFF — the switch still reports what is true while the question
  // is open, and what is true is that the worktree still exists.
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true')
  await confirm.locator('button', { hasText: 'Cancel' }).click()

  await expect(confirm).toHaveCount(0)
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true')
  const path = await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: { threads: { get(r: { threadId: string }): Promise<{ worktreePath: string | null } | null> } }
    }).flow
    return (await flow.threads.get({ threadId: id }))?.worktreePath ?? null
  }, threadId)
  expect(path, 'cancelling removed the worktree anyway').not.toBeNull()
})

test('a conversation with a worktree carries the worktree glyph in the sidebar', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { threadId } = await seed(window, 'flow-wt-panel-mark-', false)
  await openPanel(window, threadId)
  await turnOn(window)

  // The positive first: the conversation IS in the list…
  await window.locator('[data-rail-item="threads"]').click()
  const row = window.locator('.fl-sidebar-threads').getByText('Worktree panel spec').first()
  await expect(row).toBeVisible({ timeout: 30_000 })

  // …and it is marked with the SAME glyph the panel is about, not with a colour
  // in the gutter that works only once somebody has explained it.
  const glyph = window.locator('.fl-sidebar-threads fl-icon[name="checkouts"]').first()
  await expect(glyph).toBeVisible({ timeout: 30_000 })

  // AND THE RAIL SAYS IT TOO. The Files item opens a tree whose contents change
  // entirely depending on the answer, and it drew the same folder either way.
  await expect(
    window.locator('[data-rail-item="files"] fl-icon[name="checkouts"]'),
  ).toHaveCount(1, { timeout: 30_000 })

  // ONE MARK, NOT TWO. A thread with a copy AND other projects in reach used to
  // draw a worktree glyph beside a projects badge — two marks for one cluster,
  // on exactly the rows whose titles could least afford the width.
  const marks = await window.evaluate(() => {
    const row = document
      .querySelector('.fl-sidebar-threads')
      ?.querySelectorAll('fl-icon[name="checkouts"], fl-icon[name="folder"]')
    return row?.length ?? 0
  })
  expect(marks, 'the row carries more than one context mark').toBeLessThanOrEqual(1)
})

test('a thread carrying two projects still has the worktree control', async ({ window }) => {
  test.setTimeout(300_000)
  // THE SHAPE THE FIXTURES NEVER HAD. Every other test here seeds ONE project,
  // and the explorer draws a depth-0 row two different ways: a plain row for a
  // single root, a SECTION HEADER once a thread carries more than one. The
  // control was only on the first, so it was missing for exactly the people the
  // multi-project worktree work was built for — nine green tests and a user
  // looking at a row with no button on it (2026-09-17).
  const { threadId } = await seed(window, 'flow-wt-panel-multi-a-', false)
  const second = await seedProject(window, 'flow-wt-panel-multi-b-', (dir) => {
    execFileSync('git', ['init', '-q'], { cwd: dir })
  })
  await window.evaluate(
    async ({ id, root }: { id: string; root: string }) => {
      const flow = (window as unknown as {
        flow: { threads: { setRoots(r: { threadId: string; roots: string[] }): Promise<unknown> } }
      }).flow
      await flow.threads.setRoots({ threadId: id, roots: [root] })
    },
    { id: threadId, root: second },
  )

  await window.evaluate((id: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
  }, threadId)
  await window.locator('[data-rail-item="files"]').click()

  // The positive first: the explorer really is drawing section headers, i.e.
  // this test is standing on the multi-root path and not quietly on the single
  // one (allowed-pattern #28).
  const headers = window.locator('.fl-sidebar-files [style*="border-left"]')
  await expect(headers.first()).toBeVisible({ timeout: 30_000 })

  // …and the panel is there for it, once, speaking for every project the
  // conversation carries.
  await expect(window.locator(SWITCH)).toHaveCount(1, { timeout: 30_000 })
  await expect(window.locator(SWITCH)).toBeVisible({ timeout: 30_000 })
})

/**
 * THE NAME A PERSON TYPES IS THE FOLDER ON DISK — reported broken 2026-09-17:
 * "created a new worktree, new branch, but we are still showing the uuid".
 *
 * The suite above only ever CLEARED the field and asserted that some path was
 * recorded. That leaves the one thing the whole feature exists for untested:
 * that the typed stem becomes `.{repo}-threads/worktree/<stem>` rather than the
 * thread's id. A panel that shows the name, a store that records a uuid, and a
 * shell prompt reading 6418475d-… is exactly the shape that passed every test
 * there was.
 *
 * So this asks the DISK and GIT'S OWN REGISTRY, not the panel's own sentence
 * about itself (forbidden-pattern #7).
 */
test('the folder a person names is the folder on disk, not the thread id', async ({ window }) => {
  test.setTimeout(300_000)
  const { root, threadId } = await seed(window, 'flow-wt-panel-named-', false)
  await openPanel(window, threadId)
  await expect(window.locator(STATE)).toContainText('Off')

  await window.locator(SWITCH).click()
  const naming = window.locator('.fl-wt-ask')
  await expect(naming).toBeVisible({ timeout: 30_000 })
  await naming.locator('input[type="text"]').first().fill('export-pipeline')
  await naming.locator('button', { hasText: 'Create' }).click()
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true', { timeout: 120_000 })

  const recorded = await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: {
        threads: {
          get(r: { threadId: string }): Promise<{
            worktreePath: string | null
            worktreeBranch: string | null
          } | null>
        }
      }
    }).flow
    const thread = await flow.threads.get({ threadId: id })
    return { path: thread?.worktreePath ?? null, branch: thread?.worktreeBranch ?? null }
  }, threadId)

  // AND THE PANEL SAYS IT, prefix included. A shell prompt printing one path
  // component shows `export-pipeline` for the folder AND for the branch; the
  // `worktree/` prefix is the part that tells them apart, so the panel prints
  // the two segments together (user, 2026-09-18: "on the folder we should
  // always have worktree/ name").
  // ONE ROW, NOT TWO, AND NO LABEL. The branch has its own surface (the Changes
  // toolbar chip, which is also the only place it can be changed); repeating it
  // here was the same words twice with nothing saying which mattered. The
  // `Folder` label went the same way — the name already opens with the word
  // (2026-09-18).
  const rows = window.locator('.fl-wt-branch')
  await expect(rows).toHaveCount(1)
  await expect(rows).toHaveText('worktree/export-pipeline')

  // THE POSITIVE FIRST: a checkout was made at all (allowed-pattern #28).
  expect(recorded.path, 'the switch said On but nothing was recorded').not.toBeNull()
  // …and it is called what the person called it.
  expect(recorded.path).toMatch(/\/worktree\/export-pipeline$/)
  expect(
    recorded.path,
    'the checkout was named after the thread rather than after the person',
  ).not.toContain(threadId)

  // GIT'S OWN REGISTRY AGREES — a recorded path git has never heard of is a
  // checkout the next `worktree` verb cannot find.
  const registered = execFileSync('git', ['worktree', 'list'], { cwd: root }).toString()
  expect(registered).toContain(recorded.path as string)

  // AND THE BRANCH IS NOT THE FOLDER WEARING ITS PREFIX TWICE. The folder is
  // `worktree/<stem>`; a branch derived from that name must not become
  // `worktree/worktree/<stem>`.
  expect(recorded.branch ?? '').not.toContain('worktree/worktree/')
})

/**
 * DELETING A WORKTREE WHOSE BRANCH HAS NOT BEEN MERGED YET.
 *
 * Reported 2026-09-18: pressing Delete answered "This thread has work that
 * hasn't reached 'main' yet. Land it first, or say to keep it on its own
 * branch." — directly under a confirm dialog that had just said, in as many
 * words, that the branch and its commits stay and the main folder is untouched.
 *
 * The dialog was right. `prune` keeps the branch deliberately, so the commits
 * were never at risk; the guard was protecting something that could not be
 * lost, its remedy ("say to keep it on its own branch") was a sentence with
 * nothing behind it, and the only unmerged branch is the normal state of a
 * thread that has done any work at all — so Delete did not work for anybody.
 *
 * ASKS GIT, not the panel's own report of itself (forbidden-pattern #7): the
 * folder must be gone AND the branch must still be there, carrying its commit.
 */
test('a worktree whose branch is ahead of main deletes, and the branch keeps its commits', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { root, threadId } = await seed(window, 'flow-wt-panel-ahead-', false)
  await openPanel(window, threadId)
  await turnOn(window, 'export-pipeline')

  const worktree = await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: { threads: { get(r: { threadId: string }): Promise<{ worktreePath: string | null } | null> } }
    }).flow
    return (await flow.threads.get({ threadId: id }))?.worktreePath ?? null
  }, threadId)
  expect(worktree).not.toBeNull()

  // A COMMIT THAT HAS NOT REACHED MAIN — the state every working thread is in.
  writeFileSync(join(worktree as string, 'shipped.ts'), 'export const shipped = true\n')
  execFileSync('git', ['add', '-A'], { cwd: worktree as string })
  execFileSync('git', ['commit', '-q', '-m', 'work that has not landed'], { cwd: worktree as string })
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktree as string,
  })
    .toString()
    .trim()
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree as string })
    .toString()
    .trim()
  // The positive first: main really does NOT have it (allowed-pattern #28), so
  // the guard this test is about was genuinely reachable.
  expect(
    execFileSync('git', ['branch', '--contains', sha], { cwd: root }).toString(),
  ).not.toContain('main')

  await window.locator(SWITCH).click()
  const confirm = window.locator('.fl-wt-ask')
  await expect(confirm).toBeVisible({ timeout: 30_000 })
  await confirm.locator('button', { hasText: 'Delete' }).click()

  // THE SWITCH GOES OFF — and says nothing in amber on the way.
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'false', { timeout: 120_000 })
  await expect(window.locator('.fl-wt-note')).toHaveCount(0)

  // GIT'S ANSWER. The folder is gone…
  expect(existsSync(worktree as string)).toBe(false)
  expect(execFileSync('git', ['worktree', 'list'], { cwd: root }).toString()).not.toContain(
    worktree as string,
  )
  // …and the branch is still there, still carrying the commit, which is exactly
  // what the dialog promised.
  expect(execFileSync('git', ['branch', '--list', branch], { cwd: root }).toString()).toContain(
    branch,
  )
  expect(
    execFileSync('git', ['rev-parse', branch], { cwd: root }).toString().trim(),
  ).toBe(sha)
})

/**
 * DELETING A WORKTREE THAT STILL HOLDS UNCOMMITTED WORK.
 *
 * The refusal is right — those files live nowhere else — but its remedy was a
 * sentence with nothing behind it: "Land the work first, or say to let it go",
 * in a panel with no way to say it. So the press dead-ended, permanently, in
 * the one state where the warning matters most (forbidden-pattern #12).
 *
 * The refusal carries what it found, so it becomes the question instead
 * (allowed-pattern #21). This walks the whole thing: refused, kept, then
 * deleted on purpose — and asks GIT what survived each time.
 */
test('uncommitted work turns the refusal into a question, and keeping it keeps it', async ({
  window,
}) => {
  test.setTimeout(300_000)
  const { root, threadId } = await seed(window, 'flow-wt-panel-dirtycopy-', false)
  await openPanel(window, threadId)
  await turnOn(window, 'export-pipeline')

  const worktree = (await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: { threads: { get(r: { threadId: string }): Promise<{ worktreePath: string | null } | null> } }
    }).flow
    return (await flow.threads.get({ threadId: id }))?.worktreePath ?? null
  }, threadId)) as string
  expect(worktree).not.toBeNull()

  // WORK THAT LIVES NOWHERE ELSE.
  writeFileSync(join(worktree, 'a.ts'), 'export const a = 2 // edited, never committed\n')

  // ── 1. The first Delete is refused, and the refusal becomes the ask ──────
  await window.locator(SWITCH).click()
  await expect(window.locator('.fl-wt-ask')).toBeVisible({ timeout: 30_000 })
  await window.locator('.fl-wt-ask button', { hasText: 'Delete' }).first().click()

  const second = window.locator('.fl-wt-ask')
  await expect(second).toContainText('never committed', { timeout: 60_000 })
  // It NAMES what goes — a question asking consent to something unnamed is not
  // a question.
  await expect(second).toContainText('One file has')
  // …and the knob has not moved: nothing has happened yet.
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true')

  // ── 2. Keeping it keeps it, on disk and in git ───────────────────────────
  await second.locator('button', { hasText: 'Keep the worktree' }).click()
  await expect(window.locator('.fl-wt-ask')).toHaveCount(0)
  expect(existsSync(worktree)).toBe(true)
  expect(execFileSync('git', ['worktree', 'list'], { cwd: root }).toString()).toContain(worktree)
  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'true')

  // ── 3. Saying it out loud deletes it ─────────────────────────────────────
  await window.locator(SWITCH).click()
  await expect(window.locator('.fl-wt-ask')).toBeVisible({ timeout: 30_000 })
  await window.locator('.fl-wt-ask button', { hasText: 'Delete' }).first().click()
  const again = window.locator('.fl-wt-ask')
  await expect(again).toContainText('never committed', { timeout: 60_000 })
  await again.locator('button', { hasText: 'Delete and lose the work' }).click()

  await expect(window.locator(SWITCH)).toHaveAttribute('data-on', 'false', { timeout: 120_000 })
  expect(existsSync(worktree)).toBe(false)
  expect(execFileSync('git', ['worktree', 'list'], { cwd: root }).toString()).not.toContain(worktree)
})
