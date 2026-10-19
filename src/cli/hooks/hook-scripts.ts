/**
 * THE hook-script manifest — one list, two consumers.
 *
 * `scripts/hooks/` ships a fixed set of Claude Code hook scripts, and two
 * independent code paths copy them into a project's `.claude/hooks/`:
 *
 *   • install  — `installHooks` in `src/cli/handlers/claude.ts`
 *   • refresh  — the `.claude/hooks` group of `OWNED_ASSET_PATHS`
 *                in `src/cli/commands/init-refresh.ts`
 *
 * Each used to carry its own hard-coded copy of the same five filenames. They
 * were byte-identical, which is exactly what made the fork dangerous: a hook
 * added to the install path would have been silently absent from every refresh,
 * and nothing about either list would have looked wrong. `init-refresh.ts`
 * already described its manifest as mirroring "exactly what the claude handler
 * writes" — this is that sentence turned into code (allowed-pattern #14).
 *
 * ADDING A HOOK: drop the `.cjs` into `scripts/hooks/`, add its name here, and
 * register it in `.claude/settings.json` via the claude handler. The co-located
 * test refuses a `scripts/hooks/` that this list does not describe exactly, in
 * both directions — a shipped-but-unlisted hook reaches no project, and a
 * listed-but-missing one is a copy that silently does nothing.
 */
export const HOOK_SCRIPTS: readonly string[] = Object.freeze([
  'cost-tracker.cjs',
  'cost-display.cjs',
  'suggest-compact.cjs',
  'pre-compact-save.cjs',
  'session-summary.cjs',
]);
