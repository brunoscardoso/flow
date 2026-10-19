import { test, expect } from '../fixtures/electron'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Notifications — the INBOX's record of a blocked prompt (#1404). Flow 13 of
 * the progressive UX sweep, round 23.
 *
 * `showToast` renders a blocked prompt's markdown through `renderMarkdownLite`
 * (`notification-center.ts`): headings become `.fl-flow-md-h`, `**bold**`
 * becomes `<strong>`, fenced blocks become `pre.fl-flow-code`. `addToInbox`,
 * ten lines above it in the same file, does neither — it assigns the SAME body
 * to `textContent`, summarised as `firstLine(body)`.
 *
 * The daemon's prompt template (`src/cli/daemon/prompt-manager.ts`) opens every
 * prompt with the constant line `# Heartbeat Prompt`, so:
 *
 *   - every blocked-prompt inbox entry's body reads `# Heartbeat Prompt`,
 *     identical for every task in every project, with the `#` shown literally;
 *   - expanding it (the #1075 affordance) reveals the raw source — `**Task**:`,
 *     ``` fences and all — for the same body the toast beside it renders.
 *
 * That matters because the inbox is the DURABLE record: the toast is gone the
 * moment the prompt resolves (or, for non-sticky cards, after 6s), and #1075
 * made the inbox the place a body survives. Test 3 drives exactly that state.
 *
 * Credential-free: real files under `<root>/flow/`, the real main-process
 * `FlowObserver`, no account and no agent turn.
 */

const seededDirs: string[] = []
test.afterAll(() => {
  // Retry ENOTEMPTY: the IDE's fire-and-forget auto-provisioner can still be
  // writing its scaffold into a seeded root at teardown.
  for (const dir of seededDirs) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        execFileSync('sleep', ['0.3'])
      }
    }
  }
})

/** The daemon's real prompt document, verbatim from `buildPromptContent`. */
function heartbeatPrompt(task: string, question: string, errorTail: string): string {
  return `# Heartbeat Prompt

**Task**: ${task}
**Time**: 2026-08-07T18:00:00.000Z
**Status**: Waiting for input

## Context

The task "${task}" exited with code 2, indicating it needs human input.

### Last Output
\`\`\`
${question}
\`\`\`

### Error Output
\`\`\`
${errorTail}
\`\`\`

## Action Required

Please review the output above and either:
1. Open a new Claude session to resolve the issue
2. Edit this file with your response and the daemon will resume
`
}

const TASK_A = 'nightly-deploy'
const QUESTION_A = 'Should I deploy build 4471 to staging?'
const ERROR_A = 'staging smoke test 3/48 failed: checkout_flow'

const TASK_B = 'production-rollback'
const QUESTION_B = 'Should I roll back production to build 4390?'
const ERROR_B = 'rollback drops 6 hours of writes'

/** What the sidebar's "Add project" does once the native folder picker returns. */
async function addRoot(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (path) => {
    try {
      const key = 'flow.onboarded'
      const seen: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (!seen.includes(path)) seen.push(path)
      localStorage.setItem(key, JSON.stringify(seen))
    } catch {
      /* convenience only — keeps the per-project flow overlay from auto-opening */
    }
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path })
  }, dir)
}

/** Throwaway git repo with a pre-existing `flow/` dir (so the observer watch
 *  attaches), already blocked on `task`. Returns its path. */
async function seedBlocked(win: Page, prefix: string, markdown: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'autopilot: false\n', 'utf-8')
  writeFileSync(join(dir, 'flow', '.heartbeat-prompt.md'), markdown, 'utf-8')
  seededDirs.push(dir)
  await addRoot(win, dir)
  return dir
}

/** Nudge the observer's direct-refresh path — the chokidar watch on a
 *  /var/folders temp dir is unreliable on macOS (fsevents). */
async function nudge(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (path) => {
    await (
      window as unknown as {
        flow: {
          flow: {
            setConfig(r: { rootId: string; updates: Record<string, string> }): Promise<unknown>
          }
        }
      }
    ).flow.flow.setConfig({ rootId: path, updates: { autopilot: 'false' } })
  }, dir)
}

