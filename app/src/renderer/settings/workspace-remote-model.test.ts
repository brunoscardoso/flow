import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { WorkspaceHostTools, WorkspaceSyncStatus } from '../../shared/workspaces-contract'
import { WORKSPACE_SYNC_SENTENCES } from '../../main/knowledge-sync/workspace-sync-engine'
import { WORKSPACE_REMOTE_SENTENCES } from '../../main/workspaces/workspace-remote'
import { workspaceRefusalDetail } from '../../shared/workspace-refusals'
import {
  CHOICE_LABELS,
  CONNECT_LABEL,
  CREATE_AND_CONNECT_LABEL,
  FIXED_STRINGS,
  INVALID_REPOSITORY_NAME,
  BLANK_REPOSITORY_ADDRESS,
  azureProjectsOf,
  changeTitle,
  connectChoices,
  connectTitle,
  connectedLine,
  disconnectTitle,
  disconnectedLine,
  onboardingSharedLine,
  primaryLabel,
  remoteOutcome,
  showNoHostsLine,
  suggestedRepositoryName,
  validateRepositoryAddress,
  validateRepositoryName,
} from './workspace-remote-model'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const status = (over: Partial<WorkspaceSyncStatus> = {}): WorkspaceSyncStatus => ({
  state: 'synced',
  lastSyncedAt: '2026-10-06T11:59:50Z',
  detail: null,
  asks: [],
  reviews: [],
  ...over,
})
const NONE: WorkspaceHostTools = { github: { available: false, owners: [] }, azure: { available: false, organizations: [] } }
const BOTH: WorkspaceHostTools = {
  github: { available: true, login: 'devuser', owners: [{ login: 'devuser', type: 'user' }, { login: 'acme', type: 'org' }] },
  azure: { available: true, organizations: [{ name: 'acme', projects: ['Platform', 'Orbit'] }, { name: 'empty', projects: [] }] },
}

describe('what is offered', () => {
  it('only the signed-in hosts with somewhere to put it — and an existing repository, always', () => {
    expect(connectChoices(null)).toEqual(['existing'])
    expect(connectChoices(NONE)).toEqual(['existing'])
    expect(connectChoices(BOTH)).toEqual(['github', 'azure', 'existing'])
    expect(connectChoices({ ...BOTH, github: { available: true, owners: [] } })).toEqual(['azure', 'existing'])
    expect(connectChoices({ ...NONE, azure: { available: true, organizations: [{ name: 'acme', projects: [] }] } })).toEqual(['existing'])
  })

  it('says how to create one from here only once the hosts were read and none can', () => {
    expect(showNoHostsLine(null)).toBe(false)
    expect(showNoHostsLine(NONE)).toBe(true)
    expect(showNoHostsLine(BOTH)).toBe(false)
  })

  it('names the button after what it does', () => {
    expect(primaryLabel('existing')).toBe(CONNECT_LABEL)
    expect(primaryLabel('github')).toBe(CREATE_AND_CONNECT_LABEL)
    expect(primaryLabel('azure')).toBe(CREATE_AND_CONNECT_LABEL)
  })

  it("lists an organization's projects", () => {
    expect(azureProjectsOf(BOTH, 'acme')).toEqual(['Platform', 'Orbit'])
    expect(azureProjectsOf(BOTH, 'nope')).toEqual([])
    expect(azureProjectsOf(null, 'acme')).toEqual([])
  })
})

describe('the name and the address', () => {
  it('suggests <workspace>-knowledge, always a name the hosts accept', () => {
    expect(suggestedRepositoryName('acme')).toBe('acme-knowledge')
    expect(suggestedRepositoryName('default')).toBe('default-knowledge')
    expect(suggestedRepositoryName('--')).toBe('workspace-knowledge')
    expect(validateRepositoryName(suggestedRepositoryName('a'.repeat(64))).ok).toBe(true)
  })

  it('validates a repository name before anything is sent', () => {
    expect(validateRepositoryName('  acme-knowledge ')).toEqual({ ok: true, name: 'acme-knowledge' })
    for (const bad of ['-x', 'a b', 'x.git', 'x.', '../x']) expect(validateRepositoryName(bad)).toEqual({ ok: false, message: INVALID_REPOSITORY_NAME })
  })

  it('checks the address with the one shared grammar, any git host, and keeps what was typed', () => {
    expect(validateRepositoryAddress('  git@gitlab.com:acme/knowledge.git ')).toEqual({ ok: true, remote: 'git@gitlab.com:acme/knowledge.git' })
    expect(validateRepositoryAddress('https://bitbucket.org/acme/knowledge.git')).toMatchObject({ ok: true })
    expect(validateRepositoryAddress(' ')).toEqual({ ok: false, message: BLANK_REPOSITORY_ADDRESS })
    expect(validateRepositoryAddress('https://bob:hunter2@github.com/acme/k.git')).toEqual({ ok: false, message: workspaceRefusalDetail('credentials-in-url') })
    expect(validateRepositoryAddress('http://github.com/acme/k.git')).toEqual({ ok: false, message: workspaceRefusalDetail('insecure-remote') })
    const leaked = validateRepositoryAddress('https://bob:hunter2@github.com/acme/k.git')
    expect(JSON.stringify(leaked)).not.toContain('hunter2')
  })
})

