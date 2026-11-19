import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'

import { loadScopedExternalMcpServers } from '../agent/external-mcp'
import { nodeConnectorWriterFs, writeConnectorEntry } from './connector-config-writer'

import { ConnectorService, connectorToolSplits, toolPrefixName, type ConnectorServiceDeps } from './connector-service'
import { ConnectorStatusTimeout } from './connector-status'

function harness(overrides: Partial<ConnectorServiceDeps> = {}) {
  const off = new Map<string, string[]>()
  const marks = new Map<string, string[]>()
  const changed: unknown[] = []
  const toggles: unknown[] = []
  const writes: unknown[] = []
  const deps: ConnectorServiceDeps = {
    status: {
      status: async () => [{ name: 'linear', status: 'connected', source: 'user' } as McpServerStatus],
      reconnect: async () => undefined,
      close: () => undefined,
      closeAll: () => undefined,
    },
    contextFor: () => ({ ok: true, configDir: '/accounts/a', env: undefined }),
    loadScoped: () => ({ linear: { scope: 'user', config: { type: 'http', url: 'https://mcp.linear.app' } } }),
    threads: {
      getThread: (id) => (id === 't1' ? { projectRoot: '/repo' } : null),
      getConnectorsOff: (id) => off.get(id) ?? [],
      setConnectorsOff: (id, names) => void off.set(id, [...names]),
    },
    askFirst: {
      get: (account, connector) => marks.get(`${account}::${connector}`) ?? [],
      set: (account, connector, tool, on) => {
        const key = `${account}::${connector}`
        const next = new Set(marks.get(key) ?? [])
        if (on) next.add(tool)
        else next.delete(tool)
        marks.set(key, [...next])
      },
    },
    applyThreadConnector: async (...args) => void toggles.push(args),
    onChanged: (change) => void changed.push(change),
    resolveIcon: async () => null,
    signIn: {
      signIn: async () => ({ ok: true, state: 'waiting' }),
      signOut: async () => ({ ok: true }),
      cancel: () => ({ ok: true }),
      dispose: () => undefined,
    },
    write: async (target, change) => {
      writes.push([target, change])
      return { ok: true }
    },
    ...overrides,
  }
  return { service: new ConnectorService(deps), off, marks, changed, toggles, writes }
}

describe('ConnectorService', () => {
  it('lists with the chat overlay and ask-first marks', async () => {
    const { service, off, marks } = harness()
    off.set('t1', ['linear'])
    marks.set('/accounts/a::linear', ['search'])
    const answer = await service.listConnectors('/repo', 't1')
    expect(answer.error).toBeUndefined()
    expect(answer.entries).toEqual([
      expect.objectContaining({ name: 'linear', status: 'off', offInThread: true, askFirst: ['search'] }),
    ])
  })

  it('falls back to the files with a sentence when status times out', async () => {
    const { service } = harness({
      status: {
        status: async () => {
          throw new ConnectorStatusTimeout()
        },
        reconnect: async () => undefined,
        close: () => undefined,
        closeAll: () => undefined,
      },
    })
    const answer = await service.listConnectors('/repo')
    expect(answer.entries).toEqual([expect.objectContaining({ name: 'linear', status: 'pending' })])
    expect(answer.error).toMatch(/took too long/)
  })

  it('removes only with a literal true confirmation', async () => {
    const { service, writes } = harness()
    expect(await service.remove('/repo', 'account', 'linear', 'true')).toMatchObject({ ok: false })
    expect(await service.remove('/repo', 'account', 'linear', undefined)).toMatchObject({ ok: false })
    expect(writes).toEqual([])
    expect(await service.remove('/repo', 'account', 'linear', true)).toEqual({ ok: true })
    expect(writes).toEqual([[{ kind: 'account', configDir: '/accounts/a' }, { remove: 'linear', confirmed: true }]])
  })

  it('stores a chat’s off list, toggles live and never turns Flow off', async () => {
    const { service, off, toggles, changed } = harness()
    expect(await service.setForThread('t1', 'linear', false)).toEqual({ ok: true })
    expect(off.get('t1')).toEqual(['linear'])
    expect(toggles).toEqual([['t1', 'linear', false]])
    expect(changed).toEqual([{ projectRoot: '/repo', threadId: 't1' }])
    expect(await service.setForThread('t1', 'flow', false)).toMatchObject({ ok: false })
    expect(await service.setForThread('t1', 'linear', true)).toEqual({ ok: true })
    expect(off.get('t1')).toEqual([])
  })

  it('lists a connector the chat denied (its session does not report it) from the project status, as off', async () => {
    const asked: Array<string | undefined> = []
    const { service, off } = harness({
      status: {
        status: async (_context, threadId) => {
          asked.push(threadId)
          // The chat's live session runs with Canva denied, so it is absent there.
          // No config file lists a Claude.ai connector, so only the project status can.
          const linear = { name: 'linear', status: 'connected', source: 'user' } as McpServerStatus
          const canva = { name: 'claude.ai Canva', status: 'connected', source: 'claudeai' } as unknown as McpServerStatus
          return threadId === 't1' ? [linear] : [linear, canva]
        },
        reconnect: async () => undefined,
        close: () => undefined,
        closeAll: () => undefined,
      },
    })
    off.set('t1', ['claude.ai Canva'])
    const answer = await service.listConnectors('/repo', 't1')
    // The positive first: the chat's own status was asked.
    expect(asked[0]).toBe('t1')
    // …and the denied connector still lists, off in this chat, with its project status.
    expect(asked).toContain(undefined)
    expect(answer.entries.find((entry) => entry.name === 'claude.ai Canva')).toMatchObject({ status: 'off', offInThread: true })
    expect(answer.entries.find((entry) => entry.name === 'linear')).toMatchObject({ status: 'connected', offInThread: false })
  })

  it('answers the permission lookup by the tool-name form of the server', () => {
    const { service } = harness()
    expect(service.isAskFirst('t1', 'mcp__claude_ai_Linear__save_issue')).toBe(false)
    service.setAskFirst('/repo', 'claude.ai Linear', 'save_issue', true)
    expect(service.isAskFirst('t1', 'mcp__claude_ai_Linear__save_issue')).toBe(true)
    expect(service.isAskFirst('t1', 'mcp__claude_ai_Linear__list_issues')).toBe(false)
    expect(service.isAskFirst('t1', 'Bash')).toBe(false)
    expect(service.isAskFirst('nope', 'mcp__claude_ai_Linear__save_issue')).toBe(false)
  })
})

