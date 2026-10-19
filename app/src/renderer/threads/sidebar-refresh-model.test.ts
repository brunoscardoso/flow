import { sidebarRefreshAction, threadEventsAffectSidebar } from './sidebar-refresh-model'
import type { ThreadChangeEvent } from '../../shared/ipc-contract'

const event = (entity: ThreadChangeEvent['entity']): ThreadChangeEvent => ({
  entity,
  action: 'updated',
  threadId: 't1',
})

describe('threadEventsAffectSidebar (#1696)', () => {
  it('drops a batch that is purely tool-call churn', () => {
    expect(threadEventsAffectSidebar([event('tool_call'), event('tool_call')])).toBe(false)
  })

  it('keeps a batch with a thread event', () => {
    expect(threadEventsAffectSidebar([event('thread')])).toBe(true)
  })

  it('keeps a batch with a message event', () => {
    expect(threadEventsAffectSidebar([event('message')])).toBe(true)
  })

  it('keeps a mixed batch — one relevant event buys the refresh', () => {
    expect(threadEventsAffectSidebar([event('tool_call'), event('message'), event('tool_call')])).toBe(
      true,
    )
  })

  it('treats an empty batch as affecting (conservative)', () => {
    expect(threadEventsAffectSidebar([])).toBe(true)
  })
})

describe('sidebarRefreshAction (#1696)', () => {
  it('refreshes when the batch matters and the sidebar is visible', () => {
    expect(sidebarRefreshAction({ affectsSidebar: true, visible: true })).toBe('refresh')
  })

  it('defers when the batch matters but the sidebar is hidden', () => {
    expect(sidebarRefreshAction({ affectsSidebar: true, visible: false })).toBe('defer')
  })

  it('skips an irrelevant batch regardless of visibility', () => {
    expect(sidebarRefreshAction({ affectsSidebar: false, visible: true })).toBe('skip')
    expect(sidebarRefreshAction({ affectsSidebar: false, visible: false })).toBe('skip')
  })
})
