// flowconfig-writer — non-destructive merge + atomic write into .flowconfig.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { mergeFlowconfig, writeFlowconfig } from './flowconfig-writer'

describe('mergeFlowconfig', () => {
  it('updates an existing key in place and preserves everything else', () => {
    const existing = ['# header comment', 'autopilot: true', '', 'commit: false', 'branch: main'].join('\n')
    const out = mergeFlowconfig(existing, { commit: 'true' })
    expect(out).toBe(
      ['# header comment', 'autopilot: true', '', 'commit: true', 'branch: main', ''].join('\n'),
    )
  })

  it('appends keys that are not present', () => {
    const out = mergeFlowconfig('autopilot: true\n', { model_routing: 'false', 'engines.graphify': 'enabled' })
    expect(out).toBe('autopilot: true\nmodel_routing: false\nengines.graphify: enabled\n')
  })

  it('produces a valid file from empty/absent input', () => {
    expect(mergeFlowconfig('', { autopilot: 'true' })).toBe('autopilot: true\n')
  })

  it('preserves comments and blank lines while updating', () => {
    const existing = ['# managed by /flow', '', 'push: false', '# note', 'pr: false'].join('\n')
    const out = mergeFlowconfig(existing, { push: 'true', pr: 'true' })
    expect(out).toBe(['# managed by /flow', '', 'push: true', '# note', 'pr: true', ''].join('\n'))
  })

  it('round-trips dotted keys', () => {
    const out = mergeFlowconfig('commands.lint: eslint\n', { 'commands.lint': 'npm run lint' })
    expect(out).toBe('commands.lint: npm run lint\n')
  })

  it('ends every write in a single trailing newline', () => {
    expect(mergeFlowconfig('a: 1\n\n\n', { b: '2' }).endsWith('\n')).toBe(true)
    expect(mergeFlowconfig('a: 1', { a: '2' }).match(/\n+$/)?.[0]).toBe('\n')
  })

  // The shared merge (src/cli/state/flowconfig-merge.ts) leaves text ALONE when
  // asked to change nothing — it does not even normalize the trailing newline,
  // because a merge that rewrites a file it was given no changes for is a merge
  // that can dirty a repo by being called. writeFlowconfig returns before it on
  // an empty update set, so no write ever depends on the difference.
  it('leaves the file untouched when there is nothing to change', () => {
    expect(mergeFlowconfig('a: 1', {})).toBe('a: 1')
  })

  it('removes a key when its value is null', () => {
    const existing = ['# header', 'autopilot: true', 'branch: main'].join('\n')
    expect(mergeFlowconfig(existing, { branch: null })).toBe('# header\nautopilot: true\n')
  })
})

describe('writeFlowconfig', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-cfg-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates .flowconfig when absent and writes the keys', async () => {
    await writeFlowconfig(dir, { autopilot: 'true', commit: 'false' })
    expect(readFileSync(join(dir, '.flowconfig'), 'utf8')).toBe('autopilot: true\ncommit: false\n')
  })

  it('merges into an existing file without dropping other keys', async () => {
    writeFileSync(join(dir, '.flowconfig'), '# k\nautopilot: false\nbranch: dev\n', 'utf8')
    await writeFlowconfig(dir, { autopilot: 'true' })
    expect(readFileSync(join(dir, '.flowconfig'), 'utf8')).toBe('# k\nautopilot: true\nbranch: dev\n')
  })

  it('removes the legacy .autopilot marker when autopilot is written', async () => {
    writeFileSync(join(dir, '.autopilot'), '1', 'utf8')
    await writeFlowconfig(dir, { autopilot: 'false' })
    expect(existsSync(join(dir, '.autopilot'))).toBe(false)
  })

  it('is a no-op for empty updates', async () => {
    await writeFlowconfig(dir, {})
    expect(existsSync(join(dir, '.flowconfig'))).toBe(false)
  })
})
