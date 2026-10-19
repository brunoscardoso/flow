// worktree-settings — THE ONE read path for how a project's thread worktrees
// are configured, and the precedence table every consumer trusts.
//
// The resolver is PURE (text in, decisions out), so the whole table is provable
// without a project on disk. Two properties carry the whole feature and are
// asserted everywhere below:
//
//   - PROVENANCE COMES FROM KEY PRESENCE. A project that chose `origin` and one
//     that was never asked produce the same VALUE and must never produce the
//     same SOURCE.
//   - THE BUILT-IN LAYER IS A PROMISE: it is what the app did before any of
//     this existed, so a project that never opens the settings is unchanged.

import {
  BASE_REFRESH_TIMEOUT_MS,
  DEFAULT_REMOTE,
  MAX_BASE_REFRESH_TIMEOUT_MS,
  MAX_WORKTREE_CAP,
  MIN_BASE_REFRESH_TIMEOUT_MS,
  MIN_WORKTREE_CAP,
  WORKTREE_BUILTIN_DEFAULTS,
  WORKTREE_FLOWCONFIG_KEYS,
  WORKTREE_SETTING_KEYS,
  readWorktreeSettings,
  resolveWorktreeSettings,
} from './worktree-settings'
import type { WorktreeDefaults } from '../../shared/ipc-contract'

function resolve(
  projectRaw: Record<string, string> = {},
  globalDefaults: Partial<WorktreeDefaults> = {},
) {
  return resolveWorktreeSettings({ projectRaw, globalDefaults })
}

describe('the built-in layer is what the app already did', () => {
  it('answers an untouched project with yesterday’s behaviour, every key marked default', () => {
    const { settings, warnings } = resolve()
    expect(warnings).toEqual([])
    expect(settings.threadWorktrees).toEqual({ value: true, source: 'default' })
    expect(settings.remote).toEqual({ value: 'origin', source: 'default' })
    expect(settings.remoteBranchPattern).toEqual({ value: null, source: 'default' })
    expect(settings.baseBranch).toEqual({ value: null, source: 'default' })
    // THE ONE BUILT-IN THAT CHANGED. `here` handed a new conversation whatever
    // branch the project folder was left on — usually the previous thread's
    // (user, 2026-09-17: "new thread should always start from main").
    expect(settings.worktreeStart).toEqual({ value: { kind: 'trunk' }, source: 'default' })
    expect(settings.baseRefresh).toEqual({ value: true, source: 'default' })
    expect(settings.baseRefreshTimeoutMs).toEqual({ value: 8_000, source: 'default' })
  })

  it('states those built-ins in exactly one place', () => {
    expect(WORKTREE_BUILTIN_DEFAULTS.remote).toBe(DEFAULT_REMOTE)
    expect(WORKTREE_BUILTIN_DEFAULTS.baseRefreshTimeoutMs).toBe(BASE_REFRESH_TIMEOUT_MS)
    expect(BASE_REFRESH_TIMEOUT_MS).toBeGreaterThanOrEqual(MIN_BASE_REFRESH_TIMEOUT_MS)
    expect(BASE_REFRESH_TIMEOUT_MS).toBeLessThanOrEqual(MAX_BASE_REFRESH_TIMEOUT_MS)
  })

  it('answers every declared setting, and nothing else', () => {
    const { settings } = resolve()
    expect(Object.keys(settings).sort()).toEqual([...WORKTREE_SETTING_KEYS].sort())
  })

  it('keeps the base branch under its own file spelling, label or no label', () => {
    // Renaming the key would be a one-line change here and a silent behaviour
    // change in every project that already wrote it.
    expect(WORKTREE_FLOWCONFIG_KEYS.baseBranch).toBe('branch')
    expect(WORKTREE_FLOWCONFIG_KEYS.threadWorktrees).toBe('thread_worktrees')
  })
})

