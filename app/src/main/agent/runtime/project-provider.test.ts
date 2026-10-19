import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readProjectProvider, resolveProjectProviderChoice } from './project-provider'
import { isKnownProvider } from './runtime-registry'

function makeProject(flowconfig: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'flow-provider-'))
  if (flowconfig !== null) {
    mkdirSync(join(root, 'flow'), { recursive: true })
    writeFileSync(join(root, 'flow', '.flowconfig'), flowconfig, 'utf-8')
  }
  return root
}

describe('readProjectProvider', () => {
  const roots: string[] = []
  const project = (config: string | null): string => {
    const root = makeProject(config)
    roots.push(root)
    return root
  }
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  it('returns the provider value when configured', () => {
    expect(readProjectProvider(project('provider: codex\ncommit: true\n'))).toBe('codex')
  })

  it('trims trailing whitespace and ignores a following line', () => {
    expect(readProjectProvider(project('provider: codex  \npush: false\n'))).toBe('codex')
  })

  it('returns null when no .flowconfig exists', () => {
    expect(readProjectProvider(project(null))).toBeNull()
  })

  it('returns null when the provider key is absent', () => {
    expect(readProjectProvider(project('commit: true\npush: false\n'))).toBeNull()
  })

  it('returns null for an empty provider value', () => {
    expect(readProjectProvider(project('provider:   \n'))).toBeNull()
  })
})

describe('resolveProjectProviderChoice — the getProjectProvider precedence, in one path', () => {
  it('lets a KNOWN project override win, reported as pinned', () => {
    // The project's own file said `codex`, and it is a provider Flow knows, so
    // it answers — and `source` says the project chose it, not that it inherited.
    expect(resolveProjectProviderChoice('codex', 'copilot', isKnownProvider)).toEqual({
      provider: 'codex',
      source: 'project',
    })
  })

  it('SKIPS an unknown project override and falls to the default (fail-closed)', () => {
    // A typo'd override would throw at thread creation, so it must not be
    // reported as pinned here — the default answers, and its rung says so.
    expect(resolveProjectProviderChoice('coddex', 'copilot', isKnownProvider)).toEqual({
      provider: 'copilot',
      source: 'default',
    })
  })

  it('uses the app-wide default when the project has no override', () => {
    expect(resolveProjectProviderChoice(null, 'codex', isKnownProvider)).toEqual({
      provider: 'codex',
      source: 'default',
    })
  })

  it('falls to the built-in claude when nothing is set at any level', () => {
    expect(resolveProjectProviderChoice(null, null, isKnownProvider)).toEqual({
      provider: 'claude',
      source: 'builtin',
    })
  })
})
