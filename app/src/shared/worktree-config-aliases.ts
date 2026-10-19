// worktree-config-aliases — the app's reader of THE one table of renamed
// `.flowconfig` keys (`worktree-config-aliases.json`).
//
// The thread-worktree settings were once called `workspace_*` and are now
// `worktree_*`. People's files still say the old names, and nobody's file is
// rewritten behind their back, so every app reader and writer follows the same
// three rules the CLI follows (`src/cli/state/flowconfig-aliases.ts`):
//
//   - READ the new key, falling back to the old one when the new key is absent.
//     Old keys are read FOREVER; while both are written, the OLD one wins when both are present.
//   - WRITE both spellings with the same value, and only when a person changes
//     that setting. Older Flow builds (and older CLIs) read only the old key,
//     and they share projects with today's build (user, 2026-10-06), so a
//     change made here must reach them too.
//   - UNSET removes both spellings, so neither reader sees a stale value.
//
// The dual-write is TRANSITIONAL: once no build older than the rename is in
// use, writes go back to the new key alone (dropping the old one).
//
// The JSON is imported, not copied: the app and the CLI's parity test both
// load the same file, so a rename added there reaches every reader at once.

import table from './worktree-config-aliases.json'

/** New key → the old key it replaced. */
export const FLOWCONFIG_KEY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ...table.aliases,
})

/** Old key → new key, derived so the two directions cannot disagree. */
const CANONICAL_BY_LEGACY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(FLOWCONFIG_KEY_ALIASES).map(([current, legacy]) => [legacy, current]),
  ),
)

/** The old name of a renamed key, or undefined when the key was never renamed. */
export function legacyFlowconfigKeyOf(key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(FLOWCONFIG_KEY_ALIASES, key)
    ? FLOWCONFIG_KEY_ALIASES[key]
    : undefined
}

/** The current name for `key` — the new name when `key` is an old one, else `key` itself. */
export function canonicalFlowconfigKey(key: string): string {
  return Object.prototype.hasOwnProperty.call(CANONICAL_BY_LEGACY, key)
    ? CANONICAL_BY_LEGACY[key]
    : key
}

/**
 * The value `raw` holds for `key`: the new spelling when it is present, else
 * the old one. A key with no old spelling reads exactly as it always did.
 */
export function readAliasedKey(raw: Record<string, string>, key: string): string | undefined {
  // THE OLD SPELLING WINS while both are written. This build writes both names
  // with the same value; a build older than the rename writes only the old one.
  // Preferring the old name is therefore always current — preferring the new
  // one would hide every change the older build makes to a shared project.
  // A blank old key reads as absent, like a missing one (the resolver's rule).
  const legacy = legacyFlowconfigKeyOf(key)
  if (legacy !== undefined && (raw[legacy] ?? '').trim() !== '') return raw[legacy]
  return Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : undefined
}

/**
 * Expand a write so every renamed setting it touches lands under BOTH names
 * with the same value (a `null` removes both). Keys the write does not name are
 * left alone — a setting nobody changed keeps whatever spelling its file uses.
 * Transitional dual-write: see the header.
 */
export function withAliasedWrites(
  updates: Record<string, string | null>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(updates)) {
    const current = canonicalFlowconfigKey(key)
    out[current] = value
    const legacy = legacyFlowconfigKeyOf(current)
    if (legacy !== undefined) out[legacy] = value
  }
  return out
}
