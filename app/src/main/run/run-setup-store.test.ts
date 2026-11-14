// Run setup store — real temp folders for the shared file (including a Flow
// folder that is a link, as in a Workspace), in-memory fakes for the
// conversation and personal layers.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { RunSetup, RunTweaks, RunTweaksByProject } from '../../shared/run-setup'
import {
  nodeRunStoreFs,
  RunSetupError,
  RunSetupStore,
  sharedSetupPath,
  type RunPersonalSource,
  type RunThreadSource,
} from './run-setup-store'

interface FakeThread {
  projectRoot: string
  worktreePath: string | null
  roots: string[]
  rootWorktrees: Array<{ rootPath: string; worktreePath: string }>
  tweaks: RunTweaksByProject
}

function fakeThreads(threads: Record<string, FakeThread>): RunThreadSource {
  return {
    getThread: (id) => threads[id] ?? null,
    getThreadRoots: (id) => threads[id]?.roots ?? [],
    getThreadRootWorktrees: (id) => threads[id]?.rootWorktrees ?? [],
    getRunTweaks: (id) => threads[id]?.tweaks ?? {},
    setRunTweaks: (id, tweaks) => {
      const thread = threads[id]
      if (thread === undefined) throw new Error('unknown thread')
      thread.tweaks = tweaks
    },
  }
}

function fakePersonal(): RunPersonalSource & { rows: Map<string, RunTweaks> } {
  const rows = new Map<string, RunTweaks>()
  return {
    rows,
    getRunTweaks: (root) => rows.get(root) ?? {},
    setRunTweaks: (root, tweaks) => {
      rows.set(root, tweaks)
      return tweaks
    },
  }
}

const SETUP: RunSetup = {
  version: 1,
  steps: [
    { id: 'db', name: 'Database', command: 'docker compose up db', start: 'now', ready: { kind: 'port', port: 5432 } },
    { id: 'web', name: 'Web', command: 'npm run dev', start: 'after-previous' },
  ],
}

