import type { ShareLocalFacts } from '../../shared/ipc-contract'
import type { ShareSummary } from '../../shared/share-contract'
import {
  SHARE_NOBODY_MESSAGE,
  addEntries,
  buildPublishRequest,
  buildUpdateRequest,
  checkDomain,
  checkEmail,
  expiresAtFor,
  expiryOptions,
  formatBytes,
  initialForm,
  removeEntry,
  reviewedFiles,
  sendSummary,
  splitEntries,
  type ShareDialogForm,
} from './share-dialog-model'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const WALK_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const DOC_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const DOC = { rootPath: '/work/plan-flow', docPath: 'flow/discovery/discovery_x_v2.md' }

function local(over: Partial<ShareLocalFacts> = {}): ShareLocalFacts {
  return {
    project: 'plan-flow',
    slug: 'x',
    title: 'X',
    discoveryVersion: 2,
    pageModifiedAt: '2026-10-01T11:00:00.000Z',
    files: [
      { part: 'walkthrough', name: 'discovery_x_v2.walkthrough.html', bytes: 12_800, sha256: WALK_SHA },
      { part: 'discovery', name: 'discovery_x_v2.md', bytes: 900, sha256: DOC_SHA },
    ],
    totalBytes: 13_700,
    maxBytes: 2 * 1024 * 1024,
    ...over,
  }
}

function summary(over: Partial<ShareSummary> = {}): ShareSummary {
  return {
    id: 'shareABCD1234',
    url: 'https://planflow.sh/v/shareABCD1234',
    project: 'plan-flow',
    slug: 'x',
    title: 'X',
    version: 1,
    discoveryVersion: 2,
    pageModifiedAt: '2026-10-01T11:00:00.000Z',
    publishedAt: '2026-10-01T11:30:00.000Z',
    access: { emails: ['ada@client.io'], domains: ['acme.com'] },
    accessCount: 2,
    revokedAt: null,
    expiresAt: null,
    ...over,
  }
}

const form = (over: Partial<ShareDialogForm> = {}): ShareDialogForm => ({
  emails: ['ada@client.io'],
  domains: [],
  notify: true,
  expiry: 'never',
  ...over,
})

describe('emails', () => {
  it('accepts an address, lower-cased and trimmed — nothing else rewritten', () => {
    expect(checkEmail('  Ada@Client.IO ')).toEqual({ ok: true, value: 'ada@client.io' })
    expect(checkEmail('ada@gmail.com')).toEqual({ ok: true, value: 'ada@gmail.com' })
  })

  it('refuses what is not an address, quoting it', () => {
    expect(checkEmail('ada@client.io').ok).toBe(true)
    for (const bad of ['ada', 'ada@client', 'ada@@client.io', 'a b@client.io', '']) {
      expect(checkEmail(bad)).toMatchObject({ ok: false })
    }
    expect(checkEmail('ada.client.io')).toEqual({ ok: false, message: '"ada.client.io" doesn\'t look like an email address.' })
  })
})

describe('domains', () => {
  it('accepts a company domain', () => {
    expect(checkDomain(' Acme.COM ')).toEqual({ ok: true, value: 'acme.com' })
  })

  it('refuses a public mail provider as a company domain', () => {
    expect(checkDomain('acme.com').ok).toBe(true)
    for (const provider of ['gmail.com', 'Outlook.com', 'icloud.com']) {
      const result = checkDomain(provider)
      expect(result).toMatchObject({ ok: false })
      if (!result.ok) expect(result.message).toContain('public mail provider')
    }
  })

  it('refuses an address, a leading dot, and non-domains', () => {
    expect(checkDomain('acme.com').ok).toBe(true)
    expect(checkDomain('ada@acme.com')).toMatchObject({ ok: false, message: expect.stringContaining('under People') })
    expect(checkDomain('.acme.com')).toMatchObject({ ok: false, message: expect.stringContaining('leading dot') })
    expect(checkDomain('acme')).toMatchObject({ ok: false })
    expect(checkDomain('')).toMatchObject({ ok: false })
  })
})

