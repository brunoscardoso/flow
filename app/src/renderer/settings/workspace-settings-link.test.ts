import { WORKSPACE_SETTINGS_EVENT as MAIN_EVENT } from '../../main/knowledge-sync/pause-notice'
import { WORKSPACE_SETTINGS_EVENT, initWorkspaceSettingsLink } from './workspace-settings-link'

describe('the Workspace settings link', () => {
  it('names the same event main\'s notification dispatches', () => {
    expect(WORKSPACE_SETTINGS_EVENT).toBe(MAIN_EVENT)
  })

  it('opens Settings on the Workspaces group, and stops when unsubscribed', () => {
    const target = new EventTarget()
    const opened: unknown[] = []
    target.addEventListener('flow:open-settings', (event) => opened.push((event as CustomEvent).detail))
    const stop = initWorkspaceSettingsLink(target)
    target.dispatchEvent(new CustomEvent(WORKSPACE_SETTINGS_EVENT, { detail: { slug: 'acme' } }))
    expect(opened).toEqual([{ group: 'workspaces' }])
    stop()
    target.dispatchEvent(new CustomEvent(WORKSPACE_SETTINGS_EVENT))
    expect(opened).toHaveLength(1)
  })
})
