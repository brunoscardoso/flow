// Learning-state store — writer/reader/parse for
// flow/brain/.structure/learning-state.jsonl. Full-rewrite dedup (latest per
// module) and fail-soft parsing are pinned here.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { BlueprintLearningEntry } from '../../shared/ipc-contract'
import {
  LEARNING_STATE_FILE,
  dedupLearningEntries,
  parseLearningStateContent,
  mutateLearningState,
  readLearningState,
  withLearningStateLock,
  writeLearningState,
} from './learning-state'

const entry = (
  module: string,
  status: BlueprintLearningEntry['status'],
  notedAt: string,
): BlueprintLearningEntry => ({ module, status, notedAt })

describe('dedupLearningEntries', () => {
  it('keeps the latest record per module (greatest notedAt) and sorts by module', () => {
    const result = dedupLearningEntries([
      entry('src/b', 'learning', '2026-07-15T00:00:00Z'),
      entry('src/a', 'learning', '2026-07-15T00:00:00Z'),
      entry('src/b', 'learned', '2026-07-15T01:00:00Z'),
    ])
    expect(result).toEqual([
      entry('src/a', 'learning', '2026-07-15T00:00:00Z'),
      entry('src/b', 'learned', '2026-07-15T01:00:00Z'),
    ])
  })

  it('breaks a notedAt tie by later array position', () => {
    const [only] = dedupLearningEntries([
      entry('src/x', 'learning', '2026-07-15T00:00:00Z'),
      entry('src/x', 'stale', '2026-07-15T00:00:00Z'),
    ])
    expect(only.status).toBe('stale')
  })
})

describe('parseLearningStateContent', () => {
  it('yields undefined for a missing file (null) or empty content', () => {
    expect(parseLearningStateContent(null)).toBeUndefined()
    expect(parseLearningStateContent('')).toBeUndefined()
    expect(parseLearningStateContent('  \n ')).toBeUndefined()
  })

  it('skips corrupt/shape-invalid lines and keeps valid siblings', () => {
    const content = [
      'not json',
      JSON.stringify({ module: 'src/a', status: 'learned', notedAt: '2026-07-15T00:00:00Z' }),
      JSON.stringify({ module: '', status: 'learned', notedAt: 'x' }),
      JSON.stringify({ module: 'src/b', status: 'bogus', notedAt: 'x' }),
      '[1,2,3]',
    ].join('\n')
    expect(parseLearningStateContent(content)).toEqual([
      entry('src/a', 'learned', '2026-07-15T00:00:00Z'),
    ])
  })

  it('yields undefined when no line is valid', () => {
    expect(parseLearningStateContent('not json\n{"module":"x","status":"nope"}')).toBeUndefined()
  })

  it('carries the enqueue provenance so a restart can resume it (#1132)', () => {
    const content = JSON.stringify({
      module: 'src/a',
      status: 'queued',
      notedAt: '2026-07-29T00:00:00Z',
      reason: 'basic-discovery',
      deliberate: true,
    })
    expect(parseLearningStateContent(content)).toEqual([
      {
        module: 'src/a',
        status: 'queued',
        notedAt: '2026-07-29T00:00:00Z',
        reason: 'basic-discovery',
        deliberate: true,
      },
    ])
  })

  it('leaves provenance absent on older entries and invalid shapes', () => {
    const content = JSON.stringify({
      module: 'src/a',
      status: 'queued',
      notedAt: '2026-07-29T00:00:00Z',
      reason: 42,
      deliberate: 'yes',
    })
    expect(parseLearningStateContent(content)).toEqual([entry('src/a', 'queued', '2026-07-29T00:00:00Z')])
  })

  it('defaults a missing notedAt to empty string', () => {
    const [parsed] = parseLearningStateContent(JSON.stringify({ module: 'src/a', status: 'stale' })) ?? []
    expect(parsed).toEqual(entry('src/a', 'stale', ''))
  })
})

