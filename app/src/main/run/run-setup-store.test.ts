// Run setup store — each step is stored with the project it runs in, in
// (fake) local app settings; a conversation's Run combines every project it
// has, in the one order kept on this computer.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseRunSetup, runStepRef, type RunSetup, type RunStep } from '../../shared/run-setup'
import { RunSetupError, RunSetupStore, type RunPersonalSource, type RunThreadSource } from './run-setup-store'

interface FakeThread {
  projectRoot: string
  worktreePath: string | null
  roots: string[]
  rootWorktrees: Array<{ rootPath: string; worktreePath: string }>
}

function fakeThreads(threads: Record<string, FakeThread>): RunThreadSource {
  return {
    getThread: (id) => threads[id] ?? null,
    getThreadRoots: (id) => threads[id]?.roots ?? [],
    getThreadRootWorktrees: (id) => threads[id]?.rootWorktrees ?? [],
  }
}

type FakePersonal = RunPersonalSource & { setups: Map<string, string>; order: string[] }

function fakePersonal(): FakePersonal {
  const setups = new Map<string, string>()
  const fake: FakePersonal = {
    setups,
    order: [],
    getRunSetup: (root) => setups.get(root) ?? null,
    setRunSetup: (root, text) => {
      if (text === null) setups.delete(root)
      else setups.set(root, text)
    },
    listRunSetupRoots: () => [...setups.keys()],
    getRunOrder: () => [...fake.order],
    setRunOrder: (refs) => {
      fake.order = [...refs]
    },
  }
  return fake
}

function storedSteps(personal: FakePersonal, root: string): RunStep[] {
  const text = personal.setups.get(root)
  return text === undefined ? [] : parseRunSetup(text).setup.steps
}

const step = (id: string, extra: Partial<RunStep> = {}): RunStep => ({
  id,
  name: id,
  command: `run ${id}`,
  start: 'now',
  ...extra,
})

const A = '/work/a'
const B = '/work/b'
const C = '/work/c'
const D = '/work/d'

