import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 7: Editor, LSP language features (diagnostics / hover /
 * definition / completion).
 *
 * Flow's authoritative language intelligence lives in the MAIN process
 * (`typescript-language-server` → tsserver, marker owner `flow-lsp`), bridged into
 * Monaco by `renderer/editor/lsp-bindings.ts` over the contract's `editor:*`
 * channels. Monaco also ships its OWN in-browser TypeScript worker, which runs
 * with no filesystem access — it cannot read the project's `tsconfig` or
 * `node_modules`, so every answer it gives about an imported symbol is a guess.
 * #37 established that verdict ("pure noise") and `deferDiagnosticsToLsp`
 * (`monaco-host.ts`) switched its DIAGNOSTICS off. Its hover / definition /
 * completion providers stayed registered — which is #1022.
 *
 * The editor is the most-covered UX flow (tabs, dirty/save, close-ops, overflow,
 * conflict merge #618, markdown preview #575, external reload #353/#357,
 * project-switch buffers #955, same-basename identity #991) but the LSP seam had
 * ZERO end-to-end coverage — nobody had ever pressed F12 in this editor.
 *
 * Live guards here:
 *  1. the LSP pipeline actually works end-to-end (spawn → didOpen → diagnostics →
 *     markers, and didChange keeps them live) — this is #37's fix, guarded;
 *  2. the LSP answers each question EXACTLY ONCE — which is what makes the UI's
 *     "Definitions (2)" a second provider's fault rather than the LSP's.
 *
 * The last two tests are the #1022 regression guards: with the built-in worker
 * switched out of every semantic feature (`setModeConfiguration`, monaco-host.ts)
 * the LSP is the only provider, so F12 navigates and hover/suggest answer once.
 */

const SCREENS = 'e2e/ux/__screens'

/**
 * Monaco raises a benign internal `CancellationError` ("Canceled") on ordinary
 * model dispose. It escapes to `pageerror` but nothing surfaces to the user —
 * filter it so the guards flag only real errors. (Same rationale as editor.spec.ts.)
 */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Open a project file through the app's real `flow:open-file` channel — the
 *  exact `openFile(rootPath, relPath)` a Files-tree row click ends up calling. */
async function openInEditor(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/**
 * A minimal but REAL TypeScript project: `package.json` + `tsconfig.json` are
 * tsserver root markers (see tsserver-adapter.ts), so the language server spawns
 * for this root. `user.ts` imports across a file boundary — the case Monaco's
 * built-in worker cannot resolve — and carries one deliberate type error.
 *
 * Written via seedProject's `prepare` hook so the files exist BEFORE the root is
 * added (the temp-dir chokidar watcher is unreliable on macOS).
 */
function prepareTsProject(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'flow-lsp-probe', version: '1.0.0' }, null, 2),
  )
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2020',
          module: 'ESNext',
          moduleResolution: 'Bundler',
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(dir, 'lib.ts'),
    [
      'export const HELPER_MARK = "helper-mark"',
      '',
      'export function helperFunction(): number {',
      '  return 7',
      '}',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'user.ts'),
    [
      'import { helperFunction } from "./lib"',
      '',
      'export const value = helperFunction()',
      'export const bad: string = 42',
      '',
    ].join('\n'),
  )
}

/** 0-based line index of `helperFunction`'s use, and the column inside the word. */
const USE_LINE = 2
const USE_COLUMN = 25

/**
 * Pixel point at a (0-based) line index + character column. `.view-line` elements
 * are positioned by `style.top`, NOT DOM order, so they must be sorted; the font
 * is monospace, so a char width derived from the rendered line is exact enough to
 * land inside a word.
 */
async function pointAt(win: Page, lineIndex: number, column: number) {
  return win.evaluate(
    ({ lineIndex, column }) => {
      const lines = (
        Array.from(document.querySelectorAll('.monaco-editor .view-line')) as HTMLElement[]
      ).sort((a, b) => parseInt(a.style.top) - parseInt(b.style.top))
      const line = lines[lineIndex]
      if (!line) return null
      const rect = line.getBoundingClientRect()
      const text = line.textContent ?? ''
      const span = line.querySelector('span') as HTMLElement | null
      const width = span ? span.getBoundingClientRect().width : rect.width
      const charWidth = text.length ? width / text.length : 8
      return { x: rect.x + charWidth * (column + 0.5), y: rect.y + rect.height / 2 }
    },
    { lineIndex, column },
  )
}

/** Poll until the editor shows (or stops showing) an error squiggle. */
async function waitForSquiggles(win: Page, want: 'some' | 'none', timeoutMs = 45000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const n = await win.locator('.monaco-editor .squiggly-error').count()
    if ((want === 'some' && n > 0) || (want === 'none' && n === 0)) return true
    await win.waitForTimeout(400)
  }
  return false
}

/** Seed + activate a TS project and open `user.ts`, settled and LSP-warm. */
async function openProbeProject(win: Page, prefix: string): Promise<string> {
  const dir = await seedProject(win, prefix, prepareTsProject)
  await activateProject(win, dir)
  await openInEditor(win, dir, 'user.ts')
  await expect(win.locator('.monaco-editor .view-lines')).toContainText('helperFunction', {
    timeout: 15000,
  })
  // A published diagnostic is the readiness proxy: it proves the server spawned
  // for this root, received didOpen, and answered.
  expect(await waitForSquiggles(win, 'some')).toBe(true)
  return dir
}

test.afterAll(() => cleanupSeeds())

