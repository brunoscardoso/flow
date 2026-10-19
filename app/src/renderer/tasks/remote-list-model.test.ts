/**
 * The Remote list — what is assigned to YOU on a connected tracker.
 *
 * The distinction this file exists to hold: it is NOT a loop's queue. A queue is
 * a repository's list that somebody pointed a loop at, in a committed file; this
 * is "what is mine, wherever it lives". The first cut built the column on the
 * queue, so a project whose loops read a local list could never show one — which
 * is exactly what the user hit, twice.
 */

import {
  rememberedRemoteSource,
  remoteSourceStorageKey,
  REMOTE_PROVIDERS,
  remoteReadFailure,
  providerLabel,
  remoteListStorageKey,
  remoteListView,
  mergeConnected,
  type ConnectionOutcome,
} from './remote-list-model'
import type { IntegrationProvider, RemoteIssue } from '../../shared/ipc-contract'

const issue = (key: string): RemoteIssue => ({
  key,
  title: `Issue ${key}`,
  description: '',
  status: 'open',
  url: `https://example.test/${key}`,
})

const view = (over: Partial<Parameters<typeof remoteListView>[0]> = {}) =>
  remoteListView({ connected: [], read: null, chosen: null, on: false, ...over })

describe('whether the column can exist at all', () => {
  it('needs a connected tracker, and nothing else', () => {
    expect(view().available).toBe(false)
    expect(view({ connected: ['github'] }).available).toBe(true)
  })

  it('a connected tracker with NOTHING assigned still gets a column', () => {
    // "Nothing assigned to you" is an answer. Hiding the column for it would
    // make an empty inbox indistinguishable from a broken one.
    const v = view({
      connected: ['github'],
      read: { provider: 'github', ok: true, items: [], reason: null },
    })
    expect(v.available).toBe(true)
    expect(v.items).toEqual([])
    expect(v.emptyText).toContain('GitHub')
  })

  it('offers the connected trackers in a fixed order, and only those', () => {
    expect(view({ connected: ['azure', 'github'] }).providers).toEqual(['github', 'azure'])
    expect(REMOTE_PROVIDERS).toEqual(['github', 'jira', 'azure'])
  })
})

describe('the provenance caption — telling a wrong query from a broken board', () => {
  const withQuery = { mode: 'list' as const, query: 'repo:acme/api is:issue' }

  it('names the effective question and the count once a read has landed', () => {
    const v = view({
      connected: ['github'],
      config: withQuery,
      read: { provider: 'github', ok: true, items: [issue('a/b#1'), issue('a/b#2')], reason: null },
    })
    expect(v.provenance).toBe('Your saved list · 2 results')
  })

  it('says "Assigned to you" for the default mode, and singularises one result', () => {
    const v = view({
      connected: ['github'],
      read: { provider: 'github', ok: true, items: [issue('a/b#1')], reason: null },
    })
    expect(v.provenance).toBe('Assigned to you · 1 result')
  })

  it('says "Assigned + your list" for both mode', () => {
    const v = view({
      connected: ['github'],
      config: { mode: 'both', query: 'repo:acme/api is:issue' },
      read: { provider: 'github', ok: true, items: [issue('a/b#1')], reason: null },
    })
    expect(v.provenance).toBe('Assigned + your list · 1 result')
  })

  it('is blank while loading, on failure, and on an empty read — those speak for themselves', () => {
    expect(view({ connected: ['github'], reading: true }).provenance).toBe('')
    expect(
      view({
        connected: ['github'],
        read: { provider: 'github', ok: false, items: [], reason: 'nope' },
      }).provenance,
    ).toBe('')
    expect(
      view({
        connected: ['github'],
        read: { provider: 'github', ok: true, items: [], reason: null },
      }).provenance,
    ).toBe('')
  })
})

describe('which tracker is showing', () => {
  it('falls back to the first connected one when the chosen one is gone', () => {
    // A stored choice can name a tracker somebody has since disconnected. An
    // empty column would report "nothing assigned to you" about a question
    // asked of nobody.
    expect(view({ connected: ['github'], chosen: 'jira' }).showing).toBe('github')
  })

  it('honours a choice that is still connected', () => {
    expect(view({ connected: ['github', 'jira'], chosen: 'jira' }).showing).toBe('jira')
  })

  it('ignores a read that belongs to a DIFFERENT tracker', () => {
    // A snapshot left over from a previous choice is not an answer to this one,
    // and drawing it would put Jira's issues under a GitHub heading.
    const v = view({
      connected: ['github', 'jira'],
      chosen: 'jira',
      read: { provider: 'github', ok: true, items: [issue('a/b#1')], reason: null },
    })
    expect(v.items).toEqual([])
  })
})

