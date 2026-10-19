/**
 * Workspaces, end to end (workspaces-knowledge-hub Phase 11, the CLI half) —
 * through the REAL BUILT CLI (`node dist/cli/index.js`) as subprocesses, a REAL
 * git, a local bare remote, and two isolated "machines".
 *
 * WHY THE BUILT CLI. `workspace.test.ts` and `workspace-sync.test.ts` run the
 * source through tsx. This file runs the artifact the app bundles and the
 * heartbeat daemon spawns, so a build that drops a verb, a flag or a module is
 * caught here and nowhere else. It fails loud (never skips) when `dist/` is
 * missing — run `npm run build` first.
 *
 * Every scenario asserts the END STATE — files on disk, links, commits in the
 * code repos, trees on the bare remote — not just exit codes (forbidden #7).
 *
 * ISOLATION (each enforced mechanically, not by care):
 *   - Each machine has its own Flow folder (PLAN_FLOW_HOME), vault
 *     (PLAN_FLOW_VAULT_DIR), HOME, COPILOT_HOME and git identity
 *     (GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM). The real ~/plan-flow is never
 *     named.
 *   - git's `insteadOf` maps https://git.example.test/ onto bare repos in the
 *     sandbox; only the `file` transport is allowed (FLOW_E2E=1 +
 *     FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS=file, GIT_ALLOW_PROTOCOL=file).
 *   - Every CLI child's cwd is asserted to be inside the sandbox before it is
 *     spawned, and `init` additionally gets an explicit `--target` inside it:
 *     an `init` whose cwd drifts re-provisions THIS repository.
 *   - `blueprint derive` runs with a PATH that has no `graphify`, so the graph
 *     is the native extractors' alone — deterministic on any machine.
 *
 * The agent probes (Codex, Claude) are real model calls. They run under a temp
 * folder in $HOME/.cache — NOT $TMPDIR, which Codex's sandbox makes writable by
 * default and would turn the negative control into a false positive — and skip
 * with the reason in the test name when the binary is absent or not signed in.
 * They make REAL model calls, so they are opt-in: PLANFLOW_E2E_AGENT_PROBES=1
 * runs them; a plain `npm run test` never reaches a model or the network.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');
const CLI_TIMEOUT_MS = 120_000;
const SCENARIO_TIMEOUT_MS = 300_000;
const WORKSPACE_REMOTE = 'https://git.example.test/team/ws.git';

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

/** The real PATH minus any folder holding `graphify` — derive stays native-only. */
const PATH_WITHOUT_GRAPHIFY = (process.env.PATH ?? '/usr/bin:/bin')
  .split(delimiter)
  .filter((dir) => dir !== '' && !existsSync(join(dir, 'graphify')))
  .join(delimiter);

const PERSONAL_PATH = /(^|\/)(tasklist\.md|STATE\.md|\.flowconfig|memory\.md|log\.md|heartbeat\.md)$|\/brain\/\.raw\//;

interface CliRun {
  stdout: string;
  combined: string;
  status: number | null;
  json: Record<string, unknown> | null;
}

/** The LAST parseable JSON line on stdout — how the app and skills read a verb. */
function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n').reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // not a JSON line — keep scanning upwards
    }
  }
  return null;
}

/** A pretty-printed JSON document on stdout (brain search, blueprint context), hint lines after it ignored. */
function prettyJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('\n}');
  if (start < 0 || end < 0) throw new Error(`no JSON document in: ${stdout.slice(0, 400)}`);
  return JSON.parse(stdout.slice(start, end + 2)) as Record<string, unknown>;
}

