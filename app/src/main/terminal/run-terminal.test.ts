// Terminals a setup's Run starts: command, title, cwd, run link, and a hard
// kill after the grace. No native process — PtySession is a recording fake.

const created: Array<{ options: Record<string, unknown>; signals: Array<string | undefined> }> = []

jest.mock('./pty-manager', () => {
  const actual = jest.requireActual('./pty-manager')
  class FakePtySession {
    readonly scrollback = new actual.ScrollbackBuffer()
    readonly record: { options: Record<string, unknown>; signals: Array<string | undefined> }
    constructor(options: Record<string, unknown>) {
      this.record = { options, signals: [] }
      created.push(this.record)
    }
    onData(): void {}
    onExit(): void {}
    write(): void {}
    resize(): void {}
    kill(signal?: string): void {
      this.record.signals.push(signal)
    }
    killGroup(signal: string): void {
      this.record.signals.push(`group:${signal}`)
    }
  }
  return { ...actual, PtySession: FakePtySession }
})

import { TerminalManager } from './index'

const RUN = { scopeKey: 'scope', stepId: 'dev', projectRoot: '/repos/project' }

describe('TerminalManager — run terminals', () => {
  beforeEach(() => {
    created.length = 0
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it('a plain terminal is unchanged: no command, folder title, no run link', () => {
    const manager = new TerminalManager()
    const info = manager.createUserTerminal({ rootId: '/repos/project', cols: 80, rows: 24 })
    expect(info.title).toBe('project')
    expect(info.run).toBeUndefined()
    expect(created[0]?.options.command).toBeUndefined()
    expect(created[0]?.options.env).toBeUndefined()
  })

  it('a command terminal gets its title, run link and cwd, and the PTY gets the command', () => {
    const manager = new TerminalManager()
    const info = manager.createUserTerminal({
      rootId: '/repos/project',
      cols: 80,
      rows: 24,
      command: 'npm run dev',
      cwd: '/repos/.project-threads/blue',
      title: 'Dev server',
      run: RUN,
      env: { PORT: '3001' },
    })
    expect(info).toMatchObject({
      title: 'Dev server',
      cwd: '/repos/.project-threads/blue',
      projectRoot: '/repos/project',
      run: RUN,
    })
    expect(created[0]?.options).toMatchObject({
      command: 'npm run dev',
      cwd: '/repos/.project-threads/blue',
      env: { PORT: '3001' },
    })
    expect(manager.getTerminal(info.terminalId)?.run).toEqual(RUN)
  })

  it('dispose of a run terminal hangs up, then SIGKILLs after the grace', () => {
    const manager = new TerminalManager()
    const info = manager.createUserTerminal({ rootId: '/r', cols: 80, rows: 24, command: 'x', run: RUN })
    manager.dispose(info.terminalId)
    expect(created[0]?.signals).toEqual([undefined])
    jest.advanceTimersByTime(1_999)
    expect(created[0]?.signals).toEqual([undefined])
    jest.advanceTimersByTime(1)
    expect(created[0]?.signals).toEqual([undefined, 'group:SIGKILL'])
  })

  it('dispose of a plain terminal never escalates', () => {
    const manager = new TerminalManager()
    const info = manager.createUserTerminal({ rootId: '/r', cols: 80, rows: 24 })
    manager.dispose(info.terminalId)
    expect(created[0]?.signals).toEqual([undefined]) // the hang-up happened
    jest.advanceTimersByTime(10_000)
    expect(created[0]?.signals).toEqual([undefined])
  })

  it('stopProcess keeps the tab, escalates, and refuses unknown or agent terminals', () => {
    const manager = new TerminalManager()
    const info = manager.createUserTerminal({ rootId: '/r', cols: 80, rows: 24, command: 'x', run: RUN })
    expect(manager.stopProcess(info.terminalId)).toBe(true)
    expect(manager.getTerminal(info.terminalId)).not.toBeNull()
    jest.advanceTimersByTime(2_000)
    expect(created[0]?.signals).toEqual([undefined, 'group:SIGKILL'])

    expect(manager.stopProcess('nope')).toBe(false)
    const agent = manager.ensureAgentTerminal({ threadId: 't1', projectRoot: '/r' })
    expect(manager.stopProcess(agent.terminalId)).toBe(false)
  })

  it('hears plainly typed command lines of an interactive shell, keyed by its project, and never a Run terminal', () => {
    const manager = new TerminalManager()
    const heard: Array<[string, string]> = []
    const shell = manager.createUserTerminal({
      rootId: '/repos/.project-threads/blue',
      cols: 80,
      rows: 24,
      owner: { rootPath: '/repos/project', threadId: 't1' },
    })
    const step = manager.createUserTerminal({ rootId: '/repos/project', cols: 80, rows: 24, command: 'npm run dev', run: RUN })
    // Nobody listening yet: nothing is buffered.
    manager.write(shell.terminalId, 'ls\r')
    manager.setCommandLineListener((root, line) => heard.push([root, line]))
    for (const key of 'npm run dev') manager.write(shell.terminalId, key)
    manager.write(shell.terminalId, '\r')
    manager.write(shell.terminalId, '\x1b[A\r')
    manager.write(step.terminalId, 'q\r')
    expect(heard).toEqual([['/repos/project', 'npm run dev']])
  })
})
