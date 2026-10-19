/**
 * Renamed `.flowconfig` keys — the CLI's copy of the alias table.
 *
 * The thread-worktree settings were once called `workspace_*`; they are now
 * `worktree_*`, so "workspace" is free for a different meaning. People's
 * config files still say the old names, and nobody's file is rewritten behind
 * their back, so:
 *
 *   - READ: the new key, falling back to the old one when the new key is
 *     absent. Old keys are read FOREVER. While both are written, the OLD key wins when both are present (an older build writes only it).
 *   - WRITE: both keys with the same value, and only when a person changes
 *     that setting — older Flow builds and CLIs read only the old key and
 *     share the project (user, 2026-10-06). `flow unset` removes both.
 *     TRANSITIONAL: once no build older than the rename is in use, writes go
 *     back to the new key alone.
 *
 * MIRRORED, NOT IMPORTED. The table lives in
 * `app/src/shared/worktree-config-aliases.json`, which the app reads; the CLI
 * cannot import across the package boundary (`rootDir` is `src/`), so this is
 * a copy pinned to that file by a parity test (`flowconfig-aliases.test.ts`).
 * Change the JSON and this table together, never one side.
 */

/** New key → the old key it replaced. */
export const FLOWCONFIG_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  worktree_start: 'workspace_start',
  worktree_cap: 'workspace_cap',
  worktree_setup: 'workspace_setup',
  worktree_setup_timeout_ms: 'workspace_setup_timeout_ms',
});

/** Old key → new key, derived so the two directions cannot disagree. */
const CANONICAL_BY_LEGACY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(FLOWCONFIG_KEY_ALIASES).map(([current, legacy]) => [legacy, current])),
);

/** The old name of a renamed key, or undefined when the key was never renamed. */
export function legacyKeyOf(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(FLOWCONFIG_KEY_ALIASES, key)
    ? FLOWCONFIG_KEY_ALIASES[key]
    : undefined;
}

/** The current name for `key` — the new name when `key` is an old one, else `key` itself. */
export function canonicalFlowconfigKey(key: string): string {
  return Object.prototype.hasOwnProperty.call(CANONICAL_BY_LEGACY, key) ? CANONICAL_BY_LEGACY[key] : key;
}

/**
 * Read a key that may have been renamed: `read(newKey)`, or — when that reads
 * as absent — `read(oldKey)`. Whatever `read` treats as absent (a missing key,
 * a blank value) falls through to the old name, exactly as a missing key would.
 */
export function readAliasedKey<T>(key: string, read: (name: string) => T | undefined): T | undefined {
  // The old spelling wins while both are written: this CLI writes both names
  // with the same value, and a build older than the rename writes only the old
  // one — so the old key is always current (mirrors the app's readAliasedKey).
  const legacy = legacyKeyOf(key);
  const old = legacy === undefined ? undefined : read(legacy);
  return old !== undefined ? old : read(key);
}
