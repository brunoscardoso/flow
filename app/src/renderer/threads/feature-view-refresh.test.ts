import { decideFeatureViewRefresh, featureViewPageChange, featureViewTabId, featureViewTabLabel, featureViewsToClose } from './feature-view-refresh'

describe('decideFeatureViewRefresh', () => {
  it('re-reads now when the view is on screen', () => {
    expect(decideFeatureViewRefresh({ tabOpen: true, onScreen: true })).toBe('now')
  })

  it('defers (marks stale) when the tab is open but not on screen', () => {
    expect(decideFeatureViewRefresh({ tabOpen: true, onScreen: false })).toBe('defer')
  })

  it('skips when the tab is closed, whatever onScreen claims', () => {
    expect(decideFeatureViewRefresh({ tabOpen: false, onScreen: false })).toBe('skip')
    expect(decideFeatureViewRefresh({ tabOpen: false, onScreen: true })).toBe('skip')
  })
})

describe('featureViewsToClose', () => {
  const views = [
    { id: 'flow://feature-view/pay?root=%2Fa', rootPath: '/a', threadId: null },
    { id: 'flow://feature-view/pay?root=%2Fb', rootPath: '/b', threadId: null },
  ]

  it('closes every view of another project and keeps the active project’s', () => {
    expect(featureViewsToClose(views, '/a')).toEqual(['flow://feature-view/pay?root=%2Fb'])
  })

  it('closes every view when no project is active', () => {
    expect(featureViewsToClose(views, null)).toEqual(views.map((view) => view.id))
  })

  it('closes nothing when every view belongs to the active project', () => {
    expect(featureViewsToClose([views[0]], '/a')).toEqual([])
  })

  it('closes a view of another conversation in the same project, keeps this one’s', () => {
    const byThread = [
      { id: 'a1', rootPath: '/a', threadId: 't1' },
      { id: 'a2', rootPath: '/a', threadId: 't2' },
      { id: 'a0', rootPath: '/a', threadId: null },
    ]
    expect(featureViewsToClose(byThread, '/a', 't1')).toEqual(['a2', 'a0'])
    expect(featureViewsToClose(byThread, '/a', null)).toEqual(['a1', 'a2'])
  })

  it('keeps BOTH versions of one discovery open in their conversation, closes them together elsewhere', () => {
    const versions = [
      { id: featureViewTabId('/a', 'pay', 'flow/discovery/discovery_pay_v1.walkthrough.html', 't1'), rootPath: '/a', threadId: 't1' },
      { id: featureViewTabId('/a', 'pay', 'flow/discovery/discovery_pay_v2.walkthrough.html', 't1'), rootPath: '/a', threadId: 't1' },
    ]
    expect(featureViewsToClose(versions, '/a', 't1')).toEqual([])
    expect(featureViewsToClose(versions, '/a', 't2')).toEqual(versions.map((view) => view.id))
  })
})

describe('featureViewTabId', () => {
  const v1 = 'flow/discovery/discovery_pay_v1.walkthrough.html'
  const v2 = 'flow/discovery/discovery_pay_v2.walkthrough.html'

  it('keys the tab by project AND slug, so two projects never share one', () => {
    expect(featureViewTabId('/repo/a', 'pay', v1)).toBe(
      'flow://feature-view/pay?root=%2Frepo%2Fa&page=flow%2Fdiscovery%2Fdiscovery_pay_v1.walkthrough.html',
    )
    expect(featureViewTabId('/repo/a', 'pay', v1)).not.toBe(featureViewTabId('/repo/b', 'pay', v1))
  })

  it('keys the tab by conversation too, so two threads never share one', () => {
    expect(featureViewTabId('/repo/a', 'pay', v1, 't1')).toBe(
      'flow://feature-view/pay?root=%2Frepo%2Fa&page=flow%2Fdiscovery%2Fdiscovery_pay_v1.walkthrough.html&thread=t1',
    )
    expect(featureViewTabId('/repo/a', 'pay', v1, 't1')).not.toBe(featureViewTabId('/repo/a', 'pay', v1, 't2'))
    expect(featureViewTabId('/repo/a', 'pay', v1, 't1')).not.toBe(featureViewTabId('/repo/a', 'pay', v1, null))
  })

  it('keys the tab by VERSION, so two versions of one discovery in one thread open side by side', () => {
    // Positive first (allowed-pattern #28): the same version in the same thread IS one tab.
    expect(featureViewTabId('/repo/a', 'pay', v1, 't1')).toBe(featureViewTabId('/repo/a', 'pay', v1, 't1'))
    expect(featureViewTabId('/repo/a', 'pay', v1, 't1')).not.toBe(featureViewTabId('/repo/a', 'pay', v2, 't1'))
  })
})

describe('featureViewPageChange', () => {
  it('reloads when the page changed on disk', () => {
    expect(featureViewPageChange({ present: true, mtime: 1 }, { walkthrough: true, walkthroughMtime: 2 })).toBe('reload')
  })

  it('does nothing for a markdown-only edit that left the page alone', () => {
    // Positive first (allowed-pattern #28): a different mtime does reload.
    expect(featureViewPageChange({ present: true, mtime: 1 }, { walkthrough: true, walkthroughMtime: 2 })).toBe('reload')
    expect(featureViewPageChange({ present: true, mtime: 1 }, { walkthrough: true, walkthroughMtime: 1 })).toBe('none')
  })

  it('reloads when the page appears, and when the framed version is unknown', () => {
    expect(featureViewPageChange({ present: false }, { walkthrough: true, walkthroughMtime: 1 })).toBe('reload')
    expect(featureViewPageChange({ present: true }, { walkthrough: true, walkthroughMtime: 1 })).toBe('reload')
  })

  it('reports a removed page as gone, and nothing when it was already gone', () => {
    expect(featureViewPageChange({ present: true, mtime: 1 }, { walkthrough: false })).toBe('gone')
    expect(featureViewPageChange({ present: true, mtime: 1 }, {})).toBe('gone')
    expect(featureViewPageChange({ present: false }, { walkthrough: false })).toBe('none')
  })
})

describe('featureViewTabLabel', () => {
  it('names the version, so two versions side by side can be told apart', () => {
    expect(featureViewTabLabel('pay', 'flow/discovery/discovery_pay_v7.walkthrough.html')).toBe('pay v7')
    expect(featureViewTabLabel('pay', 'flow/discovery/discovery_pay_v8.walkthrough.html')).toBe('pay v8')
  })

  it('falls back to the slug for a page with no version', () => {
    expect(featureViewTabLabel('pay', 'flow/discovery/discovery_pay.walkthrough.html')).toBe('pay')
  })
})
