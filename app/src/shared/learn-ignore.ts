// Learning ignore list (#learn-ignore) — ONE pure matcher shared by the main
// process (learn orchestrator + staleness triggers) and the renderer (learning
// panel counts), so "is this module scaffolding?" has a single definition
// (allowed-pattern #14). Ignores apply only to AUTOMATIC learning — Learn all /
// T1 onboarding and the staleness watcher — and to the panel's honest counts.
// A MANUAL per-module Learn is a deliberate override and stays allowed, the
// same philosophy as the T3 auto re-learn gates.

/** Path segments that read as test/build scaffolding. A module path with ANY
 *  posix segment in this set (case-insensitive) is ignored by default —
 *  matching is per-segment, so `src/test-utils` is NOT ignored (its segment is
 *  `test-utils`, not `test`). */
export const DEFAULT_LEARN_IGNORE_SEGMENTS: readonly string[] = [
  // FLOW'S OWN DIRECTORY IS NOT THE PROJECT. `flow/` holds plan-flow's plans,
  // discovery docs, brain and resources — reading them teaches an agent about
  // plan-flow, not about the app it was pointed at. It was in a real queue,
  // being learned first, while 356 of the user's own modules waited behind it.
  'flow',
  '__mocks__',
  '__tests__',
  '__fixtures__',
  'e2e',
  'test',
  'tests',
  'spec',
  'specs',
  'fixtures',
  'mocks',
  'coverage',
  'snapshots',
  '__snapshots__',
]

const DEFAULT_SEGMENT_SET = new Set(DEFAULT_LEARN_IGNORE_SEGMENTS)

/** Parse the flowconfig `learn_ignore` value — comma-separated patterns,
 *  trimmed, empties dropped. Absent/empty → []. */
export function parseLearnIgnore(configValue: string | undefined): string[] {
  if (configValue === undefined) return []
  return configValue
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
}

/** Posix-normalize + lowercase a path/pattern so matching is separator- and
 *  case-insensitive. Trailing slashes are stripped (`vendor/` ≡ `vendor`). */
function normalize(path: string): string {
  return path.split('\\').join('/').replace(/\/+$/, '').toLowerCase()
}

/** True when a single (normalized) extra pattern matches a (normalized) path —
 *  the extras half of the matcher, shared by ignoreSource/removeIgnorePattern
 *  so "which extra causes this ignore?" has one definition. */
function matchesExtra(path: string, pattern: string): boolean {
  if (pattern.length === 0) return false
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2)
    return prefix.length > 0 && path.startsWith(`${prefix}/`)
  }
  return path === pattern || path.startsWith(`${pattern}/`)
}

/** True when the built-in defaults (scaffolding segments + dot-dirs) ignore a
 *  (normalized) path. */
function matchesDefaults(path: string): boolean {
  return path
    .split('/')
    .some((segment) => DEFAULT_SEGMENT_SET.has(segment) || segment.startsWith('.'))
}

/**
 * WHY a module path is learning-ignored — the panel's per-row actions hang off
 * this distinction:
 *  - `'default'` — a built-in rule (scaffolding segment or dot-dir) ignores it;
 *    defaults are not configurable per-module, so no Unignore is offered
 *  - `'extra'`  — only the `learn_ignore` extras ignore it (removable)
 *  - `null`     — not ignored at all
 * Defaults win: a module both default- and extra-ignored reports 'default'
 * (removing the extra would not un-ignore it).
 */
export function ignoreSource(
  modulePath: string,
  extras: readonly string[] = [],
): 'default' | 'extra' | null {
  const path = normalize(modulePath)
  if (path.length === 0) return null
  if (matchesDefaults(path)) return 'default'
  for (const raw of extras) {
    if (matchesExtra(path, normalize(raw))) return 'extra'
  }
  return null
}

/**
 * True when a module path is learning-ignored. Glob-lite by design — four
 * rules only, no general globbing:
 *  - ANY posix path segment (case-insensitive) is in
 *    DEFAULT_LEARN_IGNORE_SEGMENTS (`__mocks__/@apollo`, `e2e/tests/admin`), OR
 *  - ANY posix path segment starts with `.` (dot-dirs are tool scaffolding —
 *    `.cursor`, `.github`, `src/.hidden` — they never tell the project's
 *    story), OR
 *  - the path equals / lives under an extra pattern (`vendor` matches `vendor`
 *    and `vendor/sdk`), OR
 *  - an extra pattern with a trailing `/*` prefix-matches (`vendor/*` matches
 *    `vendor/sdk` but not `vendor` itself).
 * Extras can only ADD ignores — they can never un-ignore a default (kept
 * deliberately simple; a manual per-module Learn is the override).
 */
export function isIgnoredModule(modulePath: string, extra: readonly string[] = []): boolean {
  return ignoreSource(modulePath, extra) !== null
}

/**
 * Add a module path to the extras (the panel's per-row Ignore action). Returns
 * a NEW array — extras are never mutated. Dedup is by MATCH, not string
 * equality: a module already ignored by an existing extra (exact, prefix, or
 * `/*`) is not re-added, so the CSV never accumulates redundant entries.
 * Default-ignored modules never show the Ignore action, so defaults are not
 * consulted here.
 */
export function addIgnorePattern(extras: readonly string[], module: string): string[] {
  const entry = module.trim()
  const path = normalize(entry)
  if (path.length === 0) return [...extras]
  const covered = extras.some((raw) => matchesExtra(path, normalize(raw)))
  return covered ? [...extras] : [...extras, entry]
}

/**
 * Remove from the extras every pattern that (alone) ignores the module — the
 * panel's per-row Unignore action. Match-based, not string-equality, so a row
 * ignored via a prefix pattern (`vendor` covering `vendor/sdk`) actually flips
 * back to counted; built-in defaults are untouched (they are not extras).
 * Returns a NEW array.
 */
export function removeIgnorePattern(extras: readonly string[], module: string): string[] {
  const path = normalize(module)
  if (path.length === 0) return [...extras]
  return extras.filter((raw) => !matchesExtra(path, normalize(raw)))
}
