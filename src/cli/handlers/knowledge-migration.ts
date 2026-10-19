/**
 * Knowledge migration — move a project's brain from the central vault INTO its
 * repo, so the knowledge travels with the code (`share: shared`).
 *
 * ORDER IS THE WHOLE SAFETY PROPERTY:
 *
 *   1. COPY   the vault's flow/ tree into a staging directory in the repo.
 *   2. VERIFY the copy against the vault — every file present, same byte count,
 *             same content hash, same entry count for the append-only stores.
 *   3. COMMIT the copy: unlink the repo's flow/ SYMLINK (a link, not data) and
 *             rename staging into its place. The knowledge now exists TWICE.
 *   4. REPOINT the vault: its project flow/ directory is RENAMED aside (never
 *             deleted) and replaced by a symlink into the repo.
 *
 * There is no instant at which the knowledge exists in neither place, and
 * nothing is ever deleted — a failed verification removes only the staging
 * COPY and leaves the vault exactly as it was. This is the inverse of the
 * delete-then-copy shape, which has a window where a crash loses everything.
 *
 * The invariant lives here, in one code path (allowed-pattern #14), not in the
 * prompt of whoever runs the migration.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import type { BrainPointer, Platform, ShareMode } from '../types.js';
import { getProjectName, getVaultDir, inspectFlowLink } from '../utils/files.js';
import { QUIET_CHILD_STDIO } from '../utils/child-stdio.js';
import { upsertFlowconfigKey } from '../state/flowconfig-writer.js';
import {
  normalizeInvestigationPaths,
  type PathNormalizationResult,
} from '../blueprint/investigation-store.js';
import {
  FLOW_SUBDIRS,
  buildBrainRepoGitattributes,
  buildBrainRepoGitignore,
  keepsOwnKnowledgeRepo,
  materializeRules,
  readBrainPointer,
  readShareMode,
  updateGitattributes,
  updateGitignore,
  updateWorkingSetIgnore,
  updateWorkingSetIgnoreIn,
} from './shared.js';

/** Where the copy lands before it is verified. Repo root, never inside flow/. */
export const MIGRATION_STAGING_DIRNAME = '.plan-flow-migration';

/** Prefix of the renamed-aside vault directory. Nothing is ever deleted. */
export const VAULT_BACKUP_PREFIX = 'flow.pre-migration-';

/**
 * The precious layer: what a person (or a promoted run record) wrote, which no
 * rebuild can reproduce. Everything else under flow/ is derived or transient.
 * Used for REPORTING and for the verification's precious-file count — the copy
 * itself is verbatim, so a file missing from this list is still copied and
 * still verified.
 */
const PRECIOUS_DIR_PREFIXES = [
  'brain/features/',
  'brain/errors/',
  'brain/decisions/',
  'archive/',
  'brainstorms/',
  'contracts/',
  'discovery/',
  'plans/',
  'references/',
  'resources/',
  'reviewed-code/',
  'reviewed-pr/',
];

/** Append-only stores in the structure layer — precious despite living beside
 *  the derived graph. Their ENTRY COUNT is verified, not just their bytes. */
export const APPEND_ONLY_STORES = [
  'brain/.structure/annotations.jsonl',
  'brain/.structure/status-events.jsonl',
  'brain/.structure/investigations.jsonl',
  'brain/.structure/proposals.jsonl',
  'brain/.structure/learning-state.jsonl',
];

/** Transient tiers that are never precious, even under a precious prefix. */
const TRANSIENT_PREFIXES = ['brain/.raw/', 'brain/code/', '.evidence/'];

/** Whether a flow-relative POSIX path belongs to the precious layer. */
export function isPreciousPath(relPath: string): boolean {
  if (TRANSIENT_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false;
  if (APPEND_ONLY_STORES.includes(relPath)) return true;
  if (PRECIOUS_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return true;
  // Top-level knowledge markdown (tasklist, memory, ledger, heartbeat, log, STATE).
  return !relPath.includes('/') && relPath.endsWith('.md');
}

/** What a copy pass moved. Bytes are the source's, so a short write shows up. */
export interface CopyStats {
  files: number;
  dirs: number;
  symlinks: number;
  bytes: number;
}

/**
 * Recursively copy `src` into `dest`, verbatim.
 *
 * Symlinks are RECREATED, never followed: a vault tree can contain nested
 * links (e.g. a `graphify-out` link inside `.structure/`), and following them
 * would both duplicate foreign trees and risk a cycle.
 */
export function copyTreeVerbatim(src: string, dest: string, skipTopLevel: readonly string[] = []): CopyStats {
  const stats: CopyStats = { files: 0, dirs: 0, symlinks: 0, bytes: 0 };
  mkdirSync(dest, { recursive: true });
  stats.dirs += 1;

  // `skipTopLevel` names entries of `src` itself (never deeper) to leave out —
  // a knowledge repo's own `.git` when its working tree goes back to the vault.
  for (const entry of readdirSync(src).sort().filter((name) => !skipTopLevel.includes(name))) {
    const from = join(src, entry);
    const to = join(dest, entry);
    const info = lstatSync(from);

    if (info.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
      stats.symlinks += 1;
      continue;
    }
    if (info.isDirectory()) {
      const nested = copyTreeVerbatim(from, to);
      stats.files += nested.files;
      stats.dirs += nested.dirs;
      stats.symlinks += nested.symlinks;
      stats.bytes += nested.bytes;
      continue;
    }
    if (info.isFile()) {
      copyFileSync(from, to);
      stats.files += 1;
      stats.bytes += info.size;
    }
    // Anything else (socket, fifo, device) is not knowledge — skipped on purpose.
  }

  return stats;
}

/** One file the copy failed to reproduce. A single entry aborts the migration. */
export interface VerifyFailure {
  /** Flow-relative POSIX path. */
  path: string;
  reason: string;
}

/** The verification verdict. `ok` is the ONLY gate the repoint is allowed past. */
export interface VerifyReport {
  ok: boolean;
  /** Files compared (every file, precious or not). */
  files: number;
  /** How many of them belong to the precious layer. */
  preciousFiles: number;
  /** Append-only stores whose entry count was compared. */
  storesChecked: number;
  failures: VerifyFailure[];
}

/** SHA-256 of a file's bytes. */
function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Non-empty lines — the entry count of an append-only JSONL store. */
export function countJsonlEntries(path: string): number {
  const raw = readFileSync(path, 'utf-8');
  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length > 0) count += 1;
  }
  return count;
}

/**
 * Verify that `copy` reproduces `source` exactly.
 *
 * Every file must be present with the same byte count AND the same content
 * hash; every append-only JSONL store must carry the same entry count; every
 * directory and symlink must exist with the same shape. Failures are collected
 * (all of them, so the report names the whole problem) rather than thrown.
 *
 * The check runs against the SOURCE as it is now, so a file that changed under
 * us during the copy is reported too — the conservative direction: it aborts.
 */
export function verifyCopy(
  source: string,
  copy: string,
  prefix = '',
  skipTopLevel: readonly string[] = []
): VerifyReport {
  const report: VerifyReport = { ok: true, files: 0, preciousFiles: 0, storesChecked: 0, failures: [] };

  let entries: string[];
  try {
    // Same top-level-only skip as `copyTreeVerbatim`, so a deliberate omission
    // is not reported as a missing file.
    entries = readdirSync(source).sort().filter((name) => !skipTopLevel.includes(name));
  } catch (err) {
    report.failures.push({ path: prefix || '.', reason: `unreadable source directory: ${(err as Error).message}` });
    report.ok = false;
    return report;
  }

  for (const entry of entries) {
    const rel = `${prefix}${entry}`;
    const from = join(source, entry);
    const to = join(copy, entry);
    const info = lstatSync(from);

    if (info.isSymbolicLink()) {
      const target = readlinkSync(from);
      let copied: string | null = null;
      try {
        copied = lstatSync(to).isSymbolicLink() ? readlinkSync(to) : null;
      } catch {
        copied = null;
      }
      if (copied !== target) {
        report.failures.push({ path: rel, reason: `symlink missing or retargeted (expected ${target})` });
      }
      continue;
    }

    if (info.isDirectory()) {
      if (!existsSync(to) || !statSync(to).isDirectory()) {
        report.failures.push({ path: rel, reason: 'directory missing in the copy' });
        continue;
      }
      const nested = verifyCopy(from, to, `${rel}/`);
      report.files += nested.files;
      report.preciousFiles += nested.preciousFiles;
      report.storesChecked += nested.storesChecked;
      report.failures.push(...nested.failures);
      continue;
    }

    if (!info.isFile()) continue;

    report.files += 1;
    if (isPreciousPath(rel)) report.preciousFiles += 1;

    if (!existsSync(to)) {
      report.failures.push({ path: rel, reason: 'file missing in the copy' });
      continue;
    }
    const copiedSize = statSync(to).size;
    if (copiedSize !== info.size) {
      report.failures.push({ path: rel, reason: `byte count differs (vault ${info.size}, copy ${copiedSize})` });
      continue;
    }
    if (hashFile(from) !== hashFile(to)) {
      report.failures.push({ path: rel, reason: 'content hash differs' });
      continue;
    }
    // Entry count is IMPLIED by the hash today — asserted explicitly anyway, so
    // the store invariant still holds if the byte check is ever relaxed (e.g.
    // to tolerate a normalization pass) rather than silently going unchecked.
    if (APPEND_ONLY_STORES.includes(rel)) {
      report.storesChecked += 1;
      const before = countJsonlEntries(from);
      const after = countJsonlEntries(to);
      if (before !== after) {
        report.failures.push({ path: rel, reason: `entry count differs (vault ${before}, copy ${after})` });
      }
    }
  }

  report.ok = report.failures.length === 0;
  return report;
}

/** Everything a migration attempt did, whether or not it completed. */
export interface MigrationReport {
  status: 'migrated' | 'verified-only' | 'already-migrated' | 'refused';
  /** One-line reason, present exactly when `status` is `refused`. */
  refusal?: string;
  /** Absolute path of the vault directory the knowledge came from. */
  vaultFlowDir: string | null;
  /** Absolute path of the repo directory that now holds it. */
  repoFlowDir: string;
  copied: CopyStats | null;
  verification: VerifyReport | null;
  /** Where the vault's original directory was preserved (never deleted). */
  vaultBackup: string | null;
  /** True once the vault path is a symlink into the repo. */
  vaultLinked: boolean;
  /** Absolute paths rewritten to repo-relative in the investigation store. */
  normalizedInvestigations: PathNormalizationResult | null;
  /** What happened to `.gitattributes` (shared projects only). */
  gitattributes: 'created' | 'updated' | 'unchanged' | null;
  /** Auto-captured working sets kept out of git (shared projects only). */
  workingSetsIgnored: string[];
}

/**
 * Everything that has to be true of the repo AFTER the knowledge lands in it,
 * and nothing that could lose knowledge if it fails.
 *
 * Runs only once the repo already holds the verified copy, so every step here
 * is repairable by re-running: paths become portable, the append-only stores
 * get their union-merge rule, and the personal working sets get their nested
 * ignore list. Each failure is reported, never fatal — the knowledge is safe
 * by this point and a hygiene step is not worth losing that.
 */
export function applyPostMigrationHygiene(
  target: string,
  repoFlowDir: string,
  vaultFlowDir: string | null,
  report: MigrationReport
): void {
  const repoRoot = resolve(target);
  try {
    const roots: (string | { prefix: string; replacement?: string })[] = [repoRoot];
    if (vaultFlowDir !== null) roots.push({ prefix: vaultFlowDir, replacement: 'flow' });
    report.normalizedInvestigations = normalizeInvestigationPaths(repoFlowDir, roots);
  } catch {
    // Sanctioned fail-soft: the store is portable-or-not, never lost.
    report.normalizedInvestigations = null;
  }

  if (readShareMode(repoRoot) !== 'shared') return;
  try {
    report.gitattributes = updateGitattributes(repoRoot);
  } catch {
    report.gitattributes = null;
  }
  try {
    report.workingSetsIgnored = updateWorkingSetIgnore(repoRoot);
  } catch {
    report.workingSetsIgnored = [];
  }
}

