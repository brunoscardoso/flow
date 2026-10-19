import { ThreadBindingService, mirrorOf, type BindingThread } from './thread-binding'
import type { RunResult } from './thread-worktree'

const PROJECT = '/repo'

function thread(over: Partial<BindingThread> = {}): BindingThread {
  return {
    id: 't1',
    projectRoot: PROJECT,
    worktreePath: '/repo/.repo-threads/t1',
    worktreeBranch: 'thread/add-the-landing-bar',
    worktreeBase: 'main',
    remote: null,
    remoteBranch: null,
    prBase: null,
    previouslyPushedAs: null,
    ...over,
  }
}

function ok(stdout = ''): RunResult {
  return { ok: true, stdout }
}

function fail(stdout = '', stderr = ''): RunResult {
  return { ok: false, stdout, stderr }
}

/** `worktree list --json`, as the CLI prints it. */
function listing(entry: Record<string, unknown>): RunResult {
  return ok(JSON.stringify({ status: 'listed', root: PROJECT, worktrees: [entry] }))
}

interface Harness {
  service: ThreadBindingService
  cli: string[][]
  mirrored: Array<unknown>
  record: BindingThread
}

function harness(
  options: { record?: BindingThread; cli?: (args: readonly string[]) => RunResult } = {},
): Harness {
  const record = options.record ?? thread()
  const cli: string[][] = []
  const mirrored: unknown[] = []
  const service = new ThreadBindingService({
    threadStore: {
      getThread: (id) => (id === record.id ? record : null),
      setThreadBinding: (_id, binding) => {
        mirrored.push(binding)
      },
    },
    runCli: (_cwd, args) => {
      cli.push([...args])
      return Promise.resolve(options.cli?.(args) ?? ok('{}'))
    },
  })
  return { service, cli, mirrored, record }
}

describe('the mirror', () => {
  it('calls half a binding no binding at all', () => {
    // A remote with no branch would read as decided and publish nowhere.
    expect(mirrorOf(thread({ remote: 'origin' })).bound).toBe(false)
    expect(mirrorOf(thread({ remote: 'origin', remoteBranch: 'feature/x' })).bound).toBe(true)
  })

  it('proposes nothing — a proposal is built where a push refuses', () => {
    expect(mirrorOf(thread()).suggestion).toBeNull()
  })
})

