// The chain columns on a thread (v32) — run against the REAL better-sqlite3
// driver (Electron ABI, via scripts/run-jest.mjs) with a fresh temp database.
//
// WHY THESE COLUMNS EXIST: "which step of the flow is this conversation on" had
// no answer except reading what the model had written about itself. Now a driver
// writes the step as it issues it, so the question is answered from a record.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from './db'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations'
import { ThreadStore } from './thread-store'

const ROOT = '/tmp/project-chain'

describe('threads.chain_id / chain_stage', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: ThreadStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-thread-chain-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new ThreadStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // PINS WHAT MIGRATION 32 IS, not that nothing may ever follow it. Asserting
  // it was the LATEST turned every future migration into a failure of this
  // test — which says nothing about chains and stops the schema from growing.
  it('was added additively, at version 32', () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(32)
    const added = MIGRATIONS.find((migration) => migration.version === 32)
    expect(added?.up).toContain('ALTER TABLE threads ADD COLUMN chain_id')
    expect(added?.up).toContain('ALTER TABLE threads ADD COLUMN chain_stage')
    // NO BACKFILL AND NO CHECK: nothing has ever been chained, and a CHECK
    // naming today's four steps would make adding a fifth a table rebuild.
    expect(added?.up).not.toMatch(/UPDATE|CHECK/)
  })

  it('a thread is not born chained', () => {
    const thread = store.createThread({ projectRoot: ROOT })
    expect(thread.chainId).toBeNull()
    expect(thread.chainStage).toBeNull()
    expect(store.getThread(thread.id)).toMatchObject({ chainId: null, chainStage: null })
  })

  it('records the step a chain is on, and reads it back', () => {
    const thread = store.createThread({ projectRoot: ROOT })
    store.setThreadChain(thread.id, { chainId: 'chain-7', stage: 'execute-plan' })
    expect(store.getThread(thread.id)).toMatchObject({
      chainId: 'chain-7',
      chainStage: 'execute-plan',
    })
  })

  it('a chain that has not issued a step yet has an id and no step', () => {
    const thread = store.createThread({ projectRoot: ROOT })
    store.setThreadChain(thread.id, { chainId: 'chain-7', stage: null })
    expect(store.getThread(thread.id)).toMatchObject({ chainId: 'chain-7', chainStage: null })
  })

  it('null ends the record and touches nothing else', () => {
    const thread = store.createThread({ projectRoot: ROOT })
    store.setThreadChain(thread.id, { chainId: 'chain-7', stage: 'review-code' })
    const before = store.getThread(thread.id)
    store.setThreadChain(thread.id, null)
    const after = store.getThread(thread.id)
    expect(after).toMatchObject({ chainId: null, chainStage: null })
    // Bookkeeping, not activity: the sidebar must not reorder because a chain
    // issued a step (the same rule `setThreadBinding` follows).
    expect(after?.updatedAt).toBe(before?.updatedAt)
    expect(after?.title).toBe(before?.title)
    expect(after?.status).toBe(before?.status)
  })

  it('refuses a thread it does not know rather than writing nothing quietly', () => {
    expect(() => store.setThreadChain('nope', { chainId: 'c', stage: 'discovery' })).toThrow(
      /unknown thread/,
    )
  })

  it('listThreads carries the columns too', () => {
    const thread = store.createThread({ projectRoot: ROOT })
    store.setThreadChain(thread.id, { chainId: 'c9', stage: 'create-plan' })
    const listed = store.listThreads(ROOT).find((entry) => entry.id === thread.id)
    expect(listed).toMatchObject({ chainId: 'c9', chainStage: 'create-plan' })
  })
})
