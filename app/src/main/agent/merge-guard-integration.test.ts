// Merge guard, end to end (#1135) — a REAL conflicted git repo behind the real
// GitManager probe, driving the real PermissionBroker gate. The unit tests pin
// the command vocabulary; this one pins the seam the user actually hit: a
// standing `Bash(git)` allow rule plus a mid-merge repo must still stop and ask
// before the agent stages or commits the resolution.

import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

import type { PermissionRequest } from '../../shared/ipc-contract'
import { GitManager, type GitRootsProvider } from '../git/git-manager'
import { openDatabase, type FlowDatabase } from '../store/db'
import { PermissionBroker, PERMISSION_REQUEST_EVENT } from './permissions'

const noopRoots: GitRootsProvider = {
  getRoots: () => [],
  onRootsChanged: () => () => undefined,
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

describe('merge guard against a real conflicted repo', () => {
  let repo: string
  let dbDir: string
  let db: FlowDatabase
  let broker: PermissionBroker
  let manager: GitManager
  let requests: PermissionRequest[]

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-merge-guard-'))
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '-m', 'base')

    git(repo, 'checkout', '-b', 'feature')
    writeFileSync(join(repo, 'a.txt'), 'theirs\n')
    git(repo, 'commit', '-am', 'theirs')

    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'a.txt'), 'ours\n')
    git(repo, 'commit', '-am', 'ours')
    try {
      git(repo, 'merge', 'feature')
    } catch {
      // Expected — the merge conflicts, which is the state under test.
    }

    dbDir = mkdtempSync(join(tmpdir(), 'flow-merge-guard-db-'))
    db = openDatabase(join(dbDir, 'flow.sqlite'))
    broker = new PermissionBroker(db)
    manager = new GitManager(noopRoots)
    broker.setMergeStateProbe(async (rootPath) => {
      const state = await manager.getMergeState(rootPath)
      return state.op !== 'none' || state.unmergedPaths.length > 0
    })
    // The user's standing rule: "always allow git".
    db.prepare(
      `INSERT INTO permission_rules (id, project_root, tool_name, pattern, verdict, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), repo, 'Bash', 'git', 'allow', new Date().toISOString())

    requests = []
    broker.on(PERMISSION_REQUEST_EVENT, (request: PermissionRequest) => requests.push(request))
  })

  afterEach(() => {
    db.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  })

  async function call(command: string): Promise<'asked' | 'allowed'> {
    const before = requests.length
    const canUseTool = broker.createCanUseTool('thread-1', [repo])
    const pending = canUseTool(
      'Bash',
      { command },
      { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'req-1' },
    )
    // The probe shells out to git, so a single tick is not enough to know
    // whether this call parked — poll briefly for a NEW request.
    for (let attempt = 0; attempt < 100 && requests.length === before; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (requests.length > before) {
      broker.respond(requests[requests.length - 1].requestId, 'deny')
      await pending
      return 'asked'
    }
    const result = await pending
    expect(result).toMatchObject({ behavior: 'allow' })
    return 'allowed'
  }

  it('confirms the fixture really is mid-merge', async () => {
    const state = await manager.getMergeState(repo)
    expect(state.op).toBe('merge')
    expect(state.unmergedPaths).toContain('a.txt')
  })

  it('stops the agent from staging or committing the resolution', async () => {
    await expect(call('git add a.txt')).resolves.toBe('asked')
    await expect(call('git commit -m "resolved"')).resolves.toBe('asked')
    await expect(call('git merge --continue')).resolves.toBe('asked')
    await expect(call('git merge --abort')).resolves.toBe('asked')
  })

  it('still lets the agent inspect the conflict without asking', async () => {
    await expect(call('git status')).resolves.toBe('allowed')
    await expect(call('git diff')).resolves.toBe('allowed')
  })

  it('goes back to auto-allow once the merge is finished', async () => {
    git(repo, 'checkout', '--ours', 'a.txt')
    git(repo, 'add', 'a.txt')
    git(repo, 'commit', '--no-edit')

    await expect(call('git commit -m "ordinary work"')).resolves.toBe('allowed')
  })
})
