// The opening rule for a profile written by a NEWER Flow build.
//
// Several builds share one profile (user, 2026-10-06). A newer build that only
// ADDED to the schema records a floor (`schema_version.compatible_down_to`) at
// or below an older build's latest, and that older build may then open it. No
// floor refuses, exactly as before. The shipped ladder recorded its first
// floor at v36 (floor 35), so the installed v35 build keeps opening a profile
// today's build has migrated.

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canOpenNewerSchema, migrate, openDatabase, readCompatibleFloor, type FlowDatabase } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations'

const LADDER: Migration[] = [
  { version: 1, description: 'base', up: 'CREATE TABLE things (id TEXT PRIMARY KEY);' },
  { version: 2, description: 'nullable column', up: 'ALTER TABLE things ADD COLUMN note TEXT;' },
]

/** A database as a NEWER build left it: version `version`, floor as given
 *  (`undefined` = the column does not exist at all). */
function newerDatabase(version: number, floor: number | null | undefined): FlowDatabase {
  const db = new Database(':memory:')
  migrate(db, LADDER)
  if (floor === undefined) {
    db.prepare('UPDATE schema_version SET version = ?').run(version)
  } else {
    db.exec('ALTER TABLE schema_version ADD COLUMN compatible_down_to INTEGER')
    db.prepare('UPDATE schema_version SET version = ?, compatible_down_to = ?').run(version, floor)
  }
  return db
}

function versionOf(db: FlowDatabase): number {
  return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
}

describe('canOpenNewerSchema', () => {
  it('opens anything at or below the app’s own latest', () => {
    expect(canOpenNewerSchema({ databaseVersion: 35, compatibleDownTo: null, appLatest: 35 })).toBe(true)
    expect(canOpenNewerSchema({ databaseVersion: 30, compatibleDownTo: null, appLatest: 35 })).toBe(true)
  })

  it('opens a newer database whose floor is at or below the app’s latest', () => {
    expect(canOpenNewerSchema({ databaseVersion: 37, compatibleDownTo: 35, appLatest: 35 })).toBe(true)
    expect(canOpenNewerSchema({ databaseVersion: 37, compatibleDownTo: 30, appLatest: 35 })).toBe(true)
  })

  it('refuses a newer database whose floor is above the app’s latest', () => {
    expect(canOpenNewerSchema({ databaseVersion: 37, compatibleDownTo: 36, appLatest: 35 })).toBe(false)
    expect(canOpenNewerSchema({ databaseVersion: 37, compatibleDownTo: 37, appLatest: 35 })).toBe(false)
  })

  it('treats a missing floor as the database’s own version — refused, as today', () => {
    expect(canOpenNewerSchema({ databaseVersion: 36, compatibleDownTo: null, appLatest: 35 })).toBe(false)
  })
})

describe('migrate() applies the opening rule', () => {
  it('opens a newer database within its compatible floor and leaves it untouched', () => {
    const db = newerDatabase(4, 2)
    try {
      expect(readCompatibleFloor(db)).toBe(2)
      expect(() => migrate(db, LADDER)).not.toThrow()
      // Never migrated DOWN: the newer build's version and floor survive.
      expect(versionOf(db)).toBe(4)
      expect(readCompatibleFloor(db)).toBe(2)
    } finally {
      db.close()
    }
  })

  it('refuses a newer database beyond its compatible floor', () => {
    const db = newerDatabase(4, 3)
    try {
      expect(() => migrate(db, LADDER)).toThrow(/schema version 4 is newer than this app supports \(2\)/)
    } finally {
      db.close()
    }
  })

  it('refuses a newer database with no floor column, exactly as before the rule', () => {
    const db = newerDatabase(3, undefined)
    try {
      expect(readCompatibleFloor(db)).toBeNull()
      expect(() => migrate(db, LADDER)).toThrow(/Refusing to open/)
    } finally {
      db.close()
    }
  })

  it('refuses a newer database whose floor column holds NULL', () => {
    const db = newerDatabase(3, null)
    try {
      expect(() => migrate(db, LADDER)).toThrow(/Refusing to open/)
    } finally {
      db.close()
    }
  })

  it('records the floor once a migration has added the column', () => {
    const ladder: Migration[] = [
      ...LADDER,
      {
        version: 3,
        description: 'add the floor column',
        up: 'ALTER TABLE schema_version ADD COLUMN compatible_down_to INTEGER;',
        compatibleDownTo: 2,
      },
      { version: 4, description: 'a breaking one', up: 'DROP TABLE things;' },
    ]
    const db = new Database(':memory:')
    try {
      migrate(db, ladder.slice(0, 3))
      expect(versionOf(db)).toBe(3)
      expect(readCompatibleFloor(db)).toBe(2)
      // Omitted compatibleDownTo = the migration's own version.
      migrate(db, ladder)
      expect(versionOf(db)).toBe(4)
      expect(readCompatibleFloor(db)).toBe(4)
    } finally {
      db.close()
    }
  })
})

