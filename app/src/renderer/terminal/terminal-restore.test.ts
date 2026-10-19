// Bringing a conversation's saved shells back: once per scope, before anything
// new, and into the trees that were on screen when the restore STARTED.
import type { SavedTerminalRef, TerminalOwner, ThreadScopeEntry } from '../../shared/ipc-contract'
import { notYetLive, ownerKey, ScopeRestorer } from './terminal-restore'
import type { TerminalScopeState } from './terminal-scope'

const APP = '/work/app'
const CHECKOUT_A = '/work/.app-threads/a'
const CHECKOUT_B = '/work/.app-threads/b'

const A: TerminalOwner = { rootPath: APP, threadId: 'a' }
const B: TerminalOwner = { rootPath: APP, threadId: 'b' }

function entry(rootPath: string): ThreadScopeEntry {
  return { rootId: rootPath, rootPath, name: 'app', primary: true, available: true }
}

function onScreen(owner: TerminalOwner, checkout: string): TerminalScopeState {
  return { scopeRoots: [entry(checkout)], activeProjectRoot: APP, ownerScope: owner, scopeThreadId: owner.threadId }
}

interface Spawned {
  rootPath: string | undefined
  title: string
  owner: TerminalOwner
}

function setup(saved: Record<string, SavedTerminalRef[]>): {
  restorer: ScopeRestorer
  spawned: Spawned[]
  loads: string[]
  /** Runs between the spawns — the person switching mid-restore. */
  onSpawn: { hook: () => void }
} {
  const spawned: Spawned[] = []
  const loads: string[] = []
  const onSpawn = { hook: (): void => {} }
  const restorer = new ScopeRestorer({
    load: async (owner) => {
      loads.push(ownerKey(owner))
      return saved[ownerKey(owner)] ?? []
    },
    spawn: async (rootPath, ref, owner) => {
      spawned.push({ rootPath, title: ref.title, owner })
      onSpawn.hook()
      await Promise.resolve()
    },
  })
  return { restorer, spawned, loads, onSpawn }
}

