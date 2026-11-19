import type { ConnectorEntry } from '../../shared/connectors'
import { suggestionFingerprint } from '../../shared/connectors'
import {
  chatsUsing,
  containsWord,
  fileKindOf,
  filesReason,
  hostOfRemote,
  isSuggestionCandidate,
  isTopLevelScanFile,
  nameKeywords,
  remoteUrlsFromGitConfig,
  remoteWords,
  repoHostOf,
  repoReason,
  strongestFileMatch,
  suggestConnectors,
  usedReason,
} from './connector-suggest-model'

function entry(overrides: Partial<ConnectorEntry> = {}): ConnectorEntry {
  return {
    name: 'linear',
    displayName: 'Linear',
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

describe('remote URLs from a git config', () => {
  it('reads every remote url, in order, and nothing outside remote sections', () => {
    const text = [
      '[core]',
      '\trepositoryformatversion = 0',
      '\turl = https://not-a-remote.example/x',
      '[remote "origin"]',
      '\turl = git@github.com:acme/web.git',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[remote "upstream"]',
      '\turl = https://dev.azure.com/acme/Proj/_git/web',
      '\tpushurl = https://dev.azure.com/acme/Proj/_git/web',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\n')
    expect(remoteUrlsFromGitConfig(text)).toEqual([
      'git@github.com:acme/web.git',
      'https://dev.azure.com/acme/Proj/_git/web',
    ])
    expect(remoteUrlsFromGitConfig('[core]\n\tbare = false\n')).toEqual([])
  })

  it('finds the host of every remote form', () => {
    expect(hostOfRemote('https://github.com/acme/web.git')).toBe('github.com')
    expect(hostOfRemote('ssh://git@gitlab.example.com:2222/acme/web.git')).toBe('gitlab.example.com')
    expect(hostOfRemote('git@ssh.dev.azure.com:v3/acme/Proj/web')).toBe('ssh.dev.azure.com')
    expect(hostOfRemote('bitbucket.org:acme/web.git')).toBe('bitbucket.org')
    expect(hostOfRemote('/local/path/repo.git')).toBeNull()
  })

  it('maps a host to its service, and an unknown host to none', () => {
    expect(repoHostOf('dev.azure.com')?.label).toBe('Azure DevOps')
    expect(repoHostOf('ssh.dev.azure.com')?.label).toBe('Azure DevOps')
    expect(repoHostOf('acme.visualstudio.com')?.keyword).toBe('azure devops')
    expect(repoHostOf('github.com')?.label).toBe('GitHub')
    expect(repoHostOf('gitlab.com')?.label).toBe('GitLab')
    expect(repoHostOf('gitlab.acme.io')?.label).toBe('GitLab')
    expect(repoHostOf('bitbucket.org')?.label).toBe('Bitbucket')
    expect(repoHostOf('example.com')).toBeNull()
  })
})

describe('keywords from a name', () => {
  it('drops parentheses, generic words and short words', () => {
    expect(nameKeywords('Sentry MCP (prod)')).toEqual(['sentry'])
    expect(nameKeywords('Microsoft Learn Documentation')).toEqual([])
    expect(nameKeywords('claude.ai Atlassian Jira')).toEqual(['atlassian', 'jira'])
    expect(nameKeywords('Box API')).toEqual([])
  })

  it('drops a word that is part of the git remote', () => {
    const remote = remoteWords(['https://dev.azure.com/contoso/Payments/_git/web'])
    expect(remote.has('contoso')).toBe(true)
    expect(nameKeywords('Contoso Datadog', remote)).toEqual(['datadog'])
  })
})

describe('the project files', () => {
  it('reads only the named top-level files', () => {
    for (const name of ['package.json', 'pyproject.toml', 'requirements-dev.txt', 'docker-compose.prod.yml', 'Makefile', 'README.md', 'CLAUDE.md', '.env.example']) {
      expect(isTopLevelScanFile(name)).toBe(true)
    }
    expect(isTopLevelScanFile('index.ts')).toBe(false)
    expect(isTopLevelScanFile('.env')).toBe(false)
  })

  it('names the kind of each file', () => {
    expect(fileKindOf('.github/workflows/ci.yml')).toBe('deploy')
    expect(fileKindOf('helm/values.yaml')).toBe('deploy')
    expect(fileKindOf('docker-compose.yml')).toBe('deploy')
    expect(fileKindOf('package.json')).toBe('dependencies')
    expect(fileKindOf('requirements.txt')).toBe('dependencies')
    expect(fileKindOf('README.md')).toBe('docs')
    expect(fileKindOf('CLAUDE.md')).toBe('docs')
    expect(fileKindOf('Makefile')).toBe('files')
  })

  it('matches whole words only, ignoring case', () => {
    expect(containsWord('"@sentry/node": "^7"', 'sentry')).toBe(true)
    expect(containsWord('SENTRY_DSN=', 'sentry')).toBe(true) // an env name counts: `_` separates words
    expect(containsWord('sentry-dsn', 'Sentry')).toBe(true)
    expect(containsWord('sentryish', 'sentry')).toBe(false)
  })

  it('picks the strongest kind of file a keyword appears in', () => {
    const files = [
      { path: 'README.md', text: 'We report errors to Sentry.' },
      { path: 'deploy/app.yaml', text: 'sentry: enabled' },
    ]
    expect(strongestFileMatch(['sentry'], files)).toBe('deploy')
    expect(strongestFileMatch(['sentry'], files.slice(0, 1))).toBe('docs')
    expect(strongestFileMatch(['linear'], files)).toBeNull()
  })
})

describe('use in other chats', () => {
  it('counts distinct chats by the tool-name form of the connector', () => {
    const rows = [
      { threadId: 't1', toolName: 'mcp__claude_ai_Linear__list_issues' },
      { threadId: 't1', toolName: 'mcp__claude_ai_Linear__create_issue' },
      { threadId: 't2', toolName: 'mcp__claude_ai_Linear__list_issues' },
      { threadId: 't3', toolName: 'mcp__claude_ai_LinearX__list' },
    ]
    expect(chatsUsing('claude.ai Linear', rows)).toBe(2)
    expect(chatsUsing('sentry', rows)).toBe(0)
  })
})

describe('suggestConnectors', () => {
  const base = { remoteUrls: [] as string[], usedRows: [], files: [] }

  it('suggests only connectors that ask to sign in, never a plugin one', () => {
    expect(isSuggestionCandidate({ status: 'needs-auth', source: 'claudeai' })).toBe(true)
    expect(isSuggestionCandidate({ status: 'disabled', source: 'claudeai' })).toBe(false)
    expect(isSuggestionCandidate({ status: 'needs-auth', source: 'plugin' })).toBe(false)
    const files = [{ path: 'README.md', text: 'Linear tracks our issues.' }]
    const out = suggestConnectors({
      ...base,
      files,
      entries: [
        entry(),
        entry({ name: 'p', displayName: 'Linear Plugin', source: 'plugin' }),
        entry({ name: 'c', displayName: 'Linear Connected', status: 'connected' }),
      ],
    })
    expect(out.map((s) => s.name)).toEqual(['linear'])
  })

  it('gives each connector its strongest reason, and ranks repo, used, files', () => {
    const out = suggestConnectors({
      entries: [
        entry({ name: 'sentry', displayName: 'Sentry' }),
        entry({ name: 'claude.ai Linear', displayName: 'Linear', source: 'claudeai' }),
        entry({ name: 'azure-devops', displayName: 'Azure DevOps' }),
      ],
      remoteUrls: ['https://dev.azure.com/acme/Proj/_git/web'],
      usedRows: [
        { threadId: 't1', toolName: 'mcp__claude_ai_Linear__list' },
        { threadId: 't1', toolName: 'mcp__azure-devops__list_prs' },
      ],
      files: [{ path: 'package.json', text: '"@sentry/node": "7", "linear": true, "azure devops"' }],
    })
    expect(out).toEqual([
      { name: 'azure-devops', displayName: 'Azure DevOps', reasonKind: 'repo', reason: repoReason({ label: 'Azure DevOps', keyword: 'azure devops' }) },
      { name: 'claude.ai Linear', displayName: 'Linear', reasonKind: 'used', reason: usedReason(1) },
      { name: 'sentry', displayName: 'Sentry', reasonKind: 'files', reason: filesReason('dependencies') },
    ])
  })

  it('does not match the org name in the remote against every file', () => {
    const out = suggestConnectors({
      ...base,
      remoteUrls: ['git@github.com:contoso/web.git'],
      entries: [entry({ name: 'contoso-wiki', displayName: 'Contoso Wiki' })],
      files: [{ path: 'README.md', text: 'Contoso web app.' }],
    })
    expect(out).toEqual([])
    // …while the same word in a remote-free project does match (positive first, #28).
    expect(
      suggestConnectors({ ...base, entries: [entry({ name: 'contoso-wiki', displayName: 'Contoso Wiki' })], files: [{ path: 'README.md', text: 'Contoso web app.' }] }),
    ).toHaveLength(1)
  })

  it('leaves out a dismissed fingerprint, and shows it again for a new kind of reason', () => {
    const files = [{ path: 'README.md', text: 'Linear tracks our issues.' }]
    const shown = suggestConnectors({ ...base, files, entries: [entry()] })
    expect(shown).toHaveLength(1)
    const dismissed = new Set(shown.map(suggestionFingerprint))
    expect(suggestConnectors({ ...base, files, entries: [entry()], dismissed })).toEqual([])
    const back = suggestConnectors({
      ...base,
      files,
      entries: [entry()],
      dismissed,
      usedRows: [{ threadId: 't9', toolName: 'mcp__linear__list' }],
    })
    expect(back.map((s) => s.reasonKind)).toEqual(['used'])
  })

  it('writes plain sentences: no command, path, config key or emoji', () => {
    const sentences = [
      repoReason({ label: 'GitHub', keyword: 'github' }),
      usedReason(1),
      usedReason(4),
      filesReason('deploy'),
      filesReason('dependencies'),
      filesReason('docs'),
      filesReason('files'),
    ]
    expect(usedReason(1)).toBe('Used in 1 other chat in this project.')
    for (const sentence of sentences) {
      expect(sentence).toMatch(/\.$/)
      expect(sentence).not.toMatch(/[`/\\]|planflow|\.json|\.ya?ml|[\u{1F300}-\u{1FAFF}]/u)
    }
  })
})
