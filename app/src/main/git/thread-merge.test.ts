import {
  ThreadLandingService,
  countLandingChanges,
  firstUrl,
  landingMessageSuggestion,
  landingRef,
  looksConflicted,
  pullRequestBody,
  repoDisplayName,
  worksOnBase,
  type LandingTarget,
  type LandingThread,
} from './thread-merge'
import type { RunResult } from '../worktree/thread-worktree'
import { resolveWorktreeSettings } from '../flow/worktree-settings'
import { checkoutName } from '../../shared/worktree-name'

const PROJECT = '/repo'
const CHECKOUT = '/repo/.repo-threads/t1'

function thread(overrides: Partial<LandingThread> = {}): LandingThread {
  return {
    id: 't1',
    title: 'Add the landing bar',
    projectRoot: PROJECT,
    worktreePath: CHECKOUT,
    worktreeBranch: 'thread/add-the-landing-bar',
    worktreeBase: 'main',
    ...overrides,
  }
}

function ok(stdout = ''): RunResult {
  return { ok: true, stdout }
}

function fail(stderr = ''): RunResult {
  return { ok: false, stdout: '', stderr }
}

interface Harness {
  service: ThreadLandingService
  git: string[][]
  cli: string[][]
  gh: string[][]
  written: Array<unknown>
  /** Everything mirrored through `setThreadBinding`, in order. */
  bound: Array<unknown>
  record: LandingThread
  /** Every root `settingsFor` was asked about — one read per landing. */
  settingsCalls: string[]
}

/**
 * The verbs answering as they do when everything is bound and nothing refuses.
 *
 * These shapes are the CLI's, not this file's invention — `worktree push` and
 * `worktree pr` print exactly one line of JSON under `--json`.
 */
function defaultCli(args: readonly string[]): RunResult {
  if (args[0] === 'worktree' && args[1] === 'push') {
    return ok(
      '{"status":"pushed","thread":"t1","branch":"thread/add-the-landing-bar","remote":"origin","remoteBranch":"feature/PF-42","pushed":true}',
    )
  }
  if (args[0] === 'worktree' && args[1] === 'pr') {
    return ok(
      '{"status":"opened","thread":"t1","remote":"origin","remoteBranch":"feature/PF-42","base":"main","url":"https://github.test/pr/7"}',
    )
  }
  return ok('{"status":"pruned"}')
}

/** The refusal a push answers with when nobody has said where the work goes. */
const UNBOUND_PAYLOAD =
  '{"refused":"unbound","suggestion":"feature/PF-42","source":"ticket","remote":"origin","remotes":["origin","upstream"],"base":"main"}'

/** The same refusal from a bundled CLI old enough not to name a usual remote. */
const UNBOUND_PAYLOAD_NO_REMOTE =
  '{"refused":"unbound","suggestion":"feature/PF-42","source":"ticket","remotes":["origin","upstream"],"base":"main"}'

/** A git fake keyed on the argv the service actually sends. */
type GitAnswer = (cwd: string, args: readonly string[]) => RunResult | undefined

function harness(
  options: {
    record?: LandingThread
    git?: GitAnswer
    cli?: (args: readonly string[]) => RunResult
    gh?: (args: readonly string[]) => RunResult
    withGh?: boolean
    targets?: LandingTarget[]
    suggest?: (root: string, files: string[]) => Promise<string | null>
    /**
     * The project's own `.flowconfig` keys, resolved as production resolves
     * them. Absent → no reader wired in, which is the built-ins.
     */
    projectRaw?: Record<string, string>
    /** W-3: stand the thread's agent down, or say why the copy must stay. */
    standDownAgent?: (
      threadId: string,
      force?: boolean,
    ) => { ok: true } | { ok: false; detail: string }
  } = {},
): Harness {
  const record = options.record ?? thread()
  const git: string[][] = []
  const cli: string[][] = []
  const gh: string[][] = []
  const written: unknown[] = []
  const bound: unknown[] = []
  const settingsCalls: string[] = []
  const service = new ThreadLandingService({
    threadStore: {
      getThread: (id) => (id === record.id ? record : null),
      setThreadBinding: (_id, binding) => {
        bound.push(binding)
      },
      setThreadWorktree: (_id, worktree) => {
        written.push(worktree)
        if (worktree === null) {
          record.worktreePath = null
          record.worktreeBranch = null
          record.worktreeBase = null
        }
      },
    },
    runGit: (cwd, args) => {
      git.push([...args])
      return Promise.resolve(options.git?.(cwd, args) ?? defaultGit(args))
    },
    runCli: (_cwd, args) => {
      cli.push([...args])
      return Promise.resolve(options.cli?.(args) ?? defaultCli(args))
    },
    ...(options.withGh === false
      ? {}
      : {
          runGh: (_cwd, args) => {
            gh.push([...args])
            return Promise.resolve(options.gh?.(args) ?? ok('https://github.test/pr/7\n'))
          },
        }),
    ...(options.standDownAgent === undefined
      ? {}
      : { standDownAgent: options.standDownAgent }),
    ...(options.projectRaw === undefined
      ? {}
      : {
          settingsFor: async (rootPath: string) => {
            settingsCalls.push(rootPath)
            return resolveWorktreeSettings({
              projectRaw: options.projectRaw ?? {},
              globalDefaults: {},
            })
          },
        }),
    ...(options.targets === undefined ? {} : { targetsFor: () => options.targets ?? [] }),
    ...(options.suggest === undefined ? {} : { suggestMessage: options.suggest }),
  })
  return { service, git, cli, gh, written, bound, record, settingsCalls }
}

/** The everything-is-fine repository. */
function defaultGit(args: readonly string[]): RunResult {
  if (args[0] === 'status') return ok(' M src/app.ts\n?? src/new.ts\n')
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('main\n')
  if (args[0] === 'rev-parse' && args[1] === '--short') return ok('abc1234\n')
  if (args[0] === 'rev-parse' && args[1] === '--verify') return ok('deadbeef\n')
  if (args[0] === 'rev-parse') return ok('deadbeefdeadbeef\n')
  if (args[0] === 'rev-list') return ok('2\n')
  return ok()
}

function calls(git: string[][], verb: string): string[][] {
  return git.filter((args) => args[0] === verb)
}

describe('landing message suggestion', () => {
  it('starts from the thread title', () => {
    expect(landingMessageSuggestion('Add the landing bar', 3)).toBe('Add the landing bar')
  })

  it('says how much is waiting when the thread has no title', () => {
    expect(landingMessageSuggestion(null, 1)).toBe('Work from this thread (1 file)')
    expect(landingMessageSuggestion('  ', 4)).toBe('Work from this thread (4 files)')
  })

  it('cuts a subject that would run past a readable line', () => {
    const suggestion = landingMessageSuggestion('x'.repeat(200), 2)
    expect(suggestion.length).toBeLessThanOrEqual(72)
    expect(suggestion.endsWith('…')).toBe(true)
  })
})

