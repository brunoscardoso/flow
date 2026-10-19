/**
 * THE CODE STORY, TODAY ⇄ AFTER (plan story-today-after) — a story opened while
 * a plan is narrated on the board carries the plan's comparison.
 *
 * Real everywhere it can be: a seeded git repo with a committed file, a
 * feature whose part names it, a curated view, a plan document (its Files, its
 * tasks, a Story with a function anchor) and the project's compiled story
 * naming that plan — the board asking the bundled CLI (`blueprint storyline
 * --plan`) through main. (The plan used to come from the review a discovery
 * opened on the Territory; that view was retired on 2026-10-08, and the plan
 * now comes from the compiled story, `story-plan.ts`.)
 *
 * Before anything changes, After is the plan's PREDICTION (dashed marks, the
 * plan's words, ghost boxes for what does not exist) and the foot says there
 * is no starting point yet. Then the file is edited on disk — a function
 * added, one changed, one deleted — and the story, read again, shows the REAL
 * diff against HEAD: Added / Changed (with its lines) / Removed, and the
 * summary. Today shows the code as it was. Once the plan is cleared from the
 * board (as archiving it does), the same story has no switch at all.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { Locator, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const SCREENS =
  process.env['FLOW_E2E_SCREENS'] ??
  join(tmpdir(), 'flow-e2e-screens', 'todayafter')
const FEATURE = 'Learning'
const FEATURE_ID = 'feature:learning'
const PART = 'Learn queue'
const PART_ID = 'feature:learning/learn-queue'
const LOG = 'Activity log'
const SLUG = 'learn-review'
const DOC = `discovery_${SLUG}_v1`
const PLAN = `plan_${SLUG}_v1`
const QUEUE = 'src/project/learn-queue.ts'
const LONG_TASK =
  'Make `admit` read the review time before it starts a pass, so a queue opened from a review never runs a pass the reviewer has not seen, and say so in the log'

test.afterAll(() => cleanupSeeds())

const QUEUE_TODAY = [
  '/** Start one learn pass for a module. */',
  'export function enqueue(module: string): number {',
  '  const job = makeJob(module)',
  '  return admit(job)',
  '}',
  '',
  '/** A job for one module. */',
  'function makeJob(module: string): string {',
  "  return 'job:' + module",
  '}',
  '',
  '/** Admit a job to the queue. */',
  'function admit(job: string): number {',
  '  const size = job.length',
  '  return size',
  '}',
  '',
  '/** The old retry path. */',
  'export function legacyRetry(job: string): number {',
  '  return job.length * 2',
  '}',
  '',
].join('\n')

/** What the plan's execution leaves: `admit` changed, `logAdmit` added, `legacyRetry` gone. */
const QUEUE_AFTER = [
  '/** Start one learn pass for a module. */',
  'export function enqueue(module: string): number {',
  '  const job = makeJob(module)',
  '  return admit(job)',
  '}',
  '',
  '/** A job for one module. */',
  'function makeJob(module: string): string {',
  "  return 'job:' + module",
  '}',
  '',
  '/** Admit a job to the queue. */',
  'function admit(job: string): number {',
  '  const size = job.length',
  '  logAdmit(job)',
  '  return Math.min(size, 10)',
  '}',
  '',
  '/** Say a job was admitted. */',
  'function logAdmit(job: string): void {',
  "  console.info('admitted', job)",
  '}',
  '',
].join('\n')

const VIEW = {
  feature: 'learning',
  provenance: 'code',
  generatedAt: '2026-10-07T00:00:00.000Z',
  meta: { title: FEATURE, sub: 'How a module gets read' },
  brief: {},
  views: {
    root: {
      title: FEATURE,
      nodes: [
        { id: 'panel', kind: 'project', title: 'Learning panel', sub: 'board', delta: 'stable' },
        { id: 'queue', kind: 'function', title: PART, sub: 'learn-queue', delta: 'stable' },
        { id: 'log', kind: 'module', title: LOG, sub: 'learn-log', delta: 'stable' },
      ],
      edges: [
        { from: 'panel', to: 'queue', label: 'start a pass', delta: 'kept' },
        { from: 'queue', to: 'log', label: 'append entry', delta: 'kept' },
      ],
    },
  },
}

