// AccountStore — persistence for per-project Anthropic accounts (migration v4).
//
// An "account" is a named Claude subscription login isolated in its own
// CLAUDE_CONFIG_DIR (the runtime spike confirmed this fully isolates auth,
// keychain included). This store holds only NON-SECRET metadata — the OAuth
// token lives in the account's config dir, never here. Resolution is
// override ?? default ?? legacy(null); the override lives on workspace_state
// (the ADR-002 per-project table), the default in app_settings.

import { randomUUID } from 'crypto'

import type { FlowDatabase } from './db'
import { withTransaction } from './db'
import { PROJECT_STATE_TABLE } from './storage-names'

const DEFAULT_ACCOUNT_SETTING_KEY = 'default_account_id'

export interface AccountRecord {
  id: string
  /** User-set friendly name ("Personal", "Acme Co"). */
  label: string
  /** Absolute path to this account's isolated CLAUDE_CONFIG_DIR. */
  configDirPath: string
  /** Optional cached identity (email/org) from `claude auth status`. */
  identityHint: string | null
  createdAt: string
}

export interface CreateAccountInput {
  label: string
  configDirPath: string
  identityHint?: string | null
}

interface AccountRow {
  id: string
  label: string
  config_dir_path: string
  identity_hint: string | null
  created_at: string
}

export class AccountStore {
  constructor(private readonly db: FlowDatabase) {}

  // ── Accounts ─────────────────────────────────────────────────────────────

  listAccounts(): AccountRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM accounts ORDER BY created_at ASC, rowid ASC')
      .all() as AccountRow[]
    return rows.map(toAccountRecord)
  }

  getAccount(id: string): AccountRecord | null {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | AccountRow
      | undefined
    return row ? toAccountRecord(row) : null
  }

  createAccount(input: CreateAccountInput): AccountRecord {
    const account: AccountRecord = {
      id: randomUUID(),
      label: input.label,
      configDirPath: input.configDirPath,
      identityHint: input.identityHint ?? null,
      createdAt: new Date().toISOString(),
    }
    this.db
      .prepare(
        `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.label,
        account.configDirPath,
        account.identityHint,
        account.createdAt,
      )
    return account
  }

  /** Remove an account and clear every dangling reference (FK-less by design):
   *  project overrides pointing at it, and the default if it was the default. */
  /**
   * Remove an account, promoting a survivor when it was the DEFAULT (#1349).
   *
   * Deleting the default row without promoting anything left the app with no
   * default at all — and said nothing. Every project that merely INHERITED the
   * default then dropped from `ready` to `legacy`: they silently began running
   * under the ambient CLI login rather than any account the user configured,
   * while a perfectly good account sat in the list unused.
   *
   * `accounts:add` already promotes the first account to default for exactly
   * this reason; removal now applies the same rule from the other direction.
   * The oldest survivor wins — an arbitrary but STABLE choice, and the app
   * surfaces which account is default, so an unwanted pick is one click to
   * change rather than an invisible fallback to no account at all.
   */
  removeAccount(id: string): void {
    withTransaction(this.db, () => {
      const wasDefault =
        (
          this.db
            .prepare('SELECT value FROM app_settings WHERE key = ?')
            .get(DEFAULT_ACCOUNT_SETTING_KEY) as { value?: string } | undefined
        )?.value === id
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
      this.db.prepare(`UPDATE ${PROJECT_STATE_TABLE} SET account_id = NULL WHERE account_id = ?`).run(id)
      this.db
        .prepare('DELETE FROM app_settings WHERE key = ? AND value = ?')
        .run(DEFAULT_ACCOUNT_SETTING_KEY, id)
      if (!wasDefault) return
      const survivor = this.db
        .prepare('SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1')
        .get() as { id?: string } | undefined
      if (survivor?.id === undefined) return // none left: no default is correct
      this.db
        .prepare(
          'INSERT INTO app_settings (key, value) VALUES (?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
        .run(DEFAULT_ACCOUNT_SETTING_KEY, survivor.id)
    })
  }

  /** Update an account's cached identity (from a fresh `claude auth status`). */
  setIdentityHint(id: string, identityHint: string | null): void {
    this.db
      .prepare('UPDATE accounts SET identity_hint = ? WHERE id = ?')
      .run(identityHint, id)
  }

  // ── Default account (app_settings) ───────────────────────────────────────

  getDefaultAccountId(): string | null {
    const row = this.db
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .get(DEFAULT_ACCOUNT_SETTING_KEY) as { value: string | null } | undefined
    return row?.value ?? null
  }

  setDefaultAccountId(id: string | null): void {
    if (id === null) {
      this.db.prepare('DELETE FROM app_settings WHERE key = ?').run(DEFAULT_ACCOUNT_SETTING_KEY)
      return
    }
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(DEFAULT_ACCOUNT_SETTING_KEY, id)
  }

  // ── Per-project override (workspace_state.account_id) ────────────────────

  getProjectAccountId(projectRoot: string): string | null {
    const row = this.db
      .prepare(`SELECT account_id FROM ${PROJECT_STATE_TABLE} WHERE project_root = ?`)
      .get(projectRoot) as { account_id: string | null } | undefined
    return row?.account_id ?? null
  }

  /** Upsert the override — creates a minimal project-state row if the project
   *  has none yet (it may not, if no tabs/terminals were ever persisted). */
  setProjectAccountId(projectRoot: string, accountId: string | null): void {
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO ${PROJECT_STATE_TABLE}
           (project_root, open_files, active_file, open_terminals, active_thread_id, last_active_at, account_id)
         VALUES (?, '[]', NULL, '[]', NULL, ?, ?)
         ON CONFLICT(project_root) DO UPDATE SET account_id = excluded.account_id`,
      )
      .run(projectRoot, now, accountId)
  }
}

function toAccountRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    label: row.label,
    configDirPath: row.config_dir_path,
    identityHint: row.identity_hint,
    createdAt: row.created_at,
  }
}