describe('reading git output', () => {
  it('counts everything uncommitted, untracked files included', () => {
    // The other end of a thread's life counts TRACKED files only, because
    // nothing the dirty-tree offer does touches an untracked one. A landing
    // commits what the agent wrote, so it counts what the agent wrote.
    expect(countLandingChanges(' M a.ts\n?? b.ts\n')).toBe(2)
  })

  it('tells a conflict apart from a plain failure', () => {
    expect(looksConflicted('UU src/app.ts\n')).toBe(true)
    expect(looksConflicted('AA a\nUD b\n')).toBe(true)
    expect(looksConflicted(' M src/app.ts\n?? new.ts\n')).toBe(false)
    expect(looksConflicted('')).toBe(false)
  })

  it('merges from the branch when there is one, and the commit when there is not', () => {
    expect(landingRef('thread/x', 'deadbeef')).toBe('thread/x')
    expect(landingRef(null, 'deadbeef')).toBe('deadbeef')
    expect(landingRef('', 'deadbeef')).toBe('deadbeef')
  })

  it('reads the pull request url off gh output', () => {
    expect(firstUrl('Creating pull request\nhttps://github.test/pr/7\n')).toBe(
      'https://github.test/pr/7',
    )
    expect(firstUrl('nothing here')).toBeNull()
  })

  it('names a repository the way a person sees it named', () => {
    expect(repoDisplayName('/Users/me/Projects/plan-flow')).toBe('plan-flow')
    expect(repoDisplayName('/Users/me/Projects/plan-flow/')).toBe('plan-flow')
  })

  it('says where a pull request came from', () => {
    expect(pullRequestBody('Add the bar')).toContain('Add the bar')
    expect(pullRequestBody(null)).toBe('Opened from a Flow thread.')
  })
})

describe('nothing irreversible by default (forbidden-pattern #15)', () => {
  it('runs no git at all when nobody asked for the landing', async () => {
    const h = harness()
    const result = await h.service.land('t1')
    expect(result.complete).toBe(false)
    expect(result.rows[0]?.outcome).toBe('blocked')
    expect(h.git).toEqual([])
    expect(h.cli).toEqual([])
  })

  it('refuses to release a checkout nobody asked to release', async () => {
    const h = harness()
    const result = await h.service.prune('t1')
    expect(result.status).toBe('refused')
    expect(h.cli).toEqual([])
    expect(h.written).toEqual([])
  })

  it('never commits under a message nobody chose', async () => {
    const h = harness()
    const result = await h.service.land('t1', { mode: 'merge', confirmed: true })
    expect(result.rows[0]?.outcome).toBe('needs-message')
    expect(calls(h.git, 'commit')).toEqual([])
    expect(calls(h.git, 'merge')).toEqual([])
  })

  it('leaves the checkout in place unless the landing was told to release it', async () => {
    const h = harness()
    await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'Land it' })
    expect(h.cli).toEqual([])
    expect(h.written).toEqual([])
  })
})

describe('mergePullRequest — the Review card’s Merge button', () => {
  it('runs no gh and does not merge when nobody asked for it (forbidden-pattern #15)', async () => {
    const h = harness()
    const result = await h.service.mergePullRequest('t1', { prUrl: 'https://github.test/pr/7' })
    expect(result.ok).toBe(false)
    expect(h.gh).toEqual([])
    expect(calls(h.git, 'merge')).toEqual([])
  })

  it('squash-merges the pull request on GitHub when there is one', async () => {
    const h = harness()
    const result = await h.service.mergePullRequest('t1', {
      prUrl: 'https://github.test/pr/7',
      confirmed: true,
    })
    expect(result).toEqual({
      ok: true,
      detail: 'The pull request is merged.',
      method: 'github-squash',
    })
    expect(h.gh).toEqual([['pr', 'merge', 'https://github.test/pr/7', '--squash']])
    // GITHUB MERGED IT — no local merge ran.
    expect(calls(h.git, 'merge')).toEqual([])
  })

  it('reports a GitHub failure rather than silently merging locally instead', async () => {
    const h = harness({ gh: () => fail('checks pending') })
    const result = await h.service.mergePullRequest('t1', {
      prUrl: 'https://github.test/pr/7',
      confirmed: true,
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('GitHub')
    expect(calls(h.git, 'merge')).toEqual([])
  })

  it('falls back to the local base merge when there is no gh on the machine', async () => {
    const h = harness({ withGh: false })
    const result = await h.service.mergePullRequest('t1', {
      prUrl: 'https://github.test/pr/7',
      confirmed: true,
    })
    expect(result).toMatchObject({ ok: true, method: 'local' })
    // The same local merge `land` runs — the base merged into the thread's branch.
    expect(calls(h.git, 'merge')[0]).toEqual(['merge', '--no-edit', 'main'])
  })

  it('falls back to the local base merge when the card carries no PR', async () => {
    const h = harness()
    const result = await h.service.mergePullRequest('t1', { prUrl: null, confirmed: true })
    expect(result).toMatchObject({ ok: true, method: 'local' })
    expect(h.gh).toEqual([])
    expect(calls(h.git, 'merge')[0]).toEqual(['merge', '--no-edit', 'main'])
  })
})

describe('merge: commit, then merge', () => {
  it('commits what is loose under the given message, then merges the base in', async () => {
    const h = harness()
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Add the landing bar',
    })
    expect(result.rows[0]).toMatchObject({ outcome: 'landed', committed: 2, commit: 'abc1234' })
    expect(calls(h.git, 'add')[0]).toEqual(['add', '--all'])
    expect(calls(h.git, 'commit')[0]).toEqual([
      'commit',
      '--cleanup=strip',
      '-m',
      'Add the landing bar',
    ])
    // The base is merged INTO the thread's branch, inside the thread's checkout.
    expect(calls(h.git, 'merge')[0]).toEqual(['merge', '--no-edit', 'main'])
  })

  it('never checks out a branch in the project’s shared tree', async () => {
    const h = harness()
    await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'Land it' })
    expect(h.git.some((args) => args[0] === 'checkout' || args[0] === 'switch')).toBe(false)
  })

  it('fast-forwards the project when it is sitting on the base branch', async () => {
    const h = harness()
    await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'Land it' })
    const forward = calls(h.git, 'merge').find((args) => args[1] === '--ff-only')
    expect(forward).toEqual(['merge', '--ff-only', 'thread/add-the-landing-bar'])
    expect(calls(h.git, 'branch')).toEqual([])
  })

  it('moves the ref directly when the project is on some other branch', async () => {
    const h = harness({
      git: (_cwd, args) =>
        args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? ok('other\n') : undefined,
    })
    await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'Land it' })
    expect(calls(h.git, 'branch')[0]).toEqual([
      'branch',
      '--force',
      'main',
      'deadbeefdeadbeef',
    ])
  })

  it('reports a blocked landing when the project’s own tree is in the way', async () => {
    const h = harness({
      git: (_cwd, args) =>
        args[0] === 'merge' && args[1] === '--ff-only' ? fail('local changes') : undefined,
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('blocked')
    expect(result.rows[0]?.detail).toContain('unsaved changes')
  })

  it('never moves the base ref onto a commit that does not contain it', async () => {
    const h = harness({
      git: (_cwd, args) =>
        args[0] === 'merge-base' ? fail('not an ancestor') : undefined,
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('blocked')
    expect(calls(h.git, 'branch')).toEqual([])
  })

  it('hands a conflict to the merge editor, in the thread’s own checkout', async () => {
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'merge') return fail('CONFLICT')
        if (args[0] === 'status') return ok('UU src/app.ts\n')
        return undefined
      },
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]).toMatchObject({ outcome: 'conflicted', conflictRoot: CHECKOUT })
    expect(calls(h.git, 'branch')).toEqual([])
  })

  it('tells a real merge failure apart from a conflict', async () => {
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'merge') return fail('not something we can merge')
        if (args[0] === 'status') return ok(' M src/app.ts\n')
        return undefined
      },
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('failed')
  })

  it('says so when it does not know where the work belongs', async () => {
    const h = harness({ record: thread({ worktreeBase: null }) })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('no-base')
    expect(calls(h.git, 'commit')).toEqual([])
  })

  it('lands a checkout whose work is already committed, with nothing loose', async () => {
    const h = harness({ git: (_cwd, args) => (args[0] === 'status' ? ok('') : undefined) })
    const result = await h.service.land('t1', { mode: 'merge', confirmed: true })
    expect(result.rows[0]?.outcome).toBe('landed')
    expect(calls(h.git, 'commit')).toEqual([])
  })

  it('releases the checkout only when the landing was told to', async () => {
    // A landed checkout is clean and level with its base — which is exactly
    // what the release check re-reads before deleting anything.
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-list') return ok('0\n')
        return undefined
      },
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      pruneAfter: true,
    })
    expect(result.rows[0]?.pruned).toBe(true)
    // `--worktree-name` rides along so the verb can FIND a named folder — the
    // CLI otherwise rebuilds the path from the thread id and answers `absent`,
    // which reads as success and leaves the directory on disk (2026-09-18).
    expect(h.cli[0]).toEqual([
      'worktree',
      'prune',
      '--thread',
      't1',
      '--worktree-name',
      checkoutName(CHECKOUT),
      '--json',
      '--target',
      PROJECT,
    ])
    expect(h.written).toEqual([null])
  })
})

