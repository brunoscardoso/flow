/**
 * Init Command - Installs plan-flow for Claude Code (the only supported platform)
 */

import { resolve } from 'node:path';
import type { InitOptions, Platform, InitResult, ShareMode } from '../types.js';
import * as log from '../utils/logger.js';
import { fileExists } from '../utils/files.js';
import { askShareMode } from '../utils/prompts.js';
import { initClaude } from '../handlers/claude.js';
import { initShared, readShareMode } from '../handlers/shared.js';
import { startHeartbeatIfNeeded } from './heartbeat.js';
import { ensureGraphify } from './graphify-rails.js';
import { ensurePlanflowOnPath } from './path-rails.js';
import { ensureGraphifyOutLocal } from '../blueprint/graphify-out-symlink.js';

function printBanner(): void {
  log.header('Plan-Flow Setup');
  log.info(
    'Structured AI-assisted development workflows for discovery, planning, execution, code reviews, and testing.'
  );
  log.blank();
  log.warn('⚠️  Make sure you are running this command from your project root directory!');
}

// Claude Code is the only platform (multi-IDE support removed 2026-07-22) —
// --all and --claude are kept as accepted flags for compatibility, both
// resolving to the same claude-only install.
function detectPlatforms(): Platform[] {
  return ['claude'];
}

function validateTarget(target: string): boolean {
  // Check for common project indicators
  const indicators = [
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'Gemfile',
    '.git',
  ];

  const found = indicators.some((f) => fileExists(resolve(target, f)));

  if (!found) {
    log.warn(
      'No project files detected in target directory. Are you in a project root?'
    );
  }

  return true; // Allow proceeding regardless
}

function printSummary(
  results: InitResult[],
  _target: string,
  notices: readonly string[] = []
): void {
  log.header('Summary');

  let totalCreated = 0;
  let totalSkipped = 0;
  let totalUpdated = 0;

  for (const { platform, result } of results) {
    const created = result.created.length;
    const skipped = result.skipped.length;
    const updated = result.updated.length;

    totalCreated += created;
    totalSkipped += skipped;
    totalUpdated += updated;

    if (created > 0) {
      log.success(`${platform}: ${created} file(s) created`);
    }
    if (updated > 0) {
      log.warn(`${platform}: ${updated} file(s) updated`);
    }
    if (skipped > 0) {
      log.skip(`${platform}: ${skipped} file(s) skipped (already exist)`);
    }
  }

  log.blank();

  if (totalCreated + totalUpdated > 0) {
    log.success(
      `Done! ${totalCreated} created, ${totalUpdated} updated, ${totalSkipped} skipped.`
    );
  } else if (totalSkipped > 0) {
    log.info('All files already exist. Use --force to overwrite.');
  }

  // Outcomes of the install-time steps that are not file copies (PATH rails,
  // …). One line each, always present — a step that degraded still reports.
  for (const notice of notices) {
    log.info(notice);
  }
}

/**
 * Pick derive's own feature-bootstrap line out of its report, or null when it
 * adopted nothing.
 *
 * init RELAYS this line; it must never compute one itself. Derive is the single
 * bootstrap (allowed-pattern #14) and reports only when it actually adopted
 * something, so "no line" means "nothing to say", never "the board is empty" —
 * which is precisely the claim the old second bootstrap made, and got backwards.
 */
export function featureReportLine(lines: readonly string[]): string | null {
  return lines.find((line) => /^features:/i.test(line)) ?? null;
}

function printNextSteps(pathLine: string | null = null): void {
  log.header('Next Steps');
  log.info(
    'Claude Code: Open your project in Claude Code and use /setup to index patterns'
  );
  // The ONE step the installer refuses to do for the user: editing a shell
  // profile. The line is printed exactly as it must be pasted, never written.
  if (pathLine !== null) {
    log.blank();
    log.warn('Add this line to your shell profile so `planflow-ai` resolves in new shells:');
    log.info(`  ${pathLine}`);
  }
  log.blank();
  log.header('Heartbeat Daemon');
  log.info('The heartbeat daemon runs in the background to execute scheduled tasks.');
  log.info('Manage it with: npx planflow-ai heartbeat start|stop|status');
  log.blank();
  log.header('Brain & Obsidian Vault');
  log.info('Your project brain lives at flow/brain/ — features, errors, and decisions are tracked here.');
  log.info('All projects are linked in the central vault at ~/plan-flow/brain/');
  log.info('Open ~/plan-flow/brain/ as an Obsidian vault to browse all projects in one graph.');
  log.blank();
}

/**
 * The share answer this init run should apply, or `undefined` when this run has
 * no opinion (the handler then keeps the project's persisted setting, falling
 * back to local). Exported for tests — the decision is what matters, not the
 * readline plumbing around it.
 */
export async function resolveShareAnswer(
  target: string,
  nonInteractive: boolean
): Promise<ShareMode | undefined> {
  const existing = readShareMode(target);
  if (existing !== null) return existing;
  if (nonInteractive) return undefined;
  return askShareMode();
}

/**
 * The in-flight background derive from the most recent `runInit`, or null.
 *
 * Deliberately module state rather than a return value: `runInit` resolving
 * BEFORE the derive finishes is the feature, so the promise cannot be awaited
 * on the normal path without destroying it.
 */
let pendingDerive: Promise<void> | null = null;

/**
 * Wait for the background derive `runInit` started, if any.
 *
 * FOR TESTS. Production must never call this — it would serialise the work
 * init deliberately detaches. A test that skips it inherits a promise that
 * outlives the test: its log line lands in the NEXT test's transcript and its
 * `graphify-out/` write races the temp-dir cleanup, which is exactly how this
 * suite came to fail on a different test every run.
 */
