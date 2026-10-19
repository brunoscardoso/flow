// GitHub Copilot's LIVE model catalogue (#1929).
//
// runtime-model-discovery.ts reads what an account has been WATCHED to run —
// Copilot's own `~/.copilot/data.db`, which stays empty until an interactive
// session fills it — plus a hand-kept list of four candidate ids. So a Copilot
// user who only ever drives the CLI headlessly through Flow saw four models
// while the Copilot IDE's `/model` list showed the whole current set (#1929).
//
// THE COPILOT IDE DOES NOT GUESS. It asks the same endpoint every Copilot
// client asks — `GET https://api.githubcopilot.com/models` — which returns the
// account's live, per-plan catalogue WITH each model's context limits. There is
// no `copilot --list-models` (github/copilot-cli#700 is open), so this is the
// one source that is both current and this-account's. This module is the reader
// for it, and it is a GUEST: read-only, bounded, and fail-soft on everything —
// a machine with no token, a non-macOS box where the keychain call is absent, a
// network that is down, a schema that moved. An empty list means "nothing to
// add", which is exactly today's behaviour, never an error a user has to see.
//
// UNVERIFIED (#1929): the /models JSON is community-reverse-engineered ("not a
// stable public standard"), so every field is read defensively with a fallback.
// The keychain token path and the endpoint's auth were NOT exercised against a
// live Copilot account in the worktree this was written in — this needs an
// app-env + signed-in Copilot pass before it is trusted (allowed-pattern #7).

import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'

import { COPILOT_MODEL_LABELS } from '../../../shared/runtime-models'

/** One model as the picker/settings understand it: an id, maybe a friendlier
 *  label, and — the reason this endpoint beats the db — its context window. */
export interface CopilotCatalogModel {
  id: string
  label?: string
  /** Max context window in tokens, when the catalogue reports it. The 1M-token
   *  models are the ones a context-window choice is offered for (#1929). */
  contextWindowTokens?: number
}

export interface CopilotCatalogDeps {
  /** Injected in tests: the HTTP call. Default: global fetch. */
  fetchFn?: typeof fetch
  /** Injected in tests: how the Copilot bearer token is found. Default: env
   *  vars, then the macOS keychain. Returns null when there is none. */
  tokenFn?: (deps: CopilotCatalogDeps) => Promise<string | null>
  env?: NodeJS.ProcessEnv
  homedirFn?: () => string
  /** Injected in tests: spawn, for the keychain read. */
  spawnFn?: typeof spawn
  /** Injected in tests: read a file (the ~/.copilot token fallback). */
  readFileFn?: (path: string) => string
}

/** The endpoint every Copilot client reads its model list from. */
const MODELS_URL = 'https://api.githubcopilot.com/models'

/**
 * The GitHub OAuth token is NOT accepted by api.githubcopilot.com directly. Every
 * first-party client (VS Code, the CLI) first exchanges it here for a short-lived
 * (~30 min) Copilot SESSION token, then calls the models/chat endpoints with that.
 * Skipping this step was why the catalogue came back empty (#1929): the raw token
 * is refused by /models.
 */
const TOKEN_EXCHANGE_URL = 'https://api.github.com/copilot_internal/v2/token'

/** The header the API keys behaviour off — the same value the VS Code Copilot
 *  Chat client sends. Without it the endpoint may answer differently or refuse. */
const INTEGRATION_ID = 'vscode-chat'

/** Editor identity headers the token-exchange and models endpoints expect from a
 *  first-party client. Values track what the Copilot clients send; exact numbers
 *  do not matter, their PRESENCE does. */
const EDITOR_VERSION = 'vscode/1.95.0'
const EDITOR_PLUGIN_VERSION = 'copilot-chat/0.23.0'

/** The keychain service Copilot stores its credential under (see
 *  runtime-logout.ts `COPILOT_KEYCHAIN_SERVICE`). */
const COPILOT_KEYCHAIN_SERVICE = 'copilot-cli'

/** A network call that hangs is worse than one that fails — the settings panel
 *  waits on this. Bounded, and abandoned rather than retried. */
const FETCH_TIMEOUT_MS = 4_000

/** How long a fetched catalogue is trusted before a refetch. The set changes on
 *  the scale of GitHub releases, not minutes; opening Settings twice should not
 *  hit the network twice. */
const CACHE_TTL_MS = 5 * 60 * 1_000

interface CacheEntry {
  at: number
  models: CopilotCatalogModel[]
}
const cache = new Map<string, CacheEntry>()

