/**
 * Seeding + reading helpers for the thread-worktree specs (thread-worktrees
 * Phase 8).
 *
 * Three things every one of those specs needs, and none of them belong in a
 * spec body:
 *
 *  1. A repository a thread's checkout can actually be cut from — which means
 *     AT LEAST ONE COMMIT. `seedProject` leaves an unborn repo, and an unborn
 *     repo is refused upstream by design ("this project has no commits yet"),
 *     so a spec seeded that way would be testing the refusal, not the feature.
 *
 *  2. Agent auth ISOLATED from the machine. The fixture inherits the developer's
 *     environment, so a first message would otherwise start a real turn against
 *     their real account — slow, billable, and non-deterministic. `AGENT_AUTH_ISOLATED`
 *     points the agent at an empty config dir and deletes every inherited token
 *     that outranks it (the same three `INHERITED_AUTH_TOKENS` the app strips
 *     when it binds a session to an account). The worktree is created BEFORE
 *     the session spawns, so the feature under test runs in full either way.
 *
 *  3. A thread's checkout lives in a HIDDEN SIBLING of the repository
 *     (`.{repo}-threads/<thread id>`), which is outside the seeded dir that
 *     `cleanupSeeds` removes. Left behind, it survives the test run — so the
 *     container is tracked here and removed with it.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Page } from '@playwright/test'

import { seedProject } from './seed'

/**
 * Config dir the agent is pointed at — empty, so no account resolves.
 *
 * ONE FIXED PATH, not a fresh temp dir per run: the agent CLI writes its own
 * state into whatever config dir it is given, and a per-run directory would
 * leave one behind for every spec file that ever ran. Its emptiness of
 * CREDENTIALS is what matters, and nothing here ever puts any in.
 */
const ISOLATED_CONFIG_DIR = join(tmpdir(), 'flow-e2e-agent-auth-void')
mkdirSync(ISOLATED_CONFIG_DIR, { recursive: true })

/**
 * Environment that guarantees a spec cannot reach a real agent account.
 *
 * `CLAUDE_CONFIG_DIR` is the app's own isolation mechanism (it is how one
 * project is bound to one account), and the three deleted keys are exactly the
 * tokens that OUTRANK it — leaving any of them set would hand the session the
 * developer's credentials through the back door.
 */
export const AGENT_AUTH_ISOLATED: Record<string, string | undefined> = {
  CLAUDE_CONFIG_DIR: ISOLATED_CONFIG_DIR,
  ANTHROPIC_API_KEY: undefined,
  ANTHROPIC_AUTH_TOKEN: undefined,
  CLAUDE_CODE_OAUTH_TOKEN: undefined,
}

/** Checkout containers created by seeded repos this run, removed on teardown. */
const containers: string[] = []

/** Run git in a directory, returning stdout (throws on failure). */
export function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

/**
 * A seeded project with one commit on `main` and a clean working tree.
 *
 * Clean matters twice over: the dirty-tree offer (commit / stash / start clean)
 * is put on screen only when the project has TRACKED changes, and a spec that
 * wants the plain path must not meet a dialog it never asked about.
 */
