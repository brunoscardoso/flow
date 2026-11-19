// The suggestion gatherer — real files in a temp project, never a real
// account folder or checkout.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ConnectorEntry } from '../../shared/connectors'
import {
  ConnectorSuggester,
  MAX_FILE_BYTES,
  MAX_SCAN_FILES,
  SCAN_TTL_MS,
  gitConfigPathOf,
  readRemoteUrls,
  scanProject,
  scanTargets,
  type ProjectScan,
} from './connector-suggest'

function entry(overrides: Partial<ConnectorEntry> = {}): ConnectorEntry {
  return {
    name: 'github',
    displayName: 'GitHub',
    source: 'account',
    transport: 'web',
    status: 'needs-auth',
    tools: [],
    iconHints: [],
    removable: true,
    scope: 'account',
    askFirst: [],
    ...overrides,
  }
}

describe('connector-suggest', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-connector-suggest-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function write(rel: string, text: string): void {
    const path = join(dir, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  it('reads the remotes of a plain checkout from its config file', async () => {
    write('repo/.git/config', '[remote "origin"]\n\turl = git@github.com:acme/web.git\n')
    expect(await readRemoteUrls(join(dir, 'repo'))).toEqual(['git@github.com:acme/web.git'])
  })

  it('follows a worktree .git file to the shared config', async () => {
    write('main/.git/config', '[remote "origin"]\n\turl = https://gitlab.com/acme/web.git\n')
    write('main/.git/worktrees/feat/commondir', '../..\n')
    write('wt/.git', `gitdir: ${join(dir, 'main/.git/worktrees/feat')}\n`)
    expect(await gitConfigPathOf(join(dir, 'wt'))).toBe(join(dir, 'main/.git/config'))
    expect(await readRemoteUrls(join(dir, 'wt'))).toEqual(['https://gitlab.com/acme/web.git'])
  })

  it('answers no remotes when there is no repository', async () => {
    mkdirSync(join(dir, 'plain'))
    expect(await readRemoteUrls(join(dir, 'plain'))).toEqual([])
  })

  it('reads only the bounded set of files, one level deep, capped in number and size', async () => {
    write('package.json', '{"dependencies":{"@sentry/node":"7"}}')
    write('src/index.ts', 'sentry')
    write('deploy/app.yaml', 'x')
    write('deploy/nested/deep.yaml', 'x')
    for (let i = 0; i < MAX_SCAN_FILES + 5; i++) write(`k8s/f${String(i).padStart(2, '0')}.yaml`, 'x')
    write('README.md', 'a'.repeat(MAX_FILE_BYTES + 1000))
    const targets = await scanTargets(dir)
    expect(targets).toContain('package.json')
    expect(targets).toContain('deploy/app.yaml')
    expect(targets.length).toBe(MAX_SCAN_FILES)
    expect(targets).not.toContain('src/index.ts')
    expect(targets).not.toContain('deploy/nested/deep.yaml')
    const scan = await scanProject(dir)
    const readme = scan.files.find((file) => file.path === 'README.md')
    expect(readme?.text.length).toBe(MAX_FILE_BYTES)
  })

  it('suggests from the scan, caches it for a minute, and keeps "Not now"', async () => {
    let now = 1_000
    let scans = 0
    const kept = new Map<string, string[]>()
    const scan = async (): Promise<ProjectScan> => {
      scans += 1
      return { remoteUrls: ['git@github.com:acme/web.git'], files: [] }
    }
    const suggester = new ConnectorSuggester(
      {
        entriesFor: async () => [entry()],
        usedToolRows: () => [],
        dismissed: { get: (root) => kept.get(root) ?? [], set: (root, fps) => void kept.set(root, [...fps]) },
        now: () => now,
      },
      scan,
    )
    const first = await suggester.suggest('/p')
    expect(first.suggestions).toEqual([
      { name: 'github', displayName: 'GitHub', reasonKind: 'repo', reason: 'This project’s repository is on GitHub.' },
    ])
    await suggester.suggest('/p')
    expect(scans).toBe(1)
    now += SCAN_TTL_MS
    await suggester.suggest('/p')
    expect(scans).toBe(2)

    expect(suggester.dismiss('/p', ['github|repo'])).toEqual({ ok: true })
    expect(kept.get('/p')).toEqual(['github|repo'])
    expect((await suggester.suggest('/p')).suggestions).toEqual([])
  })

  it('does not scan at all when nothing asks to sign in', async () => {
    let scans = 0
    const suggester = new ConnectorSuggester(
      {
        entriesFor: async () => [entry({ status: 'connected' }), entry({ name: 'x', source: 'plugin' })],
        usedToolRows: () => [],
        dismissed: { get: () => [], set: () => undefined },
      },
      async () => {
        scans += 1
        return { remoteUrls: [], files: [] }
      },
    )
    expect(await suggester.suggest('/p')).toEqual({ suggestions: [] })
    expect(scans).toBe(0)
  })
})
