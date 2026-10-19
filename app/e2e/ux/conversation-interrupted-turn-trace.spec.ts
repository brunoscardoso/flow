/**
 * UX sweep — flow 4: what the transcript says about a turn that ENDED WITHOUT
 * FINISHING (round 21).
 *
 * The conversation pane has been swept 16 times, and "a turn must never end
 * silently" already has three accepted fixes behind it:
 *
 *   - `#846` — a failed turn wiped its own error card on reconcile; the pane now
 *     re-appends it after the rebuild.
 *   - `#1048` — a turn that failed for a BACKGROUND thread left nothing; main now
 *     persists the failure note BEFORE emitting, so history rebuilds show it.
 *   - `#981` — a user Stop was reported as a crash; main now persists the calm
 *     `Interrupted by you` row and settles the thread `idle`.
 *
 * All three cover a turn that ended while the app was RUNNING. The fourth exit —
 * the app itself going away mid-turn (⌘Q, a crash, an update restart) — was
 * never driven. It is handled by `ThreadStore.reconcileInterruptedWork()`, which
 * at boot flips every `working`/`needs-decision`/`blocked` thread to `idle` and
 * every open tool_call row to `error` with `{"interrupted":true}` — and persists
 * NO message row. Nothing else writes one either: assistant text is persisted
 * once, when the COMPLETE SDK assistant message arrives (stream-bridge.ts), so a
 * half-streamed answer is never stored.
 *
 * The two live tests are the controls (the reconcile really runs; a real tool
 * failure really renders as one). The two `test.fixme` tripwires encode the
 * defects fix-agnostically:
 *
 *   1. after a quit mid-turn the transcript carries NO trace of the cut-off turn
 *      — just your question, alone, under an idle thread;
 *   2. a tool call aborted by a deliberate stop is presented as a FAILURE (red
 *      error glyph) whose only explanation is the raw internal JSON
 *      `{"interrupted": true, "reason": "interrupted"}` — the crash-vs-stop
 *      confusion #981 fixed one layer up, still live on the tool card.
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SCREENS = 'e2e/ux/__screens'

// ── harness ────────────────────────────────────────────────────────────────

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** No account is connected here, so the first-run wizard opens on EVERY boot. */
async function dismissOnboarding(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await win.keyboard.press('Escape')
  await expect(wizard).toHaveCount(0)
}

/** Boot AND adding a root mount overlays asynchronously; dismiss until nothing
 *  re-appears for a quiet window, or they swallow every click. */
async function settleOverlays(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  for (let i = 0; i < 6; i++) {
    if ((await overlay.count()) === 0) {
      await win.waitForTimeout(500)
      if ((await overlay.count()) === 0) return
    }
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
}

/** A throwaway git repo. `.git/info/exclude` hides the IDE's own scaffold so the
 *  provisioner's background writes never race an assertion. */
function mkRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  writeFileSync(join(dir, 'a.txt'), 'seed\n')
  return dir
}

/** Best-effort teardown: the IDE provisioner keeps writing its scaffold into a
 *  freshly added root while the app winds down, so a delete can land mid-write
 *  (ENOTEMPTY). Throwaway temp dirs — never fail a test on cleanup. */
function cleanup(...dirs: string[]): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // temp dir, next boot's tmp reaper gets it
    }
  }
}

interface ToolCallRecord {
  id: string
  threadId: string
  messageId: string | null
  toolName: string
  inputJson: string | null
  outputJson: string | null
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  startedAt: string
  completedAt: string | null
}

interface FlowWindow {
  flow: {
    project: {
      add(r: { path: string }): Promise<unknown>
      setActive(r: { rootPath: string }): Promise<unknown>
    }
    threads: {
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
      get(r: { threadId: string }): Promise<{ status: string } | null>
      update(r: { threadId: string; patch: { status?: string } }): Promise<unknown>
    }
    messages: {
      append(r: { threadId: string; role: string; content: string }): Promise<unknown>
    }
  }
}

async function openProject(win: Page, repo: string): Promise<void> {
  await win.evaluate(async (p) => {
    const flow = (window as unknown as FlowWindow).flow
    await flow.project.add({ path: p })
    await flow.project.setActive({ rootPath: p })
  }, repo)
}

/** Open the Compact work row and its first step (plan_chat-cleanup: a request
 *  is one row, its tools inside a step), so the cards inside are reachable. */