describe('adding and removing entries', () => {
  it('splits pasted text and adds each valid entry once, without changing the caller\'s list', () => {
    expect(splitEntries(' a@x.io, b@x.io;c@x.io  d@x.io ')).toEqual(['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io'])
    const current = ['a@x.io']
    const added = addEntries(current, 'A@x.io, b@x.io', 'email')
    expect(added).toEqual({ entries: ['a@x.io', 'b@x.io'], rejected: [], message: null })
    expect(current).toEqual(['a@x.io'])
  })

  it('keeps refused entries as typed, with the first refusal\'s sentence', () => {
    const added = addEntries([], 'ok@x.io nope gmail.com', 'email')
    expect(added.entries).toEqual(['ok@x.io'])
    expect(added.rejected).toEqual(['nope', 'gmail.com'])
    expect(added.message).toBe('"nope" doesn\'t look like an email address.')
  })

  it('refuses a public domain when adding domains', () => {
    const added = addEntries([], 'acme.com gmail.com', 'domain')
    expect(added.entries).toEqual(['acme.com'])
    expect(added.rejected).toEqual(['gmail.com'])
  })

  it('holds the caps', () => {
    const full = Array.from({ length: 100 }, (_, i) => `p${i}@x.io`)
    const added = addEntries(full, 'one-more@x.io', 'email')
    expect(added.entries).toHaveLength(100)
    expect(added.rejected).toEqual(['one-more@x.io'])
    expect(added.message).toBe('A page can be shared with at most 100 people.')
    const domains = Array.from({ length: 10 }, (_, i) => `d${i}.com`)
    expect(addEntries(domains, 'eleven.com', 'domain').message).toBe('A page can be shared with at most 10 company domains.')
  })

  it('removes one entry', () => {
    expect(removeEntry(['a@x.io', 'b@x.io'], 'a@x.io')).toEqual(['b@x.io'])
  })
})

describe('expiry', () => {
  it('offers "keep" only when an expiry is set', () => {
    expect(expiryOptions(null).map((o) => o.value)).toEqual(['never', '7d', '30d', '90d'])
    expect(expiryOptions('2026-12-01T00:00:00Z').map((o) => o.value)).toEqual(['keep', 'never', '7d', '30d', '90d'])
  })

  it('turns a choice into the request field', () => {
    expect(expiresAtFor('keep', NOW)).toBeUndefined()
    expect(expiresAtFor('never', NOW)).toBeNull()
    expect(expiresAtFor('7d', NOW)).toBe(new Date(NOW + 7 * DAY).toISOString())
    expect(expiresAtFor('90d', NOW)).toBe(new Date(NOW + 90 * DAY).toISOString())
  })
})

