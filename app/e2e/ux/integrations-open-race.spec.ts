import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 17. Guards the Integrations overlay's render lifecycle, which no
 * existing spec touches: `tasks-integrations-overlay.spec` proves the board's
 * header button is not a dead click (open → 3 headings → close), but it never
 * asserts SECTION CARDINALITY and never re-opens the panel, so the whole
 * re-entrant-render seam was un-driven.
 *
 * `IntegrationsSettingsView.#render()` used to clear `#body` and then await the
 * `integrations:status` probes for GitHub + Jira + Azure DevOps (which shell out
 * to the `gh` / `az` CLIs — measured ~5.4s here) before appending anything.
 * Unlike the app Settings overlay — which grew `#renderSeq` + `isLatestRender()`
 * for exactly this in #308 — it had NO render-generation guard, so a superseded
 * render still wrote into the panel when it resolved.
 *
 * The user-facing invariant: the Integrations panel shows exactly ONE section per
 * provider, however many times it is opened, and it must never present as an
 * empty box while it loads.
 *
 * Filed this cycle:
 *  - #1068 — re-opening inside the probe window appends another full copy of
 *    every provider section (2 opens → 6 sections, 3 opens → 9; permanent).
 *  - #1069 — for those ~5s the panel is a stub with one sentence and no
 *    spinner/skeleton/"Checking connections…" (residual of the #174 async fix),
 *    which is what pushes users into the #1068 path in the first place.
 *
 * Test 1 drives the non-racing lifecycle. Tests 2 and 3 encode the two filed
 * bugs and are the regression guards for their fixes:
 *   #1068 — `#renderSeq` + `isLatestRender()` (the ported #308 guard), plus a
 *           generation bump on close, plus an atomic `replaceChildren` swap.
 *   #1069 — the provider sections paint IMMEDIATELY in a "Checking…" pending
 *           state, so the panel is never an empty box.
 */

// INTEGRATIONS IS A SETTINGS GROUP NOW, not an overlay: it used to be a modal
// reached from Settings by pressing a button — a door inside a door — and the
// provider sections render on the page itself. The name is kept so the walk
// below reads unchanged; what it names is the group that is showing.
const OVERLAY = '.fl-settings-group:not([hidden])'
const PROVIDERS = ['GitHub', 'Jira', 'Azure DevOps'] as const
/** A PROVIDER section — one with a provider heading. The Integrations group
 *  also carries a settings section of its own (closing the remote ticket on
 *  Done), which is not a provider and was never part of the count. */
const PROVIDER_SECTION = '.fl-settings-section:has(.fl-settings-heading)'
/** The gh/az CLI probes are slow and machine-dependent — be generous. */
const LOAD_TIMEOUT = 40_000

test.afterAll(() => cleanupSeeds())

/** Seed a project and open the Tasks board, whose header carries the button. */
/**
 * INTEGRATIONS MOVED TO THE APP'S SETTINGS (2026-09-04) — they are accounts,
 * and every other account is configured there. The race this file is about is
 * unchanged: it is between the overlay's own open and close, whichever surface
 * dispatched the event.
 */
async function openBoard(win: Page): Promise<void> {
  const root = await seedProject(win)
  await activateProject(win, root)
}

/**
 * Open Integrations.
 *
 * THERE IS NO DOOR TO PRESS ANY MORE. It was a button in Settings that raised a
 * modal over Settings; the provider sections render on the page itself, so
 * `flow:open-integrations` opens the page on that group. The race this file is
 * about — a status probe resolving into a panel that has been superseded — is
 * unchanged, and is what the cases below still drive.
 */
/** Close the Settings tab from the tab strip — a page has no ✕ of its own. */
async function closeSettings(win: Page): Promise<void> {
  const close = win.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close')
  if ((await close.count()) > 0) await close.first().click()
  await expect(win.locator('.fl-settings-page')).toBeHidden()
}

function integrationsButton(win: Page) {
  return win.locator('.fl-settings-tab', { hasText: 'Integrations' })
}

test.describe('flow 11 — Integrations overlay render lifecycle', () => {
  test('one section per provider on open, and again after a completed close/reopen', async ({
    window,
  }) => {
    test.setTimeout(180_000)
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

    await openBoard(window)
    const overlay = window.locator(OVERLAY)

    // (1) First open — the panel settles on exactly one section per provider.
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))
    await expect(integrationsButton(window)).toHaveClass(/active/, { timeout: 15_000 })
    await expect(overlay).toBeVisible()
    await expect(overlay.locator(PROVIDER_SECTION)).toHaveCount(3, { timeout: LOAD_TIMEOUT })
    for (const provider of PROVIDERS) {
      await expect(overlay.locator('.fl-settings-heading', { hasText: provider })).toHaveCount(1)
    }

    // (2) Close AFTER the load completed, then reopen: the previous render is
    // long settled, so the panel must once more hold exactly three sections —
    // no accumulation across the panel's lifetime (it is a singleton view).
    // LEAVING IT IS A TAB CLOSE now, not a dialog dismiss — and closing the
    // Settings tab is exactly the supersede this file is about: a probe still
    // in flight must not paint into a host that has left the document.
    await closeSettings(window)
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))
    await expect(integrationsButton(window)).toHaveClass(/active/, { timeout: 15_000 })
    await expect(overlay).toBeVisible()
    await expect(overlay.locator(PROVIDER_SECTION)).toHaveCount(3, { timeout: LOAD_TIMEOUT })
    // Settle past a second probe round-trip and re-assert — a late-resolving
    // render would append here.
    await window.waitForTimeout(8000)
    await expect(overlay.locator(PROVIDER_SECTION)).toHaveCount(3)
    for (const provider of PROVIDERS) {
      await expect(overlay.locator('.fl-settings-heading', { hasText: provider })).toHaveCount(1)
    }

    await window.screenshot({ path: 'e2e/ux/__screens/integrations-open-race.png' })

    // Closes cleanly, leaving no overlay behind.
    // LEAVING IT IS A TAB CLOSE now, not a dialog dismiss — and closing the
    // Settings tab is exactly the supersede this file is about: a probe still
    // in flight must not paint into a host that has left the document.
    await closeSettings(window)

    expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
  })

  // #1068 — re-opening while the first render's status probes are still in
  // flight used to append a second (and third…) full copy of every provider
  // section; the superseded render must now bail before touching #body.
  test(
    're-opening during the status probe must not duplicate provider sections (#1068)',
    async ({ window }) => {
      test.setTimeout(240_000)
      await openBoard(window)
      const overlay = window.locator(OVERLAY)

      // Three impatient cycles, each closing well inside the probe window.
      for (let i = 0; i < 3; i++) {
        await window.evaluate(() =>
          document.dispatchEvent(new CustomEvent('flow:open-integrations')),
        )
        await expect(integrationsButton(window)).toHaveClass(/active/, { timeout: 15_000 })
        await expect(overlay).toBeVisible()
        await window.waitForTimeout(900)
        if (i < 2) await closeSettings(window)
      }

      await expect(overlay.locator(PROVIDER_SECTION)).not.toHaveCount(0, {
        timeout: LOAD_TIMEOUT,
      })
      // Let every superseded render resolve.
      await window.waitForTimeout(12_000)
      await expect(overlay.locator(PROVIDER_SECTION)).toHaveCount(3)
      for (const provider of PROVIDERS) {
        await expect(overlay.locator('.fl-settings-heading', { hasText: provider })).toHaveCount(1)
      }
    },
  )

  // #1069 — while the gh/az probes run (~5s) the panel used to be a stub with a
  // single sentence: no spinner, no skeleton, no "Checking connections…".
  test('the panel shows a loading affordance while the CLI status probes run (#1069)', async ({
    window,
  }) => {
    test.setTimeout(180_000)
    await openBoard(window)
    const overlay = window.locator(OVERLAY)

    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))
    await expect(integrationsButton(window)).toHaveClass(/active/, { timeout: 15_000 })
    await expect(overlay).toBeVisible()

    // There is NO empty-box window: the three provider sections are part of the
    // very first paint, before any probe has resolved.
    await expect(overlay.locator(PROVIDER_SECTION)).toHaveCount(3, { timeout: 2000 })
    for (const provider of PROVIDERS) {
      await expect(overlay.locator('.fl-settings-heading', { hasText: provider })).toHaveCount(1)
    }
    // Every pill resolves to a real verdict — the pending state is transient,
    // never a dead end — and the controls come back live.
    await expect(overlay.locator('.fl-int-pill.pending')).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await expect(overlay.locator('.fl-int-save').first()).toBeEnabled()
    await window.screenshot({ path: 'e2e/ux/__screens/integrations-loading-state.png' })

    // LEAVING IT IS A TAB CLOSE now, not a dialog dismiss — and closing the
    // Settings tab is exactly the supersede this file is about: a probe still
    // in flight must not paint into a host that has left the document.
    await closeSettings(window)

    // The load affordance itself. It used to be read in the SAME TASK as the
    // open event — `open()` painted the pending skeleton before `#render`
    // reached its first await — which is no longer reachable: Integrations is a
    // settings GROUP now, so the open travels `flow:open-integrations` →
    // `flow:open-settings` → the page's own async render, and the group is
    // empty until that outer render lands.
    //
    // WHAT SURVIVES IS THE PROPERTY, not the instrument: the three provider
    // sections arrive TOGETHER, complete, with a pill each — never an empty box
    // the reader has to wait out, and never a section that appears without its
    // status affordance. Whether a given pill is still "Checking…" at the
    // instant this reads depends on how fast `gh` answers on the machine, which
    // is exactly what a test must not depend on.
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-integrations')))
    await expect(overlay.locator(PROVIDER_SECTION)).toHaveCount(3, { timeout: LOAD_TIMEOUT })
    const firstPaint = await overlay.evaluate((panel) => ({
      sections: panel.querySelectorAll('.fl-settings-section:has(.fl-settings-heading)').length,
      pills: panel.querySelectorAll('.fl-int-pill').length,
      // The connect action per provider. A connected provider also carries a
      // "Save list" button (its custom list query, 2026-09-07) of the same class.
      saves: [...panel.querySelectorAll('.fl-int-save')].filter((button) =>
        /^(Connect|Update token)$/.test((button.textContent ?? '').trim()),
      ).length,
    }))
    expect(firstPaint, JSON.stringify(firstPaint)).toEqual({ sections: 3, pills: 3, saves: 3 })

    // …and it still settles normally from that open.
    await expect(overlay.locator('.fl-int-pill.pending')).toHaveCount(0, { timeout: LOAD_TIMEOUT })
    await expect(overlay.locator(PROVIDER_SECTION)).toHaveCount(3)
  })
})
