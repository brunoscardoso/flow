// Is this runtime signed in? Ask its own credential file, not its CLI.
//
// The CLI cannot be trusted to answer this question:
//
//   codex login status  → exits 1 with "Error loading configuration: unknown
//                         variant `xhigh`" on a machine whose user IS signed
//                         in. The config it refuses to parse has nothing to do
//                         with authentication.
//   copilot             → has no status subcommand at all. Its sign-in lives
//                         inside an interactive session, so asking the binary
//                         produced "Flow cannot check its sign-in from here" —
//                         which a user who had JUST signed in, and had the
//                         GitHub "your device is now connected" page open,
//                         quite reasonably read as broken.
//
// Both tools do write down who logged in, and those files are the record the
// tools themselves consult:
//
//   ~/.codex/auth.json      { "tokens": {...}, "OPENAI_API_KEY": ... }
//   ~/.copilot/config.json  { "loggedInUsers": [ { "host": ..., "login": ... } ] }
//
// Reading them is faster than spawning anything, cannot be broken by an
// unrelated config key, and answers the question actually being asked.
//
// It says CREDENTIALS EXIST, not "this token will be accepted" — a revoked
// token still reads as signed in until the tool refreshes it. That is the same
// promise Flow's own account rows make, and infinitely better than the two
// sentences above.

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface CredentialRecord {
  signedIn: boolean
  /** Who, when the file says — shown next to the requirement. */
  identity?: string
}

export interface CredentialDeps {
  readFileFn?: (path: string) => string
  homedirFn?: () => string
  env?: NodeJS.ProcessEnv
}

/** Where a runtime keeps the file, honouring its documented home override. */
export function credentialPath(provider: string, deps: CredentialDeps = {}): string | null {
  const env = deps.env ?? process.env
  const home = deps.homedirFn?.() ?? homedir()
  if (provider === 'codex') {
    return join(env['CODEX_HOME'] ?? join(home, '.codex'), 'auth.json')
  }
  if (provider === 'copilot') {
    return join(env['COPILOT_HOME'] ?? join(home, '.copilot'), 'config.json')
  }
  return null
}

/**
 * Strip whole-line `//` comments.
 *
 * MEASURED, and it cost a live bug: ~/.copilot/config.json opens with
 *   // User settings belong in settings.json.
 *   // This file is managed automatically.
 * so `JSON.parse` threw and a user who had JUST completed the GitHub device
 * flow was still told Copilot was not signed in. Only lines that BEGIN with //
 * go — a `//` inside a value is part of "https://github.com".
 */
function stripLineComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
}

function readJson(path: string, deps: CredentialDeps): Record<string, unknown> | null {
  const read = deps.readFileFn ?? ((target: string) => readFileSync(target, 'utf8'))
  try {
    const parsed: unknown = JSON.parse(stripLineComments(read(path)))
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    // No file, no permission, half-written JSON — all "we cannot see a login".
    return null
  }
}

/**
 * What `provider`'s own credential file says. Never throws; a file that is
 * missing or unreadable is simply not a sign-in.
 */
/**
 * The email inside an OIDC id_token, for display only.
 *
 * NOT VERIFIED, and it does not need to be: this decides what to print beside
 * "Signed in", and the token was written by the tool into a file only this user
 * can read. Nothing is authorized on the strength of it.
 */
function emailFromIdToken(token: unknown): string | null {
  if (typeof token !== 'string') return null
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8')
    const claims = JSON.parse(json) as { email?: unknown }
    return typeof claims.email === 'string' && claims.email.length > 0 ? claims.email : null
  } catch {
    return null
  }
}

export function readCredentials(provider: string, deps: CredentialDeps = {}): CredentialRecord {
  const path = credentialPath(provider, deps)
  if (path === null) return { signedIn: false }
  const data = readJson(path, deps)
  if (data === null) return { signedIn: false }

  if (provider === 'codex') {
    const tokens = data['tokens']
    const apiKey = data['OPENAI_API_KEY']
    const hasTokens = typeof tokens === 'object' && tokens !== null
    const hasKey = typeof apiKey === 'string' && apiKey.length > 0
    if (!hasTokens && !hasKey) return { signedIn: false }
    // WHO, not which account row. `account_id` is a UUID, and "Signed in —
    // 0c5d7381-b372-4c12-a378-9668c1203dc8" tells a person nothing they can
    // check. The id_token carries the email they signed in with.
    const identity = hasTokens
      ? emailFromIdToken((tokens as Record<string, unknown>)['id_token'])
      : null
    return { signedIn: true, ...(identity === null ? {} : { identity }) }
  }

  if (provider === 'copilot') {
    const users = data['loggedInUsers']
    if (!Array.isArray(users) || users.length === 0) return { signedIn: false }
    const first = users[0]
    const login =
      typeof first === 'object' && first !== null
        ? (first as Record<string, unknown>)['login']
        : null
    return {
      signedIn: true,
      ...(typeof login === 'string' && login.length > 0 ? { identity: login } : {}),
    }
  }

  return { signedIn: false }
}

/**
 * The model a runtime's own config already names, when it names one.
 *
 * WHY THIS IS WORTH READING: neither CLI can list the models an account may
 * use, so Flow cannot offer a menu it did not invent. But the user has usually
 * already written one down — this machine's ~/.codex/config.toml says
 * `model = "gpt-5.1-codex-max"` — and a picker that starts with the model you
 * already chose is the difference between "pick one" and "type an id from
 * memory".
 *
 * Codex only: ~/.copilot/config.json holds no model, and inventing one would
 * be a menu entry that fails at send time.
 */
export function readConfiguredModel(provider: string, deps: CredentialDeps = {}): string | null {
  if (provider !== 'codex') return null
  const env = deps.env ?? process.env
  const home = deps.homedirFn?.() ?? homedir()
  const path = join(env['CODEX_HOME'] ?? join(home, '.codex'), 'config.toml')
  const read = deps.readFileFn ?? ((target: string) => readFileSync(target, 'utf8'))
  let text: string
  try {
    text = read(path)
  } catch {
    return null
  }
  // A top-level `model = "…"` only. A key inside a [table] belongs to that
  // table (a provider block, an MCP server), and claiming it as THE model
  // would put someone else's setting in the user's picker.
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('[')) break
    const match = /^model\s*=\s*["']([^"']+)["']/.exec(trimmed)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}
