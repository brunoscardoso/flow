/**
 * The landing belongs to a project, and one project ends where the next begins
 * (landing-per-project).
 *
 * WHAT THE USER WAS LOOKING AT. A thread spanning four repository groups —
 * their own checkout on a 53-character branch, that project's own tree, and two
 * more repositories — with ONE landing bar spanning the whole panel above all
 * four: "This thread's work · 6 saved changes waiting to land", a message box,
 * and Merge / Open a pull request / Let the workspace go. Their two sentences:
 * "on the top, remove that part of thread, that should be only individually by
 * project", and "give a little space of the last part of the project as a
 * separator or something to the user understand the part of each project."
 *
 * Both are failures of RENDERING, not of behaviour, and that is exactly why
 * they need a spec and not a unit test. The service underneath landed per
 * repository all along. The panel drew a control that acts on one repository
 * across four, and drew four repositories as one run-on list. Nothing about
 * either looks like a failure from inside the code — the classes were right,
 * the model was right, and the screen said something untrue.
 *
 * So this builds the user's shape and asserts what a person's eyes assert:
 * which group carries the controls, that the others carry none, that each
 * project visibly ends, and that none of it clips at three panel widths in both
 * themes. The screenshots are written out and looked at.
 *
 * WHAT IS SIMULATED, AND WHY. The thread's checkout is created through the app's
 * own `threads:prepareWorktree` channel rather than by a real agent turn —
 * pointing a spec at the developer's credentials is forbidden, and the worktree
 * step is the same one a first message runs. Nothing else here is stood in for:
 * three real repositories, real branches, real `git worktree add`.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  git,
  seedCommittedRepo,
  settleWorktree,
} from './fixtures/worktree'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

/** The real branch name that has broken this panel twice. 53 characters. */
const LONG_BRANCH = 'ACME-2059-logging-strategy-for-the-argo-applications-x'

/** Narrow / the width the panel bugs get reported at / wide. */
const WIDTHS = [320, 500, 900]

/** Where this run's screenshots go. */
const SHOTS = '/tmp/landing-per-project'

/** How long the panel may take to show four repositories. */
const PANEL_BUDGET_MS = 60_000

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/**
 * Resize the Source Control panel the way the splitter does.
 *
 * <fl-split> keeps its pane wrappers in its own SHADOW root and slots the light
 * children into them, so sizing a pane child resizes the whole split — the
 * measured mistake that produced a 70px panel from a 320px request. Lifted
 * verbatim from git-conflict-panel-responsive.spec.ts, which is where it was
 * worked out.
 */
function setPanelWidth(w: number): void {
  const bar = document.querySelector('.fl-activity-sidebar') as HTMLElement | null
  if (bar === null) throw new Error('no activity sidebar')
  const slot = bar.getAttribute('slot') ?? ''
  const split = document.getElementById('fl-split-root') as HTMLElement
  const shadow = split.shadowRoot
  if (shadow === null) throw new Error('fl-split has no shadow root')
  for (const pane of Array.from(shadow.querySelectorAll('.pane')) as HTMLElement[]) {
    const named = pane.querySelector('slot')?.getAttribute('name')
    pane.style.flex = named === slot ? `0 0 ${w}px` : '1 1 0px'
  }
}

/** Force the theme the way the user's toggle does — beats prefers-color-scheme. */
async function useTheme(win: Page, theme: 'light' | 'dark'): Promise<void> {
  await win.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value)
  }, theme)
  await win.waitForTimeout(200)
}

/**
 * What each repository group looks like, measured off the rendered panel.
 *
 * The GAP is the whole of request 2: `next.top - current.bottom`. The rule that
 * was there before answered 8px, on the group that starts, under the previous
 * group's last row — which is why the user could not see it.
 */