describe('precedence: project, then the person’s defaults, then the built-in', () => {
  it('lets the project win over a default that says otherwise', () => {
    const { settings } = resolve({ remote: 'fork' }, { remote: 'upstream' })
    expect(settings.remote).toEqual({ value: 'fork', source: 'project' })
  })

  it('falls to the person’s default when the project is silent', () => {
    const { settings } = resolve({}, { remote: 'upstream' })
    expect(settings.remote).toEqual({ value: 'upstream', source: 'global' })
  })

  it('falls to the built-in when neither layer says anything', () => {
    expect(resolve().settings.remote).toEqual({ value: 'origin', source: 'default' })
  })

  it('decides each setting independently — one project key does not claim the rest', () => {
    const { settings } = resolve({ remote: 'fork' }, { baseBranch: 'develop' })
    expect(settings.remote.source).toBe('project')
    expect(settings.baseBranch).toEqual({ value: 'develop', source: 'global' })
    expect(settings.worktreeStart.source).toBe('default')
  })

  it('reports the SOURCE even when two layers would produce the same value', () => {
    // The whole point of reading presence rather than comparing values.
    const chosen = resolve({ remote: 'origin' })
    const never = resolve()
    expect(chosen.settings.remote.value).toBe(never.settings.remote.value)
    expect(chosen.settings.remote.source).toBe('project')
    expect(never.settings.remote.source).toBe('default')

    const chosenDefault = resolve({}, { remote: 'origin' })
    expect(chosenDefault.settings.remote).toEqual({ value: 'origin', source: 'global' })
  })

  it('reads a project switch set to the built-in value as a project decision', () => {
    expect(resolve({ thread_worktrees: 'true' }).settings.threadWorktrees).toEqual({
      value: true,
      source: 'project',
    })
  })
})

describe('a blank is absent, at every layer', () => {
  it('lets a blank project key fall through to the default below it', () => {
    // `remote:` with nothing after it is a key the parser cannot get a value
    // out of either; treating it as a choice would let an empty line override
    // a default with nothing.
    const { settings } = resolve({ remote: '' }, { remote: 'upstream' })
    expect(settings.remote).toEqual({ value: 'upstream', source: 'global' })
  })

  it('lets a blank default fall through to the built-in', () => {
    expect(resolve({}, { remote: '   ' }).settings.remote).toEqual({
      value: 'origin',
      source: 'default',
    })
  })

  it('applies the same rule to every setting', () => {
    const blankEverywhere: Record<string, string> = {}
    for (const key of WORKTREE_SETTING_KEYS) blankEverywhere[WORKTREE_FLOWCONFIG_KEYS[key]] = '  '
    const { settings, warnings } = resolve(blankEverywhere)
    for (const key of WORKTREE_SETTING_KEYS) expect(settings[key].source).toBe('default')
    // A blank is silence, not a value Flow failed to read.
    expect(warnings).toEqual([])
  })

  it('trims a value it does accept', () => {
    expect(resolve({ remote: '  upstream  ' }).settings.remote.value).toBe('upstream')
  })
})

