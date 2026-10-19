import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 16. Drives the seam every prior settings sweep left un-probed: what
 * happens to an IN-PROGRESS interaction when the flow-settings overlay rebuilds
 * itself.
 *
 * The overlay is live-edited (no Save button): `#change` writes through
 * `flow:setConfig` and then calls `#renderSections()`, which does
 * `this.#body.textContent = ''` and rebuilds EVERY control from scratch
 * (flow-settings-view.ts:225-251, 517-530). The same unconditional rebuild also
 * answers `onStateChanged` (an external `/flow` write, or our own write's echo)
 * and `onRootsChanged` (any provisioning sweep) — lines 177-191.
 *
 * Nothing preserves focus, caret, or an in-flight gesture across that rebuild,
 * which costs the user two concrete things (both filed as #1032):
 *
 *  - A text/number field's `change` fires on BLUR. Clicking straight from an
 *    edited field onto a toggle blurs the field on mousedown → full rebuild →
 *    the button that received mousedown is detached before mouseup, so Chromium
 *    dispatches NO click at all (measured: `mousedown -> BUTTON.fl-fs-toggle`,
 *    `mouseup -> DIV.fl-fs-row`). The toggle silently does not apply.
 *  - A rebuild landing while the user types destroys the focused input; the
 *    remaining keystrokes go to `<body>` and the whole entry is lost.
 *
 * Prior flow-11 coverage never reached this: settings-text-dismiss.spec.ts
 * (round 13) types then DISMISSES the overlay (persists — no bug);
 * settings-forms.spec.ts explicitly BLURS its text field before asserting;
 * settings-worktrees-base-branch / settings-number-clamp-read drive one control at
 * a time with nothing else focused. #1000 is the same defect CLASS on the app
 * Settings overlay (accounts draft wiped by `accounts:changed`), a different
 * surface with a different trigger and a different fix site.
 *
 * THE FIELD CHANGED, THE SEAM DID NOT. Both gestures below drove 'Base branch'
 * until the worktree-management surfaces were removed and that row went with
 * them. Neither is about the base branch: they are about a text field's
 * blur-commit racing the next control's click-commit, and about a rebuild
 * landing mid-word. The Conversation files section's remaining text field takes its
 * place, and the seeded project owns a value in it for the same reason it
 * owned a branch — so select-all replaces rather than appends.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'

/** The Conversation files text field both gestures below are driven through. */
const TEXT_FIELD = 'Prepare a new conversation'

/** Seed a repo whose flow/.flowconfig ALREADY enables push+commit and holds a
 *  value in the text field, so nothing has to be clicked before the probe's own
 *  gesture — a click first would leave a `flow:stateChanged` echo in flight and
 *  make the probe race itself. The value is seeded so the select-all below
 *  REPLACES something: a field that starts empty cannot tell an append apart
 *  from a replace, which is exactly how a sibling spec once read its own typing
 *  as the racing write it was hunting for (#1428). */
async function seedConfigured(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-rerender-', (d) => {
    mkdirSync(join(d, 'flow'), { recursive: true })
    // Seeded under the OLD key on purpose: the field must read it as an alias,
    // and the app's own write below lands it under BOTH spellings.
    // `model_routing: false` because routing defaults ON since #1957, and the
    // specs below need a toggle whose click turns it on.
    writeFileSync(
      join(d, 'flow', '.flowconfig'),
      'push: true\ncommit: true\nmodel_routing: false\nworkspace_setup: prepare-me\n',
    )
  })
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
  return dir
}

/** Open the overlay (an already-configured project does not auto-onboard) and
 *  let every boot/echo re-render settle, so a rebuild can only come from the
 *  gesture under test. */
async function openSettled(win: Page): Promise<void> {
  const overlay = win.locator(FLOW_OVERLAY)
  if ((await overlay.count()) === 0) {
    await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-flow-settings')))
  }
  await expect(overlay).toHaveCount(1)
  await win.waitForTimeout(2500)
}

function toggleByLabel(overlay: ReturnType<Page['locator']>, label: string) {
  return overlay.locator('.fl-fs-row', { hasText: label }).locator('.fl-fs-toggle')
}

function textByLabel(overlay: ReturnType<Page['locator']>, label: string) {
  return overlay.locator('.fl-fs-row', { hasText: label }).locator('input[type="text"]')
}

