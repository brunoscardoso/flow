// Schema migrations for the Flow app database.
//
// Each migration is a monotonically-versioned script applied inside a
// transaction by `openDatabase` (see db.ts). The current version is tracked
// in the `schema_version` table. Never edit a shipped migration — append a
// new one instead.
//
// ── COMPATIBILITY POLICY: OLDER BUILDS SHARE THIS PROFILE ─────────────────
// One profile database can be opened by more than one Flow build (the dev app
// and an older installed Flow.app, user 2026-10-06). So:
//
//   * Prefer ADDITIVE migrations — new tables, new nullable (or defaulted)
//     columns, new indexes. An older build ignores what it does not know, so
//     it can keep reading and writing the profile. Set `compatibleDownTo` to
//     the previous migration's floor to say so.
//   * NEVER rename or drop a physical table, column or index. Rename in CODE
//     instead (see storage-names.ts: the projects table is still physically
//     `workspaces`), or add a VIEW under the new name.
//   * A migration that cannot avoid breaking older builds (a rename, a drop, a
//     type change) sets `compatibleDownTo` to its own version: every older
//     build will then refuse the profile, as it must.
//
// The floor is stored beside the version (`schema_version.compatible_down_to`)
// and read by db.ts's opening rule. Builds that predate the rule refuse any
// newer version regardless. The first migration that needed a floor (v36)
// added the column (ALTER TABLE schema_version ADD COLUMN compatible_down_to
// INTEGER) — and that is additive too.

import type Database from 'better-sqlite3'

export interface Migration {
  /** Monotonically increasing schema version this migration produces. */
  version: number
  /** Human-readable description for logs. */
  description: string
  /**
   * SQL statements applied inside one transaction, or a function for
   * migrations that need runtime feature detection (e.g. FTS5).
   */
  up: string | ((db: Database.Database) => void)
  /**
   * The OLDEST schema version whose app can still safely read and write a
   * database at this version. Additive migrations carry the previous floor
   * forward; a breaking one (rename, drop, type change) sets its own version.
   * Omitted = this migration's own version (the safe, refusing default).
   * See the compatibility policy above.
   */
  compatibleDownTo?: number
}

/**
 * True when the bundled SQLite was compiled with FTS5 (better-sqlite3
 * normally ships it, but the v2 migration must not brick the database on a
 * build without it — searchThreads falls back to a LIKE scan instead).
 */
