import {
  WORKSPACE_INTENT_SEE_BOTH_EVENT as MAIN_SEE_BOTH,
  WORKSPACE_INTENT_UNDO_EVENT as MAIN_UNDO,
} from '../../main/knowledge-sync/pause-notice'
import type { WorkspaceIntentMergeDocument } from '../../shared/workspaces-contract'
import {
  WORKSPACE_INTENT_SEE_BOTH_EVENT,
  WORKSPACE_INTENT_UNDO_EVENT,
  intentCardTitle,
  intentDocumentView,
  intentEventDetail,
} from './intent-merge-card-model'

const DOC: WorkspaceIntentMergeDocument = {
  id: 'ask-1',
  path: 'projects/api/brain/decisions/queue.md',
  kind: 'decision',
  title: 'Use one queue',
  theirName: 'Bea',
  ours: 'mine\n',
  theirs: 'hers\n',
  base: null,
  merged: 'both\n',
  current: 'merged',
}

describe('the events the merged notification sends', () => {
  it('are the ones main’s notification dispatches', () => {
    expect(WORKSPACE_INTENT_UNDO_EVENT).toBe(MAIN_UNDO)
    expect(WORKSPACE_INTENT_SEE_BOTH_EVENT).toBe(MAIN_SEE_BOTH)
    expect(WORKSPACE_INTENT_UNDO_EVENT).not.toBe(WORKSPACE_INTENT_SEE_BOTH_EVENT)
  })

  it('carry the Workspace and the merge set, and nothing else is accepted', () => {
    expect(intentEventDetail({ slug: 'acme', mergeId: 'm1' })).toEqual({ slug: 'acme', mergeId: 'm1' })
    expect(intentEventDetail({ slug: 'acme' })).toBeNull()
    expect(intentEventDetail(null)).toBeNull()
  })
})

describe('See both', () => {
  it('three panes — Yours, Bea’s, Merged (in use) — and Keep merged is the primary choice', () => {
    const view = intentDocumentView(DOC)
    expect(view.panes.map((pane) => [pane.heading, pane.text])).toEqual([
      ['Yours', 'mine\n'],
      ["Bea's", 'hers\n'],
      ['Merged (in use)', 'both\n'],
    ])
    expect(view.choices.map((choice) => [choice.label, choice.primary, choice.disabled])).toEqual([
      ['Keep yours', false, false],
      ["Keep Bea's", false, false],
      ['Keep merged', true, true],
    ])
    expect(view.intro).toBe('You and Bea both changed this decision. Flow combined them into one version and kept both originals.')
    expect(intentCardTitle({ slug: 'acme', mergeId: 'm1', at: '', documents: [DOC] })).toBe('Two edits to "Use one queue"')
  })

  it('after Undo, Yours is in use; with no git name the teammate is "a teammate"', () => {
    const view = intentDocumentView({ ...DOC, current: 'ours', theirName: null })
    expect(view.panes.map((pane) => pane.heading)).toEqual(['Yours (in use)', "Your teammate's", 'Merged'])
    expect(view.choices.map((choice) => choice.label)).toEqual(['Keep yours', "Keep your teammate's", 'Keep merged'])
    expect(view.intro).toContain('You and a teammate both changed this decision.')
  })

  it('no path, command or setting key in any word it shows', () => {
    const view = intentDocumentView(DOC)
    const words = [view.title, view.intro, ...view.panes.map((pane) => pane.heading), ...view.choices.map((choice) => choice.label)].join(' ')
    expect(words.length).toBeGreaterThan(40)
    expect(words).not.toMatch(/projects\/|\.md\b|planflow|--|\.flowconfig/)
  })
})