describe('RunSetupStore', () => {
  let dir: string
  let shop: string
  let api: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-run-store-'))
    shop = join(dir, 'shop')
    api = join(dir, 'api')
    mkdirSync(join(shop, 'flow'), { recursive: true })
    // api's Flow folder is a LINK into a Workspace folder, as after the migration.
    const workspaceProject = join(dir, 'workspaces', 'acme', 'projects', 'api')
    mkdirSync(workspaceProject, { recursive: true })
    mkdirSync(api)
    symlinkSync(workspaceProject, join(api, 'flow'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function store(threads: Record<string, FakeThread> = {}, personal = fakePersonal()): RunSetupStore {
    return new RunSetupStore({ fs: nodeRunStoreFs(), threads: fakeThreads(threads), personal })
  }

  it('a project with no shared setup resolves to no steps, and says so', async () => {
    const resolution = await store().resolve({ rootPath: shop, threadId: null })
    expect(resolution.scopeKey).toBe(`${shop}::`)
    expect(resolution.projects).toHaveLength(1)
    expect(resolution.projects[0]).toMatchObject({ root: shop, name: 'shop', cwd: shop, hasSharedSetup: false, setup: null })
    expect(resolution.steps).toEqual([])
  })

  it('writes the shared setup atomically through a linked Flow folder, leaving no temp file', async () => {
    const s = store()
    await s.save({ rootPath: api, threadId: null }, { layer: 'shared', projectRoot: api, setup: SETUP })
    const linkedTarget = join(dir, 'workspaces', 'acme', 'projects', 'api', 'run')
    expect(readdirSync(linkedTarget)).toEqual(['setup.json'])
    expect(JSON.parse(readFileSync(sharedSetupPath(api), 'utf8'))).toMatchObject({ version: 1, steps: [{ id: 'db' }, { id: 'web' }] })
    const resolution = await s.resolve({ rootPath: api, threadId: null })
    expect(resolution.steps.map((step) => step.key)).toEqual([`${api}::db`, `${api}::web`])
  })

  it('refuses to create a Flow folder for a project that has none', async () => {
    const bare = join(dir, 'bare')
    mkdirSync(bare)
    await expect(
      store().save({ rootPath: bare, threadId: null }, { layer: 'shared', projectRoot: bare, setup: SETUP }),
    ).rejects.toBeInstanceOf(RunSetupError)
    expect(readdirSync(bare)).toEqual([])
  })

  it('a malformed shared file reads with problems, never throws', async () => {
    mkdirSync(join(shop, 'flow', 'run'))
    writeFileSync(sharedSetupPath(shop), '{"steps":[{"name":"x"}]}')
    const resolution = await store().resolve({ rootPath: shop, threadId: null })
    expect(resolution.steps).toEqual([])
    expect(resolution.projects[0]?.problems).toHaveLength(1)
  })

  it('layers resolve in order: shared, then personal, then the conversation', async () => {
    const personal = fakePersonal()
    const threads: Record<string, FakeThread> = {
      t1: { projectRoot: shop, worktreePath: null, roots: [], rootWorktrees: [], tweaks: {} },
    }
    const s = store(threads, personal)
    await s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: shop, setup: SETUP })
    await s.save({ rootPath: shop, threadId: null }, { layer: 'personal', projectRoot: shop, tweaks: { web: { command: 'npm run dev -- -p 3100' }, db: { skip: true } } })
    await s.save({ rootPath: shop, threadId: 't1' }, { layer: 'conversation', projectRoot: shop, tweaks: { db: { skip: false, ready: null } } })

    const mine = await s.resolve({ rootPath: shop, threadId: null })
    expect(mine.steps.map((step) => step.id)).toEqual(['web'])
    expect(mine.steps[0]).toMatchObject({ command: 'npm run dev -- -p 3100', from: { command: 'personal' } })

    const conversation = await s.resolve({ rootPath: shop, threadId: 't1' })
    expect(conversation.steps.map((step) => step.id)).toEqual(['db', 'web'])
    expect(conversation.steps[0]?.ready).toBeUndefined()
    expect(conversation.steps[0]?.from.ready).toBe('conversation')
  })

  it('tweaks survive a reorder of the shared steps (keyed by step id, not position)', async () => {
    const personal = fakePersonal()
    const s = store({}, personal)
    await s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: shop, setup: SETUP })
    await s.save({ rootPath: shop, threadId: null }, { layer: 'personal', projectRoot: shop, tweaks: { web: { command: 'pnpm dev' } } })
    await s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: shop, setup: { version: 1, steps: [SETUP.steps[1]!, SETUP.steps[0]!] } })
    const resolution = await s.resolve({ rootPath: shop, threadId: null })
    expect(resolution.steps.map((step) => [step.id, step.command])).toEqual([
      ['web', 'pnpm dev'],
      ['db', 'docker compose up db'],
    ])
  })

  it("a conversation's checkouts are the working folders, primary first, then its other projects", async () => {
    const threads: Record<string, FakeThread> = {
      t1: {
        projectRoot: shop,
        worktreePath: join(dir, '.shop-threads', 'blue'),
        roots: [api],
        rootWorktrees: [{ rootPath: api, worktreePath: join(dir, '.api-threads', 'blue') }],
        tweaks: {},
      },
      t2: { projectRoot: shop, worktreePath: null, roots: [api], rootWorktrees: [], tweaks: {} },
    }
    const s = store(threads)
    await s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: shop, setup: SETUP })
    await s.save({ rootPath: api, threadId: null }, { layer: 'shared', projectRoot: api, setup: { version: 1, steps: [SETUP.steps[1]!] } })

    const isolated = await s.resolve({ rootPath: shop, threadId: 't1' })
    expect(isolated.steps.map((step) => [step.key, step.cwd])).toEqual([
      [`${shop}::db`, join(dir, '.shop-threads', 'blue')],
      [`${shop}::web`, join(dir, '.shop-threads', 'blue')],
      [`${api}::web`, join(dir, '.api-threads', 'blue')],
    ])
    const plain = await s.resolve({ rootPath: shop, threadId: 't2' })
    expect(plain.steps.map((step) => step.cwd)).toEqual([shop, shop, api])
  })

  it('refuses a project outside the scope, and a conversation layer without a conversation', async () => {
    const s = store()
    await expect(
      s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: api, setup: SETUP }),
    ).rejects.toThrow('not part of this Run')
    await expect(
      s.save({ rootPath: shop, threadId: null }, { layer: 'conversation', projectRoot: shop, tweaks: {} }),
    ).rejects.toThrow('inside a conversation')
  })

  it('keeps conversation tweaks per project, and an empty save removes that project only', async () => {
    const threads: Record<string, FakeThread> = {
      t1: { projectRoot: shop, worktreePath: null, roots: [api], rootWorktrees: [], tweaks: {} },
    }
    const s = store(threads)
    const scope = { rootPath: shop, threadId: 't1' }
    await s.save(scope, { layer: 'conversation', projectRoot: shop, tweaks: { web: { skip: true } } })
    await s.save(scope, { layer: 'conversation', projectRoot: api, tweaks: { web: { command: 'x' } } })
    expect(threads.t1!.tweaks).toEqual({ [shop]: { web: { skip: true } }, [api]: { web: { command: 'x' } } })
    await s.save(scope, { layer: 'conversation', projectRoot: shop, tweaks: {} })
    expect(threads.t1!.tweaks).toEqual({ [api]: { web: { command: 'x' } } })
  })
})
