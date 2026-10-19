import { isExternalMcpServer, loadExternalMcpServers } from './external-mcp'

const home = '/Users/qa'
const projectRoot = '/repos/acme'
const userConfigPath = `${home}/.claude.json`
const projectMcpPath = `${projectRoot}/.mcp.json`

/** A readFileFn backed by an in-memory file table that throws ENOENT for
 *  anything absent — so a test asserts exactly which files were consulted. */
function files(table: Record<string, string>): { readFileFn: (p: string) => string } {
  return {
    readFileFn: (target: string) => {
      const contents = table[target]
      if (contents === undefined) throw new Error(`ENOENT: ${target}`)
      return contents
    },
  }
}

const deps = (table: Record<string, string>) => ({ homedirFn: () => home, ...files(table) })

describe('isExternalMcpServer', () => {
  it('admits a stdio server (command, type omitted or explicit)', () => {
    expect(isExternalMcpServer({ command: 'npx', args: ['-y', 'x'] })).toBe(true)
    expect(isExternalMcpServer({ type: 'stdio', command: 'node' })).toBe(true)
  })

  it('admits http/sse servers with a url', () => {
    expect(isExternalMcpServer({ type: 'http', url: 'https://mcp.vercel.com' })).toBe(true)
    expect(isExternalMcpServer({ type: 'sse', url: 'https://x/sse' })).toBe(true)
  })

  it('rejects malformed / non-file variants', () => {
    expect(isExternalMcpServer({ type: 'stdio' })).toBe(false) // no command
    expect(isExternalMcpServer({ type: 'http' })).toBe(false) // no url
    expect(isExternalMcpServer({ command: '' })).toBe(false) // empty command
    expect(isExternalMcpServer({ type: 'sdk', name: 'x' })).toBe(false) // needs a live instance
    expect(isExternalMcpServer(null)).toBe(false)
    expect(isExternalMcpServer('npx')).toBe(false)
  })
})

describe('loadExternalMcpServers — scopes', () => {
  it('reads a project .mcp.json stdio server', () => {
    const result = loadExternalMcpServers(
      projectRoot,
      deps({
        [projectMcpPath]: JSON.stringify({
          mcpServers: { vercel: { command: 'npx', args: ['-y', 'vercel-mcp'] } },
        }),
      }),
    )
    expect(result).toEqual({ vercel: { command: 'npx', args: ['-y', 'vercel-mcp'] } })
  })

  it('reads a user-scope server from ~/.claude.json', () => {
    const result = loadExternalMcpServers(
      projectRoot,
      deps({
        [userConfigPath]: JSON.stringify({
          mcpServers: { vercel: { type: 'http', url: 'https://mcp.vercel.com' } },
        }),
      }),
    )
    expect(result).toEqual({ vercel: { type: 'http', url: 'https://mcp.vercel.com' } })
  })

  it('reads a local-scope server from ~/.claude.json projects[root]', () => {
    const result = loadExternalMcpServers(
      projectRoot,
      deps({
        [userConfigPath]: JSON.stringify({
          projects: { [projectRoot]: { mcpServers: { vercel: { command: 'vercel-mcp' } } } },
        }),
      }),
    )
    expect(result).toEqual({ vercel: { command: 'vercel-mcp' } })
  })

  it('later scope wins a name collision: local > project > user', () => {
    const result = loadExternalMcpServers(
      projectRoot,
      deps({
        [userConfigPath]: JSON.stringify({
          mcpServers: { vercel: { command: 'user' } },
          projects: { [projectRoot]: { mcpServers: { vercel: { command: 'local' } } } },
        }),
        [projectMcpPath]: JSON.stringify({ mcpServers: { vercel: { command: 'project' } } }),
      }),
    )
    expect(result).toEqual({ vercel: { command: 'local' } })
  })

  it('merges distinct servers across scopes', () => {
    const result = loadExternalMcpServers(
      projectRoot,
      deps({
        [userConfigPath]: JSON.stringify({ mcpServers: { a: { command: 'a' } } }),
        [projectMcpPath]: JSON.stringify({ mcpServers: { b: { command: 'b' } } }),
      }),
    )
    expect(result).toEqual({ a: { command: 'a' }, b: { command: 'b' } })
  })
})

describe('loadExternalMcpServers — fail-soft and safety', () => {
  it('returns empty when no config files exist', () => {
    expect(loadExternalMcpServers(projectRoot, deps({}))).toEqual({})
  })

  it('skips a malformed-JSON file rather than throwing', () => {
    expect(
      loadExternalMcpServers(projectRoot, deps({ [projectMcpPath]: '{ not json' })),
    ).toEqual({})
  })

  it('drops the reserved `flow` name so a user server cannot shadow the board tools', () => {
    const result = loadExternalMcpServers(
      projectRoot,
      deps({
        [projectMcpPath]: JSON.stringify({
          mcpServers: { flow: { command: 'evil' }, vercel: { command: 'ok' } },
        }),
      }),
    )
    expect(result).toEqual({ vercel: { command: 'ok' } })
  })

  it('skips malformed server entries but keeps valid siblings', () => {
    const result = loadExternalMcpServers(
      projectRoot,
      deps({
        [projectMcpPath]: JSON.stringify({
          mcpServers: { broken: { type: 'http' }, good: { command: 'x' } },
        }),
      }),
    )
    expect(result).toEqual({ good: { command: 'x' } })
  })

  it('reads the project .mcp.json off the REGISTERED project, not a worktree cwd', () => {
    // The whole point: the session's cwd is a worktree, but we key on the
    // project root — so a worktree-relative path is never consulted.
    const worktree = '/repos/.worktrees/acme-thread'
    const result = loadExternalMcpServers(
      projectRoot,
      deps({ [`${worktree}/.mcp.json`]: JSON.stringify({ mcpServers: { x: { command: 'x' } } }) }),
    )
    expect(result).toEqual({})
  })
})
