// Flow app database — better-sqlite3 open/migrate helper.
//
// One database file holds all app state (threads, messages, tool calls,
// permission rules, projects). WAL mode keeps readers and the single
// writer from blocking each other; migrations run inside transactions so a
// crash mid-migration leaves the previous schema intact.

import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

import { MIGRATIONS, LATEST_SCHEMA_VERSION, type Migration } from './migrations'

export type FlowDatabase = Database.Database

/**
 * Open (creating if needed) the Flow database at `dbPath`, apply pragmas,
 * and migrate the schema to the latest version. Throws on any failure —
 * the app cannot run without its store, so callers should surface the error
 * rather than continue with a broken database.
 */
export function openDatabase(dbPath: string): FlowDatabase {
  mkdirSync(dirname(dbPath), { recursive: true })

  const db = new Database(dbPath)
  try {
    // WAL: concurrent reads while writing; NORMAL sync is safe with WAL.
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')

    migrate(db)
    return db
  } catch (error) {
    db.close()
    console.error('[Store] Failed to open/migrate database:', error)
    throw error
  }
}

/**
 * Run `fn` inside a transaction. Rolls back on throw and rethrows —
 * partial writes never land.
 */
export function withTransaction<T>(db: FlowDatabase, fn: () => T): T {
  return db.transaction(fn)()
}

/**
 * Apply the ladder. Exported with an INJECTABLE ladder so the crash-safety
 * claim in this file's header can be tested: a migration that throws must leave
 * the previous schema and its data exactly as they were, because that is what a
 * machine dying mid-update does to a person's database.
 */
export function migrate(db: FlowDatabase, ladder: readonly Migration[] = MIGRATIONS): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `)

  const currentVersion = readSchemaVersion(db)
  const latest = ladder[ladder.length - 1]?.version ?? LATEST_SCHEMA_VERSION
  if (currentVersion > latest) {
    const floor = readCompatibleFloor(db)
    if (!canOpenNewerSchema({ databaseVersion: currentVersion, compatibleDownTo: floor, appLatest: latest })) {
      throw new Error(
        `[Store] Database schema version ${currentVersion} is newer than this app supports (${latest}). Refusing to open.`,
      )
    }
    // A newer build wrote this profile, but only additively (its floor is at or
    // below us): read and write it as-is, and never migrate DOWN.
    console.log(
      `[Store] Opening schema v${currentVersion} (compatible down to v${floor}) with an app at v${latest}.`,
    )
    return
  }

  for (const migration of ladder) {
    if (migration.version <= currentVersion) continue

    withTransaction(db, () => {
      if (typeof migration.up === 'function') {
        migration.up(db)
      } else {
        db.exec(migration.up)
      }
      db.prepare('DELETE FROM schema_version').run()
      // The floor column is added by the first migration that needs it, so it
      // may appear mid-ladder: look after each migration ran.
      if (hasCompatibleFloorColumn(db)) {
        db.prepare('INSERT INTO schema_version (version, compatible_down_to) VALUES (?, ?)').run(
          migration.version,
          migration.compatibleDownTo ?? migration.version,
        )
      } else {
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version)
      }
    })
    console.log(`[Store] Applied migration v${migration.version}: ${migration.description}`)
  }
}

/**
 * THE OPENING RULE for a database written by a NEWER build than this one.
 *
 * A newer database may be opened when this app's latest schema is at least the
 * database's recorded floor (`schema_version.compatible_down_to`) — i.e. every
 * migration past us was additive. A database with no recorded floor (the
 * column absent, or NULL) treats the floor as its own version: refused, exactly
 * as every build before this rule refused it.
 */
export function canOpenNewerSchema(input: {
  databaseVersion: number
  compatibleDownTo: number | null
  appLatest: number
}): boolean {
  if (input.databaseVersion <= input.appLatest) return true
  const floor = input.compatibleDownTo ?? input.databaseVersion
  return input.appLatest >= floor
}

function hasCompatibleFloorColumn(db: FlowDatabase): boolean {
  const columns = db.prepare('PRAGMA table_info(schema_version)').all() as Array<{ name: string }>
  return columns.some((column) => column.name === 'compatible_down_to')
}

/** The recorded floor, or null when the column does not exist or holds NULL. */
export function readCompatibleFloor(db: FlowDatabase): number | null {
  if (!hasCompatibleFloorColumn(db)) return null
  const row = db.prepare('SELECT compatible_down_to FROM schema_version LIMIT 1').get() as
    | { compatible_down_to: number | null }
    | undefined
  return row?.compatible_down_to ?? null
}

function readSchemaVersion(db: FlowDatabase): number {
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined
  return row?.version ?? 0
}
