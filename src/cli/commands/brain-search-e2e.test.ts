/**
 * Live E2E for the brain-first retrieval loop — exercises the REAL built CLI
 * (`dist/cli/index.js`) as a subprocess against a temp fixture project
 * (forbidden-pattern #7: never trust in-process seams for the shipped path).
 *
 * The full lifecycle under test:
 *
 *   seed a TS file → `blueprint derive` writes the code card + symbols
 *   sidecar → `brain search "<symbol>"` finds the symbol layer hit with
 *   `file:line` + `● fresh` → the file is edited → the same hit flips to
 *   `○ stale — verify against code` (query-time re-hash) → re-derive → fresh
 *   again.
 *
 * THERE IS NO INDEX STEP, because there is no index. `derive` writes the card
 * and the sidecar, and the search reads the markdown directly; the
 * fresh→stale→fresh flip happens with no database anywhere in the loop, which
 * is the point. A leftover `.brain.sqlite` from an earlier version is written
 * into the fixture deliberately, to prove it is tolerated and never read.
 *
 * Also covered: `--full <id>` prints the entry (id harvested from `--json`) and
 * an empty directory reports `no hits` (never an error).
 *
 * Assertions run against stdout+stderr COMBINED (allowed-pattern #15 — this
 * CLI's logger emits error() via console.log). Every subprocess runs with an
 * explicit `cwd` inside the sandbox and an explicit `--target` — cwd never
 * drifts into this repo (the init-e2e-cwd-drift lesson). PLAN_FLOW_VAULT_DIR
 * points into the sandbox as belt-and-braces; no test here runs `init`, so the
 * central vault is never touched.
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { getPackageRoot } = await import('../utils/files.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

const E2E_TIMEOUT_MS = 120_000;

/** Distinctive fixture symbol — an exact-name hit, never a fuzzy match. */
const FIXTURE_SYMBOL = 'quizzleFrobnicator';
const FIXTURE_FILE = 'src/greeter.ts';
/** 1-based declaration line of the fixture symbol inside the fixture file. */
const FIXTURE_LINE = 2;

const FIXTURE_SOURCE = [
  '/** Greets the plan-flow E2E fixture. */',
  `export function ${FIXTURE_SYMBOL}(): string {`,
  "  return 'hello';",
  '}',
  '',
].join('\n');

interface CliRun {
  /** stdout + stderr combined — what the user actually sees (pattern #15). */
  transcript: string;
  status: number | null;
}

