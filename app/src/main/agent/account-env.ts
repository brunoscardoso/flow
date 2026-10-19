// Shared account-auth environment construction (#107). The agent session, the
// availability probe, and the login spawn must all evaluate BYTE-IDENTICAL auth
// — otherwise the probe/login can pass on an inherited token while the
// token-stripped session fails, silently breaking multi-account fail-closed
// isolation (a probe reports an account `ready`/logged-in using the inherited
// token, then the real session strips it and runs against a logged-out config
// dir and crashes).

/**
 * Auth tokens that OUTRANK `CLAUDE_CONFIG_DIR`. Any one left set would override
 * an account's isolated config dir, so all account-scoped processes strip them.
 */
export const INHERITED_AUTH_TOKENS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const

/**
 * Environment for any process that must authenticate AS a specific account:
 * `baseEnv` + the account's `CLAUDE_CONFIG_DIR`, with every inherited auth token
 * removed so the config dir is the SOLE effective auth. Used by the session,
 * the auth probe, and login so availability/login match the session exactly.
 */
export function buildAccountEnv(
  configDirPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, CLAUDE_CONFIG_DIR: configDirPath }
  for (const token of INHERITED_AUTH_TOKENS) {
    delete env[token]
  }
  return env
}