describe('a base that lives only on this computer', () => {
  // BOUND, because "local only" is a question about a REMOTE: an unbound thread
  // has none to ask about, and the push verb is what refuses that case with the
  // question attached rather than with a verdict about the base.
  const wip = thread({
    worktreeBase: 'wip/20260821-101500',
    remote: 'origin',
    remoteBranch: 'feature/PF-42',
  })

  it('merges to it like any other branch', async () => {
    const h = harness({
      record: wip,
      git: (_cwd, args) =>
        args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? ok('other\n') : undefined,
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('landed')
    expect(calls(h.git, 'merge')[0]).toEqual(['merge', '--no-edit', 'wip/20260821-101500'])
  })

  it('refuses a pull request against it, before pushing anything', async () => {
    const h = harness({
      record: wip,
      git: (_cwd, args) =>
        args[0] === 'rev-parse' && args[1] === '--verify' ? fail() : undefined,
    })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('local-only')
    expect(calls(h.git, 'push')).toEqual([])
    expect(h.cli).toEqual([])
  })
})

describe('pull request', () => {
  /** A thread somebody has already said where to publish. */
  const bound = (over: Partial<LandingThread> = {}): LandingThread =>
    thread({ remote: 'origin', remoteBranch: 'feature/PF-42', prBase: 'main', ...over })

  it('commits, then publishes and proposes through the verbs — no raw git, no gh', async () => {
    const h = harness({ record: bound() })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Add the landing bar',
    })
    expect(result.rows[0]).toMatchObject({
      outcome: 'opened',
      url: 'https://github.test/pr/7',
    })
    // THE ONE WRITER (allowed-pattern #14). A raw `git push` or a `gh pr
    // create` here would be a second code path deciding where work lands.
    expect(calls(h.git, 'push')).toEqual([])
    expect(h.gh).toEqual([])
    expect(h.cli[0]).toEqual([
      'worktree',
      'push',
      '--target',
      PROJECT,
      '--thread',
      't1',
      '--pr-base',
      'main',
      '--thread-title',
      'Add the landing bar',
      // THE OFFER, NOT A DESTINATION. The resolved remote travels with every
      // call so an unbound refusal can propose it; nothing here binds anything.
      '--default-remote',
      'origin',
      '--json',
    ])
    expect(h.cli[1]?.slice(0, 6)).toEqual([
      'worktree',
      'pr',
      '--target',
      PROJECT,
      '--thread',
      't1',
    ])
  })

  it('mirrors what the verb published as, not what was asked for', async () => {
    const h = harness({ record: bound({ remoteBranch: 'feature/stale-mirror' }) })
    await h.service.land('t1', { mode: 'pull-request', confirmed: true, message: 'x' })
    expect(h.bound[0]).toMatchObject({ remote: 'origin', remoteBranch: 'feature/PF-42' })
  })

  it('asks instead of guessing when nobody has said where the work goes', async () => {
    const h = harness({
      cli: (args) =>
        args[1] === 'push' ? { ok: false, stdout: `${UNBOUND_PAYLOAD}\n`, stderr: '' } : defaultCli(args),
    })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('unbound')
    expect(result.rows[0]?.binding).toEqual({
      suggestion: 'feature/PF-42',
      source: 'ticket',
      // The project's usual remote rides along so the ask arrives with the
      // ordinary answer selected — a person still confirms it.
      remote: 'origin',
      remotes: ['origin', 'upstream'],
      base: 'main',
    })
    // Nothing was proposed, and nothing was mirrored from a refusal.
    expect(h.cli.some((args) => args[1] === 'pr')).toBe(false)
    expect(h.bound).toEqual([])
  })

  it('reads a refusal that names no usual remote as a question with nothing pre-selected', async () => {
    // A bundled CLI old enough not to send the field is still asking the same
    // question — absent is null, never a failure to read the refusal at all.
    const h = harness({
      cli: (args) =>
        args[1] === 'push'
          ? { ok: false, stdout: `${UNBOUND_PAYLOAD_NO_REMOTE}\n`, stderr: '' }
          : defaultCli(args),
    })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('unbound')
    expect(result.rows[0]?.binding).toMatchObject({ remote: null, remotes: ['origin', 'upstream'] })
  })

  it('treats a refusal it cannot read as a failure, never as a proposal', async () => {
    const h = harness({
      cli: (args) => (args[1] === 'push' ? fail('worktree refused: stale — ...') : defaultCli(args)),
    })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('failed')
    expect(result.rows[0]?.binding).toBeUndefined()
  })

  it('has nothing to propose while the checkout is still unnamed', async () => {
    const h = harness({ record: bound({ worktreeBranch: null }) })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('no-branch')
    expect(h.cli).toEqual([])
  })

  it('says so rather than half-opening one when the pull request is refused', async () => {
    const h = harness({
      record: bound(),
      cli: (args) => (args[1] === 'pr' ? fail('protected branch') : defaultCli(args)),
    })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('failed')
    expect(result.rows[0]?.detail).not.toContain('gh ')
  })

  it('asks about the base on the BOUND remote, not on a constant', async () => {
    const looked: string[] = []
    const h = harness({
      record: bound({ remote: 'upstream' }),
      git: (_cwd, args) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          looked.push(args[3] ?? '')
          return ok('deadbeef\n')
        }
        return undefined
      },
    })
    await h.service.land('t1', { mode: 'pull-request', confirmed: true, message: 'x' })
    expect(looked).toContain('refs/remotes/upstream/main')
    expect(looked).not.toContain('refs/remotes/origin/main')
  })
})

