/**
 * What this account has shared, remembered locally (review R2-M7): keyed by
 * (subject, projectId, slug), kept across restarts, and never holding anything
 * that is not a well-formed record.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createFileShareRecords, createMemoryShareRecords } from './share-records'

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const KEY = { subject: 'github|1', projectId: '0123456789abcdef0123456789abcdef', slug: 'ledger-sync' }

let warnSpy: jest.SpyInstance
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => warnSpy.mockRestore())

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-share-records-'))
  temps.push(dir)
  return join(dir, 'share-records.json')
}

describe('share records', () => {
  it('a record is found by its exact (subject, projectId, slug) and nothing else', async () => {
    const records = createMemoryShareRecords([{ ...KEY, id: 'shareABCD1234' }])
    expect(await records.get(KEY)).toBe('shareABCD1234')
    expect(await records.get({ ...KEY, subject: 'github|2' })).toBeNull()
    expect(await records.get({ ...KEY, projectId: 'f'.repeat(32) })).toBeNull()
    expect(await records.get({ ...KEY, slug: 'other' })).toBeNull()
  })

  it('persists to its file and is read back by a fresh store (a restart)', async () => {
    const file = tempFile()
    const first = createFileShareRecords(file)
    await first.set(KEY, 'shareABCD1234')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const second = createFileShareRecords(file)
    expect(await second.get(KEY)).toBe('shareABCD1234')
    await second.remove(KEY)
    expect(await createFileShareRecords(file).get(KEY)).toBeNull()
  })

  it('removeId drops what this account recorded under that share id only', async () => {
    const records = createMemoryShareRecords([
      { ...KEY, id: 'shareABCD1234' },
      { ...KEY, slug: 'other', id: 'shareOTHER5678' },
      { ...KEY, subject: 'github|2', id: 'shareABCD1234' },
    ])
    await records.removeId('github|1', 'shareABCD1234')
    expect(records.all()).toEqual([
      { ...KEY, slug: 'other', id: 'shareOTHER5678' },
      { ...KEY, subject: 'github|2', id: 'shareABCD1234' },
    ])
  })

  it('a corrupt or hand-edited file starts empty; malformed entries are dropped', async () => {
    const corrupt = tempFile()
    writeFileSync(corrupt, '{not json')
    expect(await createFileShareRecords(corrupt).get(KEY)).toBeNull()

    const edited = tempFile()
    writeFileSync(
      edited,
      JSON.stringify({
        version: 1,
        records: [
          { ...KEY, id: 'shareABCD1234' },
          { ...KEY, slug: 'bad', projectId: 'plan-flow', id: 'shareABCD1234' },
          { ...KEY, slug: 'evil', id: '../../etc' },
        ],
      }),
    )
    const records = createFileShareRecords(edited)
    expect(await records.get(KEY)).toBe('shareABCD1234')
    expect(await records.get({ ...KEY, slug: 'evil' })).toBeNull()
    await records.set({ ...KEY, slug: 'next' }, 'shareNEXT0001')
    const saved = JSON.parse(readFileSync(edited, 'utf8')) as { records: unknown[] }
    expect(saved.records).toHaveLength(2)
  })
})
