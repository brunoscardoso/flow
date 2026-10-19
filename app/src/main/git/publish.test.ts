import { GitPublishService, publishFailureSentence, type GitPublishDeps } from './publish'
import type { GitPublishBinding, GitStatus, ThreadBindingRequest } from '../../shared/ipc-contract'
import type { RunResult } from '../worktree/thread-worktree'

const PROJECT = '/repo'
const CHECKOUT = '/repo/.repo-threads/t1'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    rootId: PROJECT,
    branch: 'feat/push-from-review',
    dirty: false,
    ahead: 1,
    behind: 0,
    changes: [],
    ...overrides,
  }
}

/** What `worktree push` prints on success — the CLI's shape, not this file's. */
const PUSHED =
  '{"status":"pushed","thread":"t1","branch":"feat/push-from-review","remote":"origin","remoteBranch":"feature/PF-42","pushed":true}'

/** The refusal a push answers with when nobody has said where the work goes. */
const UNBOUND =
  '{"refused":"unbound","suggestion":"feature/PF-42","source":"ticket","remote":"origin","remotes":["origin","upstream"],"base":"main"}'

/**
 * The CLI, as a table keyed on the argv the service actually sends — and it
 * THROWS on anything it was not asked about (allowed-pattern #24's sibling).
 *
 * A fake that answers everything tests the answer the code got; a fake that
 * refuses to answer an argv nobody wrote down tests the QUESTION the code
 * asked. The difference matters most here, where one unlisted flag
 * (`--unattended`) would silently turn a refusal that asks into a binding
 * nobody consented to.
 */
function cliTable(answers: Record<string, RunResult>): {
  runCli: GitPublishDeps['runCli']
  calls: Array<{ cwd: string; args: readonly string[] }>
} {
  const calls: Array<{ cwd: string; args: readonly string[] }> = []
  return {
    calls,
    runCli: async (cwd, args) => {
      calls.push({ cwd, args })
      const key = args.join(' ')
      const answer = answers[key]
      if (answer === undefined) {
        throw new Error(`the service ran an argv nothing expected: ${key}`)
      }
      return answer
    },
  }
}

interface Harness {
  service: GitPublishService
  calls: Array<{ cwd: string; args: readonly string[] }>
  /** Every request that reached the thread binding path, in order. */
  bindings: ThreadBindingRequest[]
}

function harness(
  options: {
    status?: GitStatus | null
    upstream?: string | null
    owner?: { threadId: string; projectRoot: string } | null
    root?: string
    answers?: Record<string, RunResult>
    /** What the THREAD binding path answers. Nothing else fakes it. */
    bind?: { ok: true } | { ok: false; detail: string }
  } = {},
): Harness {
  const { runCli, calls } = cliTable(options.answers ?? {})
  const bindings: ThreadBindingRequest[] = []
  const service = new GitPublishService({
    runCli,
    status: async () => (options.status === undefined ? status() : options.status),
    upstreamOf: async () => options.upstream ?? null,
    threadFor: () => options.owner ?? null,
    bindThread: async (request) => {
      bindings.push(request)
      return options.bind ?? { ok: true }
    },
  })
  return { service, calls, bindings }
}

/** The argv a plain checkout's publish sends. */
const HERE_ARGV = `worktree push --target ${PROJECT} --here --json`
/**
 * The argv a thread's own checkout sends.
 *
 * `--target` IS THE PROJECT, NOT THE WORKTREE. The verb derives a repo's
 * thread-worktree container from the target, so naming the worktree asks it
 * to find this thread inside this thread's own checkout — it never is, and the
 * push refused "thread 't1' has no worktree" for a worktree that existed.
 */
const THREAD_ARGV = `worktree push --target ${PROJECT} --thread t1 --json`