/** Injectable steps — the copy is a seam so a short write can be exercised. */
export interface MigrationDeps {
  copyTree: (src: string, dest: string) => CopyStats;
  verify: (source: string, copy: string) => VerifyReport;
}

const DEFAULT_DEPS: MigrationDeps = { copyTree: copyTreeVerbatim, verify: verifyCopy };

export interface MigrationOptions {
  /** Copy and verify, then discard the staging copy and change nothing. */
  dryRun?: boolean;
  /** Test/diagnostic seam; production callers leave this alone. */
  deps?: Partial<MigrationDeps>;
  /** Clock seam so the backup directory name is deterministic in tests. */
  now?: () => Date;
}

function refuse(reason: string, repoFlowDir: string, vaultFlowDir: string | null): MigrationReport {
  return {
    status: 'refused',
    refusal: reason,
    vaultFlowDir,
    repoFlowDir,
    copied: null,
    verification: null,
    vaultBackup: null,
    vaultLinked: false,
    normalizedInvestigations: null,
    gitattributes: null,
    workingSetsIgnored: [],
  };
}

/** `2026-08-11T09-31-02Z` — filesystem-safe, sortable, no locale. */
function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

/**
 * Migrate this project's knowledge from the vault into the repo.
 *
 * Refuses (and changes nothing) when there is nothing to migrate, when the
 * vault target is missing, when a staging directory from an aborted run is in
 * the way, or when VERIFICATION FAILS. Idempotent: a repo that already owns
 * its flow/ reports `already-migrated`.
 */
export function migrateKnowledgeIntoRepo(target: string, options: MigrationOptions = {}): MigrationReport {
  const deps: MigrationDeps = { ...DEFAULT_DEPS, ...options.deps };
  const now = options.now ?? (() => new Date());
  const repoRoot = resolve(target);
  const repoFlowDir = join(repoRoot, 'flow');
  const stagingDir = join(repoRoot, MIGRATION_STAGING_DIRNAME);

  // One inspection covers all three shapes: absent, a real directory, or a link
  // — including a link the OTHER environment created (a WSL POSIX symlink seen
  // from Windows, or a Windows junction seen from WSL), which `existsSync` and
  // `isSymbolicLink` between them would have reported as "no flow/ at all".
  const flowLink = inspectFlowLink(repoFlowDir);

  if (flowLink.status === 'absent') {
    return refuse('no flow/ in this project — run init first', repoFlowDir, null);
  }

  if (flowLink.status === 'dangling' && flowLink.origin !== 'unknown') {
    // Cross-environment link: there is nothing to migrate and nothing safe to
    // touch. Name the cause and the fix instead of dangling in silence.
    return refuse(
      flowLink.message ?? `flow/ was created in another environment and does not resolve (${repoFlowDir})`,
      repoFlowDir,
      null
    );
  }

  if (flowLink.status === 'not-a-link') {
    // Already a real directory: the repo owns its knowledge. Nothing to do.
    return {
      status: 'already-migrated',
      vaultFlowDir: null,
      repoFlowDir,
      copied: null,
      verification: null,
      vaultBackup: null,
      vaultLinked: false,
      normalizedInvestigations: null,
      gitattributes: null,
      workingSetsIgnored: [],
    };
  }

  const linkTarget = flowLink.target;
  if (linkTarget === null) {
    // A reparse point this environment cannot decode — WSL writes exactly that
    // on a Windows drive. Refuse with the remediation rather than crashing in
    // readlink or guessing a target.
    return refuse(
      flowLink.message ?? `flow/ is a link this environment cannot read (${repoFlowDir})`,
      repoFlowDir,
      null
    );
  }
  const vaultFlowDir = resolve(repoFlowDir, '..', linkTarget);
  if (!existsSync(vaultFlowDir)) {
    return refuse(`flow/ points at a missing directory (${vaultFlowDir})`, repoFlowDir, vaultFlowDir);
  }
  if (existsSync(stagingDir)) {
    return refuse(
      `${MIGRATION_STAGING_DIRNAME}/ already exists — an earlier run left it behind; inspect and remove it first`,
      repoFlowDir,
      vaultFlowDir
    );
  }

  // ── 1. COPY (the vault is only ever READ here) ─────────────────────────────
  let copied: CopyStats;
  try {
    copied = deps.copyTree(vaultFlowDir, stagingDir);
  } catch (err) {
    discard(stagingDir);
    return refuse(`copy failed (vault untouched): ${(err as Error).message}`, repoFlowDir, vaultFlowDir);
  }

  // ── 2. VERIFY — the only gate the repoint is allowed past ──────────────────
  let verification: VerifyReport;
  try {
    verification = deps.verify(vaultFlowDir, stagingDir);
  } catch (err) {
    discard(stagingDir);
    return refuse(`verification failed (vault untouched): ${(err as Error).message}`, repoFlowDir, vaultFlowDir);
  }

  if (!verification.ok) {
    discard(stagingDir);
    const detail = verification.failures
      .slice(0, 5)
      .map((failure) => `${failure.path} — ${failure.reason}`)
      .join('; ');
    const more = verification.failures.length > 5 ? ` (+${verification.failures.length - 5} more)` : '';
    const report = refuse(
      `verification failed, nothing repointed and the vault is untouched: ${detail}${more}`,
      repoFlowDir,
      vaultFlowDir
    );
    report.copied = copied;
    report.verification = verification;
    return report;
  }

  if (options.dryRun === true) {
    discard(stagingDir);
    return {
      status: 'verified-only',
      vaultFlowDir,
      repoFlowDir,
      copied,
      verification,
      vaultBackup: null,
      vaultLinked: false,
      normalizedInvestigations: null,
      gitattributes: null,
      workingSetsIgnored: [],
    };
  }

  // ── 3. COMMIT — from here the knowledge exists in BOTH places ──────────────
  try {
    rmSync(repoFlowDir, { force: true }); // the SYMLINK only; the vault dir is untouched
    renameSync(stagingDir, repoFlowDir);
  } catch (err) {
    // Put the link back so the project still resolves to the vault.
    let restoreNote = '';
    if (!existsSync(repoFlowDir)) {
      try {
        symlinkSync(vaultFlowDir, repoFlowDir, process.platform === 'win32' ? 'junction' : 'dir');
        const restored = inspectFlowLink(repoFlowDir);
        if (restored.status === 'dangling') {
          // The link exists but points nowhere this environment can follow —
          // say so, rather than leaving a project that looks restored.
          restoreNote = ` — and the restored flow/ link does not resolve: ${restored.message}`;
        }
      } catch {
        // Sanctioned fail-soft: the refusal below carries the real problem.
      }
    }
    discard(stagingDir);
    return refuse(
      `could not install the copy (vault untouched): ${(err as Error).message}${restoreNote}`,
      repoFlowDir,
      vaultFlowDir
    );
  }

  // ── 4. REPOINT — rename the vault dir aside, then link it into the repo ────
  const vaultBackup = `${join(vaultFlowDir, '..')}/${VAULT_BACKUP_PREFIX}${backupStamp(now())}`;
  let vaultLinked = false;
  let backupPath: string | null = null;
  try {
    renameSync(vaultFlowDir, vaultBackup);
    backupPath = vaultBackup;
    symlinkSync(repoFlowDir, vaultFlowDir, process.platform === 'win32' ? 'junction' : 'dir');
    // A created link is not a working link: verify it resolves before claiming
    // the vault is repointed. The catch below reports the failure loudly.
    const vaultLink = inspectFlowLink(vaultFlowDir);
    if (vaultLink.status === 'dangling') {
      throw new Error(vaultLink.message ?? `the new vault link does not resolve (${vaultFlowDir})`);
    }
    vaultLinked = true;
  } catch (err) {
    // The repo already holds the knowledge, so this is a partial success, not a
    // loss — report it loudly rather than pretending either way.
    const report: MigrationReport = {
      status: 'migrated',
      refusal: `repo holds the knowledge, but the vault could not be repointed: ${(err as Error).message}`,
      vaultFlowDir,
      repoFlowDir,
      copied,
      verification,
      vaultBackup: backupPath,
      vaultLinked,
      normalizedInvestigations: null,
      gitattributes: null,
      workingSetsIgnored: [],
    };
    applyPostMigrationHygiene(target, repoFlowDir, vaultFlowDir, report);
    return report;
  }

  const report: MigrationReport = {
    status: 'migrated',
    vaultFlowDir,
    repoFlowDir,
    copied,
    verification,
    vaultBackup: backupPath,
    vaultLinked,
    normalizedInvestigations: null,
    gitattributes: null,
    workingSetsIgnored: [],
  };
  applyPostMigrationHygiene(target, repoFlowDir, vaultFlowDir, report);
  return report;
}

/** Remove the staging COPY. Never touches the vault or the repo's flow/. */
function discard(stagingDir: string): void {
  try {
    rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // Sanctioned fail-soft: a leftover staging dir refuses the next run by name.
  }
}

// ── team-knowledge-sharing Phase 3: convert same <-> separate ────────────────
//
// `separate` mode makes flow/ its OWN nested git repo (own remote), gitignored by
// the parent. Git is INJECTED (allowed-pattern #12) so the argv sequence and the
// file effects are unit-testable with a fake git that throws on the unexpected.

/** A git runner: run argv in cwd, throw on failure. Injected for testability. */
export interface GitExec {
  (args: string[], cwd: string): void;
}

export interface ConvertResult {
  ok: boolean;
  error?: string;
  /** The git argv actually run, in order — for assertions. */
  ran: string[][];
}

/**
 * Convert a project to `separate` mode:
 *   1. `git init` flow/ + `git remote add origin <pointer.url>`
 *   2. move team rules into the brain (flow/rules/) + seed the brain .gitignore
 *   3. parent stops tracking flow/ (`git rm -r --cached --ignore-unmatch flow`)
 *   4. parent .gitignore records `separate` + the committed brain pointer
 *   5. materialize <cwd>/.claude/rules from the brain (SDK still loads them)
 *   6. first brain commit
 * Refuses if flow/ is already a nested repo. Reversible via convertToSame.
 */
export function convertToSeparate(
  projectRoot: string,
  pointer: BrainPointer,
  platforms: Platform[],
  exec: GitExec
): ConvertResult {
  const ran: string[][] = [];
  const run = (args: string[], cwd: string): void => {
    ran.push(args);
    exec(args, cwd);
  };
  const flowDir = join(projectRoot, 'flow');
  if (!existsSync(flowDir)) return { ok: false, error: 'no flow/ directory to convert', ran };
  if (existsSync(join(flowDir, '.git'))) {
    return { ok: false, error: 'flow/ is already a separate brain repo', ran };
  }
  const address = parseGitRemote(pointer.url);
  if (!address.ok) return { ok: false, error: `${address.reason}: ${address.detail}`, ran };
  const branch = parseKnowledgeBranch(pointer.branch ?? DEFAULT_KNOWLEDGE_BRANCH);
  if (!branch.ok) return { ok: false, error: `${branch.reason}: ${branch.detail}`, ran };
  try {
    run(knowledgeInitArgs(branch.branch), flowDir);
    run(['remote', 'add', '--', 'origin', address.url], flowDir);

    copyRulesIntoKnowledge(projectRoot, flowDir);
    writeKnowledgeRepoFiles(flowDir);

    // The parent stops tracking flow/ AND .claude/rules — both are now owned by
    // the brain repo (rules are materialized back below). Adding them to
    // .gitignore does NOT untrack an already-tracked path, so the `git rm --cached`
    // is what actually stops the code repo from committing them (review F1). The
    // parent may already have them untracked (local mode) — --ignore-unmatch makes
    // that a no-op rather than an error.
    run(['rm', '-r', '--cached', '--ignore-unmatch', 'flow'], projectRoot);
    run(['rm', '-r', '--cached', '--ignore-unmatch', '.claude/rules'], projectRoot);
    updateGitignore(projectRoot, platforms, { force: false }, 'separate', pointer);
    materializeRules(flowDir, projectRoot);

    run(['add', '-A'], flowDir);
    run(['commit', '-m', 'chore(plan-flow): initialize team brain repo'], flowDir);
    return { ok: true, ran };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ran };
  }
}