async function openRequestFold(win: Page): Promise<void> {
  const row = win.locator('.fl-request-row').first()
  await expect(row).toBeVisible()
  if (!(await row.evaluate((el) => el.classList.contains('expanded')))) {
    await row.locator('.fl-request-row-header').click()
  }
  const step = row.locator('.fl-request-row-step').first()
  if (!(await step.evaluate((el) => el.classList.contains('expanded')))) {
    await step.locator('.fl-request-row-step-header').click()
  }
}

async function openThread(win: Page, title: string): Promise<void> {
  await settleOverlays(win)
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator('.fl-conversation')).toBeVisible()
}

async function threadStatus(win: Page, threadId: string): Promise<string | undefined> {
  return win.evaluate(
    async (id) =>
      (await (window as unknown as FlowWindow).flow.threads.get({ threadId: id }))?.status,
    threadId,
  )
}

/** Emit a real `threads:stream` event, exactly as the agent-manager does. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

/**
 * The shared scenario for both quit-mid-turn tests: a thread whose question is
 * persisted and whose status is `working` when the app goes away, reopened after
 * a relaunch against the SAME userData dir. `after` receives the reopened
 * window; both tests read the same reality, only their assertions differ.
 */
async function quitMidTurnThenRelaunch(
  after: (win: Page, threadId: string) => Promise<void>,
): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-cutoff-'))
  const repo = mkRepo('flow-ux-cutoff-repo-')
  try {
    let app = await launch(userDataDir)
    let win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await settleOverlays(win)
    await openProject(win, repo)

    // Mid-turn: the user's question is persisted (AgentManager stores it before
    // the session even starts) and the thread is `working`.
    const threadId = await win.evaluate(async (p) => {
      const flow = (window as unknown as FlowWindow).flow
      const thread = await flow.threads.create({ projectRoot: p, title: 'Cut Off Turn' })
      await flow.messages.append({
        threadId: thread.id,
        role: 'user',
        content: 'Refactor the auth module and explain what you changed.',
      })
      await flow.threads.update({ threadId: thread.id, patch: { status: 'working' } })
      return thread.id
    }, repo)

    // The setup is real: the thread IS running when the app goes away.
    expect(await threadStatus(win, threadId)).toBe('working')

    await app.close() // ⌘Q / crash / update restart, mid-turn

    app = await launch(userDataDir)
    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await settleOverlays(win)
    await openThread(win, 'Cut Off Turn')

    try {
      await after(win, threadId)
    } finally {
      await app.close()
    }
  } finally {
    cleanup(userDataDir, repo)
  }
}

// ── live guards ────────────────────────────────────────────────────────────

test('a quit mid-turn settles the thread at boot and the transcript still renders', async () => {
  test.setTimeout(180_000)
  await quitMidTurnThenRelaunch(async (win, threadId) => {
    // The app DID notice: reconcileInterruptedWork settled the thread at boot,
    // so the composer offers Send rather than a phantom Interrupt.
    await expect.poll(() => threadStatus(win, threadId), { timeout: 10_000 }).not.toBe('working')
    // …and the thread's history renders (the control that makes the trace
    // tripwire below non-vacuous — the feed is alive, it just says nothing).
    await expect(win.locator('.fl-conv-feed')).toContainText('Refactor the auth module')
    await win.screenshot({ path: `${SCREENS}/conversation-cutoff-after-relaunch.png` })
  })
})