describe('GitPublishService.publish', () => {
  it('publishes, and reports where the verb said the branch landed', async () => {
    const h = harness({
      upstream: 'origin/feature/PF-42',
      answers: { [HERE_ARGV]: { ok: true, stdout: PUSHED } },
    })

    const result = await h.service.publish(PROJECT)

    expect(result).toEqual({
      status: 'published',
      remote: 'origin',
      remoteBranch: 'feature/PF-42',
    })
  })

  it('carries the rename forward when the verb reports one', async () => {
    const h = harness({
      upstream: 'origin/feature/PF-42',
      answers: {
        [HERE_ARGV]: {
          ok: true,
          stdout:
            '{"status":"pushed","remote":"origin","remoteBranch":"feature/PF-42","previouslyPushedAs":"feat/old-name","pushed":true}',
        },
      },
    })

    expect(await h.service.publish(PROJECT)).toEqual({
      status: 'published',
      remote: 'origin',
      remoteBranch: 'feature/PF-42',
      previouslyPushedAs: 'feat/old-name',
    })
  })

  it('relays the unbound refusal with its suggestion intact', async () => {
    const h = harness({
      upstream: null,
      answers: {
        [HERE_ARGV]: { ok: false, stdout: UNBOUND, stderr: 'worktree refused: unbound' },
      },
    })

    const result = await h.service.publish(PROJECT)

    expect(result).toEqual({
      status: 'unbound',
      suggestion: {
        suggestion: 'feature/PF-42',
        source: 'ticket',
        remote: 'origin',
        remotes: ['origin', 'upstream'],
        base: 'main',
      },
    })
  })

  it('refuses a diverged branch with nothing spawned at all', async () => {
    // No answers in the table: a spawn here fails the test by construction,
    // which is the assertion that matters — a refusal that pushes anyway is the
    // exact bug this feature exists to prevent (allowed-pattern #24).
    const h = harness({
      status: status({ ahead: 2, behind: 3 }),
      upstream: 'origin/feature/PF-42',
    })

    expect(await h.service.publish(PROJECT)).toEqual({ status: 'diverged', behind: 3 })
    expect(h.calls).toEqual([])
  })

  it('says there is nothing to publish for a bound branch that is already there', async () => {
    const h = harness({
      status: status({ ahead: 0, behind: 0 }),
      upstream: 'origin/feature/PF-42',
    })

    expect(await h.service.publish(PROJECT)).toEqual({ status: 'nothing' })
    expect(h.calls).toEqual([])
  })

  it('does NOT read a never-published branch as nothing to publish', async () => {
    // `ahead: 0` with no upstream is "never aimed", not "already there" — the
    // whole reason the upstream is read beside the status.
    const h = harness({
      status: status({ ahead: 0, behind: 0 }),
      upstream: null,
      answers: {
        [HERE_ARGV]: { ok: false, stdout: UNBOUND, stderr: 'worktree refused: unbound' },
      },
    })

    expect((await h.service.publish(PROJECT)).status).toBe('unbound')
  })

  it('reads a non-unbound refusal as a failure, in a sentence with no command in it', async () => {
    const h = harness({
      upstream: 'origin/feature/PF-42',
      answers: {
        [HERE_ARGV]: {
          ok: false,
          stdout: '',
          stderr:
            'worktree refused: origin/feature/PF-42 has work this branch does not — nothing was pushed',
        },
      },
    })

    const result = await h.service.publish(PROJECT)

    expect(result.status).toBe('failed')
    const detail = result.status === 'failed' ? result.detail : ''
    expect(detail).toContain('origin/feature/PF-42 has work this branch does not')
    expect(detail).not.toContain('git ')
    expect(detail).not.toContain('planflow-ai')
    expect(detail).not.toContain('`')
  })

  it('fails without spawning when the repository cannot be read', async () => {
    const h = harness({ status: null })

    const result = await h.service.publish(PROJECT)

    expect(result.status).toBe('failed')
    expect(h.calls).toEqual([])
  })

  it('does not claim a place it could not read back', async () => {
    const h = harness({
      upstream: 'origin/feature/PF-42',
      answers: { [HERE_ARGV]: { ok: true, stdout: 'pushed: feat/x → origin/feature/PF-42' } },
    })

    const result = await h.service.publish(PROJECT)

    expect(result.status).toBe('failed')
    // It never says nothing was sent, because something was.
    expect(result.status === 'failed' ? result.detail : '').not.toContain('Nothing was sent')
  })

  describe('which checkout the verb is told to act on', () => {
    // THE BUG THIS PAIR EXISTS FOR (2026-09-14): the push named the WORKTREE as
    // its target while also naming the thread, so the verb looked for that
    // thread's worktree inside that thread's own checkout and refused —
    // "thread 'b3fe...' has no worktree" — for a worktree sitting right there.
    it('never names the worktree as the target when it names a thread', async () => {
      const h = harness({
        owner: { threadId: 't1', projectRoot: PROJECT },
        upstream: 'origin/feature/PF-42',
        answers: { [THREAD_ARGV]: { ok: true, stdout: PUSHED } },
      })

      await h.service.publish(CHECKOUT)

      const args = h.calls[0].args
      const target = args[args.indexOf('--target') + 1]
      expect(target).toBe(PROJECT)
      expect(target).not.toBe(CHECKOUT)
      // …and the worktree is still named, by the flag that means "which one".
      expect(args).toContain('--thread')
    })

    it('names the checkout itself when nobody owns it — there is no project above it', async () => {
      const h = harness({
        owner: null,
        upstream: 'origin/main',
        answers: { [HERE_ARGV]: { ok: true, stdout: PUSHED } },
      })

      await h.service.publish(PROJECT)

      const args = h.calls[0].args
      expect(args[args.indexOf('--target') + 1]).toBe(PROJECT)
      expect(args).toContain('--here')
      expect(args).not.toContain('--thread')
    })

    it('names the thread when one owns the checkout', async () => {
      const h = harness({
        owner: { threadId: 't1', projectRoot: PROJECT },
        upstream: 'origin/feature/PF-42',
        answers: { [THREAD_ARGV]: { ok: true, stdout: PUSHED } },
      })

      await h.service.publish(CHECKOUT)

      expect(h.calls).toHaveLength(1)
      // The PROJECT, not the checkout: the verb looks for this thread's
      // worktree inside the target, and inside the worktree it never is.
      expect(h.calls[0].args).toEqual([
        'worktree',
        'push',
        '--target',
        PROJECT,
        '--thread',
        't1',
        '--json',
      ])
      expect(h.calls[0].cwd).toBe(CHECKOUT)
    })

    it('acts on the checkout itself when no thread owns it', async () => {
      const h = harness({
        owner: null,
        upstream: 'origin/feature/PF-42',
        answers: { [HERE_ARGV]: { ok: true, stdout: PUSHED } },
      })

      await h.service.publish(PROJECT)

      expect(h.calls[0].args).toEqual([
        'worktree',
        'push',
        '--target',
        PROJECT,
        '--here',
        '--json',
      ])
    })

    it('passes no flag that could bind the branch without an answer', async () => {
      // `--unattended` is the ONE flag that turns a confident suggestion into a
      // binding nobody was asked about (plan risk R4). A press is attended by
      // definition, so it must never appear.
      const h = harness({
        upstream: 'origin/feature/PF-42',
        answers: { [HERE_ARGV]: { ok: true, stdout: PUSHED } },
      })

      await h.service.publish(PROJECT)

      const argv = h.calls[0].args
      expect(argv).not.toContain('--unattended')
      expect(argv).not.toContain('--remote')
      expect(argv).not.toContain('--branch')
      expect(argv.filter((flag) => flag.startsWith('--')).sort()).toEqual([
        '--here',
        '--json',
        '--target',
      ])
    })
  })
})