/**
 * Reverse: fold flow/ back into the parent repo (`shared` mode by default). Drops
 * the nested .git + the brain .gitignore, moves rules back to the parent's
 * .claude/rules as tracked content, and rewrites the parent .gitignore. No git
 * subprocess is needed — flow/ becomes plain tracked content on the parent's next
 * commit. The caller must refuse on an unpushed brain (data loss).
 */
export function convertToSame(
  projectRoot: string,
  platforms: Platform[],
  mode: ShareMode = 'shared'
): ConvertResult {
  const ran: string[][] = [];
  const flowDir = join(projectRoot, 'flow');
  if (!existsSync(flowDir)) return { ok: false, error: 'no flow/ directory to convert', ran };
  if (!existsSync(join(flowDir, '.git'))) {
    return { ok: false, error: 'flow/ is not a separate brain repo', ran };
  }
  try {
    rmSync(join(flowDir, '.git'), { recursive: true, force: true });
    rmSync(join(flowDir, '.gitignore'), { force: true });

    const rulesInBrain = join(flowDir, 'rules');
    if (existsSync(rulesInBrain)) {
      mkdirSync(join(projectRoot, '.claude', 'rules'), { recursive: true });
      cpSync(rulesInBrain, join(projectRoot, '.claude', 'rules'), { recursive: true });
      rmSync(rulesInBrain, { recursive: true, force: true });
    }
    updateGitignore(projectRoot, platforms, { force: false }, mode);
    return { ok: true, ran };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), ran };
  }
}

// ── knowledge sync: one door to turn it on and off (Phase 2) ─────────────────
//
// `enableKnowledgeSync` / `disableKnowledgeSync` / `knowledgeStatus` are the
// ONLY code that moves a project into or out of its own knowledge repo — the
// `planflow-ai knowledge` verb is a printer for them, and the app spawns that
// verb (allowed-pattern #14). Every step runs against a real git, behind a
// rollback list: a failure at any step undoes the steps before it, so the
// project is left in the shape it started in (staging discarded, symlink
// restored, no half-made `.git`). Nothing is pushed here, ever — the first push
// belongs to the sync, which runs where a person can see it fail.

/** The branch a knowledge repo starts on when nobody names one. */
export const DEFAULT_KNOWLEDGE_BRANCH = 'main';

/** Where a vault copy is assembled before it becomes `flow/` (project root). */
export const KNOWLEDGE_STAGING_PREFIX = '.flow-staging-';

/** Where the project's own `flow/` waits while a vault link replaces it. */
export const KNOWLEDGE_RETIRED_PREFIX = '.flow-retired-';

/** A vault copy moved aside so a newer one can take its place. Never deleted. */
export const VAULT_FLOW_BACKUP_PREFIX = 'flow.backup-';

/** The vault copy taken before this machine adopts the knowledge repo. Never deleted. */
export const VAULT_ADOPT_BACKUP_PREFIX = 'flow.before-adopt-';

/** Marks the vault's version of a file the knowledge repo also has, set beside it. */
export const FROM_VAULT_MARK = '.from-vault';

/** A retired knowledge repo's history, kept beside the vault copy. Never deleted. */
export const KEPT_KNOWLEDGE_REPO_PREFIX = 'knowledge-repo-';

const KNOWLEDGE_FIRST_COMMIT = "chore(plan-flow): start this project's knowledge repo";
const CODE_UNTRACK_COMMIT = "chore(plan-flow): keep this project's knowledge in its own repo";
const CODE_RETRACK_COMMIT = "chore(plan-flow): track this project's knowledge with the code again";

/** How long any one git call may take before it is a failure. */
const KNOWLEDGE_GIT_TIMEOUT_MS = 120_000;

/** The ONE argv that starts a knowledge repo — shared by every converter. */
export function knowledgeInitArgs(branch: string): string[] {
  return ['init', '-q', '-b', branch];
}

/**
 * Write the knowledge repo's own `.gitignore` and `.gitattributes`, and the
 * nested working-set list in `brain/features/` (the same content-aware
 * mechanism a shared project uses — a path ignore cannot tell a per-thread
 * capture from a feature). Returns the working sets kept out of the repo.
 */
export function writeKnowledgeRepoFiles(knowledgeDir: string): string[] {
  writeFileSync(join(knowledgeDir, '.gitignore'), buildBrainRepoGitignore() + '\n', 'utf-8');
  writeFileSync(join(knowledgeDir, '.gitattributes'), buildBrainRepoGitattributes() + '\n', 'utf-8');
  return updateWorkingSetIgnoreIn(join(knowledgeDir, 'brain', 'features'));
}

/**
 * Copy the project's team rules into the knowledge repo's `rules/`, so they
 * sync with the knowledge. Only when the repo has none yet: an existing
 * `rules/` is the knowledge repo's own and wins. Returns whether it copied.
 */
export function copyRulesIntoKnowledge(projectRoot: string, knowledgeDir: string): boolean {
  const rulesSrc = join(projectRoot, '.claude', 'rules');
  const rulesDest = join(knowledgeDir, 'rules');
  if (!existsSync(rulesSrc) || existsSync(rulesDest)) return false;
  mkdirSync(rulesDest, { recursive: true });
  cpSync(rulesSrc, rulesDest, { recursive: true });
  return true;
}

/** Run git, return stdout, throw on a non-zero exit. */
export type KnowledgeGit = (args: string[], cwd: string) => string;

/**
 * The real git, quiet on the terminal, its stderr kept for the reason line.
 *
 * `env` is passed EXPLICITLY. It is the same object in production, but a
 * host that gives this module its own `process.env` (jest's sandbox does)
 * would otherwise run git with the OUTER environment — another person's git
 * identity, another config, the real network.
 */
export const defaultKnowledgeGit: KnowledgeGit = (args, cwd) =>
  execFileSync('git', args, {
    encoding: 'utf-8',
    cwd,
    env: process.env,
    timeout: KNOWLEDGE_GIT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    stdio: [...QUIET_CHILD_STDIO],
  });

/** Every step a converter checkpoints — the failure-injection seam's vocabulary. */
export type KnowledgeStep =
  | 'prepare'
  | 'init'
  | 'identity'
  | 'remote'
  | 'files'
  | 'commit'
  | 'swap'
  | 'code-ignore'
  | 'code-untrack'
  | 'code-commit'
  | 'remote-remove'
  | 'keep-history'
  | 'copy'
  | 'backup-aside'
  | 'install'
  | 'retire'
  | 'link'
  | 'convert'
  | 'code-track'
  | 'backup'
  | 'clone'
  | 'merge';

/** Injected collaborators. Production passes none. */
export interface KnowledgeDeps {
  git: KnowledgeGit;
  /** Called before every step; throwing here is how a test fails that step. */
  checkpoint: (step: KnowledgeStep) => void;
  copyTree: (src: string, dest: string, skipTopLevel?: readonly string[]) => CopyStats;
  verify: (source: string, copy: string, prefix?: string, skipTopLevel?: readonly string[]) => VerifyReport;
  now: () => Date;
  /** A short random token for staging names. */
  random: () => string;
}

const DEFAULT_KNOWLEDGE_DEPS: KnowledgeDeps = {
  git: defaultKnowledgeGit,
  checkpoint: () => undefined,
  copyTree: copyTreeVerbatim,
  verify: verifyCopy,
  now: () => new Date(),
  random: () => randomBytes(4).toString('hex'),
};

/**
 * Where a project's knowledge sits right now. `vault-pending` is a `flow/`
 * still linked into the vault while the committed block names a knowledge
 * repo: another machine turned sync on, and this one has not adopted it yet.
 */
export type KnowledgeShape = 'vault' | 'vault-pending' | 'shared' | 'local' | 'separate' | 'none';

/** Every reason a knowledge verb refuses. Each carries a payload (pattern #21). */
export type KnowledgeRefusalReason =
  | GitRemoteRefusalReason
  | 'invalid-branch'
  | 'leftovers'
  | 'nothing-to-adopt'
  | 'clone-failed'
  | 'already-enabled'
  | 'other-remote'
  | 'clone-pending'
  | 'dirty-code'
  | 'no-git-identity'
  | 'not-a-git-repo'
  | 'flow-unreadable'
  | 'verification-failed'
  | 'not-enabled'
  | 'unpushed'
  | 'conflicted'
  | 'invalid-destination'
  | 'unconfirmed'
  | 'flow-ignored'
  /** `enable` / `adopt` since the hard migration (decision 2026-10-06): knowledge syncs through the Workspace. */
  | 'retired'
  | 'failed';

/**
 * A refusal that answers. `sentence` is what a person reads; `payload` is what
 * the asking surface needs to put the question (allowed-pattern #21) — always
 * `{ refused, detail, ... }`, with `restored` once anything had been touched.
 */
export class KnowledgeRefusal extends Error {
  readonly reason: KnowledgeRefusalReason;
  readonly sentence: string;
  readonly payload: Record<string, unknown>;

  constructor(reason: KnowledgeRefusalReason, sentence: string, extra: Record<string, unknown> = {}) {
    super(`${reason} — ${sentence}`);
    this.name = 'KnowledgeRefusal';
    this.reason = reason;
    this.sentence = sentence;
    this.payload = { refused: reason, detail: sentence, ...extra };
  }
}

/**
 * The address shapes a knowledge repo may use — any git host. Shown to the
 * person deciding, never parsed.
 */
export const ACCEPTED_REMOTE_FORMS = [
  'https://<host>/<owner>/<repo>(.git)',
  'ssh://[user@]<host>[:port]/<owner>/<repo>(.git)',
  '[user@]<host>:<owner>/<repo>(.git)',
];

/** Which hosting service an address names — a label, never a permission. */
export type GitRemoteProvider = 'github' | 'azure' | 'gitlab' | 'bitbucket' | 'other';

/** Why an address is refused. Each is a KnowledgeRefusalReason too. */
export type GitRemoteRefusalReason = 'invalid-remote' | 'insecure-remote' | 'credentials-in-url';

export type GitRemoteVerdict =
  | { ok: true; url: string; host: string; provider: GitRemoteProvider }
  | { ok: false; reason: GitRemoteRefusalReason; detail: string };

/** Userinfo that is a token wearing a username's clothes. */
const TOKEN_USERNAME_PREFIXES = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_', 'glpat-'];

/** GitHub's own ceiling for a login; anything longer is a secret, not a name. */
const MAX_PLAIN_USERNAME_LENGTH = 39;

/** The highest TCP port. */
const MAX_PORT = 65_535;

/** A path needs at least an owner and a repo. */
const MIN_PATH_SEGMENTS = 2;

/** `scheme://authority/path` — the authority runs to the first `/`. */
const URL_FORM = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/;
/** scp-like `[user@]host:path` — no `/` before the first `:`, which is git's own rule. */
const SCP_FORM = /^(?:([^@/:]+)@)?([^@/:]+):(.*)$/;
const HOST_PORT = /^([^:]+)(?::(\d{1,5}))?$/;
const DNS_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const PLAIN_USERNAME = /^[A-Za-z0-9_.~][A-Za-z0-9_.~-]*$/;
/** A path segment: never `-`-led, so no segment can be read as an option (L2). */
const PATH_SEGMENT = /^[A-Za-z0-9_.~+%][A-Za-z0-9_.~+%-]*$/;
const PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
// eslint-disable-next-line no-control-regex
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/;
/** A token smuggled into the query string. */
const URL_TOKEN_QUERY = /[?&](?:access_token|token|private_token|oauth_token)=/i;

/** What the grammar learned about an accepted address. */
interface RemoteParts {
  host: string;
  segments: string[];
}

type RemoteInspection = { ok: true; parts: RemoteParts } | { ok: false; reason: GitRemoteRefusalReason; detail: string };

function invalid(detail: string): RemoteInspection {
  return { ok: false, reason: 'invalid-remote', detail };
}

function credentials(detail: string): RemoteInspection {
  return { ok: false, reason: 'credentials-in-url', detail };
}