/** The inbox entries for blocked prompts: title, the body line the user reads
 *  while scanning, and whether the entry offers the #1075 expand affordance. */
async function blockedEntries(
  win: Page,
): Promise<Array<{ title: string; body: string; expandable: boolean }>> {
  return win.evaluate(() =>
    Array.from(document.querySelectorAll('.fl-flow-inbox-entry'))
      .map((entry) => {
        const captions = entry.querySelectorAll('.fl-flow-inbox-text .fl-flow-caption')
        return {
          title: entry.querySelector('.fl-flow-title')?.textContent ?? '',
          // captions[0] is the body; the last one is the timestamp.
          body: captions.length > 1 ? (captions[0].textContent ?? '') : '',
          expandable: entry.classList.contains('fl-flow-inbox-entry--expandable'),
        }
      })
      .filter((e) => e.title.startsWith('Task blocked:')),
  )
}

/** The unrelated per-project "Run a basic discovery?" ask shares the bottom-right
 *  region and intercepts clicks on the inbox; clear it first. */
async function clearDiscoveryAsk(win: Page): Promise<void> {
  const notNow = win.locator('fl-button', { hasText: 'Not now' })
  if (await notNow.count()) await notNow.first().click().catch(() => undefined)
  await win.evaluate(() => {
    for (const el of document.querySelectorAll('.fl-learn-card')) el.remove()
    for (const el of document.querySelectorAll('.fl-flow-toasts > *')) {
      if ((el as HTMLElement).innerText.includes('basic discovery')) el.remove()
    }
  })
}

/** Resolve a root's prompt out of band and wait for its sticky card to go.
 *  Required before touching the inbox: while a prompt card is live the toast
 *  stack is deliberately elevated ABOVE the inbox (#459), so the reply textarea
 *  covers the entries. It is also the state the durable record exists for. */
async function resolvePrompt(win: Page, dir: string): Promise<void> {
  rmSync(join(dir, 'flow', '.heartbeat-prompt.md'), { force: true })
  await nudge(win, dir)
  await expect(win.locator('.fl-flow-toast:has(.fl-flow-reply)')).toHaveCount(0, {
    timeout: 10_000,
  })
}

async function openInbox(win: Page): Promise<void> {
  await clearDiscoveryAsk(win)
  await win.locator('.fl-flow-line-inbox').click()
  await expect(win.locator('.fl-flow-inbox')).toBeVisible()
}

/**
 * LIVE CONTROL 1 — the app really can render a prompt's markdown, and does, on
 * the toast. Without this the inbox tripwires below could pass vacuously on a
 * build where `renderMarkdownLite` was gone or the prompt never arrived.
 */
test('the blocked-prompt CARD renders the prompt markdown (control)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  await seedBlocked(
    window,
    'flow-inbox-rec-card-',
    heartbeatPrompt(TASK_A, QUESTION_A, ERROR_A),
  )

  const card = window.locator('.fl-flow-toast:has(.fl-flow-reply)')
  await expect(card).toHaveCount(1, { timeout: 20_000 })
  await expect(card).toContainText(TASK_A, { timeout: 10_000 })

  const rendered = await card.locator('.fl-flow-md').innerText()
  expect(rendered, 'the card shows the question').toContain(QUESTION_A)
  expect(rendered, 'the card resolves the `#` heading').not.toContain('# Heartbeat Prompt')
  expect(rendered, 'the card resolves `**bold**`').not.toContain('**Task**')

  // The daemon's output/error tails really do land in a rendered code block.
  const code = await card.locator('.fl-flow-md pre.fl-flow-code').allInnerTexts()
  expect(code.join('\n'), 'the error tail renders as a code block').toContain(ERROR_A)
  expect(errors).toEqual([])
})

/**
 * LIVE CONTROL 2 — #1075's retention really works: the whole body is kept and
 * the entry expands on click. The tripwires are about WHAT is kept, not whether.
 */