/**
 * Binding, when the answer arrives (Phase 3).
 *
 * EVERY TEST BELOW LEANS ON THE SAME FAKE. The CLI table throws on an argv
 * nothing wrote down, so a refusal that spawns anything fails the test by
 * construction rather than by an assertion somebody remembered to write — and
 * the thread path is a separate recorder, so "it took the other path" is a fact
 * about which list is empty (allowed-pattern #24).
 */
describe('GitPublishService binding', () => {
  /** A complete, ordinary answer — the one every refusal below is a dent in. */
  const ANSWER: GitPublishBinding = {
    remote: 'origin',
    remoteBranch: 'feature/PF-42',
    confirmed: true,
  }
  /** The argv a plain checkout's bind sends. */
  const BIND_ARGV = `worktree bind --target ${PROJECT} --here --remote origin --branch feature/PF-42 --json`

  describe('the gate', () => {
    it('writes nothing at all when the request never said a person asked', async () => {
      // ABSENT, not false: the wire is untyped, and a request that simply left
      // the field out is the shape this gate exists for (forbidden-pattern #15).
      const partial = { remote: 'origin', remoteBranch: 'feature/PF-42' } as GitPublishBinding
      const h = harness()

      const result = await h.service.publish(PROJECT, partial)

      expect(result.status).toBe('unconfirmed')
      expect(h.calls).toEqual([])
      expect(h.bindings).toEqual([])
    })

    it('writes nothing at all when the request said not-confirmed', async () => {
      const h = harness()

      const result = await h.service.publish(PROJECT, { ...ANSWER, confirmed: false })

      expect(result.status).toBe('unconfirmed')
      expect(h.calls).toEqual([])
      expect(h.bindings).toEqual([])
    })

    it('refuses an empty remote rather than reaching for the project default', async () => {
      const h = harness()

      const result = await h.service.publish(PROJECT, { ...ANSWER, remote: '  ' })

      expect(result.status).toBe('incomplete')
      expect(result.status === 'incomplete' ? result.detail : '').not.toContain('origin')
      expect(h.calls).toEqual([])
      expect(h.bindings).toEqual([])
    })

    it('refuses an empty branch name rather than reaching for the local one', async () => {
      const h = harness()

      const result = await h.service.publish(PROJECT, { ...ANSWER, remoteBranch: '' })

      expect(result.status).toBe('incomplete')
      expect(h.calls).toEqual([])
      expect(h.bindings).toEqual([])
    })

    it('says its refusals in sentences with no command, path or key in them', async () => {
      const h = harness()

      const details = [
        await h.service.publish(PROJECT, { ...ANSWER, confirmed: false }),
        await h.service.publish(PROJECT, { ...ANSWER, remote: '' }),
        await h.service.publish(PROJECT, { ...ANSWER, remoteBranch: '' }),
      ].map((result) =>
        result.status === 'unconfirmed' || result.status === 'incomplete' ? result.detail : '',
      )

      for (const detail of details) {
        expect(detail).not.toBe('')
        expect(detail).not.toContain('planflow-ai')
        expect(detail).not.toContain('`')
        expect(detail).not.toContain('--')
        expect(detail).not.toContain('/')
      }
    })
  })

  describe('which path the answer takes', () => {
    it('binds a plain checkout through the verb, and never with a PR base', async () => {
      const h = harness({
        answers: {
          [BIND_ARGV]: { ok: true, stdout: '{"bound":true,"remote":"origin","remoteBranch":"feature/PF-42"}' },
          [HERE_ARGV]: { ok: true, stdout: PUSHED },
        },
      })

      await h.service.publish(PROJECT, ANSWER)

      const argv = h.calls[0].args
      // The verb REFUSES the whole call when `--pr-base` rides along with
      // `--here` — a plain checkout has nowhere to keep one. Asserting the flag
      // set, not just this flag's absence, so a later addition has to come and
      // read this test before it changes what gets sent.
      expect(argv).not.toContain('--pr-base')
      expect(argv.filter((flag) => flag.startsWith('--')).sort()).toEqual([
        '--branch',
        '--here',
        '--json',
        '--remote',
        '--target',
      ])
      expect(argv).toEqual([
        'worktree',
        'bind',
        '--target',
        PROJECT,
        '--here',
        '--remote',
        'origin',
        '--branch',
        'feature/PF-42',
        '--json',
      ])
      expect(h.bindings).toEqual([])
    })

    it('binds a thread’s own checkout through the thread path, not the verb', async () => {
      const h = harness({
        owner: { threadId: 't1', projectRoot: PROJECT },
        answers: { [THREAD_ARGV]: { ok: true, stdout: PUSHED } },
      })

      await h.service.publish(CHECKOUT, ANSWER)

      expect(h.bindings).toEqual([
        {
          threadId: 't1',
          remote: 'origin',
          remoteBranch: 'feature/PF-42',
          // No PR base: this press opens no pull request, so it answers no
          // question about one.
          prBase: null,
          confirmed: true,
        },
      ])
      // The bind argv is absent from the table, so a CLI bind here would have
      // thrown. The only spawn was the push.
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0].args.slice(0, 2)).toEqual(['worktree', 'push'])
    })
  })

  describe('a bind that did not happen', () => {
    it('does not push when the verb refused the binding', async () => {
      // The push argv is NOT in the table: reaching it throws, which is the
      // assertion. The explicit check below says so out loud as well.
      const h = harness({
        answers: {
          [BIND_ARGV]: {
            ok: false,
            stdout: '',
            stderr: "worktree refused: this repository has no remote named 'origin'",
          },
        },
      })

      const result = await h.service.publish(PROJECT, ANSWER)

      expect(result.status).toBe('bind-failed')
      expect(result.status === 'bind-failed' ? result.detail : '').toContain('no remote named')
      expect(h.calls.map(({ args }) => args.join(' '))).toEqual([BIND_ARGV])
      expect(h.calls.map(({ args }) => args.join(' '))).not.toContain(HERE_ARGV)
    })

    it('does not push when the thread path refused the binding', async () => {
      const h = harness({
        owner: { threadId: 't1', projectRoot: PROJECT },
        bind: { ok: false, detail: 'This thread has no branch of its own.' },
      })

      const result = await h.service.publish(CHECKOUT, ANSWER)

      expect(result).toEqual({
        status: 'bind-failed',
        detail: 'This thread has no branch of its own.',
      })
      expect(h.calls).toEqual([])
    })
  })

  it('binds and then pushes once, in that order', async () => {
    const h = harness({
      answers: {
        [BIND_ARGV]: { ok: true, stdout: '{"bound":true}' },
        [HERE_ARGV]: { ok: true, stdout: PUSHED },
      },
    })

    const result = await h.service.publish(PROJECT, ANSWER)

    expect(result).toEqual({
      status: 'published',
      remote: 'origin',
      remoteBranch: 'feature/PF-42',
    })
    // ONE PRESS, ONE PUSH — whether or not a binding had to be written first.
    expect(h.calls.map(({ args }) => args.join(' '))).toEqual([BIND_ARGV, HERE_ARGV])
  })

  it('still refuses a diverged branch before writing the answer', async () => {
    // The checks are asked of the repository as the reader found it. Binding
    // first would move the ground they stand on.
    const h = harness({
      status: status({ ahead: 2, behind: 3 }),
      upstream: 'origin/feature/PF-42',
    })

    expect(await h.service.publish(PROJECT, ANSWER)).toEqual({ status: 'diverged', behind: 3 })
    expect(h.calls).toEqual([])
    expect(h.bindings).toEqual([])
  })
})

describe('publishFailureSentence', () => {
  it('says something happened even when the verb said nothing readable', () => {
    expect(publishFailureSentence({ ok: false, stdout: '', stderr: '' })).toBe(
      'Flow couldn’t publish this branch. Nothing was sent.',
    )
  })

  it('drops a backticked invocation the CLI wrote for a terminal reader', () => {
    const sentence = publishFailureSentence({
      ok: false,
      stdout: '',
      stderr: 'worktree refused: stale — the branch moved; refresh it with `planflow-ai worktree bind`',
    })

    expect(sentence).not.toContain('planflow-ai')
    expect(sentence).not.toContain('`')
    expect(sentence).toContain('the branch moved')
  })

  it('drops a path down to what it is about', () => {
    const sentence = publishFailureSentence({
      ok: false,
      stdout: '',
      stderr: 'worktree refused: /Users/someone/repo/flow/.flowconfig names no remote',
    })

    expect(sentence).not.toContain('/Users/someone')
    expect(sentence).toContain('its settings')
  })
})
