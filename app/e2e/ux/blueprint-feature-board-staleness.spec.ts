import { test, expect, type Page } from '../fixtures/electron'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { enterProject } from './fixtures/territory'

/**
 * UX sweep — flow 10 (Blueprint), round 21: the FEATURE BOARD, the board's
 * DEFAULT view since #1221 ("the board becomes a feature map").
 *
 * Twenty-one blueprint rounds and 22 committed blueprint specs drive the code
 * map, the drift briefing, the preview walkthrough, the popover, must-review,
 * trace and the learning panel — every one of them a surface that existed
 * BEFORE #1221. Nobody had driven the surface the board now opens onto: the
 * grid of `.fb-feature-card`s fed by `blueprint:featureGraph` →
 * `planflow-ai blueprint features graph --json`.
 *
 * Everything here runs through the REAL pipeline: a throwaway git repo with
 * hand-authored `flow/brain/features/*.md`, the app-embedded CLI's own derive,
 * and the app's own `feature-runner` spawn. The CLI is queried directly for
 * ground truth, so a wrong board is provable rather than asserted.
 *
 * Findings guarded here (tripwires once, LIVE since #1306's fix):
 *  • `#featureGraph` is fetched ONCE (`#renderFeatureBoard` loads only when the
 *    field is null) and never invalidated. `setRoot()` resets fifteen other
 *    per-root fields and not this one, so switching the active project leaves
 *    the PREVIOUS project's capabilities on the board.
 *  • The same cache freezes within one project: adding/removing a feature file
 *    — the documented correction mechanism — never reaches the board, not even
 *    through a full re-derive (whose `blueprint:changed` → `refresh()` re-reads
 *    the snapshot and leaves the feature graph alone).
 */

const boardRoot = '.flow-board-root'
const CLI = join(__dirname, '../../resources/cli/planflow-ai.mjs')

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

function feature(
  dir: string,
  slug: string,
  id: string,
  name: string,
  summary: string,
  extra = '',
): void {
  writeFileSync(
    join(dir, 'flow', 'brain', 'features', `${slug}.md`),
    `---\nid: ${id}\nname: ${name}\nkind: core\nanchors: [module:src/${slug}]\nrelates: []\nlastFullRead: null\npatchCount: 0\n${extra}---\n\n${summary}\n`,
  )
}

/** A small but real repo: one source dir per feature, plus the feature files. */
function prepareRepo(dir: string, features: Array<[string, string, string, string]>): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'feat-board-probe', version: '1.0.0' }))
  for (const [slug] of features) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), `export const ${slug.replace(/-/g, '_')} = 1\n`)
  }
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-qm', 'init'])

  mkdirSync(join(dir, 'flow', 'brain', 'features'), { recursive: true })
  mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
  for (const [slug, id, name, summary] of features) feature(dir, slug, id, name, summary)
  // `derive` refuses without flow/; the IDE provisioner normally creates it.
  execFileSync(process.execPath, [CLI, 'blueprint', 'derive'], { cwd: dir, stdio: 'ignore' })
}

/** Ground truth from the SAME CLI the app spawns — core features, board order. */
function truth(dir: string): string[] {
  const graph = JSON.parse(
    execFileSync(process.execPath, [CLI, 'blueprint', 'features', 'graph', '--json'], {
      cwd: dir,
    }).toString(),
  ) as { nodes: Array<{ name: string; kind: string }> }
  return graph.nodes.filter((node) => node.kind === 'core').map((node) => node.name).sort()
}

/**
 * The names the board draws. The grid of `.fb-feature-card`s this spec was
 * written against is the TERRITORY now — a feature is a cell named by
 * `.fb-terr-cell-name`; the question (does the board show THIS project's
 * features, freshly) is the same.
 */
async function cardNames(window: Page): Promise<string[]> {
  const names = await window.evaluate(() =>
    [...document.querySelectorAll('.fb-terr-cell .fb-terr-cell-name')]
      .filter((el) => (el as HTMLElement).checkVisibility())
      .map((el) => el.textContent ?? ''),
  )
  return [...names].sort()
}

/** Open the Blueprint in the scope on screen (editor tabs are per project
 *  since f6ef9977, so a switched-to project opens its own). */
async function openBoard(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator(boardRoot)).toBeVisible()
  await window.locator('.fb-terr-cell').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/** Poll the board for up to `ms`, so a PASS never depends on one lucky tick. */
async function waitForCards(window: Page, want: string[], ms: number): Promise<string[]> {
  const deadline = Date.now() + ms
  let seen = await cardNames(window)
  while (Date.now() < deadline) {
    seen = await cardNames(window)
    if (seen.join('|') === want.join('|')) return seen
    await window.waitForTimeout(500)
  }
  return seen
}