function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `export const ${prefix}${String(i)} = ${String(i)}`).join('\n') + '\n'
}

function featureNote(slug: string, name: string, text: string): string {
  return ['---', `id: feature:${slug}`, `name: ${name}`, 'kind: core', `anchors: [module:src/${slug}]`, 'relates: []', 'lastFullRead: null', 'patchCount: 0', '---', '', `# ${name}`, '', text, ''].join('\n')
}

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Flow E2E', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: dir })
}

function seed(dir: string): void {
  mkdirSync(join(dir, 'src', 'project'), { recursive: true })
  writeFileSync(join(dir, QUEUE), QUEUE_TODAY)
  writeFileSync(join(dir, 'src', 'project', 'learn-log.ts'), lines('logStep', 30))
  const features = join(dir, 'flow', 'brain', 'features')
  mkdirSync(features, { recursive: true })
  for (const [slug, name, size] of [
    ['agents', 'Agents', 40],
    ['connectors', 'Connectors', 30],
  ] as const) {
    mkdirSync(join(dir, 'src', slug), { recursive: true })
    writeFileSync(join(dir, 'src', slug, 'index.ts'), lines(slug, size))
    writeFileSync(join(features, `${slug}.md`), featureNote(slug, name, `${name} — a sibling capability.`))
  }
  writeFileSync(
    join(features, 'learning.md'),
    [
      '---',
      `id: ${FEATURE_ID}`,
      `name: ${FEATURE}`,
      'kind: core',
      'anchors: [module:src/project]',
      'relates: []',
      'lastFullRead: null',
      'patchCount: 0',
      '---',
      '',
      `# ${FEATURE}`,
      '',
      'Reads modules and records what they do, one pass at a time.',
      '',
      '## Parts',
      '',
      `### ${PART}`,
      'The serial queue that runs learn passes.',
      `anchors: ${QUEUE}`,
      '',
      `### ${LOG}`,
      'What the queue did, newest first.',
      'anchors: src/project/learn-log.ts',
      '',
    ].join('\n'),
  )
  // THE CODE IS COMMITTED — HEAD is the plan's starting point once it changes.
  // `flow/` is not: the Workspace takes it over.
  git(dir, ['add', 'src'])
  git(dir, ['commit', '-q', '-m', 'seed'])
}

/** The plan: its Files (one planned file), its tasks, a Story naming a function that does not exist. */
const PLAN_DOC = [
  '# Plan: Learning review',
  '',
  '## Story',
  '',
  '### Step: A retry the queue does not have',
  '- kicker: The shape',
  `- anchors: symbol:${QUEUE}#retryLater`,
  '- phases: 2',
  '',
  'A failed pass waits a beat and tries again.',
  '',
  '## Phases',
  '',
  '### Phase 1: The queue reads the review',
  '',
  '**Scope**: the queue',
  '**Complexity**: 4/10',
  '**Dependencies**: None',
  `**Files**: \`${QUEUE}\`, \`src/project/review-cells.ts\``,
  '',
  `- [ ] ${LONG_TASK}`,
  `- [ ] Keep \`${QUEUE}\` small and readable`,
  '',
  '### Phase 2: Retry later',
  '',
  '**Complexity**: 2/10',
  '**Dependencies**: Phase 1',
  '',
  '- [ ] Add `retryLater` so a failed pass tries once more',
  '',
].join('\n')

/** The documents under review — through the Workspace link, once it exists. */
function writeReview(dir: string): void {
  const discovery = join(dir, 'flow', 'discovery')
  mkdirSync(discovery, { recursive: true })
  writeFileSync(join(discovery, `${DOC}.md`), '# Discovery: Learning review\n\nThe review cells, and a queue that reads the review.\n')
  const plans = join(dir, 'flow', 'plans')
  mkdirSync(plans, { recursive: true })
  writeFileSync(join(plans, `${PLAN}.md`), PLAN_DOC)
  const structure = join(dir, 'flow', 'brain', '.structure')
  mkdirSync(join(structure, 'feature-views'), { recursive: true })
  writeFileSync(join(structure, 'feature-views', 'learning.json'), JSON.stringify(VIEW, null, 2))
  // THE PLAN IN FLIGHT: `/create-plan` narrates its plan's Story into the
  // project's compiled story, which names the plan.
  const story = {
    plan: SLUG,
    sourcePath: `flow/plans/${PLAN}.md`,
    mode: 'strict',
    warnings: [],
    steps: [
      {
        id: 'a-retry',
        title: 'A retry the queue does not have',
        body: 'A failed pass waits a beat and tries again.',
        anchors: [],
        flow: [],
        phases: [2],
        decisions: [],
        rejected: [],
        questions: [],
        unresolvedAnchors: [],
        draft: false,
      },
    ],
  }
  writeFileSync(join(structure, 'story.json'), JSON.stringify(story, null, 2))
}

