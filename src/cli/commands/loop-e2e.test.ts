/**
 * Live E2E for the agent-loop verb family — exercises the REAL built CLI
 * (`dist/cli/index.js`) as a subprocess against throwaway fixture projects.
 *
 * WHY THIS FILE EXISTS NEXT TO `loop.test.ts`. That suite proves the verbs in
 * process, with an injected clock and an injected exec; this one proves the
 * same guarantees survive the shipped binary — real argv parsing by commander,
 * real flag names, real exit codes, real refusal transcripts, and real stores
 * written to a real disk by one process and read back by the NEXT one. Every
 * invariant here is one a beat depends on at 3am with nobody watching:
 *
 *   1. the queue (Task 8.1) — file, dedup, the cap, claim, the approval gate,
 *      close-with-evidence, and the close-without-evidence refusal
 *   2. the gate (Task 8.2) — a paused loop really stops, a self-expiring pause
 *      really lifts, and a run slot that has run out really lets the next beat
 *      through
 *   3. the pipeline — a stage still in flight IS a beat's honest ending, read
 *      from the plan recorded on the claim and from nothing else
 *
 * WHAT PHASE 6 TOOK OUT OF THIS FILE. The circuit breaker, the run budget, the
 * single pipeline lock and the stalled-pipeline policy were all SUPERVISION —
 * they existed so something outside a beat could notice it misbehaving and take
 * the machinery back. Nothing schedules unattended re-runs any more (a run is a
 * Claude Code background agent, and that session's end is the end), so those
 * tests were deleted rather than weakened: a rule with nobody left to enforce it
 * reads as true and never fires. The gate's remaining answers — the two pauses,
 * the run-slot table, the queue's shape — are all still proved below, and so is
 * the honest-ending rule, which is the only surviving reader of a pipeline
 * stage.
 *
 * ASSERTIONS RUN ON stdout+stderr COMBINED (allowed-pattern #15 — this CLI's
 * logger routes `error()` through `console.log`, so a stderr-only assertion
 * passes vacuously). Success output is a single JSON line on stdout, which the
 * `json` field of every run parses.
 *
 * NO NETWORK, NO GIT, NO `gh`. Every fixture directive uses `queue: ledger`,
 * and every `loop next` passes `--no-pull`, so nothing here reaches a remote or
 * shells out to git. Every subprocess gets an explicit `--target` inside the
 * sandbox and an explicit `cwd` there too, so cwd can never drift into this
 * repository (the init-e2e-cwd-drift lesson).
 *
 * TIME IS MOVED BY EDITING THE STORE, not by sleeping. A slot's TTL is its
 * loop's `max_run_minutes` plus five minutes, so the only honest way to observe
 * an expiry end-to-end is to rewrite the `expiresAt` the previous beat actually
 * wrote — the state file IS the contract between two beats, and a test that
 * slept for half an hour would prove the same thing far later.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

const E2E_TIMEOUT_MS = 120_000;

// ── fixtures ─────────────────────────────────────────────

/** A producer over the ledger, capped at two open items. */
const PROBE_DIRECTIVE = `---
loop: probe
engine: producer
mission: Hunt for real defects in the fixture tree
scope: [src, app/src]
slice: changed
queue: ledger
max_open_issues: 2
max_run_minutes: 20
---

## Direction

Reproduce before filing.
`;

/** A producer whose findings wait for a human. */
const GATED_DIRECTIVE = `---
loop: gated
engine: producer
mission: Propose changes a person has to agree to first
queue: ledger
max_open_issues: 5
needs_approval: true
---
`;

/** A consumer — the only engine that can hold a pipeline. */
const DRAIN_DIRECTIVE = `---
loop: drain
engine: consumer
mission: Drain the queue one item per beat
queue: ledger
max_open_issues: 5
max_run_minutes: 25
---
`;

/**
 * A loop pointed at an area, over the ledger.
 *
 * It carries BOTH label-ish fields on purpose: `label:` is provenance (which
 * machine filed this) and `topic:` is area (where the loop is working), and the
 * whole risk in giving the topic the existing label path is that one of them
 * displaces the other on the way to the store.
 */
const TOPICAL_DIRECTIVE = `---
loop: sweep
engine: producer
mission: Sweep the codemap for entries nothing points at
queue: ledger
label: qa-heartbeat
topic: codemap
max_open_issues: 5
---
`;

/** The same loop, re-pointed at a new area — one field changed, nothing else. */
const REPOINTED_DIRECTIVE = TOPICAL_DIRECTIVE.replace('topic: codemap', 'topic: docs');

/** A loop pointed at an area in a real repo. Its topic label does NOT exist yet. */
const GITHUB_DIRECTIVE = `---
loop: ship
engine: producer
mission: File findings into the repo's own issue tracker
queue: github
repo: acme/widgets
label: qa-heartbeat
topic: codemap
max_open_issues: 5
---
`;

const PLAN_HASH = 'b'.repeat(64);

/**
 * A stand-in for the `gh` CLI, dropped on PATH for the spawned binary.
 *
 * WHY A FAKE BINARY AND NOT A MODULE MOCK. The GitHub backend shells out with
 * `execFileSync('gh', …)`, so the only place the argv it really builds can be
 * observed is a process boundary — an in-process mock proves the backend calls
 * its own injected seam, not that the shipped binary asks `gh` for the right
 * thing. This is also why a PATH stub is legitimate HERE where allowed-pattern
 * #12 forbids it: that rule is about jest's in-process children inheriting the
 * REAL env, and every subprocess below is spawned with an env this file builds.
 *
 * IT REFUSES UNKNOWN LABELS, exactly as the live tool does — that refusal IS
 * the "labels are a setup precondition" rule the backend documents, and it is
 * what makes the topic exception observable: a run that skipped
 * `gh label create` fails here rather than passing quietly.
 *
 * No network, no auth, no real repository: state is a JSON file in the sandbox.
 */
const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify(argv) + '\\n');

const storePath = process.env.GH_FAKE_STORE;
const db = existsSync(storePath)
  ? JSON.parse(readFileSync(storePath, 'utf-8'))
  : { labels: [], issues: [], prs: [] };
db.prs = db.prs ?? [];
const save = () => writeFileSync(storePath, JSON.stringify(db), 'utf-8');

const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};
const flagAll = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === name) out.push(argv[i + 1]);
  return out;
};
const die = (message) => {
  process.stderr.write(message + '\\n');
  process.exit(1);
};
const requireLabels = (names) => {
  const missing = names.filter((name) => !db.labels.includes(name));
  if (missing.length > 0) die("could not add label: '" + missing[0] + "' not found");
};
const find = (id) => db.issues.find((issue) => String(issue.number) === String(id));

const [group, verb] = argv;

if (group === 'label' && verb === 'create') {
  if (!db.labels.includes(argv[2])) db.labels.push(argv[2]);
  save();
  process.exit(0);
}

if (group === 'issue' && verb === 'create') {
  const labels = flagAll('--label');
  requireLabels(labels);
  const number = db.issues.length + 1;
  const url = 'https://github.com/' + flag('--repo') + '/issues/' + number;
  db.issues.push({
    number,
    title: flag('--title') ?? '',
    body: flag('--body') ?? '',
    state: 'OPEN',
    labels: labels.map((name) => ({ name })),
    createdAt: new Date(Date.now() + number).toISOString(),
    url,
    stateReason: null,
  });
  save();
  process.stdout.write(url + '\\n');
  process.exit(0);
}

if (group === 'issue' && verb === 'list') {
  const state = (flag('--state') ?? 'all').toUpperCase();
  // \`--search\` is a narrowing device only — the backend's exact marker check is
  // what decides a duplicate, so the fake returns the unnarrowed set.
  const rows = db.issues.filter((issue) => state === 'ALL' || issue.state === state);
  process.stdout.write(JSON.stringify(rows) + '\\n');
  process.exit(0);
}

if (group === 'issue' && verb === 'view') {
  const issue = find(argv[2]);
  if (issue === undefined) die('no issue ' + argv[2]);
  process.stdout.write(JSON.stringify(issue) + '\\n');
  process.exit(0);
}

if (group === 'issue' && verb === 'edit') {
  const issue = find(argv[2]);
  if (issue === undefined) die('no issue ' + argv[2]);
  const added = flagAll('--add-label');
  requireLabels(added);
  const body = flag('--body');
  if (body !== undefined) issue.body = body;
  for (const name of added) {
    if (!issue.labels.some((label) => label.name === name)) issue.labels.push({ name });
  }
  for (const name of flagAll('--remove-label')) {
    issue.labels = issue.labels.filter((label) => label.name !== name);
  }
  save();
  process.exit(0);
}

if (group === 'issue' && verb === 'close') {
  const issue = find(argv[2]);
  if (issue === undefined) die('no issue ' + argv[2]);
  issue.state = 'CLOSED';
  issue.stateReason = flag('--reason') === 'completed' ? 'COMPLETED' : 'NOT_PLANNED';
  save();
  process.exit(0);
}

if (group === 'issue' && verb === 'comment') {
  const issue = find(argv[2]);
  if (issue === undefined) die('no issue ' + argv[2]);
  issue.comments = [...(issue.comments ?? []), flag('--body') ?? ''];
  save();
  process.exit(0);
}

// A pull request is looked up BY ITS HEAD BRANCH, exactly as the live tool
// resolves \`gh pr view <branch>\` — which is what makes "the ref this PR really
// proposes" a thing the merge gate can disagree with.
if (group === 'pr' && verb === 'view') {
  const pr = db.prs.find((candidate) => candidate.headRefName === argv[2]);
  if (pr === undefined) die('no pull requests found for branch "' + argv[2] + '"');
  process.stdout.write(JSON.stringify(pr) + '\\n');
  process.exit(0);
}

if (group === 'pr' && verb === 'merge') {
  const pr = db.prs.find((candidate) => String(candidate.number) === String(argv[2]));
  if (pr === undefined) die('no pull request ' + argv[2]);
  if (pr.state !== 'OPEN') die('Pull request #' + pr.number + ' is not open');
  pr.state = 'MERGED';
  save();
  process.stdout.write('merged\\n');
  process.exit(0);
}

die('fake gh: unsupported command ' + argv.join(' '));
`;

/** A compiled run artifact: 4 phases in 3 waves. */
function runArtifact(plan: string): string {
  return JSON.stringify({
    version: 1,
    plan,
    planHash: PLAN_HASH,
    phases: [1, 2, 3, 4].map((number) => ({
      number,
      name: `Phase ${number}`,
      complexity: 5,
      dependencies: [],
      model: 'sonnet',
      skip: false,
      tasks: [],
    })),
    waves: [
      { wave_number: 1, phase_numbers: [1, 2] },
      { wave_number: 2, phase_numbers: [3] },
      { wave_number: 3, phase_numbers: [4] },
    ],
    routing: [],
    commitStrategy: 'per-task',
    overrides: {},
    diagnostics: [],
  });
}

interface CliRun {
  /** stdout + stderr combined — what the user actually sees (pattern #15). */
  transcript: string;
  stdout: string;
  status: number | null;
  /** The parsed JSON result, or null when the run refused. */
  json: Record<string, unknown> | null;
}

/** One issue as the fake repository holds it. */
interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  createdAt: string;
  url: string;
  stateReason: string | null;
  comments?: string[];
}

/** One pull request as the fake repository holds it. */
interface FakePullRequest {
  number: number;
  headRefName: string;
  state: string;
  url: string;
}

/** The whole fake repository. */
interface FakeRepo {
  labels: string[];
  issues: FakeIssue[];
  prs: FakePullRequest[];
}

/**
 * An issue a PERSON filed: real prose, no marker of any kind, and whatever
 * labels a human happened to put on it.
 *
 * The body is the whole point — it carries no `<!-- loop: … -->`, which is the
 * only thing that makes an item a loop's. Every "leaves it untouched" assertion
 * below compares against exactly these bytes.
 */
function humanIssue(number: number, title: string, body: string): FakeIssue {
  return {
    number,
    title,
    body,
    state: 'OPEN',
    labels: [{ name: 'bug' }],
    createdAt: '2026-08-01T09:00:00.000Z',
    url: `https://github.com/acme/widgets/issues/${number}`,
    stateReason: null,
  };
}