describe('ScopeRestorer', () => {
  it('spawns every saved shell in the trees on screen when the restore started, even if the person switches mid-way', async () => {
    const { restorer, spawned, onSpawn } = setup({
      [ownerKey(A)]: [
        { title: 'one', cwd: CHECKOUT_A },
        { title: 'two', cwd: CHECKOUT_A },
        { title: 'three', cwd: CHECKOUT_A },
      ],
    })
    const state = onScreen(A, CHECKOUT_A)
    // The live state the panel would read — moved to thread B after the first shell.
    onSpawn.hook = () => Object.assign(state, onScreen(B, CHECKOUT_B))

    await expect(restorer.restore(state)).resolves.toBe(3)

    expect(spawned.map((shell) => shell.rootPath)).toEqual([CHECKOUT_A, CHECKOUT_A, CHECKOUT_A])
    expect(spawned.every((shell) => shell.owner.threadId === 'a')).toBe(true)
  })

  it('runs once per scope — a + and the auto-start await the same restore', async () => {
    const { restorer, spawned, loads } = setup({ [ownerKey(A)]: [{ title: 'one', cwd: CHECKOUT_A }] })
    const state = onScreen(A, CHECKOUT_A)
    expect(restorer.started(A)).toBe(false)

    const first = restorer.restore(state)
    const second = restorer.restore(state)
    expect(second).toBe(first)
    expect(restorer.started(A)).toBe(true)
    await first
    await restorer.restore(state)

    expect(loads).toEqual([ownerKey(A)])
    expect(spawned).toHaveLength(1)
  })

  it('refuses — and does not remember — while the roots still belong to another thread', async () => {
    const { restorer, spawned, loads } = setup({ [ownerKey(B)]: [{ title: 'one', cwd: CHECKOUT_B }] })
    const behind: TerminalScopeState = { ...onScreen(B, CHECKOUT_A), scopeThreadId: 'a' }

    expect(restorer.restore(behind)).toBeNull()
    expect(restorer.started(B)).toBe(false)
    expect(loads).toEqual([])

    // The roots arrive: now it runs, into B's own checkout.
    await expect(restorer.restore(onScreen(B, CHECKOUT_B))).resolves.toBe(1)
    expect(spawned.map((shell) => shell.rootPath)).toEqual([CHECKOUT_B])
  })

  it('does nothing without a conversation on screen', () => {
    const { restorer } = setup({})
    expect(restorer.restore({ scopeRoots: null, activeProjectRoot: null, ownerScope: null })).toBeNull()
    expect(restorer.restore({ scopeRoots: null, activeProjectRoot: null })).toBeNull()
  })

  it('a failed read restores nothing and resolves to zero (the auto-start then opens one)', async () => {
    const restorer = new ScopeRestorer({
      load: async () => {
        throw new Error('db gone')
      },
      spawn: async () => {
        throw new Error('never called')
      },
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(restorer.restore(onScreen(A, CHECKOUT_A))).resolves.toBe(0)
    warn.mockRestore()
  })

  it('one shell that cannot come back does not keep the others away', async () => {
    const spawned: string[] = []
    const restorer = new ScopeRestorer({
      load: async () => [
        { title: 'bad', cwd: CHECKOUT_A },
        { title: 'good', cwd: CHECKOUT_A },
      ],
      spawn: async (_root, ref) => {
        if (ref.title === 'bad') throw new Error('spawn failed')
        spawned.push(ref.title)
      },
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(restorer.restore(onScreen(A, CHECKOUT_A))).resolves.toBe(2)
    warn.mockRestore()
    expect(spawned).toEqual(['good'])
  })

  it('does not re-spawn a shell that opened in the scope before its restore ran', async () => {
    // The boot auto-start raced the scope's arrival: main saved its live set
    // (that one shell), and the first + then ran the restore — which used to
    // bring the running shell back a second time (one + made three tabs).
    const spawned: string[] = []
    const restorer = new ScopeRestorer({
      load: async () => [{ title: 'zsh', cwd: CHECKOUT_A }],
      live: async () => [{ title: 'node', cwd: CHECKOUT_A }],
      spawn: async (_root, ref) => {
        spawned.push(ref.title)
      },
    })
    await expect(restorer.restore(onScreen(A, CHECKOUT_A))).resolves.toBe(0)
    expect(spawned).toEqual([])
  })

  it('a cold start, with nothing running, brings every saved shell back', async () => {
    const spawned: string[] = []
    const restorer = new ScopeRestorer({
      load: async () => [
        { title: 'one', cwd: CHECKOUT_A },
        { title: 'two', cwd: CHECKOUT_A },
      ],
      live: async () => [],
      spawn: async (_root, ref) => {
        spawned.push(ref.title)
      },
    })
    await expect(restorer.restore(onScreen(A, CHECKOUT_A))).resolves.toBe(2)
    expect(spawned).toEqual(['one', 'two'])
  })

  it('an unreadable live set restores nothing rather than duplicating', async () => {
    const spawned: string[] = []
    const restorer = new ScopeRestorer({
      load: async () => [{ title: 'one', cwd: CHECKOUT_A }],
      live: async () => {
        throw new Error('ipc down')
      },
      spawn: async (_root, ref) => {
        spawned.push(ref.title)
      },
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(restorer.restore(onScreen(A, CHECKOUT_A))).resolves.toBe(0)
    warn.mockRestore()
    expect(spawned).toEqual([])
  })
})

describe('notYetLive', () => {
  it('cancels one saved shell per live shell in the same directory', () => {
    const saved = [
      { title: 'a', cwd: CHECKOUT_A },
      { title: 'b', cwd: CHECKOUT_A },
      { title: 'c', cwd: CHECKOUT_B },
    ]
    expect(notYetLive(saved, [{ title: 'x', cwd: CHECKOUT_A }])).toEqual([
      { title: 'b', cwd: CHECKOUT_A },
      { title: 'c', cwd: CHECKOUT_B },
    ])
    expect(notYetLive(saved, [])).toEqual(saved)
  })
})
