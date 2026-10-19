// storage-names — the ON-DISK names of the project tables, kept in one place.
//
// THE CODE SAYS "PROJECT"; THE DATABASE STILL SAYS "WORKSPACE". The rename
// (plan_rename-workspace-to-project_v1) renamed every code-level name, but the
// physical tables, columns and indexes keep their legacy names on purpose: an
// older Flow build that predates the rename must still be able to open the SAME
// profile database (user, 2026-10-06: the dev app and the installed app share
// one profile). Renaming a physical table or column is a breaking migration —
// the older build refuses any schema newer than it knows, and could not read
// the renamed names even if it tried. See the policy block in migrations.ts.
//
// SQL strings interpolate these constants rather than spelling the legacy names
// inline, so a reader sees the concept ("the projects table") and the one place
// that maps it to storage. Never change these values: the day a build no older
// than the rename is the oldest one anyone runs, a view or a new table can take
// over — never an in-place rename.

/** The registered-project table (one row per project root per window). */
export const PROJECTS_TABLE = 'workspaces' as const

/** `threads` column naming the project a thread belongs to. */
export const THREAD_PROJECT_ROOT_COLUMN = 'workspace_root' as const

/** Per-project UI state table (active thread, account override, legacy tabs).
 *  Its own key column is already called `project_root`. */
export const PROJECT_STATE_TABLE = 'workspace_state' as const
