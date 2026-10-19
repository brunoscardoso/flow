/**
 * A guard on the number of PROCESSES, not the shape of the answer.
 *
 * `fileAuthors` used to spawn `git log -1 -- <path>` for every path it was
 * given, all at once. A V8 profile of the main process while this repository
 * was added found 93% of its CPU inside posix_spawn, and the spawn census
 * printed the rest of the sentence: `1145 processes in 10s — log ×1130`, with
 * the process reporting itself blocked for 10.7 seconds.
 *
 * The answer it produced was correct, and the tests that covered the answer all
 * passed. What was wrong was how many children it forked to get there — which
 * no assertion about the answer can catch. This one counts them.
 */
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { GitManager, type GitRootsProvider } from './git-manager'

const noopRoots: GitRootsProvider = {
  getRoots: () => [],
  onRootsChanged: () => () => undefined,
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('fileAuthors does not fork per file', () => {
  let repo: string
  let manager: GitManager
  const names: string[] = []

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-git-budget-'))
    git(repo, 'init')
    git(repo, 'config', 'user.email', 'me@here.com')
    git(repo, 'config', 'user.name', 'Me')
    names.length = 0
    for (let i = 0; i < 60; i += 1) {
      const name = `file-${String(i)}.txt`
      names.push(name)
      writeFileSync(join(repo, name), `v ${String(i)}\n`, 'utf8')
    }
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'sixty files')
    manager = new GitManager(noopRoots)
  })

  afterEach(async () => {
    await manager.dispose()
    rmSync(repo, { recursive: true, force: true })
  })

  it('answers sixty files with a handful of processes, not sixty', async () => {
    // The count comes from the manager's own census, which is what the app
    // reports about itself — the same number a slow-log line would carry.
    const before = manager.gitProcessesSpawnedForTests()
    const authors = await manager.fileAuthors(repo, names)
    const spawned = manager.gitProcessesSpawnedForTests() - before

    // THE COUNT FIRST — it is what this test exists for, and a failure should
    // name the forking rather than whatever the forking happened to return.
    // One rev-parse to anchor the repo, one walk. A budget, not an exact
    // number: the point is that it does not grow with the file count.
    expect(spawned).toBeLessThanOrEqual(4)
    expect(authors.size).toBe(60)
  })
})