describe('RunSetupStore — one combined list across projects', () => {
  const threads: Record<string, FakeThread> = {
    t1: { projectRoot: A, worktreePath: null, roots: [B, C], rootWorktrees: [] },
    t2: {
      projectRoot: B,
      worktreePath: '/work/.b-threads/blue',
      roots: [C, D],
      rootWorktrees: [{ rootPath: C, worktreePath: '/work/.c-threads/blue' }],
    },
    t3: { projectRoot: D, worktreePath: null, roots: [], rootWorktrees: [] },
  }
  const T1 = { rootPath: A, threadId: 't1' }
  const T2 = { rootPath: B, threadId: 't2' }

  function seeded(): { s: RunSetupStore; personal: FakePersonal } {
    const personal = fakePersonal()
    return { s: new RunSetupStore({ threads: fakeThreads(threads), personal }), personal }
  }

  async function saveConversationOne(s: RunSetupStore): Promise<void> {
    await s.save(T1, {
      layer: 'shared',
      steps: [
        step('cache', { runsIn: 'c' }),
        step('api', { runsIn: 'b', start: 'after-previous' }),
        step('web'),
        step('worker', { runsIn: 'b' }),
      ],
    })
  }

  it('stores each step with the project it runs in, with no runsIn, and keeps one order', async () => {
    const { s, personal } = seeded()
    await saveConversationOne(s)
    expect(storedSteps(personal, A).map((x) => [x.id, x.runsIn])).toEqual([['web', undefined]])
    expect(storedSteps(personal, B).map((x) => [x.id, x.runsIn])).toEqual([
      ['api', undefined],
      ['worker', undefined],
    ])
    expect(storedSteps(personal, C).map((x) => x.id)).toEqual(['cache'])
    expect(personal.order).toEqual([runStepRef(C, 'cache'), runStepRef(B, 'api'), runStepRef(A, 'web'), runStepRef(B, 'worker')])

    const one = await s.resolve(T1)
    expect(one.steps.map((x) => [x.key, x.projectRoot])).toEqual([
      [`${C}::cache`, C],
      [`${B}::api`, B],
      [`${A}::web`, A],
      [`${B}::worker`, B],
    ])
    expect(one.places.map((place) => place.name)).toEqual(['a', 'b', 'c'])
  })

  it('another conversation shows its projects’ steps in the same order, plus its own project’s', async () => {
    const { s } = seeded()
    await saveConversationOne(s)
    await s.save({ rootPath: D, threadId: 't3' }, { layer: 'shared', steps: [step('docs')] })

    const two = await s.resolve(T2)
    expect(two.steps.map((x) => [x.key, x.cwd])).toEqual([
      [`${C}::cache`, '/work/.c-threads/blue'],
      [`${B}::api`, '/work/.b-threads/blue'],
      [`${B}::worker`, '/work/.b-threads/blue'],
      [`${D}::docs`, D],
    ])
    // The combined list names each step's project; the main one is the draft's own.
    expect(two.project.setup?.steps.map((x) => [x.id, x.runsIn])).toEqual([
      [`${C}::cache`, 'c'],
      [`${B}::api`, 'b'],
      [`${B}::worker`, 'b'],
      [`${D}::docs`, 'd'],
    ])
    expect(two.places.map((place) => place.name)).toEqual(['b', 'c', 'd'])
  })

  it('a save from another conversation leaves the steps it cannot see, and their order, alone', async () => {
    const { s, personal } = seeded()
    await saveConversationOne(s)
    const before = personal.setups.get(A)
    await s.save(T2, {
      layer: 'shared',
      steps: [
        step(`${B}::worker`, { name: 'worker', runsIn: 'b' }),
        step(`${C}::cache`, { name: 'cache', runsIn: 'c' }),
        step(`${B}::api`, { name: 'api', runsIn: 'b', command: 'run api --reload' }),
        step('docs', { runsIn: 'd' }),
      ],
    })
    expect(personal.setups.get(A)).toBe(before)
    expect(personal.order).toEqual([
      runStepRef(B, 'worker'),
      runStepRef(C, 'cache'),
      runStepRef(B, 'api'),
      runStepRef(D, 'docs'),
      runStepRef(A, 'web'),
    ])
    expect(storedSteps(personal, B).find((x) => x.id === 'api')?.command).toBe('run api --reload')
    expect(storedSteps(personal, D).map((x) => x.id)).toEqual(['docs'])
    // Conversation one keeps a's step where it was relative to the others.
    expect((await s.resolve(T1)).steps.map((x) => x.key)).toEqual([
      `${B}::worker`,
      `${C}::cache`,
      `${B}::api`,
      `${A}::web`,
    ])
  })

  it('moving a step to another project stores it there with a fresh id', async () => {
    const { s, personal } = seeded()
    await saveConversationOne(s)
    await s.save(T1, {
      layer: 'shared',
      steps: [
        step(`${C}::cache`, { name: 'cache', runsIn: 'c' }),
        step(`${B}::api`, { name: 'api', runsIn: 'c', start: 'after-previous' }),
        step(`${A}::web`, { name: 'web' }),
        step(`${B}::worker`, { name: 'worker', runsIn: 'b' }),
      ],
    })
    expect(storedSteps(personal, B).map((x) => x.id)).toEqual(['worker'])
    expect(storedSteps(personal, C).map((x) => x.id)).toEqual(['cache', 'api'])
    expect(personal.order).toEqual([runStepRef(C, 'cache'), runStepRef(C, 'api'), runStepRef(A, 'web'), runStepRef(B, 'worker')])
  })

  it('a fresh id never takes one the project already uses', async () => {
    const { s, personal } = seeded()
    await saveConversationOne(s)
    await s.save(T1, {
      layer: 'shared',
      steps: [
        step(`${C}::cache`, { name: 'cache', runsIn: 'c' }),
        step(`${B}::api`, { name: 'api', runsIn: 'b' }),
        step(`${A}::web`, { name: 'web' }),
        step(`${B}::worker`, { name: 'worker', runsIn: 'b' }),
        step('api', { runsIn: 'b' }),
      ],
    })
    expect(storedSteps(personal, B).map((x) => x.id)).toEqual(['api', 'worker', 'api-2'])
  })

  it('deleting a step removes it and its place in the order; an emptied project is forgotten', async () => {
    const { s, personal } = seeded()
    await saveConversationOne(s)
    await s.save(T1, {
      layer: 'shared',
      steps: [step(`${B}::api`, { name: 'api', runsIn: 'b' }), step(`${B}::worker`, { name: 'worker', runsIn: 'b' })],
    })
    expect(personal.setups.has(A)).toBe(false)
    expect(personal.setups.has(C)).toBe(false)
    expect(personal.order).toEqual([runStepRef(B, 'api'), runStepRef(B, 'worker')])
  })

  it('refuses a step for a project that is not part of the conversation, and writes nothing', async () => {
    const { s, personal } = seeded()
    await saveConversationOne(s)
    const before = new Map(personal.setups)
    await expect(s.save(T1, { layer: 'shared', steps: [step('docs', { runsIn: 'd' })] })).rejects.toBeInstanceOf(RunSetupError)
    await expect(s.save(T1, { layer: 'shared', steps: [step('docs', { runsIn: 'd' })] })).rejects.toThrow(
      'not part of this conversation',
    )
    expect(personal.setups).toEqual(before)
  })

  it('steps the order does not name yet go last, by project: the main one first', async () => {
    const { s, personal } = seeded()
    personal.setups.set(C, JSON.stringify({ version: 1, steps: [step('cache')] }))
    personal.setups.set(B, JSON.stringify({ version: 1, steps: [step('api'), step('worker')] }))
    personal.setups.set(A, JSON.stringify({ version: 1, steps: [step('web')] }))
    personal.order = [runStepRef(B, 'worker')]
    expect((await s.resolve(T1)).steps.map((x) => x.key)).toEqual([
      `${B}::worker`,
      `${A}::web`,
      `${B}::api`,
      `${C}::cache`,
    ])
  })
})

