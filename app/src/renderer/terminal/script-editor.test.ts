import { scriptChatText } from './run-setup-model'

describe('what ⌘L sends from a script', () => {
  const script = '#!/usr/bin/env bash\nset -e\necho hi\n'

  it('sends the selection when there is one', () => {
    expect(scriptChatText(script, 20, 26)).toBe('set -e')
  })

  it('sends the whole script when nothing is selected', () => {
    expect(scriptChatText(script, 5, 5)).toBe(script.trim())
  })

  it('sends nothing for an empty script or a blank selection', () => {
    expect(scriptChatText('', 0, 0)).toBeNull()
    expect(scriptChatText('a\n\n\nb', 2, 3)).toBeNull()
  })
})
