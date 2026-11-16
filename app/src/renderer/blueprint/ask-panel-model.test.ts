// The Ask panel's whole behaviour as a pure reducer: state transitions, the
// answer replaced in place, follow-ups, saved answers, and what the map shows
// per state (askDecoration / projectDecoration).

import type { AskAnswer, AskSavedThread, AskStateEvent } from '../../shared/ask-contract'
import {
  askDecoration,
  askPhase,
  canFollowUp,
  continuePrompt,
  decorationKey,
  durationLabel,
  followUpTarget,
  initialAskState,
  kindOfId,
  labelOfId,
  listLabel,
  ageLabel,
  MAX_FOLLOW_UPS,
  projectDecoration,
  reduceAsk,
  runningAskIds,
  tagsFromOpen,
  type AskPanelEvent,
  type AskPanelState,
  type AskTag,
} from './ask-panel-model'

const CONNECTORS: AskTag = { id: 'feature:connectors', kind: 'feature', label: 'Connectors' }
const CREDENTIALS: AskTag = { id: 'feature:connectors/credentials', kind: 'part', label: 'Connectors · Credentials' }
const CONVO: AskTag = { id: 'thread-1', kind: 'conversation', label: 'Vault work' }

function run(events: AskPanelEvent[], from: AskPanelState = initialAskState()): AskPanelState {
  return events.reduce(reduceAsk, from)
}

function answer(patch: Partial<AskAnswer> = {}): AskAnswer {
  return {
    explanation: 'In the vault.',
    confidence: 'first',
    thin: true,
    sources: [],
    factsLearned: 0,
    factsSaved: true,
    partial: false,
    ...patch,
  }
}

function state(askId: string, phase: AskStateEvent['phase'], a: AskAnswer | null, at = 0): AskPanelEvent {
  return { type: 'state', event: { askId, rootId: '/repo', phase, answer: a }, at }
}

const asked = (): AskPanelState =>
  run([
    { type: 'open', text: 'Where do secrets live?', tags: [CONNECTORS] },
    { type: 'submit', question: 'Where do secrets live?', followUp: false, at: 1000 },
    { type: 'started', askId: 'ask-1' },
  ])

describe('reduceAsk — composing', () => {
  it('opens fresh with text or tags, and where it was left with neither', () => {
    const opened = run([{ type: 'open', text: 'hello', tags: [CONNECTORS, CONNECTORS] }])
    expect(opened).toMatchObject({ open: true, view: 'compose', draft: 'hello', tags: [CONNECTORS] })
    const reopened = run([{ type: 'close' }, { type: 'open' }], opened)
    expect(reopened).toMatchObject({ open: true, draft: 'hello', tags: [CONNECTORS] })
  })

  it('adds and removes tags once; suggestions skip what is tagged and can be accepted', () => {
    let s = run([{ type: 'add-tag', tag: CONNECTORS }, { type: 'add-tag', tag: CONNECTORS }])
    expect(s.tags).toEqual([CONNECTORS])
    s = run(
      [
        {
          type: 'suggest',
          suggestions: [
            { id: CONNECTORS.id, kind: 'feature', label: 'Connectors' },
            { id: CREDENTIALS.id, kind: 'part', label: CREDENTIALS.label },
            { id: 'feature:coworkers', kind: 'feature', label: 'Coworkers' },
          ],
        },
      ],
      s,
    )
    expect(s.suggestions.map((x) => x.id)).toEqual([CREDENTIALS.id, 'feature:coworkers'])
    s = run([{ type: 'accept-suggestion', id: CREDENTIALS.id }], s)
    expect(s.tags.map((t) => t.id)).toEqual([CONNECTORS.id, CREDENTIALS.id])
    expect(s.suggestions.map((x) => x.id)).toEqual(['feature:coworkers'])
    s = run([{ type: 'accept-all-suggestions' }], s)
    expect(s.tags.map((t) => t.id)).toEqual([CONNECTORS.id, CREDENTIALS.id, 'feature:coworkers'])
    expect(s.suggestions).toEqual([])
    s = run([{ type: 'remove-tag', id: CONNECTORS.id }], s)
    expect(s.tags.map((t) => t.id)).toEqual([CREDENTIALS.id, 'feature:coworkers'])
  })

  it('an empty question does not submit', () => {
    const s = run([{ type: 'submit', question: '   ', followUp: false, at: 0 }])
    expect(s.turns).toEqual([])
    expect(askPhase(s)).toBe('idle')
  })
})

