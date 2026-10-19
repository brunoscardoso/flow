import {
  BASE_REFRESH_TIMEOUT_MS,
  ThreadWorktreeService,
  countChangedFiles,
  refusalReason,
  startArgs,
  threadBranchName,
  wipBranchName,
  checkoutName,
  worktreeUnavailableNote,
  worktreeNameArgs,
  type RunResult,
  type WorktreeThread,
} from './thread-worktree'
import { resolveWorktreeSettings } from '../flow/worktree-settings'
import { MAX_SLUG_LENGTH, THREAD_BRANCH_PREFIX } from '../../shared/thread-branch'

const ROOT = '/repo'
const CHECKOUT = '/private/repo/.repo-threads/t1'

function thread(overrides: Partial<WorktreeThread> = {}): WorktreeThread {
  return {
    id: 't1',
    projectRoot: ROOT,
    title: '',
    status: 'idle',
    worktreePath: null,
    worktreeBranch: null,
    worktreeBase: null,
    ...overrides,
  }
}

function ok(stdout = ''): RunResult {
  return { ok: true, stdout }
}

function refused(reason: string): RunResult {
  // The repo's logger routes error() through console.log — a refusal really
  // does arrive on stdout (allowed-pattern #15).
  return { ok: false, stdout: `worktree refused: ${reason}\n` }
}

/** The bound a caller asked `runGit` to keep, per call, alongside `gitCalls`. */
type GitOptions = { timeoutMs?: number; signal?: AbortSignal } | undefined

interface Harness {
  service: ThreadWorktreeService
  cliCalls: string[][]
  /** Per-project checkout records the service wrote for ATTACHED projects. */
  attachedWritten: Array<{
    rootPath: string
    worktree: { path: string; branch: string | null; base: string | null } | null
  }>
  gitCalls: string[][]
  gitOptions: GitOptions[]
  notes: string[]
  written: Array<{
    path: string
    branch: string | null
    base: string | null
    baseMayBeBehind?: boolean
  } | null>
  record: WorktreeThread
  /** Every root `settingsFor` was asked about, in order — one read per prepare. */
  settingsCalls: string[]
  setupCalls: { cwd: string; command: string; timeoutMs?: number }[]
  detachCalls: string[]
  progress: { state: string; detail?: string }[]
  /** `detach` and `setup` in the order they actually happened. */
  order: string[]
}

function harness(
  options: {
    record?: WorktreeThread
    /** Other projects this conversation carries — none unless a test says so. */
    attachedRoots?: string[]
    cli?: (args: readonly string[]) => RunResult
    /** Async on purpose: the refresh's ceiling is only visible to a git that
     *  can take its time (or never answer at all). */
    git?: (args: readonly string[]) => RunResult | Promise<RunResult>
    /** The remote this project talks to. Absent → the built-in `origin`. */
    remote?: string
    /**
     * The project's own `.flowconfig` keys, resolved exactly as production
     * resolves them — through the resolver, never a hand-built settings object
     * (which would be a second copy of the built-in table).
     */
    projectRaw?: Record<string, string>
    enabled?: boolean
    disposeSession?: (threadId: string) => void
    /** Whether a recorded checkout is still on disk. Default: it is. */
    checkoutPresent?: (path: string) => boolean
    /** Whether ANY path exists — the project's own dependency folders. */
    pathPresent?: (path: string) => boolean
    /** The project's setup command runner. ABSENT → no setup ever runs. */
    setup?: (cwd: string, command: string, opts: { timeoutMs?: number }) => RunResult
  } = {},
): Harness {
  const record = options.record ?? thread()
  const cliCalls: string[][] = []
  const gitCalls: string[][] = []
  const gitOptions: GitOptions[] = []
  const notes: string[] = []
  const written: Harness['written'] = []
  const settingsCalls: string[] = []
  const setupCalls: { cwd: string; command: string; timeoutMs?: number }[] = []
  const detachCalls: string[] = []
  const progress: { state: string; detail?: string }[] = []
  const order: string[] = []
  /** Every per-project checkout record the service wrote. */
  const attachedWritten: Array<{
    rootPath: string
    worktree: { path: string; branch: string | null; base: string | null } | null
  }> = []
  const service = new ThreadWorktreeService({
    threadStore: {
      getThread: (id) => (id === record.id ? record : null),
      setThreadWorktree: (_id, worktree) => {
        written.push(worktree)
        if (worktree !== null) {
          record.worktreePath = worktree.path
          record.worktreeBranch = worktree.branch
          record.worktreeBase = worktree.base
        }
      },
      appendMessage: (_id, _role, content) => notes.push(content),
      // The folder-behind notice's once-per-thread guard reads what this
      // harness has already recorded, so a second call finds the first row.
      hasSystemMessage: (_id, content) => notes.includes(content),
      // The names already spoken for — what a folder derived from a title has
      // to be unique against. Whatever this harness has recorded, which is
      // nothing until a test cuts something.
      listThreadWorktrees: () => [
        ...written
          .filter((w): w is NonNullable<typeof w> => w !== null)
          .map((w) => ({ worktreePath: w.path, projectRoot: record.projectRoot })),
        ...attachedWritten
          .filter((w) => w.worktree !== null)
          .map((w) => ({ worktreePath: w.worktree?.path ?? '', projectRoot: w.rootPath })),
      ],
      // The OTHER projects a conversation carries. Empty unless a test attaches
      // some, so every existing case describes a single-project thread exactly
      // as it did before attached checkouts existed.
      getThreadRoots: () => options.attachedRoots ?? [],
      getThreadRootWorktrees: () => attachedWritten.filter((w) => w.worktree !== null).map((w) => ({
        rootPath: w.rootPath,
        worktreePath: w.worktree?.path ?? '',
        branch: w.worktree?.branch ?? null,
        base: w.worktree?.base ?? null,
      })),
      setThreadRootWorktree: (_id, rootPath, worktree) => {
        attachedWritten.push({ rootPath, worktree })
      },
    },
    runCli: async (_cwd, args) => {
      cliCalls.push([...args])
      return options.cli?.(args) ?? ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null }))
    },
    runGit: async (_cwd, args, gitOpts) => {
      gitCalls.push([...args])
      gitOptions.push(gitOpts)
      return options.git?.(args) ?? ok('')
    },
    isEnabled: async () => options.enabled ?? true,
    // Default TRUE: these fixtures use paths that were never made, and the
    // production reader would call every one of them missing.
    checkoutPresent: options.checkoutPresent ?? (() => true),
    // NOTHING ELSE ON DISK BY DEFAULT — a project with no dependency folder
    // beside it is what most projects are, and it is the quiet case.
    pathPresent: options.pathPresent ?? (() => false),
    // THROUGH THE RESOLVER, like production. A fake that assembled a settings
    // object by hand would be a second copy of the built-in table.
    ...(options.remote === undefined && options.projectRaw === undefined
      ? {}
      : {
          settingsFor: async (rootPath: string) => {
            settingsCalls.push(rootPath)
            return resolveWorktreeSettings({
              projectRaw: {
                ...(options.remote === undefined ? {} : { remote: options.remote }),
                ...options.projectRaw,
              },
              globalDefaults: {},
            })
          },
        }),
    ...(options.disposeSession === undefined ? {} : { disposeSession: options.disposeSession }),
    // ABSENT BY DEFAULT, and that is the contract under test as much as the
    // behaviour: without a runner handed over on purpose, no setup ever runs
    // however a project is configured (forbidden-pattern #15).
    ...(options.setup === undefined
      ? {}
      : {
          runSetup: async (cwd, command, opts) => {
            order.push('setup')
            setupCalls.push({ cwd, command, ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) })
            return options.setup!(cwd, command, opts)
          },
        }),
    detachModules: (threadId) => {
      order.push('detach')
      detachCalls.push(threadId)
    },
    onSetupProgress: (_threadId, event) => {
      progress.push({ state: event.state, ...(event.detail === undefined ? {} : { detail: event.detail }) })
    },
    now: () => new Date(2026, 7, 21, 14, 32, 5),
  })
  return {
    service,
    cliCalls,
    attachedWritten,
    gitCalls,
    gitOptions,
    notes,
    written,
    record,
    settingsCalls,
    setupCalls,
    detachCalls,
    progress,
    order,
  }
}

/** The verbs a git fake was asked for, in order. */
function verbs(gitCalls: string[][]): string[] {
  return gitCalls.map((call) => call[0] ?? '')
}

/**
 * The `worktree create` call, wherever it landed in the sequence.
 *
 * NOT `cliCalls[0]` ANY MORE. A new worktree starts from the project's BASE
 * branch by default (2026-09-17: "new thread should always start from main"),
 * and resolving that base asks the CLI which branch it is — so the create call
 * is no longer the first one the service makes. Asserting on an index made
 * these tests assertions about the ORDER of an unrelated lookup.
 */
function createCall(calls: readonly string[][]): readonly string[] {
  return calls.find((call) => call[0] === 'worktree' && call[1] === 'create') ?? []
}

/**
 * The verbs the service asked the CLI for, minus the base lookup.
 *
 * `worktree branches` is how the default start (the project's BASE branch)
 * resolves to a name, so it precedes every creation now. It is a READ — it
 * changes nothing and is not what any of these tests are about — so the
 * sequences below stay about the verbs that act.
 */
function actingVerbs(calls: readonly string[][]): string[] {
  return calls.map((call) => call[1] ?? '').filter((verb) => verb !== 'branches')
}

describe('threadBranchName', () => {
  it('slugs a title into the thread namespace', () => {
    expect(threadBranchName('Fix the login redirect')).toBe('worktree/fix-the-login-redirect')
    expect(threadBranchName('  Two   spaces & symbols!  ')).toBe('worktree/two-spaces-symbols')
  })

  it('has no name for a title that survives no slug', () => {
    expect(threadBranchName(null)).toBeNull()
    expect(threadBranchName('')).toBeNull()
    expect(threadBranchName('🎉🎉')).toBeNull()
  })

  it('never ends on a separator, even after truncation', () => {
    const branch = threadBranchName('a'.repeat(40) + ' ' + 'b'.repeat(40))
    expect(branch).not.toBeNull()
    expect(branch as string).not.toMatch(/-$/)
    // AGAINST THE CONSTANTS, not a number that happened to be right once. The
    // prefix changed from `thread/` to `worktree/` and this read 55 forever.
    expect((branch as string).length).toBeLessThanOrEqual(
      THREAD_BRANCH_PREFIX.length + MAX_SLUG_LENGTH,
    )
  })
})

describe('wipBranchName', () => {
  it('stamps to the second so two threads in a day never collide', () => {
    expect(wipBranchName(new Date(2026, 7, 21, 9, 4, 5))).toBe('wip/20260821-090405')
  })
})

describe('refusalReason', () => {
  it('reads the refusal off stdout', () => {
    expect(refusalReason(refused('/x is not a git repository'))).toBe('/x is not a git repository')
  })

  it('reads it off stderr too', () => {
    expect(
      refusalReason({ ok: false, stdout: '', stderr: 'worktree refused: no commits yet\n' }),
    ).toBe('no commits yet')
  })

  it('is null when there is no refusal line', () => {
    expect(refusalReason(ok('{"status":"created"}'))).toBeNull()
  })
})

describe('worktreeUnavailableNote', () => {
  it('says what is wrong in the terms of the project, never the tool', () => {
    const note = worktreeUnavailableNote('/x is not a git repository')
    expect(note).toContain('isn’t tracked by git')
    expect(note).toContain('work directly in the project’s files')
  })

  it('never repeats a command, a path or a config key (#12)', () => {
    for (const reason of [
      '/Users/me/x is not a git repository',
      'the repository has no commits — run `git commit` first',
      'something nobody predicted',
    ]) {
      const note = worktreeUnavailableNote(reason)
      expect(note).not.toContain('`')
      expect(note).not.toContain('planflow-ai')
      expect(note).not.toContain('git commit')
      expect(note).not.toContain('/Users/')
    }
  })
})

describe('countChangedFiles', () => {
  it('counts porcelain lines and ignores blanks', () => {
    expect(countChangedFiles(' M a.ts\n?? b.ts\n\n')).toBe(2)
    expect(countChangedFiles('')).toBe(0)
  })
})

