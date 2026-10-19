// Accounts IPC — the accounts:* channels that let the renderer manage
// per-project Anthropic accounts (list / add+login / remove / set default /
// per-project override / resolve-active). Account SECRETS never cross this
// boundary: the config dir and token stay in the main process; only labels,
// ids, and cached identity hints are exposed.

import { randomUUID } from 'node:crypto'
import { timed } from '../ipc/slow-handler'

import { ipcMain, BrowserWindow } from 'electron'

import type {
  AccountResolutionSummary,
  AccountSummary,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import type { AccountResolution } from '../agent/account-resolver'
import type { AccountResolver } from '../agent/account-resolver'
import type { LoginOrchestrator, LoginProgress } from '../agent/login-orchestrator'
import type { AccountRecord, AccountStore } from '../store/account-store'

export interface AccountIpcDependencies {
  accountStore: AccountStore
  accountResolver: AccountResolver
  loginOrchestrator: LoginOrchestrator
}

function toSummary(account: AccountRecord, defaultId: string | null): AccountSummary {
  return {
    id: account.id,
    label: account.label,
    identityHint: account.identityHint,
    createdAt: account.createdAt,
    isDefault: account.id === defaultId,
  }
}

function toResolutionSummary(resolution: AccountResolution): AccountResolutionSummary {
  if (resolution.status === 'legacy') return { status: 'legacy' }
  if (resolution.status === 'dangling') {
    return { status: 'dangling', accountId: resolution.accountId }
  }
  // 'ready' or 'unavailable' — both carry the resolved account AND where it came
  // from (#1108: pinned vs inherited must not render identically).
  return {
    status: 'ready',
    accountId: resolution.account.id,
    label: resolution.account.label,
    source: resolution.source,
  }
}

/**
 * Register the accounts:* handlers and return a dispose function. The add
 * handler blocks for the duration of the interactive login (browser OAuth) —
 * that is expected; the renderer shows a "signing in…" state while it runs.
 */
export function registerAccountChannels(deps: AccountIpcDependencies): () => void {
  const { accountStore, accountResolver, loginOrchestrator } = deps
  const registered: IpcInvokeChannel[] = []

  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registered.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload)
    }
  }

  // #972: stream the interactive login's progress (sign-in URL fallback +
  // the CLI's paste-the-code prompt) to every window so the UI can render a
  // code-entry field instead of freezing on "Opening browser sign-in…".
  function broadcastLoginProgress(progress: LoginProgress): void {
    broadcast(
      'accounts:loginEvent',
      progress.kind === 'url' ? { phase: 'url', url: progress.url } : { phase: 'awaiting-code' },
    )
  }

  handle('accounts:list', () => {
    const defaultId = accountStore.getDefaultAccountId()
    return accountStore.listAccounts().map((account) => toSummary(account, defaultId))
  })

  handle('accounts:add', async ({ label }) => {
    const trimmed = label.trim()
    if (trimmed.length === 0) {
      return { error: 'Account label is required' }
    }
    // Allocate an isolated config dir (keyed by a fresh id — the dir name is
    // unrelated to the account's DB id) and run the interactive login into it.
    const configDirPath = loginOrchestrator.allocateConfigDir(randomUUID())
    let result
    try {
      result = await loginOrchestrator.login(configDirPath, broadcastLoginProgress)
    } catch (error) {
      loginOrchestrator.removeConfigDir(configDirPath)
      return { error: error instanceof Error ? error.message : 'login failed' }
    }
    if (!result.completed) {
      loginOrchestrator.removeConfigDir(configDirPath)
      return { error: result.error ?? 'login did not complete' }
    }
    const account = accountStore.createAccount({
      label: trimmed,
      configDirPath,
      identityHint: result.identity ?? null,
    })
    // The first account becomes the default automatically.
    if (accountStore.getDefaultAccountId() === null) {
      accountStore.setDefaultAccountId(account.id)
    }
    broadcast('accounts:changed', {})
    return { account: toSummary(account, accountStore.getDefaultAccountId()) }
  })

  handle('accounts:status', async ({ id }) => {
    const account = accountStore.getAccount(id)
    if (!account) return { checked: true, loggedIn: false, identity: null }
    const status = await accountResolver.probeStatus(account.configDirPath)
    if (status.probeFailed === true) {
      return { checked: false, loggedIn: false, identity: null }
    }
    // Keep the stored hint fresh whenever a live identity comes back.
    if (status.loggedIn && status.identity && status.identity !== account.identityHint) {
      accountStore.setIdentityHint(id, status.identity)
    }
    return { checked: true, loggedIn: status.loggedIn, identity: status.identity ?? null }
  })

  handle('accounts:relogin', async ({ id }) => {
    const account = accountStore.getAccount(id)
    if (!account) return { ok: false as const, error: 'account not found' }
    // Re-login into the EXISTING config dir — expired enterprise sessions
    // (user call 2026-07-27) get fresh credentials without losing the
    // account's id, per-project assignments, or history.
    let result
    try {
      result = await loginOrchestrator.login(account.configDirPath, broadcastLoginProgress)
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : 'login failed' }
    }
    if (!result.completed) {
      return { ok: false as const, error: result.error ?? 'login did not complete' }
    }
    accountStore.setIdentityHint(id, result.identity ?? null)
    // Warm the session cache so the very next agent run passes resolution.
    await accountResolver.probeStatus(account.configDirPath)
    broadcast('accounts:changed', {})
    return { ok: true as const, identity: result.identity ?? null }
  })

  // #972: the pasted authorization code travels renderer → active child stdin.
  handle('accounts:submitLoginCode', ({ code }) => ({
    ok: loginOrchestrator.submitCode(code),
  }))

  // #972: user-initiated abort — the pending add/relogin resolves as canceled.
  handle('accounts:cancelLogin', () => ({ ok: loginOrchestrator.cancelLogin() }))

  handle('accounts:remove', ({ id }) => {
    const account = accountStore.getAccount(id)
    accountStore.removeAccount(id)
    if (account) loginOrchestrator.removeConfigDir(account.configDirPath)
    broadcast('accounts:changed', {})
  })

  handle('accounts:setDefault', ({ id }) => {
    accountStore.setDefaultAccountId(id)
    broadcast('accounts:changed', {})
  })

  handle('accounts:assignProject', ({ rootPath, accountId }) => {
    accountStore.setProjectAccountId(rootPath, accountId)
    broadcast('accounts:changed', { rootPath })
  })

  handle('accounts:activeForProject', ({ rootPath }) =>
    toResolutionSummary(accountResolver.resolve(rootPath)),
  )

  return function disposeAccountChannels(): void {
    for (const channel of registered) {
      ipcMain.removeHandler(channel)
    }
    registered.length = 0
  }
}
