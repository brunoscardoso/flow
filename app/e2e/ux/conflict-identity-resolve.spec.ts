import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { activateProject, seedProject, cleanupSeeds, removeTempDir } from './fixtures/seed'
import { sel } from '../selectors'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Conflict-UX v2 — end-to-end identity annotation + per-hunk resolve (Phase 5).
 *
 * This is the FR12 reconciliation of the original conflict-UX-redesign spec. v1
 * asserted a floating identity-CHIP bar whose controls read `Keep <branch>` and
 * asserted the whole conflict UI was free of the stage words ours/theirs/current/
 * incoming. v2 DELIBERATELY reversed both of those:
 *
 *   - the primary surface is now the REAL editor: opening a conflicted file floats
 *     no chip bar — instead Monaco tints each side (`fl-conflict-side-a/-b-*`
 *     decorations), writes a dimmed per-side IDENTITY ANNOTATION on the marker
 *     lines (`<branch/ref> · <you|author> · <time>   (Current)/(Incoming)`), and
 *     offers inline CodeLens actions over every hunk;
 *   - the actions use FIXED v2 wording — `Accept Current` / `Accept Incoming` /
 *     `Accept Both` — plus a `Compare` lens and a `✨ Resolve with AI` lens;
 *   - the `(Current)`/`(Incoming)` stage tags are PERMITTED now, because they are
 *     always paired with a concrete identity on the annotation line — the
 *     annotation is what makes Current vs Incoming unambiguous, replacing the old
 *     stage-word-absence assertion. (The reorder-menu stage-word rule still holds,
 *     but it lives on the pure `keepBothOrderOptions` core and is unit-tested in
 *     conflict-hunk-controls.test.ts, not here.)
 *
 * Driven by seeding a REAL two-hunk merge conflict (diverging commits +
 * `git merge`) so the app sees a genuine `conflicted` git state — never a faked
 * one — and opening the working-tree file the way the app does (the `flow:open-file`
 * channel a Files-tree row click ends up calling). The `Resolve with AI` hand-off
 * needs a Claude account and is covered by the fixme at the bottom; everything
 * below is deterministic and credential-less.
 *
 * NOTE on branch naming: the feature branch is deliberately NEUTRAL ("topic-blue")
 * — a branch literally named `incoming`/`current` would legitimately surface in an
 * annotation and confuse the identity assertion. The ours side has no captured
 * branch on a merge, so its truthful annotation shows the "HEAD" ref, tagged
 * `(Current)`.
 */

const SHOTS = join(__dirname, '__screens')

/** Monaco fires a benign "Canceled" rejection on model/editor disposal — not an app error. */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

/** Throwaway repos seeded this run (cleaned in afterAll). */
const seededDirs: string[] = []

/**
 * Build a repo carrying a real merge conflict with TWO separate hunks in one file,
 * then return { dir, file }. The two changed regions are spaced ~10 unchanged
 * context lines apart so git does NOT coalesce them into a single hunk. Seeding
 * the conflict BEFORE `addRoot` matters: the app's git watcher starts polling the
 * moment the root is added and races the seed commits for the index lock.
 */
function seedTwoHunkConflictRepo(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-conflict-id-'))
  seededDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')

  const file = 'notes.txt'
  // Two edit regions (ALPHA / OMEGA) separated by ten unchanged pad lines.
  const base = [
    'intro line',
    'ALPHA base',
    ...Array.from({ length: 10 }, (_v, i) => `pad ${i + 1}`),
    'OMEGA base',
    'outro line',
    '',
  ].join('\n')
  const withRegions = (alpha: string, omega: string): string =>
    [
      'intro line',
      alpha,
      ...Array.from({ length: 10 }, (_v, i) => `pad ${i + 1}`),
      omega,
      'outro line',
      '',
    ].join('\n')

  writeFileSync(join(dir, file), base)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', 'base')
  const mainBranch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()

  // Neutral feature branch — its name is what side B's annotation must display.
  git(dir, 'checkout', '-q', '-b', 'topic-blue')
  writeFileSync(join(dir, file), withRegions('ALPHA blue', 'OMEGA blue'))
  git(dir, 'commit', '-q', '-am', 'topic-blue change')

  git(dir, 'checkout', '-q', mainBranch)
  writeFileSync(join(dir, file), withRegions('ALPHA trunk', 'OMEGA trunk'))
  git(dir, 'commit', '-q', '-am', 'trunk change')

  try {
    git(dir, 'merge', 'topic-blue')
  } catch {
    // Expected: merge exits non-zero on conflict. The working tree now has markers.
  }
  return { dir, file }
}

