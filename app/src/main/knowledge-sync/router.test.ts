/**
 * WHICH WORKSPACE CARRIES A PROJECT — over the REAL registry and the REAL
 * Workspace engine, both driven by one fake CLI: a table keyed by argv that
 * THROWS on anything unexpected (allowed-pattern #24). There is no
 * per-project sync any more (the hard migration, 2026-10-06).
 */

import { createWorkspaceRegistry, type WorkspaceCliRun, type WorkspaceSettings } from '../workspaces/workspace-registry'
import { createKnowledgeRouter, createWorkspaceRoute } from './router'
import type { EngineTimers } from './sync-timing'
import { TURN_SYNC_DELAY_MS, createWorkspaceSyncEngine } from './workspace-sync-engine'

const API = '/code/api'
const WEB = '/code/web'
const SOLO = '/code/solo'
const HOME = '/home/dev'
const SLUG = 'acme'

class FakeTimers implements EngineTimers {
  readonly tasks = new Map<number, () => void>()
  private seq = 0
  setTimeout(callback: () => void): unknown {
    this.seq += 1
    this.tasks.set(this.seq, callback)
    return this.seq
  }
  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }
  async fireAll(): Promise<void> {
    for (const [id, fn] of [...this.tasks.entries()]) {
      this.tasks.delete(id)
      fn()
    }
    await settled()
  }
}

async function settled(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await new Promise((resolve) => setImmediate(resolve))
}

function project(slug: string, localPath: string) {
  return {
    id: `github.com/acme/${slug}`,
    name: slug,
    slug,
    remotes: [`git@github.com:acme/${slug}.git`],
    description: null,
    localPath,
    flowPath: `/flow/workspaces/acme/projects/${slug}`,
  }
}

/** The ONE listing every membership question is answered from (`workspace status`). */
function listing(projects: Array<{ slug: string; localPath: string }>): string {
  return JSON.stringify({
    action: 'status',
    flowFolder: '/flow',
    workspaces: [
      {
        name: 'Acme',
        slug: SLUG,
        path: '/flow/workspaces/acme',
        remote: null,
        projects: projects.map((entry) => project(entry.slug, entry.localPath)),
      },
    ],
    unreadable: [],
  })
}

const LIST_ARGV = 'workspace status --json'
const API_AND_WEB = listing([
  { slug: 'api', localPath: API },
  { slug: 'web', localPath: WEB },
])

const SYNCED = JSON.stringify({
  action: 'sync',
  workspace: { name: 'Acme', slug: SLUG, path: '/flow/workspaces/acme' },
  branch: 'main',
  remote: null,
  state: 'synced',
  committed: null,
  pulled: 0,
  pushed: true,
  ahead: 0,
  merge: null,
  resolutions: [],
  asks: [],
  reviews: [],
  decided: [],
  skipped: [],
  indexes: { rebuilt: [], failed: [] },
})

const SYNC_ARGV = `workspace sync --workspace ${SLUG} --json`

function harness(options: { linked?: readonly string[] } = {}) {
  const table = new Map<string, string[]>()
  const cliCalls: string[] = []
  const runCli = async (_cwd: string, args: readonly string[]): Promise<WorkspaceCliRun> => {
    const key = args.filter((arg) => !arg.startsWith('--message=')).join(' ')
    cliCalls.push(key)
    const next = table.get(key)?.shift()
    if (next === undefined) throw new Error(`unexpected CLI call: ${key}`)
    return { ok: true, stdout: `${next}\n` }
  }
  const answer = (key: string, ...lines: string[]): void => {
    table.set(key, [...(table.get(key) ?? []), ...lines])
  }
  const settings: WorkspaceSettings = {
    getCurrentWorkspace: () => null,
    setCurrentWorkspace: () => undefined,
  }
  const registry = createWorkspaceRegistry({
    runCli,
    settings,
    homeDir: HOME,
    log: () => undefined,
    // A linked project's `<root>/flow` resolves into its Workspace project folder.
    realpath: async (path) => {
      const root = path.endsWith('/flow') ? path.slice(0, -'/flow'.length) : null
      if (root !== null && (options.linked ?? []).includes(root)) {
        return `/flow/workspaces/acme/projects/${root.split('/').pop()}`
      }
      return path
    },
  })
  const timers = new FakeTimers()
  const workspaces = createWorkspaceSyncEngine({
    nameOf: async () => null,
    runCli: (cwd, args) => runCli(cwd, args),
    cwd: HOME,
    lastSynced: { get: () => null, set: () => undefined },
    writeTempText: async () => {
      throw new Error('no decisions here')
    },
    now: () => 0,
    timers,
    onStatus: () => undefined,
    log: () => undefined,
  })
  const router = createKnowledgeRouter({
    workspaces,
    route: createWorkspaceRoute({ registry, log: () => undefined }),
  })
  return { router, answer, cliCalls, timers }
}

const label = (root: string): string => `turn in ${root.split('/').pop()}`

describe('the knowledge router', () => {
  it('a project in a Workspace → `workspace sync --workspace <slug>`', async () => {
    const h = harness({ linked: [API] })
    h.answer(LIST_ARGV, API_AND_WEB)
    h.answer(SYNC_ARGV, SYNCED)
    await h.router.open(API)
    expect(h.cliCalls).toEqual([LIST_ARGV, SYNC_ARGV])
  })

  it('a project listed in a Workspace syncs with it even before its flow link resolves', async () => {
    const h = harness()
    h.answer(LIST_ARGV, API_AND_WEB)
    h.answer(SYNC_ARGV, SYNCED)
    await h.router.open(API)
    expect(h.cliCalls).toEqual([LIST_ARGV, SYNC_ARGV])
  })

  it('a project in no Workspace (its move waits on a person) has nothing to sync — no sync is started', async () => {
    // POSITIVE FIRST (allowed-pattern #28): a project of the Workspace DOES sync.
    const on = harness({ linked: [API] })
    on.answer(LIST_ARGV, API_AND_WEB)
    on.answer(SYNC_ARGV, SYNCED)
    await on.router.open(API)
    expect(on.cliCalls).toContain(SYNC_ARGV)

    const h = harness()
    h.answer(LIST_ARGV, API_AND_WEB)
    await h.router.open(SOLO)
    await h.router.commitAfterTurn(SOLO, [], label)
    await h.timers.fireAll()
    expect(h.cliCalls.filter((call) => call.startsWith('workspace sync'))).toEqual([])
  })

  it('a thread that touched two projects of one Workspace, over N turns → ONE sync', async () => {
    const h = harness({ linked: [API, WEB] })
    h.answer(LIST_ARGV, API_AND_WEB)
    h.answer(SYNC_ARGV, SYNCED)
    await h.router.commitAfterTurn(API, [WEB], label)
    // ONE membership read for the turn, whatever the number of projects —
    // never a `workspace status --target` per root.
    expect(h.cliCalls).toEqual([LIST_ARGV])
    await h.router.commitAfterTurn(API, [WEB], label)
    await h.router.commitAfterTurn(API, [WEB], label)
    expect(h.timers.tasks.size).toBe(1)
    await h.timers.fireAll()
    expect(h.cliCalls.filter((call) => call === SYNC_ARGV)).toHaveLength(1)
    expect(TURN_SYNC_DELAY_MS).toBeGreaterThan(0)
  })

  it('quit runs the Workspace engine and asks nothing when nothing is waiting', async () => {
    const h = harness()
    await h.router.quit()
    expect(h.cliCalls).toEqual([])
  })
})