describe('loop E2E — the real built CLI against throwaway fixture projects', () => {
  let sandbox: string;
  let project: string;
  let flowDir: string;
  let ghPath: string;
  let ghLog: string;
  let ghStore: string;

  function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): CliRun {
    const result = spawnSync('node', [CLI_PATH, ...args, '--target', project], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, PLAN_FLOW_VAULT_DIR: join(sandbox, 'vault'), ...extraEnv },
      timeout: E2E_TIMEOUT_MS,
    });
    if (result.error) {
      throw result.error;
    }
    const stdout = result.stdout ?? '';
    let json: Record<string, unknown> | null = null;
    const firstLine = stdout.trim().split('\n')[0] ?? '';
    if (firstLine.startsWith('{')) {
      try {
        json = JSON.parse(firstLine) as Record<string, unknown>;
      } catch {
        json = null;
      }
    }
    return { transcript: `${stdout}\n${result.stderr ?? ''}`, stdout, status: result.status, json };
  }

  /** `loop <verb> …` through the built binary. */
  function loop(...args: string[]): CliRun {
    return runCli(['loop', ...args]);
  }

  /** Write one directive into the fixture's `flow/loops/`. */
  function seedDirective(name: string, content: string): void {
    mkdirSync(join(flowDir, 'loops'), { recursive: true });
    writeFileSync(join(flowDir, 'loops', `${name}.md`), content, 'utf-8');
  }

  /** The state store as it stands on disk. */
  function readState(): Record<string, unknown> {
    return JSON.parse(readFileSync(join(flowDir, 'loops', 'state.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
  }

  /**
   * Rewrite every `expiresAt` in the state store into the past — the file-level
   * equivalent of "half an hour went by and the beat holding this never came
   * back". See the module header on why this beats sleeping.
   */
  function expireEveryLock(): void {
    const raw = readFileSync(join(flowDir, 'loops', 'state.json'), 'utf-8');
    writeFileSync(
      join(flowDir, 'loops', 'state.json'),
      raw.replace(/"expiresAt": "[^"]+"/g, '"expiresAt": "2020-01-01T00:00:00.000Z"'),
      'utf-8',
    );
  }

  /** Every line of the beat log — an empty list when nothing was written. */
  function runLines(): Record<string, unknown>[] {
    const path = join(flowDir, 'loops', 'runs.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  // ── the fake `gh`, shared by every GitHub-backed case ────

  /** `loop <verb> …` with the fake `gh` first on PATH. */
  function ghLoop(...args: string[]): CliRun {
    return runCli(['loop', ...args], {
      PATH: `${ghPath}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      GH_FAKE_LOG: ghLog,
      GH_FAKE_STORE: ghStore,
    });
  }

  /** Every argv the CLI handed to `gh`, in order. */
  function ghCalls(): string[][] {
    if (!existsSync(ghLog)) return [];
    return readFileSync(ghLog, 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as string[]);
  }

  /** Every label name the CLI ever named to `gh`, across every call. */
  function labelsNamed(): string[] {
    const out: string[] = [];
    for (const argv of ghCalls()) {
      if (argv[0] === 'label' && argv[1] === 'create') out.push(argv[2]);
      for (const flag of ['--label', '--add-label', '--remove-label']) {
        for (let i = 0; i < argv.length; i += 1) {
          if (argv[i] === flag) out.push(argv[i + 1]);
        }
      }
    }
    return out;
  }

  /** The fake repository as it now stands. */
  function readGhStore(): FakeRepo {
    return JSON.parse(readFileSync(ghStore, 'utf-8')) as FakeRepo;
  }

  /** Seed the fake repository, filling in whatever the caller did not name. */
  function writeGhStore(store: Partial<FakeRepo>): void {
    const full: FakeRepo = {
      labels: store.labels ?? [],
      issues: store.issues ?? [],
      prs: store.prs ?? [],
    };
    writeFileSync(ghStore, JSON.stringify(full), 'utf-8');
  }

  /** The issue as the fake repository now holds it. */
  function issueLabels(id: string): string[] {
    const issue = readGhStore().issues.find((candidate) => String(candidate.number) === id);
    return (issue?.labels ?? []).map((label) => label.name);
  }

  /** One issue as the fake repository now holds it. */
  function ghIssue(id: string): FakeIssue {
    const issue = readGhStore().issues.find((candidate) => String(candidate.number) === id);
    if (issue === undefined) throw new Error(`no issue ${id} in the fake repository`);
    return issue;
  }

  /** Path of the ledger queue, whether or not anything has written it yet. */
  function queuePath(): string {
    return join(flowDir, 'loops', 'queue.jsonl');
  }

  /** Every line of the ledger queue — an empty list when nothing was written. */
  function queueLines(): Record<string, unknown>[] {
    if (!existsSync(queuePath())) return [];
    return readFileSync(queuePath(), 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /**
   * Back-date every claim in the ledger — "the beat that took this never came
   * back", written into the file the way `expireEveryLock` writes an expiry.
   *
   * `claimedAt` is replayed from the `claimed` event's own `ts`, so moving that
   * timestamp IS moving the claim into the past; the same reasoning as the
   * module header's, applied to a claim rather than a lock.
   */
  function backdateClaims(): void {
    const rewritten = readFileSync(queuePath(), 'utf-8')
      .split('\n')
      .map((line) =>
        line.includes('"event":"claimed"')
          ? line.replace(/"ts":"[^"]+"/, '"ts":"2020-01-01T00:00:00.000Z"')
          : line,
      )
      .join('\n');
    writeFileSync(queuePath(), rewritten, 'utf-8');
  }

  /** Seed an in-flight pipeline the way the project itself leaves one behind. */
  /** The interactive session's leavings ONLY: STATE.md, docs, artifact,
   *  rounds — and NO carrier item. What a human's half-finished execution
   *  looks like to a loop, which must read it as no pipeline at all. */
  function seedSessionState(plan: string, donePhases: number[]): void {
    mkdirSync(join(flowDir, 'plans'), { recursive: true });
    writeFileSync(
      join(flowDir, 'STATE.md'),
      [
        '## Execution State',
        '',
        '- **Active Skill**: execute-plan',
        `- **Active Plan**: plan_${plan}_v1`,
        '',
      ].join('\n'),
      'utf-8',
    );
    writeFileSync(join(flowDir, 'plans', `plan_${plan}_v1.md`), '# plan\n', 'utf-8');
    writeFileSync(join(flowDir, 'plans', `${plan}.run.json`), runArtifact(plan), 'utf-8');
    writeFileSync(
      join(flowDir, '.rounds.jsonl'),
      donePhases
        .map((phase) =>
          JSON.stringify({
            ts: '2026-08-12T08:00:00.000Z',
            run_id: 'run-1',
            type: 'phase_result',
            phase,
            status: 'success',
            planHash: PLAN_HASH,
          }),
        )
        .join('\n') + (donePhases.length > 0 ? '\n' : ''),
      'utf-8',
    );
  }

  function seedPipeline(plan: string, donePhases: number[]): void {
    seedSessionState(plan, donePhases);
    // THE HANDOFF RIDES THE CLAIM (#1599, applied fully): the pipeline is named
    // by an open item carrying the `planned` record — a stalled run's give-back
    // shape, which `claimedPlan` reads with or without a live claim. The
    // STATE.md in the session seed above proves the binary no longer reads it
    // as one.
    mkdirSync(join(flowDir, 'loops'), { recursive: true });
    appendFileSync(
      join(flowDir, 'loops', 'queue.jsonl'),
      [
        JSON.stringify({
          ts: '2026-08-12T07:00:00.000Z',
          id: '9001',
          event: 'filed',
          loop: 'drain',
          provenance: 'test',
          title: `pipeline carrier for ${plan}`,
          fingerprint: `fp-pipeline-${plan}`,
        }),
        JSON.stringify({
          ts: '2026-08-12T07:00:01.000Z',
          id: '9001',
          event: 'planned',
          loop: 'drain',
          provenance: 'test',
          plan,
        }),
      ].join('\n') + '\n',
      'utf-8',
    );
  }

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `loop-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`,
      );
    }
  });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
    project = join(sandbox, 'proj');
    flowDir = join(project, 'flow');
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(sandbox, 'vault'), { recursive: true });
    seedDirective('probe', PROBE_DIRECTIVE);
    seedDirective('gated', GATED_DIRECTIVE);
    seedDirective('drain', DRAIN_DIRECTIVE);

    // The fake `gh` is dropped for every test and reached by none of them
    // unless it runs through `ghLoop` — PATH is only extended there. The
    // GITHUB_DIRECTIVE is deliberately NOT seeded here: a `queue: github`
    // directive on disk would make the loops-wide verbs shell out to `gh` in
    // ledger-only tests that never put it on PATH.
    ghPath = join(sandbox, 'ghbin');
    mkdirSync(ghPath, { recursive: true });
    writeFileSync(join(ghPath, 'gh'), FAKE_GH, 'utf-8');
    chmodSync(join(ghPath, 'gh'), 0o755);
    ghLog = join(sandbox, 'gh-calls.jsonl');
    writeFileSync(ghLog, '', 'utf-8');

    // The repository as a correctly SET UP repo looks: it already has this
    // system's vocabulary and the loop's own provenance label — and it does
    // NOT have `codemap`, because a topic is the user's word, invented at the
    // moment they re-point a loop. That absence is what makes a skipped
    // `gh label create` fail here rather than pass quietly.
    ghStore = join(sandbox, 'gh-store.json');
    writeGhStore({ labels: ['needs-approval', 'not-now', 'in-progress', 'qa-heartbeat'] });
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ── Task 8.1: the queue, through the shipped binary ──────

  /**
   * The producer's guard rail, end to end through the real CLI.
   *
   * An instruction like "find UI improvements" has no natural end — an agent
   * will keep producing plausible findings forever. What must be true is that
   * the hunt STOPS at the number, on its own, without a person watching; and
   * that the count survives the run that filed against it, because a cap that
   * resets every run is not a cap.
   */
  describe('an instruction stops at its cap', () => {
    it('counts across runs and then refuses to file, naming both numbers', () => {
      // Open the gate with a typed instruction and a cap of two.
      // Cap of ONE, deliberately below the fixture's open-item cap: otherwise
      // the queue's own cap refuses first and this proves nothing about the
      // instruction.
      const gate = loop('next', '--loop', 'probe', '--focus', 'find gaps in the widget parser', '--cap', '1');
      expect(gate.status).toBe(0);

      const owner = String((gate.json as Record<string, unknown>).owner);
      const file = (title: string) =>
        loop('file', '--loop', 'probe', '--owner', owner, '--title', title, '--body', 'Reproduced.');

      expect(file('First real finding').status).toBe(0);

      // The second is refused — and the refusal names what was filed and the
      // cap, so the reader knows whether to raise it or go and look at the list.
      const third = file('Second finding, over the cap');
      expect(third.status).toBe(1);
      // `CliRun` carries no `stderr` field — the combined transcript IS the
      // field (#15), and reading a non-existent one stringified to `undefined`.
      const transcript = third.transcript;
      expect(transcript).toContain('filed 1 of 1');
      expect(transcript).toContain('let a person look');
    });

    it('a run with no instruction is capped by nothing — the directive still bounds it', () => {
      // The instruction is opt-in. A producer that was simply started keeps the
      // behaviour it always had, or every existing loop would stop at 20.
      const gate = loop('next', '--loop', 'probe');
      expect(gate.status).toBe(0);
      const owner = String((gate.json as Record<string, unknown>).owner);
      expect(
        loop('file', '--loop', 'probe', '--owner', owner, '--title', 'Uncapped finding', '--body', 'x').status,
      ).toBe(0);
    });
  });

  describe('Task 8.1 — file, dedup, cap, claim, approve, close', () => {
    it(
      'files a finding, embeds its fingerprint, and records it in the ledger',
      () => {
        const filed = loop(
          'file',
          '--loop',
          'probe',
          '--title',
          'Null deref in the widget parser',
          '--body',
          'Reproduced with `node repro.js`.',
          '--file',
          'src/parser.ts',
        );

        expect(filed.status).toBe(0);
        expect(filed.json).toMatchObject({ status: 'filed', loop: 'probe' });

        const item = filed.json?.item as Record<string, unknown>;
        expect(item.title).toBe('Null deref in the widget parser');
        expect(item.state).toBe('open');
        expect(item.approved).toBe(true);
        // The dedup key is written by the BACKEND into the body — a caller
        // never supplies it, and the marker is what a later search matches.
        expect(String(item.body)).toContain(`<!-- loop-fp: ${String(item.fingerprint)} -->`);
        expect(String(item.body)).toContain('<!-- loop: probe -->');
        expect(String(item.body)).toContain('<!-- loop-file: src/parser.ts -->');

        const ledger = readFileSync(join(flowDir, 'loops', 'queue.jsonl'), 'utf-8').trim();
        expect(ledger.split('\n')).toHaveLength(1);
        expect(JSON.parse(ledger)).toMatchObject({ event: 'filed' });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'suppresses a cosmetically-different re-report of the same finding',
      () => {
        const first = loop(
          'file',
          '--loop',
          'probe',
          '--title',
          'Null deref in the widget parser',
          '--file',
          'src/parser.ts',
        );
        expect(first.json?.status).toBe('filed');

        // Same finding, different words for it — punctuation, case and digits
        // are normalized away, so the fingerprint collides.
        const second = loop(
          'file',
          '--loop',
          'probe',
          '--title',
          'NULL DEREF in the widget parser!!',
          '--file',
          'src/parser.ts',
        );

        // A duplicate is an ORDINARY outcome: exit 0, not a refusal.
        expect(second.status).toBe(0);
        expect(second.json?.status).toBe('duplicate');
        expect((second.json?.item as Record<string, unknown>).id).toBe(
          (first.json?.item as Record<string, unknown>).id,
        );
        // and nothing new reached the store
        expect(
          readFileSync(join(flowDir, 'loops', 'queue.jsonl'), 'utf-8').trim().split('\n'),
        ).toHaveLength(1);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses to file past the open-item cap — one line, exit 1, nothing written',
      () => {
        expect(loop('file', '--loop', 'probe', '--title', 'First finding').json?.status).toBe(
          'filed',
        );
        expect(loop('file', '--loop', 'probe', '--title', 'Second finding').json?.status).toBe(
          'filed',
        );

        const refused = loop('file', '--loop', 'probe', '--title', 'Third finding');

        expect(refused.status).toBe(1);
        expect(refused.transcript).toContain('loop refused: open-item cap reached — 2 open, max 2');
        // ONE refusal line, never doubled
        expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        expect(
          readFileSync(join(flowDir, 'loops', 'queue.jsonl'), 'utf-8').trim().split('\n'),
        ).toHaveLength(2);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a duplicate at the cap still reports duplicate, never "cap reached"',
      () => {
        loop('file', '--loop', 'probe', '--title', 'First finding', '--file', 'src/a.ts');
        loop('file', '--loop', 'probe', '--title', 'Second finding', '--file', 'src/b.ts');

        const again = loop(
          'file',
          '--loop',
          'probe',
          '--title',
          'First finding',
          '--file',
          'src/a.ts',
        );

        expect(again.status).toBe(0);
        expect(again.json?.status).toBe('duplicate');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'claims the oldest eligible item and records who holds it',
      () => {
        loop('file', '--loop', 'probe', '--title', 'Older finding', '--file', 'src/a.ts');
        loop('file', '--loop', 'probe', '--title', 'Newer finding', '--file', 'src/b.ts');

        const claimed = loop('claim', '--loop', 'probe', '--owner', 'beat-1');

        expect(claimed.status).toBe(0);
        expect(claimed.json).toMatchObject({ status: 'claimed', owner: 'beat-1' });
        const item = claimed.json?.item as Record<string, unknown>;
        expect(item.title).toBe('Older finding');
        expect(item.claimedBy).toBe('beat-1');

        // A second beat cannot take what the first holds.
        const stolen = loop('claim', '--loop', 'probe', '--owner', 'beat-2', '--id', String(item.id));
        expect(stolen.status).toBe(1);
        expect(stolen.transcript).toContain(
          `loop refused: item ${String(item.id)} is already claimed by 'beat-1'`,
        );
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'holds a gated finding behind approval until `loop approve` clears it',
      () => {
        const filed = loop('file', '--loop', 'gated', '--title', 'Rework the rail affordance');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        expect((filed.json?.item as Record<string, unknown>).approved).toBe(false);
        expect((filed.json?.item as Record<string, unknown>).labels).toContain('needs-approval');

        // Nothing to claim — the gate is not a failure, so the queue reads empty.
        const empty = loop('claim', '--loop', 'gated', '--owner', 'beat-1');
        expect(empty.status).toBe(0);
        expect(empty.json).toMatchObject({ status: 'empty' });

        // Naming it directly says exactly why.
        const named = loop('claim', '--loop', 'gated', '--owner', 'beat-1', '--id', id);
        expect(named.status).toBe(1);
        expect(named.transcript).toContain(
          `loop refused: item ${id} is awaiting approval (needs-approval)`,
        );

        const approved = loop('approve', '--loop', 'gated', '--id', id);
        expect(approved.status).toBe(0);
        expect(approved.json).toMatchObject({ status: 'approved', alreadyApproved: false });

        // Repeating an approval is success, not an error.
        const repeated = loop('approve', '--loop', 'gated', '--id', id);
        expect(repeated.status).toBe(0);
        expect(repeated.json).toMatchObject({ status: 'approved', alreadyApproved: true });

        const claimed = loop('claim', '--loop', 'gated', '--owner', 'beat-1');
        expect(claimed.status).toBe(0);
        expect(claimed.json).toMatchObject({ status: 'claimed' });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'closes on captured exit codes — and refuses to close on prose alone',
      () => {
        const filed = loop('file', '--loop', 'probe', '--title', 'Broken import path');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        loop('claim', '--loop', 'probe', '--owner', 'beat-1', '--id', id);

        // Prose alone — the single most important refusal in the feature.
        const prose = loop(
          'close',
          '--loop',
          'probe',
          '--id',
          id,
          '--reason',
          'done',
          '--owner',
          'beat-1',
          '--detail',
          'I checked it carefully and it definitely works now',
        );
        expect(prose.status).toBe(1);
        expect(prose.transcript).toContain(
          "loop refused: a 'done' close requires machine-checkable evidence",
        );

        // A recorded FAILING command is not evidence of success either.
        const failing = loop(
          'close',
          '--loop',
          'probe',
          '--id',
          id,
          '--reason',
          'done',
          '--owner',
          'beat-1',
          '--evidence',
          JSON.stringify({ commands: [{ command: 'npm run test', exitCode: 1 }] }),
        );
        expect(failing.status).toBe(1);
        expect(failing.transcript).toContain("loop refused: evidence command 'npm run test' exited 1");

        // Neither refusal closed anything.
        const stillOpen = loop('status', '--loop', 'probe');
        expect(
          ((stillOpen.json?.loops as Record<string, unknown>[])[0].queue as Record<string, number>)
            .open,
        ).toBe(1);

        const closed = loop(
          'close',
          '--loop',
          'probe',
          '--id',
          id,
          '--reason',
          'done',
          '--owner',
          'beat-1',
          '--evidence',
          JSON.stringify({
            commands: [
              { command: 'npx tsc --noEmit', exitCode: 0 },
              { command: 'npm run test -- src/parser.test.ts', exitCode: 0 },
            ],
            summary: 'the import resolves and the suite passes',
          }),
        );
        expect(closed.status).toBe(0);
        expect(closed.json).toMatchObject({ status: 'closed', reason: 'done' });
        expect((closed.json?.item as Record<string, unknown>).state).toBe('closed');

        // The closed item stays the queue's MEMORY: re-filing it is a duplicate,
        // not a new finding.
        const refiled = loop('file', '--loop', 'probe', '--title', 'Broken import path');
        expect(refiled.json?.status).toBe('duplicate');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a wontfix close needs no commands but does need a written reason',
      () => {
        const filed = loop('file', '--loop', 'probe', '--title', 'Rename every variable');
        const id = String((filed.json?.item as Record<string, unknown>).id);

        const bare = loop('close', '--loop', 'probe', '--id', id, '--reason', 'wontfix');
        expect(bare.status).toBe(1);
        expect(bare.transcript).toContain("loop refused: a 'wontfix' close requires a written reason");

        const explained = loop(
          'close',
          '--loop',
          'probe',
          '--id',
          id,
          '--reason',
          'wontfix',
          '--detail',
          'churn with no behaviour change — never file this again',
        );
        expect(explained.status).toBe(0);
        expect(explained.json).toMatchObject({ status: 'closed', reason: 'wontfix' });
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── Task 8.2: the gate ───────────────────────────────────

  // Phase 6 note: this block used to also prove the circuit breaker — three
  // failed beats trip it, `loop resume` clears it. Nothing schedules unattended
  // re-runs any more, so counting consecutive failures protected nobody and the
  // breaker was deleted with the engine around it. What is left is what a run
  // still asks the gate: am I paused, and is there a free slot.
  describe('Task 8.2 — pause, resume and the run-slot TTL', () => {
    it(
      'a paused loop really stops, and resume really lets it run again',
      () => {
        const before = loop('next', '--loop', 'probe', '--owner', 'beat-0', '--no-pull');
        expect(before.json?.verdict).toBe('proceed');
        // That beat ends properly, so its lock is not what stops the next one.
        loop(
          'log',
          '--loop',
          'probe',
          '--owner',
          'beat-0',
          '--record',
          JSON.stringify({ kind: 'beat', loop: 'probe', outcome: 'success' }),
        );

        const paused = loop('pause', '--loop', 'probe', '--reason', 'noisy findings');
        expect(paused.status).toBe(0);
        expect(paused.json).toMatchObject({ status: 'paused', scope: 'loop' });

        const gated = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        // A gated beat is not a failure — exit 0 with the verdict in the JSON.
        expect(gated.status).toBe(0);
        expect(gated.json).toMatchObject({ verdict: 'paused' });
        expect(String(gated.json?.reason)).toContain("loop 'probe' is paused — noisy findings");
        // and it took NO lock
        expect(gated.json?.lock).toBeNull();

        const resumed = loop('resume', '--loop', 'probe', '--detail', 'tuned the mission');
        expect(resumed.json).toMatchObject({ status: 'resumed', scope: 'loop' });

        const after = loop('next', '--loop', 'probe', '--owner', 'beat-2', '--no-pull');
        expect(after.json?.verdict).toBe('proceed');
        expect((after.json?.lock as Record<string, unknown>).owner).toBe('beat-2');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a global pause stops every loop, whatever the loop asked for',
      () => {
        loop('pause', '--reason', 'deploying');

        for (const name of ['probe', 'drain']) {
          const gated = loop('next', '--loop', name, '--owner', 'beat-1', '--no-pull');
          expect(gated.json?.verdict).toBe('paused');
          expect(String(gated.json?.reason)).toContain('all loops are paused — deploying');
        }

        loop('resume');
        expect(loop('next', '--loop', 'probe', '--owner', 'beat-2', '--no-pull').json?.verdict).toBe(
          'proceed',
        );
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a pause with an expiry lifts itself, so a forgotten pause cannot stop a loop forever',
      () => {
        // An expiry already in the past: the pause is written, and the very next
        // read drops it. Self-expiry on READ is the property under test.
        loop('pause', '--loop', 'probe', '--reason', 'brief hold', '--until', '2020-01-01T00:00:00Z');

        const next = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        expect(next.json?.verdict).toBe('proceed');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a live slot excludes the next beat — and an expired one lets it through',
      () => {
        const first = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        expect(first.json?.verdict).toBe('proceed');
        expect((first.json?.lock as Record<string, unknown>).owner).toBe('beat-1');

        const blocked = loop('next', '--loop', 'probe', '--owner', 'beat-2', '--no-pull');
        expect(blocked.status).toBe(0);
        expect(blocked.json?.verdict).toBe('locked');
        // The allocator hands out SLOTS now (Phase 6 kept it precisely because
        // it allocates git worktrees, which Claude Code does not do), so the
        // refusal names the table being full rather than "the loop is locked".
        expect(String(blocked.json?.reason)).toContain(
          "loop 'probe' has no free run slot — 'beat-1' holds one until",
        );

        // The SAME beat re-entering after a checkpoint is not locked out by its
        // own lock.
        const reentrant = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        expect(reentrant.json?.verdict).toBe('proceed');

        // beat-1 never came back. Its lock runs out, and beat-2 takes over.
        expireEveryLock();
        const takeover = loop('next', '--loop', 'probe', '--owner', 'beat-2', '--no-pull');
        expect(takeover.json?.verdict).toBe('proceed');
        expect((takeover.json?.lock as Record<string, unknown>).owner).toBe('beat-2');
        expect(
          ((readState().loops as Record<string, Record<string, Record<string, unknown>[]>>).probe
            .locks)[0].owner,
        ).toBe('beat-2');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'recording a beat gives its lock back, so the next beat is not excluded',
      () => {
        loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        loop(
          'log',
          '--loop',
          'probe',
          '--owner',
          'beat-1',
          '--record',
          JSON.stringify({ kind: 'beat', loop: 'probe', outcome: 'success', filed: 1 }),
        );

        const next = loop('next', '--loop', 'probe', '--owner', 'beat-2', '--no-pull');
        expect(next.json?.verdict).toBe('proceed');

        const digest = loop('log', '--loop', 'probe');
        expect(digest.json?.digest).toMatchObject({ beats: 1, success: 1, failure: 0, filed: 1 });
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── Task 8.3: the pipeline ───────────────────────────────
  //
  // DELETED IN PHASE 6, and deliberately not replaced. This block proved the
  // stalled-pipeline policy: a beat dies mid-stage, the next `loop next`
  // reports the same `stage`, takes the single `pipelineLock` and counts the
  // attempt, and the third failure abandons the pipeline and unclaims the item.
  // Every one of those subjects is gone — `loop next` reports no stage, no
  // stall and no pipeline lock, and the resume counting had no supervisor left
  // to act on it once the daemon's loop task was deleted. The one fact that
  // survived is that an in-flight stage IS a beat's honest ending, and that is
  // proved where it is now enforced: the close-enforcement round trip below,
  // and the Phase 5.3 block that follows.

  // ── Phase 5.3: the handoff survives the file being deleted ──

  /**
   * THE DEFECT, END TO END THROUGH THE SHIPPED BINARY (#1599, NFR-2).
   *
   * The unit tests around `deriveStage` passed while this was broken, which is
   * exactly why this plan requires a process-boundary proof: one process records
   * the plan on the item, the FILE the old handoff lived in is deleted the way a
   * completing skill deleted it, and the NEXT process — fresh, remembering
   * nothing — still has to find the pipeline.
   *
   * `rmSync` on `flow/STATE.md` is not a contrived fixture. It is the literal
   * instruction that stood in five pipeline skills: *Delete flow/STATE.md (skill
   * is done, no state to preserve)*.
   *
   * HOW PHASE 6 CHANGED WHAT THESE TESTS WATCH. They used to read the stage off
   * `loop next`, which reported one on every consumer gate. That field is gone
   * with the stalled-pipeline policy that was its only consumer, so the same
   * derivation is observed where it still DECIDES something: `loop log --record`,
   * whose honest-ending rule lets a run end holding an item only when a stage is
   * in flight, and whose early-stop rule lets a run report `empty` over a
   * non-empty queue only for the same reason. Same `claimedPlan` → `deriveStage`
   * path, same process boundary, and now an assertion about a refusal a run
   * actually meets rather than about a field nothing reads.
   */
  describe('Phase 5.3 — a deleted STATE.md no longer loses the pipeline', () => {
    /**
     * The interactive session's leavings with the file the skills deleted taken
     * away — and NO carrier item, so the only thing that can name a plan is the
     * record a test writes with `loop plan`. `seedPipeline`'s carrier would name
     * it by itself, which is exactly the shortcut these tests must not have.
     */
    function seedWithoutStateMd(plan: string, donePhases: number[]): void {
      seedSessionState(plan, donePhases);
      rmSync(join(flowDir, 'STATE.md'), { force: true });
      expect(existsSync(join(flowDir, 'STATE.md'))).toBe(false);
    }

    /** File one item into `drain` and return its id. */
    function fileOne(title: string): string {
      const filed = loop('file', '--loop', 'drain', '--title', title);
      return String((filed.json?.item as Record<string, unknown>).id);
    }

    /** Ask the CLI to end a run, the way a run prompt does. */
    function record(owner: string, extra: Record<string, unknown> = {}): CliRun {
      return loop(
        'log',
        '--loop',
        'drain',
        '--owner',
        owner,
        '--record',
        JSON.stringify({ kind: 'beat', loop: 'drain', outcome: 'success', ...extra }),
      );
    }

    it(
      'the plan on the claim IS the pipeline, so a run ends holding its item with the file deleted',
      () => {
        seedWithoutStateMd('widgets', [1, 2]);

        // A run claims its item and enters a stage — the two acts that used to
        // be recorded in a file, now recorded on the item itself.
        const id = fileOne('The item being worked');
        expect(loop('claim', '--loop', 'drain', '--owner', 'beat-1', '--id', id).status).toBe(0);
        const recorded = loop(
          'plan',
          '--loop',
          'drain',
          '--owner',
          'beat-1',
          '--id',
          id,
          '--plan',
          'widgets',
        );
        expect(recorded.status).toBe(0);
        expect(recorded.json?.plan).toBe('widgets');

        // A NEW process, with no STATE.md anywhere on disk, still derives wave 2
        // of 3 from the claim alone — which is what lets this run report success
        // while the item stays claimed. Without the derivation the honest-ending
        // rule refuses, and the run could not record its line at all.
        const ended = record('beat-1');
        expect(ended.status).toBe(0);
        expect(ended.json).toMatchObject({ status: 'recorded' });

        // HELD ON PURPOSE: the hand-off is the item staying where it is.
        const status = loop('status', '--loop', 'drain');
        expect((status.json?.loops as Record<string, unknown>[])[0].queue).toMatchObject({
          open: 1,
          claimed: 1,
        });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'hands the pipeline to the NEXT run — a different owner, still no file',
      () => {
        seedWithoutStateMd('widgets', [1, 2]);
        const held = fileOne('The item being worked');
        loop('claim', '--loop', 'drain', '--owner', 'beat-1', '--id', held);
        loop('plan', '--loop', 'drain', '--owner', 'beat-1', '--id', held, '--plan', 'widgets');
        // Ordinary claimable work beside it, so "there was nothing left to do"
        // is a claim the CLI can weigh rather than a vacuous one.
        fileOne('ordinary work, nobody claimed');

        // The run that entered the stage ends and its slot runs out. This is the
        // exact gap the defect lived in: everything beat-1 knew is gone.
        loop(
          'log',
          '--loop',
          'drain',
          '--owner',
          'beat-1',
          '--record',
          JSON.stringify({ kind: 'beat', loop: 'drain', outcome: 'failure', reason: 'beat-1 died' }),
        );
        expireEveryLock();

        // beat-2 holds nothing and has read no file, yet reporting `empty` over
        // a queue with a claimable item is accepted — because the stage beat-1
        // left in flight, named by the record on beat-1's claim, is the run.
        const second = record('beat-2', { stopCondition: 'empty' });
        expect(second.status).toBe(0);
        expect(second.json).toMatchObject({ status: 'recorded' });

        // THE CONTRAST, so this proves the pipeline and not the wording: with the
        // record cleared, the identical ending from a fresh run is refused.
        loop('plan', '--loop', 'drain', '--owner', 'beat-1', '--id', held);
        const third = record('beat-3', { stopCondition: 'empty' });
        expect(third.status).toBe(1);
        expect(third.transcript).toContain('still claimable');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'clearing the record ends the pipeline — no file, and nothing on disk is guessed at',
      () => {
        // Docs and artifact only — the ONE plan record in this project is the
        // one this test writes and then clears, so clearing it must end the
        // pipeline (a seeded carrier would keep naming it).
        seedWithoutStateMd('widgets', [1, 2]);
        const id = fileOne('The item being worked');
        loop('claim', '--loop', 'drain', '--owner', 'beat-1', '--id', id);
        loop('plan', '--loop', 'drain', '--owner', 'beat-1', '--id', id, '--plan', 'widgets');

        // Same verb, no `--plan`: the run is finished with the pipeline.
        const cleared = loop('plan', '--loop', 'drain', '--owner', 'beat-1', '--id', id);
        expect(cleared.status).toBe(0);
        expect(cleared.json?.plan).toBe('');

        // `plan_widgets_v1.md` and its artifact are STILL on disk — and are not
        // mistaken for a live pipeline (C-2: with 10+ finished features present,
        // scanning would report an arbitrary one as permanently in flight). So
        // there is no hand-off left, and the run may not end holding the item.
        expect(existsSync(join(flowDir, 'plans', 'plan_widgets_v1.md'))).toBe(true);
        const refused = record('beat-1');
        expect(refused.status).toBe(1);
        expect(refused.transcript).toContain(`item ${id}`);
        expect(refused.transcript).toContain('a pipeline stage in flight');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      "a STATE.md with no claim record is NO pipeline — the interactive session's mirror never dispatches",
      () => {
        // The interactive session's leavings exactly: the file, the artifact,
        // the docs — and no plan record on any item. This used to resolve as a
        // dispatchable `wave 2 of widgets` (the windows_support phantom); the
        // handoff rides the claim, and nothing here carries one.
        seedSessionState('widgets', [1, 2]);
        expect(existsSync(join(flowDir, 'STATE.md'))).toBe(true);
        const id = fileOne('The item being worked');
        expect(loop('claim', '--loop', 'drain', '--owner', 'beat-1', '--id', id).status).toBe(0);

        // The file names a plan whose artifact says wave 2 of 3 is pending, and
        // it buys this run nothing: with no record on the claim there is no
        // stage, so ending while still holding the item is refused.
        const refused = record('beat-1');
        expect(refused.status).toBe(1);
        expect(refused.transcript).toContain(`item ${id}`);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      "the file is NEVER promoted onto a claim — a held item stays clean of the session's plan",
      () => {
        // THE RETIRED BRIDGE, proven gone. The gate used to stamp STATE.md's
        // plan onto the single item a run held ("promotion", #1599's migration
        // path) — which is how a human's unrelated plan could be written onto
        // a loop's item as a durable wrong marker. Here a run holds an item,
        // the file names a plan, and the gate is opened twice.
        seedSessionState('widgets', [1, 2]);
        const id = fileOne('The item being worked');
        expect(loop('claim', '--loop', 'drain', '--owner', 'beat-1', '--id', id).status).toBe(0);

        expect(loop('next', '--loop', 'drain', '--owner', 'beat-1', '--no-pull').json?.verdict).toBe(
          'proceed',
        );
        expect(loop('next', '--loop', 'drain', '--owner', 'beat-1', '--no-pull').json?.verdict).toBe(
          'proceed',
        );

        // THE LEDGER IS THE PROOF: a promotion would be a `planned` event on the
        // item, and there is none — the gate wrote nothing about a plan at all.
        expect(queueLines().some((line) => line.event === 'planned')).toBe(false);

        // and the derivation agrees, at the seam that still reads it: no stage,
        // so the run cannot end holding what it claimed.
        expect(record('beat-1').status).toBe(1);
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── Phase 4: topics, through the shipped binary ──────────
  //
  // `topic:` rides the label path `file()` already merges, which is exactly why
  // it needs a process-boundary test: the in-process suite proves the merge, and
  // these prove the merged array survives argv parsing, a directive read from
  // real disk, a store written by one process, and a read back by the NEXT one.

  describe('Task 4.1–4.3 — a topic reaches the store, survives re-pointing, and refuses when malformed', () => {
    it(
      'labels a filed item with its topic AND keeps the provenance label beside it',
      () => {
        seedDirective('sweep', TOPICAL_DIRECTIVE);

        const filed = loop(
          'file',
          '--loop',
          'sweep',
          '--title',
          'Codemap entry points at a deleted module',
          '--file',
          'src/codemap.ts',
        );

        expect(filed.status).toBe(0);
        expect(filed.json?.status).toBe('filed');
        const labels = (filed.json?.item as Record<string, unknown>).labels as string[];
        // BOTH, not either: provenance says WHICH loop filed this, the topic
        // says WHERE it was working, and giving the topic the existing label
        // path must not cost the field that path already carried.
        expect(labels).toContain('codemap');
        expect(labels).toContain('qa-heartbeat');
        // and nothing invented a queue-state label along the way
        expect(labels).not.toContain('needs-approval');

        // The store the NEXT process reads carries both too — a label that
        // exists only in this run's JSON reply is a label no beat can query.
        const [line] = queueLines();
        expect(line).toMatchObject({ event: 'filed' });
        expect(line.labels).toEqual(expect.arrayContaining(['qa-heartbeat', 'codemap']));

        // and the loop reports where it is working, in the slot the engine used
        // to waste (`sweep [codemap]`, not `sweep [producer]`)
        const status = loop('status', '--loop', 'sweep', '--human');
        expect(status.stdout).toContain('sweep [codemap]');
        expect(status.stdout).not.toContain('sweep [producer]');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      're-pointing a loop reports the old finding as a duplicate, never as new work',
      () => {
        seedDirective('sweep', TOPICAL_DIRECTIVE);
        const first = loop(
          'file',
          '--loop',
          'sweep',
          '--title',
          'Codemap entry points at a deleted module',
          '--file',
          'src/codemap.ts',
        );
        expect(first.json?.status).toBe('filed');

        // The steering commit: one field changed on disk, and the next beat is
        // a NEW PROCESS that reads it. This is the failure the fingerprint
        // decision exists to prevent — a topic inside it would make every
        // re-point re-file the entire backlog under the new word.
        seedDirective('sweep', REPOINTED_DIRECTIVE);

        const again = loop(
          'file',
          '--loop',
          'sweep',
          '--title',
          'Codemap entry points at a deleted module',
          '--file',
          'src/codemap.ts',
        );
        expect(again.status).toBe(0);
        expect(again.json?.status).toBe('duplicate');
        expect((again.json?.item as Record<string, unknown>).id).toBe(
          (first.json?.item as Record<string, unknown>).id,
        );

        // Nothing new reached the store, and the old item keeps the topic it was
        // filed under — re-pointing steers what comes NEXT, it does not rewrite
        // where the loop has already been.
        expect(queueLines()).toHaveLength(1);
        expect((again.json?.item as Record<string, unknown>).labels).toContain('codemap');
        expect((again.json?.item as Record<string, unknown>).labels).not.toContain('docs');

        // A genuinely new finding lands under the new topic, which is the whole
        // point of having re-pointed.
        const fresh = loop('file', '--loop', 'sweep', '--title', 'Docs page links nowhere');
        expect(fresh.json?.status).toBe('filed');
        expect((fresh.json?.item as Record<string, unknown>).labels).toContain('docs');
      },
      E2E_TIMEOUT_MS,
    );

    it.each([
      ['Codemap', "malformed topic 'Codemap'"],
      ['code map', "malformed topic 'code map'"],
      ['$(whoami)', "malformed topic '$(whoami)'"],
      ['in-progress', "reserved topic 'in-progress'"],
    ])(
      'refuses the topic %s — one line, exit 1, nothing written',
      (topic, expected) => {
        seedDirective('sweep', TOPICAL_DIRECTIVE.replace('topic: codemap', `topic: ${topic}`));

        const refused = loop('file', '--loop', 'sweep', '--title', 'Anything at all');

        expect(refused.status).toBe(1);
        expect(refused.transcript).toContain('loop refused:');
        // The offending value, VERBATIM: refusing rather than sanitizing is only
        // worth anything if the user can see what was rejected.
        expect(refused.transcript).toContain(expected);
        expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        // and the refusal names the file that has to change
        expect(refused.transcript).toContain('sweep.md');

        // NOTHING WRITTEN — a refused directive must not leave a half-made queue
        // behind for the next beat to inherit.
        expect(existsSync(queuePath())).toBe(false);
        // A refusal emits no machine line at all — a beat parsing stdout gets
        // nothing to mistake for a filed item. (The refusal text itself IS on
        // stdout: this CLI's `error()` routes through `console.log`, which is
        // why every assertion above reads the combined transcript.)
        expect(refused.json).toBeNull();
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── Task 4.4: the renamed claim label, against a real `gh` argv ──

  describe('Task 4.4 — claim adds `in-progress`, unclaim removes it, `claimed` is gone', () => {
    beforeEach(() => {
      seedDirective('ship', GITHUB_DIRECTIVE);
    });

    it(
      'creates the missing topic label before filing, says so, and leaves the vocabulary alone',
      () => {
        const filed = ghLoop('file', '--loop', 'ship', '--title', 'Codemap points at a ghost');

        expect(filed.status).toBe(0);
        expect(filed.json?.status).toBe('filed');

        const calls = ghCalls();
        const created = calls.findIndex((argv) => argv[0] === 'label' && argv[1] === 'create');
        const opened = calls.findIndex((argv) => argv[0] === 'issue' && argv[1] === 'create');
        // ORDER IS THE POINT: `gh issue create --label` refuses a label the repo
        // does not have (the fake refuses it too), so a create that ran first
        // would file an item that silently lost its topic.
        expect(created).toBeGreaterThanOrEqual(0);
        expect(created).toBeLessThan(opened);
        expect(calls[created]).toEqual(['label', 'create', 'codemap', '--repo', 'acme/widgets', '--force']);

        // A write to someone's repo CONFIGURATION is never silent — and it goes
        // to stderr, so the single JSON line a beat parses on stdout is intact.
        expect(filed.transcript).toContain("loop: ensured topic label 'codemap' in acme/widgets");
        expect(filed.stdout.trim().split('\n')).toHaveLength(1);

        // The rule the exception did NOT bend: no reserved label was created.
        expect(
          calls.filter((argv) => argv[0] === 'label' && argv[1] === 'create').map((argv) => argv[2]),
        ).toEqual(['codemap']);

        const id = String((filed.json?.item as Record<string, unknown>).id);
        expect(issueLabels(id)).toEqual(expect.arrayContaining(['qa-heartbeat', 'codemap']));
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'files a second finding under the same topic without asking `gh` twice',
      () => {
        expect(ghLoop('file', '--loop', 'ship', '--title', 'First ghost').json?.status).toBe('filed');
        expect(ghLoop('file', '--loop', 'ship', '--title', 'Second ghost').json?.status).toBe('filed');

        // Once per topic PER BEAT — two beats are two processes, so two calls is
        // the honest floor; what must never happen is one beat calling it per
        // filed item.
        const creates = ghCalls().filter((argv) => argv[0] === 'label' && argv[1] === 'create');
        expect(creates).toHaveLength(2);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'round-trips the claim label through the real argv — `in-progress` on, then off',
      () => {
        const filed = ghLoop('file', '--loop', 'ship', '--title', 'Codemap points at a ghost');
        const id = String((filed.json?.item as Record<string, unknown>).id);

        const claimed = ghLoop('claim', '--loop', 'ship', '--owner', 'beat-1', '--id', id);
        expect(claimed.status).toBe(0);
        expect((claimed.json?.item as Record<string, unknown>).labels).toContain('in-progress');
        expect(issueLabels(id)).toContain('in-progress');
        // The rename is only real if it reached the WIRE. `claimed` does not
        // exist in the fixture repo, so a binary still saying it would have been
        // refused by `gh` here rather than passing quietly.
        expect(ghCalls()).toContainEqual(
          expect.arrayContaining(['issue', 'edit', id, '--add-label', 'in-progress']),
        );

        const released = ghLoop('unclaim', '--loop', 'ship', '--owner', 'beat-1', '--id', id);
        expect(released.status).toBe(0);
        expect(released.json).toMatchObject({ status: 'unclaimed', wasClaimed: true });
        expect((released.json?.item as Record<string, unknown>).labels).not.toContain('in-progress');
        expect(issueLabels(id)).not.toContain('in-progress');
        expect(ghCalls()).toContainEqual(
          expect.arrayContaining(['issue', 'edit', id, '--remove-label', 'in-progress']),
        );

        // and the released item is workable again by whoever comes next
        const next = ghLoop('claim', '--loop', 'ship', '--owner', 'beat-2');
        expect(next.json).toMatchObject({ status: 'claimed', owner: 'beat-2' });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'never names the old `claimed` label anywhere in a full file/claim/unclaim/close arc',
      () => {
        const filed = ghLoop('file', '--loop', 'ship', '--title', 'Codemap points at a ghost');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        ghLoop('claim', '--loop', 'ship', '--owner', 'beat-1', '--id', id);
        ghLoop('unclaim', '--loop', 'ship', '--owner', 'beat-1', '--id', id);
        ghLoop('claim', '--loop', 'ship', '--owner', 'beat-1', '--id', id);
        const closed = ghLoop(
          'close',
          '--loop',
          'ship',
          '--id',
          id,
          '--owner',
          'beat-1',
          '--reason',
          'done',
          '--evidence',
          JSON.stringify({ commands: [{ command: 'npm run test', exitCode: 0 }] }),
        );
        expect(closed.status).toBe(0);

        // The whole label vocabulary this arc put on the wire, checked as a SET:
        // the old word is absent, and nothing unexpected slipped in beside it.
        const named = [...new Set(labelsNamed())].sort();
        expect(named).not.toContain('claimed');
        expect(named).toEqual(['codemap', 'in-progress', 'qa-heartbeat']);
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── Phase 3, at the process boundary: a beat cannot quietly leave an item open ──
  //
  // The refusal reads the DIRECTIVE, the PIPELINE and the QUEUE — three files
  // written by earlier processes — to decide whether this one may end. That is
  // precisely the seam an in-process test cannot see, and the failure it guards
  // (an item held by a beat that is never coming back, with the cap slowly
  // filling with ghosts) is invisible until a human counts open issues by hand.

  describe('the close-enforcement round trip, through the shipped binary', () => {
    /** Ask the CLI to end a beat, the way a beat prompt does. */
    function record(owner: string, outcome: 'success' | 'failure'): CliRun {
      return loop(
        'log',
        '--loop',
        'drain',
        '--owner',
        owner,
        '--record',
        JSON.stringify({ kind: 'beat', loop: 'drain', outcome, reason: `${owner} ended` }),
      );
    }

    /** File one item and claim it, returning its id. */
    function claimOne(owner: string, title: string): string {
      const filed = loop('file', '--loop', 'drain', '--title', title);
      const id = String((filed.json?.item as Record<string, unknown>).id);
      expect(loop('claim', '--loop', 'drain', '--owner', owner, '--id', id).status).toBe(0);
      return id;
    }

    /** The queue counts as `loop status` reports them. */
    function counts(): Record<string, number> {
      const status = loop('status', '--loop', 'drain');
      return (status.json?.loops as Record<string, unknown>[])[0].queue as Record<string, number>;
    }

    it(
      'refuses a success beat that did the work and forgot to close — item still open, still claimed',
      () => {
        const id = claimOne('beat-1', 'Widget parser drops the last row');
        loop('next', '--loop', 'drain', '--owner', 'beat-1', '--no-pull');
        const runsBefore = existsSync(join(flowDir, 'loops', 'runs.jsonl'))
          ? readFileSync(join(flowDir, 'loops', 'runs.jsonl'), 'utf-8')
          : '';

        const refused = record('beat-1', 'success');

        expect(refused.status).toBe(1);
        expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        // Named, so the refusal can be acted on rather than merely objected to.
        expect(refused.transcript).toContain(`item ${id}`);
        // and it teaches all three honest endings
        expect(refused.transcript).toContain('loop close --reason done');
        expect(refused.transcript).toContain('a pipeline stage in flight');
        expect(refused.transcript).toContain('loop unclaim');
        // No machine line — a beat that is refused has nothing to parse as a
        // recorded beat and can simply fix its ending and record again.
        expect(refused.json).toBeNull();

        // NOTHING PERSISTED: no beat line, no outcome, and the beat's own lock
        // still held — the beat did not end, so the next one must not think it
        // did.
        const runsAfter = existsSync(join(flowDir, 'loops', 'runs.jsonl'))
          ? readFileSync(join(flowDir, 'loops', 'runs.jsonl'), 'utf-8')
          : '';
        expect(runsAfter).toBe(runsBefore);
        const drain = (readState().loops as Record<string, Record<string, unknown>>).drain;
        expect(drain.lastOutcome).toBeUndefined();
        expect((drain.locks as Record<string, unknown>[])[0].owner).toBe('beat-1');

        // and the item is exactly where it was — the refusal changed nothing
        expect(counts()).toMatchObject({ open: 1, claimed: 1 });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'the same beat closes with captured evidence, and then records clean',
      () => {
        const id = claimOne('beat-1', 'Widget parser drops the last row');
        expect(record('beat-1', 'success').status).toBe(1);

        const closed = loop(
          'close',
          '--loop',
          'drain',
          '--id',
          id,
          '--owner',
          'beat-1',
          '--reason',
          'done',
          '--evidence',
          JSON.stringify({
            commands: [{ command: 'npm run test -- src/parser.test.ts', exitCode: 0 }],
            summary: 'the dropped row is back and the suite passes',
          }),
        );
        expect(closed.status).toBe(0);

        const ended = record('beat-1', 'success');
        expect(ended.status).toBe(0);
        expect(ended.json).toMatchObject({ status: 'recorded' });
        expect(counts()).toMatchObject({ open: 0, claimed: 0 });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'releasing the claim is the other honest ending — the item goes back to the queue',
      () => {
        const id = claimOne('beat-1', 'Widget parser drops the last row');
        expect(record('beat-1', 'success').status).toBe(1);

        const released = loop('unclaim', '--loop', 'drain', '--id', id, '--owner', 'beat-1');
        expect(released.status).toBe(0);
        expect(released.json).toMatchObject({ status: 'unclaimed', wasClaimed: true });
        expect((released.json?.item as Record<string, unknown>).claimedBy).toBeUndefined();

        const ended = record('beat-1', 'success');
        expect(ended.status).toBe(0);

        // RELEASED, NOT CLOSED: the finding is still real and still workable, so
        // the next beat can take it.
        expect(counts()).toMatchObject({ open: 1, claimed: 0 });
        const next = loop('claim', '--loop', 'drain', '--owner', 'beat-2');
        expect(next.json).toMatchObject({ status: 'claimed', owner: 'beat-2' });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'an in-flight pipeline stage IS the hand-off, so the beat ends holding the item',
      () => {
        const id = claimOne('beat-1', 'Widget parser drops the last row');
        seedPipeline('widgets', [1, 2]);

        const ended = record('beat-1', 'success');
        expect(ended.status).toBe(0);
        // Phase 6 stopped DERIVING a stage onto the line: the derivation existed
        // so the stalled-pipeline counter could not depend on a prompt, and that
        // counter is gone. The stage still decides whether this ending is
        // accepted — which is what the exit code above is reporting — it is just
        // no longer written down at the cost of a queue round trip.
        expect((ended.json?.entry as Record<string, unknown>).stage).toBeUndefined();
        // Held ON PURPOSE — the next beat resumes the stage still owning it.
        // Two open: the worked item, plus the seeded pipeline carrier.
        expect(counts()).toMatchObject({ open: 2, claimed: 1 });
        expect(id.length).toBeGreaterThan(0);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a back-dated claim is named — not merely counted — as an abandoned claim',
      () => {
        const id = claimOne('beat-1', 'Widget parser drops the last row');

        // Live, so nothing is stuck yet.
        const fresh = loop('status', '--loop', 'drain');
        expect((fresh.json?.loops as Record<string, unknown>[])[0].abandonedClaims).toEqual([]);

        // beat-1 took this and never came back.
        backdateClaims();

        const stale = loop('status', '--loop', 'drain');
        const claims = (stale.json?.loops as Record<string, unknown>[])[0]
          .abandonedClaims as Record<string, unknown>[];
        expect(claims).toHaveLength(1);
        expect(claims[0]).toMatchObject({ id, owner: 'beat-1', claimedAt: '2020-01-01T00:00:00.000Z' });
        expect(Number(claims[0].ageMs)).toBeGreaterThan(0);

        // NAMED in the human line: a count cannot be chased, and the whole
        // failure this reports is that the item was invisible.
        const human = loop('status', '--loop', 'drain', '--human');
        expect(human.stdout).toContain(`1 abandoned claim (${id})`);

        // A REPORT, NEVER AN ACTION — status is read-only, so it is still held.
        expect(counts()).toMatchObject({ open: 1, claimed: 1 });
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ══ Phase 5 ══════════════════════════════════════════════
  //
  // Every rule below exists because a beat did the wrong thing with nobody
  // watching: it halted after one item, it relabelled and rewrote a human's
  // issue, and it landed a branch. (A fourth — it ran well past its budget —
  // was answered by the run budget, which Phase 6 deleted: a run is a Claude
  // Code session now, and that session's end is the end.) Each was
  // written as a refusal in Phases 1-4; each is proved HERE against the real
  // binary, because the seam where those defects actually lived is the process
  // boundary — argv the CLI really builds, stores one process writes and the
  // next reads back, and exit codes a cron job really sees.

  // ── Task 5.1: a beat works until something stops it ──────

  describe('Task 5.1 — a beat keeps going, and names the condition that ended it', () => {
    it(
      'beats past its first finding and stops on the cap, saying which condition it was',
      () => {
        const gate = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        expect(gate.status).toBe(0);
        expect(gate.json?.verdict).toBe('proceed');
        // NOTHING IS STOPPING IT. This is the whole complaint the phase answers:
        // a beat that opened with `none` and halted anyway halted for no reason
        // it could name.
        expect(gate.json?.stopCondition).toBe('none');
        const startedAt = String(gate.json?.runStartedAt);
        // ONE STAMP, and it is the slot's — not a second timestamp beside it.
        expect(startedAt).toBe((gate.json?.lock as Record<string, unknown>).acquiredAt);

        // WHAT THE HUMAN SURFACE SAYS ABOUT `max_run_minutes` NOW. It used to
        // print a `budget:` line, and Phase 6 deleted the budget: the number
        // stops nothing, it only sizes how long a dead run's checkout stays
        // reserved. So the line names the slot and its reservation instead.
        const opened = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull', '--human');
        expect(opened.stdout).toContain(`slot 1: beat-1, started ${startedAt} (reserved until `);

        expect(
          loop('file', '--loop', 'probe', '--title', 'First finding', '--file', 'src/a.ts').json
            ?.status,
        ).toBe('filed');

        // The beat asks again after its first item — and is told to carry on.
        const mid = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        expect(mid.json?.verdict).toBe('proceed');
        expect(mid.json?.stopCondition).toBe('none');
        // Re-entering the gate does NOT restart the beat's clock.
        expect(mid.json?.runStartedAt).toBe(startedAt);

        expect(
          loop('file', '--loop', 'probe', '--title', 'Second finding', '--file', 'src/b.ts').json
            ?.status,
        ).toBe('filed');

        // Two open items against a cap of two: NOW something stops it, and the
        // condition is named rather than left to be read out of the prose.
        const stopped = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');
        expect(stopped.status).toBe(0);
        expect(stopped.json?.verdict).toBe('skip');
        expect(stopped.json?.stopCondition).toBe('cap');
        expect(String(stopped.json?.reason)).toContain('open-item cap reached — 2 open, max 2');
        // A skip takes no lock, so the beat is not left holding one it cannot use.
        expect(stopped.json?.lock).toBeNull();

        // and it reaches the human surface a person actually reads
        const human = loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull', '--human');
        expect(human.stdout).toContain('stop condition: cap');
        // A skip holds no slot, so the slot line is absent rather than reporting
        // a reservation this beat does not have.
        expect(human.stdout).not.toContain('slot ');

        // The beat ends carrying the condition, so "why did it stop" is a
        // COUNTABLE field on the record rather than prose in a transcript.
        const recorded = loop(
          'log',
          '--loop',
          'probe',
          '--owner',
          'beat-1',
          '--record',
          JSON.stringify({
            kind: 'beat',
            loop: 'probe',
            outcome: 'success',
            filed: 2,
            stopCondition: 'cap',
          }),
        );
        expect(recorded.status).toBe(0);
        expect(recorded.json?.entry).toMatchObject({ stopCondition: 'cap', filed: 2 });
        expect(runLines()).toHaveLength(1);
        expect(runLines()[0].stopCondition).toBe('cap');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a consumer with nothing to claim stops on `empty` — which is not a failure',
      () => {
        const gate = loop('next', '--loop', 'drain', '--owner', 'beat-1', '--no-pull');
        expect(gate.status).toBe(0);
        expect(gate.json?.verdict).toBe('skip');
        expect(gate.json?.stopCondition).toBe('empty');
        expect(String(gate.json?.reason)).toContain('a quiet queue is not a broken loop');
        // A skip takes no slot, and says so rather than reporting a start stamp
        // for a run that never opened.
        expect(gate.json?.lock).toBeNull();
        expect(gate.json?.runStartedAt).toBe('');

        const recorded = loop(
          'log',
          '--loop',
          'drain',
          '--owner',
          'beat-1',
          '--record',
          JSON.stringify({
            kind: 'beat',
            loop: 'drain',
            outcome: 'success',
            stopCondition: 'empty',
          }),
        );
        expect(recorded.status).toBe(0);
        expect(recorded.json?.entry).toMatchObject({ stopCondition: 'empty', outcome: 'success' });
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses a stop condition that is not one of the four, and records nothing',
      () => {
        loop('next', '--loop', 'probe', '--owner', 'beat-1', '--no-pull');

        const refused = loop(
          'log',
          '--loop',
          'probe',
          '--owner',
          'beat-1',
          '--record',
          JSON.stringify({
            kind: 'beat',
            loop: 'probe',
            outcome: 'success',
            stopCondition: 'ran out of ideas',
          }),
        );

        expect(refused.status).toBe(1);
        expect(refused.transcript).toContain(
          "loop refused: unknown stopCondition 'ran out of ideas' — expected cap|empty|budget|none",
        );
        expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        // A FIFTH WORD WOULD MAKE THE LOG UNCOUNTABLE, so the line is refused
        // outright rather than stored or silently dropped — and nothing at all
        // was written, so the beat can fix its ending and record again.
        expect(runLines()).toHaveLength(0);

        const fixed = loop(
          'log',
          '--loop',
          'probe',
          '--owner',
          'beat-1',
          '--record',
          JSON.stringify({ kind: 'beat', loop: 'probe', outcome: 'success', stopCondition: 'none' }),
          '--human',
        );
        expect(fixed.status).toBe(0);
        // `none` is a real condition, and the human line does not clutter itself
        // saying "nothing stopped it".
        expect(fixed.stdout).toContain('recorded: probe beat success');
        expect(fixed.stdout).not.toContain('stopped on');

        // `budget` SURVIVED THE BUDGET. Phase 6 deleted the run budget, so the
        // CLI no longer proves, derives or refuses on it — but a run may still
        // say its session ran long, and the word is still in the vocabulary the
        // refusal above enumerates. Recording it explicitly is accepted.
        const overlong = loop(
          'log',
          '--loop',
          'probe',
          '--owner',
          'beat-2',
          '--record',
          JSON.stringify({
            kind: 'beat',
            loop: 'probe',
            outcome: 'success',
            stopCondition: 'budget',
          }),
        );
        expect(overlong.status).toBe(0);
        expect(overlong.json?.entry).toMatchObject({ stopCondition: 'budget' });
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── Task 5.2: the run budget ─────────────────────────────
  //
  // DELETED IN PHASE 6, block and subject together. The budget proved that a
  // beat past its minutes could still close and release what it held, but not
  // take NEW work: `loop file` and `loop claim` refused, and an unreported
  // ending was filled in as `budget`. `run-budget.ts` is gone — a run lives in
  // a Claude Code session and that session's end is the end, so there is no
  // clock here to run out and nothing this CLI could prove about one.
  //
  // `budget` IS STILL A LEGAL WORD (it is in the stop vocabulary and the frozen
  // prompt assets name it): a run may report that its session ran long. The CLI
  // simply no longer derives it or refuses on it — see the vocabulary test
  // above, which records it explicitly and is accepted.

  // ── Task 5.3: a person's item is not the loop's to touch ──
  //
  // THE INCIDENT, EXACTLY. A consumer met a hand-filed issue, created a repo
  // label so the issue would fit its schema, rewrote the human's body, and
  // worked it. So the assertion that matters here is not the refusal — it is
  // the ABSENCE OF WRITES behind the refusal: with the fake `gh` on PATH, a
  // refused claim must have issued reads and nothing else, and the issue must
  // come back byte-identical.

  describe('Task 5.3 — a refused claim leaves a human\'s issue exactly as it was', () => {
    const HUMAN_BODY = [
      'When I click the rail twice the panel keeps the old width.',
      '',
      'Steps:',
      '1. open the board',
      '2. click the rail',
      '3. click it again',
    ].join('\n');

    /** Every `gh` call that would CHANGE something in the repository. */
    function ghWrites(): string[][] {
      return ghCalls().filter(
        (argv) =>
          (argv[0] === 'label' && argv[1] === 'create') ||
          (argv[0] === 'issue' && argv[1] !== 'list' && argv[1] !== 'view') ||
          argv.includes('--add-label') ||
          argv.includes('--remove-label') ||
          argv.includes('--body'),
      );
    }

    beforeEach(() => {
      seedDirective('ship', GITHUB_DIRECTIVE);
      writeGhStore({
        labels: ['needs-approval', 'not-now', 'in-progress', 'qa-heartbeat'],
        issues: [humanIssue(41, 'Rail affordance is wrong on the second click', HUMAN_BODY)],
      });
    });

    it(
      'refuses to claim it, names the way out, and issues not one write',
      () => {
        const refused = ghLoop('claim', '--loop', 'ship', '--owner', 'beat-1', '--id', '41');

        expect(refused.status).toBe(1);
        expect(refused.transcript).toContain(
          'loop refused: item 41 carries no loop marker — it was filed by a person',
        );
        expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        // The way out is a PERSON's act, named as one.
        expect(refused.transcript).toContain(
          'planflow-ai loop adopt --loop ship --id 41 --detail "<why>"',
        );
        expect(refused.transcript).toContain('no beat may');

        // THE ASSERTION THIS TEST EXISTS FOR. Everything the binary said to
        // `gh` was a read.
        expect(ghWrites()).toEqual([]);
        expect(ghCalls().length).toBeGreaterThan(0);
        expect(ghCalls().every((argv) => argv[0] === 'issue' && ['list', 'view'].includes(argv[1]))).toBe(
          true,
        );
        // No label was invented — not the loop's topic, not anything.
        expect(labelsNamed()).toEqual([]);
        expect(readGhStore().labels).toEqual([
          'needs-approval',
          'not-now',
          'in-progress',
          'qa-heartbeat',
        ]);

        // and the issue is byte-identical, down to its labels and its state
        const issue = ghIssue('41');
        expect(issue.body).toBe(HUMAN_BODY);
        expect(issue.labels).toEqual([{ name: 'bug' }]);
        expect(issue.state).toBe('OPEN');
        expect(issue.comments).toBeUndefined();
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'passes it over when sweeping — an empty in-tray, not a refusal, and still no write',
      () => {
        // Being pointed at one item is a refusal; sweeping the queue is not.
        // Stopping a whole beat because a person filed something is a refusal
        // nobody asked for.
        const swept = ghLoop('claim', '--loop', 'ship', '--owner', 'beat-1');

        expect(swept.status).toBe(0);
        expect(swept.json).toMatchObject({ status: 'empty' });
        expect(String(swept.json?.reason)).toContain("nothing claimable in loop 'ship'");
        expect(ghWrites()).toEqual([]);
        expect(ghIssue('41').body).toBe(HUMAN_BODY);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'and no beat can adopt it — a beat holds the loop for its whole life',
      () => {
        // A beat exists exactly as long as it holds the loop's lock, and while
        // that lock is held this verb refuses. So the rule does not rest on the
        // beat prompt failing to mention adoption: a beat cannot reach it.
        const beat = ghLoop('next', '--loop', 'ship', '--owner', 'beat-1', '--no-pull');
        expect(beat.json?.verdict).toBe('proceed');

        const refused = ghLoop('adopt', '--loop', 'ship', '--id', '41', '--detail', 'we own this area now');
        expect(refused.status).toBe(1);
        expect(refused.transcript).toContain("loop refused: loop 'ship' is running — run 'beat-1' holds it");
        expect(refused.transcript).toContain("is a person's decision, never a run's");
        expect(ghWrites()).toEqual([]);
        expect(ghIssue('41').body).toBe(HUMAN_BODY);

        // The beat ends. A PERSON adopts, and that one act — the only body
        // write in the system that lands on an item no loop filed — appends a
        // marker and leaves the prose alone.
        expireEveryLock();
        const adopted = ghLoop('adopt', '--loop', 'ship', '--id', '41', '--detail', 'we own this area now');
        expect(adopted.status).toBe(0);
        expect(adopted.json).toMatchObject({ status: 'adopted', loop: 'ship', id: '41' });

        const issue = ghIssue('41');
        expect(issue.body).toBe(`${HUMAN_BODY}\n\n<!-- loop: ship -->\n`);
        expect(issue.body.startsWith(HUMAN_BODY)).toBe(true);
        // ADOPTION RECONFIGURES NOTHING — no label added, none created.
        expect(issue.labels).toEqual([{ name: 'bug' }]);
        expect(labelsNamed()).toEqual([]);
        // and the beat log carries the one line a person auditing this reads
        expect(runLines().filter((line) => line.kind === 'adopt')).toHaveLength(1);

        // Only NOW is it workable.
        const claimed = ghLoop('claim', '--loop', 'ship', '--owner', 'beat-2', '--id', '41');
        expect(claimed.status).toBe(0);
        expect(claimed.json).toMatchObject({ status: 'claimed', owner: 'beat-2' });
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── Task 5.4: merging, the largest thing a loop may do alone ──

  describe('Task 5.4 — a loop lands only its own branch, only on real evidence', () => {
    /** A typecheck, a build and the tests — every one of them exited 0. */
    const FULL_EVIDENCE = JSON.stringify({
      commands: [
        { command: 'npm run typecheck', exitCode: 0 },
        { command: 'npm run build', exitCode: 0 },
        { command: 'npm run test -- src/parser.test.ts', exitCode: 0 },
      ],
      summary: 'the dropped row is back and the suite passes',
    });

    /**
     * File one finding into `probe` and open a pull request for its branch.
     *
     * The queue is the LEDGER while the pull request is real: that combination
     * is what makes "no `gh` call happened before the refusal" literally
     * assertable, because nothing else in the run has any reason to reach `gh`.
     */
    function fileWithPr(branch: string, prNumber: number): string {
      const filed = loop(
        'file',
        '--loop',
        'probe',
        '--title',
        'Widget parser drops the last row',
        '--file',
        'src/a.ts',
      );
      expect(filed.json?.status).toBe('filed');
      writeGhStore({
        prs: [
          {
            number: prNumber,
            headRefName: branch,
            state: 'OPEN',
            url: `https://github.com/acme/widgets/pull/${prNumber}`,
          },
        ],
      });
      return String((filed.json?.item as Record<string, unknown>).id);
    }

    it(
      'refuses every branch outside its own namespace — before it asks `gh` anything',
      () => {
        const id = fileWithPr('loop/probe/1', 12);

        const cases: Array<[string[], string]> = [
          [['--branch', 'main'], "a loop may merge only its own 'loop/probe' branches — 'main' is outside them"],
          [
            ['--branch', 'loop/other/12'],
            "a loop may merge only its own 'loop/probe' branches — 'loop/other/12' is outside them",
          ],
          // A refspec is refused outright rather than parsed: a merge takes a
          // branch, and a colon means the caller is describing something else.
          [['--branch', 'loop/probe/1:main'], "a merge takes a branch, not a refspec — 'loop/probe/1:main'"],
          [[], 'merging requires --branch <loop/probe.<id>>'],
        ];

        for (const [args, expected] of cases) {
          // Through `ghLoop` even though nothing should reach `gh`: if a gate
          // ever regressed, the fake logs the call instead of the real tool
          // running it.
          const refused = ghLoop('merge', '--loop', 'probe', '--id', id, ...args, '--evidence', FULL_EVIDENCE);
          expect(refused.status).toBe(1);
          expect(refused.transcript).toContain(`loop refused: ${expected}`);
          expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        }

        // NOT ONE `gh` CALL. A refusal that happened after the network was
        // reached would be a refusal that had already done something.
        expect(ghCalls()).toEqual([]);
        expect(queueLines().filter((line) => line.event === 'merged')).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses prose, a missing proof and a failed command — before it asks `gh` anything',
      () => {
        const id = fileWithPr('loop/probe/1', 12);
        const merge = (evidence?: string): CliRun =>
          ghLoop(
            'merge',
            '--loop',
            'probe',
            '--id',
            id,
            '--branch',
            'loop/probe/1',
            ...(evidence === undefined ? [] : ['--evidence', evidence]),
          );

        const none = merge();
        expect(none.status).toBe(1);
        expect(none.transcript).toContain(
          'loop refused: a merge requires machine-checkable evidence — a typecheck, a build and the targeted tests',
        );

        // "I checked it carefully" is not evidence here either.
        const prose = merge(JSON.stringify({ summary: 'I ran everything and it all looked fine' }));
        expect(prose.status).toBe(1);
        expect(prose.transcript).toContain('never prose alone');

        // Two of the three proofs is not the bar — and the refusal shows what
        // WAS recorded, so the beat's next move is to run the missing command.
        const partial = merge(
          JSON.stringify({
            commands: [
              { command: 'npm run typecheck', exitCode: 0 },
              { command: 'npx jest src/parser.test.ts', exitCode: 0 },
            ],
          }),
        );
        expect(partial.status).toBe(1);
        expect(partial.transcript).toContain(
          "loop refused: merge evidence is missing a build — recorded: 'npm run typecheck', 'npx jest src/parser.test.ts'",
        );

        // A RECORDED FAILURE IS NOT EVIDENCE OF SUCCESS.
        const failing = merge(
          JSON.stringify({
            commands: [
              { command: 'npm run typecheck', exitCode: 0 },
              { command: 'npm run build', exitCode: 1 },
              { command: 'npm run test', exitCode: 0 },
            ],
          }),
        );
        expect(failing.status).toBe(1);
        expect(failing.transcript).toContain(
          "loop refused: evidence command 'npm run build' exited 1 — a merge requires every recorded command to have exited 0",
        );

        expect(ghCalls()).toEqual([]);
        expect(queueLines().filter((line) => line.event === 'merged')).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'lands its own branch on full evidence, and records what landed on what',
      () => {
        const id = fileWithPr('loop/probe/1', 12);

        const merged = ghLoop(
          'merge',
          '--loop',
          'probe',
          '--id',
          id,
          '--branch',
          'loop/probe/1',
          '--evidence',
          FULL_EVIDENCE,
        );

        expect(merged.status).toBe(0);
        expect(merged.json).toMatchObject({
          status: 'merged',
          loop: 'probe',
          id,
          branch: 'loop/probe/1',
          pr: { number: '12', url: 'https://github.com/acme/widgets/pull/12' },
        });

        // THE REAL ARGV: resolve the pull request, then squash it. No
        // `--delete-branch` — the push carve-out refuses a branch deletion, and
        // merging is not where a loop acquires that power.
        expect(ghCalls()).toEqual([
          ['pr', 'view', 'loop/probe/1', '--json', 'number,headRefName,state,url'],
          ['pr', 'merge', '12', '--squash'],
        ]);
        expect(readGhStore().prs[0].state).toBe('MERGED');

        // The evidence travels VERBATIM into the record — a landed change whose
        // proof lives only in a transcript is a change nobody can audit later.
        const events = queueLines().filter((line) => line.event === 'merged');
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          id,
          detail: "merged 'loop/probe/1' via PR #12 (https://github.com/acme/widgets/pull/12)",
        });
        expect(events[0].evidence).toEqual(JSON.parse(FULL_EVIDENCE));

        // LANDING IS NOT SETTLING. The item is exactly as open as it was, so
        // `close`'s own evidence gate cannot be skipped by merging instead.
        expect((merged.json?.item as Record<string, unknown>).state).toBe('open');
        const status = loop('status', '--loop', 'probe');
        expect((status.json?.loops as Record<string, unknown>[])[0].queue).toMatchObject({
          open: 1,
          closed: 0,
        });

        // The one line in the beat log saying a loop changed the default branch.
        const lines = runLines().filter((line) => line.kind === 'merge');
        expect(lines).toHaveLength(1);
        expect(String(lines[0].reason)).toContain(`item ${id} merged — loop/probe/1 via PR #12`);

        // Merging the same branch twice is refused by the pull request's own
        // state, so a retrying beat cannot land anything a second time.
        const again = ghLoop(
          'merge',
          '--loop',
          'probe',
          '--id',
          id,
          '--branch',
          'loop/probe/1',
          '--evidence',
          FULL_EVIDENCE,
        );
        expect(again.status).toBe(1);
        expect(again.transcript).toContain(
          "loop refused: pull request #12 for 'loop/probe/1' is merged — only an open pull request can be merged",
        );
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'collapses a `gh` failure into one line, and lands nothing',
      () => {
        // Everything a STRING can be checked for passes: the branch is inside
        // this loop's namespace and the evidence covers all three proofs. What
        // is missing is the pull request itself — the beat pushed nothing, or
        // opened nothing — and that is only discoverable at the network.
        const id = fileWithPr('loop/probe/1', 12);
        writeGhStore({ prs: [] });

        const refused = ghLoop(
          'merge',
          '--loop',
          'probe',
          '--id',
          id,
          '--branch',
          'loop/probe/1',
          '--evidence',
          FULL_EVIDENCE,
        );

        expect(refused.status).toBe(1);
        // `gh` fails at length — a paragraph, sometimes with a URL in it. The
        // refusal contract is ONE line, so the collapse happens before anything
        // is printed rather than after a page of stderr already has been.
        expect(refused.transcript).toContain('loop refused: gh pr view loop/probe/1 failed:');
        expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        expect(
          refused.transcript.split('\n').filter((line) => line.includes('loop refused:')),
        ).toHaveLength(1);

        // It asked, was told no, and stopped — nothing was merged and nothing
        // was written on the item.
        expect(ghCalls().map((argv) => argv.slice(0, 2))).toEqual([['pr', 'view']]);
        expect(queueLines().filter((line) => line.event === 'merged')).toEqual([]);
        expect(runLines().filter((line) => line.kind === 'merge')).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'on a GitHub-backed loop it comments the evidence and closes nothing',
      () => {
        seedDirective('ship', GITHUB_DIRECTIVE);
        const filed = ghLoop('file', '--loop', 'ship', '--title', 'Codemap points at a ghost');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        const store = readGhStore();
        writeGhStore({
          ...store,
          prs: [
            {
              number: 7,
              headRefName: `loop/ship/${id}`,
              state: 'OPEN',
              url: 'https://github.com/acme/widgets/pull/7',
            },
          ],
        });

        const merged = ghLoop(
          'merge',
          '--loop',
          'ship',
          '--id',
          id,
          '--branch',
          `loop/ship/${id}`,
          '--evidence',
          FULL_EVIDENCE,
          '--human',
        );

        expect(merged.status).toBe(0);
        // The one verb whose human output a person reads to check what a robot
        // landed shows the evidence itself, not a claim about it.
        expect(merged.stdout).toContain(`merged: loop/ship/${id} → PR #7`);
        expect(merged.stdout).toContain('npm run build → exit 0');

        const comments = ghCalls().filter((argv) => argv[0] === 'issue' && argv[1] === 'comment');
        expect(comments).toHaveLength(1);
        const body = comments[0][comments[0].indexOf('--body') + 1];
        expect(body).toContain(`**Merged: \`loop/ship/${id}\`**`);
        expect(body).toContain('`npm run typecheck` → exit 0');
        expect(body).toContain(`<!-- loop-merge: loop/ship/${id} -->`);

        // NOT A CLOSE AND NOT A LABEL: one comment is the whole write.
        expect(ghCalls().some((argv) => argv[0] === 'issue' && argv[1] === 'close')).toBe(false);
        expect(ghIssue(id).state).toBe('OPEN');
        expect(issueLabels(id)).toEqual(expect.arrayContaining(['qa-heartbeat', 'codemap']));
        // The merge invented no vocabulary of its own: the only labels named
        // across the whole arc are the ones filing the item already needed.
        expect([...new Set(labelsNamed())].sort()).toEqual(['codemap', 'qa-heartbeat']);
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ── loops-on-the-board Task 8.1: `loop list`, through the shipped binary ──
  //
  // The board's Todo column is drawn from this verb's stdout and nothing else,
  // so what has to be true is not "the backend returns items" (loop-list.test.ts
  // proves that in process, with `node:child_process` mocked) but that the REAL
  // argv the IDE spawns — `loop list [--loop x] [--state y]` — produces the
  // exact JSON the app's narrowing reads, from the exact binary it ships.
  //
  // BOTH BACKENDS, AND THE GITHUB ONE THROUGH THE FAKE `gh` ON PATH. A module
  // mock cannot reach into a subprocess, so the in-process suite and this one
  // arrange `gh` by the only means each has: allowed-pattern #12 forbids a PATH
  // stub for jest's own in-process children (they inherit the real env), and
  // every subprocess below is spawned with an env this file builds — the same
  // reasoning the FAKE_GH header already sets out.
  //
  // ASSERTIONS ARE ON THE COMBINED TRANSCRIPT (allowed-pattern #15): the
  // refusal case below really is printed through `console.log`, so a
  // stderr-only assertion would pass while seeing nothing at all.
  describe('Task 8.1 — `loop list` is the board\'s read, through the shipped binary', () => {
    /** One row of a `loop list` result. */
    interface ListRow {
      loop: string;
      queueKind?: string;
      queueLocation?: string;
      items: Record<string, unknown>[] | null;
      queueError?: string;
      directiveError?: string;
    }

    /** The rows of a `loop list` run, indexed by loop. */
    function rowsOf(run: CliRun): Map<string, ListRow> {
      const rows = (run.json as unknown as { loops?: ListRow[] } | null)?.loops ?? [];
      return new Map(rows.map((row) => [row.loop, row]));
    }

    /** Every file under `dir`, with its bytes — the "nothing was written" probe. */
    function treeOf(dir: string): Record<string, string> {
      const out: Record<string, string> = {};
      const walk = (at: string): void => {
        if (!existsSync(at)) return;
        for (const entry of readdirSync(at)) {
          const path = join(at, entry);
          if (statSync(path).isDirectory()) walk(path);
          else out[path.slice(dir.length)] = readFileSync(path, 'utf-8');
        }
      };
      walk(dir);
      return out;
    }

    /** A `gh` that is installed and cannot answer — the unreachable-queue case. */
    const FAILING_GH = `#!/usr/bin/env node
process.stderr.write('gh: To get started with GitHub CLI, please run: gh auth login\\n');
process.exit(1);
`;

    it(
      'lists the ledger queue the board draws Todo from, with its kind and location',
      () => {
        loop('file', '--loop', 'probe', '--title', 'Null deref in the widget parser', '--file', 'src/parser.ts');
        loop('file', '--loop', 'probe', '--title', 'Codemap points at a deleted file', '--file', 'src/map.ts');

        const listed = loop('list', '--loop', 'probe');

        expect(listed.status).toBe(0);
        expect(listed.json).toMatchObject({ status: 'ok', state: 'open' });
        const row = rowsOf(listed).get('probe');
        // The two fields the board groups by (D11) — read off the report, never
        // parsed out of a directive by a second reader.
        expect(row?.queueKind).toBe('ledger');
        expect(row?.queueLocation).toBe('flow/loops/queue.jsonl');
        expect((row?.items ?? []).map((item) => item.title)).toEqual([
          'Null deref in the widget parser',
          'Codemap points at a deleted file',
        ]);
        // A producer's own filing carries the fingerprint the board reads as the
        // `loop` origin chip — the tell, through the real binary.
        expect(String((row?.items ?? [])[0].fingerprint).length).toBeGreaterThan(0);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'slices open from closed, and says which slice it read',
      () => {
        const filed = loop('file', '--loop', 'probe', '--title', 'Fixed since', '--file', 'src/a.ts');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        loop('file', '--loop', 'probe', '--title', 'Still broken', '--file', 'src/b.ts');
        loop('claim', '--loop', 'probe', '--owner', 'beat-1', '--id', id);
        const closed = loop(
          'close',
          '--loop',
          'probe',
          '--id',
          id,
          '--reason',
          'done',
          '--evidence',
          JSON.stringify({ commands: [{ command: 'npm run test', exitCode: 0 }] }),
        );
        expect(closed.status).toBe(0);

        // The default read IS the open slice, and the verb says so rather than
        // leaving the app to know what the default is.
        const open = loop('list', '--loop', 'probe');
        expect(open.json).toMatchObject({ state: 'open' });
        expect((rowsOf(open).get('probe')?.items ?? []).map((item) => item.title)).toEqual([
          'Still broken',
        ]);

        const shut = loop('list', '--loop', 'probe', '--state', 'closed');
        expect(shut.json).toMatchObject({ state: 'closed' });
        const shutItems = rowsOf(shut).get('probe')?.items ?? [];
        expect(shutItems.map((item) => item.title)).toEqual(['Fixed since']);
        // The close a Done card is drawn from, as the board receives it. NOTE
        // the absence: `list()` reports the close's REASON, never the evidence
        // that gated it — that record lives only in the queue's own log.
        expect(shutItems[0]).toMatchObject({ state: 'closed', closeReason: 'done' });
        expect(shutItems[0].evidence).toBeUndefined();
        expect(
          queueLines().find((line) => line.event === 'closed' && line.id === id)?.evidence,
        ).toMatchObject({ commands: [{ command: 'npm run test', exitCode: 0 }] });

        const all = loop('list', '--loop', 'probe', '--state', 'all');
        expect(all.json).toMatchObject({ state: 'all' });
        expect(rowsOf(all).get('probe')?.items).toHaveLength(2);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'lists every directive when no loop is named, so one call draws the whole board',
      () => {
        loop('file', '--loop', 'probe', '--title', 'A probe finding', '--file', 'src/a.ts');
        const listed = loop('list');

        expect(listed.status).toBe(0);
        // Three seeded directives, three rows — the board's groups come from one
        // read, not one call per loop.
        expect([...rowsOf(listed).keys()].sort()).toEqual(['drain', 'gated', 'probe']);
        expect(rowsOf(listed).get('probe')?.items).toHaveLength(1);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'reads a GitHub queue through `gh`, naming the repo it read',
      () => {
        seedDirective('ship', GITHUB_DIRECTIVE);
        const filed = ghLoop('file', '--loop', 'ship', '--title', 'Codemap points at a ghost');
        expect(filed.status).toBe(0);
        const id = String((filed.json?.item as Record<string, unknown>).id);
        // Everything the FILING said to `gh` is already behind us; the read's
        // own calls are the ones after this mark.
        const beforeRead = ghCalls().length;

        const listed = ghLoop('list', '--loop', 'ship');

        expect(listed.status).toBe(0);
        const row = rowsOf(listed).get('ship');
        expect(row?.queueKind).toBe('github');
        expect(row?.queueLocation).toBe('acme/widgets');
        expect((row?.items ?? []).map((item) => item.id)).toEqual([id]);
        // Reading is a READ: the argv the binary really built asks for a slice
        // and changes nothing in the repository.
        const readCalls = ghCalls().slice(beforeRead);
        expect(readCalls.length).toBeGreaterThan(0);
        expect(readCalls.every((argv) => argv[0] === 'issue' && argv[1] === 'list')).toBe(true);
        expect(
          readCalls.some((argv) => argv.includes('--repo') && argv.includes('acme/widgets')),
        ).toBe(true);
        expect(readCalls.some((argv) => argv.includes('--state') && argv.includes('open'))).toBe(
          true,
        );
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'reports an unreachable GitHub queue as unreadable — items null, never []',
      () => {
        // THE FAILURE THE WHOLE VERB EXISTS TO AVOID (NFR-1). `[]` would tell the
        // board's Todo column there is no work; null says nobody could find out.
        seedDirective('ship', GITHUB_DIRECTIVE);
        loop('file', '--loop', 'probe', '--title', 'A ledger finding', '--file', 'src/a.ts');
        writeFileSync(join(ghPath, 'gh'), FAILING_GH, 'utf-8');
        chmodSync(join(ghPath, 'gh'), 0o755);

        const listed = ghLoop('list');

        // A queue nobody could read is not a refusal: the rest of the board is
        // still true, so the run succeeds and the row carries the failure.
        expect(listed.status).toBe(0);
        const ship = rowsOf(listed).get('ship');
        expect(ship?.items).toBeNull();
        expect(ship?.items).not.toEqual([]);
        expect(String(ship?.queueError)).toContain('gh issue list failed');
        // The location survives the failure — "unreadable" is only actionable
        // with one.
        expect(ship?.queueLocation).toBe('acme/widgets');
        // and the loop that COULD be read is untouched by the one that could not
        expect(rowsOf(listed).get('probe')?.items).toHaveLength(1);

        const human = ghLoop('list', '--loop', 'ship', '--human');
        expect(human.transcript).toContain('queue unreadable');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses a malformed --state with ONE line on the combined transcript, exit 1',
      () => {
        const refused = loop('list', '--loop', 'probe', '--state', 'sideways');

        expect(refused.status).toBe(1);
        // ON THE COMBINED TRANSCRIPT (#15): this CLI's logger routes error()
        // through console.log, so the refusal really arrives on stdout.
        expect(refused.transcript).toContain(
          "loop refused: malformed --state 'sideways' — expected open|closed|all",
        );
        expect(refused.transcript.match(/loop refused:/g)).toHaveLength(1);
        // Nothing partial was emitted — a board reading this gets a reason, not
        // half a list.
        expect(refused.json).toBeNull();
        expect(refused.transcript).not.toContain('"status":"ok"');
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'reading writes nothing — not a queue file, not a byte',
      () => {
        // The board reads this on every open. If the read created the ledger it
        // is reading, an untouched project would grow a store just by being
        // looked at.
        const before = treeOf(flowDir);
        expect(existsSync(queuePath())).toBe(false);

        const listed = loop('list');

        expect(listed.status).toBe(0);
        expect(existsSync(queuePath())).toBe(false);
        expect(treeOf(flowDir)).toEqual(before);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a project with NO loop directives lists nothing and creates nothing',
      () => {
        // Backward compatibility (Task 8.4), at the source: every project that
        // never adopted a loop takes this path, and the honest answer is an
        // empty list of QUEUES — not an empty backlog, and not a `flow/loops/`
        // directory conjured by the read.
        rmSync(join(flowDir, 'loops'), { recursive: true, force: true });
        const before = treeOf(project);

        const listed = loop('list');

        expect(listed.status).toBe(0);
        expect(listed.json).toMatchObject({ status: 'ok', loops: [] });
        expect(existsSync(join(flowDir, 'loops'))).toBe(false);
        expect(treeOf(project)).toEqual(before);
      },
      E2E_TIMEOUT_MS,
    );
  });

  // ══ Phase 7 ══════════════════════════════════════════════
  //
  // THE SEAM BETWEEN TWO RUNS, which is the only place the loops runtime's real
  // defects have ever lived. A loop run is now a Claude Code background agent:
  // it files, claims and closes over several invocations, and every fact one of
  // them relies on was written to disk by an earlier one. An in-process suite
  // shares a module graph and a heap, so it cannot see a fact that fails to
  // survive that boundary — the original loops work found two real defects here
  // that every in-process test walked past.
  //
  // A CLAIM NOW CARRIES ITS SESSION. `--session <id>` is folded into the owner
  // the claim already stores, so the one identity a run has says which Claude
  // Code session it lives in. That binding is what makes the user's named worst
  // case answerable: an item held by a run that is no longer among the live
  // sessions can be NAMED, without waiting out a TTL and without guessing from
  // a clock.

  describe('Phase 7 — a run files, claims with its session bound, and closes with evidence', () => {
    /** A session id in the shape `claude agents` reports one. */
    const RUN_SESSION = '7f3c2a10-1b2c-4d5e-8f90-abcdef012345';
    const OTHER_SESSION = '0a0b0c0d-1112-4131-8151-616171819100';

    /** The live-runs snapshot the IDE hands `status`, for the given sessions. */
    function liveRunsJson(...sessionIds: string[]): string {
      return JSON.stringify(
        sessionIds.map((sessionId, index) => ({
          kind: 'background',
          sessionId,
          id: `bg-${String(index + 1)}`,
          name: 'loop drain',
          state: 'running',
        })),
      );
    }

    /** The `drain` row of a `loop status` run. */
    function drainRow(run: CliRun): Record<string, unknown> {
      const rows = (run.json?.loops ?? []) as Record<string, unknown>[];
      const row = rows.find((candidate) => candidate.loop === 'drain');
      expect(row).not.toBeUndefined();
      return row as Record<string, unknown>;
    }

    /**
     * Open a run the way a dispatched background agent opens one.
     *
     * CALLED AFTER SOMETHING IS FILED, because a consumer's gate skips a quiet
     * queue outright ("a quiet queue is not a broken loop") and a skip takes no
     * slot and mints no owner — which is itself the right behaviour and is
     * proved elsewhere in this file.
     *
     * `loop next --session <id>` AND NO `--owner`, which is the whole sequence
     * under test: the gate MINTS the owner, folding the session into it, and
     * hands it back for every later call in the run to pass verbatim. An owner
     * a caller spells itself is passed through untouched — a rewrite here would
     * make a run fail to authorize against its own claim — so the gate is the
     * one moment the binding can be made, and a run that skipped it takes claims
     * nothing can ever check.
     */
    function openRun(loopName: string, sessionId: string): string {
      const gate = loop('next', '--loop', loopName, '--session', sessionId, '--no-pull');
      expect(gate.status).toBe(0);
      const owner = String((gate.json as Record<string, unknown>).owner);
      // THE BINDING, IN THE IDENTITY THAT ALREADY EXISTED. One string carrying
      // both halves — the run and the session it lives in — because a second
      // identity field would be a second thing that can disagree with the first.
      expect(owner).toContain(`~${sessionId}`);
      return owner;
    }

    it(
      'carries the session across four separate processes, from gate to close',
      () => {
        // ── PROCESS 1: a finding is filed ──────────────────
        const filed = loop(
          'file',
          '--loop',
          'drain',
          '--title',
          'Widget parser drops the last row',
          '--body',
          'Reproduced with `node repro.js`.',
          '--file',
          'src/parser.ts',
        );
        expect(filed.status).toBe(0);
        expect(filed.json?.status).toBe('filed');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        expect(id.length).toBeGreaterThan(0);

        // ── PROCESS 2: the gate mints the run's identity ────
        const owner = openRun('drain', RUN_SESSION);

        // ── PROCESS 3: the run claims the item ─────────────
        //
        // A DIFFERENT PROCESS WITH A DIFFERENT HEAP. Everything it knows about
        // the item above came off the ledger file the previous one wrote.
        const claimed = loop('claim', '--loop', 'drain', '--id', id, '--owner', owner);
        expect(claimed.status).toBe(0);
        expect(claimed.json).toMatchObject({ status: 'claimed', owner });

        // …and the session reached the STORE, not just the argv. This is the
        // fact every later report depends on, and the one an in-process suite
        // cannot see fail: it is written by one process and read by the next.
        const claimEvent = queueLines().filter((line) => line.event === 'claimed').pop();
        expect(claimEvent).not.toBeUndefined();
        expect(String(claimEvent?.owner)).toContain(`~${RUN_SESSION}`);

        // ── PROCESS 4: `status` reads the binding back ─────
        const held = loop('status', '--loop', 'drain', '--live-runs', liveRunsJson(RUN_SESSION));
        expect(held.status).toBe(0);
        expect((held.json as Record<string, unknown>).runs).toMatchObject({ known: true });
        // Alive, so nothing is stuck — and EMPTY rather than absent, which is
        // the difference between "asked, and all well" and "never asked".
        expect(drainRow(held).stuckClaims).toEqual([]);
        expect((drainRow(held).queue as Record<string, number>).claimed).toBe(1);

        // ── PROCESS 5: the same run closes it, with evidence ─
        const closed = loop(
          'close',
          '--loop',
          'drain',
          '--id',
          id,
          '--reason',
          'done',
          '--owner',
          owner,
          '--evidence',
          JSON.stringify({
            commands: [{ command: 'npx tsc --noEmit', exitCode: 0 }],
            summary: 'the parser keeps the last row',
          }),
        );
        expect(closed.status).toBe(0);
        expect(closed.json).toMatchObject({ status: 'closed', reason: 'done' });

        // AUTHORIZED AGAINST ITS OWN CLAIM — which is exactly why the gate's
        // owner is passed through untouched rather than rebuilt per call. A
        // stranger cannot close it.
        const stranger = loop(
          'close',
          '--loop',
          'drain',
          '--id',
          id,
          '--reason',
          'done',
          '--owner',
          'someone-else',
          '--evidence',
          JSON.stringify({ commands: [{ command: 'npx tsc --noEmit', exitCode: 0 }] }),
        );
        expect(stranger.status).toBe(1);

        // ── PROCESS 6: and the queue agrees, from disk ─────
        const after = loop('status', '--loop', 'drain', '--live-runs', liveRunsJson(RUN_SESSION));
        expect(drainRow(after).queue as Record<string, number>).toMatchObject({
          open: 0,
          claimed: 0,
          closed: 1,
        });
        expect(drainRow(after).stuckClaims).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'refuses to close without evidence — the rule survives the process boundary',
      () => {
        const filed = loop('file', '--loop', 'drain', '--title', 'Widget parser drops the last row');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        const owner = openRun('drain', RUN_SESSION);
        expect(loop('claim', '--loop', 'drain', '--id', id, '--owner', owner).status).toBe(0);

        const bare = loop('close', '--loop', 'drain', '--id', id, '--reason', 'done', '--owner', owner);
        expect(bare.status).toBe(1);
        // ASSERTED ON THE COMBINED TRANSCRIPT (allowed-pattern #15): this CLI's
        // logger routes `error()` through `console.log`, so a stderr-only
        // assertion passes vacuously.
        expect(bare.transcript).toContain('loop refused:');
        // Nothing was closed, and the claim is exactly where it was.
        expect(
          (drainRow(loop('status', '--loop', 'drain')).queue as Record<string, number>).claimed,
        ).toBe(1);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'names the item whose run is gone — and calls nothing dead when it cannot tell',
      () => {
        const filed = loop('file', '--loop', 'drain', '--title', 'Widget parser drops the last row');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        const owner = openRun('drain', RUN_SESSION);
        expect(loop('claim', '--loop', 'drain', '--id', id, '--owner', owner).status).toBe(0);

        // ── THE RUN IS GONE. Not slow, not quiet — its session is simply not
        // among the ones running any more, which is what a killed background
        // agent looks like from the outside. No TTL is waited out and no clock
        // is consulted: the machine is asked.
        const dead = loop('status', '--loop', 'drain', '--live-runs', liveRunsJson(OTHER_SESSION));
        expect(dead.status).toBe(0);
        const stuck = drainRow(dead).stuckClaims as Record<string, unknown>[];
        expect(stuck).toHaveLength(1);
        expect(stuck[0]).toMatchObject({ id, loop: 'drain', sessionId: RUN_SESSION });

        // NAMED IN THE HUMAN LINE TOO — a count cannot be chased, and the whole
        // point of this report is that a person goes and looks at the item.
        const human = loop(
          'status',
          '--loop',
          'drain',
          '--human',
          '--live-runs',
          liveRunsJson(OTHER_SESSION),
        );
        expect(human.stdout).toContain(id);

        // ── A REPORT, NEVER AN ACTION. `status` is read-only: the item is still
        // held, and a person releases it with `unclaim` when they mean to.
        expect((drainRow(dead).queue as Record<string, number>).claimed).toBe(1);

        // ── AND WITH NO SNAPSHOT AT ALL, NOTHING IS CALLED DEAD. The safety
        // property, at the process boundary: collapsing "could not tell" into
        // "no runs are alive" would report every live claim in the project as
        // stuck, which is worse than the silence it replaces — a report that
        // cries wolf on healthy runs is one people learn to ignore. The FIELD IS
        // ABSENT rather than empty, so a reader cannot mistake "we did not ask"
        // for "everything is fine", and the result says which, once, for the
        // whole report.
        const blind = loop('status', '--loop', 'drain');
        expect(blind.status).toBe(0);
        expect((blind.json as Record<string, unknown>).runs).toMatchObject({ known: false });
        expect(drainRow(blind)).not.toHaveProperty('stuckClaims');

        // The same for a snapshot that arrived and could not be read: garbage is
        // unknown, never an empty world.
        const garbled = loop('status', '--loop', 'drain', '--live-runs', 'not json at all');
        expect((garbled.json as Record<string, unknown>).runs).toMatchObject({ known: false });
        expect(drainRow(garbled)).not.toHaveProperty('stuckClaims');

        // …and a KNOWN-EMPTY list is NOT unknown: nothing is running, so the
        // claim really is stuck. This is the control that stops the two
        // assertions above from passing for the wrong reason — a build that
        // never reported anything stuck would fail here.
        const nobodyHome = loop('status', '--loop', 'drain', '--live-runs', '[]');
        expect((nobodyHome.json as Record<string, unknown>).runs).toMatchObject({ known: true });
        expect(drainRow(nobodyHome).stuckClaims).toHaveLength(1);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'never calls a claim dead that could not have been in the list',
      () => {
        // A CLAIM WITH NO SESSION NAMES NOTHING CHECKABLE. It was taken before
        // sessions existed, or by a person, or by an engineer on another machine
        // — and none of those could ever appear in THIS machine's session list.
        // Reporting them stuck the moment a snapshot arrives is the cry-wolf
        // failure the report exists to avoid.
        const filed = loop('file', '--loop', 'drain', '--title', 'Widget parser drops the last row');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        expect(loop('claim', '--loop', 'drain', '--id', id, '--owner', 'a-person').status).toBe(0);

        const report = loop('status', '--loop', 'drain', '--live-runs', liveRunsJson(OTHER_SESSION));
        expect((report.json as Record<string, unknown>).runs).toMatchObject({ known: true });
        expect(drainRow(report).stuckClaims).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );

    it(
      'a person’s own chat session is not a live run, so the claim it shares an id with is still stuck',
      () => {
        // OBSERVED LIVE: `claude agents --json` returns the user's interactive
        // sessions beside the background ones. Counting one as a live run would
        // keep a genuinely dead claim off this report for exactly as long as the
        // user has a chat open — and drop claims onto it the moment they close
        // one. This is that rule at the process boundary, with the session ids
        // deliberately identical so only `kind` can separate them.
        const filed = loop('file', '--loop', 'drain', '--title', 'Widget parser drops the last row');
        const id = String((filed.json?.item as Record<string, unknown>).id);
        const owner = openRun('drain', RUN_SESSION);
        expect(loop('claim', '--loop', 'drain', '--id', id, '--owner', owner).status).toBe(0);

        const chatOnly = loop(
          'status',
          '--loop',
          'drain',
          '--live-runs',
          JSON.stringify([
            { kind: 'interactive', sessionId: RUN_SESSION, pid: 4242, status: 'running' },
          ]),
        );
        const named = drainRow(chatOnly).stuckClaims as Record<string, unknown>[];
        expect(named).toHaveLength(1);
        expect(named[0]).toMatchObject({ id, sessionId: RUN_SESSION });

        // THE CONTROL. The same id, called a background agent, IS a live run —
        // so the claim is not stuck. Without this, the assertion above would
        // pass against a build that reported every claim stuck all the time.
        const asBackground = loop(
          'status',
          '--loop',
          'drain',
          '--live-runs',
          liveRunsJson(RUN_SESSION),
        );
        expect(drainRow(asBackground).stuckClaims).toEqual([]);
      },
      E2E_TIMEOUT_MS,
    );
  });
});
