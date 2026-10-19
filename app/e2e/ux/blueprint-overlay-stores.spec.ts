import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 10 (Blueprint), round 24: the board's OVERLAY stores.
 *
 * The blueprint stores split into two families the board treats very
 * differently, and nothing had ever driven the difference:
 *
 *   • investigations.jsonl (`blueprint observe`) — reaches the board.
 *   • proposals.jsonl (`blueprint propose`) and annotations.jsonl (derive's
 *     promotion of anchored `/execute-plan` rounds records) — were culled by
 *     #52 "option A" (68b9f73f): `BlueprintObserver.read()` returned `[]`
 *     literals for both. #1393 restored the read, so they reach the board too.
 *     (The code-map ghost cards and popover sections those stores fed were
 *     retired with the code map; the snapshot is what this spec can assert.)
 *
 * Everything here is credential-free: a throwaway git repo, the app-embedded
 * CLI's own derive/propose/observe/narrate, and the real `blueprint:read` IPC.
 * The stores are read back from disk as ground truth, so an empty board is
 * provable rather than asserted.
 *
 * LIVE controls:
 *  1. every store really is written — the observe note, the effective proposal,
 *     and derive's `promotion: 1 promoted` into annotations.jsonl;
 *  2. `narrate --strict` compiles a plan story whose second step anchors the
 *     PROPOSED module with zero unresolved anchors;
 *  3. `blueprint:read` hands the board all three.
 */

const CLI = resolve(__dirname, '../../resources/cli/planflow-ai.mjs')
const boardRoot = '.flow-board-root'
const MODULE = 'module:src/billing'
const PROPOSED = 'module:src/payments'
const PLAN_NAME = 'payments_v2'
const NOTE = 'Charge retries are NOT idempotent — a duplicate webhook double-charges.'
const DECISION = 'Charge idempotency: key on the PSP event id, not our order id'

/** A plan story whose second step anchors a module that does not exist yet —
 *  only the proposal makes it resolvable, which is what `--strict` proves. */
const PLAN_DOC = `# Plan: ${PLAN_NAME}

## Story

### Step: Today the ledger is implicit
- kicker: Charges land, but nothing records them twice.
- anchors: ${MODULE}

### Step: A payments module owns the PSP
- kicker: The new module talks to the PSP and writes the ledger.
- anchors: ${PROPOSED}
`

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

/** Run the app-embedded CLI; returns stdout (throws surface as text so a
 *  refusal is asserted rather than crashing the fixture). */
function cli(dir: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { cwd: dir }).toString()
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer }
    return `CLI FAILED: ${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`
  }
}

interface Prepared {
  /** stdout of the derive that promoted the rounds record. */
  deriveOut: string
  /** stdout of the strict narrate. */
  narrateOut: string
}

const prepared: Record<string, Prepared> = {}

/**
 * A small real repo (two module dirs), derived, then all three stores written
 * through their documented CLI writers:
 *   - `observe`  → investigations.jsonl  (the store that DOES reach the board)
 *   - `propose`  → proposals.jsonl       (silent)
 *   - a real anchored `plan_decision` rounds record + a second derive, whose
 *     promotion pass writes annotations.jsonl (silent)
 * Finally `narrate --strict` compiles the plan story that leans on the proposal.
 */
function prepareRepo(dir: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'overlay-probe', version: '1.0.0' }))
  mkdirSync(join(dir, 'src', 'billing'), { recursive: true })
  mkdirSync(join(dir, 'src', 'shipping'), { recursive: true })
  writeFileSync(join(dir, 'src/billing/charge.ts'), 'export function charge(): number {\n  return 1\n}\n')
  writeFileSync(join(dir, 'src/shipping/label.ts'), 'export function label(): string {\n  return "x"\n}\n')
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-qm', 'init'])
  git(dir, ['config', 'user.email', 'me@example.com'])
  git(dir, ['config', 'user.name', 'Me'])

  // `derive` refuses without flow/; the IDE provisioner normally creates it.
  mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
  mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(dir, 'flow', 'plans', `plan_${PLAN_NAME}_v1.md`), PLAN_DOC)
  cli(dir, ['blueprint', 'derive'])

  cli(dir, ['blueprint', 'observe', '--anchor', MODULE, '--note', NOTE])
  cli(dir, [
    'blueprint', 'propose',
    '--plan', PLAN_NAME,
    '--node', PROPOSED,
    '--kind', 'module',
    '--label', 'Payments',
    '--detail', 'New payments module',
    '--phase', '2',
  ])

  // Exactly what /execute-plan appends when a decision carries anchors.
  writeFileSync(
    join(dir, 'flow', '.rounds.jsonl'),
    `${JSON.stringify({
      ts: '2026-08-07T12:00:00.000Z',
      type: 'plan_decision',
      run_id: 'overlay-probe-1',
      anchors: [{ kind: 'module', ref: 'src/billing' }],
      decision: 'Charge idempotency',
      choice: 'key on the PSP event id, not our order id',
    })}\n`,
  )
  const deriveOut = cli(dir, ['blueprint', 'derive'])
  const narrateOut = cli(dir, [
    'blueprint', 'narrate',
    '--from', `flow/plans/plan_${PLAN_NAME}_v1.md`,
    '--plan', PLAN_NAME,
    '--strict',
  ])
  prepared[dir] = { deriveOut, narrateOut }
}