/** Every file under `root` → its content: a snapshot to prove old knowledge was never touched. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (lstatSync(full).isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full, 'utf-8');
    }
  };
  walk(root);
  return out;
}

interface Machine {
  name: 'A' | 'B';
  root: string;
  flow: string;
  vault: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

describeWithGit('Workspaces E2E — the built CLI, real git, two machines', () => {
  let sandbox: string;
  let remotes: string;
  let A: Machine;
  let B: Machine;

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`workspace-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`);
    }
  });

  function makeMachine(name: 'A' | 'B', person: string): Machine {
    const root = join(sandbox, `machine-${name.toLowerCase()}`);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const gitconfig = join(root, 'gitconfig');
    writeFileSync(
      gitconfig,
      `[user]\n\tname = ${person}\n\temail = ${person.toLowerCase().replace(/\s+/g, '.')}@example.com\n` +
        `[init]\n\tdefaultBranch = main\n[url "file://${remotes}/"]\n\tinsteadOf = https://git.example.test/\n` +
        `[url "file://${remotes}/"]\n\tinsteadOf = git@git.example.test:\n`
    );
    const flow = join(root, 'plan-flow');
    const vault = join(root, 'vault');
    return {
      name,
      root,
      flow,
      vault,
      home,
      env: {
        PATH: PATH_WITHOUT_GRAPHIFY,
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        GIT_CONFIG_GLOBAL: gitconfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'file',
        GIT_TERMINAL_PROMPT: '0',
        FLOW_E2E: '1',
        FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS: 'file',
        COPILOT_HOME: join(root, 'copilot'),
        PLANFLOW_NO_BACKGROUND_WORK: '1',
        PLAN_FLOW_HOME: flow,
        PLAN_FLOW_VAULT_DIR: vault,
      },
    };
  }

  function assertInSandbox(path: string): void {
    // LOAD-BEARING SAFETY: a child outside the sandbox could provision or link a real folder.
    expect(realpathSync(path).startsWith(sandbox + sep)).toBe(true);
  }

  /** The built CLI on `machine`, from `cwd` (default: the machine's own folder). */
  function cli(machine: Machine, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): CliRun {
    const cwd = options.cwd ?? machine.root;
    assertInSandbox(cwd);
    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      timeout: CLI_TIMEOUT_MS,
      cwd,
      env: { ...machine.env, ...(options.env ?? {}) },
      input: '',
    });
    if (result.error) throw result.error;
    const stdout = result.stdout ?? '';
    return { stdout, combined: `${stdout}\n${result.stderr ?? ''}`, status: result.status, json: lastJson(stdout) };
  }

  /** `workspace <args> --json`, expected to succeed; the result object. */
  function ws(machine: Machine, ...args: string[]): Record<string, unknown> {
    const run = cli(machine, ['workspace', ...args, '--json']);
    if (run.status !== 0 || run.json === null) throw new Error(`workspace ${args.join(' ')} on ${machine.name} failed:\n${run.combined}`);
    return run.json;
  }

  function git(machine: Machine, cwd: string, ...args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: machine.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed: ${result.stderr}`);
    return result.stdout;
  }

  function bareGit(...args: string[]): string {
    return git(A, join(remotes, 'team', 'ws.git'), ...args);
  }

  const remoteTree = (): string[] => bareGit('ls-tree', '-r', '--name-only', 'main').split('\n').filter((line) => line !== '');
  const remoteRefs = (): string => bareGit('for-each-ref', '--format=%(refname) %(objectname)');
  const remoteFile = (path: string): string => bareGit('show', `main:${path}`);

  function write(path: string, text: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  /** A code repo with one commit and an `origin`; optionally with `files` committed. */
  function makeRepo(machine: Machine, name: string, origin: string, files: Record<string, string> = {}): string {
    const path = join(machine.root, 'code', name);
    mkdirSync(path, { recursive: true });
    git(machine, path, 'init', '-q', '-b', 'main');
    write(join(path, 'README.md'), `# ${name}\n`);
    for (const [file, text] of Object.entries(files)) write(join(path, file), text);
    git(machine, path, 'add', '-A');
    git(machine, path, 'commit', '-q', '-m', 'init');
    git(machine, path, 'remote', 'add', 'origin', origin);
    return realpathSync(path);
  }

  const wsDir = (machine: Machine): string => join(machine.flow, 'workspaces', 'team');
  const projectDir = (machine: Machine, project: string): string => join(wsDir(machine), 'projects', project);

  beforeEach(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-e2e-')));
    remotes = join(sandbox, 'remotes');
    mkdirSync(join(remotes, 'team'), { recursive: true });
    A = makeMachine('A', 'Person A');
    B = makeMachine('B', 'Person B');
    git(A, join(remotes, 'team'), 'init', '-q', '--bare', 'ws.git');
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // ─── Scenario 1 — sync ────────────────────────────────────────────────────

  it(
    'scenario 1 — create, link (old flow/ kept), join by remote, renumber, decision ask, personal files never leave',
    () => {
      // ── Machine A: a Workspace with a remote, two repos with OLD knowledge ──
      expect(ws(A, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE)).toMatchObject({
        action: 'create',
        workspace: { slug: 'team', remote: WORKSPACE_REMOTE },
      });

      // backend: an UNTRACKED flow/ (the vault era's real folder, never committed).
      const backendA = makeRepo(A, 'backend', 'https://git.example.test/acme/backend.git');
      write(join(backendA, 'flow', 'plans', 'plan_old_v1.md'), '# Old plan\n\nkept forever\n');
      write(join(backendA, 'flow', 'brain', 'decisions', 'old.md'), '# Old decision\n');
      const backendOld = snapshot(join(backendA, 'flow'));

      // frontend: a COMMITTED flow/ (like plan-flow itself).
      const frontendA = makeRepo(A, 'frontend', 'https://git.example.test/acme/frontend.git', {
        'flow/plans/plan_ui_v1.md': '# UI plan\n',
        'flow/discovery/discovery_ui_v1.md': '# UI discovery\n',
      });
      const frontendOld = snapshot(join(frontendA, 'flow'));
      const frontendHead = git(A, frontendA, 'rev-parse', 'HEAD').trim();

      const linkedBackend = ws(A, 'link', '--target', backendA);
      expect(linkedBackend).toMatchObject({ link: 'created', projectAdded: true, previous: { kind: 'folder' } });
      const keptAt = (linkedBackend.previous as { keptAt: string }).keptAt;
      expect(keptAt).toMatch(/\/flow\.pre-workspace-\d{8}$/);
      expect(dirname(keptAt)).toBe(backendA);
      expect(snapshot(keptAt)).toEqual(backendOld);
      expect(lstatSync(join(backendA, 'flow')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(backendA, 'flow'))).toBe(projectDir(A, 'backend'));
      // The link and the kept folder stay out of the code repo's status.
      expect(git(A, backendA, 'status', '--porcelain')).toBe('');

      // The committed flow/ is refused, with the exact commit it would make — and nothing changes.
      const refused = cli(A, ['workspace', 'link', '--target', frontendA, '--json']);
      expect(refused.status).toBe(1);
      expect(refused.combined).toContain('workspace refused: committed-flow');
      expect(refused.json).toMatchObject({
        action: 'link',
        refused: 'committed-flow',
        needs: 'confirm-commit',
        commit: { files: 2, from: 'flow', to: 'flow.pre-workspace' },
      });
      const promisedMessage = (refused.json?.commit as { message: string }).message;
      expect(promisedMessage).toMatch(/flow\.pre-workspace/);
      expect(git(A, frontendA, 'rev-parse', 'HEAD').trim()).toBe(frontendHead);
      expect(lstatSync(join(frontendA, 'flow')).isDirectory()).toBe(true);
      expect(existsSync(projectDir(A, 'frontend'))).toBe(false);

      // Confirmed: exactly ONE commit — the one the refusal described — and only renames in it.
      const confirmed = ws(A, 'link', '--target', frontendA, '--confirm-commit');
      expect(confirmed).toMatchObject({ link: 'created', previous: { kind: 'committed-folder' }, codeRepo: { commit: { files: 2 } } });
      expect(git(A, frontendA, 'rev-parse', 'HEAD~1').trim()).toBe(frontendHead);
      expect(git(A, frontendA, 'log', '-1', '--format=%s').trim()).toBe(promisedMessage);
      const changes = git(A, frontendA, 'show', '--name-status', '--format=', 'HEAD').trim().split('\n');
      expect(changes).toHaveLength(2);
      for (const change of changes) expect(change).toMatch(/^R100\tflow\/.+\tflow\.pre-workspace\/.+$/);
      expect(snapshot(join(frontendA, 'flow.pre-workspace'))).toEqual(frontendOld);
      expect(readlinkSync(join(frontendA, 'flow'))).toBe(projectDir(A, 'frontend'));

      // ── Knowledge written through <repo>/flow, plus personal files beside it ──
      write(join(backendA, 'flow', 'discovery', 'discovery_orders_v1.md'), '# Orders discovery\n\nPOST /api/orders.\n');
      expect(readFileSync(join(projectDir(A, 'backend'), 'discovery', 'discovery_orders_v1.md'), 'utf-8')).toContain('POST /api/orders');
      const personal = ['tasklist.md', 'STATE.md', '.flowconfig', 'memory.md', 'brain/.raw/thread-1.md'];
      for (const file of personal) write(join(backendA, 'flow', file), `A's own ${file}\n`);

      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true, ahead: 0 });
      expect(remoteTree()).toContain('projects/backend/discovery/discovery_orders_v1.md');

      // ── Machine B: its own checkouts, another URL form for the backend ──
      const apiB = makeRepo(B, 'api', 'git@git.example.test:acme/backend.git');
      const webB = makeRepo(B, 'web', 'https://git.example.test/acme/frontend');
      const joined = ws(B, 'join', '--remote', WORKSPACE_REMOTE);
      expect(joined).toMatchObject({ action: 'join', workspace: { slug: 'team' }, linked: [], needsReview: [] });
      expect((joined.noLocalCheckout as { id: string }[]).map((project) => project.id).sort()).toEqual([
        'git.example.test/acme/backend',
        'git.example.test/acme/frontend',
      ]);

      // `link` records each checkout and maps it onto the EXISTING project by id.
      for (const [repo, id] of [
        [apiB, 'git.example.test/acme/backend'],
        [webB, 'git.example.test/acme/frontend'],
      ] as const) {
        expect(ws(B, 'link', '--target', repo)).toMatchObject({ link: 'created', projectAdded: false, project: { id, localPath: repo } });
      }
      expect(JSON.parse(readFileSync(join(B.flow, 'projects.local.json'), 'utf-8'))).toEqual({
        projects: { 'git.example.test/acme/backend': apiB, 'git.example.test/acme/frontend': webB },
      });
      expect(readFileSync(join(apiB, 'flow', 'discovery', 'discovery_orders_v1.md'), 'utf-8')).toBe('# Orders discovery\n\nPOST /api/orders.\n');
      // A's personal files did not travel.
      for (const file of personal) expect(existsSync(join(apiB, 'flow', file))).toBe(false);
      for (const file of ['tasklist.md', 'STATE.md']) write(join(apiB, 'flow', file), `B's own ${file}\n`);

      // ── The same new versioned document on both machines → renumbered ──
      write(join(backendA, 'flow', 'discovery', 'discovery_x_v1.md'), '# X — from A\n');
      write(join(apiB, 'flow', 'discovery', 'discovery_x_v1.md'), '# X — from B\n');
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true });
      const renumbered = ws(B, 'sync', '--workspace', 'team');
      expect(renumbered).toMatchObject({
        state: 'synced',
        pushed: true,
        resolutions: [
          {
            kind: 'renumber',
            path: 'projects/backend/discovery/discovery_x_v1.md',
            renamedTo: 'projects/backend/discovery/discovery_x_v2.md',
          },
        ],
      });
      const mergeLog = (renumbered.merge as { log: string }).log;
      expect(mergeLog).toMatch(/^merges\/\d{4}-\d{2}-\d{2}-[0-9a-f]+\.md$/);
      expect(readFileSync(join(wsDir(B), mergeLog), 'utf-8')).toContain('discovery_x_v2.md');
      expect(remoteTree()).toContain(mergeLog);
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced' });
      for (const repo of [backendA, apiB]) {
        // Theirs (first published) keeps the name; the later one moved to v2. Same on both machines.
        expect(readFileSync(join(repo, 'flow', 'discovery', 'discovery_x_v1.md'), 'utf-8')).toBe('# X — from A\n');
        expect(readFileSync(join(repo, 'flow', 'discovery', 'discovery_x_v2.md'), 'utf-8')).toBe('# X — from B\n');
      }

      // ── A decision edited on both machines → asked, B untouched, remote untouched ──
      const decision = 'projects/backend/brain/decisions/queue.md';
      write(join(backendA, 'flow', 'brain', 'decisions', 'queue.md'), '# Queue\n\nSQS.\n');
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true });
      expect(ws(B, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced' });
      write(join(backendA, 'flow', 'brain', 'decisions', 'queue.md'), '# Queue\n\nSQS, FIFO.\n');
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true });
      write(join(apiB, 'flow', 'brain', 'decisions', 'queue.md'), '# Queue\n\nKafka.\n');

      const refsBefore = remoteRefs();
      const asked = ws(B, 'sync', '--workspace', 'team');
      expect(asked).toMatchObject({
        state: 'ask',
        pushed: false,
        asks: [{ kind: 'decision', path: decision, existing: '# Queue\n\nSQS, FIFO.\n', incoming: '# Queue\n\nKafka.\n' }],
      });
      expect(remoteRefs()).toBe(refsBefore);
      // B's tree is back on its own commit: no merge in progress, nothing dirty, its text intact.
      const bCommit = (asked.committed as { sha: string }).sha;
      expect(git(B, wsDir(B), 'rev-parse', 'HEAD').trim()).toBe(bCommit);
      expect(git(B, wsDir(B), 'status', '--porcelain')).toBe('');
      expect(existsSync(join(wsDir(B), '.git', 'MERGE_HEAD'))).toBe(false);
      expect(readFileSync(join(apiB, 'flow', 'brain', 'decisions', 'queue.md'), 'utf-8')).toBe('# Queue\n\nKafka.\n');

      expect(ws(B, 'sync', '--workspace', 'team', '--resolve', decision, '--take', 'ours')).toMatchObject({ state: 'synced', pushed: true });
      expect(remoteFile(decision)).toBe('# Queue\n\nKafka.\n');
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced' });
      expect(readFileSync(join(backendA, 'flow', 'brain', 'decisions', 'queue.md'), 'utf-8')).toBe('# Queue\n\nKafka.\n');

      // ── Personal files: present on both machines (the positive), absent from the remote ──
      for (const file of personal) expect(existsSync(join(projectDir(A, 'backend'), file))).toBe(true);
      expect(readFileSync(join(apiB, 'flow', 'tasklist.md'), 'utf-8')).toBe("B's own tasklist.md\n");
      const tree = remoteTree();
      expect(tree).toContain(decision);
      expect(tree.filter((path) => PERSONAL_PATH.test(path))).toEqual([]);

      // ── Old knowledge: untouched through every sync ──
      expect(snapshot(keptAt)).toEqual(backendOld);
      expect(snapshot(join(frontendA, 'flow.pre-workspace'))).toEqual(frontendOld);
    },
    SCENARIO_TIMEOUT_MS
  );

  // ─── Scenario 2 — cross-project links ────────────────────────────────────

  it(
    'scenario 2 — the discovery skill’s calls record a backend↔frontend link that search, blueprint context and machine B all see',
    () => {
      const backendCode = {
        'package.json': '{"name":"backend","dependencies":{"express":"4"}}\n',
        'src/routes/orders.ts':
          "import express from 'express'\nconst app = express()\napp.post('/api/orders', (req, res) => { res.json({ ok: true }) })\nexport default app\n",
      };
      const frontendCode = {
        'package.json': '{"name":"frontend","dependencies":{"react":"18"}}\n',
        'src/screens/Orders.tsx': "export async function submitOrder(cart: unknown) {\n  return fetch('/api/orders', { method: 'POST', body: JSON.stringify(cart) })\n}\n",
      };
      ws(A, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE);
      const backendA = makeRepo(A, 'backend', 'https://git.example.test/acme/backend.git', backendCode);
      const frontendA = makeRepo(A, 'frontend', 'https://git.example.test/acme/frontend.git', frontendCode);
      ws(A, 'link', '--target', backendA);
      ws(A, 'link', '--target', frontendA);
      write(join(frontendA, 'flow', 'discovery', 'discovery_orders-screen_v1.md'), '# Orders screen\n\nThe checkout screen posts the cart to the orders API.\n');

      // ── What the discovery skill runs, from the backend repo ──
      const status = cli(A, ['workspace', 'status', '--target', '.'], { cwd: backendA });
      expect(status.status).toBe(0);
      expect(status.stdout.trim()).toBe('workspace: backend in Team — 1 sibling project(s)');

      const search = cli(A, ['brain', 'search', 'orders', '--scope', 'workspace', '--json'], { cwd: backendA });
      expect(search.status).toBe(0);
      const found = prettyJson(search.stdout) as { workspace: string; hits: { file: string; project?: string }[] };
      expect(found.workspace).toBe('team');
      expect(found.hits).toEqual(
        expect.arrayContaining([expect.objectContaining({ file: 'frontend/flow/discovery/discovery_orders-screen_v1.md', project: 'frontend' })])
      );

      const linked = cli(
        A,
        [
          'workspace',
          'link-knowledge',
          '--from',
          'backend/endpoint:POST /api/orders',
          '--to',
          'frontend/file:src/screens/Orders.tsx',
          '--kind',
          'exposes',
          '--note',
          'checkout posts the cart',
          '--json',
        ],
        { cwd: backendA }
      );
      expect(linked.status).toBe(0);
      expect(linked.json).toMatchObject({ recorded: true, link: { author: 'Person A', kind: 'exposes' } });
      expect(readFileSync(join(wsDir(A), 'links.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1);

      // ── The frontend's own search shows it, read from the frontend's side ──
      const frontendHeading = 'frontend/file:src/screens/Orders.tsx —consumes→ backend/endpoint:POST /api/orders';
      const linkHit = (repo: string, machine: Machine): { heading: string; snippet: string } | undefined => {
        const run = cli(machine, ['brain', 'search', 'orders', '--json'], { cwd: repo });
        expect(run.status).toBe(0);
        const hits = (prettyJson(run.stdout) as { hits: { kind: string; heading: string; snippet: string }[] }).hits;
        return hits.find((hit) => hit.kind === 'link');
      };
      expect(linkHit(frontendA, A)).toMatchObject({ heading: frontendHeading, snippet: expect.stringContaining('checkout posts the cart') });

      // ── blueprint context on both ends' nodes ──
      const contextLinks = (machine: Machine, repo: string, node: string): unknown => {
        const derive = cli(machine, ['blueprint', 'derive'], { cwd: repo });
        expect(derive.status).toBe(0);
        const graph = JSON.parse(readFileSync(join(repo, 'flow', 'brain', '.structure', 'graph.json'), 'utf-8')) as { nodes: { id: string }[] };
        expect(graph.nodes.map((entry) => entry.id)).toContain(node);
        const context = cli(machine, ['blueprint', 'context', node], { cwd: repo });
        expect(context.status).toBe(0);
        return prettyJson(context.stdout).workspaceLinks;
      };
      expect(contextLinks(A, frontendA, 'module:src/screens')).toEqual([
        expect.objectContaining({ kind: 'consumes', own: 'file:src/screens/Orders.tsx', other: 'backend/endpoint:POST /api/orders', note: 'checkout posts the cart' }),
      ]);
      expect(contextLinks(A, backendA, 'endpoint:POST /api/orders')).toEqual([
        expect.objectContaining({ kind: 'exposes', own: 'endpoint:POST /api/orders', other: 'frontend/file:src/screens/Orders.tsx' }),
      ]);

      // ── The link survives a sync; the derived graph does not travel ──
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true });
      const tree = remoteTree();
      expect(tree).toContain('links.jsonl');
      expect(tree.filter((path) => path.includes('/brain/.structure/graph'))).toEqual([]);

      // ── Machine B: checkouts with the same code, already known locally → linked at join ──
      const apiB = makeRepo(B, 'api', 'https://git.example.test/acme/backend.git', backendCode);
      const webB = makeRepo(B, 'web', 'git@git.example.test:acme/frontend.git', frontendCode);
      mkdirSync(B.flow, { recursive: true });
      writeFileSync(
        join(B.flow, 'projects.local.json'),
        JSON.stringify({ projects: { 'git.example.test/acme/backend': apiB, 'git.example.test/acme/frontend': webB } })
      );
      const joined = ws(B, 'join', '--remote', WORKSPACE_REMOTE);
      expect((joined.linked as { slug: string }[]).map((project) => project.slug).sort()).toEqual(['backend', 'frontend']);
      expect(linkHit(webB, B)).toMatchObject({ heading: frontendHeading });
      expect(contextLinks(B, webB, 'module:src/screens')).toEqual([
        expect.objectContaining({ other: 'backend/endpoint:POST /api/orders', author: 'Person A' }),
      ]);
      expect(ws(B, 'links', '--target', webB, '--project', 'frontend')).toMatchObject({
        links: [{ from: 'backend/endpoint:POST /api/orders', to: 'frontend/file:src/screens/Orders.tsx', kind: 'exposes' }],
      });
    },
    SCENARIO_TIMEOUT_MS
  );

  // ─── Scenario 3 — CLI = IDE ──────────────────────────────────────────────

  it(
    'scenario 3 — status answers the same structure on both machines; init suggests (never auto-links) a remote-only checkout, and leaves a linked one alone',
    () => {
      ws(A, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE);
      const backendA = makeRepo(A, 'backend', 'https://git.example.test/acme/backend.git');
      const frontendA = makeRepo(A, 'frontend', 'https://git.example.test/acme/frontend.git');
      ws(A, 'link', '--target', backendA);
      ws(A, 'link', '--target', frontendA);
      ws(A, 'sync', '--workspace', 'team');

      const apiB = makeRepo(B, 'api', 'https://git.example.test/acme/backend.git');
      const webB = makeRepo(B, 'web', 'https://git.example.test/acme/frontend.git');
      mkdirSync(B.flow, { recursive: true });
      writeFileSync(join(B.flow, 'projects.local.json'), JSON.stringify({ projects: { 'git.example.test/acme/backend': apiB } }));
      ws(B, 'join', '--remote', WORKSPACE_REMOTE);
      ws(B, 'link', '--target', webB);

      // ── Same Workspace, same ids, each machine's own paths ──
      for (const [machine, backend, frontend] of [
        [A, backendA, frontendA],
        [B, apiB, webB],
      ] as const) {
        expect(ws(machine, 'status', '--target', frontend)).toMatchObject({
          workspace: { slug: 'team', name: 'Team', path: wsDir(machine) },
          project: { id: 'git.example.test/acme/frontend', slug: 'frontend', localPath: frontend, flowPath: projectDir(machine, 'frontend') },
          linked: true,
          siblings: [{ id: 'git.example.test/acme/backend', slug: 'backend', localPath: backend, flowPath: projectDir(machine, 'backend') }],
        });
      }

      // ── A file written through <repo>/flow lands in the Workspace project folder ──
      write(join(webB, 'flow', 'plans', 'plan_checkout_v1.md'), '# Checkout\n');
      expect(readFileSync(join(projectDir(B, 'frontend'), 'plans', 'plan_checkout_v1.md'), 'utf-8')).toBe('# Checkout\n');

      // ── B adds a third project; A learns of it by syncing (no checkout on A yet) ──
      const mobileB = makeRepo(B, 'mobile', 'https://git.example.test/acme/mobile.git');
      expect(ws(B, 'link', '--target', mobileB)).toMatchObject({ projectAdded: true, project: { id: 'git.example.test/acme/mobile' } });
      write(join(mobileB, 'flow', 'discovery', 'discovery_push_v1.md'), '# Push notifications\n\nB wrote this.\n');
      expect(ws(B, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true });
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced' });
      const listing = ws(A, 'status') as { workspaces: { projects: { slug: string; localPath: string | null }[] }[] };
      expect(listing.workspaces[0].projects.find((project) => project.slug === 'mobile')).toMatchObject({ localPath: null });

      // ── `init` in a TEMP checkout of mobile on A: linked into the Workspace, not the vault ──
      const mobileA = makeRepo(A, 'mobile-checkout', 'git@git.example.test:acme/mobile.git');
      const discoveryBefore = readFileSync(join(projectDir(A, 'mobile'), 'discovery', 'discovery_push_v1.md'), 'utf-8');
      const bin = join(A.root, 'bin');
      mkdirSync(bin, { recursive: true });
      for (const stub of ['planflow-ai', 'graphify']) {
        // planflow-ai resolves → the PATH rails stop at rung 1; graphify resolves → no install attempt.
        writeFileSync(join(bin, stub), '#!/bin/sh\nexit 0\n');
        chmodSync(join(bin, stub), 0o755);
      }
      const init = cli(A, ['init', '--claude', '--yes', '--target', mobileA], {
        cwd: mobileA,
        env: { PATH: `${bin}${delimiter}${PATH_WITHOUT_GRAPHIFY}` },
      });
      expect(init.status).toBe(0);
      // A remote-only match is a suggestion, never a link: this machine never recorded this checkout.
      expect(init.combined).toContain('Not linked to a Workspace: this checkout looks like mobile of the Team Workspace');
      expect(existsSync(join(projectDir(A, 'mobile'), 'brain', 'features', 'push.md'))).toBe(false);
      // The person confirms; the link replaces the vault link, and a second init leaves it alone.
      expect(ws(A, 'link', '--target', mobileA)).toMatchObject({ project: { slug: 'mobile', localPath: mobileA } });
      const again = cli(A, ['init', '--claude', '--yes', '--target', mobileA], {
        cwd: mobileA,
        env: { PATH: `${bin}${delimiter}${PATH_WITHOUT_GRAPHIFY}` },
      });
      expect(again.status).toBe(0);
      expect(readlinkSync(join(mobileA, 'flow'))).toBe(projectDir(A, 'mobile'));
      expect(ws(A, 'status', '--target', mobileA)).toMatchObject({ project: { slug: 'mobile', localPath: mobileA }, linked: true });
      // B's document, as B wrote it: provisioning A's checkout edits no team knowledge.
      expect(readFileSync(join(mobileA, 'flow', 'discovery', 'discovery_push_v1.md'), 'utf-8')).toBe(discoveryBefore);
      expect(discoveryBefore).toBe('# Push notifications\n\nB wrote this.\n');
      expect(existsSync(join(projectDir(A, 'mobile'), 'brain', 'features', 'push.md'))).toBe(false);
    },
    SCENARIO_TIMEOUT_MS
  );

  // ─── Scenario 4 — move-flow-folder ───────────────────────────────────────

  it(
    'scenario 4 — move-flow-folder moves the Workspaces, re-points every link, and sync works from the new home',
    () => {
      ws(A, 'create', '--name', 'Team', '--remote', WORKSPACE_REMOTE);
      const backendA = makeRepo(A, 'backend', 'https://git.example.test/acme/backend.git');
      const frontendA = makeRepo(A, 'frontend', 'https://git.example.test/acme/frontend.git');
      ws(A, 'link', '--target', backendA);
      ws(A, 'link', '--target', frontendA);
      write(join(backendA, 'flow', 'plans', 'plan_a_v1.md'), '# A\n');
      expect(ws(A, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true });

      const newHome = join(A.root, 'moved', 'plan-flow');
      const moved = ws(A, 'move-flow-folder', '--to', newHome, '--confirm');
      expect(moved).toMatchObject({ moved: ['workspaces', 'projects.local.json'], needs: { env: 'PLAN_FLOW_HOME', value: newHome }, failed: [] });
      expect((moved.relinked as unknown[]).length).toBe(2);
      expect(existsSync(join(A.flow, 'workspaces'))).toBe(false);
      for (const [repo, project] of [
        [backendA, 'backend'],
        [frontendA, 'frontend'],
      ] as const) {
        expect(readlinkSync(join(repo, 'flow'))).toBe(join(newHome, 'workspaces', 'team', 'projects', project));
      }
      expect(readFileSync(join(backendA, 'flow', 'plans', 'plan_a_v1.md'), 'utf-8')).toBe('# A\n');

      // From the new home (the caller persists PLAN_FLOW_HOME): status and sync both work.
      const fromNewHome: Machine = { ...A, flow: newHome, env: { ...A.env, PLAN_FLOW_HOME: newHome } };
      expect(ws(fromNewHome, 'status', '--target', backendA)).toMatchObject({ project: { localPath: backendA, flowPath: join(newHome, 'workspaces', 'team', 'projects', 'backend') } });
      write(join(backendA, 'flow', 'plans', 'plan_b_v1.md'), '# B after the move\n');
      expect(ws(fromNewHome, 'sync', '--workspace', 'team')).toMatchObject({ state: 'synced', pushed: true, ahead: 0 });
      expect(remoteFile('projects/backend/plans/plan_b_v1.md')).toBe('# B after the move\n');
      // The old home no longer has Workspaces — it does not answer for the repo.
      expect(ws(A, 'status', '--target', backendA)).toMatchObject({ workspace: null, project: null });
    },
    SCENARIO_TIMEOUT_MS
  );

  // ─── Scenario 4b — the hard migration ────────────────────────────────────

  it(
    'scenario 4b — migrate: a dry run writes nothing; the real run makes the Default, copies the vault and a plain folder in, holds a committed folder back',
    () => {
      /** Every path under `root`: file content hash, link target, or folder — mtimes included. */
      const tree = (root: string): string[] => {
        const lines: string[] = [];
        const walk = (dir: string): void => {
          for (const entry of readdirSync(dir).sort()) {
            const full = join(dir, entry);
            const stat = lstatSync(full);
            if (stat.isSymbolicLink()) lines.push(`L ${relative(root, full)} ${readlinkSync(full)}`);
            else if (stat.isDirectory()) {
              lines.push(`D ${relative(root, full)}`);
              walk(full);
            } else lines.push(`F ${relative(root, full)} ${readFileSync(full).toString('base64').length} ${stat.mtimeMs}`);
          }
        };
        walk(root);
        return lines;
      };

      // web: the REAL vault link, made by provisioning through the built CLI.
      const web = makeRepo(A, 'web', 'https://git.example.test/acme/web.git');
      const provisioned = cli(A, ['init', '--claude', '--force', '--yes', '--target', web], { cwd: web });
      expect(provisioned.status).toBe(0);
      const vaultFlow = join(A.vault, 'projects', 'web', 'flow');
      expect(readlinkSync(join(web, 'flow'))).toBe(vaultFlow);
      write(join(vaultFlow, 'plans', 'plan_checkout_v1.md'), '# Checkout\n');
      // api: a plain untracked folder. mono: a committed one.
      const api = makeRepo(A, 'api', 'https://git.example.test/acme/api.git');
      write(join(api, 'flow', 'discovery', 'discovery_auth_v1.md'), '# Auth\n');
      write(join(api, '.git', 'info', 'exclude'), '/flow\n');
      const mono = makeRepo(A, 'mono', 'https://git.example.test/acme/mono.git', { 'flow/plans/plan_mono_v1.md': '# Mono\n' });
      const roots = JSON.stringify([web, api, mono, join(A.root, 'nowhere')]);

      // ── Dry run: the whole machine is byte-for-byte the same afterwards ──
      const before = tree(A.root);
      const dry = ws(A, 'migrate', '--roots', roots, '--dry-run');
      expect(tree(A.root)).toEqual(before);
      expect(dry).toMatchObject({ action: 'migrate', dryRun: true, would: 'create-workspace', workspace: { name: 'Default', slug: 'default' } });
      expect(dry.plan).toEqual([
        expect.objectContaining({ root: web, would: 'link', previous: 'link' }),
        expect.objectContaining({ root: api, would: 'link', previous: 'untracked', files: 1 }),
        expect.objectContaining({ root: mono, would: 'pending', reason: 'committed-folder' }),
        expect.objectContaining({ root: join(A.root, 'nowhere'), would: 'fail', reason: 'not-a-git-repo' }),
      ]);

      // ── The real run ──
      const vaultBefore = tree(A.vault);
      const monoHead = git(A, mono, 'rev-parse', 'HEAD').trim();
      const run = ws(A, 'migrate', '--roots', roots);
      expect(run).toMatchObject({ action: 'migrate', dryRun: false, workspace: { slug: 'default', created: true } });
      const defaultDir = join(A.flow, 'workspaces', 'default');
      expect((run.migrated as { root: string }[]).map((entry) => entry.root)).toEqual([web, api]);
      expect(readFileSync(join(defaultDir, 'projects', 'web', 'plans', 'plan_checkout_v1.md'), 'utf-8')).toBe('# Checkout\n');
      expect(readFileSync(join(defaultDir, 'projects', 'api', 'discovery', 'discovery_auth_v1.md'), 'utf-8')).toBe('# Auth\n');
      expect(readlinkSync(join(web, 'flow'))).toBe(join(defaultDir, 'projects', 'web'));
      expect(tree(A.vault)).toEqual(vaultBefore);
      expect(run.pending).toEqual([
        { root: mono, reason: 'committed-folder', commit: expect.objectContaining({ files: 1, from: 'flow', to: 'flow.pre-workspace' }) },
      ]);
      expect(git(A, mono, 'rev-parse', 'HEAD').trim()).toBe(monoHead);
      expect((run.failed as { reason: string }[]).map((entry) => entry.reason)).toEqual(['not-a-git-repo']);

      // The app confirms the held-back one; then a second migrate changes nothing.
      const confirmed = ws(A, 'link', '--target', mono, '--workspace', 'default', '--confirm-commit', '--import');
      expect(confirmed).toMatchObject({ link: 'created', imported: { files: 1 }, codeRepo: { commit: { files: 1 } } });
      const again = ws(A, 'migrate', '--roots', roots);
      expect(again).toMatchObject({ workspace: { slug: 'default', created: false }, migrated: [], unchanged: [web, api, mono], pending: [] });

      // The Default is this machine's, and status says so.
      const status = ws(A, 'status');
      expect(status).toMatchObject({ defaultWorkspace: 'default', workspaces: [expect.objectContaining({ slug: 'default', default: true })] });
      expect(JSON.parse(readFileSync(join(defaultDir, 'workspace.json'), 'utf-8'))).not.toHaveProperty('default');
    },
    SCENARIO_TIMEOUT_MS
  );
});