function groupGeometry(): {
  name: string
  boxed: boolean
  collapsed: boolean
  hasLanding: boolean
  landingButtons: number
  top: number
  bottom: number
}[] {
  return (Array.from(document.querySelectorAll('.gp-group')) as HTMLElement[]).map((group) => {
    const box = group.getBoundingClientRect()
    return {
      name: group.querySelector('.gp-group-name')?.textContent ?? '',
      boxed: group.classList.contains('gp-group-boxed'),
      collapsed: group.querySelector('.gp-group-head.gp-collapsed') !== null,
      hasLanding: group.querySelector('.gp-landing') !== null,
      landingButtons: group.querySelectorAll('.gp-landing-btn').length,
      top: box.top,
      bottom: box.bottom,
    }
  })
}

/**
 * Every leaf inside the Source Control panel painted narrower than its own text.
 *
 * Walks shadow roots because the file rows live inside each <fl-list>'s. The
 * allow-list is the set of strings DESIGNED to give way — identity (a branch
 * name, a file path, a commit subject) shortens and is still recognisable.
 * Anything else that clips is a bug, and this is the width no unit test has.
 */
function clippedInPanel(): { cls: string; text: string }[] {
  const root = document.querySelector('.gp-root') as HTMLElement | null
  if (root === null) return [{ cls: 'MISSING', text: 'no panel' }]
  const clipped: { cls: string; text: string }[] = []
  const walk = (node: ParentNode): void => {
    for (const el of Array.from(node.querySelectorAll('*')) as HTMLElement[]) {
      if (el.shadowRoot) walk(el.shadowRoot)
      if (el.childElementCount > 0) continue
      const text = (el.textContent ?? '').trim()
      if (text === '' || el.offsetParent === null) continue
      if (el.scrollWidth > el.clientWidth + 1) {
        clipped.push({ cls: el.className || el.tagName, text })
      }
    }
  }
  walk(root)
  return clipped
}

/** The classes whose whole job is to ellipsize — identity, never a verb. */
const MAY_ELLIPSIZE = [
  'gp-group-branch',
  'gp-group-name',
  'gp-branch-name',
  'gp-name',
  'gp-dir',
  'gp-commit-subject',
  'gp-commit-meta',
  'gp-legend-branch',
  'label',
  'meta',
  'detail',
]

/** Make a thread over the real create seam, with a checkout of its own. */
async function threadWithCheckout(
  win: Page,
  projectRoot: string,
  title: string,
  additionalRoots: string[],
  branch: string,
): Promise<string> {
  return win.evaluate(
    async ([root, name, rootsJson, take]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const thread = await flow.threads.create({
        projectRoot: root,
        title: name,
        additionalRoots: JSON.parse(rootsJson),
      })
      await flow.threads.prepareWorktree({
        threadId: thread.id,
        carry: 'clean',
        requested: true,
        start: { kind: 'checkout', branch: take },
      })
      // Retarget onto `main` so the checkout's branch and its base DIFFER —
      // which is the state in which Merge is a real offer rather than "this
      // thread works on its branch directly".
      await flow.threads.retargetWorktree({
        threadId: thread.id,
        start: { kind: 'branch', branch: 'main' },
      })
      return thread.id as string
    },
    [projectRoot, title, JSON.stringify(additionalRoots), branch],
  ) as Promise<string>
}

/**
 * Send the one-time "Run a basic discovery?" ask away.
 *
 * It is a real card in the corner of the window, it lands whenever it likes,
 * and at 320px it covers the bottom third of the panel — so a screenshot taken
 * with it up is a screenshot of it.
 */
async function dismissDiscoveryAsk(win: Page): Promise<void> {
  const card = win.locator('.fl-learn-card')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await card.count()) === 0) return
    await card.locator('fl-button', { hasText: 'Not now' }).first().click()
    await win.waitForTimeout(300)
  }
}

/** Open the Source Control panel's Changes view. */
async function openSourceControl(win: Page): Promise<void> {
  await win.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await win.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(win.locator('.gp-root')).toBeVisible({ timeout: 20_000 })
}