describe('the chat-only guarantee', () => {
  it('creates nothing until something asks it to', () => {
    // THE GUARANTEE, asserted as what it is: a fact about call sites. Building
    // the service — which is what happens for every thread in the app, chat-only
    // or not — spawns no process and writes no column.
    const { cliCalls, gitCalls, written } = harness()
    expect(cliCalls).toEqual([])
    expect(gitCalls).toEqual([])
    expect(written).toEqual([])
  })

  it('leaves a thread that already has a checkout completely alone', async () => {
    const h = harness({ record: thread({ worktreePath: CHECKOUT }) })
    await expect(h.service.prepare('t1')).resolves.toEqual({ status: 'ready' })
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('does nothing for an unknown thread', async () => {
    const h = harness()
    await expect(h.service.prepare('nope')).resolves.toEqual({ status: 'unavailable' })
    expect(h.cliCalls).toEqual([])
  })
})

describe('prepare — creation', () => {
  it('creates detached, without fetching, and persists what the CLI returned', async () => {
    const h = harness({
      cli: () => ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null })),
    })
    await expect(h.service.prepare('t1', { ask: false })).resolves.toMatchObject({
      status: 'created',
    })
    expect(createCall(h.cliCalls)).toEqual([
      'worktree',
      'create',
      '--thread',
      't1',
      // NAMED FROM THE TITLE EVEN THOUGH NOBODY TYPED ONE. Sending no name left
      // the CLI's own fallback — the thread's slug — which is how a checkout
      // came to be a uuid in somebody's shell prompt while the field above it
      // promised "it takes the conversation's title" (user, 2026-09-18). This
      // harness's thread has no usable title, so it gets the same fallback the
      // ask would have shown.
      '--worktree-name',
      'worktree/work',
      '--detach',
      // THE DEFAULT START, spelled out: a new worktree begins at the project's
      // BASE branch, not at whatever the project folder was left on
      // (2026-09-17).
      '--trunk',
      '--no-fetch',
      '--json',
      '--target',
      ROOT,
    ])
    // The path the CLI returned — never one recomputed from the project root.
    // The cut answers whether it refreshed first; every other writer omits it.
    expect(h.written).toEqual([
      { path: CHECKOUT, branch: null, base: null, baseMayBeBehind: false },
    ])
  })

  // ── A branch a person named, applied at the cut ─────────────────────────

  it('names the branch a person typed, at creation — and leaves where it publishes unasked', async () => {
    // THE CLI'S OWN RULE, faked faithfully: `bind` without `--remote` is
    // refused. The old cut called it exactly that way, every time.
    const refusedBinds: string[][] = []
    const h = harness({
      cli: (args) => {
        if (args[1] === 'create') return ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null }))
        if (args[1] === 'bind' && !args.includes('--remote')) {
          refusedBinds.push([...args])
          return { ok: false, stdout: '', error: 'worktree refused: bind requires --remote <name>' }
        }
        return ok(JSON.stringify({ status: 'ok' }))
      },
    })
    await h.service.prepare('t1', { ask: false, branch: 'feature/PF-42-fix-parser' })
    // The name is applied through the SAME verb auto-naming uses — one code
    // path for "what is this branch called" (allowed-pattern #14).
    expect(actingVerbs(h.cliCalls)).toEqual(['create', 'name'])
    // A branch name is not a destination: nothing binds a remote nobody chose
    // (CLAUDE.md, Thread Remote Binding) — the first push asks.
    expect(refusedBinds).toEqual([])
    expect(h.cliCalls.some((call) => call[1] === 'bind')).toBe(false)
    // Exactly as typed. A sanitizer here would hand back a different branch
    // from the one the person was shown (allowed-pattern #22). The `name`
    // verb is the one that carries it — `create` cuts detached, and the base
    // lookup carries nothing at all.
    for (const call of h.cliCalls.filter((c) => c[1] === 'name')) {
      expect(call).toContain('feature/PF-42-fix-parser')
    }
    expect(h.written).toEqual([
      { path: CHECKOUT, branch: 'feature/PF-42-fix-parser', base: null, baseMayBeBehind: false },
    ])
  })

  it('keeps the checkout when the chosen name cannot be taken', async () => {
    // FAIL-SOFT, and only here. The checkout already holds work; throwing it
    // away over a name would destroy something real to protect something
    // cosmetic. It stays detached and is named later from the title, which is
    // exactly the pre-existing path.
    const h = harness({
      cli: (args) =>
        args[1] === 'create'
          ? ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null }))
          : { ok: false, stdout: '', stderr: 'taken', error: 'taken' },
    })
    await expect(h.service.prepare('t1', { ask: false, branch: 'feature/taken' })).resolves.toMatchObject(
      { status: 'created' },
    )
    expect(h.written).toEqual([
      { path: CHECKOUT, branch: null, base: null, baseMayBeBehind: false },
    ])
  })

  it('asks for no BRANCH at all when nobody chose one', async () => {
    // The path every caller took before the Create-thread modal: one CLI call,
    // detached, the branch named later from the first reply. The FOLDER is a
    // different question and is always answered — see the create-call assertion
    // above.
    const h = harness()
    await h.service.prepare('t1', { ask: false })
    expect(actingVerbs(h.cliCalls)).toEqual(['create'])
    expect(createCall(h.cliCalls)).not.toContain('--branch')
  })

  it('says a Python copy has no environment yet — once, and with somewhere to fix it', async () => {
    // A `git worktree` carries tracked files only, and the untracked set Flow
    // adds is JS-shaped, so this checkout has no interpreter. The first sign of
    // it used to be a command failing in a terminal with somebody else's error
    // message (user, 2026-09-18, running alembic in a fresh orbit-core copy).
    const h = harness({
      // The evidence is the folder beside the project, not a manifest.
      pathPresent: (path: string) => path.endsWith('/.venv'),
    })
    const result = await h.service.prepare('t1', { ask: false })
    expect(result.detail).toContain('no Python environment yet')
    // It points at a place in the app, never at the key it would set
    // (forbidden-pattern #12).
    expect(result.detail).toContain('Conversation files settings')
    expect(result.detail).not.toMatch(/worktree_setup|flowconfig|uv sync/)
  })

  it('says nothing to a project that already says what to run', async () => {
    const h = harness({
      pathPresent: (path: string) => path.endsWith('/.venv'),
      projectRaw: { worktree_setup: 'uv sync' },
    })
    const result = await h.service.prepare('t1', { ask: false })
    // The positive first: the cut DID happen, so a silent detail is a decision
    // rather than a path that was never reached (allowed-pattern #28).
    expect(result.status).toBe('created')
    expect(result.detail ?? '').not.toContain('no Python environment')
  })

  it('says nothing to a project with no such folder — which is most of them', async () => {
    const h = harness()
    const result = await h.service.prepare('t1', { ask: false })
    expect(result.status).toBe('created')
    expect(result.detail ?? '').not.toContain('environment yet')
  })

  it('names the folder from the conversation’s title, and keeps it unique', async () => {
    // THE PROMISE THE FIELD MAKES. "Leave it empty and it takes the
    // conversation's title" was kept by nothing: an empty field sent no name
    // and the CLI fell back to the thread id.
    const h = harness({ record: thread({ title: 'Rewrite the export pipeline' }) })
    await h.service.prepare('t1', { ask: false })
    expect(createCall(h.cliCalls)).toContain('worktree/rewrite-the-export-pipeline')
  })

  it('two callers arriving at once share one preparation', async () => {
    const h = harness()
    const [first, second] = await Promise.all([
      h.service.prepare('t1', { ask: false }),
      h.service.prepare('t1', { ask: false }),
    ])
    expect(first).toEqual(second)
    // One CLI, one write — a check-then-act gap here would make two of each.
    expect(actingVerbs(h.cliCalls)).toHaveLength(1)
    expect(h.written).toHaveLength(1)
  })

  it('records the branch the CLI reports when creation attached one', async () => {
    const h = harness({
      cli: () => ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: 'thread/x' })),
    })
    await h.service.prepare('t1', { ask: false })
    expect(h.written[0]).toMatchObject({ branch: 'thread/x' })
  })

  it('does not create when the project turned worktrees off', async () => {
    const h = harness({ enabled: false })
    await expect(h.service.prepare('t1', { ask: false })).resolves.toEqual({ status: 'disabled' })
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('says a refusal on the thread and falls back to today’s behaviour', async () => {
    const h = harness({ cli: () => refused('/repo is not a git repository') })
    const result = await h.service.prepare('t1', { ask: false })
    expect(result.status).toBe('refused')
    expect(h.written).toEqual([]) // nothing recorded — the thread stays as it was
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toContain('isn’t tracked by git')
  })

  it('does not re-spawn the CLI, or repeat the notice, for a repo that refused', async () => {
    const h = harness({ cli: () => refused('no commits') })
    await h.service.prepare('t1', { ask: false })
    await h.service.prepare('t1', { ask: false })
    await h.service.prepare('t1', { ask: false })
    expect(actingVerbs(h.cliCalls)).toHaveLength(1)
    expect(h.notes).toHaveLength(1)
  })

  it('retries a refused project when a person asks by name', async () => {
    // KEYED ON THE VERB, not on a call counter. Resolving the default start
    // (the project's base branch) asks the CLI which branch that is, so a
    // counter hands the refusal to the lookup instead of to the creation.
    let creates = 0
    const h = harness({
      cli: (args) => {
        if (args[1] !== 'create') return ok(JSON.stringify({ current: 'main', branches: [] }))
        creates += 1
        return creates === 1
          ? refused('no commits')
          : ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null }))
      },
    })
    await h.service.prepare('t1', { ask: false })
    await expect(h.service.prepare('t1', { requested: true })).resolves.toMatchObject({
      status: 'created',
    })
  })

  it('refuses a requested move while a turn is running, rather than lying', async () => {
    const h = harness({ record: thread({ status: 'working' }) })
    const result = await h.service.prepare('t1', { requested: true })
    expect(result.status).toBe('busy')
    expect(result.detail).toContain('working right now')
    expect(h.cliCalls).toEqual([])
  })

  it('drops an idle session on a requested move so the next turn lands in it', async () => {
    const disposed: string[] = []
    const h = harness({ disposeSession: (id) => disposed.push(id) })
    await h.service.prepare('t1', { requested: true, carry: 'clean' })
    expect(disposed).toEqual(['t1'])
  })

  it('never disposes a session on the automatic send path', async () => {
    const disposed: string[] = []
    const h = harness({ disposeSession: (id) => disposed.push(id) })
    await h.service.prepare('t1', { ask: false })
    expect(disposed).toEqual([])
  })
})