export async function seedCommittedRepo(win: Page, prefix: string): Promise<string> {
  const dir = await seedProject(win, prefix, (d) => {
    git(d, 'config', 'user.email', 'qa@flow.test')
    git(d, 'config', 'user.name', 'QA Bot')
    git(d, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    // The IDE's auto-provisioner also drops a `loops/` directory into every
    // project it scaffolds. `seedProject` excludes the rest of that scaffold;
    // this one is excluded here so a spec can say "the project's own tree is
    // untouched" and mean the project's files rather than the app's.
    appendFileSync(join(d, '.git', 'info', 'exclude'), 'loops/\n')
    writeFileSync(join(d, 'README.md'), '# seeded\n')
    git(d, 'add', 'README.md')
    git(d, 'commit', '-q', '-m', 'chore: base commit')
  })
  containers.push(threadCheckoutContainer(dir))
  return dir
}

/** The hidden sibling directory holding every thread checkout of a repo. */
export function threadCheckoutContainer(repoRoot: string): string {
  return join(dirname(repoRoot), `.${basename(repoRoot)}-threads`)
}

/** Remove the checkout containers of every repo seeded through this module. */
export function cleanupCheckouts(): void {
  while (containers.length) {
    const dir = containers.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
}

/** One thread, as the store reports it over `threads:list`. */
export interface ThreadRecordView {
  id: string
  title: string
  status: string
  worktreePath: string | null
  worktreeBranch: string | null
  worktreeBase: string | null
}

/** Read one thread's record straight from the store. */
export async function readThread(
  win: Page,
  projectRoot: string,
  threadId: string,
): Promise<ThreadRecordView | null> {
  return win.evaluate(
    async ([root, id]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const threads = await flow.threads.list({ projectRoot: root })
      return (threads as ThreadRecordView[]).find((thread) => thread.id === id) ?? null
    },
    [projectRoot, threadId],
  ) as Promise<ThreadRecordView | null>
}

/** Every thread of a project, as the store reports them. */
export async function listThreads(win: Page, projectRoot: string): Promise<ThreadRecordView[]> {
  return win.evaluate(async (root: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    return flow.threads.list({ projectRoot: root })
  }, projectRoot) as Promise<ThreadRecordView[]>
}

/**
 * How long a thread's checkout may take to appear after its first message.
 *
 * MEASURED, not guessed: `git worktree add` is the cost and it is proportional
 * to the repository — 1.3s to 3.5s on the repos this feature was built against,
 * and the seeded one here is a single file. The budget is the slow end plus
 * room for a loaded machine running the whole suite serially.
 */
export const CHECKOUT_BUDGET_MS = 30_000

/** Interval between store reads while waiting for a checkout. */
const CHECKOUT_POLL_MS = 200

/**
 * Wait until the thread owns a checkout, and return its record.
 *
 * Polls the STORE rather than the disk: `worktree_path` is written in the same
 * step that creates the directory, and it is the column every consumer reads.
 * A directory that exists with no column behind it would be a half-created
 * checkout — which this would (correctly) never report as ready.
 */
export async function waitForCheckout(
  win: Page,
  projectRoot: string,
  threadId: string,
  budgetMs: number = CHECKOUT_BUDGET_MS,
): Promise<ThreadRecordView> {
  const deadline = Date.now() + budgetMs
  let last: ThreadRecordView | null = null
  while (Date.now() < deadline) {
    last = await readThread(win, projectRoot, threadId)
    if (last?.worktreePath != null && existsSync(last.worktreePath)) return last
    await new Promise((settle) => setTimeout(settle, CHECKOUT_POLL_MS))
  }
  throw new Error(
    `the thread never got a checkout within ${budgetMs}ms (last record: ${JSON.stringify(last)})`,
  )
}

/** Longest a freshly-added project may take to finish being provisioned. */
const SETTLE_BUDGET_MS = 90_000

/** How long the derived scope must then hold still to count as settled. */
const SETTLE_QUIET_MS = 2_500

/**
 * Wait until a freshly-added project has stopped moving under the app's feet.
 *
 * WHY A SPEC MUST DO THIS. Adding a root kicks off the IDE's auto-provisioner,
 * and the stamp it writes when it finishes broadcasts `project:listChanged`
 * — which is one of the triggers that re-derives the thread scope. A spec that
 * opens its thread while that is still in flight can be handed a scope refresh
 * it never caused, and would then report the feature working when what actually
 * worked was the seeding. It is a coin flip, and it was observed landing on both
 * faces while this spec was being written.
 *
 * A real project is warm: it was provisioned when the app started, long before
 * anyone opened a thread in it. This makes the seeded one warm too, so what
 * happens after it is caused by the thread and nothing else.
 *
 * TWO GATES, because either alone is a guess: the root's own provisioning state
 * must reach a terminal value (`ready` / `failed` / `idle` after a stamp), and
 * only THEN must the derived scope hold still — the quiet period is measured
 * after the noisy thing has finished, not instead of waiting for it.
 */
export async function settleWorktree(win: Page, projectRoot: string): Promise<void> {
  const deadline = Date.now() + SETTLE_BUDGET_MS

  const rootState = async (): Promise<{ state: string; stamped: boolean } | null> =>
    win.evaluate(async (root: string) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const roots = (await flow.project.list()) as {
        rootPath: string
        provisioningState?: string
        provisionedAt?: string
      }[]
      const match = roots.find((entry) => entry.rootPath === root)
      if (match === undefined) return null
      return { state: match.provisioningState ?? 'idle', stamped: match.provisionedAt !== undefined }
    }, projectRoot)

  while (Date.now() < deadline) {
    const current = await rootState()
    // `provisioning` is the only state that is still going to move. `ready` and
    // `failed` are terminal; a stamped `idle` is a root that needed nothing.
    if (current !== null && current.state !== 'provisioning' && (current.stamped || current.state !== 'idle')) {
      break
    }
    await new Promise((settle) => setTimeout(settle, CHECKOUT_POLL_MS))
  }

  const readScope = async (): Promise<string> =>
    JSON.stringify(
      await win.evaluate(async () => {
        const flow = (window as unknown as { flow: Record<string, any> }).flow
        return flow.project.getThreadScope({})
      }),
    )
  let previous = await readScope()
  while (Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, SETTLE_QUIET_MS))
    const current = await readScope()
    if (current === previous) return
    previous = current
  }
}

