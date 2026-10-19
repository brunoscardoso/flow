// AppSettingsStore tests — real better-sqlite3 (Electron ABI), fresh temp DB.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from './db'
import { AppSettingsStore } from './app-settings-store'

describe('AppSettingsStore', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: AppSettingsStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-app-settings-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new AppSettingsStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('defaults to false when unset', () => {
    expect(store.getOnboardingCompleted()).toBe(false)
    expect(store.getAutonomyBypassDefault()).toBe(false)
  })

  it('round-trips onboarding completion', () => {
    store.setOnboardingCompleted(true)
    expect(store.getOnboardingCompleted()).toBe(true)
    store.setOnboardingCompleted(false)
    expect(store.getOnboardingCompleted()).toBe(false)
  })

  it('round-trips the autonomy bypass default independently', () => {
    store.setAutonomyBypassDefault(true)
    expect(store.getAutonomyBypassDefault()).toBe(true)
    expect(store.getOnboardingCompleted()).toBe(false) // independent key
  })

  it('close-remote-on-done defaults to TRUE when unset (#1885)', () => {
    // Unlike every other boolean here, absent must read as ON — the feature the
    // user asked for works out of the box, and only an explicit off turns it off.
    expect(store.getCloseRemoteOnDone()).toBe(true)
  })

  it('round-trips close-remote-on-done, and only an explicit false turns it off (#1885)', () => {
    store.setCloseRemoteOnDone(false)
    expect(store.getCloseRemoteOnDone()).toBe(false)
    store.setCloseRemoteOnDone(true)
    expect(store.getCloseRemoteOnDone()).toBe(true)
    expect(store.getAutonomyBypassDefault()).toBe(false) // independent key
  })

  it('returns the suggested defaults for model routing when unset (#129)', () => {
    expect(store.getModelRouting()).toEqual({ low: 'haiku', medium: 'sonnet', high: 'opus' })
  })

  it('round-trips a saved model-routing map', () => {
    store.setModelRouting({ low: 'sonnet', medium: 'opus', high: 'opus' })
    expect(store.getModelRouting()).toEqual({ low: 'sonnet', medium: 'opus', high: 'opus' })
    expect(store.getAutonomyBypassDefault()).toBe(false) // independent key
  })

  it('default model selection is unset until the user picks (#848)', () => {
    expect(store.getDefaultModelSelection()).toEqual({ model: null, effort: null })
  })

  it('round-trips the model+effort preference (#848)', () => {
    store.setDefaultModelSelection('opus', 'high')
    expect(store.getDefaultModelSelection()).toEqual({ model: 'opus', effort: 'high' })
  })

  it('round-trips the last-run version (post-update What\'s-new stamp)', () => {
    expect(store.getLastRunVersion()).toBeNull()
    store.setLastRunVersion('0.1.3')
    expect(store.getLastRunVersion()).toBe('0.1.3')
  })

  // ── issue-list config (mode + native query), per provider ───────────────

  it('issue-list config defaults to assigned with no query', () => {
    expect(store.getIssueListConfig('github')).toEqual({ mode: 'assigned', query: '' })
  })

  it('round-trips mode and query per provider, independently', () => {
    store.setIssueListConfig('github', { mode: 'both', query: 'repo:acme/api is:issue' })
    store.setIssueListConfig('jira', { mode: 'list', query: 'project = ACME' })
    expect(store.getIssueListConfig('github')).toEqual({
      mode: 'both',
      query: 'repo:acme/api is:issue',
    })
    expect(store.getIssueListConfig('jira')).toEqual({ mode: 'list', query: 'project = ACME' })
    // Untouched provider keeps the default — the rows are independent.
    expect(store.getIssueListConfig('azure')).toEqual({ mode: 'assigned', query: '' })
  })

  it('a partial patch merges onto the stored config and echoes the result', () => {
    store.setIssueListConfig('github', { query: 'label:bug' })
    // Only the mode changes; the query set a moment ago survives.
    const result = store.setIssueListConfig('github', { mode: 'list' })
    expect(result).toEqual({ mode: 'list', query: 'label:bug' })
    expect(store.getIssueListConfig('github')).toEqual({ mode: 'list', query: 'label:bug' })
  })

  it('trims the query but never rewrites it (allowed-pattern #22)', () => {
    store.setIssueListConfig('github', { query: '  repo:acme/api  ' })
    expect(store.getIssueListConfig('github').query).toBe('repo:acme/api')
  })

  it('clearing the query is a real choice — stored as empty', () => {
    store.setIssueListConfig('github', { mode: 'both', query: 'label:bug' })
    store.setIssueListConfig('github', { query: '' })
    expect(store.getIssueListConfig('github')).toEqual({ mode: 'both', query: '' })
  })

  it('an unknown mode on read falls back to assigned, never propagates', () => {
    // A row written by a newer build that knows a mode this one does not.
    store.setDefaultProvider('x') // touch the table so it exists
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('issue_list_config_github', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify({ mode: 'galaxy', query: 'label:bug' }))
    expect(store.getIssueListConfig('github')).toEqual({ mode: 'assigned', query: 'label:bug' })
  })

  it('an Auto pick stores no effort — routing owns the tier (#332/#848)', () => {
    store.setDefaultModelSelection('opus', 'high')
    store.setDefaultModelSelection('auto', null)
    expect(store.getDefaultModelSelection()).toEqual({ model: 'auto', effort: null })
  })

  // ── the installation's queue-claim owner (review finding H1) ────────────
  //
  // THE WHOLE FIX IS STABILITY. The board used to claim with no `--owner`, so
  // the CLI minted a fresh `run-<ts>-<pid>` per invocation and a retry could
  // never match the claim this window had just made.

  it('mints a claim owner on first use and returns the SAME one forever after', () => {
    const first = store.getLoopOwnerId()
    expect(first).toMatch(/^flow-ide-[0-9a-f]{12}$/)
    expect(store.getLoopOwnerId()).toBe(first)
    expect(store.getLoopOwnerId()).toBe(first)
  })

  it('survives a restart — the word is in the store, not in the process', () => {
    const minted = store.getLoopOwnerId()
    // A second store over the same database is what the next app launch sees.
    expect(new AppSettingsStore(db).getLoopOwnerId()).toBe(minted)
  })

  it('counts a day of use once, however many times the app starts', () => {
    expect(store.countUseDayNow('2026-09-22')).toBe(1)
    expect(store.countUseDayNow('2026-09-22')).toBe(1)
    expect(store.countUseDayNow('2026-09-22')).toBe(1)
    expect(store.countUseDayNow('2026-09-23')).toBe(2)
    expect(store.getUseDays()).toBe(2)
  })

  it('carries the use-day count across a restart', () => {
    store.countUseDayNow('2026-09-22')
    store.countUseDayNow('2026-09-23')
    expect(new AppSettingsStore(db).getUseDays()).toBe(2)
  })

  it('counts how many times the telemetry question was raised', () => {
    expect(store.getConsentAsks()).toBe(0)
    store.recordConsentAsk()
    store.recordConsentAsk()
    expect(store.getConsentAsks()).toBe(2)
    expect(new AppSettingsStore(db).getConsentAsks()).toBe(2)
  })

  it('stamps the first run once, and never moves it afterwards', () => {
    const day1 = () => new Date('2026-09-01T10:00:00.000Z')
    const day2 = () => new Date('2027-01-01T00:00:00.000Z')
    const stamped = store.getFirstRunAt(day1)
    expect(stamped).toBe('2026-09-01T10:00:00.000Z')
    // A LATER LAUNCH MUST NOT RESTAMP IT. Reading with a different clock is
    // exactly what the second launch does, and a getter that wrote every time
    // would return day2 here while still passing a same-process equality check.
    expect(store.getFirstRunAt(day2)).toBe(stamped)
    expect(new AppSettingsStore(db).getFirstRunAt(day2)).toBe(stamped)
  })

  it('cannot be mistaken for a run or for a queue-derived claimant', () => {
    const owner = store.getLoopOwnerId()
    // `run-<ts>-<pid>` is one headless run; `@<login>` is an account read off
    // the queue's assignees. Colliding with either would break a comparison the
    // CLI makes to decide whether a claim is another run's.
    expect(owner.startsWith('run-')).toBe(false)
    expect(owner.startsWith('@')).toBe(false)
  })

  it('is independent of every other setting', () => {
    store.setOnboardingCompleted(true)
    const owner = store.getLoopOwnerId()
    store.setDefaultModelSelection('opus', 'high')
    expect(store.getLoopOwnerId()).toBe(owner)
    expect(store.getOnboardingCompleted()).toBe(true)
  })

  it('two installations do not share a word', () => {
    const other = mkdtempSync(join(tmpdir(), 'flow-app-settings-other-'))
    const otherDb = openDatabase(join(other, 'flow.sqlite'))
    try {
      expect(new AppSettingsStore(otherDb).getLoopOwnerId()).not.toBe(store.getLoopOwnerId())
    } finally {
      otherDb.close()
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('the model preference is per runtime', () => {
  let tempDir: string
  let db: FlowDatabase
  const makeStore = (): AppSettingsStore => new AppSettingsStore(db)

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-model-pref-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('keeps each runtime’s pick apart', () => {
    // The failure this prevents: pinning gpt-5.1-codex-max under Codex made it
    // the default for EVERY new thread, so the next Claude chat opened with a
    // model Anthropic has never heard of and died on its first message —
    // "There's an issue with the selected model (gpt-5.1-codex-max)."
    const store = makeStore()
    store.setDefaultModelSelection('gpt-5.1-codex-max', null, 'codex')
    store.setDefaultModelSelection('opus', 'high', 'claude')
    expect(store.getDefaultModelSelection('codex')).toEqual({
      model: 'gpt-5.1-codex-max',
      effort: null,
    })
    expect(store.getDefaultModelSelection('claude')).toEqual({ model: 'opus', effort: 'high' })
  })

  it('gives a runtime with no pick nothing, rather than someone else’s', () => {
    const store = makeStore()
    store.setDefaultModelSelection('opus', 'high', 'claude')
    expect(store.getDefaultModelSelection('copilot')).toEqual({ model: null, effort: null })
  })

  it('reads an existing preference as Claude’s — it was chosen under Claude', () => {
    const store = makeStore()
    // Written before this key was per-runtime (the default argument IS claude).
    store.setDefaultModelSelection('sonnet', 'medium')
    expect(store.getDefaultModelSelection('claude')).toEqual({ model: 'sonnet', effort: 'medium' })
  })
})

describe('models Flow has watched a runtime use', () => {
  let tempDir: string
  let db: FlowDatabase
  const makeStore = (): AppSettingsStore => new AppSettingsStore(db)

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-seen-models-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('records what a runtime reported, newest first', () => {
    // GitHub Copilot's catalogue table is empty until its interactive session
    // fills it, and no command exists to ask — but every turn names the model
    // it ran, which is where "Sonnet 5" under a reply comes from.
    const store = makeStore()
    store.rememberSeenRuntimeModel('copilot', 'claude-sonnet-5')
    store.rememberSeenRuntimeModel('copilot', 'gpt-5-mini')
    expect(store.getSeenRuntimeModels('copilot')).toEqual(['gpt-5-mini', 'claude-sonnet-5'])
  })

  it('does not repeat one, and keeps each runtime’s own', () => {
    const store = makeStore()
    store.rememberSeenRuntimeModel('copilot', 'claude-sonnet-5')
    store.rememberSeenRuntimeModel('copilot', 'gpt-5-mini')
    store.rememberSeenRuntimeModel('copilot', 'claude-sonnet-5')
    expect(store.getSeenRuntimeModels('copilot')).toEqual(['claude-sonnet-5', 'gpt-5-mini'])
    expect(store.getSeenRuntimeModels('codex')).toEqual([])
  })

  it('is a menu, not a history', () => {
    const store = makeStore()
    for (let i = 0; i < 20; i += 1) store.rememberSeenRuntimeModel('codex', `m${String(i)}`)
    expect(store.getSeenRuntimeModels('codex')).toHaveLength(12)
    expect(store.getSeenRuntimeModels('codex')[0]).toBe('m19')
  })

  it('ignores an empty model rather than storing a blank row', () => {
    const store = makeStore()
    store.rememberSeenRuntimeModel('codex', '   ')
    expect(store.getSeenRuntimeModels('codex')).toEqual([])
  })
})

describe('the person’s app-wide worktree defaults', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: AppSettingsStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-worktree-defaults-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new AppSettingsStore(db)
  })
  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('is EMPTY until somebody sets one — absence is a fact the shape must express', () => {
    // A key absent is a default nobody set; a key set to the built-in value
    // pins that value. The resolver reads the first as "ask the layer below".
    expect(store.getWorktreeDefaults()).toEqual({})
  })

  it('round-trips one default without inventing the others', () => {
    store.setWorktreeDefaults({ remote: 'upstream' })
    expect(store.getWorktreeDefaults()).toEqual({ remote: 'upstream' })
  })

  it('stores raw text, so the same value typed in either place means one thing', () => {
    store.setWorktreeDefaults({
      threadWorktrees: 'false',
      baseRefresh: 'false',
      baseRefreshTimeoutMs: '3000',
      worktreeStart: 'branch:release/2.0',
      remoteBranchPattern: 'feature/{ticket}',
      baseBranch: 'develop',
    })
    expect(store.getWorktreeDefaults()).toEqual({
      threadWorktrees: 'false',
      baseRefresh: 'false',
      baseRefreshTimeoutMs: '3000',
      worktreeStart: 'branch:release/2.0',
      remoteBranchPattern: 'feature/{ticket}',
      baseBranch: 'develop',
    })
  })

  it('is PARTIAL — a patch touches only the settings it names', () => {
    store.setWorktreeDefaults({ remote: 'upstream', baseBranch: 'develop' })
    store.setWorktreeDefaults({ remote: 'fork' })
    expect(store.getWorktreeDefaults()).toEqual({ remote: 'fork', baseBranch: 'develop' })
  })

  it('REMOVES a row on null — the one way back to inheriting', () => {
    store.setWorktreeDefaults({ remote: 'upstream' })
    store.setWorktreeDefaults({ remote: null })
    expect(store.getWorktreeDefaults()).toEqual({})
  })

  it('removes nothing the caller did not name (forbidden-pattern #15)', () => {
    store.setWorktreeDefaults({ remote: 'upstream', baseBranch: 'develop' })
    store.setWorktreeDefaults({ baseBranch: null })
    expect(store.getWorktreeDefaults()).toEqual({ remote: 'upstream' })
  })

  it('treats a blank as a removal rather than storing an empty default', () => {
    // A blank default has no effect on any project — the built-in answers — so
    // a blank row would be provenance saying the opposite of what happens.
    store.setWorktreeDefaults({ remote: 'upstream' })
    store.setWorktreeDefaults({ remote: '   ' })
    expect(store.getWorktreeDefaults()).toEqual({})
  })

  it('trims what it stores', () => {
    store.setWorktreeDefaults({ remote: '  upstream  ' })
    expect(store.getWorktreeDefaults().remote).toBe('upstream')
  })

  it('survives a reopen — these are the person’s settings, not a session’s', () => {
    store.setWorktreeDefaults({ remote: 'upstream' })
    db.close()
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    expect(new AppSettingsStore(db).getWorktreeDefaults()).toEqual({ remote: 'upstream' })
  })

  it('keeps its rows clear of every other setting in the table', () => {
    store.setWorktreeDefaults({ remote: 'upstream' })
    store.setOnboardingCompleted(true)
    expect(store.getWorktreeDefaults()).toEqual({ remote: 'upstream' })
    expect(store.getOnboardingCompleted()).toBe(true)
  })

  // Dual-written while older builds (which read only `workspace.<old key>`)
  // share this profile — see WORKTREE_DEFAULT_PREFIX.
  describe('row spelling (dual-written for older builds)', () => {
    const rows = (): Array<{ key: string; value: string }> =>
      db
        .prepare("SELECT key, value FROM app_settings WHERE key LIKE 'w%' ORDER BY key")
        .all() as Array<{ key: string; value: string }>
    const seed = (key: string, value: string): void => {
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, value)
    }

    it('writes BOTH worktree.<new key> and workspace.<old key> with the same value', () => {
      store.setWorktreeDefaults({
        remote: 'upstream',
        threadWorktrees: 'false',
        worktreeStart: 'trunk',
        worktreeCap: '4',
        worktreeSetup: 'npm ci',
        worktreeSetupTimeoutMs: '60000',
      })
      expect(rows()).toEqual([
        { key: 'workspace.remote', value: 'upstream' },
        { key: 'workspace.thread_worktrees', value: 'false' },
        { key: 'workspace.workspace_cap', value: '4' },
        { key: 'workspace.workspace_setup', value: 'npm ci' },
        { key: 'workspace.workspace_setup_timeout_ms', value: '60000' },
        { key: 'workspace.workspace_start', value: 'trunk' },
        { key: 'worktree.remote', value: 'upstream' },
        { key: 'worktree.thread_worktrees', value: 'false' },
        { key: 'worktree.worktree_cap', value: '4' },
        { key: 'worktree.worktree_setup', value: 'npm ci' },
        { key: 'worktree.worktree_setup_timeout_ms', value: '60000' },
        { key: 'worktree.worktree_start', value: 'trunk' },
      ])
    })

    it('reads a workspace.* row an older build wrote alone', () => {
      seed('workspace.remote', 'fork')
      seed('workspace.workspace_start', 'branch:release')
      expect(store.getWorktreeDefaults()).toEqual({
        remote: 'fork',
        worktreeStart: 'branch:release',
      })
    })

    it('prefers the legacy row when both spellings exist (a pre-rename build writes only that one)', () => {
      seed('workspace.workspace_cap', '2')
      seed('worktree.worktree_cap', '6')
      expect(store.getWorktreeDefaults()).toEqual({ worktreeCap: '2' })
    })

    it('a save overwrites both rows, and an unset removes both', () => {
      seed('workspace.workspace_start', 'trunk')
      store.setWorktreeDefaults({ worktreeStart: 'here' })
      expect(rows()).toEqual([
        { key: 'workspace.workspace_start', value: 'here' },
        { key: 'worktree.worktree_start', value: 'here' },
      ])

      store.setWorktreeDefaults({ worktreeStart: null })
      expect(rows()).toEqual([])
      expect(store.getWorktreeDefaults()).toEqual({})
    })

    it('leaves an old row alone when the save did not name its setting', () => {
      seed('workspace.remote', 'fork')
      store.setWorktreeDefaults({ baseBranch: 'develop' })
      expect(rows().map((row) => row.key)).toEqual([
        'workspace.branch',
        'workspace.remote',
        'worktree.branch',
      ])
    })
  })

  describe('telemetry consent', () => {
    it('is UNANSWERED before anyone is asked — not a no, and never a yes', () => {
      // The first-run wizard has to tell "declined" from "not reached", and an
      // unanswered question must never read as consent: everything optional
      // stays home until this is explicitly true.
      expect(store.getTelemetryConsent()).toBeNull()
    })

    it('remembers a yes and a no distinctly', () => {
      store.setTelemetryConsent(true)
      expect(store.getTelemetryConsent()).toBe(true)
      store.setTelemetryConsent(false)
      expect(store.getTelemetryConsent()).toBe(false)
    })

    it('survives a new store over the same database', () => {
      // A consent that does not outlive a restart would be asked again, and a
      // question asked twice reads as one that was ignored.
      store.setTelemetryConsent(true)
      expect(new AppSettingsStore(db).getTelemetryConsent()).toBe(true)
    })
  })

  describe('model context-window preferences (#1929)', () => {
    it('defaults to an empty map', () => {
      expect(store.getModelContextPreferences('copilot')).toEqual({})
    })

    it('round-trips a max choice per model', () => {
      store.setModelContextPreference('copilot', 'claude-sonnet-4.5', 'max')
      expect(store.getModelContextPreferences('copilot')).toEqual({ 'claude-sonnet-4.5': 'max' })
    })

    it("'default' removes the entry rather than storing it", () => {
      store.setModelContextPreference('copilot', 'claude-sonnet-4.5', 'max')
      store.setModelContextPreference('copilot', 'claude-sonnet-4.5', 'default')
      expect(store.getModelContextPreferences('copilot')).toEqual({})
    })

    it('is scoped per provider', () => {
      store.setModelContextPreference('copilot', 'gpt-5-mini', 'max')
      expect(store.getModelContextPreferences('codex')).toEqual({})
    })

    it('survives a reopen', () => {
      store.setModelContextPreference('copilot', 'gpt-5-mini', 'max')
      db.close()
      db = openDatabase(join(tempDir, 'flow.sqlite'))
      expect(new AppSettingsStore(db).getModelContextPreferences('copilot')).toEqual({
        'gpt-5-mini': 'max',
      })
    })
  })

  describe('Workspaces (app-only rows — no schema change)', () => {
    it('stores and clears the current Workspace', () => {
      expect(store.getCurrentWorkspace()).toBeNull()
      store.setCurrentWorkspace('acme')
      expect(store.getCurrentWorkspace()).toBe('acme')
      store.setCurrentWorkspace(null)
      expect(store.getCurrentWorkspace()).toBeNull()
    })

    it('keeps a GENERATED project description on this computer, per Workspace project', () => {
      expect(store.getGeneratedProjectDescription('acme', 'web')).toBeNull()
      store.setGeneratedProjectDescription('acme', 'web', 'The storefront web app.')
      expect(store.getGeneratedProjectDescription('acme', 'web')).toBe('The storefront web app.')
      expect(store.getGeneratedProjectDescription('acme', 'api')).toBeNull()
      expect(store.getGeneratedProjectDescription('other', 'web')).toBeNull()
    })

    it("keeps a card's extra projects per task, de-duplicated; empty removes the row", () => {
      expect(store.setTaskExtraProjects('t1', ['/a', '/b', '/a', ' '])).toEqual(['/a', '/b'])
      store.setTaskExtraProjects('t2', ['/c'])
      expect(store.getTaskExtraProjects('t1')).toEqual(['/a', '/b'])
      expect(store.getTaskExtraProjects('t2')).toEqual(['/c'])
      store.setTaskExtraProjects('t1', [])
      expect(store.getTaskExtraProjects('t1')).toEqual([])
      store.forgetTaskExtraProjects('t2')
      expect(store.getTaskExtraProjects('t2')).toEqual([])
      const rows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'workspaces_task_projects:%'").all()
      expect(rows).toEqual([])
    })

    it("remembers that a person chose a task's projects, and forgets it with the task", () => {
      expect(store.isTaskProjectsChosen('t1')).toBe(false)
      store.markTaskProjectsChosen('t1')
      expect(new AppSettingsStore(db).isTaskProjectsChosen('t1')).toBe(true)
      expect(store.isTaskProjectsChosen('t2')).toBe(false)
      store.forgetTaskExtraProjects('t1')
      expect(store.isTaskProjectsChosen('t1')).toBe(false)
    })

    it('keeps when knowledge last synced, per project and per Workspace, apart', () => {
      expect(store.getKnowledgeLastSyncedAt('project', '/code/api')).toBeNull()
      store.setKnowledgeLastSyncedAt('project', '/code/api', 1_700_000_000_000)
      store.setKnowledgeLastSyncedAt('workspace', 'acme', 1_700_000_100_000)
      expect(new AppSettingsStore(db).getKnowledgeLastSyncedAt('project', '/code/api')).toBe(1_700_000_000_000)
      expect(new AppSettingsStore(db).getKnowledgeLastSyncedAt('workspace', 'acme')).toBe(1_700_000_100_000)
      expect(store.getKnowledgeLastSyncedAt('workspace', '/code/api')).toBeNull()
      store.setKnowledgeLastSyncedAt('workspace', 'acme', Number.NaN)
      expect(store.getKnowledgeLastSyncedAt('workspace', 'acme')).toBe(1_700_000_100_000)
    })

    it('never writes under the legacy worktree-default prefix', () => {
      store.setCurrentWorkspace('acme')
      store.setTaskExtraProjects('t1', ['/a'])
      const rows = db.prepare("SELECT key FROM app_settings WHERE key LIKE 'workspace.%'").all()
      expect(rows).toEqual([])
    })
  })
})