test('the inbox keeps the whole prompt body and expands it (control)', async ({ window }) => {
  const dir = await seedBlocked(
    window,
    'flow-inbox-rec-keep-',
    heartbeatPrompt(TASK_A, QUESTION_A, ERROR_A),
  )
  await expect(window.locator('.fl-flow-toast:has(.fl-flow-reply)')).toHaveCount(1, {
    timeout: 20_000,
  })
  await resolvePrompt(window, dir)
  await openInbox(window)

  const entries = await blockedEntries(window)
  expect(entries.length, 'the prompt reached the inbox').toBe(1)
  expect(entries[0].title).toContain(TASK_A)
  expect(entries[0].expandable, 'a multi-line body is expandable (#1075)').toBe(true)

  const entry = window.locator('.fl-flow-inbox-entry').filter({ hasText: 'Task blocked' }).first()
  await entry.click()
  await expect(entry, 'expanding reveals the question the toast showed').toContainText(QUESTION_A)
})

/**
 * LIVE CONTROL 3 — the state the record exists for: once the prompt resolves
 * out of band the reply card is gone and the inbox is the only surviving copy.
 */
test('after the card is gone the inbox is the only record (control)', async ({ window }) => {
  const dir = await seedBlocked(
    window,
    'flow-inbox-rec-only-',
    heartbeatPrompt(TASK_A, QUESTION_A, ERROR_A),
  )
  await expect(window.locator('.fl-flow-toast:has(.fl-flow-reply)')).toHaveCount(1, {
    timeout: 20_000,
  })
  await resolvePrompt(window, dir)
  await openInbox(window)
  const entries = await blockedEntries(window)
  expect(entries.length, 'the inbox still holds the record').toBe(1)
  expect(entries[0].title).toContain(TASK_A)
})

/**
 * TRIPWIRE — the body line a user scans in the inbox must tell two different
 * blocked prompts apart. `firstLine()` of the daemon's template is the constant
 * `# Heartbeat Prompt`, so today every prompt from every project reads the same.
 * Verified failing against main.
 */
test.fixme('the inbox body line distinguishes two different blocked prompts', async ({
  window,
}) => {
  await seedBlocked(window, 'flow-inbox-rec-A-', heartbeatPrompt(TASK_A, QUESTION_A, ERROR_A))
  // Distinct mtimes → distinct prompt ids (`hb-<mtimeMs>`), so both are shown.
  await new Promise((r) => setTimeout(r, 80))
  await seedBlocked(window, 'flow-inbox-rec-B-', heartbeatPrompt(TASK_B, QUESTION_B, ERROR_B))

  await expect(window.locator('.fl-flow-toast:has(.fl-flow-reply)')).toHaveCount(2, {
    timeout: 25_000,
  })
  await openInbox(window)

  const entries = await blockedEntries(window)
  expect(entries.length, 'both prompts reached the inbox').toBe(2)
  const bodies = entries.map((e) => e.body)
  expect(
    new Set(bodies).size,
    `two different questions produce the same inbox body line: ${JSON.stringify(bodies)}`,
  ).toBe(2)
})

/**
 * TRIPWIRE — the retained body must be readable prose, not markdown source.
 * The same string the card renders is dropped into `textContent` here, so the
 * durable record shows `# Heartbeat Prompt`, `**Task**:` and ``` fences raw.
 * Verified failing against main.
 */
test.fixme('the inbox record is rendered, not raw markdown source', async ({ window }) => {
  const dir = await seedBlocked(
    window,
    'flow-inbox-rec-raw-',
    heartbeatPrompt(TASK_A, QUESTION_A, ERROR_A),
  )
  await expect(window.locator('.fl-flow-toast:has(.fl-flow-reply)')).toHaveCount(1, {
    timeout: 20_000,
  })
  await resolvePrompt(window, dir)
  await openInbox(window)

  const entry = window.locator('.fl-flow-inbox-entry').filter({ hasText: 'Task blocked' }).first()
  const collapsed = (await blockedEntries(window))[0]?.body ?? ''
  expect(
    collapsed,
    `the inbox summary shows the markdown heading marker: ${JSON.stringify(collapsed)}`,
  ).not.toMatch(/^#{1,3}\s/)

  await entry.click()
  const expanded = await entry.innerText()
  expect(expanded, 'the expanded record shows raw `**bold**` source').not.toContain('**Task**')
  expect(expanded, 'the expanded record shows raw code fences').not.toContain('```')
})
