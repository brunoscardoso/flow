import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds, activeProjectName } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { readFileSync, existsSync } from 'node:fs'
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
 * UX-sweep regression probe — flow 11 (Settings/accounts + flow-settings
 * overlays), round 24.
 *
 * The Flow-settings overlay has 23 committed specs (toggles, branch gating,
 * number clamp, write-failure rollback, re-render interaction, provisioning,
 * account binding, overlay stacking). Every one of them drives ONE control at a
 * time and lets it settle. Nothing had ever driven the ordinary gesture where a
 * text field's blur-commit and the next control's click-commit fire **in the
 * same click**, and nothing had removed the root out from under an open panel.
 * Both are broken.
 *
 * Findings this cycle:
 *  - #1452 — `FlowObserver.setConfig` (flow-observer.ts:566-582) is an
 *    unserialized read-modify-write over the whole `.flowconfig`: read → merge →
 *    full-file overwrite, no queue, no lock. The overlay's text inputs commit on
 *    `change` (= blur), so "type a base branch, then click Auto-create PR"
 *    issues two overlapping setConfig calls; both merge against the same
 *    snapshot and the second write drops the first one's key. Measured 3/4 runs
 *    through the UI and 2/5 through the bridge. Both writes RESOLVE, so #1158's
 *    rollback + inline error never fire — the typed branch just vanishes and the
 *    box blanks itself. One run left the file torn (`…branch: release/2.0⏎e⏎`).
 *  - #1453 — removing the root leaves the panel open, titled with the removed
 *    project, every control enabled, and its toggles keep writing
 *    `.flowconfig` into the removed project's folder.
 *
 * HARNESS TRAPS (each cost a wrong reading first):
 *  - `toContainText('provisioned')` matches **"Not provisioned"**. Waiting for
 *    the background auto-provision to settle needs `/^v\d.*· provisioned/` — the
 *    vacuous wait made every "settled root" measurement actually an in-flight
 *    one, and in-flight `provisionRoot` early-returns on `inFlight`, which made
 *    "Re-provision now" look like it had no busy state at all. On a genuinely
 *    settled root the busy state is fine ("Re-provisioning…", disabled, ~1.9s).
 *  - `locator.fill('')` before typing INSERTS an extra write and spaces the pair
 *    out — it made the race disappear (4/4 green). Reproduce with plain
 *    `type()`, or `Meta+a` then type; never `fill`.
 *  - The docked terminal covers the panel in a default window — ⌃` first for
 *    legible screenshots.
 */

const OVERLAY = '.fl-settings-overlay:not([hidden])'

async function activate(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
}

function flowconfig(dir: string): string {
  const p = join(dir, 'flow', '.flowconfig')
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

/** Wait for the background auto-provision to stamp the root — NOT
 *  `toContainText('provisioned')`, which "Not provisioned" satisfies. */
async function settled(win: Page): Promise<void> {
  await expect(
    win
      .locator(OVERLAY)
      .locator('.fl-settings-section', { hasText: 'Plan-flow provisioning' })
      .locator('.fl-fs-name')
      .first(),
  ).toHaveText(/^v\d.*· provisioned/, { timeout: 45_000 })
}

/** Seed a repo, make it active (the flow panel auto-opens for a fresh project),
 *  and wait until provisioning has settled so nothing else is writing. */
async function openSettledPanel(win: Page): Promise<string> {
  await win.keyboard.press('Control+`').catch(() => undefined)
  const dir = await seedProject(win)
  await activate(win, dir)
  await expect(win.locator(OVERLAY)).toHaveCount(1)
  await settled(win)
  return dir
}

const row = (win: Page, label: string) =>
  win.locator(OVERLAY).locator('.fl-fs-row', { hasText: label })

/**
 * Put a value in the Conversation files text field before the race starts.
 *
 * NOT A SETUP DETAIL — the select-all below has to REPLACE something, or an
 * append reads as a pass. Written through the same channel the panel uses and
 * settled before the gesture, so it cannot join the race it is preparing for.
 */
