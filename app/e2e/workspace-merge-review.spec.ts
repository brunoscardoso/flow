/**
 * Agent-decided conflicts (plan `agent_decided_conflicts`, Phase 7): a Workspace
 * sync that collides with another machine is decided by the agent, merged and
 * committed HERE without being shared, reviewed in Settings → Workspaces, and
 * only what the person agreed to reaches the shared repository.
 *
 * Real everywhere it can be: a seeded code repo, a temp Flow folder per
 * "machine", every sync going through main → the bundled CLI, and a Workspace
 * remote that is a LOCAL bare repository behind an ordinary https address
 * (fixtures/workspaces.ts — git is locked to `file`, HOME is the sandbox's).
 * The "other machine" is the repo's own CLI build with its own Flow folder.
 *
 * STOOD IN FOR, in main, through `e2e-seams.ts` (honoured only under
 * FLOW_E2E=1): the decider's fast sorting call (`decideFast`) and its merge
 * call (`mergeIntent`). Nothing here reaches a model.
 *
 * The scenario — three files changed on both machines:
 *  · a plan the agent keeps as this machine wrote it   → group "kept mine";
 *  · a plan the agent merges into one text             → group "merged";
 *  · a decision document (the agent only ever suggests) → "Needs you".
 * The person presses "Agree to all groups except Needs you": the two plans
 * are shared as decided, the decision is shared only as the Workspace's
 * version, and this machine's decision text never leaves the machine.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { ElectronApplication, Locator, Page } from '@playwright/test'

import { expect, test } from './fixtures/electron'
import { addProjects, closeProjectOnboarding, lazySandbox, openWorkspaceSettings, type WorkspaceSandbox } from './fixtures/workspaces'

const PLAN_KEPT = 'projects/backend/plans/plan_orders_page_v1.md'
const PLAN_MERGED = 'projects/backend/plans/plan_search_v1.md'
const DECISION = 'projects/backend/brain/decisions/queue.md'

const BASE: Record<string, string> = {
  [PLAN_KEPT]: '# Orders page\n\nShip the orders page.\n',
  [PLAN_MERGED]: '# Search\n\nAdd search.\n',
  [DECISION]: '# Queue\n\nUse a queue.\n',
}
/** The other machine's edits — published first. */
const THEIRS: Record<string, string> = {
  [PLAN_KEPT]: '# Orders page\n\nShip the orders page this week.\n',
  [PLAN_MERGED]: '# Search\n\nAdd search by order number.\n',
  [DECISION]: '# Queue\n\nUse SQS.\n',
}
/** This machine's edits — they collide on the next sync. */
const MINE: Record<string, string> = {
  [PLAN_KEPT]: '# Orders page\n\nShip the orders page with a status filter.\n',
  [PLAN_MERGED]: '# Search\n\nAdd search by customer name.\n',
  [DECISION]: '# Queue\n\nUse Kafka.\n',
}
/** What the stand-in merge answers for the merged plan. */
const MERGED_TEXT = '# Search\n\nAdd search by order number and by customer name.\n'

/** The fast model's verdict per file (the stand-in reads the item's file off the prompt). */
const VERDICTS: Record<string, string> = {
  [PLAN_KEPT]: 'ours',
  [PLAN_MERGED]: 'merge',
  [DECISION]: 'theirs',
}

