// Post-merge verification tests (#66; Phase 10). Command RESOLUTION and failure
// PARSING are pure; the runner is exercised with an injected fake exec so no real
// process is ever spawned. Deterministic ordering (typecheck → test → build →
// lint) and the flowconfig-beats-package-scripts priority are pinned exactly.

import {
  parseCommandString,
  parseFlowconfigLines,
  pinCulprit,
  readPackageScripts,
  resolveVerifyCommands,
  runVerify,
  type ExecOutcome,
  type VerifyCommand,
  type VerifyExec,
} from './merge-verify'

describe('parseCommandString', () => {
  it('splits a plain command string into command + argv', () => {
    expect(parseCommandString('npx tsc --noEmit')).toEqual({ command: 'npx', args: ['tsc', '--noEmit'] })
  })

  it('collapses runs of whitespace and trims', () => {
    expect(parseCommandString('  npm   run   lint  ')).toEqual({ command: 'npm', args: ['run', 'lint'] })
  })

  it('returns null for an empty or blank string', () => {
    expect(parseCommandString('')).toBeNull()
    expect(parseCommandString('   ')).toBeNull()
  })
})

describe('resolveVerifyCommands', () => {
  it('returns [] when nothing is configured', () => {
    expect(resolveVerifyCommands({}, {})).toEqual([])
  })

  it('prefers a flowconfig command over the matching package script', () => {
    const commands = resolveVerifyCommands(
      { 'commands.typecheck': 'npx tsc --noEmit' },
      { typecheck: 'tsc -p tsconfig.json' },
    )
    expect(commands).toEqual([{ name: 'typecheck', command: 'npx', args: ['tsc', '--noEmit'] }])
  })

  it('falls back to a package script (via the package manager) when no flowconfig command', () => {
    const commands = resolveVerifyCommands({}, { test: 'jest' })
    expect(commands).toEqual([{ name: 'test', command: 'npm', args: ['run', 'test'] }])
  })

  it('emits commands in the deterministic typecheck → test → build → lint order', () => {
    const commands = resolveVerifyCommands(
      {},
      { lint: 'eslint .', build: 'tsc', test: 'jest', typecheck: 'tsc --noEmit' },
    )
    expect(commands.map((c) => c.name)).toEqual(['typecheck', 'test', 'build', 'lint'])
  })

  it('skips a kind whose flowconfig value is blank and has no package script', () => {
    expect(resolveVerifyCommands({ 'commands.build': '   ' }, {})).toEqual([])
  })

  it('mixes flowconfig and package sources per kind', () => {
    const commands = resolveVerifyCommands(
      { 'commands.typecheck': 'npx tsc --noEmit' },
      { test: 'jest' },
    )
    expect(commands.map((c) => c.name)).toEqual(['typecheck', 'test'])
    expect(commands[1]).toEqual({ name: 'test', command: 'npm', args: ['run', 'test'] })
  })
})

describe('parseFlowconfigLines', () => {
  it('parses key: value lines, skipping comments and blanks', () => {
    const config = parseFlowconfigLines(['# a comment', '', 'commands.test: jest --ci', 'push: true'].join('\n'))
    expect(config).toEqual({ 'commands.test': 'jest --ci', push: 'true' })
  })

  it('trims surrounding whitespace from the value', () => {
    expect(parseFlowconfigLines('commands.lint:   eslint .  ')['commands.lint']).toBe('eslint .')
  })
})

describe('readPackageScripts', () => {
  it('extracts the string-valued scripts map', () => {
    const scripts = readPackageScripts(JSON.stringify({ scripts: { test: 'jest', build: 'tsc' } }))
    expect(scripts).toEqual({ test: 'jest', build: 'tsc' })
  })

  it('drops non-string script values', () => {
    const scripts = readPackageScripts(JSON.stringify({ scripts: { test: 'jest', bad: 42 } }))
    expect(scripts).toEqual({ test: 'jest' })
  })

  it('returns {} for malformed JSON (fail-soft, never throws)', () => {
    expect(readPackageScripts('{ not json')).toEqual({})
  })

  it('returns {} when there is no scripts object', () => {
    expect(readPackageScripts(JSON.stringify({ name: 'x' }))).toEqual({})
  })
})

describe('pinCulprit', () => {
  it('pins the first changed file whose full path appears in the output', () => {
    expect(pinCulprit('error in src/b.ts line 3', ['src/a.ts', 'src/b.ts'])).toBe('src/b.ts')
  })

  it('matches by basename when the tool prints a relative path', () => {
    expect(pinCulprit('FAIL b.test.ts', ['src/nested/b.test.ts'])).toBe('src/nested/b.test.ts')
  })

  it('returns null when no changed file appears in the output', () => {
    expect(pinCulprit('some unrelated failure', ['src/a.ts'])).toBeNull()
  })

  it('ignores empty file entries', () => {
    expect(pinCulprit('mentions src/a.ts', ['', 'src/a.ts'])).toBe('src/a.ts')
  })
})

describe('runVerify', () => {
  const ok: ExecOutcome = { code: 0, stdout: '', stderr: '' }
  const cmd = (name: string): VerifyCommand => ({ name, command: 'x', args: [] })

  it('reports success with no ran steps for an empty command list', async () => {
    const result = await runVerify('/root', [])
    expect(result).toEqual({ ok: true, ran: [] })
  })

  it('runs every command in order and reports ok when all pass', async () => {
    const seen: string[] = []
    const exec: VerifyExec = async (command, _args, cwd) => {
      seen.push(`${command}@${cwd}`)
      return ok
    }
    const result = await runVerify('/root', [cmd('typecheck'), cmd('test')], exec)
    expect(result).toEqual({ ok: true, ran: ['typecheck', 'test'] })
    expect(seen).toHaveLength(2)
  })

  it('stops at the first failing step and captures its combined output', async () => {
    const exec: VerifyExec = async (_command, _args, _cwd) => ({
      code: 1,
      stdout: 'boom-out',
      stderr: 'boom-err',
    })
    const result = await runVerify('/root', [cmd('typecheck'), cmd('test')], exec)
    expect(result.ok).toBe(false)
    expect(result.ran).toEqual(['typecheck']) // never reached 'test'
    expect(result.firstFailure?.name).toBe('typecheck')
    expect(result.firstFailure?.output).toContain('boom-out')
    expect(result.firstFailure?.output).toContain('boom-err')
  })

  it('passes the root path through as the exec cwd', async () => {
    let capturedCwd = ''
    const exec: VerifyExec = async (_command, _args, cwd) => {
      capturedCwd = cwd
      return ok
    }
    await runVerify('/my/root', [cmd('test')], exec)
    expect(capturedCwd).toBe('/my/root')
  })
})
