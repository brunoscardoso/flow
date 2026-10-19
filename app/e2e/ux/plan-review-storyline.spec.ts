/**
 * THE REVIEW IS THE CODE STORY (plan `plan_change_review`, the user's second
 * complaint): "the review part still not showing the code references … I
 * wanna use that same structure [the code storyline] combined with the new
 * review". Reproduces the user's plan shape end to end: a page-object class
 * whose constructor is noted, a types file and a fixtures file with file
 * notes (one quoting its place with `where:`, one not), a new fixture
 * function, and a spec file note.
 *
 * Real everywhere it can be: a seeded git repo, the PLAN card's own "Review
 * the change" press, the bundled CLI reading the notes and drawing the
 * story (`blueprint storyline --plan`), and every decision written into the
 * plan file on disk (`plan note`). Nothing reaches an agent.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const SLUG = 'direct_link'
const DISCOVERY = `flow/discovery/discovery_${SLUG}_v1.md`
const PLAN = `flow/plans/plan_${SLUG}_v1.md`
const RESULTS = join(__dirname, '..', 'results')

const QUOTE = "this.errorBanner = this.main.locator('p.text-destructive')"

const PAGE_FILE = `import type { Locator, Page } from '@playwright/test'

/** The chat thread page. */
export class ChatThreadPage {
  readonly main: Locator
  errorBanner: Locator | null = null
  composer: Locator | null = null

  constructor(readonly page: Page) {
    this.main = page.locator('main')
    this.composer = this.main.locator('textarea')
    ${QUOTE}
    this.wire()
  }

  /** Wire the page's handlers. */
  wire(): void {
    this.page.on('dialog', (dialog) => void dialog.dismiss())
  }

  /** Open a chat by its id. */
  async open(id: string): Promise<void> {
    await this.page.goto('/chats/' + id)
  }

  unrelated(): number {
    return 1
  }
}
`

const TYPES_FILE = `export type StartedChat = {
  id: string
  title: string
}

export type ChatFixtures = {
  started: StartedChat
}
`

const FIXTURES_FILE = `import { test as base } from '@playwright/test'
import { ChatThreadPage } from '../pages/thread-page'

/**
 * Fixtures for the chats section.
 */
export const test = base.extend<{ thread: ChatThreadPage }>({
  thread: async ({ page }, use) => {
    await use(new ChatThreadPage(page))
  },
})
`

const SPEC_FILE = `import { test } from '../fixtures/chats'

test.describe('chat access', () => {
  test('opens its own chat', async ({ thread }) => {
    await thread.open('mine')
  })
})
`

const PLAN_DOC = `# Plan: Direct link access error

## Phases

### Phase 1: Page object and fixtures
**Complexity**: 4/10

- [ ] Add the access alert

#### Change notes

- note: 1 · change · file:src/pages/thread-page.ts:ChatThreadPage.constructor
    where: \`${QUOTE}\`
    what: assign an access-alert locator beside the existing ones
    why: the spec needs a page-object handle for the alert
- note: 2 · file · file:src/types/chats.ts
    where: \`export type ChatFixtures = {\`
    what: add the member page to the fixtures' type
    why: the fixture is typed
- note: 3 · file · file:src/fixtures/chats.ts
    what: add a member fixture to the chats section
    why: the spec needs a second user
- note: 4 · new · file:src/fixtures/chats.ts:memberPage
    signature: memberPage({ browser }, use): Promise<void>
    purpose: a second user's page in its own browser context
    callers: ChatThreadPage.open

### Phase 2: Tests (Final)
**Complexity**: 2/10

- [ ] The denied case

#### Change notes

- note: 5 · file · file:src/tests/access.spec.ts
    where: \`test('opens its own chat'\`
    what: add the case where another user's chat URL is denied
    why: the regression guard
`

test.afterAll(() => cleanupSeeds())

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Flow E2E', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: dir })
}