describe('the worktree setup step', () => {
  const configured = { worktree_setup: 'npm ci' }

  it('runs the project’s command in the new copy, bounded by the resolved wait', async () => {
    const h = harness({ projectRaw: configured, setup: () => ok('') })
    await h.service.prepare('t1', { ask: false })
    expect(h.setupCalls).toEqual([
      { cwd: CHECKOUT, command: 'npm ci', timeoutMs: 300_000 },
    ])
  })

  it('breaks the node_modules link BEFORE the command runs', async () => {
    // R-4, and the sharpest thing in the feature: `npm ci` under a symlinked
    // node_modules does not install into the worktree, it installs into the
    // user's checkout. Asserted as an ORDER, because an end state of "detached
    // and installed" is also what you get if the install ran first.
    const h = harness({ projectRaw: configured, setup: () => ok('') })
    await h.service.prepare('t1', { ask: false })
    expect(h.order).toEqual(['detach', 'setup'])
    expect(h.detachCalls).toEqual(['t1'])
  })

  it('runs NOTHING for a project that configured no command', async () => {
    // NFR-1, the promise the whole feature rests on. No command, no detach, no
    // extra wait — a project that never opens the panel is untouched.
    const h = harness({ setup: () => ok('') })
    await h.service.prepare('t1', { ask: false })
    expect(h.setupCalls).toEqual([])
    expect(h.detachCalls).toEqual([])
    // The ONE thing such a project does notice (Task 5.4): the cut itself now
    // says it is working. That silence was ~3.6 s of nothing on every new
    // thread, and it was never deliberate — only refusals ever reached the
    // thread, so a working app and a stuck one looked identical.
    expect(h.progress).toEqual([{ state: 'running' }, { state: 'done' }])
  })

  it('runs nothing when no runner was handed over, however configured', async () => {
    // forbidden-pattern #15: a dep that executes a project's shell command must
    // be passed on purpose. `{}` runs nothing.
    const h = harness({ projectRaw: configured })
    await h.service.prepare('t1', { ask: false })
    expect(h.detachCalls).toEqual([])
    // The cut still speaks; nothing was RUN.
    expect(h.progress).toEqual([{ state: 'running' }, { state: 'done' }])
  })

  it('says it is working, then that it finished', async () => {
    const h = harness({ projectRaw: configured, setup: () => ok('') })
    await h.service.prepare('t1', { ask: false })
    expect(h.progress).toEqual([{ state: 'running' }, { state: 'done' }])
  })

  it('a failed setup does not fail the message', async () => {
    // The stance `ensureBeforeSession` already takes for the whole cut: the
    // turn is worth more than the worktree.
    const h = harness({
      projectRaw: configured,
      setup: () => ({ ok: false, stdout: '', stderr: 'boom', error: 'exit 1' }),
    })
    const result = await h.service.prepare('t1', { ask: false })
    expect(result.status).toBe('created')
    expect(h.written).toHaveLength(1)
    expect(result.detail).toContain('ready to work in either way')
  })

  it('names a timeout as a timeout, and neither as the command', async () => {
    const h = harness({
      projectRaw: configured,
      setup: () => ({ ok: false, stdout: '', stderr: '', error: 'Command timed out' }),
    })
    const result = await h.service.prepare('t1', { ask: false })
    expect(result.detail).toContain('took longer than this project allows')
    // forbidden-pattern #12 and allowed-pattern #18: not the command they wrote,
    // not the path, and not a line of the child's output.
    expect(result.detail).not.toContain('npm ci')
    expect(result.detail).not.toContain(CHECKOUT)
    expect(h.progress.at(-1)).toMatchObject({ state: 'failed' })
  })

  it('never runs for a worktree that already exists', async () => {
    // Setup belongs to CREATING a copy. `prepare` on a recorded checkout
    // returns `ready` and must not re-run an install on every message.
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      projectRaw: configured,
      setup: () => ok(''),
    })
    await expect(h.service.prepare('t1', { ask: false })).resolves.toMatchObject({ status: 'ready' })
    expect(h.setupCalls).toEqual([])
    expect(h.detachCalls).toEqual([])
  })

  it('takes the wait the project configured, clamped', async () => {
    const h = harness({
      projectRaw: { ...configured, worktree_setup_timeout_ms: '999999999' },
      setup: () => ok(''),
    })
    await h.service.prepare('t1', { ask: false })
    // 30 minutes — the resolver's ceiling, applied where the value is read.
    expect(h.setupCalls[0]?.timeoutMs).toBe(30 * 60_000)
  })
})

describe('dependency promotion — the caller it never had', () => {
  // `promoteDependencies` has been implemented, registered as a CLI verb, and
  // cited by name in the comment justifying the `node_modules` symlink, while
  // nothing in the app ever called it. Everything below is behaviour that has
  // never run before, which is why it is asserted rather than assumed.

  it('promotes through the CLI when a turn ends', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      cli: () => ok(JSON.stringify({ status: 'installed', manifests: ['package-lock.json'] })),
    })
    h.service.promoteAfterTurn('t1')
    await h.service.settleDependencies('t1')
    expect(h.cliCalls).toEqual([
      ['worktree', 'promote', '--thread', 't1', '--json', '--target', ROOT],
    ])
  })

  it('says nothing for the common case, where no manifest changed', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      cli: () => ok(JSON.stringify({ status: 'clean', manifests: [] })),
    })
    h.service.promoteAfterTurn('t1')
    await h.service.settleDependencies('t1')
    expect(h.notes).toEqual([])
  })

  it('names the files when the toolchain is not one Flow installs for', async () => {
    // `manual` — a Python, Ruby, Go or Rust manifest changed. Swallowing it
    // would let the NEXT turn fail for a reason nothing on screen explains.
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      cli: () => ok(JSON.stringify({ status: 'manual', manifests: ['pyproject.toml'] })),
    })
    h.service.promoteAfterTurn('t1')
    await h.service.settleDependencies('t1')
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0]).toContain('pyproject.toml')
    // The remedy is theirs to know; naming an installer here would be Flow
    // running another ecosystem's toolchain on a hunch (forbidden-pattern #12).
    expect(h.notes[0]).not.toMatch(/\b(pip|poetry|uv|bundle|cargo|go get)\b/)
  })

  it('never touches a thread that has no worktree', async () => {
    const h = harness({ record: thread({ worktreePath: null }) })
    h.service.promoteAfterTurn('t1')
    await h.service.settleDependencies('t1')
    expect(h.cliCalls).toEqual([])
  })

  it('runs once for overlapping turn-ends, not once per call', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      cli: () => ok(JSON.stringify({ status: 'clean', manifests: [] })),
    })
    h.service.promoteAfterTurn('t1')
    h.service.promoteAfterTurn('t1')
    await h.service.settleDependencies('t1')
    expect(actingVerbs(h.cliCalls)).toHaveLength(1)
  })

  it('settles instantly when nothing is owed — every turn but one', async () => {
    const h = harness({ record: thread({ worktreePath: CHECKOUT }) })
    await expect(h.service.settleDependencies('t1')).resolves.toBeUndefined()
    expect(h.cliCalls).toEqual([])
  })

  it('a promotion that fails costs a slower turn, never the turn', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      cli: () => ({ ok: false, stdout: '', stderr: 'locked', error: 'locked' }),
    })
    h.service.promoteAfterTurn('t1')
    await expect(h.service.settleDependencies('t1')).resolves.toBeUndefined()
    expect(h.notes).toEqual([])
  })
})

describe('prepare — the uncommitted-work offer', () => {
  const dirty = (args: readonly string[]): RunResult =>
    args[0] === 'status' ? ok(' M a.ts\n M b.ts\n M c.ts\n') : ok('main\n')

  it('asks only when there is something to bring', async () => {
    const h = harness({ git: dirty })
    const result = await h.service.prepare('t1', { ask: true })
    expect(result).toMatchObject({ status: 'needs-choice', changedFiles: 3, baseBranch: 'main' })
    expect(h.cliCalls).toEqual([]) // nothing created while the question is open
    // Tracked only: none of the three answers touches an untracked file, so a
    // count that included them would overstate what is at stake.
    expect(h.gitCalls[0]).toEqual(['status', '--porcelain', '--untracked-files=no'])
  })

  it('does not ask when the project tree is clean', async () => {
    const h = harness({ git: (args) => (args[0] === 'status' ? ok('') : ok('main\n')) })
    await expect(h.service.prepare('t1', { ask: true })).resolves.toMatchObject({
      status: 'created',
    })
  })

  it('never asks on the send path, even with a dirty tree', async () => {
    const h = harness({ git: dirty })
    await expect(h.service.prepare('t1', { ask: false })).resolves.toMatchObject({
      status: 'created',
    })
  })

  it('clean is the default and moves nothing of the user’s', async () => {
    const h = harness({ git: dirty })
    await h.service.prepare('t1', { ask: false })
    const verbs = h.gitCalls.map((call) => call.join(' '))
    expect(verbs.some((call) => call.startsWith('stash push'))).toBe(false)
    expect(verbs.some((call) => call.startsWith('branch'))).toBe(false)
  })

  it('commit copies the work onto a branch and starts the worktree from it', async () => {
    const h = harness({
      git: (args) => {
        if (args[0] === 'status') return ok(' M a.ts\n')
        if (args[0] === 'stash' && args[1] === 'create') return ok('abc123\n')
        if (args[0] === 'rev-parse') return ok('main\n')
        return ok('')
      },
      cli: () =>
        ok(
          JSON.stringify({
            status: 'created',
            created: true,
            path: CHECKOUT,
            branch: null,
            base: 'wip/20260821-143205',
          }),
        ),
    })
    const result = await h.service.prepare('t1', { carry: 'commit' })
    expect(result.status).toBe('created')
    expect(result.wipBranch).toBe('wip/20260821-143205')
    const verbs = h.gitCalls.map((call) => call.join(' '))
    // `stash create` writes an object and touches nothing on disk; `stash push`
    // would have taken the user's changes away without being asked.
    expect(verbs).toContain('stash create')
    expect(verbs).toContain('branch wip/20260821-143205 abc123')
    expect(verbs.some((call) => call.startsWith('stash push'))).toBe(false)
    // …and the worktree is CREATED from that branch rather than created and
    // then moved onto it. The parked work is not a second mechanism — it is a
    // branch, and a branch is something a worktree can simply start from.
    expect(createCall(h.cliCalls)).toContain('--base')
    expect(createCall(h.cliCalls)).toContain('wip/20260821-143205')
    expect(verbs.some((call) => call.startsWith('checkout'))).toBe(false)
    expect(h.written[0]).toMatchObject({ base: 'wip/20260821-143205' })
  })

  it('never moves a checkout it did not create — an earlier one may hold work', async () => {
    const h = harness({
      git: (args) => {
        if (args[0] === 'stash' && args[1] === 'create') return ok('abc123\n')
        if (args[0] === 'rev-parse') return ok('main\n')
        return ok('')
      },
      // `create` is idempotent: a leftover directory comes back ready, and its
      // HEAD is not this call's to move. The guarantee is now the CLI's — a
      // start point applies only when it CREATES — so the app runs no git that
      // could move a checkout at all.
      cli: () =>
        ok(JSON.stringify({ status: 'ready', created: false, path: CHECKOUT, branch: null })),
    })
    await h.service.prepare('t1', { carry: 'commit' })
    expect(h.gitCalls.map((call) => call[0])).not.toContain('checkout')
  })

  it('commit falls back to a clean start when there was nothing to copy', async () => {
    const h = harness({
      git: (args) => {
        if (args[0] === 'stash' && args[1] === 'create') return ok('\n')
        if (args[0] === 'rev-parse') return ok('main\n')
        return ok('')
      },
      cli: () =>
        ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null, base: 'main' })),
    })
    const result = await h.service.prepare('t1', { carry: 'commit' })
    expect(result.status).toBe('created')
    expect(result.wipBranch).toBeUndefined()
    expect(h.gitCalls.map((call) => call[0])).not.toContain('checkout')
    expect(createCall(h.cliCalls)).not.toContain('--base')
    expect(h.written[0]).toMatchObject({ base: 'main' })
  })

  it('stash sets the work aside and starts from the last commit', async () => {
    const h = harness({
      git: (args) => (args[0] === 'rev-parse' ? ok('main\n') : ok('')),
      cli: () =>
        ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null, base: 'main' })),
    })
    const result = await h.service.prepare('t1', { carry: 'stash' })
    expect(result.status).toBe('created')
    expect(h.gitCalls.map((call) => call.slice(0, 2).join(' '))).toContain('stash push')
    expect(result.detail).toContain('stashed')
    expect(h.written[0]).toMatchObject({ base: 'main' })
  })
})

