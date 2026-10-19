/**
 * Cross-project knowledge links — the one writer (`linkKnowledge`), the reader
 * (`listWorkspaceLinks`) and the feature-note mirror. In process, a REAL git, a
 * throwaway sandbox: every Flow folder, code repo and vault lives under one
 * mkdtemp directory, PLAN_FLOW_HOME points into it, and nothing reaches a
 * network (no remote is ever contacted — `create` records one, `link` reads it).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { WorkspaceRefusal, createWorkspace, linkRepo } = await import('./workspace-model.js');
const { linkKnowledge, listWorkspaceLinks, parseLinkAddress, readWorkspaceLinks, linkFromSide, WORKSPACE_LINKS_FILENAME } = await import(
  './workspace-links.js'
);
const { readFeatures } = await import('../blueprint/feature-store.js');

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'HOME'] as const;

const FIXED_NOW = new Date('2026-10-06T12:00:00.000Z');

function refusalOf(fn: () => unknown, reason: string): InstanceType<typeof WorkspaceRefusal> {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceRefusal);
    const refusal = error as InstanceType<typeof WorkspaceRefusal>;
    expect(refusal.reason).toBe(reason);
    return refusal;
  }
  throw new Error(`expected a ${reason} refusal, and nothing was refused`);
}

function featureNote(flowDir: string, slug: string, anchors: string[]): void {
  const dir = join(flowDir, 'brain', 'features');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${slug}.md`),
    `---\nid: feature:${slug}\nname: ${slug}\nkind: core\nanchors: [${anchors.join(', ')}]\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n\n# ${slug}\n\nHand-written prose.\n`,
  );
}

describe('parseLinkAddress', () => {
  it('reads features, anchors and their project', () => {
    expect(parseLinkAddress('backend/endpoint:POST /api/orders')).toMatchObject({
      project: 'backend',
      type: 'anchor',
      anchorKind: 'endpoint',
      anchorRef: 'POST /api/orders',
    });
    expect(parseLinkAddress('app/file:src/screens/Orders.tsx')).toMatchObject({ project: 'app', anchorKind: 'file', anchorRef: 'src/screens/Orders.tsx' });
    expect(parseLinkAddress('app/orders')).toMatchObject({ type: 'feature', feature: 'orders' });
    expect(parseLinkAddress('app/feature:orders')).toMatchObject({ type: 'feature', feature: 'orders' });
  });

  it('refuses what is not an address', () => {
    for (const bad of ['orders', '/orders', 'app/', 'app/route:x', 'app/endpoint:']) {
      expect(parseLinkAddress(bad)).toBeNull();
    }
  });
});

describeWithGit('workspace link-knowledge', () => {
  let sandbox: string;
  let flowFolder: string;
  let backend: string;
  let frontend: string;
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

  const ctx = (): { flowFolder: string; deps: { now: () => Date } } => ({ flowFolder, deps: { now: () => FIXED_NOW } });

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-links-')));
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
    linkRepo({ flowFolder, target: backend });
    linkRepo({ flowFolder, target: frontend });
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const linksFile = (): string => join(flowFolder, 'workspaces', 'team', WORKSPACE_LINKS_FILENAME);

  it('records an anchor-to-anchor link with author and time, even with no feature note', () => {
    const result = linkKnowledge({
      ...ctx(),
      target: frontend,
      from: 'backend/endpoint:POST /api/orders',
      to: 'frontend/file:src/screens/Orders.tsx',
      kind: 'exposes',
      note: 'creates an order;   the screen posts the cart',
    });
    expect(result).toMatchObject({
      action: 'link-knowledge',
      workspace: { slug: 'team' },
      recorded: true,
      link: {
        ts: FIXED_NOW.toISOString(),
        author: 'Test Person',
        kind: 'exposes',
        from: 'backend/endpoint:POST /api/orders',
        to: 'frontend/file:src/screens/Orders.tsx',
        note: 'creates an order; the screen posts the cart',
      },
    });
    expect(result.mirrored.every((mirror) => !mirror.written)).toBe(true);
    const lines = readFileSync(linksFile(), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(result.link);
  });

  it('is idempotent — the same from/to/kind twice is one line', () => {
    const args = { ...ctx(), target: backend, from: 'backend/orders', to: 'frontend/checkout', kind: 'relates' };
    expect(linkKnowledge(args).recorded).toBe(true);
    const again = linkKnowledge({ ...args, note: 'a different note' });
    expect(again.recorded).toBe(false);
    expect(again.link.note).toBeUndefined();
    expect(readFileSync(linksFile(), 'utf-8').trim().split('\n')).toHaveLength(1);
    // A different kind is a different link.
    expect(linkKnowledge({ ...args, kind: 'calls' }).recorded).toBe(true);
    expect(readWorkspaceLinks(join(flowFolder, 'workspaces', 'team')).links).toHaveLength(2);
  });

  it('mirrors into both projects’ feature notes as relates edges, prose untouched', () => {
    featureNote(join(backend, 'flow'), 'orders-api', ['module:src/api']);
    featureNote(join(frontend, 'flow'), 'checkout', ['file:src/screens/Orders.tsx']);
    const result = linkKnowledge({
      ...ctx(),
      target: frontend,
      from: 'backend/file:src/api/orders.ts',
      to: 'frontend/file:src/screens/Orders.tsx',
      kind: 'exposes',
      note: 'POST /api/orders',
    });
    expect(result.mirrored).toEqual([
      { project: 'backend', feature: 'orders-api', target: 'frontend/file:src/screens/Orders.tsx', written: true },
      { project: 'frontend', feature: 'checkout', target: 'backend/file:src/api/orders.ts', written: true },
    ]);
    const [api] = readFeatures(join(backend, 'flow'));
    expect(api.relates).toEqual([
      {
        target: 'frontend/file:src/screens/Orders.tsx',
        via: 'file:src/api/orders.ts',
        note: 'workspace link — exposes frontend/file:src/screens/Orders.tsx: POST /api/orders',
      },
    ]);
    const [checkout] = readFeatures(join(frontend, 'flow'));
    expect(checkout.relates[0]).toMatchObject({ target: 'backend/file:src/api/orders.ts', note: expect.stringContaining('consumes') });
    expect(checkout.body).toContain('Hand-written prose.');
    // Recording it again changes nothing in the notes either.
    const before = readFileSync(join(frontend, 'flow', 'brain', 'features', 'checkout.md'), 'utf-8');
    linkKnowledge({ ...ctx(), target: frontend, from: 'backend/file:src/api/orders.ts', to: 'frontend/file:src/screens/Orders.tsx', kind: 'exposes' });
    expect(readFileSync(join(frontend, 'flow', 'brain', 'features', 'checkout.md'), 'utf-8')).toBe(before);
  });

  it('refuses an unknown project with the valid slugs, and writes nothing', () => {
    const refusal = refusalOf(
      () => linkKnowledge({ ...ctx(), target: frontend, from: 'billing/invoices', to: 'frontend/checkout', kind: 'calls' }),
      'unknown-project',
    );
    expect(refusal.payload).toMatchObject({ project: 'billing', projects: ['backend', 'frontend'] });
    expect(existsSync(linksFile())).toBe(false);
  });

  it('refuses a kind outside the vocabulary, a malformed address and a same-project link', () => {
    const kind = refusalOf(() => linkKnowledge({ ...ctx(), target: frontend, from: 'backend/a', to: 'frontend/b', kind: 'uses' }), 'invalid-link-kind');
    expect(kind.payload).toMatchObject({ kinds: ['calls', 'exposes', 'consumes', 'relates'] });
    const address = refusalOf(() => linkKnowledge({ ...ctx(), target: frontend, from: 'orders', to: 'frontend/b', kind: 'calls' }), 'invalid-link-address');
    expect(address.payload).toMatchObject({ flag: 'from', projects: ['backend', 'frontend'] });
    refusalOf(() => linkKnowledge({ ...ctx(), target: frontend, from: 'frontend/a', to: 'frontend/b', kind: 'calls' }), 'same-project');
    expect(existsSync(linksFile())).toBe(false);
  });

  it('refuses outside a Workspace', () => {
    const loose = makeRepo('loose', 'https://github.com/acme/loose.git');
    refusalOf(() => linkKnowledge({ ...ctx(), target: loose, from: 'backend/a', to: 'frontend/b', kind: 'calls' }), 'no-workspace');
  });

  it('lists links, filtered by project, and reads them from either side', () => {
    linkKnowledge({ ...ctx(), target: frontend, from: 'backend/endpoint:GET /api/orders', to: 'frontend/orders', kind: 'exposes' });
    const all = listWorkspaceLinks({ ...ctx(), target: frontend });
    expect(all).toMatchObject({ action: 'links', project: null, unreadable: 0 });
    expect(all.links).toHaveLength(1);
    expect(listWorkspaceLinks({ ...ctx(), target: frontend, project: 'backend' }).links).toHaveLength(1);
    refusalOf(() => listWorkspaceLinks({ ...ctx(), target: frontend, project: 'nope' }), 'unknown-project');

    const side = linkFromSide(all.links[0], 'frontend');
    expect(side).toMatchObject({ own: { address: 'frontend/orders' }, other: { address: 'backend/endpoint:GET /api/orders' }, kind: 'consumes' });
  });

  it('normalizes feature addresses: one link however the feature end is spelled (review fixes 1, 14)', () => {
    featureNote(join(backend, 'flow'), 'orders', []);
    // The namespaced id the store mints inside a Workspace.
    const ordersPath = join(backend, 'flow', 'brain', 'features', 'orders.md');
    writeFileSync(ordersPath, readFileSync(ordersPath, 'utf-8').replace('id: feature:orders', 'id: feature:backend::orders'));
    const first = linkKnowledge({ ...ctx(), target: backend, from: 'backend/feature:backend::orders', to: 'frontend/checkout', kind: 'calls' });
    expect(first.link.from).toBe('backend/orders');
    expect(first.mirrored[0]).toMatchObject({ project: 'backend', feature: 'orders', written: true });
    expect(linkKnowledge({ ...ctx(), target: backend, from: 'backend/feature:orders', to: 'frontend/feature:checkout', kind: 'calls' }).recorded).toBe(false);
    expect(linkKnowledge({ ...ctx(), target: backend, from: 'backend/orders', to: 'frontend/checkout', kind: 'calls' }).recorded).toBe(false);
    // A line a merge brought in with the long spelling is the same link.
    writeFileSync(
      linksFile(),
      `${readFileSync(linksFile(), 'utf-8')}${JSON.stringify({ ts: 'x', author: null, kind: 'calls', from: 'backend/feature:orders', to: 'frontend/checkout' })}\n`,
    );
    expect(readWorkspaceLinks(join(flowFolder, 'workspaces', 'team')).links).toHaveLength(1);
    // A feature id naming ANOTHER project than the address is not an address.
    expect(parseLinkAddress('backend/feature:frontend::orders')).toBeNull();
    expect(parseLinkAddress('backend/feature:backend::orders')).toMatchObject({ address: 'backend/orders', feature: 'orders' });
  });

  it('reads past a corrupt line and counts it', () => {
    linkKnowledge({ ...ctx(), target: frontend, from: 'backend/a', to: 'frontend/b', kind: 'calls' });
    writeFileSync(linksFile(), `${readFileSync(linksFile(), 'utf-8')}{broken\n{"ts":"x","kind":"nope","from":"a/b","to":"c/d"}\n`);
    const read = readWorkspaceLinks(join(flowFolder, 'workspaces', 'team'));
    expect(read.links).toHaveLength(1);
    expect(read.unreadable).toBe(2);
  });
});