describe('writeLearningState / readLearningState round-trip', () => {
  let dir: string
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('creates the structure dir, writes deduped entries, and reads them back', async () => {
    dir = mkdtempSync(join(tmpdir(), 'learn-state-'))
    const structureDir = join(dir, 'flow/brain/.structure')
    await writeLearningState(structureDir, [
      entry('src/b', 'learning', '2026-07-15T00:00:00Z'),
      entry('src/a', 'learned', '2026-07-15T00:00:00Z'),
      entry('src/b', 'stale', '2026-07-15T02:00:00Z'),
    ])
    expect(await readLearningState(structureDir)).toEqual([
      entry('src/a', 'learned', '2026-07-15T00:00:00Z'),
      entry('src/b', 'stale', '2026-07-15T02:00:00Z'),
    ])
  })

  it('fully rewrites the file each update (no append)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'learn-state-'))
    const structureDir = join(dir, 'flow/brain/.structure')
    await writeLearningState(structureDir, [entry('src/a', 'learning', '2026-07-15T00:00:00Z')])
    await writeLearningState(structureDir, [entry('src/c', 'learned', '2026-07-15T01:00:00Z')])
    const onDisk = readFileSync(join(structureDir, LEARNING_STATE_FILE), 'utf-8')
    expect(onDisk).toContain('src/c')
    expect(onDisk).not.toContain('src/a')
    expect(await readLearningState(structureDir)).toEqual([
      entry('src/c', 'learned', '2026-07-15T01:00:00Z'),
    ])
  })

  it('reads undefined when the store is corrupt on disk', async () => {
    dir = mkdtempSync(join(tmpdir(), 'learn-state-'))
    const structureDir = join(dir, 'flow/brain/.structure')
    await writeLearningState(structureDir, [])
    writeFileSync(join(structureDir, LEARNING_STATE_FILE), 'garbage\n{bad')
    expect(await readLearningState(structureDir)).toBeUndefined()
  })

  // "Learn all" (#learn-all) fires many transitions at once. With a FIXED temp
  // filename, concurrent writes raced on the same temp — one writer renamed it
  // away and the next hit `ENOENT: rename learning-state.jsonl.tmp`. A per-write
  // unique temp file makes concurrent writes safe (each renames its own temp).
  it('survives many CONCURRENT writes without an ENOENT temp-file race', async () => {
    dir = mkdtempSync(join(tmpdir(), 'learn-state-'))
    const structureDir = join(dir, 'flow/brain/.structure')
    await writeLearningState(structureDir, []) // create the dir first
    const writes = Array.from({ length: 40 }, (_, i) =>
      writeLearningState(structureDir, [entry(`src/m${i}`, 'queued', '2026-07-15T00:00:00Z')]),
    )
    await expect(Promise.all(writes)).resolves.toBeDefined() // no ENOENT rejection
    // The store is still valid, readable JSON afterward (last write wins).
    expect(await readLearningState(structureDir)).toBeDefined()
  })
})

// A full-rewrite store has a second, quieter failure mode than the temp-file
// race above: two writers that each READ, append their own entry and rewrite
// both succeed, and the file ends up missing whichever entry was read past.
// Nothing throws — the entry is simply gone. These pin the critical section
// that stops it.
describe('read-modify-write under the store lock', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'learn-state-lock-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('two overlapping writers BOTH survive — neither entry is lost', async () => {
    const structureDir = join(dir, 'flow/brain/.structure')
    // Yielding inside the mutation is what makes the overlap real: without the
    // lock both callbacks read the same empty store and the slower rewrite
    // erases the faster one's entry. With it, the second read sees the first
    // write.
    const append = (module: string): Promise<unknown> =>
      mutateLearningState(structureDir, async (current) => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return [...current, entry(module, 'learned', '2026-08-21T00:00:00Z')]
      })

    await Promise.all([append('src/a'), append('src/b')])

    const stored = await readLearningState(structureDir)
    expect(stored?.map((record) => record.module)).toEqual(['src/a', 'src/b'])
  })

  it('a caller may wrap its own read-modify-write — the inner write is re-entrant', async () => {
    const structureDir = join(dir, 'flow/brain/.structure')
    const append = (module: string): Promise<void> =>
      withLearningStateLock(structureDir, async () => {
        const current = (await readLearningState(structureDir)) ?? []
        await new Promise((resolve) => setTimeout(resolve, 5))
        await writeLearningState(structureDir, [
          ...current,
          entry(module, 'learned', '2026-08-21T00:00:00Z'),
        ])
      })

    await Promise.all([append('src/a'), append('src/b')])

    const stored = await readLearningState(structureDir)
    expect(stored?.map((record) => record.module)).toEqual(['src/a', 'src/b'])
  })

  it('leaves no lock file behind', async () => {
    const structureDir = join(dir, 'flow/brain/.structure')
    await mutateLearningState(structureDir, () => [entry('src/a', 'learned', '2026-08-21T00:00:00Z')])
    expect(existsSync(join(structureDir, `${LEARNING_STATE_FILE}.lock`))).toBe(false)
  })
})

describe('a project folder that is gone', () => {
  it('is never recreated by a learning-state write (#1118)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'flow-ls-gone-'))
    const root = join(parent, 'moved-away-project')
    try {
      const structureDir = join(root, 'flow', 'brain', '.structure')
      await expect(
        writeLearningState(structureDir, [entry('src/a', 'stale', '2026-10-09T00:00:00Z')]),
      ).rejects.toThrow(/ENOENT/)
      await expect(withLearningStateLock(structureDir, () => 'ran')).rejects.toThrow(/ENOENT/)
      expect(existsSync(root)).toBe(false)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('still creates flow/brain/.structure inside a project that exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flow-ls-live-'))
    try {
      const structureDir = join(root, 'flow', 'brain', '.structure')
      await writeLearningState(structureDir, [entry('src/a', 'learned', '2026-10-09T00:00:00Z')])
      expect(existsSync(join(structureDir, LEARNING_STATE_FILE))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a relative project path', () => {
  it('is refused, and creates nothing beside the process', async () => {
    const id = '0002376f-eb58-4552-8d74-5725d9abe8ef'
    const relative = join(id, 'flow', 'brain', '.structure')
    // Positive first: the write really was attempted with that path…
    await expect(writeLearningState(relative, [])).rejects.toThrow('absolute project path')
    // …and no `<uuid>/flow` folder appeared in the working directory.
    expect(existsSync(id)).toBe(false)
  })
})
