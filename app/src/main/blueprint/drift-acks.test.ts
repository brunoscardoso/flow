// Drift-ack store tests (drift feature, Phase 5). Plain fs I/O (no sqlite /
// Electron), so these run under plain `npx jest`. Each test works in an isolated
// mkdtemp dir; the store creates the structure dir on first append.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { appendDriftAck, isAcked, readDriftAcks, type DriftAck } from './drift-acks'

const ACKS_FILE = 'drift-acks.jsonl'

describe('drift-acks store', () => {
  let structureDir: string

  beforeEach(() => {
    structureDir = mkdtempSync(join(tmpdir(), 'drift-acks-'))
  })

  afterEach(() => {
    rmSync(structureDir, { recursive: true, force: true })
  })

  it('round-trips: append then read returns the ack', async () => {
    const ack: DriftAck = { nodeId: 'module:src/main', commit: 'abc123', ackedAt: '2026-07-20T10:00:00.000Z' }
    await appendDriftAck(structureDir, ack)

    const acks = await readDriftAcks(structureDir)
    expect(acks).toEqual([ack])
  })

  it('creates the structure dir if it does not exist', async () => {
    const nested = join(structureDir, 'brain', '.structure')
    await appendDriftAck(nested, { nodeId: 'n1', commit: 'c1', ackedAt: '2026-07-20T10:00:00.000Z' })
    expect(await readDriftAcks(nested)).toHaveLength(1)
  })

  it('never rewrites existing lines — append only', async () => {
    await appendDriftAck(structureDir, { nodeId: 'n1', commit: 'c1', ackedAt: '2026-07-20T10:00:00.000Z' })
    await appendDriftAck(structureDir, { nodeId: 'n2', commit: 'c2', ackedAt: '2026-07-20T11:00:00.000Z' })

    const raw = readFileSync(join(structureDir, ACKS_FILE), 'utf-8')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).nodeId).toBe('n1')
    expect(JSON.parse(lines[1]).nodeId).toBe('n2')
  })

  it('dedupes by nodeId+commit, keeping the latest ackedAt', async () => {
    await appendDriftAck(structureDir, { nodeId: 'n1', commit: 'c1', ackedAt: '2026-07-20T10:00:00.000Z' })
    await appendDriftAck(structureDir, { nodeId: 'n1', commit: 'c1', ackedAt: '2026-07-20T12:00:00.000Z' })

    const acks = await readDriftAcks(structureDir)
    expect(acks).toHaveLength(1)
    expect(acks[0].ackedAt).toBe('2026-07-20T12:00:00.000Z')
  })

  it('treats the same node with a different commit as a distinct ack', async () => {
    await appendDriftAck(structureDir, { nodeId: 'n1', commit: 'c1', ackedAt: '2026-07-20T10:00:00.000Z' })
    await appendDriftAck(structureDir, { nodeId: 'n1', commit: 'c2', ackedAt: '2026-07-20T10:00:00.000Z' })

    const acks = await readDriftAcks(structureDir)
    expect(acks).toHaveLength(2)
  })

  it('skips corrupt lines but keeps valid ones', async () => {
    const filePath = join(structureDir, ACKS_FILE)
    const goodA = JSON.stringify({ nodeId: 'n1', commit: 'c1', ackedAt: '2026-07-20T10:00:00.000Z' })
    const goodB = JSON.stringify({ nodeId: 'n2', commit: 'c2', ackedAt: '2026-07-20T11:00:00.000Z' })
    // corrupt JSON, a shape-invalid object, and a blank line interleaved
    writeFileSync(filePath, `${goodA}\n{not json\n${JSON.stringify({ nodeId: 5 })}\n\n${goodB}\n`, 'utf-8')

    const acks = await readDriftAcks(structureDir)
    expect(acks.map((a) => a.nodeId)).toEqual(['n1', 'n2'])
  })

  it('returns [] when the file is missing', async () => {
    expect(await readDriftAcks(structureDir)).toEqual([])
  })

  it('reads deterministically regardless of append order', async () => {
    await appendDriftAck(structureDir, { nodeId: 'zeta', commit: 'c2', ackedAt: '2026-07-20T10:00:00.000Z' })
    await appendDriftAck(structureDir, { nodeId: 'alpha', commit: 'c2', ackedAt: '2026-07-20T10:00:00.000Z' })
    await appendDriftAck(structureDir, { nodeId: 'alpha', commit: 'c1', ackedAt: '2026-07-20T10:00:00.000Z' })

    const acks = await readDriftAcks(structureDir)
    expect(acks.map((a) => `${a.nodeId}/${a.commit}`)).toEqual(['alpha/c1', 'alpha/c2', 'zeta/c2'])
  })

  describe('isAcked', () => {
    const acks: DriftAck[] = [
      { nodeId: 'n1', commit: 'c1', ackedAt: '2026-07-20T10:00:00.000Z' },
      { nodeId: 'n2', commit: 'c2', ackedAt: '2026-07-20T11:00:00.000Z' },
    ]

    it('is true for a matching node+commit', () => {
      expect(isAcked(acks, 'n1', 'c1')).toBe(true)
    })

    it('is false when the commit differs (a new drift on the same node)', () => {
      expect(isAcked(acks, 'n1', 'c2')).toBe(false)
    })

    it('is false for an unknown node', () => {
      expect(isAcked(acks, 'nX', 'c1')).toBe(false)
    })

    it('is false against an empty ack list', () => {
      expect(isAcked([], 'n1', 'c1')).toBe(false)
    })
  })
})
