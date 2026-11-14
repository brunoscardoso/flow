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

  function store(
    threads: Record<string, FakeThread> = {},
    personal = fakePersonal(),
    workspaceSiblings?: (root: string) => Promise<string[]>,
  ): RunSetupStore {
    return new RunSetupStore({
      fs: nodeRunStoreFs(),
      threads: fakeThreads(threads),
      personal,
      ...(workspaceSiblings === undefined ? {} : { workspaceSiblings }),
    })
  }

  it('a project with no shared setup resolves to no steps, and says so', async () => {
    const resolution = await store().resolve({ rootPath: shop, threadId: null })
    expect(resolution.scopeKey).toBe(`${shop}::`)
    expect(resolution.project).toMatchObject({ root: shop, name: 'shop', cwd: shop, hasSharedSetup: false, setup: null })
    expect(resolution.places).toEqual([{ name: 'shop', root: shop, cwd: shop, from: 'scope' }])
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
    expect(resolution.project.problems).toHaveLength(1)
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

  it("ONE list: only the primary project's setup is read; another project's own file is not merged", async () => {
    const threads: Record<string, FakeThread> = {
      t1: { projectRoot: shop, worktreePath: null, roots: [api], rootWorktrees: [], tweaks: {} },
    }
    const s = store(threads)
    await s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: shop, setup: SETUP })
    await s.save({ rootPath: api, threadId: null }, { layer: 'shared', projectRoot: api, setup: { version: 1, steps: [SETUP.steps[1]!] } })
    const resolution = await s.resolve({ rootPath: shop, threadId: 't1' })
    expect(resolution.steps.map((step) => step.key)).toEqual([`${shop}::db`, `${shop}::web`])
    expect(resolution.places.map((place) => place.name)).toEqual(['shop', 'api'])
  })

  it("a step runs in the named project's conversation checkout, else its folder; keys stay the primary's", async () => {
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
    const cross: RunSetup = {
      version: 1,
      steps: [
        { id: 'temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', runsIn: 'api' },
        { id: 'web', name: 'Web', command: 'npm run dev', start: 'after-previous' },
      ],
    }
    await s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: shop, setup: cross })

    const isolated = await s.resolve({ rootPath: shop, threadId: 't1' })
    expect(isolated.steps.map((step) => [step.key, step.projectRoot, step.cwd])).toEqual([
      [`${shop}::temporal`, api, join(dir, '.api-threads', 'blue')],
      [`${shop}::web`, shop, join(dir, '.shop-threads', 'blue')],
    ])
    const plain = await s.resolve({ rootPath: shop, threadId: 't2' })
    expect(plain.steps.map((step) => step.cwd)).toEqual([api, shop])
  })

  it('a step naming a Workspace sibling on this computer runs in its folder; an unknown one is blocked', async () => {
    const core = join(dir, 'jupiter-core')
    mkdirSync(core)
    const s = store({}, fakePersonal(), async (root) => (root === shop ? [core, shop] : []))
    await s.save(
      { rootPath: shop, threadId: null },
      {
        layer: 'shared',
        projectRoot: shop,
        setup: {
          version: 1,
          steps: [
            { id: 'temporal', name: 'temporal', command: 'temporal server start-dev', start: 'now', runsIn: 'jupiter-core' },
            { id: 'ghost', name: 'ghost', command: 'x', start: 'after-previous', runsIn: 'billing' },
          ],
        },
      },
    )
    const resolution = await s.resolve({ rootPath: shop, threadId: null })
    expect(resolution.places).toEqual([
      { name: 'shop', root: shop, cwd: shop, from: 'scope' },
      { name: 'jupiter-core', root: core, cwd: core, from: 'workspace' },
    ])
    expect(resolution.steps[0]).toMatchObject({ projectRoot: core, cwd: core, projectName: 'jupiter-core' })
    expect(resolution.steps[0]?.unavailable).toBeUndefined()
    expect(resolution.steps[1]?.unavailable).toBe("billing is not on this computer, so this step can't start.")
  })

  it('a Workspace read that fails leaves the scope projects only', async () => {
    const s = store({}, fakePersonal(), async () => {
      throw new Error('cli down')
    })
    expect((await s.placesOf({ rootPath: shop, threadId: null })).map((place) => place.name)).toEqual(['shop'])
  })

  it('refuses any project but the primary, and a conversation layer without a conversation', async () => {
    const threads: Record<string, FakeThread> = {
      t1: { projectRoot: shop, worktreePath: null, roots: [api], rootWorktrees: [], tweaks: {} },
    }
    const s = store(threads)
    await expect(
      s.save({ rootPath: shop, threadId: null }, { layer: 'shared', projectRoot: api, setup: SETUP }),
    ).rejects.toThrow('not the one this Run belongs to')
    // An attached project of the conversation is not the Run's setup either.
    await expect(
      s.save({ rootPath: shop, threadId: 't1' }, { layer: 'conversation', projectRoot: api, tweaks: {} }),
    ).rejects.toBeInstanceOf(RunSetupError)
    await expect(
      s.save({ rootPath: shop, threadId: null }, { layer: 'conversation', projectRoot: shop, tweaks: {} }),
    ).rejects.toThrow('inside a conversation')
  })

  it('keeps conversation tweaks under the primary project, and an empty save removes them', async () => {
    const threads: Record<string, FakeThread> = {
      t1: { projectRoot: shop, worktreePath: null, roots: [api], rootWorktrees: [], tweaks: { [api]: { web: { command: 'x' } } } },
    }
    const s = store(threads)
    const scope = { rootPath: shop, threadId: 't1' }
    await s.save(scope, { layer: 'conversation', projectRoot: shop, tweaks: { web: { skip: true } } })
    expect(threads.t1!.tweaks).toEqual({ [shop]: { web: { skip: true } }, [api]: { web: { command: 'x' } } })
    await s.save(scope, { layer: 'conversation', projectRoot: shop, tweaks: {} })
    expect(threads.t1!.tweaks).toEqual({ [api]: { web: { command: 'x' } } })
  })
})
