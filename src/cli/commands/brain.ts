/**
 * Brain CLI command
 *
 * `brain search` is the PROJECT knowledge front door (brain-first-retrieval
 * Phase 2): the layered fan-out over the project's markdown corpus + the
 * generated `INDEX.md` + the symbols sidecar, delegated to
 * `commands/brain-search.ts`.
 *
 * `brain migrate` moves a project's precious knowledge out of the central
 * vault and into its own repo.
 *
 * `brain ref` is the CURATED half of retrieval: a hand-authored catalog maps a
 * stable code to a section's heading, and this expands one code into that whole
 * section. Search ranks; ref does not — see `state/brain-catalog.ts`.
 *
 * `brain index` rebuilds `flow/brain/index.md` — the session-start summary —
 * from the notes. That file is GENERATED (never edited in place, never synced
 * between machines), so this is how it is refreshed after notes change.
 *
 * The index maintenance verbs — `ingest`, `rebuild`, `stats`, `sync` — went
 * with the `.brain.sqlite` index they maintained. There is no index to build:
 * the markdown IS the store, so it is never out of date with itself.
 */

import * as log from '../utils/logger.js';

export interface BrainOptions {
  limit?: number;
  list?: boolean;
  check?: boolean;
  prefix?: string;
  type?: string;
  scope?: string;
  full?: string;
  json?: boolean;
  target?: string;
  dryRun?: boolean;
}

export async function runBrain(action: string, args: string[], options: BrainOptions): Promise<void> {
  switch (action) {
    case 'migrate': {
      const { runBrainMigrate } = await import('./brain-migrate.js');
      runBrainMigrate({ target: options.target ?? process.cwd(), dryRun: options.dryRun });
      return;
    }

    case 'search': {
      if (args.length === 0) {
        log.error('Usage: brain search <query>');
        process.exit(1);
      }
      const { runBrainSearch } = await import('./brain-search.js');
      await runBrainSearch(args.join(' '), {
        scope: options.scope,
        limit: options.limit,
        full: options.full,
        json: options.json,
        target: options.target ?? process.cwd(),
      });
      return;
    }

    case 'ref': {
      const { runBrainRef } = await import('./brain-ref.js');
      runBrainRef(args, {
        target: options.target ?? process.cwd(),
        list: options.list,
        check: options.check,
        prefix: options.prefix,
        json: options.json,
      });
      return;
    }

    case 'index': {
      const { join } = await import('node:path');
      const { existsSync } = await import('node:fs');
      const { writeBrainIndex } = await import('../state/brain-index.js');
      const flowDir = join(options.target ?? process.cwd(), 'flow');
      if (!existsSync(flowDir)) {
        log.error('brain index refused: this project has no flow/ folder');
        process.exit(1);
      }
      const written = writeBrainIndex(flowDir);
      process.stdout.write(`brain index: rebuilt ${written}\n`);
      return;
    }

    default:
      log.error(`Unknown brain action: "${action}". Valid actions: search, ref, migrate, index`);
      process.exit(1);
  }
}