function structureFile(root: string, name: string): string {
  const path = join(root, 'flow', 'brain', '.structure', name)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** The snapshot the board itself renders, over the real IPC. */
async function snapshot(window: Page, root: string): Promise<{
  proposals: unknown[]
  annotations: unknown[]
  investigations: unknown[]
  story: { steps?: Array<{ anchors?: unknown[]; unresolvedAnchors?: unknown[] }> } | null
}> {
  return window.evaluate(async (rootPath) => {
    const flow = (
      window as unknown as {
        flow: { blueprint: { read(r: { rootId: string }): Promise<Record<string, unknown>> } }
      }
    ).flow
    const snap = await flow.blueprint.read({ rootId: rootPath })
    return {
      proposals: (snap.proposals as unknown[]) ?? [],
      annotations: (snap.annotations as unknown[]) ?? [],
      investigations: (snap.investigations as unknown[]) ?? [],
      story: (snap.story as { steps?: [] } | null) ?? null,
    }
  }, root)
}

/** Open the Blueprint tab and wait for the board to be live. The board sits
 *  behind "Setting up plan-flow…" until the IDE provisioner finishes. */
async function openBoard(window: Page): Promise<void> {
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-blueprint')))
  await window.locator(boardRoot).first().waitFor({ state: 'visible', timeout: 20_000 })
  await window.locator(`${boardRoot} .fb-territory`).first().waitFor({ state: 'visible', timeout: 90_000 })
}

test.describe('blueprint overlay stores', () => {
  test.afterAll(() => cleanupSeeds())

  test('control: the stores are written, and all three reach the board (#1393)', async ({
    window,
  }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window, 'flow-ux-overlay-ctl-', prepareRepo)
    const { deriveOut, narrateOut } = prepared[root]

    // ── Ground truth on disk: every store really was written. ───────────────
    const proposalStore = structureFile(root, 'proposals.jsonl')
    expect(proposalStore, 'blueprint propose wrote the proposal store').toContain(PROPOSED)
    expect(proposalStore).toContain('"event":"proposed"')
    expect(deriveOut, 'derive promoted the anchored rounds record').toContain('promotion: 1 promoted')
    expect(structureFile(root, 'annotations.jsonl')).toContain(DECISION)
    expect(structureFile(root, 'investigations.jsonl')).toContain(NOTE)

    // ── The rest of the toolchain TRUSTS the proposal: strict narrate refuses
    //    on any unresolved anchor, and it compiled a story whose second step
    //    anchors a module that exists only as a proposal. ────────────────────
    expect(narrateOut, 'narrate --strict compiled the plan story').toContain('2 steps compiled')
    expect(narrateOut).not.toContain('narrate refused')

    await activateProject(window, root)
    // `story.json` is a GENERATED file: the Workspace migration's copy drops it
    // (and the provisioner's first derive rebuilds the graph), so the compiled
    // story is re-made once the project sits in its Workspace — the same strict
    // narrate, still leaning on the proposal store, which DOES carry over.
    await waitForLinkedStructure(window, root)
    // The graph it resolves against is generated too; derive it here rather
    // than race the provisioner's own first derive for it.
    cli(root, ['blueprint', 'derive'])
    const narrateAgain = cli(root, [
      'blueprint', 'narrate',
      '--from', `flow/plans/plan_${PLAN_NAME}_v1.md`,
      '--plan', PLAN_NAME,
      '--strict',
    ])
    expect(narrateAgain, 'narrate --strict compiled the plan story in the Workspace').toContain(
      '2 steps compiled',
    )
    await openBoard(window)

    const snap = await snapshot(window, root)
    const storyStep = snap.story?.steps?.[1]
    expect(storyStep?.anchors, 'the compiled step anchors the proposed module').toHaveLength(1)
    expect(storyStep?.unresolvedAnchors, 'and strict mode left nothing unresolved').toHaveLength(0)

    // The board's own snapshot: ALL THREE stores land. The two that used to be
    // handed `[]` as literals (#52's cull) are folded and read again since
    // #1393 — every recorded ghost and promoted decision reaches the board.
    expect(snap.investigations.length, 'investigations reach the board').toBeGreaterThan(0)
    expect(JSON.stringify(snap.proposals), 'the recorded proposal reaches the board').toContain(PROPOSED)
    expect(JSON.stringify(snap.annotations), 'the promoted decision reaches the board').toContain(DECISION)
    // (The module-card popover that rendered the note lived on the code map,
    // which the code storyline replaced — plan_code-storyline_v1 phase 7.)

    expect(errors, 'no uncaught errors').toEqual([])
  })
})