describe('the argv the landing sends — the contract, element for element', () => {
  /** A thread somebody has already said where to publish. */
  const bound = (over: Partial<LandingThread> = {}): LandingThread =>
    thread({ remote: 'origin', remoteBranch: 'feature/PF-42', prBase: 'main', ...over })

  const propose = (h: Harness): Promise<unknown> =>
    h.service.land('t1', { mode: 'pull-request', confirmed: true, message: 'Add the landing bar' })

  it('publishes with exactly the arguments `worktree push` is documented to take', async () => {
    const h = harness({ record: bound() })
    await propose(h)
    expect(h.cli[0]).toEqual([
      'worktree',
      'push',
      '--target',
      PROJECT,
      '--thread',
      't1',
      '--pr-base',
      'main',
      // A SOURCE FOR THE SUGGESTION ONLY. The ladder's second rung reads a
      // ticket id out of the title; it reaches nothing that writes.
      '--thread-title',
      'Add the landing bar',
      // THE OFFER, NOT A DESTINATION. The resolved remote travels with every
      // call so an unbound refusal can propose it; nothing here binds anything.
      '--default-remote',
      'origin',
      '--json',
    ])
  })

  it('proposes with exactly the arguments `worktree pr` is documented to take', async () => {
    const h = harness({ record: bound() })
    await propose(h)
    expect(h.cli[1]).toEqual([
      'worktree',
      'pr',
      '--target',
      PROJECT,
      '--thread',
      't1',
      '--title',
      'Add the landing bar',
      '--body',
      'Opened from a Flow thread: Add the landing bar',
      '--pr-base',
      'main',
      '--default-remote',
      'origin',
      '--json',
    ])
  })

  it('titles the request with what the commit was actually landed under', async () => {
    // Two files were committed, so the untitled thread's suggestion counts them
    // — the same sentence the person saw on the landing surface.
    const h = harness({ record: bound({ title: '' }) })
    await propose(h)
    expect(h.cli[1]?.[7]).toBe('Work from this thread (2 files)')
    expect(h.cli[1]?.[9]).toBe('Opened from a Flow thread.')
  })

  it('opens against the base a person chose, in both verbs', async () => {
    // `prBase` is not the merge base. A thread cut from `main` whose owner said
    // the request goes to `develop` proposes to `develop`, and nothing here
    // quietly substitutes the other one.
    const h = harness({ record: bound({ worktreeBase: 'main', prBase: 'develop' }) })
    await propose(h)
    const prBaseOf = (args: string[]): string | undefined => args[args.indexOf('--pr-base') + 1]
    expect(prBaseOf(h.cli[0] ?? [])).toBe('develop')
    expect(prBaseOf(h.cli[1] ?? [])).toBe('develop')
  })

  it('opens against what the work was cut from when nobody chose one', async () => {
    // NEVER A CONSTANT: `main` here would be a guess targeting a branch nobody
    // picked — the same mistake as an unbound push, one level up.
    const h = harness({ record: bound({ worktreeBase: 'develop', prBase: null }) })
    await propose(h)
    expect(h.cli[0]).toContain('--pr-base')
    expect(h.cli[0]?.[h.cli[0]?.indexOf('--pr-base') + 1]).toBe('develop')
    expect(h.cli[1]?.[h.cli[1]?.indexOf('--pr-base') + 1]).toBe('develop')
  })

  it('never runs a raw `git push`, and never reaches for `gh` itself', async () => {
    // THE ONE WRITER (allowed-pattern #14). This file used to send the local
    // branch name verbatim to a hardcoded `origin` and shell out to `gh pr
    // create`; a second code path deciding where work lands is the whole thing
    // the verbs replaced. Every mode, including the ones that fail.
    const runs: string[][] = []
    for (const record of [bound(), bound({ remote: null, remoteBranch: null })]) {
      for (const mode of ['merge', 'pull-request'] as const) {
        const h = harness({ record })
        await h.service.land('t1', { mode, confirmed: true, message: 'Land it' })
        await h.service.preview('t1')
        runs.push(...h.git, ...h.gh)
      }
    }
    expect(runs.some((args) => args[0] === 'push')).toBe(false)
    expect(runs.some((args) => args[0] === 'pr' || args[1] === 'pr')).toBe(false)
    expect(runs.some((args) => args.includes('--set-upstream') || args.includes('-u'))).toBe(false)
  })

  it('leaves merging exactly as it was — no verb, no remote, no base of its own', async () => {
    // The feature is about where work is PUBLISHED. Merging a thread's branch
    // into the branch it was cut from never leaves this computer, and gained
    // nothing it has to ask a person about.
    const h = harness({ record: bound({ prBase: 'develop' }) })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]).toMatchObject({ outcome: 'landed', committed: 2 })
    expect(calls(h.git, 'merge')[0]).toEqual(['merge', '--no-edit', 'main'])
    expect(h.cli).toEqual([])
    expect(h.gh).toEqual([])
    expect(h.bound).toEqual([])
  })

  it('hands the unbound question back with the work it already committed', async () => {
    const h = harness({
      cli: (args) =>
        args[1] === 'push' ? { ok: false, stdout: `${UNBOUND_PAYLOAD}\n`, stderr: '' } : defaultCli(args),
    })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    // The commit HAPPENED — the refusal is about where it goes, not whether it
    // exists — so the row carries it, and the question, back to the caller.
    expect(result.rows[0]).toMatchObject({
      outcome: 'unbound',
      branch: 'thread/add-the-landing-bar',
      committed: 2,
      commit: 'abc1234',
      binding: {
        suggestion: 'feature/PF-42',
        source: 'ticket',
        remote: 'origin',
        remotes: ['origin', 'upstream'],
        base: 'main',
      },
    })
  })

  it('carries the same question back when it is the pr verb that refuses', async () => {
    const h = harness({
      record: bound(),
      cli: (args) =>
        args[1] === 'pr' ? { ok: false, stdout: `${UNBOUND_PAYLOAD}\n`, stderr: '' } : defaultCli(args),
    })
    const result = await h.service.land('t1', {
      mode: 'pull-request',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows[0]?.outcome).toBe('unbound')
    expect(result.rows[0]?.binding).toMatchObject({ suggestion: 'feature/PF-42' })
  })
})