describe('what it says when the read failed', () => {
  it('carries the tracker’s own sentence, and draws no items', () => {
    const v = view({
      connected: ['github'],
      read: { provider: 'github', ok: false, items: [], reason: 'check your token / permissions' },
    })
    expect(v.reason).toBe('check your token / permissions')
    expect(v.items).toEqual([])
  })

  it('a failure is never reported as an empty list', () => {
    // The two are different answers: one says you have nothing, the other says
    // nobody could ask.
    const failed = view({
      connected: ['github'],
      read: { provider: 'github', ok: false, items: [], reason: 'no token' },
    })
    const empty = view({
      connected: ['github'],
      read: { provider: 'github', ok: true, items: [], reason: null },
    })
    expect(failed.reason).not.toBeNull()
    expect(empty.reason).toBeNull()
  })
})

describe('the toggle and where its answer is kept', () => {
  it('says what pressing it will do, in the state it is in', () => {
    expect(view({ connected: ['github'], on: false }).toggleLabel).toMatch(/^Show/)
    expect(view({ connected: ['github'], on: true }).toggleLabel).toMatch(/^Hide/)
  })

  it('remembers the answer per project — one board wants it, another does not', () => {
    expect(remoteListStorageKey('/a')).not.toBe(remoteListStorageKey('/b'))
  })

  it('names each tracker the way a person does', () => {
    expect(providerLabel('github' as IntegrationProvider)).toBe('GitHub')
    expect(providerLabel('azure' as IntegrationProvider)).toBe('Azure DevOps')
  })
})

describe('what a failed read is allowed to say', () => {
  it('passes a tracker’s own reason through verbatim — it is the finding', () => {
    expect(remoteReadFailure('github request failed — check your token / permissions')).toBe(
      'github request failed — check your token / permissions',
    )
  })

  it('translates an unregistered CHANNEL, which is not a fact about the tracker', () => {
    // Reported by the user as `No handler registered for
    // 'integrations:assigned'` — the app's own plumbing, handed over as an
    // explanation, telling them nothing they can do. It means the window is
    // newer than the process behind it.
    const said = remoteReadFailure("Error invoking remote method 'integrations:assigned': Error: No handler registered for 'integrations:assigned'")
    expect(said).toMatch(/restart/i)
    expect(said).not.toContain('integrations:assigned')
  })

  it('says something when the failure said nothing', () => {
    expect(remoteReadFailure(null)).toMatch(/Could not read/)
    expect(remoteReadFailure('   ')).toMatch(/Could not read/)
  })
})

describe('reading is its own state, not "no items yet"', () => {
  it('says it is loading while a read is in flight', () => {
    // The two look identical in a list and mean opposite things — one is an
    // answer, the other is the absence of one — and this read goes to somebody
    // else's server. Reported as "is taking a long time and there no loader".
    const v = view({ connected: ['github'], on: true, reading: true })
    expect(v.loading).toBe(true)
    expect(v.toggleLabel).toMatch(/Reading/)
  })

  it('the empty sentence is only ever the "nothing assigned" answer', () => {
    // It used to double as "Reading…", so the empty state carried two opposite
    // meanings depending on a field nobody looking at it could see.
    const v = view({
      connected: ['github'],
      on: true,
      read: { provider: 'github', ok: true, items: [], reason: null },
    })
    expect(v.loading).toBe(false)
    expect(v.emptyText).toMatch(/Nothing assigned to you/)
  })
})

describe('the list mode — Assigned / My list / Both', () => {
  it('offers only Assigned until a query is saved', () => {
    // With no query, `list`/`both` cannot mean anything, so the selector has
    // nothing to pick between and the board hides it.
    const v = view({ connected: ['github'], on: true })
    expect(v.mode).toBe('assigned')
    expect(v.modeOptions).toEqual(['assigned'])
  })

  it('unlocks all three modes once a query exists', () => {
    const v = view({
      connected: ['github'],
      on: true,
      config: { mode: 'both', query: 'label:bug' },
    })
    expect(v.mode).toBe('both')
    expect(v.modeOptions).toEqual(['assigned', 'list', 'both'])
  })

  it('forces the effective mode back to assigned when the query is cleared', () => {
    // The stored mode says `list`, but the query is gone — the fetch falls back
    // to assigned, and the view must not disagree with it.
    const v = view({
      connected: ['github'],
      on: true,
      config: { mode: 'list', query: '' },
    })
    expect(v.mode).toBe('assigned')
    expect(v.modeOptions).toEqual(['assigned'])
  })

  it('worded the empty sentence for the mode, so a list read never claims "assigned"', () => {
    const list = view({
      connected: ['github'],
      on: true,
      config: { mode: 'list', query: 'label:bug' },
      read: { provider: 'github', ok: true, items: [], reason: null },
    })
    expect(list.emptyText).toMatch(/Nothing matches your list on GitHub/)

    const both = view({
      connected: ['github'],
      on: true,
      config: { mode: 'both', query: 'label:bug' },
      read: { provider: 'github', ok: true, items: [], reason: null },
    })
    expect(both.emptyText).toMatch(/Nothing assigned or on your list on GitHub/)
  })
})

