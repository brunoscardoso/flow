#!/usr/bin/env node
/**
 * One-time recovery for findings stranded by the per-worktree ledger fork
 * (#loop-ledger-shared-root). Thin imperative shell around the pure planner in
 * `src/cli/loop/salvage.ts` — reads the canonical ledger and the source
 * worktree queues, plans the append (dedup + renumber), and either prints it
 * (`--dry-run`) or appends it.
 *
 * Requires a build first (`npm run build`): it imports the compiled planner from
 * `dist/`, the same reality as the CLI fix itself — the canonicalization only
 * takes effect once the bundle is rebuilt.
 *
 * Usage:
 *   node scripts/salvage-loop-findings.mjs \
 *     --ledger <canonical queue.jsonl> \
 *     --source <worktree queue.jsonl> [--source <...> ...] \
 *     [--dry-run]
 *
 * The canonical ledger is the MAIN checkout's flow/loops/queue.jsonl (what the
 * board reads). Sources are the per-worktree copies that hold divergent filings.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { ledger: '', sources: [], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--ledger') out.ledger = argv[(i += 1)] ?? '';
    else if (arg === '--source') out.sources.push(argv[(i += 1)] ?? '');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.ledger.trim().length === 0) throw new Error('--ledger <path> is required');
  if (out.sources.length === 0) throw new Error('at least one --source <path> is required');
  return out;
}

function readLines(path) {
  try {
    return readFileSync(path, 'utf-8').split('\n');
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // The compiled planner — build first. Kept as a dynamic import so a missing
  // build fails with a clear message rather than a load-time crash.
  let planSalvage;
  let renderSalvagedLine;
  try {
    // A file:// URL, not a bare path — Windows `import()` rejects `C:\…` as an
    // unknown URL scheme otherwise.
    const built = pathToFileURL(resolve(HERE, '../dist/cli/loop/salvage.js')).href;
    ({ planSalvage, renderSalvagedLine } = await import(built));
  } catch {
    throw new Error('dist/cli/loop/salvage.js not found — run `npm run build` first');
  }

  const canonical = readLines(args.ledger);
  const sources = args.sources.map((path) => ({ label: path, lines: readLines(path) }));
  const plan = planSalvage(canonical, sources);

  process.stdout.write(
    `baseline max id: ${plan.baselineMaxId}\n` +
      `already present (skipped): ${plan.alreadyPresent.length}\n` +
      `to append: ${plan.append.length}\n`,
  );
  for (const finding of plan.append) {
    process.stdout.write(`  + #${finding.id}  (from ${finding.source} #${finding.sourceId})  ${finding.title}\n`);
  }

  if (plan.append.length === 0) {
    process.stdout.write('nothing to salvage — canonical ledger already has every source finding\n');
    return;
  }
  if (args.dryRun) {
    process.stdout.write('\n--dry-run: nothing written\n');
    return;
  }

  const ts = new Date().toISOString();
  const payload = plan.append.map((finding) => renderSalvagedLine(finding, ts)).join('\n') + '\n';
  appendFileSync(args.ledger, payload, 'utf-8');
  process.stdout.write(`\nappended ${plan.append.length} finding(s) to ${args.ledger}\n`);
}

main().catch((error) => {
  process.stderr.write(`salvage refused: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
