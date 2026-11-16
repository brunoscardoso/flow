import {
  WORKSPACE_INTENT_SEE_BOTH_EVENT,
  WORKSPACE_INTENT_UNDO_EVENT,
  WORKSPACE_SETTINGS_EVENT,
  WORKSPACE_SYNC_EVENT,
  createWorkspacePauseNotifier,
  workspaceIntentMergeNotification,
} from './pause-notice'
import type { WorkspaceIntentMergeDocument, WorkspaceIntentMergeSet, WorkspaceSyncStatus } from '../../shared/workspaces-contract'

const AT = '2026-10-02T12:00:00.000Z'

describe('the Workspace pause notifier', () => {
  const status = (state: WorkspaceSyncStatus['state'], detail: string | null): WorkspaceSyncStatus => ({
    state,
    lastSyncedAt: null,
    detail,
    asks: [],
    reviews: [],
  })
  const ASKED = 'Two people changed the same decision in Acme. Flow needs you to choose which one to keep.'

  it('announces the transition into a pause once; syncing again onto the same pause is not new', () => {
    const notifier = createWorkspacePauseNotifier()
    expect(notifier.observe('acme', status('syncing', null), AT)).toBeNull()
    const first = notifier.observe('acme', status('paused', ASKED), AT)
    expect(first).toMatchObject({ title: 'Workspace sync paused', body: ASKED, level: 'warn', rootId: 'workspace:acme' })
    expect(first?.action?.event).toBe(WORKSPACE_SYNC_EVENT)
    // The button names its Workspace, so the card opens on the right one.
    expect(first?.action?.detail).toEqual({ slug: 'acme' })
    expect(notifier.observe('acme', status('syncing', null), AT)).toBeNull()
    expect(notifier.observe('acme', status('paused', ASKED), AT)).toBeNull()
    // Leaving and coming back is a new pause.
    expect(notifier.observe('acme', status('synced', null), AT)).toBeNull()
    expect(notifier.observe('acme', status('paused', ASKED), AT)).not.toBeNull()
  })

  it('the toast chip shows the Workspace name, never the internal key', () => {
    const notice = createWorkspacePauseNotifier().observe('acme', status('error', 'Nothing was sent.'), AT, 'Acme Team')
    expect(notice).toMatchObject({ rootId: 'workspace:acme', label: 'Acme Team' })
    // Name not known: "Workspace" — never the folder slug.
    expect(createWorkspacePauseNotifier().observe('acme', status('error', 'Nothing was sent.'), AT)?.label).toBe('Workspace')
    expect(createWorkspacePauseNotifier().observe('acme', status('error', 'Nothing was sent.'), AT, null)?.label).toBe('Workspace')
  })

  it('no access and an error open Workspace settings — their own event, naming the Workspace', () => {
    const noAccess = createWorkspacePauseNotifier().observe('acme', status('no-access', 'Flow can’t reach it.'), AT, 'Acme')
    expect(noAccess?.action).toEqual({ label: 'Open Workspace settings', event: WORKSPACE_SETTINGS_EVENT, detail: { slug: 'acme' } })
    const error = createWorkspacePauseNotifier().observe('acme', status('error', 'Nothing was sent.'), AT, 'Acme')
    expect(error?.action?.event).toBe(WORKSPACE_SETTINGS_EVENT)
    expect(WORKSPACE_SETTINGS_EVENT).not.toBe(WORKSPACE_SYNC_EVENT)
  })

  it('an error needs a person too; offline and retries raise nothing', () => {
    const notifier = createWorkspacePauseNotifier()
    expect(notifier.observe('acme', status('offline', "Flow couldn't reach Acme's shared repository."), AT)).toBeNull()
    expect(notifier.observe('acme', status('idle', 'Flow will try again shortly.'), AT)).toBeNull()
    expect(notifier.observe('acme', status('error', 'Nothing was sent.'), AT)).toMatchObject({ level: 'error' })
  })
})

describe('the "Flow merged two edits" notification (FR-12)', () => {
  const document = (overrides: Partial<WorkspaceIntentMergeDocument> = {}): WorkspaceIntentMergeDocument => ({
    id: 'ask-1',
    path: 'projects/api/brain/decisions/queue.md',
    kind: 'decision',
    title: 'Use one queue for jobs',
    theirName: 'Bea',
    ours: 'a\n',
    theirs: 'b\n',
    base: null,
    merged: 'a b\n',
    current: 'merged',
    ...overrides,
  })
  const set = (documents: WorkspaceIntentMergeDocument[]): WorkspaceIntentMergeSet => ({
    slug: 'acme',
    mergeId: 'm1',
    at: AT,
    documents,
  })
  /** Anything that reads as an internal: a path, a command, a setting key, a file name. */
  const INTERNALS = /projects\/|\.md\b|planflow|--|workspace sync|\.flowconfig|[a-z]+_[a-z]+:|merges\//i

  it('one document: the approved title and body, Undo and a quiet See both, naming the merge set', () => {
    const notice = workspaceIntentMergeNotification(set([document()]), AT, 'Acme')
    expect(notice).toMatchObject({
      title: 'Flow merged two edits to "Use one queue for jobs"',
      body: 'You and Bea both changed this decision. Flow combined them into one version and kept both originals.',
      label: 'Acme',
      rootId: 'workspace:acme',
      level: 'info',
      action: { label: 'Undo', event: WORKSPACE_INTENT_UNDO_EVENT, detail: { slug: 'acme', mergeId: 'm1' } },
      secondaryAction: { label: 'See both', event: WORKSPACE_INTENT_SEE_BOTH_EVENT, detail: { slug: 'acme', mergeId: 'm1' } },
    })
  })

  it('several documents: one notification that lists them; no git name → "a teammate"; the kind word each', () => {
    const notice = workspaceIntentMergeNotification(
      set([document({ theirName: null }), document({ id: 'r-1', kind: 'plan', title: 'Queue plan', theirName: null })]),
      AT,
    )
    expect(notice?.title).toBe('Flow merged edits to 2 documents')
    expect(notice?.body).toBe(
      'You and a teammate both changed these. Flow combined each into one version and kept both originals.\n- "Use one queue for jobs" (decision)\n- "Queue plan" (plan)',
    )
    expect(notice?.label).toBe('Workspace')
  })

  it('no command, path or setting key in any of its words', () => {
    for (const notice of [
      workspaceIntentMergeNotification(set([document()]), AT, 'Acme'),
      workspaceIntentMergeNotification(set([document({ kind: 'discovery' }), document({ id: 'x', kind: 'plan', theirName: null })]), AT),
    ]) {
      // Positive first: there is copy to check.
      expect(notice?.body.length).toBeGreaterThan(20)
      const words = [notice?.title, notice?.body, notice?.action?.label, notice?.secondaryAction?.label].join(' ')
      expect(words).not.toMatch(INTERNALS)
    }
    expect(workspaceIntentMergeNotification(set([]), AT)).toBeNull()
  })
})
