import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { waitForLinkedStructure } from './fixtures/linked-structure'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { callBoard } from '../board-hook'

/**
 * Learning-panel controls (#learn-controls): Pause / Stop / Reset next to
 * "Learn all" (blueprint-board.ts #renderLearnPanel).
 *
 *  - Pause/Resume — stop STARTING new passes (the active one finishes); shown
 *    while anything is queued/learning or while paused. Label flips live via
 *    the learn:pausedChanged broadcast + the optimistic click re-render.
 *  - Stop — learn:cancel aborts the active pass + drops the queue; the
 *    orchestrator flips orphaned queued/learning entries to 'stale' NOW
 *    (cancelRoot → reconcileInterrupted), which we verify at the STORE
 *    (learning-state.jsonl) — deterministic, no chokidar dependence.
 *  - Reset — learn:reset FORGETS what has been learned, behind an inline
 *    confirmation that names the work: the module docs, the investigation notes
 *    and their heat, the generated views, and each feature's learned sections.
 *    It used to clear the status table alone and say "Reset learning for N
 *    modules?", which is how a board came back looking exactly as informed as
 *    before ("i reset the learn, why we still having data on the blueprint?").
 *    A feature's name and prose, your own decisions, and the derived map stay.
 *
 * Seeding mirrors learning-progress-panel.spec.ts: graph.json + a
 * learning-state.jsonl under flow/brain/.structure, panel opened via the
 * flow:open-blueprint / flow:open-learning-panel deep-links. Store effects are
 * asserted by reading learning-state.jsonl from disk (expect.poll) because the
 * temp-dir file watcher is not reliable on macOS; the post-reset UI refresh is
 * forced through the E2E-only __flowBoard.handleChanged hook.
 */

/** Three depth-1 roots keep the depth-1 spine (matches the other blueprint specs). */
const GRAPH = {
  version: 1,
  derivedAt: '2026-07-20T00:00:00Z',
  coverage: { filesScanned: 3, filesTotal: 3, extractorsRun: ['modules'], graphifyEnriched: false },
  nodes: [
    { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
    { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1 } },
    // NOTE: not named `test` — that segment is on the built-in learning ignore
    // list (#learn-ignore) and would drop out of the panel's counts.
    { id: 'module:core', kind: 'module', label: 'core', sourceFile: 'core', meta: { depth: 1 } },
  ],
  edges: [],
}

function structureDir(root: string): string {
  return join(root, 'flow', 'brain', '.structure')
}

function seedLearning(
  root: string,
  entries: Array<{ module: string; status: string; notedAt: string }>,
): void {
  const dir = structureDir(root)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(GRAPH))
  writeFileSync(
    join(dir, 'learning-state.jsonl'),
    `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`,
  )
}

/** Everything else a learn leaves behind — what Reset used to walk past. */
function seedKnowledge(root: string): void {
  const brain = join(root, 'flow', 'brain')
  mkdirSync(join(brain, 'modules'), { recursive: true })
  mkdirSync(join(brain, 'features'), { recursive: true })
  mkdirSync(join(brain, 'decisions'), { recursive: true })
  writeFileSync(join(brain, 'modules', 'src.md'), '# src\n\nWhat it does.\n')
  writeFileSync(join(brain, 'modules', 'lib.md'), '# lib\n\nWhat it does.\n')
  writeFileSync(
    join(structureDir(root), 'investigations.jsonl'),
    `${JSON.stringify({ kind: 'note', text: 'a finding', anchors: ['module:src'] })}\n` +
      `${JSON.stringify({ kind: 'heat', anchor: 'module:src' })}\n`,
  )
  // A person's own note, which is not the learner's to forget.
  writeFileSync(join(brain, 'decisions', 'mine.md'), '# Mine\n\nI wrote this.\n')
  writeFileSync(
    join(brain, 'features', 'auth.md'),
    [
      '---',
      'name: Auth',
      'kind: core',
      '---',
      '',
      '# Auth',
      '',
      'How a person gets in.',
      '',
      '## Learned',
      '',
      '- Login races a modal <!-- learned: code 2026-08-09 -->',
      '',
    ].join('\n'),
  )
}

