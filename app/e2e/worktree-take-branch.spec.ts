import { test, expect } from './fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from './ux/fixtures/seed'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.afterAll(() => cleanupSeeds())

test('a name that is already a branch is TAKEN, not created twice', async ({ window }) => {
  test.setTimeout(300_000)
  let dir = ''
  const root = await seedProject(window, 'orbit-app-', (d) => {
    dir = d
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: d })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: d })
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: d })
    writeFileSync(join(d, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: d })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: d })
    execFileSync('git', ['branch', 'existing-work'], { cwd: d })
  })
  await activateProject(window, root)
  const threadId = await window.evaluate(async (p: string) => {
    const flow = (window as unknown as {
      flow: { threads: { create(r: { projectRoot: string; title: string }): Promise<{ id: string }> } }
    }).flow
    return (await flow.threads.create({ projectRoot: p, title: 'Take it' })).id
  }, root)
  await window.evaluate((id: string) => {
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: id } }))
  }, threadId)
  await window.locator('[data-rail-item="files"]').click()
  await window.locator('.fl-wt-track').click()
  const ask = window.locator('.fl-wt-ask')
  await expect(ask).toBeVisible({ timeout: 30_000 })
  await ask.locator('input[type="text"]').fill('existing-work')
  await expect(ask).toContainText('already exists', { timeout: 10_000 })
  await ask.locator('button', { hasText: 'Create' }).click()
  await expect(window.locator('.fl-wt-track')).toHaveAttribute('data-on', 'true', {
    timeout: 120_000,
  })

  // THE POINT: the checkout is ON that branch, and git did not refuse to make
  // a ref it already had.
  const record = await window.evaluate(async (id: string) => {
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
  expect(record.branch).toBe('existing-work')
  const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: record.path,
  })
    .toString()
    .trim()
  expect(head).toBe('existing-work')
  // …and the branch was not duplicated.
  const branches = execFileSync('git', ['branch', '--list', 'existing-work*'], { cwd: dir })
    .toString()
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
  expect(branches).toHaveLength(1)
})
