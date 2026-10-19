/**
 * `init --refresh-owned` — guarded refresh of plan-flow-OWNED assets.
 *
 * The Flow IDE auto-refreshes a stale project's plan-flow assets on open. The
 * BINDING constraint (NFR3) is that a refresh may rewrite plan-flow-OWNED
 * assets ONLY. It must never rewrite:
 *   - `.claude/rules/**`   (accumulated user pattern data)
 *   - `flow/` content       (vault-linked user knowledge)
 *   - existing `.flowconfig` KEYS (additive keys only)
 *
 * The boundary lives in CODE, not prompt convention (allowed-pattern #14):
 * `OWNED_ASSET_PATHS` is the single source of truth for what may be rewritten,
 * and `assertOwnedBoundary()` hard-refuses any manifest entry that targets a
 * protected path.
 */

import { join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  getPackageRoot,
  copyDir,
  copyFile,
  ensureDir,
} from '../utils/files.js';
import * as log from '../utils/logger.js';
import { HOOK_SCRIPTS } from '../hooks/hook-scripts.js';
import { isPlanFlowSourceRepo, planFlowSection, replacePlanFlowSection } from '../handlers/claude.js';
import { seedLoopDirectives } from '../loop/directive-templates.js';
import type { CopyResult } from '../types.js';

/** A plan-flow-owned asset group that `init --refresh-owned` may rewrite. */
export interface OwnedAssetGroup {
  /** Human-readable label (also the display path). */
  readonly label: string;
  /** Source path, relative to the CLI's co-located package root. */
  readonly src: string;
  /** Destination path, relative to the target project root. */
  readonly dest: string;
  /**
   * Optional explicit file list (relative to `src`). When present, only these
   * files are copied — used for `.claude/hooks`, where the claude handler ships
   * a fixed set of scripts rather than a whole directory.
   */
  readonly files?: readonly string[];
}

/**
 * Frozen manifest of plan-flow-OWNED path groups — mirrors exactly what the
 * claude handler writes, MINUS `.claude/rules/` (excluded on purpose: user
 * pattern data) and minus additively-merged files (`.claude/settings.json`,
 * `CLAUDE.md`, `flow/.flowconfig`), which a blind rewrite would corrupt.
 */
export const OWNED_ASSET_PATHS: readonly OwnedAssetGroup[] = Object.freeze([
  Object.freeze({
    label: '.claude/commands',
    src: '.claude/commands',
    dest: '.claude/commands',
  }),
  Object.freeze({
    label: '.claude/resources',
    src: '.claude/resources',
    dest: '.claude/resources',
  }),
  Object.freeze({
    label: '.claude/hooks',
    src: 'scripts/hooks',
    dest: '.claude/hooks',
    // THE SAME LIST THE INSTALL PATH COPIES, by reference — this used to be a
    // second hard-coded copy of it, byte-identical and therefore invisible when
    // it drifted. See src/cli/hooks/hook-scripts.ts.
    files: HOOK_SCRIPTS,
  }),
]) as readonly OwnedAssetGroup[];

/** Structured outcome — returned for callers and tests; no process.exit(). */
export interface RefreshResult {
  /** True when the refresh refused to run (no existing install). */
  refused: boolean;
  /** Populated only when `refused` is true. */
  reason?: string;
  /** Number of owned asset groups rewritten. */
  groupsUpdated: number;
  /** Aggregate copy result across all groups. */
  copy: CopyResult;
}

function emptyCopyResult(): CopyResult {
  return { created: [], skipped: [], updated: [] };
}

/**
 * A project has an existing plan-flow install when its definitive owned markers
 * are present. Refresh only ever UPDATES — it never bootstraps a fresh install.
 */
export function hasExistingInstall(target: string): boolean {
  return (
    existsSync(join(target, '.claude', 'commands')) ||
    existsSync(join(target, '.claude', 'resources'))
  );
}

/**
 * Code-level enforcement of the NFR3 boundary (allowed-pattern #14): no owned
 * group may ever target `.claude/rules/**` or `flow/**`. A violation is a
 * programming error, so it throws — the manifest can never silently drift into
 * clobbering protected user data.
 */
function assertOwnedBoundary(): void {
  for (const group of OWNED_ASSET_PATHS) {
    const dest = group.dest.replace(/\\/g, '/').replace(/\/+$/, '');
    const protectedPrefixes = ['.claude/rules', 'flow'];
    for (const prefix of protectedPrefixes) {
      if (dest === prefix || dest.startsWith(`${prefix}/`)) {
        throw new Error(
          `OWNED_ASSET_PATHS boundary violation: group "${group.label}" targets protected path "${group.dest}"`
        );
      }
    }
  }
}

/** Copies an explicit file list from src → dest (create or overwrite). */
function copyFiles(
  srcDir: string,
  destDir: string,
  files: readonly string[]
): CopyResult {
  const result = emptyCopyResult();
  for (const file of files) {
    const src = join(srcDir, file);
    if (!existsSync(src)) continue;
    const fileResult = copyFile(src, join(destDir, file), { force: true });
    result.created.push(...fileResult.created);
    result.updated.push(...fileResult.updated);
    result.skipped.push(...fileResult.skipped);
  }
  return result;
}

