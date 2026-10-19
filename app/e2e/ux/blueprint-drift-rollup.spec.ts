import { test, expect, type Page } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openDriftPanel } from './fixtures/territory'
import { waitForLinkedStructure } from './fixtures/linked-structure'

/**
 * UX sweep — flow 10 (Blueprint), round 19: the DRIFT briefing.
 *
 * The board's Learning panel folds in a "Drift" tab whose feature docs promise
 * a signal for "code that changed since the blueprint was derived… so a change
 * to a never-learned module still produces a signal" (file-stamps.ts), split
 * into External vs Your/agent changes with per-node [open diff] / [re-learn] /
 * [acknowledge] actions. No prior blueprint spec drives it.
 *
 * Everything here runs through the REAL pipeline the feature ships: the
 * app-embedded `planflow-ai blueprint derive` establishes graph.json plus the
 * drift baseline (file-stamps.json), a real git commit by ANOTHER author moves
 * a source file off that baseline, and the app's own BlueprintObserver spawns
 * `blueprint drift-check --json` and assembles the projection the panel renders.
 *
 * Findings guarded here (both fixme tripwires, verified failing vs main):
 *  • Attribution is an EXACT `node.sourceFile === path` match (drift-check
 *    `sourceFileOwners` → drift-assemble `ownerNodeId`), but module nodes'
 *    `sourceFile` is a DIRECTORY. An ordinary edit to a module source file maps
 *    to no node and is dropped: no row, no card mark, no tab.
 *  • Every row that CAN appear therefore belongs to a file-backed node
 *    (integration / endpoint / datastore), yet the row offers `re-learn`, which
 *    `#learnModule` forwards verbatim as a module path — the popover for the
 *    same node deliberately offers no learn affordance at all.
 */

const CLI = resolve(__dirname, '../../resources/cli/planflow-ai.mjs')
const boardRoot = '.flow-board-root'
const driftPanel = '.flow-board-root .fb-drift-panel'

function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore', env: { ...process.env, ...env } })
}

/** A committer who is NOT the repo's configured user → origin 'external'. */
const OTHER = {
  GIT_AUTHOR_NAME: 'Dana Teammate',
  GIT_AUTHOR_EMAIL: 'dana@example.com',
  GIT_COMMITTER_NAME: 'Dana Teammate',
  GIT_COMMITTER_EMAIL: 'dana@example.com',
}

const ENGINE = 'src/core/engine.ts'
const CLIENT = 'src/api/client.ts'

/**
 * Build a small but REALISTIC repo and derive it: one plain module file
 * (`src/core/engine.ts`) and one file carrying an outbound integration
 * (`src/api/client.ts`), so the graph gets both module nodes whose sourceFile
 * is a DIRECTORY and an integration node whose sourceFile is a FILE. Then a
 * teammate commits a change to `changed`.
 */
function prepareRepo(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'drift-probe', version: '1.0.0' }))
  mkdirSync(join(dir, 'src', 'core'), { recursive: true })
  mkdirSync(join(dir, 'src', 'api'), { recursive: true })
  writeFileSync(join(dir, ENGINE), 'export function run(): number {\n  return 1\n}\n')
  writeFileSync(
    join(dir, CLIENT),
    'export async function charge(id: string) {\n  return fetch("https://api.stripe.com/v1/charges/" + id)\n}\n',
  )
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-qm', 'init'])
  git(dir, ['config', 'user.email', 'me@example.com'])
  git(dir, ['config', 'user.name', 'Me'])
}

/**
 * Establish the blueprint + its drift baseline, THEN have someone else commit
 * a change to `changed`.
 *
 * Runs after the project has joined its Workspace: `file-stamps.json` (the
 * drift baseline) is a GENERATED file, so one written before the migration is
 * dropped by its copy and re-taken by the first derive — AFTER the teammate's
 * commit, which then is no drift at all.
 */
async function deriveThenTeammateChange(window: Page, dir: string, changed: string): Promise<void> {
  await waitForLinkedStructure(window, dir)
  execFileSync(process.execPath, [CLI, 'blueprint', 'derive'], { cwd: dir, stdio: 'ignore' })
  const body =
    changed === ENGINE
      ? 'export function run(): number {\n  return 42 // teammate changed the answer\n}\n'
      : 'export async function charge(id: string) {\n  // teammate switched the endpoint\n  return fetch("https://api.stripe.com/v1/payment_intents/" + id)\n}\n'
  writeFileSync(join(dir, changed), body)
  git(dir, ['add', '--', changed])
  git(dir, ['commit', '-qm', `change ${changed}`], OTHER)
}