/** The newest schema the installed (pre-rename) Flow.app was built with. It
 *  carries the opening rule above, so it opens any newer profile whose floor
 *  is at or below this. */
const INSTALLED_BUILD_SCHEMA = 35

describe('the shipped ladder', () => {
  // #1931's sub-agent migrations (v36–v38) moved past v35 the way the policy
  // in migrations.ts demands: every one is ADDITIVE (nullable columns +
  // indexes), v36 adds the `compatible_down_to` column, and all three record
  // the v35 floor — so a v35 build with the opening rule still opens the
  // profile. This pin is the loud, non-quiet bump that policy asks for.
  it('tops out at v39, floored at v35 for the installed pre-rename build', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(39)
  })

  // Workspaces (plan_workspaces-knowledge-hub, Phase 4) deliberately added NO
  // schema: membership is derived from the CLI and the app-only extras live in
  // app_settings rows. A later table must come with a compatible floor — see
  // the policy in migrations.ts — not by quietly bumping the version.
  it('Workspaces store nothing in the schema: no group table, no membership columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-schema-compat-'))
    try {
      const db = openDatabase(join(dir, 'fresh.db'))
      try {
        expect(versionOf(db)).toBe(39)
        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((row) => row.name)
        expect(tables).not.toContain('workspace_groups')
        expect(tables).not.toContain('task_projects')
        for (const table of ['threads', 'tasks']) {
          const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name)
          expect(columns.length).toBeGreaterThan(0)
          expect(columns).not.toContain('workspace_id')
        }
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the installed build (ladder ending at v35) opens a v39 database and writes into it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-schema-compat-'))
    try {
      const path = join(dir, 'shared.db')
      const today = openDatabase(path)
      today.close()
      const installed = new Database(path)
      try {
        const installedLadder = MIGRATIONS.filter((m) => m.version <= INSTALLED_BUILD_SCHEMA)
        expect(() => migrate(installed, installedLadder)).not.toThrow()
        // Never migrated down: still the latest version, floor kept.
        expect(versionOf(installed)).toBe(LATEST_SCHEMA_VERSION)
        expect(readCompatibleFloor(installed)).toBe(INSTALLED_BUILD_SCHEMA)
        // An insert naming only the columns the installed build knows lands,
        // and reads as not marked.
        installed
          .prepare('INSERT INTO threads (id, workspace_root, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run('th-1', '/repo', 'old build', 'idle', 'now', 'now')
        installed
          .prepare('INSERT INTO messages (id, thread_id, role, content, created_at, model) VALUES (?, ?, ?, ?, ?, ?)')
          .run('m-1', 'th-1', 'assistant', 'hi', 'now', null)
        expect(
          (installed.prepare('SELECT ends_turn FROM messages WHERE id = ?').get('m-1') as { ends_turn: number }).ends_turn,
        ).toBe(0)
      } finally {
        installed.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records the v35 floor on a fresh database (v36 added the column; the rule can accept it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-schema-compat-'))
    try {
      const db = openDatabase(join(dir, 'fresh.db'))
      try {
        expect(versionOf(db)).toBe(39)
        expect(readCompatibleFloor(db)).toBe(35)
        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((row) => row.name)
        expect(tables).toEqual(expect.arrayContaining(['workspaces', 'workspace_state', 'threads']))
        expect(tables).not.toContain('projects')
        expect(tables).not.toContain('project_state')
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
