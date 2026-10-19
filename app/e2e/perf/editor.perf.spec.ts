/**
 * The editor half: the palette, and opening files.
 *
 * ⌘P runs its source once per keystroke — the pattern that already needed a
 * cache here (allowed-pattern #20) — and opening a file is the most common
 * thing a person does in a repository. Both are timed against a real 4,182-file
 * project, cold and warm.
 */
import { test, expect } from '@playwright/test'

import {
  close,
  dismissOnboarding,
  ensurePerfRepo,
  freshUserData,
  launch,
  printTable,
  slowLines,
} from './launch'

test('the palette and the editor, on a real project', async () => {
  test.setTimeout(900_000)
  const repo = ensurePerfRepo()
  const userData = freshUserData('editor')
  const { app, window } = await launch(userData)
  await dismissOnboarding(window)

  const root = await window.evaluate(async (path) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.project.add({ path })
    const roots = (await flow.project.list()) as Array<{ rootPath: string }>
    const canonical = roots.at(-1)?.rootPath ?? path
    await flow.project.setActive({ rootPath: canonical })
    return canonical
  }, repo)
  await window.waitForTimeout(20_000)

  const marks: Record<string, number | string> = {}

  // THE PALETTE'S SOURCE — the call a keystroke re-runs.
  const listing = await window.evaluate(async (rootPath: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const cold = performance.now()
    const listed = (await flow.project.listAllFiles({ rootPath })) as { relPaths: string[] }
    const coldMs = performance.now() - cold
    // …and the same call eight times, as typing a filename would.
    const warm = performance.now()
    for (let i = 0; i < 8; i += 1) await flow.project.listAllFiles({ rootPath })
    return {
      coldMs,
      perKeystrokeMs: (performance.now() - warm) / 8,
      files: listed.relPaths.length,
      bytes: new TextEncoder().encode(JSON.stringify(listed)).length,
    }
  }, root)
  marks['palette source, cold'] = listing.coldMs
  marks['palette source, per keystroke'] = listing.perKeystrokeMs
  marks['files listed'] = listing.files
  marks['listing payload'] = `${(listing.bytes / 1024).toFixed(0)} KB`

  // THE PALETTE AS A PERSON DRIVES IT: open it, type eight characters, and
  // count what crossed IPC. The source runs per keystroke; the question is
  // whether the list is re-sent per keystroke with it.
  await window.evaluate(() => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const real = flow.project.listAllFiles.bind(flow.project)
    ;(window as unknown as { __listCalls: number }).__listCalls = 0
    flow.project.listAllFiles = async (request: unknown) => {
      ;(window as unknown as { __listCalls: number }).__listCalls += 1
      return real(request)
    }
  })
  // Opened through the app's own event, so the probe does not depend on which
  // accelerator this platform binds.
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-palette', { detail: { mode: 'files' } }))
  })
  const paletteInput = window.locator('input.fl-palette-input').first()
  await paletteInput.waitFor({ state: 'visible', timeout: 30_000 })
  await paletteInput.click()
  const typedAt = Date.now()
  for (const ch of 'launcher'.split('')) await window.keyboard.type(ch, { delay: 40 })
  await window.waitForTimeout(500)
  marks['typing 8 chars in the palette'] = Date.now() - typedAt
  marks['palette results'] = await window.locator('.fl-palette-list .row').count()
  marks['listAllFiles calls for those 8'] = await window.evaluate(
    () => (window as unknown as { __listCalls: number }).__listCalls,
  )
  await window.keyboard.press('Escape')

  // OPENING A FILE — through the same event the file tree and the palette use.
  const openMs = await window.evaluate(async (rootPath: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const listed = (await flow.project.listAllFiles({ rootPath })) as { relPaths: string[] }
    const pick = listed.relPaths.find(
      (path) => path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.js'),
    )
    if (pick === undefined) return -1
    const started = performance.now()
    document.dispatchEvent(
      new CustomEvent('flow:open-file', { detail: { rootPath, relPath: pick } }),
    )
    return performance.now() - started
  }, root)
  marks['open-file dispatch'] = openMs

  // …and what a person sees: an editor with text in it.
  const painted = Date.now()
  await window
    .locator('.monaco-editor')
    .first()
    .waitFor({ state: 'visible', timeout: 120_000 })
    .catch(() => undefined)
  marks['monaco on screen'] = Date.now() - painted

  await window.waitForTimeout(1_500)
  printTable('palette + editor', marks)
  for (const line of slowLines(userData).slice(-10)) console.log(`  ${line}`)

  await close(app)
  expect(listing.files).toBeGreaterThan(0)
})
