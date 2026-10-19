/**
 * UX sweep — flow: editor (round 25). The MULTI-ROOT editor tab seam.
 *
 * Every prior flow-7 editor probe drives ONE project root. Multi-project
 * threads put two repos in one window: the files sidebar renders a section per
 * root and BOTH roots' files open into the same tab strip. Two seams only that
 * shape can reach, and neither had any e2e coverage:
 *
 *  1. Tab identity/labelling when two roots hold the SAME relative path
 *     (`src/index.ts` in alpha and in beta — the norm, not an edge case).
 *     disambiguateTabLabels (tab-labels.ts, #991) is fed `relPath` only, so the
 *     one segment that would tell the two apart — the root — is never seen; the
 *     only differentiators are the secondary root's accent dot + full-path
 *     tooltip, and refreshTabAccents (editor/index.ts:329) strips BOTH the
 *     moment the active thread stops carrying that root in its scope.
 *  2. The per-project restore round trip (snapshotTabs → saveOpenFiles → boot
 *     restore → setActiveProject), which stores the active tab as a bare
 *     `relPath` (index.ts:938) and re-joins it against the CONTEXT root
 *     (index.ts:877) — root-blind on both ends.
 *
 * Findings: #1481 (reload / project switch re-activates the other repo's
 * same-named file) and #1482 (the two tabs are indistinguishable). The green
 * test guards what IS correct — tab identity is the absolute path, so each
 * root's file is its own tab and Monaco follows the tab you click.
 */
import { test, expect, dismissOnboarding } from '../fixtures/electron'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Both seeded repos hold the SAME relative path with different content, so
 *  "which file am I looking at" is answerable from the editor alone. */
function populate(dir: string, marker: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), `export const WHO = "${marker}"\n`)
  writeFileSync(join(dir, `${marker.toLowerCase()}-only.ts`), `// ${marker} only\n`)
}

/** Create a thread through the real `threads:create` seam (the multi-project
 *  chooser's request — `additionalRoots` is exactly what it sends). */
async function createThread(
  win: Page,
  projectRoot: string,
  title: string,
  additionalRoots: string[] = [],
): Promise<string> {
  return win.evaluate(
    async ({ projectRoot, title, additionalRoots }) => {
      const created = await (
        window as unknown as {
          flow: {
            threads: {
              create(i: {
                projectRoot: string
                title: string
                additionalRoots?: string[]
              }): Promise<{ id: string }>
            }
          }
        }
      ).flow.threads.create({ projectRoot, title, additionalRoots })
      return created.id
    },
    { projectRoot, title, additionalRoots },
  )
}

/** Activate a thread the way the user does — click its sidebar row. */
async function openThread(win: Page, title: string): Promise<void> {
  await openThreadByTitle(win, title)
}

/** Open a project file through the app's real decoupled `flow:open-file` event
 *  (the same `openFile` a tree-row click calls — avoids the cold-launch
 *  tree-populate race, a seeding artifact rather than a product behavior). */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

const fileTabs = (win: Page) => win.locator('.fl-shell fl-tabs .tab')

/** The tab strip's `index.ts` file tabs — the label is the bare basename while
 *  it is unique and grows to `src/index.ts` once both roots' copies are open
 *  (#991 disambiguation), so match on the basename. The Blueprint/board view
 *  tab (labelled with the project name) never matches. */
const indexTabs = (win: Page) => win.locator('.fl-shell fl-tabs .tab', { hasText: 'index.ts' })

/** Every tab's visible label, tooltip, accent-dot presence and active state. */
async function tabReport(
  win: Page,
): Promise<{ label: string; title: string; dot: boolean; active: boolean }[]> {
  return fileTabs(win).evaluateAll((nodes) =>
    nodes.map((node) => {
      const el = node as HTMLElement
      const labelSpan = el.querySelector('span:not(.dirty-dot):not(.project-dot)')
      return {
        label: (labelSpan?.textContent ?? el.textContent ?? '').trim(),
        title: el.getAttribute('title') ?? '',
        dot: el.querySelector('.project-dot') !== null,
        active: el.classList.contains('active'),
      }
    }),
  )
}

async function monacoText(win: Page): Promise<string> {
  return (await win.locator('.monaco-editor .view-lines').first().innerText()).trim()
}

test.afterAll(() => cleanupSeeds())

