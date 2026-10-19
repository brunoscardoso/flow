/**
 * Connections learning — the plan (pair states, signs, dossiers), the check of
 * one pair (code matches, the model's answer, the pair record) and the pure
 * helpers. In process, a REAL git, a throwaway sandbox under one mkdtemp
 * directory; no model and no network is ever reached — an "answer" is a file
 * the test writes.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { WorkspaceRefusal, createWorkspace, linkRepo } = await import('./workspace-model.js');
const { readWorkspaceLinks } = await import('./workspace-links.js');
const {
  CONNECTIONS_LEARNING_FILENAME,
  anchorsCoverFile,
  checkModelLinks,
  hostOf,
  learnPair,
  parseAnswer,
  planConnections,
  readConnectionsProject,
} = await import('./workspace-connections.js');

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'HOME'] as const;
const FIXED_NOW = new Date('2026-10-06T12:00:00.000Z');

function featureNote(flowDir: string, slug: string, anchors: string[], prose = 'Hand-written prose.'): void {
  const dir = join(flowDir, 'brain', 'features');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\nid: feature:${slug}\nname: ${slug}\nkind: core\nanchors: [${anchors.join(', ')}]\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n\n# ${slug}\n\n${prose}\n`,
  );
}

function structure(flowDir: string, name: string, value: unknown): void {
  const dir = join(flowDir, 'brain', '.structure');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value));
}

describe('connections learning — pure helpers', () => {
  it('keeps only the host of a setting value — never user info, a path or a query', () => {
    expect(hostOf('postgres://admin:s3cret@db.internal:5432/app?ssl=1')).toBe('db.internal');
    expect(hostOf('https://orbit-core.internal.example.com/api')).toBe('orbit-core.internal.example.com');
    expect(hostOf('orbit-app.internal:8080')).toBe('orbit-app.internal');
    expect(hostOf('${HOST}/x')).toBeNull();
    expect(hostOf('just words')).toBeNull();
  });

  it('a file is covered by its own anchor or a folder above it, with or without a kind prefix', () => {
    expect(anchorsCoverFile(['module:src/api'], 'src/api/orders.ts')).toBe(true);
    expect(anchorsCoverFile(['src/api/'], 'src/api/orders.ts')).toBe(true);
    expect(anchorsCoverFile(['file:src/api/orders.ts'], 'src/api/orders.ts')).toBe(true);
    expect(anchorsCoverFile(['src/ap'], 'src/api/orders.ts')).toBe(false);
  });

  it('reads the JSON out of a fenced, prefixed or bare answer', () => {
    expect(parseAnswer('```json\n{"links":[]}\n```')).toEqual({ links: [] });
    expect(parseAnswer('Here you go: {"links":[]} — done')).toEqual({ links: [] });
    expect(parseAnswer('no json here')).toBeNull();
  });
});

describeWithGit('workspace learn-connections', () => {
  let sandbox: string;
  let flowFolder: string;
  let backend: string;
  let frontend: string;
  let mobile: string;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  function makeRepo(name: string, origin: string): string {
    const path = join(sandbox, 'code', name);
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'app.ts'), 'export {}\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    git(path, 'remote', 'add', 'origin', origin);
    return path;
  }

  const ctx = (target: string): { flowFolder: string; target: string; deps: { now: () => Date }; now: () => Date } => ({
    flowFolder,
    target,
    deps: { now: () => FIXED_NOW },
    now: () => FIXED_NOW,
  });

  function workspacePath(): string {
    return join(flowFolder, 'workspaces', 'team');
  }

  function pairOf(result: ReturnType<typeof planConnections>, a: string, b: string): ReturnType<typeof planConnections>['pairs'][number] {
    const found = result.pairs.find((pair) => pair.pair.join(',') === [a, b].sort().join(','));
    if (found === undefined) throw new Error(`no pair ${a},${b}`);
    return found;
  }

  function answerFile(body: string): string {
    const path = join(sandbox, `answer-${String(Math.random()).slice(2)}.txt`);
    writeFileSync(path, body);
    return path;
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-connections-')));
    flowFolder = join(sandbox, 'plan-flow');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.PLAN_FLOW_HOME = flowFolder;
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');

    createWorkspace({ flowFolder, name: 'Team' });
    backend = makeRepo('backend', 'git@github.com:acme/backend.git');
    frontend = makeRepo('frontend', 'https://github.com/acme/frontend.git');
    mobile = makeRepo('mobile', 'https://github.com/acme/mobile.git');
    for (const repo of [backend, frontend, mobile]) linkRepo({ flowFolder, target: repo });

    // backend SERVES POST /api/orders/{id}/pay from src/api/orders.ts (feature `orders`).
    featureNote(join(backend, 'flow'), 'orders', ['module:src/api'], 'Orders and payments.');
    structure(join(backend, 'flow'), 'surface.json', {
      version: 1,
      project: 'backend',
      repoPath: backend,
      derivedAt: FIXED_NOW.toISOString(),
      graphHash: 'x',
      endpoints: [{ method: 'POST', path: '/api/orders/{id}/pay' }],
      graphqlOperations: [],
    });
    structure(join(backend, 'flow'), 'graph.json', {
      version: 1,
      derivedAt: FIXED_NOW.toISOString(),
      nodes: [{ id: 'endpoint:POST /api/orders/{id}/pay', kind: 'endpoint', label: 'POST /api/orders/{id}/pay', sourceFile: 'src/api/orders.ts', meta: { method: 'POST', route: '/api/orders/{id}/pay' } }],
      edges: [],
    });
    // frontend CALLS it through a setting whose example names the backend (feature `checkout`).
    featureNote(join(frontend, 'flow'), 'checkout', ['src/screens'], 'The checkout screen.');
    structure(join(frontend, 'flow'), 'outbound.json', {
      version: 1,
      extractedAt: FIXED_NOW.toISOString(),
      calls: [{ base: 'ORDERS_API_URL', baseIsEnv: true, path: '/orders/{param}/pay', file: 'src/screens/Checkout.tsx' }],
      graphqlOperations: [],
      envHints: { ORDERS_API_URL: 'https://backend.internal.acme.dev/api', DATABASE_URL: 'postgres://admin:s3cret@db.internal:5432/app' },
    });
    // mobile has a feature and talks to nobody.
    featureNote(join(mobile, 'flow'), 'login', ['src/login']);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('plans every pair: all pending at first, a dossier only where there is a sign, and writes nothing', () => {
    const plan = planConnections(ctx(frontend));
    expect(plan.totals).toMatchObject({ pairs: 3, learned: 0, pending: 3, blocked: 0 });
    const talking = pairOf(plan, 'backend', 'frontend');
    expect(talking).toMatchObject({ state: 'pending', reason: 'never checked', codeLinks: 1 });
    expect(talking.signals.join(' ')).toMatch(/matched in code/);
    expect(talking.dossier).toContain('<data>');
    expect(talking.dossier).toContain('- checkout: checkout');
    expect(talking.dossier).toContain('- orders: orders');
    // A setting reaches the model as its host — never the credential.
    expect(talking.dossier).toContain('db.internal');
    expect(talking.dossier).not.toContain('s3cret');
    expect(pairOf(plan, 'backend', 'mobile').dossier).toBeNull();
    expect(readWorkspaceLinks(workspacePath()).links).toEqual([]);
    expect(() => readFileSync(join(workspacePath(), CONNECTIONS_LEARNING_FILENAME), 'utf-8')).toThrow();
  });

  it('checks a pair: the code match becomes ONE learned connection between the two features', () => {
    const result = learnPair({ ...ctx(frontend), pair: 'frontend,backend', model: 'unavailable' });
    expect(result.code).toEqual({ found: 1, recorded: 1 });
    const [link] = readWorkspaceLinks(workspacePath()).links;
    expect(link).toMatchObject({
      from: 'frontend/checkout',
      to: 'backend/orders',
      kind: 'calls',
      source: 'learned',
      evidence: 'code',
      note: '1 endpoint matched in code, e.g. POST /api/orders/{id}/pay',
    });
    // Without a model the pair is still pending — and a second check writes no duplicate.
    expect(pairOf(planConnections(ctx(frontend)), 'backend', 'frontend')).toMatchObject({ state: 'pending', reason: 'the last check could not finish' });
    learnPair({ ...ctx(frontend), pair: 'backend,frontend', model: 'unavailable' });
    expect(readWorkspaceLinks(workspacePath()).links).toHaveLength(1);
  });

  it("keeps the model's real connections, drops the invented ones, and the pair is learned", () => {
    const answer = answerFile(
      '```json\n' +
        JSON.stringify({
          links: [
            { from: 'backend/orders', to: 'frontend/checkout', kind: 'exposes', note: 'payment API used by checkout' },
            { from: 'frontend/cart', to: 'backend/orders', kind: 'calls' },
            { from: 'frontend/checkout', to: 'frontend/checkout', kind: 'calls' },
            { from: 'mobile/login', to: 'backend/orders', kind: 'calls' },
            { from: 'frontend/checkout', to: 'backend/orders', kind: 'pokes' },
          ],
        }) +
        '\n```',
    );
    const result = learnPair({ ...ctx(frontend), pair: 'backend,frontend', answer });
    expect(result.model).toMatchObject({ outcome: 'done', accepted: 1, recorded: 1 });
    expect(result.model.dropped.map((drop) => drop.reason)).toEqual([
      'names a feature that does not exist',
      'both ends are in one project',
      'names a project outside this pair',
      'unknown kind',
    ]);
    const learned = readWorkspaceLinks(workspacePath()).links.find((link) => link.evidence === 'model');
    expect(learned).toMatchObject({ from: 'backend/orders', to: 'frontend/checkout', kind: 'exposes', source: 'learned', note: 'payment API used by checkout' });
    expect(pairOf(planConnections(ctx(frontend)), 'backend', 'frontend').state).toBe('learned');
  });

  it('an unreadable answer is a failed check: code matches kept, the pair stays pending', () => {
    const result = learnPair({ ...ctx(frontend), pair: 'backend,frontend', answer: answerFile('I could not decide.') });
    expect(result.model.outcome).toBe('failed');
    expect(result.code.recorded).toBe(1);
    expect(pairOf(planConnections(ctx(frontend)), 'backend', 'frontend').state).toBe('pending');
  });

  it('a pair with no sign is checked without a model, and goes pending again when either side changes', () => {
    learnPair({ ...ctx(frontend), pair: 'backend,mobile', model: 'no-signal' });
    expect(pairOf(planConnections(ctx(frontend)), 'backend', 'mobile').state).toBe('learned');
    featureNote(join(mobile, 'flow'), 'profile', ['src/profile']);
    expect(pairOf(planConnections(ctx(frontend)), 'backend', 'mobile')).toMatchObject({
      state: 'pending',
      reason: 'one of the two projects changed since the last check',
    });
  });

  it('a match a person rejected on the board stays rejected', () => {
    structure(
      join(frontend, 'flow'),
      'cross-links.jsonl',
      `${JSON.stringify({ ts: FIXED_NOW.toISOString(), status: 'rejected', provider: 'backend', endpoint: 'POST /api/orders/{id}/pay', confidence: 'high', files: [], surfaceDerivedAt: FIXED_NOW.toISOString() })}\n`,
    );
    expect(pairOf(planConnections(ctx(frontend)), 'backend', 'frontend').codeLinks).toBe(0);
  });

  it('a project with no features yet blocks its pairs, and checking one is refused', () => {
    rmSync(join(mobile, 'flow', 'brain', 'features'), { recursive: true, force: true });
    const plan = planConnections(ctx(frontend));
    expect(pairOf(plan, 'backend', 'mobile')).toMatchObject({ state: 'blocked', reason: 'mobile has not been learned yet' });
    expect(plan.totals.blocked).toBe(2);
    expect(() => learnPair({ ...ctx(frontend), pair: 'backend,mobile', model: 'no-signal' })).toThrow(WorkspaceRefusal);
  });

  it('refuses a pair that is not two projects of this Workspace, and an answer that comes with an outcome', () => {
    for (const bad of ['backend', 'backend,backend', 'backend,nowhere']) {
      try {
        learnPair({ ...ctx(frontend), pair: bad });
        throw new Error('not refused');
      } catch (error) {
        expect((error as InstanceType<typeof WorkspaceRefusal>).reason).toBe('invalid-pair');
      }
    }
    expect(() => learnPair({ ...ctx(frontend), pair: 'backend,frontend', answer: answerFile('{}'), model: 'no-signal' })).toThrow(WorkspaceRefusal);
  });

  it('checkModelLinks folds duplicates and caps one pair at twelve connections', () => {
    for (let index = 0; index < 15; index += 1) featureNote(join(backend, 'flow'), `svc-${String(index)}`, [`src/svc${String(index)}`]);
    const a = readConnectionsProject({ id: 'a', name: 'backend', slug: 'backend', remotes: [], description: null, localPath: backend, flowPath: join(backend, 'flow') });
    const b = readConnectionsProject({ id: 'b', name: 'frontend', slug: 'frontend', remotes: [], description: null, localPath: frontend, flowPath: join(frontend, 'flow') });
    const links = Array.from({ length: 15 }, (_, index) => ({ from: 'frontend/checkout', to: `backend/svc-${String(index)}`, kind: 'calls' }));
    const duplicate = { from: 'frontend/checkout', to: 'backend/svc-0', kind: 'calls' };
    const { accepted, dropped } = checkModelLinks({ links: [duplicate, ...links] }, a, b);
    expect(accepted).toHaveLength(12);
    expect(dropped.map((drop) => drop.reason)).toEqual(Array(3).fill('over the limit for one pair'));
  });

});