describe('branchAvailable', () => {
  // THE REFUSAL REACHES THE FIELD, not a thread that already exists. This is
  // what lets the modal say "no thread was created" and mean it: nothing is
  // made until this answers yes (allowed-pattern #21).
  it('refuses a name git would refuse, and touches nothing', async () => {
    const h = harness()
    await expect(h.service.branchAvailable(ROOT, 'fix parser!!')).resolves.toEqual({
      ok: false,
      detail: expect.stringContaining('isn’t a name a branch can have'),
    })
    expect(h.gitCalls).toEqual([])
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('refuses a name something already works under', async () => {
    const h = harness({ git: () => ok('abc123') })
    await expect(h.service.branchAvailable(ROOT, 'feature/PF-42')).resolves.toEqual({
      ok: false,
      detail: 'Something already works under that name. Pick another one.',
    })
    // Asked, never taken — a read-only check creates nothing.
    expect(verbs(h.gitCalls)).toEqual(['rev-parse'])
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('accepts a free, valid name', async () => {
    const h = harness({ git: () => ok('') })
    await expect(h.service.branchAvailable(ROOT, 'feature/PF-42')).resolves.toEqual({
      ok: true,
      detail: null,
    })
  })

  it('never names a command, a path or a config key (#12)', async () => {
    const h = harness()
    const refused = await h.service.branchAvailable(ROOT, 'fix parser!!')
    expect(refused.detail ?? '').not.toMatch(/planflow-ai|git |--|\/repo|\.flowconfig/)
  })
})

describe('nameAfterTitle', () => {
  it('names a detached checkout once the title lands', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT, title: 'Fix the login redirect' }),
      cli: () => ok(JSON.stringify({ status: 'named', branch: 'worktree/fix-the-login-redirect' })),
    })
    await h.service.nameAfterTitle('t1')
    expect(h.cliCalls[0]).toEqual([
      'worktree',
      'name',
      '--thread',
      't1',
      // THE FOLDER, SO THE VERB CAN FIND IT. The CLI works out which thread a
      // checkout belongs to from its directory NAME, so a named folder is
      // invisible to a lookup by thread id (2026-09-17). This fixture's
      // checkout sits in a folder called `t1`, and that is what gets passed.
      '--worktree-name',
      't1',
      '--branch',
      'worktree/fix-the-login-redirect',
      '--json',
      '--target',
      ROOT,
    ])
    expect(h.written).toEqual([
      { path: CHECKOUT, branch: 'worktree/fix-the-login-redirect', base: null },
    ])
  })

  // THE GUARD THAT MAKES A CHOSEN NAME SURVIVE. `nameAfterTitle` runs after
  // every successful turn, and the first turn's title is generated. Without
  // this early return, the model's title would quietly rename a branch a person
  // typed — the one thing the whole feature exists to stop.
  //
  // The return already existed for the auto-named case; nothing had ever proved
  // it protects a chosen one, because until now no name could be chosen.
  it('leaves a branch a person chose exactly where it is', async () => {
    const h = harness({
      record: thread({
        worktreePath: CHECKOUT,
        worktreeBranch: 'feature/PF-42-fix-parser',
        title: 'Fix the login redirect',
      }),
    })
    await h.service.nameAfterTitle('t1')
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
    expect(h.record.worktreeBranch).toBe('feature/PF-42-fix-parser')
  })

  it('persists the branch the CLI RETURNED, not the one asked for', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT, title: 'Fix login' }),
      // Deduping moved it — a second thread already took the name.
      cli: () =>
        ok(
          JSON.stringify({
            status: 'named',
            branch: 'thread/fix-login-2',
            requested: 'thread/fix-login',
          }),
        ),
    })
    await h.service.nameAfterTitle('t1')
    expect(h.written[0]).toMatchObject({ branch: 'thread/fix-login-2' })
  })

  it('does nothing for a thread with no checkout, no title, or a branch already', async () => {
    for (const record of [
      thread({ title: 'Has a title' }),
      thread({ worktreePath: CHECKOUT, title: '' }),
      thread({ worktreePath: CHECKOUT, title: 'Named', worktreeBranch: 'thread/named' }),
    ]) {
      const h = harness({ record })
      await h.service.nameAfterTitle('t1')
      expect(h.cliCalls).toEqual([])
      expect(h.written).toEqual([])
    }
  })

  it('leaves the checkout detached when naming refuses', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT, title: 'Fix login' }),
      cli: () => refused('thread has no worktree to name'),
    })
    await h.service.nameAfterTitle('t1')
    expect(h.written).toEqual([])
  })

  it('preserves the base it was cut from across the rename', async () => {
    const h = harness({
      record: thread({
        worktreePath: CHECKOUT,
        title: 'Fix login',
        worktreeBase: 'wip/20260821-143205',
      }),
      cli: () => ok(JSON.stringify({ status: 'named', branch: 'thread/fix-login' })),
    })
    await h.service.nameAfterTitle('t1')
    expect(h.written[0]).toMatchObject({ base: 'wip/20260821-143205' })
  })
})

describe('startArgs — where the worktree begins, as the CLI hears it', () => {
  it('asks for nothing but a detached checkout when nobody chose', () => {
    // THE DEFAULT IS THE FIX. No `--trunk`, no base: the CLI's own default is
    // now the branch the project is on, so the send path — which has no screen
    // to ask on — gets the person's own work rather than the repository's trunk.
    expect(startArgs({ kind: 'here' })).toEqual(['--detach'])
  })

  it('branches off a named branch, still detached until the title lands', () => {
    expect(startArgs({ kind: 'branch', branch: 'ACME-2446' })).toEqual([
      '--detach',
      '--base',
      'ACME-2446',
    ])
  })

  it('never detaches a worktree that takes a branch — it already has a name', () => {
    expect(startArgs({ kind: 'checkout', branch: 'ACME-2446' })).toEqual(['--checkout', 'ACME-2446'])
  })

  it('keeps the old behaviour reachable by name', () => {
    expect(startArgs({ kind: 'trunk' })).toEqual(['--detach', '--trunk'])
  })
})

describe('prepare — choosing where it starts', () => {
  it('sends the chosen branch through to the worktree tool', async () => {
    const h = harness({
      cli: () =>
        ok(
          JSON.stringify({
            status: 'created',
            path: CHECKOUT,
            branch: 'ACME-2446',
            base: 'ACME-2446',
            onBase: true,
          }),
        ),
    })
    const result = await h.service.prepare('t1', {
      ask: false,
      requested: true,
      start: { kind: 'checkout', branch: 'ACME-2446' },
    })

    expect(createCall(h.cliCalls)).toContain('--checkout')
    expect(createCall(h.cliCalls)).toContain('ACME-2446')
    expect(createCall(h.cliCalls)).not.toContain('--detach')
    // Branch and base are the same name — the signal, everywhere, that this
    // worktree's commits are already where they belong.
    expect(h.written[0]).toEqual({
      path: CHECKOUT,
      branch: 'ACME-2446',
      base: 'ACME-2446',
      baseMayBeBehind: false,
    })
    expect(result).toMatchObject({ status: 'created', base: 'ACME-2446', onBase: true })
  })

  it('records the branch the CLI reported, never one it re-read afterwards', async () => {
    const h = harness({
      // The project moved on between the checkout and the write — a re-read
      // here would record a branch the worktree was never cut from.
      git: () => ok('somewhere-else\n'),
      cli: () =>
        ok(
          JSON.stringify({
            status: 'created',
            path: CHECKOUT,
            branch: null,
            base: 'ACME-2446',
          }),
        ),
    })
    await h.service.prepare('t1', { ask: false })
    expect(h.written[0]).toMatchObject({ base: 'ACME-2446' })
  })

  it('does not ask about uncommitted work when the worktree starts somewhere else', async () => {
    // The question only has honest answers for a worktree starting where the
    // person is. Starting elsewhere leaves their files untouched, which is what
    // `clean` does — so nothing is asked and nothing of theirs moves.
    const h = harness({ git: () => ok(' M a.ts\n M b.ts\n') })
    const result = await h.service.prepare('t1', {
      ask: true,
      requested: true,
      start: { kind: 'checkout', branch: 'ACME-2446' },
    })

    expect(result.status).not.toBe('needs-choice')
    const verbs = h.gitCalls.map((call) => call.join(' '))
    expect(verbs.some((call) => call.startsWith('stash'))).toBe(false)
    expect(verbs.some((call) => call.startsWith('branch'))).toBe(false)
  })

  it('still asks when the worktree starts where the person is', async () => {
    const h = harness({ git: () => ok(' M a.ts\n') })
    await expect(
      h.service.prepare('t1', { ask: true, requested: true, start: { kind: 'here' } }),
    ).resolves.toMatchObject({ status: 'needs-choice' })
  })
})

