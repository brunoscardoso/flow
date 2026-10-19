// Read a project's configured runtime provider (multi_runtime_support).
//
// The one key the app needs from a project's `flow/.flowconfig`: `provider`.
// The app does not import the CLI's flowconfig parser, so this mirrors that
// parser's `extractString` for this single key — same line grammar (a value on
// the same line as the key, trimmed), fail-soft to null when the file or key is
// absent or unreadable. `flow/` is normally a symlink; reading through it
// resolves to the real config.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** The `provider:` value from a project's flow/.flowconfig, or null when there
 *  is no readable override (→ the caller's default provider). */
export function readProjectProvider(projectRoot: string): string | null {
  const configPath = join(projectRoot, 'flow', '.flowconfig')
  if (!existsSync(configPath)) return null
  let content: string
  try {
    content = readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }
  // Same-line value only ([ \t]) so a following line cannot leak in via \s.
  const match = content.match(/^provider:[ \t]*(.+)$/m)
  if (!match) return null
  const value = match[1].trim()
  return value.length > 0 ? value : null
}

/** Which provider a project resolves to, and which rung answered. */
export interface ProjectProviderChoice {
  provider: string
  source: 'project' | 'default' | 'builtin'
}

/**
 * The `settings:getProjectProvider` precedence, in one pure code path so the
 * handler and its test share it (allowed-pattern #14):
 *   - a project override that is present AND known → source 'project'
 *   - else the app-wide default when it is non-null → source 'default'
 *   - else the built-in 'claude' → source 'builtin'
 *
 * `source` comes from WHICH level answered — key presence, never a value
 * comparison — so a project that merely inherits never reads as pinned.
 * Fail-closed: an UNKNOWN project override is skipped (as the resolver would
 * throw on it) rather than reported as a pinned provider.
 */
export function resolveProjectProviderChoice(
  projectProvider: string | null,
  defaultProvider: string | null,
  isKnown: (provider: string) => boolean,
): ProjectProviderChoice {
  if (projectProvider !== null && isKnown(projectProvider)) {
    return { provider: projectProvider, source: 'project' }
  }
  if (defaultProvider !== null) return { provider: defaultProvider, source: 'default' }
  return { provider: 'claude', source: 'builtin' }
}
