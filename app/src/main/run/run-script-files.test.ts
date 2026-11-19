// Script files for one-time actions — temp folders only.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunScriptFiles, scriptFileCommand, SCRIPT_LEFTOVER_MS, shellQuote } from './run-script-files'

let parent: string
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), 'flow-run-script-files-'))
})
afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

describe('shellQuote / scriptFileCommand', () => {
  it('single-quotes a path, escaping its quotes', () => {
    expect(shellQuote('/a b/it\'s')).toBe(`'/a b/it'\\''s'`)
    expect(scriptFileCommand('/x/y', true)).toBe(`'/x/y'`)
    expect(scriptFileCommand('/x/y', false)).toBe(`bash '/x/y'`)
  })
})

describe('createRunScriptFiles', () => {
  it('on Windows passes the text as the command and writes nothing', async () => {
    const dir = join(parent, 'scripts')
    const files = createRunScriptFiles({ dir, platform: 'win32' })
    expect(await files.prepare('echo a\r\necho b')).toEqual({ command: 'echo a\necho b', file: null })
    expect(existsSync(dir)).toBe(false)
  })

  it('writes each script to its own file with a unique name', async () => {
    const dir = join(parent, 'scripts')
    const files = createRunScriptFiles({ dir, platform: 'linux' })
    const a = await files.prepare('echo a')
    const b = await files.prepare('echo a')
    expect(a.file).not.toBe(b.file)
    expect(readdirSync(dir)).toHaveLength(2)
    await files.remove(a.file!)
    await files.remove(a.file!) // twice is fine
    expect(readdirSync(dir)).toHaveLength(1)
  })

  it('sweeps leftovers older than a day on first use, and keeps newer ones and foreign files', async () => {
    const dir = join(parent, 'scripts')
    mkdirSync(dir)
    const old = join(dir, 'script-old')
    const fresh = join(dir, 'script-fresh')
    const other = join(dir, 'notes.txt')
    for (const path of [old, fresh, other]) writeFileSync(path, 'x')
    const now = Date.now()
    const longAgo = (now - SCRIPT_LEFTOVER_MS - 60_000) / 1000
    utimesSync(old, longAgo, longAgo)
    utimesSync(other, longAgo, longAgo)
    const files = createRunScriptFiles({ dir, platform: 'darwin', now: () => now })
    await files.sweep()
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(other)).toBe(true)
  })

  it('a sweep with no folder yet does nothing and does not throw', async () => {
    const files = createRunScriptFiles({ dir: join(parent, 'missing'), platform: 'darwin' })
    await expect(files.sweep()).resolves.toBeUndefined()
  })
})