describe('more than one repository', () => {
  const two: LandingTarget[] = [
    {
      name: 'app',
      projectRoot: '/repo/app',
      worktreePath: '/repo/app/.app-threads/t1',
      branch: 'thread/x',
      base: 'main',
    },
    {
      name: 'core',
      projectRoot: '/repo/core',
      worktreePath: '/repo/core/.core-threads/t1',
      branch: 'thread/x',
      base: 'main',
    },
  ]

  it('lands them one after another, each reporting its own outcome', async () => {
    const h = harness({
      targets: two,
      git: (cwd, args) => {
        if (cwd.includes('/core/') && args[0] === 'merge') return fail('CONFLICT')
        if (cwd.includes('/core/') && args[0] === 'status') return ok('UU core/a.ts\n')
        return undefined
      },
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows.map((row) => [row.name, row.outcome])).toEqual([
      ['app', 'landed'],
      ['core', 'conflicted'],
    ])
    // NO ATOMICITY: the first repository's merge is not undone because the
    // second one stopped. Undoing a merge that worked was the rejected option.
    expect(result.complete).toBe(false)
  })

  it('keeps going past a failure rather than abandoning the rest', async () => {
    const h = harness({
      targets: two,
      git: (cwd, args) => (cwd.includes('/app/') && args[0] === 'merge' ? fail('bad ref') : undefined),
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    expect(result.rows.map((row) => row.outcome)).toEqual(['failed', 'landed'])
  })

  // The landing controls sit inside the repository group they act on
  // (landing-per-project). The button therefore says WHICH repository it is,
  // and this is where that stops being a claim on screen and starts being true.
  describe('landing the one repository the pressed control belongs to', () => {
    it('touches that repository and leaves the other alone', async () => {
      const h = harness({ targets: two })
      const result = await h.service.land('t1', {
        mode: 'merge',
        confirmed: true,
        message: 'Land it',
        projectRoot: '/repo/core',
      })
      expect(result.rows.map((row) => row.name)).toEqual(['core'])
      expect(result.complete).toBe(true)
      // Nothing that writes ran anywhere near the other repository.
      const wrote = ['add', 'commit', 'merge', 'branch', 'push']
      expect(h.git.filter((args) => wrote.includes(args[0] ?? ''))).not.toEqual([])
    })

    it('lands everything when the caller names no repository — the old meaning', async () => {
      const h = harness({ targets: two })
      const result = await h.service.land('t1', {
        mode: 'merge',
        confirmed: true,
        message: 'Land it',
      })
      expect(result.rows.map((row) => row.name)).toEqual(['app', 'core'])
    })

    it('narrows and never widens: an unknown repository lands nothing', async () => {
      const h = harness({ targets: two })
      const result = await h.service.land('t1', {
        mode: 'merge',
        confirmed: true,
        message: 'Land it',
        projectRoot: '/repo/elsewhere',
      })
      expect(result.complete).toBe(false)
      expect(result.rows.map((row) => row.outcome)).toEqual(['blocked'])
      // It says so in a sentence, and never in a path (forbidden-pattern #12).
      expect(result.rows[0]?.detail).not.toContain('/')
      const wrote = ['add', 'commit', 'merge', 'branch', 'push']
      expect(h.git.filter((args) => wrote.includes(args[0] ?? ''))).toEqual([])
    })
  })
})

describe('preview', () => {
  it('reads what is waiting without writing anything', async () => {
    const h = harness()
    const preview = await h.service.preview('t1')
    expect(preview.repos[0]).toMatchObject({
      name: 'repo',
      changedFiles: 2,
      aheadCommits: 2,
      base: 'main',
      baseOnRemote: true,
    })
    expect(preview.blockedReason).toBeNull()
    const writes = h.git.filter((args) =>
      ['add', 'commit', 'merge', 'branch', 'push'].includes(args[0] ?? ''),
    )
    expect(writes).toEqual([])
  })

  it('offers the message for editing before anything is committed', async () => {
    const h = harness()
    const preview = await h.service.preview('t1')
    expect(preview.message).toBe('Add the landing bar')
  })

  it('prefers the suggestion the commit box would make', async () => {
    const h = harness({ suggest: () => Promise.resolve('feat(landing): add the bar') })
    const preview = await h.service.preview('t1')
    expect(preview.message).toBe('feat(landing): add the bar')
  })

  it('falls back to the plain message when the suggestion fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const h = harness({ suggest: () => Promise.reject(new Error('no model')) })
    const preview = await h.service.preview('t1')
    expect(preview.message).toBe('Add the landing bar')
    warn.mockRestore()
  })

  it('says there is nothing to land when the thread changed nothing', async () => {
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-list') return ok('0\n')
        return undefined
      },
    })
    const preview = await h.service.preview('t1')
    expect(preview.blockedReason).toContain('nothing to land')
  })

  it('offers no pull request for a bound thread whose base is local only', async () => {
    const h = harness({
      record: thread({ remote: 'origin', remoteBranch: 'feature/PF-42' }),
      git: (_cwd, args) => (args[0] === 'rev-parse' && args[1] === '--verify' ? fail() : undefined),
    })
    const preview = await h.service.preview('t1')
    expect(preview.canOpenPullRequest).toBe(false)
  })

  it('offers no pull request when gh is not reachable', async () => {
    const h = harness({ withGh: false })
    const preview = await h.service.preview('t1')
    expect(preview.canOpenPullRequest).toBe(false)
  })

  it('says a chat-only thread has nothing separate to land', async () => {
    const h = harness({ record: thread({ worktreePath: null }) })
    const preview = await h.service.preview('t1')
    expect(preview.repos).toEqual([])
    expect(preview.blockedReason).toContain('nothing separate to land')
  })
})