describe('RunSetupStore — older setups that name another project', () => {
  const threads: Record<string, FakeThread> = {
    t1: { projectRoot: A, worktreePath: null, roots: [B, C], rootWorktrees: [] },
    t2: { projectRoot: B, worktreePath: null, roots: [C, D], rootWorktrees: [] },
  }
  const LEGACY: RunSetup = {
    version: 1,
    steps: [step('cache', { runsIn: 'c' }), step('api', { runsIn: 'b', start: 'after-previous' }), step('web', { runsIn: 'a' })],
  }

  function seeded(): { s: RunSetupStore; personal: FakePersonal } {
    const personal = fakePersonal()
    personal.setups.set(A, JSON.stringify(LEGACY))
    return { s: new RunSetupStore({ threads: fakeThreads(threads), personal }), personal }
  }

  it('reads a step as belonging to the project it names', async () => {
    const { s } = seeded()
    const two = await s.resolve({ rootPath: B, threadId: 't2' })
    expect(two.steps.map((x) => [x.key, x.projectRoot])).toEqual([
      [`${A}::cache`, C],
      [`${A}::api`, B],
    ])
    // Alone, a sees only its own step.
    expect((await s.resolve({ rootPath: A, threadId: null })).steps.map((x) => x.key)).toEqual([`${A}::web`])
  })

  it('moves the steps a save touches to their own project, losing nothing', async () => {
    const { s, personal } = seeded()
    const scope = { rootPath: B, threadId: 't2' }
    const view = await s.resolve(scope)
    await s.save(scope, { layer: 'shared', steps: view.project.setup!.steps })
    expect(storedSteps(personal, A).map((x) => [x.id, x.runsIn])).toEqual([['web', 'a']])
    expect(storedSteps(personal, B).map((x) => [x.id, x.runsIn])).toEqual([['api', undefined]])
    expect(storedSteps(personal, C).map((x) => [x.id, x.runsIn])).toEqual([['cache', undefined]])
    expect((await s.resolve({ rootPath: A, threadId: 't1' })).steps.map((x) => x.key)).toEqual([
      `${C}::cache`,
      `${B}::api`,
      `${A}::web`,
    ])
  })
})

describe('RunSetupStore — where it is kept', () => {
  let dir: string
  let api: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-run-store-'))
    api = join(dir, 'api')
    const workspaceProject = join(dir, 'workspaces', 'acme', 'projects', 'api')
    mkdirSync(workspaceProject, { recursive: true })
    mkdirSync(api)
    symlinkSync(workspaceProject, join(api, 'flow'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a project with no setup resolves to no steps, and says so', async () => {
    const s = new RunSetupStore({ threads: fakeThreads({}), personal: fakePersonal() })
    const resolution = await s.resolve({ rootPath: api, threadId: null })
    expect(resolution.scopeKey).toBe(`${api}::`)
    expect(resolution.project).toMatchObject({ root: api, name: 'api', cwd: api, hasSharedSetup: false, setup: null })
    expect(resolution.places).toEqual([{ name: 'api', root: api, cwd: api, from: 'scope' }])
    expect(resolution.steps).toEqual([])
  })

  it('keeps the setup in local settings and never writes into the project or its Workspace', async () => {
    const personal = fakePersonal()
    const s = new RunSetupStore({ threads: fakeThreads({}), personal })
    await s.save({ rootPath: api, threadId: null }, { layer: 'shared', steps: [step('db'), step('web', { start: 'after-previous' })] })
    expect(storedSteps(personal, api).map((x) => x.id)).toEqual(['db', 'web'])
    expect(readdirSync(join(dir, 'workspaces', 'acme', 'projects', 'api'))).toEqual([])
    expect(readdirSync(api)).toEqual(['flow'])
    expect((await s.resolve({ rootPath: api, threadId: null })).steps.map((x) => x.key)).toEqual([`${api}::db`, `${api}::web`])
  })

  it('a malformed stored setup reads with problems, never throws', async () => {
    const personal = fakePersonal()
    personal.setups.set(api, '{"steps":[{"name":"x"}]}')
    const resolution = await new RunSetupStore({ threads: fakeThreads({}), personal }).resolve({ rootPath: api, threadId: null })
    expect(resolution.steps).toEqual([])
    expect(resolution.project.problems).toHaveLength(1)
  })

  it('a step turned off stays in the list but is not resolved to run', async () => {
    const personal = fakePersonal()
    const s = new RunSetupStore({ threads: fakeThreads({}), personal })
    await s.save({ rootPath: api, threadId: null }, { layer: 'shared', steps: [step('db', { disabled: true }), step('web')] })
    const resolution = await s.resolve({ rootPath: api, threadId: null })
    expect(resolution.project.setup?.steps.map((x) => [x.id, x.disabled])).toEqual([
      [`${api}::db`, true],
      [`${api}::web`, undefined],
    ])
    expect(resolution.steps.map((x) => x.key)).toEqual([`${api}::web`])
  })
})

