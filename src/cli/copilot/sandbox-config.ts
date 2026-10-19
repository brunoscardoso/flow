// Copilot local-sandbox compatibility (#1928).
//
// plan-flow makes `flow/` a symlink to the Obsidian vault
// (`~/plan-flow/brain/projects/<name>/flow`), whose realpath is OUTSIDE the
// project root. GitHub Copilot's local sandbox resolves symlinks to their
// realpath and denies writes to out-of-tree targets, so every plan-flow skill
// that writes into `flow/` fails with "outside the sandbox, all writes were
// denied". plan-flow's own agent path allows the symlink lexically
// (`app/src/main/agent/path-containment.ts`); Copilot needs the resolved target
// on its read-write allowlist.
//
// This module is the single code path (allowed-pattern #14) that resolves the
// vault target and merges it into the user-owned `~/.copilot/settings.json`
// sandbox policy — additive, idempotent, non-mutating, fail-soft. `initShared`
// calls `ensureCopilotSandboxAccess` after the symlink is created.
//
// The exact settings key lives in ONE constant (`COPILOT_WRITABLE_PATHS_KEY`)
// so a correction is a one-line change — see flow/references/copilot-sandbox-config.md.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/**
 * The single source-of-truth dotted key into `settings.json` for the sandbox
 * read-write path allowlist. Confirmed as `sandbox.userPolicy.readwritePaths`
 * (the allow sibling of the GitHub-docs-confirmed `sandbox.userPolicy.deniedPaths`,
 * a bare `string[]`). If a Copilot acceptance test shows it ineffective, switch
 * this to `sandbox.filesystem.readwritePaths` (the documented alternate) — that
 * is the ONLY line that needs to change. See
 * `flow/references/copilot-sandbox-config.md`.
 */
export const COPILOT_WRITABLE_PATHS_KEY = 'sandbox.userPolicy.readwritePaths';

/** Minimal JSON object shape for the Copilot settings file. */
export type JsonObject = Record<string, unknown>;

/** Env slice we read — `COPILOT_HOME` overrides the config dir (like plan-flow's
 *  own `PLAN_FLOW_VAULT_DIR` in `src/cli/utils/files.ts`). */
export type CopilotEnv = Record<string, string | undefined>;

/** The Copilot CLI config directory: `$COPILOT_HOME` or `~/.copilot`. */
export function copilotHome(env: CopilotEnv = process.env): string {
  const override = env.COPILOT_HOME;
  return override && override.length > 0 ? override : join(homedir(), '.copilot');
}

/** Absolute path to the user-owned `settings.json` we merge into. */
export function copilotSettingsPath(env: CopilotEnv = process.env): string {
  return join(copilotHome(env), 'settings.json');
}

/** True when `child` equals `parent` or is lexically nested inside it — an
 *  ancestor entry on the allowlist already covers `child`. */
