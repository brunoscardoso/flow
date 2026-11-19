/**
 * SCRIPT FILES FOR ONE-TIME ACTIONS — a one-time action that holds a script
 * runs it as ONE file, never line by line, so `set -e` stops at the first
 * failure and a loop spans its lines as written.
 *
 *   - The script is written to a private file in a folder only this user can
 *     read (folder and file 0700), under a name nobody can guess or collide
 *     with, and the command handed to the login shell runs that file: the file
 *     itself when its first line names the program (`#!` — the kernel honours
 *     it), else `bash '<file>'`. The path is single-quoted for the shell.
 *   - The file is removed when the run ends (the caller says when). Leftovers
 *     a crash or a quit left behind are swept on first use: anything older than
 *     a day.
 *   - Windows has no shebang and no POSIX shell to hand it to: there the text
 *     is passed as the command, as before (`prepare` returns no file).
 *
 * Every filesystem call is async (allowed-pattern #19) and injected, so the
 * tests use temp folders only. Nothing here ever logs a script's contents —
 * a script can hold a password.
 */
import { randomUUID } from 'node:crypto'
import { promises as nodeFs } from 'node:fs'
import { join } from 'node:path'

/** The filesystem calls this module makes (node's `fs.promises` shape). */
export interface RunScriptFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  chmod(path: string, mode: number): Promise<void>
  writeFile(path: string, data: string, options: { mode: number; flag: 'wx' }): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
  readdir(path: string): Promise<string[]>
  stat(path: string): Promise<{ mtimeMs: number; isFile(): boolean }>
}

export interface RunScriptFilesOptions {
  /** The private folder the files go in (the app's own data folder + a name). */
  dir: string
  fs?: RunScriptFs
  /** `process.platform` by default. */
  platform?: NodeJS.Platform
  /** A unique name part — a random UUID by default. */
  newId?: () => string
  now?: () => number
}

/** What to run for a script: the command for the login shell, and the file to remove after (null: none). */
export interface PreparedScript {
  command: string
  file: string | null
}

/** Leftover script files older than this are removed on first use. */
export const SCRIPT_LEFTOVER_MS = 24 * 60 * 60 * 1000
const PRIVATE = 0o700
const PREFIX = 'script-'

/** A path quoted for a POSIX shell: inside single quotes, each `'` written as `'\''`. */
export function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/** The command that runs a script file: the file itself when it names its program, else bash with it. */
export function scriptFileCommand(file: string, hasShebang: boolean): string {
  return hasShebang ? shellQuote(file) : `bash ${shellQuote(file)}`
}

export interface RunScriptFiles {
  /** Write the script to its own private file and say how to run it. Throws when it cannot be written. */
  prepare(script: string): Promise<PreparedScript>
  /** Remove a file `prepare` wrote. Never throws. */
  remove(file: string): Promise<void>
  /** Remove leftovers older than a day. Never throws. Runs once on its own, on first use. */
  sweep(): Promise<void>
}

export function createRunScriptFiles(options: RunScriptFilesOptions): RunScriptFiles {
  const fs: RunScriptFs = options.fs ?? (nodeFs as unknown as RunScriptFs)
  const platform = options.platform ?? process.platform
  const newId = options.newId ?? randomUUID
  const now = options.now ?? Date.now
  const dir = options.dir
  let swept: Promise<void> | null = null

  const ensureDir = async (): Promise<void> => {
    await fs.mkdir(dir, { recursive: true, mode: PRIVATE })
    // The folder may predate this build, or the umask may have narrowed the mode.
    await fs.chmod(dir, PRIVATE)
  }

  const sweep = async (): Promise<void> => {
    try {
      const names = await fs.readdir(dir)
      const cutoff = now() - SCRIPT_LEFTOVER_MS
      await Promise.all(
        names
          .filter((name) => name.startsWith(PREFIX))
          .map(async (name) => {
            const path = join(dir, name)
            try {
              const info = await fs.stat(path)
              if (info.isFile() && info.mtimeMs < cutoff) await fs.rm(path, { force: true })
            } catch {
              // Gone already, or not ours to read: leave it.
            }
          }),
      )
    } catch {
      // No folder yet: nothing to sweep.
    }
  }

  const sweepOnce = (): Promise<void> => {
    swept ??= sweep()
    return swept
  }

  return {
    async prepare(script) {
      const text = script.replace(/\r\n?/g, '\n')
      if (platform === 'win32') return { command: text, file: null }
      void sweepOnce()
      await ensureDir()
      const file = join(dir, `${PREFIX}${newId()}`)
      const body = text.endsWith('\n') ? text : `${text}\n`
      // 'wx': never write into a file that is already there.
      await fs.writeFile(file, body, { mode: PRIVATE, flag: 'wx' })
      await fs.chmod(file, PRIVATE)
      return { command: scriptFileCommand(file, text.startsWith('#!')), file }
    },
    async remove(file) {
      try {
        await fs.rm(file, { force: true })
      } catch {
        // The sweep removes it later.
      }
    },
    sweep: sweepOnce,
  }
}
