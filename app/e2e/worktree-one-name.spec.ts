import { test, expect } from './fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './ux/fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.afterAll(() => cleanupSeeds())

test('the folder wears its prefix, and the branch follows it', async ({ window }) => {
  test.setTimeout(300_000)
  const root = await seedProject(window, 'orbit-app-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
    // A branch this project already has — the case the advice is about.
    execFileSync('git', ['branch', 'existing-work'], { cwd: dir })
  })
  await activateProject(window, root)
  const threadId = await window.evaluate(async (p: string) => {
    const flow = (window as unknown as {
      flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> } }
    }).flow
    return (await flow.threads.create({ projectRoot: p, title: 'Data Contract Guard' })).id
  }, root)
  await window.evaluate((id: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
  }, threadId)
  await window.locator('[data-rail-item="files"]').click()
  await window.locator('.fl-wt-track').click()
  const ask = window.locator('.fl-wt-ask')
  await expect(ask).toBeVisible({ timeout: 30_000 })

  // ONE field, with the prefix drawn beside it rather than explained under it.
  await expect(ask.locator('input[type="text"]')).toHaveCount(1)
  await expect(ask.locator('.fl-wt-fixed')).toHaveText('worktree/')
  await expect(ask.locator('input[type="text"]')).toHaveValue('data-contract-guard')
  // …and the branch the same word produces, on one muted line.
  await expect(ask.locator('.fl-wt-branch')).toContainText('data-contract-guard')

  // The link splits them, pre-filled with what the linked pair was about to do.
  await ask.locator('.fl-wt-link').click()
  await expect(ask.locator('input[type="text"]')).toHaveCount(2)
  await expect(ask.locator('input[type="text"]').first()).toHaveValue('data-contract-guard')
  await expect(ask.locator('input[type="text"]').last()).toHaveValue('data-contract-guard')

  // ALREADY A BRANCH: advice, not a refusal, and the Create stays available.
  await ask.locator('input[type="text"]').last().fill('existing-work')
  await expect(ask).toContainText('already exists', { timeout: 10_000 })
  await expect(ask.locator('button', { hasText: 'Create' })).toBeEnabled()

  // One word, two things.
  await ask.locator('input[type="text"]').first().fill('parser-rewrite')
  await ask.locator('input[type="text"]').last().fill('parser-rewrite')
  await ask.locator('button', { hasText: 'Create' }).click()
  await expect(window.locator('.fl-wt-track')).toHaveAttribute('data-on', 'true', {
    timeout: 120_000,
  })
  const outcome = await window.evaluate(async (id: string) => {
    const flow = (window as unknown as {
      flow: {
        threads: {
          get(r: { threadId: string }): Promise<{
            worktreePath: string | null
            worktreeBranch: string | null
          } | null>
        }
      }
    }).flow
    const t = await flow.threads.get({ threadId: id })
    return { path: t?.worktreePath ?? '', branch: t?.worktreeBranch ?? '' }
  }, threadId)
  expect(outcome.path.endsWith('/worktree/parser-rewrite')).toBe(true)
  expect(outcome.branch).toBe('parser-rewrite')
})
