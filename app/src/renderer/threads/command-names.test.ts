import { isKnownCommand, onCommandNamesChanged, publishCommandNames } from './command-names'

describe('command names', () => {
  it('answers from the last published list and notifies only on change', () => {
    const heard: number[] = []
    const stop = onCommandNamesChanged(() => heard.push(1))
    publishCommandNames([{ name: 'create-plan' }, { name: 'brainstorm' }])
    expect(isKnownCommand('create-plan')).toBe(true)
    expect(isKnownCommand('usr')).toBe(false)
    publishCommandNames([{ name: 'brainstorm' }, { name: 'create-plan' }])
    expect(heard).toHaveLength(1)
    publishCommandNames([])
    expect(isKnownCommand('create-plan')).toBe(false)
    expect(heard).toHaveLength(2)
    stop()
    publishCommandNames([{ name: 'x' }])
    expect(heard).toHaveLength(2)
  })
})
