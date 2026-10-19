// shared-config — stage plan-flow's STATIC, app-versioned assets (slash commands,
// resources, hook scripts, and the plan-flow CLAUDE.md core) into a user-scope
// config dir, ONCE per app version, so every project's Claude session loads them
// via `settingSources` with NO per-project copy. This is the "everything plan-flow
// owns is bundled and shared" half of shared-ide-assets (plan_shared-ide-assets_v2,
// Phase 1, Task 1.1).
//
// WHY THIS IS A PURE STAGER, and the caller chooses the dir (Task 1.2/1.3):
//   The dir we stage into MUST be the one the app's auth already selects — the
//   account's isolated CLAUDE_CONFIG_DIR when account-bound, else the default
//   user dir (~/.claude) for legacy auth. Relocating CLAUDE_CONFIG_DIR to an
//   assets-only dir drops the credentials that live in the same root (proven live:
//   "Not logged in"). So this module NEVER sets CLAUDE_CONFIG_DIR and never decides
//   the dir — it stages into whatever dir it is handed, and composes with
//   buildAccountEnv (#107). See flow/brain/decisions/shared-ide-assets-mechanism.md.
//
// WHY A MANIFEST, not "own a subdir":
//   `<configDir>/commands/` can also hold the user's OWN personal commands, and the
//   config dir root holds the account's auth files. A blind rewrite of a subdir, or
//   a recursive clean, would eat user content or credentials. So every file we write
//   is recorded in `.plan-flow-shared.json`, and a re-stage removes ONLY the files
//   the previous stage recorded — never anything else in the dir. This is the same
//   "touch only what we own" invariant the CLI's OWNED_ASSET_PATHS enforces.
//
// WHY CLAUDE.md is spliced, not copied:
//   A user may keep their own `~/.claude/CLAUDE.md`. We inject the plan-flow core
//   between `<!-- plan-flow-start -->` / `<!-- plan-flow-end -->` (the SAME markers
//   the CLI uses for the project CLAUDE.md), preserving everything outside them.
//
// Fail-soft, like ensureCliShim: any fs error is logged once and returned as
// { ok: false } — a failed stage must never throw, never partially-apply silently,
// and never leave a session with zero commands. Content-gated on `version`: an
// unchanged version re-stages nothing.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { dirname, join, relative } from 'path'

/** Splice markers — identical to the CLI's project-CLAUDE.md markers (claude.ts). */
const MARKER_START = '<!-- plan-flow-start -->'
const MARKER_END = '<!-- plan-flow-end -->'

/** The manifest recording exactly which files this module wrote, so a re-stage
 *  cleans only plan-flow-owned files and never touches user content or auth. */
const MANIFEST_NAME = '.plan-flow-shared.json'

/** The bundle-side source of the static assets to stage. All optional so a caller
 *  (or a test) can stage a subset; a missing/absent dir is skipped, not an error. */
export interface SharedAssetSource {
  /** `<bundle>/.claude/commands` — copied to `<configDir>/commands`. */
  commandsDir?: string
  /** `<bundle>/.claude/resources` — copied to `<configDir>/resources` (for the CLI's
   *  state-query reader; the SDK itself does not load resources). */
  resourcesDir?: string
  /** `<bundle>/scripts/hooks` — copied to `<configDir>/hooks`. */
  hookScriptsDir?: string
  /** The plan-flow CLAUDE.md core text spliced into `<configDir>/CLAUDE.md`. */
  claudeMdBody?: string
}

export interface SharedConfigResult {
  ok: boolean
  /** Action taken, for the caller's log/telemetry. */
  action: 'staged' | 'unchanged' | 'failed'
  /** Files written this run (relative to configDir), empty when unchanged/failed. */
  written: string[]
  error?: string
}

interface Manifest {
  version: string
  files: string[]
}

function readManifest(configDir: string): Manifest | null {
  const path = join(configDir, MANIFEST_NAME)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Manifest).version === 'string' &&
      Array.isArray((parsed as Manifest).files)
    ) {
      return parsed as Manifest
    }
  } catch {
    // A corrupt manifest is treated as "not staged" — we re-stage rather than trust it.
  }
  return null
}

/** Every real file under `dir` (absolute paths). Uses `lstat` so a symlinked
 *  subdirectory is treated as a leaf, never followed — no redundant walks, no
 *  cycles (review Finding 4). */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (lstatSync(full).isDirectory()) walk(full)
      else out.push(full)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/**
 * Copy `srcDir` into `<configDir>/<destSub>`, recording each written file
 * (relative to configDir) in `written`. Absent `srcDir` is a no-op.
 *
 * The manifest is built from the SOURCE files, NOT by scanning the destination:
 * a user may keep their own files in the same shared dest dir (e.g. a personal
 * `commands/my-own.md`), and recording the destination would capture those into
 * the manifest and delete them on the next re-stage (review Finding 1 — user
 * data loss). Recording only what we copied keeps the "touch only what we own"
 * invariant intact.
 */