test('LSP diagnostics are live: a real type error squiggles, clears on fix, returns on a new one (#37)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await openProbeProject(window, 'flow-ux-lsp-diag-')

  // The squiggle is on `export const bad: string = 42` (line 4) — from the
  // main-process LSP, since Monaco's own worker has diagnostics disabled (#37).
  expect(await window.locator('.monaco-editor .squiggly-error').count()).toBeGreaterThan(0)

  // Fix it in the buffer — didChange (300ms debounce) must re-publish and clear.
  const caret = await pointAt(window, 3, 4)
  expect(caret).not.toBeNull()
  await window.mouse.click(caret!.x, caret!.y)
  await window.keyboard.press('End')
  await window.keyboard.press('Backspace')
  await window.keyboard.press('Backspace')
  await window.keyboard.type('"ok"')
  expect(await waitForSquiggles(window, 'none')).toBe(true)

  // ...and a NEWLY typed error must come back (the buffer, not the disk, is the
  // source of truth for diagnostics).
  await window.keyboard.type('\nconst another: number = "nope"')
  expect(await waitForSquiggles(window, 'some')).toBe(true)

  expect(appErrors(errors)).toEqual([])
})

test('the main-process LSP answers each question exactly once (anchors #1022)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await openProbeProject(window, 'flow-ux-lsp-once-')

  const answers = await window.evaluate(
    async ({ rootId, line, character }) => {
      const api = (window as unknown as { flow: { editor: Record<string, Function> } }).flow.editor
      const at = { rootId, filePath: 'user.ts', position: { line, character } }
      const definition = (await api['definition']!(at)) as Array<{ filePath: string }>
      const hover = (await api['hover']!(at)) as { contents: string } | null
      return { definition, hover }
    },
    { rootId: dir, line: USE_LINE, character: USE_COLUMN },
  )

  // ONE definition, and it points at the other file — never at `user.ts` itself.
  expect(answers.definition).toHaveLength(1)
  expect(answers.definition[0]!.filePath).toBe('lib.ts')

  // ONE hover, carrying the resolved signature (proof the LSP really resolved the
  // module — a provider without filesystem access cannot produce this).
  expect(answers.hover?.contents ?? '').toContain('helperFunction(): number')

  expect(appErrors(errors)).toEqual([])
})

test(
  'F12 on an imported symbol jumps to its definition instead of opening a multi-result peek (#1022)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await openProbeProject(window, 'flow-ux-lsp-def-')

    const point = await pointAt(window, USE_LINE, USE_COLUMN)
    expect(point).not.toBeNull()
    await window.mouse.click(point!.x, point!.y)
    await window.keyboard.press('F12')
    await window.waitForTimeout(4000)

    await window.screenshot({ path: `${SCREENS}/lsp-goto-definition.png` })

    // The user asked to go to ONE definition. The LSP returned exactly one
    // (guarded above), so no disambiguation peek should ever appear...
    const peekTitle = await window.evaluate(
      () => (document.querySelector('.peekview-title') as HTMLElement | null)?.innerText ?? '',
    )
    expect(peekTitle, 'a "Definitions (N)" peek was opened instead of navigating').not.toMatch(
      /Definitions \(\d+\)/,
    )

    // ...and the editor should now be showing lib.ts.
    await expect(window.locator('.fl-shell fl-tabs:not(.fl-term-tabs) .tab.active')).toContainText('lib.ts')

    expect(appErrors(errors)).toEqual([])
    expect(dir).toBeTruthy()
  },
)

test(
  'hover and autocomplete describe a symbol once, not twice (#1022)',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await openProbeProject(window, 'flow-ux-lsp-dup-')

    // ── HOVER ────────────────────────────────────────────────────────────────
    const point = await pointAt(window, USE_LINE, USE_COLUMN)
    expect(point).not.toBeNull()
    await window.mouse.move(point!.x, point!.y)
    await window.waitForTimeout(2500)
    const hoverRows = await window.evaluate(() =>
      Array.from(document.querySelectorAll('.monaco-hover'))
        .filter((h) => (h as HTMLElement).offsetParent !== null)
        .flatMap((h) => Array.from(h.querySelectorAll('.hover-row')).map((r) => (r as HTMLElement).innerText)),
    )
    await window.screenshot({ path: `${SCREENS}/lsp-hover-rows.png` })
    expect(hoverRows.length, `hover showed ${hoverRows.length} rows: ${JSON.stringify(hoverRows)}`).toBe(1)
    await window.mouse.move(2, 2)
    await window.waitForTimeout(400)

    // ── AUTOCOMPLETE ─────────────────────────────────────────────────────────
    const caret = await pointAt(window, 3, 4)
    expect(caret).not.toBeNull()
    await window.mouse.click(caret!.x, caret!.y)
    await window.keyboard.press('End')
    await window.keyboard.type('\nconst z = helperFun')
    await window.waitForTimeout(3000)
    const suggestions = await window.evaluate(() =>
      Array.from(document.querySelectorAll('.suggest-widget .monaco-list-row')).map((r) =>
        (r as HTMLElement).innerText.replace(/\n+/g, ' | '),
      ),
    )
    await window.screenshot({ path: `${SCREENS}/lsp-suggest-rows.png` })
    const helperRows = suggestions.filter((s) => s.includes('helperFunction'))
    expect(
      helperRows.length,
      `suggest listed helperFunction ${helperRows.length}×: ${JSON.stringify(suggestions)}`,
    ).toBe(1)

    expect(appErrors(errors)).toEqual([])
  },
)
