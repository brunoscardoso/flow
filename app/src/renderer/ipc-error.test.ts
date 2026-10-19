import { ipcErrorMessage } from './ipc-error'

describe('ipcErrorMessage (#731)', () => {
  it('strips the Electron remote-method wrapper AND the doubled Error: prefix', () => {
    const raw = new Error(
      "Error invoking remote method 'tasks:importIssue': Error: Not a recognized Jira key or Jira/GitHub/Azure DevOps issue URL: \"gibberish-not-a-key\"",
    )
    expect(ipcErrorMessage(raw)).toBe(
      'Not a recognized Jira key or Jira/GitHub/Azure DevOps issue URL: "gibberish-not-a-key"',
    )
  })

  it('strips a wrapper without the doubled Error: prefix', () => {
    const raw = new Error("Error invoking remote method 'threads:respondDialog': session gone")
    expect(ipcErrorMessage(raw)).toBe('session gone')
  })

  it('passes an unwrapped message through untouched', () => {
    expect(ipcErrorMessage(new Error('That looks like a GitHub URL, but not an issue link.'))).toBe(
      'That looks like a GitHub URL, but not an issue link.',
    )
  })

  it('stringifies non-Error values and degrades opaque objects', () => {
    expect(ipcErrorMessage('plain string failure')).toBe('plain string failure')
    expect(ipcErrorMessage({})).toBe('Unknown error')
  })

  it("strips main's error CLASS name, not just Error: (the banner read IssueFetchError)", () => {
    const raw = new Error(
      "Error invoking remote method 'tasks:importIssue': IssueFetchError: jira request failed — issue not found or no access",
    )
    expect(ipcErrorMessage(raw)).toBe('jira request failed — issue not found or no access')
  })

  it('leaves a capitalised word that is not a class name alone', () => {
    // "Jira:" opens the guidance; eating it would edit the message, not unwrap it.
    const raw = new Error("Error invoking remote method 'tasks:importIssue': Jira: check the site URL")
    expect(ipcErrorMessage(raw)).toBe('Jira: check the site URL')
  })

  it('does not strip a mid-string mention of the wrapper text', () => {
    const msg = 'The log contains "Error invoking remote method \'x\':" verbatim'
    expect(ipcErrorMessage(new Error(msg))).toBe(msg)
  })
})