function writeIn(folder: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    const full = join(folder, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
}

function workspaceFolder(sandbox: WorkspaceSandbox, flowHome: string): string {
  const listed = sandbox.cli(['status'], flowHome).workspaces as Array<{ slug: string; path: string }>
  const path = listed.find((workspace) => workspace.slug === 'acme')?.path
  if (path === undefined) throw new Error('the Acme Workspace is not on this machine')
  return path
}

/** Does any file of the bare repository's `main` contain `text`? (`git grep`: 0 = found, 1 = searched, nothing.) */
function remoteContains(sandbox: WorkspaceSandbox, text: string): boolean {
  const result = spawnSync('git', ['--git-dir', sandbox.bareDir, 'grep', '-l', '-F', text, 'main'], {
    env: { ...process.env, ...sandbox.gitEnv },
    encoding: 'utf8',
  })
  if (result.status !== 0 && result.status !== 1) throw new Error(`git grep failed: ${result.stderr}`)
  return result.status === 0
}

/** Stand in for the decider's two model calls, and count them. */
async function installDeciderStandIns(app: ElectronApplication): Promise<void> {
  await app.evaluate(
    (_electron, input) => {
      const g = globalThis as unknown as {
        __flowE2ESeams?: Record<string, unknown>
        __flowE2EDecider?: { fast: number; merge: number; files: string[] }
      }
      const calls = { fast: 0, merge: 0, files: [] as string[] }
      g.__flowE2EDecider = calls
      g.__flowE2ESeams = {
        ...(g.__flowE2ESeams ?? {}),
        decideFast: async ({ prompt }: { prompt: string }) => {
          calls.fast += 1
          const lines: string[] = []
          for (const match of prompt.matchAll(/<item label="([^"]+)" kind="[^"]*" file="([^"]+)"/g)) {
            const file = match[2] ?? ''
            calls.files.push(file)
            lines.push(`${match[1]} ${input.verdicts[file] ?? 'unsure'} the stand-in read both sides`)
          }
          return lines.join('\n')
        },
        mergeIntent: async () => {
          calls.merge += 1
          return input.merged
        },
      }
    },
    { verdicts: VERDICTS, merged: MERGED_TEXT },
  )
}

async function deciderCalls(app: ElectronApplication): Promise<{ fast: number; merge: number; files: string[] }> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __flowE2EDecider?: { fast: number; merge: number; files: string[] } }).__flowE2EDecider ?? {
        fast: 0,
        merge: 0,
        files: [],
      },
  )
}

async function syncState(page: Page): Promise<string> {
  const status = (await page.evaluate(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the preload bridge
    (window as unknown as { flow: any }).flow.workspaces.syncStatus({ slug: 'acme' }),
  )) as { state: string }
  return status.state
}

async function pressSyncNow(card: Locator): Promise<void> {
  const syncNow = card.locator('[data-part="sync-now"]')
  await expect(syncNow).toBeEnabled({ timeout: 60_000 })
  await syncNow.click()
}

const seeded = lazySandbox('merge-review', (sandbox) => {
  const backend = sandbox.seedRepo('backend')
  sandbox.cli(['create', '--name=Acme', `--remote=${sandbox.remoteUrl}`])
  sandbox.cli(['link', `--target=${backend}`, '--workspace=acme'])
  // The base every machine starts from, published by this machine.
  writeIn(workspaceFolder(sandbox, sandbox.flowHome), BASE)
  sandbox.cli(['sync', '--workspace=acme'])
  // The other machine joins at that base (its own Flow folder; no app runs there).
  const other = sandbox.newMachine('machine-2')
  sandbox.cli(['join', `--remote=${sandbox.remoteUrl}`], other.flowHome)
  return { backend, other }
})

test.use({ appEnv: async ({}, use) => use(seeded.get().sandbox.appEnv()) })
test.afterAll(async () => seeded.cleanup())

