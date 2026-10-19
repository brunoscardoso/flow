import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { waitForFlowState } from './fixtures/seed'
import { dismissOnboarding } from '../fixtures/electron'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Notifications — DOES THE FLOW SURFACE ACTUALLY FOLLOW A REAL PROJECT?
 * Flow 13 of the progressive UX sweep, round 19.
 *
 * Eighteen prior flow-13 specs drive the notification center's lifecycle, and
 * almost all of them raise notifications by dispatching `flow:notify` in the
 * renderer — the shape the main process WOULD have sent. That proves the center
 * renders correctly; it proves nothing about whether the main-process
 * `FlowObserver` ever produces those events for a project the user opened.
 *
 * This spec closes that gap by writing only REAL files into a real project's
 * `flow/` dir (STATE.md, .flowconfig, .heartbeat-prompt.md — exactly what the
 * plan-flow daemon writes) and asserting what the user sees. Two seams:
 *
 *  1. WATCH LIFETIME. The IDE auto-provisioner replaces a fresh project's
 *     `flow/` directory with a symlink into the central vault ~1s AFTER
 *     `project:add` resolves — i.e. after FlowObserver has already
 *     started chokidar on the original inode. For a project added THIS session
 *     the watcher is therefore orphaned and nothing in `flow/` is ever observed
 *     again (#1164). A boot-restored project (control) is watched fine.
 *
 *  2. OUT-OF-BAND RESOLUTION. A blocked prompt can be answered somewhere else
 *     (a Telegram reply, a CLI agent session archiving it, the daemon consuming
 *     it). The reply card is then removed with `card.remove()` — taking the
 *     answer the user was mid-way through typing with it, with no toast and no
 *     inbox record that the question was resolved at all (#1165). The sibling
 *     path (#1004, a prompt swapped in for the same root) deliberately carries
 *     the draft into the replacement card and flags it.
 *
 * The two-launch harness is what makes seam 1 attributable: the SAME project,
 * the SAME files, the SAME writes — watched when restored at boot, dead when
 * added at runtime.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SETTLE_MS = 6_000
const OBSERVE_TIMEOUT = 12_000

const trash: string[] = []
test.afterAll(() => {
  for (const d of trash) rmSync(d, { recursive: true, force: true })
})

/** A throwaway git repo with a pre-existing `flow/` dir the daemon would write. */
function makeProject(prefix: string): string {
  // Under $HOME, not /tmp: the temp-dir chokidar watcher is unreliable on macOS
  // and would make a missed event ambiguous.
  const dir = mkdtempSync(join(homedir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(
    join(dir, 'flow', 'STATE.md'),
    '# State\n\n- **Active Skill**: execute-plan\n- **Current Phase**: Phase 1\n',
    'utf-8',
  )
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'autopilot: false\n', 'utf-8')
  trash.push(dir)
  // Provisioning mirrors the project into the central Obsidian vault; clean that
  // up too so repeat runs never inherit a previous run's vault dir.
  trash.push(join(homedir(), 'plan-flow', 'brain', 'projects', dir.split('/').pop() as string))
  return dir
}

async function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

async function shellOf(app: ElectronApplication): Promise<Page> {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await dismissOnboarding(window)
  return window
}

/** Add a project the way `project:open` does after its folder picker. */
async function addRoot(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    try {
      const key = 'flow.onboarded'
      const seen: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (!seen.includes(p)) seen.push(p)
      localStorage.setItem(key, JSON.stringify(seen))
    } catch {
      /* convenience only — keeps the per-project flow overlay from auto-opening */
    }
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
}

/** Main's observed state reached Phase 1 — the observer has the project. (The
 *  status bar's `flow: <skill> · <phase>` readout this used to read was retired
 *  2026-09-04.) */
async function observedPhase1(win: Page, project: string): Promise<void> {
  await waitForFlowState(win, project, (state) => (state.activePhase ?? '').includes('Phase 1'))
}

/** Poll a user-visible predicate; returns whether it ever became true. */
async function observed(
  win: Page,
  predicate: () => Promise<boolean>,
  timeout = OBSERVE_TIMEOUT,
): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await win.waitForTimeout(500)
  }
  return false
}

test.describe('notifications — a real project the user opened', () => {
  // ── Control ────────────────────────────────────────────────────────────────
  // A project RESTORED AT BOOT is watched end-to-end: a phase advance reaches
  // the status line, a task blocking raises the red indicator AND the sticky
  // reply card, and resolving the prompt clears the indicator. This is the whole
  // point of the flow status line, and it works — which is what makes the
  // runtime-added case below a property of WHEN the project was added.
  test('CONTROL: a boot-restored project is followed live (state, block, clear)', async () => {
    test.setTimeout(180_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-boot-'))
    trash.push(userDataDir)
    const project = makeProject('flow-ux-boot-')

    // Run 1 — add the project so it persists into the projects table.
    const first = await launch(userDataDir)
    await addRoot(await shellOf(first), project)
    await first.firstWindow().then((w) => w.waitForTimeout(2500))
    await first.close()

    // Run 2 — the root is restored at boot, so watch-start sees the final flow/.
    const app = await launch(userDataDir)
    const window = await shellOf(app)
    try {
      await observedPhase1(window, project)
      await window.waitForTimeout(SETTLE_MS)
      // (The phase-advance check went with the status bar's phase readout.)

      // The task blocks.
      const promptPath = join(project, 'flow', '.heartbeat-prompt.md')
      writeFileSync(promptPath, '**Task**: deploy-check\n\nApprove the migration?\n', 'utf-8')
      expect(
        await observed(window, async () => (await window.locator('.fl-flow-reply').count()) === 1),
        'a boot-restored project blocking must raise the sticky reply card',
      ).toBe(true)
      await expect(window.locator('.fl-flow-line-blocked')).toBeVisible()

      // ...and resolving it clears the indicator.
      rmSync(promptPath, { force: true })
      await expect(window.locator('.fl-flow-line-blocked')).toBeHidden({ timeout: OBSERVE_TIMEOUT })
    } finally {
      await app.close()
    }
  })

  // RETIRED 2026-10-09: the "#1164, live guard" pinned auto-provisioning
  // swapping a fresh project's flow/ for a VAULT symlink after the root was
  // announced. Provisioning no longer links flow/ into the vault (the
  // Workspaces hard migration, 2026-10-06: `init --workspace-managed` leaves
  // flow/ alone and placement links it into the Workspace), so the swap the
  // guard measured is gone — and, as the guard itself said, the contract test
  // below is the one that should now pass.

  // ── #1164, the contract ────────────────────────────────────────────────────
  // A task that blocks while the app is open MUST reach the user — that is the
  // entire reason the blocked indicator and the sticky reply card exist. On a
  // project added this session none of it fires: no phase updates, no red
  // `blocked`, no reply card, no toast. The autonomous run waits forever on an
  // answer the user was never asked for, and only an app restart recovers.
  //
  // Fix-agnostic: any mechanism that keeps the observer bound to the project's
  // flow/ dir (re-watch on provisioning completion, watch the vault target,
  // provision BEFORE announcing the root) satisfies it.
  test(
    'a task blocking on a project added this session raises the blocked prompt (#1164)',
    async () => {
      test.setTimeout(120_000)
      const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-runtime-'))
      trash.push(userDataDir)
      const project = makeProject('flow-ux-runtime-')

      const app = await launch(userDataDir)
      const window = await shellOf(app)
      try {
        await addRoot(window, project)
        await observedPhase1(window, project)
        await window.waitForTimeout(SETTLE_MS)

        // The run blocks on a question only the user can answer.
        writeFileSync(
          join(project, 'flow', '.heartbeat-prompt.md'),
          '**Task**: deploy-check\n\nThe migration drops `sessions`. Approve? Reply yes/no.\n',
          'utf-8',
        )
        const cardSeen = await observed(
          window,
          async () => (await window.locator('.fl-flow-reply').count()) === 1,
        )
        const blockedSeen = await window.locator('.fl-flow-line-blocked').isVisible()

        await window.screenshot({
          path: 'e2e/ux/__screens/notifications-runtime-project-silent.png',
        })

        expect(
          cardSeen && blockedSeen,
          `a task blocked while the app was open announced NOTHING on a project added this ` +
            `session: reply card=${cardSeen}, red blocked indicator=${blockedSeen}. ` +
            `The same project restored at boot shows both (see the control).`,
        ).toBe(true)
      } finally {
        await app.close()
      }
    },
  )

  // ── #1165, live guard ──────────────────────────────────────────────────────
  // Pins today's measured behaviour when a blocked prompt is answered somewhere
  // else while the user is typing an answer in Flow: the card and the draft are
  // gone, and the notification log's last word on that task is still
  // "Task blocked" — no resolution entry, no toast, no trace of the draft.
  test('an out-of-band resolution announces itself and keeps the draft (#1165)', async () => {
    test.setTimeout(180_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-oob-'))
    trash.push(userDataDir)
    const project = makeProject('flow-ux-oob-')

    const first = await launch(userDataDir)
    await addRoot(await shellOf(first), project)
    await first.firstWindow().then((w) => w.waitForTimeout(2500))
    await first.close()

    const app = await launch(userDataDir)
    const window = await shellOf(app)
    try {
      await observedPhase1(window, project)
      await window.waitForTimeout(SETTLE_MS)

      const promptPath = join(project, 'flow', '.heartbeat-prompt.md')
      writeFileSync(
        promptPath,
        '**Task**: deploy-check\n\nThe migration drops the `sessions` table. Approve? Reply yes/no.\n',
        'utf-8',
      )
      await expect(window.locator('.fl-flow-reply')).toHaveCount(1, { timeout: OBSERVE_TIMEOUT })

      const draft = 'no - snapshot prod first, then run only steps 1-4 of the migration'
      await window.locator('.fl-flow-reply').fill(draft)

      // Answered elsewhere: a Telegram reply, a CLI agent session archiving the
      // prompt, or the daemon consuming it. All three remove the prompt file.
      rmSync(promptPath, { force: true })
      await expect(window.locator('.fl-flow-line-blocked')).toBeHidden({ timeout: OBSERVE_TIMEOUT })
      await window.waitForTimeout(1500)

      const trace = await window.evaluate((d) => {
        const replies = [...document.querySelectorAll('.fl-flow-reply')] as HTMLTextAreaElement[]
        return {
          cardGone: document.querySelectorAll('.fl-flow-toast:has(.fl-flow-reply)').length === 0,
          draftSurvives:
            replies.some((r) => r.value.includes(d)) || document.body.innerText.includes(d),
          toasts: [...document.querySelectorAll('.fl-flow-toast')].map(
            (t) => (t as HTMLElement).innerText.split('\n')[0],
          ),
          inbox: [...document.querySelectorAll('.fl-flow-inbox-entry')].map((e) =>
            (e as HTMLElement).innerText.replace(/\n/g, ' | '),
          ),
        }
      }, draft)

      await window.locator('.fl-flow-line-inbox').click()
      await window.screenshot({ path: 'e2e/ux/__screens/notifications-oob-draft-kept.png' })

      expect(trace.cardGone, 'the resolved prompt card is removed').toBe(true)
      // #1165 (fixed): the reply card goes, but the draft goes WITH it into the
      // announcement — never destroyed without a trace (#1004's floor).
      expect(
        trace.draftSurvives,
        `the reply being typed was destroyed with the card — ${JSON.stringify(trace)}`,
      ).toBe(true)
      // …and the log no longer stops at "Task blocked: …", which by now is false.
      expect(
        trace.inbox.some((e) => /resolved|answered|reply sent|no longer|elsewhere/i.test(e)),
        `the notification log never recorded that the prompt was resolved — ${JSON.stringify(trace.inbox)}`,
      ).toBe(true)
    } finally {
      await app.close()
    }
  })

  // ── #1165, the contract ────────────────────────────────────────────────────
  // #1004 established the invariant for the sibling path: a card replaced by a
  // swapped-in prompt carries the user's draft into its replacement precisely so
  // it "is never destroyed without a trace". Resolution deserves the same floor —
  // keep the draft, or say the question is gone. Fix-agnostic: a toast, an inbox
  // entry naming the resolution, or the draft preserved anywhere all satisfy it.
  test(
    'a prompt resolved out-of-band must not silently destroy the reply being typed (#1165)',
    async () => {
      test.setTimeout(180_000)
      const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-oob2-'))
      trash.push(userDataDir)
      const project = makeProject('flow-ux-oob2-')

      const first = await launch(userDataDir)
      await addRoot(await shellOf(first), project)
      await first.firstWindow().then((w) => w.waitForTimeout(2500))
      await first.close()

      const app = await launch(userDataDir)
      const window = await shellOf(app)
      try {
        await window.waitForTimeout(SETTLE_MS)
        const promptPath = join(project, 'flow', '.heartbeat-prompt.md')
        writeFileSync(promptPath, '**Task**: deploy-check\n\nApprove the migration?\n', 'utf-8')
        await expect(window.locator('.fl-flow-reply')).toHaveCount(1, { timeout: OBSERVE_TIMEOUT })

        const draft = 'no - snapshot prod first, then run only steps 1-4'
        await window.locator('.fl-flow-reply').fill(draft)
        rmSync(promptPath, { force: true })
        await expect(window.locator('.fl-flow-line-blocked')).toBeHidden({
          timeout: OBSERVE_TIMEOUT,
        })
        await window.waitForTimeout(1500)

        const told = await window.evaluate((d) => {
          const replies = [...document.querySelectorAll('.fl-flow-reply')] as HTMLTextAreaElement[]
          const text = (sel: string) =>
            [...document.querySelectorAll(sel)].map((e) => (e as HTMLElement).innerText).join('\n')
          return (
            replies.some((r) => r.value.includes(d)) ||
            /resolved|answered|elsewhere|no longer|reply sent/i.test(
              `${text('.fl-flow-toast')}\n${text('.fl-flow-inbox-entry')}`,
            )
          )
        }, draft)

        expect(
          told,
          'the reply the user was typing vanished with the card and nothing said the question ' +
            'was resolved — the sibling swap path (#1004) preserves and flags the draft',
        ).toBe(true)
      } finally {
        await app.close()
      }
    },
  )
})
