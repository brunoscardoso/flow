/**
 * UX sweep — flow `project` (rotation index 1, round 25): opening a project
 * folder the app cannot WRITE to, and one it cannot READ.
 *
 * Flow 1 is the most-probed flow in the rotation (28+ specs across 24 rounds),
 * but every prior probe opens a folder the app has full access to. The shared
 * `seedProject` fixture `mkdtemp`s a directory owned by the test user and
 * `git init`s it, so `project.spec`, `project-manage`, `project-switch-reorder`,
 * `project-samename-…` (#426), `project-open-already-added` (#1008),
 * `project-repo-root-mismatch` (#1040 — a NON-git folder, still readable),
 * `project-relaunch-restore` (#1080), `project-live-vanish` (#1118 — the folder
 * is DELETED, i.e. ENOENT), `project-subfolder-commit-scope` (#1209) and
 * `project-unavailable-root` (#974/#975) all drive a fully-accessible root.
 * Nobody had opened a folder that exists and is a directory but whose contents
 * the app is not permitted to read or write — a read-only checkout, a
 * root-owned or other-user directory, a network mount whose credentials
 * lapsed, or (on macOS) a TCC-protected folder an un-entitled app gets EPERM on.
 *
 * Both shapes are ordinary "Open Project" outcomes: `ProjectRegistry.addRoot`
 * checks `isDirectory` only, so the root attaches and the app enters it.
 *
 *  - Guard 1 (LIVE) — control: a normal project provisions with no failure
 *    toast and its file shows up in the Files tree. Makes the tripwires
 *    non-vacuous: the recipe below really does exercise a working path.
 *  - Guard 2 (LIVE) — a READ-ONLY (chmod 555) project does surface its
 *    provisioning failure: `Provisioner.emitFailure` raises one error toast
 *    ("Could not set up plan-flow"). The app noticed.
 *  - Tripwire A (`test.fixme`, #1463) — …and the body of that toast is
 *    `lastLine(stderrTail)` (provisioner.ts:341-349), which for an unhandled
 *    Node error is the crash banner Node prints LAST: "Node.js v24.18.0". The
 *    real reason ("EACCES: permission denied, mkdir '<project>/.claude/commands'")
 *    is captured in the same stderr tail and thrown away. The user is told a
 *    Node version and nothing else, and the sidebar tag tells them to retry
 *    from Settings → Re-provision, which fails identically forever.
 *  - Guard 3 (LIVE) — an UNREADABLE (chmod 000) project is announced by the
 *    OTHER surfaces: Source Control ("Couldn't load git status") and Review
 *    ("Couldn't refresh the review") each raise a toast naming the project.
 *  - Tripwire B (`test.fixme`, #1464) — …while the Files tree, the pane the
 *    user is actually looking at, renders the EACCES as an ordinary empty
 *    project: zero rows, no error, no retry, byte-identical to a genuinely
 *    empty folder. `file-tree.ts:292-308` catches the failure, sets
 *    `children = []` and only toasts when `looksMissing(error)` matches
 *    /ENOENT|Unknown root/ — exactly the defect #1118 fixed for the vanished
 *    folder, left in place one error code away.
 *
 * Account-independent, agent-independent, no network. No native dialog is
 * involved: the pick is handed to `project:open`, the real handler,
 * with only the un-automatable `showOpenDialog` step supplied.
 */
import { basename, join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { dismissFlowOverlay, activeProjectName, showActiveProjectFiles, FILES_PANE } from './fixtures/seed'

const SHOTS = join(__dirname, '__screens')
const MARKER = 'READABLE_MARKER.txt'
/** Provisioning spawns the bundled CLI; its failure toast lands seconds later. */
const PROVISION_WATCH_MS = 14_000
const scratch: string[] = []

/** A throwaway git repo with one tracked-visible file, mode applied last. */
function makeRepo(prefix: string, mode?: number): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  writeFileSync(join(dir, MARKER), 'hello\n')
  scratch.push(dir)
  if (mode !== undefined) chmodSync(dir, mode)
  return dir
}

/** Everything `project:open` does AFTER the user picks `path` in the
 *  (Playwright-invisible) native folder dialog — the real handler, byte for byte. */
async function pickInOpenProjectDialog(win: Page, path: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { open(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.open({ path: p })
  }, path)
}

async function selectRail(win: Page, id: 'threads' | 'files' | 'source-control'): Promise<void> {
  await win.locator(`.fl-activity-bar [data-rail-item="${id}"]`).click()
}

/** One toast as the user reads it: title / attribution / body / time lines. */
interface ToastText {
  title: string
  body: string
  raw: string
}

/**
 * Accumulate every toast raised over `ms`. Toasts auto-dismiss at
 * TOAST_AUTO_DISMISS_MS (6s), so a single read after the fact sees nothing —
 * the stack has to be polled while the burst is live.
 */