test('the agent decides a colliding sync, the person agrees to all groups except Needs you, and only agreed content reaches the shared repository', async ({
  app,
  window,
}) => {
  const { sandbox, backend, other } = seeded.get()
  test.setTimeout(300_000)
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  // The base is on the shared repository (the positive every later check stands against).
  for (const [path, text] of Object.entries(BASE)) expect(sandbox.remoteFile(path)).toBe(text)

  await installDeciderStandIns(app)
  await addProjects(window, [backend])
  await closeProjectOnboarding(window, 3_000)
  await expect(window.locator('.fl-ws-switcher .fl-project-name')).toHaveText('Acme', { timeout: 60_000 })

  const section = await openWorkspaceSettings(window)
  const card = section.locator('.fl-wss-card[data-workspace="acme"]')
  await expect(card).toBeVisible({ timeout: 15_000 })

  // A sync now — so the open's own sync is behind us and its cooldown keeps it
  // from running between the two machines' edits below.
  await pressSyncNow(card)
  await expect(card.locator('[data-part="sync-status"]')).toHaveText(/^(Synced|Up to date)/, { timeout: 90_000 })

  // ── The other machine publishes its edits; this machine edits the same files ──
  writeIn(workspaceFolder(sandbox, other.flowHome), THEIRS)
  expect(sandbox.cli(['sync', '--workspace=acme'], other.flowHome)).toMatchObject({ state: 'synced', pushed: true })
  for (const [path, text] of Object.entries(THEIRS)) expect(sandbox.remoteFile(path)).toBe(text)
  writeIn(workspaceFolder(sandbox, sandbox.flowHome), MINE)

  // ── Sync now: the agent decides, the merge is committed here and waits for review ──
  await pressSyncNow(card)
  const review = card.locator('[data-part="merge-review"] .fl-mrc-review')
  await expect(review).toBeVisible({ timeout: 120_000 })
  await expect.poll(() => syncState(window), { timeout: 30_000 }).toBe('review')
  await expect(review.locator('.fl-mrc-group[data-group="kept-mine"]')).toBeVisible()
  await expect(review.locator('.fl-mrc-group[data-group="merged"]')).toBeVisible()
  const needsYou = review.locator('[data-part="needs-you"]')
  await expect(needsYou).toBeVisible()
  await expect(needsYou.locator('.fl-mrc-need')).toHaveCount(1)

  // The agent really decided (the positive): all three items were sorted, one merge was written…
  const calls = await deciderCalls(app)
  expect(calls.fast).toBeGreaterThanOrEqual(1)
  expect([...new Set(calls.files)].sort()).toEqual([DECISION, PLAN_KEPT, PLAN_MERGED].sort())
  expect(calls.merge).toBe(1)
  // …and nothing it decided was shared yet (the absence): the remote still holds the other machine's text.
  for (const [path, text] of Object.entries(THEIRS)) expect(sandbox.remoteFile(path)).toBe(text)
  expect(remoteContains(sandbox, 'status filter')).toBe(false)
  expect(remoteContains(sandbox, 'by order number and by customer name')).toBe(false)
  expect(remoteContains(sandbox, 'Use Kafka')).toBe(false)

  // ── The person agrees to every group; "Needs you" is never agreed in bulk ──
  const agreeAll = review.locator('[data-part="agree-all"]')
  await expect(agreeAll).toHaveText('Agree to all groups except Needs you')
  await expect(agreeAll).toBeEnabled()
  await agreeAll.click()

  // The agreed groups are shared as decided…
  await expect.poll(() => sandbox.remoteFile(PLAN_KEPT), { timeout: 120_000 }).toBe(MINE[PLAN_KEPT])
  expect(sandbox.remoteFile(PLAN_MERGED)).toBe(MERGED_TEXT)
  // …the decision only as the Workspace's version, and this machine's decision text nowhere on the remote.
  expect(sandbox.remoteFile(DECISION)).toBe(THEIRS[DECISION])
  expect(remoteContains(sandbox, 'Use Kafka')).toBe(false)
  // The agreed decisions were recorded in the shared record and shared with the team; the held one was not.
  const record = sandbox.remoteFile('merge-decisions.jsonl') ?? ''
  expect(record).toContain(PLAN_KEPT)
  expect(record).toContain(PLAN_MERGED)
  expect(record).not.toContain(DECISION)

  // The decision still waits for the person, here.
  await expect(needsYou.locator('.fl-mrc-need')).toHaveCount(1, { timeout: 30_000 })
  await expect(review.locator('.fl-mrc-group[data-group="kept-mine"]')).toHaveCount(0, { timeout: 30_000 })

  expect(errors, errors.join('\n')).toEqual([])
})
