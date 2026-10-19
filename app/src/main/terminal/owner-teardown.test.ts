// A person's shells in a thread's checkout belong to the PROJECT through their
// owner, not their root: removing the project must take them too. And a tab's
// name is kept in main, so it is saved with the shell.
//
// No native process: PtySession is replaced by an inert stand-in, so user
// shells can be created under plain Node.

jest.mock('./pty-manager', () => {
  const actual = jest.requireActual('./pty-manager')
  class FakePtySession {
    readonly scrollback = new actual.ScrollbackBuffer()
    killed = false
    onData(): void {}
    onExit(): void {}
    write(): void {}
    resize(): void {}
    kill(): void {
      this.killed = true
    }
  }
  return { ...actual, PtySession: FakePtySession }
})

import type { TerminalInfo, TerminalOwner } from '../../shared/ipc-contract'
import {
  TERMINAL_REMOVED_EVENT,
  TERMINAL_RENAMED_EVENT,
  TerminalManager,
  type TerminalRemovedEvent,
} from './index'

const PROJECT = '/repos/project'
const OTHER = '/repos/other'
const WORKTREE = '/repos/.project-threads/blue-heron'
const THREAD: TerminalOwner = { rootPath: PROJECT, threadId: 't1' }

describe('TerminalManager.disposeForRoot — thread worktree shells', () => {
  it('takes the project’s thread shells sitting in their checkout, and leaves other projects alone', () => {
    const manager = new TerminalManager()
    const removed: string[] = []
    manager.on(TERMINAL_REMOVED_EVENT, (event: TerminalRemovedEvent) => removed.push(event.terminalId))

    const inCheckout = manager.createUserTerminal({ rootId: WORKTREE, cols: 80, rows: 24, owner: THREAD })
    const inProject = manager.createUserTerminal({
      rootId: PROJECT,
      cols: 80,
      rows: 24,
      owner: { rootPath: PROJECT, threadId: null },
    })
    const elsewhere = manager.createUserTerminal({
      rootId: OTHER,
      cols: 80,
      rows: 24,
      owner: { rootPath: OTHER, threadId: 't9' },
    })
    // Positive first: the checkout shell's root is NOT the project — which is
    // why matching on projectRoot alone missed it.
    expect(manager.getTerminal(inCheckout.terminalId)?.projectRoot).toBe(WORKTREE)

    expect(manager.disposeForRoot(PROJECT)).toBe(2)
    expect(removed.sort()).toEqual([inCheckout.terminalId, inProject.terminalId].sort())
    expect(manager.getTerminal(elsewhere.terminalId)).not.toBeNull()
    manager.disposeAll()
  })
})

describe('TerminalManager.rename', () => {
  it('keeps a person’s name for the tab, clears it on null or blank, and says so each time', () => {
    const manager = new TerminalManager()
    const renamed: TerminalInfo[] = []
    manager.on(TERMINAL_RENAMED_EVENT, (info: TerminalInfo) => renamed.push(info))
    const shell = manager.createUserTerminal({ rootId: WORKTREE, cols: 80, rows: 24, owner: THREAD })

    expect(manager.rename(shell.terminalId, '  server  ')).toBe(true)
    expect(manager.getTerminal(shell.terminalId)?.customTitle).toBe('server')
    expect(manager.listTerminals()[0]?.customTitle).toBe('server')

    expect(manager.rename(shell.terminalId, null)).toBe(true)
    expect(manager.getTerminal(shell.terminalId)?.customTitle).toBeUndefined()
    manager.rename(shell.terminalId, 'x')
    manager.rename(shell.terminalId, '   ')
    expect(manager.getTerminal(shell.terminalId)?.customTitle).toBeUndefined()

    expect(renamed.map((info) => info.customTitle)).toEqual(['server', undefined, 'x', undefined])
    expect(manager.rename('nope', 'x')).toBe(false)
    expect(renamed).toHaveLength(4)
    manager.disposeAll()
  })
})
