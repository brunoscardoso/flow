// THE UPDATE PATH, EXERCISED — every old schema, with data in it, opened by
// today's app.
//
// The sibling suite (migrations.test.ts) checks the LADDER: numbering, order,
// the apply predicate. It says so itself — "these assertions need no live DB".
// So nothing ran the SQL against real SQLite with real rows in it, and that is
// the only thing a user actually does: they update the app, and their existing
// database is opened by code written after it.
//
// The risk is not theoretical. This ladder rebuilds `tasks` twice (v9 and v22
// both CREATE a new table, copy, drop, rename) because SQLite cannot drop a
// CHECK constraint. A rebuild copies an explicit column list — so a column
// added between the rebuild and the version that wrote it is a column that
// silently does not arrive. No count changes, no error is raised: the value is
// simply gone, on the users with the oldest data.
//
// So: for EVERY version, build a database at that version, write rows into it
// through raw SQL (the stores assume the latest schema), open it with the real
// `openDatabase`, and assert the rows are still there with their values. One
// test per version, named by it, so a failure says which upgrade eats data.

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrate, openDatabase, withTransaction, type FlowDatabase } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'

/** Apply the ladder only as far as `version` — a database as an old app left it. */
function buildAtVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break
    withTransaction(db, () => {
      if (typeof migration.up === 'function') migration.up(db)
      else db.exec(migration.up)
      db.prepare('DELETE FROM schema_version').run()
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
    })
  }
  db.close()
}

/** Columns a table has AT THIS VERSION, with their NOT NULL / default facts. */
interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

function columnsOf(db: FlowDatabase, table: string): ColumnInfo[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]
  return rows
}

function tableExists(db: FlowDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
  return row !== undefined
}

/**
 * Columns whose values are constrained (a CHECK, or a foreign key) — a marker
 * string in one of these is refused by the schema rather than carried by it.
 * Everything else gets a marker, because a nullable column left NULL proves
 * nothing about whether a rebuild would have carried its value.
 */
const CONSTRAINED: Record<string, unknown> = {
  role: 'user',
  status: 'idle',
  source: 'manual',
  lane: 'todo',
  brief_status: 'idle',
  kind: 'text',
  thread_id: 'th-1',
  message_id: null,
  origin_thread_id: null,
  workspace_root: '/repo',
  project_root: '/repo',
}

/**
 * Insert one row, filling EVERY column this version's table has.
 *
 * NOT JUST THE REQUIRED ONES, and that is the whole point. This ladder rebuilds
 * `tasks` twice by copying an EXPLICIT column list; a column missing from that
 * list is dropped in silence. A seed seeding only NOT NULL columns would leave
 * every nullable one NULL — and NULL survives a dropped column exactly as well
 * as it survives a carried one, so the test would pass either way.
 *
 * GENERIC ON PURPOSE. A seed written against today's columns cannot be written
 * at v3, and per-version fixtures are twenty-three things to maintain and
 * forget. Values a schema constrains (a CHECK, an FK) come from the table
 * above; everything else gets a marker naming its own column, so the assertion
 * can say exactly which value did not survive.
 */
