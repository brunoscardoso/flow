import { TabScopeGate } from './tab-scope-gate'

const P = '/repo/one'
const T1 = { rootPath: P, threadId: 't1' }
const T2 = { rootPath: P, threadId: 't2' }
const T3 = { rootPath: P, threadId: 't3' }

/** A gate already showing `scope`, as after a settled switch. */
function showing(scope: { rootPath: string; threadId: string | null }): TabScopeGate {
  const gate = new TabScopeGate()
  gate.want(scope)
  gate.settled(scope)
  return gate
}

describe('TabScopeGate', () => {
  it('runs a press at once when the editor shows the set that was asked for', async () => {
    const gate = showing(T1)
    const opened: string[] = []
    const result = await gate.run(() => {
      opened.push('blueprint')
      return 'tab'
    })
    expect(opened).toEqual(['blueprint'])
    expect(result).toBe('tab')
  })

  it('holds a press made during a switch until the incoming set is on screen', async () => {
    const gate = showing(T1)
    gate.want(T2) // the conversation pane already shows T2; the editor still shows T1
    const opened: string[] = []
    const pending = gate.run(() => opened.push('feature view'))
    // The positive first: the switch really is pending.
    expect(gate.unsettled).toBe(true)
    expect(opened).toEqual([])
    gate.settled(T2)
    await pending
    expect(opened).toEqual(['feature view'])
    expect(gate.queued).toBe(0)
  })

  it('drops a press whose set was abandoned before it ever showed', async () => {
    const gate = showing(T1)
    gate.want(T2)
    const opened: string[] = []
    const pending = gate.run(() => opened.push('browser'))
    gate.want(T3) // moved on before T2 loaded
    await expect(pending).resolves.toBeUndefined()
    gate.settled(T3)
    expect(opened).toEqual([])
  })

  it('binds a press made while a selection is unresolved to the set it resolves to', async () => {
    const gate = showing(T1)
    gate.holdSignal()
    const opened: string[] = []
    const pending = gate.run(() => opened.push('changes'))
    expect(gate.unsettled).toBe(true)
    gate.want(T2)
    gate.releaseSignal()
    // Not yet: T2 is wanted but T1 is still what the editor shows.
    expect(opened).toEqual([])
    gate.settled(T2)
    await pending
    expect(opened).toEqual(['changes'])
  })

  it('runs an unresolved press in place when the selection asked for nothing new', async () => {
    const gate = showing(T1)
    gate.holdSignal()
    const opened: string[] = []
    const pending = gate.run(() => opened.push('file'))
    expect(opened).toEqual([])
    gate.releaseSignal() // same conversation re-selected: no switch
    await pending
    expect(opened).toEqual(['file'])
  })

  it('runs a press whose switch was reversed before loading finished', async () => {
    const gate = showing(T1)
    gate.want(T2)
    const pending = gate.run(() => 'x')
    gate.want(T1) // back where it started — the T2 press is dropped, nothing else waits
    await expect(pending).resolves.toBeUndefined()
    expect(gate.unsettled).toBe(false)
    await expect(gate.run(() => 'y')).resolves.toBe('y')
  })

  it('surfaces a press that throws', async () => {
    const gate = showing(T1)
    await expect(
      gate.run(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})
