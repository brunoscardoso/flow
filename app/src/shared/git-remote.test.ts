import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseGitRemote, parseKnowledgeBranch, providerLabel, remoteIdentity, sameGitRemote } from './git-remote'

interface Fixtures {
  accept: Array<{ url: string; host: string; provider: string }>
  refuse: Array<{ url: string; reason: string }>
  branches: { accept: string[]; refuse: string[] }
  identities: { cases: Array<{ url: string; identity: string }> }
}

const fixtures = JSON.parse(readFileSync(join(__dirname, 'git-remote-fixtures.json'), 'utf8')) as Fixtures

describe('parseGitRemote — parity with the shared fixture list', () => {
  it('has cases on every side (an empty fixture would pass vacuously)', () => {
    expect(fixtures.accept.length).toBeGreaterThan(5)
    expect(fixtures.refuse.length).toBeGreaterThan(5)
    expect(fixtures.branches.accept.length).toBeGreaterThan(0)
    expect(fixtures.branches.refuse.length).toBeGreaterThan(0)
  })

  it.each(fixtures.accept.map((entry) => [entry.url, entry]))('accepts %s', (_url, entry) => {
    const verdict = parseGitRemote(entry.url)
    expect(verdict).toMatchObject({ ok: true, url: entry.url, host: entry.host, provider: entry.provider })
  })

  it.each(fixtures.refuse.map((entry) => [entry.url, entry]))('refuses %j', (_url, entry) => {
    const verdict = parseGitRemote(entry.url)
    expect(verdict).toMatchObject({ ok: false, reason: entry.reason })
  })

  it.each(fixtures.branches.accept)('accepts the branch %j', (branch) => {
    expect(parseKnowledgeBranch(branch)).toEqual({ ok: true, branch })
  })

  it.each(fixtures.branches.refuse)('refuses the branch %j', (branch) => {
    expect(parseKnowledgeBranch(branch)).toMatchObject({ ok: false, reason: 'invalid-branch' })
  })

  it('refusal sentences name no command, path or setting', () => {
    for (const entry of fixtures.refuse) {
      const verdict = parseGitRemote(entry.url)
      if (verdict.ok) throw new Error(`accepted ${entry.url}`)
      expect(verdict.detail).not.toMatch(/`|--|\.git\b|flow\/|planflow/)
    }
  })

  it('a one-letter host is a Windows drive, not a host', () => {
    expect(parseGitRemote('git@c:repo')).toMatchObject({ ok: false, reason: 'invalid-remote' })
    expect(parseGitRemote('https://c/acme/repo')).toMatchObject({ ok: false, reason: 'invalid-remote' })
  })

  it('a non-string is refused, not thrown on', () => {
    expect(parseGitRemote(undefined)).toMatchObject({ ok: false, reason: 'invalid-remote' })
    expect(parseKnowledgeBranch(42)).toMatchObject({ ok: false })
  })
})

describe('remoteIdentity — parity with the CLI (the source of truth for project ids)', () => {
  it('has identity cases (an empty list would pass vacuously)', () => {
    expect(fixtures.identities.cases.length).toBeGreaterThan(10)
  })

  it.each(fixtures.identities.cases.map((entry) => [entry.url, entry.identity]))('%s is %s', (url, identity) => {
    expect(remoteIdentity(url)).toBe(identity)
  })

  it('every accepted address has an identity, every refused one none', () => {
    for (const entry of fixtures.accept) expect(remoteIdentity(entry.url)).not.toBeNull()
    for (const entry of fixtures.refuse) expect(remoteIdentity(entry.url)).toBeNull()
  })
})

describe('same repository, whatever the spelling', () => {
  it('https and ssh, with or without .git, any case', () => {
    expect(sameGitRemote('https://github.com/Acme/Notes', 'git@github.com:acme/notes.git')).toBe(true)
    expect(sameGitRemote('https://github.com/acme/notes', 'https://github.com/acme/other')).toBe(false)
    expect(sameGitRemote('https://github.com/acme/notes', 'https://gitlab.com/acme/notes')).toBe(false)
  })

  it("Azure's three spellings name one repository", () => {
    const https = 'https://dev.azure.com/acme/Orbit/_git/notes'
    expect(sameGitRemote(https, 'git@ssh.dev.azure.com:v3/acme/Orbit/notes')).toBe(true)
    expect(sameGitRemote(https, 'https://acme.visualstudio.com/Orbit/_git/notes')).toBe(true)
    expect(sameGitRemote(https, 'https://acme@dev.azure.com/acme/Orbit/_git/notes')).toBe(true)
    expect(remoteIdentity(https)).toBe('dev.azure.com/acme/orbit/notes')
  })
})

describe('providerLabel', () => {
  it('names the known hosts and falls back to the host', () => {
    expect(providerLabel('github', 'github.com')).toBe('GitHub')
    expect(providerLabel('azure', 'dev.azure.com')).toBe('Azure DevOps')
    expect(providerLabel('gitlab', 'gitlab.com')).toBe('GitLab')
    expect(providerLabel('bitbucket', 'bitbucket.org')).toBe('Bitbucket')
    expect(providerLabel('other', 'git.acme.internal')).toBe('git.acme.internal')
  })
})