/** A userinfo part: a password or a token refuses; a plain login name is allowed. */
function inspectUserinfo(userinfo: string): RemoteInspection | null {
  if (userinfo.includes(':')) return credentials('the address carries a password');
  const lower = userinfo.toLowerCase();
  if (TOKEN_USERNAME_PREFIXES.some((prefix) => lower.startsWith(prefix)) || userinfo.length > MAX_PLAIN_USERNAME_LENGTH) {
    return credentials('the address carries a token');
  }
  if (!PLAIN_USERNAME.test(userinfo)) return invalid('the user name is not a plain login name');
  return null;
}

function inspectHost(host: string): string | null {
  // Two characters at least: a lone letter before `:` is a Windows drive.
  if (host.length < 2) return null;
  const labels = host.split('.');
  return labels.every((label) => DNS_LABEL.test(label)) ? host.toLowerCase() : null;
}

function inspectPath(path: string): string[] | null {
  let body = path.startsWith('/') ? path.slice(1) : path;
  if (body.endsWith('/')) body = body.slice(0, -1);
  const segments = body.split('/');
  if (segments.length < MIN_PATH_SEGMENTS) return null;
  for (const segment of segments) {
    if (!PATH_SEGMENT.test(segment) || segment === '.' || segment === '..') return null;
    if (segment.includes('%')) {
      if (PERCENT_ESCAPE.test(segment)) return null;
      let decoded: string;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return null;
      }
      if (decoded === '.' || decoded === '..' || /[/\\]/.test(decoded) || WHITESPACE_OR_CONTROL.test(decoded)) return null;
    }
  }
  return segments;
}

/**
 * The one grammar. Every refusal names a reason and a detail that never
 * repeats the address — a refused address may carry a secret.
 */
function inspectRemote(raw: string): RemoteInspection {
  if (raw.length === 0) return invalid('no address was given');
  if (raw.startsWith('-')) return invalid('an address cannot start with "-"');
  if (WHITESPACE_OR_CONTROL.test(raw)) return invalid('the address contains spaces or control characters');
  if (raw.includes('::')) return invalid('"::" transport syntax is not an address');
  if (URL_TOKEN_QUERY.test(raw)) return credentials('the address carries a token');
  if (/[?#]/.test(raw)) return invalid('an address cannot carry "?" or "#"');
  if (raw.includes('\\')) return invalid('an address cannot contain "\\"');

  const url = URL_FORM.exec(raw);
  if (url !== null) {
    const scheme = url[1].toLowerCase();
    let authority = url[2];
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      const problem = inspectUserinfo(authority.slice(0, at));
      if (problem !== null) return problem;
      authority = authority.slice(at + 1);
    }
    if (scheme === 'http' || scheme === 'git') {
      return { ok: false, reason: 'insecure-remote', detail: `${scheme}:// is not encrypted` };
    }
    if (scheme !== 'https' && scheme !== 'ssh') return invalid('only https://, ssh:// and user@host:path addresses are accepted');
    const hostPort = HOST_PORT.exec(authority);
    if (hostPort === null) return invalid('the host is not a valid name');
    const host = inspectHost(hostPort[1]);
    if (host === null) return invalid('the host is not a valid name');
    if (hostPort[2] !== undefined) {
      const port = Number.parseInt(hostPort[2], 10);
      if (port < 1 || port > MAX_PORT) return invalid('the port is out of range');
    }
    if (!url[3].startsWith('/')) return invalid('the address has no repository path');
    const segments = inspectPath(url[3]);
    if (segments === null) return invalid('the repository path is not owner/repo shaped');
    return { ok: true, parts: { host, segments } };
  }

  // scp-like. A `user:secret@` prefix never matches the form, so say what it is.
  const firstAt = raw.indexOf('@');
  if (firstAt > 0 && !raw.slice(0, firstAt).includes('/') && raw.slice(0, firstAt).includes(':')) {
    return credentials('the address carries a password');
  }
  const scp = SCP_FORM.exec(raw);
  if (scp === null) return invalid('this is not a git repository address');
  if (scp[1] !== undefined) {
    const problem = inspectUserinfo(scp[1]);
    if (problem !== null) return problem;
  }
  const host = inspectHost(scp[2]);
  if (host === null) return invalid('the host is not a valid name');
  const segments = inspectPath(scp[3]);
  if (segments === null) return invalid('the repository path is not owner/repo shaped');
  return { ok: true, parts: { host, segments } };
}

function providerOf(host: string): GitRemoteProvider {
  if (host === 'github.com' || host === 'ssh.github.com') return 'github';
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) return 'azure';
  if (host === 'gitlab.com') return 'gitlab';
  if (host === 'bitbucket.org') return 'bitbucket';
  return 'other';
}

/**
 * Validate a knowledge-repo address — one a person TYPED or one read from a
 * committed file (allowed-pattern #22: validate, never rewrite). Any git host:
 * https, ssh:// and scp-like `user@host:path`. The verdict's `url` is the input
 * exactly as given.
 *
 * Pinned to `app/src/shared/git-remote-fixtures.json` by a parity test — the
 * app's parser runs the same list. Change the list, never one side.
 */
export function parseGitRemote(raw: string): GitRemoteVerdict {
  const seen = inspectRemote(raw);
  if (!seen.ok) return seen;
  return { ok: true, url: raw, host: seen.parts.host, provider: providerOf(seen.parts.host) };
}

/**
 * What names the same repository whatever the transport: the canonical host
 * and the path, lowercased, without `.git` — and Azure's three spellings
 * (`dev.azure.com/org/project/_git/repo`, `org.visualstudio.com/project/_git/repo`,
 * `ssh.dev.azure.com:v3/org/project/repo`) folded into one. Null when the
 * address does not parse.
 */
export function remoteIdentity(raw: string): string | null {
  const seen = inspectRemote(raw);
  if (!seen.ok) return null;
  let { host } = seen.parts;
  let segments = [...seen.parts.segments];
  if (host === 'ssh.github.com') host = 'github.com';
  if (providerOf(host) === 'azure') {
    if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
      if (segments[0] === 'v3') segments = segments.slice(1);
    } else if (host.endsWith('.visualstudio.com')) {
      segments = [host.slice(0, -'.visualstudio.com'.length), ...segments.filter((segment) => segment !== 'DefaultCollection')];
    }
    host = 'dev.azure.com';
    segments = segments.filter((segment) => segment !== '_git');
  }
  const last = segments.length - 1;
  segments[last] = segments[last].replace(/\.git$/i, '');
  return `${host}/${segments.join('/')}`.toLowerCase();
}

/** Whether two addresses name the same repository, whatever the transport. */
export function sameRemoteRepo(a: string, b: string): boolean {
  const left = remoteIdentity(a.trim());
  const right = remoteIdentity(b.trim());
  if (left === null || right === null) return a.trim() === b.trim();
  return left === right;
}

export type KnowledgeBranchVerdict =
  | { ok: true; branch: string }
  | { ok: false; reason: 'invalid-branch'; detail: string };

/** A ref name's longest sensible length. */
const MAX_BRANCH_LENGTH = 255;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const BRANCH_FORBIDDEN = /[\s\u0000-\u001f\u007f~^:?*[\\]/;

/**
 * Validate a branch name before it reaches git — git's check-ref-format
 * essentials, plus never `-`-led (it would be read as an option). Pinned to the
 * fixture list's `branches` like the address grammar.
 */
export function parseKnowledgeBranch(raw: string): KnowledgeBranchVerdict {
  const fail = (detail: string): KnowledgeBranchVerdict => ({ ok: false, reason: 'invalid-branch', detail });
  if (raw.length === 0) return fail('no branch name was given');
  if (raw.length > MAX_BRANCH_LENGTH) return fail('the branch name is too long');
  if (raw.startsWith('-')) return fail('a branch name cannot start with "-"');
  if (raw === '@') return fail('"@" alone is not a branch name');
  if (BRANCH_FORBIDDEN.test(raw)) return fail('the branch name contains a character git does not allow');
  if (raw.includes('..') || raw.includes('@{')) return fail('the branch name contains a sequence git does not allow');
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('//')) return fail('the branch name has an empty part');
  if (raw.endsWith('.')) return fail('a branch name cannot end with "."');
  for (const segment of raw.split('/')) {
    if (segment.startsWith('.') || segment.endsWith('.lock')) return fail('a part of the branch name starts with "." or ends with ".lock"');
  }
  return { ok: true, branch: raw };
}

/** Userinfo kept in a printed address: a plain login name (`git`, an Azure org) only. */
function keepUserinfo(userinfo: string): string {
  return inspectUserinfo(userinfo) === null ? userinfo : '***';
}

/**
 * An address safe to print and to put in a payload: a password, a token or
 * any userinfo the grammar cannot read is masked; a plain login name stays.
 */
export function redactRemote(raw: string): string {
  const trimmed = raw.trim();
  const masked = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*)@/, (_all, scheme: string, userinfo: string) => `${scheme}${keepUserinfo(userinfo)}@`)
    : trimmed.replace(/^([^@/]+)@/, (_all, userinfo: string) => `${keepUserinfo(userinfo)}@`);
  return masked.replace(/([?&](?:access_token|token|private_token|oauth_token)=)[^&#]*/gi, '$1***');
}

/** Run git and return stdout, or null when it exits non-zero. */
function tryGit(git: KnowledgeGit, args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Collapse a thrown message into one bounded line. */
function oneLine(value: string, max = 200): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function errorText(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error));
}

/** What `inspectKnowledge` found. Read-only. */
interface KnowledgeInspection {
  shape: KnowledgeShape;
  root: string;
  flowDir: string;
  /** realpath of a vault-shape `flow/`; null otherwise (or when it dangles). */
  vaultPath: string | null;
  /** The link's stored target, exactly as written — what a restore re-creates. */
  linkTarget: string | null;
  /** The knowledge dir already holds its own `.git`. */
  hasRepo: boolean;
  /** `root` is the top of a git work tree (never a subdirectory of one). */
  codeIsRepo: boolean;
}

function isCodeRepoRoot(root: string, git: KnowledgeGit): boolean {
  const top = tryGit(git, ['rev-parse', '--show-toplevel'], root);
  if (top === null) return false;
  try {
    return realpathSync(top.trim()) === realpathSync(root);
  } catch {
    return false;
  }
}

function inspectKnowledge(root: string, git: KnowledgeGit): KnowledgeInspection {
  const flowDir = join(root, 'flow');
  const codeIsRepo = isCodeRepoRoot(root, git);
  const base = { root, flowDir, codeIsRepo, vaultPath: null, linkTarget: null };

  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(flowDir);
  } catch {
    return { ...base, shape: 'none', hasRepo: false };
  }

  if (info.isSymbolicLink()) {
    let vaultPath: string | null = null;
    try {
      vaultPath = realpathSync(flowDir);
    } catch {
      vaultPath = null;
    }
    return {
      ...base,
      shape: keepsOwnKnowledgeRepo(root) ? 'vault-pending' : 'vault',
      vaultPath,
      linkTarget: readlinkSync(flowDir),
      hasRepo: vaultPath !== null && existsSync(join(vaultPath, '.git')),
    };
  }

  if (!info.isDirectory()) {
    throw new KnowledgeRefusal('flow-unreadable', 'flow/ is a file, not a folder — there is no knowledge to sync there', {
      flowDir,
    });
  }

  const hasRepo = existsSync(join(flowDir, '.git'));
  if (hasRepo && keepsOwnKnowledgeRepo(root)) return { ...base, shape: 'separate', hasRepo };
  if (!hasRepo && codeIsRepo) {
    const tracked = tryGit(git, ['ls-files', '--', 'flow'], root);
    if (readShareMode(root) === 'shared' || (tracked !== null && tracked.trim().length > 0)) {
      return { ...base, shape: 'shared', hasRepo };
    }
  }
  return { ...base, shape: 'local', hasRepo };
}

/**
 * Tracked changes in the code repo, outside `flow/` (repo-relative).
 *
 * Untracked files are not dirt — no commit here could sweep them up. Changes
 * under `flow/` are not dirt either: on enable they BECOME the knowledge repo's
 * first commit, and refusing on them would refuse almost every shared project,
 * whose agent writes to `flow/` all day.
 */