function stageDir(
  srcDir: string | undefined,
  configDir: string,
  destSub: string,
  written: string[],
): void {
  if (!srcDir || !existsSync(srcDir)) return
  const destRoot = join(configDir, destSub)
  cpSync(srcDir, destRoot, { recursive: true })
  for (const absSrc of filesUnder(srcDir)) {
    written.push(join(destSub, relative(srcDir, absSrc)))
  }
}

/** Remove now-empty managed directories left behind after a prior-file cleanup
 *  (review Finding 3). Only ever removes EMPTY dirs, so a dir still holding a
 *  user's own file is never touched. Best-effort. */
function pruneEmptyDirs(configDir: string, relFiles: string[]): void {
  const dirs = new Set<string>()
  for (const f of relFiles) {
    let d = dirname(f)
    while (d && d !== '.' && d !== '/') {
      dirs.add(d)
      d = dirname(d)
    }
  }
  // Deepest first, so a parent can empty out after its children are pruned.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    const abs = join(configDir, d)
    try {
      if (existsSync(abs) && readdirSync(abs).length === 0) {
        rmSync(abs, { recursive: true, force: true })
      }
    } catch {
      // best-effort — a non-empty or vanished dir is fine to leave
    }
  }
}

/**
 * Replace (or insert) the plan-flow section of a CLAUDE.md body, preserving
 * everything outside the marker pair. A body with no markers gets the section
 * appended; a body with them has only the enclosed region rewritten.
 */
export function splicePlanFlowSection(existing: string, body: string): string {
  const section = `${MARKER_START}\n${body}\n${MARKER_END}`
  const start = existing.indexOf(MARKER_START)
  const end = existing.indexOf(MARKER_END)
  if (start !== -1 && end !== -1 && end > start) {
    const before = existing.slice(0, start)
    const after = existing.slice(end + MARKER_END.length)
    return `${before}${section}${after}`
  }
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  return `${existing}${sep}${section}\n`
}

/**
 * Stage the shared assets into `configDir`, once per `version`. Idempotent and
 * content-gated: an unchanged version with its recorded files intact re-stages
 * nothing. Fail-soft: never throws; a failure returns `{ ok: false }`.
 *
 * The caller supplies `configDir` (the app's effective config dir — see the header)
 * and must NOT rely on this to set CLAUDE_CONFIG_DIR.
 */
export function ensureSharedConfig(
  configDir: string,
  source: SharedAssetSource,
  version: string,
): SharedConfigResult {
  try {
    const prior = readManifest(configDir)
    const claudeMdPath = join(configDir, 'CLAUDE.md')
    const claudeMdCurrent = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf8') : ''
    const claudeMdWanted =
      source.claudeMdBody !== undefined
        ? splicePlanFlowSection(claudeMdCurrent, source.claudeMdBody)
        : claudeMdCurrent

    // Content gate: same version, every recorded file still present, and the
    // CLAUDE.md section already up to date → nothing to do.
    if (
      prior !== null &&
      prior.version === version &&
      prior.files.every((f) => existsSync(join(configDir, f))) &&
      claudeMdWanted === claudeMdCurrent
    ) {
      return { ok: true, action: 'unchanged', written: [] }
    }

    // Remove ONLY what a previous stage recorded — never user content or auth.
    if (prior !== null) {
      for (const f of prior.files) rmSync(join(configDir, f), { force: true })
      pruneEmptyDirs(configDir, prior.files)
    }

    mkdirSync(configDir, { recursive: true })
    const written: string[] = []
    stageDir(source.commandsDir, configDir, 'commands', written)
    stageDir(source.resourcesDir, configDir, 'resources', written)
    stageDir(source.hookScriptsDir, configDir, 'hooks', written)

    if (source.claudeMdBody !== undefined && claudeMdWanted !== claudeMdCurrent) {
      mkdirSync(dirname(claudeMdPath), { recursive: true })
      writeFileSync(claudeMdPath, claudeMdWanted, 'utf8')
      // CLAUDE.md is NOT in `files` — it is spliced (shared with the user's own
      // content), so a future re-stage rewrites its section rather than deleting it.
    }

    const manifest: Manifest = { version, files: written }
    writeFileSync(join(configDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8')

    return { ok: true, action: 'staged', written }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[shared-config] Failed to stage shared assets into ${configDir}: ${message}`)
    return { ok: false, action: 'failed', written: [], error: message }
  }
}
