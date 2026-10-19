import type { ShareLocalFacts } from '../../shared/ipc-contract'
import type { ShareSummary } from '../../shared/share-contract'
import {
  SHARED_BUTTON_LABEL,
  SHARE_BUTTON_LABEL,
  SIGNING_IN_LABEL,
  SIGN_IN_TO_SHARE_LABEL,
  UPDATE_PROMPT_TITLE,
  createRequestSequence,
  dialogAfterSignIn,
  formatAgo,
  invitesSkippedText,
  liveShare,
  localIsNewer,
  shareButtonFor,
  shareStateFrom,
  shareStripFor,
  sharedWithText,
  shareSubject,
  stepAfterRefusal,
  updateDismissKey,
  updatePromptFor,
  viewerRows,
  withDismissed,
  withRevoked,
  withShare,
  type ShareState,
} from './share-state-model'

const NOW = Date.parse('2026-10-01T12:00:00.000Z')

function local(over: Partial<ShareLocalFacts> = {}): ShareLocalFacts {
  return {
    project: 'plan-flow',
    slug: 'x',
    title: 'X',
    discoveryVersion: 2,
    pageModifiedAt: '2026-10-01T11:00:00.000Z',
    files: [
      { part: 'walkthrough', name: 'discovery_x_v2.walkthrough.html', bytes: 2048, sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { part: 'discovery', name: 'discovery_x_v2.md', bytes: 512, sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    ],
    totalBytes: 2560,
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
    access: { emails: ['ada@client.io'], domains: [] },
    accessCount: 1,
    revokedAt: null,
    expiresAt: null,
    ...over,
  }
}

const ready = (share: ShareSummary | null, facts = local()): ShareState => ({ kind: 'ready', share, local: facts })

describe('state from main\'s answer', () => {
  it('a share answer is ready', () => {
    expect(shareStateFrom({ ok: true, share: null, local: local() })).toEqual(ready(null))
  })

  it('every sign-in refusal is signed-out, carrying main\'s sentence', () => {
    for (const reason of ['signed-out', 'session-expired', 'unauthenticated'] as const) {
      expect(shareStateFrom({ ok: false, reason, message: 'Sign in.' })).toEqual({ kind: 'signed-out', message: 'Sign in.' })
    }
  })

  it('any other refusal is refused', () => {
    expect(shareStateFrom({ ok: false, reason: 'unreachable', message: 'Offline.' })).toEqual({
      kind: 'refused',
      reason: 'unreachable',
      message: 'Offline.',
    })
  })
})

describe('the Share button', () => {
  it('is "Share" and publishes when never shared', () => {
    expect(shareButtonFor(ready(null), false)).toMatchObject({ label: SHARE_BUTTON_LABEL, disabled: false, action: 'publish' })
  })

  it('is "Shared" and manages when live', () => {
    expect(shareButtonFor(ready(summary()), false)).toMatchObject({ label: SHARED_BUTTON_LABEL, disabled: false, action: 'manage' })
  })

  it('a revoked share publishes again', () => {
    expect(shareButtonFor(ready(summary({ revokedAt: '2026-10-01T00:00:00Z' })), false)).toMatchObject({ label: 'Share', action: 'publish' })
  })

  it('reads "Sign in to share" signed out, and is pressable', () => {
    expect(shareButtonFor({ kind: 'signed-out', message: 'x' }, false)).toMatchObject({
      label: SIGN_IN_TO_SHARE_LABEL,
      disabled: false,
      action: 'sign-in',
    })
    expect(SIGN_IN_TO_SHARE_LABEL).toBe('Sign in to share')
  })

  it('is disabled while signing in, loading, or without a project — never hidden', () => {
    expect(shareButtonFor({ kind: 'signed-out', message: 'x' }, true)).toMatchObject({ label: SIGNING_IN_LABEL, disabled: true, action: 'none' })
    expect(shareButtonFor({ kind: 'loading' }, false)).toMatchObject({ disabled: true, action: 'none' })
    expect(shareButtonFor({ kind: 'idle' }, false)).toMatchObject({ disabled: true })
    expect(shareButtonFor({ kind: 'no-project' }, false)).toMatchObject({ disabled: true })
  })

  it('a final refusal is disabled with its sentence; a passing one retries', () => {
    expect(shareButtonFor({ kind: 'refused', reason: 'sharing-unavailable', message: 'Not in this version.' }, false)).toEqual({
      label: 'Share',
      title: 'Not in this version.',
      disabled: true,
      action: 'none',
    })
    expect(shareButtonFor({ kind: 'refused', reason: 'unreachable', message: 'Offline.' }, false)).toMatchObject({
      disabled: false,
      action: 'retry',
      title: 'Offline. Press to try again.',
    })
  })
})

describe('the shared strip', () => {
  it('"Shared with 1 person" with the link', () => {
    expect(shareStripFor(ready(summary()), NOW)).toEqual({
      subject: 'X · plan-flow',
      summary: 'Shared with 1 person',
      url: 'https://planflow.sh/v/shareABCD1234',
      expiry: null,
    })
  })

  it('names people, a single domain, or a count of domains', () => {
    expect(sharedWithText({ emails: ['a@x.io', 'b@x.io'], domains: ['acme.com'] })).toBe('Shared with 2 people and acme.com')
    expect(sharedWithText({ emails: [], domains: ['a.com', 'b.com'] })).toBe('Shared with 2 company domains')
    expect(sharedWithText({ emails: [], domains: [] })).toBe('Shared with nobody yet')
  })

  it('says when the link expires or expired', () => {
    expect(shareStripFor(ready(summary({ expiresAt: '2026-12-01T00:00:00Z' })), NOW)?.expiry).toMatch(/^Link expires /)
    expect(shareStripFor(ready(summary({ expiresAt: '2026-09-01T00:00:00Z' })), NOW)?.expiry).toMatch(/^Link expired on /)
  })

  it('is absent when not shared or revoked', () => {
    expect(shareStripFor(ready(summary()), NOW)).not.toBeNull()
    expect(shareStripFor(ready(null), NOW)).toBeNull()
    expect(shareStripFor(ready(summary({ revokedAt: '2026-10-01T00:00:00Z' })), NOW)).toBeNull()
    expect(shareStripFor({ kind: 'signed-out', message: 'x' }, NOW)).toBeNull()
  })

  it('withShare replaces the share, keeping the local facts', () => {
    const next = withShare(ready(null), summary())
    expect(liveShare(next)).toEqual(summary())
    expect(withShare({ kind: 'loading' }, summary())).toEqual({ kind: 'loading' })
  })
})

describe('"This page is shared — update it?"', () => {
  it('asks when the discovery has a later version', () => {
    const prompt = updatePromptFor(ready(summary({ discoveryVersion: 1 })), new Set())
    expect(localIsNewer(summary({ discoveryVersion: 1 }), local())).toBe('version')
    expect(prompt).toEqual({
      key: 'v2@2026-10-01T11:00:00.000Z',
      title: UPDATE_PROMPT_TITLE,
      target: 'X · plan-flow — Shared with 1 person',
      detail:
        'The discovery is now version 2; people with the link still see version 1. Updating sends discovery_x_v2.walkthrough.html (2.0 KB) and discovery_x_v2.md (512 B) to the same link, and keeps the earlier version.',
    })
  })

  it('asks when the same version\'s page was rewritten after it was shared', () => {
    const shared = summary({ pageModifiedAt: '2026-10-01T10:00:00.000Z' })
    expect(localIsNewer(shared, local())).toBe('page')
    expect(updatePromptFor(ready(shared), new Set())?.detail).toMatch(/^The artifact changed since you shared it/)
  })

  it('does not ask when current, older, unshared or revoked', () => {
    expect(updatePromptFor(ready(summary({ discoveryVersion: 1 })), new Set())).not.toBeNull()
    expect(updatePromptFor(ready(summary()), new Set())).toBeNull()
    expect(updatePromptFor(ready(summary({ discoveryVersion: 3 })), new Set())).toBeNull()
    expect(updatePromptFor(ready(null), new Set())).toBeNull()
    expect(updatePromptFor(ready(summary({ discoveryVersion: 1, revokedAt: '2026-10-01T00:00:00Z' })), new Set())).toBeNull()
  })

  it('"Not now" silences exactly that version and page — the next rewrite asks again', () => {
    const state = ready(summary({ discoveryVersion: 1 }))
    const first = updatePromptFor(state, new Set())
    expect(first).not.toBeNull()
    const dismissed = withDismissed(new Set(), first?.key ?? '')
    expect(updatePromptFor(state, dismissed)).toBeNull()

    const rewritten = ready(summary({ discoveryVersion: 1 }), local({ pageModifiedAt: '2026-10-01T11:45:00.000Z' }))
    expect(updatePromptFor(rewritten, dismissed)).not.toBeNull()
    const nextVersion = ready(summary({ discoveryVersion: 1 }), local({ discoveryVersion: 3 }))
    expect(updatePromptFor(nextVersion, dismissed)).not.toBeNull()
  })

  it('withDismissed never changes the caller\'s set', () => {
    const original = new Set<string>()
    withDismissed(original, updateDismissKey(local()))
    expect(original.size).toBe(0)
  })
})

describe('viewers', () => {
  it('formats when each person last opened it, in server order', () => {
    expect(
      viewerRows(
        [
          { email: 'a@x.io', firstViewedAt: '2026-10-01T11:00:00Z', lastViewedAt: '2026-10-01T11:59:30Z' },
          { email: 'b@x.io', firstViewedAt: '2026-09-29T00:00:00Z', lastViewedAt: '2026-09-29T12:00:00Z' },
        ],
        NOW,
      ),
    ).toEqual([
      { email: 'a@x.io', lastViewed: 'Last opened just now' },
      { email: 'b@x.io', lastViewed: 'Last opened 2 days ago' },
    ])
    expect(formatAgo('2026-10-01T11:55:00Z', NOW)).toBe('5 minutes ago')
    expect(formatAgo('2026-10-01T09:00:00Z', NOW)).toBe('3 hours ago')
  })
})

describe('answer ordering', () => {
  it('only the newest request is current', () => {
    const sequence = createRequestSequence()
    const first = sequence.next()
    expect(sequence.isCurrent(first)).toBe(true)
    const second = sequence.next()
    expect(sequence.isCurrent(first)).toBe(false)
    expect(sequence.isCurrent(second)).toBe(true)
  })
})

describe('revoked elsewhere (review H4)', () => {
  it("'revoked' re-shares — never a retried update; other refusals keep their step", () => {
    expect(stepAfterRefusal('changed-since-review')).toBe('reread')
    expect(stepAfterRefusal('unavailable')).toBe('show')
    expect(stepAfterRefusal('not-found')).toBe('show')
    expect(stepAfterRefusal('revoked')).toBe('reshare')
  })

  it('a revoked mark ends the update question and turns the button back into Share', () => {
    const live = ready(summary({ discoveryVersion: 1 }))
    // The positive: a stale window still asks to update a live share…
    expect(updatePromptFor(live, new Set())).not.toBeNull()
    expect(shareButtonFor(live, false)).toMatchObject({ action: 'manage' })

    const revoked = withRevoked(live, '2026-10-01T12:00:00.000Z')
    // …and once the server said "revoked", it asks nothing and offers a re-share.
    expect(updatePromptFor(revoked, new Set())).toBeNull()
    expect(shareStripFor(revoked, NOW)).toBeNull()
    expect(shareButtonFor(revoked, false)).toMatchObject({ label: SHARE_BUTTON_LABEL, action: 'publish' })
    // The caller's state is untouched.
    expect(liveShare(live)).not.toBeNull()
  })

  it('withRevoked leaves states with nothing live as they are', () => {
    const already = ready(summary({ revokedAt: '2026-09-01T00:00:00.000Z' }))
    expect(withRevoked(already, '2026-10-01T12:00:00.000Z')).toBe(already)
    const never = ready(null)
    expect(withRevoked(never, '2026-10-01T12:00:00.000Z')).toBe(never)
    const loading: ShareState = { kind: 'loading' }
    expect(withRevoked(loading, '2026-10-01T12:00:00.000Z')).toBe(loading)
  })
})

describe('which share an action goes to (review R2-M3)', () => {
  it('the strip and the update question name the share by title and project, with its audience', () => {
    const shared = summary({
      title: 'Ledger Sync',
      project: 'clientA-app',
      discoveryVersion: 1,
      access: { emails: ['a@x.io', 'b@x.io'], domains: ['acme.com'] },
      accessCount: 3,
    })
    expect(shareStripFor(ready(shared), NOW)?.subject).toBe('Ledger Sync · clientA-app')
    expect(updatePromptFor(ready(shared), new Set())?.target).toBe(
      'Ledger Sync · clientA-app — Shared with 2 people and acme.com',
    )
  })

  it('falls back to the slug for an empty title, and drops an empty project', () => {
    expect(shareSubject(summary({ title: '  ', project: '' }))).toBe('x')
  })
})

describe('invites the server skipped (review R2-L5)', () => {
  it('says how many people were not emailed, in plain words', () => {
    expect(invitesSkippedText(1)).toBe(
      "1 person wasn't emailed because of sending limits — share the link with them directly.",
    )
    expect(invitesSkippedText(4)).toBe(
      "4 people weren't emailed because of sending limits — share the link with them directly.",
    )
  })

  it('says nothing when nobody was skipped, or the count is not a count', () => {
    for (const value of [undefined, 0, -2, 1.5, Number.NaN]) expect(invitesSkippedText(value)).toBeNull()
  })

  it('names no command, path or setting', () => {
    expect(invitesSkippedText(3)).not.toMatch(/planflow-ai|`|\/|\.flowconfig|invitesSkipped/)
  })
})

describe('after a sign-in, the person picks up where they were', () => {
  it('a rejected session reads "Sign in to share", and pressing it is a sign-in', () => {
    const state = shareStateFrom({
      ok: false,
      reason: 'unauthenticated',
      message: 'Your Flow sign-in is no longer valid. Sign in again to share.',
    })
    expect(state).toEqual({ kind: 'signed-out', message: 'Your Flow sign-in is no longer valid. Sign in again to share.' })
    expect(shareButtonFor(state, false)).toMatchObject({ label: SIGN_IN_TO_SHARE_LABEL, action: 'sign-in', disabled: false })
  })

  it('reopens the publish dialog for a page not shared yet — and Manage for one that is', () => {
    // POSITIVE FIRST: with the intent, a ready answer opens something.
    expect(dialogAfterSignIn(true, ready(null))).toBe('publish')
    expect(dialogAfterSignIn(true, ready(summary()))).toBe('manage')
    // A revoked share is shared with nobody: it reopens as a publish.
    expect(dialogAfterSignIn(true, ready(summary({ revokedAt: '2026-10-01T11:45:00.000Z' })))).toBe('publish')
  })

  it('opens nothing without the intent, or from a state main did not answer with a share', () => {
    expect(dialogAfterSignIn(false, ready(null))).toBeNull()
    expect(dialogAfterSignIn(true, { kind: 'signed-out', message: 'x' })).toBeNull()
    expect(dialogAfterSignIn(true, { kind: 'loading' })).toBeNull()
    expect(dialogAfterSignIn(true, { kind: 'refused', reason: 'unavailable', message: 'x' })).toBeNull()
    expect(dialogAfterSignIn(true, { kind: 'no-project' })).toBeNull()
  })
})
