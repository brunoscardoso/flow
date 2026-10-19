// The git tail — what the chain publishes after the review, and everything it
// refuses to do on its own.
//
// A REFUSAL TEST ASSERTS THE ABSENCE OF THE EFFECT, not just the sentence
// (allowed-pattern #24): each case below checks which verbs were called, so a
// tail that reports "nothing to publish" and pushes anyway fails here.

import { runGitTail, tailConfigFrom, type TailDeps } from './chain-tail'

/** The instant the chain began — the publish gate's scope. */
const SINCE = '2026-09-11T12:00:00.000Z'

function deps(over: Partial<TailDeps> = {}): { deps: TailDeps; called: string[] } {
  const called: string[] = []
  return {
    called,
    deps: {
      checkRisk: async () => {
        called.push('gate')
        return { ok: true, detail: 'This work may be published.' }
      },
      push: async () => {
        called.push('push')
        return { ok: true, detail: 'The work is published.' }
      },
      openPullRequest: async () => {
        called.push('pr')
        return { ok: true, detail: 'Opened.', url: 'https://example.test/pr/1' }
      },
      ...over,
    },
  }
}

describe('tailConfigFrom', () => {
  it('only the literal true switches one on', () => {
    expect(tailConfigFrom({ commit: 'true', push: 'true', pr: 'true' })).toEqual({
      commit: true,
      push: true,
      pr: true,
    })
    expect(tailConfigFrom({ commit: 'yes', push: '', pr: 'True' })).toEqual({
      commit: false,
      push: false,
      pr: false,
    })
  })

  it('an absent key means no', () => {
    expect(tailConfigFrom({})).toEqual({ commit: false, push: false, pr: false })
  })
})

describe('runGitTail', () => {
  it('opens a pull request when the project asks for one, and reports its URL', async () => {
    const { deps: tail, called } = deps()
    const out = await runGitTail(tail, {
      threadId: 'th',
      chainId: 'chain-1',
      since: SINCE,
      config: { commit: true, push: true, pr: true },
    })
    expect(called).toEqual(['gate', 'pr'])
    expect(out).toMatchObject({ ok: true, url: 'https://example.test/pr/1' })
  })

  it('publishes and stops there when the project pushes but opens no pull requests', async () => {
    const { deps: tail, called } = deps()
    const out = await runGitTail(tail, {
      threadId: 'th',
      chainId: 'chain-1',
      since: SINCE,
      config: { commit: true, push: true, pr: false },
    })
    expect(called).toEqual(['gate', 'push'])
    expect(out.url).toBeNull()
  })

  it('never does both — a pull request already commits and publishes', async () => {
    const { deps: tail, called } = deps()
    await runGitTail(tail, {
      threadId: 'th',
      config: { commit: true, push: true, pr: true },
      chainId: 'chain-1',
      since: SINCE,
    })
    expect(called).not.toContain('push')
  })

  it('a project that publishes nothing has nothing done to it', async () => {
    const { deps: tail, called } = deps()
    const out = await runGitTail(tail, {
      threadId: 'th',
      chainId: 'chain-1',
      since: SINCE,
      config: { commit: true, push: false, pr: false },
    })
    expect(called).toEqual([])
    expect(out).toEqual({ ok: true, detail: null, url: null, gated: false })
  })

  it('a project that keeps its work local publishes nothing, and says so', async () => {
    const { deps: tail, called } = deps()
    const out = await runGitTail(tail, {
      threadId: 'th',
      chainId: 'chain-1',
      since: SINCE,
      config: { commit: false, push: true, pr: true },
    })
    expect(called).toEqual([])
    expect(out.detail).toContain('local')
  })

  it('honours a refusal — an unbound branch is reported, never retried or guessed at', async () => {
    const { deps: tail, called } = deps({
      openPullRequest: async () => ({
        ok: false,
        detail: 'Nobody has said where this work should be published, so it was left alone.',
      }),
    })
    const out = await runGitTail(tail, {
      threadId: 'th',
      chainId: 'chain-1',
      since: SINCE,
      config: { commit: true, push: true, pr: true },
    })
    expect(out.ok).toBe(false)
    expect(out.url).toBeNull()
    // The gate passed and the publish verb refused — so the gate ran and
    // NOTHING ELSE did: no second attempt, no fallback, no guessed remote.
    expect(called).toEqual(['gate'])
    expect(out.gated).toBe(false)
  })

  it('no sentence it produces names a command, a path or a config key', async () => {
    const { deps: tail } = deps()
    for (const config of [
      { commit: true, push: false, pr: false },
      { commit: false, push: true, pr: true },
    ]) {
      const out = await runGitTail(tail, { threadId: 'th', config, chainId: 'chain-1', since: SINCE })
      if (out.detail === null) continue
      expect(out.detail).not.toMatch(/planflow-ai|flowconfig|`/)
    }
  })
})