/** Clear the plan from the board, as archiving it does (`narrate --clear`). */
function clearStory(dir: string): void {
  rmSync(join(dir, 'flow', 'brain', '.structure', 'story.json'), { force: true })
}

async function waitForWorkspaceLink(dir: string, feature: string, timeout = 300_000): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(dir, 'flow')).isSymbolicLink() && existsSync(join(dir, 'flow', 'brain', 'features', `${feature}.md`))
        } catch {
          return false
        }
      },
      { timeout },
    )
    .toBe(true)
}

async function dismissAsks(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const notNow = page.getByRole('button', { name: 'Not now' }).first()
    if (!(await notNow.isVisible().catch(() => false))) break
    await notNow.click().catch(() => undefined)
    await page.waitForTimeout(150)
  }
}

async function reachProjectBoard(page: Page, folder: string, learning: Locator): Promise<void> {
  await expect(async () => {
    if (await learning.isVisible().catch(() => false)) return
    const countries = page.locator('.fb-ws-country')
    if ((await countries.count()) > 0) {
      const ours = countries.filter({ hasText: folder })
      const country = (await ours.count()) > 0 ? ours.first() : countries.first()
      await country.locator('.fb-ws-name').click({ timeout: 2_000 })
    }
    await expect(learning).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout: 150_000, intervals: [1_000, 2_000, 5_000] })
}

function exactly(name: string): RegExp {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

const terrCell = (page: Page, name: string): Locator =>
  page.locator('.fb-terr-cell', { has: page.locator(':scope > .fb-terr-cell-name', { hasText: exactly(name) }) }).first()

/** A story box by the name it prints. */
const storyBox = (page: Page, name: string): Locator =>
  page.locator('.fb-story-box', { has: page.locator('.fb-story-bname', { hasText: exactly(name) }) }).first()

async function screenshotBoth(page: Page, name: string): Promise<void> {
  mkdirSync(SCREENS, { recursive: true })
  // Off the sheet: a hovered box lights itself and dims the rest.
  await page.mouse.move(2, 450)
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((next) => document.documentElement.setAttribute('data-theme', next), theme)
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(SCREENS, `today-after-${name}-${theme}.png`) })
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
}