describe('releasing the checkout, keeping the branch', () => {
  it('removes the checkout and forgets it', async () => {
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-list') return ok('0\n')
        return undefined
      },
    })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('pruned')
    // The branch is never named to git here — only the CLI removes anything,
    // and it leaves the branch alone.
    // `--worktree-name` rides along so the verb can FIND a named folder — the
    // CLI otherwise rebuilds the path from the thread id and answers `absent`,
    // which reads as success and leaves the directory on disk (2026-09-18).
    expect(h.cli[0]).toEqual([
      'worktree',
      'prune',
      '--thread',
      't1',
      '--worktree-name',
      checkoutName(CHECKOUT),
      '--json',
      '--target',
      PROJECT,
    ])
    expect(h.git.some((args) => args[0] === 'branch' && args.includes('-D'))).toBe(false)
    expect(h.written).toEqual([null])
  })

  it('leaves a checkout that still holds uncommitted work', async () => {
    const h = harness()
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('holds-work')
    expect(result.changedFiles).toBe(2)
    expect(h.cli).toEqual([])
    expect(h.written).toEqual([])
  })

  it('RELEASES a checkout whose commits are on a branch but not yet on the base', async () => {
    // THE BRANCH IS THE RECORD OF WHAT THE THREAD DID, and prune keeps it —
    // so these commits are not at risk and there is nothing to refuse. This
    // used to answer `holds-work`, described in its own comment as "a caution
    // rather than a refusal — but it is the caller's to overrule", and no
    // caller ever overruled it: a worktree whose branch was simply unmerged
    // could not be deleted at all, under a dialog that had just said the branch
    // and its commits stay (user, 2026-09-18).
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse') return ok('feature/export-pipeline\n')
        if (args[0] === 'rev-list') return ok('3\n')
        return undefined
      },
    })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('pruned')
    // …and it really removed it, rather than reporting success over a no-op.
    expect(h.cli.length).toBeGreaterThan(0)
  })

  it('leaves a DETACHED checkout whose commits reach no ref at all', async () => {
    // The same count, the other answer: `base..HEAD` on a detached HEAD counts
    // commits that live on no branch, and `worktree remove` takes the reflog
    // they were reachable from. This reached the overridable caution too, which
    // is the same bug pointing the other way.
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse') return ok('HEAD\n')
        if (args[0] === 'rev-list') return ok('3\n')
        return undefined
      },
    })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('holds-work')
    expect(result.aheadCommits).toBe(3)
    expect(result.detail).toContain('on no branch')
    expect(h.cli).toEqual([])
  })

  it('refuses while the thread is working, before it reads anything', async () => {
    // W-3. Removing a directory does not redirect the agent standing in it: a
    // session's cwd is fixed at spawn. Worse, `sendMessage` skips the cut while
    // a session exists, so a thread released mid-turn could never get a new copy
    // — permanently pointed at nothing, by the release button itself.
    const h = harness({
      standDownAgent: () => ({ ok: false, detail: 'This thread is working right now.' }),
    })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('refused')
    expect(result.detail).toContain('working right now')
    expect(h.cli).toEqual([])
    expect(h.written).toEqual([])
    // BEFORE the reading, not after: every number the unlanded check takes is
    // stale the moment an agent is writing in the tree.
    expect(h.git).toEqual([])
  })

  it('refuses a working thread even when told to discard what it holds', async () => {
    // `allowUnlanded` is a licence to lose uncommitted work a person was shown.
    // It is not a licence to delete the floor under a turn in flight.
    const h = harness({
      standDownAgent: () => ({ ok: false, detail: 'This thread is working right now.' }),
    })
    const result = await h.service.prune('t1', { confirmed: true, allowUnlanded: true })
    expect(result.status).toBe('refused')
    expect(h.cli).toEqual([])
  })

  it('stands an idle agent down before the copy goes', async () => {
    // The other half of W-3, and the half that makes the thread usable again:
    // while a session exists the next message will not cut a new copy.
    const stood: Array<[string, boolean | undefined]> = []
    const h = harness({
      git: (_cwd, args) => (args[0] === 'status' ? ok('') : args[0] === 'rev-list' ? ok('0\n') : undefined),
      standDownAgent: (threadId, force) => {
        stood.push([threadId, force])
        return { ok: true }
      },
    })
    expect((await h.service.prune('t1', { confirmed: true })).status).toBe('pruned')
    expect(stood).toEqual([['t1', undefined]])
  })

  it('releases exactly as before for a caller that runs no agents', async () => {
    // Absent dep → nothing is stood down and nothing is refused, which is every
    // existing caller and every test above this one.
    const h = harness({
      git: (_cwd, args) => (args[0] === 'status' ? ok('') : args[0] === 'rev-list' ? ok('0\n') : undefined),
    })
    expect((await h.service.prune('t1', { confirmed: true })).status).toBe('pruned')
  })

  it('refuses a checkout with no base that is sitting on no branch', async () => {
    // THE 2026-09-09 SHAPE. A thread cut while the project sat on a detached
    // HEAD (a tag, mid-bisect) records no base, and its commits are on no ref
    // at all — `worktree remove --force` takes `.git/worktrees/<id>/` with its
    // HEAD and reflog and they are unreachable the same second. This read as
    // "nothing held" and released, while the disk cap read the same null base
    // as `hasLanded: false` and protected it.
    const h = harness({
      record: thread({ worktreeBase: null }),
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('HEAD\n')
        return undefined
      },
    })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('holds-work')
    expect(h.cli).toEqual([])
    expect(h.written).toEqual([])
  })

  it('still releases a checkout with no base that IS on a branch', async () => {
    // The ordinary orphan: nothing recorded its base, but everything it did is
    // on a ref that survives the directory. Refusing this one would strand every
    // unclaimed copy on disk forever, which is the cost the fix must not pay.
    const h = harness({
      record: thread({ worktreeBase: null }),
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return ok('thread/orphan\n')
        return undefined
      },
    })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('pruned')
  })

  it('holds on to a checkout it could not read the branch of', async () => {
    // Unreadable and detached look identical from here, and both mean CANNOT
    // SAY. Holding costs disk; the alternative costs the work inside.
    const h = harness({
      record: thread({ worktreeBase: null }),
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return fail('not a git repository')
        return undefined
      },
    })
    expect((await h.service.prune('t1', { confirmed: true })).status).toBe('holds-work')
  })

  it('lets it go when the caller says so knowing what it holds', async () => {
    const h = harness()
    const result = await h.service.prune('t1', { confirmed: true, allowUnlanded: true })
    expect(result.status).toBe('pruned')
    expect(h.written).toEqual([null])
  })

  it('keeps the thread pointing at its checkout when removal failed', async () => {
    const h = harness({
      git: (_cwd, args) => (args[0] === 'status' ? ok('') : args[0] === 'rev-list' ? ok('0\n') : undefined),
      cli: () => fail('worktree refused: locked'),
    })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('failed')
    expect(h.written).toEqual([])
  })

  it('says nothing to do for a thread that never had a checkout', async () => {
    const h = harness({ record: thread({ worktreePath: null }) })
    const result = await h.service.prune('t1', { confirmed: true })
    expect(result.status).toBe('absent')
    expect(h.cli).toEqual([])
  })
})

describe('what a person reads (forbidden-pattern #12)', () => {
  it('never names a command, a path or a config key', async () => {
    const h = harness({
      git: (_cwd, args) => {
        if (args[0] === 'merge') return fail('CONFLICT')
        if (args[0] === 'status') return ok('UU a.ts\n')
        return undefined
      },
    })
    const landed = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Land it',
    })
    const held = await h.service.prune('t1', { confirmed: true })
    const preview = await h.service.preview('t1')
    const strings = [
      ...landed.rows.map((row) => row.detail),
      held.detail,
      preview.blockedReason ?? '',
    ]
    for (const text of strings) {
      expect(text).not.toMatch(/planflow-ai|git |gh pr|\/repo|\.flowconfig|--/)
    }
  })
})

