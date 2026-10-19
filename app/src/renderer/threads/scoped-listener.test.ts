import { chainCleanup, listenUntilRemoved, type ListenerTarget } from './scoped-listener'

function fakeTarget() {
  const listeners = new Set<(event: string) => void>()
  const target: ListenerTarget<string> = {
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
  }
  return { target, listeners }
}

describe('the rename field’s window listener lives as long as the field', () => {
  it('is removed by the field’s teardown, not by some later keydown', () => {
    const { target, listeners } = fakeTarget()
    const remove = listenUntilRemoved(target, 'keydown', () => undefined, true)
    expect(listeners.size).toBe(1)
    remove()
    expect(listeners.size).toBe(0)
  })

  it('commit, Escape and the menu cleanup may all remove it', () => {
    const { target, listeners } = fakeTarget()
    const removeSpy = jest.spyOn(target, 'removeEventListener')
    const remove = listenUntilRemoved(target, 'keydown', () => undefined, true)
    remove()
    remove()
    remove()
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(listeners.size).toBe(0)
  })

  it('the menu’s cleanup runs the field’s removal and keeps its own', () => {
    const calls: string[] = []
    chainCleanup(() => calls.push('menu'), () => calls.push('field'))()
    expect(calls).toEqual(['field', 'menu'])
    chainCleanup(null, () => calls.push('field-only'))()
    expect(calls).toEqual(['field', 'menu', 'field-only'])
  })
})
