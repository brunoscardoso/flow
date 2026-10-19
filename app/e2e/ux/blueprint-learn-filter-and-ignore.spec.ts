import { test, expect, type Page } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openLearningPanel } from './fixtures/territory'
import { waitForLinkedStructure } from './fixtures/linked-structure'

/**
 * UX sweep — flow 10 (Blueprint), round 24: the Learning panel's MODULE LIST
 * controls (#905) — the filter box and the per-row Ignore action.
 *
 * Thirty committed blueprint specs drive the map, the feature board, briefs,
 * drift, preview, trace, must-review and the overlay stores; not one of them
 * has ever typed into the module filter or clicked Ignore. Both are the panel's
 * only tools for a real repo's module list (this project derives hundreds of
 * modules; the list caps at 40 rows until "Show all").
 *
 * LIVE controls (green on main — they make the tripwires non-vacuous):
 *  1. the Modules tab lists every derived module, the filter narrows it, a
 *     nonsense query says "No modules match", and clearing restores the list;
 *  2. Ignore really persists — `learn_ignore` lands in flow/.flowconfig on disk
 *     and the denominator drops — so the tripwires below are about the UI's
 *     handling of that state, never about a failed write.
 *
 * Regressions — LIVE since #1449 was fixed (each was verified genuinely RED vs
 * main on 2026-08-10, and green against the fix on 2026-08-13):
 *  • #1449 — every keystroke rebuilt the input and forced the caret to the END
 *    (`setSelectionRange(value.length, value.length)` in the input handler), so
 *    only the FIRST mid-string edit landed where the user was typing: with the
 *    caret at 0 of `illing`, typing `bx` yielded `billingx`, not `bxilling`, and
 *    a second Backspace ate the last character instead of the one before the
 *    caret. The filter now repaints only its rows (`.fb-learn-rows`) and never
 *    the field being typed in, so the caret is the browser's to keep.
 *  • #1449 (second facet) — `setRoot` reset fifteen per-root fields and not
 *    `#learnFilter`, so the previous project's query still filtered the next
 *    project's modules. It is reset with the rest of them now.
 *
 * Retired tripwire: #1450 (Ignore on a never-learned module deleted its row)
 * — since the panel's redesign (82538cd9) such a module is listed only inside
 * its folder's "Not learned" row, which offers no Ignore at all. Ignore is
 * driven here on a LEARNED module's row, the surface that still carries it.
 */

const CLI = resolve(__dirname, '../../resources/cli/planflow-ai.mjs')
const boardRoot = '.flow-board-root'
const MODULES = ['auth', 'billing', 'inventory', 'search', 'shipping']
/** Every module row the derive produces: the spine root plus its children. */
const ALL_ROWS = 1 + MODULES.length

function git(dir: string, args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
}

function cli(dir: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [CLI, ...args], { cwd: dir }).toString()
  } catch (error) {
    const e = error as { stdout?: Buffer; stderr?: Buffer }
    return `CLI FAILED: ${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`
  }
}

/** A throwaway repo with `modules` source dirs, derived by the embedded CLI. */
function makeRepo(modules: string[]): (dir: string) => void {
  return (dir) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'learn-panel-probe', version: '1.0.0' }))
    for (const m of modules) {
      mkdirSync(join(dir, 'src', m), { recursive: true })
      writeFileSync(join(dir, 'src', m, `${m}.ts`), `export function ${m}(): number {\n  return 1\n}\n`)
    }
    git(dir, ['add', '-A'])
    git(dir, ['-c', 'user.email=me@example.com', '-c', 'user.name=Me', 'commit', '-qm', 'init'])
    git(dir, ['config', 'user.email', 'me@example.com'])
    git(dir, ['config', 'user.name', 'Me'])
    // `derive` refuses without flow/; the IDE provisioner normally creates it.
    mkdirSync(join(dir, 'flow', 'brain', '.structure'), { recursive: true })
    cli(dir, ['blueprint', 'derive'])
  }
}

/** Open the Blueprint tab, wait for the board to be live, then open the
 *  Learning panel's Modules tab. */
async function openModulesTab(window: Page): Promise<void> {
  await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-blueprint')))
  await window.locator(boardRoot).first().waitFor({ state: 'visible', timeout: 20_000 })
  // The board sits behind "Setting up plan-flow…" until the IDE provisioner
  // finishes; the Territory appears only once the board is live.
  await window.locator(`${boardRoot} .fb-territory`).first().waitFor({ state: 'visible', timeout: 90_000 })
  // The header's "Learn" button is the panel's door on the Territory (the
  // learn chip is painted only by the retired module-card map).
  await openLearningPanel(window)
  await window.locator('.fb-learn-panel-body').waitFor({ state: 'visible', timeout: 15_000 })
  const modules = window.locator('.fb-learn-tab', { hasText: 'Modules' })
  if (await modules.count()) await modules.first().click()
  await window.locator('.fb-learn-filter').waitFor({ state: 'visible', timeout: 10_000 })
}

