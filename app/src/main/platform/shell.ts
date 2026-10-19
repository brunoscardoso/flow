// Platform encoding of the shell a PTY session spawns.
//
// `detectShell()` in terminal/pty-manager.ts already returns `powershell.exe`
// on Windows, but the caller then builds the single-command argv as
// `[...args, '-c', command]` — the POSIX form, reused by accident. PowerShell
// has no `-c`; it has `-Command`, and the closest it gets to `-c` is the
// ambiguous abbreviation of it. The Windows terminal therefore "works" only
// for interactive sessions, which is exactly why nobody noticed.
//
// So the single-command shape is part of the spec here, not something each
// call site assembles. Pure and platform-parameterized (NFR3): the optional
// `envShell` argument stands in for `$SHELL` so a test can pin either branch
// from any host.

/** How to launch one platform's shell, both interactively and for one command. */
export interface ShellSpec {
  /** Executable to spawn. */
  shell: string
  /** Argv for an interactive session. */
  interactiveArgs: string[]
  /** Argv for running ONE command and exiting. */
  singleCommandArgs: (command: string) => string[]
}

/** Windows PowerShell 5.1 — always present, unlike `pwsh`. */
const WINDOWS_SHELL = 'powershell.exe'

/**
 * The shell spec for a platform.
 *
 * POSIX keeps today's behavior exactly: `$SHELL` first, `/bin/zsh` on macOS
 * and `/bin/bash` elsewhere as the fallback, and `-l` on BOTH forms. The login
 * flag matters — without it the PATH setup users keep in `.zprofile` /
 * `.bash_profile` never runs and the first `npm`/`git` hits "command not
 * found".
 *
 * Windows mirrors that intent rather than the flags:
 *  - `-NoLogo` suppresses the copyright banner that would otherwise be the
 *    first thing written to a fresh terminal (and the first thing a
 *    single-command caller has to parse around).
 *  - The PowerShell profile is deliberately NOT suppressed. `-NoProfile` is
 *    the tempting default, but it is the exact opposite of POSIX's `-l`: the
 *    profile is where a Windows user's PATH additions live.
 *  - `-NonInteractive` on the single-command form only. A command that decides
 *    to prompt (`Read-Host`, a confirmation) has no one to answer it there, so
 *    it must error instead of hanging forever behind a pty nobody is watching.
 *  - `-Command` is the real single-command switch; the command travels as ONE
 *    argument and must not be pre-split by the caller.
 *
 * `envShell` is ignored on Windows: `$SHELL` on a Windows host, when set at
 * all, is normally a leftover pointing at a POSIX shell from Git Bash or WSL.
 */
export function shellSpec(
  platform: NodeJS.Platform | string,
  envShell?: string,
): ShellSpec {
  if (platform === 'win32') {
    return {
      shell: WINDOWS_SHELL,
      interactiveArgs: ['-NoLogo'],
      singleCommandArgs: (command: string) => [
        '-NoLogo',
        '-NonInteractive',
        '-Command',
        command,
      ],
    }
  }
  const trimmed = envShell?.trim()
  const shell =
    trimmed !== undefined && trimmed.length > 0
      ? trimmed
      : platform === 'darwin'
        ? '/bin/zsh'
        : '/bin/bash'
  return {
    shell,
    interactiveArgs: ['-l'],
    singleCommandArgs: (command: string) => ['-l', '-c', command],
  }
}