describe('tool names', () => {
  it('normalises server names and splits at every candidate', () => {
    expect(toolPrefixName('claude.ai Linear')).toBe('claude_ai_Linear')
    expect(connectorToolSplits('mcp__a__b__c')).toEqual([
      { server: 'a', tool: 'b__c' },
      { server: 'a__b', tool: 'c' },
    ])
    expect(connectorToolSplits('Read')).toEqual([])
  })

  it('serves an icon only for a listed connector, without opening a status query', async () => {
    let statusReads = 0
    const asked: unknown[] = []
    const { service } = harness({
      status: {
        status: async () => {
          statusReads += 1
          return [{ name: 'linear', status: 'connected', source: 'user' } as McpServerStatus]
        },
        reconnect: async () => undefined,
        close: () => undefined,
        closeAll: () => undefined,
      },
      resolveIcon: async (entry, theme) => {
        asked.push([entry.name, theme])
        return 'data:image/png;base64,AA=='
      },
    })
    expect(await service.icon('/repo', 'linear', 'dark')).toEqual({ dataUri: null })
    expect(statusReads).toBe(0)
    await service.listConnectors('/repo')
    expect(await service.icon('/repo', 'linear', 'dark')).toEqual({ dataUri: 'data:image/png;base64,AA==' })
    expect(asked).toEqual([['linear', 'dark']])
    expect(statusReads).toBe(1)
  })

  it('sign out without the literal confirmation never reaches the sign-in adapter', async () => {
    const outs: unknown[] = []
    const { service } = harness({
      signIn: {
        signIn: async () => ({ ok: true, state: 'waiting' }),
        signOut: async (...args) => {
          outs.push(args)
          return { ok: true }
        },
        cancel: () => ({ ok: true }),
        dispose: () => undefined,
      },
    })
    expect((await service.signOut('/repo', 'linear', 'yes')).ok).toBe(false)
    expect(outs).toEqual([])
    expect(await service.signOut('/repo', 'linear', true)).toEqual({ ok: true })
    expect(outs).toHaveLength(1)
  })
})