describe('a worktree that took its base branch — there is nothing to merge', () => {
  /** The shape the picker's "work on this branch" choice produces. */
  const onBase = (): LandingThread =>
    thread({ worktreeBranch: 'ACME-2446', worktreeBase: 'ACME-2446' })

  it('is exactly branch === base, and nothing else is', () => {
    expect(worksOnBase('ACME-2446', 'ACME-2446')).toBe(true)
    expect(worksOnBase('thread/x', 'ACME-2446')).toBe(false)
    // A detached worktree has no branch, so it is never on its base.
    expect(worksOnBase(null, 'ACME-2446')).toBe(false)
    expect(worksOnBase('', '')).toBe(false)
  })

  it('saves what is loose and moves no ref at all', async () => {
    const h = harness({
      record: onBase(),
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok(' M engine.ts\n')
        if (args[0] === 'rev-parse') return ok('abc123')
        return undefined
      },
    })
    const result = await h.service.land('t1', {
      mode: 'merge',
      confirmed: true,
      message: 'Resolve the merge',
    })

    expect(result.rows[0]).toMatchObject({ outcome: 'landed', committed: 1 })
    expect(result.complete).toBe(true)
    const verbs = h.git.map((call) => call.join(' '))
    // No merge, and — the one that would actually have failed — no attempt to
    // force a branch that is checked out in this very worktree.
    expect(verbs.some((call) => call.startsWith('merge'))).toBe(false)
    expect(verbs.some((call) => call.startsWith('branch --force'))).toBe(false)
    expect(result.rows[0].detail).toContain('ACME-2446')
  })

  it('reports plainly when everything it did is already on the branch', async () => {
    const h = harness({
      record: onBase(),
      git: (_cwd, args) => (args[0] === 'status' ? ok('') : undefined),
    })
    const result = await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'x' })
    expect(result.rows[0]).toMatchObject({ outcome: 'nothing' })
    expect(result.rows[0].detail).toContain('already there')
  })

  it('does not tell a reader that nothing changed when a great deal did', async () => {
    // The failure this guards: `base..HEAD` is 0 for a worktree whose HEAD IS
    // the base, so the old "nothing to land" line would have been shown to
    // somebody whose work was entirely done and entirely committed.
    const h = harness({
      record: onBase(),
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-list') return ok('0\n')
        return undefined
      },
    })
    const preview = await h.service.preview('t1')
    expect(preview.repos[0].onBase).toBe(true)
    expect(preview.blockedReason).toContain('already there')
    expect(preview.blockedReason).not.toContain('hasn’t changed anything')
  })

  it('offers no pull request against the branch it is already on', async () => {
    const h = harness({
      record: { ...onBase(), remote: 'origin', remoteBranch: 'feature/PF-42' },
      withGh: true,
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse') return ok('deadbee')
        return undefined
      },
    })
    const preview = await h.service.preview('t1')
    expect(preview.canOpenPullRequest).toBe(false)

    const result = await h.service.land('t1', { mode: 'pull-request', confirmed: true })
    expect(result.rows[0]).toMatchObject({ outcome: 'no-branch' })
    expect(h.gh).toEqual([])
  })

  it('says nothing a person could not act on (#12)', async () => {
    const h = harness({
      record: onBase(),
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok(' M engine.ts\n')
        if (args[0] === 'rev-parse') return ok('abc123')
        return undefined
      },
    })
    const landed = await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'x' })
    const preview = await h.service.preview('t1')
    for (const text of [...landed.rows.map((row) => row.detail), preview.blockedReason ?? '']) {
      expect(text).not.toMatch(/planflow-ai|git |gh pr|\/repo|\.flowconfig|--/)
    }
  })
})

describe('a base that is a branch of the project, not its trunk', () => {
  it('merges onto the branch the worktree was cut from, wherever that is', async () => {
    // The reported case, landing: the thread started from ACME-2446, so its work
    // goes back to ACME-2446 — never to the repository's trunk.
    const h = harness({
      record: thread({ worktreeBranch: 'thread/fix', worktreeBase: 'ACME-2446' }),
      git: (cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          // The project is sitting on some other branch, so the ref is moved
          // directly rather than fast-forwarded through the user's tree.
          return cwd === PROJECT ? ok('somewhere-else\n') : ok('thread/fix\n')
        }
        if (args[0] === 'rev-parse') return ok('abc123')
        return undefined
      },
    })
    const result = await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'x' })

    expect(result.rows[0]).toMatchObject({ outcome: 'landed' })
    const verbs = h.git.map((call) => call.join(' '))
    expect(verbs).toContain('merge --no-edit ACME-2446')
    expect(verbs).toContain('branch --force ACME-2446 abc123')
    expect(verbs.some((call) => call.includes('main'))).toBe(false)
  })
})

describe('prune, pointed at a copy no thread claims', () => {
  /** The listing details a management view would hand back for one. */
  const abandoned = {
    projectRoot: PROJECT,
    worktreePath: '/repo/.repo-threads/ghost',
    branch: 'thread/ghost',
  }

  it('still runs nothing without an explicit say-so', async () => {
    // Widening what prune can be POINTED AT must not widen what it may do.
    const h = harness({ record: thread({ id: 'other' }) })
    const result = await h.service.prune('ghost', { abandoned })
    expect(result.status).toBe('refused')
    expect(h.cli).toEqual([])
  })

  it('is absent when nothing says where the copy is', async () => {
    const h = harness({ record: thread({ id: 'other' }) })
    const result = await h.service.prune('ghost', { confirmed: true })
    expect(result.status).toBe('absent')
    expect(h.cli).toEqual([])
  })

  it('keeps a copy that still holds unsaved work, without a second say-so', async () => {
    const h = harness({ record: thread({ id: 'other' }) })
    const result = await h.service.prune('ghost', { confirmed: true, abandoned })
    expect(result.status).toBe('holds-work')
    expect(h.cli).toEqual([])
  })

  it('removes it through the ONE deletion path when told twice', async () => {
    const h = harness({ record: thread({ id: 'other' }) })
    const result = await h.service.prune('ghost', {
      confirmed: true,
      allowUnlanded: true,
      abandoned,
    })
    expect(result.status).toBe('pruned')
    // THE SECOND SAY-SO TRAVELS. The CLI now refuses to delete a checkout
    // holding uncommitted work unless it is told the person was shown what
    // would go (#1797) — the same consent this call just collected. Without
    // `--discard` on the argv, the escalation a person made here would be
    // refused by the very verb it exists to authorise.
    expect(h.cli).toEqual([
      [
        'worktree',
        'prune',
        '--thread',
        'ghost',
        '--worktree-name',
        'ghost',
        '--json',
        '--target',
        PROJECT,
        '--discard',
      ],
    ])
  })

  it('does not carry the discard when nobody asked for one (#1797)', async () => {
    // A clean release is the common case and it must stay the plain call — a
    // flag added unconditionally is not a consent, which is the whole reason
    // `--discard` is separate from `confirmed`.
    // A copy with nothing uncommitted and nothing unmerged: the release needs
    // no second say-so, so none is collected and none is forwarded.
    const h = harness({
      record: thread({ id: 'other' }),
      git: (_cwd, args) => {
        if (args[0] === 'status') return ok('')
        if (args[0] === 'rev-list') return ok('0\n')
        return undefined
      },
    })
    const result = await h.service.prune('ghost', { confirmed: true, abandoned })
    expect(result.status).toBe('pruned')
    expect(h.cli).toEqual([
      [
        'worktree',
        'prune',
        '--thread',
        'ghost',
        '--worktree-name',
        'ghost',
        '--json',
        '--target',
        PROJECT,
      ],
    ])
  })

  it('writes no record for a thread the store does not know', async () => {
    // Asking the store to clear columns for an id it has never seen throws;
    // there is nothing to clear because the record is what went missing.
    const h = harness({ record: thread({ id: 'other' }) })
    await h.service.prune('ghost', { confirmed: true, allowUnlanded: true, abandoned })
    expect(h.written).toEqual([])
  })

  it('still clears the record for an ordinary release', async () => {
    const h = harness({ git: (_cwd, args) => (args[0] === 'status' ? ok('') : undefined) })
    const result = await h.service.prune('t1', { confirmed: true, allowUnlanded: true })
    expect(result.status).toBe('pruned')
    expect(h.written).toEqual([null])
  })
})

