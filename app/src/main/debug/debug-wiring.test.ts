import { makeDebugSessionDeps } from './debug-wiring'
import type { StampedTerminalChunk } from '../../shared/terminal-stamp'

const CORE = '/repos/orbit-core'
const APP = '/repos/orbit-app'
const OTHER = '/repos/unrelated'

function sources(over: Record<string, unknown> = {}) {
  return {
    terminals: () => ({
      observeOutput: (_fn: (c: StampedTerminalChunk) => void) => () => undefined,
      listTerminals: () => [
        { terminalId: 'a', projectRoot: CORE, title: 'zsh' },
        { terminalId: 'b', projectRoot: APP, title: 'zsh' },
        { terminalId: 'c', projectRoot: OTHER, title: 'zsh' },
        { terminalId: 'd', projectRoot: undefined, title: 'orphan' },
      ],
      getScrollback: (id: string) =>
        id === 'a' ? Array.from({ length: 100 }, (_v, i) => `line ${i}`).join('\n') : null,
    }),
    browser: { bufferSlice: () => [] },
    scopeRoots: () => [CORE, APP],
    activeProjectRoot: () => null,
    ...over,
  }
}

describe('wiring the session to the real app', () => {
  it('records the browser alone when the terminal manager is not up yet', () => {
    // The manager is built AFTER the IPC handlers register, so an accessor that
    // answers null is a real state, not a bug. What must not happen is a
    // session that claims to be recording terminals it never subscribed to.
    const deps = makeDebugSessionDeps(sources({ terminals: () => null }) as never)
    expect(deps.terminalsInScope('t1')).toEqual([])
    expect(deps.scrollbackTail('a', 5)).toBe('')
    expect(() => deps.observeTerminalOutput(() => undefined)()).not.toThrow()
  })

  it('takes every terminal in the THREAD’s scope, across projects', () => {
    // The decision from discovery: a conversation spanning two projects records
    // both — the backend in one, the app in the other — with no picking.
    const deps = makeDebugSessionDeps(sources() as never)
    const found = deps.terminalsInScope('t1')
    expect(found.map((t) => t.terminalId)).toEqual(['a', 'b'])
  })

  it('names a terminal by its PROJECT, not its tab title', () => {
    // Two tabs both called "zsh" would make the timeline unreadable, and
    // "which project printed this" is the question a reader has.
    const deps = makeDebugSessionDeps(sources() as never)
    expect(deps.terminalsInScope('t1').map((t) => t.label)).toEqual([
      'orbit-core',
      'orbit-app',
    ])
  })

  it('falls back to the active project when there is no thread', () => {
    const deps = makeDebugSessionDeps(
      sources({ scopeRoots: () => [], activeProjectRoot: () => APP }) as never,
    )
    expect(deps.terminalsInScope(null).map((t) => t.terminalId)).toEqual(['b'])
  })

  it('records nothing when no project is in scope, rather than everything', () => {
    // The dangerous failure here is the opposite of an empty list: sweeping in
    // every terminal on the machine would put somebody else's build in the
    // artifact.
    const deps = makeDebugSessionDeps(
      sources({ scopeRoots: () => [], activeProjectRoot: () => null }) as never,
    )
    expect(deps.terminalsInScope(null)).toEqual([])
  })

  it('bounds the pre-roll to the lines asked for', () => {
    const deps = makeDebugSessionDeps(sources() as never)
    const tail = deps.scrollbackTail('a', 10)
    expect(tail.split('\n')).toHaveLength(10)
    expect(tail).toContain('line 99')
    expect(tail).not.toContain('line 50')
  })

  it('reports an unknown terminal’s pre-roll as empty, not as a crash', () => {
    const deps = makeDebugSessionDeps(sources() as never)
    expect(deps.scrollbackTail('gone', 10)).toBe('')
  })

  it('treats a browser that was never opened as no captures, not a failure', () => {
    // A session recording only terminals is a real session.
    const deps = makeDebugSessionDeps(
      sources({
        browser: {
          bufferSlice: () => {
            throw new Error('no guest attached')
          },
        },
      }) as never,
    )
    expect(deps.browserCaptures()).toEqual([])
  })
})

describe('telling two shells in one project apart', () => {
  it('numbers terminals that would otherwise share a name', () => {
    // Three shells in one checkout all answered to the project's name, so the
    // artifact read "X, X, X" and attributed every quoted line to the same one.
    const deps = makeDebugSessionDeps(
      sources({
        terminals: () => ({
          observeOutput: () => () => undefined,
          listTerminals: () => [
            { terminalId: 'a', projectRoot: CORE, title: 'zsh' },
            { terminalId: 'b', projectRoot: CORE, title: 'zsh' },
            { terminalId: 'c', projectRoot: CORE, title: 'zsh' },
          ],
          getScrollback: () => null,
        }),
        scopeRoots: () => [CORE],
      }) as never,
    )
    expect(deps.terminalsInScope('t1').map((t) => t.label)).toEqual([
      'orbit-core #1',
      'orbit-core #2',
      'orbit-core #3',
    ])
  })

  it('leaves a lone terminal unnumbered', () => {
    // "#1" on the only shell is noise that implies a second one exists.
    const deps = makeDebugSessionDeps(
      sources({
        terminals: () => ({
          observeOutput: () => () => undefined,
          listTerminals: () => [{ terminalId: 'a', projectRoot: CORE, title: 'zsh' }],
          getScrollback: () => null,
        }),
        scopeRoots: () => [CORE],
      }) as never,
    )
    expect(deps.terminalsInScope('t1').map((t) => t.label)).toEqual(['orbit-core'])
  })

  it('numbers only the name that collides', () => {
    const deps = makeDebugSessionDeps(
      sources({
        terminals: () => ({
          observeOutput: () => () => undefined,
          listTerminals: () => [
            { terminalId: 'a', projectRoot: CORE, title: 'zsh' },
            { terminalId: 'b', projectRoot: CORE, title: 'zsh' },
            { terminalId: 'c', projectRoot: APP, title: 'zsh' },
          ],
          scopeRoots: () => [CORE, APP],
        }),
        scopeRoots: () => [CORE, APP],
      }) as never,
    )
    expect(deps.terminalsInScope('t1').map((t) => t.label)).toEqual([
      'orbit-core #1',
      'orbit-core #2',
      'orbit-app',
    ])
  })
})