function seed(dir: string): void {
  const write = (path: string, text: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  write('src/pages/thread-page.ts', PAGE_FILE)
  write('src/types/chats.ts', TYPES_FILE)
  write('src/fixtures/chats.ts', FIXTURES_FILE)
  write('src/tests/access.spec.ts', SPEC_FILE)
  git(dir, ['add', 'src'])
  git(dir, ['commit', '-q', '-m', 'seed'])
  // The documents ride the Workspace import (`link --import`) into the project's knowledge.
  write(DISCOVERY, '# Discovery: Direct link\n\nAnother user opening a chat link is told they have no access.\n')
  write(PLAN, PLAN_DOC)
}

async function waitForWorkspaceLink(dir: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(dir, 'flow')).isSymbolicLink() && existsSync(join(dir, PLAN))
        } catch {
          return false
        }
      },
      { timeout: 300_000 },
    )
    .toBe(true)
}

async function api<T>(win: Page, fn: string, arg: unknown): Promise<T> {
  return win.evaluate(
    async ({ fn, arg }) => {
      const flow = (window as unknown as { flow: Record<string, Record<string, (i: unknown) => Promise<unknown>>> }).flow
      const [ns, method] = fn.split('.')
      return (await flow[ns]![method]!(arg)) as unknown
    },
    { fn, arg },
  ) as Promise<T>
}

