import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import { statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * UX sweep — flow 10 (Blueprint), round 23: what the FEATURE BOARD says it
 * knows, and what it says when a feature's anchors no longer resolve.
 *
 * Round 21 drove the feature board's identity (which cards, whose project —
 * #1306/#1307). Nothing had ever driven the two things the sheet and briefs
 * actually CLAIM (re-pointed onto the territory sheet, Task 6.6 — the
 * learn-state vocabulary it asserts is unchanged):
 *
 *  1. UNDERSTANDING (#1346). Every cell carries a dot (`understanding: none |
 *     learning | learned | stale`) and the header carries a `Learning · n/N`
 *     meter. `understandingOf()` (cli feature-graph.ts) derives it worst-wins
 *     from MODULE learning-state, while the brief's own primary CTA
 *     (`#learnFeature`, blueprint-board.ts ~6632) deliberately learns the
 *     FEATURE and writes no module state at all — so a feature the agent has
 *     genuinely read stays `none` forever.
 *  2. UNRESOLVED ANCHORS (#1347). `#renderBriefNoStructure` has TWO messages, and the
 *     accurate one ("N anchors name components the derived map does not
 *     contain — re-derive, or fix the anchors") is keyed on a `missing` count
 *     that a FEATURE brief can never produce: `#briefScope` is built from the
 *     CLI's RESOLVED nodes only (blueprint-board.ts ~1663), so the unresolved
 *     anchors never enter the scope and `missing` is structurally empty.
 *
 * Everything here is account-independent: a throwaway git repo, hand-authored
 * `flow/brain/features/*.md`, and the app-embedded CLI's own derive. The CLI is
 * queried for ground truth so a wrong board is provable rather than asserted.
 * The two findings are `test.fixme` tripwires, both verified failing vs main.
 */

const CLI = join(__dirname, '../../resources/cli/planflow-ai.mjs')
const boardRoot = '.flow-board-root'

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

/** What `Learn this feature` actually writes into a feature file: a `## Learned`
 *  section plus a `## Parts` breakdown, each learning stamped with its source. */
const LEARNED_SECTIONS = [
  '',
  '## Learned',
  '',
  '- charge() returns cents * 2, so every caller is billed double. <!-- learned: code 2026-08-07 -->',
  '',
  '## Parts',
  '',
  '### Billing module',
  'The only surface of the feature: a lone module whose whole API is charge().',
  'anchors: src/billing/index.ts',
  '',
  '- charge() returns cents * 2, so every caller is billed double. <!-- learned: code 2026-08-07 -->',
  '',
].join('\n')

function featureFile(
  dir: string,
  slug: string,
  id: string,
  name: string,
  prose: string,
  anchor: string,
  extraBody = '',
): void {
  writeFileSync(
    join(dir, 'flow', 'brain', 'features', `${slug}.md`),
    `---\nid: ${id}\nname: ${name}\nkind: core\nanchors: [${anchor}]\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n\n${prose}\n${extraBody}`,
  )
}

interface RepoOptions {
  /** Raw `.structure/learning-state.jsonl` contents, when the repo should have one. */
  learningState?: string
  /** Append the `## Learned` + `## Parts` sections a learn pass writes to billing.md. */
  learned?: boolean
  /** Add a third feature whose single anchor names a directory that does not exist. */
  ghost?: boolean
  /**
   * Modules to write an investigation note for, through the CLI's own
   * `observe`. A `learned` module WITHOUT a note is flipped to `stale` by the
   * app's integrity reconcile (`reconcileNoteless`, learn-orchestrator.ts)
   * about a second after the project is added — so a seed that claims
   * `learned` must also carry the note that makes the claim verifiable.
   */
  notedModules?: string[]
}

function prepareRepo(dir: string, options: RepoOptions = {}): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'bp-learn-state', version: '1.0.0' }))
  for (const slug of ['billing', 'shipping']) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), `export const ${slug} = 1\n`)
  }
  git(dir, ['add', '-A'])
  git(dir, ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-qm', 'init'])

  mkdirSync(join(dir, 'flow', 'brain', 'features'), { recursive: true })
  mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
  featureFile(
    dir,
    'billing',
    'feat_billing',
    'Billing',
    'Charges the customer for what they used.',
    'module:src/billing',
    options.learned === true ? LEARNED_SECTIONS : '',
  )
  featureFile(
    dir,
    'shipping',
    'feat_shipping',
    'Shipping',
    'Books couriers and prints labels.',
    'module:src/shipping',
  )
  if (options.ghost === true) {
    featureFile(
      dir,
      'ghost',
      'feat_ghost',
      'Ghost Feature',
      'Points at code that a refactor moved away.',
      'module:src/does-not-exist',
    )
  }
  if (options.learningState !== undefined) {
    writeFileSync(join(dir, 'flow', 'brain', '.structure', 'learning-state.jsonl'), options.learningState)
  }
  // `derive` refuses without flow/; the IDE provisioner normally creates it.
  execFileSync(process.execPath, [CLI, 'blueprint', 'derive'], { cwd: dir, stdio: 'ignore' })
  for (const module of options.notedModules ?? []) {
    execFileSync(
      process.execPath,
      [CLI, 'blueprint', 'observe', '--anchor', `module:${module}`, '--note', `Read ${module}: charge() bills cents * 2.`],
      { cwd: dir, stdio: 'ignore' },
    )
  }
}

