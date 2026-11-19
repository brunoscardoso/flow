import type { Query } from '@anthropic-ai/claude-agent-sdk'

import type { ConnectorChangeEvent } from '../../shared/connectors'
import { ConnectorSignIn, ConnectorSignInUnavailable, mcpAuthenticate, type ConnectorSignInDeps } from './connector-sign-in'

const context = { projectRoot: '/repo', configDir: '/accounts/a', env: undefined }
const web = { name: 'linear', transport: 'web' as const }

interface FakeQueryOptions {
  auth?: unknown
  statuses?: () => Array<{ name: string; status: string }>
  withAuthMethods?: boolean
}

function fakeQuery(options: FakeQueryOptions = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const query: Record<string, unknown> = {
    mcpServerStatus: async () => {
      calls.push(['status'])
      return options.statuses?.() ?? [{ name: 'linear', status: 'needs-auth' }]
    },
    reconnectMcpServer: async (name: string) => void calls.push(['reconnect', name]),
  }
  if (options.withAuthMethods !== false) {
    query['mcpAuthenticate'] = async (...args: unknown[]) => {
      calls.push(['authenticate', ...args])
      return options.auth ?? { authUrl: 'https://auth.linear.app/authorize?x=1', requiresUserAction: true, callbackExpected: true }
    }
    query['mcpClearAuth'] = async (name: string) => void calls.push(['clearAuth', name])
  }
  return { query: query as unknown as Query, calls }
}

/** Timers run by hand: `tick()` fires every timer due by then. */
function manualTimers() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      id += 1
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (handle: unknown) => void timers.delete(handle as number),
    async advance(ms: number) {
      now += ms
      for (const [key, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(key)
          timer.fn()
        }
      }
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    },
    pending: () => timers.size,
  }
}

function harness(query: Query, overrides: Partial<ConnectorSignInDeps> = {}) {
  const opened: string[] = []
  const changes: ConnectorChangeEvent[] = []
  const timers = manualTimers()
  const signIn = new ConnectorSignIn({
    queryFor: async () => query,
    openExternal: async (url) => void opened.push(url),
    onChanged: (change) => void changes.push(change),
    pollMs: 2_000,
    maxWaitMs: 10_000,
    callTimeoutMs: 1_000_000,
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  })
  return { signIn, opened, changes, timers }
}

describe('mcpAuthenticate adapter', () => {
  it('throws the sentence error when the runtime lacks the method', async () => {
    const { query } = fakeQuery({ withAuthMethods: false })
    await expect(mcpAuthenticate(query, 'linear')).rejects.toBeInstanceOf(ConnectorSignInUnavailable)
  })

  it('passes no redirect address', async () => {
    const { query, calls } = fakeQuery()
    await mcpAuthenticate(query, 'linear')
    expect(calls).toEqual([['authenticate', 'linear']])
  })
})

