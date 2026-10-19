import { buildFeatureViewRequest, matchFeatureViewNotice } from './feature-view-request'
import {
  FEATURE_VIEW_DONE_TITLE,
  FEATURE_VIEW_FAILED_TITLE,
  FEATURE_VIEW_NOTE_TITLE,
} from '../../shared/feature-view-notice'

describe('buildFeatureViewRequest', () => {
  it('puts the root PATH in rootId — never a project uuid', () => {
    const request = buildFeatureViewRequest({
      rootPath: '/Users/x/repo',
      featureRef: 'feature:chats',
      featureName: 'Chats',
      modulePaths: ['src/api/chat'],
    })
    expect(request).toEqual({
      rootId: '/Users/x/repo',
      featureRef: 'feature:chats',
      featureName: 'Chats',
      modulePaths: ['src/api/chat'],
    })
  })

  it('copies the module paths rather than aliasing the caller’s array', () => {
    const modulePaths = ['src/api/chat']
    const request = buildFeatureViewRequest({
      rootPath: '/r',
      featureRef: 'f',
      featureName: 'F',
      modulePaths,
    })
    modulePaths.push('mutated')
    expect(request?.modulePaths).toEqual(['src/api/chat'])
  })

  it('refuses to build half a request', () => {
    const missing = { featureRef: 'f', featureName: 'F', modulePaths: [] }
    expect(buildFeatureViewRequest({ ...missing, rootPath: null })).toBeNull()
    expect(buildFeatureViewRequest({ ...missing, rootPath: '' })).toBeNull()
    expect(
      buildFeatureViewRequest({ rootPath: '/r', featureRef: null, featureName: 'F', modulePaths: [] }),
    ).toBeNull()
    expect(
      buildFeatureViewRequest({ rootPath: '/r', featureRef: 'f', featureName: null, modulePaths: [] }),
    ).toBeNull()
  })
})

describe('matchFeatureViewNotice', () => {
  const root = '/Users/x/repo'

  it('reads the success toast as done', () => {
    expect(
      matchFeatureViewNotice({ title: FEATURE_VIEW_DONE_TITLE, body: 'Chats: 7 component(s)', rootId: root }, root),
    ).toEqual({ done: true })
  })

  it('reads the failure toast as a failure, carrying its reason', () => {
    expect(
      matchFeatureViewNotice(
        { title: FEATURE_VIEW_FAILED_TITLE, body: 'Chats: no credentials', rootId: root },
        root,
      ),
    ).toEqual({ done: false, reason: 'Chats: no credentials' })
  })

  it('never leaves a failure without a reason', () => {
    expect(
      matchFeatureViewNotice({ title: FEATURE_VIEW_FAILED_TITLE, body: '  ', rootId: root }, root),
    ).toEqual({ done: false, reason: 'unknown reason' })
  })

  it('ignores another project’s drawing', () => {
    expect(
      matchFeatureViewNotice({ title: FEATURE_VIEW_DONE_TITLE, body: '', rootId: '/other' }, root),
    ).toBeNull()
  })

  it('ignores every other notification', () => {
    expect(matchFeatureViewNotice({ title: 'Learning failed', body: 'x', rootId: root }, root)).toBeNull()
    expect(matchFeatureViewNotice({ title: 'Learning', body: 'x', rootId: root }, root)).toBeNull()
    expect(matchFeatureViewNotice({ rootId: root }, root)).toBeNull()
  })

  it('does NOT end the running state on a mid-pass note', () => {
    // The credentials heads-up is raised WHILE the pass runs. Reading it as an
    // outcome would wipe the spinner before anything finished.
    expect(new Set([FEATURE_VIEW_DONE_TITLE, FEATURE_VIEW_FAILED_TITLE, FEATURE_VIEW_NOTE_TITLE]).size).toBe(3)
    expect(
      matchFeatureViewNotice({ title: FEATURE_VIEW_NOTE_TITLE, body: 'no account bound', rootId: root }, root),
    ).toBeNull()
  })

  it('matches nothing without an active root', () => {
    expect(
      matchFeatureViewNotice({ title: FEATURE_VIEW_DONE_TITLE, body: '', rootId: root }, null),
    ).toBeNull()
  })
})