describe('brain search E2E — real built CLI against a temp fixture project', () => {
  let sandbox: string;
  let project: string;

  function runCli(args: string[], cwd: string): CliRun {
    const result = spawnSync('node', [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, PLAN_FLOW_VAULT_DIR: join(sandbox, 'vault') },
      timeout: E2E_TIMEOUT_MS,
    });
    if (result.error) {
      throw result.error;
    }
    return {
      transcript: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      status: result.status,
    };
  }

  function derive(): CliRun {
    return runCli(['blueprint', 'derive'], project);
  }

  function search(query: string, extraArgs: string[] = []): CliRun {
    return runCli(['brain', 'search', query, '--target', project, ...extraArgs], project);
  }

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `brain-search-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`
      );
    }
  });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'brain-e2e-'));
    project = join(sandbox, 'proj');
    mkdirSync(join(project, 'src'), { recursive: true });
    // Derive requires an existing flow/ dir (normally provisioned by init).
    mkdirSync(join(project, 'flow'), { recursive: true });
    mkdirSync(join(sandbox, 'vault'), { recursive: true });
    writeFileSync(join(project, FIXTURE_FILE), FIXTURE_SOURCE, 'utf-8');
    // A leftover index from a pre-retirement version of this tool. It stays on
    // disk for the whole run: nothing may read it, and nothing may break on it.
    writeFileSync(join(project, '.brain.sqlite'), 'stale leftover, not a database', 'utf-8');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  });

  it(
    'derive → fresh symbol hit → edit flips stale at query time → re-derive restores fresh',
    () => {
      // ── derive writes the code card + symbols sidecar ──
      const derived = derive();
      expect(derived.status).toBe(0);
      expect(derived.transcript).toContain('code-cards: 1 file(s) extracted');

      const cardPath = join(project, 'flow', 'brain', 'code', 'src.md');
      expect(existsSync(cardPath)).toBe(true);
      expect(readFileSync(cardPath, 'utf-8')).toContain(FIXTURE_SYMBOL);

      const sidecarPath = join(project, 'flow', 'brain', '.structure', 'symbols.jsonl');
      expect(existsSync(sidecarPath)).toBe(true);
      const sidecarRow = JSON.parse(readFileSync(sidecarPath, 'utf-8').trim().split('\n')[0]);
      expect(sidecarRow.name).toBe(FIXTURE_SYMBOL);
      expect(sidecarRow.path).toBe(FIXTURE_FILE);

      // ── fresh symbol hit with file:line, no index consulted ──
      const freshRun = search(FIXTURE_SYMBOL);
      expect(freshRun.status).toBe(0);
      expect(freshRun.transcript).toContain(
        `● fresh symbol ${FIXTURE_FILE}:${FIXTURE_LINE}`
      );
      // The card (code layer) agrees and is fresh too.
      expect(freshRun.transcript).toContain(`● fresh code ${FIXTURE_FILE}`);
      // Mandatory drill-down hint is always the last line.
      expect(freshRun.transcript).toContain('--full');

      // ── edit the file: freshness flips at QUERY time, no reindex needed ──
      appendFileSync(join(project, FIXTURE_FILE), '\n// drifted\n', 'utf-8');

      const staleRun = search(FIXTURE_SYMBOL);
      expect(staleRun.status).toBe(0);
      expect(staleRun.transcript).toContain(
        `○ stale symbol ${FIXTURE_FILE}:${FIXTURE_LINE} — verify against code`
      );
      expect(staleRun.transcript).not.toContain(`● fresh symbol ${FIXTURE_FILE}`);

      // ── re-derive (new hashes) → fresh again, still no index ──
      expect(derive().status).toBe(0);

      const freshAgain = search(FIXTURE_SYMBOL);
      expect(freshAgain.status).toBe(0);
      expect(freshAgain.transcript).toContain(
        `● fresh symbol ${FIXTURE_FILE}:${FIXTURE_LINE}`
      );
      expect(freshAgain.transcript).toContain(`● fresh code ${FIXTURE_FILE}`);
      expect(freshAgain.transcript).not.toContain('○ stale');

      // The leftover database was there the whole time and was never touched.
      expect(readFileSync(join(project, '.brain.sqlite'), 'utf-8')).toBe(
        'stale leftover, not a database',
      );
    },
    E2E_TIMEOUT_MS
  );

  it(
    '--full <id> prints the full entry for a hit id harvested from --json',
    () => {
      expect(derive().status).toBe(0);

      const jsonRun = search(FIXTURE_SYMBOL, ['--json']);
      expect(jsonRun.status).toBe(0);
      // The JSON payload is the whole stdout — parse it from the transcript.
      const payload = JSON.parse(jsonRun.transcript.trim());
      const symbolHit = payload.hits.find((hit: { kind: string }) => hit.kind === 'symbol');
      expect(symbolHit).toBeDefined();
      expect(symbolHit.codeFile).toBe(FIXTURE_FILE);
      expect(symbolHit.line).toBe(FIXTURE_LINE);
      expect(symbolHit.freshness).toBe('fresh');

      const fullRun = search(FIXTURE_SYMBOL, ['--full', symbolHit.id]);
      expect(fullRun.status).toBe(0);
      expect(fullRun.transcript).toContain(`id: ${symbolHit.id}`);
      expect(fullRun.transcript).toContain(
        `${FIXTURE_SYMBOL} (function, typescript) — ${FIXTURE_FILE}:${FIXTURE_LINE}`
      );
    },
    E2E_TIMEOUT_MS
  );

  it(
    'an EMPTY directory reports no hits and exits 0 — never an error',
    () => {
      // No corpus at all. The honest answer to that is "no hits" plus the drill
      // hint, not a crash and not the retired "no index" apology — there is no
      // index to be missing from a path that does not use one.
      const bare = join(sandbox, 'no-index');
      mkdirSync(bare, { recursive: true });
      const run = runCli(['brain', 'search', 'anything', '--target', bare], bare);
      expect(run.status).toBe(0);
      expect(run.transcript).toContain('no hits');
      expect(run.transcript).toContain('drill: planflow-ai brain search "anything" --full <id>');
    },
    E2E_TIMEOUT_MS
  );
});
