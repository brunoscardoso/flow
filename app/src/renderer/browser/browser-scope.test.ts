import { adoptBrowserScope } from './browser-scope'

const P = '/repo/one'
const T1 = { rootPath: P, threadId: 't1' }
const T2 = { rootPath: P, threadId: 't2' }
const PAGE_ONE = 'http://localhost:3000/one'
const PAGE_TWO = 'http://localhost:3000/two'

describe('adoptBrowserScope', () => {
  it('starts blank, with no captures, when another conversation opens a browser it never had', () => {
    expect(
      adoptBrowserScope({
        owner: T1,
        next: T2,
        saved: null,
        current: PAGE_ONE,
        restoring: false,
        hasNavigated: true,
      }),
    ).toEqual({ clearCaptures: true, load: { kind: 'blank' } })
  })

  it('goes to the saved page, with no captures, when a conversation’s set brings the browser back', () => {
    expect(
      adoptBrowserScope({
        owner: T1,
        next: T2,
        saved: PAGE_TWO,
        current: PAGE_ONE,
        restoring: true,
        hasNavigated: true,
      }),
    ).toEqual({ clearCaptures: true, load: { kind: 'url', url: PAGE_TWO } })
  })

  it('starts blank on restore when the saved set never had a page', () => {
    expect(
      adoptBrowserScope({ owner: T1, next: T2, saved: null, current: PAGE_ONE, restoring: true, hasNavigated: true }),
    ).toEqual({ clearCaptures: true, load: { kind: 'blank' } })
  })

  it('keeps a page both conversations were on, but still drops the other one’s captures', () => {
    expect(
      adoptBrowserScope({ owner: T1, next: T2, saved: PAGE_ONE, current: PAGE_ONE, restoring: true, hasNavigated: true }),
    ).toEqual({ clearCaptures: true, load: { kind: 'keep' } })
  })

  it('keeps everything when the same conversation reopens its own browser', () => {
    expect(
      adoptBrowserScope({ owner: T1, next: T1, saved: null, current: PAGE_ONE, restoring: false, hasNavigated: true }),
    ).toEqual({ clearCaptures: false, load: { kind: 'keep' } })
    expect(
      adoptBrowserScope({ owner: T1, next: T1, saved: PAGE_TWO, current: PAGE_ONE, restoring: true, hasNavigated: true }),
    ).toEqual({ clearCaptures: false, load: { kind: 'url', url: PAGE_TWO } })
  })

  it('leaves a never-used guest to its first-open behaviour', () => {
    expect(
      adoptBrowserScope({ owner: null, next: T1, saved: null, current: null, restoring: false, hasNavigated: false }),
    ).toEqual({ clearCaptures: true, load: { kind: 'keep' } })
  })
})
