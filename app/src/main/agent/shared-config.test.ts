// shared-config tests — the stager's content-gating, idempotency, manifest-only
// cleanup, and CLAUDE.md splice, exercised against real temp dirs (no mocks), the
// same way cli-shim.test.ts does.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ensureSharedConfig, splicePlanFlowSection } from './shared-config'

const VERSION = '1.2.3'

function makeSource(root: string): {
  commandsDir: string
  resourcesDir: string
  hookScriptsDir: string
  claudeMdBody: string
} {
  const commandsDir = join(root, 'src', 'commands')
  const resourcesDir = join(root, 'src', 'resources', 'core')
  const hookScriptsDir = join(root, 'src', 'hooks')
  mkdirSync(commandsDir, { recursive: true })
  mkdirSync(resourcesDir, { recursive: true })
  mkdirSync(hookScriptsDir, { recursive: true })
  writeFileSync(join(commandsDir, 'create-plan.md'), '# create-plan\n')
  writeFileSync(join(commandsDir, 'review-code.md'), '# review-code\n')
  writeFileSync(join(resourcesDir, 'rules.md'), '# rules\n')
  writeFileSync(join(hookScriptsDir, 'cost-tracker.cjs'), '// hook\n')
  return {
    commandsDir,
    resourcesDir: join(root, 'src', 'resources'),
    hookScriptsDir,
    claudeMdBody: '# Plan-Flow core instructions',
  }
}

describe('ensureSharedConfig', () => {
  let base: string
  let configDir: string
  let source: ReturnType<typeof makeSource>

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pf-shared-'))
    configDir = join(base, 'cfg')
    source = makeSource(base)
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('stages commands, resources, hooks and splices CLAUDE.md, recording a manifest', () => {
    const result = ensureSharedConfig(configDir, source, VERSION)

    expect(result.ok).toBe(true)
    expect(result.action).toBe('staged')
    expect(existsSync(join(configDir, 'commands', 'create-plan.md'))).toBe(true)
    expect(existsSync(join(configDir, 'commands', 'review-code.md'))).toBe(true)
    expect(existsSync(join(configDir, 'resources', 'core', 'rules.md'))).toBe(true)
    expect(existsSync(join(configDir, 'hooks', 'cost-tracker.cjs'))).toBe(true)

    const claudeMd = readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('<!-- plan-flow-start -->')
    expect(claudeMd).toContain('# Plan-Flow core instructions')
    expect(claudeMd).toContain('<!-- plan-flow-end -->')

    const manifest = JSON.parse(readFileSync(join(configDir, '.plan-flow-shared.json'), 'utf8'))
    expect(manifest.version).toBe(VERSION)
    expect(manifest.files).toEqual(expect.arrayContaining([join('commands', 'create-plan.md')]))
    // CLAUDE.md is spliced, not owned outright — it must NOT be in the file manifest.
    expect(manifest.files).not.toContain('CLAUDE.md')
  })

  it('is idempotent — a second run at the same version stages nothing', () => {
    ensureSharedConfig(configDir, source, VERSION)
    const second = ensureSharedConfig(configDir, source, VERSION)
    expect(second.ok).toBe(true)
    expect(second.action).toBe('unchanged')
    expect(second.written).toEqual([])
  })

  it('re-stages on a version bump and drops a file the new source no longer has', () => {
    ensureSharedConfig(configDir, source, VERSION)
    expect(existsSync(join(configDir, 'commands', 'review-code.md'))).toBe(true)

    // New source version without review-code.md
    rmSync(join(source.commandsDir, 'review-code.md'))
    const bumped = ensureSharedConfig(configDir, source, '2.0.0')

    expect(bumped.action).toBe('staged')
    expect(existsSync(join(configDir, 'commands', 'create-plan.md'))).toBe(true)
    expect(existsSync(join(configDir, 'commands', 'review-code.md'))).toBe(false)
  })

  it('never removes a file it did not write, across repeated re-stages', () => {
    ensureSharedConfig(configDir, source, VERSION)
    // A user's OWN personal command in the same commands dir.
    const userCmd = join(configDir, 'commands', 'my-own.md')
    writeFileSync(userCmd, '# mine\n')

    // TWO re-stages: the original manifest-over-capture bug survived round 1 but
    // deleted the user file on round 2 (review Finding 1/2).
    ensureSharedConfig(configDir, source, '2.0.0')
    ensureSharedConfig(configDir, source, '3.0.0')

    expect(existsSync(userCmd)).toBe(true)
    // And it must never have been recorded as plan-flow-owned.
    const manifest = JSON.parse(readFileSync(join(configDir, '.plan-flow-shared.json'), 'utf8'))
    expect(manifest.files).not.toContain(join('commands', 'my-own.md'))
  })

  it('preserves user content outside the CLAUDE.md marker pair', () => {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'CLAUDE.md'), '# My own notes\n\nkeep me\n')

    ensureSharedConfig(configDir, source, VERSION)
    const claudeMd = readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')
    expect(claudeMd).toContain('# My own notes')
    expect(claudeMd).toContain('keep me')
    expect(claudeMd).toContain('# Plan-Flow core instructions')
  })

  it('skips absent source dirs without failing', () => {
    const result = ensureSharedConfig(configDir, { claudeMdBody: '# only claude' }, VERSION)
    expect(result.ok).toBe(true)
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(configDir, 'commands'))).toBe(false)
  })
})

describe('splicePlanFlowSection', () => {
  it('appends the section when the body has no markers', () => {
    const out = splicePlanFlowSection('# Existing\n', 'BODY')
    expect(out).toContain('# Existing')
    expect(out).toBe('# Existing\n<!-- plan-flow-start -->\nBODY\n<!-- plan-flow-end -->\n')
  })

  it('replaces only the enclosed region, preserving the rest', () => {
    const existing = 'A\n<!-- plan-flow-start -->\nOLD\n<!-- plan-flow-end -->\nB\n'
    const out = splicePlanFlowSection(existing, 'NEW')
    expect(out).toBe('A\n<!-- plan-flow-start -->\nNEW\n<!-- plan-flow-end -->\nB\n')
    expect(out).not.toContain('OLD')
  })
})
