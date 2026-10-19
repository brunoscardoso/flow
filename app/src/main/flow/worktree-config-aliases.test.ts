// worktree-config-aliases — the app half of the alias parity check.
//
// The CLI's `src/cli/state/flowconfig-aliases.test.ts` loads the same JSON and
// proves the CLI reads and writes it the same way. This file proves the app
// does: every reader takes the new key and falls back to the old one, the new
// one wins when both are present, and a write lands under BOTH names with the
// same value (an unset removes both) for THAT setting only — the transitional
// dual-write that keeps older Flow builds, which read only the old key, in step.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { parseFlowconfigKeys } from '../../shared/flowconfig-merge'
import {
  FLOWCONFIG_KEY_ALIASES,
  canonicalFlowconfigKey,
  legacyFlowconfigKeyOf,
  readAliasedKey,
  withAliasedWrites,
} from '../../shared/worktree-config-aliases'
import { readValues } from '../../renderer/settings/flow-settings-model'
import { writeFlowconfig } from './flowconfig-writer'
import { WORKTREE_FLOWCONFIG_KEYS, resolveWorktreeSettings } from './worktree-settings'

/** Read straight off disk, so the import path cannot hide a stale copy. */
const TABLE = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'shared', 'worktree-config-aliases.json'), 'utf-8'),
) as { aliases: Record<string, string> }

function resolveFile(text: string) {
  return resolveWorktreeSettings({ projectRaw: parseFlowconfigKeys(text), globalDefaults: {} })
}

describe('the shared alias table', () => {
  it('is the JSON file, entry for entry', () => {
    expect(FLOWCONFIG_KEY_ALIASES).toEqual(TABLE.aliases)
  })

  it('maps the four renamed worktree keys and nothing else', () => {
    expect(TABLE.aliases).toEqual({
      worktree_start: 'workspace_start',
      worktree_cap: 'workspace_cap',
      worktree_setup: 'workspace_setup',
      worktree_setup_timeout_ms: 'workspace_setup_timeout_ms',
    })
  })

  it('is what the settings resolver writes under — every renamed key is a current name', () => {
    const fileKeys = Object.values(WORKTREE_FLOWCONFIG_KEYS)
    for (const current of Object.keys(TABLE.aliases)) expect(fileKeys).toContain(current)
    for (const legacy of Object.values(TABLE.aliases)) expect(fileKeys).not.toContain(legacy)
  })

  it('names both directions consistently', () => {
    for (const [current, legacy] of Object.entries(TABLE.aliases)) {
      expect(legacyFlowconfigKeyOf(current)).toBe(legacy)
      expect(canonicalFlowconfigKey(legacy)).toBe(current)
      expect(canonicalFlowconfigKey(current)).toBe(current)
    }
    expect(legacyFlowconfigKeyOf('remote')).toBeUndefined()
    expect(canonicalFlowconfigKey('remote')).toBe('remote')
  })
})

describe('reading a project file', () => {
  it('reads an old-only file under the old names', () => {
    const { settings, warnings } = resolveFile(
      [
        'workspace_start: branch:release',
        'workspace_cap: 4',
        'workspace_setup: npm ci',
        'workspace_setup_timeout_ms: 90000',
      ].join('\n'),
    )
    expect(warnings).toEqual([])
    expect(settings.worktreeStart).toEqual({
      value: { kind: 'branch', branch: 'release' },
      source: 'project',
    })
    expect(settings.worktreeCap).toEqual({ value: 4, source: 'project' })
    expect(settings.worktreeSetup).toEqual({ value: 'npm ci', source: 'project' })
    expect(settings.worktreeSetupTimeoutMs).toEqual({ value: 90_000, source: 'project' })
  })

  it('reads a new-only file under the new names', () => {
    const { settings } = resolveFile(
      ['worktree_start: here', 'worktree_cap: 7', 'worktree_setup: uv sync'].join('\n'),
    )
    expect(settings.worktreeStart).toEqual({ value: { kind: 'here' }, source: 'project' })
    expect(settings.worktreeCap).toEqual({ value: 7, source: 'project' })
    expect(settings.worktreeSetup).toEqual({ value: 'uv sync', source: 'project' })
  })

  it('lets the OLD name win when both are present, in either order (a pre-rename build writes only it)', () => {
    for (const text of [
      'workspace_cap: 3\nworktree_cap: 9\n',
      'worktree_cap: 9\nworkspace_cap: 3\n',
    ]) {
      expect(resolveFile(text).settings.worktreeCap).toEqual({ value: 3, source: 'project' })
    }
  })

  it('a BLANK new key with an old value reads the old one', () => {
    expect(resolveFile('worktree_cap:\nworkspace_cap: 5\n').settings.worktreeCap).toEqual({
      value: 5,
      source: 'project',
    })
  })

  it('reads the same way in the per-project settings panel', () => {
    expect(readValues({ workspace_setup: 'npm ci' }).worktree_setup).toBe('npm ci')
    expect(readValues({ worktree_setup: 'uv sync' }).worktree_setup).toBe('uv sync')
    expect(
      readValues({ workspace_setup: 'npm ci', worktree_setup: 'uv sync' }).worktree_setup,
    ).toBe('npm ci')
  })
})

