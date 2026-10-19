/**
 * Reusable seeding helpers for UX-sweep probes (see flow/qa-sweep-runbook.md).
 *
 * A fresh launch has no project/account. These helpers reach core features by
 * driving the app's real IPC bridge *after* boot:
 *
 *  - `seedProject` creates a throwaway git repo and adds it as a project root
 *    via `project:add` (no native dialog — unlike `openProject`, which
 *    opens a folder picker Playwright can't drive). The main process persists
 *    the root and broadcasts `project:listChanged`, so every surface rebinds.
 *  - `activateProject` makes a seeded root the active project via
 *    `project:setActive`, which broadcasts `project:activeChanged`
 *    (the titlebar switcher label + editor/file-tree/terminal binding follow it).
 *
 * Each seeded repo dir is tracked so callers can `cleanupSeeds()` in a finally.
 */
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

const seededDirs: string[] = []

/**
 * The IDE auto-provisions every added root with its own scaffold (`.claude/`,
 * the `flow` symlink, a `.gitignore`, `loops/`, `CLAUDE.md`, `graphify-out/`) as
 * a fire-and-forget background write — and since the Workspaces hard migration
 * (2026-10-06) placing the project in its Workspace renames the plain `flow/`
 * it found to `flow.pre-workspace-<date>/` (the backup it never deletes).
 *
 * `loops/` was missing from this list until 2026-09-04, which is why
 * git-submodule.spec.ts intermittently ended with `U loops` in CHANGES and
 * "Working tree clean" never arriving — the provisioner's write racing the
 * spec's last assertion. Anything `planflow-ai init` scaffolds belongs here.
 * That lands mid-test and dirties `git status`, so specs asserting exact
 * `CHANGES (N)` counts or a clean tree race it. Excluding the IDE-owned names
 * via `.git/info/exclude` (repo-local, never a tracked file) keeps seeded
 * repos' status deterministic: only what the spec itself wrote is reported.
 * Tracked files are unaffected — exclude only hides untracked paths.
 */
const IDE_SCAFFOLD_EXCLUDES = '.claude/\nflow\n.gitignore\nloops/\nflow.pre-workspace*\nCLAUDE.md\ngraphify-out/\n'

/** Create a throwaway git repo and add it as a project root. Returns its path.
 *  `prepare` runs after `git init` but BEFORE the root is added — use it for
 *  files the main process snapshots at watch-start (e.g. flow/.flowconfig; the
 *  temp-dir chokidar watcher is unreliable on macOS, so writing them later may
 *  never be observed). */
export async function seedProject(
  win: Page,
  prefix = 'flow-ux-proj-',
  prepare?: (dir: string) => void,
  options: { onboarded?: boolean } = {},
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), IDE_SCAFFOLD_EXCLUDES)
  prepare?.(dir)
  seededDirs.push(dir)
  await win.evaluate(async ({ p, onboarded }) => {
    // `onboarded`: mark the root BEFORE it is added, so the per-project
    // settings overlay can never auto-open over the spec. Dismissing it after
    // the fact is a race: it opens only once `flow.state()` answers, which on
    // a loaded machine is later than `dismissFlowOverlay`'s 1.5 s wait, and a
    // first project is activated by the add itself — before `activateProject`.
    if (onboarded) {
      try {
        const key = 'flow.onboarded'
        const seen: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
        if (!seen.includes(p)) seen.push(p)
        localStorage.setItem(key, JSON.stringify(seen))
      } catch {
        /* convenience only */
      }
    }
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, { p: dir, onboarded: options.onboarded === true })
  return dir
}

/**
 * Wait until the project has been placed in its Workspace — `flow/` is then a
 * link into the Workspace folder. Placement COPIES whatever `flow/` held and
 * the watch re-lists it; a doc written in that instant arrives as a re-listing
 * (history), not a write. A person writes into a project that is already
 * placed, so a spec that writes a doc live waits for that state first.
 */
export async function waitForWorkspaceLink(root: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(root, 'flow')).isSymbolicLink()
        } catch {
          return false
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}