async function seedSetupField(win: Page, root: string, value = 'prepare-me'): Promise<void> {
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
      ).flow.flow.setConfig({ rootId: r, updates: { worktree_setup: v } })
    },
    [root, value],
  )
}

/** The Conversation files text field the UI-channel race is driven through. */
const TEXT_FIELD = 'Prepare a new conversation'

test.afterEach(() => cleanupSeeds())

test.describe('flow settings — concurrent config writes', () => {
  // ── Live guards (green vs main) ─────────────────────────────────────────

  test('two toggles clicked as separate gestures BOTH persist', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const dir = await openSettledPanel(window)
    await row(window, 'Autopilot').locator('.fl-fs-toggle').click()
    await expect
      .poll(() => flowconfig(dir), { timeout: 10_000 })
      .toContain('autopilot: true')
    // Routing defaults ON (#1957) and a fresh project has no key, so the click
    // turns it OFF — written out explicitly, which is what proves it persisted.
    const routing = row(window, 'Model routing').locator('.fl-fs-toggle')
    await expect(routing).toHaveAttribute('aria-checked', 'true')
    await routing.click()
    await expect
      .poll(() => flowconfig(dir), { timeout: 10_000 })
      .toContain('model_routing: false')

    // The first write must still be there — this is the non-racing baseline.
    expect(flowconfig(dir)).toContain('autopilot: true')
    expect(errors, `uncaught: ${errors.join(' | ')}`).toEqual([])
  })

  test('a text field committed by blur ALONE reaches disk and survives a reopen', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const dir = await openSettledPanel(window)
    const ignore = () => row(window, 'Ignore modules').locator('input')
    await ignore().click()
    await ignore().type('src/vendor')
    // Blur with nothing else competing: Tab moves focus, no second write.
    await window.keyboard.press('Tab')
    await expect
      .poll(() => flowconfig(dir), { timeout: 10_000 })
      .toContain('learn_ignore: src/vendor')

    await window.keyboard.press('Escape')
    await expect(window.locator(OVERLAY)).toHaveCount(0)
    await window.evaluate(
      (p) =>
        document.dispatchEvent(new CustomEvent('flow:open-flow-settings', { detail: { rootPath: p } })),
      dir,
    )
    await expect(window.locator(OVERLAY)).toHaveCount(1)
    await expect(row(window, 'Ignore modules').locator('input')).toHaveValue('src/vendor')

    // No write-failure line — the write genuinely succeeded (#1158's contract).
    await expect(window.locator(OVERLAY).locator('.fl-fs-write-error')).toHaveCount(0)
    expect(errors, `uncaught: ${errors.join(' | ')}`).toEqual([])
  })

  test('removing the open panel’s root leaves the shell correctly project-less', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

    const dir = await openSettledPanel(window)
    await window.evaluate(async (p) => {
      await (
        window as unknown as {
          flow: { project: { remove(r: { rootPath: string }): Promise<unknown> } }
        }
      ).flow.project.remove({ rootPath: p })
    }, dir)

    // The shell half is healthy and must stay that way: everything outside the
    // modal falls back to the no-project state. (The titlebar names the
    // Workspace now, never "No project", so ask the shell's own answer.)
    await expect.poll(() => activeProjectName(window), { timeout: 10_000 }).toBe('')
    expect(errors, `uncaught: ${errors.join(' | ')}`).toEqual([])
  })

  // ── Tripwires — RED against current main, flip green when the bugs land ──

  // #1452 (UI channel). Type into a text field, then click another toggle: the
  // blur-commit and the click-commit are one gesture, so they race and the
  // typed value is dropped. Four attempts — a fixed setConfig makes all four
  // land. (It drove 'Base branch' until that row was removed with the
  // worktree-management surfaces; the seam is the field's blur-commit, not
  // which setting the field holds.)
  test('#1452: a value typed then followed by a toggle click survives', async ({
    window,
  }) => {
    const dir = await openSettledPanel(window)
    const field = () => row(window, TEXT_FIELD).locator('input')
    // Something in the box before the race, settled, so the select-all below
    // replaces rather than appends.
    await seedSetupField(window, dir)
    await expect
      .poll(() => setupValues(flowconfig(dir)), { timeout: 10_000 })
      .toEqual(['prepare-me', 'prepare-me'])

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const value = `release/2.${attempt}`
      await field().click()
      // Portable select-all: a hardcoded Meta+a is a no-op off macOS, so the
      // typed value appended to the previous one (`release/2.0release/2.1`) and
      // the spec read that as the racing write it was hunting for (cf. #1428).
      await field().press('ControlOrMeta+a')
      await field().type(value)
      // The very next control, in the same gesture — no explicit blur.
      // (It was 'Auto-commit per task' until the Git & PR toggles moved to the
      // unified Settings page; the seam is one gesture reaching two controls,
      // not which two.)
      await row(window, 'Model routing').locator('.fl-fs-toggle').click()
      await window.waitForTimeout(1200)
      expect(
        setupValues(flowconfig(dir)),
        `attempt ${attempt}: value dropped by the racing write`,
      ).toEqual([value, value])
      await expect(field()).toHaveValue(value)
    }
  })

  // #1452 (mechanism). Two overlapping setConfig calls — exactly what one
  // gesture produces — must both survive. Five pairs; a serialized writer keeps
  // every key.
  test('#1452: overlapping setConfig calls do not lose each other’s keys', async ({
    window,
  }) => {
    const dir = await openSettledPanel(window)
    for (let i = 0; i < 5; i += 1) {
      await window.evaluate(
        async ([root, n]) => {
          const api = (
            window as unknown as {
              flow: {
                flow: {
                  setConfig(r: { rootId: string; updates: Record<string, string> }): Promise<unknown>
                }
              }
            }
          ).flow.flow
          await Promise.all([
            api.setConfig({ rootId: root as string, updates: { branch: `feat/${n}` } }),
            api.setConfig({ rootId: root as string, updates: { autopilot: 'true' } }),
          ])
        },
        [dir, i] as const,
      )
      await window.waitForTimeout(400)
      const text = flowconfig(dir)
      expect(text, `pair ${i}: branch lost to the concurrent write`).toContain(`branch: feat/${i}`)
      expect(text, `pair ${i}: autopilot lost to the concurrent write`).toContain('autopilot: true')
    }
  })

  // #1453. Once the root is gone from the app, the panel must stop acting
  // on it — closed, or degraded to its own "Open a project…" empty state. What
  // it must NEVER do is keep writing config into the removed project's folder.
  test('#1453: a removed root’s panel stops writing into the removed project', async ({
    window,
  }) => {
    const dir = await openSettledPanel(window)
    expect(flowconfig(dir)).not.toContain('autopilot: true')

    await window.evaluate(async (p) => {
      await (
        window as unknown as {
          flow: { project: { remove(r: { rootPath: string }): Promise<unknown> } }
        }
      ).flow.project.remove({ rootPath: p })
    }, dir)
    await expect.poll(() => activeProjectName(window), { timeout: 10_000 }).toBe('')

    // The original tripwire only asserted "if a toggle survives, it must not
    // write" — which a fix that removes the toggles passes without ever being
    // looked at. Assert the state itself: the panel either closed with its
    // project or degraded to the project-less panel, and in NEITHER case does it
    // still claim to be editing the removed project.
    const overlay = window.locator('.fl-settings-overlay:not([hidden]):has-text("Flow settings")')
    await expect
      .poll(async () => (await overlay.count()) === 0 || (await overlay.innerText()), {
        timeout: 10_000,
      })
      .not.toContain(dir.split('/').pop() ?? '')

    if ((await overlay.count()) > 0) {
      await expect(overlay).toContainText('Open a project to edit its flow settings.')
      // The lie this also fixes: a genuinely provisioned project was reported
      // as "Not provisioned" once its root resolved to undefined.
      await expect(overlay).not.toContainText('Not provisioned')
    }

    const stillEditable = await row(window, 'Autopilot').locator('.fl-fs-toggle').count()
    expect(stillEditable, 'a removed project must not still be editable').toBe(0)
    await window.waitForTimeout(1000)
    expect(
      flowconfig(dir),
      'the panel wrote .flowconfig into a project the app no longer holds',
    ).not.toContain('autopilot: true')
  })
})