describe('the remembered tracker (#the board opens where it was left)', () => {
  it('keeps the two answers in two keys', () => {
    // Hiding the column is not a change of mind about whose list is yours, so
    // the tracker cannot live in the same key as the on/off flag.
    expect(remoteSourceStorageKey('/repo')).not.toBe(remoteListStorageKey('/repo'))
    expect(remoteSourceStorageKey('/repo')).not.toBe(remoteSourceStorageKey('/other'))
  })

  it('accepts a tracker this build knows', () => {
    expect(rememberedRemoteSource('jira')).toBe('jira')
    expect(rememberedRemoteSource('github')).toBe('github')
    expect(rememberedRemoteSource('azure')).toBe('azure')
  })

  it('reads anything else as no answer, rather than as a provider', () => {
    // A value a newer build wrote, a hand-edit, or nothing stored at all.
    expect(rememberedRemoteSource('gitlab')).toBeNull()
    expect(rememberedRemoteSource('')).toBeNull()
    expect(rememberedRemoteSource(null)).toBeNull()
    expect(rememberedRemoteSource('JIRA')).toBeNull()
  })

  it('is honoured when that tracker is connected', () => {
    const view = remoteListView({
      connected: ['github', 'jira'],
      read: null,
      chosen: rememberedRemoteSource('jira'),
      on: true,
      reading: false,
    })
    // Not `github`, which is merely first in the list.
    expect(view.showing).toBe('jira')
  })

  it('falls back to a connected tracker when the remembered one is gone', () => {
    // Somebody disconnected Jira since they last looked. The board opens on
    // what it HAS rather than on a name nothing can answer.
    const view = remoteListView({
      connected: ['github'],
      read: null,
      chosen: rememberedRemoteSource('jira'),
      on: true,
      reading: false,
    })
    expect(view.showing).toBe('github')
  })
})

describe('folding a status sweep over what was last known (the vanished toggle)', () => {
  const outcomes = (
    entries: Partial<Record<IntegrationProvider, ConnectionOutcome>>,
  ): Map<IntegrationProvider, ConnectionOutcome> =>
    new Map(Object.entries(entries) as [IntegrationProvider, ConnectionOutcome][])

  it('adds a tracker the sweep found connected', () => {
    expect(mergeConnected([], outcomes({ github: 'connected' }))).toEqual(['github'])
  })

  it('removes one the sweep found explicitly disconnected', () => {
    expect(mergeConnected(['github'], outcomes({ github: 'disconnected' }))).toEqual([])
  })

  it('KEEPS a known-connected tracker when the probe FAILED, not drops it', () => {
    // The bug: a `gh`/`az` resolve that timed out, or a status handler missing
    // mid-update, came back as `unknown` — and the old code (`.catch(() => null)`)
    // treated that as "not connected", dropping the tracker. Nothing re-checks a
    // root that has not changed, so the Remote toggle vanished for the whole
    // session even though the tracker was connected the entire time.
    expect(mergeConnected(['github'], outcomes({ github: 'unknown' }))).toEqual(['github'])
  })

  it('does not invent a connection it never confirmed', () => {
    // `unknown` with nothing known before is still nothing — we can only keep
    // what we last saw, never conjure a tracker we have never confirmed.
    expect(mergeConnected([], outcomes({ github: 'unknown' }))).toEqual([])
  })

  it('folds all three trackers at once, each on its own outcome', () => {
    // github times out (keep — was known), jira answers connected (add), azure
    // answers disconnected (drop — was known).
    const merged = mergeConnected(
      ['github', 'azure'],
      outcomes({ github: 'unknown', jira: 'connected', azure: 'disconnected' }),
    )
    expect(merged).toEqual(['github', 'jira'])
  })

  it('keeps the offer order regardless of previous or outcome order', () => {
    expect(
      mergeConnected(['azure'], outcomes({ azure: 'connected', github: 'connected' })),
    ).toEqual(['github', 'azure'])
  })
})
