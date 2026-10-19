import type { WorkspaceSyncAsk, WorkspaceSyncReview, WorkspaceSyncStatus } from '../../shared/workspaces-contract'
import {
  ALL_SETTLED,
  DRAFT_BEGIN,
  DRAFT_END,
  KEEP_MINE,
  KEEP_THEIRS,
  LET_FLOW_ADAPT,
  RECORD_CHANGE,
  USE_MERGED,
  WORKSPACE_SYNC_EVENT,
  adaptPrompt,
  askView,
  choicesFor,
  collisionItems,
  extractDraft,
  introLine,
  humanTopic,
  noteTopic,
  recordChange,
  recordPrompt,
  collisionThreadMessage,
  reviewView,
  takeOf,
  threadProjectFor,
} from './collision-card-model'

function ask(partial: Partial<WorkspaceSyncAsk>): WorkspaceSyncAsk {
  return {
    id: 'ask-1',
    kind: 'same-feature',
    topic: 'Feature flags',
    path: 'projects/backend/brain/features/flags.md',
    existingPath: 'projects/backend/brain/features/flags.md',
    existing: 'Flags roll out by team.',
    incoming: 'Flags roll out by percentage.',
    merged: null,
    truncated: false,
    options: ['ours', 'theirs', 'merged', 'file'],
    ...partial,
  }
}

function review(partial: Partial<WorkspaceSyncReview>): WorkspaceSyncReview {
  return {
    id: 'review-1',
    kind: 'conflict',
    path: 'projects/backend/brain/decisions/auth-flow.md',
    base: 'base',
    existing: 'theirs text',
    incoming: 'ours text',
    conflicted: '<<<<<<< ours\nours text\n=======\ntheirs text\n>>>>>>> theirs\n',
    truncated: true,
    options: ['ours', 'theirs', 'file'],
    ...partial,
  }
}

function paused(asks: WorkspaceSyncAsk[], reviews: WorkspaceSyncReview[] = []): WorkspaceSyncStatus {
  return { state: 'paused', lastSyncedAt: null, detail: 'Acme needs you.', asks, reviews }
}

describe('the event the paused notification sends', () => {
  it('is the one main’s notification dispatches', () => {
    expect(WORKSPACE_SYNC_EVENT).toBe('flow:open-workspace-sync')
  })
})

describe('choices', () => {
  it('offers every choice the item allows, in the card’s order', () => {
    expect(choicesFor(['ours', 'theirs', 'merged', 'file'], 'merged text').map((choice) => choice.label)).toEqual([
      KEEP_MINE,
      KEEP_THEIRS,
      USE_MERGED,
      LET_FLOW_ADAPT,
      RECORD_CHANGE,
    ])
  })
  it('never offers a merged version git did not produce', () => {
    expect(choicesFor(['ours', 'theirs', 'merged'], null).map((choice) => choice.choice)).toEqual(['ours', 'theirs', 'record'])
  })
  it('the two agent choices need a thread; the rest settle directly', () => {
    const choices = choicesFor(['ours', 'theirs', 'file'], null)
    expect(choices.filter((choice) => choice.needsThread).map((choice) => choice.choice)).toEqual(['adapt', 'record'])
    expect(takeOf('ours')).toBe('ours')
    expect(takeOf('theirs')).toBe('theirs')
    expect(takeOf('merged')).toBe('merged')
    expect(takeOf('adapt')).toBeNull()
    expect(takeOf('record')).toBeNull()
  })
})

describe('human topics', () => {
  it('turns a path-shaped topic into words: the note, and the project it is in', () => {
    expect(humanTopic('backend/decisions/flag-rollout')).toBe('flag rollout in backend')
    expect(humanTopic('projects/backend/brain/decisions/auth-flow.md')).toBe('auth flow in backend')
    expect(humanTopic('decisions/auth-flow.md')).toBe('auth flow')
    expect(humanTopic('backend/auth')).toBe('auth in backend')
    expect(humanTopic('backend/discovery checkout-v2')).toBe('checkout v2 in backend')
    expect(humanTopic('backend: src/a.ts, src/b.ts')).toBe('the same code in backend')
  })
  it('leaves a topic that is already words alone', () => {
    expect(humanTopic('Feature flags')).toBe('Feature flags')
  })
  it('an ask with a path-shaped topic shows the words', () => {
    expect(askView(ask({ kind: 'decision', topic: 'backend/decisions/flag-rollout' })).topic).toBe('flag rollout in backend')
  })
})

