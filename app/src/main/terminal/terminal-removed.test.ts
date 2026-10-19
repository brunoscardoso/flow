import { TerminalManager, TERMINAL_REMOVED_EVENT, type TerminalRemovedEvent } from './index'

// Agent (⚙) terminals are virtual (no pty), so ensureAgentTerminal + dispose run
// without any native process. Guards the #304 fix: dispose() must emit
// terminal:removed so the renderer can drop the tab — virtual agent terminals
// never emit terminal:exit, so this is their ONLY removal signal.
describe('TerminalManager dispose → terminal:removed (#304)', () => {
  it('emits terminal:removed with the disposed id', () => {
    const mgr = new TerminalManager()
    const removed: string[] = []
    mgr.on(TERMINAL_REMOVED_EVENT, (e: TerminalRemovedEvent) => removed.push(e.terminalId))

    const info = mgr.ensureAgentTerminal({ threadId: 't1', title: 'Agent' })
    mgr.dispose(info.terminalId)

    expect(removed).toEqual([info.terminalId])
    mgr.disposeAll()
  })

  it('does not emit for an unknown / already-disposed id (no duplicate tab removal)', () => {
    const mgr = new TerminalManager()
    const removed: string[] = []
    mgr.on(TERMINAL_REMOVED_EVENT, (e: TerminalRemovedEvent) => removed.push(e.terminalId))

    const info = mgr.ensureAgentTerminal({ threadId: 't1' })
    mgr.dispose(info.terminalId) // 1st: emits
    mgr.dispose(info.terminalId) // 2nd: entry gone → no-op, no event
    mgr.dispose('never-existed') // unknown → no-op, no event

    expect(removed).toEqual([info.terminalId])
    mgr.disposeAll()
  })

  it('re-opening a disposed thread gets a fresh terminal that also emits on dispose', () => {
    const mgr = new TerminalManager()
    const removed: string[] = []
    mgr.on(TERMINAL_REMOVED_EVENT, (e: TerminalRemovedEvent) => removed.push(e.terminalId))

    const first = mgr.ensureAgentTerminal({ threadId: 't1' })
    mgr.dispose(first.terminalId)
    const second = mgr.ensureAgentTerminal({ threadId: 't1' })
    expect(second.terminalId).not.toBe(first.terminalId) // fresh, not the disposed one
    mgr.dispose(second.terminalId)

    expect(removed).toEqual([first.terminalId, second.terminalId])
    mgr.disposeAll()
  })
})
