// Auto-open on thread activation tests (multi-project threads, phase 6):
// the pure decision (which thread roots to open) and the activation wiring
// (ACTIVE_THREAD_CHANGED_EVENT → ProjectRegistry.addRoot, fail-soft).

import { EventEmitter } from 'events'

import { autoOpenTargets, startAutoOpenOnActivation } from './auto-open'
import { ACTIVE_THREAD_CHANGED_EVENT } from './project-context'

const PRIMARY = '/work/app'
const CLOSED_ON_DISK = '/work/lib'
const MISSING = '/gone/never'

describe('autoOpenTargets', () => {
  const existsAll = (): boolean => true

  it('opens a thread root that exists on disk but has no project record', () => {
    expect(autoOpenTargets([PRIMARY, CLOSED_ON_DISK], [PRIMARY], existsAll)).toEqual([
      CLOSED_ON_DISK,
    ])
  })

  it('skips roots that are already project roots', () => {
    expect(autoOpenTargets([PRIMARY, CLOSED_ON_DISK], [PRIMARY, CLOSED_ON_DISK], existsAll)).toEqual(
      [],
    )
  })

  it('skips roots missing on disk — they stay unavailable scope entries', () => {
    const exists = (path: string): boolean => path !== MISSING
    expect(autoOpenTargets([PRIMARY, MISSING, CLOSED_ON_DISK], [PRIMARY], exists)).toEqual([
      CLOSED_ON_DISK,
    ])
  })

  it('dedupes and skips empty paths, preserving order', () => {
    expect(
      autoOpenTargets(['', CLOSED_ON_DISK, CLOSED_ON_DISK, '/work/other'], [PRIMARY], existsAll),
    ).toEqual([CLOSED_ON_DISK, '/work/other'])
  })
})

describe('startAutoOpenOnActivation', () => {
  function makeDeps(options?: {
    threadRoots?: string[]
    knownPaths?: string[]
    exists?: (path: string) => boolean
    addRoot?: jest.Mock
  }): {
    projectContext: EventEmitter
    addRoot: jest.Mock
    dispose: () => void
  } {
    const projectContext = new EventEmitter()
    const addRoot = options?.addRoot ?? jest.fn()
    const dispose = startAutoOpenOnActivation({
      projectContext,
      threadStore: {
        getThread: (id: string) => (id === 't1' ? { projectRoot: PRIMARY } : null),
        getThreadRoots: () => options?.threadRoots ?? [CLOSED_ON_DISK],
      },
      projectRegistry: {
        getRoots: () => (options?.knownPaths ?? [PRIMARY]).map((rootPath) => ({ rootPath })),
        addRoot,
      },
      exists: options?.exists ?? ((): boolean => true),
    })
    return { projectContext, addRoot, dispose }
  }

  it('opens the activated thread’s closed-but-on-disk roots via addRoot', () => {
    const { projectContext, addRoot } = makeDeps()
    projectContext.emit(ACTIVE_THREAD_CHANGED_EVENT, { rootPath: PRIMARY, threadId: 't1' })
    expect(addRoot).toHaveBeenCalledTimes(1)
    expect(addRoot).toHaveBeenCalledWith(CLOSED_ON_DISK)
  })

  it('is idempotent for already-open roots (no addRoot call)', () => {
    const { projectContext, addRoot } = makeDeps({ knownPaths: [PRIMARY, CLOSED_ON_DISK] })
    projectContext.emit(ACTIVE_THREAD_CHANGED_EVENT, { rootPath: PRIMARY, threadId: 't1' })
    expect(addRoot).not.toHaveBeenCalled()
  })

  it('leaves missing-on-disk roots alone', () => {
    const { projectContext, addRoot } = makeDeps({
      threadRoots: [MISSING],
      exists: () => false,
    })
    projectContext.emit(ACTIVE_THREAD_CHANGED_EVENT, { rootPath: PRIMARY, threadId: 't1' })
    expect(addRoot).not.toHaveBeenCalled()
  })

  it('ignores activations for unknown threads', () => {
    const { projectContext, addRoot } = makeDeps()
    projectContext.emit(ACTIVE_THREAD_CHANGED_EVENT, { rootPath: PRIMARY, threadId: 'ghost' })
    expect(addRoot).not.toHaveBeenCalled()
  })

  it('an addRoot failure is contained (fail-soft) and later roots still open', () => {
    const addRoot = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('raced away')
      })
      .mockImplementation(() => ({}))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { projectContext } = makeDeps({
      threadRoots: [CLOSED_ON_DISK, '/work/other'],
      addRoot,
    })
    expect(() =>
      projectContext.emit(ACTIVE_THREAD_CHANGED_EVENT, { rootPath: PRIMARY, threadId: 't1' }),
    ).not.toThrow()
    expect(addRoot).toHaveBeenCalledTimes(2)
    expect(addRoot).toHaveBeenLastCalledWith('/work/other')
    warn.mockRestore()
  })

  it('dispose unsubscribes', () => {
    const { projectContext, addRoot, dispose } = makeDeps()
    dispose()
    projectContext.emit(ACTIVE_THREAD_CHANGED_EVENT, { rootPath: PRIMARY, threadId: 't1' })
    expect(addRoot).not.toHaveBeenCalled()
  })
})
