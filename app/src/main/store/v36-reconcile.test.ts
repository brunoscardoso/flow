/**
 * TWO v36s (merged 2026-10-09). The chat-cleanup branch shipped
 * `messages.ends_turn` as v36 while main shipped sub-agent sub-chats as v36.
 * The user's real profile was opened by the branch build: it records version
 * 36 with `ends_turn` and without main's v36 columns. v39 must bring EVERY
 * profile shape to the same columns, adding only what is missing.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrate, type FlowDatabase } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'

const columns = (db: FlowDatabase, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
const versionOf = (db: FlowDatabase): number =>
  (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version

function withDb(run: (db: FlowDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'flow-v36-'))
  const db = new Database(join(dir, 'p.db'))
  try {
    run(db)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function expectAllColumns(db: FlowDatabase): void {
  expect(versionOf(db)).toBe(LATEST_SCHEMA_VERSION)
  expect(columns(db, 'messages')).toEqual(expect.arrayContaining(['ends_turn', 'parent_tool_call_id']))
  expect(columns(db, 'tool_calls')).toEqual(expect.arrayContaining(['parent_tool_call_id', 'agent_id']))
  expect(columns(db, 'threads')).toEqual(expect.arrayContaining(['parent_thread_id', 'origin_tool_call_id']))
}

describe('v39 reconciles both v36s', () => {
  it('a profile the BRANCH build opened (v36 = ends_turn) gains main’s columns and keeps its marks', () => {
    withDb((db) => {
      migrate(db, MIGRATIONS.filter((m) => m.version <= 35))
      // The branch's v36, exactly as it shipped.
      db.exec(`
        ALTER TABLE messages ADD COLUMN ends_turn INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE schema_version ADD COLUMN compatible_down_to INTEGER;
        UPDATE schema_version SET version = 36, compatible_down_to = 35;
      `)
      db.prepare("INSERT INTO threads (id, workspace_root, title, status, created_at, updated_at) VALUES ('t', '/r', 't', 'idle', 'n', 'n')").run()
      db.prepare("INSERT INTO messages (id, thread_id, role, content, created_at, ends_turn) VALUES ('m', 't', 'assistant', 'hi', 'n', 1)").run()
      expect(() => migrate(db)).not.toThrow()
      expectAllColumns(db)
      expect((db.prepare("SELECT ends_turn FROM messages WHERE id = 'm'").get() as { ends_turn: number }).ends_turn).toBe(1)
    })
  })

  it('a profile MAIN opened (v38) gains ends_turn only', () => {
    withDb((db) => {
      migrate(db, MIGRATIONS.filter((m) => m.version <= 38))
      expect(columns(db, 'messages')).not.toContain('ends_turn')
      expect(() => migrate(db)).not.toThrow()
      expectAllColumns(db)
    })
  })

  it('a fresh profile gets everything once', () => {
    withDb((db) => {
      migrate(db)
      expectAllColumns(db)
      expect(() => migrate(db)).not.toThrow()
    })
  })
})