/** Type into the filter box the way a user does — through the real input. */
async function typeFilter(window: Page, text: string): Promise<void> {
  await window.locator('.fb-learn-filter').click()
  await window.keyboard.type(text, { delay: 20 })
  await window.waitForTimeout(400)
}

async function filterValue(window: Page): Promise<string> {
  return window.locator('.fb-learn-filter').inputValue()
}

/** The filter box's caret position — the thing the input handler resets. */
async function caret(window: Page): Promise<number | null> {
  return window.evaluate(
    () => document.querySelector<HTMLInputElement>('.fb-learn-filter')?.selectionStart ?? null,
  )
}

/** Every module path the panel lists, whichever group it sits in — a learned
 *  module's own row, or a not-learned folder's row (`.fb-lp-path` in both). */
async function moduleRows(window: Page): Promise<string[]> {
  // A group can be folded (Learned is, by default): a reader opens it to see
  // its rows, and so does this.
  for (let i = 0; i < 4; i += 1) {
    const folded = window.locator('.fb-learn-rows .fb-lp-ghead[aria-expanded="false"]')
    if ((await folded.count()) === 0) break
    await folded.first().click()
    await window.waitForTimeout(150)
  }
  return window.evaluate(() =>
    [...document.querySelectorAll('.fb-learn-rows .fb-lp-items .fb-lp-path')]
      .map((el) => el.textContent ?? '')
      .sort(),
  )
}

/**
 * Mark `modules` LEARNED, so the panel lists them as MODULE rows. Since the
 * panel's redesign (82538cd9, 2026-10-06) a never-learned module is shown only
 * inside its folder's "Not learned" row — which offers Learn, not Ignore — so
 * Ignore lives on the rows of modules something was learned about.
 *
 * Written once the project sits in its Workspace: before that, the migration's
 * copy and the provisioner's first pass replace `.structure`.
 */
async function seedLearned(window: Page, root: string, modules: string[]): Promise<void> {
  const structure = await waitForLinkedStructure(window, root)
  writeFileSync(
    join(structure, 'learning-state.jsonl'),
    `${modules.map((module) => JSON.stringify({ module, status: 'learned', notedAt: '2026-10-01T10:00:00Z' })).join('\n')}\n`,
  )
}