describe('items', () => {
  it('an ask shows the Workspace’s text, this computer’s and the merge', () => {
    const view = askView(ask({ merged: 'Flags roll out by team, then by percentage.' }))
    expect(view.sides.map((side) => side.heading)).toEqual([
      'What the Workspace already says',
      'This computer’s version',
      'The merged version',
    ])
    expect(view.sides[0]?.text).toBe('Flags roll out by team.')
    expect(view.topic).toBe('Feature flags')
  })
  it('a removed side says so', () => {
    expect(askView(ask({ existing: null })).sides[0]?.text).toBe('Nothing — removed on this side')
  })
  it('a review is named by its note, never its location, and shows the conflicted text', () => {
    const view = reviewView(review({}))
    expect(view.topic).toBe('auth flow in backend')
    expect(view.sides.map((side) => side.heading)).toContain('Both versions, side by side in one note')
    expect(view.truncated).toBe(true)
    expect(noteTopic('a/b/c.walkthrough.html')).toBe('c')
  })
  it('decisions come first, always shown; nothing waits unless paused', () => {
    const items = collisionItems(
      paused([ask({ id: 'feature' }), ask({ id: 'decision', kind: 'decision', topic: 'Rollout' })], [review({})]),
    )
    expect(items.map((item) => item.id)).toEqual(['decision', 'feature', 'review-1'])
    expect(items[0]?.isDecision).toBe(true)
    expect(collisionItems({ ...paused([ask({})]), state: 'synced' })).toEqual([])
    expect(collisionItems(null)).toEqual([])
    expect(ALL_SETTLED).toMatch(/settled/)
  })
  it('the intro counts', () => {
    expect(introLine('Acme', 1)).toBe('Acme needs you to choose one thing before it syncs again.')
    expect(introLine('Acme', 2)).toBe('Acme needs you to choose 2 things before it syncs again.')
  })
})

describe('Let Flow adapt it', () => {
  const item = askView(ask({}))
  it('sends both versions and how to hand the draft back', () => {
    const prompt = adaptPrompt({ workspaceName: 'Acme', item })
    expect(prompt).toContain('Flags roll out by team.')
    expect(prompt).toContain('Flags roll out by percentage.')
    expect(prompt).toContain(DRAFT_BEGIN)
    expect(prompt).toContain(DRAFT_END)
    expect(prompt).not.toMatch(/`/)
  })
  it('reads the draft from the newest assistant message that has one', () => {
    const messages = [
      { role: 'user', content: adaptPrompt({ workspaceName: 'Acme', item }) },
      { role: 'assistant', content: `Here:\n${DRAFT_BEGIN}\nold draft\n${DRAFT_END}` },
      { role: 'assistant', content: `Better:\n\`\`\`\n${DRAFT_BEGIN}\nFlags roll out by team,\nthen by percentage.\n${DRAFT_END}\n\`\`\`` },
      { role: 'assistant', content: 'Anything else?' },
    ]
    expect(extractDraft(messages)).toBe('Flags roll out by team,\nthen by percentage.\n')
  })
  it('a user message quoting the markers is never the draft; nothing yet reads as null', () => {
    expect(extractDraft([{ role: 'user', content: `${DRAFT_BEGIN}\nx\n${DRAFT_END}` }])).toBeNull()
    expect(extractDraft([{ role: 'assistant', content: `${DRAFT_BEGIN}\n\n${DRAFT_END}` }])).toBeNull()
    expect(extractDraft([])).toBeNull()
  })
})

describe('Record a change', () => {
  it('keeps the Workspace’s version and carries this computer’s into the conversation', () => {
    const prompt = recordPrompt({ workspaceName: 'Acme', item: askView(ask({})) })
    expect(prompt).toContain('Flags roll out by percentage.')
    expect(prompt).toContain('new decision')
  })
})

describe('the thread’s project', () => {
  it('is the first of the Workspace’s projects open here', () => {
    expect(threadProjectFor([null, '/code/frontend/', '/code/backend'], ['/code/backend', '/code/frontend'])).toBe('/code/frontend')
    expect(threadProjectFor(['/code/other'], ['/code/backend'])).toBeNull()
  })
})

describe('the collision card\'s conversations', () => {
  it('skip the context gate — the card already chose the project', () => {
    expect(collisionThreadMessage('t1', 'hello')).toEqual({ threadId: 't1', content: 'hello', skipContextGate: true })
  })

  it('Record a change starts the conversation BEFORE keeping the Workspace\'s version', async () => {
    const calls: string[] = []
    const outcome = await recordChange({
      createThread: async () => {
        calls.push('create')
        return 't1'
      },
      keepTheirs: async () => {
        calls.push('keep')
        return true
      },
      send: async (threadId) => {
        calls.push(`send ${threadId}`)
      },
      discardThread: async () => {
        calls.push('discard')
      },
    })
    expect(outcome).toEqual({ kind: 'recorded', threadId: 't1' })
    expect(calls).toEqual(['create', 'keep', 'send t1'])
  })

  it('when the conversation cannot start, nothing is resolved', async () => {
    const calls: string[] = []
    const outcome = await recordChange({
      createThread: async () => {
        calls.push('create')
        return null
      },
      keepTheirs: async () => {
        calls.push('keep')
        return true
      },
      send: async () => {
        calls.push('send')
      },
      discardThread: async () => {
        calls.push('discard')
      },
    })
    expect(outcome).toEqual({ kind: 'thread-failed' })
    expect(calls).toEqual(['create'])
  })

  it('when keeping the Workspace\'s version fails, the empty conversation is removed again', async () => {
    const calls: string[] = []
    const outcome = await recordChange({
      createThread: async () => 't1',
      keepTheirs: async () => false,
      send: async () => {
        calls.push('send')
      },
      discardThread: async (threadId) => {
        calls.push(`discard ${threadId}`)
      },
    })
    expect(outcome).toEqual({ kind: 'not-resolved' })
    expect(calls).toEqual(['discard t1'])
  })
})