function dirtyCodeFiles(seen: KnowledgeInspection, git: KnowledgeGit): string[] {
  if (!seen.codeIsRepo) return [];
  const raw = tryGit(git, ['status', '--porcelain=v1', '-z', '--untracked-files=no'], seen.root);
  if (raw === null) return [];
  const files: string[] = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes('R') || xy.includes('C')) i += 1; // the next entry is the original path
    if (path === 'flow' || path.startsWith('flow/')) continue;
    files.push(path);
  }
  return files.sort();
}

/** The knowledge repo's commits not on its remote. All of them, with no remote-tracking ref. */
function unpushedCount(knowledgeDir: string, git: KnowledgeGit): { count: number; hasUpstream: boolean } {
  if (tryGit(git, ['rev-parse', '--verify', '-q', 'HEAD'], knowledgeDir) === null) {
    return { count: 0, hasUpstream: false };
  }
  const count = (range: string): number => Number.parseInt(git(['rev-list', '--count', range], knowledgeDir).trim(), 10);
  if (tryGit(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], knowledgeDir) !== null) {
    return { count: count('@{u}..HEAD'), hasUpstream: true };
  }
  const branch = tryGit(git, ['symbolic-ref', '--short', '-q', 'HEAD'], knowledgeDir)?.trim() ?? '';
  if (branch.length > 0 && tryGit(git, ['show-ref', '--verify', '-q', `refs/remotes/origin/${branch}`], knowledgeDir) !== null) {
    return { count: count(`refs/remotes/origin/${branch}..HEAD`), hasUpstream: false };
  }
  return { count: count('HEAD'), hasUpstream: false };
}

