import type { ThreadWorktreeEntry, ThreadWorktreeInventory } from '../../shared/ipc-contract'
import {
  FREE_FAILED,
  STORAGE_PAGE_TITLE,
  STORAGE_UNREADABLE,
  bulkFreeControl,
  freeAction,
  freeSummary,
  landedRows,
  storageHeader,
  storageRowView,
  storageRows,
} from './storage-page-model'

const entry = (over: Partial<ThreadWorktreeEntry> = {}): ThreadWorktreeEntry => ({
  threadId: 't1',
  threadTitle: 'Fix the login redirect',
  branch: 'thread/fix-login',
  base: 'main',
  landed: true,
  changedFiles: 0,
  aheadCommits: 0,
  lastActiveAt: 0,
  diskKb: 2048,
  onBase: false,
  busy: false,
  archived: false,
  drift: 'none',
  remote: null,
  remoteBranch: null,
  prBase: null,
  previouslyPushedAs: null,
  baseMayBeBehind: false,
  ...over,
})

const inventory = (
  entries: ThreadWorktreeEntry[],
  usage: Partial<ThreadWorktreeInventory['usage']> = {},
): ThreadWorktreeInventory => ({
  rootPath: '/repo',
  usage: { total: entries.length, cap: 10, unlanded: 0, atCap: false, ...usage },
  entries,
  unreadable: false,
})

/**
 * Every situation the wire can put on this page, one entry each.
 *
 * A SWEEP, NOT A SAMPLE. The vocabulary ban and the "nothing unlanded is ever
 * freed" promise are both claims about EVERY string and EVERY press, so the
 * tests that assert them walk this list rather than a hand-picked row — a new
 * drift value or a new state added to the wire fails here instead of landing
 * in whichever branch happens to catch it.
 */
const EVERY_SITUATION: ThreadWorktreeEntry[] = [
  entry({ threadId: 'landed' }),
  entry({ threadId: 'landed-on-base', onBase: true }),
  entry({ threadId: 'never-touched', branch: null, diskKb: null, lastActiveAt: 0 }),
  entry({ threadId: 'busy', busy: true }),
  entry({ threadId: 'unsaved', changedFiles: 3 }),
  entry({ threadId: 'ahead', aheadCommits: 1 }),
  entry({ threadId: 'ahead-many', aheadCommits: 4 }),
  entry({ threadId: 'gone', drift: 'gone' }),
  entry({ threadId: 'abandoned', drift: 'abandoned', threadTitle: null }),
  entry({ threadId: 'abandoned-unsaved', drift: 'abandoned', threadTitle: null, changedFiles: 2 }),
  entry({ threadId: 'dead-record', drift: 'dead-record', threadTitle: null, diskKb: null }),
  entry({ threadId: 'archived', archived: true }),
  entry({ threadId: 'untitled', threadTitle: '  ' }),
]

/** Every string this page could put in front of a person, for one inventory. */
function everyVisibleString(entries: ThreadWorktreeEntry[]): string[] {
  const inv = inventory(entries)
  const rows = storageRows(inv)
  const header = storageHeader(inv)
  const bulk = bulkFreeControl(rows)
  return [
    STORAGE_PAGE_TITLE,
    STORAGE_UNREADABLE,
    FREE_FAILED,
    header.line,
    header.note,
    header.empty ?? '',
    bulk.text,
    bulk.blockedReason ?? '',
    ...rows.flatMap((row) => [row.title, row.detail, ...row.facts, row.free.reason ?? '']),
    ...[0, 1, 2].flatMap((freed) => [0, 1, 2].map((kept) => freeSummary(freed, kept))),
  ]
}

describe('the vocabulary this page removes', () => {
  /**
   * THE WORDS THAT LEAVE THE PRODUCT. The surface this replaces called these
   * rows "copies of the project" and the settings row that opened it said the
   * same. All three words name a THING a reader was never introduced to; the
   * page is about files on disk belonging to a conversation, and that needs no
   * introduction at all.
   */
  const BANNED = /\b(cop(y|ies)|work\s?space[s]?|worktree[s]?)\b/i

  it('never says copy, workspace or worktree — in any string, for any row', () => {
    const offenders = everyVisibleString(EVERY_SITUATION).filter((text) => BANNED.test(text))
    expect(offenders).toEqual([])
  })

  it('still says them when the ban is broken, so the sweep is not vacuous', () => {
    // A test that cannot fail is a test that proves nothing. This asserts the
    // matcher itself, against the exact sentence the old ledger printed.
    expect(BANNED.test('This thread is still pointing at a copy of the repo')).toBe(true)
    expect(BANNED.test('Thread workspace')).toBe(true)
    expect(BANNED.test('the copies this project is holding')).toBe(true)
  })

  it('names a conversation, never a thread record, where a person can see it', () => {
    const rows = storageRows(inventory(EVERY_SITUATION))
    const orphan = rows.find((row) => row.id === 'abandoned')
    expect(orphan?.title).toBe('A conversation that no longer exists')
    expect(rows.find((row) => row.id === 'untitled')?.title).toBe('Untitled conversation')
    expect(rows.find((row) => row.id === 'archived')?.title).toBe(
      'Fix the login redirect (archived)',
    )
  })
})

