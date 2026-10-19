import {
  ageLabel,
  freeRefusal,
  freeable,
  sizeLabel,
  storageRowState,
  type StorageRow,
} from './storage-rows'

const row = (over: Partial<StorageRow> = {}): StorageRow => ({
  drift: 'none',
  busy: false,
  changedFiles: 0,
  aheadCommits: 0,
  ...over,
})

/**
 * The nine situations the ledger spelled as nine states, one row each. Named
 * here by the OLD label so the collapse can be read against what it replaced —
 * and so a tenth situation added to the wire fails a sweep rather than
 * silently landing in whichever branch happens to catch it.
 */
const NINE: Array<{ was: string; row: StorageRow }> = [
  { was: 'Left over', row: row({ drift: 'dead-record' }) },
  { was: 'Missing', row: row({ drift: 'gone' }) },
  { was: 'No thread', row: row({ drift: 'abandoned', changedFiles: 3 }) },
  { was: 'Working', row: row({ busy: true }) },
  { was: 'Unsaved work', row: row({ changedFiles: 2 }) },
  { was: 'Not landed', row: row({ aheadCommits: 1 }) },
  { was: 'No branch', row: row() },
  { was: 'Landed (took its base)', row: row() },
  { was: 'Landed', row: row() },
]

describe('nine states collapse to three', () => {
  it('answers the only question anybody opens this page with', () => {
    // CAN I GET THIS SPACE BACK, AND WHAT DO I LOSE? Nine states answered it
    // nine ways and asked the reader to learn a taxonomy first.
    expect(NINE.map((c) => storageRowState(c.row))).toEqual([
      'orphaned', // Left over
      'orphaned', // Missing
      'orphaned', // No thread
      'working', // Working
      'working', // Unsaved work
      'working', // Not landed
      'landed', // No branch
      'landed', // Landed (took its base)
      'landed', // Landed
    ])
  })

  it('calls a broken pairing orphaned, whatever else is true of it', () => {
    // Drift is asked about FIRST: "working" and "landed" both describe a
    // conversation and its files together, and drift means one of the two is
    // not there. A row with unsaved files whose thread is gone is not a busy
    // row — there is nobody to be busy.
    for (const drift of ['gone', 'abandoned', 'dead-record'] as const) {
      expect(
        storageRowState(row({ drift, busy: true, changedFiles: 9, aheadCommits: 9 })),
      ).toBe('orphaned')
    }
  })

  it('calls a turn in flight working, before it looks at what is held', () => {
    expect(storageRowState(row({ busy: true }))).toBe('working')
  })

  it('treats unsaved files and unlanded commits as the same answer', () => {
    // They differ in what would be LOST, which is the refusal's business.
    // They do not differ in whether the reader should reach for this row.
    expect(storageRowState(row({ changedFiles: 1 }))).toBe('working')
    expect(storageRowState(row({ aheadCommits: 1 }))).toBe('working')
    expect(storageRowState(row({ changedFiles: 1, aheadCommits: 1 }))).toBe('working')
  })

  it('calls a row that has reached its branch landed — the row this page is for', () => {
    expect(storageRowState(row())).toBe('landed')
  })
})

