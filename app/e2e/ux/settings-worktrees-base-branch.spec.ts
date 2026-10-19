import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The setup value under BOTH spellings: an app write lands the renamed key
 *  under its new name AND its old one, with the same value (transitional
 *  dual-write), so a build older than the rename still reads it. */
function setupValues(text: string): [string | null, string | null] {
  const read = (key: string): string | null =>
    text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1] ?? null
  return [read('worktree_setup'), read('workspace_setup')]
}

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays).
 *
 * TWICE NOW THIS FILE HAS OUTLIVED ITS SUBJECT, and both times it was rewritten
 * rather than deleted, because a spec removed alongside the surface it guarded
 * proves nothing about what replaced it.
 *
 *  1. It began as `settings-branch-push-gating.spec.ts`, guarding one rule: the
 *     "Target branch" field is DISABLED whenever Auto-push is off. That rule
 *     died when the field stopped meaning "where a finished run pushes" and
 *     started meaning "what a thread's branch is cut from".
 *  2. It then guarded the renamed "Base branch" row — and that row is gone too,
 *     with the rest of the worktree-management settings. The keys survive; the
 *     CLI still reads them. What went is a panel in this app offering to set
 *     them.
 *
 * WHAT WAS ACTUALLY BEING DEFENDED, both times, is the Conversation files section's own
 * two rules — and both are still here, on the two rows that are:
 *
 *  - A field in this section is NOT part of the push pipeline. It is editable
 *    with Auto-push off, stays editable across push on and off again, and the
 *    typed value reaches flow/.flowconfig. Driven on the section's text field.
 *  - A value nobody has taken over is INHERITING, which is a different state
 *    from disabled: the row is quiet and read-only because nobody has claimed
 *    it, and it says whose value is in effect. Driven on the one row that still
 *    resolves through the person's defaults.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'

/** The Conversation files section's text field — the row that inherited the exercise. */
const TEXT_FIELD = 'Prepare a new conversation'

/** The one field on this panel whose value still answers through three layers. */
const INHERITED_FIELD = 'Let a conversation work on its own branch'

/** addRoot + setActiveProject; the flow overlay auto-opens for the unconfigured project. */
async function seedAndActivate(win: Page): Promise<string> {
  const dir = await seedProject(win)
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
  return dir
}

/**
 * Turn the push pipeline on or off from OUTSIDE this panel.
 *
 * The Auto-push switch is not on this surface any more — the Git & PR toggles
 * moved to the unified Settings page — so the pipeline is driven through the
 * same config channel `/flow push=true` uses, and the panel reconciles it live.
 * That is the honest way to ask the question this file exists for: does
 * anything in the Conversation files section CHANGE when the pipeline does?
 */
async function setPush(win: Page, root: string, on: boolean): Promise<void> {
  await win.evaluate(
    async ([r, v]) => {
      await (
        window as unknown as {
          flow: {
            flow: {
              setConfig(x: { rootId: string; updates: Record<string, string> }): Promise<unknown>
            }
          }
        }
      ).flow.flow.setConfig({ rootId: r, updates: { push: v } })
    },
    [root, on ? 'true' : 'false'],
  )
}

/** A row in the Conversation files section, by its label. */
function rowByLabel(overlay: ReturnType<Page['locator']>, label: string) {
  return overlay.locator('.fl-fs-row', { hasText: label })
}

function flowconfig(dir: string): string {
  const p = join(dir, 'flow', '.flowconfig')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

test.afterEach(() => cleanupSeeds())

test.describe('flow 11 — the Conversation files section is not part of the push pipeline', () => {
  test('editable with push off, and push toggling never changes that', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const dir = await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)

    const row = rowByLabel(overlay, TEXT_FIELD)
    const field = row.locator('input[type="text"]')

    // 1. Push is OFF on a fresh project, and the field is editable anyway —
    //    nothing in this section waits on the pipeline.
    expect(flowconfig(dir)).not.toContain('push: true')
    await expect(row).not.toHaveClass(/disabled/)
    await expect(field).toBeEnabled()

    await window.screenshot({ path: `${SCREENS}/settings-worktrees-base-branch.png` })

    // 2. A value typed with push OFF is written through — the value the old
    //    gate existed to prevent is now an ordinary setting.
    await field.fill('release-x')
    await field.blur()
    await expect
      .poll(() => setupValues(flowconfig(dir)), { timeout: 10_000 })
      .toEqual(['release-x', 'release-x'])

    // 3. Push ON changes nothing about this field…
    await setPush(window, dir, true)
    await expect.poll(() => flowconfig(dir), { timeout: 10_000 }).toContain('push: true')
    await expect(rowByLabel(overlay, TEXT_FIELD)).not.toHaveClass(/disabled/)
    await expect(rowByLabel(overlay, TEXT_FIELD).locator('input[type="text"]')).toBeEnabled()
    await expect(rowByLabel(overlay, TEXT_FIELD).locator('input[type="text"]')).toHaveValue(
      'release-x',
    )

    // 4. …and neither does push OFF again. The old spec asserted the opposite
    //    of both, which is exactly why they are asserted here.
    await setPush(window, dir, false)
    await expect.poll(() => flowconfig(dir), { timeout: 10_000 }).toContain('push: false')
    await expect(rowByLabel(overlay, TEXT_FIELD)).not.toHaveClass(/disabled/)
    await expect(rowByLabel(overlay, TEXT_FIELD).locator('input[type="text"]')).toBeEnabled()
    await expect(rowByLabel(overlay, TEXT_FIELD).locator('input[type="text"]')).toHaveValue(
      'release-x',
    )

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('a value nobody has set is inherited — quiet and read-only, not gated', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    await seedAndActivate(window)
    const overlay = window.locator(FLOW_OVERLAY)
    await expect(overlay).toHaveCount(1)

    const row = rowByLabel(overlay, INHERITED_FIELD)
    // NON-VACUITY FIRST: the row this is about really is on screen, so the
    // class and chip assertions below are read off something that exists.
    await expect(row).toHaveCount(1)

    // Inherited, NOT disabled: the two look different on purpose — a disabled
    // row is dimmed because something else has to be true first, an inherited
    // one is quiet because nobody has taken the value over yet.
    await expect(row).toHaveClass(/inherited/)
    await expect(row).not.toHaveClass(/disabled/)
    await expect(row.locator('.fl-fs-toggle')).toBeDisabled()

    // And it says whose value is in effect rather than reading as a value this
    // project chose.
    await expect(row.locator('.fl-fs-chip')).toHaveText("Flow's default")

    // The way to take it over is a press that says so — never a control that
    // silently starts writing the moment it is touched.
    await expect(row.locator('.fl-fs-inherit')).toHaveText('Use a project value')

    // The help is the honest sentence about the three ways a conversation gets
    // a branch — no config key, no path, no command (forbidden-pattern #12).
    await expect(row.locator('.fl-fs-help')).toContainText(
      'choose that when you start it, or ask from its menu later',
    )

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })
})
