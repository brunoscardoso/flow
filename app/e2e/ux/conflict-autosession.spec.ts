/**
 * Resolve-with-AI must not require a chat session to already be open: with none
 * selected, firing it auto-creates + selects one to resolve into. Seeds a real
 * conflict (no thread selected), fires flow:resolve-conflict, and asserts a thread
 * becomes active + the composer mounts. Deterministic + credential-less — the agent
 * turn's send may fail without creds, but that happens AFTER the session is created,
 * which is what this guards.
 */
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { AGENT_AUTH_ISOLATED } from './fixtures/worktree'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(dir: string, ...a: string[]): string {
  return execFileSync('git', a, { cwd: dir }).toString()
}
function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-autosess-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  const file = 'notes.txt'
  const body = (v: string) => ['intro', v, 'outro', ''].join('\n')
  writeFileSync(join(dir, file), body('base')); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', 'base')
  const main = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(dir, 'checkout', '-q', '-b', 'topic-blue')
  writeFileSync(join(dir, file), body('blue')); git(dir, 'commit', '-q', '-am', 'blue')
  git(dir, 'checkout', '-q', main)
  writeFileSync(join(dir, file), body('trunk')); git(dir, 'commit', '-q', '-am', 'trunk')
  try { git(dir, 'merge', 'topic-blue') } catch { /* conflict */ }
  return dir
}

// The resolution prompt is really sent — never to the developer's own account.
test.use({ appEnv: AGENT_AUTH_ISOLATED })

test('Resolve with AI with no session open auto-creates a session', async ({ window }: { window: Page }) => {
  const dir = seed()
  await window.evaluate(async (p) => { await (window as any).flow.project.add({ path: p }) }, dir)
  await activateProject(window, dir)
  await window.locator('.fl-activity-bar .fl-rail-item[aria-label="Threads"]').click()

  const result = await window.evaluate(async () => {
    const activeIds: (string | null)[] = []
    document.addEventListener('flow:active-thread', (e) =>
      activeIds.push((e as CustomEvent<{ threadId: string | null }>).detail?.threadId ?? null),
    )
    // Snapshot: no session before (fresh repo → composer hidden, no non-null id yet).
    const composerBefore = !!document.querySelector('.fl-composer')
    const nonNullBefore = activeIds.filter(Boolean).length

    document.dispatchEvent(new CustomEvent('flow:resolve-conflict', { detail: { filePath: 'notes.txt' } }))
    await new Promise((r) => setTimeout(r, 6000)) // create + select (agent send may fail w/o creds — fine)

    return {
      composerBefore,
      nonNullBefore,
      composerAfter: !!document.querySelector('.fl-composer'),
      nonNullAfter: activeIds.filter(Boolean).length,
    }
  })

  // Auto-creation: a thread became active (non-null flow:active-thread) that wasn't
  // there before, and the composer (only present inside an open session) mounted.
  expect(result.nonNullBefore, 'no session active before').toBe(0)
  expect(result.nonNullAfter, 'a session became active after Resolve with AI').toBeGreaterThan(0)
  expect(result.composerAfter, 'composer mounted (a session is open)').toBe(true)
})
