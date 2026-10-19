import {
  commitDiffFailedToast,
  fileDiffFailedToast,
  gitErrorMessage,
} from './git-feedback'

describe('gitErrorMessage (#988)', () => {
  it('reads an Error message, and degrades unknown throws gracefully', () => {
    expect(gitErrorMessage(new Error('git exploded'))).toBe('git exploded')
    expect(gitErrorMessage('boom')).toBe('boom')
    expect(gitErrorMessage({})).toBe('Unknown error') // avoids "[object Object]"
  })

  it('strips the Electron IPC wrapper via the ONE unwrap path (#731)', () => {
    expect(
      gitErrorMessage(
        new Error(
          "Error invoking remote method 'git:pull': Error: There is no tracking information for the current branch.",
        ),
      ),
    ).toBe('There is no tracking information for the current branch.')
  })

  it('drops the internal `Command failed: git …` lead line, keeping the real message', () => {
    expect(
      gitErrorMessage(
        new Error(
          "Error invoking remote method 'git:pull': Error: Command failed: git pull --no-edit\n" +
            'There is no tracking information for the current branch.\n' +
            'Please specify which branch you want to merge with.',
        ),
      ),
    ).toBe(
      'There is no tracking information for the current branch.\n' +
        'Please specify which branch you want to merge with.',
    )
  })

  it('surfaces a pre-commit hook message first, not the commit command line', () => {
    expect(
      gitErrorMessage(
        new Error(
          "Error invoking remote method 'git:commitIndex': Error: Command failed: git commit -m feat: nope\n" +
            'blocked by policy: no commits on fridays',
        ),
      ),
    ).toBe('blocked by policy: no commits on fridays')
  })

  it('falls back to the unwrapped text when nothing follows Command failed', () => {
    expect(
      gitErrorMessage(
        new Error("Error invoking remote method 'git:pull': Error: Command failed: git pull"),
      ),
    ).toBe('Command failed: git pull')
  })
})

describe('fileDiffFailedToast (#192)', () => {
  it('names the file and carries the underlying error, at error level', () => {
    const toast = fileDiffFailedToast('src/app.ts', new Error('deleted at HEAD'))
    expect(toast).toEqual({
      title: 'Could not open diff',
      body: 'src/app.ts — deleted at HEAD',
      level: 'error',
    })
  })
})

describe('commitDiffFailedToast (#192)', () => {
  it('names the short commit hash and carries the underlying error', () => {
    const toast = commitDiffFailedToast('1a2b3c4d5e6f', new Error('bad object'))
    expect(toast).toEqual({
      title: 'Could not open diff',
      body: 'commit 1a2b3c4 — bad object',
      level: 'error',
    })
  })
})