/** Ground truth from the SAME CLI the app spawns. */
function truth(dir: string): Array<{ name: string; understanding: string; summary?: string }> {
  const graph = JSON.parse(
    execFileSync(process.execPath, [CLI, 'blueprint', 'features', 'graph', '--json'], { cwd: dir }).toString(),
  ) as { nodes: Array<{ name: string; understanding: string; summary?: string }> }
  return graph.nodes
}

async function openBoard(window: Page): Promise<void> {
  await window.locator(statusButtonByText('Blueprint')).click()
  await expect(window.locator(boardRoot)).toBeVisible()
  await window.locator('.fb-terr-cell').first().waitFor({ state: 'visible', timeout: 60_000 })
}

/**
 * What one feature's CELL says about its understanding.
 *
 * Re-pointed from `.fb-feature-card` to the territory sheet
 * (plan_blueprint_territory_v1, Task 6.6). The learn-state vocabulary itself is
 * UNCHANGED and that is the point of the re-point: `fb-learn-<state>` and the
 * `understanding: <state>` title mean here exactly what they meant on a card,
 * so the assertions below still measure the same claim. The one difference is
 * where the class lives — a cell carries its state on the DOT in its kicker
 * row, rather than on the box.
 */
async function cardState(
  window: Page,
  name: string,
): Promise<{ cls: string; dot: string | null; text: string }> {
  return window.evaluate((wanted: string) => {
    const cell = [...document.querySelectorAll('.fb-terr-cell')].find(
      (el) => el.querySelector('.fb-terr-cell-name')?.textContent === wanted,
    )
    const dot = cell?.querySelector('.fb-learn-dot') ?? null
    return {
      // The dot's classes ARE the state — `fb-learn-none` on a never-read
      // feature, `fb-learn-learned` on one that has been. A cell with no dot at
      // all reports `(no dot)`, which is a third and different answer.
      cls: dot === null ? (cell === undefined ? '(no cell)' : '(no dot)') : dot.className,
      dot: dot?.getAttribute('title') ?? null,
      text: (cell as HTMLElement | undefined)?.innerText.replace(/\n/g, ' | ') ?? '',
    }
  }, name)
}

/**
 * Open a feature's brief — through the CONTROL on its cell.
 *
 * The body of a cell DIVES (into the feature's parts); only the control opens
 * the level. That split is the board's one-gesture-one-meaning rule, and a
 * probe that clicked the body here would land on the parts sheet and then fail
 * looking for a brief bar that was never asked for.
 */
async function openFeatureBrief(window: Page, name: string): Promise<void> {
  // The cell's control is its LEARN door now — pressing it would start a
  // learn pass — and the diagram door is gone (plan cell-hover-diagram, FR-5).
  // A feature WITH parts dives on press and its header carries the
  // feature-view control; a partless feature reads as its story instead, and
  // has no way into its feature view (see the fixme below).
  const cell = window.locator('.fb-terr-cell', { hasText: name }).first()
  const featureView = window.locator('.flow-board-root [data-control-glyph="diagram"]')
  await window.mouse.move(0, 0)
  await cell.click({ position: { x: 12, y: 12 } })
  await featureView.click({ timeout: 10_000 })
}

