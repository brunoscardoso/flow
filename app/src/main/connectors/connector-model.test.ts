import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'

import type { ScopedExternalMcpServer } from '../agent/external-mcp'
import { buildConnectorList, displayNameOf, entryFromStatus, NOT_ANSWERING, NOT_ANSWERING_SENTENCE } from './connector-model'

const noOverlay = { askFirst: () => [] as string[] }

describe('displayNameOf', () => {
  it('prefers the server title, then strips Claude.ai and plugin prefixes, else title-cases', () => {
    expect(displayNameOf('linear', 'account', 'Linear')).toBe('Linear')
    expect(displayNameOf('claude.ai Gmail', 'claudeai', undefined)).toBe('Gmail')
    expect(displayNameOf('plugin:vercel:vercel', 'plugin', undefined)).toBe('Vercel')
    expect(displayNameOf('my-neon_db', 'account', undefined)).toBe('My Neon Db')
  })
})

describe('entryFromStatus', () => {
  it('maps a connected web connector without copying headers, env or the url path', () => {
    const status = {
      name: 'linear',
      status: 'connected',
      source: 'dynamic',
      config: { type: 'http', url: 'https://mcp.linear.app/mcp?token=secret', headers: { Authorization: 'Bearer x' } },
      serverInfo: {
        name: 'linear',
        version: '1',
        title: 'Linear',
        websiteUrl: 'https://linear.app',
        icons: [{ src: 'https://linear.app/icon.svg', mimeType: 'image/svg+xml', theme: 'dark' }, { src: 'file:///x' }],
      },
      tools: [{ name: 'search_issues', description: 'Search', annotations: { readOnly: true } }],
    } as unknown as McpServerStatus
    const files: Record<string, ScopedExternalMcpServer> = {
      linear: { scope: 'user', config: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
    }

    const entry = entryFromStatus(status, files, { offInThread: [], askFirst: () => ['search_issues'] })

    expect(entry).toEqual({
      name: 'linear',
      displayName: 'Linear',
      source: 'account',
      transport: 'web',
      status: 'connected',
      tools: [{ name: 'search_issues', description: 'Search', readOnly: true }],
      websiteUrl: 'https://linear.app',
      host: 'mcp.linear.app',
      iconHints: [{ src: 'https://linear.app/icon.svg', mimeType: 'image/svg+xml', theme: 'dark' }],
      removable: true,
      scope: 'account',
      offInThread: false,
      askFirst: ['search_issues'],
    })
    expect(JSON.stringify(entry)).not.toMatch(/secret|Bearer|token/)
  })

  it('a connector that never answered says so, in its own sentence, and stays failed', () => {
    const entry = entryFromStatus(
      { name: 'claude.ai ArgoCD DEV', status: 'failed', error: NOT_ANSWERING, source: 'claudeai' } as McpServerStatus,
      {},
      noOverlay,
    )
    expect(entry).toMatchObject({ status: 'failed', error: NOT_ANSWERING_SENTENCE })
    // The runtime's own error text is never shown.
    const other = entryFromStatus(
      { name: 'x', status: 'failed', error: 'spawn /usr/bin/x ENOENT', source: 'claudeai' } as McpServerStatus,
      {},
      noOverlay,
    )
    expect(other?.error).toBe('This connector could not start.')
  })

  it('skips Flow’s own server, shows Claude.ai and plugin connectors as not removable', () => {
    expect(entryFromStatus({ name: 'flow', status: 'connected', source: 'sdk' } as McpServerStatus, {}, noOverlay)).toBeNull()
    const claudeai = entryFromStatus(
      {
        name: 'claude.ai Gmail',
        status: 'needs-auth',
        source: 'claudeai',
        config: { type: 'claudeai-proxy', url: 'https://claude.ai/x', id: '1' },
      } as McpServerStatus,
      {},
      noOverlay,
    )
    expect(claudeai).toMatchObject({ displayName: 'Gmail', source: 'claudeai', transport: 'claudeai', removable: false })
    expect(claudeai?.error).toBe('This connector needs you to sign in on Claude.ai.')
    expect(claudeai?.host).toBeUndefined()
    const plugin = entryFromStatus(
      { name: 'plugin:vercel:vercel', status: 'connected', source: 'plugin' } as McpServerStatus,
      {},
      noOverlay,
    )
    expect(plugin).toMatchObject({ displayName: 'Vercel', source: 'plugin', removable: false })
  })

  it('a chat that turned a connector off sees it as off', () => {
    const entry = entryFromStatus(
      { name: 'neon', status: 'failed', error: 'spawn /usr/bin/x ENOENT', source: 'project' } as McpServerStatus,
      { neon: { scope: 'project', config: { command: 'npx' } } },
      { offInThread: ['neon'], askFirst: () => [] },
    )
    expect(entry).toMatchObject({ status: 'off', offInThread: true, transport: 'program', scope: 'project-shared' })
    expect(entry?.error).toBeUndefined()
  })
})

describe('buildConnectorList', () => {
  it('falls back to the files alone, as pending, when there is no status', () => {
    const list = buildConnectorList(
      null,
      { neon: { scope: 'local', config: { command: 'npx' } }, linear: { scope: 'project', config: { type: 'sse', url: 'https://a.b/c' } } },
      noOverlay,
    )
    expect(list.map((entry) => [entry.name, entry.status, entry.source, entry.scope])).toEqual([
      ['neon', 'pending', 'account', 'project-local'],
      ['linear', 'pending', 'project', 'project-shared'],
    ])
  })

  it('adds a configured connector the runtime did not report', () => {
    const list = buildConnectorList(
      [{ name: 'linear', status: 'connected', source: 'user' } as McpServerStatus],
      { linear: { scope: 'user', config: { type: 'http', url: 'https://x.y' } }, neon: { scope: 'user', config: { command: 'npx' } } },
      noOverlay,
    )
    expect(list.map((entry) => [entry.name, entry.status])).toEqual([
      ['linear', 'connected'],
      ['neon', 'pending'],
    ])
  })
})