describe('reduceAsk — one turn', () => {
  it('fast → digging → done, the checked answer replacing the fast one in place', () => {
    let s = asked()
    expect(askPhase(s)).toBe('fast')
    expect(runningAskIds(s)).toEqual(['ask-1'])

    s = reduceAsk(s, state('ask-1', { kind: 'fast' }, answer(), 4000))
    expect(s.turns[0].answer?.explanation).toBe('In the vault.')
    expect(s.turns[0].answeredAfterMs).toBe(3000)

    // A dig step without an answer keeps the fast one shown.
    s = reduceAsk(s, state('ask-1', { kind: 'digging', steps: [{ label: 'Read a.ts', state: 'current' }], reads: 1, elapsedMs: 900 }, null, 5000))
    expect(s.turns[0]).toMatchObject({ phase: 'digging', reads: 1, digElapsedMs: 900 })
    expect(s.turns[0].answer?.explanation).toBe('In the vault.')

    s = reduceAsk(s, state('ask-1', { kind: 'done' }, answer({ explanation: 'In the vault service.', confidence: 'checked', savedId: 'qa-1' }), 9000))
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]).toMatchObject({ phase: 'done', changedFromFirst: true, answeredAfterMs: 8000 })
    expect(s.turns[0].answer?.explanation).toBe('In the vault service.')
    expect(runningAskIds(s)).toEqual([])
    expect(followUpTarget(s)).toBe('qa-1')
  })

  it('a checked answer with the same text is not "changed from first"', () => {
    const s = run([state('ask-1', { kind: 'fast' }, answer()), state('ask-1', { kind: 'done' }, answer({ confidence: 'checked' }))], asked())
    expect(s.turns[0].changedFromFirst).toBe(false)
  })

  it('ignores state for a run no turn owns', () => {
    const s = asked()
    expect(reduceAsk(s, state('ask-other', { kind: 'done' }, answer()))).toBe(s)
  })

  it('Stop here marks stopping until main answers partial', () => {
    let s = run([{ type: 'stop' }], asked())
    expect(s.turns[0].stopping).toBe(true)
    s = reduceAsk(s, state('ask-1', { kind: 'partial' }, answer({ partial: true })))
    expect(s.turns[0]).toMatchObject({ phase: 'partial', stopping: false })
  })

  it('an error ends the turn with its sentence; a refused start does too', () => {
    const errored = reduceAsk(asked(), state('ask-1', { kind: 'error', sentence: "The answer couldn't be saved." }, answer()))
    expect(errored.turns[0]).toMatchObject({ phase: 'error', error: "The answer couldn't be saved." })
    expect(errored.turns[0].answer?.explanation).toBe('In the vault.')

    const refused = run([
      { type: 'submit', question: 'q', followUp: false, at: 0 },
      { type: 'start-failed', sentence: 'Flow is busy.' },
    ])
    expect(refused.turns[0]).toMatchObject({ phase: 'error', error: 'Flow is busy.', askId: null })
  })
})

describe('reduceAsk — follow-ups', () => {
  const done = (): AskPanelState =>
    reduceAsk(asked(), state('ask-1', { kind: 'done' }, answer({ savedId: 'qa-1', confidence: 'checked' })))

  it('waits for the running turn, then adds a turn with the same tags', () => {
    const running = asked()
    expect(canFollowUp(running)).toBe(false)
    expect(reduceAsk(running, { type: 'submit', question: 'and?', followUp: true, at: 0 })).toBe(running)

    const s = reduceAsk(done(), { type: 'submit', question: 'And who rotates them?', followUp: true, at: 0 })
    expect(s.turns).toHaveLength(2)
    expect(s.turns[1]).toMatchObject({ question: 'And who rotates them?', tags: [CONNECTORS], askId: null })
    expect(followUpTarget(s)).toBe('qa-1')
  })

  it('stops at the follow-up cap', () => {
    let s = done()
    for (let i = 0; i < MAX_FOLLOW_UPS + 2; i += 1) {
      s = reduceAsk(s, { type: 'submit', question: `f${i}`, followUp: true, at: 0 })
      s = reduceAsk(s, { type: 'started', askId: `ask-f${i}` })
      s = reduceAsk(s, state(`ask-f${i}`, { kind: 'done' }, answer()))
    }
    expect(s.turns).toHaveLength(MAX_FOLLOW_UPS + 1)
    expect(canFollowUp(s)).toBe(false)
  })

  it('new question returns to compose keeping the tags', () => {
    const s = reduceAsk(done(), { type: 'new-question' })
    expect(s).toMatchObject({ view: 'compose', draft: '', turns: [], tags: [CONNECTORS] })
  })
})

