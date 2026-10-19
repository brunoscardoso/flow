/**
 * Heartbeat daemon version sidecar
 *
 * The pid file (`flow/.heartbeat.pid`) is a bare integer read by every
 * plan-flow version ever shipped, so its format cannot change. The running
 * daemon's version therefore lives in a **sidecar** file written beside it
 * (`flow/.heartbeat.version`), which older daemons simply never write.
 *
 * That gives the migration for free: a daemon started before this feature has
 * no sidecar, which reads as DRIFTED — so it is restarted exactly once by the
 * next `planflow-ai init` and versioned from then on.
 *
 * Every function here is fail-soft. The sidecar is a hint used to decide
 * whether to restart a daemon; a filesystem failure must never fail an install.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageRoot } from '../utils/files.js';

/** Filename of the sidecar, written beside `.heartbeat.pid` in `flow/`. */
export const VERSION_SIDECAR_FILENAME = '.heartbeat.version';

/**
 * Version label used when the installed version cannot be determined.
 * Both the writer (daemon) and the reader (init) resolve the version through
 * `readInstalledVersion()`, so an unreadable package degrades to "no drift"
 * rather than to a restart loop.
 */
export const UNKNOWN_VERSION = 'unknown';

/** Absolute path of the version sidecar for a project target. */
export function getVersionSidecarPath(target: string): string {
  return join(target, 'flow', VERSION_SIDECAR_FILENAME);
}

/**
 * The installed CLI's version, read from the package that `--version` reads.
 * Never a hardcoded literal — the whole point is that an upgraded package
 * reports a different version than the daemon that is still running.
 */
export function readInstalledVersion(): string {
  try {
    const pkgPath = join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    return version || UNKNOWN_VERSION;
  } catch {
    // Sanctioned fail-soft: an unreadable package means "we cannot tell",
    // which must degrade to leaving the running daemon alone.
    return UNKNOWN_VERSION;
  }
}

/**
 * Record the version of the daemon that is booting.
 * Called by the daemon on the same path that writes the pid file.
 */
export function writeVersionSidecar(target: string, version: string): void {
  try {
    writeFileSync(getVersionSidecarPath(target), version, 'utf-8');
  } catch {
    // Sanctioned fail-soft: an unwritable sidecar reads as drifted later,
    // costing at most one extra restart — never a failed daemon boot.
  }
}

/**
 * Read the version recorded by the running daemon.
 * Returns null when the sidecar is absent, unreadable, or empty — all of which
 * the caller must treat as DRIFTED, never as "current".
 */
export function readVersionSidecar(target: string): string | null {
  const sidecarPath = getVersionSidecarPath(target);
  if (!existsSync(sidecarPath)) return null;

  try {
    const version = readFileSync(sidecarPath, 'utf-8').trim();
    return version || null;
  } catch {
    // Sanctioned fail-soft: unreadable is indistinguishable from absent.
    return null;
  }
}

/**
 * Remove the sidecar. MUST be called wherever the pid file is removed — a
 * stale sidecar next to no pid would otherwise describe a daemon that is gone.
 */
export function removeVersionSidecar(target: string): void {
  try {
    const sidecarPath = getVersionSidecarPath(target);
    if (existsSync(sidecarPath)) unlinkSync(sidecarPath);
  } catch {
    // Sanctioned fail-soft: a leftover sidecar is only ever read alongside a
    // live pid, and is re-written on the next daemon boot.
  }
}

/** Version drift verdict for a running daemon. */
export interface VersionDrift {
  /** True unless the sidecar records exactly the installed version. */
  drifted: boolean;
  /** Version the running daemon recorded, or null when unknown/absent. */
  running: string | null;
  /** Version of the CLI that is asking. */
  installed: string;
}

/**
 * Compare the running daemon's recorded version against the installed one.
 *
 * Drifted covers: no sidecar, unreadable sidecar, and a different version.
 * Only an exact match is current.
 */
export function checkVersionDrift(target: string, installed: string): VersionDrift {
  const running = readVersionSidecar(target);
  return { drifted: running !== installed, running, installed };
}

/** Human label for a possibly-unknown running version, used in notices. */
export function versionLabel(version: string | null): string {
  return version ?? UNKNOWN_VERSION;
}
