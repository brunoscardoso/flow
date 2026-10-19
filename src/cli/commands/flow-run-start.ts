/**
 * The one writer of a run's START record — `planflow-ai flow run-start`.
 *
 * `blueprint storyline --plan <name>` compares a plan's After against the
 * commit its run started from, and finds that commit in the newest `run_intent`
 * for the plan carrying a `base` (`../blueprint/storyline-compare.ts`). Before
 * this verb nothing wrote `base`, so Today silently fell back to HEAD — the
 * commit the run had already moved.
 *
 * IF A GATE READS IT, A VERB WRITES IT (forbidden-pattern #18). The coordinator
 * does not compose this line from a paragraph: the verb resolves the plan the
 * same way the reader does (`findActivePlan`, so the `plan` field is spelled
 * exactly as `recordedRunBase` matches it), asks git for the sha itself, and
 * copies the compiled run script's `planHash` when there is one — the same
 * lineage key every other `run_intent` carries (`../state/resume-evaluator.ts`).
 *
 * It refuses — and appends nothing — when the plan is unknown, the run id was
 * not given (it never mints one), or the project is not a git repository with a
 * commit to start from. Append-only, like every other writer of the record.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { findActivePlan } from '../blueprint/storyline-compare.js';
import { readRunScript } from '../state/run-script-store.js';
import { ROUNDS_FILE } from '../state/workflow-stages.js';

/** The rounds entry type a run's start shares with its end-of-run intent. */
export const RUN_START_ENTRY_TYPE = 'run_intent';

/** The entry this verb appends. */
export interface RunStartEntry {
  ts: string;
  run_id: string;
  type: typeof RUN_START_ENTRY_TYPE;
  phase: null;
  /** The plan's slug — the spelling `blueprint storyline` matches on. */
  plan: string;
  /** The full sha of HEAD when the run started. */
  base: string;
  /** The compiled run script's plan hash, when the plan has been compiled. */
  planHash?: string;
}

/** What the verb was told to record. */
export interface RunStartRequest {
  /** The project root — the git checkout whose HEAD is the base. */
  target: string;
  flowDir: string;
  /** The plan as the caller named it: slug or `plan_<slug>_v<N>[.md]`. */
  plan: string;
  runId: string;
}

/** The clock, git and the append — injectable so a test reads what it asserts. */
export interface RunStartDeps {
  now: () => Date;
  /** HEAD's sha, or null when the target is not a git repository with a commit. */
  head: (target: string) => string | null;
  append: (line: string) => void;
}

function gitHead(target: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      cwd: target,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40,64}$/.test(out) ? out : null;
  } catch {
    // Not a repository, or one with no commit yet: either way there is no
    // starting point to record, and the caller refuses with that sentence.
    return null;
  }
}

/** The real writer — creates the flow directory if this is the record's first line. */
export function runStartDeps(flowDir: string): RunStartDeps {
  return {
    now: () => new Date(),
    head: gitHead,
    append: (line: string) => {
      mkdirSync(flowDir, { recursive: true });
      appendFileSync(join(flowDir, ROUNDS_FILE), line, 'utf-8');
    },
  };
}

/**
 * Record that a run of `plan` started at HEAD. Everything is validated before
 * the one append, so a refusal leaves the record untouched.
 */
export function recordRunStart(
  request: RunStartRequest,
  deps: RunStartDeps = runStartDeps(request.flowDir),
): RunStartEntry {
  const found = findActivePlan(request.flowDir, request.plan);
  if (found === null) {
    throw new Error(
      `no active plan named '${request.plan}' — expected flow/plans/plan_<name>_v<N>.md to exist`,
    );
  }
  const base = deps.head(request.target);
  if (base === null) {
    throw new Error(
      `${request.target} is not a git repository with a commit, so there is no starting point to record`,
    );
  }
  const planHash = readRunScript(request.flowDir, found.name)?.planHash;
  const entry: RunStartEntry = {
    ts: deps.now().toISOString(),
    run_id: request.runId,
    type: RUN_START_ENTRY_TYPE,
    phase: null,
    plan: found.name,
    base,
    ...(typeof planHash === 'string' && planHash.length > 0 ? { planHash } : {}),
  };
  deps.append(`${JSON.stringify(entry)}\n`);
  return entry;
}