/** Activate a thread the way the user does — click its row in the sidebar. */
async function openThread(win: Page, title: string): Promise<void> {
  const rail = win.locator('[data-rail-item="threads"]')
  const cls = (await rail.getAttribute('class')) ?? ''
  if (!/\bactive\b/.test(cls)) await rail.click()
  await win
    .locator('.fl-thread-sidebar .row', { has: win.locator(`span[title="${title}"]`) })
    .first()
    .click()
  await expect(win.locator('.fl-composer')).toBeVisible()
}

/**
 * SKIPPED 2026-09-04 — the surface this drives was removed.
 *
 * Source Control's thread-landing block ("This thread's work", the waiting
 * line, the disk-quota count, Merge and "Let the workspace go") was taken out
 * on the user's call: it sat above the branch, the commit box and the log —
 * what the panel is actually opened for — and read as a second subject in a
 * panel that already had one.
 *
 * `Merge` lived only there, so landing a thread's worktree is no longer a UI
 * action at all. Releasing one survives as "Let it go" in the worktrees
 * manager. This spec is kept rather than deleted because it is the written
 * record of what the landing flow guaranteed, and the thing to un-skip if that
 * flow ever comes back.
 */
test.skip('the landing belongs to one project, and every project has a visible end', async ({
  app,
  window,
}) => {
  test.setTimeout(420_000)
  const errors: string[] = []
  window.on('pageerror', (event) => errors.push(event.message))

  // ── The user's shape: three repositories, one of them the thread's own ────
  const project = await seedCommittedRepo(window, 'flow-lpp-app-')
  const argo = await seedCommittedRepo(window, 'flow-lpp-argo-')
  const core = await seedCommittedRepo(window, 'flow-lpp-core-')

  // A 53-character branch in one of them, checked out — the width hazard, in a
  // group header, at 320px.
  git(argo, 'checkout', '-q', '-b', LONG_BRANCH)
  // Something changed in every repository, so no group is an empty shell.
  for (const [repo, file] of [
    [project, 'my-own-work.md'],
    [argo, 'logging.yaml'],
    [core, 'core-notes.md'],
  ] as const) {
    writeFileSync(join(repo, file), 'work the user did themselves\n')
  }
  // …and the branch the thread's checkout will take, in the project.
  git(project, 'branch', 'thread/chat-migration-to-engine-investigation-2')

  await activateProject(window, project)
  await settleWorktree(window, project)

  const title = 'Chat migration to engine investigation 2'
  await threadWithCheckout(
    window,
    project,
    title,
    [argo, core],
    'thread/chat-migration-to-engine-investigation-2',
  )
  await openThread(window, title)
  await openSourceControl(window)

  // Work inside the thread's OWN checkout, so its landing has something to
  // offer and its block is not permanently disabled.
  const checkout = await window.evaluate(
    async (root: string) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const threads = (await flow.threads.list({ projectRoot: root })) as {
        worktreePath: string | null
      }[]
      return threads[0]?.worktreePath ?? null
    },
    project,
  )
  expect(checkout, 'the thread should own a checkout').not.toBeNull()
  mkdirSync(join(String(checkout), 'src'), { recursive: true })
  await window.evaluate(
    async ([root, relPath]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.project.writeFile({
        rootPath: root,
        relPath,
        content: 'written inside the thread’s own checkout\n',
      })
    },
    [String(checkout), 'src/notes.md'],
  )

  // ── Four groups, in the order the user saw them ───────────────────────────
  const names = [
    `${basename(project)} (this thread)`,
    basename(project),
    basename(argo),
    basename(core),
  ]
  await expect(async () => {
    expect(await window.locator('.gp-group-name').allTextContents()).toEqual(names)
  }).toPass({ timeout: PANEL_BUDGET_MS })

  // ── REQUEST 1: the landing belongs to ONE group ───────────────────────────
  await expect(window.locator('.gp-landing')).toHaveCount(1, { timeout: PANEL_BUDGET_MS })
  await expect(async () => {
    const geometry = await window.evaluate(groupGeometry)
    expect(geometry.map((group) => group.hasLanding), 'only the thread’s own checkout').toEqual([
      true,
      false,
      false,
      false,
    ])
    // And the other three offer nothing that lands anything — the question the
    // old bar could not answer was "does Merge touch orbit-core".
    expect(geometry.slice(1).map((group) => group.landingButtons)).toEqual([0, 0, 0])
  }).toPass({ timeout: PANEL_BUDGET_MS })

  // It offers a real Merge, in the group whose header names the checkout.
  const owner = window.locator('.gp-group').filter({ has: window.locator('.gp-landing') })
  await expect(owner.locator('.gp-group-name')).toHaveText(names[0]!)
  await expect(owner.locator('.gp-landing-primary')).toHaveText('Merge')
  await expect(owner.locator('.gp-landing-primary')).toBeEnabled({ timeout: PANEL_BUDGET_MS })
  // The disk total is still on screen, and still a door: it is a fact about
  // THIS project, so it sits on this project's block.
  await expect(owner.locator('.gp-landing-total')).toBeVisible()

  // Nothing a person reads is a command, a path or a config key (#12).
  for (const text of await window.locator('.gp-landing *').allTextContents()) {
    expect(text, 'no path in the landing').not.toMatch(/(^|\s)\/[A-Za-z._-]+\//)
    expect(text, 'no command in the landing').not.toContain('planflow-ai')
    expect(text, 'no config key in the landing').not.toMatch(/`/)
  }

  // ── THE DRAFT SURVIVES A BACKGROUND REFRESH ──────────────────────────────
  //
  // The block is INSIDE the panel's scroll area now, and the panel rebuilds its
  // whole DOM on every status read. That is precisely what the bar was lifted
  // out of the way of, so it has to be proven rather than reasoned about.
  const half = 'feat: half a se'
  const messageBox = owner.locator('.gp-landing-msg')
  await messageBox.click()
  await messageBox.fill(half)
  await window.evaluate(
    async ([root, relPath]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.project.writeFile({ rootPath: root, relPath, content: 'background\n' })
    },
    [core, 'a-background-write.md'],
  )
  await expect(async () => {
    const listed = await window.locator('.gp-name').allTextContents()
    expect(listed.join(' '), 'the panel really did rebuild').toContain('a-background-write.md')
  }).toPass({ timeout: PANEL_BUDGET_MS })
  await expect(messageBox, 'a half-typed landing message survives the rebuild').toHaveValue(half)

  // ── REQUEST 2: every project visibly ends ────────────────────────────────
  const geometry = await window.evaluate(groupGeometry)
  expect(geometry.every((group) => group.boxed), 'each project is its own band').toBe(true)
  for (let index = 0; index + 1 < geometry.length; index += 1) {
    const gap = geometry[index + 1]!.top - geometry[index]!.bottom
    expect(gap, `no space between ${geometry[index]!.name} and the next`).toBeGreaterThanOrEqual(8)
  }

  // Collapsed, a project is still a band with an end — the head is all there is
  // left of it, and it must not merge into the next project's head.
  //
  // Located by POSITION, not by "the group with a landing in it": collapsing
  // takes the block off screen with the rest of the group's body, which is the
  // honest consequence of the block belonging to the group. The checkout is the
  // panel's leading root (asserted above).
  const ownerHead = window.locator('.gp-group').nth(0).locator('.gp-group-head')
  await ownerHead.click()
  await expect(async () => {
    const collapsed = await window.evaluate(groupGeometry)
    expect(collapsed[0]?.collapsed).toBe(true)
    expect(collapsed[0]?.boxed).toBe(true)
    expect(collapsed[0]?.hasLanding, 'a collapsed project shows none of its body').toBe(false)
    expect(collapsed[1]!.top - collapsed[0]!.bottom).toBeGreaterThanOrEqual(8)
  }).toPass({ timeout: 15_000 })
  await ownerHead.click()
  await expect(window.locator('.gp-landing')).toHaveCount(1, { timeout: 15_000 })

  // ── Three widths, both themes, and a look at each ────────────────────────
  mkdirSync(SHOTS, { recursive: true })
  await dismissDiscoveryAsk(window)
  for (const theme of ['light', 'dark'] as const) {
    await useTheme(window, theme)
    for (const width of WIDTHS) {
      // THE WINDOW'S OWN 960px FLOOR SILENTLY CLAMPS EVERY REQUEST BELOW IT, so
      // a width test that only calls setSize measures the same picture three
      // times. Lift the floor, then ASSERT the width that was actually achieved.
      await app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows()[0]
        win?.setMinimumSize(1, 1)
        win?.setSize(w, 900)
      }, width)
      await window.waitForTimeout(600)
      const viewport = await window.evaluate(() => window.innerWidth)
      expect(Math.abs(viewport - width), `window refused ${String(width)}px`).toBeLessThanOrEqual(2)
      // …and give the panel everything the window has left after the activity
      // rail. Asking for the full window width instead pushes the panel's right
      // edge off screen, and a screenshot of that measures the WINDOW clipping
      // the panel rather than the panel clipping itself.
      const rail = await window.evaluate(
        () => document.querySelector('.fl-activity-bar')?.getBoundingClientRect().width ?? 0,
      )
      await window.evaluate(setPanelWidth, Math.max(160, Math.round(viewport - rail)))
      await window.waitForTimeout(400)
      const panelWidth = await window.evaluate(
        () => document.querySelector('.gp-root')?.clientWidth ?? 0,
      )
      expect(panelWidth, `the panel got no width at ${String(width)}px`).toBeGreaterThan(140)
      expect(panelWidth, `the panel overflowed the window at ${String(width)}px`).toBeLessThanOrEqual(
        viewport,
      )

      await dismissDiscoveryAsk(window)
      await window.screenshot({ path: `${SHOTS}/panel-${theme}-${String(width)}.png` })

      // Nothing is painted narrower than its own words, except identity.
      const clipped = await window.evaluate(clippedInPanel)
      expect(
        clipped.filter((entry) => !MAY_ELLIPSIZE.some((cls) => entry.cls.includes(cls))),
        `clipped at ${String(width)}px in ${theme}: ${JSON.stringify(clipped)}`,
      ).toEqual([])

      // And the panel never scrolls sideways.
      const box = await window.evaluate(() => {
        const root = document.querySelector('.gp-root') as HTMLElement
        return { scroll: root.scrollWidth, client: root.clientWidth }
      })
      expect(box.scroll, `sideways scroll at ${String(width)}px in ${theme}`).toBeLessThanOrEqual(
        box.client + 1,
      )

      // The separators are still separators at this width.
      const measured = await window.evaluate(groupGeometry)
      for (let index = 0; index + 1 < measured.length; index += 1) {
        expect(
          measured[index + 1]!.top - measured[index]!.bottom,
          `no space between projects at ${String(width)}px in ${theme}`,
        ).toBeGreaterThanOrEqual(8)
      }
      // …and the landing is still attached to exactly one of them.
      expect(measured.map((group) => group.hasLanding)).toEqual([true, false, false, false])
    }
  }

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win?.setMinimumSize(960, 600)
    win?.setSize(1280, 900)
  })
  await window.evaluate(setPanelWidth, 380)

  // ── ONE PROJECT: no separator, and no band ───────────────────────────────
  //
  // A lone group has nothing to be separated from, and the panel's rule has
  // always been that a single repository renders chrome-free.
  const solo = 'A thread in one project'
  await window.evaluate(
    async ([root, name]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.threads.create({ projectRoot: root, title: name })
    },
    [project, solo],
  )
  await openThread(window, solo)
  await openSourceControl(window)
  await expect(async () => {
    const single = await window.evaluate(groupGeometry)
    expect(single).toHaveLength(1)
    expect(single[0]?.boxed, 'a lone project is not a band').toBe(false)
    expect(single[0]?.hasLanding, 'a chat-only thread has no landing').toBe(false)
  }).toPass({ timeout: PANEL_BUDGET_MS })
  await expect(window.locator('.gp-landing')).toHaveCount(0)

  expect(errors, errors.join(', ')).toEqual([])
})