/** The fixture the CLI's parity test loads too — same files, same expected values. */
const PARITY = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'shared', 'worktree-config-aliases.fixture.json'), 'utf-8'),
) as { cases: Array<{ name: string; text: string; expected: Record<string, string> }> }

describe('the shared parity fixture — the CLI asserts the same values', () => {
  it('covers old-only, new-only and both-present files for every renamed key', () => {
    expect(PARITY.cases.map((c) => c.name)).toEqual([
      'old keys only',
      'new keys only',
      'both present, old lines first',
      'both present, new lines first',
    ])
    for (const c of PARITY.cases) {
      expect(Object.keys(c.expected).sort()).toEqual(Object.keys(TABLE.aliases).sort())
    }
  })

  for (const c of PARITY.cases) {
    it(`${c.name}: every reader sees the expected value`, () => {
      const raw = parseFlowconfigKeys(c.text)
      for (const [key, value] of Object.entries(c.expected)) {
        expect(readAliasedKey(raw, key)).toBe(value)
      }
      // The panel and the resolver read through the same table.
      expect(readValues(raw).worktree_setup).toBe(c.expected.worktree_setup)
      const { settings } = resolveFile(c.text)
      expect(settings.worktreeCap.value).toBe(Number(c.expected.worktree_cap))
      expect(settings.worktreeSetup.value).toBe(c.expected.worktree_setup)
      expect(settings.worktreeSetupTimeoutMs.value).toBe(
        Number(c.expected.worktree_setup_timeout_ms),
      )
      const start = c.expected.worktree_start
      expect(settings.worktreeStart.value).toEqual(
        start.startsWith('branch:')
          ? { kind: 'branch', branch: start.slice('branch:'.length) }
          : { kind: start },
      )
    })
  }
})

describe('writing a project file', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-worktree-aliases-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const file = (): string => readFileSync(join(dir, '.flowconfig'), 'utf-8')

  it('writes the new name AND the old one, with the same value', async () => {
    writeFileSync(join(dir, '.flowconfig'), '# mine\nworkspace_cap: 3\nremote: origin\n')
    await writeFlowconfig(dir, { worktree_cap: '6' })
    expect(file()).toBe('# mine\nworkspace_cap: 6\nremote: origin\nworktree_cap: 6\n')
  })

  it('dual-writes into a file that has neither spelling yet', async () => {
    writeFileSync(join(dir, '.flowconfig'), 'remote: origin\n')
    await writeFlowconfig(dir, { worktree_start: 'trunk' })
    expect(parseFlowconfigKeys(file())).toEqual({
      remote: 'origin',
      worktree_start: 'trunk',
      workspace_start: 'trunk',
    })
  })

  it('canonicalises a write that names the OLD key', async () => {
    writeFileSync(join(dir, '.flowconfig'), 'workspace_setup: npm ci\n')
    await writeFlowconfig(dir, { workspace_setup: 'uv sync' })
    expect(file()).toBe('workspace_setup: uv sync\nworktree_setup: uv sync\n')
  })

  it('removes both spellings when a setting goes back to inheriting', async () => {
    writeFileSync(join(dir, '.flowconfig'), 'worktree_cap: 6\nworkspace_cap: 3\n')
    await writeFlowconfig(dir, { worktree_cap: null })
    expect(parseFlowconfigKeys(file())).toEqual({})
  })

  it('leaves the old spelling of a setting nobody changed exactly where it is', async () => {
    writeFileSync(join(dir, '.flowconfig'), 'workspace_start: trunk\nworkspace_cap: 3\n')
    await writeFlowconfig(dir, { autopilot: 'true' })
    expect(file()).toBe('workspace_start: trunk\nworkspace_cap: 3\nautopilot: true\n')
  })

  it('expands writes without touching keys that were never renamed', () => {
    expect(withAliasedWrites({ remote: 'upstream', workspace_start: 'here' })).toEqual({
      remote: 'upstream',
      worktree_start: 'here',
      workspace_start: 'here',
    })
    expect(withAliasedWrites({ worktree_cap: null })).toEqual({
      worktree_cap: null,
      workspace_cap: null,
    })
  })
})