/** Make a seeded root the active project (broadcasts activeProjectChanged). */
export async function activateProject(win: Page, rootPath: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, rootPath)
  // The first time a project with no .flowconfig becomes active, the flow-settings
  // overlay auto-opens (per-project onboarding — intentional). It intercepts
  // clicks, so dismiss it before driving other surfaces.
  await dismissFlowOverlay(win)
}

/** Dismiss the per-project flow-settings overlay if it's up (Escape closes it). */
export async function dismissFlowOverlay(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  try {
    await overlay.waitFor({ state: 'visible', timeout: 1500 })
  } catch {
    return // never appeared — already-configured project or none
  }
  await win.keyboard.press('Escape')
  await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
}

/**
 * Run git in a seeded repo, retrying on `.git/index.lock` contention — the
 * app's own status refreshes and the auto-provisioner briefly take the lock,
 * so a spec's mid-test `git add`/`git commit` can collide with it. Same
 * pattern git-diff-inflight-open-file.spec.ts established locally.
 */
export function gitRetry(dir: string, ...args: string[]): string {
  let lastError: unknown
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } catch (error) {
      lastError = error
      const stderr = String((error as { stderr?: Buffer }).stderr ?? '')
      if (!stderr.includes('index.lock')) throw error
      // NOT `execFileSync('sleep')` — that program does not exist on Windows, so
      // the backoff threw ENOENT and the retry loop never ran a second attempt.
      // The comment on `cleanupSeeds` below records this exact fix; this call
      // site was left behind, which is forbidden-pattern #17 in one line.
      sleepSync(200)
    }
  }
  throw lastError
}

/** Sleep without a timer or a shell — `sleep` is not a program on Windows. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Errors worth waiting out. ENOTEMPTY is the auto-provisioner still writing
 * its scaffold into a just-attached root; EPERM/EACCES/EBUSY are Windows
 * refusing to delete a directory while ANY handle in it is open — a watcher, a
 * SQLite file, an Electron that has not finished exiting.
 */
const TRANSIENT = new Set(['ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'])

/**
 * Remove every throwaway repo dir seeded this run. Best-effort, and NEVER
 * fatal.
 *
 * TEARDOWN MUST NOT FAIL A TEST THAT PASSED. This used to rethrow whatever it
 * could not delete, so on Windows — where a directory cannot be removed while
 * anything inside it is open — specs that had asserted everything correctly
 * were reported as failures by their own cleanup. It also retried ONLY
 * ENOTEMPTY, and did its backoff with `execFileSync('sleep', …)`, a program
 * that does not exist on Windows: the first retry threw ENOENT from the sleep
 * itself. The sibling fixture in electron.ts already states the rule this now
 * follows — "a locked SQLite file on teardown is non-fatal".
 *
 * What is left behind is a temp directory. Measured live: 176 of them had
 * accumulated under %TEMP% before this was fixed, so the leak is reported
 * rather than swallowed silently.
 */
export function cleanupSeeds(): void {
  const leaked: string[] = []
  while (seededDirs.length) {
    const dir = seededDirs.pop()
    if (!dir) continue
    if (!tryRemoveDir(dir)) leaked.push(dir)
  }
  if (leaked.length > 0) {
    console.warn(`[seed] could not remove ${String(leaked.length)} temp dir(s); still held open:`)
    for (const dir of leaked) console.warn(`  ${dir}`)
  }
}

/**
 * Remove ONE throwaway temp dir a spec made itself (not via `seedProject`).
 * Same contract as `cleanupSeeds`: retries the transient errors, never throws.
 *
 * A spec's `finally` used to call a bare `rmSync(projectDir…)`. The
 * provisioner's `init` child runs at background priority and outlives
 * `app.close()`, still writing `.claude/` for seconds, so that rm threw
 * ENOTEMPTY and failed specs whose every assertion had passed. What is left
 * behind is swept by the next run's global-setup.
 */
export function removeTempDir(dir: string): void {
  if (!tryRemoveDir(dir)) console.warn(`[seed] could not remove temp dir; still held open: ${dir}`)
}

