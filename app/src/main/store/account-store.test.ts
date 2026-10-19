// AccountStore tests — real better-sqlite3 (Electron ABI, migration v4 applied
// by openDatabase) over a temp-dir database.

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { openDatabase, type FlowDatabase } from './db'
import { AccountStore } from './account-store'

describe('AccountStore', () => {
  let tempDir: string
  let db: FlowDatabase
  let store: AccountStore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-accounts-'))
    db = openDatabase(join(tempDir, 'flow.sqlite'))
    store = new AccountStore(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates, lists, and gets accounts', () => {
    const a = store.createAccount({ label: 'Personal', configDirPath: '/dir/a' })
    const b = store.createAccount({ label: 'Acme Co', configDirPath: '/dir/b', identityHint: 'x@acme' })

    expect(store.getAccount(a.id)).toMatchObject({ label: 'Personal', configDirPath: '/dir/a', identityHint: null })
    expect(store.getAccount(b.id)?.identityHint).toBe('x@acme')
    expect(store.listAccounts().map((acc) => acc.label)).toEqual(['Personal', 'Acme Co'])
  })

  it('sets and clears the default account', () => {
    const a = store.createAccount({ label: 'Personal', configDirPath: '/dir/a' })
    expect(store.getDefaultAccountId()).toBeNull()

    store.setDefaultAccountId(a.id)
    expect(store.getDefaultAccountId()).toBe(a.id)

    store.setDefaultAccountId(null)
    expect(store.getDefaultAccountId()).toBeNull()
  })

  it('sets a per-project override, creating a workspace_state row if absent', () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    expect(store.getProjectAccountId('/proj/x')).toBeNull()

    store.setProjectAccountId('/proj/x', a.id)
    expect(store.getProjectAccountId('/proj/x')).toBe(a.id)
  })

  it('preserves other workspace_state columns when setting an override', () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    // Seed a workspace_state row with real UI state, then override the account.
    db.prepare(
      `INSERT INTO workspace_state (project_root, open_files, active_file, open_terminals, active_thread_id, last_active_at)
       VALUES ('/proj/x', '["a.ts"]', 'a.ts', '[]', 'thread-1', '2026-01-01T00:00:00Z')`,
    ).run()

    store.setProjectAccountId('/proj/x', a.id)

    const row = db.prepare('SELECT open_files, active_file, active_thread_id, account_id FROM workspace_state WHERE project_root = ?').get('/proj/x') as {
      open_files: string
      active_file: string
      active_thread_id: string
      account_id: string
    }
    expect(row).toEqual({ open_files: '["a.ts"]', active_file: 'a.ts', active_thread_id: 'thread-1', account_id: a.id })
  })

  it('removing an account clears the default and every project override', () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    store.setDefaultAccountId(a.id)
    store.setProjectAccountId('/proj/x', a.id)
    store.setProjectAccountId('/proj/y', a.id)

    store.removeAccount(a.id)

    expect(store.getAccount(a.id)).toBeNull()
    expect(store.getDefaultAccountId()).toBeNull()
    expect(store.getProjectAccountId('/proj/x')).toBeNull()
    expect(store.getProjectAccountId('/proj/y')).toBeNull()
  })

  it('updates the cached identity hint', () => {
    const a = store.createAccount({ label: 'Acme', configDirPath: '/dir/a' })
    store.setIdentityHint(a.id, 'ceo@acme · Acme Org')
    expect(store.getAccount(a.id)?.identityHint).toBe('ceo@acme · Acme Org')
  })

  // #1349: removing the DEFAULT account left the app with NO default and said
  // nothing. Every project that merely INHERITED it dropped from `ready` to
  // `legacy` — silently running under the ambient CLI login rather than any
  // configured account, while a perfectly good account sat unused.
  describe('removing the default account (#1349)', () => {
    it('promotes a survivor', () => {
      const first = store.createAccount({ label: 'Personal', configDirPath: '/dir/a' })
      const second = store.createAccount({ label: 'Acme Co', configDirPath: '/dir/b' })
      store.setDefaultAccountId(second.id)

      store.removeAccount(second.id)

      expect(store.getDefaultAccountId()).toBe(first.id)
    })

    it('leaves no default when nothing survives — that IS correct', () => {
      const only = store.createAccount({ label: 'Personal', configDirPath: '/dir/a' })
      store.setDefaultAccountId(only.id)

      store.removeAccount(only.id)

      expect(store.getDefaultAccountId()).toBeNull()
    })

    it('does not disturb the default when a NON-default account goes', () => {
      const first = store.createAccount({ label: 'Personal', configDirPath: '/dir/a' })
      const second = store.createAccount({ label: 'Acme Co', configDirPath: '/dir/b' })
      store.setDefaultAccountId(first.id)

      store.removeAccount(second.id)

      expect(store.getDefaultAccountId()).toBe(first.id)
    })

    it('picks the OLDEST survivor — arbitrary, but stable across runs', () => {
      const first = store.createAccount({ label: 'One', configDirPath: '/dir/a' })
      store.createAccount({ label: 'Two', configDirPath: '/dir/b' })
      const third = store.createAccount({ label: 'Three', configDirPath: '/dir/c' })
      store.setDefaultAccountId(third.id)

      store.removeAccount(third.id)

      expect(store.getDefaultAccountId()).toBe(first.id)
    })
  })
})
