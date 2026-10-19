import {
  errorText,
  terminalAttachFailedToast,
  terminalCreateFailedToast,
} from './terminal-feedback'

describe('errorText', () => {
  it('reads an Error message, and degrades unknown throws gracefully', () => {
    expect(errorText(new Error('spawn /bin/zsh ENOENT'))).toBe('spawn /bin/zsh ENOENT')
    expect(errorText('no pty')).toBe('no pty')
    expect(errorText({})).toBe('Unknown error') // avoids "[object Object]"
  })

  it('unwraps the Electron IPC wrapper via the shared helper (#988)', () => {
    expect(
      errorText(new Error("Error invoking remote method 'terminal:create': Error: no pty")),
    ).toBe('no pty')
  })
})

describe('terminalCreateFailedToast (#209)', () => {
  it('carries the underlying error at error level', () => {
    expect(terminalCreateFailedToast(new Error('shell missing'))).toEqual({
      title: "Couldn't open terminal",
      body: 'shell missing',
      level: 'error',
    })
  })
})

describe('terminalAttachFailedToast (#209)', () => {
  it('explains the view failed to load and carries the error', () => {
    expect(terminalAttachFailedToast(new Error('xterm boom'))).toEqual({
      title: "Couldn't open terminal",
      body: 'The terminal view failed to load — xterm boom.',
      level: 'error',
    })
  })
})
