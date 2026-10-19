/**
 * The Workspace map (`blueprint workspace graph`) — in process, a REAL git, a
 * throwaway sandbox. Every Flow folder, code repo and vault lives under one
 * mkdtemp directory and PLAN_FLOW_HOME points into it; nothing reaches a
 * network (a remote is recorded, never contacted).
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { WorkspaceRefusal, createWorkspace, linkRepo } = await import('../handlers/workspace-model.js');
const { linkKnowledge } = await import('../handlers/workspace-links.js');
const { buildWorkspaceGraph, readLastKnownSizes, SIZES_FILENAME } = await import('./workspace-graph.js');
const { featuresUnderstood, rollUpUnderstood, understoodPercent } = await import('./understood.js');

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const PACKAGE_ROOT = getPackageRoot();

function lastJson(stdout: string): Record<string, unknown> | null {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.trim().startsWith('{')) continue;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // keep scanning
    }
  }
  return null;
}

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'HOME'] as const;
const T1 = new Date('2026-10-06T12:00:00.000Z');
const T2 = new Date('2026-10-06T13:00:00.000Z');

describe('understood arithmetic', () => {
  it('counts learned capabilities only, and rolls up by summing counts', () => {
    const nodes = [
      { kind: 'core' as const, understanding: 'learned' as const },
      { kind: 'core' as const, understanding: 'stale' as const },
      { kind: 'part' as const, understanding: 'learned' as const },
      { kind: 'child' as const, understanding: 'learned' as const },
    ];
    expect(featuresUnderstood(nodes)).toEqual({ done: 1, total: 2 });
    expect(featuresUnderstood([])).toBeNull();
    // 2/2 and 1/10 is 3/12 (25%), not the 55% an average of percentages gives.
    const rolled = rollUpUnderstood([{ done: 2, total: 2 }, { done: 1, total: 10 }, null]);
    expect(rolled).toEqual({ done: 3, total: 12 });
    expect(understoodPercent(rolled)).toBe(25);
    expect(rollUpUnderstood([null])).toBeNull();
  });
});

describeWithGit('buildWorkspaceGraph', () => {
  let sandbox: string;
  let flowFolder: string;
  const repos: Record<string, string> = {};
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  function makeRepo(name: string, files: Record<string, number>): string {
    const path = join(sandbox, 'code', name);
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    for (const [file, lines] of Object.entries(files)) {
      mkdirSync(join(path, file, '..'), { recursive: true });
      writeFileSync(join(path, file), `${Array.from({ length: lines }, (_, i) => `const l${String(i)} = ${String(i)}`).join('\n')}\n`);
    }
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    git(path, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
    return path;
  }

  const projectFolder = (slug: string): string => join(flowFolder, 'workspaces', 'team', 'projects', slug);

  function feature(slug: string, name: string, anchors: string[], learned = false): void {
    const dir = join(projectFolder(slug.split('/')[0]), 'brain', 'features');
    mkdirSync(dir, { recursive: true });
    const file = slug.split('/')[1];
    writeFileSync(
      join(dir, `${file}.md`),
      `---\nid: feature:${file}\nname: ${name}\nkind: core\nanchors: [${anchors.join(', ')}]\nrelates: []\nlastFullRead: ${learned ? '2026-10-01T00:00:00.000Z' : 'null'}\npatchCount: 0\n---\n\n# ${name}\n\nWhat ${name} does.\n`,
    );
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-workspace-graph-')));
    flowFolder = join(sandbox, 'plan-flow');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.PLAN_FLOW_HOME = flowFolder;
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');

    createWorkspace({ flowFolder, name: 'Team' });
    repos.backend = makeRepo('backend', { 'src/engine.ts': 300, 'src/auth.ts': 100 });
    repos.frontend = makeRepo('frontend', { 'src/chats.tsx': 120 });
    repos.mobile = makeRepo('mobile', { 'src/login.tsx': 50 });
    for (const name of ['backend', 'frontend', 'mobile']) linkRepo({ flowFolder, target: repos[name] });

    feature('backend/chat-engine', 'Chat Engine', ['file:src/engine.ts'], true);
    feature('backend/auth', 'Auth', ['file:src/auth.ts']);
    feature('frontend/chats', 'Chats', ['file:src/chats.tsx'], true);
    feature('mobile/login', 'Login', ['file:src/login.tsx']);
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const graph = (now = T1, target = repos.frontend) => buildWorkspaceGraph({ flowFolder, target, now: () => now });

  it('returns every project in workspace.json order with its own feature graph, sizes and understanding', () => {
    const result = graph();
    expect(result.action).toBe('workspace-graph');
    expect(result.workspace).toEqual({ name: 'Team', slug: 'team' });
    expect(result.current).toBe('frontend');
    expect(result.projects.map((project) => [project.slug, project.colorIndex, project.current, project.state])).toEqual([
      ['backend', 0, false, 'local'],
      ['frontend', 1, true, 'local'],
      ['mobile', 2, false, 'local'],
    ]);
    const backend = result.projects[0];
    // NOTHING MERGED: the backend's graph holds the backend's features only.
    expect(backend.graph?.nodes.map((node) => node.name).sort()).toEqual(['Auth', 'Chat Engine']);
    expect(backend.totals).toMatchObject({ features: 2, lines: 400, files: 2, understood: { done: 1, total: 2 } });
    expect(backend.size.source).toBe('measured');
    expect(result.totals).toMatchObject({
      projects: 3,
      features: 4,
      lines: 570,
      understood: { done: 2, total: 4 },
      connections: 0,
    });
    // BOUNDED: no limitations report, no file lists.
    expect(JSON.stringify(result)).not.toContain('limitations');
    expect(JSON.stringify(result)).not.toContain('src/engine.ts"');
  });

  it('resolves links to the features they touch — by feature, by claimed anchor, and keeps an unresolved end', () => {
    linkKnowledge({ flowFolder, target: repos.frontend, from: 'frontend/chats', to: 'backend/chat-engine', kind: 'consumes' });
    linkKnowledge({ flowFolder, target: repos.mobile, from: 'mobile/file:src/login.tsx', to: 'backend/endpoint:POST /login', kind: 'calls', note: 'OIDC' });
    const result = graph();
    expect(result.links).toHaveLength(2);
    const [consumes, calls] = result.links ?? [];
    expect(consumes.from.features).toHaveLength(1);
    expect(consumes.from.features[0]).toMatch(/chats$/);
    expect(consumes.to.features[0]).toMatch(/chat-engine$/);
    // An anchor end maps to the feature that claims it; one nothing claims stays,
    // with its address, so it can be drawn to its project's block.
    expect(calls.from.features[0]).toMatch(/login$/);
    expect(calls.to).toMatchObject({ project: 'backend', type: 'anchor', features: [], address: 'backend/endpoint:POST /login' });
    expect(calls.note).toBe('OIDC');
    const connections = Object.fromEntries(result.projects.map((project) => [project.slug, project.connections]));
    expect(connections).toEqual({ backend: 2, frontend: 1, mobile: 1 });
    expect(result.totals.connections).toBe(2);
  });

  it('records sizes when a checkout measures them, only when they change', () => {
    graph(T1);
    graph(T1);
    const sizes = readFileSync(join(projectFolder('backend'), 'brain', '.structure', SIZES_FILENAME), 'utf-8').trim().split('\n');
    expect(sizes).toHaveLength(1);
    writeFileSync(join(repos.backend, 'src', 'auth.ts'), 'const a = 1\n');
    graph(T2);
    const after = readLastKnownSizes(projectFolder('backend'));
    expect(after?.ts).toBe(T2.toISOString());
    expect(after?.lines).toBe(301);
  });

  it('draws a project not on this computer from the Workspace knowledge, sized by the last known lines, and links to it still count', () => {
    graph(T1); // a machine with the checkout measured it
    linkKnowledge({ flowFolder, target: repos.frontend, from: 'frontend/chats', to: 'mobile/login', kind: 'relates' });
    rmSync(repos.mobile, { recursive: true, force: true });
    const result = graph(T2);
    const mobile = result.projects.find((project) => project.slug === 'mobile');
    expect(mobile).toMatchObject({ state: 'remote', local: null, error: null });
    expect(mobile?.size).toEqual({ source: 'last-known', measuredAt: T1.toISOString() });
    expect(mobile?.totals.lines).toBe(50);
    expect(mobile?.graph?.nodes.find((node) => node.name === 'Login')?.size).toEqual({ files: 1, lines: 50 });
    expect(mobile?.connections).toBe(1);
    expect(result.links?.[0].to.features[0]).toMatch(/login$/);
  });

  it('a remote project nobody has measured carries no size and says so', () => {
    rmSync(repos.mobile, { recursive: true, force: true });
    const mobile = graph().projects.find((project) => project.slug === 'mobile');
    expect(mobile?.size).toEqual({ source: 'none', measuredAt: null });
    expect(mobile?.totals.lines).toBeNull();
    expect(mobile?.totals.features).toBe(1);
  });

  it('a project on this computer says where each feature lives; one drawn from the knowledge alone never guesses', () => {
    graph(T1);
    rmSync(repos.mobile, { recursive: true, force: true });
    const result = graph(T2);
    const backend = result.projects.find((project) => project.slug === 'backend');
    const engine = backend?.graph?.nodes.find((node) => node.name === 'Chat Engine');
    expect(engine?.folders?.rows[0]).toMatchObject({ path: 'src', lines: 300, files: 1, share: 1 });
    const mobile = result.projects.find((project) => project.slug === 'mobile');
    const login = mobile?.graph?.nodes.find((node) => node.name === 'Login');
    expect(login?.size).toEqual({ files: 1, lines: 50 }); // the node IS drawn, from the last known size
    expect(login).not.toHaveProperty('folders');
  });

  it('one project that cannot be read does not stop the others', () => {
    // A features "folder" that is a file: the store read throws for this project only.
    rmSync(join(projectFolder('backend'), 'brain', 'features'), { recursive: true, force: true });
    writeFileSync(join(projectFolder('backend'), 'brain', 'features'), 'not a folder');
    const result = graph();
    const backend = result.projects.find((project) => project.slug === 'backend');
    expect(backend).toMatchObject({ state: 'unreadable', graph: null });
    expect(backend?.error).toEqual(expect.any(String));
    expect(result.projects.filter((project) => project.graph !== null).map((project) => project.slug)).toEqual(['frontend', 'mobile']);
    expect(result.totals.features).toBe(2);
  });

  it('links that cannot be read leave the projects drawn and report why', () => {
    const linksPath = join(flowFolder, 'workspaces', 'team', 'links.jsonl');
    rmSync(linksPath, { force: true });
    mkdirSync(linksPath); // a directory where the file should be — unreadable
    const result = graph();
    expect(result.links).toBeNull();
    expect(result.linksError).toEqual(expect.any(String));
    expect(result.totals.connections).toBeNull();
    expect(result.projects.every((project) => project.graph !== null)).toBe(true);
  });

  it('counts a malformed links line without failing', () => {
    linkKnowledge({ flowFolder, target: repos.frontend, from: 'frontend/chats', to: 'backend/auth', kind: 'calls' });
    appendFileSync(join(flowFolder, 'workspaces', 'team', 'links.jsonl'), 'not json\n');
    const result = graph();
    expect(result.links).toHaveLength(1);
    expect(result.linksUnreadable).toBe(1);
  });

  it('the CLI verb prints the map as one JSON line, and refuses outside a Workspace with the payload then the line', () => {
    const run = (target: string) =>
      spawnSync(process.execPath, [tsxRunnerPath(PACKAGE_ROOT), join(PACKAGE_ROOT, 'src', 'cli', 'index.ts'), 'blueprint', 'workspace', 'graph', '--target', target, '--json'], {
        encoding: 'utf-8',
        cwd: sandbox,
        timeout: 120_000,
        env: { ...process.env, PLANFLOW_NO_BACKGROUND_WORK: '1' },
      });
    const ok = run(repos.backend);
    expect(ok.status).toBe(0);
    expect(lastJson(ok.stdout)).toMatchObject({ action: 'workspace-graph', current: 'backend', totals: { projects: 3 } });
    const loose = makeRepo('loose2', { 'a.ts': 1 });
    const refused = run(loose);
    expect(refused.status).toBe(1);
    expect(`${refused.stdout}\n${refused.stderr}`).toContain('blueprint refused: no-workspace');
    expect(lastJson(refused.stdout)).toMatchObject({ action: 'workspace-graph', refused: 'no-workspace' });
  }, 180_000);

  it('refuses a repo in no Workspace', () => {
    const loose = makeRepo('loose', { 'a.ts': 1 });
    expect(() => buildWorkspaceGraph({ flowFolder, target: loose })).toThrow(WorkspaceRefusal);
  });
});