function seedRow(
  db: FlowDatabase,
  table: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {}
  for (const column of columnsOf(db, table)) {
    if (column.name in values) {
      row[column.name] = values[column.name]
      continue
    }
    if (column.name in CONSTRAINED) {
      const constrained = CONSTRAINED[column.name]
      if (constrained === null) continue
      row[column.name] = constrained
      continue
    }
    row[column.name] = column.type.toUpperCase().includes('INT')
      ? 7
      : `marker:${table}.${column.name}`
  }
  const names = Object.keys(row)
  const placeholders = names.map(() => '?').join(', ')
  db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`).run(
    ...names.map((name) => row[name]),
  )
  return row
}

/**
 * Every seeded value that still has a column to live in must still be there.
 *
 * A column REMOVED by a later migration is not a loss — the ladder decided that
 * on purpose. A column that still exists holding a different value than the one
 * written is a migration that ate it.
 */
function expectCarried(
  db: FlowDatabase,
  table: string,
  id: string,
  seeded: Record<string, unknown>,
): void {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  expect({ table, id, found: row !== undefined }).toEqual({ table, id, found: true })
  const columns = new Set(columnsOf(db, table).map((column) => column.name))
  for (const [name, value] of Object.entries(seeded)) {
    if (!columns.has(name)) continue
    expect({ column: `${table}.${name}`, value: row?.[name] }).toEqual({
      column: `${table}.${name}`,
      value,
    })
  }
}

const AT = '2026-01-01T00:00:00.000Z'

describe('an update opens the data the old app wrote', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-upgrade-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  // One case per version — the name says which upgrade broke when it does.
  for (let from = 1; from < LATEST_SCHEMA_VERSION; from += 1) {
    it(`carries a v${from} database up to v${LATEST_SCHEMA_VERSION} with its rows intact`, () => {
      const dbPath = join(dir, `v${from}.db`)
      buildAtVersion(dbPath, from)

      // Seed through raw SQL at the OLD schema.
      const old = new Database(dbPath)
      old.pragma('foreign_keys = ON')
      expect(
        (old.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
      ).toBe(from)

      const thread = seedRow(old, 'threads', {
        id: 'th-1',
        workspace_root: '/repo',
        title: 'A thread from the old app',
        status: 'idle',
        created_at: AT,
        updated_at: AT,
      })
      const message = seedRow(old, 'messages', {
        id: 'msg-1',
        thread_id: 'th-1',
        role: 'user',
        content: 'the message a user typed',
        created_at: AT,
      })
      const hadToolCalls = tableExists(old, 'tool_calls')
      const hadTasks = tableExists(old, 'tasks')
      let toolCall: Record<string, unknown> = {}
      let task: Record<string, unknown> = {}
      if (hadToolCalls) {
        toolCall = seedRow(old, 'tool_calls', {
          id: 'tc-1',
          thread_id: 'th-1',
          tool_name: 'Read',
          status: 'success',
          started_at: AT,
        })
      }
      if (hadTasks) {
        task = seedRow(old, 'tasks', {
          id: 'task-1',
          project_root: '/repo',
          title: 'A task from the old app',
          source: 'manual',
          created_at: AT,
          updated_at: AT,
        })
      }
      old.close()

      // …and open it the way the updated app does.
      const db = openDatabase(dbPath)
      try {
        expect(
          (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
        ).toBe(LATEST_SCHEMA_VERSION)

        expectCarried(db, 'threads', 'th-1', thread)
        expectCarried(db, 'messages', 'msg-1', message)
        // A table that did not EXIST at the old version has nothing to carry —
        // asserting on it would be testing the migration that created it, not
        // the upgrade of somebody's data.
        if (hadToolCalls) expectCarried(db, 'tool_calls', 'tc-1', toolCall)
        // `tasks` is the table this ladder rebuilds TWICE (v9, v22) — the exact
        // shape that loses a column silently.
        if (hadTasks) expectCarried(db, 'tasks', 'task-1', task)
      } finally {
        db.close()
      }
    })
  }

  it('opening an up-to-date database changes nothing', () => {
    const dbPath = join(dir, 'current.db')
    const first = openDatabase(dbPath)
    first.prepare(
      'INSERT INTO threads (id, workspace_root, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('th-1', '/repo', 'unchanged', 'idle', AT, AT)
    first.close()

    const second = openDatabase(dbPath)
    try {
      const thread = second.prepare('SELECT * FROM threads WHERE id = ?').get('th-1') as
        | Record<string, unknown>
        | undefined
      expect(thread?.title).toBe('unchanged')
      expect(
        (second.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
      ).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      second.close()
    }
  })

  it('refuses a database from a NEWER app instead of writing into it', () => {
    // What a user sees when they run an older build against newer data — the
    // dialog is this throw. Refusing is the correct answer: an older app
    // writing a newer schema is how the data gets damaged rather than stale.
    const dbPath = join(dir, 'from-the-future.db')
    const db = openDatabase(dbPath)
    db.prepare('DELETE FROM schema_version').run()
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_SCHEMA_VERSION + 5)
    db.close()

    expect(() => openDatabase(dbPath)).toThrow(/newer than this app supports/)
  })
})

describe('an update that dies half way leaves the old database whole', () => {
  // THE CLAIM IN db.ts'S HEADER — "migrations run inside transactions so a crash
  // mid-migration leaves the previous schema intact" — is the promise a person's
  // data rests on when their machine reboots during an update. Nothing checked
  // it, so it was a comment.
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-crash-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('rolls the failing step back, keeps the version, and keeps the rows', () => {
    const dbPath = join(dir, 'interrupted.db')
    const db = openDatabase(dbPath)
    db.prepare(
      'INSERT INTO threads (id, workspace_root, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('th-1', '/repo', 'written before the update', 'idle', AT, AT)

    const doomed = [
      ...MIGRATIONS,
      {
        version: LATEST_SCHEMA_VERSION + 1,
        description: 'a step that dies half way',
        up: (target: FlowDatabase): void => {
          target.exec('CREATE TABLE half_written (id TEXT PRIMARY KEY)')
          throw new Error('the machine rebooted')
        },
      },
    ]

    expect(() => migrate(db, doomed)).toThrow('the machine rebooted')

    // The version did NOT advance — the next launch retries the same step
    // rather than skipping it as done.
    expect(
      (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
    ).toBe(LATEST_SCHEMA_VERSION)
    // The half-written table is gone with the transaction.
    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half_written'")
      .get()
    expect(leftover).toBeUndefined()
    // And the data somebody had before the update is untouched.
    const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get('th-1') as
      | Record<string, unknown>
      | undefined
    expect(thread?.title).toBe('written before the update')
    db.close()

    // Re-opening with the REAL ladder still works — the failed step left
    // nothing behind that blocks the app.
    const reopened = openDatabase(dbPath)
    try {
      expect(
        (reopened.prepare('SELECT version FROM schema_version').get() as { version: number })
          .version,
      ).toBe(LATEST_SCHEMA_VERSION)
      expect(
        (reopened.prepare('SELECT * FROM threads WHERE id = ?').get('th-1') as
          | Record<string, unknown>
          | undefined)?.title,
      ).toBe('written before the update')
    } finally {
      reopened.close()
    }
  })
})