const ALPHA: Array<[string, string, string, string]> = [
  ['chat-engine', 'feat_chatengine', 'Chat Engine', 'Streams agent turns into the thread view.'],
  ['billing', 'feat_billing', 'Billing', 'Charges the customer for what they used.'],
]
const BETA: Array<[string, string, string, string]> = [
  ['inventory', 'feat_inventory', 'Inventory', 'Tracks stock levels.'],
  ['shipping', 'feat_shipping', 'Shipping', 'Books couriers and prints labels.'],
]

test.describe('blueprint feature board (flow 10 — the board\'s default view)', () => {
  test.afterAll(() => cleanupSeeds())

  test('CONTROL: the board renders the active project\'s features, and a cell opens in place', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(`pageerror: ${event.message}`))

    const alpha = await seedProject(window, 'flow-ux-featboard-a-', (dir) => prepareRepo(dir, ALPHA))
    expect(truth(alpha)).toEqual(['Billing', 'Chat Engine'])

    await activateProject(window, alpha)
    await openBoard(window)
    expect(await waitForCards(window, ['Billing', 'Chat Engine'], 20_000)).toEqual([
      'Billing',
      'Chat Engine',
    ])

    // The cell is live: pressing it really opens THAT feature — in place, grown
    // to its details (5dd9bf03), its neighbour shrunk. This is the control that
    // keeps the staleness guards below from passing on an inert board.
    const chat = window.locator('.fb-terr-cell', { hasText: 'Chat Engine' }).first()
    await chat.click()
    await expect(chat).toHaveClass(/fb-terr-grown/, { timeout: 15_000 })
    await expect(window.locator('.fb-terr-cell', { hasText: 'Billing' }).first()).toHaveClass(
      /fb-terr-shrunk/,
    )

    expect(errors).toEqual([])
  })

  // LIVE since #1306 (the snapshot is invalidated on project switch).
  test(
    'switching the active project must repaint the board with THAT project\'s features',
    async ({ window }) => {
      const alpha = await seedProject(window, 'flow-ux-featswitch-a-', (dir) => prepareRepo(dir, ALPHA))
      const beta = await seedProject(window, 'flow-ux-featswitch-b-', (dir) => prepareRepo(dir, BETA))
      expect(truth(beta)).toEqual(['Inventory', 'Shipping'])

      await activateProject(window, alpha)
      await openBoard(window)
      await enterProject(window, basename(alpha))
      expect(await waitForCards(window, ['Billing', 'Chat Engine'], 20_000)).toEqual([
        'Billing',
        'Chat Engine',
      ])

      // Switch the ACTIVE PROJECT with the board open — the titlebar, the
      // sidebar selection and the terminal all follow it.
      await activateProject(window, beta)
      await openBoard(window)
      // In a Workspace of two the board's root is the WORKSPACE sheet, which
      // draws every project's countries by design; the claim is about the
      // active project's own level, so go into it the way a person does.
      await enterProject(window, basename(beta))
      const after = await waitForCards(window, ['Inventory', 'Shipping'], 15_000)
      await window.screenshot({ path: 'e2e/ux/__screens/blueprint-feature-board-project-leak.png' })
      expect(
        after,
        `the board shows ${after.join(' + ')} while the active project is beta (${truth(beta).join(' + ')})`,
      ).toEqual(['Inventory', 'Shipping'])
    },
  )

  // LIVE since #1306 (`flow/brain/features/` is watched; a derive re-reads).
  test(
    'a feature added or removed on disk must reach the open board',
    async ({ window }) => {
      const root = await seedProject(window, 'flow-ux-featdisk-', (dir) =>
        prepareRepo(dir, [
          ['orders', 'feat_orders', 'Orders', 'Takes the order.'],
          ['typo', 'feat_typo', 'Teh Typo Featrue', 'Named wrong on purpose.'],
        ]),
      )
      await activateProject(window, root)
      await openBoard(window)
      expect(await waitForCards(window, ['Orders', 'Teh Typo Featrue'], 20_000)).toEqual([
        'Orders',
        'Teh Typo Featrue',
      ])

      // The documented correction mechanism: edit/delete the markdown. Plus the
      // ordinary case — an agent adopting a new feature mid-session.
      rmSync(join(root, 'flow', 'brain', 'features', 'typo.md'))
      mkdirSync(join(root, 'src', 'payments'), { recursive: true })
      writeFileSync(join(root, 'src', 'payments', 'index.ts'), 'export const payments = 1\n')
      feature(root, 'payments', 'feat_payments', 'Payments', 'Takes the money.')
      // …and a full re-derive, which fires blueprint:changed → refresh().
      execFileSync(process.execPath, [CLI, 'blueprint', 'derive'], { cwd: root, stdio: 'ignore' })
      expect(truth(root)).toEqual(['Orders', 'Payments'])

      const after = await waitForCards(window, ['Orders', 'Payments'], 15_000)
      expect(after, `board still shows ${after.join(' + ')} after the store changed on disk`).toEqual(
        ['Orders', 'Payments'],
      )
    },
  )
})
