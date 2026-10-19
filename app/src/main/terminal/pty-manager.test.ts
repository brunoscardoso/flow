// The terminal's SPAWN SHAPE — which executable a PtySession launches and with
// which argv, for an interactive session and for a single command.
//
// Why this file exists (Phase 9, task 6): the Windows form was never chosen.
// `detectShell()` returned `powershell.exe` with no args and the constructor
// then appended `'-c'` — the POSIX shape, reused verbatim. It "worked" only
// because PowerShell accepts `-c` as an abbreviation of `-Command`, and only
// for the interactive case nobody was checking. Phase 1 wrote the real spec in
// `../platform/shell` and nothing consumed it, so FR4 rested on an accident.
//
// The assertions below are therefore a regression net in two directions:
//  - darwin is pinned to the PRE-PORT literals (`$SHELL` or `/bin/zsh`, `-l`,
//    `-l -c <command>`) — NFR1 forbids any macOS behavior change.
//  - win32 is pinned to the DELIBERATE form, so nobody re-derives it from the
//    POSIX one again.
//
// `ptySpawnSpec` is pure and platform-parameterized, so both branches are
// asserted from any host without node-pty and without spawning anything.
// Importing this module is side-effect free: node-pty is required lazily
// inside the PtySession constructor, never at load.

import { detectShell, ptySpawnSpec } from './pty-manager'

const COMMAND = 'npm run build'

describe('ptySpawnSpec on darwin (NFR1 — the pre-port shape, unchanged)', () => {
  it('spawns the login shell from $SHELL for an interactive session', () => {
    expect(ptySpawnSpec(undefined, 'darwin', '/opt/homebrew/bin/fish')).toEqual({
      shell: '/opt/homebrew/bin/fish',
      args: ['-l'],
    })
  })

  it('falls back to /bin/zsh on darwin and /bin/bash elsewhere', () => {
    // `''` rather than `undefined` for "no $SHELL": an explicit `undefined`
    // argument takes the parameter's default, which reads the REAL host env
    // and would make this assertion depend on the machine running it.
    expect(ptySpawnSpec(undefined, 'darwin', '').shell).toBe('/bin/zsh')
    expect(ptySpawnSpec(undefined, 'darwin', '   ').shell).toBe('/bin/zsh')
    expect(ptySpawnSpec(undefined, 'linux', '').shell).toBe('/bin/bash')
  })

  it('runs a single command as `-l -c <command>`, the command unsplit', () => {
    // The exact argv the pre-port constructor produced: `[...args, '-c', cmd]`
    // with `args = ['-l']`. A diff here is a macOS behavior change.
    expect(ptySpawnSpec(COMMAND, 'darwin', '/bin/zsh')).toEqual({
      shell: '/bin/zsh',
      args: ['-l', '-c', COMMAND],
    })
  })

  it('keeps a command with spaces and quotes as ONE argument', () => {
    const command = 'git commit -m "two words"'
    const { args } = ptySpawnSpec(command, 'darwin', '/bin/zsh')
    expect(args).toEqual(['-l', '-c', command])
    expect(args[2]).toBe(command)
  })

  it('keeps `-l` on BOTH forms — without it .zprofile never runs', () => {
    expect(ptySpawnSpec(undefined, 'darwin', '/bin/zsh').args).toContain('-l')
    expect(ptySpawnSpec(COMMAND, 'darwin', '/bin/zsh').args).toContain('-l')
  })
})

describe('ptySpawnSpec on win32 (FR4 — deliberate, not inherited)', () => {
  it('spawns powershell.exe, which is always present unlike pwsh', () => {
    expect(ptySpawnSpec(undefined, 'win32').shell).toBe('powershell.exe')
    expect(ptySpawnSpec(COMMAND, 'win32').shell).toBe('powershell.exe')
  })

  it('ignores $SHELL — on Windows it is a leftover from Git Bash or WSL', () => {
    expect(ptySpawnSpec(undefined, 'win32', '/usr/bin/bash').shell).toBe('powershell.exe')
    expect(ptySpawnSpec(COMMAND, 'win32', '/bin/zsh').args).not.toContain('/bin/zsh')
  })

  it('opens an interactive session with -NoLogo and nothing else', () => {
    expect(ptySpawnSpec(undefined, 'win32').args).toEqual(['-NoLogo'])
  })

  it('runs a single command with -Command, never the POSIX -c', () => {
    // The defect this test exists to prevent from coming back: `['-c', cmd]`,
    // which survives only as an ambiguous abbreviation PowerShell may stop
    // accepting, and which carries neither -NoLogo nor -NonInteractive.
    const { args } = ptySpawnSpec(COMMAND, 'win32')
    expect(args).toEqual(['-NoLogo', '-NonInteractive', '-Command', COMMAND])
    expect(args).not.toContain('-c')
    expect(args).not.toContain('-l')
  })

  it('passes the command as ONE trailing argument, unsplit', () => {
    const command = 'Get-ChildItem -Path "C:\\Program Files" -Recurse'
    const { args } = ptySpawnSpec(command, 'win32')
    expect(args[args.length - 1]).toBe(command)
    expect(args.filter((arg) => arg === command)).toHaveLength(1)
  })

  it('is -NonInteractive ONLY for a single command', () => {
    // A single command runs behind a pty nobody is watching: a prompt there
    // hangs forever, so it must error instead. An interactive session is the
    // opposite case and must keep its prompts.
    expect(ptySpawnSpec(COMMAND, 'win32').args).toContain('-NonInteractive')
    expect(ptySpawnSpec(undefined, 'win32').args).not.toContain('-NonInteractive')
  })

  it('never passes -NoProfile — the profile is Windows’ counterpart of `-l`', () => {
    expect(ptySpawnSpec(undefined, 'win32').args).not.toContain('-NoProfile')
    expect(ptySpawnSpec(COMMAND, 'win32').args).not.toContain('-NoProfile')
  })
})

describe('ptySpawnSpec — interactive vs single-command selection', () => {
  it('treats an empty command as interactive, exactly as before the port', () => {
    // The pre-port constructor branched on truthiness (`options.command ? …`),
    // so `''` meant "interactive login shell". Changing that to an `undefined`
    // check would silently start running an empty command instead.
    expect(ptySpawnSpec('', 'darwin', '/bin/zsh').args).toEqual(['-l'])
    expect(ptySpawnSpec('', 'win32').args).toEqual(['-NoLogo'])
  })

  it('gives every platform a distinct interactive and single-command argv', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const interactive = ptySpawnSpec(undefined, platform, '/bin/zsh')
      const single = ptySpawnSpec(COMMAND, platform, '/bin/zsh')
      expect(single.shell).toBe(interactive.shell)
      expect(single.args).not.toEqual(interactive.args)
      expect(single.args).toContain(COMMAND)
    }
  })
})

describe('detectShell', () => {
  it('reports the interactive form for the host it runs on', () => {
    // Kept as the module's public interactive read, now delegating to the same
    // spec the constructor uses so the two cannot drift apart.
    const { shell, args } = detectShell()
    expect(shell).toBe(ptySpawnSpec(undefined).shell)
    expect(args).toEqual(ptySpawnSpec(undefined).args)
  })

  it('agrees with the platform spec about the shell it names', () => {
    const { shell } = detectShell()
    if (process.platform === 'win32') {
      expect(shell).toBe('powershell.exe')
    } else {
      expect(shell).toBe(process.env.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'))
    }
  })
})
