// Opening a COPY of this machine's real Flow profile with today's code.
//
// The dev app and the older installed Flow.app share ONE profile database
// (user, 2026-10-06). #1931's sub-agent migrations (v36–v38) move past v35 —
// the way the policy in migrations.ts allows: ADDITIVELY, recording the v35
// floor the opening rule reads. So this asserts that opening a v35 profile
// upgrades it without breaking the installed build's view of it: the floor is
// v35, every object the installed build had is still there (nothing renamed,
// nothing dropped), and no table lost or gained a row.
//
// The original is never opened: its files (the database and its WAL sidecars)
// are copied byte for byte into a temp directory, and only the copy is read.
// Skipped when there is no profile (CI, a fresh machine); a profile outside
// v35–latest is reported and left uncompared.

import Database from 'better-sqlite3'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { migrate, openDatabase, readCompatibleFloor, type FlowDatabase } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'

/** The app's userData folder (`app.setName('Flow')`) and its database file. */
const PROFILE_DB = join(homedir(), 'Library', 'Application Support', 'Flow', 'flow.db')
const SIDECARS = ['-wal', '-shm']
/** The newest schema the installed (pre-rename) Flow.app accepts. */
const INSTALLED_BUILD_SCHEMA = 35

interface Shape {
  version: number
  objects: Array<{ type: string; name: string; sql: string | null }>
  rows: Record<string, number>
}

function shapeOf(db: FlowDatabase): Shape {
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Shape['objects']
  const rows: Record<string, number> = {}
  for (const { type, name } of objects) {
    if (type !== 'table') continue
    rows[name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n
  }
  const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
  return { version, objects, rows }
}

const describeIfProfile = existsSync(PROFILE_DB) ? describe : describe.skip

describeIfProfile('a copy of the real profile, opened by today’s code', () => {
  let dir: string
  let copyPath: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-profile-compat-'))
    copyPath = join(dir, 'flow.db')
    copyFileSync(PROFILE_DB, copyPath)
    for (const suffix of SIDECARS) {
      if (existsSync(`${PROFILE_DB}${suffix}`)) copyFileSync(`${PROFILE_DB}${suffix}`, `${copyPath}${suffix}`)
    }
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('upgrades a v35 profile ADDITIVELY: floor v35, nothing dropped or renamed, rows intact', () => {
    // Past the installed build only behind a floor its opening rule accepts.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(INSTALLED_BUILD_SCHEMA)

    const raw = new Database(copyPath)
    const before = shapeOf(raw)
    raw.close()
    if (before.version < INSTALLED_BUILD_SCHEMA || before.version > LATEST_SCHEMA_VERSION) {
      console.warn(
        `[profile-compat] profile copy is at v${before.version}, outside v${INSTALLED_BUILD_SCHEMA}–v${LATEST_SCHEMA_VERSION} — nothing to compare`,
      )
      return
    }
    // Positive first (allowed-pattern #28): the tables the installed build reads exist.
    expect(before.objects.map((object) => object.name)).toEqual(
      expect.arrayContaining(['workspaces', 'workspace_state', 'threads', 'app_settings']),
    )

    const db = openDatabase(copyPath)
    try {
      const after = shapeOf(db)
      expect(after.version).toBe(LATEST_SCHEMA_VERSION)
      // The floor the installed build's opening rule reads: at (never above) v35.
      expect(readCompatibleFloor(db)).toBe(INSTALLED_BUILD_SCHEMA)
      // ADDITIVE ONLY: every object the installed build had is still there
      // under its own name and type (the stored SQL may gain columns).
      const afterNames = new Set(after.objects.map((object) => `${object.type}:${object.name}`))
      for (const object of before.objects) {
        expect(afterNames.has(`${object.type}:${object.name}`)).toBe(true)
      }
      // …and migration invented or lost no rows in any pre-existing table.
      expect(after.rows).toEqual(before.rows)
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      db.close()
    }

    // And the installed build's ladder opens the migrated copy instead of refusing it.
    const installed = new Database(copyPath)
    try {
      expect(() =>
        migrate(installed, MIGRATIONS.filter((migration) => migration.version <= INSTALLED_BUILD_SCHEMA)),
      ).not.toThrow()
      expect(readCompatibleFloor(installed)).toBe(INSTALLED_BUILD_SCHEMA)
    } finally {
      installed.close()
    }
  })
})