test('a genuinely failed tool call renders as an error card', async () => {
  test.setTimeout(180_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-toolfail-'))
  const repo = mkRepo('flow-ux-toolfail-repo-')
  try {
    const app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await dismissOnboarding(win)
    await settleOverlays(win)
    await openProject(win, repo)
    const threadId = await win.evaluate(async (p) => {
      const t = await (window as unknown as FlowWindow).flow.threads.create({
        projectRoot: p,
        title: 'Tool Failure',
      })
      return t.id
    }, repo)
    await openThread(win, 'Tool Failure')

    const running: ToolCallRecord = {
      id: 'tc-fail-1',
      threadId,
      messageId: null,
      toolName: 'Bash',
      inputJson: JSON.stringify({ command: 'npm run nope' }),
      outputJson: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      completedAt: null,
    }
    await emitStream(app, { kind: 'tool-start', threadId, toolCall: running })
    const card = win.locator('.fl-tool-card')
    await expect(card).toHaveAttribute('data-status', 'running')

    await emitStream(app, {
      kind: 'tool-end',
      threadId,
      toolCall: {
        ...running,
        outputJson: JSON.stringify({ stderr: 'missing script: nope', exitCode: 1 }),
        status: 'error',
        completedAt: new Date().toISOString(),
      },
    })
    // This is what the error status is FOR — which is what makes the tripwire
    // below (the SAME status for a deliberate stop) a real conflation.
    await expect(card).toHaveAttribute('data-status', 'error')
    await app.close()
  } finally {
    cleanup(userDataDir, repo)
  }
})

// ── former tripwires, now live guards (fixed by #1216 / #1217) ─────────────

test(
  'a turn cut off by a quit must leave a trace in the transcript, not just your question under an idle thread',
  async () => {
    test.setTimeout(180_000)
    await quitMidTurnThenRelaunch(async (win) => {
      const feed = win.locator('.fl-conv-feed')
      await expect(feed).toContainText('Refactor the auth module')
      const trace = win.locator('.fl-conv-system, .fl-conv-entry-error')
      expect(
        await trace.count(),
        `the turn was cut off by the quit and the transcript says nothing about it — ` +
          `no system note, no error card (feed: ${JSON.stringify(await feed.innerText())})`,
      ).toBeGreaterThan(0)
    })
  },
)

test(
  'a tool call ended by a deliberate stop must not read as a crash (and must not explain itself in raw JSON)',
  async () => {
    test.setTimeout(180_000)
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-abort-'))
    const repo = mkRepo('flow-ux-abort-repo-')
    try {
      const app = await launch(userDataDir)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await dismissOnboarding(win)
      await settleOverlays(win)
      await openProject(win, repo)
      const threadId = await win.evaluate(async (p) => {
        const t = await (window as unknown as FlowWindow).flow.threads.create({
          projectRoot: p,
          title: 'Aborted Tool',
        })
        return t.id
      }, repo)
      await openThread(win, 'Aborted Tool')

      const running: ToolCallRecord = {
        id: 'tc-abort-1',
        threadId,
        messageId: null,
        toolName: 'Bash',
        inputJson: JSON.stringify({ command: 'npm run build' }),
        outputJson: null,
        status: 'running',
        startedAt: new Date().toISOString(),
        completedAt: null,
      }
      // A real turn is running when its tool starts. Since 85a19380 a tool with
      // no turn running is a background agent's and goes to the feed, so the
      // turn edge comes first or the work row this test opens never exists.
      await emitStream(app, { kind: 'status', threadId, status: 'working' })
      await emitStream(app, { kind: 'tool-start', threadId, toolCall: running })
      const card = win.locator('.fl-tool-card')
      await expect(card).toHaveAttribute('data-status', 'running')

      // The user presses Stop. `StreamBridge.abortOpenToolCalls()` finalizes
      // every open call with EXACTLY this record — since #1217 status
      // 'interrupted' and a sentence as the output (it used to be 'error' plus
      // the raw `{"interrupted": true, …}` marker, which is what this tripwire
      // was filed against) — while the turn itself settles with the calm
      // "Interrupted by you" note (#981).
      await emitStream(app, {
        kind: 'tool-end',
        threadId,
        toolCall: {
          ...running,
          outputJson: 'Stopped when you interrupted the turn',
          status: 'interrupted',
          completedAt: new Date().toISOString(),
        },
      })
      await emitStream(app, { kind: 'status', threadId, status: 'idle' })

      // The request folds first — in Compact it is one work row with the card
      // inside a step (plan_chat-cleanup). What this test guards is untouched:
      // a deliberate stop must not read as a crash, and must not explain itself
      // in raw JSON.
      await openRequestFold(win)
      await expect(card).toBeVisible()
      await card.locator('.fl-tool-line').click()
      await expect(card.locator('.fl-tool-detail')).toBeVisible()
      await win.screenshot({ path: `${SCREENS}/conversation-aborted-tool-card.png` })

      await expect(
        card,
        'a deliberate stop is not a tool failure — the card must not carry the error status',
      ).not.toHaveAttribute('data-status', 'error')
      await expect(
        card,
        'the card explains the stop with raw internal JSON instead of a sentence',
      ).not.toContainText('"interrupted"')
      await expect(card).toHaveAttribute('data-status', 'interrupted')
      await app.close()
    } finally {
      cleanup(userDataDir, repo)
    }
  },
)
