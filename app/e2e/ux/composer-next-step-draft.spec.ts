import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 3 (composer), round 15: the WORKFLOW NEXT-STEP suggestion bar.
 *
 * plan-flow skills run in a recommended order, so once a workflow command
 * settles the composer surfaces a one-click "Next step /<skill>" button
 * (`workflow-suggestion.ts` + `Composer#renderSuggestion`). Fifteen composer
 * specs cover input / @-mentions / /-commands / attachments / queue / history /
 * model+effort — none of them has ever driven the suggestion bar, even though it
 * is the one composer control that SENDS on a single click.
 *
 * Test 1 (live guard) — the suggestion surface's own contract:
 *   - it appears only after a workflow command settles (last user message is
 *     `/brainstorm` → suggests `/discovery-plan`, resolved from the project's
 *     real `.claude/commands/*.md`),
 *   - it hides while a turn is working (`#renderSuggestion` gates on status), so
 *     the one-click send can't race a running turn,
 *   - it comes back when the turn settles again.
 *
 * Test 2 (regression guard for #980) — the suggestion button must NOT destroy
 * an unsent draft. `Composer#acceptNextStep` used to write `/${command.name}`
 * over the textarea and call `#send()`, silently discarding whatever the user
 * was typing with no confirm, no restore, and no recall entry. Fixed: the
 * suggestion now dispatches directly (the #drainNext pattern) without touching
 * the textarea, so the draft survives in the input.
 *
 * Credential-free: the workflow history is persisted with `messages:append`
 * (raw store, no turn) and the settle is driven by the same `threads:stream`
 * status events the agent-manager emits — the pattern from
 * composer-idle-queue-label.spec.ts.
 */

const SUGGESTION = '.fl-composer-suggestion'
const DRAFT = 'wait — first explain how the auth token refresh works in this repo'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

/** Persist a user message WITHOUT starting a turn (raw store — see ipc-contract). */
async function appendUser(win: Page, threadId: string, content: string): Promise<void> {
  await win.evaluate(
    async ({ threadId, content }) => {
      await (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role: 'user', content })
    },
    { threadId, content },
  )
}

async function emitStream(
  app: ElectronApplication,
  ev: Record<string, unknown>,
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', ev)
  }, ev)
}

/** Real plan-flow skills so `computeNextStepCommand` can resolve the successor. */
function populateSkills(dir: string): void {
  const commandsDir = join(dir, '.claude', 'commands')
  mkdirSync(commandsDir, { recursive: true })
  for (const [name, description] of [
    ['brainstorm', 'Explore an idea'],
    ['discovery-plan', 'Gather requirements'],
    ['create-plan', 'Build a plan'],
  ]) {
    writeFileSync(join(commandsDir, `${name}.md`), `---\ndescription: ${description}\n---\nBody\n`)
  }
}

/** Seed a project + a thread whose last user message is `/brainstorm`, open it,
 *  and settle a turn so the next-step suggestion is computed. */
async function openThreadWithSuggestion(
  win: Page,
  app: ElectronApplication,
  title: string,
): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-nextstep-', populateSkills)
  await activateProject(win, dir)
  const threadId = await createThread(win, dir, title)
  await appendUser(win, threadId, '/brainstorm a notifications redesign')
  await win.getByText(title, { exact: true }).click()
  await expect(win.locator(sel.composer)).toBeVisible()
  // A settled turn is what recomputes the suggestion (threads/index.ts onStatus).
  await emitStream(app, { kind: 'status', threadId, status: 'idle' })
  return threadId
}

test.afterAll(() => cleanupSeeds())

test('the Next-step suggestion appears on a settled workflow turn and hides while working', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const threadId = await openThreadWithSuggestion(window, app, 'Suggestion lifecycle')
  const bar = window.locator(SUGGESTION)

  // Appears, and names the workflow successor of /brainstorm. The description
  // comes from the project's discovery-plan.md frontmatter — but the IDE
  // auto-provisioner treats `.claude/commands` as OWNED assets and may replace
  // the seeded file with the bundled skill, so assert a description is shown
  // rather than pinning the seeded text.
  await expect(bar).toBeVisible({ timeout: 5000 })
  await expect(bar).toContainText('/discovery-plan')
  await expect(bar.locator('.fl-composer-suggestion-desc')).not.toBeEmpty()

  // A running turn hides it — a one-click send must not race the live turn
  // (#acceptNextStep also refuses on `working`, so the hide is the visible half
  // of that guard rather than its only line of defence).
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await expect(bar).toBeHidden({ timeout: 3000 })

  // ...and returns when the turn settles again.
  await emitStream(app, { kind: 'status', threadId, status: 'idle' })
  await expect(bar).toBeVisible({ timeout: 5000 })
  await expect(bar).toContainText('/discovery-plan')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test(
  'clicking Next step must not destroy the unsent draft in the composer',
  async ({ app, window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    await openThreadWithSuggestion(window, app, 'Draft vs suggestion')
    const bar = window.locator(SUGGESTION)
    await expect(bar).toBeVisible({ timeout: 5000 })

    // The user is mid-thought in the composer — the suggestion bar sits directly
    // above this input, still offering its one-click skill.
    const textarea = window.locator(`${sel.composer} textarea`)
    await textarea.click()
    await textarea.fill(DRAFT)
    await expect(textarea).toHaveValue(DRAFT)
    await expect(bar).toBeVisible()

    await bar.locator('.fl-composer-suggestion-btn').click()
    await window.waitForTimeout(500)

    // The draft must survive in SOME reachable form: still in the input (the
    // fixed behavior — #acceptNextStep dispatches without touching the textarea),
    // or at minimum recoverable by ArrowUp history recall.
    const survivedInInput = (await textarea.inputValue()).includes(DRAFT)
    let survivedInHistory = false
    if (!survivedInInput) {
      await textarea.click()
      await textarea.fill('')
      for (let i = 0; i < 6 && !survivedInHistory; i += 1) {
        await window.keyboard.press('ArrowUp')
        await window.waitForTimeout(120)
        survivedInHistory = (await textarea.inputValue()).includes(DRAFT)
      }
    }
    expect(
      survivedInInput || survivedInHistory,
      'the unsent draft was destroyed by the Next-step click and is unrecoverable',
    ).toBe(true)

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)
