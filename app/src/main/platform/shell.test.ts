import { shellSpec } from './shell'

describe('shellSpec on POSIX', () => {
  it('prefers $SHELL', () => {
    expect(shellSpec('darwin', '/opt/homebrew/bin/fish').shell).toBe('/opt/homebrew/bin/fish')
    expect(shellSpec('linux', '/usr/bin/zsh').shell).toBe('/usr/bin/zsh')
  })

  it('falls back per platform when $SHELL is absent, empty or whitespace', () => {
    expect(shellSpec('darwin').shell).toBe('/bin/zsh')
    expect(shellSpec('darwin', '').shell).toBe('/bin/zsh')
    expect(shellSpec('darwin', '   ').shell).toBe('/bin/zsh')
    expect(shellSpec('linux').shell).toBe('/bin/bash')
  })

  it('trims $SHELL, matching detectShell’s current behavior', () => {
    expect(shellSpec('darwin', '  /bin/bash  ').shell).toBe('/bin/bash')
  })

  it('uses a LOGIN shell for both forms', () => {
    // Without `-l` the PATH setup users keep in .zprofile/.bash_profile never
    // runs, and the session's first `npm`/`git` is "command not found".
    const spec = shellSpec('darwin', '/bin/zsh')
    expect(spec.interactiveArgs).toEqual(['-l'])
    expect(spec.singleCommandArgs('echo hi')).toEqual(['-l', '-c', 'echo hi'])
  })

  it('keeps the single command as ONE argument', () => {
    expect(shellSpec('darwin', '/bin/zsh').singleCommandArgs('git commit -m "a b"')).toEqual([
      '-l',
      '-c',
      'git commit -m "a b"',
    ])
  })
})

describe('shellSpec on win32', () => {
  it('spawns Windows PowerShell, which is always present', () => {
    expect(shellSpec('win32').shell).toBe('powershell.exe')
  })

  it('ignores $SHELL — on Windows it is a Git Bash / WSL leftover', () => {
    expect(shellSpec('win32', '/usr/bin/bash').shell).toBe('powershell.exe')
  })

  it('suppresses the banner on interactive sessions', () => {
    expect(shellSpec('win32').interactiveArgs).toEqual(['-NoLogo'])
  })

  it('uses -Command, NOT the POSIX -c, for a single command', () => {
    // The defect this replaces: pty-manager builds `[...args, '-c', command]`
    // unconditionally — the POSIX form, reused by accident on PowerShell.
    const args = shellSpec('win32').singleCommandArgs('Get-ChildItem')
    expect(args).toEqual(['-NoLogo', '-NonInteractive', '-Command', 'Get-ChildItem'])
    expect(args).not.toContain('-c')
  })

  it('runs the user profile, the counterpart of POSIX -l', () => {
    // -NoProfile is the tempting default and the exact opposite of `-l`: the
    // PowerShell profile is where a Windows user's PATH additions live.
    expect(shellSpec('win32').singleCommandArgs('x')).not.toContain('-NoProfile')
    expect(shellSpec('win32').interactiveArgs).not.toContain('-NoProfile')
  })

  it('is non-interactive for single commands only, so a prompt errors instead of hanging', () => {
    expect(shellSpec('win32').singleCommandArgs('x')).toContain('-NonInteractive')
    expect(shellSpec('win32').interactiveArgs).not.toContain('-NonInteractive')
  })

  it('keeps the command as ONE trailing argument', () => {
    const command = 'Set-Content -Path "C:\\a b\\c.txt" -Value "hi"'
    const args = shellSpec('win32').singleCommandArgs(command)
    expect(args[args.length - 1]).toBe(command)
    expect(args.filter((arg) => arg === command)).toHaveLength(1)
  })
})

describe('shellSpec across platforms', () => {
  it('always puts the interactive args at the head of the single-command argv', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const spec = shellSpec(platform, '/bin/zsh')
      expect(spec.singleCommandArgs('x').slice(0, spec.interactiveArgs.length)).toEqual(
        spec.interactiveArgs,
      )
    }
  })
})