export async function settleInitBackgroundWork(): Promise<void> {
  const inFlight = pendingDerive;
  pendingDerive = null;
  if (inFlight !== null) await inFlight;
}

export async function runInit(options: InitOptions): Promise<void> {
  // Guarded refresh mode (IDE auto-provisioning): rewrite plan-flow-owned
  // assets only, never touching user data. Delegates entirely and returns.
  if (options.refreshOwned) {
    const { runRefreshOwned } = await import('./init-refresh.js');
    runRefreshOwned({ target: resolve(options.target) });
    return;
  }

  printBanner();

  const target = resolve(options.target);
  const force = options.force ?? false;
  const nonInteractive = options.yes ?? false;

  validateTarget(target);

  const platforms = detectPlatforms();

  log.blank();
  log.info(`Installing for: ${platforms.join(', ')}`);
  log.info(`Target: ${target}`);
  if (force) {
    log.warn('Force mode: existing files will be overwritten');
  }

  // Knowledge sharing — asked ONCE per project, before anything is generated
  // from the answer. Three rules, all of them about not publishing someone's
  // work for them:
  //   - a project that already answered is never re-asked (its answer wins);
  //   - a non-interactive run (`--yes`, how the IDE provisions) never asks and
  //     never changes the setting — an unanswered project stays local;
  //   - the interactive default is local.
  const share = await resolveShareAnswer(target, nonInteractive);

  const results: InitResult[] = [];

  // Run platform-specific handlers
  for (const platform of platforms) {
    log.header(`Setting up ${platform}...`);

    const result = await initClaude(target, { force, nonInteractive });
    results.push({ platform, result });
  }

  // Run shared handler (flow directories, .gitignore)
  log.header('Setting up shared resources...');
  const workspaceManaged = options.workspaceManaged === true;
  const sharedResult = await initShared(target, { force, nonInteractive, share, workspaceManaged }, platforms);
  results.push({ platform: 'shared', result: sharedResult });

  // Start heartbeat daemon in background
  await startHeartbeatIfNeeded(target);

  // Graphify install rails — required blueprint backbone dependency.
  // ensureGraphify is fail-soft internally; this guard keeps init resilient regardless.
  try {
    const graphify = await ensureGraphify(target);
    log.info(graphify.notice);
    // Ensure graphify-out is a real, gitignored local directory at init so
    // graphify's output stays out of the commit — never a vault symlink, which
    // Tailwind/Turbopack follow out of the project and panic on (#142).
    ensureGraphifyOutLocal(target);
  } catch (error) {
    // Sanctioned fallback: init must never fail because the graphify rails errored.
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`Graphify setup skipped: ${message}`);
  }

  // PATH rails — make `planflow-ai` resolve by name. The beat prompts invoke it
  // by name, so a checkout whose binary does not resolve makes every beat
  // improvise a fallback. ensurePlanflowOnPath is fail-soft internally (never
  // sudo, never a profile edit); this guard keeps init resilient regardless.
  const initNotices: string[] = [];
  let pathLine: string | null = null;
  try {
    const pathRails = await ensurePlanflowOnPath();
    initNotices.push(pathRails.notice);
    pathLine = pathRails.pathLine;
  } catch (error) {
    // Sanctioned fallback: init must never fail because the PATH rails errored.
    const message = error instanceof Error ? error.message : String(error);
    initNotices.push(`CLI: PATH setup skipped: ${message}`);
  }

  // Derive blueprint system map in background (fire-and-forget). DERIVE IS THE
  // ONE BOOTSTRAP: its first-run seed populates the feature board and reports
  // what it wrote, so init only relays that line (allowed-pattern #14).
  //
  // init used to bootstrap a SECOND time here. Because `deriveBlueprint` is
  // synchronous, derive had already seeded the store by then, so every slug was
  // taken, the second pass returned `cores: 0, adopted: 0`, and
  // `describeBootstrap` mapped that to "no capability surfaces found — the
  // feature board starts empty". The message was exactly inverted: the user was
  // told the board was empty on precisely the repos where it had just been
  // populated. Fail-soft either way — a project that provisions is usable
  // whether or not derive succeeds.
  // The handle is kept (see `pendingDerive`) so a caller that needs the work to
  // be OVER can wait for it. Production never does — the whole point is that
  // init returns while derive runs. Tests must, because this promise outlives
  // `runInit`: it logs into whatever transcript is current when it resolves and
  // writes `graphify-out/` into a target a test is already tearing down, which
  // made init's suite fail nondeterministically — different tests on different
  // runs, including in isolation.
  // CHAINED, NOT REPLACED (#1848). Assigning over `pendingDerive` orphaned the
  // previous one: `settleInitBackgroundWork` can only await the handle it can
  // see, so a caller that runs init twice — three tests here do, and a
  // re-provision is a real scenario — left the FIRST derive running with
  // nothing holding it. It then wrote `graphify-out/` into a directory the test
  // had already torn down, which is the `ENOTEMPTY … rmdir` that survived the
  // process-level guards.
  //
  // Serialising them is also right on its own terms: two concurrent derives of
  // the same target race each other over the same output.
  const previousDerive = pendingDerive ?? Promise.resolve();
  pendingDerive = previousDerive
    .catch(() => undefined)
    .then(async () => import('./blueprint.js'))
    .then(({ deriveBlueprint }) => {
      const featureLine = featureReportLine(deriveBlueprint(target, null));
      if (featureLine !== null) log.info(featureLine);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Blueprint derive failed: ${message}`);
    });

  // Print summary and next steps
  printSummary(results, target, initNotices);
  printNextSteps(pathLine);
}