describe('reading where a thread publishes', () => {
  it('adopts an upstream that was there before any of this existed (FR-10)', async () => {
    const h = harness({
      cli: () =>
        listing({ thread: 't1', branch: 'thread/x', remote: 'origin', remoteBranch: 'feature/PF-42', bound: true }),
    })
    const state = await h.service.read('t1')
    expect(state).toMatchObject({ bound: true, remote: 'origin', remoteBranch: 'feature/PF-42' })
    expect(h.mirrored[0]).toEqual({
      remote: 'origin',
      remoteBranch: 'feature/PF-42',
      prBase: null,
    })
    // ONE CALL, and it is a read of git — nothing writes git from the mirror.
    expect(h.cli).toHaveLength(1)
    expect(h.cli[0]?.slice(0, 2)).toEqual(['worktree', 'list'])
  })

  it('finds a NAMED checkout: passes its folder, and reads the row the CLI answers with whatever the folder is called', async () => {
    // A checkout cut since folders got names lives at `worktree/<name>`, so the
    // row's `thread` is that folder, not the id. Matching it against the id
    // threw away every named checkout's binding.
    const h = harness({
      record: thread({ worktreePath: '/repo/.repo-threads/worktree/landing-bar' }),
      cli: () =>
        listing({ thread: 'worktree/landing-bar', owner: 't1', branch: 'thread/x', remote: 'origin', remoteBranch: 'feature/PF-42', bound: true }),
    })
    const state = await h.service.read('t1')
    expect(state).toMatchObject({ bound: true, remote: 'origin', remoteBranch: 'feature/PF-42' })
    expect(h.cli[0]).toEqual([
      'worktree',
      'list',
      '--target',
      PROJECT,
      '--thread',
      't1',
      '--worktree-name',
      'worktree/landing-bar',
      '--json',
    ])
  })

  it('asks with exactly the arguments `worktree list` is documented to take', async () => {
    // THE CONTRACT, ELEMENT FOR ELEMENT. `--target` says which repository and
    // `--thread` narrows the listing to this one row; a reader that dropped
    // either would be handed somebody else's binding and mirror it.
    const h = harness({
      cli: () => listing({ thread: 't1', branch: 'thread/x', remote: 'origin', remoteBranch: 'feature/PF-42', bound: true }),
    })
    await h.service.read('t1')
    expect(h.cli[0]).toEqual([
      'worktree',
      'list',
      '--target',
      PROJECT,
      '--thread',
      't1',
      '--json',
    ])
  })

  it('lets git win, and carries the base the store is the only home for', async () => {
    const h = harness({
      record: thread({ remote: 'origin', remoteBranch: 'feature/old', prBase: 'develop' }),
      cli: () =>
        listing({ thread: 't1', branch: 'thread/x', remote: 'upstream', remoteBranch: 'feature/new', bound: true }),
    })
    const state = await h.service.read('t1')
    expect(state).toMatchObject({ remote: 'upstream', remoteBranch: 'feature/new', prBase: 'develop' })
    expect(h.mirrored[0]).toMatchObject({ prBase: 'develop' })
  })

  it('writes nothing when the two already agree', async () => {
    const h = harness({
      record: thread({ remote: 'origin', remoteBranch: 'feature/x' }),
      cli: () =>
        listing({ thread: 't1', branch: 'thread/x', remote: 'origin', remoteBranch: 'feature/x', bound: true }),
    })
    await h.service.read('t1')
    expect(h.mirrored).toEqual([])
  })

  it('clears a mirror git no longer stands behind', async () => {
    const h = harness({
      record: thread({ remote: 'origin', remoteBranch: 'feature/x' }),
      cli: () => listing({ thread: 't1', branch: 'thread/x', remote: null, remoteBranch: null, bound: false }),
    })
    const state = await h.service.read('t1')
    expect(state.bound).toBe(false)
    expect(h.mirrored).toEqual([null])
  })

  it('does not read a detached worktree’s silence as an answer', async () => {
    const h = harness({
      record: thread({ remote: 'origin', remoteBranch: 'feature/x' }),
      cli: () => listing({ thread: 't1', branch: null, remote: null, remoteBranch: null, bound: false }),
    })
    const state = await h.service.read('t1')
    expect(state.bound).toBe(true)
    expect(h.mirrored).toEqual([])
  })

  it('keeps the mirror when the listing cannot be read at all', async () => {
    const h = harness({
      record: thread({ remote: 'origin', remoteBranch: 'feature/x' }),
      cli: () => fail('', 'not a git repository'),
    })
    const state = await h.service.read('t1')
    expect(state.bound).toBe(true)
    expect(h.mirrored).toEqual([])
  })

  it('asks git nothing for a thread that has no branch of its own', async () => {
    const h = harness({ record: thread({ worktreePath: null }) })
    const state = await h.service.read('t1')
    expect(state.bound).toBe(false)
    expect(h.cli).toEqual([])
  })

  it('answers unbound for a thread nothing knows', async () => {
    const h = harness()
    expect(await h.service.read('gone')).toMatchObject({ bound: false, suggestion: null })
  })
})