function flowconfig(root: string): string {
  const path = join(root, 'flow', '.flowconfig')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test.describe('blueprint learning panel — module filter + ignore', () => {
  test.afterAll(() => cleanupSeeds())

  test('control: the filter narrows the module list, and Ignore persists', async ({ window }) => {
    test.setTimeout(240_000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seedProject(window, 'flow-ux-learnfilter-ctl-', makeRepo(MODULES))
    await activateProject(window, root)
    await seedLearned(window, root, ['src/billing'])
    await openModulesTab(window)

    // ── The list is the derived module universe. ────────────────────────────
    await expect
      .poll(() => moduleRows(window), { timeout: 15_000 })
      .toEqual(['src', 'src/auth', 'src/billing', 'src/inventory', 'src/search', 'src/shipping'])
    const facts = window.locator('.fb-learn-panel-body .fb-lp-facts').first()
    await expect(facts).toContainText(`1 of ${ALL_ROWS} modules`)

    // ── It filters, it says so when nothing matches, and it restores. ───────
    await typeFilter(window, 'billing')
    await expect.poll(() => moduleRows(window), { timeout: 10_000 }).toEqual(['src/billing'])
    await window.locator('.fb-learn-filter').fill('')
    await window.waitForTimeout(400)
    expect(await moduleRows(window)).toHaveLength(ALL_ROWS)
    await typeFilter(window, 'zzzz')
    expect(await moduleRows(window)).toEqual([])
    await expect(window.locator('.fb-learn-rows')).toContainText('Nothing here matches.')
    await window.locator('.fb-learn-filter').fill('')
    await window.waitForTimeout(400)

    // ── Ignore is a real, persisted write (ground truth on disk). ───────────
    const row = window.locator('.fb-learn-row', { hasText: 'src/billing' }).first()
    await row.hover()
    await row.locator('.fb-learn-ignore-btn').click()
    await expect
      .poll(() => flowconfig(root), { timeout: 15_000 })
      .toContain('learn_ignore: src/billing')
    // ...and the count follows it out of the denominator.
    await expect(facts).toContainText(`of ${ALL_ROWS - 1} modules`)

    expect(errors, 'no uncaught errors').toEqual([])
  })

  // ── Tripwire 1 — the filter box cannot be edited anywhere but its end ────
  //
  // Verified RED vs main (2026-08-10): after the first inserted character the
  // caret is at 7 (end) instead of 1, so `bx` typed at position 0 of `illing`
  // produces `billingx`. Measured with ArrowLeft, not Home — Home does not move
  // the caret reliably in a macOS text input, and reading a no-op Home as the
  // bug was this sweep's own first (discarded) misreading.
  test('the filter box keeps the caret where the user put it', async ({ window }) => {
    test.setTimeout(240_000)
    const root = await seedProject(window, 'flow-ux-learnfilter-caret-', makeRepo(MODULES))
    await activateProject(window, root)
    await openModulesTab(window)

    // A user who mistyped the start of the word: fix it in place.
    await typeFilter(window, 'illing')
    for (let i = 0; i < 'illing'.length; i += 1) await window.keyboard.press('ArrowLeft')
    expect(await caret(window), 'the caret really is at the start').toBe(0)

    await window.keyboard.press('b')
    await window.waitForTimeout(400)
    expect(await filterValue(window)).toBe('billing')
    expect(await caret(window), 'the caret stays where the typing is').toBe(1)

    // The character after it must follow the caret, not jump to the end.
    await window.keyboard.press('x')
    await window.waitForTimeout(400)
    expect(await filterValue(window), 'consecutive mid-string typing is not scrambled').toBe(
      'bxilling',
    )
  })

  // ── Tripwire 1b — the same defect ate the wrong character on Backspace ───
  //
  // Verified RED vs main (2026-08-10): `shipping` with the caret after `ship`
  // backspaces to `shiping` (right), then to `shipin` — the LAST character.
  //
  // #1449 named the second delete's correct result as `shiing`; it is `shping`,
  // and the caret assertions below are why. `shipping` is s(0)h(1)i(2)p(3)p(4)
  // i(5)n(6)g(7); four ArrowLeft puts the caret at 4, so the first Backspace
  // takes index 3 and LEAVES THE CARET AT 3 — the second therefore takes index
  // 2, the `i`. `shiing` is what you get only if the caret stays at 4, which is
  // the very behaviour this test exists to forbid. The bug the issue reported is
  // real and this asserts the fix; only its arithmetic is corrected.
  test('repeated Backspace deletes at the caret, not at the end', async ({ window }) => {
    test.setTimeout(240_000)
    const root = await seedProject(window, 'flow-ux-learnfilter-bksp-', makeRepo(MODULES))
    await activateProject(window, root)
    await openModulesTab(window)

    await typeFilter(window, 'shipping')
    for (let i = 0; i < 4; i += 1) await window.keyboard.press('ArrowLeft')
    expect(await caret(window), 'the caret is between `ship` and `ping`').toBe(4)

    await window.keyboard.press('Backspace')
    await window.waitForTimeout(400)
    expect(await filterValue(window)).toBe('shiping')
    expect(await caret(window), 'the caret follows the delete instead of jumping to 7').toBe(3)

    await window.keyboard.press('Backspace')
    await window.waitForTimeout(400)
    expect(await filterValue(window), 'the second Backspace deletes at the caret').toBe('shping')
    expect(await caret(window)).toBe(2)
  })

  // ── Tripwire 2 (#1450) — RETIRED 2026-10-09 ──────────────────────────────
  //
  // It pinned "Ignore on a NEVER-LEARNED module deletes its row outright". The
  // panel's redesign (82538cd9, 2026-10-06) removed that action from such a
  // module altogether: a never-learned module is listed inside its folder's
  // "Not learned" row, which offers Learn and no Ignore. The one-way door the
  // tripwire described no longer exists to be pressed.

  // ── Tripwire 3 — the filter outlives the project it was typed in ─────────
  //
  // Verified RED vs main (2026-08-10): project B's panel shows
  // "No modules match" with `billing` still in the box.
  test('a project switch clears the module filter', async ({ window }) => {
    test.setTimeout(300_000)
    const rootA = await seedProject(window, 'flow-ux-learnfilter-a-', makeRepo(MODULES))
    const rootB = await seedProject(
      window,
      'flow-ux-learnfilter-b-',
      makeRepo(['payments', 'notifications']),
    )

    await activateProject(window, rootA)
    await openModulesTab(window)
    await typeFilter(window, 'billing')
    await expect.poll(() => moduleRows(window), { timeout: 10_000 }).toEqual(['src/billing'])

    await activateProject(window, rootB)
    // Editor tabs belong to the scope on screen (f6ef9977): project B has its
    // own tab set, so its Blueprint is opened there — the board itself is one
    // instance per window, which is what could carry the filter across.
    await openModulesTab(window)

    expect(await filterValue(window), 'the new project starts unfiltered').toBe('')
    await expect
      .poll(() => moduleRows(window), {
        timeout: 15_000,
        message: "project B's own modules are listed",
      })
      .toContain('src/payments')
  })
})
