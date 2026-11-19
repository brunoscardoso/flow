import type { Query } from '@anthropic-ai/claude-agent-sdk'

import type { QueryFunction } from '../agent/agent-manager'
import { NOT_ANSWERING } from './connector-model'
import { ConnectorStatusService, ConnectorStatusTimeout } from './connector-status'

function fakeQuery(statusImpl: () => Promise<unknown>) {
  const closed = { value: false }
  const query = {
    mcpServerStatus: statusImpl,
    reconnectMcpServer: async () => undefined,
    close: () => {
      closed.value = true
    },
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }),
  } as unknown as Query
  return { query, closed }
}

const context = { projectRoot: '/repo', configDir: '/accounts/a', env: { CLAUDE_CONFIG_DIR: '/accounts/a' } }

describe('ConnectorStatusService', () => {
  it('opens one status-only query per account and project, with the session’s servers', async () => {
    const calls: Array<Parameters<QueryFunction>[0]> = []
    const fake = fakeQuery(async () => [{ name: 'linear', status: 'connected' }])
    const service = new ConnectorStatusService({
      queryFn: async () => (params) => {
        calls.push(params)
        return fake.query
      },
      loadServers: () => ({ linear: { type: 'http', url: 'https://x.y' } }),
      setTimer: () => 0,
      clearTimer: () => undefined,
    })
    await Promise.all([service.status(context), service.status(context)])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.options).toMatchObject({
      cwd: '/repo',
      settingSources: ['user', 'project', 'local'],
      env: { CLAUDE_CONFIG_DIR: '/accounts/a' },
      mcpServers: { linear: { type: 'http', url: 'https://x.y' } },
    })
  })

  it('asks a chat’s live query instead of opening one', async () => {
    const live = fakeQuery(async () => [{ name: 'live', status: 'connected' }])
    let opened = 0
    const service = new ConnectorStatusService({
      queryFn: async () => () => {
        opened += 1
        return fakeQuery(async () => []).query
      },
      loadServers: () => ({}),
      liveQueryFor: (threadId) => (threadId === 't1' ? live.query : null),
    })
    expect(await service.status(context, 't1')).toEqual([{ name: 'live', status: 'connected' }])
    expect(opened).toBe(0)
  })

  it('times out, and closes the held query so the next read starts fresh', async () => {
    const fake = fakeQuery(() => new Promise(() => undefined))
    const service = new ConnectorStatusService({
      queryFn: async () => () => fake.query,
      loadServers: () => ({}),
      timeoutMs: 10,
      idleMs: 60_000,
    })
    await expect(service.status(context)).rejects.toBeInstanceOf(ConnectorStatusTimeout)
    expect(fake.closed.value).toBe(true)
    service.closeAll()
  })
})

describe('ConnectorStatusService — a freshly opened query', () => {
  it('waits for servers still starting, so the first answer is not all "pending"', async () => {
    const answers = [
      [{ name: 'stub', status: 'pending' }],
      [{ name: 'stub', status: 'pending' }],
      [{ name: 'stub', status: 'connected', tools: [{ name: 'search' }] }],
    ]
    let reads = 0
    const fake = fakeQuery(async () => answers[Math.min(reads++, answers.length - 1)])
    let clock = 0
    const service = new ConnectorStatusService({
      queryFn: async () => () => fake.query,
      loadServers: () => ({}),
      now: () => clock,
      pollMs: 1,
      settleMs: 1_000,
      idleMs: 60_000,
    })
    expect(await service.status(context)).toEqual([{ name: 'stub', status: 'connected', tools: [{ name: 'search' }] }])
    expect(reads).toBe(3)
    // Once the settle window has passed, a server still pending is not going to
    // answer: it is reported as failed, not "Starting" for ever.
    clock = 5_000
    answers.push([{ name: 'stub', status: 'pending' }, { name: 'ok', status: 'connected' }])
    reads = 3
    expect(await service.status(context)).toEqual([
      { name: 'stub', status: 'failed', error: NOT_ANSWERING },
      { name: 'ok', status: 'connected' },
    ])
    expect(reads).toBe(4)
    // A reconnect starts its window again, so the next read waits for it.
    await service.reconnect(context, 'stub')
    answers.push([{ name: 'stub', status: 'pending' }], [{ name: 'stub', status: 'connected' }])
    reads = 4
    expect(await service.status(context)).toEqual([{ name: 'stub', status: 'connected' }])
    service.closeAll()
  })

  it('asks a chat’s live query once, pending or not', async () => {
    let reads = 0
    const live = fakeQuery(async () => {
      reads += 1
      return [{ name: 'stub', status: 'pending' }]
    })
    const service = new ConnectorStatusService({
      queryFn: async () => () => fakeQuery(async () => []).query,
      loadServers: () => ({}),
      liveQueryFor: () => live.query,
      pollMs: 1,
    })
    expect(await service.status(context, 't1')).toEqual([{ name: 'stub', status: 'pending' }])
    expect(reads).toBe(1)
  })
})