/** Into the feature's own level, where its parts are cells. */
async function diveIntoFeature(page: Page): Promise<void> {
  await expect(async () => {
    if (await terrCell(page, PART).isVisible().catch(() => false)) return
    await terrCell(page, FEATURE).dblclick({ position: { x: 24, y: 12 }, timeout: 2_000 })
    await expect(terrCell(page, PART)).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
}

/** Double-click the part's cell until its story is drawn (a single click only opens it in place). */
async function pressPart(page: Page): Promise<void> {
  await expect(async () => {
    await terrCell(page, PART).dblclick({ timeout: 2_000 })
    await expect(page.locator('.fb-story')).toHaveCount(1, { timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await expect(page.locator('.fb-story-box.fb-story-entry')).toHaveCount(1, { timeout: 60_000 })
}

/** Leave the story by its first crumb — back to where it was opened. */
async function leaveStory(page: Page): Promise<void> {
  await page.locator('.fb-story-head button.fb-story-crumb').last().click()
  await expect(page.locator('.fb-story')).toHaveCount(0, { timeout: 10_000 })
}

const timeButton = (page: Page, time: 'today' | 'after'): Locator => page.locator(`.fb-story-head [data-story-time="${time}"]`)

test('a story opened while a plan is in flight shows Today and After: the prediction first, then the real diff', async ({ window: page }) => {
  test.setTimeout(480_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const root = await seedProject(page, 'flow-ux-today-after-', seed)
  await activateProject(page, root)
  await waitForWorkspaceLink(root, 'learning')
  const terminal = page.locator('[data-view-action="terminal"]')
  if ((await terminal.getAttribute('aria-pressed')) === 'true') await terminal.click()
  await dismissAsks(page)
  const sidebar = page.locator('button[title^="Toggle sidebar"]').first()
  if (await sidebar.isVisible().catch(() => false)) await sidebar.click()
  await page.locator('[data-view-action="blueprint"]').click()
  await expect(page.locator('.flow-board-root')).toBeVisible()
  await reachProjectBoard(page, basename(root), terrCell(page, FEATURE))
  writeReview(root)
  await page.waitForTimeout(1_500)
  await dismissAsks(page)

  // ── BEFORE THE PLAN RUNS: After is the plan's prediction. ──
  await diveIntoFeature(page)
  await pressPart(page)
  const head = page.locator('.fb-story-head')
  await expect(head.locator('.fb-story-plan-chip')).toHaveText(`Plan ${SLUG}`, { timeout: 30_000 })
  await expect(timeButton(page, 'after')).toHaveAttribute('aria-pressed', 'true')
  await expect(timeButton(page, 'today')).toHaveAttribute('aria-pressed', 'false')

  // Every piece of the file is predicted to change in phase 1 — dashed, labelled.
  const admit = storyBox(page, 'admit')
  await expect(admit).toHaveAttribute('data-state', 'predicted')
  await expect(admit.locator('.fb-story-pill')).toHaveText('Changes in phase 1')
  // The task line is long: clamped on the box, whole on hover.
  const caption = admit.locator('.fb-story-caption')
  await expect(caption).toBeVisible()
  const captionText = (await caption.textContent()) ?? ''
  expect(captionText.length).toBeLessThanOrEqual(90)
  expect(captionText.endsWith('…')).toBe(true)
  await expect(caption).toHaveAttribute('title', LONG_TASK)
  await expect(storyBox(page, 'enqueue')).toHaveAttribute('data-state', 'predicted')
  // Nothing is drawn as fact yet.
  await expect(page.locator('.fb-story-box[data-state="added"], .fb-story-box[data-state="changed"], .fb-story-box[data-state="removed"]')).toHaveCount(0)
  // The plan's function that does not exist, and its file that does not: ghosts, no code.
  const retry = page.locator('.fb-story-ghost', { hasText: 'retryLater()' })
  await expect(retry).toHaveCount(1)
  await expect(retry.locator('.fb-story-pill')).toHaveText('Planned in phase 2')
  await expect(retry.locator('.fb-story-ghost-task')).toHaveText('Add `retryLater` so a failed pass tries once more')
  await expect(retry.locator('pre')).toHaveCount(0)
  await expect(page.locator('.fb-story-ghost', { hasText: 'review-cells.ts' })).toHaveCount(1)
  await expect(page.locator('.fb-story-compare-sum')).toHaveText('No starting point yet — showing what the plan says will change')
  // The rail marks the steps the plan changes.
  await expect(page.locator('.fb-story-step[data-state="predicted"]').first()).toBeVisible()
  // Wires still run: enqueue → makeJob, enqueue → admit.
  await expect(page.locator('.fb-story-wire:not(.fb-story-wire-type)')).not.toHaveCount(0)
  await page.waitForTimeout(400)
  await screenshotBoth(page, 'prediction-after')

  // TODAY: the code as it is, with no marks at all.
  await timeButton(page, 'today').click()
  await expect(timeButton(page, 'today')).toHaveAttribute('aria-pressed', 'true')
  await expect(storyBox(page, 'admit')).toBeVisible()
  await expect(page.locator('.fb-story-pill')).toHaveCount(0)
  await expect(page.locator('.fb-story-caption')).toHaveCount(0)
  await expect(page.locator('.fb-story-ghost')).toHaveCount(0)
  await expect(page.locator('.fb-story-box[data-state]')).toHaveCount(0)
  await expect(page.locator('.fb-story-step[data-state]')).toHaveCount(0)
  await page.waitForTimeout(300)
  await screenshotBoth(page, 'prediction-today')

  // ── THE PLAN RUNS: `admit` changes, `logAdmit` is added, `legacyRetry` goes. ──
  await leaveStory(page)
  writeFileSync(join(root, QUEUE), QUEUE_AFTER)
  await pressPart(page)
  await expect(head.locator('.fb-story-plan-chip')).toHaveText(`Plan ${SLUG}`, { timeout: 30_000 })
  await expect(timeButton(page, 'after')).toHaveAttribute('aria-pressed', 'true')

  const added = storyBox(page, 'logAdmit')
  await expect(added).toHaveAttribute('data-state', 'added', { timeout: 30_000 })
  await expect(added.locator('.fb-story-pill')).toHaveText('Added')
  const changed = storyBox(page, 'admit')
  await expect(changed).toHaveAttribute('data-state', 'changed')
  await expect(changed.locator('.fb-story-pill')).toHaveText('Changed')
  await expect(changed.locator('.fb-story-ln-removed')).toHaveText(['return size'])
  await expect(changed.locator('.fb-story-ln-added')).toHaveText(['logAdmit(job)', 'return Math.min(size, 10)'])
  const removed = storyBox(page, 'legacyRetry')
  await expect(removed).toHaveAttribute('data-state', 'removed')
  await expect(removed.locator('.fb-story-pill')).toHaveText('Removed')
  await expect(removed.locator('pre')).toContainText('return job.length * 2')
  // A removed piece has no wires out of it.
  expect(await page.locator('.fb-story-wire[data-from$="#legacyRetry"]').count()).toBe(0)
  // The wire into the new function leaves the changed box from its call line.
  await expect(page.locator('.fb-story-wire[data-to$="#logAdmit"]')).toHaveCount(1)
  // BOTH, WHILE THE PLAN RUNS: untouched pieces keep the prediction.
  await expect(storyBox(page, 'enqueue')).toHaveAttribute('data-state', 'predicted')
  await expect(page.locator('.fb-story-ghost', { hasText: 'retryLater()' })).toHaveCount(1)
  await expect(page.locator('.fb-story-compare-sum')).toContainText(`Plan ${SLUG}: 1 changed · 1 added · 1 removed`)
  await expect(page.locator('.fb-story-step[data-state="changed"]')).toHaveCount(1)
  await expect(page.locator('.fb-story-step[data-state="added"]')).toHaveCount(1)
  await page.waitForTimeout(400)
  await screenshotBoth(page, 'diff-after')
  // The whole sheet, framed: the added box, the removed one and the ghosts.
  await page.locator('.fb-story-head fl-button', { hasText: 'Fit' }).click()
  await page.waitForTimeout(300)
  await screenshotBoth(page, 'diff-after-fit')

  // TODAY: the old text of `admit`, `legacyRetry` plain, `logAdmit` not there yet.
  await timeButton(page, 'today').click()
  await expect(storyBox(page, 'admit').locator('pre')).toContainText('return size')
  await expect(storyBox(page, 'admit').locator('pre')).not.toContainText('logAdmit')
  await expect(storyBox(page, 'logAdmit')).toHaveCount(0)
  await expect(storyBox(page, 'legacyRetry')).toBeVisible()
  await expect(page.locator('.fb-story-pill')).toHaveCount(0)
  await expect(page.locator('.fb-story-ln-added, .fb-story-ln-removed')).toHaveCount(0)
  await page.waitForTimeout(300)
  await screenshotBoth(page, 'diff-today')

  // ── NO PLAN IN FLIGHT: the same part's story has no switch. ──
  await leaveStory(page)
  clearStory(root)
  await page.waitForTimeout(1_500)
  await diveIntoFeature(page)
  await pressPart(page)
  // Positive first: the story is drawn, with the edited code.
  await expect(storyBox(page, 'logAdmit')).toBeVisible()
  await expect(page.locator('.fb-story-head .fb-story-crumb.on')).toHaveText(PART)
  await expect(page.locator('.fb-story-plan-chip')).toHaveCount(0)
  await expect(page.locator('.fb-story-time')).toHaveCount(0)
  await expect(page.locator('.fb-story-box[data-state], .fb-story-ghost, .fb-story-pill, .fb-story-compare-sum')).toHaveCount(0)
  await page.waitForTimeout(300)
  await screenshotBoth(page, 'outside-plan')

  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