// ─── Scenario 5 — real agent sandboxes (Codex, Claude) ───────────────────────

const PROBE_TIMEOUT_MS = 180_000;
const PREFLIGHT_TIMEOUT_MS = 90_000;
const AUTH_FAILURE = /401 Unauthorized|Failed to refresh token|Not logged in|Invalid API key|Please run \/login|authentication_error|OAuth token has expired/i;

/** `which <bin>`, through the real PATH. */
function onPath(bin: string): boolean {
  return spawnSync('which', [bin], { encoding: 'utf-8' }).status === 0;
}

interface AgentRun {
  output: string;
  code: number | null;
  /** Why the run tells us nothing about the sandbox — set when it never reached the model. */
  unavailable: string | null;
}

/**
 * Run an agent CLI with stdin closed and a watchdog. Codex 0.19 keeps running
 * after a fatal auth error, so an auth failure seen on the output ends the run
 * at once instead of waiting out the timeout. Output is never printed whole —
 * only the classification leaves this function (no secrets in a test log).
 */
function runAgent(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<AgentRun> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let unavailable: string | null = null;
    const stop = (reason: string): void => {
      if (unavailable === null) unavailable = reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(`${bin} did not answer within ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString('utf-8');
      const auth = AUTH_FAILURE.exec(output);
      if (auth !== null) stop(`${bin} is not signed in (${auth[0]})`);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolvePromise({ output, code: null, unavailable: `${bin} could not start: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ output, code, unavailable });
    });
  });
}