describe('what can be freed, and what says why not', () => {
  it('never touches a conversation in the middle of a turn', () => {
    expect(freeable(row({ busy: true }))).toBe(false)
    expect(freeRefusal(row({ busy: true }))).toBe(
      'This thread is in the middle of a turn. Nothing here will touch it while it works.',
    )
  })

  it('will not free a row whose files are already gone — there is nothing there', () => {
    expect(freeable(row({ drift: 'gone' }))).toBe(false)
    expect(freeRefusal(row({ drift: 'gone' }))).toContain('already gone')
  })

  it('frees a leftover record and an abandoned one — nobody else ever will', () => {
    for (const drift of ['dead-record', 'abandoned'] as const) {
      expect(freeable(row({ drift }))).toBe(true)
    }
  })

  it('frees a row holding work — freeable is not the same question as safe', () => {
    // A row holding changes that exist nowhere else IS freeable, and the page
    // asks a second question before it acts, naming what would be lost. This
    // function is narrower on purpose: is there anything to act on, and is
    // anything using it right now.
    expect(freeable(row({ changedFiles: 4 }))).toBe(true)
    expect(freeable(row({ aheadCommits: 4 }))).toBe(true)
  })

  it('gives a reason exactly when it refuses, and none when it does not', () => {
    // The two functions are one decision with two faces; a refusal with no
    // sentence is a disabled control nobody can explain.
    for (const { row: subject } of NINE) {
      expect(freeRefusal(subject) === null).toBe(freeable(subject))
    }
    for (const subject of [row({ busy: true, drift: 'gone' }), row({ drift: 'gone' })]) {
      expect(freeable(subject)).toBe(false)
      expect(freeRefusal(subject)).not.toBeNull()
    }
  })
})

describe('size and age, lifted from the ledger unchanged', () => {
  it('rounds disk the way a person reads it', () => {
    expect(sizeLabel(512)).toBe('under 1 MB')
    expect(sizeLabel(40 * 1024)).toBe('40 MB')
    expect(sizeLabel(2 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('says nothing rather than zero when the size is not known', () => {
    // A "0 KB" that really means "Flow could not tell" is a number the reader
    // would act on. Omitted, never guessed.
    expect(sizeLabel(null)).toBeNull()
    expect(sizeLabel(Number.NaN)).toBeNull()
    expect(sizeLabel(-1)).toBeNull()
  })

  it('says nothing rather than "just now" when nothing was ever done', () => {
    expect(ageLabel(0)).toBeNull()
    expect(ageLabel(Number.NaN)).toBeNull()
  })

  it('counts age in the units a person would', () => {
    const now = Date.UTC(2026, 7, 20)
    const days = (n: number): number => now - n * 24 * 60 * 60 * 1000
    expect(ageLabel(days(0), now)).toBe('used today')
    expect(ageLabel(days(1), now)).toBe('used yesterday')
    expect(ageLabel(days(5), now)).toBe('used 5 days ago')
    expect(ageLabel(days(40), now)).toBe('used last month')
    expect(ageLabel(days(120), now)).toBe('used 4 months ago')
    expect(ageLabel(days(500), now)).toBe('used over a year ago')
    expect(ageLabel(days(1200), now)).toBe('used 3 years ago')
  })
})

describe('the words', () => {
  it('never names a container — the whole point of the change', () => {
    // THE ASSERTION THAT SURVIVES THE REST OF THIS PROJECT. The ledger's own
    // sentence for a missing row named one, which is why that single string is
    // restated here rather than lifted with the others.
    const everything = [
      ...NINE.map((c) => freeRefusal(c.row) ?? ''),
      freeRefusal(row({ drift: 'gone' })) ?? '',
      sizeLabel(512) ?? '',
      sizeLabel(40 * 1024) ?? '',
      sizeLabel(2 * 1024 * 1024) ?? '',
      ageLabel(1, 1 + 5 * 24 * 60 * 60 * 1000) ?? '',
      ageLabel(1, 1 + 400 * 24 * 60 * 60 * 1000) ?? '',
    ].join(' ')
    expect(everything).not.toMatch(/copy|workspace|worktree/i)
  })

  it('names no path, command or config key (forbidden-pattern #12)', () => {
    // A refusal says what is wrong in the terms of the row on screen. There is
    // nothing for the reader to type, and no directory for them to go and find.
    const refusals = [
      freeRefusal(row({ busy: true })) ?? '',
      freeRefusal(row({ drift: 'gone' })) ?? '',
    ].join(' ')
    expect(refusals).not.toMatch(/planflow-ai|\.flowconfig|\.git|npm |git |\//)
  })
})