/** Every worktree git itself reports for a repository, by absolute path. */
export function registeredWorktrees(repoRoot: string): string[] {
  return git(repoRoot, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim())
}

/** Local branch names, `thread/*` included. */
export function localBranches(repoRoot: string): string[] {
  return git(repoRoot, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * Start a thread IN ITS OWN CHECKOUT the way a person does now: "+ New thread"
 * opens the new-thread page, the branch chip's Worktree switch is thrown, and
 * Create sends the first message — which is what cuts the checkout.
 *
 * It used to be "+ New thread" (a thread at once, its checkout on by default)
 * and a first message typed into the composer. Both halves changed: a thread
 * exists only once Create sends (f7935aff), and the chip opens on the PROJECT
 * so a checkout is a choice, not a default. Returns the new thread's id.
 */
export async function startThreadInCheckout(
  win: Page,
  projectRoot: string,
  message: string,
): Promise<string> {
  const before = new Set((await listThreads(win, projectRoot)).map((thread) => thread.id))
  await win.locator('fl-button[aria-label="New thread"]').click()
  await win.locator('.fl-newthread').waitFor({ state: 'visible', timeout: 20_000 })
  await win.locator('.fl-newthread-body').fill(message)
  await win.locator('.fl-newbranch-chip').click()
  const menu = win.locator('.fl-fmenu')
  await menu.waitFor({ state: 'visible' })
  const worktreeSwitch = menu.locator('.fl-wt-track')
  if ((await worktreeSwitch.getAttribute('aria-checked')) !== 'true') await worktreeSwitch.click()
  await menu.locator('.fl-wt-track[aria-checked="true"]').waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  await win.locator('.fl-newthread-footer fl-button', { hasText: 'Create thread' }).click()
  await win.locator('.fl-newthread').waitFor({ state: 'hidden', timeout: 30_000 })
  let created = ''
  for (let attempt = 0; attempt < 50 && created === ''; attempt += 1) {
    created = (await listThreads(win, projectRoot)).find((thread) => !before.has(thread.id))?.id ?? ''
    if (created === '') await win.waitForTimeout(200)
  }
  if (created === '') throw new Error('Create thread made no thread in the store')
  return created
}
