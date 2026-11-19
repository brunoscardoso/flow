// The writer of connector entries in Claude's own files. Every test works in a
// temp folder with an injected fs whose home is that folder — never the
// developer's real settings files.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  nodeConnectorWriterFs,
  writeConnectorEntry,
  type ConnectorChange,
  type ConnectorWriterFs,
} from './connector-config-writer'

let dir: string
let fs: ConnectorWriterFs

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flow-connector-writer-'))
  fs = { ...nodeConnectorWriterFs, homedir: () => join(dir, 'home-that-must-not-be-used') }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const linear = { type: 'http' as const, url: 'https://mcp.linear.app/mcp' }

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('writeConnectorEntry', () => {
  it('adds an account connector and keeps every other key, in order', async () => {
    const path = join(dir, '.claude.json')
    writeFileSync(
      path,
      JSON.stringify({ numStartups: 3, mcpServers: { neon: { command: 'npx', args: ['neon'] } }, zeta: { a: 1 } }, null, 2) + '\n',
    )
    chmodSync(path, 0o600)

    const result = await writeConnectorEntry({ kind: 'account', configDir: dir }, { add: { name: 'linear', config: linear } }, fs)

    expect(result).toEqual({ ok: true })
    const written = readJson(path)
    expect(Object.keys(written)).toEqual(['numStartups', 'mcpServers', 'zeta'])
    expect(Object.keys(written['mcpServers'] as object)).toEqual(['neon', 'linear'])
    expect((written['mcpServers'] as Record<string, unknown>)['linear']).toEqual(linear)
    expect(written['zeta']).toEqual({ a: 1 })
    // Permissions kept, newline kept, no temp file left behind.
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('adds a this-project-only connector inside the project entry', async () => {
    const path = join(dir, '.claude.json')
    writeFileSync(path, JSON.stringify({ projects: { '/repo': { allowedTools: [] }, '/other': {} } }))

    const result = await writeConnectorEntry(
      { kind: 'project-local', configDir: dir, projectRoot: '/repo' },
      { add: { name: 'linear', config: linear } },
      fs,
    )

    expect(result).toEqual({ ok: true })
    const projects = readJson(path)['projects'] as Record<string, Record<string, unknown>>
    expect(Object.keys(projects['/repo'] ?? {})).toEqual(['allowedTools', 'mcpServers'])
    expect(projects['/repo']?.['mcpServers']).toEqual({ linear })
    expect(projects['/other']).toEqual({})
  })

  it("creates the project's shared list when there is none", async () => {
    const result = await writeConnectorEntry(
      { kind: 'project-shared', projectRoot: dir },
      { add: { name: 'linear', config: linear } },
      fs,
    )
    expect(result).toEqual({ ok: true })
    expect(readJson(join(dir, '.mcp.json'))).toEqual({ mcpServers: { linear } })
  })

  it('removes only the named entry when confirmed', async () => {
    const path = join(dir, '.mcp.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { linear, neon: { command: 'npx' } } }, null, 4))

    const result = await writeConnectorEntry({ kind: 'project-shared', projectRoot: dir }, { remove: 'linear', confirmed: true }, fs)

    expect(result).toEqual({ ok: true })
    expect(readJson(path)).toEqual({ mcpServers: { neon: { command: 'npx' } } })
    // The file's own indent is kept.
    expect(readFileSync(path, 'utf8')).toContain('\n    "mcpServers"')
  })

  it('does nothing at all when a removal is not confirmed (forbidden-pattern #15)', async () => {
    const path = join(dir, '.mcp.json')
    const before = JSON.stringify({ mcpServers: { linear } })
    writeFileSync(path, before)
    // The positive first (#28): the entry is really in the file to be removed.
    expect(readJson(path)).toEqual({ mcpServers: { linear } })
    const reads: string[] = []
    const watched: ConnectorWriterFs = {
      ...fs,
      readFile: (p) => {
        reads.push(p)
        return fs.readFile(p)
      },
    }

    const unconfirmed = { remove: 'linear' } as unknown as ConnectorChange
    const falsy = { remove: 'linear', confirmed: 'yes' } as unknown as ConnectorChange
    expect(await writeConnectorEntry({ kind: 'project-shared', projectRoot: dir }, unconfirmed, watched)).toMatchObject({ ok: false })
    expect(await writeConnectorEntry({ kind: 'project-shared', projectRoot: dir }, falsy, watched)).toMatchObject({ ok: false })
    expect(reads).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(before)
    // …and the same call WITH the confirmation does remove it (allowed-pattern #28).
    expect(
      await writeConnectorEntry({ kind: 'project-shared', projectRoot: dir }, { remove: 'linear', confirmed: true }, watched),
    ).toEqual({ ok: true })
    expect(reads.length).toBeGreaterThan(0)
    expect(readJson(path)).toEqual({ mcpServers: {} })
  })

  it('refuses a file that does not parse, and leaves it alone', async () => {
    const path = join(dir, '.claude.json')
    writeFileSync(path, '{ "mcpServers": ')
    const result = await writeConnectorEntry({ kind: 'account', configDir: dir }, { add: { name: 'linear', config: linear } }, fs)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).not.toMatch(/\.claude\.json|\//)
    expect(readFileSync(path, 'utf8')).toBe('{ "mcpServers": ')
  })

  it('refuses when the file changed between the read and the write', async () => {
    const path = join(dir, '.claude.json')
    writeFileSync(path, JSON.stringify({ mcpServers: {} }))
    const racing: ConnectorWriterFs = {
      ...fs,
      writeFile: async (p, data, mode) => {
        await fs.writeFile(p, data, mode)
        // Claude Code writes the file while Flow is saving.
        writeFileSync(path, JSON.stringify({ mcpServers: {}, numStartups: 9 }))
      },
    }
    const result = await writeConnectorEntry({ kind: 'account', configDir: dir }, { add: { name: 'linear', config: linear } }, racing)
    expect(result.ok).toBe(false)
    expect(readJson(path)).toEqual({ mcpServers: {}, numStartups: 9 })
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses the reserved name, a bad name, a bad config and a duplicate', async () => {
    const target = { kind: 'project-shared' as const, projectRoot: dir }
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { linear } }))
    expect(await writeConnectorEntry(target, { add: { name: 'flow', config: linear } }, fs)).toMatchObject({ ok: false })
    expect(await writeConnectorEntry(target, { add: { name: 'has space', config: linear } }, fs)).toMatchObject({ ok: false })
    expect(
      await writeConnectorEntry(target, { add: { name: 'x', config: { type: 'http', url: '' } } }, fs),
    ).toMatchObject({ ok: false })
    expect(await writeConnectorEntry(target, { add: { name: 'linear', config: linear } }, fs)).toMatchObject({ ok: false })
    expect(readJson(join(dir, '.mcp.json'))).toEqual({ mcpServers: { linear } })
  })

  it('refuses to remove a connector that is not there', async () => {
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    expect(
      await writeConnectorEntry({ kind: 'project-shared', projectRoot: dir }, { remove: 'linear', confirmed: true }, fs),
    ).toMatchObject({ ok: false })
  })
})