describe('ConnectorService over scratch config folders (never the real ones)', () => {
  // The REAL scoped read and the REAL writer, over a temp account folder and a
  // temp project — only the runtime status is stubbed, as the session reports it.
  let root: string
  let configDir: string
  let project: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'flow-connector-service-'))
    configDir = join(root, 'account')
    project = join(root, 'repo')
    mkdirSync(configDir)
    mkdirSync(project)
    writeFileSync(
      join(configDir, '.claude.json'),
      JSON.stringify({
        mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
        projects: { [project]: { mcpServers: { scratch: { command: 'node', args: ['s.js'] } } } },
      }),
    )
    writeFileSync(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { neon: { command: 'npx', args: ['neon'] } } }))
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  function real(statuses: McpServerStatus[] | null) {
    return harness({
      contextFor: () => ({ ok: true, configDir, env: undefined }),
      loadScoped: (p, dir) => loadScopedExternalMcpServers(p, dir, { homedirFn: () => join(root, 'not-home') }),
      threads: {
        getThread: (id) => (id === 't1' ? { projectRoot: project } : null),
        getConnectorsOff: () => [],
        setConnectorsOff: () => undefined,
      },
      status: {
        status: async () => {
          if (statuses === null) throw new Error('no runtime')
          return statuses
        },
        reconnect: async () => undefined,
        close: () => undefined,
        closeAll: () => undefined,
      },
      write: (target, change) => writeConnectorEntry(target, change, { ...nodeConnectorWriterFs, homedir: () => join(root, 'not-home') }),
    })
  }

  it('names each file connector’s source and scope, and takes the status the runtime reports', async () => {
    const { service } = real([
      { name: 'linear', status: 'connected', source: 'dynamic', tools: [{ name: 'save_issue' }] } as unknown as McpServerStatus,
      { name: 'neon', status: 'failed', error: 'spawn ENOENT', source: 'dynamic' } as unknown as McpServerStatus,
      { name: 'scratch', status: 'needs-auth', source: 'dynamic' } as unknown as McpServerStatus,
      { name: 'claude.ai Gmail', status: 'connected', source: 'claudeai' } as unknown as McpServerStatus,
    ])
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const answer = await service.listConnectors(project, 't1')
    warn.mockRestore()

    expect(answer.error).toBeUndefined()
    const byName = new Map(answer.entries.map((entry) => [entry.name, entry]))
    expect(byName.get('linear')).toMatchObject({ source: 'account', scope: 'account', status: 'connected', transport: 'web', removable: true })
    expect(byName.get('linear')?.tools.map((tool) => tool.name)).toEqual(['save_issue'])
    expect(byName.get('neon')).toMatchObject({ source: 'project', scope: 'project-shared', status: 'failed', transport: 'program' })
    // The runtime's own failure text (it can name a program) never reaches the entry.
    expect(byName.get('neon')?.error ?? '').not.toContain('ENOENT')
    expect(byName.get('scratch')).toMatchObject({ source: 'account', scope: 'project-local', status: 'needs-auth' })
    expect(byName.get('claude.ai Gmail')).toMatchObject({ source: 'claudeai', removable: false })
    expect(byName.get('claude.ai Gmail')?.scope).toBeUndefined()
  })

  it('without a runtime answer, lists the files alone as pending', async () => {
    const { service } = real(null)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const answer = await service.listConnectors(project)
    warn.mockRestore()
    expect(answer.error).toEqual(expect.any(String))
    expect(answer.entries.map((entry) => [entry.name, entry.status]).sort()).toEqual([
      ['linear', 'pending'],
      ['neon', 'pending'],
      ['scratch', 'pending'],
    ])
  })

  it('adds and removes through the account’s own file, keeping its other keys', async () => {
    const { service } = real(null)
    const path = join(configDir, '.claude.json')
    expect(await service.add(project, 'account', 'figma', { type: 'http', url: 'https://mcp.figma.com/mcp' })).toEqual({ ok: true })
    const added = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>
    expect(Object.keys(added)).toEqual(['mcpServers', 'projects'])
    expect(Object.keys(added['mcpServers'] ?? {})).toEqual(['linear', 'figma'])

    const before = readFileSync(path, 'utf8')
    // The positive first: figma is in the file. Unconfirmed → byte-identical.
    expect(before).toContain('"figma"')
    expect(await service.remove(project, 'account', 'figma', undefined)).toMatchObject({ ok: false })
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(await service.remove(project, 'account', 'figma', true)).toEqual({ ok: true })
    expect(Object.keys((JSON.parse(readFileSync(path, 'utf8')) as Record<string, object>)['mcpServers'] ?? {})).toEqual(['linear'])
  })
})