describe('prepare — refreshing what the worktree starts from', () => {
  /** Git that answers "there is a counterpart on the remote" to the probe. */
  const tracked = (args: readonly string[]): RunResult =>
    args[0] === 'rev-parse' ? ok('abc123\n') : ok('')

  it('skips the network for a base with no counterpart on the remote', async () => {
    // A branch that lives only here — the parked `wip/` branch every carried-work
    // cut starts from, a local experiment — cannot be behind anything, so the
    // round trip that could only fail is never made. The probe still IS: the
    // service asks before it decides.
    const h = harness()
    await h.service.prepare('t1', { ask: false, start: { kind: 'branch', branch: 'wip/x' } })
    expect(h.gitCalls).toContainEqual(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/wip/x'])
    expect(verbs(h.gitCalls)).not.toContain('fetch')
    // Nothing was skipped that could have been known — the cut is not flagged.
    expect(h.written[0]).toMatchObject({ baseMayBeBehind: false })
  })

  it('fetches the remote the PROJECT talks to, never a constant', async () => {
    const h = harness({ remote: 'upstream', git: tracked })
    const result = await h.service.prepare('t1', {
      ask: false,
      start: { kind: 'branch', branch: 'main' },
    })
    expect(h.gitCalls).toContainEqual([
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/upstream/main',
    ])
    expect(h.gitCalls).toContainEqual(['fetch', '--quiet', 'upstream', 'main'])
    expect(verbs(h.gitCalls)).not.toContain('merge') // it updates what the repo
    expect(verbs(h.gitCalls)).not.toContain('pull') // knows, never someone's branch
    // A refresh that worked is a cut that is not behind, and nothing to say.
    expect(h.written[0]).toMatchObject({ baseMayBeBehind: false })
    expect(result.baseMayBeBehind).toBeUndefined()
    expect(result.detail).toBeUndefined()
  })

  it('asks the fetch to keep the ceiling it is raced against', async () => {
    const h = harness({ git: tracked })
    await h.service.prepare('t1', { ask: false, start: { kind: 'branch', branch: 'main' } })
    const index = h.gitCalls.findIndex((call) => call[0] === 'fetch')
    expect(index).toBeGreaterThanOrEqual(0)
    expect(h.gitOptions[index]?.timeoutMs).toBe(BASE_REFRESH_TIMEOUT_MS)
    expect(h.gitOptions[index]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('cuts anyway when the fetch fails, and says so in one sentence', async () => {
    const h = harness({
      git: (args) => (args[0] === 'fetch' ? { ok: false, stdout: '', error: 'offline' } : ok('abc\n')),
    })
    const result = await h.service.prepare('t1', {
      ask: false,
      start: { kind: 'branch', branch: 'main' },
    })
    // The worktree exists — the freshness is what was lost, not the cut.
    expect(result.status).toBe('created')
    expect(result.baseMayBeBehind).toBe(true)
    expect(h.written[0]).toMatchObject({ baseMayBeBehind: true })
    expect(result.detail).toContain('may be behind')
    expect((result.detail ?? '').split('. ')).toHaveLength(1)
  })

  it('never names a command, a flag, a path or a config key in that sentence (#12)', async () => {
    const h = harness({
      git: (args) => (args[0] === 'fetch' ? { ok: false, stdout: '' } : ok('abc\n')),
    })
    const result = await h.service.prepare('t1', {
      ask: false,
      start: { kind: 'branch', branch: 'main' },
    })
    expect(result.detail).not.toMatch(/planflow-ai|`|git |--|\/repo|worktree_base/)
  })

  it('gives up on a fetch that never answers, and still cuts', async () => {
    jest.useFakeTimers()
    try {
      const h = harness({
        // The remote that is down, the VPN that is slow, the SSH key waiting on
        // a passphrase: a promise that simply never settles.
        git: (args) => (args[0] === 'fetch' ? new Promise<RunResult>(() => undefined) : ok('abc\n')),
      })
      const pending = h.service.prepare('t1', {
        ask: false,
        start: { kind: 'branch', branch: 'main' },
      })
      await jest.advanceTimersByTimeAsync(BASE_REFRESH_TIMEOUT_MS)
      const result = await pending
      expect(result.status).toBe('created')
      expect(result.baseMayBeBehind).toBe(true)
      expect(h.written[0]).toMatchObject({ baseMayBeBehind: true })
      // The WAIT was abandoned, not the repository: a killed fetch leaves refs
      // exactly as it found them, and the checkout went ahead regardless.
      expect(createCall(h.cliCalls)).toContain('--no-fetch')
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not go to the network at all when the caller has already given up', async () => {
    const controller = new AbortController()
    controller.abort()
    const h = harness({ git: tracked })
    const result = await h.service.prepare('t1', {
      ask: false,
      start: { kind: 'branch', branch: 'main' },
      signal: controller.signal,
    })
    expect(verbs(h.gitCalls)).not.toContain('fetch')
    // A person who stopped waiting for a remote has not abandoned their
    // worktree — it is cut, and it says what it started from.
    expect(result.status).toBe('created')
    expect(result.baseMayBeBehind).toBe(true)
    expect(result.detail).toContain('may be behind')
  })

  it('has nothing to refresh when it cannot tell where the cut starts', async () => {
    // A detached project, an unreadable HEAD: `here` with no branch to name.
    const h = harness({ git: () => ok('\n') })
    await h.service.prepare('t1', { ask: false, start: { kind: 'here' } })
    expect(verbs(h.gitCalls)).not.toContain('fetch')
    expect(h.written[0]).toMatchObject({ baseMayBeBehind: false })
  })
})

describe('nameAfterTitle — a worktree that took a branch already has its name', () => {
  it('never renames a checkout that is on a branch of the project', async () => {
    // The one shape where the branch exists from the first second. Renaming it
    // would take a person's branch away from the work sitting on it.
    const h = harness({
      record: thread({
        worktreePath: CHECKOUT,
        title: 'Fix the merge',
        worktreeBranch: 'ACME-2446',
        worktreeBase: 'ACME-2446',
      }),
    })
    await h.service.nameAfterTitle('t1')
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })
})

describe('branches — what the picker is offered', () => {
  it('reports the branches and which of them are spoken for', async () => {
    const h = harness({
      cli: () =>
        ok(
          JSON.stringify({
            status: 'listed',
            current: 'ACME-2446',
            branches: [
              { name: 'ACME-2446', current: true, trunk: false, heldBy: ROOT, canCheckOut: false, remoteOnly: false },
              { name: 'main', current: false, trunk: true, heldBy: null, canCheckOut: true, remoteOnly: false },
            ],
          }),
        ),
    })
    await expect(h.service.branches(ROOT)).resolves.toEqual({
      current: 'ACME-2446',
      branches: [
        { name: 'ACME-2446', current: true, trunk: false, heldBy: ROOT, canCheckOut: false, remoteOnly: false },
        { name: 'main', current: false, trunk: true, heldBy: null, canCheckOut: true, remoteOnly: false },
      ],
    })
  })

  it('offers nothing rather than a list it could not read', async () => {
    const h = harness({ cli: () => refused('not a git repository') })
    await expect(h.service.branches(ROOT)).resolves.toEqual({ current: null, branches: [] })
  })
})

describe('retarget — changing where an existing worktree works', () => {
  const withWorktree = (over: Partial<WorktreeThread> = {}): WorktreeThread =>
    thread({ worktreePath: CHECKOUT, worktreeBranch: null, worktreeBase: 'main', ...over })

  it('starts the worktree again when it is holding nothing', async () => {
    const h = harness({
      record: withWorktree(),
      git: (args) => (args[0] === 'rev-list' ? ok('0\n') : ok('')),
      cli: (args) =>
        args[1] === 'prune'
          ? ok(JSON.stringify({ status: 'pruned', path: CHECKOUT }))
          : ok(
              JSON.stringify({
                status: 'created',
                path: CHECKOUT,
                branch: 'ACME-2446',
                base: 'ACME-2446',
                onBase: true,
              }),
            ),
    })
    const result = await h.service.retarget('t1', { kind: 'checkout', branch: 'ACME-2446' })

    expect(result.status).toBe('recut')
    expect(result.base).toBe('ACME-2446')
    expect(result.detail).toContain('ACME-2446')
    expect(actingVerbs(h.cliCalls)).toEqual(['prune', 'create'])
  })

  it('never moves a worktree that holds work — only where that work goes', async () => {
    const h = harness({
      record: withWorktree({ worktreeBranch: 'thread/x' }),
      git: (args) => (args[0] === 'status' ? ok(' M engine.ts\n') : ok('')),
    })
    const result = await h.service.retarget('t1', { kind: 'branch', branch: 'ACME-2446' })

    expect(result.status).toBe('retargeted')
    expect(result.base).toBe('ACME-2446')
    // Nothing was pruned and nothing was created — the checkout is untouched.
    expect(h.cliCalls).toEqual([])
    // The two columns it was not asked to change come back exactly as they were.
    expect(h.written[0]).toEqual({ path: CHECKOUT, branch: 'thread/x', base: 'ACME-2446' })
  })

  it('treats a checkout it cannot read as holding work', async () => {
    const h = harness({
      record: withWorktree(),
      git: () => ({ ok: false, stdout: '' }),
    })
    const result = await h.service.retarget('t1', { kind: 'branch', branch: 'ACME-2446' })
    expect(result.status).toBe('retargeted')
    expect(h.cliCalls).toEqual([])
  })

  it('says so rather than moving a worktree mid-turn', async () => {
    const h = harness({ record: withWorktree({ status: 'working' }) })
    const result = await h.service.retarget('t1', { kind: 'branch', branch: 'ACME-2446' })
    expect(result.status).toBe('busy')
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('does nothing when it already works from there', async () => {
    const h = harness({ record: withWorktree({ worktreeBase: 'ACME-2446' }) })
    const result = await h.service.retarget('t1', { kind: 'branch', branch: 'ACME-2446' })
    expect(result.status).toBe('unchanged')
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('has nothing to change for a thread with no worktree', async () => {
    const h = harness()
    const result = await h.service.retarget('t1', { kind: 'trunk' })
    expect(result.status).toBe('unavailable')
    expect(h.cliCalls).toEqual([])
  })

  it('never names a command, a path or a config key (#12)', async () => {
    const h = harness({
      record: withWorktree(),
      git: (args) => (args[0] === 'status' ? ok(' M engine.ts\n') : ok('')),
    })
    const result = await h.service.retarget('t1', { kind: 'branch', branch: 'ACME-2446' })
    expect(result.detail).not.toMatch(/planflow-ai|`|--|\/repo|worktree_base/)
  })
})

describe('ensureBeforeSession', () => {
  it('never throws — a message is worth more than a worktree', async () => {
    const h = harness({
      cli: () => {
        throw new Error('the CLI exploded')
      },
    })
    await expect(h.service.ensureBeforeSession('t1', { firstTurn: false })).resolves.toBeUndefined()
    expect(h.written).toEqual([])
  })

  it('never asks, so a send is never blocked on a dialog', async () => {
    // A LOOP THREAD, because that is the only one this path still cuts for.
    const h = harness({
      record: thread({ originLoop: 'board' }),
      git: (args) => (args[0] === 'status' ? ok(' M a.ts\n') : ok('main\n')),
    })
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    expect(h.written).toHaveLength(1) // created, not parked on a question
  })

  it('cuts NOTHING for a conversation somebody is having', async () => {
    // THE CHANGE. Flow cut a copy of the project on every thread's first
    // message — no other agentic IDE does — and the result was a second
    // checkout per conversation that nobody chose and nothing explained.
    const h = harness()
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('still cuts for a thread a loop picked up on its own', async () => {
    // `originLoop` is the whole test, and it was already recorded: null for a
    // person, the loop's name for a run nobody is watching.
    const h = harness({ record: thread({ originLoop: 'board' }) })
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    expect(createCall(h.cliCalls)[1]).toBe('create')
    expect(h.written).toHaveLength(1)
  })

  it('reads a blank loop name as nobody, not as a loop', async () => {
    for (const originLoop of ['', '   ', null]) {
      const h = harness({ record: thread({ originLoop }) })
      await h.service.ensureBeforeSession('t1', { firstTurn: false })
      expect(h.cliCalls).toEqual([])
    }
  })

  it('leaves the EXPLICIT path alone — asking still creates', async () => {
    // Automatic is not the only way in; it is the way that happens TO you. The
    // row menu and the checkout bar both come through `prepare`.
    const h = harness()
    await expect(h.service.prepare('t1', { ask: false, requested: true })).resolves.toMatchObject({
      status: 'created',
    })
    expect(h.written).toHaveLength(1)
  })
})

describe('the folder-behind notice', () => {
  /**
   * A project folder on `main`, behind `origin/main`, with every git answer the
   * notice asks for. `behind` of 0 is the current folder; `ahead` makes it
   * diverged.
   */
  const behindGit =
    (over: { ahead?: number; behind?: number; upstream?: string | null; branch?: string } = {}) =>
    (args: readonly string[]): RunResult => {
      const branch = over.branch ?? 'main'
      if (args[0] === 'rev-parse' && args.includes('@{upstream}')) {
        return over.upstream === null ? refused('no upstream') : ok(`${over.upstream ?? 'origin/main'}\n`)
      }
      if (args[0] === 'rev-parse') return ok(`${branch}\n`)
      if (args[0] === 'rev-list') return ok(`${over.ahead ?? 0}\t${over.behind ?? 7}\n`)
      return ok('')
    }

  /**
   * The notice is deliberately NOT awaited by `ensureBeforeSession` — a turn
   * must not wait on a fetch to print a line. So the assertions wait for it
   * here instead, and a test that expects silence still pays the full wait
   * before believing it.
   */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
  }

  it('writes one row when the folder is behind, on the first turn', async () => {
    const h = harness({ git: behindGit() })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toEqual(['[folder-behind] main origin/main'])
    // NOTHING WAS CUT. The notice is a sentence, not a decision about where
    // this conversation works.
    expect(h.written).toEqual([])
  })

  it('says it once, however often the first send is retried', async () => {
    const h = harness({ git: behindGit() })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toHaveLength(1)
  })

  it('says nothing on a later turn', async () => {
    const h = harness({ git: behindGit() })
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    await settle()
    expect(h.notes).toEqual([])
    // POSITIVE FIRST (allowed-pattern #28): the same harness DOES speak when
    // the turn is the first one, so this silence is the flag's doing.
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toHaveLength(1)
  })

  it('says nothing to a thread that has a copy of its own', async () => {
    const h = harness({
      record: thread({ worktreePath: '/repo/.copy', worktreeBranch: 'thread/x' }),
      git: behindGit(),
    })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toEqual([])
    // AND IT ASKED GIT NOTHING. That path already started from the latest, so
    // the comparison is not merely unused — it is never paid for.
    expect(h.gitCalls.filter((args) => args[0] === 'rev-list')).toEqual([])
  })

  it('says nothing when the folder is current', async () => {
    const h = harness({ git: behindGit({ behind: 0 }) })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toEqual([])
  })

  it('says nothing when the branch tracks nothing', async () => {
    const h = harness({ git: behindGit({ upstream: null }) })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toEqual([])
    // It stopped at the upstream, rather than counting against a guess.
    expect(h.gitCalls.filter((args) => args[0] === 'rev-list')).toEqual([])
  })

  it('still writes the row for a diverged folder', async () => {
    // The card reads the live numbers and offers no merge; the ROW is the same
    // row, because this is the state most worth knowing about.
    const h = harness({ git: behindGit({ ahead: 2 }) })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toEqual(['[folder-behind] main origin/main'])
  })

  it('fetches first, under the same ceiling as a cut, through the configured remote', async () => {
    const h = harness({ remote: 'upstream', git: behindGit({ upstream: 'upstream/main' }) })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.gitCalls).toContainEqual(['fetch', '--quiet', 'upstream', 'main'])
    const fetched = h.gitCalls.findIndex((args) => args[0] === 'fetch')
    const counted = h.gitCalls.findIndex((args) => args[0] === 'rev-list')
    expect(fetched).toBeGreaterThanOrEqual(0)
    expect(counted).toBeGreaterThan(fetched)
    expect(h.notes).toEqual(['[folder-behind] main upstream/main'])
  })

  it('does not go to the network when the project said not to', async () => {
    // `base_refresh: false` is a person saying "do not fetch before starting
    // work". One meaning, one switch — the comparison still runs, against the
    // refs already on disk.
    const h = harness({ projectRaw: { base_refresh: 'false' }, git: behindGit() })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.gitCalls.filter((args) => args[0] === 'fetch')).toEqual([])
    expect(h.notes).toEqual(['[folder-behind] main origin/main'])
  })

  it('says nothing when git would not give a count', async () => {
    const h = harness({
      git: (args) => {
        if (args[0] === 'rev-parse' && args.includes('@{upstream}')) return ok('origin/main\n')
        if (args[0] === 'rev-parse') return ok('main\n')
        if (args[0] === 'rev-list') return refused('fatal: bad revision')
        return ok('')
      },
    })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    expect(h.notes).toEqual([])
  })

  it('never puts a command, a path or a branch guess in the row', async () => {
    const h = harness({ git: behindGit() })
    await h.service.ensureBeforeSession('t1', { firstTurn: true })
    await settle()
    // The row is machine-readable and the renderer writes the sentences, so
    // the one thing it must not carry is a count that can expire.
    expect(h.notes[0]).not.toMatch(/\d/)
  })
})

describe('the promise to threads that already have one', () => {
  // NFR-1, and the most important test in this change. The gate applies to what
  // gets CREATED; a thread already working in its own copy must behave exactly
  // as it did — moving work in flight is the accident this subsystem already
  // had twice.

  it('a person’s thread with a copy still reports it ready, gate or no gate', async () => {
    const h = harness({ record: thread({ worktreePath: CHECKOUT }) })
    await expect(h.service.prepare('t1', { ask: false })).resolves.toMatchObject({
      status: 'ready',
    })
    expect(h.cliCalls).toEqual([])
  })

  it('and the send path leaves it exactly alone', async () => {
    // `ensureBeforeSession` returns before `prepare` for a person's thread now.
    // The thread keeps its checkout; nothing is cut, moved or cleared.
    const record = thread({ worktreePath: CHECKOUT })
    const h = harness({ record })
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
    expect(record.worktreePath).toBe(CHECKOUT)
  })

  it('a thread with no copy is not given one, and nothing is written', async () => {
    const h = harness()
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    expect(h.written).toEqual([])
  })

  // THE BUG (tasklist, 2026-10-05). A person's thread that HAS a copy, with a
  // project attached after it was cut — a chip, the context gate on the first
  // send, an accepted offer. The send path returned before `prepare` for every
  // person's thread, so the attached project was never given its checkout and
  // the session got that project's MAIN tree beside its own isolated one.
  it('gives a newly attached project its checkout before the session starts', async () => {
    const OTHER = '/tmp/attached-later'
    const record = thread({ worktreePath: CHECKOUT })
    const h = harness({ record, attachedRoots: [OTHER] })
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    const cuts = h.cliCalls.filter((args) => args[1] === 'create')
    expect(cuts).toHaveLength(1)
    expect(cuts[0][cuts[0].indexOf('--target') + 1]).toBe(OTHER)
    expect(h.attachedWritten.map((entry) => entry.rootPath)).toEqual([OTHER])
    // The thread's own copy is untouched: nothing cut, moved or cleared for it.
    expect(h.written).toEqual([])
    expect(record.worktreePath).toBe(CHECKOUT)
  })

  it('a person’s thread with NO copy leaves its attached projects in their trees', async () => {
    // Not isolated in its own project → nothing to match in the others.
    const h = harness({ attachedRoots: ['/tmp/attached-later'] })
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    expect(h.cliCalls).toEqual([])
    expect(h.attachedWritten).toEqual([])
  })
})

describe('renameBranch', () => {
  /** A thread with a worktree on a branch of its own — the renameable case. */
  const renameable = (over: Partial<WorktreeThread> = {}): WorktreeThread =>
    thread({
      worktreePath: CHECKOUT,
      worktreeBranch: 'thread/fix-the-parser',
      worktreeBase: 'main',
      ...over,
    })

  /** Git that answers "no such branch" and "no upstream" unless told otherwise. */
  const quietGit = (args: readonly string[]): RunResult =>
    args[0] === 'rev-parse' ? { ok: false, stdout: '' } : ok('')

  it('runs no git that writes without an explicit say-so (forbidden-pattern #15)', async () => {
    const h = harness({ record: renameable(), git: quietGit })
    const result = await h.service.renameBranch('t1', 'something-else')
    expect(result.status).toBe('refused')
    expect(h.gitCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('called with nothing at all, it does nothing at all', async () => {
    const h = harness({ record: renameable(), git: quietGit })
    // The shape of the incident that wrote #15: a call an author believed inert.
    await h.service.renameBranch('t1', '')
    expect(h.gitCalls).toEqual([])
  })

  it('moves the branch to exactly the name it was given', async () => {
    const h = harness({ record: renameable(), git: quietGit })
    const result = await h.service.renameBranch('t1', 'thread/parser-take-two', { confirmed: true })
    expect(result.status).toBe('renamed')
    expect(result.branch).toBe('thread/parser-take-two')
    expect(h.gitCalls).toContainEqual(['branch', '-m', 'thread/fix-the-parser', 'thread/parser-take-two'])
    // setThreadWorktree is the only writer, and the two columns it was not
    // asked to change come back exactly as they were.
    expect(h.written).toEqual([
      { path: CHECKOUT, branch: 'thread/parser-take-two', base: 'main' },
    ])
  })

  // A DELIBERATE REVERSAL of the rule this test used to assert.
  //
  // It was called "keeps Flow's own prefix rather than letting a typed name
  // escape it", and it passed because the typed value went through
  // `threadBranchName` — which forced `thread/` and slugged the rest, so
  // `thread/already-prefixed` became `thread/thread-already-prefixed`. That
  // rule also made `feature/PF-42-fix-parser` impossible to type, which is the
  // shape people actually want, and it handed back a different name from the
  // one on screen (allowed-pattern #22).
  //
  // The prefix is still applied to names this app DERIVES — see `nameAfterTitle`
  // and the naming tests below. It is no longer applied to names it is given.
  it('gives a typed name back exactly as typed, prefix and all', async () => {
    const h = harness({ record: renameable(), git: quietGit })
    expect(
      (await h.service.renameBranch('t1', 'thread/already-prefixed', { confirmed: true })).branch,
    ).toBe('thread/already-prefixed')
    const other = harness({ record: renameable(), git: quietGit })
    expect(
      (await other.service.renameBranch('t1', 'feature/PF-42-fix-parser', { confirmed: true }))
        .branch,
    ).toBe('feature/PF-42-fix-parser')
  })

  it('refuses while a turn is in flight', async () => {
    const h = harness({ record: renameable({ status: 'working' }), git: quietGit })
    const result = await h.service.renameBranch('t1', 'later', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('working right now')
    expect(h.gitCalls).toEqual([])
  })

  // A REVERSAL, ON PURPOSE. This used to refuse a detached worktree with "it
  // gets a name when its first reply lands" — which describes every thread
  // between being created and being answered, so the person who knew what the
  // branch should be called had to wait for a generated name to correct it.
  it('names a worktree that has no branch yet, rather than refusing it', async () => {
    const h = harness({ record: renameable({ worktreeBranch: null }), git: quietGit })
    const result = await h.service.renameBranch('t1', 'feature/PF-42', { confirmed: true })
    expect(result.status).toBe('renamed')
    expect(result.branch).toBe('feature/PF-42')
    // Through the CUT'S OWN VERB (allowed-pattern #14) — a name given here and
    // one typed in the Create-thread dialog are applied identically, and
    // neither binds a remote nobody chose.
    expect(h.cliCalls.map((call) => call.slice(0, 2))).toEqual([['worktree', 'name']])
    expect(h.cliCalls[0]).toContain('feature/PF-42')
    // Never `branch -m`: there is no old ref to move.
    expect(verbs(h.gitCalls)).not.toContain('branch')
    expect(h.written.at(-1)?.branch).toBe('feature/PF-42')
  })

  it('still refuses a name a branch cannot have, named or not', async () => {
    const h = harness({ record: renameable({ worktreeBranch: null }), git: quietGit })
    const result = await h.service.renameBranch('t1', 'a name', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('isn’t a name a branch can have')
    expect(h.cliCalls).toEqual([]) // nothing was cut, named or bound
  })

  it('reports a naming that did not take, instead of claiming it did', async () => {
    const h = harness({
      record: renameable({ worktreeBranch: null }),
      git: quietGit,
      cli: (args) => (args[1] === 'name' ? { ok: false, stdout: '' } : ok('{}')),
    })
    const result = await h.service.renameBranch('t1', 'feature/PF-42', { confirmed: true })
    expect(result.status).toBe('failed')
    expect(h.written).toEqual([]) // the store still says it has no branch
  })

  it('refuses to rename a branch the thread merely borrowed', async () => {
    // The worktree TOOK its base. That branch is the person's own — renaming
    // it would rename something every other checkout and remote knows.
    const h = harness({
      record: renameable({ worktreeBranch: 'main', worktreeBase: 'main' }),
      git: quietGit,
    })
    const result = await h.service.renameBranch('t1', 'mine now', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(h.gitCalls).toEqual([])
  })

  it('refuses a name git would refuse, and nothing else', async () => {
    // The old rule refused anything that slugged to nothing — including 🎉🎉,
    // which `git check-ref-format --branch` actually ACCEPTS (verified against
    // the binary). Refusing it was the sanitizer's opinion, not git's, and a
    // typed name is only ever measured against git's.
    const bad = harness({ record: renameable(), git: quietGit })
    const refused = await bad.service.renameBranch('t1', 'fix the parser!!', { confirmed: true })
    expect(refused.status).toBe('refused')
    expect(refused.detail).toContain('isn’t a name a branch can have')
    expect(bad.gitCalls).toEqual([])

    const emoji = harness({ record: renameable(), git: quietGit })
    expect((await emoji.service.renameBranch('t1', '🎉🎉', { confirmed: true })).status).toBe(
      'renamed',
    )
  })

  // TASK 8.3 — a rename is LOCAL. It moves the branch and re-points the
  // upstream; a branch already published keeps its old remote name and says so.
  // Nothing on a server is renamed or deleted by it, and the way to prove that
  // is to assert the ABSENCE of the side effect, not just the presence of the
  // right words (allowed-pattern #24).
  it('never pushes, never calls gh, never deletes a remote branch', async () => {
    const h = harness({ record: renameable(), git: quietGit })
    const result = await h.service.renameBranch('t1', 'feature/PF-42-renamed', {
      confirmed: true,
    })
    expect(result.status).toBe('renamed')
    expect(verbs(h.gitCalls)).not.toContain('push')
    for (const call of h.gitCalls) {
      expect(call).not.toContain('--delete')
      expect(call.join(' ')).not.toMatch(/push|gh /)
    }
    // The rename goes through git alone — no CLI verb publishes anything here.
    for (const call of h.cliCalls) {
      expect(call).not.toContain('push')
      expect(call).not.toContain('pr')
    }
  })

  it('says nothing changed rather than moving a branch onto itself', async () => {
    const h = harness({ record: renameable(), git: quietGit })
    const result = await h.service.renameBranch('t1', 'thread/fix-the-parser', { confirmed: true })
    expect(result.status).toBe('unchanged')
    expect(h.gitCalls).toEqual([])
  })

  it('refuses a name something else already answers to — never a silent dedupe', async () => {
    // A rename that quietly became `-2` is a rename that did not happen.
    const h = harness({
      record: renameable(),
      git: (args) => (args[0] === 'rev-parse' ? ok('abc123\n') : ok('')),
    })
    const result = await h.service.renameBranch('t1', 'taken', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('already works under that name')
    expect(h.gitCalls.some((call) => call[0] === 'branch')).toBe(false)
  })

  it('renames a pushed branch and says the shared copy keeps the old name', async () => {
    const h = harness({
      record: renameable(),
      git: (args) => {
        if (args[0] !== 'rev-parse') return ok('')
        // The collision check misses; the upstream check hits.
        return args.includes('--verify')
          ? { ok: false, stdout: '' }
          : ok('origin/thread/fix-the-parser\n')
      },
    })
    const result = await h.service.renameBranch('t1', 'renamed', { confirmed: true })
    expect(result.status).toBe('renamed')
    expect(result.staleOnRemote).toBe(true)
    expect(result.detail).toContain('shared under its old name')
  })

  it('leaves the record alone when git refuses the move', async () => {
    const h = harness({
      record: renameable(),
      git: (args) => {
        if (args[0] === 'branch') return { ok: false, stdout: '' }
        return args[0] === 'rev-parse' ? { ok: false, stdout: '' } : ok('')
      },
    })
    const result = await h.service.renameBranch('t1', 'nope', { confirmed: true })
    expect(result.status).toBe('failed')
    expect(h.written).toEqual([])
  })

  it('refuses a thread with no branch of its own', async () => {
    const h = harness({ git: quietGit })
    const result = await h.service.renameBranch('t1', 'anything', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(h.gitCalls).toEqual([])
  })

  it('never puts a path, a command or a config key in what it says', async () => {
    const h = harness({ record: renameable(), git: quietGit })
    const details = [
      await h.service.renameBranch('t1', 'x'),
      await h.service.renameBranch('t1', '🎉', { confirmed: true }),
      await h.service.renameBranch('t1', 'renamed', { confirmed: true }),
    ].map((result) => result.detail)
    for (const detail of details) {
      expect(detail).not.toMatch(/planflow-ai|\/repo|\/Users\/|worktree|git |--/)
    }
  })
})

describe('the configured start is a DEFAULT, never a bypass (worktree_settings_ui)', () => {
  /** The `worktree create` argv, past whatever the start had to look up first. */
  function createArgs(h: Harness): string[] {
    return h.cliCalls.find((call) => call[1] === 'create') ?? []
  }

  it('uses the configured start when nobody named one', async () => {
    const h = harness({ projectRaw: { worktree_start: 'trunk' } })
    await h.service.prepare('t1', { ask: false })
    expect(createArgs(h)).toContain('--trunk')
    expect(createArgs(h)).toContain('--detach')
  })

  it('uses it for a send, which never had a screen to ask on', async () => {
    const h = harness({
      record: thread({ originLoop: 'board' }),
      projectRaw: { worktree_start: 'branch:release/2.0' },
    })
    await h.service.ensureBeforeSession('t1', { firstTurn: false })
    expect(createCall(h.cliCalls)).toContain('--base')
    expect(createCall(h.cliCalls)).toContain('release/2.0')
  })

  it('lets a start NAMED BY A PERSON win over it — the whole contract', async () => {
    // A start chosen in the picker is a decision about THIS worktree; a
    // setting that could override it would be a bypass, not a default.
    const h = harness({ projectRaw: { worktree_start: 'trunk' } })
    await h.service.prepare('t1', { ask: false, start: { kind: 'here' } })
    expect(createArgs(h)).not.toContain('--trunk')
    expect(createArgs(h)).toContain('--detach')
  })

  it('starts from the project’s BASE branch when nothing is configured', async () => {
    // THE BUILT-IN CHANGED, DELIBERATELY. It was `here` — the branch the project
    // folder happened to be on, which is usually another conversation's branch
    // or something somebody checked out to read. A thread's branch belongs to
    // that thread (user, 2026-09-17: "new thread should always start from
    // main"), and the base branch is the only start that means the same thing
    // tomorrow.
    const h = harness()
    await h.service.prepare('t1', { ask: false })
    expect(createCall(h.cliCalls)).toContain('--detach')
    expect(createCall(h.cliCalls)).toContain('--trunk')
    expect(createCall(h.cliCalls)).not.toContain('--base')
  })

  it('still honours a project that asks for `here`', async () => {
    const h = harness({ projectRaw: { worktree_start: 'here' } })
    await h.service.prepare('t1', { ask: false })
    expect(createCall(h.cliCalls)).toContain('--detach')
    expect(createCall(h.cliCalls)).not.toContain('--trunk')
  })

  it('asks about uncommitted work whatever the configured start is', async () => {
    // IT USED TO ASK ONLY FOR `here`, on the reasoning that a worktree
    // starting elsewhere could not also start from the parked work. But
    // `#carry` parks that work as a BRANCH and the worktree starts from it —
    // the answer supplies its own starting point. Gated on `here`, the default
    // moving to the base branch would have retired the question everywhere
    // without anybody deciding to.
    const dirty = (args: readonly string[]): RunResult =>
      args[0] === 'status' ? ok(' M a.ts\n') : ok('main\n')
    for (const start of ['trunk', 'here']) {
      const h = harness({ projectRaw: { worktree_start: start }, git: dirty })
      await expect(
        h.service.prepare('t1', { ask: true, requested: true }),
      ).resolves.toMatchObject({ status: 'needs-choice' })
    }
  })

  it('does NOT ask when the worktree takes an existing branch', async () => {
    // The one start with no honest "bring them": the checkout is already on a
    // branch somebody named, and it cannot also start from the parked one.
    const dirty = (args: readonly string[]): RunResult =>
      args[0] === 'status' ? ok(' M a.ts\n') : ok('main\n')
    const taken = harness({ git: dirty })
    await expect(
      taken.service.prepare('t1', {
        ask: true,
        requested: true,
        start: { kind: 'checkout', branch: 'ACME-2446' },
      }),
    ).resolves.not.toMatchObject({ status: 'needs-choice' })
  })
})

describe('the refresh settings actually reach the fetch (worktree_settings_ui)', () => {
  const tracked = (args: readonly string[]): RunResult =>
    args[0] === 'rev-parse' ? ok('abc123\n') : ok('')

  it('turned OFF means no probe, no fetch, no flag and no sentence', async () => {
    // The fetch, the flag and the sentence are one decision: keeping the
    // warning while dropping the check would mark every worktree stale forever.
    const h = harness({ projectRaw: { base_refresh: 'false' }, git: tracked })
    const result = await h.service.prepare('t1', {
      ask: false,
      start: { kind: 'branch', branch: 'main' },
    })
    expect(verbs(h.gitCalls)).not.toContain('fetch')
    expect(verbs(h.gitCalls)).not.toContain('rev-parse')
    expect(result.status).toBe('created')
    expect(result.baseMayBeBehind).toBeUndefined()
    expect(result.detail).toBeUndefined()
    expect(h.written[0]).toMatchObject({ baseMayBeBehind: false })
  })

  it('still cuts the worktree with the fetch turned off', async () => {
    const h = harness({ projectRaw: { base_refresh: 'false' } })
    await h.service.prepare('t1', { ask: false })
    expect(createCall(h.cliCalls).slice(0, 2)).toEqual(['worktree', 'create'])
    expect(createCall(h.cliCalls)).toContain('--no-fetch')
  })

  it('keeps the fetch when the switch is explicitly on', async () => {
    const h = harness({ projectRaw: { base_refresh: 'true' }, git: tracked })
    await h.service.prepare('t1', { ask: false, start: { kind: 'branch', branch: 'main' } })
    expect(verbs(h.gitCalls)).toContain('fetch')
  })

  it('gives the fetch the configured ceiling, not the built-in one', async () => {
    const h = harness({ projectRaw: { base_refresh_timeout_ms: '3000' }, git: tracked })
    await h.service.prepare('t1', { ask: false, start: { kind: 'branch', branch: 'main' } })
    const index = h.gitCalls.findIndex((call) => call[0] === 'fetch')
    expect(h.gitOptions[index]?.timeoutMs).toBe(3_000)
  })

  it('takes the ceiling the RESOLVER handed it — clamped there, not here', async () => {
    // `.flowconfig` is hand-editable, so an out-of-range wait reaches the
    // resolver having passed no validator; this consumer takes the value it is
    // given and never re-decides the bound.
    const h = harness({ projectRaw: { base_refresh_timeout_ms: '600000' }, git: tracked })
    await h.service.prepare('t1', { ask: false, start: { kind: 'branch', branch: 'main' } })
    const index = h.gitCalls.findIndex((call) => call[0] === 'fetch')
    expect(h.gitOptions[index]?.timeoutMs).toBe(30_000)
  })

  it('reads the settings ONCE per prepare, so no step can disagree with the next', async () => {
    const h = harness({ projectRaw: { worktree_start: 'trunk' }, git: tracked })
    await h.service.prepare('t1', { ask: false })
    expect(h.settingsCalls).toEqual([ROOT])
  })

  it('reads them once per retarget too', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT, worktreeBranch: 'thread/x', worktreeBase: 'main' }),
      projectRaw: { remote: 'upstream' },
      git: () => ok('ACME-2446\n'),
    })
    await h.service.retarget('t1', { kind: 'branch', branch: 'ACME-2446' })
    expect(h.settingsCalls).toEqual([ROOT])
  })

  it('does not read them at all when there is nothing to cut', async () => {
    // The two checks that can end a prepare without cutting run first; a file
    // read for a worktree nobody is going to get is work done for no reader.
    const h = harness({ projectRaw: { worktree_start: 'trunk' }, enabled: false })
    await h.service.prepare('t1', { ask: false })
    expect(h.settingsCalls).toEqual([])
  })
})

describe('reconcileBranch', () => {
  const onBranch = (branch: string | null) =>
    thread({ worktreePath: CHECKOUT, worktreeBranch: branch, worktreeBase: 'main' })

  it('corrects a record the checkout has moved out from under', async () => {
    // Found live: the record said `thread/mapping-orbit-core-data-architecture`
    // while git said `feat/data-contract-guard`, so the landing surface named
    // one branch and the panel beside it named another.
    const h = harness({
      record: onBranch('thread/mapping-orbit-core-data-architecture'),
      git: () => ok('feat/data-contract-guard\n'),
    })
    await expect(h.service.reconcileBranch('t1')).resolves.toBe('feat/data-contract-guard')
    expect(h.written.at(-1)).toEqual({
      path: CHECKOUT,
      branch: 'feat/data-contract-guard',
      base: 'main',
    })
  })

  it('writes nothing when the two already agree', async () => {
    const h = harness({ record: onBranch('thread/fix-it'), git: () => ok('thread/fix-it\n') })
    await expect(h.service.reconcileBranch('t1')).resolves.toBe('thread/fix-it')
    expect(h.written).toEqual([])
  })

  it('records a detached checkout as nameless rather than keeping the old name', async () => {
    // `branch --show-current` prints nothing when HEAD is on a commit. Empty is
    // the true answer; the old name would be exactly the drift this ends.
    const h = harness({ record: onBranch('thread/fix-it'), git: () => ok('\n') })
    await expect(h.service.reconcileBranch('t1')).resolves.toBeNull()
    expect(h.written.at(-1)?.branch).toBeNull()
  })

  it('keeps what it had when git cannot be read, rather than blanking it', async () => {
    const h = harness({ record: onBranch('thread/fix-it'), git: () => ({ ok: false, stdout: '' }) })
    await expect(h.service.reconcileBranch('t1')).resolves.toBe('thread/fix-it')
    expect(h.written).toEqual([])
  })

  it('is a no-op for a thread with no checkout, and reads no git', async () => {
    const h = harness({ record: thread({ worktreePath: null }) })
    await expect(h.service.reconcileBranch('t1')).resolves.toBeNull()
    expect(h.gitCalls).toEqual([])
  })

  it('moves nothing — one read, and it is a read', async () => {
    const h = harness({ record: onBranch('a'), git: () => ok('b\n') })
    await h.service.reconcileBranch('t1')
    expect(h.gitCalls).toEqual([['branch', '--show-current']])
  })
})

/**
 * A RECORDED CHECKOUT IS NOT THE SAME AS A PRESENT ONE (2026-09-08).
 *
 * `#prepare` answered `ready` from the database alone. When a checkout was
 * removed underneath it — by the disk cap's eviction race, by a hand-run
 * `git worktree remove`, by anything at all — every future session was still
 * pointed at that path, and the agent recreated it as an empty non-git
 * directory that `git worktree add` then refuses forever.
 */
describe('a checkout that vanished underneath the record', () => {
  it('cuts again when the recorded path is no longer a checkout', async () => {
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      checkoutPresent: () => false,
    })
    // `created`, not `ready` — this really is a fresh cut, and the thread is
    // told so exactly as it would be the first time.
    await expect(h.service.prepare('t1')).resolves.toMatchObject({ status: 'created' })
    expect(h.cliCalls.length).toBeGreaterThan(0)
  })

  it('does NOT clear the record on the way, so the remote binding survives', () => {
    // The null branch of setThreadWorktree also wipes remote / remoteBranch /
    // prBase, and prBase lives nowhere else. That is a person's answer to
    // "where does this publish to"; a directory going missing is no reason to
    // forget it.
    const h = harness({
      record: thread({ worktreePath: CHECKOUT }),
      checkoutPresent: () => false,
    })
    return h.service.prepare('t1').then(() => {
      expect(h.written.filter((entry) => entry === null)).toEqual([])
    })
  })

  it('still leaves a present checkout completely alone', async () => {
    const h = harness({ record: thread({ worktreePath: CHECKOUT }) })
    await expect(h.service.prepare('t1')).resolves.toEqual({ status: 'ready' })
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })
})


describe('a conversation\u2019s OTHER projects get checkouts too', () => {
  // THE BUG. A thread carries several projects, but only the one it started in
  // got a checkout — so the conversation was isolated in one repository and
  // writing straight into the others, and the file tree said so without anyone
  // noticing: `orbit-app (thread/…)` above a plain `orbit-core`
  // (user, 2026-09-17). Partial isolation is worse than none.
  const OTHER = '/tmp/other-project'
  const SECOND = '/tmp/second-project'

  it('cuts one for every attached project, keyed by the same thread', async () => {
    const h = harness({ attachedRoots: [OTHER] })
    await h.service.prepare('t1', { ask: false })

    const cuts = h.cliCalls.filter((args) => args[1] === 'create')
    expect(cuts.length).toBeGreaterThanOrEqual(2)
    // Same conversation, a different project each time — one identity, several
    // trees, every one of them discoverable by the listing that exists.
    for (const cut of cuts) {
      expect(cut).toContain('--thread')
      expect(cut[cut.indexOf('--thread') + 1]).toBe('t1')
    }
    expect(cuts.some((cut) => cut[cut.indexOf('--target') + 1] === OTHER)).toBe(true)
  })

  it('records the attached project\u2019s checkout against that project', async () => {
    const h = harness({ attachedRoots: [OTHER] })
    await h.service.prepareAttached('t1')
    expect(h.attachedWritten).toEqual([
      { rootPath: OTHER, worktree: { path: CHECKOUT, branch: null, base: null } },
    ])
  })

  // KEEP WHAT WORKED, SAY WHAT DID NOT. Rolling back the ones that succeeded
  // would let a single unrelated repository stop a conversation from being
  // isolated at all.
  it('keeps the projects it could isolate when one of them refuses', async () => {
    const h = harness({
      attachedRoots: [OTHER, SECOND],
      cli: (args) => {
        if (args[1] === 'create' && args[args.indexOf('--target') + 1] === OTHER) {
          return { ok: false, stdout: '', stderr: 'not a repository', error: 'not a repository' }
        }
        return ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null }))
      },
    })

    const results = await h.service.prepareAttached('t1')

    expect(results.find((r) => r.rootPath === OTHER)?.status).toBe('failed')
    expect(results.find((r) => r.rootPath === SECOND)?.status).toBe('created')
    // The one that worked is still recorded — nothing was rolled back.
    expect(h.attachedWritten.map((w) => w.rootPath)).toEqual([SECOND])
  })

  it('never cuts a second time for a project that already has one', async () => {
    const h = harness({ attachedRoots: [OTHER] })
    await h.service.prepareAttached('t1')
    const after = h.cliCalls.filter((args) => args[1] === 'create').length

    const second = await h.service.prepareAttached('t1')

    expect(second).toEqual([{ rootPath: OTHER, status: 'ready' }])
    expect(h.cliCalls.filter((args) => args[1] === 'create')).toHaveLength(after)
  })

  it('does nothing at all for a conversation carrying one project', async () => {
    // The ordinary case, unchanged: no extra cut, no extra record.
    const h = harness({})
    const results = await h.service.prepareAttached('t1')
    expect(results).toEqual([])
    expect(h.attachedWritten).toEqual([])
  })
})

// ── The two axes, told apart ────────────────────────────────────────────────
//
// A checkout of its own and the branch the work lands on used to be ONE fact,
// carried by whether this service was called at all — so "the person chose the
// project" and "nobody was asked" were the same thing to main, and a branch
// could not be named without a checkout coming with it (user, 2026-09-17: "we
// should have two dif things, one is branch, and another is worktree … we need
// to separate that concept everywhere").
describe('worktree and branch are separate answers', () => {
  it('answers "in the project" without creating anything', async () => {
    const h = harness()
    await expect(h.service.prepare('t1', { worktree: 'project' })).resolves.toEqual({
      status: 'in-project',
    })
    // The positive first: this harness DOES create when asked…
    const other = harness()
    await expect(other.service.prepare('t1', { ask: false })).resolves.toMatchObject({
      status: 'created',
    })
    // …and this one did not, for any project.
    expect(h.cliCalls).toEqual([])
    expect(h.written).toEqual([])
  })

  it('REFUSES a branch for a thread that has no checkout, by name', async () => {
    // Honouring it means checking that branch out in the project's one folder,
    // moving files nobody in this call asked to move. A contract that accepts a
    // combination its implementation would have to guess at is worse than one
    // that says no (allowed-pattern #21).
    const h = harness()
    const result = await h.service.prepare('t1', {
      worktree: 'project',
      branch: 'feature/PF-42',
    })
    expect(result.status).toBe('refused')
    expect(result.detail ?? '').toContain('branch that folder is on')
    expect(h.cliCalls).toEqual([])
  })

  it('still means `own` when nobody says — every caller before this did', async () => {
    const h = harness()
    await h.service.prepare('t1', { ask: false })
    expect(createCall(h.cliCalls)[1]).toBe('create')
  })
})

// ── Two names, carried to the CLI ───────────────────────────────────────────
describe('the folder and the branch are named separately', () => {
  const UUID = 'e2265b48-03e9-43e3-8f76-ff887a48615e'

  it('passes the folder name to the cut, and nothing when there is none', () => {
    expect(worktreeNameArgs('data-contract-guard')).toEqual([
      '--worktree-name',
      'data-contract-guard',
    ])
    // Absent is the OLD behaviour exactly — the CLI falls back to the slug, so
    // no checkout cut before this moves because it shipped.
    expect(worktreeNameArgs(undefined)).toEqual([])
    expect(worktreeNameArgs('   ')).toEqual([])
  })

  it('reads a checkout’s name back off its path rather than storing it twice', () => {
    expect(checkoutName('/repos/.orbit-app-threads/data-contract-guard')).toBe(
      'data-contract-guard',
    )
    expect(checkoutName('/repos/.orbit-app-threads/data-contract-guard/')).toBe(
      'data-contract-guard',
    )
    // A uuid directory has no NAME — which is what the upgrade migration is for.
    expect(checkoutName(`/repos/.orbit-app-threads/${UUID}`)).toBeNull()
    expect(checkoutName(null)).toBeNull()
  })

  it('gives an attached project the conversation’s branch, never the thread id', async () => {
    // THE REGRESSION: `#cutAttached` passed neither name, so the CLI fell back
    // to the thread's id and the second repository's Source Control read
    // `worktree/<uuid>` while the first read the real branch (2026-09-17).
    const h = harness({
      record: thread({
        worktreePath: '/repos/.orbit-app-threads/data-contract-guard',
        worktreeBranch: 'feat/data-contract-guard',
      }),
      attachedRoots: ['/repos/orbit-core'],
    })
    await h.service.prepareAttached('t1')
    const cut = h.cliCalls.find((call) => call[1] === 'create') ?? []
    expect(cut).toContain('--branch')
    expect(cut).toContain('feat/data-contract-guard')
    expect(cut).toContain('--worktree-name')
    expect(cut).toContain('data-contract-guard')
    expect(cut.join(' ')).not.toContain(UUID)
  })

  it('cuts an attached project DETACHED when the primary has no branch', async () => {
    // The two must not disagree about whether this conversation has a branch.
    const h = harness({
      record: thread({ worktreePath: '/repos/.orbit-app-threads/work', worktreeBranch: null }),
      attachedRoots: ['/repos/orbit-core'],
    })
    await h.service.prepareAttached('t1')
    const cut = h.cliCalls.find((call) => call[1] === 'create') ?? []
    expect(cut).toContain('--detach')
    expect(cut).not.toContain('--branch')
  })
})

/**
 * THE LINE THAT WOULD NOT COME DOWN.
 *
 * `#create` raises "Setting up this conversation's branch…" and the terminal
 * event is what lowers it. Two exits used to emit nothing: the branch that
 * refuses because the CLI's JSON could not be read back, and — covering every
 * await in the body — a THROW, which `ensureBeforeSession` catches and logs so
 * the turn survives. The turn did survive; the indicator never recovered, and
 * because the pane's reset never cleared the flag it followed the reader into
 * other conversations for the rest of the session.
 *
 * Each test states the POSITIVE first (#28): `running` really was emitted, so
 * a terminal event beside it is evidence of the edge rather than of a harness
 * that never ran the cut at all.
 */
describe('the setup indicator always gets its edge', () => {
  it('lowers the line when the cut THROWS, not just when it returns', async () => {
    const h = harness({
      cli: (args) => {
        if (args[1] === 'create') throw new Error('git exploded')
        return ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null }))
      },
    })
    await expect(h.service.prepare('t1', { ask: false })).rejects.toThrow('git exploded')
    expect(h.progress[0]).toEqual({ state: 'running' })
    expect(h.progress.at(-1)?.state).toBe('done')
  })

  it('survives the swallow in ensureBeforeSession, which is how it reaches a person', async () => {
    // The real path: the turn is worth more than the worktree, so the throw is
    // caught and logged and the conversation runs in the project tree. That is
    // correct AND it is exactly the case that used to strand the line.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // `originLoop` is what makes the cut AUTOMATIC — without it
      // `ensureBeforeSession` never reaches `prepare` and this test would pass
      // against any code at all, which is what the positive assertion below
      // exists to prove it does not.
      const h = harness({
        record: thread({ originLoop: 'nightly' }),
        cli: (args) => {
          if (args[1] === 'create') throw new Error('git exploded')
          return ok(JSON.stringify({ status: 'created', path: CHECKOUT, branch: null }))
        },
      })
      await expect(h.service.ensureBeforeSession('t1', { firstTurn: true })).resolves.toBeUndefined()
      expect(h.progress[0]).toEqual({ state: 'running' })
      expect(h.progress.at(-1)?.state).toBe('done')
    } finally {
      warn.mockRestore()
    }
  })

  it('lowers the line when the CLI result cannot be read back', async () => {
    // The branch beside `!result.ok`, which emitted by hand and so was fine,
    // while this one returned a refusal with no edge at all.
    const h = harness({ cli: (args) => (args[1] === 'create' ? ok('not json at all') : ok('')) })
    const result = await h.service.prepare('t1', { ask: false })
    expect(result.status).toBe('refused')
    expect(h.progress[0]).toEqual({ state: 'running' })
    expect(h.progress.at(-1)?.state).toBe('done')
  })

  it('still lowers it when the CLI refuses outright', async () => {
    const h = harness({
      cli: (args) =>
        args[1] === 'create' ? { ok: false, stdout: '', stderr: '', error: 'refused' } : ok(''),
    })
    const result = await h.service.prepare('t1', { ask: false })
    expect(result.status).toBe('refused')
    expect(h.progress.at(-1)?.state).toBe('done')
  })

  it('raises the line exactly once per cut, and lowers it exactly once', async () => {
    // A doubled edge is its own bug: the pane would flicker, and a `failed`
    // followed by a stray `done` would drop a card the person needed.
    const h = harness({ projectRaw: { worktree_setup: 'npm ci' }, setup: () => ok('') })
    await h.service.prepare('t1', { ask: false })
    expect(h.progress.filter((event) => event.state === 'running')).toHaveLength(1)
    expect(h.progress.filter((event) => event.state !== 'running')).toHaveLength(1)
  })
})