test('multi-root thread: a file opened from each root is its own tab, and each tab shows ITS repo file', async ({
  window,
}) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const alpha = await seedProject(window, 'flow-mre-alpha-', (d) => populate(d, 'ALPHA'))
  const beta = await seedProject(window, 'flow-mre-beta-', (d) => populate(d, 'BETA'))
  await activateProject(window, alpha)
  await createThread(window, alpha, 'Multi-root editor', [beta])
  await openThread(window, 'Multi-root editor')

  await openFile(window, alpha, 'src/index.ts')
  await expect(indexTabs(window)).toHaveCount(1, { timeout: 15_000 })
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('ALPHA', {
    timeout: 15_000,
  })

  await openFile(window, beta, 'src/index.ts')
  // GUARD — tab identity is the ABSOLUTE path: beta's copy opens as a SECOND
  // tab rather than re-activating alpha's, and Monaco follows to beta's file.
  await expect(indexTabs(window)).toHaveCount(2, { timeout: 15_000 })
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('BETA', {
    timeout: 15_000,
  })
  console.log('TABS(both open):', JSON.stringify(await tabReport(window), null, 2))
  await window.screenshot({ path: `${SCREENS}/editor-multiroot-two-tabs.png` })

  // GUARD — clicking back to alpha's tab shows ALPHA's file again. Addressed by
  // its ABSOLUTE tooltip: this guard used to pick it out as "the one whose
  // tooltip is still the bare relative path", but that asymmetry was the #1482
  // bug — the relative tooltip depended on the thread scope, and read in the
  // current project it names a different file that also exists. Both tabs now
  // carry their absolute path, which is what actually identifies them.
  await fileTabs(window).and(window.locator(`[title="${alpha}/src/index.ts"]`)).first().click()
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('ALPHA', {
    timeout: 15_000,
  })

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

// TRIPWIRE (currently RED — #1481). The active tab is persisted
// as a bare relPath and restored as joinPath(contextRoot, relPath), so a
// secondary-root file that was active comes back as the PRIMARY root's
// same-named file: the reader silently continues in the other repo.
test(
  'multi-root thread: the ACTIVE tab must survive a renderer reload when it belongs to the secondary root',
  async ({ app, window }) => {
    test.setTimeout(240_000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const alpha = await seedProject(window, 'flow-mrr-alpha-', (d) => populate(d, 'ALPHA'))
    const beta = await seedProject(window, 'flow-mrr-beta-', (d) => populate(d, 'BETA'))
    await activateProject(window, alpha)
    await createThread(window, alpha, 'Multi-root reload', [beta])
    await openThread(window, 'Multi-root reload')

    await openFile(window, alpha, 'src/index.ts')
    await expect(indexTabs(window)).toHaveCount(1, { timeout: 15_000 })
    await openFile(window, beta, 'src/index.ts')
    await expect(indexTabs(window)).toHaveCount(2, { timeout: 15_000 })
    await expect(window.locator('.monaco-editor .view-lines')).toContainText('BETA', {
      timeout: 15_000,
    })
    await window.screenshot({ path: `${SCREENS}/editor-multiroot-before-reload.png` })

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.reload()
    })
    await window.waitForTimeout(500)
    await window.waitForLoadState('domcontentloaded')
    await dismissOnboarding(window)
    await dismissFlowOverlay(window)
    await expect(indexTabs(window)).toHaveCount(2, { timeout: 20_000 })
    await window.waitForTimeout(1500)
    console.log('TABS(after reload):', JSON.stringify(await tabReport(window), null, 2))
    console.log('MONACO(after reload):', await monacoText(window))
    await window.screenshot({ path: `${SCREENS}/editor-multiroot-after-reload.png` })

    // The reader was reading BETA's file; after the reload the editor must not
    // be showing the identically-named file from the OTHER repo.
    await expect(window.locator('.monaco-editor .view-lines')).toContainText('BETA', {
      timeout: 15_000,
    })

    const appErrs = appErrors(errors)
    expect(appErrs, appErrs.join(', ')).toHaveLength(0)
  },
)

// #1482, after per-conversation tab sets. The strip used to be per PROJECT, so
// switching to a thread that did not carry the second root left that root's
// tab open with nothing to tell it apart. Now each conversation keeps its own
// tabs: the single-root thread shows none of them, and switching back brings
// both back still distinguishable.
test(
  'multi-root thread: a foreign-repo tab must stay distinguishable after switching to a single-root thread',
  async ({ window }) => {
    test.setTimeout(240_000)
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const alpha = await seedProject(window, 'flow-mrs-alpha-', (d) => populate(d, 'ALPHA'))
    const beta = await seedProject(window, 'flow-mrs-beta-', (d) => populate(d, 'BETA'))
    await activateProject(window, alpha)
    await createThread(window, alpha, 'Scoped both', [beta])
    await createThread(window, alpha, 'Alpha only')
    await openThread(window, 'Scoped both')

    await openFile(window, alpha, 'src/index.ts')
    await expect(indexTabs(window)).toHaveCount(1, { timeout: 15_000 })
    await openFile(window, beta, 'src/index.ts')
    await expect(indexTabs(window)).toHaveCount(2, { timeout: 15_000 })

    // The single-root thread has its own (empty) tab set: neither repo's file
    // is left behind in it.
    await openThread(window, 'Alpha only')
    await expect(indexTabs(window)).toHaveCount(0, { timeout: 15_000 })

    await openThread(window, 'Scoped both')
    await expect(indexTabs(window)).toHaveCount(2, { timeout: 15_000 })
    await window.waitForTimeout(1500)
    const after = await tabReport(window)
    console.log('TABS(back on the multi-root thread):', JSON.stringify(after, null, 2))
    await window.screenshot({ path: `${SCREENS}/editor-multiroot-scope-drop.png` })

    // At least one channel — label, tooltip or accent dot — must still tell the
    // two repos' files apart.
    const idx = after.filter((t) => t.label.endsWith('index.ts'))
    expect(idx).toHaveLength(2)
    const channels = new Set(idx.map((t) => `${t.label}|${t.title}|${t.dot}`))
    expect(channels.size, `indistinguishable tabs: ${JSON.stringify(idx)}`).toBe(2)

    const appErrs = appErrors(errors)
    expect(appErrs, appErrs.join(', ')).toHaveLength(0)
  },
)