/** Add a pre-built repo dir as a project root (no native dialog). */
async function addRoot(window: Page, dir: string): Promise<void> {
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
}

/** Create a chat thread and return its id. */
async function createThread(window: Page, root: string, title: string): Promise<string> {
  return window.evaluate(
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

/** Persist a message into a thread (user / assistant / system). */
async function appendMessage(
  window: Page,
  threadId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Promise<void> {
  await window.evaluate(
    async ({ threadId, role, content }) => {
      await (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

/** Open a thread's conversation by clicking its sidebar title. */
async function openThread(window: Page, title: string): Promise<void> {
  await window.getByText(title, { exact: true }).first().click()
  await expect(window.locator(sel.conversation)).toBeVisible()
}

/** Seed the conflict, add + activate the root, reveal Source Control → Changes. The
 *  Source Control panel stays visible so the merge banner's overview counter is
 *  asserted alongside the editor surface. */
async function openGitPanel(window: Page): Promise<{ dir: string; file: string }> {
  const { dir, file } = seedTwoHunkConflictRepo()
  await addRoot(window, dir)
  await activateProject(window, dir)
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Source Control"]').click()
  await window.locator('.fl-sc-viewbtn', { hasText: 'Changes' }).click()
  await expect(window.locator('.gp-root')).toBeVisible()
  await expect(async () => {
    expect(await window.locator('.gp-name').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 6000 })
  return { dir, file }
}

/**
 * Open the conflicted working-tree file in the REAL editor through the app's own
 * `flow:open-file` channel — the exact open a Files-tree row click ends up calling.
 * A `file:`-scheme Monaco model is what arms the conflict CodeLens provider + the
 * side/annotation decorations (both skip non-`file:` models), so this is the surface
 * v2 puts the resolver on. Waits until Monaco has mounted the marker copy.
 */
async function openConflictedFileInEditor(window: Page, dir: string, file: string): Promise<void> {
  await window.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath: dir, relPath: file },
  )
  await expect(window.locator('.fl-shell fl-tabs .tab', { hasText: file })).toBeVisible()
  // The marker working copy is what the real editor renders (never a merged view).
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('<<<<<<<', {
    timeout: 15000,
  })
}

/** The per-hunk conflict CodeLens COMMAND link whose visible label matches `label`
 *  (one such link per still-open hunk). Targets the individual `<a>` command inside
 *  `.codelens-decoration` — NOT the whole container, whose centre would land on a
 *  different command (e.g. Compare) and mis-click. */
function conflictLens(window: Page, label: string) {
  return window.locator('.monaco-editor .codelens-decoration a').filter({ hasText: label })
}

/** Every dimmed per-side identity annotation currently rendered in the editor. */
function annotations(window: Page) {
  return window.locator('.monaco-editor .fl-conflict-annotation')
}

test.afterAll(() => {
  while (seededDirs.length) {
    const dir = seededDirs.pop()
    if (dir) removeTempDir(dir)
  }
})

test('the real editor tints each side, annotates it by identity (Current/Incoming), and offers Accept + Compare', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { dir, file } = await openGitPanel(window)
  await openConflictedFileInEditor(window, dir, file)

  // (a) Both sides carry their colored tint — the ours (side A) and theirs (side B)
  // decorations from the shared conflict-decorations recipe (line + gutter classes).
  await expect(
    window.locator('.monaco-editor .fl-conflict-side-a-line, .monaco-editor .fl-conflict-side-a-gutter'),
  ).not.toHaveCount(0, { timeout: 15000 })
  await expect(
    window.locator('.monaco-editor .fl-conflict-side-b-line, .monaco-editor .fl-conflict-side-b-gutter'),
  ).not.toHaveCount(0)

  // (b) The per-side IDENTITY ANNOTATION is present and is what disambiguates the
  // two sides: the incoming side names the neutral branch + carries the (Incoming)
  // tag, the current side carries the (Current) tag — the stage tag never stands
  // alone, it rides on a concrete identity. This REPLACES v1's stage-word-absence
  // check over the whole conflict UI.
  // Two hunks → one incoming-side annotation per hunk, so assert existence of the
  // paired identity (topic-blue) + stage tag ((Incoming)) rather than a single match.
  await expect(
    annotations(window).filter({ hasText: 'topic-blue' }).filter({ hasText: '(Incoming)' }),
  ).not.toHaveCount(0, { timeout: 15000 })
  await expect(annotations(window).filter({ hasText: '(Current)' })).not.toHaveCount(0)

  // (c) The inline actions read the fixed v2 wording plus Compare. The three Accept
  // lenses need the file's (root, repo-path) to resolve first (async), so allow time;
  // Compare renders immediately (renderer-only).
  await expect(conflictLens(window, 'Accept Current').first()).toBeVisible({ timeout: 15000 })
  await expect(conflictLens(window, 'Accept Incoming').first()).toBeVisible()
  await expect(conflictLens(window, 'Accept Both').first()).toBeVisible()
  await expect(conflictLens(window, 'Compare').first()).toBeVisible()

  // (f) The scrollbar overview ruler is mounted so per-hunk conflict markers can be
  // drawn on it (the marks themselves are canvas-rendered — not DOM-queryable — so
  // their appearance is verified by the running-app screenshot below, not asserted).
  await expect(window.locator('.monaco-editor canvas.decorationsOverviewRuler')).not.toHaveCount(0)

  await window.screenshot({ path: join(SHOTS, 'conflict-identity-annotation.png') })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('Accept Current resolves ONE hunk and leaves the sibling conflict intact', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { dir, file } = await openGitPanel(window)
  await openConflictedFileInEditor(window, dir, file)

  // Two open hunks → an Accept-Current lens over each. The file-level overview
  // counter reads zero-of-one (the one conflicted file) and completion is gated.
  await expect(conflictLens(window, 'Accept Current')).toHaveCount(2, { timeout: 15000 })
  await expect(window.locator('.gp-merge-banner-count')).toHaveText('0 of 1 resolved')
  await expect(window.locator('.gp-merge-complete')).toBeDisabled()

  // (d) Take the current side of the FIRST hunk only. The lens resolves exactly its
  // hunk via the shared per-hunk path, then the buffer refreshes from disk.
  await conflictLens(window, 'Accept Current').first().click()

  // The sibling conflict survives: one Accept-Current lens remains, and the editor
  // still shows an (Incoming) annotation for the un-resolved hunk.
  await expect(conflictLens(window, 'Accept Current')).toHaveCount(1, { timeout: 10000 })
  await expect(annotations(window).filter({ hasText: '(Incoming)' })).not.toHaveCount(0)

  // The file is only PARTIALLY resolved, so it stays unmerged: the overview counter
  // holds at zero-of-one and "Complete merge" stays gated (a still-unmerged file is
  // unresolved even with a recorded hunk).
  await expect(window.locator('.gp-merge-banner-count')).toHaveText('0 of 1 resolved')
  await expect(window.locator('.gp-merge-complete')).toBeDisabled()

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('resolving every hunk clears the file and un-gates "Complete merge"; the overview counter reflects it', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const { dir, file } = await openGitPanel(window)
  await openConflictedFileInEditor(window, dir, file)

  await expect(conflictLens(window, 'Accept Current')).toHaveCount(2, { timeout: 15000 })
  await expect(window.locator('.gp-merge-banner-count')).toHaveText('0 of 1 resolved')
  await expect(window.locator('.gp-merge-complete')).toBeDisabled()

  // Resolve the first hunk (Accept Current); wait for the buffer to re-provide with a
  // single remaining hunk before touching the next one.
  await conflictLens(window, 'Accept Current').first().click()
  await expect(conflictLens(window, 'Accept Current')).toHaveCount(1, { timeout: 10000 })

  // Resolve the LAST hunk. Each per-hunk splice triggers a disk-refresh that rebuilds
  // the CodeLens, so a lone click can race the re-render and land on a detaching lens.
  // Retry the click until the buffer actually clears — the splice is a no-op once the
  // hunk is gone, so retries are safe. (The product resolves both hunks correctly —
  // verified on disk; this only makes the E2E robust to render timing.)
  await expect(async () => {
    await conflictLens(window, 'Accept Current').first().click({ timeout: 3000 })
    await expect(window.locator('.monaco-editor .view-lines')).not.toContainText('<<<<<<<', {
      timeout: 3000,
    })
  }).toPass({ timeout: 20000 })
  await expect(annotations(window)).toHaveCount(0)

  // (e) The file drops out of the unmerged set: the overview counter reads
  // one-of-one and "Complete merge" un-gates (the hard file-level gate).
  await expect(window.locator('.gp-merge-banner-count')).toHaveText('1 of 1 resolved', {
    timeout: 10000,
  })
  await expect(window.locator('.gp-merge-complete')).toBeEnabled()

  await window.screenshot({ path: join(SHOTS, 'conflict-identity-resolved.png') })
  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

/**
 * Resolve with AI — HUMAN-IN-THE-LOOP review (conflict-UX v2 / #1919).
 *
 * The v2 reversal made Resolve-with-AI human-in-the-loop: it parses the agent's
 * fenced proposals and mounts a ConflictReviewCard instead of auto-applying. Two
 * defects kept the user from ever seeing that card (#1919): the raw JSON reply was
 * rendered verbatim in the transcript, and the parser returned `[]` on realistic
 * replies. The two tests below pin the fix's user-visible halves HERMETICALLY —
 * no live Claude turn needed, using the same message-append + document-event seams
 * the conversation specs already use.
 */
test.afterAll(() => cleanupSeeds())

test('a conflict-proposals reply renders the review pointer, NOT the raw JSON (#1919)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Resolve Suppress')

  // The exact shape a real turn persists: a fenced conflict-proposals JSON array.
  const proposals = [
    { file: 'notes.txt', blockId: 0, choice: 'theirs', risk: 'safe', confidence: 0.9, why: 'keep incoming', how: 'take theirs' },
  ]
  const reply = ['Here are my proposals:', '```conflict-proposals', JSON.stringify(proposals), '```'].join('\n')
  await appendMessage(window, threadId, 'assistant', reply)
  await openThread(window, 'Resolve Suppress')

  // The transcript shows the compact pointer to the card — never the raw JSON.
  await expect(window.locator('.fl-conv-proposal-note')).toBeVisible()
  await expect(window.locator(sel.conversation)).not.toContainText('"choice"')

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('the review card mounts, is actionable, and applies NOTHING until a row is accepted (#1919)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Resolve Card')
  await appendMessage(window, threadId, 'user', 'resolve the conflicts please')
  await openThread(window, 'Resolve Card')

  // Dispatch the decoupled review event the resolve flow fires once proposals are
  // parsed — with a spy responder so we can assert Accept reached the apply path
  // WITHOUT touching git (the per-hunk splice is covered by conflict-accept-apply).
  await window.evaluate((root) => {
    const w = window as unknown as { __conflictDecisions?: string[] }
    w.__conflictDecisions = []
    const inputs = [
      {
        proposal: {
          file: 'notes.txt',
          blockId: 0,
          choice: 'theirs',
          risk: 'safe',
          confidence: 0.9,
          why: 'keep the incoming edit',
          how: 'take theirs',
        },
        side: 'b',
        rootPath: root,
        filePath: 'notes.txt',
        hunkId: 'hunk-1',
        fallbackLabel: 'incoming',
      },
    ]
    const onDecision = async (rowId: string, decision: string): Promise<void> => {
      w.__conflictDecisions!.push(`${rowId}:${decision}`)
    }
    const onDecisionAll = async (decision: string): Promise<string[]> => {
      w.__conflictDecisions!.push(`all:${decision}`)
      return inputs.map((i) => `${i.filePath}#${i.hunkId ?? i.proposal.blockId}`)
    }
    document.dispatchEvent(
      new CustomEvent('flow:conflict-review', { detail: { inputs, onDecision, onDecisionAll } }),
    )
  }, dir)

  // The card mounts with one readable row carrying the v2 choice wording.
  await expect(window.locator('.fl-conflict-card')).toBeVisible()
  await expect(window.locator('.fl-conflict-row')).toHaveCount(1)
  await expect(window.locator('.fl-conflict-choice')).toHaveText('Accept Incoming')

  // Nothing decided yet — no responder call recorded.
  expect(await window.evaluate(() => (window as unknown as { __conflictDecisions: string[] }).__conflictDecisions)).toEqual([])

  // Accept the row → the responder records it and the row collapses to "Accepted".
  await window.locator('.fl-conflict-row-actions fl-button').filter({ hasText: 'Accept' }).first().click()
  await expect(window.locator('.fl-conflict-row-resolution')).toHaveText('Accepted', { timeout: 10000 })
  expect(
    await window.evaluate(() => (window as unknown as { __conflictDecisions: string[] }).__conflictDecisions),
  ).toEqual(['notes.txt#hunk-1:accept'])

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

/**
 * The remaining gap: the FULL wiring RESOLVE_CONFLICT_EVENT → sendMessage → the
 * turn's stream `done` → parseProposals → CONFLICT_REVIEW_EVENT. Driving it end to
 * end still needs a hermetic AGENT-TURN stub (a canned assistant reply delivered as
 * the reply to the resolve prompt, without a live model call). The two tests above
 * already pin both user-visible halves (raw JSON suppressed; card mounts + applies),
 * so this covers only the send/await plumbing between them.
 */
test.fixme(
  'Resolve with AI drives the full turn→parse→card wiring (needs an agent-turn stub seam)',
  async ({ window }) => {
    expect(window).toBeTruthy()
  },
)

/**
 * Agent-clash reconstruction (wave-execution) — STUBBED (honest gap, carried from
 * the v1 spec).
 *
 * The agent-clash surface (git-manager.synthesizeClashConflict + the
 * git:listAgentClashes / git:readAgentClash / git:reconcileAgentClash IPC channels)
 * reconstructs a conflict between two wave sub-agents that edited the same file in
 * parallel. Unlike a merge conflict, that state is NOT produced by any git command
 * against a seeded repo — it needs a live wave-execution run (two isolated Agent
 * sub-agents + a synthesized clash record), unreachable from a credential-less
 * headless E2E launch.
 *
 * When a hermetic seam for injecting a synthesized clash lands, this spec should
 * register a clash via an E2E IPC hook, open it in the resolver, assert the two
 * sides show each AGENT'S identity (never ours/theirs), resolve it, and assert
 * reconcileAgentClash stages the merged content and the clash drops out of
 * git:listAgentClashes.
 */
test.fixme(
  'agent-clash reconstruction shows per-agent identities and reconciles (needs wave-state seam)',
  async ({ window }) => {
    // Intentionally unimplemented — see the block comment above. Kept as a typed
    // skeleton so the intended surface + assertions are documented in-code.
    expect(window).toBeTruthy()
  },
)
