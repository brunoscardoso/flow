import type { RunKeptData, RunKeptDataItem } from '../../shared/run-setup'
import { KEPT_DATA_STRINGS, dataWords, keptConfirm, keptRow, keptSection } from './kept-data-model'

const GB = 1024 ** 3
const item = (over: Partial<RunKeptDataItem> = {}): RunKeptDataItem => ({
  threadId: 't1',
  projectRoot: '/repos/shop',
  projectName: 'shop',
  title: null,
  volumes: [
    { volume: 'postgres_data', sizeBytes: 1.5 * GB },
    { volume: 'redis', sizeBytes: 0.5 * GB },
  ],
  totalBytes: 2 * GB,
  ...over,
})

describe('dataWords', () => {
  it('names one kind, two kinds, three kinds', () => {
    expect(dataWords([{ volume: 'postgres_data' }])).toBe('Database')
    expect(dataWords([{ volume: 'pgdata' }, { volume: 'redis' }])).toBe('Database and cache')
    expect(dataWords([{ volume: 'pgdata' }, { volume: 'redis' }, { volume: 'minio' }])).toBe('Database, cache and files')
  })
  it('says Data when no volume says what it is, and adds other data beside a known kind', () => {
    expect(dataWords([{ volume: 'blobs' }])).toBe('Data')
    expect(dataWords([{ volume: 'pgdata' }, { volume: 'blobs' }])).toBe('Database and other data')
    expect(dataWords([{ volume: 'pgdata' }, { volume: 'mysql' }])).toBe('Database')
  })
})

describe('keptRow', () => {
  it('title, then project · data · size', () => {
    expect(keptRow(item({ title: 'Fix login' }))).toMatchObject({ title: 'Fix login', sub: 'shop · Database and cache · 2 GB' })
  })
  it('a thread with no title reads as one that no longer exists; an unknown size says so', () => {
    expect(keptRow(item({ totalBytes: null })).title).toBe('A thread that no longer exists')
    expect(keptRow(item({ totalBytes: null })).sub).toBe('shop · Database and cache · size unknown')
  })
})

describe('keptSection', () => {
  const data = (items: RunKeptDataItem[], dockerAvailable = true): RunKeptData => ({ dockerAvailable, items })
  it('has a heading total, one explanation and a row per thread', () => {
    const view = keptSection(data([item(), item({ threadId: 't2', totalBytes: 1 * GB })]))
    expect(view).toMatchObject({ kind: 'list', heading: 'Data kept from deleted threads', total: '3 GB in all' })
    expect(view?.kind === 'list' ? view.rows : []).toHaveLength(2)
    expect(view?.kind === 'list' ? view.explanation : '').toBe(
      'These threads were deleted and their Docker data was kept. Nothing uses it any more.',
    )
  })
  it('no total when a size is unknown', () => {
    const view = keptSection(data([item(), item({ threadId: 't2', totalBytes: null })]))
    expect(view?.kind === 'list' ? view.total : 'x').toBeNull()
  })
  it('Docker closed says so in a sentence and lists nothing', () => {
    expect(keptSection(data([item()], false))).toEqual({ kind: 'closed', heading: KEPT_DATA_STRINGS.heading, closed: KEPT_DATA_STRINGS.dockerClosed })
  })
  it('is hidden with nothing kept, and before the first read', () => {
    expect(keptSection(data([]))).toBeNull()
    expect(keptSection(null)).toBeNull()
  })
})

describe('keptConfirm', () => {
  it('names the thread, the data words and the size', () => {
    const copy = keptConfirm(item({ title: 'Fix login' }))
    expect(copy.title).toBe('Delete the data of “Fix login”?')
    expect(copy.body).toBe(
      "This deletes its database and cache, 2 GB. It can't be brought back. The project and other threads are not touched.",
    )
    expect([copy.cancel, copy.confirm]).toEqual(['Cancel', 'Delete data'])
  })
  it('leaves the size out when unknown, and uses the fallback title', () => {
    const copy = keptConfirm(item({ totalBytes: null }))
    expect(copy.title).toBe('Delete the data of “A thread that no longer exists”?')
    expect(copy.body.startsWith('This deletes its database and cache. ')).toBe(true)
  })
})