test.describe('blueprint feature knowledge state (flow 10)', () => {
  test.afterAll(() => cleanupSeeds())

  test('CONTROL: the card paints the understanding the store reports, and a resolvable feature offers Learn', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(`pageerror: ${event.message}`))

    // THE FEATURE'S OWN EVIDENCE, PLUS THE MODULE STATE — both, because
    // `understandingOf()` needs both. The comment here used to say module
    // learning-state was "the ONLY input", and the seed matched that belief;
    // `d5ae3b83` had already removed exactly that lie ("MODULE learning was
    // making features report `learned`, so ~30 cards claimed knowledge nobody
    // had about the product — a feature's understanding is its OWN, not its
    // modules'", src/cli/blueprint/feature-graph.ts). So a feature with only a
    // learned module reads `none`, correctly, and the oracle below refused the
    // seed rather than the board. `## Learned` supplies the feature's own half;
    // the module state supplies the freshness half.
    const root = await seedProject(window, 'flow-ux-learnstate-ctl-', (dir) =>
      prepareRepo(dir, {
        learned: true,
        learningState: '{"module":"src/billing","status":"learned"}\n',
        notedModules: ['src/billing'],
      }),
    )
    expect(
      truth(root).find((node) => node.name === 'Billing')?.understanding,
      'the CLI must report Billing as learned for this control to mean anything',
    ).toBe('learned')

    await activateProject(window, root)
    await openBoard(window)

    // The dot is NOT stuck on `none`: this surface can and does paint a
    // learned/stale/learning state. Without this the tripwire below could pass
    // on a board that simply never renders anything but `none`.
    const billing = await cardState(window, 'Billing')
    expect(billing.cls, `Billing card classes: ${billing.cls}`).toMatch(
      /fb-learn-(learned|stale|learning)/,
    )
    expect(billing.dot).not.toBe('understanding: none')
    // …while its never-learned sibling stays `none`, so the state is per-card.
    const shipping = await cardState(window, 'Shipping')
    expect(shipping.cls).toContain('fb-learn-none')
    expect(shipping.dot).toBe('understanding: none')

    // A feature whose anchor resolves offers Learn. Shipping has no parts, so
    // its feature view (and the brief's CTA in it) has no door since plan
    // cell-hover-diagram removed the cell's diagram door (FR-5) — the offer is
    // the cell's own Learn door on the map.
    const shippingLearn = window
      .locator('.fb-terr-cell', { hasText: 'Shipping' })
      .first()
      .locator('.fb-terr-learn-btn')
    await expect(shippingLearn).toHaveCount(1)
    await expect(shippingLearn).toHaveAttribute('data-learn-feature', /shipping/)

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  // RELATED TO plan cell-hover-diagram: Ghost Feature has no parts, so its
  // feature view (where the unresolved anchor is reported) has no door since FR-5.
  test.fixme('CONTROL: an unresolved anchor IS reported — in the facts line and the Verification ledger', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (event) => errors.push(`pageerror: ${event.message}`))

    const root = await seedProject(window, 'flow-ux-learnstate-ghost-ctl-', (dir) =>
      prepareRepo(dir, { ghost: true }),
    )
    await activateProject(window, root)
    await openBoard(window)

    await openFeatureBrief(window, 'Ghost Feature')
    const bar = window.locator('.fb-brief-bar')
    await expect(bar).toContainText('Ghost Feature', { timeout: 20_000 })

    // The bar's own facts line is honest about the count…
    await expect(bar.locator('.fb-brief-facts')).toContainText('1 unresolved')
    const verification = bar.locator('.fb-brief-slot', { hasText: 'Verification' })
    await expect(verification).toContainText('0/1 anchors')

    // …and the ledger drawer names WHICH anchor failed, so the reader is not
    // left guessing once they know something is wrong.
    await verification.click()
    const drawer = window.locator('.fb-brief-drawer')
    await expect(drawer).toBeVisible()
    await expect(drawer).toContainText('module:src/does-not-exist')

    expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
  })

  test.fixme(
    'a feature whose markdown records what was learned is no longer "understanding: none"',
    async ({ window }) => {
      // billing.md carries the exact `## Learned` + `## Parts` sections that
      // "Learn this feature" writes — a full, successful pass over its code.
      const root = await seedProject(window, 'flow-ux-learnstate-md-', (dir) =>
        prepareRepo(dir, { learned: true }),
      )
      // The store PARSED those learnings: the card's own summary is now the
      // learned sentence, not the hand-written prose. So this is not "the file
      // was ignored" — only `understanding` refuses to move.
      const node = truth(root).find((entry) => entry.name === 'Billing')
      expect(node?.summary).toContain('charge() returns cents * 2')

      await activateProject(window, root)
      await openBoard(window)

      const billing = await cardState(window, 'Billing')
      await window.screenshot({ path: 'e2e/ux/__screens/blueprint-learned-still-none.png' })
      expect(
        billing.dot,
        `card shows "${billing.dot ?? ''}" (classes: ${billing.cls}) although its file records what was learned from the code`,
      ).not.toBe('understanding: none')
      await expect(window.locator('.fb-learn-chip')).not.toHaveText(/· 0\//)
    },
  )

  test.fixme(
    'a feature with an unresolved anchor is told so — not that it "claims no code yet"',
    async ({ window }) => {
      const root = await seedProject(window, 'flow-ux-learnstate-ghost-', (dir) =>
        prepareRepo(dir, { ghost: true }),
      )
      await activateProject(window, root)
      await openBoard(window)

      await openFeatureBrief(window, 'Ghost Feature')
      const bar = window.locator('.fb-brief-bar')
      await expect(bar).toContainText('Ghost Feature', { timeout: 20_000 })
      await window.screenshot({ path: 'e2e/ux/__screens/blueprint-ghost-anchor-brief.png' })

      // The stage must not claim the feature is empty when it claims code the
      // map cannot find — the app already has the right sentence for this.
      const hint = window.locator('.fb-codemap-hint')
      await expect(hint).toBeVisible()
      await expect(hint).not.toHaveText('This feature claims no code yet.')
      await expect(hint).toContainText('anchor')

      // And an instruction to "run Learn" must come with a Learn button.
      const tellsYouToLearn = await bar.locator('.fb-brief-nothing').count()
      if (tellsYouToLearn > 0) {
        await expect(bar.locator('.fb-brief-nothing')).toContainText('run Learn')
        await expect(
          window.locator('.fb-brief-learn'),
          'the bar says "run Learn to read its code" but no Learn control exists',
        ).toHaveCount(1)
      }
    },
  )
})