/** A repo OUTSIDE $TMPDIR whose `flow` links to a folder outside the repo. */
function makeProbeRepo(): { root: string; repo: string; target: string } {
  const cacheDir = join(homedir(), '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const root = realpathSync(mkdtempSync(join(cacheDir, 'plan-flow-e2e-')));
  const repo = join(root, 'repo');
  const target = join(root, 'knowledge', 'projects', 'probe');
  mkdirSync(repo, { recursive: true });
  mkdirSync(target, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  spawnSync('ln', ['-s', target, join(repo, 'flow')]);
  return { root, repo, target };
}

const PROBES_OFF = process.env.PLANFLOW_E2E_AGENT_PROBES !== '1';
const CODEX_BASE = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'model_reasoning_effort=high', '-c', 'mcp_servers={}'];

/** Decided once, before the tests are declared, so a skip carries its reason in the test name. */
async function codexAvailability(): Promise<string | null> {
  if (PROBES_OFF) return 'agent probes are opt-in (PLANFLOW_E2E_AGENT_PROBES=1)';
  if (!onPath('codex')) return 'codex is not on PATH';
  const probe = makeProbeRepo();
  try {
    const run = await runAgent('codex', [...CODEX_BASE, '-C', probe.repo, 'Reply with the single word: ready'], probe.repo, PREFLIGHT_TIMEOUT_MS);
    if (run.unavailable !== null) return run.unavailable;
    if (run.code !== 0) return `codex exited ${String(run.code)} before the probe`;
    return null;
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
}

async function claudeAvailability(): Promise<string | null> {
  if (PROBES_OFF) return 'agent probes are opt-in (PLANFLOW_E2E_AGENT_PROBES=1)';
  if (!onPath('claude')) return 'claude is not on PATH';
  const probe = makeProbeRepo();
  try {
    const run = await runAgent('claude', ['-p', 'Reply with the single word: ready', '--model', 'haiku'], probe.repo, PREFLIGHT_TIMEOUT_MS);
    if (run.unavailable !== null) return run.unavailable;
    if (run.code !== 0) return `claude exited ${String(run.code)} before the probe`;
    return null;
  } finally {
    rmSync(probe.root, { recursive: true, force: true });
  }
}

const CODEX_SKIP = await codexAvailability();
const CLAUDE_SKIP = await claudeAvailability();

describe('Workspaces E2E — scenario 5: agents write through the flow link (real sandboxes)', () => {
  const codexIt = CODEX_SKIP === null ? it : it.skip;
  const claudeIt = CLAUDE_SKIP === null ? it : it.skip;

  codexIt(
    `codex: a write through flow/ lands with the link target as a writable root, and is denied without it${CODEX_SKIP === null ? '' : ` — SKIPPED: ${CODEX_SKIP}`}`,
    async () => {
      const probe = makeProbeRepo();
      try {
        const writeTo = (file: string): string =>
          `Run exactly this one shell command and nothing else, then stop: printf 'probe-ok' > flow/${file}`;

        // The positive first (allowed-pattern #28): with the key, the write lands.
        const allowed = await runAgent(
          'codex',
          [...CODEX_BASE, '-c', `sandbox_workspace_write.writable_roots=["${probe.target}"]`, '-C', probe.repo, writeTo('allowed.txt')],
          probe.repo,
          PROBE_TIMEOUT_MS
        );
        expect(allowed.unavailable).toBeNull();
        expect(readFileSync(join(probe.target, 'allowed.txt'), 'utf-8')).toBe('probe-ok');

        // The negative control: the same request without the writable root is denied by the sandbox.
        const denied = await runAgent('codex', [...CODEX_BASE, '-C', probe.repo, writeTo('denied.txt')], probe.repo, PROBE_TIMEOUT_MS);
        expect(denied.unavailable).toBeNull();
        expect(existsSync(join(probe.target, 'denied.txt'))).toBe(false);
      } finally {
        rmSync(probe.root, { recursive: true, force: true });
      }
    },
    PROBE_TIMEOUT_MS * 2 + 30_000
  );

  claudeIt(
    `claude: a write through flow/ lands with the link target added (--add-dir, the SDK's additionalDirectories), and is refused without it${CLAUDE_SKIP === null ? '' : ` — SKIPPED: ${CLAUDE_SKIP}`}`,
    async () => {
      const probe = makeProbeRepo();
      try {
        const ask = (file: string): string =>
          `Use the Write tool to create the file flow/${file} containing exactly: probe-ok — do not use any other tool, then reply done.`;
        const base = ['--model', 'haiku', '--permission-mode', 'acceptEdits', '--allowedTools', 'Write'];

        const allowed = await runAgent('claude', ['-p', ask('allowed.txt'), ...base, '--add-dir', probe.target], probe.repo, PROBE_TIMEOUT_MS);
        expect(allowed.unavailable).toBeNull();
        expect(readFileSync(join(probe.target, 'allowed.txt'), 'utf-8').trim()).toBe('probe-ok');

        const denied = await runAgent('claude', ['-p', ask('denied.txt'), ...base], probe.repo, PROBE_TIMEOUT_MS);
        expect(denied.unavailable).toBeNull();
        expect(existsSync(join(probe.target, 'denied.txt'))).toBe(false);
      } finally {
        rmSync(probe.root, { recursive: true, force: true });
      }
    },
    PROBE_TIMEOUT_MS * 2 + 30_000
  );

  // Keeps the describe non-empty — and the reasons visible — when both probes skip.
  it('reports why any agent probe was skipped', () => {
    expect(typeof (CODEX_SKIP ?? 'ran')).toBe('string');
    expect(typeof (CLAUDE_SKIP ?? 'ran')).toBe('string');
    if (CODEX_SKIP !== null || CLAUDE_SKIP !== null) {
      // eslint-disable-next-line no-console
      console.log(`agent probes — codex: ${CODEX_SKIP ?? 'ran'}; claude: ${CLAUDE_SKIP ?? 'ran'}`);
    }
  });

  // Never left behind: no stray probe folder survives this file.
  afterAll(() => {
    const cacheDir = join(homedir(), '.cache');
    if (!existsSync(cacheDir)) return;
    const leftovers = readdirSync(cacheDir).filter((entry) => entry.startsWith('plan-flow-e2e-') && statSync(join(cacheDir, entry)).isDirectory());
    expect(leftovers).toEqual([]);
  });
});