describe('reduceAsk — saved answers', () => {
  const saved: AskSavedThread = {
    id: 'qa-1',
    ts: '2026-11-01T10:00:00Z',
    author: 'Ana',
    question: 'Where?',
    tags: ['feature:connectors/credentials'],
    conversationCount: 0,
    usedConversation: false,
    answer: 'Vault.',
    sources: [{ label: 'Plain' }, { label: 'Creds', featureId: 'feature:connectors/credentials' }],
    factsLearned: 2,
    partial: false,
    followUps: [{ id: 'qa-2', ts: '2026-11-01T10:05:00Z', author: 'Bo', question: 'Who?', tags: [], conversationCount: 0, usedConversation: false, answer: 'Ops.', sources: [], factsLearned: 0, partial: true }],
  }

  it('opens a saved thread as turns, stale when the history said so, sources numbered', () => {
    const s = run([
      { type: 'history', threads: [saved], stale: [{ id: 'qa-1', stale: true, changedFiles: ['a.ts'], missingFiles: [] }] },
      { type: 'open-saved', thread: saved },
    ])
    expect(s.view).toBe('answer')
    expect(s.turns).toHaveLength(2)
    expect(s.turns[0]).toMatchObject({ phase: 'done', saved: { id: 'qa-1', author: 'Ana', stale: true } })
    expect(s.turns[0].tags).toEqual([{ id: 'feature:connectors/credentials', kind: 'part', label: 'Credentials' }])
    // Numbered by position, as a fresh answer's are — what its [n] citations name.
    expect(s.turns[0].answer?.sources.map((x) => x.n)).toEqual([1, 2])
    expect(s.turns[1]).toMatchObject({ phase: 'partial' })
    expect(followUpTarget(s)).toBe('qa-1')
  })

  it('stale results update; a fresh result clears a stale id', () => {
    let s = run([{ type: 'asked-before', threads: [saved], stale: [{ id: 'qa-1', stale: true, changedFiles: [], missingFiles: [] }] }])
    expect(s.staleIds).toEqual(['qa-1'])
    s = run([{ type: 'asked-before', threads: [saved], stale: [{ id: 'qa-1', stale: false, changedFiles: [], missingFiles: [] }] }], s)
    expect(s.staleIds).toEqual([])
  })

  it('a failed history read keeps the list and says why', () => {
    const s = run([{ type: 'show-history' }, { type: 'history-failed', sentence: 'Could not read.' }])
    expect(s).toMatchObject({ view: 'history', history: [], historyError: 'Could not read.' })
  })
})

describe('askDecoration', () => {
  it('shows nothing while the panel is closed', () => {
    expect(askDecoration(initialAskState()).active).toBe(false)
  })

  it('composing outlines tagged features (not conversations) and dims the rest', () => {
    const s = run([{ type: 'open', tags: [CONNECTORS, CONVO] }])
    expect(askDecoration(s)).toMatchObject({ active: true, dimOthers: true, outlined: [CONNECTORS.id], live: [], numbers: [] })
    const untagged = run([{ type: 'open' }])
    expect(askDecoration(untagged)).toMatchObject({ active: true, dimOthers: false, outlined: [] })
  })

  it('while digging: tagged cells reading, cited ones read, mentions dashed; no numbers yet', () => {
    const cited = answer({ sources: [{ n: 1, label: 'Coworkers', featureId: 'feature:coworkers' }] })
    const s = reduceAsk(asked(), state('ask-1', { kind: 'digging', steps: [], reads: 0, elapsedMs: 0 }, cited))
    expect(askDecoration(s)).toMatchObject({
      mentioned: ['feature:coworkers'],
      live: [
        { id: CONNECTORS.id, state: 'reading' },
        { id: 'feature:coworkers', state: 'read' },
      ],
      numbers: [],
    })
  })

  it('done: numbers and facts; a part of a tagged feature is not a mention', () => {
    const done = answer({
      confidence: 'checked',
      factsLearned: 3,
      sources: [{ n: 1, label: 'Connectors › Credentials', featureId: CREDENTIALS.id, file: 'src/vault.ts' }],
    })
    const s = reduceAsk(asked(), state('ask-1', { kind: 'done' }, done))
    const d = askDecoration(s)
    expect(d).toMatchObject({
      mentioned: [],
      live: [],
      numbers: [{ id: CREDENTIALS.id, n: 1, label: 'Credentials' }],
      facts: { id: CREDENTIALS.id, count: 3 },
    })
    // Stable: the same state gives an equal key, so the board skips a redraw.
    expect(decorationKey(askDecoration(s))).toBe(decorationKey(d))
  })

  it('partial: a tagged part the answer never reached is thin', () => {
    const s = reduceAsk(asked(), state('ask-1', { kind: 'partial' }, answer({ partial: true })))
    expect(askDecoration(s).live).toEqual([{ id: CONNECTORS.id, state: 'thin' }])
  })
})