describe('a value Flow cannot read loses, and says so', () => {
  it('falls through and names the layer in a person’s words', () => {
    const { settings, warnings } = resolve({ thread_worktrees: 'no' })
    expect(settings.threadWorktrees).toEqual({ value: true, source: 'default' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('for this project')
    expect(warnings[0]).toContain('the setting that lets a conversation work on its own branch')
    // The sentence names the layer that ANSWERED. With no default of their own
    // the person is told the built-in behaviour was used — not a default they
    // never set.
    expect(warnings[0]).toContain('the built-in behaviour')
    expect(warnings[0]).not.toContain('your default')
  })

  it('says "your default" only when a default really answered', () => {
    const { settings, warnings } = resolve({ remote: '' }, {})
    expect(settings.remote.source).toBe('default')
    expect(warnings).toEqual([])
    const bad = resolve({ worktree_start: 'sideways' }, { worktreeStart: 'trunk' })
    expect(bad.settings.worktreeStart).toEqual({ value: { kind: 'trunk' }, source: 'global' })
    expect(bad.warnings[0]).toContain('your default')
  })

  it('reports an unreadable DEFAULT as written in your defaults', () => {
    const { settings, warnings } = resolve({}, { baseRefresh: 'maybe' })
    expect(settings.baseRefresh).toEqual({ value: true, source: 'default' })
    expect(warnings[0]).toContain('in your defaults')
  })

  it('warns once per layer when both are unreadable, and still answers', () => {
    const { settings, warnings } = resolve({ base_refresh: 'yes' }, { baseRefresh: 'no' })
    expect(settings.baseRefresh).toEqual({ value: true, source: 'default' })
    expect(warnings).toHaveLength(2)
    // Both failed, so both name the ONE thing that answered.
    for (const warning of warnings) expect(warning).toContain('the built-in behaviour')
  })

  it('never names a key, a file or a command in a warning (#12)', () => {
    const { warnings } = resolve(
      { thread_worktrees: 'no', worktree_start: 'sideways', base_refresh_timeout_ms: '600000' },
      { baseRefresh: 'maybe' },
    )
    expect(warnings.length).toBeGreaterThan(0)
    for (const warning of warnings) {
      expect(warning).not.toContain('_')
      expect(warning).not.toContain('.flowconfig')
      expect(warning).not.toContain('planflow-ai')
      expect(warning).not.toContain('`')
    }
  })
})

describe('booleans are the two literal words', () => {
  it('reads true and false, and nothing else', () => {
    expect(resolve({ thread_worktrees: 'false' }).settings.threadWorktrees.value).toBe(false)
    expect(resolve({ base_refresh: 'false' }).settings.baseRefresh.value).toBe(false)
    for (const raw of ['no', 'off', '0', 'False', 'TRUE']) {
      const { settings, warnings } = resolve({ base_refresh: raw })
      // Unreadable rather than falsey: `thread_worktrees: no` has always meant on.
      expect(settings.baseRefresh.value).toBe(true)
      expect(warnings).toHaveLength(1)
    }
  })
})

describe('the worktree start', () => {
  it('reads the two plain kinds', () => {
    expect(resolve({ worktree_start: 'here' }).settings.worktreeStart.value).toEqual({
      kind: 'here',
    })
    expect(resolve({ worktree_start: 'trunk' }).settings.worktreeStart.value).toEqual({
      kind: 'trunk',
    })
  })

  it('reads a named branch, name and all', () => {
    expect(resolve({ worktree_start: 'branch:release/2.0' }).settings.worktreeStart.value).toEqual(
      { kind: 'branch', branch: 'release/2.0' },
    )
    expect(resolve({ worktree_start: 'branch:  dev  ' }).settings.worktreeStart.value).toEqual({
      kind: 'branch',
      branch: 'dev',
    })
  })

  it('REFUSES checkout: — a branch can only be checked out in one place', () => {
    // As a per-thread choice it is fine; as a DEFAULT it would mean the second
    // thread to start always fails, so it is not offered as what every thread does.
    const { settings, warnings } = resolve({ worktree_start: 'checkout:dev' })
    // Falls back to the BUILT-IN — which is the base branch now, not `here`.
    expect(settings.worktreeStart).toEqual({ value: { kind: 'trunk' }, source: 'default' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("where a new conversation's branch starts")
  })

  it('refuses a branch start with no branch', () => {
    const { settings, warnings } = resolve({ worktree_start: 'branch:' })
    expect(settings.worktreeStart.source).toBe('default')
    expect(warnings).toHaveLength(1)
    expect(resolve({ worktree_start: 'branch:   ' }).settings.worktreeStart.source).toBe('default')
  })

  it('takes a start from the defaults layer too', () => {
    expect(resolve({}, { worktreeStart: 'branch:main' }).settings.worktreeStart).toEqual({
      value: { kind: 'branch', branch: 'main' },
      source: 'global',
    })
  })
})

describe('the refresh wait is clamped where it is READ', () => {
  // `.flowconfig` is hand-editable, so a 600000 typed into it reaches this code
  // having passed no validator at all. This clamp is the last gate before the
  // number becomes a setTimeout, which makes it the only one that cannot be
  // bypassed — reopening an unbounded wait is the failure it must prevent.

  it('takes a wait inside the bounds as written', () => {
    expect(resolve({ base_refresh_timeout_ms: '3000' }).settings.baseRefreshTimeoutMs).toEqual({
      value: 3_000,
      source: 'project',
    })
  })

  it('clamps at the ceiling, and says what it will actually wait', () => {
    const { settings, warnings } = resolve({ base_refresh_timeout_ms: '600000' })
    expect(settings.baseRefreshTimeoutMs).toEqual({
      value: MAX_BASE_REFRESH_TIMEOUT_MS,
      source: 'project',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('30 seconds')
    expect(warnings[0]).toContain('for this project')
  })

  it('clamps at the floor too', () => {
    const { settings, warnings } = resolve({ base_refresh_timeout_ms: '0' })
    expect(settings.baseRefreshTimeoutMs.value).toBe(MIN_BASE_REFRESH_TIMEOUT_MS)
    expect(warnings[0]).toContain('1 seconds')
  })

  it('says nothing when the clamp does not bite, at either bound', () => {
    expect(resolve({ base_refresh_timeout_ms: String(MIN_BASE_REFRESH_TIMEOUT_MS) }).warnings).toEqual([])
    expect(resolve({ base_refresh_timeout_ms: String(MAX_BASE_REFRESH_TIMEOUT_MS) }).warnings).toEqual([])
  })

  it('clamps a default the same way, and names the layer it came from', () => {
    const { settings, warnings } = resolve({}, { baseRefreshTimeoutMs: '90000' })
    expect(settings.baseRefreshTimeoutMs).toEqual({
      value: MAX_BASE_REFRESH_TIMEOUT_MS,
      source: 'global',
    })
    expect(warnings[0]).toContain('in your defaults')
  })

  it('falls through a wait that is not a number at all', () => {
    for (const raw of ['soon', '8s', '-1', '2.5s']) {
      const { settings, warnings } = resolve({ base_refresh_timeout_ms: raw })
      expect(settings.baseRefreshTimeoutMs.value).toBe(BASE_REFRESH_TIMEOUT_MS)
      expect(settings.baseRefreshTimeoutMs.source).toBe('default')
      expect(warnings).toHaveLength(1)
    }
  })

  it('lets an unreadable project wait fall to a readable default', () => {
    const { settings } = resolve({ base_refresh_timeout_ms: 'soon' }, { baseRefreshTimeoutMs: '2000' })
    expect(settings.baseRefreshTimeoutMs).toEqual({ value: 2_000, source: 'global' })
  })
})

describe('the worktree limit', () => {
  // The number was hardcoded at ten for the whole life of the feature, so a
  // project that had filled its disk with copies had nothing to say about it.
  // Everything below is the same shape as the refresh wait, for the same reason:
  // `.flowconfig` is hand-editable, so the bounds have to hold at the point the
  // value is READ, not only where it is typed.

  it('takes a limit inside the bounds as written', () => {
    expect(resolve({ worktree_cap: '25' }).settings.worktreeCap).toEqual({
      value: 25,
      source: 'project',
    })
  })

  it('is ten when nobody has said otherwise — what the app already did', () => {
    expect(resolve({}).settings.worktreeCap).toEqual({ value: 10, source: 'default' })
  })

  it('refuses to let zero mean "keep none"', () => {
    // Zero does not keep none: it puts EVERY landed copy above the line on every
    // sweep, which turns the reclaimer into a deleter of everything it may touch.
    const { settings, warnings } = resolve({ worktree_cap: '0' })
    expect(settings.worktreeCap.value).toBe(MIN_WORKTREE_CAP)
    expect(warnings[0]).toContain('1 copy')
    expect(warnings[0]).toContain('for this project')
  })

  it('clamps at the ceiling and says what it will actually keep', () => {
    const { settings, warnings } = resolve({ worktree_cap: '100000' })
    expect(settings.worktreeCap.value).toBe(MAX_WORKTREE_CAP)
    expect(warnings[0]).toContain('100 copies')
  })

  it('says nothing when the clamp does not bite, at either bound', () => {
    expect(resolve({ worktree_cap: String(MIN_WORKTREE_CAP) }).warnings).toEqual([])
    expect(resolve({ worktree_cap: String(MAX_WORKTREE_CAP) }).warnings).toEqual([])
  })

  it('clamps a default the same way, and names the layer it came from', () => {
    const { settings, warnings } = resolve({}, { worktreeCap: '0' })
    expect(settings.worktreeCap).toEqual({ value: MIN_WORKTREE_CAP, source: 'global' })
    expect(warnings[0]).toContain('in your defaults')
  })

  it('falls through a limit that is not a number at all', () => {
    for (const raw of ['plenty', 'ten', '']) {
      const { settings } = resolve({ worktree_cap: raw })
      expect(settings.worktreeCap).toEqual({ value: 10, source: 'default' })
    }
  })
})

describe('the worktree setup command', () => {
  it('is nothing until a project asks for one', () => {
    // The promise the whole feature rests on: an untouched project runs nothing.
    expect(resolve({}).settings.worktreeSetup).toEqual({ value: null, source: 'default' })
  })

  it('takes the command exactly as written, spaces and all', () => {
    expect(resolve({ worktree_setup: 'npm ci && npm run generate' }).settings.worktreeSetup).toEqual({
      value: 'npm ci && npm run generate',
      source: 'project',
    })
  })

  it('judges nothing about what the command says', () => {
    // Flow RUNS this string; it does not read it. A script path, a chain, a
    // binary nobody here has heard of — all equally valid (NFR-2).
    for (const raw of ['./scripts/worktree-setup.sh', 'make bootstrap', 'uv sync']) {
      expect(resolve({ worktree_setup: raw }).settings.worktreeSetup.value).toBe(raw)
    }
  })

  it('reads a key written blank as absent, not as a command that is nothing', () => {
    const { settings, warnings } = resolve({ worktree_setup: '   ' })
    expect(settings.worktreeSetup).toEqual({ value: null, source: 'default' })
    expect(warnings).toEqual([])
  })

  it('inherits a default the person set, and names that layer', () => {
    expect(resolve({}, { worktreeSetup: 'npm ci' }).settings.worktreeSetup).toEqual({
      value: 'npm ci',
      source: 'global',
    })
  })

  it('lets a project take the command over from the default', () => {
    const { settings } = resolve({ worktree_setup: 'make dev' }, { worktreeSetup: 'npm ci' })
    expect(settings.worktreeSetup).toEqual({ value: 'make dev', source: 'project' })
  })
})

describe('readWorktreeSettings — the one part that touches a file', () => {
  it('reads the project’s own file and resolves over the defaults given', async () => {
    const reads: string[] = []
    const result = await readWorktreeSettings('/projects/thing', {
      readFile: async (path) => {
        reads.push(path)
        return 'remote: fork\nbranch: develop\n'
      },
      globalDefaults: () => ({ remote: 'upstream', worktreeStart: 'trunk' }),
    })
    expect(reads).toHaveLength(1)
    expect(reads[0]).toContain('.flowconfig')
    expect(result.settings.remote).toEqual({ value: 'fork', source: 'project' })
    expect(result.settings.baseBranch).toEqual({ value: 'develop', source: 'project' })
    expect(result.settings.worktreeStart).toEqual({ value: { kind: 'trunk' }, source: 'global' })
  })

  it('treats a missing or unreadable file as a project with no opinion', async () => {
    const result = await readWorktreeSettings('/projects/thing', {
      readFile: async () => {
        throw new Error('ENOENT')
      },
      globalDefaults: () => ({ remote: 'upstream' }),
    })
    expect(result.settings.remote).toEqual({ value: 'upstream', source: 'global' })
    expect(result.warnings).toEqual([])
  })

  it('resolves against the project and the built-ins when no defaults are supplied', async () => {
    // The behaviour that shipped before defaults existed — a caller without the
    // store (a test, or a path that runs before it exists) still gets an answer.
    const result = await readWorktreeSettings('/projects/thing', {
      readFile: async () => 'thread_worktrees: false\n',
    })
    expect(result.settings.threadWorktrees).toEqual({ value: false, source: 'project' })
    expect(result.settings.remote.source).toBe('default')
  })

  it('reads presence, so a key written blank in the file still inherits', async () => {
    const result = await readWorktreeSettings('/projects/thing', {
      readFile: async () => 'branch:\n',
      globalDefaults: () => ({ baseBranch: 'develop' }),
    })
    expect(result.settings.baseBranch).toEqual({ value: 'develop', source: 'global' })
  })
})
