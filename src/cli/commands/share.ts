/**
 * `planflow-ai share [local|shared]` — the two-way knowledge-sharing switch.
 *
 * This is the mechanism behind `/flow share=<mode>`. The skill MUST call it
 * rather than editing `.gitignore` by hand: the marker block is generated from
 * the setting on every provision, so a hand edit is not a fix, it is a bug
 * report about the config that the next `init` will silently undo.
 *
 * Switching only changes which paths are ignored. Nothing is moved, rewritten
 * or deleted in either direction (allowed-pattern #14: the invariant lives in
 * `applyShareMode`, not in prompt convention).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as log from '../utils/logger.js';
import { ShareModeRefusal, applyShareMode, readShareMode, resolveShareMode } from '../handlers/shared.js';
import type { ShareMode } from '../types.js';

/** How many changed paths to list before collapsing into a count. */
const SAMPLE_LIMIT = 10;

function printSample(label: string, files: string[]): void {
  if (files.length === 0) return;
  log.info(`${label}: ${files.length} file(s)`);
  for (const file of files.slice(0, SAMPLE_LIMIT)) {
    log.info(`    ${file}`);
  }
  if (files.length > SAMPLE_LIMIT) {
    log.info(`    ... and ${files.length - SAMPLE_LIMIT} more`);
  }
}

/** Flowconfig keys that carry a credential rather than a preference. */
const SECRET_CONFIG_KEYS = ['telegram_bot_token', 'webhook_url'];

/**
 * `flow/.flowconfig` is IGNORED in shared mode: it can hold a bot token or a
 * webhook URL, and a credential must never become trackable because someone
 * flipped a sharing switch. The team's mode still travels — the generated
 * `.gitignore` block states it in its own committed header, and `readShareMode`
 * reads it back from there.
 *
 * Say so out loud when the file actually carries a secret, so the reason the
 * config stays behind is visible rather than folklore.
 */
function reportConfigStaysLocal(target: string): void {
  const configPath = join(target, 'flow', '.flowconfig');
  if (!existsSync(configPath)) return;
  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch {
    return;
  }
  const present = SECRET_CONFIG_KEYS.filter((key) =>
    new RegExp(`^${key}:[ \\t]*\\S`, 'm').test(content)
  );
  if (present.length === 0) return;
  log.info(
    `flow/.flowconfig stays ignored (it carries ${present.join(', ')}) — the share mode travels in the .gitignore block instead`
  );
}

export interface ShareCommandOptions {
  target: string;
}

export function runShare(mode: string | undefined, options: ShareCommandOptions): void {
  const target = resolve(options.target);

  // No mode → report the current setting and stop.
  if (mode === undefined) {
    const persisted = readShareMode(target);
    const effective = resolveShareMode(target);
    log.info(
      persisted === null
        ? `share: ${effective} (unanswered — the default; nothing is published until it is answered)`
        : `share: ${effective}`
    );
    return;
  }

  if (mode !== 'local' && mode !== 'shared') {
    log.error(`share refused: unknown mode "${mode}" (expected local or shared)`);
    process.exitCode = 1;
    return;
  }

  let report: ReturnType<typeof applyShareMode>;
  try {
    report = applyShareMode(target, mode as ShareMode);
  } catch (error) {
    if (!(error instanceof ShareModeRefusal)) throw error;
    log.error(`share refused: ${error.reason} — ${error.sentence}`);
    process.exitCode = 1;
    return;
  }

  if (!report.changed) {
    // Still regenerated: the block is generated from the setting, so re-running
    // is how a hand-edited or missing block is put back.
    log.info(
      report.gitignore === 'unchanged'
        ? `share: already ${report.mode} — nothing to change`
        : `share: already ${report.mode} — .gitignore block ${report.gitignore}`
    );
    return;
  }

  log.success(`share: ${report.previous} → ${report.mode}`);
  printSample('now trackable', report.nowTrackable);
  printSample('now ignored (nothing deleted)', report.nowIgnored);
  log.info(`.gitignore: ${report.gitignore}`);
  if (report.mode === 'shared') {
    log.info(`.gitattributes: ${report.gitattributes}`);
    if (report.workingSetsIgnored.length > 0) {
      log.info(
        `${report.workingSetsIgnored.length} auto-captured working set(s) kept out of git (personal session records, not features)`
      );
    }
    reportConfigStaysLocal(target);
  }
}