describe('projectDecoration', () => {
  it('lands a part on its drawn feature, and a feature on its drawn parts', () => {
    const s = reduceAsk(
      asked(),
      state('ask-1', { kind: 'done' }, answer({ sources: [{ n: 1, label: 'Creds', featureId: 'feature:coworkers/invite' }] })),
    )
    const top = projectDecoration(askDecoration(s), new Set(['feature:connectors', 'feature:coworkers']))
    expect(top.get('feature:connectors')?.role).toBe('tagged')
    expect(top.get('feature:coworkers')).toMatchObject({ role: 'mentioned', numbers: [{ n: 1, label: 'Creds' }] })

    const inside = projectDecoration(askDecoration(s), new Set(['feature:connectors/a', 'feature:connectors/b']))
    expect(inside.get('feature:connectors/a')?.role).toBe('tagged')
    expect(inside.get('feature:connectors/b')?.role).toBe('tagged')
  })

  it('is empty for an inactive decoration', () => {
    expect(projectDecoration(askDecoration(initialAskState()), new Set(['feature:x'])).size).toBe(0)
  })
})

describe('helpers', () => {
  it('kindOfId / labelOfId / tagsFromOpen', () => {
    expect(kindOfId('feature:a')).toBe('feature')
    expect(kindOfId('feature:a/b')).toBe('part')
    expect(kindOfId('thread-9')).toBe('conversation')
    expect(labelOfId('feature:connectors/api_keys')).toBe('Api keys')
    expect(tagsFromOpen([{ id: 'feature:a', kind: 'feature' }], 't1', 'Chat')).toEqual([
      { id: 'feature:a', kind: 'feature', label: 'A' },
      { id: 't1', kind: 'conversation', label: 'Chat' },
    ])
    expect(tagsFromOpen([{ id: 't1', kind: 'conversation', label: 'Mine' }], 't1')).toHaveLength(1)
    expect(tagsFromOpen(undefined, 't2')).toEqual([{ id: 't2', kind: 'conversation', label: 'This conversation' }])
  })

  it('labels', () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    expect(ageLabel('2026-11-15T11:59:30Z', now)).toBe('just now')
    expect(ageLabel('2026-11-14T12:00:00Z', now)).toBe('yesterday')
    expect(ageLabel('not a date', now)).toBe('')
    expect(durationLabel(4200)).toBe('4 s')
    expect(durationLabel(100_000)).toBe('1 min 40 s')
    expect(listLabel(['A', 'B', 'C'])).toBe('A, B and C')
  })

  it('continuePrompt carries the question, the answer and its sources — nothing is sent', () => {
    const s = reduceAsk(
      asked(),
      state(
        'ask-1',
        { kind: 'done' },
        answer({
          verdict: { label: 'Yes · small', risk: 'Rotation.' },
          branchInProgress: 'Already in progress on branch feat/vault (not merged)',
          sources: [{ n: 1, label: 'Creds', featureId: CREDENTIALS.id }, { n: null, label: 'vault', file: 'src/vault.ts' }],
        }),
      ),
    )
    expect(continuePrompt(s.turns[0])).toBe(
      [
        'Where do secrets live?',
        '',
        'The Blueprint answered:',
        'In the vault.',
        '',
        'Can we build it? Yes · small — Rotation.',
        '',
        'Already in progress on branch feat/vault (not merged)',
        '',
        'Sources:',
        '1. Creds',
        '2. vault (src/vault.ts)',
      ].join('\n'),
    )
  })
})