/** The status line of one note in the plan file on disk ('' when it has none). */
function statusOnDisk(root: string, n: number): string {
  const text = readFileSync(join(root, PLAN), 'utf-8')
  const start = text.indexOf(`- note: ${String(n)} ·`)
  if (start < 0) return ''
  const rest = text.slice(start + 1)
  const next = rest.search(/\n- note: |\n### /)
  const block = next < 0 ? text.slice(start) : text.slice(start, start + 1 + next)
  return /status: (.*)/.exec(block)?.[1]?.trim() ?? ''
}

test('Review the change draws the code story — real code, entry, call arrows, the step rail — with the notes on it', async ({ app, window: page }) => {
  test.setTimeout(480_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  mkdirSync(RESULTS, { recursive: true })

  const root = await seedProject(page, 'flow-ux-plan-review-story-', seed)
  await activateProject(page, root)
  await waitForWorkspaceLink(root)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: root, title: 'Access thread' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'plan the access error' })
  await api(page, 'messages.append', { threadId: thread.id, role: 'system', content: `[artifact] discovery ${DISCOVERY}` })
  await api(page, 'messages.append', { threadId: thread.id, role: 'system', content: `[artifact] plan ${PLAN}` })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'ready' })

  await page.getByText('Access thread', { exact: true }).first().click()
  await expect(page.locator(sel.conversation)).toBeVisible()
  const card = page.locator(`.fl-artifact-card[data-doc-path="${PLAN}"]`)
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  // POSITIVE FIRST (allowed-pattern #28): the notes were read — the card offers the review.
  const reviewButton = card.getByRole('button', { name: 'Review the change' })
  await expect(reviewButton).toBeVisible({ timeout: 30_000 })
  await reviewButton.click()

  // Room to read the sheet: a larger window, and no terminal pane (⌘J).
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1800, 1150))
  await page.keyboard.press('ControlOrMeta+j')
  await page.waitForTimeout(400)

  // ── PROPOSAL: the code story with the review on it ─────────────────────────
  const board = page.locator('.flow-board-root')
  await expect(board.locator('.fb-nr-modes [data-review-mode="proposal"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 })
  const sheet = board.locator('.fb-story.fb-story-review')
  await expect(sheet).toHaveAttribute('data-review-mode', 'proposal')

  // THE NOTED CONSTRUCTOR'S BOX PRINTS ITS REAL CODE, the quoted line marked.
  const ctorBox = sheet.locator('.fb-story-box[data-piece="src/pages/thread-page.ts#ChatThreadPage.constructor"]')
  await expect(ctorBox).toHaveCount(1, { timeout: 60_000 })
  await expect(ctorBox.locator('pre.fb-story-code')).toBeVisible()
  await expect(ctorBox.locator('pre.fb-story-code')).toContainText(QUOTE)
  await expect(ctorBox.locator('pre.fb-story-code')).toContainText("this.main = page.locator('main')")
  const hit = ctorBox.locator('.fb-story-ln.fb-nr-hit')
  await expect(hit).toHaveCount(1)
  await expect(hit).toContainText(QUOTE)
  const hitStyle = await hit.evaluate((el) => getComputedStyle(el).boxShadow)
  expect(hitStyle).not.toBe('none')
  // Its note under it: Where / What / Why and the decision.
  await expect(ctorBox.locator('.fb-note[data-note="1"]')).toBeVisible()
  await expect(ctorBox.locator('.fb-nr-badge')).toHaveText(/proposed change/i)

  // THE STORYLINE'S OWN STRUCTURE: the entry point, a numbered call arrow from
  // the call line to the callee drawn to its right, and the step rail.
  await expect(ctorBox.locator('.fb-story-entry-tag')).toHaveText('Entry point')
  const wireBox = sheet.locator('.fb-story-box[data-piece="src/pages/thread-page.ts#ChatThreadPage.wire"]')
  await expect(wireBox).toHaveCount(1)
  await expect(wireBox).toContainText("this.page.on('dialog'")
  await expect(sheet.locator('svg.fb-story-wires path.fb-story-wire[data-to="src/pages/thread-page.ts#ChatThreadPage.wire"]')).toHaveCount(1, { timeout: 10_000 })
  await expect(sheet.locator('svg.fb-story-wires .fb-story-dot')).not.toHaveCount(0)
  await expect(ctorBox.locator('.fb-story-call[data-to="src/pages/thread-page.ts#ChatThreadPage.wire"]')).toHaveCount(1)
  const ctorRect = await ctorBox.boundingBox()
  const wireRect = await wireBox.boundingBox()
  expect(wireRect!.x).toBeGreaterThan(ctorRect!.x + ctorRect!.width)
  await expect(sheet.locator('.fb-story-rail .fb-story-step')).not.toHaveCount(0)
  await expect(sheet.locator('.fb-story-rail .fb-story-step').first()).toContainText('ChatThreadPage')
  // The code the plan does not touch is not on the sheet.
  await expect(sheet.locator('.fb-story-box[data-piece="src/pages/thread-page.ts#ChatThreadPage.unrelated"]')).toHaveCount(0)

  // A NEW FUNCTION: a dashed box in its file's cell, wired from its caller by a dashed "will call".
  const added = sheet.locator('.fb-nr-box.fb-nr-box-new', { has: page.locator('.fb-note[data-note="4"]') })
  await expect(added).toHaveCount(1)
  await expect(added.locator('.fb-story-bname')).toHaveText('memberPage')
  expect(await added.evaluate((el) => getComputedStyle(el).borderStyle)).toContain('dashed')
  await expect(sheet.locator('svg.fb-story-wires path.fb-nr-wire[data-to="note-new:4"]')).toHaveCount(1)
  await expect(sheet.locator('svg.fb-story-wires .fb-nr-wire-label')).toHaveText(['will call'])

  // FILE NOTES SIT ON THEIR FILE'S LABEL, above that file's code.
  for (const [file, n] of [
    ['src/types/chats.ts', 2],
    ['src/fixtures/chats.ts', 3],
    ['src/tests/access.spec.ts', 5],
  ] as const) {
    const notes = sheet.locator(`.fb-nr-filenotes[data-file="${file}"]`)
    await expect(notes).toHaveCount(1)
    await expect(notes.locator(`.fb-note[data-note="${String(n)}"]`)).toBeVisible()
    expect(await notes.evaluate((el) => (el.previousElementSibling as HTMLElement | null)?.dataset['file'] ?? null)).toBe(file)
  }
  // A file note's quote marks the line in the piece that holds it.
  const typesBox = sheet.locator('.fb-story-box[data-piece="src/types/chats.ts#ChatFixtures"]')
  await expect(typesBox.locator('.fb-nr-hit')).toContainText('export type ChatFixtures = {')
  // A file with no declaration still shows code: its lines, the quote marked.
  const specLines = sheet.locator('.fb-story-box[data-piece^="src/tests/access.spec.ts#L"]')
  await expect(specLines).toHaveCount(1)
  await expect(specLines.locator('.fb-nr-hit')).toContainText("test('opens its own chat'")
  const fixtureLines = sheet.locator('.fb-story-box[data-piece^="src/fixtures/chats.ts#L"]')
  await expect(fixtureLines).toContainText('export const test = base.extend')

  // The note strip and the review bar are still there.
  await expect(sheet.locator('.fb-nr-pill')).toHaveCount(5)
  const send = sheet.locator('.fb-nr-send')
  await expect(send).toBeDisabled()

  await page.mouse.move(2, 2)
  await page.screenshot({ path: join(RESULTS, 'plan-review-storyline-detail.png') })
  // The whole sheet: Fit, then the board alone.
  await board.locator('.fb-head-btn[aria-label="Fit"]').click()
  await page.waitForTimeout(400)
  await page.mouse.move(2, 2)
  await sheet.screenshot({ path: join(RESULTS, 'plan-review-storyline.png') })

  // ── TODAY: the same story, nothing on it ───────────────────────────────────
  await board.locator('.fb-nr-modes [data-review-mode="today"]').click()
  await expect(sheet).toHaveAttribute('data-review-mode', 'today')
  await expect(ctorBox.locator('pre.fb-story-code')).toContainText(QUOTE)
  await expect(ctorBox.locator('.fb-story-entry-tag')).toHaveText('Entry point')
  await expect(sheet.locator('.fb-note')).toHaveCount(0)
  await expect(sheet.locator('.fb-nr-hit')).toHaveCount(0)
  await expect(sheet.locator('.fb-nr-box-new')).toHaveCount(0)
  await expect(sheet.locator('svg.fb-story-wires path.fb-story-wire[data-to="src/pages/thread-page.ts#ChatThreadPage.wire"]')).toHaveCount(1)
  await page.mouse.move(2, 2)
  await sheet.screenshot({ path: join(RESULTS, 'plan-review-storyline-today.png') })

  // ── ACCEPT ALL: the notes not reviewed, never a rejected one ──────────────
  await board.locator('.fb-nr-modes [data-review-mode="proposal"]').click()
  await expect(sheet).toHaveAttribute('data-review-mode', 'proposal')
  const note2 = sheet.locator('.fb-note[data-note="2"]')
  await note2.locator('.fb-note-acts .fb-note-reject').click()
  await note2.locator('.fb-note-reason input').fill('the type is generated')
  await note2.locator('.fb-note-reason .fb-note-reject').click()
  await expect.poll(() => statusOnDisk(root, 2), { timeout: 30_000 }).toBe('rejected — the type is generated')
  // The positive: before Accept all, the others are not reviewed (no status line).
  expect([1, 3, 4, 5].map((n) => statusOnDisk(root, n))).toEqual(['', '', '', ''])
  // The first-run "basic discovery" offer floats over the bar's corner: not now.
  const learnOffer = page.locator('.fl-learn-card')
  if ((await learnOffer.count()) > 0) {
    await learnOffer.getByText('Not now', { exact: true }).click()
    await expect(learnOffer).toHaveCount(0)
  }
  const acceptAll = sheet.locator('.fb-nr-accept-all')
  await expect(acceptAll).toBeVisible()
  await expect(acceptAll).toHaveText('Accept all')
  await acceptAll.click()
  await expect.poll(() => [1, 3, 4, 5].map((n) => statusOnDisk(root, n)), { timeout: 60_000 }).toEqual(['accepted', 'accepted', 'accepted', 'accepted'])
  expect(statusOnDisk(root, 2)).toBe('rejected — the type is generated')
  await expect(send).toBeEnabled({ timeout: 30_000 })
  await expect(acceptAll).toHaveCount(0)

  expect(errors, `uncaught errors:\n${errors.join('\n')}`).toEqual([])
})
