import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * ⌘W / Ctrl+W must close the FOCUSED terminal tab, not only editor tabs. The
 * app menu sends `editor:closeActiveTab`; the renderer's Close-Tab router is now
 * focus-aware (terminal focused → close its active tab). Regression for the bug
 * where ⌘W in a terminal did nothing.
 */

test.afterAll(() => cleanupSeeds())

test('⌘W closes the focused terminal, not just editor tabs', async ({ app, window }) => {
  const proj = await seedProject(window)
  await activateProject(window, proj)

  const termRoot = window.locator('.fl-term-root')
  await expect(termRoot).toBeVisible()
  // A shell auto-starts for the activated project (#957/#1024 switch-path
  // parity with reveal); open one only if none appeared yet.
  await expect(window.locator('.fl-term-tabs .tab')).toHaveCount(1, { timeout: 15_000 })
  const textarea = window.locator('.fl-term-host:not([hidden]) .xterm-helper-textarea')
  await expect(textarea).toBeVisible({ timeout: 15_000 })

  // Focus the terminal (as a user typing in it would).
  await textarea.focus()
  await expect(textarea).toBeFocused()

  // Simulate ⌘W: the app menu sends this IPC to the focused window.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('editor:closeActiveTab', null)
  })

  // The active terminal closed. It was the only one, so the panel gives its
  // slot back to the editor (#940) rather than showing an empty strip.
  await expect(window.locator('.fl-term-host:not([hidden]) .xterm')).toHaveCount(0, { timeout: 5_000 })
  await expect(termRoot).toHaveCount(0)
})
