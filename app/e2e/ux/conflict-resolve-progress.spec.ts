/**
 * Resolve-with-AI must SHOW that it is running (#1134).
 *
 * "Resolve all with AI" fired and then sat there unchanged for the whole agent
 * turn — the button looked idle while a turn was running, so the only feedback
 * was the chat scrolling somewhere else, and there was no way to stop the turn
 * from the place you started it.
 *
 * Seeds a real conflict, opens Source Control, and drives the section-level
 * control: it must become a spinner, gain a Stop beside it once the turn is
 * with the agent, and return to the plain action when Stop lands. Deterministic
 * and credential-less — the phase is announced by the orchestration itself, so
 * this never depends on an agent actually replying.
 */
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { statusButtonByText } from '../selectors'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(dir: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd: dir }).toString()
}

/** A repo mid-merge with one conflicted file (the Merge Changes section's
 *  precondition — the control only renders with resolvable conflicts). */
function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-resolve-progress-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  const file = 'notes.txt'
  const body = (v: string): string => ['intro', v, 'outro', ''].join('\n')
  writeFileSync(join(dir, file), body('base'))
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', 'base')
  const main = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(dir, 'checkout', '-q', '-b', 'topic-blue')
  writeFileSync(join(dir, file), body('blue'))
  git(dir, 'commit', '-q', '-am', 'blue')
  git(dir, 'checkout', '-q', main)
  writeFileSync(join(dir, file), body('trunk'))
  git(dir, 'commit', '-q', '-am', 'trunk')
  try {
    git(dir, 'merge', 'topic-blue')
  } catch {
    /* the conflict is the point */
  }
  return dir
}

test('the Resolve-with-AI control shows the run and offers Stop (#1134)', async ({
  window,
}: {
  window: Page
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

  const dir = seed()
  await window.evaluate(async (p) => {
    await (window as { flow: { project: { add(a: { path: string }): Promise<unknown> } } }).flow.project.add(
      { path: p },
    )
  }, dir)
  await activateProject(window, dir)
  await window.locator(statusButtonByText('Source Control')).click()

  const resolveAll = window.locator('.gp-action-resolve')
  await expect(resolveAll).toBeVisible({ timeout: 10_000 })
  // Idle: the plain action, no spinner, no Stop.
  await expect(resolveAll).toHaveText('Resolve all with AI')
  await expect(window.locator('.gp-resolve-spinner')).toHaveCount(0)
  await expect(window.locator('.gp-action-resolve-stop')).toHaveCount(0)

  // Running with the agent: spinner + Stop. Driven through the orchestration's
  // own phase event, so no credentials and no real turn are needed.
  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:conflict-resolve-state', {
        detail: { phase: 'resolving', threadId: 'thread-under-test' },
      }),
    )
  })
  await expect(window.locator('.gp-resolve-spinner')).toBeVisible()
  await expect(resolveAll).toContainText('Resolving…')
  // Busy is not a second entry point — re-firing would supersede the run it
  // is reporting on.
  await expect(resolveAll).toBeDisabled()
  const stop = window.locator('.gp-action-resolve-stop')
  await expect(stop).toBeVisible()

  // During the gather there is no turn yet, so no Stop is offered.
  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:conflict-resolve-state', { detail: { phase: 'gathering' } }),
    )
  })
  await expect(window.locator('.gp-resolve-spinner')).toBeVisible()
  await expect(window.locator('.gp-action-resolve-stop')).toHaveCount(0)

  // Stop asks the orchestration to interrupt, and the control returns to idle.
  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:conflict-resolve-state', {
        detail: { phase: 'resolving', threadId: 'thread-under-test' },
      }),
    )
  })
  const stopped = window.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        document.addEventListener('flow:conflict-resolve-stop', () => resolve(true), { once: true })
        setTimeout(() => resolve(false), 5000)
      }),
  )
  await window.locator('.gp-action-resolve-stop').click()
  expect(await stopped, 'Stop asked the orchestration to interrupt').toBe(true)
  await expect(window.locator('.gp-resolve-spinner')).toHaveCount(0)
  await expect(resolveAll).toHaveText('Resolve all with AI')

  expect(errors, `renderer errors during resolve-progress flow:\n${errors.join('\n')}`).toEqual([])
})