export function isFts5Available(db: Database.Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(probe)')
    db.exec('DROP TABLE temp.__fts5_probe')
    return true
  } catch {
    return false
  }
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'initial schema: threads, messages, tool_calls, permission_rules, workspaces',
    up: `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        sdk_session_id TEXT,
        model TEXT,
        effort TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_threads_workspace_root ON threads(workspace_root);
      CREATE UNIQUE INDEX idx_threads_sdk_session_id
        ON threads(sdk_session_id) WHERE sdk_session_id IS NOT NULL;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);

      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT,
        output_json TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX idx_tool_calls_thread ON tool_calls(thread_id);

      CREATE TABLE permission_rules (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        pattern TEXT,
        verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'deny')),
        created_at TEXT NOT NULL,
        UNIQUE(project_root, tool_name, pattern)
      );
      CREATE INDEX idx_permission_rules_root_tool
        ON permission_rules(project_root, tool_name);

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        window_id TEXT NOT NULL,
        root_path TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        UNIQUE(window_id, root_path)
      );
      CREATE INDEX idx_workspaces_window ON workspaces(window_id);
    `,
  },
  {
    // PERF-4: thread search was an unindexed leading-wildcard LIKE scan over
    // every message. External-content FTS5 tables over threads.title and
    // messages.content (kept in sync by triggers, so ANY writer is covered —
    // including FK cascade deletes) turn it into an index lookup.
    //
    // tokenchars '_%': underscores and percent signs are token characters,
    // so `snake_case` and `100%` search as single tokens instead of being
    // split/stripped by unicode61's default separator rules.
    //
    // Idempotent by construction: IF NOT EXISTS on every object, and the
    // backfill uses the FTS5 'rebuild' command, which fully repopulates an
    // external-content table from its content table no matter how many times
    // it runs. On SQLite builds without FTS5 the migration is a no-op and
    // ThreadStore falls back to the LIKE scan.
    version: 2,
    description: 'FTS5 search index over threads.title + messages.content (PERF-4)',
    up: (db) => {
      if (!isFts5Available(db)) {
        console.warn(
          '[Store] FTS5 unavailable in this SQLite build — thread search stays on the LIKE scan',
        )
        return
      }
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
          title,
          content='threads',
          content_rowid='rowid',
          tokenize="unicode61 tokenchars '_%'"
        );
        CREATE TRIGGER IF NOT EXISTS threads_fts_ai AFTER INSERT ON threads BEGIN
          INSERT INTO threads_fts(rowid, title) VALUES (new.rowid, new.title);
        END;
        CREATE TRIGGER IF NOT EXISTS threads_fts_ad AFTER DELETE ON threads BEGIN
          INSERT INTO threads_fts(threads_fts, rowid, title)
            VALUES ('delete', old.rowid, old.title);
        END;
        CREATE TRIGGER IF NOT EXISTS threads_fts_au AFTER UPDATE OF title ON threads BEGIN
          INSERT INTO threads_fts(threads_fts, rowid, title)
            VALUES ('delete', old.rowid, old.title);
          INSERT INTO threads_fts(rowid, title) VALUES (new.rowid, new.title);
        END;

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content='messages',
          content_rowid='rowid',
          tokenize="unicode61 tokenchars '_%'"
        );
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES ('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, content)
            VALUES ('delete', old.rowid, old.content);
          INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
        END;

        INSERT INTO threads_fts(threads_fts) VALUES ('rebuild');
        INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');
      `)
    },
  },
  {
    version: 3,
    description:
      'workspace_state: per-project workspace context (open tabs, terminals, active thread) for ADR-002 project-scoped switching + restore',
    up: `
      CREATE TABLE IF NOT EXISTS workspace_state (
        project_root TEXT PRIMARY KEY,
        open_files TEXT NOT NULL DEFAULT '[]',
        active_file TEXT,
        open_terminals TEXT NOT NULL DEFAULT '[]',
        active_thread_id TEXT,
        last_active_at TEXT NOT NULL
      );
    `,
  },
  {
    // Per-project Anthropic accounts: named subscription accounts (each an
    // isolated CLAUDE_CONFIG_DIR the CLI is logged into) + a per-project
    // override on workspace_state, resolved as override ?? default ?? legacy.
    // account_id is intentionally FK-less (SQLite ADD COLUMN can't add an
    // enforced reference retroactively) — AccountStore clears dangling
    // overrides in code when an account is removed. app_settings holds the
    // default_account_id (a generic single-row key/value store).
    version: 4,
    description:
      'accounts + workspace_state.account_id override + app_settings (per-project Anthropic accounts)',
    up: `
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        config_dir_path TEXT NOT NULL,
        identity_hint TEXT,
        created_at TEXT NOT NULL
      );

      ALTER TABLE workspace_state ADD COLUMN account_id TEXT;

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `,
  },
  {
    // Thread archiving: a soft-hide separate from delete. archived_at is the
    // ISO timestamp a thread was archived (NULL = active). Archived threads are
    // excluded from the default thread list and shown in a separate section.
    version: 5,
    description: 'threads.archived_at — soft-archive a thread out of the active list',
    up: `ALTER TABLE threads ADD COLUMN archived_at TEXT;`,
  },
  {
    // Claude Code import: imported_at is the ISO timestamp a thread was created
    // by importing a Claude Code CLI session (NULL = a native app thread).
    // Additive — existing threads read as non-imported. The imported thread's
    // sdk_session_id carries the Claude sessionId (dedup + resume handle).
    version: 6,
    description: 'threads.imported_at — mark threads imported from Claude Code sessions',
    up: `ALTER TABLE threads ADD COLUMN imported_at TEXT;`,
  },
  {
    // Pinning: pinned_at is the ISO timestamp a thread was pinned (NULL =
    // unpinned). Pinned threads are exempt from the sidebar's 7-day recency
    // filter and float to the top. Additive — existing threads read as unpinned.
    version: 7,
    description: 'threads.pinned_at — pin a thread above the recency filter',
    up: `ALTER TABLE threads ADD COLUMN pinned_at TEXT;`,
  },
  {
    // Task list: a Task owns exactly one thread (1:1 via thread_id) and carries
    // a source (manual / jira / github) plus the external issue key/url so
    // future git/link work can attach without migration. lane is the Kanban
    // state (todo/doing/done). Additive — existing threads are unaffected and
    // simply have no task (they render as "bare" threads).
    version: 8,
    description: 'tasks — task list owning one thread each, with source + lane',
    up: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual'
          CHECK (source IN ('manual', 'jira', 'github')),
        external_key TEXT,
        external_url TEXT,
        lane TEXT NOT NULL DEFAULT 'todo'
          CHECK (lane IN ('todo', 'doing', 'done')),
        suggest_done INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        description TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_tasks_project_root ON tasks(project_root);
      CREATE UNIQUE INDEX idx_tasks_external_key
        ON tasks(source, external_key) WHERE external_key IS NOT NULL;
    `,
  },
  {
    // Add more issue providers (Azure DevOps, …) without a migration each time:
    // SQLite can't ALTER a CHECK, so rebuild `tasks` WITHOUT the source CHECK
    // (the TaskSource TS type is the source of truth now). lane CHECK stays.
    version: 9,
    description: 'tasks.source — drop the CHECK so new providers (azure, …) need no migration',
    up: `
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        external_key TEXT,
        external_url TEXT,
        lane TEXT NOT NULL DEFAULT 'todo'
          CHECK (lane IN ('todo', 'doing', 'done')),
        suggest_done INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        description TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks_new (id, project_root, title, source, external_key, external_url, lane, suggest_done, thread_id, description, archived_at, created_at, updated_at)
        SELECT id, project_root, title, source, external_key, external_url, lane, suggest_done, thread_id, description, archived_at, created_at, updated_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX idx_tasks_project_root ON tasks(project_root);
      CREATE UNIQUE INDEX idx_tasks_external_key
        ON tasks(source, external_key) WHERE external_key IS NOT NULL;
    `,
  },
  {
    // Dedup is PER PROJECT: the same issue can legitimately be tracked in two
    // projects. Re-scope the unique index from (source, external_key) to
    // (project_root, source, external_key). Idempotent via IF EXISTS/IF NOT EXISTS.
    version: 10,
    description: 'tasks: per-project external-key uniqueness (project_root, source, external_key)',
    up: `
      DROP INDEX IF EXISTS idx_tasks_external_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_key
        ON tasks(project_root, source, external_key) WHERE external_key IS NOT NULL;
    `,
  },
  {
    // Per-thread "skip permission prompts" — runs the SDK session in
    // bypassPermissions mode. Additive; existing threads read as 0 (default,
    // prompts on). Dangerous by design, so it's off unless explicitly enabled.
    version: 11,
    description: 'threads.bypass_permissions — run a thread with permission prompts skipped',
    up: `ALTER TABLE threads ADD COLUMN bypass_permissions INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    // Task technical brief — a PM-style, engineer-focused summary generated
    // asynchronously (e.g. after importing a PR). Additive; existing tasks read
    // as no brief / idle status until (re)generated.
    version: 12,
    description: 'tasks.brief + tasks.brief_status — auto-generated technical brief',
    up: `
      ALTER TABLE tasks ADD COLUMN brief TEXT;
      ALTER TABLE tasks ADD COLUMN brief_status TEXT NOT NULL DEFAULT 'idle';
    `,
  },
  {
    // Multi-project threads (#45): a thread's PRIMARY project stays
    // threads.workspace_root; ADDITIONAL projects live here. Additive — existing
    // single-project threads simply have zero rows. Cascades on thread delete.
    version: 13,
    description: 'thread_roots — additional project roots for multi-project threads',
    up: `
      CREATE TABLE IF NOT EXISTS thread_roots (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        root_path TEXT NOT NULL,
        UNIQUE(thread_id, root_path)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_roots_thread ON thread_roots(thread_id);
    `,
  },
  {
    // Record which model produced each assistant message, so the conversation
    // can show a per-message model badge (#129). Additive + nullable: existing
    // messages (and user/system rows) read as no model and render no badge.
    version: 14,
    description: 'messages.model — the model that produced each assistant message',
    up: `ALTER TABLE messages ADD COLUMN model TEXT;`,
  },
  {
    version: 15,
    description: 'message_attachments — image attachments on user messages (#456); bytes on disk',
    up: `
      CREATE TABLE message_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        file_name TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_message_attachments_message ON message_attachments (message_id);
    `,
  },
  {
    // ide-auto-provisioning: stamps a workspace root once it's been auto-
    // provisioned (e.g. plan-flow scaffolding applied) so future sessions can
    // skip re-provisioning and the UI can show provisioning state. Both
    // columns are nullable and written together via a single write path
    // (ProjectRegistryDao.stampProvisioned) — existing/legacy rows simply read as
    // never-provisioned (NULL → absent on the RegisteredProject shape).
    version: 16,
    description:
      'workspaces.provisioned_at + provisioned_version — stamp when a root was auto-provisioned',
    up: `
      ALTER TABLE workspaces ADD COLUMN provisioned_at TEXT;
      ALTER TABLE workspaces ADD COLUMN provisioned_version TEXT;
    `,
  },
  {
    // progressive-learning (#513 phase 2): records this root's answer to the
    // one-time "Run a basic discovery?" ask shown on first provisioning-ready.
    // 'yes' | 'no' | NULL (never asked). Additive + nullable: the ask fires
    // only while the answer is NULL, so it is never repeated once answered.
    version: 17,
    description:
      'workspaces.basic_discovery_answer — per-root answer to the basic-discovery onboarding ask (#513)',
    up: `ALTER TABLE workspaces ADD COLUMN basic_discovery_answer TEXT;`,
  },
  {
    // #955: a project switch silently destroyed unsaved editor buffers. The
    // workspace_state row already persists the project's tab SET (open_files /
    // active_file); this adds the unsaved buffer CONTENTS — a JSON object keyed
    // by absolute file path — so switching back restores the tabs DIRTY with
    // the user's typed text instead of silently reverting to disk.
    version: 18,
    description:
      'workspace_state.dirty_buffers — persisted unsaved editor buffer contents per project (#955)',
    up: `ALTER TABLE workspace_state ADD COLUMN dirty_buffers TEXT NOT NULL DEFAULT '{}';`,
  },
  {
    // User-customizable project accent color: a per-root override for the
    // deterministic hash accent (project-accent.ts). NULL = no override — the
    // hash accent applies ("Auto"). Written only via ProjectRegistryDao.setAccentColor
    // (one code path, allowed-pattern #14). Additive + nullable: existing rows
    // read as no override, so nothing changes until a user picks a color.
    version: 19,
    description: 'workspaces.accent_color — per-root user accent override (Auto = NULL)',
    up: `ALTER TABLE workspaces ADD COLUMN accent_color TEXT;`,
  },
  {
    // PERF batch: tool_calls are always read per-thread in (started_at, id)
    // order (list/slim/offset queries) and messages are probed per-thread by
    // role (hasSystemMessage's artifact-marker guard) — both previously
    // sorted/filtered without a covering index. Additive + idempotent.
    version: 20,
    description:
      'perf indexes — tool_calls(thread_id, started_at, id) + messages(thread_id, role)',
    up: `
      CREATE INDEX IF NOT EXISTS idx_tool_calls_thread_started
        ON tool_calls(thread_id, started_at, id);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_role
        ON messages(thread_id, role);
    `,
  },
  {
    // NOT this feature's migration — carried over from parallel in-progress
    // work in the main checkout so the SHARED user database (already at v21)
    // opens on this branch. Without it the app refuses to start: v21 on disk,
    // v20 supported, and refusing a downgrade is correct.
    //
    // Verbatim, so it merges cleanly when that work lands. Purely additive
    // (two columns with defaults) and inert here — nothing on this branch
    // reads them.
    version: 21,
    description: 'threads.input_tokens + threads.output_tokens — per-thread cumulative usage',
    up: `
      ALTER TABLE threads ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    // The board grew a fourth lane (Blocked). The lane column is already TEXT,
    // but v8 pinned a CHECK to the three lanes of the day and v9 deliberately
    // kept it while dropping the sibling `source` CHECK — so writing 'blocked'
    // raised SQLITE_CONSTRAINT and the drop target silently refused every card.
    // Same remedy v9 applied to `source`, for the same reason: SQLite can't
    // ALTER a CHECK, so rebuild `tasks` without it and let the TaskLane TS type
    // be the source of truth. Pure schema — every row is copied verbatim, and a
    // lane this build doesn't know now reads back as Todo rather than failing
    // (see toTaskLane in task-store.ts).
    version: 22,
    description: 'tasks.lane — drop the CHECK so new lanes (blocked, …) need no migration',
    up: `
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        project_root TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        external_key TEXT,
        external_url TEXT,
        lane TEXT NOT NULL DEFAULT 'todo',
        suggest_done INTEGER NOT NULL DEFAULT 0,
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        description TEXT,
        brief TEXT,
        brief_status TEXT NOT NULL DEFAULT 'idle',
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO tasks_new (id, project_root, title, source, external_key, external_url, lane, suggest_done, thread_id, description, brief, brief_status, archived_at, created_at, updated_at)
        SELECT id, project_root, title, source, external_key, external_url, lane, suggest_done, thread_id, description, brief, brief_status, archived_at, created_at, updated_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX IF NOT EXISTS idx_tasks_project_root ON tasks(project_root);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_key
        ON tasks(project_root, source, external_key) WHERE external_key IS NOT NULL;
    `,
  },
  {
    // PROVENANCE, not ownership. `tasks.thread_id` means "the conversation this
    // task OWNS" — click the card, that thread opens. `origin_thread_id` answers
    // a different question: which conversation PRODUCED this card. A task
    // mirrored from an agent's todo list has an origin and (until someone opens
    // it) no thread of its own; a task created by hand has a thread and no
    // origin. Two fields, because one field cannot answer both without ten cards
    // from one conversation all reopening it.
    //
    // DELETION SEMANTICS — chosen, not inherited (FR-10):
    //   * NOT cascade. A task must OUTLIVE the conversation that created it.
    //     Tidying up a chat would otherwise delete a person's work, silently and
    //     irreversibly — the single worst outcome available on this column.
    //   * NOT restrict/no-action. That inverts the harm: deleting a chat would
    //     start FAILING once it had produced a card, and the user cannot see
    //     why.
    //   * SET NULL, matching thread_id. The row survives; only the pointer goes.
    //     Retaining a dead id instead would leave every consumer resolving a
    //     thread that is gone — the shape of #1061, where a cached dead thread
    //     id had surfaces offering "Open chat" on nothing. And NULL already has
    //     an honest meaning here that a dangling id does not: we do not know
    //     which conversation produced this. After the conversation is deleted,
    //     that is simply true, and it reads back through exactly the same path
    //     as a row written before this column existed.
    //
    // Additive + nullable, no CHECK (v9 and v22 both had to rebuild `tasks` to
    // drop one — none is added back). Existing rows read as no origin.
    version: 23,
    description:
      'tasks.origin_thread_id — the thread that PRODUCED a task, distinct from the thread it owns',
    up: `ALTER TABLE tasks ADD COLUMN origin_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;`,
  },
  {
    // A LOOP RUN IS A CONVERSATION, and until now nothing recorded that it was
    // one. Pressing Run on the loops screen opened a thread and sent it a
    // command; the thread came out looking like any other chat, the board's card
    // for the hunt had no way to reach it, and the loops screen could not say
    // "it is running, here". Three surfaces short one fact.
    //
    // Three columns, because three different questions get asked of a run:
    //   * `origin_loop` — WHICH loop this thread runs. The sidebar reads it to
    //     draw the loop's own glyph instead of a chat bubble.
    //   * `origin_aim`  — the sentence it was pointed at, VERBATIM. The board
    //     matches it against the hunt the CLI reports, which is keyed on the
    //     same text; storing our own normalization would be a second spelling of
    //     a fact the CLI already owns.
    //   * `origin_key`  — the run's name (`TOL-001`), minted once when the run
    //     starts. Derived nowhere else: a key each surface recomputed would
    //     drift the moment two of them disagreed about how many runs there had
    //     been.
    //
    // All three nullable and additive — every existing thread reads back as what
    // it is, a conversation nobody started from a loop.
    version: 24,
    description: 'threads.origin_loop / origin_aim / origin_key — the run a thread IS',
    up: `
      ALTER TABLE threads ADD COLUMN origin_loop TEXT;
      ALTER TABLE threads ADD COLUMN origin_aim TEXT;
      ALTER TABLE threads ADD COLUMN origin_key TEXT;
      CREATE INDEX IF NOT EXISTS idx_threads_origin_loop
        ON threads(workspace_root, origin_loop) WHERE origin_loop IS NOT NULL;
    `,
  },
  {
    // A THREAD OWNS ITS CHECKOUT. Until now every thread agent, editor and
    // terminal shared the project's one working tree, which is forbidden-pattern
    // #11 written down: two turns against one tree, one of them switches branch,
    // and the other's commits land wherever it happened to be. The loops were
    // given worktrees for exactly this; these three columns are where a thread
    // records the one it was given.
    //
    // Three columns, because three different questions get asked of a checkout:
    //   * `worktree_path`   — WHERE the thread's tree is on disk. Stored EXACTLY
    //     as `planflow-ai worktree` returned it, never recomputed: the command
    //     realpaths its target, so its answer is git's own spelling of the path.
    //     A path we derived ourselves disagrees the moment a root is reached
    //     through a symlink (this repo's `flow/` is one), and then every
    //     comparison against `git worktree list` silently misses.
    //   * `worktree_branch` — the branch that tree is on, or NULL while it is
    //     DETACHED. Detached is the normal early state, not an error: a thread
    //     has no title until its first turn succeeds, so it has nothing to name
    //     a branch after until then. Consumers must read null as "not named
    //     yet", never as "no worktree".
    //   * `worktree_base`   — the ref the tree was cut FROM, kept because it is
    //     the only record of where the work is meant to land. Deriving it later
    //     from whatever the project's HEAD happens to be would silently retarget
    //     a merge every time the user switched branches.
    //
    // All three nullable and additive. Every existing thread — and every thread
    // that is only ever chatted to — reads back as three nulls, which is exactly
    // what it is: a conversation with no checkout of its own, behaving as it
    // does today.
    version: 25,
    description:
      'threads.worktree_path / worktree_branch / worktree_base — the checkout a thread owns',
    up: `
      ALTER TABLE threads ADD COLUMN worktree_path TEXT;
      ALTER TABLE threads ADD COLUMN worktree_branch TEXT;
      ALTER TABLE threads ADD COLUMN worktree_base TEXT;
      CREATE INDEX IF NOT EXISTS idx_threads_worktree_path
        ON threads(worktree_path) WHERE worktree_path IS NOT NULL;
    `,
  },
  {
    // A LOCAL BRANCH IS NOT A REMOTE TARGET. v25 gave a thread its checkout and
    // the branch that checkout is on — a name Flow chose, in Flow's grammar.
    // Pushing that name verbatim to a hardcoded remote is how work lands on the
    // wrong branch, the wrong remote or against the wrong base: the remote side
    // belongs to the project's conventions, not to ours. These four columns are
    // where a thread records the binding a PERSON decided for it.
    //
    // A MIRROR, NOT THE TRUTH. Git's own upstream config
    // (`branch.<local>.remote` / `branch.<local>.merge`) is the source of truth
    // for `remote` and `remote_branch`; these columns exist so the workspace
    // list can draw fifteen rows without fifteen child processes
    // (allowed-pattern #19). When the two disagree — somebody ran plain git —
    // GIT WINS and the mirror is rewritten from it, never the other way round.
    //
    // Four columns, because four different questions get asked of a binding:
    //   * `remote`               — WHICH remote this thread publishes to. Part
    //     of the binding rather than assumed `origin`: a fork-and-upstream
    //     checkout has two, and picking the first one is precisely the guess
    //     this feature exists to refuse.
    //   * `remote_branch`        — the branch name on that remote, which may
    //     differ from the local one and usually does in projects with a naming
    //     convention. NULL means UNBOUND — nobody has decided yet — and unbound
    //     is refused at push, never silently defaulted to the local name.
    //   * `pr_base`              — the branch a pull request opens against.
    //     The one field git has no slot for, which is why the mirror cannot be
    //     dropped in favour of reading config alone. NULL falls back to the
    //     ref the worktree was cut from (`worktree_base`).
    //   * `previously_pushed_as` — the remote branch this thread USED to be
    //     bound to, kept after a rename re-points the upstream. The old branch
    //     is still on the remote and nothing here deletes it; a record that
    //     says so is the difference between a user seeing an orphan and being
    //     surprised by one.
    //
    // All four nullable and additive. Every existing thread — and every thread
    // that is only ever chatted to — reads back as four nulls, which is what it
    // is: a conversation that has never published anything and is never asked
    // to. Threads that already have an upstream in git are read as bound the
    // first time something asks; nothing is renamed or re-pointed here.
    version: 26,
    description:
      'threads.remote / remote_branch / pr_base / previously_pushed_as — the remote binding a thread was given',
    up: `
      ALTER TABLE threads ADD COLUMN remote TEXT;
      ALTER TABLE threads ADD COLUMN remote_branch TEXT;
      ALTER TABLE threads ADD COLUMN pr_base TEXT;
      ALTER TABLE threads ADD COLUMN previously_pushed_as TEXT;
    `,
  },
  {
    // A COPY IS ONLY AS CURRENT AS WHAT IT WAS CUT FROM. Creating a thread's
    // checkout deliberately does not contact the remote (`--no-fetch`): the
    // checkout itself is measured in seconds and bounded by the disk, while a
    // fetch is bounded by nothing the app knows, and a workspace that hangs
    // behind an unreachable remote is worse than one cut a few commits behind.
    // So the refresh became its own step — bounded, cancellable — and this
    // column is what the step writes when it could not finish.
    //
    // ONE COLUMN, ONE QUESTION: was the branch this copy was cut from refreshed
    // first? `1` means no — the network was slow, absent, or somebody stopped
    // waiting — and the cut went ahead from the last thing the repository knew.
    // NOT a failure and not an error state: the work in the copy is fine, and
    // what is unknown is only whether its starting point was current. Saying so
    // is the entire point; a stale cut that hides is a merge conflict nobody
    // saw coming.
    //
    // Nullable INTEGER and additive, like every flag before it. NULL reads as
    // false — every existing thread, and every thread cut while the remote was
    // reachable, honestly says nothing is known to be behind. Cleared with the
    // rest of the checkout's columns when a workspace is released, because the
    // question stops having a subject.
    version: 27,
    description: 'threads.base_may_be_behind — the cut that could not refresh its base first',
    up: `
      ALTER TABLE threads ADD COLUMN base_may_be_behind INTEGER;
    `,
  },
  {
    // THE SCREENSHOTS COME WITH THE TICKET, or they never come at all.
    //
    // A bug report is mostly its picture, and the addresses of those pictures
    // are read once — while the issue is being fetched, from a payload that
    // holds the attachment list. Storing them here is what lets an imported
    // task show the same strip the remote card showed, offline, with no second
    // round trip and no second way for it to fail.
    //
    // JSON, not a table. This is a short, ordered list that is written once
    // with its task, read whole, and never queried across — the shape a column
    // is for. A row per picture would buy joins nobody performs.
    //
    // NULL IS NOT AN EMPTY LIST, which is the whole reason the column is
    // nullable: a task written before this existed says "nobody looked", and a
    // ticket with nothing attached says "there are none". Only the second
    // should ever be reported as a ticket with no pictures.
    version: 28,
    description: 'tasks.images — the ticket attachments an imported task carries',
    up: `
      ALTER TABLE tasks ADD COLUMN images TEXT;
    `,
  },
  {
    // A BOARD IS ALSO A NOTEBOOK, and that is what this column protects.
    //
    // The Todo column's play button now puts an agent on the cards it finds,
    // and the user's own objection is the reason it does not find all of them:
    // "sometime the user wanna create some item manually just to track, but no
    // fix or implement at that moment". A list you were keeping to remember
    // things must not become a list an agent starts work on because you pressed
    // a button somewhere else.
    //
    // So a card joins the loop's population only when somebody ticks it. NULL
    // reads as false — every card that already exists, and every card made from
    // now on, is a note until a person says otherwise. Opting in is the
    // deliberate act; opting out is the default, because the cost of the two
    // mistakes is not remotely symmetric.
    version: 29,
    description: 'tasks.auto_fix — the cards the board loop is allowed to work',
    up: `
      ALTER TABLE tasks ADD COLUMN auto_fix INTEGER;
    `,
  },
  {
    // THE BLOCKED LANE NOW HAS TWO MEANINGS, and this column keeps them apart.
    //
    // A human dragging a card to Blocked means "I parked this". An agent asking
    // the user a question means "this card is waiting on you" — and we move it to
    // Blocked so the board shows it. The two must not be confused: when the agent
    // is answered, only the card the AGENT moved may slide back, and a human's
    // parked card must never be yanked out from under them.
    //
    // NULL = not parked by the agent (a human drag, or not blocked at all). A
    // lane value = the agent moved this card and this is where it came from —
    // both the marker AND the lane to restore to, in one column. Every existing
    // row, and every row made from now on, reads NULL: the safe default is "the
    // human owns any block", because auto-restoring a card nobody's agent moved
    // is the mistake with the higher cost.
    version: 30,
    description: 'tasks.agent_blocked_from — the lane an agent-waiting card returns to',
    up: `
      ALTER TABLE tasks ADD COLUMN agent_blocked_from TEXT;
    `,
  },
  {
    // THE REVIEW LANE NEEDS A LINK TO REVIEW. When the board loop finishes a
    // card's turn cleanly it opens a pull request and moves the card to Review;
    // this column is where that PR's URL is kept, so the card can offer "PR ↗"
    // and a one-click merge without asking git again.
    //
    // NULL = no pull request (a card that never reached Review, or one whose
    // turn could not open one — an unbound thread, no `gh`, a base that lives
    // only on this computer). Additive + nullable, no CHECK — every existing
    // row, and every card that never produces a PR, reads NULL. The lane column
    // itself needs no migration: v22 dropped its CHECK, so 'review' is just
    // another string a build that knows it draws and one that doesn't degrades
    // to Todo (toTaskLane).
    version: 31,
    description: 'tasks.pr_url — the pull request a Review card carries',
    up: `
      ALTER TABLE tasks ADD COLUMN pr_url TEXT;
    `,
  },
  {
    // WHICH STEP OF THE FLOW THIS CONVERSATION IS ON, without inferring it.
    //
    // Autopilot used to be prose — a config key and an instruction block asking
    // a model to run discovery → plan → execute → review in order. Nothing ran
    // the chain, and nothing could say where a thread had got to except by
    // reading what the model had written about itself. These two columns are
    // what a driver writes as it issues each step, so the question is answered
    // from a record rather than from a transcript.
    //
    // NULL IS NOT A STAGE, and that is both columns' ordinary value: every
    // thread that already exists, every ordinary conversation, and every thread
    // whose chain has ended reads NULL — no chain is driving this. A value in
    // `chain_stage` means one is, and `chain_id` says which run it belongs to,
    // so two chains on one project are told apart in the record the same way
    // they are told apart in memory.
    //
    // Additive and nullable, with no CHECK and no backfill: there is nothing to
    // backfill (no thread has ever been chained), and a CHECK naming today's
    // four stages would turn adding a fifth into a table rebuild. A build that
    // does not know a stage name simply has no chain to draw.
    version: 32,
    description: 'threads.chain_id / chain_stage — the flow step a chain is driving',
    up: `
      ALTER TABLE threads ADD COLUMN chain_id TEXT;
      ALTER TABLE threads ADD COLUMN chain_stage TEXT;
    `,
  },
  {
    // A CONVERSATION'S OTHER PROJECTS GET CHECKOUTS TOO.
    //
    // WHAT WAS WRONG. A thread can carry several projects — `thread_roots` is
    // the join — but only ONE checkout existed, on `threads.worktree_path`, and
    // it belonged to the project the thread started in. Every other project
    // resolved to its real shared tree. So a multi-project thread was isolated
    // in one repository and writing directly into the others, and nothing on
    // screen said so: the file tree showed `orbit-app (thread/…)` above a
    // plain `orbit-core` (user, 2026-09-17). Partial isolation is worse than
    // none, because it is the kind you trust.
    //
    // WHERE THE PRIMARY'S RECORD STAYS. On `threads` — 116 readers across 21
    // files already ask it there, and moving them would be a rewrite whose only
    // gain is symmetry. These columns hold the OTHER projects' checkouts, which
    // is a different fact with a different key, not a second copy of the same
    // one. `thread_roots` holds additional roots; the primary is never a row in
    // it, so the two can never disagree about one project.
    //
    // Additive and nullable. Every existing row reads as "this project has no
    // checkout of its own", which is exactly what was true before this ran.
    version: 33,
    description:
      'thread_roots.worktree_path / worktree_branch / worktree_base — a checkout per attached project',
    up: `
      ALTER TABLE thread_roots ADD COLUMN worktree_path TEXT;
      ALTER TABLE thread_roots ADD COLUMN worktree_branch TEXT;
      ALTER TABLE thread_roots ADD COLUMN worktree_base TEXT;
    `,
  },
  {
    // EACH CONVERSATION KEEPS ITS OWN TABS. Until now the editor's tab set was
    // persisted per PROJECT (`workspace_state.open_files` / `active_file` /
    // `dirty_buffers`), so every thread of a project shared one strip: a file,
    // a feature view or the blueprint opened while reading thread 1 was still
    // there on thread 2 (user, 2026-10-01: "each thread separates the work").
    //
    // ONE ROW PER (project, thread). `thread_id = ''` is the PROJECT-LEVEL set —
    // what shows while no thread is selected. '' rather than NULL because the
    // pair is the primary key, and SQLite treats every NULL as distinct.
    // `open_views` is the editor-area views that belong to the set (feature
    // views, the blueprint, the browser, the Changes tab), as JSON refs with
    // enough identity to reopen them lazily.
    //
    // NO FOREIGN KEY on thread_id for the same '' reason; the thread delete
    // path drops a thread's row explicitly (thread-store.deleteThread).
    //
    // MIGRATION: every project's saved tabs become that project's project-level
    // set, verbatim; threads start empty. `INSERT OR IGNORE` keeps it a no-op if
    // it ever met a row it already wrote. The legacy columns are left in place
    // (never edit a shipped table destructively) and are simply no longer read.
    version: 34,
    description: 'thread_tab_state — editor tabs + views per (project, thread)',
    up: `
      CREATE TABLE IF NOT EXISTS thread_tab_state (
        root_path TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        open_files TEXT NOT NULL DEFAULT '[]',
        active_file TEXT,
        dirty_buffers TEXT NOT NULL DEFAULT '{}',
        open_views TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (root_path, thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_thread_tab_state_thread ON thread_tab_state(thread_id);
      INSERT OR IGNORE INTO thread_tab_state
        (root_path, thread_id, open_files, active_file, dirty_buffers, open_views, updated_at)
        SELECT project_root, '', open_files, active_file, dirty_buffers, '[]', last_active_at
        FROM workspace_state;
    `,
  },
  {
    // …AND ITS OWN SHELLS. A terminal a person opens belongs to the
    // conversation it was opened in (user, 2026-10-01: "your terminals too"),
    // so the shells to re-spawn after a restart are saved per (project,
    // thread) beside that conversation's tabs — one row, one store
    // (tab-set-store.ts), and the thread delete that drops its tabs drops its
    // shells in the same statement.
    //
    // MIGRATION: each project's saved shells (`workspace_state.open_terminals`)
    // become its project-level set. The legacy column stays (never edit a
    // shipped table destructively) and is no longer read.
    version: 35,
    description: 'thread_tab_state.open_terminals — user shells per (project, thread)',
    up: `
      ALTER TABLE thread_tab_state ADD COLUMN open_terminals TEXT NOT NULL DEFAULT '[]';
      INSERT OR IGNORE INTO thread_tab_state
        (root_path, thread_id, open_files, active_file, dirty_buffers, open_views, updated_at)
        SELECT project_root, '', '[]', NULL, '{}', '[]', last_active_at
        FROM workspace_state;
      UPDATE thread_tab_state
        SET open_terminals = COALESCE(
          (SELECT ws.open_terminals FROM workspace_state ws
            WHERE ws.project_root = thread_tab_state.root_path),
          '[]')
        WHERE thread_id = '' AND open_terminals = '[]';
    `,
  },
  {
    // Sub-agent sub-chats (#1931): a sub-agent's messages and tool calls are
    // captured and tagged with the PARENT Task tool call's id, so a sub-agent
    // transcript is "rows where parent_tool_call_id = <taskId>". Main-thread
    // rows keep it NULL (back-compat — existing rows get NULL, and the main
    // transcript reads filter to IS NULL, so it is unchanged).
    version: 36,
    description: 'messages/tool_calls.parent_tool_call_id — sub-agent sub-chats (#1931)',
    // ADDITIVE (nullable columns + indexes), so a v35 build that knows the
    // opening rule can keep reading and writing this profile. This is the first
    // migration past the shared v35 floor, so it also ADDS the
    // `compatible_down_to` column the rule reads (see the compatibility policy
    // above — that ALTER is additive too). Builds that predate the rule refuse
    // any newer version regardless.
    compatibleDownTo: 35,
    up: `
      ALTER TABLE schema_version ADD COLUMN compatible_down_to INTEGER;
      ALTER TABLE messages ADD COLUMN parent_tool_call_id TEXT;
      ALTER TABLE tool_calls ADD COLUMN parent_tool_call_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(thread_id, parent_tool_call_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_parent ON tool_calls(thread_id, parent_tool_call_id);
    `,
  },
  {
    // Sub-agent child threads (#1931 redesign): a sub-agent can be promoted to a
    // REAL child thread continued from its landing point. `parent_thread_id`
    // links it to its parent conversation; `origin_tool_call_id` is the parent's
    // Task tool-call it was promoted from (idempotency + "continue" seeding).
    // Both nullable — ordinary threads keep them NULL and are unchanged.
    version: 37,
    description: 'threads.parent_thread_id/origin_tool_call_id — sub-agent child threads (#1931)',
    // Additive (nullable columns + an index): the v35 floor carries forward.
    compatibleDownTo: 35,
    up: `
      ALTER TABLE threads ADD COLUMN parent_thread_id TEXT;
      ALTER TABLE threads ADD COLUMN origin_tool_call_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id);
    `,
  },
  {
    // Sub-agent transcript backfill (#1931): the runtime's task events carry the
    // sub-agent's id (`task_id`), which is also the key its transcript is stored
    // under in SDK session storage (subagents/agent-<id>.jsonl). Persisted on the
    // SPAWN tool-call row so a later promotion resolves the transcript
    // deterministically instead of matching prompts. NOT output_json — the SDK's
    // own tool_result overwrites that on completion. Nullable: rows that predate
    // this (and calls that never spawned an agent) stay NULL and are unchanged.
    version: 38,
    description: 'tool_calls.agent_id — sub-agent transcript backfill key (#1931)',
    // Additive (one nullable column): the v35 floor carries forward.
    compatibleDownTo: 35,
    up: `
      ALTER TABLE tool_calls ADD COLUMN agent_id TEXT;
    `,
  },
  {
    // WHICH MESSAGE ENDED A TURN (plan_chat-cleanup, Phase 1). The feed folds a
    // request into one work row and shows ONE answer under it; the answer is
    // the last assistant message that ended a turn. The bridge stamps it on
    // turn end (ThreadStore.markTurnEnd), so a wake-up turn's ending is a
    // stored fact rather than a guess from position.
    //
    // ONE VERSION NUMBER, TWO MEANINGS (merged 2026-10-09). This shipped on a
    // branch as v36 while main shipped a DIFFERENT v36 (sub-agent sub-chats).
    // A profile the branch build opened records version 36 with `ends_turn`
    // and WITHOUT main's v36 columns, so main's v36 never runs on it. This
    // migration therefore adds every column of both v36s that is missing, and
    // only those — it is the same step for a branch profile, a main profile
    // and a fresh one. ADDITIVE: the v35 floor carries forward.
    version: 39,
    description: 'messages.ends_turn — the assistant message that ended its turn (+ v36 reconciliation)',
    compatibleDownTo: 35,
    up: (db) => {
      const has = (table: string, column: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
          (row) => row.name === column,
        )
      if (!has('schema_version', 'compatible_down_to')) {
        db.exec('ALTER TABLE schema_version ADD COLUMN compatible_down_to INTEGER;')
      }
      if (!has('messages', 'parent_tool_call_id')) {
        db.exec('ALTER TABLE messages ADD COLUMN parent_tool_call_id TEXT;')
      }
      if (!has('tool_calls', 'parent_tool_call_id')) {
        db.exec('ALTER TABLE tool_calls ADD COLUMN parent_tool_call_id TEXT;')
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(thread_id, parent_tool_call_id);
        CREATE INDEX IF NOT EXISTS idx_tool_calls_parent ON tool_calls(thread_id, parent_tool_call_id);
      `)
      if (!has('messages', 'ends_turn')) {
        db.exec('ALTER TABLE messages ADD COLUMN ends_turn INTEGER NOT NULL DEFAULT 0;')
      }
    },
  },
  {
    // MID-RUN SUBTASKS (plan_mid-run-subtasks, Phase 3). A subtask is work the
    // agent hands to a background sub-agent while the person keeps talking. Its
    // row is created by `start_subtask` (a ticket) before the Agent call exists,
    // linked to that call by the Agent PreToolUse hook (`tool_call_id`), and to
    // the SDK's background task by `task_started` (`sdk_task_id`, which is also
    // the `agent_id` on the sub-agent's own hook input). SubtaskRegistry is the
    // ONLY writer. `files_written` / `overlap_files` are JSON text arrays.
    //
    // ADDITIVE (a new table + an index): a v35 build never reads it, so the v35
    // floor carries forward.
    version: 40,
    description: 'subtasks — mid-run background subtasks and their tickets',
    compatibleDownTo: 35,
    up: `
      CREATE TABLE IF NOT EXISTS subtasks (
        ticket          TEXT PRIMARY KEY,
        thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        from_message_id TEXT,
        title           TEXT NOT NULL,
        task            TEXT NOT NULL,
        state           TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'stopped')),
        attempt         INTEGER NOT NULL DEFAULT 1,
        retry_of        TEXT,
        tool_call_id    TEXT,
        sdk_task_id     TEXT,
        created_at      TEXT NOT NULL,
        started_at      TEXT,
        ended_at        TEXT,
        error           TEXT,
        files_written   TEXT NOT NULL DEFAULT '[]',
        overlap_files   TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_subtasks_thread ON subtasks(thread_id, created_at);
    `,
  },
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0