describe('forget', () => {
  /** Git that says the checkout is not there. */
  const missing = (_cwd: string, args: readonly string[]): RunResult | undefined =>
    args[0] === 'rev-parse' && args[1] === '--git-dir' ? fail('not a git repository') : undefined

  it('clears nothing without an explicit say-so (forbidden-pattern #15)', async () => {
    const h = harness({ git: missing })
    const result = await h.service.forget('t1')
    expect(result.status).toBe('refused')
    expect(h.written).toEqual([])
    expect(h.git).toEqual([])
  })

  it('called with nothing at all, it does nothing at all', async () => {
    const h = harness({ git: missing })
    await h.service.forget('t1')
    expect(h.git).toEqual([])
    expect(h.cli).toEqual([])
  })

  it('stops a thread pointing at a copy that is gone', async () => {
    const h = harness({ git: missing })
    const result = await h.service.forget('t1', { confirmed: true })
    expect(result.status).toBe('forgotten')
    expect(h.written).toEqual([null])
  })

  it('REFUSES when the copy turns out to still be there', async () => {
    // The whole safety of this: forgetting a live checkout would strand real
    // files where nothing in the app would ever mention them again.
    const h = harness({
      git: (_cwd, args) =>
        args[0] === 'rev-parse' && args[1] === '--git-dir' ? ok('.git\n') : undefined,
    })
    const result = await h.service.forget('t1', { confirmed: true })
    expect(result.status).toBe('still-there')
    expect(h.written).toEqual([])
  })

  it('deletes nothing, ever', async () => {
    const h = harness({ git: missing })
    await h.service.forget('t1', { confirmed: true })
    expect(h.cli).toEqual([])
  })

  it('has nothing to do for a thread with no worktree', async () => {
    const h = harness({ record: thread({ worktreePath: null }), git: missing })
    expect((await h.service.forget('t1', { confirmed: true })).status).toBe('absent')
  })

  it('never names a path, a command or a config key', async () => {
    const h = harness({ git: missing })
    const details = [
      (await h.service.forget('t1')).detail,
      (await h.service.forget('t1', { confirmed: true })).detail,
    ]
    for (const detail of details) {
      expect(detail).not.toMatch(/planflow-ai|\/repo|\/Users\/|worktree|git |--/)
    }
  })
})

describe('the resolved remote and pattern travel with every landing (worktree_settings_ui)', () => {
  const bound = (over: Partial<LandingThread> = {}): LandingThread =>
    thread({ remote: 'origin', remoteBranch: 'feature/PF-42', prBase: 'main', ...over })

  const propose = (h: Harness): Promise<unknown> =>
    h.service.land('t1', { mode: 'pull-request', confirmed: true, message: 'Add the landing bar' })

  it('sends the RESOLVED remote, not the built-in, on push and on pr', async () => {
    // A default set only in the person's app-wide settings is invisible to the
    // CLI, which reads one file: without this it could never reach the ask.
    const h = harness({ record: bound(), projectRaw: { remote: 'upstream' } })
    await propose(h)
    for (const call of h.cli.slice(0, 2)) {
      expect(call[call.indexOf('--default-remote') + 1]).toBe('upstream')
    }
  })

  it('adds the naming pattern when there is one, right before --json', async () => {
    const h = harness({
      record: bound(),
      projectRaw: { remote: 'upstream', remote_branch_pattern: 'feature/{ticket}' },
    })
    await propose(h)
    for (const call of h.cli.slice(0, 2)) {
      expect(call.slice(-5)).toEqual([
        '--default-remote',
        'upstream',
        '--branch-pattern',
        'feature/{ticket}',
        '--json',
      ])
    }
  })

  it('OMITS the pattern when there is none — an empty flag is an opinion nobody has', async () => {
    // An absent flag means "the project file decides"; an empty one would be a
    // caller saying it has an opinion and then not having one.
    const h = harness({ record: bound(), projectRaw: { remote: 'upstream' } })
    await propose(h)
    for (const call of h.cli.slice(0, 2)) {
      expect(call).not.toContain('--branch-pattern')
      expect(call.slice(-3)).toEqual(['--default-remote', 'upstream', '--json'])
    }
  })

  it('falls back to the built-ins when no reader is wired in', async () => {
    const h = harness({ record: bound() })
    await propose(h)
    expect(h.cli[0]?.slice(-3)).toEqual(['--default-remote', 'origin', '--json'])
    expect(h.cli[0]).not.toContain('--branch-pattern')
  })

  it('resolves ONCE for a landing that both pushes and proposes', async () => {
    const h = harness({ record: bound(), projectRaw: { remote: 'upstream' } })
    await propose(h)
    expect(h.cli.filter((call) => call[1] === 'push' || call[1] === 'pr')).toHaveLength(2)
    expect(h.settingsCalls).toEqual([PROJECT])
  })

  it('asks nothing of the settings for a landing that never leaves the machine', async () => {
    // A merge publishes nothing, so it has no remote to be offered and no
    // suggestion to build — and pays for neither (allowed-pattern #17).
    const h = harness({ record: bound(), projectRaw: { remote: 'upstream' } })
    await h.service.land('t1', { mode: 'merge', confirmed: true, message: 'Add the landing bar' })
    expect(h.settingsCalls).toEqual([])
    for (const call of h.cli) expect(call).not.toContain('--default-remote')
  })
})