async function watchToasts(win: Page, ms: number): Promise<ToastText[]> {
  const seen = new Map<string, ToastText>()
  const until = Date.now() + ms
  while (Date.now() < until) {
    for (const raw of await win.locator('.fl-flow-toast').allInnerTexts()) {
      if (seen.has(raw)) continue
      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
      seen.set(raw, { title: lines[0] ?? '', body: lines[2] ?? '', raw })
    }
    await win.waitForTimeout(200)
  }
  return [...seen.values()]
}

const provisionFailure = (toasts: ToastText[]): ToastText | undefined =>
  toasts.find((toast) => toast.title === 'Could not set up plan-flow')

/** Wait for the provisioning-failure toast and read it as the user sees it.
 *  Waiting on the toast itself (rather than a fixed delay) keeps the shot taken
 *  right after this call inside the 6s auto-dismiss window. */
async function waitForProvisionFailureToast(win: Page): Promise<ToastText> {
  const toast = win
    .locator('.fl-flow-toast', { hasText: 'Could not set up plan-flow' })
    .first()
  await expect(toast).toBeVisible({ timeout: PROVISION_WATCH_MS })
  const raw = await toast.innerText()
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
  return { title: lines[0] ?? '', body: lines[2] ?? '', raw }
}

test.afterAll(() => {
  while (scratch.length) {
    const dir = scratch.pop()!
    try {
      chmodSync(dir, 0o755)
    } catch {
      /* already writable, or already gone */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test.describe('opening a project folder the app cannot read or write', () => {
  test('control: a fully accessible project provisions cleanly and lists its files', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(String(event)))

    const dir = makeRepo('flow-ok-')
    await pickInOpenProjectDialog(window, dir)
    const toasts = await watchToasts(window, PROVISION_WATCH_MS)
    expect(
      provisionFailure(toasts),
      `unexpected provisioning failure: ${JSON.stringify(toasts)}`,
    ).toBeUndefined()

    await dismissFlowOverlay(window)
    await expect.poll(() => activeProjectName(window)).toBe(basename(dir))
    await showActiveProjectFiles(window)
    await expect(
      window.locator(FILES_PANE).getByText(MARKER),
    ).toBeVisible({ timeout: 10_000 })

    expect(errors, errors.join(', ')).toEqual([])
  })

  test('a read-only project raises exactly one provisioning-failure toast', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(String(event)))

    const dir = makeRepo('flow-nowrite-', 0o555)
    await pickInOpenProjectDialog(window, dir)
    const failure = await waitForProvisionFailureToast(window)
    await window.screenshot({ path: `${SHOTS}/project-readonly-provision-toast.png` })
    expect(failure.title).toBe('Could not set up plan-flow')

    // The project is still entered — the failure is about the scaffold, not the root.
    await expect.poll(() => activeProjectName(window)).toBe(basename(dir))
    expect(errors, errors.join(', ')).toEqual([])
  })

  test(
    'the provisioning-failure toast says WHY it failed, not the Node version (#1463)',
    async ({ window }) => {
      const dir = makeRepo('flow-nowrite-why-', 0o555)
      await pickInOpenProjectDialog(window, dir)
      const failure = await waitForProvisionFailureToast(window)

      // Today: "Node.js v24.18.0" — the banner Node prints after a crash dump,
      // which `lastLine(stderrTail)` picks because it is the LAST line.
      expect(failure.body).not.toMatch(/^Node\.js v[\d.]+$/)
      // The reason is in the same captured tail; the user needs it.
      expect(failure.body).toMatch(/permission|EACCES|read-only|write/i)
    },
  )

  test('an unreadable project is announced by Source Control and Review', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(String(event)))

    const dir = makeRepo('flow-noread-', 0o000)
    await pickInOpenProjectDialog(window, dir)
    // The per-project flow-settings overlay auto-opens on first activation and
    // is modal — it intercepts the rail click until dismissed.
    await dismissFlowOverlay(window)
    await selectRail(window, 'files')
    // Shot while the burst is still up: the Files tree the user is looking at
    // is empty, and every word about the unreadable folder is in the toasts
    // raised by the OTHER two surfaces.
    await window.screenshot({ path: `${SHOTS}/project-unreadable-files-tree.png` })
    const toasts = await watchToasts(window, 9000)

    // The app DID notice the folder is unreadable — twice, loudly.
    expect(
      toasts.map((toast) => toast.title),
      JSON.stringify(toasts),
    ).toEqual(expect.arrayContaining(["Couldn't load git status", "Couldn't refresh the review"]))
    expect(errors, errors.join(', ')).toEqual([])
  })

  test(
    'the Files tree says the folder could not be read, instead of rendering it empty (#1464)',
    async ({ window }) => {
      const dir = makeRepo('flow-noread-tree-', 0o000)
      await pickInOpenProjectDialog(window, dir)
      await dismissFlowOverlay(window)
      await showActiveProjectFiles(window)
      await window.waitForTimeout(3000)

      const pane = window.locator(FILES_PANE)
      // Today the pane is literally empty — an EACCES listing is indistinguishable
      // from an empty project (the #1118 defect, for a different error code).
      expect((await pane.innerText()).trim()).not.toBe('')
      await expect(pane).toContainText(/couldn't read|permission|can't be read|not readable/i)
    },
  )
})
