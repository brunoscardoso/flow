import { fileRefNotifyRoot, fileRefRoots } from './file-ref-roots'

const PROJECT = '/Users/dev/Projects/orbit-app'
const THREAD = '/Users/dev/Projects/.orbit-app-threads/993d169a'
const OTHER = '/Users/dev/Projects/orbit-core'

describe('fileRefRoots', () => {
  it('asks the thread’s own checkout before the project', () => {
    // The reported bug: the agent wrote the file in the thread's checkout and
    // the click looked only in the project, which really does not have it.
    expect(fileRefRoots({ requested: null, threadRoots: [THREAD], activeRoot: PROJECT })).toEqual([
      THREAD,
      PROJECT,
    ])
  })

  it('still falls back to the project, so a file only it has opens', () => {
    const roots = fileRefRoots({ requested: null, threadRoots: [THREAD], activeRoot: PROJECT })
    expect(roots[roots.length - 1]).toBe(PROJECT)
  })

  it('asks exactly once when the thread has no checkout of its own', () => {
    expect(fileRefRoots({ requested: null, threadRoots: [], activeRoot: PROJECT })).toEqual([
      PROJECT,
    ])
  })

  it('does not ask the same directory twice', () => {
    expect(fileRefRoots({ requested: PROJECT, threadRoots: [PROJECT], activeRoot: PROJECT })).toEqual([
      PROJECT,
    ])
  })

  it('honours a click that named the active project, thread first', () => {
    // Artifact cards pass the active root explicitly; that is the same click.
    expect(fileRefRoots({ requested: PROJECT, threadRoots: [THREAD], activeRoot: PROJECT })).toEqual([
      THREAD,
      PROJECT,
    ])
  })

  it('leaves a click that named ANOTHER project alone', () => {
    // The blueprint board peeking a second repository means that repository —
    // preferring some thread's checkout over it is the same bug reversed.
    expect(fileRefRoots({ requested: OTHER, threadRoots: [THREAD], activeRoot: PROJECT })).toEqual([
      OTHER,
    ])
  })

  it('asks EVERY root the thread reaches, primary first', () => {
    // The 2026-09-09 report: a thread spanning three repositories wrote a
    // discovery doc in one of the additional roots and named it in the chat.
    // Only the primary checkout and the active project were asked, so the file
    // was unopenable and the message said "in this project" about the one
    // project it was never in.
    expect(
      fileRefRoots({ requested: null, threadRoots: [THREAD, OTHER], activeRoot: PROJECT }),
    ).toEqual([THREAD, OTHER, PROJECT])
  })

  it('keeps the scope’s order among the thread’s own roots', () => {
    expect(
      fileRefRoots({ requested: null, threadRoots: [OTHER, THREAD], activeRoot: PROJECT }),
    ).toEqual([OTHER, THREAD, PROJECT])
  })

  it('still dedupes when the active project is also one of the thread’s roots', () => {
    expect(
      fileRefRoots({ requested: null, threadRoots: [THREAD, PROJECT], activeRoot: PROJECT }),
    ).toEqual([THREAD, PROJECT])
  })

  it('drops a blank among real roots without dropping the rest', () => {
    expect(
      fileRefRoots({ requested: null, threadRoots: ['  ', THREAD], activeRoot: PROJECT }),
    ).toEqual([THREAD, PROJECT])
  })

  it('leaves a click naming another project alone however many roots the thread has', () => {
    expect(
      fileRefRoots({ requested: OTHER, threadRoots: [THREAD, PROJECT], activeRoot: PROJECT }),
    ).toEqual([OTHER])
  })

  it('yields nothing to ask when there is no root at all', () => {
    expect(fileRefRoots({ requested: null, threadRoots: [], activeRoot: null })).toEqual([])
    expect(fileRefRoots({ requested: '  ', threadRoots: [''], activeRoot: null })).toEqual([])
  })
})

describe('fileRefNotifyRoot', () => {
  it('files a miss under the project, not the checkout the user never named', () => {
    expect(fileRefNotifyRoot({ requested: null, threadRoots: [THREAD], activeRoot: PROJECT })).toBe(
      PROJECT,
    )
  })

  it('falls back to the thread’s checkout when there is no project', () => {
    expect(fileRefNotifyRoot({ requested: null, threadRoots: [THREAD], activeRoot: null })).toBe(THREAD)
  })
})