describe('the promise in the header', () => {
  it('nothing holding work that exists nowhere else can be freed, whatever is pressed', () => {
    // THE HEADER SAYS THIS, so it has to be true of every press on the page —
    // the per-row action AND the bulk one. There is no force flag to check
    // because there is deliberately none to add.
    for (const row of EVERY_SITUATION) {
      const holdsWork = row.changedFiles > 0 || row.aheadCommits > 0
      if (!holdsWork) continue
      expect(freeAction(row).enabled).toBe(false)
      expect(freeAction(row).reason).not.toBeNull()
    }
    const bulk = landedRows(storageRows(inventory(EVERY_SITUATION)))
    expect(bulk.map((row) => row.id).sort()).toEqual([
      'archived',
      'landed',
      'landed-on-base',
      'never-touched',
      'untitled',
    ])
  })

  it('refuses an orphan that still holds unsaved files, which no state names', () => {
    // Drift is asked about before anything else, so this row reads as
    // `orphaned` rather than `working` — and it is the row where losing the
    // work would be least recoverable, because nothing else in Flow will ever
    // mention it again.
    const orphan = storageRowView(
      entry({ drift: 'abandoned', threadTitle: null, changedFiles: 2 }),
    )
    expect(orphan.state).toBe('orphaned')
    expect(orphan.free.enabled).toBe(false)
    expect(orphan.free.reason).toContain('exists nowhere else')
  })

  it('says the promise in the words the page is read in', () => {
    const header = storageHeader(inventory(EVERY_SITUATION))
    expect(header.note).toContain('Flow frees these on its own as work lands')
    expect(header.note).toContain('whatever you press here')
  })
})

describe('a row that cannot be freed says why', () => {
  it('gives every disabled action a sentence', () => {
    for (const row of storageRows(inventory(EVERY_SITUATION))) {
      if (row.free.enabled) {
        expect(row.free.reason).toBeNull()
        continue
      }
      expect(row.free.reason).not.toBe('')
      expect(row.free.reason).not.toBeNull()
    }
  })

  it('leaves a turn in flight alone, in Phase 1’s own words', () => {
    const busy = storageRowView(entry({ busy: true }))
    expect(busy.state).toBe('working')
    expect(busy.free.enabled).toBe(false)
    expect(busy.free.reason).toBe(
      'This thread is in the middle of a turn. Nothing here will touch it while it works.',
    )
  })

  it('has nothing to free when the files are already gone', () => {
    const gone = storageRowView(entry({ drift: 'gone' }))
    expect(gone.free.enabled).toBe(false)
    expect(gone.detail).toContain('already gone')
  })

  it('tells a reader where unlanded commits actually are', () => {
    // They are not lost by freeing the files — they are on the branch. Saying
    // so is the difference between a refusal and a scare.
    const ahead = storageRowView(entry({ aheadCommits: 1 }))
    expect(ahead.free.reason).toContain('safe on its own branch')
    expect(storageRowView(entry({ aheadCommits: 4 })).free.reason).toContain('4 saved changes')
  })
})

describe('the header line', () => {
  it('leads with the number and adds up only what could be measured', () => {
    const header = storageHeader(
      inventory([entry({ diskKb: 2048 }), entry({ diskKb: 1024 }), entry({ diskKb: null })], {
        total: 3,
        cap: 8,
      }),
    )
    expect(header.line).toBe('3 of 8 · 3 MB')
  })

  it('prints no size at all when nothing could be measured', () => {
    // NULL IS NOT ZERO: "0 MB" is a number a person would act on.
    const header = storageHeader(inventory([entry({ diskKb: null })], { total: 1, cap: 8 }))
    expect(header.line).toBe('1 of 8')
  })

  it('says what an empty project means rather than showing an empty list', () => {
    const header = storageHeader(inventory([], { total: 0, cap: 8 }))
    expect(header.empty).toContain('No conversation in this project is keeping files of its own')
  })
})

describe('the one bulk control', () => {
  it('acts on what has landed and nothing else', () => {
    const rows = storageRows(inventory(EVERY_SITUATION))
    const control = bulkFreeControl(rows)
    expect(control.enabled).toBe(true)
    expect(control.text).toBe('Free what has landed — 5')
  })

  it('never offers an orphan to a bulk press', () => {
    // Freeable, but a decision somebody should look at one at a time.
    const rows = storageRows(inventory([entry({ drift: 'abandoned', threadTitle: null })]))
    expect(rows[0]?.free.enabled).toBe(true)
    expect(landedRows(rows)).toEqual([])
    expect(bulkFreeControl(rows).enabled).toBe(false)
  })

  it('explains itself when there is nothing landed to free', () => {
    const rows = storageRows(inventory([entry({ changedFiles: 1 })]))
    expect(bulkFreeControl(rows).blockedReason).toContain('Nothing here has landed yet')
  })

  it('says nothing at all on a page with no rows', () => {
    // The empty line above already said it; a second sentence saying the same
    // thing in different words is how a surface starts contradicting itself.
    expect(bulkFreeControl([]).blockedReason).toBeNull()
  })
})

describe('what happened', () => {
  it('names what survived rather than counting what went', () => {
    expect(freeSummary(1, 0)).toContain('Its branch keeps the record')
    expect(freeSummary(3, 0)).toContain('Their branches keep the record')
    expect(freeSummary(0, 1)).toContain('changed while this page was open')
    expect(freeSummary(2, 1)).toBe(
      '2 gone, 1 kept. The ones that stayed changed while this page was open.',
    )
    expect(freeSummary(0, 0)).toBe('Nothing was removed.')
  })
})

describe('what an action is addressed by', () => {
  it('flags the rows a free call cannot look up from a conversation', () => {
    const rows = storageRows(inventory(EVERY_SITUATION))
    const unclaimed = rows.filter((row) => row.unclaimed).map((row) => row.id)
    expect(unclaimed.sort()).toEqual(['abandoned', 'abandoned-unsaved', 'dead-record'])
  })
})
