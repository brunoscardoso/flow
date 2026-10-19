import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * UX regression probe — flow `editor` (open file / tabs / Monaco / conflict
 * resolve), round 22: the **application Edit menu fired at the code editor**.
 *
 * `src/main/menu.ts` mounts Electron's stock `{ role: 'editMenu' }` composite:
 * Undo / Redo / Cut / Copy / Paste / Select All. Every one of those roles
 * resolves to a Blink edit command on the focused frame — `webContents.undo()`,
 * `webContents.selectAll()`, … — whether Electron routes it through its JS role
 * table or (on macOS) through the responder chain. Monaco 0.55 takes keyboard
 * input through the **EditContext API**: its focused node is a
 * `<div class="native-edit-context">`, not a textarea. Blink's `Undo` and
 * `SelectAll` have no editable target there and quietly do nothing, while
 * `Cut`/`Copy`/`Paste` are clipboard events Monaco does listen for.
 *
 * Twenty-one prior flow-7 probes drive the tab layer, the disk layer, find &
 * replace, LSP or the conflict UI. Nobody had fired the Edit menu — the mouse
 * route to Undo/Select All, and the only route for a user who doesn't know the
 * shortcuts or drives the app by assistive technology.
 *
 * Result: **#1338** — Edit ▸ Undo, Redo and Select All are dead against the
 * editor, while their menu siblings Cut/Copy/Paste work in the very same
 * buffer and all six work on Flow's own plain inputs in the same window. So
 * Edit ▸ Cut can empty your file and Edit ▸ Undo cannot put it back.
 *
 * NOTE on driving: `MenuItem.click()` called from `app.evaluate` does NOT
 * execute a role (verified — it is inert even on a plain input), so these tests
 * issue the edit command the role executes, which is the faithful probe. The
 * shape test below keeps the menu items themselves honest.
 */

const SCREENS = 'e2e/ux/__screens'
const CONTROL = 'input[placeholder="Search threads"]'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Issue the Blink edit command an Edit-menu role executes. */
async function editCommand(
  app: ElectronApplication,
  method: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll',
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, name: string) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents as unknown as Record<
      string,
      () => void
    >
    contents[name]?.()
  }, method)
}

const clipboardText = (app: ElectronApplication): Promise<string> =>
  app.evaluate(({ clipboard }) => clipboard.readText())

const setClipboard = (app: ElectronApplication, text: string): Promise<void> =>
  app.evaluate(({ clipboard }, t: string) => clipboard.writeText(t), text)

/** Click a file-tree row by filename (self-heals against the late flow overlay). */
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

/** Seed a project, open `alpha.ts`, park the caret at the end of line 1. */
async function openProbeFile(win: Page): Promise<void> {
  const dir = await seedProject(win)
  writeFileSync(join(dir, 'alpha.ts'), 'const ORIGINAL = 1\n')
  await activateProject(win, dir)
  await openFromTree(win, 'alpha.ts')
  await expect(win.locator('.monaco-editor .view-lines')).toContainText('const ORIGINAL', {
    timeout: 15000,
  })
  await win.locator('.monaco-editor .view-lines').click()
  await win.keyboard.press('ControlOrMeta+ArrowUp')
  await win.keyboard.press('End')
}

/** The buffer as the user reads it (Monaco renders spaces as NBSP). */
async function bufferText(win: Page): Promise<string> {
  return (await win.locator('.monaco-editor .view-lines').innerText()).replace(/\u00a0/g, ' ')
}

/** Monaco paints one span per selected region; 0 means "nothing is selected". */
const selectionSpans = (win: Page) => win.locator('.monaco-editor .selected-text')

/** Value + selected substring of the plain-input control. */
const controlState = (win: Page) =>
  win.evaluate((s) => {
    const el = document.querySelector(s) as HTMLInputElement | null
    if (!el) return { value: 'NO-ELEMENT', selected: '' }
    return {
      value: el.value,
      selected: el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
    }
  }, CONTROL)

test.afterAll(() => cleanupSeeds())

test('the Edit menu ships every stock role, all advertised as enabled', async ({ app, window }) => {
  // Wait for the first window before reading main: evaluated during startup,
  // main's context can be replaced under the call ("Execution context was
  // destroyed") — the menu is built by then either way.
  await window.waitForLoadState('domcontentloaded')
  const items = await app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((i) => /^edit$/i.test(i.label))
    return (edit?.submenu?.items ?? [])
      .filter((i) => i.type !== 'separator')
      .map((i) => ({ label: i.label, enabled: i.enabled }))
  })
  const labels = items.map((i) => i.label)
  for (const wanted of ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All']) {
    expect(labels, `Edit menu is missing ${wanted}`).toContain(wanted)
  }
  // Nothing ever greys these out — which is what makes #1338 silent: an enabled
  // item that does nothing gives the user no signal at all.
  expect(items.filter((i) => i.enabled).map((i) => i.label)).toEqual(
    expect.arrayContaining(['Undo', 'Redo', 'Select All']),
  )
})