/**
 * Refresh the plan-flow-owned assets in `target` from the CLI's co-located
 * package. Rewrites ONLY the `OWNED_ASSET_PATHS` groups; `.claude/rules/**`,
 * `flow/` content, and `.flowconfig` are never touched. Refuses (exit 1,
 * nothing written) when there is no existing install. Idempotent — a second
 * run rewrites byte-identical bytes and reports the same group count.
 */
export function runRefreshOwned(options: { target: string }): RefreshResult {
  const target = resolve(options.target);
  const packageRoot = getPackageRoot();

  if (!hasExistingInstall(target)) {
    const reason = 'no existing plan-flow install to refresh';
    log.error(`init refused: ${reason}`);
    process.exitCode = 1;
    return { refused: true, reason, groupsUpdated: 0, copy: emptyCopyResult() };
  }

  // NFR3 invariant — enforced in code before a single byte is written.
  assertOwnedBoundary();

  const copy = emptyCopyResult();
  let groupsUpdated = 0;

  for (const group of OWNED_ASSET_PATHS) {
    const src = join(packageRoot, group.src);
    // Source absent in this build (e.g. trimmed package) — skip, don't miscount.
    if (!existsSync(src)) continue;

    const dest = join(target, group.dest);
    ensureDir(dest);

    const groupResult = group.files
      ? copyFiles(src, dest, group.files)
      : copyDir(src, dest, { force: true });

    copy.created.push(...groupResult.created);
    copy.updated.push(...groupResult.updated);
    copy.skipped.push(...groupResult.skipped);
    groupsUpdated++;
    log.info(`Refreshed ${group.label}`);
  }

  // THE GENERATED HALF OF `CLAUDE.md`, AND ONLY THAT HALF (#1850).
  //
  // `CLAUDE.md` is excluded from `OWNED_ASSET_PATHS` above, correctly: it is an
  // additively-merged file and a blind rewrite would eat the user's own
  // instructions. But the exclusion was all-or-nothing, so a doc fix in
  // `CLAUDE.md.template` reached only projects provisioned AFTER it — while its
  // sibling half, in `.claude/commands/`, reached everyone. A two-file doc fix
  // half-landed, and the half that did not is the one spliced into
  // always-loaded instructions (that is #1849, which is what filed this).
  //
  // The marker pair exists to separate the two documents, so it is used to
  // refresh one and leave the other byte-for-byte. A file with no markers is
  // untouched — never provisioned, or the user removed them on purpose.
  //
  // …except in plan-flow's own repo, where the block is the duplicate of the
  // document above it (#1951). The install path refuses to add it; this one
  // must refuse to refill it, or an empty marker pair left behind brings the
  // whole 4,020 tokens back on the next provision.
  const claudeMd = join(target, 'CLAUDE.md');
  if (existsSync(claudeMd) && !isPlanFlowSourceRepo(target)) {
    const existing = readFileSync(claudeMd, 'utf-8');
    const updated = replacePlanFlowSection(existing, planFlowSection(packageRoot));
    if (updated !== null && updated !== existing) {
      writeFileSync(claudeMd, updated, 'utf-8');
      copy.updated.push(claudeMd);
      groupsUpdated++;
      log.info('Refreshed the plan-flow section of CLAUDE.md');
    }
  }

  // A PROJECT THAT PREDATES LOOP SEEDING NEVER GOT ANY, AND NEVER WOULD.
  //
  // The full `init` seeds `loops/` (step 11), but the IDE runs the full init
  // only for a FRESH project — one with no `.claude/commands`. Every project
  // provisioned before that step existed takes the refresh path on every open
  // instead, and refresh rewrote owned assets and nothing else. The result was
  // a permanently loop-less project: the panel said "This project has no loops
  // yet", offered no way to make one, and no amount of reopening would ever
  // change it. Verified on the reporter's machine — three provisioned projects,
  // `.claude/` and `flow/` present, no `loops/` anywhere.
  //
  // WHY THIS IS SAFE ON THE REFRESH PATH, which may only touch plan-flow-owned
  // assets: seeding is a BOOTSTRAP, not a rewrite. `seedLoopDirectives` leaves a
  // `loops/` holding anything at all completely alone, so it can only ever
  // create the directory that was missing — it cannot reach an edited mission.
  // That is a stronger guarantee than the owned-asset groups above have, which
  // is why this sits outside the manifest rather than in it: a group in
  // OWNED_ASSET_PATHS is copied with `force: true`, and loop directives are
  // hand-edited intent that must never be copied over.
  const loops = seedLoopDirectives(target);
  copy.created.push(...loops.created);
  copy.updated.push(...loops.updated);
  copy.skipped.push(...loops.skipped);

  log.success(`refresh: ${groupsUpdated} owned asset group(s) updated`);
  return { refused: false, groupsUpdated, copy };
}