function tryRemoveDir(dir: string): boolean {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch (error) {
      if (!TRANSIENT.has((error as { code?: string }).code ?? '')) return false
      sleepSync(300)
    }
  }
  return false
}

/**
 * Create an EMPTY thread in `projectRoot` and open it, so the composer is up.
 *
 * WHY NOT THE "+" BUTTON. Since the new-thread page replaced the Create-thread
 * modal (f7935aff, 2026-09-04), "+" opens a page whose From-scratch Create needs
 * a description — and that description IS the thread's first message, so it
 * starts a turn. There is no longer a UI path that makes an empty thread, which
 * is what every spec that pressed "+" and then waited for `.fl-composer` was
 * relying on. Those specs test the conversation, not the page, so they create
 * the thread through the same IPC the page ends in and open it the way a person
 * does: by its row. (The thread-list `fl-list .row` locator is unreliable here —
 * the row is found, then the list re-renders — so the row is pressed by text.)
 */
export async function openEmptyThread(win: Page, projectRoot: string, title = 'New thread'): Promise<string> {
  const id = await win.evaluate(
    async ({ projectRoot, title }) => {
      const created = await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot, title })
      return created.id
    },
    { projectRoot, title },
  )
  await win.locator('.fl-thread-sidebar').getByText(title, { exact: true }).first().click()
  await win.locator('.fl-composer').waitFor({ state: 'visible', timeout: 10_000 })
  return id
}

/**
 * If the Files panel is showing its Workspace PICKER, press a project in it.
 *
 * In a Workspace with no thread selected, the Files panel does not claim any
 * one project as "the" project — it lists them and asks
 * (file-tree-picker-model.ts, 2026-10-06). Specs that seed a project, activate
 * it and then read the tree were written before that, when the active project's
 * tree simply showed. They press the project the way a person does. A no-op
 * when the tree is already showing (a thread is selected, or a pick was made).
 */
export async function pickFilesProject(win: Page, name?: string): Promise<void> {
  const picks = win.locator('.fl-sidebar-pane:visible .fl-file-tree-pick:not([disabled])')
  const pick = name === undefined ? picks.first() : picks.filter({ hasText: name }).first()
  try {
    await pick.waitFor({ state: 'visible', timeout: 1500 })
  } catch {
    return // the tree is up — nothing to choose
  }
  await pick.click()
}

/**
 * Open a thread by its title in the thread list, the way a person does, and
 * wait for its conversation (the composer) to be up.
 *
 * On the TITLE, not the row's centre: the row's second line is the project
 * name, and a press there is not "open this thread". Retried, because a
 * just-created thread's broadcast can redraw the list between finding the row
 * and the press landing.
 */