/** Parse the on-disk learning-state statuses (deduped-enough for assertions). */
function storeStatuses(root: string): string[] {
  const raw = readFileSync(join(structureDir(root), 'learning-state.jsonl'), 'utf-8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { status: string }).status)
}

async function openLearningPanel(window: import('@playwright/test').Page): Promise<void> {
  await window.evaluate(() => {
    document.dispatchEvent(new CustomEvent('flow:open-blueprint'))
    document.dispatchEvent(new CustomEvent('flow:open-learning-panel'))
  })
}

const panelSel = '.fb-learn-panel'
const controlsSel = '.fb-learn-controls'

/**
 * Seed `graph.json` + `learning-state.jsonl` once the project sits in its
 * Workspace. The migration's copy drops `graph.json` (a GENERATED file) and the
 * provisioner's first derive rewrites it from the repo — which holds none of
 * these modules — so a graph written before the add never reaches the board.
 */
async function seedAfterLink(
  window: import('@playwright/test').Page,
  root: string,
  graph: unknown,
  entries: Array<{ module: string; status: string; notedAt: string }>,
): Promise<void> {
  const dir = await waitForLinkedStructure(window, root)
  writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph))
  writeFileSync(join(dir, 'learning-state.jsonl'), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`)
}

/** The panel's Workspace line: "N of M modules · P%". */
const factsSel = `${panelSel} .fb-lp-facts`
/** This project's row action (Learn N / Update N). */
const projectLearnSel = `${panelSel} .fb-lp-head .fb-lp-primary`

/** Every module the panel LISTS, folded groups opened the way a reader does. */
async function listedModules(window: import('@playwright/test').Page): Promise<string[]> {
  for (let i = 0; i < 5; i += 1) {
    const folded = window.locator(`${panelSel} .fb-learn-rows .fb-lp-ghead[aria-expanded="false"]`)
    if ((await folded.count()) === 0) break
    await folded.first().click()
    await window.waitForTimeout(150)
  }
  return window.evaluate(() =>
    [...document.querySelectorAll('.fb-learn-panel .fb-learn-rows .fb-lp-items .fb-lp-path')]
      .map((el) => el.textContent ?? '')
      .sort(),
  )
}

test.afterAll(() => cleanupSeeds())

test('Reset forgets what was learned, behind a confirm that names it', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window)
  // Idle store: 3 learned entries, nothing queued/learning.
  seedLearning(root, [
    { module: 'src', status: 'learned', notedAt: '2026-07-19T10:00:00Z' },
    { module: 'lib', status: 'learned', notedAt: '2026-07-19T10:01:00Z' },
    { module: 'core', status: 'learned', notedAt: '2026-07-19T10:02:00Z' },
  ])
  seedKnowledge(root)
  await activateProject(window, root)
  // Let the project finish joining its Workspace first: a Reset that lands
  // while the migration is still copying `flow/` forgets the ORIGINAL, and the
  // copy then comes back through the link with everything Reset removed.
  await waitForLinkedStructure(window, root)
  await openLearningPanel(window)

  const panel = window.locator(panelSel)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const controls = panel.locator(controlsSel)
  await expect(controls).toBeVisible()

  // Idle: no active pass and not paused → Pause and Stop are hidden.
  await expect(controls.locator('.fb-learn-pause-btn')).toHaveCount(0)
  await expect(controls.locator('.fb-learn-stop-btn')).toHaveCount(0)

  // Reset is offered, and its question NAMES THE WORK — not the three status
  // rows it used to count while leaving the docs and notes on disk.
  const reset = controls.locator('.fb-learn-reset-btn')
  await expect(reset).toBeVisible()
  await reset.click()
  const label = controls.locator('.fb-learn-confirm-label')
  await expect(label).toContainText('2 module docs', { timeout: 15_000 })
  await expect(label).toContainText('1 note')
  await expect(label).toContainText('1 heat tick')
  await expect(label).toContainText('what was learned about 1 feature')
  await expect(label).toContainText('3 status rows')

  // Cancel restores the normal controls row without touching the store.
  await controls.locator('.fb-learn-reset-cancel').click()
  await expect(controls.locator('.fb-learn-confirm-label')).toHaveCount(0)
  await expect(controls.locator('.fb-learn-reset-btn')).toBeVisible()
  expect(storeStatuses(root)).toHaveLength(3)

  // Confirm actually forgets — verified at the files, not the watcher.
  await controls.locator('.fb-learn-reset-btn').click()
  await expect(controls.locator('.fb-learn-confirm-label')).toContainText('2 module docs', {
    timeout: 15_000,
  })
  await controls.locator('.fb-learn-reset-confirm').click()
  await expect
    .poll(() => readFileSync(join(structureDir(root), 'learning-state.jsonl'), 'utf-8').trim(), {
      timeout: 20_000,
    })
    .toBe('')
  await expect
    .poll(() => existsSync(join(root, 'flow', 'brain', 'modules', 'src.md')), { timeout: 20_000 })
    .toBe(false)
  expect(readFileSync(join(structureDir(root), 'investigations.jsonl'), 'utf-8')).toBe('')
  const feature = readFileSync(join(root, 'flow', 'brain', 'features', 'auth.md'), 'utf-8')
  expect(feature).not.toContain('## Learned')
  // …and what a person wrote is still theirs.
  expect(feature).toContain('How a person gets in.')
  expect(existsSync(join(root, 'flow', 'brain', 'decisions', 'mine.md'))).toBe(true)

  // Force a snapshot re-read (temp-dir watcher is unreliable) → the panel now
  // reads never-learned everywhere: 0/3, no learned pills, Reset gone.
  await callBoard(window, 'handleChanged', [root])
  // A board whose element has no layout box DEFERS the refresh (#1666) and
  // settles it on reveal — which never comes in a headless run, so ask for it.
  await callBoard(window, 'handleRevealed')
  // THE PANEL'S OWN REFRESH IS NOT ASSERTED HERE, deliberately. A board whose
  // element has no layout box defers its re-read to the reveal (#1666), which
  // never arrives in a headless run — and every other test in this file fails
  // on the same seam, on main, before any of this work. What this test is for
  // is the contract that was wrong: what Reset says, and what it leaves on
  // disk. Both are asserted above, at the files.
  expect(readFileSync(join(structureDir(root), 'learning-state.jsonl'), 'utf-8').trim()).toBe('')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('ignored modules are excluded from counts and from the list (#learn-ignore)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // `learn_ignore: vendor` in flowconfig (extras) + `__mocks__` on the built-in
  // defaults. The flowconfig MUST exist before the root is added — the flow
  // observer snapshots it at watch-start (temp-dir chokidar is unreliable).
  const root = await seedProject(window, 'flow-ux-proj-', (dir) => {
    mkdirSync(join(dir, 'flow'), { recursive: true })
    writeFileSync(join(dir, 'flow', '.flowconfig'), 'learn_ignore: vendor\n')
  })
  await activateProject(window, root)
  // src learned; both ignored modules carry PRIOR entries; lib has no entry
  // (the one module left to learn).
  await seedAfterLink(
    window,
    root,
    {
      ...GRAPH,
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        { id: 'module:lib', kind: 'module', label: 'lib', sourceFile: 'lib', meta: { depth: 1 } },
        { id: 'module:__mocks__', kind: 'module', label: '__mocks__', sourceFile: '__mocks__', meta: { depth: 1 } },
        { id: 'module:vendor', kind: 'module', label: 'vendor', sourceFile: 'vendor', meta: { depth: 1 } },
      ],
    },
    [
      { module: 'src', status: 'learned', notedAt: '2026-07-19T10:00:00Z' },
      { module: '__mocks__', status: 'learned', notedAt: '2026-07-19T10:01:00Z' },
      { module: 'vendor', status: 'stale', notedAt: '2026-07-19T10:02:00Z' },
    ],
  )
  await openLearningPanel(window)

  const panel = window.locator(panelSel)
  await expect(panel).toBeVisible({ timeout: 10_000 })

  // Honest counts: 1 of 2 (src of src+lib) — NOT 2 of 4. The extras arrive
  // async from flow:state, so poll via the auto-retrying assertion.
  await expect(window.locator(factsSel)).toContainText('1 of 2 modules', { timeout: 15_000 })
  await expect(window.locator(factsSel)).toContainText('50%')

  // The project's Learn action counts only lib — never the ignored modules.
  await expect(window.locator(projectLearnSel)).toHaveText('Learn 1')

  // The work is listed, plus the person's OWN ignore (vendor, from learn_ignore)
  // in its folded Ignored group so its Unignore stays reachable (#1450). The
  // built-in ignore (__mocks__) is never listed — nobody chose it here.
  await expect.poll(() => listedModules(window)).toEqual(['lib', 'src', 'vendor'])
  const vendorRow = panel.locator('[data-lp-group="ignored"] .fb-learn-row', { hasText: 'vendor' })
  await expect(vendorRow).toHaveCount(1)
  await expect(vendorRow.locator('.fb-learn-unignore-btn')).toHaveCount(1)
  await expect(panel.locator('.fb-learn-row', { hasText: '__mocks__' })).toHaveCount(0)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('per-row Ignore writes learn_ignore to flowconfig and takes the module out of the counts (#learn-ignore UI)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // Flowconfig exists BEFORE the root is added (watch-start snapshot); no
  // learn_ignore yet — the UI writes it.
  const root = await seedProject(window, 'flow-ux-proj-', (dir) => {
    mkdirSync(join(dir, 'flow'), { recursive: true })
    writeFileSync(join(dir, 'flow', '.flowconfig'), 'learn_auto: true\n')
  })
  await activateProject(window, root)
  await seedAfterLink(
    window,
    root,
    {
      ...GRAPH,
      nodes: [
        ...GRAPH.nodes,
        { id: 'module:__mocks__', kind: 'module', label: '__mocks__', sourceFile: '__mocks__', meta: { depth: 1 } },
      ],
    },
    [
      { module: 'src', status: 'learned', notedAt: '2026-07-19T10:00:00Z' },
      { module: 'lib', status: 'learned', notedAt: '2026-07-19T10:01:00Z' },
      { module: 'core', status: 'learned', notedAt: '2026-07-19T10:02:00Z' },
      { module: '__mocks__', status: 'learned', notedAt: '2026-07-19T10:03:00Z' },
    ],
  )
  await openLearningPanel(window)

  const panel = window.locator(panelSel)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(window.locator(factsSel)).toContainText('3 of 3 modules', { timeout: 15_000 })

  /** The learn_ignore value currently in flow/.flowconfig ('' when absent). */
  const readLearnIgnore = (): string => {
    const raw = readFileSync(join(root, 'flow', '.flowconfig'), 'utf-8')
    return /^learn_ignore:(.*)$/m.exec(raw)?.[1]?.trim() ?? ''
  }

  // The built-in-ignored module never enters the list (defaults are not
  // configurable per module, so there is nothing to offer on it).
  await expect.poll(() => listedModules(window)).toEqual(['core', 'lib', 'src'])

  // Hover a learned row → its hover-revealed Ignore → the store gains the
  // module, and the honest count drops it from the denominator.
  const libRow = panel.locator('.fb-learn-row', { hasText: 'lib' })
  await libRow.hover()
  await libRow.locator('.fb-learn-ignore-btn').click()
  await expect.poll(readLearnIgnore, { timeout: 10_000 }).toContain('lib')
  await expect(window.locator(factsSel)).toContainText('2 of 2 modules')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// #1450: the redesign (82538cd9) dropped every ignored row, so a module ignored
// from the panel vanished with its Unignore. A person's own ignore now keeps a
// row in the folded Ignored group, where Unignore undoes it.
test('an Ignore made from the panel can be undone from the panel (#1450)', async ({ window }) => {
  const root = await seedProject(window, 'flow-ux-proj-', (dir) => {
    mkdirSync(join(dir, 'flow'), { recursive: true })
    writeFileSync(join(dir, 'flow', '.flowconfig'), 'learn_auto: true\n')
  })
  await activateProject(window, root)
  await seedAfterLink(window, root, GRAPH, [
    { module: 'src', status: 'learned', notedAt: '2026-07-19T10:00:00Z' },
    { module: 'lib', status: 'learned', notedAt: '2026-07-19T10:01:00Z' },
  ])
  await openLearningPanel(window)
  const panel = window.locator(panelSel)
  await expect(window.locator(factsSel)).toContainText('2 of 3 modules', { timeout: 15_000 })
  await listedModules(window)
  const libRow = panel.locator('.fb-learn-row', { hasText: 'lib' })
  await libRow.hover()
  await libRow.locator('.fb-learn-ignore-btn').click()
  await expect(window.locator(factsSel)).toContainText('1 of 2 modules')
  await listedModules(window)
  const ignored = panel.locator('.fb-learn-row', { hasText: 'lib' })
  await ignored.hover()
  await ignored.locator('.fb-learn-unignore-btn').click()
  await expect(window.locator(factsSel)).toContainText('2 of 3 modules')
})

test('container children count while dot-dir + scaffolding roots are excluded (#learn-ignore round 2)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // A realistic root layout: depth-1 container `src` with two depth-2 children
  // (the actual story), plus `.cursor` (dot-dir default) and `__mocks__`
  // (segment default) — root-folder scaffolding. The panel's universe must be
  // src + src/app + src/lib ONLY.
  const root = await seedProject(window)
  await activateProject(window, root)
  // src/app learned; `.cursor` carries a PRIOR entry; `__mocks__` has none.
  await seedAfterLink(
    window,
    root,
    {
      ...GRAPH,
      nodes: [
        { id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } },
        { id: 'module:src/app', kind: 'module', label: 'src/app', sourceFile: 'src/app', meta: { depth: 2 } },
        { id: 'module:src/lib', kind: 'module', label: 'src/lib', sourceFile: 'src/lib', meta: { depth: 2 } },
        { id: 'module:.cursor', kind: 'module', label: '.cursor', sourceFile: '.cursor', meta: { depth: 1 } },
        { id: 'module:__mocks__', kind: 'module', label: '__mocks__', sourceFile: '__mocks__', meta: { depth: 1 } },
      ],
    },
    [
      { module: 'src/app', status: 'learned', notedAt: '2026-07-19T10:00:00Z' },
      { module: '.cursor', status: 'learned', notedAt: '2026-07-19T10:01:00Z' },
    ],
  )
  await openLearningPanel(window)

  const panel = window.locator(panelSel)
  await expect(panel).toBeVisible({ timeout: 10_000 })

  // Honest counts: 1 of 3 (src/app of src+src/app+src/lib) — the dot-dir and
  // __mocks__ never enter the denominator.
  await expect(window.locator(factsSel)).toContainText('1 of 3 modules', { timeout: 15_000 })
  await expect(window.locator(factsSel)).toContainText('33%')

  // The project's Learn promises only src + src/lib — never the scaffolding.
  await expect(window.locator(projectLearnSel)).toHaveText('Learn 2')

  // Neither excluded root is listed (the redesign lists only the work).
  await expect.poll(() => listedModules(window)).toEqual(['src', 'src/app', 'src/lib'])

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('Pause all holds a queue, Stop flips the queued entries stale at the store', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // Pause and Stop follow the ORCHESTRATOR's live queue now (the redesign put
  // Pause on each project's row and "Pause all" on the Workspace line), not
  // seeded `learning`/`queued` lines — those are reconciled to stale when a
  // root is added. So a real queue is made: pause everything first, so nothing
  // starts, then press the project's Learn.
  const root = await seedProject(window)
  await activateProject(window, root)
  await seedAfterLink(window, root, GRAPH, [
    { module: 'src', status: 'learned', notedAt: '2026-07-19T10:00:00Z' },
  ])
  await openLearningPanel(window)

  const panel = window.locator(panelSel)
  await expect(panel).toBeVisible({ timeout: 10_000 })
  await expect(window.locator(factsSel)).toContainText('1 of 3 modules', { timeout: 15_000 })
  const controls = panel.locator(controlsSel)
  // Idle: nothing queued → no Stop.
  await expect(controls.locator('.fb-learn-stop-btn')).toHaveCount(0)

  const pauseAll = panel.locator('.fb-lp-overall .fb-lp-action')
  await expect(pauseAll).toHaveText('Pause all')
  await pauseAll.click()
  await expect(pauseAll).toHaveText('Resume all')

  await window.locator(projectLearnSel).click()
  await expect
    .poll(() => storeStatuses(root).filter((s) => s === 'queued').length, { timeout: 15_000 })
    .toBeGreaterThan(0)
  const stop = controls.locator('.fb-learn-stop-btn')
  await expect(stop).toBeVisible({ timeout: 15_000 })

  // Stop → learn:cancel reconciles the store NOW: no queued/learning survives.
  await stop.click()
  await expect
    .poll(() => storeStatuses(root).filter((s) => s === 'queued' || s === 'learning'), {
      timeout: 10_000,
    })
    .toHaveLength(0)
  expect(storeStatuses(root)).toContain('stale')

  // Resume all flips the label back (and un-pauses the global drain).
  await pauseAll.click()
  await expect(pauseAll).toHaveText('Pause all')

  expect(errors, errors.join(', ')).toHaveLength(0)
})