test('control: the same edit commands DO drive Flow’s own plain inputs', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // The thread search box is a plain <input> — the neutral control proving the
  // command channel reaches this renderer.
  const search = window.locator(CONTROL).first()
  await search.click()
  await window.keyboard.type('control-text')
  await expect(search).toHaveValue('control-text')

  await editCommand(app, 'selectAll')
  await expect.poll(async () => (await controlState(window)).selected).toBe('control-text')

  await setClipboard(app, 'SENTINEL')
  await editCommand(app, 'copy')
  await expect.poll(() => clipboardText(app)).toBe('control-text')

  await editCommand(app, 'cut')
  await expect(search).toHaveValue('', { timeout: 5000 })

  await editCommand(app, 'undo')
  await expect(search).toHaveValue('control-text', { timeout: 5000 })

  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})

test('in the editor, Cut / Copy / Paste from the menu reach the buffer', async ({
  window,
  app,
}) => {
  // These three are the reason #1338 is a bug and not a missing wire: the very
  // same menu can change the file, so the user has every reason to expect the
  // rest of it to work too.
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openProbeFile(window)
  await window.keyboard.press('Shift+Home')
  await expect(selectionSpans(window).first()).toBeVisible({ timeout: 5000 })

  await setClipboard(app, 'SENTINEL')
  await editCommand(app, 'copy')
  await expect.poll(() => clipboardText(app), { timeout: 8000 }).toContain('const ORIGINAL')

  await editCommand(app, 'cut')
  await expect.poll(() => bufferText(window), { timeout: 8000 }).not.toContain('const ORIGINAL')

  await setClipboard(app, 'PASTED-BY-MENU')
  await editCommand(app, 'paste')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('PASTED-BY-MENU', {
    timeout: 8000,
  })

  expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
})

test('in the editor, the keyboard shortcuts are healthy (⌘Z / ⌘A)', async ({ window }) => {
  // Monaco's own keybindings never go through the menu, and they work — the
  // asymmetry is the finding.
  await openProbeFile(window)
  await window.keyboard.type('-TYPED')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('-TYPED')

  await window.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => bufferText(window), { timeout: 5000 }).not.toContain('-TYPED')

  await window.keyboard.press('ControlOrMeta+a')
  await expect(selectionSpans(window).first()).toBeVisible({ timeout: 5000 })
})

// ── #1338 tripwires ────────────────────────────────────────────────────────
// They state what an enabled menu item owes the user, and fail against current
// main. Drop the `.fixme` when #1338 lands.

test.fixme('Edit ▸ Undo / Redo drive the editor buffer, like ⌘Z does', async ({ window, app }) => {
  await openProbeFile(window)
  await window.keyboard.type('-TYPED')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('-TYPED')

  await editCommand(app, 'undo')
  await expect.poll(() => bufferText(window), { timeout: 8000 }).not.toContain('-TYPED')

  await editCommand(app, 'redo')
  await expect.poll(() => bufferText(window), { timeout: 8000 }).toContain('-TYPED')
})

test.fixme('Edit ▸ Undo can reverse what Edit ▸ Paste just did', async ({ window, app }) => {
  // The sharp edge: the menu can WRITE to the file and cannot take it back.
  await openProbeFile(window)
  await setClipboard(app, 'PASTED-BY-MENU')
  await editCommand(app, 'paste')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('PASTED-BY-MENU', {
    timeout: 8000,
  })

  await editCommand(app, 'undo')
  await expect.poll(() => bufferText(window), { timeout: 8000 }).not.toContain('PASTED-BY-MENU')
})

test.fixme('Edit ▸ Select All selects the whole editor buffer', async ({ window, app }) => {
  await openProbeFile(window)
  await expect(selectionSpans(window)).toHaveCount(0)

  await editCommand(app, 'selectAll')
  await expect(selectionSpans(window).first()).toBeVisible({ timeout: 8000 })
})

test('evidence: one Undo command, two surfaces, two answers', async ({ window, app }) => {
  // The screenshot filed with #1338. Both surfaces are typed into, then the
  // single edit command Edit ▸ Undo issues is fired once: the search box obeys,
  // the editor keeps the text.
  await openProbeFile(window)
  await window.keyboard.type('-TYPED-IN-EDITOR')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('-TYPED-IN-EDITOR')

  await window.locator('[data-rail-item="threads"]').click().catch(() => undefined)
  const search = window.locator(CONTROL).first()
  await search.click()
  await window.keyboard.type('TYPED-IN-SEARCH')
  await expect(search).toHaveValue('TYPED-IN-SEARCH')

  // Blink groups typed characters into undo units at its own discretion, so a
  // long word can take more than one Undo to clear. Any number of them is fine
  // for the point being made: the control responds, the editor never does.
  for (let i = 0; i < 8 && (await search.inputValue()) !== ''; i++) {
    await editCommand(app, 'undo')
    await window.waitForTimeout(300)
  }
  await expect(search).toHaveValue('', { timeout: 5000 })
  expect(await bufferText(window)).toContain('-TYPED-IN-EDITOR')

  await window.screenshot({ path: `${SCREENS}/editor-edit-menu-undo-split.png` })
})