function readConfig(dir: string): string {
  const p = join(dir, 'flow', '.flowconfig')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

/** A human-paced physical click (move · press · hold · release) — the timing a
 *  real mouse produces, and the only way the mousedown/mouseup split is real. */
async function humanClick(win: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  // Raw mouse events use viewport coordinates and do NOT auto-scroll the way
  // locator.click() does — a control below the fold (this panel scrolls) would
  // otherwise be "clicked" at a point outside the window, delivering nothing.
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  if (!box) throw new Error('control has no bounding box')
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.waitForTimeout(80)
  await win.mouse.down()
  await win.waitForTimeout(140)
  await win.mouse.up()
}

test.afterEach(() => cleanupSeeds())

test.describe('flow 11 — flow-settings overlay vs. in-progress interaction', () => {
  /**
   * LIVE GUARD (passes on current main). Establishes the two baselines that make
   * the tripwires below meaningful, and locks in behaviour that must never rot:
   *  - an undisturbed toggle click applies AND reaches flow/.flowconfig;
   *  - an undisturbed text edit applies AND reaches flow/.flowconfig;
   *  - controls in the header (outside the rebuilt #body) keep working after an
   *    edit — the ✕ closes the overlay, so the panel is never a trap.
   * Account-independent, credential-free, no agent.
   */
  test('undisturbed edits apply and persist; the header ✕ survives a field edit', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const dir = await seedConfigured(window)
    await openSettled(window)
    const overlay = window.locator(FLOW_OVERLAY)

    // 1. A toggle clicked with nothing focused applies and is written through.
    const routing = () => toggleByLabel(overlay, 'Model routing')
    await expect(routing()).toHaveAttribute('aria-checked', 'false')
    await humanClick(window, routing())
    await expect(routing()).toHaveAttribute('aria-checked', 'true')
    await expect
      .poll(() => readConfig(dir), { timeout: 5000 })
      .toContain('model_routing: true')

    // 2. A text edit, committed by an explicit blur, applies and is written through.
    //    Select-all first: the seeded project already holds a value here, and
    //    typing at the caret would append to it rather than replace it.
    await humanClick(window, textByLabel(overlay, TEXT_FIELD))
    await window.keyboard.press('ControlOrMeta+a')
    await window.keyboard.type('release', { delay: 30 })
    await window.keyboard.press('Tab') // explicit blur — the already-covered path
    await expect
      .poll(() => setupValues(readConfig(dir)), { timeout: 5000 })
      .toEqual(['release', 'release'])

    // 3. The header ✕ lives OUTSIDE #body, so it is never rebuilt — it must stay
    //    clickable straight from an edited field (the overlay is not a trap).
    await humanClick(window, textByLabel(overlay, 'Ignore modules'))
    await window.keyboard.type('vendor', { delay: 30 })
    await humanClick(window, overlay.locator('.fl-settings-close'))
    await expect(window.locator(FLOW_OVERLAY)).toHaveCount(0)

    expect(errors, `unexpected pageerrors: ${errors.join(' | ')}`).toEqual([])
  })

  /**
   * TRIPWIRE #1032 (a) — the dead click. Verified non-vacuous: un-fixme'd it
   * fails deterministically with the toggle still `aria-checked="false"` and no
   * `pr:` key in flow/.flowconfig.
   */
  test(
    'clicking a toggle straight after editing a field applies the toggle (#1032)',
    async ({ window }) => {
      const dir = await seedConfigured(window)
      await openSettled(window)
      const overlay = window.locator(FLOW_OVERLAY)

      // The natural gesture: fill a text field in and then turn on Auto-create
      // PR. The two rows live in different sections, which changes nothing
      // about the seam — a field's blur-commit and the next control's
      // click-commit are still one gesture.
      await humanClick(window, textByLabel(overlay, TEXT_FIELD))
      await window.keyboard.press('ControlOrMeta+a')
      await window.keyboard.type('release', { delay: 45 })

      // It was 'Auto-create PR' until the Git & PR toggles moved to the unified
      // Settings page. The seam is a blur-commit and a click-commit in ONE
      // gesture — any toggle on this panel is that second control.
      const toggle = () => toggleByLabel(overlay, 'Model routing')
      await expect(toggle()).toHaveAttribute('aria-checked', 'false')
      await humanClick(window, toggle())
      await window.waitForTimeout(1500)
      await window.screenshot({ path: `${SCREENS}/settings-rerender-deadclick.png` })

      // The typed text DID save — only the click was lost, with zero feedback.
      await expect(textByLabel(overlay, TEXT_FIELD)).toHaveValue('release')
      expect(setupValues(readConfig(dir)), 'the typed value should have persisted').toEqual([
        'release',
        'release',
      ])

      // TODAY: aria-checked is still "false" and .flowconfig has no
      // `model_routing:` key — the user leaves believing the toggle is on.
      await expect(toggle()).toHaveAttribute('aria-checked', 'true')
      expect(readConfig(dir), 'the toggle must reach .flowconfig').toContain(
        'model_routing: true',
      )
    },
  )

  /**
   * TRIPWIRE #1032 (b) — typing destroyed mid-word by a background rebuild.
   * `onStateChanged` fires for any external `flow:setConfig` write (the `/flow`
   * slash command, an autopilot run, another window), and the overlay answers it
   * with the same unconditional `#body` rebuild. Verified non-vacuous:
   * un-fixme'd, the field reads "" instead of the typed value.
   */
  test(
    'an external /flow write while typing does not destroy the entry (#1032)',
    async ({ window }) => {
      const dir = await seedConfigured(window)
      await openSettled(window)
      const overlay = window.locator(FLOW_OVERLAY)

      await humanClick(window, textByLabel(overlay, 'Ignore modules'))
      await window.keyboard.type('vendor,gener', { delay: 60 })

      // An unrelated key written from outside the panel — exactly what
      // `/flow autopilot=true` does while the user has the panel open.
      await window.evaluate(async (p) => {
        await (
          window as unknown as {
            flow: {
              flow: {
                setConfig(a: { rootId: string; updates: Record<string, string> }): Promise<unknown>
              }
            }
          }
        ).flow.flow.setConfig({ rootId: p, updates: { autopilot: 'true' } })
      }, dir)
      await window.waitForTimeout(900)

      // TODAY: the input was destroyed by the rebuild, so these keystrokes land
      // on <body> and are lost.
      await window.keyboard.type('ated,dist', { delay: 60 })
      await window.waitForTimeout(1200)
      await humanClick(window, overlay.locator('.fl-settings-heading').first())
      await window.waitForTimeout(1000)

      await textByLabel(overlay, 'Ignore modules').scrollIntoViewIfNeeded()
      await window.screenshot({ path: `${SCREENS}/settings-rerender-midtyping.png` })

      await expect(textByLabel(overlay, 'Ignore modules')).toHaveValue('vendor,generated,dist')
      expect(readConfig(dir)).toContain('learn_ignore: vendor,generated,dist')
    },
  )
})
