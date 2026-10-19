import { test, expect } from '../fixtures/electron'
import { activateProject } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConflictHunks } from '../../src/shared/conflict-hunks'

/**
 * The apply path behind a review card's Accept button, driven without an agent
 * turn: `git:resolveConflictHunk` with an id derived by the SAME shared parser
 * the proposals are shaped with.
 *
 * Reported symptom: every row of a live review card answered "Failed to record
 * decision — try again". That message covers two very different situations —
 * broken plumbing (nothing would ever apply) and a hunk that no longer exists in
 * the working file (the proposals went stale). This spec pins the first: a
 * freshly-parsed hunk MUST apply. The stale case is asserted at the bottom, since
 * that is what the card has to explain rather than swallow.
 */

const seededDirs: string[] = []

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString()
}

function seedConflictRepo(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-accept-'))
  seededDirs.push(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'qa@flow.test')
  git(dir, 'config', 'user.name', 'QA Bot')
  const file = 'flags.py'
  writeFileSync(join(dir, file), 'FLAGS = ["base"]\n')
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', 'base')
  const main = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
  git(dir, 'checkout', '-q', '-b', 'topic')
  writeFileSync(join(dir, file), 'FLAGS = ["playbook_scopes"]\n')
  git(dir, 'commit', '-q', '-am', 'topic')
  git(dir, 'checkout', '-q', main)
  writeFileSync(join(dir, file), 'FLAGS = ["chat_persistence"]\n')
  git(dir, 'commit', '-q', '-am', 'trunk')
  try {
    git(dir, 'merge', 'topic')
  } catch {
    // Expected — the tree now carries markers.
  }
  return { dir, file }
}

test.afterAll(() => {
  for (const dir of seededDirs) rmSync(dir, { recursive: true, force: true })
})

test('accepting a proposal applies its hunk — and a stale hunk id reports, never silently succeeds', async ({
  window,
}) => {
  const { dir, file } = seedConflictRepo()
  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(window, dir)

  // The markered working text the proposals are shaped from.
  const read = await window.evaluate(
    async ({ rootId, filePath }) =>
      (
        window as unknown as {
          flow: {
            git: {
              readConflicted(i: {
                rootId: string
                filePath: string
              }): Promise<{ markered?: string }>
            }
          }
        }
      ).flow.git.readConflicted({ rootId, filePath }),
    { rootId: dir, filePath: file },
  )
  expect(read.markered).toContain('<<<<<<<')

  const hunks = parseConflictHunks(read.markered!)
  expect(hunks).toHaveLength(1)
  const hunkId = hunks[0].hunkId

  // Accept → the exact call the card's Accept button ends in.
  const applied = await window.evaluate(
    async ({ rootId, filePath, hunkId }) =>
      (
        window as unknown as {
          flow: {
            git: {
              resolveConflictHunk(i: {
                rootId: string
                filePath: string
                hunkId: string
                choice: string
                order?: string
              }): Promise<{ matched: boolean; remainingConflicts: number; staged: boolean }>
            }
          }
        }
      ).flow.git.resolveConflictHunk({ rootId, filePath, hunkId, choice: 'both' }),
    { rootId: dir, filePath: file, hunkId },
  )
  expect(applied.matched).toBe(true)
  expect(applied.remainingConflicts).toBe(0)
  expect(applied.staged).toBe(true)

  const resolved = readFileSync(join(dir, file), 'utf8')
  expect(resolved).not.toContain('<<<<<<<')
  expect(resolved).toContain('chat_persistence')
  expect(resolved).toContain('playbook_scopes')

  // A stale id (the hunk is gone now) must answer matched:false — the signal the
  // card has to turn into "these proposals are stale", not a bare retry prompt.
  const stale = await window.evaluate(
    async ({ rootId, filePath, hunkId }) =>
      (
        window as unknown as {
          flow: {
            git: {
              resolveConflictHunk(i: {
                rootId: string
                filePath: string
                hunkId: string
                choice: string
              }): Promise<{ matched: boolean }>
            }
          }
        }
      ).flow.git.resolveConflictHunk({ rootId, filePath, hunkId, choice: 'both' }),
    { rootId: dir, filePath: file, hunkId },
  )
  expect(stale.matched).toBe(false)
})