function lines(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The read-only answer to "where is this project's knowledge, and is it synced?" */
export interface KnowledgeStatus {
  shape: KnowledgeShape;
  /** The knowledge repo's `origin`, when it has one. */
  remote: string | null;
  /** The committed pointer in the code repo's plan-flow block. */
  pointer: BrainPointer | null;
  /** Tracked code-repo changes outside `flow/`. */
  dirtyCode: string[];
  /** `flow/` holds its own `.git`. */
  hasRepo: boolean;
  /** Commits the remote does not have; null without a knowledge repo. */
  unpushed: number | null;
  /** Unmerged paths in the knowledge repo. */
  conflicted: string[];
  /** The knowledge repo's current branch. */
  branch: string | null;
  /** An upstream is configured for that branch. */
  hasUpstream: boolean;
  /** Where a vault-shape `flow/` resolves. */
  vaultPath: string | null;
  /** Copies an interrupted run left in the project root (names only). */
  leftovers: string[];
}

function isVaultShape(shape: KnowledgeShape): boolean {
  return shape === 'vault' || shape === 'vault-pending';
}

function knowledgeDirOf(seen: KnowledgeInspection): string | null {
  if (!seen.hasRepo) return null;
  return isVaultShape(seen.shape) ? seen.vaultPath : seen.flowDir;
}

/**
 * The knowledge repo's `origin` AS STORED — never `remote get-url`, which
 * applies the person's `insteadOf` rewrites and would make one repository
 * look like another.
 */
function originOf(git: KnowledgeGit, dir: string): string | null {
  return tryGit(git, ['config', '--get', 'remote.origin.url'], dir)?.trim() || null;
}

/** A pointer that is safe to print: its address with any credentials masked. */
function printablePointer(pointer: BrainPointer | null): BrainPointer | null {
  if (pointer === null) return null;
  return { ...pointer, url: redactRemote(pointer.url) };
}

/**
 * What an interrupted enable or disable left in the project root —
 * `.flow-staging-*` / `.flow-retired-*`. Always COPIES of knowledge that also
 * lives in `flow/` or the vault, never the source of truth. Names only.
 */
export function knowledgeLeftovers(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .filter((name) => name.startsWith(KNOWLEDGE_STAGING_PREFIX) || name.startsWith(KNOWLEDGE_RETIRED_PREFIX))
    .sort();
}

export function knowledgeStatus(target: string, deps: Partial<KnowledgeDeps> = {}): KnowledgeStatus {
  const git = deps.git ?? DEFAULT_KNOWLEDGE_DEPS.git;
  const seen = inspectKnowledge(resolve(target), git);
  const dir = knowledgeDirOf(seen);
  const pending = dir === null ? null : unpushedCount(dir, git);
  return {
    shape: seen.shape,
    remote: dir === null ? null : printableRemote(originOf(git, dir)),
    pointer: printablePointer(readBrainPointer(seen.root)),
    dirtyCode: dirtyCodeFiles(seen, git),
    hasRepo: seen.hasRepo,
    unpushed: pending === null ? null : pending.count,
    conflicted: dir === null ? [] : lines(tryGit(git, ['diff', '--name-only', '--diff-filter=U'], dir)),
    branch: dir === null ? null : tryGit(git, ['symbolic-ref', '--short', '-q', 'HEAD'], dir)?.trim() || null,
    hasUpstream: pending?.hasUpstream ?? false,
    vaultPath: seen.vaultPath,
    leftovers: knowledgeLeftovers(seen.root),
  };
}

function printableRemote(remote: string | null): string | null {
  return remote === null ? null : redactRemote(remote);
}

/**
 * The undo list. Each step that changes something pushes how to put it back;
 * a failure runs them newest-first. An undo that itself fails is REPORTED (the
 * payload's `restoreProblems`), never swallowed — a half-restored project must
 * say so.
 */
class Rollback {
  readonly #undo: Array<() => void> = [];

  push(undo: () => void): void {
    this.#undo.push(undo);
  }

  run(): string[] {
    const problems: string[] = [];
    while (this.#undo.length > 0) {
      const undo = this.#undo.pop();
      try {
        undo?.();
      } catch (error) {
        problems.push(errorText(error));
      }
    }
    return problems;
  }
}

/** Snapshot a file's bytes (or its absence) and return how to put them back. */
function snapshotFile(path: string): () => void {
  const existed = existsSync(path);
  const bytes = existed ? readFileSync(path) : null;
  return () => {
    if (bytes === null) rmSync(path, { force: true });
    else writeFileSync(path, bytes);
  };
}

/**
 * Keep transient siblings out of the code repo's `git status` — through the
 * clone-local `info/exclude`, never the committed `.gitignore` (a project that
 * never turns sync on must not see a byte change there).
 */
function excludeTransientDirs(seen: KnowledgeInspection, git: KnowledgeGit): void {
  if (!seen.codeIsRepo) return;
  const rel = tryGit(git, ['rev-parse', '--git-path', 'info/exclude'], seen.root);
  if (rel === null) return;
  const path = resolve(seen.root, rel.trim());
  const wanted = [`/${KNOWLEDGE_STAGING_PREFIX}*`, `/${KNOWLEDGE_RETIRED_PREFIX}*`];
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const missing = wanted.filter((line) => !existing.split('\n').includes(line));
  if (missing.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
  writeFileSync(path, `${prefix}${missing.join('\n')}\n`, 'utf-8');
}

/** Which identity keys git cannot find for a commit made in `cwd`. */
function missingIdentity(git: KnowledgeGit, cwd: string): string[] {
  const missing: string[] = [];
  const name = process.env.GIT_AUTHOR_NAME ?? tryGit(git, ['config', '--get', 'user.name'], cwd)?.trim();
  const email = process.env.GIT_AUTHOR_EMAIL ?? tryGit(git, ['config', '--get', 'user.email'], cwd)?.trim();
  if (name === undefined || name.length === 0) missing.push('user.name');
  if (email === undefined || email.length === 0) missing.push('user.email');
  return missing;
}

/** A commit as the payload reports it. */
export interface KnowledgeCommit {
  sha: string;
  message: string;
  files: number;
}

function describeHead(git: KnowledgeGit, cwd: string, message: string): KnowledgeCommit {
  const sha = git(['rev-parse', 'HEAD'], cwd).trim();
  const files = lines(tryGit(git, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'], cwd)).length;
  return { sha, message, files };
}

/** Commit what is staged — WITHOUT ever letting git invent an author. */
function commitStaged(git: KnowledgeGit, cwd: string, message: string): void {
  git(['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', message], cwd);
}

/** True when the index differs from HEAD (or there is no HEAD and the index has entries). */
function hasStagedChanges(git: KnowledgeGit, cwd: string): boolean {
  return tryGit(git, ['diff', '--cached', '--quiet'], cwd) === null;
}

function linkType(): 'junction' | 'dir' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

/** Tracked files under `.claude/rules` in the code repo. */
function trackedRules(seen: KnowledgeInspection, git: KnowledgeGit): string[] {
  if (!seen.codeIsRepo) return [];
  return lines(tryGit(git, ['ls-files', '--', '.claude/rules'], seen.root));
}

/** What the code repo's side of a conversion did. */
export interface CodeRepoEffect {
  /** True only when this verb made a commit in the code repo. */
  committed: boolean;
  commit: KnowledgeCommit | null;
  /** Files changed and left UNCOMMITTED for the person to commit (repo-relative). */
  changed: string[];
  /** Rules the code repo still tracks although the knowledge repo now carries them. */
  rulesStillTracked: string[];
}

export interface KnowledgeEnableOptions {
  remote: string;
  branch?: string;
  /**
   * Delete `.flow-staging-*` / `.flow-retired-*` copies an interrupted run
   * left in the project root. Without it, their presence refuses.
   */
  cleanLeftovers?: boolean;
  platforms?: Platform[];
  deps?: Partial<KnowledgeDeps>;
}

export interface KnowledgeEnableResult {
  action: 'enable';
  status: 'enabled' | 'unchanged';
  /** The shape the project started in. */
  from: KnowledgeShape;
  shape: 'separate';
  remote: string;
  branch: string;
  pointer: BrainPointer;
  /** The knowledge repo's first commit (null when nothing new was committed). */
  knowledgeCommit: KnowledgeCommit | null;
  codeRepo: CodeRepoEffect;
  /** Vault start: the vault folder, left exactly as it was, as the backup. */
  vaultBackup: string | null;
  copied: CopyStats | null;
  verified: { files: number; preciousFiles: number; storesChecked: number } | null;
  workingSetsIgnored: string[];
  rulesCopied: boolean;
  /** Leftover copies deleted because the caller passed `cleanLeftovers`. */
  leftoversCleaned: string[];
  /** Always false: enabling never pushes. */
  pushed: false;
}

function gitignoreChange(result: { created: string[]; updated: string[] }): boolean {
  return result.created.length > 0 || result.updated.length > 0;
}

/** The refusal for an address the grammar turned down — never echoing a secret. */
function remoteRefusal(verdict: Extract<GitRemoteVerdict, { ok: false }>, raw: string): KnowledgeRefusal {
  const sentences: Record<GitRemoteRefusalReason, string> = {
    'invalid-remote': `that is not a git repository address (${verdict.detail}) — give its https://, ssh:// or user@host:path address`,
    'insecure-remote': `${verdict.detail} — give the repository's https:// or ssh:// address`,
    'credentials-in-url': `${verdict.detail} — give the plain address; signing in is handled separately`,
  };
  return new KnowledgeRefusal(verdict.reason, sentences[verdict.reason], {
    remote: redactRemote(raw),
    accepted: ACCEPTED_REMOTE_FORMS,
  });
}

/** The branch as given, or the refusal that says why git would not take it. */
function validBranchOrRefuse(raw: string): string {
  const verdict = parseKnowledgeBranch(raw);
  if (!verdict.ok) {
    throw new KnowledgeRefusal('invalid-branch', `that is not a usable branch name (${verdict.detail})`, { branch: raw });
  }
  return verdict.branch;
}

/**
 * Leftovers refuse unless the caller asked for them to go. They are copies an
 * interrupted run made — the knowledge itself is in `flow/` or the vault — so
 * deleting them on request loses nothing. Returns what was deleted.
 */
function settleLeftovers(root: string, clean: boolean): string[] {
  const leftovers = knowledgeLeftovers(root);
  if (leftovers.length === 0) return [];
  if (!clean) {
    throw new KnowledgeRefusal(
      'leftovers',
      `an earlier attempt was interrupted and left ${leftovers.length} spare cop${leftovers.length === 1 ? 'y' : 'ies'} beside the project — clear them, then try again`,
      { leftovers }
    );
  }
  for (const name of leftovers) rmSync(join(root, name), { recursive: true, force: true });
  return leftovers;
}

/**
 * Turn knowledge sync ON: make `flow/` its own git repo with an origin on any git host,
 * and record the pointer in the code repo's committed plan-flow block.
 *
 * From each starting shape:
 *  - vault    — the vault folder is COPIED to a staging dir in the project,
 *               verified, made a repo there, and only then swapped in for the
 *               symlink. The vault folder is never touched: it is the backup.
 *  - shared   — refused on a dirty code tree; otherwise the repo is made in
 *               place and the code repo stops tracking `flow/` (and the rules
 *               now synced in it) in ONE commit.
 *  - local    — made in place (an existing `.git` with no origin is reused).
 *  - none     — `flow/` is scaffolded, then made a repo.
 * The code repo's `.gitignore` is committed only in the shared case; elsewhere
 * it is reported as changed for the person to commit. Never pushes.
 */
export function enableKnowledgeSync(target: string, options: KnowledgeEnableOptions): KnowledgeEnableResult {
  const deps: KnowledgeDeps = { ...DEFAULT_KNOWLEDGE_DEPS, ...options.deps };
  const { git } = deps;
  const platforms = options.platforms ?? ['claude'];
  const root = resolve(target);

  const rawRemote = (options.remote ?? '').trim();
  const verdict = parseGitRemote(rawRemote);
  if (!verdict.ok) throw remoteRefusal(verdict, rawRemote);
  const branch = validBranchOrRefuse((options.branch ?? DEFAULT_KNOWLEDGE_BRANCH).trim());
  const pointer: BrainPointer = { url: verdict.url, branch };

  const seen = inspectKnowledge(root, git);

  if (seen.shape === 'separate') {
    const current = originOf(git, seen.flowDir) ?? readBrainPointer(root)?.url ?? null;
    if (current !== null && sameRemoteRepo(current, verdict.url)) {
      return {
        action: 'enable',
        status: 'unchanged',
        from: 'separate',
        shape: 'separate',
        remote: redactRemote(current),
        branch: tryGit(git, ['symbolic-ref', '--short', '-q', 'HEAD'], seen.flowDir)?.trim() || branch,
        pointer: printablePointer(readBrainPointer(root)) ?? pointer,
        knowledgeCommit: null,
        codeRepo: { committed: false, commit: null, changed: [], rulesStillTracked: [] },
        vaultBackup: null,
        copied: null,
        verified: null,
        workingSetsIgnored: [],
        rulesCopied: false,
        leftoversCleaned: [],
        pushed: false,
      };
    }
    const shown = printableRemote(current);
    throw new KnowledgeRefusal('already-enabled', `knowledge already syncs with ${shown ?? 'another repository'}`, {
      remote: shown,
      requested: verdict.url,
    });
  }

  const committedPointer = readBrainPointer(root);
  if (keepsOwnKnowledgeRepo(root) && committedPointer !== null) {
    throw new KnowledgeRefusal(
      'clone-pending',
      `this project already names a knowledge repo (${redactRemote(committedPointer.url)}) — it is cloned into flow/, not started again`,
      { pointer: printablePointer(committedPointer), shape: seen.shape }
    );
  }
  if (seen.shape === 'vault' && seen.vaultPath === null) {
    throw new KnowledgeRefusal('flow-unreadable', 'flow/ links to a folder that is not there', {
      linkTarget: seen.linkTarget,
    });
  }
  const sourceDir = seen.shape === 'vault' ? (seen.vaultPath as string) : seen.flowDir;
  if (seen.hasRepo) {
    const origin = originOf(git, sourceDir);
    if (origin !== null && !sameRemoteRepo(origin, verdict.url)) {
      throw new KnowledgeRefusal('other-remote', `flow/ already has its own repository, pointing at ${redactRemote(origin)}`, {
        remote: redactRemote(origin),
        requested: verdict.url,
      });
    }
  }
  if (seen.shape === 'shared') {
    const dirty = dirtyCodeFiles(seen, git);
    if (dirty.length > 0) {
      throw new KnowledgeRefusal(
        'dirty-code',
        `the code repo has ${dirty.length} uncommitted change(s) — commit or put them aside first, so the one commit this makes holds only the switch`,
        { dirtyCode: dirty }
      );
    }
  }

  const leftoversCleaned = settleLeftovers(root, options.cleanLeftovers === true);

  excludeTransientDirs(seen, git);

  const rollback = new Rollback();
  let step: KnowledgeStep = 'prepare';
  const at = (name: KnowledgeStep): void => {
    step = name;
    deps.checkpoint(name);
  };

  let knowledgeDir = seen.flowDir;
  let staging: string | null = null;
  let copied: CopyStats | null = null;
  let verified: KnowledgeEnableResult['verified'] = null;
  let knowledgeCommit: KnowledgeCommit | null = null;
  let workingSetsIgnored: string[] = [];
  let rulesCopied = false;
  const codeRepo: CodeRepoEffect = { committed: false, commit: null, changed: [], rulesStillTracked: [] };

  try {
    at('prepare');
    if (seen.shape === 'vault') {
      const stagingDir = join(root, `${KNOWLEDGE_STAGING_PREFIX}${deps.random()}`);
      staging = stagingDir;
      rollback.push(() => rmSync(stagingDir, { recursive: true, force: true }));
      copied = deps.copyTree(sourceDir, stagingDir);
      const report = deps.verify(sourceDir, stagingDir);
      if (!report.ok) {
        throw new KnowledgeRefusal('verification-failed', 'the copy of the vault folder did not match it, so nothing was changed', {
          failures: report.failures.slice(0, 20),
          failureCount: report.failures.length,
        });
      }
      verified = { files: report.files, preciousFiles: report.preciousFiles, storesChecked: report.storesChecked };
      knowledgeDir = stagingDir;
    } else if (seen.shape === 'none') {
      const flowDir = seen.flowDir;
      rollback.push(() => rmSync(flowDir, { recursive: true, force: true }));
      for (const subdir of FLOW_SUBDIRS) {
        mkdirSync(join(flowDir, subdir), { recursive: true });
        writeFileSync(join(flowDir, subdir, '.gitkeep'), '', 'utf-8');
      }
    }

    at('init');
    const repoExisted = existsSync(join(knowledgeDir, '.git'));
    if (!repoExisted) {
      const dir = knowledgeDir;
      rollback.push(() => rmSync(join(dir, '.git'), { recursive: true, force: true }));
      git(knowledgeInitArgs(branch), knowledgeDir);
    }

    at('identity');
    const missing = missingIdentity(git, knowledgeDir);
    if (missing.length > 0) {
      throw new KnowledgeRefusal(
        'no-git-identity',
        'git has no name and email for you on this machine, and a commit needs an author — set them in git, then try again',
        { missing }
      );
    }

    at('remote');
    const origin = originOf(git, knowledgeDir);
    if (origin === null) {
      git(['remote', 'add', '--', 'origin', verdict.url], knowledgeDir);
      if (repoExisted) {
        const dir = knowledgeDir;
        rollback.push(() => git(['remote', 'remove', 'origin'], dir));
      }
    } else if (!sameRemoteRepo(origin, verdict.url)) {
      throw new KnowledgeRefusal('other-remote', `flow/ already has its own repository, pointing at ${redactRemote(origin)}`, {
        remote: redactRemote(origin),
        requested: verdict.url,
      });
    }

    at('files');
    for (const path of [
      join(knowledgeDir, '.gitignore'),
      join(knowledgeDir, '.gitattributes'),
      join(knowledgeDir, 'brain', 'features', '.gitignore'),
      join(knowledgeDir, '.flowconfig'),
    ]) {
      rollback.push(snapshotFile(path));
    }
    const rulesDir = join(knowledgeDir, 'rules');
    const rulesExisted = existsSync(rulesDir);
    rollback.push(() => {
      if (!rulesExisted) rmSync(rulesDir, { recursive: true, force: true });
    });
    rulesCopied = copyRulesIntoKnowledge(root, knowledgeDir);
    workingSetsIgnored = writeKnowledgeRepoFiles(knowledgeDir);
    // The local setting must agree with the committed block: `readShareMode`
    // reads `.flowconfig` FIRST, so a leftover `share: local` from the vault
    // would make the next provision regenerate a `local` block — and drop the
    // pointer that keeps provisioning away from this repo.
    upsertFlowconfigKey(knowledgeDir, 'share', 'separate');

    at('commit');
    const previousHead = repoExisted ? tryGit(git, ['rev-parse', '--verify', '-q', 'HEAD'], knowledgeDir)?.trim() ?? null : null;
    if (repoExisted) {
      const dir = knowledgeDir;
      rollback.push(() => {
        if (previousHead !== null) {
          git(['reset', '-q', '--soft', previousHead], dir);
          git(['reset', '-q'], dir);
        } else {
          tryGit(git, ['update-ref', '-d', 'HEAD'], dir);
          git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '.'], dir);
        }
      });
    }
    git(['add', '-A'], knowledgeDir);
    if (hasStagedChanges(git, knowledgeDir)) {
      commitStaged(git, knowledgeDir, KNOWLEDGE_FIRST_COMMIT);
      knowledgeCommit = describeHead(git, knowledgeDir, KNOWLEDGE_FIRST_COMMIT);
    }

    if (seen.shape === 'vault' && staging !== null) {
      at('swap');
      const stagingDir = staging;
      const flowDir = seen.flowDir;
      const linkTarget = seen.linkTarget as string;
      unlinkSync(flowDir); // the LINK only — the vault folder is untouched
      rollback.push(() => {
        if (!existsSync(flowDir) && !isLink(flowDir)) symlinkSync(linkTarget, flowDir, linkType());
      });
      renameSync(stagingDir, flowDir);
      rollback.push(() => {
        if (!isLink(flowDir) && existsSync(flowDir) && !existsSync(stagingDir)) renameSync(flowDir, stagingDir);
      });
    }

    at('code-ignore');
    rollback.push(snapshotFile(join(root, '.gitignore')));
    const ignoreResult = updateGitignore(root, platforms, { force: false }, 'separate', pointer);
    const ignoreChanged = gitignoreChange(ignoreResult);

    if (seen.shape === 'shared') {
      at('code-untrack');
      rollback.push(() => {
        tryGit(git, ['reset', '-q', '--', 'flow', '.claude/rules', '.gitignore'], root);
      });
      git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', 'flow'], root);
      git(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.claude/rules'], root);

      at('code-commit');
      git(['add', '--', '.gitignore'], root);
      commitStaged(git, root, CODE_UNTRACK_COMMIT);
      codeRepo.committed = true;
      codeRepo.commit = describeHead(git, root, CODE_UNTRACK_COMMIT);
    } else {
      codeRepo.changed = ignoreChanged ? ['.gitignore'] : [];
      codeRepo.rulesStillTracked = trackedRules(seen, git);
    }
  } catch (error) {
    const problems = rollback.run();
    const restored = { restored: problems.length === 0, restoreProblems: problems, step, shape: seen.shape };
    if (error instanceof KnowledgeRefusal) {
      throw new KnowledgeRefusal(error.reason, error.sentence, { ...error.payload, ...restored });
    }
    throw new KnowledgeRefusal(
      'failed',
      problems.length === 0
        ? `step '${step}' failed (${errorText(error)}) — everything was put back as it was`
        : `step '${step}' failed (${errorText(error)}) and the project could not be fully put back: ${problems.join('; ')}`,
      restored
    );
  }

  return {
    action: 'enable',
    status: 'enabled',
    from: seen.shape,
    shape: 'separate',
    remote: verdict.url,
    branch,
    pointer,
    knowledgeCommit,
    codeRepo,
    vaultBackup: seen.shape === 'vault' ? seen.vaultPath : null,
    copied,
    verified,
    workingSetsIgnored,
    rulesCopied,
    leftoversCleaned,
    pushed: false,
  };
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where `disable` takes the knowledge. */
export const KNOWLEDGE_DISABLE_DESTINATIONS = ['keep', 'vault', 'shared'] as const;
export type KnowledgeDisableDestination = (typeof KNOWLEDGE_DISABLE_DESTINATIONS)[number];

export function isKnowledgeDisableDestination(value: string): value is KnowledgeDisableDestination {
  return (KNOWLEDGE_DISABLE_DESTINATIONS as readonly string[]).includes(value);
}

export interface KnowledgeDisableOptions {
  to: string;
  /** Go ahead although the remote is missing commits (they stay in the kept history). */
  acceptUnpushed?: boolean;
  /**
   * `vault` and `shared` remove the project's `flow/.git` (after keeping a
   * verified copy). They do nothing without this — the caller says out loud
   * that a person asked (forbidden-pattern #15). The CLI passes it: the typed
   * `disable --to …` IS the confirmation.
   */
  confirmed?: boolean;
  platforms?: Platform[];
  deps?: Partial<KnowledgeDeps>;
}

export interface KnowledgeDisableResult {
  action: 'disable';
  to: KnowledgeDisableDestination;
  status: 'disabled';
  /** The shape the project is in now. */
  shape: KnowledgeShape;
  /** The remote that was configured, and the pointer that was removed. */
  previousRemote: string | null;
  unpushed: number;
  /** Where the knowledge repo's history now lives (`.git` itself for keep). */
  knowledgeRepoKeptAt: string;
  /** vault: the vault folder `flow/` now links to. */
  vaultPath: string | null;
  /** vault: an older vault copy moved aside rather than replaced. */
  vaultBackup: string | null;
  codeRepo: CodeRepoEffect;
  copied: CopyStats | null;
  /** A leftover the verb could not remove (verified copies exist elsewhere). */
  leftover: string | null;
}

function vaultFlowPathFor(root: string): string {
  return join(getVaultDir(), 'projects', getProjectName(root), 'flow');
}

/** Copy a knowledge repo's `.git` out beside the vault copy and verify it. */
function keepHistory(
  deps: KnowledgeDeps,
  flowDir: string,
  root: string,
  stamp: string,
  rollback: Rollback
): { path: string; stats: CopyStats } {
  const keptAt = join(dirname(vaultFlowPathFor(root)), `${KEPT_KNOWLEDGE_REPO_PREFIX}${stamp}.git`);
  if (existsSync(keptAt)) throw new Error(`${keptAt} already exists`);
  mkdirSync(dirname(keptAt), { recursive: true });
  rollback.push(() => rmSync(keptAt, { recursive: true, force: true }));
  const stats = deps.copyTree(join(flowDir, '.git'), keptAt);
  const report = deps.verify(join(flowDir, '.git'), keptAt);
  if (!report.ok) {
    throw new KnowledgeRefusal('verification-failed', "the copy of the knowledge repo's history did not match it, so nothing was changed", {
      failures: report.failures.slice(0, 20),
      failureCount: report.failures.length,
    });
  }
  return { path: keptAt, stats };
}

/**
 * Turn knowledge sync OFF.
 *
 *  - keep   — the remote and the code repo's pointer go; `flow/` and its `.git`
 *             stay exactly where they are (the project reads as `local`).
 *  - vault  — `flow/`'s working tree (without `.git`) is copied into the vault
 *             and verified; the `.git` is copied, verified, and KEPT beside it
 *             as `knowledge-repo-<date>.git`; an existing vault copy is moved
 *             aside as `flow.backup-<date>`; then `flow/` becomes the link.
 *             The project's own folder is deleted only after both copies have
 *             verified byte-for-byte — that is the one deletion, and it is of
 *             something that exists twice elsewhere.
 *  - shared — the `.git` is kept the same way, then `convertToSame` folds
 *             `flow/` back into the code repo, in ONE code-repo commit.
 *
 * Refused while the remote is missing commits (all of them, when there is no
 * remote-tracking ref) unless `acceptUnpushed` — and even then the history is
 * kept, never dropped.
 */
export function disableKnowledgeSync(target: string, options: KnowledgeDisableOptions): KnowledgeDisableResult {
  const deps: KnowledgeDeps = { ...DEFAULT_KNOWLEDGE_DEPS, ...options.deps };
  const { git } = deps;
  const platforms = options.platforms ?? ['claude'];
  const root = resolve(target);
  const to = (options.to ?? '').trim();

  if (!isKnowledgeDisableDestination(to)) {
    throw new KnowledgeRefusal('invalid-destination', `say where the knowledge goes: ${KNOWLEDGE_DISABLE_DESTINATIONS.join(', ')}`, {
      to: to.length > 0 ? to : null,
      allowed: [...KNOWLEDGE_DISABLE_DESTINATIONS],
    });
  }

  const seen = inspectKnowledge(root, git);
  if (seen.shape !== 'separate') {
    throw new KnowledgeRefusal('not-enabled', 'knowledge sync is not on for this project', { shape: seen.shape });
  }
  const flowDir = seen.flowDir;
  const previousRemote = originOf(git, flowDir);
  const conflicted = lines(tryGit(git, ['diff', '--name-only', '--diff-filter=U'], flowDir));
  if (conflicted.length > 0) {
    throw new KnowledgeRefusal('conflicted', 'the knowledge repo is in the middle of a merge — settle it first', { conflicted });
  }
  const pending = unpushedCount(flowDir, git);
  if (pending.count > 0 && options.acceptUnpushed !== true) {
    throw new KnowledgeRefusal(
      'unpushed',
      `${pending.count} knowledge commit(s) are not on the remote yet — sync first, or go ahead knowing they stay only on this machine`,
      { unpushed: pending.count, hasUpstream: pending.hasUpstream, remote: printableRemote(previousRemote) }
    );
  }
  if ((to === 'vault' || to === 'shared') && options.confirmed !== true) {
    throw new KnowledgeRefusal('unconfirmed', `turning sync off into '${to}' replaces flow/'s own repository and needs an explicit confirmation`, {
      to,
    });
  }
  if (to === 'shared') {
    if (!seen.codeIsRepo) {
      throw new KnowledgeRefusal('not-a-git-repo', 'the project is not a git repository, so it cannot track the knowledge', {});
    }
    const dirty = dirtyCodeFiles(seen, git);
    if (dirty.length > 0) {
      throw new KnowledgeRefusal(
        'dirty-code',
        `the code repo has ${dirty.length} uncommitted change(s) — commit or put them aside first, so the one commit this makes holds only the switch`,
        { dirtyCode: dirty }
      );
    }
  }

  excludeTransientDirs(seen, git);
  const stamp = backupStamp(deps.now());
  const rollback = new Rollback();
  let step: KnowledgeStep = 'prepare';
  const at = (name: KnowledgeStep): void => {
    step = name;
    deps.checkpoint(name);
  };
  const codeRepo: CodeRepoEffect = { committed: false, commit: null, changed: [], rulesStillTracked: [] };
  let knowledgeRepoKeptAt = join(flowDir, '.git');
  let vaultPath: string | null = null;
  let vaultBackup: string | null = null;
  let copied: CopyStats | null = null;
  let retired: string | null = null;
  let shape: KnowledgeShape = 'local';

  try {
    if (to === 'keep') {
      at('remote-remove');
      if (previousRemote !== null) {
        git(['remote', 'remove', 'origin'], flowDir);
        rollback.push(() => git(['remote', 'add', '--', 'origin', previousRemote], flowDir));
      }
      at('code-ignore');
      rollback.push(snapshotFile(join(flowDir, '.flowconfig')));
      rollback.push(snapshotFile(join(root, '.gitignore')));
      upsertFlowconfigKey(flowDir, 'share', 'local');
      if (gitignoreChange(updateGitignore(root, platforms, { force: false }, 'local'))) codeRepo.changed = ['.gitignore'];
      shape = 'local';
    } else if (to === 'vault') {
      const vaultFlow = vaultFlowPathFor(root);
      const stagingDir = join(dirname(vaultFlow), `${KNOWLEDGE_STAGING_PREFIX}${deps.random()}`);

      at('copy');
      mkdirSync(dirname(vaultFlow), { recursive: true });
      rollback.push(() => rmSync(stagingDir, { recursive: true, force: true }));
      copied = deps.copyTree(flowDir, stagingDir, ['.git']);
      const report = deps.verify(flowDir, stagingDir, '', ['.git']);
      if (!report.ok) {
        throw new KnowledgeRefusal('verification-failed', 'the copy of flow/ did not match it, so nothing was changed', {
          failures: report.failures.slice(0, 20),
          failureCount: report.failures.length,
        });
      }
      upsertFlowconfigKey(stagingDir, 'share', 'local');

      at('keep-history');
      knowledgeRepoKeptAt = keepHistory(deps, flowDir, root, stamp, rollback).path;

      at('backup-aside');
      // Anything at the vault path — a backup from enable, a link, a folder —
      // is moved aside whole. Never merged into, never deleted.
      if (isLink(vaultFlow) || existsSync(vaultFlow)) {
        const aside = join(dirname(vaultFlow), `${VAULT_FLOW_BACKUP_PREFIX}${stamp}`);
        if (existsSync(aside)) throw new Error(`${aside} already exists`);
        renameSync(vaultFlow, aside);
        vaultBackup = aside;
        rollback.push(() => renameSync(aside, vaultFlow));
      }

      at('install');
      renameSync(stagingDir, vaultFlow);
      rollback.push(() => renameSync(vaultFlow, stagingDir));

      at('retire');
      const retiredDir = join(root, `${KNOWLEDGE_RETIRED_PREFIX}${deps.random()}`);
      renameSync(flowDir, retiredDir);
      rollback.push(() => renameSync(retiredDir, flowDir));
      retired = retiredDir;

      at('link');
      symlinkSync(vaultFlow, flowDir, linkType());
      rollback.push(() => unlinkSync(flowDir));

      at('code-ignore');
      rollback.push(snapshotFile(join(root, '.gitignore')));
      if (gitignoreChange(updateGitignore(root, platforms, { force: false }, 'local'))) codeRepo.changed = ['.gitignore'];
      vaultPath = vaultFlow;
      shape = 'vault';
    } else {
      at('keep-history');
      knowledgeRepoKeptAt = keepHistory(deps, flowDir, root, stamp, rollback).path;

      at('convert');
      const restoreGit = (): void => {
        if (!existsSync(join(flowDir, '.git'))) deps.copyTree(knowledgeRepoKeptAt, join(flowDir, '.git'));
      };
      const rulesInFlow = join(flowDir, 'rules');
      const rulesBackup = join(dirname(knowledgeRepoKeptAt), `.rules-${stamp}-${deps.random()}`);
      if (existsSync(rulesInFlow)) {
        deps.copyTree(rulesInFlow, rulesBackup);
        rollback.push(() => rmSync(rulesBackup, { recursive: true, force: true }));
      }
      rollback.push(snapshotFile(join(flowDir, '.gitignore')));
      rollback.push(snapshotFile(join(flowDir, '.flowconfig')));
      rollback.push(snapshotFile(join(root, '.gitignore')));
      rollback.push(snapshotFile(join(root, '.gitattributes')));
      rollback.push(() => {
        if (existsSync(rulesBackup) && !existsSync(rulesInFlow)) deps.copyTree(rulesBackup, rulesInFlow);
      });
      rollback.push(restoreGit);
      const converted = convertToSame(root, platforms, 'shared');
      if (!converted.ok) throw new Error(converted.error ?? 'could not fold flow/ back into the code repo');
      upsertFlowconfigKey(flowDir, 'share', 'shared');
      updateGitattributes(root);
      updateWorkingSetIgnore(root);
      retired = existsSync(rulesBackup) ? rulesBackup : null; // removed once the commit lands

      at('code-track');
      // A line the person wrote OUTSIDE the generated block can still ignore
      // flow/, and no regeneration of the block can lift it. Say which line,
      // rather than relaying git's paragraph about `-f`.
      const ignoredBy = tryGit(git, ['check-ignore', '-v', '--no-index', 'flow'], root);
      if (ignoredBy !== null && ignoredBy.trim().length > 0) {
        const source = ignoredBy.split('\t')[0]?.trim() ?? '';
        throw new KnowledgeRefusal(
          'flow-ignored',
          `a line in the code repo's ignore rules still keeps flow/ out of git (${source}) — remove it, then try again`,
          { ignoredBy: source }
        );
      }
      const paths = ['.gitignore', '.gitattributes', 'flow', '.claude/rules'].filter((path) => existsSync(join(root, path)));
      rollback.push(() => {
        tryGit(git, ['reset', '-q', '--', ...paths], root);
      });
      git(['add', '-A', '--', ...paths], root);

      at('code-commit');
      commitStaged(git, root, CODE_RETRACK_COMMIT);
      codeRepo.committed = true;
      codeRepo.commit = describeHead(git, root, CODE_RETRACK_COMMIT);
      shape = 'shared';
    }
  } catch (error) {
    const problems = rollback.run();
    const restored = { restored: problems.length === 0, restoreProblems: problems, step, to };
    if (error instanceof KnowledgeRefusal) {
      throw new KnowledgeRefusal(error.reason, error.sentence, { ...error.payload, ...restored });
    }
    throw new KnowledgeRefusal(
      'failed',
      problems.length === 0
        ? `step '${step}' failed (${errorText(error)}) — everything was put back as it was`
        : `step '${step}' failed (${errorText(error)}) and the project could not be fully put back: ${problems.join('; ')}`,
      restored
    );
  }

  // The one deletion (vault): the project's own folder, whose working tree and
  // history were each copied and verified above. (shared: only the scratch
  // copy of `rules/` kept for the rollback.) A failure here costs a leftover
  // folder, never knowledge.
  let leftover: string | null = null;
  if (retired !== null) {
    try {
      rmSync(retired, { recursive: true, force: true });
    } catch {
      leftover = retired;
    }
  }

  return {
    action: 'disable',
    to,
    status: 'disabled',
    shape,
    previousRemote: printableRemote(previousRemote),
    unpushed: pending.count,
    knowledgeRepoKeptAt,
    vaultPath,
    vaultBackup,
    codeRepo,
    copied,
    leftover,
  };
}

// ── adopt: a machine still linked to the vault takes up the knowledge repo ────
//
// Another machine turned sync on and committed the pointer; this one still has
// `flow/` linked into its vault (`vault-pending`). Provisioning leaves that
// alone on purpose — adopting needs the network and may meet knowledge only
// this machine has, so a person starts it. Nothing here commits or pushes: the
// files this machine adds show up as changes for the app's sync to commit.

export interface KnowledgeAdoptOptions {
  deps?: Partial<KnowledgeDeps>;
}

/** A file both sides had, with different content. The clone's stays; the vault's sits beside it. */
export interface KnowledgeAdoptConflict {
  /** Flow-relative path holding the knowledge repo's version. */
  path: string;
  /** Flow-relative path the vault's version was written to. */
  besidePath: string;
}

export interface KnowledgeAdoptResult {
  action: 'adopt';
  status: 'adopted';
  shape: 'separate';
  /** The knowledge repo's address (credentials masked — there are none: the grammar refuses them). */
  remote: string;
  /** The branch checked out. */
  branch: string | null;
  /** The commit the clone arrived at. */
  head: string;
  /** The vault folder `flow/` linked to — left exactly as it was. */
  vaultPath: string;
  /** A verified copy of that folder, taken first. Never deleted. */
  vaultBackup: string;
  /** Files only this machine's vault had, copied into the clone (flow-relative). */
  copiedFromVault: string[];
  /** Files both had with different content: nothing silently lost. */
  keptBeside: KnowledgeAdoptConflict[];
  /** Always false: adopting never commits — the sync does. */
  committed: false;
  /** Always false: adopting never pushes. */
  pushed: false;
}

/** `ledger.md` → `ledger.from-vault.md`, numbered when that name is taken. */
function besideName(dir: string, name: string): string {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = `${base}${FROM_VAULT_MARK}${ext}`;
  for (let n = 2; existsSync(join(dir, candidate)) || isLink(join(dir, candidate)); n += 1) {
    candidate = `${base}${FROM_VAULT_MARK}-${n}${ext}`;
  }
  return candidate;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Bring the vault's knowledge into the clone WITHOUT overwriting anything the
 * clone has: a file only the vault has is copied in; a file both have with
 * different bytes keeps the clone's version and gets the vault's written
 * beside it. The vault is only ever read.
 */
function mergeVaultIntoClone(
  source: string,
  dest: string,
  prefix: string,
  out: { copied: string[]; beside: KnowledgeAdoptConflict[] }
): void {
  for (const entry of readdirSync(source).sort()) {
    if (prefix === '' && entry === '.git') continue;
    const rel = `${prefix}${entry}`;
    const from = join(source, entry);
    const info = lstatSync(from);
    let to = join(dest, entry);
    const there = lstatOrNull(to);

    if (info.isSymbolicLink()) {
      if (there === null) {
        symlinkSync(readlinkSync(from), to);
        out.copied.push(rel);
      }
      continue;
    }
    if (info.isDirectory()) {
      if (there !== null && !there.isDirectory()) {
        const name = besideName(dest, entry);
        out.beside.push({ path: rel, besidePath: `${prefix}${name}` });
        to = join(dest, name);
        mkdirSync(to);
        mergeVaultIntoClone(from, to, `${prefix}${name}/`, { copied: [], beside: [] });
        continue;
      }
      if (there === null) mkdirSync(to);
      mergeVaultIntoClone(from, to, `${rel}/`, out);
      continue;
    }
    if (!info.isFile()) continue;
    if (there === null) {
      copyFileSync(from, to);
      out.copied.push(rel);
      continue;
    }
    if (there.isFile() && hashFile(from) === hashFile(to)) continue;
    const name = besideName(dest, entry);
    copyFileSync(from, join(dest, name));
    out.beside.push({ path: rel, besidePath: `${prefix}${name}` });
  }
}

/**
 * Adopt the knowledge repo the committed pointer names, on a machine whose
 * `flow/` is still a vault link.
 *
 *   1. BACKUP — the vault folder is copied beside itself and verified
 *               (`flow.before-adopt-<date>`, never deleted).
 *   2. CLONE  — the pointer, validated by the address grammar, is cloned into
 *               a staging folder in the project (`--` before the address).
 *   3. MERGE  — vault-only files are copied in; a file both have with
 *               different content keeps the clone's, the vault's beside it.
 *   4. SWAP   — only now is the link removed and the clone put in its place.
 *
 * A failure at any step puts everything back: the link is never removed
 * before the clone exists, so a failed clone leaves the project exactly as it
 * was. Never commits, never pushes.
 */
export function adoptKnowledgeRepo(target: string, options: KnowledgeAdoptOptions = {}): KnowledgeAdoptResult {
  const deps: KnowledgeDeps = { ...DEFAULT_KNOWLEDGE_DEPS, ...options.deps };
  const { git } = deps;
  const root = resolve(target);
  const seen = inspectKnowledge(root, git);

  if (seen.shape !== 'vault-pending') {
    throw new KnowledgeRefusal(
      'nothing-to-adopt',
      seen.shape === 'separate'
        ? 'this machine already keeps the knowledge in its own repository'
        : 'this project does not name a knowledge repository for this machine to take up',
      { shape: seen.shape }
    );
  }
  if (seen.vaultPath === null || seen.linkTarget === null) {
    throw new KnowledgeRefusal('flow-unreadable', 'flow/ links to a folder that is not there', { linkTarget: seen.linkTarget });
  }
  const pointer = readBrainPointer(root);
  if (pointer === null) {
    throw new KnowledgeRefusal('nothing-to-adopt', 'this project does not name a knowledge repository', { shape: seen.shape });
  }
  // The pointer is read from a COMMITTED file: anyone who can land a commit
  // wrote it. It reaches git only through the grammar, and only after `--`.
  const address = parseGitRemote(pointer.url);
  if (!address.ok) {
    throw new KnowledgeRefusal(
      address.reason,
      `the knowledge repository this project names is not a usable address (${address.detail}), so nothing was cloned`,
      { remote: redactRemote(pointer.url), accepted: ACCEPTED_REMOTE_FORMS }
    );
  }
  const branch = pointer.branch === undefined ? null : validBranchOrRefuse(pointer.branch);

  excludeTransientDirs(seen, git);
  const vaultPath = seen.vaultPath;
  const linkTarget = seen.linkTarget;
  const flowDir = seen.flowDir;
  const vaultBackup = join(dirname(vaultPath), `${VAULT_ADOPT_BACKUP_PREFIX}${backupStamp(deps.now())}`);
  const staging = join(root, `${KNOWLEDGE_STAGING_PREFIX}${deps.random()}`);
  const merged = { copied: [] as string[], beside: [] as KnowledgeAdoptConflict[] };
  const rollback = new Rollback();
  let step: KnowledgeStep = 'prepare';
  const at = (name: KnowledgeStep): void => {
    step = name;
    deps.checkpoint(name);
  };
  let head = '';
  let checkedOut: string | null = branch;

  try {
    at('backup');
    if (existsSync(vaultBackup) || isLink(vaultBackup)) throw new Error(`${vaultBackup} already exists`);
    // Rolled back only on failure, when the vault itself was never touched.
    rollback.push(() => rmSync(vaultBackup, { recursive: true, force: true }));
    deps.copyTree(vaultPath, vaultBackup);
    const report = deps.verify(vaultPath, vaultBackup);
    if (!report.ok) {
      throw new KnowledgeRefusal('verification-failed', 'the backup of the vault folder did not match it, so nothing was changed', {
        failures: report.failures.slice(0, 20),
        failureCount: report.failures.length,
      });
    }

    at('clone');
    rollback.push(() => rmSync(staging, { recursive: true, force: true }));
    try {
      git(['clone', '-q', ...(branch === null ? [] : ['--branch', branch]), '--', address.url, staging], root);
    } catch (error) {
      throw new KnowledgeRefusal(
        'clone-failed',
        `the knowledge repository could not be cloned (${errorText(error)}) — nothing on this machine was changed`,
        { remote: redactRemote(pointer.url) }
      );
    }
    head = git(['rev-parse', 'HEAD'], staging).trim();
    checkedOut = tryGit(git, ['symbolic-ref', '--short', '-q', 'HEAD'], staging)?.trim() || checkedOut;

    at('merge');
    mergeVaultIntoClone(vaultPath, staging, '', merged);
    // `readShareMode` reads `.flowconfig` FIRST: a `share: local` carried over
    // from the vault would make the next provision drop the pointer.
    upsertFlowconfigKey(staging, 'share', 'separate');

    at('swap');
    unlinkSync(flowDir); // the LINK only — the vault folder is untouched
    rollback.push(() => {
      if (!existsSync(flowDir) && !isLink(flowDir)) symlinkSync(linkTarget, flowDir, linkType());
    });
    renameSync(staging, flowDir);
    rollback.push(() => {
      if (!isLink(flowDir) && existsSync(flowDir) && !existsSync(staging)) renameSync(flowDir, staging);
    });
  } catch (error) {
    const problems = rollback.run();
    const restored = { restored: problems.length === 0, restoreProblems: problems, step, shape: seen.shape };
    if (error instanceof KnowledgeRefusal) {
      throw new KnowledgeRefusal(error.reason, error.sentence, { ...error.payload, ...restored });
    }
    throw new KnowledgeRefusal(
      'failed',
      problems.length === 0
        ? `step '${step}' failed (${errorText(error)}) — everything was put back as it was`
        : `step '${step}' failed (${errorText(error)}) and the project could not be fully put back: ${problems.join('; ')}`,
      restored
    );
  }

  return {
    action: 'adopt',
    status: 'adopted',
    shape: 'separate',
    remote: redactRemote(address.url),
    branch: checkedOut,
    head,
    vaultPath,
    vaultBackup,
    copiedFromVault: merged.copied,
    keptBeside: merged.beside,
    committed: false,
    pushed: false,
  };
}