/** Wait until the app's own snapshot carries a drift projection. */
async function awaitDrift(window: Page): Promise<NonNullable<Awaited<ReturnType<typeof snapshotDrift>>>> {
  let drift: Awaited<ReturnType<typeof snapshotDrift>> = null
  await expect
    .poll(async () => {
      drift = await snapshotDrift(window)
      return drift !== null
    }, { timeout: 30_000, message: 'the drift never reached the snapshot' })
    .toBe(true)
  return drift as unknown as NonNullable<Awaited<ReturnType<typeof snapshotDrift>>>
}

/** Ground truth straight from the SAME CLI the app spawns. */
function driftCheck(root: string): Array<{ path: string; kind: string; nodeId?: string }> {
  const report = JSON.parse(
    execFileSync(process.execPath, [CLI, 'blueprint', 'drift-check', '--json'], {
      cwd: root,
    }).toString(),
  ) as { entries: Array<{ path: string; kind: string; nodeId?: string }> }
  return report.entries
}

function graphNodes(root: string): Array<{ id: string; sourceFile?: string }> {
  const graph = JSON.parse(
    readFileSync(join(root, 'flow', 'brain', '.structure', 'graph.json'), 'utf8'),
  ) as { nodes: Array<{ id: string; sourceFile?: string }> }
  return graph.nodes.map((n) => ({ id: n.id, sourceFile: n.sourceFile }))
}

/** The `drift` projection the board renders, read over the real IPC (rootId is
 *  the root PATH here — the same key blueprint-board.ts passes). */
/** The graph's module-node source dirs — the set a re-learn target must be in. */
async function snapshotModuleDirs(window: Page): Promise<string[]> {
  return window.evaluate(async () => {
    const flow = (
      window as unknown as {
        flow: {
          blueprint: { read(r: { rootId: string }): Promise<unknown> }
          project: { list(): Promise<Array<{ id: string; rootPath: string }>> }
        }
      }
    ).flow
    const roots = await flow.project.list()
    const snap = (await flow.blueprint.read({ rootId: roots[0].rootPath })) as {
      graph?: { nodes?: Array<{ kind?: string; sourceFile?: string }> }
    }
    return (snap.graph?.nodes ?? [])
      .filter((n) => n.kind === 'module' && typeof n.sourceFile === 'string')
      .map((n) => n.sourceFile as string)
  })
}

async function snapshotDrift(window: Page): Promise<{
  nodes: Array<{ nodeId: string; label: string; origin: string; changedFiles: string[] }>
  system: unknown[]
} | null> {
  return window.evaluate(async () => {
    const flow = (
      window as unknown as {
        flow: {
          blueprint: { read(r: { rootId: string }): Promise<unknown> }
          project: { list(): Promise<Array<{ id: string; rootPath: string }>> }
        }
      }
    ).flow
    const roots = await flow.project.list()
    const snap = (await flow.blueprint.read({ rootId: roots[0].rootPath })) as {
      drift?: {
        nodes: Array<{ nodeId: string; label: string; origin: string; changedFiles: string[] }>
        system: unknown[]
      }
    }
    return snap.drift ?? null
  })
}

/** Open the board and its drift panel. Drift is no longer a tab of the
 *  Learning panel (its tabs are Modules and Docs since 82538cd9); the panel's
 *  door is ⌘P "Blueprint: Show Drift". */
async function openBoardDrift(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator(boardRoot)).toBeVisible()
  await openDriftPanel(window)
}