export async function openThreadByTitle(win: Page, title: string): Promise<void> {
  const threadsRail = win.locator('[data-rail-item="threads"]')
  if (!/\bactive\b/.test((await threadsRail.getAttribute('class')) ?? '')) await threadsRail.click()
  const row = win.locator('.fl-thread-sidebar .row', { hasText: title }).first()
  await row.waitFor({ state: 'visible', timeout: 15_000 })
  // OPEN means the row is the CURRENT one (the mark <fl-list> paints on the
  // active row) and its conversation is up — a composer alone could be the
  // previous thread's, still on screen after a press that did not land.
  const current = win.locator('.fl-thread-sidebar .fl-row-current', { hasText: title })
  const composer = win.locator('.fl-composer')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await row
      .getByText(title, { exact: true })
      .click({ timeout: 5_000 })
      .catch(() => undefined)
    try {
      await current.waitFor({ state: 'visible', timeout: 3_000 })
      await composer.waitFor({ state: 'visible', timeout: 3_000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

/** What main's FlowObserver reports for a root (`flow:state`) — skill, phase,
 *  autopilot, the pending prompt. */
export interface ObservedFlowState {
  activeSkill?: string
  activePhase?: string
  autopilot: boolean
  pendingPrompt: unknown
}

/**
 * Wait until main's observed flow state for `root` satisfies `ready`.
 *
 * Specs used to wait on the status bar's `flow: <skill> · <phase>` and
 * `autopilot on|off` readouts as proof the FlowObserver had attached to a
 * seeded project. Both readouts left the status bar on the user's call
 * (2026-09-04, status-line.ts); the fact they displayed is still main's, and
 * this reads it from there.
 */
export async function waitForFlowState(
  win: Page,
  root: string,
  ready: (state: ObservedFlowState) => boolean,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout
  let last: ObservedFlowState | null = null
  while (Date.now() < deadline) {
    last = await win.evaluate(async (rootId) => {
      const flow = (
        window as unknown as {
          flow: { flow: { state(r: { rootId: string }): Promise<ObservedFlowState | null> } }
        }
      ).flow.flow
      return (await flow.state({ rootId }).catch(() => null)) ?? null
    }, root)
    if (last !== null && ready(last)) return
    await win.waitForTimeout(250)
  }
  throw new Error(`flow state for ${root} never became ready; last: ${JSON.stringify(last)}`)
}

/**
 * Wait until the first element matching `selector` has stayed the SAME node for
 * `quietMs` — i.e. the surface has stopped rebuilding itself.
 *
 * Several panels (Source Control, the Review/Phases list) rebuild their whole
 * subtree on each background git refresh (#1093/#1094), and a freshly added
 * project gets a short burst of those (provisioning writes, its Workspace
 * placement). A click that lands on a node in the instant it is replaced is
 * lost. A person never clicks inside that first second or two; a spec does.
 */
export async function waitForStableNode(
  win: Page,
  selector: string,
  quietMs = 1_500,
  timeout = 15_000,
): Promise<void> {
  await win.locator(selector).first().waitFor({ state: 'attached', timeout })
  await win.evaluate(
    ({ selector, quietMs, timeout }) =>
      new Promise<void>((resolve, reject) => {
        const started = performance.now()
        let node = document.querySelector(selector)
        let since = performance.now()
        const timer = window.setInterval(() => {
          const now = document.querySelector(selector)
          if (now !== node) {
            node = now
            since = performance.now()
          } else if (now !== null && performance.now() - since >= quietMs) {
            window.clearInterval(timer)
            resolve()
          }
          if (performance.now() - started > timeout) {
            window.clearInterval(timer)
            reject(new Error(`${selector} never stopped rebuilding`))
          }
        }, 50)
      }),
    { selector, quietMs, timeout },
  )
}

/**
 * The ACTIVE project's folder name ('' when none), read from the app.
 *
 * The titlebar used to name it — `.fl-project-name` — but since the Workspaces
 * hard migration (2026-10-06) that switcher names the WORKSPACE ("Default", or
 * "Setting up your Workspace…" while placement runs). The fact the old label
 * stood for is main's, and this asks for it there.
 */
export async function activeProjectName(win: Page): Promise<string> {
  const root = await win.evaluate(async () => {
    const context = await (
      window as unknown as { flow: { project: { active(): Promise<{ rootPath?: string } | null> } } }
    ).flow.project.active()
    return context?.rootPath ?? ''
  })
  return root === '' ? '' : (root.split(/[\\/]/).filter(Boolean).pop() ?? '')
}

/**
 * Show the Files tree of the ACTIVE project: select the Files rail (only when
 * it is not already showing — re-clicking the active rail item collapses the
 * sidebar) and, if the panel is showing its Workspace picker, press the active
 * project in it — the press a person makes (see pickFilesProject).
 */
export async function showActiveProjectFiles(win: Page): Promise<void> {
  const files = win.locator('.fl-activity-bar [data-rail-item="files"]')
  if (!/\bactive\b/.test((await files.getAttribute('class')) ?? '')) await files.click()
  await pickFilesProject(win, await activeProjectName(win))
}

/** The Files panel's own pane (not the Threads or Source Control pane). */
export const FILES_PANE = '.fl-sidebar-pane.fl-sidebar-files'