/** Read the Copilot bearer token, or null. Env first (a CI/headless box may set
 *  it), then macOS keychain, then the token file some CLI versions drop under
 *  `~/.copilot`. Every branch fail-soft: no token is a normal state (a machine
 *  that has never signed in), handled by returning null, never throwing. */
async function defaultToken(deps: CopilotCatalogDeps): Promise<string | null> {
  const env = deps.env ?? process.env
  for (const key of ['COPILOT_TOKEN', 'GH_COPILOT_TOKEN', 'GITHUB_COPILOT_TOKEN']) {
    const value = env[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }

  // macOS keychain — the same store runtime-logout.ts deletes on sign-out. `-w`
  // prints just the secret. Absent on other platforms, which is fine: null.
  if (process.platform === 'darwin') {
    const fromKeychain = await readKeychainToken(deps)
    if (fromKeychain !== null) return fromKeychain
  }

  // Some CLI versions keep a token file; read it the way we read any config.
  const home = env['COPILOT_HOME'] ?? join(deps.homedirFn?.() ?? homedir(), '.copilot')
  const read = deps.readFileFn ?? ((path: string) => readFileSync(path, 'utf8'))
  for (const name of ['token', 'apps.json', 'hosts.json']) {
    try {
      const raw = read(join(home, name))
      const token = extractToken(raw)
      if (token !== null) return token
    } catch {
      // Not this file — try the next.
    }
  }
  return null
}

/** A bare token, or the first token-shaped value in a small JSON blob. */
function extractToken(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed
  try {
    const found = firstStringValue(JSON.parse(trimmed), ['oauth_token', 'token', 'access_token'])
    return found
  } catch {
    return null
  }
}

/** Depth-first hunt for the first value under one of `keys`. */
function firstStringValue(node: unknown, keys: readonly string[]): string | null {
  if (node === null || typeof node !== 'object') return null
  const record = node as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  for (const value of Object.values(record)) {
    const nested = firstStringValue(value, keys)
    if (nested !== null) return nested
  }
  return null
}

/** `security find-generic-password -s copilot-cli -w` — the secret on stdout,
 *  or null on any non-zero/absent path. Mirrors runtime-logout.ts's spawn. */
async function readKeychainToken(deps: CopilotCatalogDeps): Promise<string | null> {
  const spawnFn = deps.spawnFn ?? spawn
  return await new Promise<string | null>((resolve) => {
    let out = ''
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const child = spawnFn('security', ['find-generic-password', '-s', COPILOT_KEYCHAIN_SERVICE, '-w'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      child.stdout?.on('data', (chunk: Buffer | string) => {
        out += String(chunk)
      })
      child.on('error', () => finish(null))
      child.on('close', (code) => {
        const token = out.trim()
        finish(code === 0 && token.length > 0 ? extractToken(token) : null)
      })
    } catch {
      finish(null)
    }
  })
}

/** The one field that is always there — the id. Everything else is optional and
 *  read only when it is the shape we expect. */
function looksLikeModelId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length < 80 && !/[\s/]/.test(value)
}

/** Pull a positive token count out of whichever field the account's schema uses
 *  for the model's context window. All optional; undefined when none is found. */
function contextTokensOf(capabilities: unknown): number | undefined {
  if (capabilities === null || typeof capabilities !== 'object') return undefined
  const caps = capabilities as Record<string, unknown>
  const limits = (caps['limits'] as Record<string, unknown> | undefined) ?? caps
  for (const key of ['max_context_window_tokens', 'max_prompt_tokens', 'context_window', 'max_input_tokens']) {
    const value = limits[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/** One raw `/models` entry → our shape, or null if it is not a usable model. */
function toModel(entry: unknown): CopilotCatalogModel | null {
  if (entry === null || typeof entry !== 'object') return null
  const record = entry as Record<string, unknown>
  const id = record['id']
  if (!looksLikeModelId(id)) return null
  // Some catalogues flag a model as unavailable/disabled on this plan — never
  // offer one that would refuse the turn (the invariant runtime-models keeps).
  if (record['model_picker_enabled'] === false || record['enabled'] === false) return null
  const model: CopilotCatalogModel = { id }
  const name = record['name']
  if (typeof name === 'string' && name.trim().length > 0) model.label = name.trim()
  const tokens = contextTokensOf(record['capabilities'])
  if (tokens !== undefined) model.contextWindowTokens = tokens
  return model
}

/**
 * Turn whatever token we found into a Copilot SESSION token accepted by
 * api.githubcopilot.com.
 *
 * A value that already carries `tid=` IS a session token (that is the shape the
 * exchange returns) — used as-is. Anything else is treated as a GitHub OAuth
 * token and exchanged. Fail-soft: a refused or malformed exchange returns null,
 * which the caller reads as "no catalogue", never an error.
 */
async function copilotSessionToken(
  raw: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<string | null> {
  if (raw.includes('tid=')) return raw
  try {
    const response = await fetchFn(TOKEN_EXCHANGE_URL, {
      headers: {
        Authorization: `token ${raw}`,
        'Editor-Version': EDITOR_VERSION,
        'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
        'User-Agent': 'GitHubCopilot/1.0',
        Accept: 'application/json',
      },
      signal,
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return null
    const token = (body as Record<string, unknown>)['token']
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** The `/models` body in either of the two shapes seen in the wild: a bare
 *  array, or `{ data: [...] }` (the OpenAI-compatible envelope). */
function parseModels(body: unknown): CopilotCatalogModel[] {
  const rows = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['data'])
      ? ((body as Record<string, unknown>)['data'] as unknown[])
      : []
  const seen = new Set<string>()
  const models: CopilotCatalogModel[] = []
  for (const row of rows) {
    const model = toModel(row)
    if (model !== null && !seen.has(model.id)) {
      seen.add(model.id)
      models.push(model)
    }
  }
  return models
}

/**
 * The KNOWN-GOOD built-in catalogue (#1929) — every entry in COPILOT_MODEL_LABELS
 * as a catalogue row. Used whenever the live fetch cannot answer, so the picker
 * still lists the real current set instead of falling back to four ids. No
 * context window is claimed (the live fetch is the only source that knows one).
 */
function builtinCatalog(): CopilotCatalogModel[] {
  return Object.entries(COPILOT_MODEL_LABELS).map(([id, label]) => ({ id, label }))
}

/**
 * The account's LIVE Copilot model catalogue, or the built-in list when it
 * cannot be read.
 *
 * Cached for a few minutes so opening Settings does not hit the network each
 * time. NEVER throws — every failure (no token, non-macOS keychain, a down
 * network, a moved schema, a refused exchange) falls back to the built-in
 * catalogue, so the picker always shows the current set. Only a NON-EMPTY live
 * result is cached; the built-in is never cached, so the next call retries live.
 */
export async function fetchCopilotCatalog(deps: CopilotCatalogDeps = {}): Promise<CopilotCatalogModel[]> {
  const cached = cache.get(COPILOT_KEYCHAIN_SERVICE)
  // Date.now() is fine in app main (this is not a workflow script).
  const now = Date.now()
  if (cached !== undefined && now - cached.at < CACHE_TTL_MS) return cached.models

  const token = await (deps.tokenFn ?? defaultToken)(deps)
  if (token === null) return cached?.models ?? builtinCatalog()

  const fetchFn = deps.fetchFn ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    // The raw token is not accepted by /models — exchange it for a session token
    // first (the step that was missing, #1929). Null → built-in catalogue.
    const session = await copilotSessionToken(token, fetchFn, controller.signal)
    if (session === null) return cached?.models ?? builtinCatalog()
    const response = await fetchFn(MODELS_URL, {
      headers: {
        Authorization: `Bearer ${session}`,
        'Content-Type': 'application/json',
        'Copilot-Integration-Id': INTEGRATION_ID,
        'Editor-Version': EDITOR_VERSION,
        'Editor-Plugin-Version': EDITOR_PLUGIN_VERSION,
      },
      signal: controller.signal,
    })
    if (!response.ok) return cached?.models ?? builtinCatalog()
    const models = parseModels(await response.json())
    // A real answer supersedes the built-in and is cached; an empty one falls
    // back without caching, so a later call can still get the live list.
    if (models.length === 0) return cached?.models ?? builtinCatalog()
    cache.set(COPILOT_KEYCHAIN_SERVICE, { at: now, models })
    return models
  } catch {
    // Timeout, DNS, TLS, a body that would not parse — the built-in stands in.
    return cached?.models ?? builtinCatalog()
  } finally {
    clearTimeout(timer)
  }
}

/** Drop the cached catalogue — for tests, and for an explicit refresh after a
 *  sign-in changes which account answers. */
export function clearCopilotCatalogCache(): void {
  cache.clear()
}
