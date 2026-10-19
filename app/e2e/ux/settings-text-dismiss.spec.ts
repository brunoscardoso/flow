import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 14. No new bug found this cycle; this is a stabilization guard for a
 * real-user path the existing settings specs do NOT cover.
 *
 * The flow-settings overlay is LIVE-EDITED — "every control change is written
 * immediately (no Save button)". The existing persist test
 * (settings-forms.spec) explicitly `.blur()`s its text field before closing, so
 * it never proves what happens when a real user types and then dismisses the
 * panel STRAIGHT from the focused input (no blur) — via Escape, the backdrop,
 * or the ✕ button. Because there is no Save button, a live-edit silently lost
 * on dismiss would be a genuine data-loss bug.
 *
 * Driven GREEN on current main: all three dismiss gestures persist the typed
 * value (hiding the overlay blurs the focused input → its change event fires →
 * setConfig persists), zero pageerrors. This guard locks that in.
 *
 * THE FIELD CHANGED, THE EXERCISE DID NOT. This drove 'Base branch' until the
 * worktree-management surfaces were removed and that row went with them. The
 * test was never about the base branch — it is about a live-edited text field
 * in this panel — so it now drives the text field left in the same Conversation files
 * section, and everything below reads exactly as it did.
 */

const FLOW_OVERLAY = '.fl-settings-overlay:not([hidden])'

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

async function reopenFlowSettings(win: Page, root: string): Promise<void> {
  await win.evaluate(
    (r) =>
      document.dispatchEvent(
        new CustomEvent('flow:open-flow-settings', { detail: { rootPath: r } }),
      ),
    root,
  )
  await expect(win.locator(FLOW_OVERLAY)).toHaveCount(1)
}

/** The Conversation files text field this exercise types into. */
const TEXT_FIELD = 'Prepare a new conversation'

function textInput(overlay: ReturnType<Page['locator']>) {
  return overlay.locator('.fl-fs-row', { hasText: TEXT_FIELD }).locator('input[type="text"]')
}

test.afterEach(() => cleanupSeeds())

test.describe('flow-settings overlay — live text edit persists on dismiss (no blur)', () => {
  for (const gesture of ['escape', 'backdrop', 'close-button'] as const) {
    test(`a text field typed then dismissed via ${gesture} (no explicit blur) persists`, async ({
      window,
    }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

      const root = await seedAndActivate(window)
      const overlay = window.locator(FLOW_OVERLAY)

      // This field is the project's own from the first frame, so there is
      // nothing to take over before typing into it.
      const field = textInput(overlay)
      await expect(field).toBeEnabled()
      await field.click()
      const typed = `release-${gesture}`
      // Replace, never append, so a field that already held something cannot
      // make the assertion below pass on a concatenation. Select-all does not
      // blur, so the gesture under test (type, then dismiss with no blur) is
      // still the one being driven.
      await field.press('ControlOrMeta+a')
      await field.pressSequentially(typed)
      // Deliberately NO blur — dismiss straight from the focused input, the way a
      // real user does when they type a value and immediately close the panel.

      if (gesture === 'escape') {
        await window.keyboard.press('Escape')
      } else if (gesture === 'backdrop') {
        await overlay.click({ position: { x: 4, y: 4 } }) // backdrop mousedown → close
      } else {
        await overlay.locator('.fl-settings-close').click()
      }
      await expect(overlay).toHaveCount(0)

      // The live-edit must survive the dismiss (no Save button ⇒ no silent loss).
      await reopenFlowSettings(window, root)
      await expect(textInput(window.locator(FLOW_OVERLAY))).toHaveValue(typed)

      expect(errors, `uncaught errors: ${errors.join(' | ')}`).toEqual([])
    })
  }
})