describe('ConnectorSignIn', () => {
  it('answers a sentence (no throw, no browser) when the methods are missing', async () => {
    const { query } = fakeQuery({ withAuthMethods: false })
    const { signIn, opened } = harness(query)
    const answer = await signIn.signIn(context, web)
    expect(answer).toEqual({ ok: false, reason: new ConnectorSignInUnavailable().message })
    expect(opened).toEqual([])
  })

  it('refuses a program connector with a sentence', async () => {
    const { query, calls } = fakeQuery()
    const { signIn } = harness(query)
    const answer = await signIn.signIn(context, { name: 'local', transport: 'program' })
    expect(answer.ok).toBe(false)
    expect(calls).toEqual([])
  })

  it('opens the browser, polls, and stops on connected: reconnects and broadcasts', async () => {
    let connected = false
    const { query, calls } = fakeQuery({ statuses: () => [{ name: 'linear', status: connected ? 'connected' : 'needs-auth' }] })
    const { signIn, opened, changes, timers } = harness(query)
    expect(await signIn.signIn(context, web)).toEqual({ ok: true, state: 'waiting' })
    expect(opened).toEqual(['https://auth.linear.app/authorize?x=1'])
    expect(signIn.isWaiting(context, 'linear')).toBe(true)

    await timers.advance(2_000)
    expect(calls.filter(([verb]) => verb === 'status')).toHaveLength(1)
    expect(changes).toEqual([])

    connected = true
    await timers.advance(2_000)
    expect(calls).toContainEqual(['reconnect', 'linear'])
    expect(changes).toEqual([{ projectRoot: '/repo', signIn: { name: 'linear', outcome: 'connected' } }])
    expect(signIn.isWaiting(context, 'linear')).toBe(false)

    const polls = calls.filter(([verb]) => verb === 'status').length
    await timers.advance(10_000)
    expect(calls.filter(([verb]) => verb === 'status')).toHaveLength(polls)
    expect(timers.pending()).toBe(0)
  })

  it('gives up after the wait and says so', async () => {
    const { query } = fakeQuery()
    const { signIn, changes, timers } = harness(query)
    await signIn.signIn(context, web, 't1')
    for (let i = 0; i < 6; i += 1) await timers.advance(2_000)
    expect(changes).toEqual([{ projectRoot: '/repo', threadId: 't1', signIn: { name: 'linear', outcome: 'timed-out' } }])
    expect(timers.pending()).toBe(0)
  })

  it('stops polling when cancelled', async () => {
    const { query, calls } = fakeQuery()
    const { signIn, changes, timers } = harness(query)
    await signIn.signIn(context, web)
    signIn.cancel(context, 'linear')
    await timers.advance(20_000)
    expect(calls.filter(([verb]) => verb === 'status')).toEqual([])
    expect(changes).toEqual([{ projectRoot: '/repo', signIn: { name: 'linear', outcome: 'cancelled' } }])
  })

  it('a Claude.ai connector opens the address and does not poll', async () => {
    const { query } = fakeQuery({ auth: { authUrl: 'https://claude.ai/settings/connectors', requiresUserAction: true, callbackExpected: false } })
    const { signIn, opened, timers } = harness(query)
    expect(await signIn.signIn(context, { name: 'claude.ai Linear', transport: 'claudeai' })).toEqual({
      ok: true,
      state: 'finish-in-browser',
    })
    expect(opened).toHaveLength(1)
    expect(timers.pending()).toBe(0)
  })

  it('an already signed-in connector reconnects and answers connected', async () => {
    const { query, calls } = fakeQuery({ auth: { requiresUserAction: false, callbackExpected: true } })
    const { signIn, opened } = harness(query)
    expect(await signIn.signIn(context, web)).toEqual({ ok: true, state: 'connected' })
    expect(opened).toEqual([])
    expect(calls).toContainEqual(['reconnect', 'linear'])
  })

  it('never opens an address that is not a web address', async () => {
    const { query } = fakeQuery({ auth: { authUrl: 'file:///etc/passwd', requiresUserAction: true, callbackExpected: true } })
    const { signIn, opened } = harness(query)
    expect((await signIn.signIn(context, web)).ok).toBe(false)
    expect(opened).toEqual([])
  })

  it('sign out without a literal confirmation does nothing', async () => {
    const { query, calls } = fakeQuery()
    const { signIn, changes } = harness(query)
    for (const confirmed of [undefined, 'true', 1, {}]) {
      expect((await signIn.signOut(context, web, confirmed)).ok).toBe(false)
    }
    expect(calls).toEqual([])
    expect(changes).toEqual([])
  })

  it('sign out with confirmation clears the sign-in, reconnects and broadcasts', async () => {
    const { query, calls } = fakeQuery()
    const { signIn, changes } = harness(query)
    expect(await signIn.signOut(context, web, true)).toEqual({ ok: true })
    expect(calls).toEqual([
      ['clearAuth', 'linear'],
      ['reconnect', 'linear'],
    ])
    expect(changes).toEqual([{ projectRoot: '/repo' }])
  })
})
