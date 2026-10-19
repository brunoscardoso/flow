// Structural invariants of the migration ladder. db.ts applies migrations with:
//
//   for (const m of MIGRATIONS) { if (m.version <= currentVersion) continue
//                                 apply(m); schema_version = m.version }
//
// so the ARRAY ORDER and the version NUMBERS are load-bearing, not cosmetic:
//   • out-of-order (v5 before v4) → v5 stamps schema_version=5, then v4's
//     `<= 5` check skips it → v4's SQL NEVER runs → silent schema corruption.
//   • a duplicate version → the second copy is `<= currentVersion` after the
//     first applies → skipped → its SQL never runs.
//   • a gap (v16 → v18) is almost always a fat-fingered version number.
//   • LATEST_SCHEMA_VERSION drives the "DB newer than this app — refuse to
//     open" guard, so it must equal the last migration's version.
//
// These assertions need no live DB (type-only better-sqlite3 import) — they read
// the exported ladder and fail loudly the moment a new migration is mis-numbered.

import { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration } from './migrations'

describe('MIGRATIONS ladder invariants', () => {
  const versions = MIGRATIONS.map((m) => m.version)

  it('is non-empty and starts at version 1 (a fresh DB is currentVersion 0)', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    expect(versions[0]).toBe(1)
  })

  it('is strictly ascending in array order (the apply loop trusts array order)', () => {
    for (let i = 1; i < versions.length; i += 1) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1])
    }
  })

  it('has no duplicate versions (a dup silently skips the later migration)', () => {
    expect(new Set(versions).size).toBe(versions.length)
  })

  it('is contiguous 1..N with no gaps (a gap signals a mis-numbered migration)', () => {
    expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1))
  })

  it('exposes LATEST_SCHEMA_VERSION as the final migration version', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(versions[versions.length - 1])
  })

  it('every migration carries a description and a runnable up (string SQL or fn)', () => {
    for (const m of MIGRATIONS) {
      expect(typeof m.description).toBe('string')
      expect(m.description.length).toBeGreaterThan(0)
      const upType = typeof m.up
      expect(upType === 'string' || upType === 'function').toBe(true)
      if (upType === 'string') expect((m.up as string).trim().length).toBeGreaterThan(0)
    }
  })
})

describe('the ladder is what db.ts would apply on a fresh database', () => {
  // Replays db.ts's apply predicate over a virgin (version 0) database WITHOUT a
  // real DB: every migration must be selected exactly once, in ascending order,
  // ending at LATEST_SCHEMA_VERSION — the property that makes a fresh open correct.
  function applied(from: number): Migration[] {
    const out: Migration[] = []
    let currentVersion = from
    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue
      out.push(migration)
      currentVersion = migration.version
    }
    return out
  }

  it('applies every migration from a fresh DB, ending at LATEST_SCHEMA_VERSION', () => {
    const run = applied(0)
    expect(run).toEqual(MIGRATIONS)
    expect(run[run.length - 1]?.version).toBe(LATEST_SCHEMA_VERSION)
  })

  it('applies only the tail when partway upgraded (idempotent re-open)', () => {
    const mid = MIGRATIONS[Math.floor(MIGRATIONS.length / 2)].version
    const run = applied(mid)
    expect(run.every((m) => m.version > mid)).toBe(true)
    expect(run.map((m) => m.version)).toEqual(versionsAbove(mid))
  })

  it('applies nothing when already at the latest version', () => {
    expect(applied(LATEST_SCHEMA_VERSION)).toEqual([])
  })
})

function versionsAbove(threshold: number): number[] {
  return MIGRATIONS.map((m) => m.version).filter((v) => v > threshold)
}

describe('v36 — the turn-end mark (plan_chat-cleanup, Phase 1)', () => {
  // The turn-end mark moved from the branch's v36 to v39 at the merge with
  // main's own v36 (v36-reconcile.test.ts runs it against every profile shape).
  const v39 = MIGRATIONS.find((m) => m.version === 39)

  it('adds ends_turn as a guarded, additive step — never a drop or rename', () => {
    expect(typeof v39?.up).toBe('function')
    const source = String(v39?.up)
    expect(source).toContain('ALTER TABLE messages ADD COLUMN ends_turn INTEGER NOT NULL DEFAULT 0')
    expect(source).not.toMatch(/\b(DROP|RENAME)\b/i)
  })

  it('declares floor 35, so the installed v35 build keeps opening the shared profile', () => {
    expect(v39?.compatibleDownTo).toBe(35)
  })
})