test.describe('blueprint drift briefing (flow 10 — "code that changed since the derive")', () => {
  test.afterAll(() => cleanupSeeds())

  test('CONTROL: a teammate edit to a node-owned file surfaces as an external drift row', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window, 'flow-ux-drift-ctl-', prepareRepo)
    await activateProject(window, root)
    await deriveThenTeammateChange(window, root, CLIENT)

    // The integration node's sourceFile IS this exact path, so the CLI attributes it.
    const entries = driftCheck(root)
    expect(entries.map((e) => e.path)).toContain(CLIENT)
    expect(entries.find((e) => e.path === CLIENT)?.nodeId).toBe('integration:api.stripe.com')

    const drift = await awaitDrift(window)
    expect(drift.nodes.map((n) => n.nodeId)).toContain('integration:api.stripe.com')
    expect(drift.nodes[0]?.origin).toBe('external')

    await openBoardDrift(window)
    const panel = window.locator(driftPanel)
    // The briefing renders: an "External changes" section with a row + actions.
    await expect(panel.locator('.fb-drift-external')).toBeVisible()
    const row = panel.locator('.fb-drift-row').first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('Dana Teammate')
    await expect(panel.locator('.fb-drift-review-all')).toBeVisible()
    // (RETIRED: "…and the board marks the drifted card". The integration's
    // card was a code-map card; the Territory marks FEATURE cells only —
    // blueprint-drift.spec.ts guards that mark.)
    await window.screenshot({ path: 'e2e/ux/__screens/blueprint-drift-external-row.png' })

    expect(errors).toEqual([])
  })

  test('a teammate’s commit to a plain module source file is reported against its module (#1155)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window, 'flow-ux-drift-', prepareRepo)
    await activateProject(window, root)
    await deriveThenTeammateChange(window, root, ENGINE)

    // Ground truth: the CLI sees the change AND rolls it up to the module that
    // contains the file (#1155 — it used to carry no nodeId at all, because no
    // node's sourceFile equals a file inside a module's DIRECTORY).
    const entries = driftCheck(root)
    expect(entries.map((e) => e.path)).toContain(ENGINE)
    expect(graphNodes(root).map((n) => n.id)).toContain('module:src/core')
    expect(entries.find((e) => e.path === ENGINE)?.nodeId).toBe('module:src/core')

    const drift = await awaitDrift(window)
    await openBoardDrift(window)
    const panel = window.locator(driftPanel)
    await window.screenshot({ path: 'e2e/ux/__screens/blueprint-drift-module-silent.png' })
    const panelText = (await panel.innerText()).replace(/\s+/g, ' ')

    // ── Live guard: the panel never disagrees with the snapshot, and the whole
    // briefing path stays free of uncaught errors. ──
    await expect(panel.locator('.fb-drift-row')).toHaveCount(drift.nodes.length)
    expect(errors).toEqual([])

    // ── #1155 (fixed): an ordinary module-file change is named in the briefing. ──
    // The row is labelled with the module's own label (`core`), and the module
    // it names is the one its [re-learn] resolves to — the full path.
    expect(panelText).toContain('Drift')
    const row = panel.locator('.fb-drift-row', { hasText: 'core' })
    await expect(row).toHaveCount(1)
    await expect(row.locator('.fb-drift-action[data-relearn-module]')).toHaveAttribute(
      'data-relearn-module',
      'src/core',
    )
  })

  test('every drift row’s [re-learn] targets a learnable module node', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const root = await seedProject(window, 'flow-ux-drift-rl-', prepareRepo)
    await activateProject(window, root)
    await deriveThenTeammateChange(window, root, CLIENT)
    const drift = await awaitDrift(window)
    const nodeIds = drift.nodes.map((n) => n.nodeId)
    expect(nodeIds.length).toBeGreaterThan(0)

    await openBoardDrift(window)
    const panel = window.locator(driftPanel)
    await expect(panel.locator('.fb-drift-row').first()).toBeVisible()
    // (RETIRED: "the popover for the SAME node offers no learn affordance" —
    // the node's popover was a code-map card's. The rule it stood for is the
    // one below: a re-learn is only ever offered for a real module.)
    expect(errors).toEqual([])

    // ── #1156 (fixed): the row's [re-learn] targets a module that REALLY
    // exists in the graph, instead of forwarding the row's node id as a module
    // path (which spent an agent pass on a nonexistent directory and recorded a
    // phantom module in learning-state.jsonl). Asserted through the resolved
    // target on the button, so the guard costs no ~40s learn pass. ──
    const moduleDirs = await snapshotModuleDirs(window)
    const targets = await panel
      .locator('.fb-drift-action[data-relearn-module]')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset['relearnModule'] ?? ''))
    // Every offered re-learn names a real module dir; a row whose file no module
    // owns simply offers no button (never a fabricated target).
    for (const target of targets) {
      expect(target.length, 'a re-learn button with no resolved module').toBeGreaterThan(0)
      expect(target.startsWith('integration:'), 'a node id forwarded as a module path').toBe(false)
      if (moduleDirs.length > 0) expect(moduleDirs).toContain(target)
    }
  })
})