export function pathIsCoveredBy(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

/**
 * The vault write target to grant, or `null` when there is nothing to grant:
 * `flow/` is missing, is a real directory (no sandbox problem), or its realpath
 * already resolves inside `projectRoot`. Returns the resolved (realpath) target
 * because Copilot keys its policy on the resolved symlink target.
 */
export function resolveVaultWritableTarget(projectRoot: string): string | null {
  const flow = join(projectRoot, 'flow');
  try {
    if (!lstatSync(flow).isSymbolicLink()) return null; // real dir / missing → Copilot can already write it
  } catch {
    return null; // no flow/ yet
  }

  let real: string;
  try {
    real = realpathSync(flow);
  } catch {
    return null; // dangling symlink → nothing coherent to grant
  }

  // Compare realpath-to-realpath so a symlinked root (e.g. macOS /var/folders →
  // /private/var/folders) doesn't spuriously read as "outside".
  let root: string;
  try {
    root = realpathSync(projectRoot);
  } catch {
    root = resolve(projectRoot);
  }
  if (real === root || real.startsWith(root + sep)) return null; // inside root → fine
  return real;
}

/**
 * Return a deep-cloned settings object with `target` ensured present in the
 * `string[]` at `key`. Additive, idempotent (coverage-aware — an existing self
 * or ancestor entry means no change), non-mutating (the input is never touched,
 * forbidden-pattern #4), and every other key is preserved. Intermediate objects
 * along the dotted key are created as needed.
 */
export function mergeWritablePath(
  settings: JsonObject,
  target: string,
  key: string = COPILOT_WRITABLE_PATHS_KEY,
): { changed: boolean; settings: JsonObject } {
  // JSON deep-clone — the config is pure JSON, so this never mutates the input.
  const clone = JSON.parse(JSON.stringify(settings ?? {})) as JsonObject;

  const parts = key.split('.');
  const leaf = parts.pop() as string;

  let node: JsonObject = clone;
  for (const part of parts) {
    const next = node[part];
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      node = next as JsonObject;
    } else {
      node = node[part] = {} as JsonObject;
    }
  }

  const existing = Array.isArray(node[leaf])
    ? (node[leaf] as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  const normalized = resolve(target);
  const covered = existing.some((entry) => pathIsCoveredBy(entry, normalized));
  if (covered) return { changed: false, settings: clone };

  node[leaf] = [...existing, normalized];
  return { changed: true, settings: clone };
}

// ── Orchestration (fail-soft I/O) ────────────────────────────────────────────

/** Minimal logger surface (a subset of `src/cli/utils/logger.ts`). */
export interface SandboxLogger {
  success(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
}

export interface EnsureDeps {
  env?: CopilotEnv;
  platform?: NodeJS.Platform;
  logger?: SandboxLogger;
}

export type EnsureStatus =
  | 'granted' // appended the target to the allowlist
  | 'already-allowed' // target (or an ancestor) was already present
  | 'no-copilot' // ~/.copilot absent → silent no-op
  | 'not-symlinked' // flow/ is a real dir / missing → nothing to grant
  | 'skipped-windows' // sandbox can't allow per-path on Windows
  | 'error'; // read/parse/write failed → single notice, init continues

export interface EnsureResult {
  status: EnsureStatus;
  target?: string;
}

/**
 * Ensure a Copilot session can write into this project's `flow/` (symlinked to
 * the vault). Detect Copilot by config-dir existence, resolve the vault target,
 * and merge it into `~/.copilot/settings.json` idempotently with an atomic
 * write. NEVER throws — every failure degrades to at most one notice and a
 * non-`granted` status so init/provisioning is never blocked (discovery
 * FR-6/NFR-5). Safe to call on every init/provisioning pass (self-healing if
 * Copilot rewrote its config).
 */
export function ensureCopilotSandboxAccess(
  projectRoot: string,
  deps: EnsureDeps = {},
): EnsureResult {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const logger = deps.logger;

  try {
    if (platform === 'win32') {
      logger?.warn(
        'Copilot sandbox cannot allow per-path on Windows; skipping flow/ grant',
      );
      return { status: 'skipped-windows' };
    }

    const home = copilotHome(env);
    if (!existsSync(home)) {
      return { status: 'no-copilot' }; // common case — stay silent
    }

    const target = resolveVaultWritableTarget(projectRoot);
    if (!target) return { status: 'not-symlinked' };

    const settingsPath = copilotSettingsPath(env);
    let settings: JsonObject = {};
    if (existsSync(settingsPath)) {
      try {
        const raw = readFileSync(settingsPath, 'utf-8');
        settings = raw.trim() ? (JSON.parse(raw) as JsonObject) : {};
      } catch {
        logger?.warn(
          'Copilot settings.json is unreadable/malformed; leaving it untouched (flow/ grant skipped)',
        );
        return { status: 'error' };
      }
    }

    const { changed, settings: merged } = mergeWritablePath(settings, target);
    if (!changed) return { status: 'already-allowed', target };

    writeSettingsAtomic(settingsPath, home, merged);
    logger?.success(`Copilot sandbox: allowed flow/ target for writes → ${target}`);
    return { status: 'granted', target };
  } catch (err) {
    logger?.warn(`Copilot sandbox grant skipped (${(err as Error).message})`);
    return { status: 'error' };
  }
}

/** Write `settings` to `settingsPath` via a same-dir tmp file + rename, so the
 *  user's global config is never left partially written. */
function writeSettingsAtomic(settingsPath: string, home: string, settings: JsonObject): void {
  const tmp = join(home, `.settings.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  renameSync(tmp, settingsPath);
}