describe('what will be sent', () => {
  it('lists both files by label, name and size', () => {
    expect(sendSummary(local())).toEqual({
      rows: [
        { label: 'Artifact page', name: 'discovery_x_v2.walkthrough.html', size: '12.5 KB' },
        { label: 'Discovery document', name: 'discovery_x_v2.md', size: '900 B' },
      ],
      total: '13.4 KB',
      overCap: false,
      overCapMessage: null,
    })
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('says when the two together are over the cap', () => {
    const over = sendSummary(local({ totalBytes: 3 * 1024 * 1024 }))
    expect(over.overCap).toBe(true)
    expect(over.overCapMessage).toBe('These are 3.0 MB together; a shared page can hold at most 2.0 MB.')
  })

  it('reviewed carries the hashes (and sizes) of the facts the author was shown', () => {
    expect(reviewedFiles(local())).toEqual({
      walkthroughBytes: 12_800,
      discoveryBytes: 900,
      walkthroughSha256: WALK_SHA,
      discoverySha256: DOC_SHA,
    })
  })

  it('a missing file reviews as an empty hash, which main refuses', () => {
    expect(reviewedFiles(local({ files: [] }))).toMatchObject({ walkthroughSha256: '', discoverySha256: '' })
  })
})

describe('initial form', () => {
  it('starts empty, notifying, never expiring for a first share', () => {
    expect(initialForm(null)).toEqual({ emails: [], domains: [], notify: true, expiry: 'never' })
  })

  it('starts from the existing list, keeping an expiry, when managing', () => {
    const share = summary({ expiresAt: '2026-12-01T00:00:00Z' })
    const opened = initialForm(share)
    expect(opened).toEqual({ emails: ['ada@client.io'], domains: ['acme.com'], notify: true, expiry: 'keep' })
    opened.emails.push('x@y.io')
    expect(share.access.emails).toEqual(['ada@client.io'])
  })

  it('a revoked share re-shares to its old list but not its old expiry', () => {
    expect(initialForm(summary({ revokedAt: '2026-10-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' })).expiry).toBe('never')
  })

  it('re-sharing a revoked page does NOT email the old list unless asked (review info)', () => {
    // The positive: a live share and a first share open with "Email them" on…
    expect(initialForm(null).notify).toBe(true)
    expect(initialForm(summary()).notify).toBe(true)
    // …a revoked one opens with it off, but keeps the list.
    const reshare = initialForm(summary({ revokedAt: '2026-10-01T00:00:00Z' }))
    expect(reshare).toEqual({ emails: ['ada@client.io'], domains: ['acme.com'], notify: false, expiry: 'never' })
    expect(buildPublishRequest(DOC, local(), reshare, NOW)).toMatchObject({ ok: true, request: { notify: false } })
  })
})

describe('publish payload', () => {
  it('carries doc, reviewed hashes, the list, notify and the expiry', () => {
    expect(buildPublishRequest(DOC, local(), form({ domains: ['acme.com'], expiry: '7d' }), NOW)).toEqual({
      ok: true,
      request: {
        rootPath: DOC.rootPath,
        docPath: DOC.docPath,
        reviewed: { walkthroughBytes: 12_800, discoveryBytes: 900, walkthroughSha256: WALK_SHA, discoverySha256: DOC_SHA },
        access: { emails: ['ada@client.io'], domains: ['acme.com'] },
        notify: true,
        expiresAt: new Date(NOW + 7 * DAY).toISOString(),
      },
    })
  })

  it('a "never" expiry is an explicit null; never content', () => {
    const built = buildPublishRequest(DOC, local(), form(), NOW)
    expect(built).toMatchObject({ ok: true, request: { expiresAt: null } })
    if (built.ok) expect(Object.keys(built.request).sort()).toEqual(['access', 'docPath', 'expiresAt', 'notify', 'reviewed', 'rootPath'])
  })

  it('refuses nobody, and over the cap', () => {
    expect(buildPublishRequest(DOC, local(), form(), NOW).ok).toBe(true)
    expect(buildPublishRequest(DOC, local(), form({ emails: [] }), NOW)).toEqual({ ok: false, message: SHARE_NOBODY_MESSAGE })
    expect(buildPublishRequest(DOC, local({ totalBytes: 3 * 1024 * 1024 }), form(), NOW)).toMatchObject({ ok: false })
  })
})

describe('update payload', () => {
  it('replaces the whole list and leaves a kept expiry out', () => {
    expect(buildUpdateRequest('shareABCD1234', form({ emails: ['a@x.io', 'b@x.io'], notify: false, expiry: 'keep' }), NOW)).toEqual({
      ok: true,
      request: { id: 'shareABCD1234', access: { emails: ['a@x.io', 'b@x.io'], domains: [] }, notify: false },
    })
  })

  it('never empties the list — that is a revoke, asked for separately', () => {
    expect(buildUpdateRequest('shareABCD1234', form(), NOW).ok).toBe(true)
    const result = buildUpdateRequest('shareABCD1234', form({ emails: [], domains: [] }), NOW)
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('revoke the link') })
    expect(JSON.stringify(result)).not.toContain('"revoke"')
  })
})
