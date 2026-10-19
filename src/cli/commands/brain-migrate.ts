/**
 * `planflow-ai brain migrate [--target <dir>] [--dry-run]`
 *
 * Moves this project's knowledge out of the central vault and into the repo,
 * then points the vault at the repo so Obsidian keeps its one-graph view.
 *
 * The safety order (copy → verify → commit → repoint, nothing ever deleted)
 * lives in `migrateKnowledgeIntoRepo`, not here — this file only reports it.
 * Refusals print ONE `migrate refused:` line and exit 1, having changed nothing.
 */

import { resolve } from 'node:path';
import * as log from '../utils/logger.js';
import { migrateKnowledgeIntoRepo } from '../handlers/knowledge-migration.js';

export interface BrainMigrateOptions {
  target: string;
  dryRun?: boolean;
}

export function runBrainMigrate(options: BrainMigrateOptions): void {
  const target = resolve(options.target);
  const report = migrateKnowledgeIntoRepo(target, { dryRun: options.dryRun === true });

  if (report.status === 'refused') {
    log.error(`migrate refused: ${report.refusal}`);
    process.exitCode = 1;
    return;
  }

  if (report.status === 'already-migrated') {
    log.info('migrate: flow/ is already a real directory in this repo — nothing to move');
    return;
  }

  const copied = report.copied;
  const verified = report.verification;
  if (copied !== null) {
    log.success(
      `copied ${copied.files} file(s), ${copied.dirs} dir(s), ${copied.bytes} byte(s) from ${report.vaultFlowDir}`
    );
  }
  if (verified !== null) {
    log.success(
      `verified ${verified.files} file(s) — ${verified.preciousFiles} precious, ${verified.storesChecked} append-only store(s) entry-counted`
    );
  }

  if (report.status === 'verified-only') {
    log.info('migrate --dry-run: copy verified and discarded; nothing was repointed');
    return;
  }

  log.success(`repo now holds the knowledge: ${report.repoFlowDir}`);
  const normalized = report.normalizedInvestigations;
  if (normalized !== null && normalized.scanned > 0) {
    log.info(
      `investigations.jsonl: ${normalized.rewritten} entry(ies) made repo-relative, ${normalized.unchanged} byte-identical`
    );
  }
  if (report.gitattributes !== null) {
    log.info(`.gitattributes: union-merge rule for the append-only stores (${report.gitattributes})`);
  }
  if (report.workingSetsIgnored.length > 0) {
    log.info(
      `${report.workingSetsIgnored.length} auto-captured working set(s) kept out of git (personal session records)`
    );
  }
  if (report.vaultBackup !== null) {
    log.info(`vault contents preserved (nothing deleted): ${report.vaultBackup}`);
  }
  if (report.vaultLinked) {
    log.success(`vault now points at the repo: ${report.vaultFlowDir} → ${report.repoFlowDir}`);
  }
  if (report.refusal !== undefined) {
    log.warn(report.refusal);
  }
}