describe('deciding where a thread publishes', () => {
  const request = {
    threadId: 't1',
    remote: 'origin',
    remoteBranch: 'feature/PF-42',
    prBase: 'develop',
    confirmed: true,
  }

  it('runs no git at all without an explicit say-so (forbidden-pattern #15)', async () => {
    const h = harness()
    const result = await h.service.bind({ ...request, confirmed: false })
    expect(result).toMatchObject({ ok: false })
    expect(h.cli).toEqual([])
    expect(h.mirrored).toEqual([])
  })

  it('refuses an empty answer rather than completing it', async () => {
    const h = harness()
    const noRemote = await h.service.bind({ ...request, remote: '  ' })
    const noBranch = await h.service.bind({ ...request, remoteBranch: '' })
    expect(noRemote).toMatchObject({ ok: false })
    expect(noBranch).toMatchObject({ ok: false })
    expect(h.cli).toEqual([])
  })

  it('calls the one verb that writes an upstream, and mirrors what it wrote', async () => {
    const h = harness({
      cli: () =>
        ok(
          '{"status":"bound","thread":"t1","branch":"thread/x","remote":"origin","remoteBranch":"feature/PF-42","prBase":"develop","previouslyPushedAs":"feature/old"}',
        ),
    })
    const result = await h.service.bind(request)
    expect(result).toMatchObject({ ok: true })
    expect(h.cli[0]).toEqual([
      'worktree',
      'bind',
      '--target',
      PROJECT,
      '--thread',
      't1',
      '--remote',
      'origin',
      '--branch',
      'feature/PF-42',
      '--pr-base',
      'develop',
      '--json',
    ])
    expect(h.mirrored[0]).toEqual({
      remote: 'origin',
      remoteBranch: 'feature/PF-42',
      prBase: 'develop',
      previouslyPushedAs: 'feature/old',
    })
  })

  it('omits the base flag entirely rather than passing an empty one', async () => {
    // A flag with nothing after it is not "no answer" — it is an answer of ''.
    // The verb has its own default for a base nobody chose, and it only gets
    // to use it when the argument is absent.
    const h = harness({
      cli: () =>
        ok('{"status":"bound","thread":"t1","branch":"thread/x","remote":"origin","remoteBranch":"feature/PF-42","prBase":null}'),
    })
    await h.service.bind({ ...request, prBase: null })
    expect(h.cli[0]).toEqual([
      'worktree',
      'bind',
      '--target',
      PROJECT,
      '--thread',
      't1',
      '--remote',
      'origin',
      '--branch',
      'feature/PF-42',
      '--json',
    ])
  })

  it('leaves the record of an earlier name alone when this write made none', async () => {
    const h = harness({
      cli: () =>
        ok('{"status":"bound","thread":"t1","branch":"thread/x","remote":"origin","remoteBranch":"feature/PF-42","prBase":null}'),
    })
    await h.service.bind({ ...request, prBase: null })
    expect(h.mirrored[0]).toEqual({
      remote: 'origin',
      remoteBranch: 'feature/PF-42',
      prBase: null,
    })
  })

  it('relays the verb’s reason and mirrors nothing when it refuses', async () => {
    const h = harness({
      cli: () => fail("worktree refused: this repository has no remote named 'upstrem'"),
    })
    const result = await h.service.bind({ ...request, remote: 'upstrem' })
    expect(result).toEqual({
      ok: false,
      detail: "this repository has no remote named 'upstrem'",
    })
    expect(h.mirrored).toEqual([])
  })

  it('has nothing to bind for a worktree that is still unnamed', async () => {
    const h = harness({ record: thread({ worktreeBranch: null }) })
    const result = await h.service.bind(request)
    expect(result).toMatchObject({ ok: false })
    expect(h.cli).toEqual([])
  })

  it('says nothing a person could not act on (forbidden-pattern #12)', async () => {
    const h = harness({ record: thread({ worktreePath: null }) })
    const refusals = [
      await h.service.bind({ ...request, confirmed: false }),
      await h.service.bind({ ...request, remote: '' }),
      await h.service.bind({ ...request, remoteBranch: '' }),
      await h.service.bind(request),
    ]
    for (const refusal of refusals) {
      const detail = 'detail' in refusal ? refusal.detail : ''
      expect(detail).not.toMatch(/planflow-ai|git |gh pr|\/repo|\.flowconfig|--/)
    }
  })
})

describe('binding is untouched by the worktree settings (worktree_settings_ui)', () => {
  // A BINDING IS A DECISION ALREADY MADE. The resolved remote and naming
  // pattern are SUGGESTION inputs — they belong to the refusal that asks a
  // person where the work goes, and to nothing that writes one. A settings
  // change must never reach a thread that already said where it publishes.
  const request = {
    threadId: 't1',
    remote: 'origin',
    remoteBranch: 'feature/PF-42',
    prBase: 'develop',
    confirmed: true,
  }

  it('sends no suggestion flags on the verb that writes an upstream', async () => {
    const h = harness({
      cli: () =>
        ok(
          '{"status":"bound","thread":"t1","branch":"thread/x","remote":"origin","remoteBranch":"feature/PF-42","prBase":"develop"}',
        ),
    })
    await h.service.bind(request)
    expect(h.cli[0]).not.toContain('--default-remote')
    expect(h.cli[0]).not.toContain('--branch-pattern')
  })

  it('sends none on the read either — a listing asks nothing of a settings file', async () => {
    const h = harness({
      cli: () =>
        listing({
          thread: 't1',
          branch: 'thread/x',
          remote: 'origin',
          remoteBranch: 'feature/PF-42',
          bound: true,
        }),
    })
    await h.service.read('t1')
    for (const call of h.cli) {
      expect(call).not.toContain('--default-remote')
      expect(call).not.toContain('--branch-pattern')
    }
  })
})
