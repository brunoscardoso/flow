import type { Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'

/**
 * Flow 12 — panel toggles & keyboard shortcuts. Drives the VS-Code-parity
 * keybindings wired in `shell.ts` (sidebar ⌘B, terminal ⌃`, bottom-panel ⌘J,
 * new-terminal ⌘⇧`) plus the editor tab-cycle (Ctrl+Tab / Ctrl+Shift+Tab wired
 * in `editor/index.ts`) and the Files/Git/Review side-panel tab switcher, and
 * asserts the observable panel state while watching for uncaught renderer errors.
 *
 * Note: the "new terminal" shortcut (⌘⇧`) had a double-open bug from the
 * hidden-panel state (issue #372, fixed). The hidden→reveal single-terminal
 * invariant it violated is guarded by "⌃` reveal opens exactly one terminal";
 * the inverse — that ⌘⇧` from a *visible* panel still opens a second terminal
 * (the fix must not over-suppress) — is guarded by its own test below.
 */
const t = test
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Count of terminal tabs rendered in the panel's (shadow-DOM) tab strip. */
async function terminalTabCount(win: Page): Promise<number> {
  return win.evaluate(() => {
    const tabsEl = document.querySelector('.fl-term-tabs')
    return tabsEl?.shadowRoot?.querySelectorAll('button.tab').length ?? -1
  })
}

/** Open a seeded file the user way — clicking its row in the visible Files tree.
 *  Post-#674 the default rail is Threads (switch to Files unless already active —
 *  clicking the active rail item collapses the sidebar); retries through the
 *  per-project flow-settings overlay that can cover the tree on cold launches. */
async function openFromTree(win: Page, name: string): Promise<void> {
  const row = win.locator('.fl-sidebar-pane:visible').getByText(name, { exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const overlay = win.locator('.fl-settings-overlay:not([hidden])')
    if (await overlay.count()) {
      await win.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
    }
    const files = win.locator('[data-rail-item="files"]')
    const cls = (await files.getAttribute('class')) ?? ''
    if (!/\bactive\b/.test(cls)) await files.click().catch(() => undefined)
    await pickFilesProject(win)
    try {
      await row.waitFor({ state: 'visible', timeout: 8000 })
      await row.click({ timeout: 4000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

/** Post-activity-bar (#674/#675) the terminal is docked in the editor stack and
 *  DEFAULTS visible (shell.ts: `terminalVisible = state.terminalVisible !== false`).
 *  Toggle tests want a known HIDDEN baseline — collapse it first if it's showing. */
async function ensureTerminalHidden(win: Page): Promise<void> {
  if (await win.locator(sel.terminalRoot).isVisible()) {
    await win.keyboard.press('Control+`')
    await expect(win.locator(sel.terminalRoot)).toBeHidden()
  }
}

/** The editor tab strip button whose visible label matches `name`. */
function editorTab(win: Page, name: string) {
  return win.locator('.fl-shell fl-tabs .tab', { hasText: name })
}

/** Wait until Monaco shows a line containing `text` (content actually rendered). */
async function expectEditorShows(win: Page, text: string): Promise<void> {
  await expect(win.locator('.monaco-editor .view-lines')).toContainText(text, { timeout: 15000 })
}

/** Label text of the currently-active editor tab. Scoped to the EDITOR strip —
 *  the terminal's own fl-tabs (.fl-term-tabs) also carries an active tab as
 *  soon as its auto-started shell exists, and the unscoped selector is a
 *  strict-mode violation with two matches. */
async function activeEditorTab(win: Page): Promise<string | null> {
  return win.locator('.fl-shell fl-tabs:not(.fl-term-tabs) .tab.active').textContent()
}

t.describe('panel toggles & keyboard shortcuts', () => {
  t.afterAll(() => cleanupSeeds())

  t('⌘/Ctrl+B toggles the threads sidebar', async ({ window }) => {
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
  })

  t('⌘/Ctrl+J toggles the terminal (bottom) panel', async ({ window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await ensureTerminalHidden(window)
    await window.keyboard.press(`${mod}+j`)
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await window.keyboard.press(`${mod}+j`)
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
  })

  t('⌃` reveal opens exactly one terminal', async ({ window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await ensureTerminalHidden(window)

    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    // Let the auto-open shell spawn + render its tab.
    await expect(async () => {
      expect(await terminalTabCount(window)).toBe(1)
    }).toPass({ timeout: 8000 })
  })

  t('side panel switches Files ↔ Source Control with one active tab, toggling views (#335)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    // Post-#674 the side panel switches via the activity-bar rail (data-rail-item),
    // not the removed .fl-sidetabs-tab strip. Exactly one switch-item is active.
    for (const item of ['source-control', 'files']) {
      const rail = window.locator(`[data-rail-item="${item}"]`)
      await rail.click()
      await expect(rail).toHaveClass(/active/)
      await expect(window.locator('.fl-activity-bar .fl-rail-item.active')).toHaveCount(1)
    }
    // Source Control view-mode toggle: Changes ↔ Phases, one active at a time.
    await window.locator('[data-rail-item="source-control"]').click()
    for (const mode of ['Phases', 'Changes']) {
      const view = window.locator(sel.scViewBtn).filter({ hasText: mode })
      await view.click()
      await expect(view).toHaveClass(/active/)
      await expect(window.locator(sel.scViewActive)).toHaveCount(1)
    }
    expect(errors).toEqual([])
  })

  // Regression guard for #454: sidebar-hidden / terminal-open / side-panel prefs
  // must persist across a restart (a reload re-executes the renderer against the
  // same localStorage partition — a proxy for quit+relaunch).
  //
  // hydrate() correctly re-applies all of these on project re-activation; the gap
  // was that the 200ms DEBOUNCED save could be dropped when the reload fired inside
  // its window, so the just-hidden sidebar was never persisted and re-showed. Fixed
  // by flushing the pending save on `pagehide` (shell.ts flushSave). The post-reload
  // asserts auto-retry, covering the async activeProject→hydrate restore.
  t('panel visibility + side-panel prefs persist across a restart (#454)', async ({ window }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await ensureTerminalHidden(window) // known baseline (terminal defaults visible)

    // Switch the side panel to Source Control FIRST — post-#674 the panel switches
    // via the activity-bar rail, and clicking a rail item re-opens a hidden sidebar,
    // so the rail switch must precede the ⌘B hide (order the old side-tabs didn't need).
    const scRail = window.locator('[data-rail-item="source-control"]')
    await scRail.click()
    await expect(scRail).toHaveClass(/active/)
    await window.keyboard.press(`${mod}+b`) // hide sidebar
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await window.keyboard.press('Control+`') // open terminal
    await expect(window.locator(sel.terminalRoot)).toBeVisible()

    // Restart proxy: reload the renderer against the same userData partition.
    await window.reload()
    await window.waitForLoadState('domcontentloaded')
    await window.locator(sel.shell).waitFor({ state: 'visible', timeout: 10000 })

    // A user expects the layout they left it in — all three restored. The rail
    // is the sidebar's first line now, so it leaves with the sidebar: the
    // remembered item is checked by bringing the sidebar back.
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    // No account is connected in a spec profile, so the first-run wizard comes
    // back with the reload — a modal that (rightly) owns the keyboard and the
    // pointer. Put it away the way the fixture does at launch.
    await dismissOnboarding(window)
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator('.fl-activity-sidebar')).toBeVisible()
    await expect(window.locator('[data-rail-item="source-control"]')).toHaveClass(/active/)
  })

  t('the titlebar sidebar toggle reflects keyboard-driven sidebar state', async ({ window }) => {
    // The titlebar sidebar icon must track the sidebar's visibility even when it
    // changes via the keyboard (⌘B), not just its own click. (Post-#674 the former
    // status-bar Terminal button is a rail ACTION with no active state — the
    // terminal's visibility toggle itself is covered by the ⌘J test above.)
    const sideBtn = window.locator(sel.sidebarToggle)
    const isActive = (loc: typeof sideBtn) => loc.evaluate((el) => el.classList.contains('active'))

    // Sidebar starts visible → button active; ⌘B hides it → button inactive.
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    expect(await isActive(sideBtn)).toBe(true)
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    expect(await isActive(sideBtn)).toBe(false)
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    expect(await isActive(sideBtn)).toBe(true)
  })

  t('Ctrl+Tab cycles editor tabs forward and Ctrl+Shift+Tab backward (with wrap)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const dir = await seedProject(window)
    writeFileSync(join(dir, 'alpha.ts'), 'export const ALPHA = "alpha-marker"\n')
    writeFileSync(join(dir, 'beta.md'), '# Beta\n\nbeta-marker line\n')
    writeFileSync(join(dir, 'gamma.txt'), 'gamma-marker\n')
    await activateProject(window, dir)

    // Open three files in order (alpha, beta, gamma); gamma ends active.
    await openFromTree(window, 'alpha.ts')
    await expectEditorShows(window, 'alpha-marker')
    await openFromTree(window, 'beta.md')
    await expectEditorShows(window, 'beta-marker')
    await openFromTree(window, 'gamma.txt')
    await expectEditorShows(window, 'gamma-marker')
    await expect(editorTab(window, 'gamma.txt')).toHaveClass(/active/)

    // Forward from the last tab wraps to the first.
    await window.keyboard.press('Control+Tab')
    await expect(editorTab(window, 'alpha.ts')).toHaveClass(/active/)
    expect(await activeEditorTab(window)).toContain('alpha.ts')
    await window.keyboard.press('Control+Tab')
    await expect(editorTab(window, 'beta.md')).toHaveClass(/active/)

    // Backward returns to the previous tab.
    await window.keyboard.press('Control+Shift+Tab')
    await expect(editorTab(window, 'alpha.ts')).toHaveClass(/active/)

    // Only Monaco's benign internal CancellationError ("Canceled") may appear on
    // rapid model switch — it is not user-facing. Any other pageerror is a bug.
    const realErrors = errors.filter((e) => !/Canceled/.test(e))
    expect(realErrors, realErrors.join(', ')).toEqual([])
  })

  t('terminal hide then re-reveal reuses the same terminal (no dup, no blank)', async ({
    window,
  }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await ensureTerminalHidden(window)

    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await expect(async () => {
      expect(await terminalTabCount(window)).toBe(1)
    }).toPass({ timeout: 8000 })

    // Hide (⌃`) detaches the panel but must NOT dispose the terminal…
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeHidden()

    // …so re-revealing shows the SAME single terminal, not a fresh one or none.
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await expect(async () => {
      expect(await terminalTabCount(window)).toBe(1)
    }).toPass({ timeout: 8000 })
  })

  t('"New terminal" from a visible panel opens a SECOND terminal, not a toggle', async ({
    window,
  }) => {
    const root = await seedProject(window)
    await activateProject(window, root)
    await ensureTerminalHidden(window)

    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await expect(async () => {
      expect(await terminalTabCount(window)).toBe(1)
    }).toPass({ timeout: 8000 })

    // The #674 activity-bar redesign dropped the ⌘⇧` keybinding — "New terminal"
    // is now the palette/rail entry point (flow:show-terminal). With the panel
    // already visible, it must ADD a second terminal (showTerminal → the reveal
    // is already satisfied, so it dispatches flow:terminal-new), never dismiss the
    // panel — the invariant the old ⌘⇧` test guarded, via the current mechanism.
    await window.evaluate(() => document.dispatchEvent(new CustomEvent('flow:show-terminal')))
    await expect(async () => {
      expect(await terminalTabCount(window)).toBe(2)
    }).toPass({ timeout: 8000 })
  })
})
