import {
  WORKSPACE_SETTINGS_EVENT,
  WORKSPACE_SYNC_EVENT,
  createWorkspacePauseNotifier,
} from './pause-notice'
import type { WorkspaceSyncStatus } from '../../shared/workspaces-contract'

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