describe('what happened', () => {
  it('a first sync that finished says it is shared; one that did not says why, in its own words', () => {
    expect(connectedLine('Acme', status(), NOW)).toEqual({ text: 'Acme is shared now. Its knowledge syncs through this repository.', tone: 'ok' })
    const unrelated = connectedLine('Acme', status({ state: 'error', detail: WORKSPACE_SYNC_SENTENCES.unrelatedHistory('Acme') }), NOW)
    expect(unrelated.tone).toBe('warning')
    expect(unrelated.text).toContain(WORKSPACE_SYNC_SENTENCES.unrelatedHistory('Acme'))
  })

  it('a refusal carries the free name to offer and the address of a repository that was created anyway', () => {
    expect(remoteOutcome({ ok: false, reason: 'name-taken', detail: 'Taken.', suggestion: 'acme-knowledge-2' }, 'Acme', NOW)).toEqual({
      kind: 'refused',
      text: 'Taken.',
      suggestion: 'acme-knowledge-2',
    })
    expect(remoteOutcome({ ok: false, reason: 'sync-busy', detail: 'x', created: 'https://github.com/acme/k' }, 'Acme', NOW)).toMatchObject({
      created: 'https://github.com/acme/k',
    })
    expect(remoteOutcome({ ok: true, remote: 'https://github.com/acme/k', status: status() }, 'Acme', NOW)).toMatchObject({ kind: 'done', tone: 'ok' })
  })
})

// ── forbidden-pattern #12 ───────────────────────────────────────────────────

function everyString(): string[] {
  const out = [...FIXED_STRINGS]
  out.push(connectTitle('Acme'), changeTitle('Acme'), disconnectTitle('Acme'), disconnectedLine('Acme'), onboardingSharedLine('Default'))
  out.push(connectedLine('Acme', status(), NOW).text)
  for (const state of ['offline', 'no-access', 'local-only', 'idle'] as const) out.push(connectedLine('Acme', status({ state }), NOW).text)
  out.push(WORKSPACE_SYNC_SENTENCES.unrelatedHistory('Acme'))
  out.push(WORKSPACE_REMOTE_SENTENCES.alreadyShared, WORKSPACE_REMOTE_SENTENCES.createdNotConnected('That did not work.'))
  out.push(workspaceRefusalDetail('remote-exists'), workspaceRefusalDetail('merge-in-progress'))
  out.push(INVALID_REPOSITORY_NAME)
  return out
}

describe('forbidden-pattern #12: connecting says nothing of commands, paths, keys or internals', () => {
  const strings = everyString()

  it('collected a real surface to scan (the positive before the absence)', () => {
    expect(strings.length).toBeGreaterThan(40)
    expect(strings).toContain(CHOICE_LABELS.existing)
    expect(strings).toContain('Share Acme with your team')
  })

  const FORBIDDEN: [string, RegExp][] = [
    ['a slash path', /[A-Za-z0-9_.~-]\/[A-Za-z0-9_.~-]|^\/|\s\/|\\/],
    ['a dotfile', /(^|\s)\.[a-z]|\.(gitignore|flowconfig|gitattributes|git)\b/i],
    ['a git command', /\bgit\s+(?!sign-in|host)/i],
    ['a host tool command', /\b(gh|az)\s/],
    ['the CLI', /planflow|plan-flow|set-remote|unset-remote/i],
    ['a flag', /(^|\s)--?[a-z][a-z-]*/],
    ['a URL', /https?:|www\.|:\/\/|git@/i],
    ['a backtick', /`/],
    ['a config assignment', /\b[a-z]+_[a-z_]+\b|\b[a-z_]+:\s*(true|false)\b/],
    ['an internal word', /\b(slug|symlink|payload|refus(al|ed)|CLI|IPC|JSON|origin|remote|repo|unrelated)\b/],
    ['an emoji', /\p{Extended_Pictographic}/u],
  ]

  it.each(FORBIDDEN)('contains no %s', (_what, pattern) => {
    expect(strings.filter((text) => pattern.test(text))).toEqual([])
  })
})

describe('the onboarding step writes no connect copy of its own', () => {
  it('steps.ts takes the share wording from the model', () => {
    const source = readFileSync(join(__dirname, '..', 'onboarding', 'steps.ts'), 'utf8')
    // POSITIVE FIRST: it does offer the share.
    expect(source).toContain('WORKSPACE_SHARE')
    expect(source).not.toMatch(/(button|status|p)\(\s*['"`]Share/)
  })
})
