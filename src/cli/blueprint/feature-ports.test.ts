/**
 * Feature ports (`blueprint features ports`) — in process against a REAL git
 * and a throwaway Workspace of two projects, plus one subprocess run through the
 * CLI's dispatch. Every Flow folder and code repo lives under one mkdtemp
 * directory and PLAN_FLOW_HOME points into it; nothing reaches a network.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createWorkspace, linkRepo } = await import('../handlers/workspace-model.js');
const {
  PORTS_PER_SIDE_CAP,
  PortsRefusal,
  anchorLocation,
  capPorts,
  connectionCovers,
  dedupePorts,
  mergeViewPorts,
  portCrossing,
  portDirection,
  portTrust,
  readFeaturePorts,
  runFeaturePortsVerb,
} = await import('./feature-ports.js');
type Ports = Awaited<ReturnType<typeof readFeaturePorts>>;
type Port = Ports['in'][number];

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const PACKAGE_ROOT = getPackageRoot();

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'HOME'] as const;

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

// ─── Pure rules ─────────────────────────────────────────────────────────────

describe('port direction table', () => {
  it.each([
    ['calls', 'from', 'out'],
    ['calls', 'to', 'in'],
    ['consumes', 'from', 'out'],
    ['consumes', 'to', 'in'],
    ['exposes', 'from', 'in'],
    ['exposes', 'to', 'out'],
    ['relates', 'from', 'linked'],
    ['relates', 'to', 'linked'],
  ] as const)('%s, this feature is `%s` → %s', (kind, side, direction) => {
    expect(portDirection(kind, side)).toBe(direction);
  });

  it('names the crossing from the note, else the relationship read from this side', () => {
    expect(portCrossing('calls', 'from', '  HTTP POST /api/chat ')).toBe('HTTP POST /api/chat');
    expect(portCrossing('calls', 'from', undefined)).toBe('calls');
    expect(portCrossing('calls', 'to', undefined)).toBe('called by');
    expect(portCrossing('exposes', 'to', '')).toBe('consumes');
    expect(portCrossing('consumes', 'to', undefined)).toBe('exposes');
    expect(portCrossing('relates', 'to', undefined)).toBe('relates');
  });

  it('maps evidence to trust: code, model, and nothing means declared', () => {
    expect(portTrust({ evidence: 'code' })).toBe('code');
    expect(portTrust({ evidence: 'model' })).toBe('model');
    expect(portTrust({})).toBe('declared');
  });

  it('reads the file and symbol an anchor names', () => {
    expect(anchorLocation('file', 'src/a.ts')).toEqual({ file: 'src/a.ts' });
    expect(anchorLocation('file', 'src/a.ts:run')).toEqual({ file: 'src/a.ts', symbol: 'run' });
    expect(anchorLocation('symbol', 'src/a.ts#run')).toEqual({ file: 'src/a.ts', symbol: 'run' });
    expect(anchorLocation('symbol', 'src/a.ts:run')).toEqual({ file: 'src/a.ts', symbol: 'run' });
    expect(anchorLocation('symbol', 'verifyToken')).toEqual({ symbol: 'verifyToken' });
    expect(anchorLocation('endpoint', 'POST /api/x')).toEqual({});
  });

  it('dedupes by direction + far end + crossing, keeping the strongest trust and a matched node', () => {
    const base: Port = { direction: 'out', crosses: 'x', far: { project: 'b', feature: 'f', local: false }, internalNode: null, trust: 'model', source: 'connection' };
    const out = dedupePorts([base, { ...base, trust: 'code' }, { ...base, internalNode: 'n' }, { ...base, crosses: 'y' }]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ crosses: 'x', trust: 'code', internalNode: 'n' });
  });

  it('merges view ports: a covering connection wins, an uncovered view port stays', () => {
    const connection: Port = { direction: 'out', crosses: 'calls', far: { project: 'b', feature: 'f', anchor: 'file:x.ts', file: 'x.ts', local: false }, internalNode: null, trust: 'code', source: 'connection' };
    const covered: Port = { direction: 'out', crosses: 'other words', far: { project: 'b', feature: 'f', local: false }, internalNode: 'n', trust: 'model', source: 'view' };
    const otherSide: Port = { ...covered, direction: 'in' };
    const otherFile: Port = { ...covered, far: { project: 'b', feature: 'f', file: 'y.ts', local: false } };
    expect(connectionCovers(connection, covered)).toBe(true);
    expect(connectionCovers(connection, otherSide)).toBe(false);
    expect(connectionCovers(connection, otherFile)).toBe(false);
    const merged = mergeViewPorts([connection], [covered, otherSide, otherFile]);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ source: 'connection', trust: 'code', internalNode: 'n', crosses: 'calls' });
    expect(merged.slice(1).every((port) => port.source === 'view')).toBe(true);
    // The input connection is not mutated.
    expect(connection.internalNode).toBeNull();
  });

  it('caps a side at the named constant and counts the rest', () => {
    const many: Port[] = Array.from({ length: PORTS_PER_SIDE_CAP + 3 }, (_, i) => ({
      direction: 'in',
      crosses: `c${String(i).padStart(2, '0')}`,
      far: { local: true },
      internalNode: null,
      trust: i === PORTS_PER_SIDE_CAP + 2 ? 'code' : 'model',
      source: 'connection',
    }));
    const { shown, more } = capPorts(many);
    expect(shown).toHaveLength(PORTS_PER_SIDE_CAP);
    expect(more).toBe(3);
    // Sorted by trust first: the one code port survives the cap.
    expect(shown[0].trust).toBe('code');
  });
});

// ─── The read, against a seeded Workspace ───────────────────────────────────

describeWithGit('readFeaturePorts', () => {
  let sandbox: string;
  let flowFolder: string;
  const repos: Record<string, string> = {};
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  function makeRepo(name: string): string {
    const path = join(sandbox, 'code', name);
    mkdirSync(join(path, 'src'), { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    writeFileSync(join(path, 'src', 'index.ts'), 'export const x = 1\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    git(path, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
    return path;
  }

  const projectFolder = (slug: string): string => join(flowFolder, 'workspaces', 'team', 'projects', slug);
  const linksFile = (): string => join(flowFolder, 'workspaces', 'team', 'links.jsonl');

  function feature(project: string, slug: string, name: string, anchors: string[], extra: { relates?: string; parts?: string } = {}): void {
    const dir = join(projectFolder(project), 'brain', 'features');
    mkdirSync(dir, { recursive: true });
    const relates = extra.relates ?? 'relates: []';
    const parts = extra.parts === undefined ? '' : `\n## Parts\n\n${extra.parts}`;
    writeFileSync(
      join(dir, `${slug}.md`),
      `---\nid: feature:${slug}\nname: ${name}\nkind: core\nanchors: [${anchors.join(', ')}]\n${relates}\nlastFullRead: null\npatchCount: 0\n---\n\n# ${name}\n\nWhat ${name} does.\n${parts}`,
    );
  }

  function link(record: Record<string, unknown>): void {
    appendFileSync(linksFile(), `${JSON.stringify({ ts: '2026-10-07T00:00:00.000Z', author: null, ...record })}\n`);
  }

  const code = (file: string) => ({ file, from: 1, to: 1, note: 'why', text: 'export const x = 1' });

  function view(project: string, slug: string, ports?: Record<string, unknown>): void {
    const dir = join(projectFolder(project), 'brain', '.structure', 'feature-views');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${slug}.json`),
      JSON.stringify({
        feature: slug,
        provenance: 'test',
        generatedAt: '2026-10-07T00:00:00.000Z',
        meta: { title: 'Chats' },
        brief: {},
        views: {
          root: {
            title: 'Chats',
            nodes: [
              { id: 'stream', kind: 'module', title: 'Chat stream', delta: 'stable', code: code('src/stream.ts'), view: 'stream-inside' },
              { id: 'list', kind: 'module', title: 'Chat list', delta: 'stable' },
              { id: 'screen', kind: 'function', title: 'Chat screen', delta: 'stable', code: code('src/chats.tsx') },
            ],
            edges: [{ from: 'screen', to: 'stream', label: 'opens', delta: 'kept' }],
            ...(ports === undefined ? {} : { ports }),
          },
          'stream-inside': {
            title: 'Inside the stream',
            nodes: [{ id: 'sse', kind: 'function', title: 'SSE reader', delta: 'stable', code: code('src/stream.ts') }],
            edges: [],
          },
        },
      }),
    );
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-feature-ports-')));
    flowFolder = join(sandbox, 'plan-flow');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.PLAN_FLOW_HOME = flowFolder;
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');

    createWorkspace({ flowFolder, name: 'Team' });
    repos.backend = makeRepo('backend');
    repos.frontend = makeRepo('frontend');
    for (const name of ['backend', 'frontend']) linkRepo({ flowFolder, target: repos[name] });

    // backend: chat-engine owns the chat endpoint through a part, and the events module.
    feature('backend', 'chat-engine', 'Chat Engine', ['file:src/engine.ts', 'module:src/events'], {
      parts: '### Chat API\nThe HTTP surface.\nanchors: endpoint:POST /api/chat\n',
    });
    feature('backend', 'auth', 'Auth', ['file:src/auth.ts']);
    // Two features claiming one anchor: neither may be named.
    feature('backend', 'billing', 'Billing', ['file:src/shared.ts']);
    feature('backend', 'ledger', 'Ledger', ['file:src/shared.ts']);

    // frontend: chats, with two parts, a curated view, an in-project edge and a link mirror.
    feature('frontend', 'chats', 'Chats', ['file:src/chats.tsx'], {
      relates: 'relates:\n  - target: backend/auth\n    note: workspace link — relates backend/auth',
      parts: [
        '### Chat stream\nReads the stream.\nanchors: src/stream.ts\n',
        '### Chat list\nThe list.\nanchors: src/list.tsx, src/list-item.tsx\n',
      ].join('\n'),
    });
    feature('frontend', 'settings', 'Settings', ['file:src/settings.tsx'], {
      relates: 'relates:\n  - target: feature:chats\n    via: src/chats.tsx\n    note: opens settings from the chat screen',
    });
    view('frontend', 'chats');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const read = (ref = 'chats', target = repos.frontend): Ports => readFeaturePorts({ flowFolder, repoRoot: target, feature: ref });
  const find = (ports: readonly Port[], crosses: string): Port | undefined => ports.find((port) => port.crosses === crosses);

  it('turns each kind into the right side, from either end', () => {
    link({ kind: 'calls', from: 'frontend/file:src/stream.ts', to: 'backend/endpoint:POST /api/chat', note: 'HTTP POST /api/chat', source: 'learned', evidence: 'code' });
    link({ kind: 'calls', from: 'backend/file:src/auth.ts', to: 'frontend/file:src/list-item.tsx', note: 'session refresh' });
    link({ kind: 'consumes', from: 'frontend/chats', to: 'backend/file:src/events/bus.ts:emit', note: 'SSE events', source: 'learned', evidence: 'model' });
    link({ kind: 'consumes', from: 'backend/symbol:verifyToken', to: 'frontend/chats' });
    link({ kind: 'exposes', from: 'frontend/chats', to: 'backend/auth', note: 'chat transcript export' });
    link({ kind: 'exposes', from: 'backend/chat-engine', to: 'frontend/chats' });
    link({ kind: 'relates', from: 'frontend/chats', to: 'backend/auth' });
    // Touches neither chats nor any anchor it claims.
    link({ kind: 'calls', from: 'frontend/settings', to: 'backend/auth', note: 'unrelated' });

    const ports = read();
    expect(ports).toMatchObject({ action: 'features-ports', feature: 'feature:chats', slug: 'chats', name: 'Chats', part: null, project: 'frontend' });
    expect(ports.workspace).toEqual({ name: 'Team', slug: 'team' });
    expect(ports.in.map((port) => port.crosses).sort()).toEqual(['chat transcript export', 'exposes', 'session refresh']);
    expect(ports.out.map((port) => port.crosses).sort()).toEqual(['HTTP POST /api/chat', 'SSE events', 'consumes']);
    expect(ports.linked.map((port) => port.crosses).sort()).toEqual(['opens settings from the chat screen', 'relates']);
    expect([...ports.in, ...ports.out, ...ports.linked].some((port) => port.crosses === 'unrelated')).toBe(false);
    expect(ports.more).toEqual({ in: 0, out: 0, linked: 0 });
  });

  it('names the far end as finely as is known', () => {
    link({ kind: 'calls', from: 'frontend/file:src/stream.ts', to: 'backend/endpoint:POST /api/chat', note: 'endpoint', source: 'learned', evidence: 'code' });
    link({ kind: 'consumes', from: 'frontend/chats', to: 'backend/file:src/events/bus.ts:emit', note: 'file and symbol' });
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/auth', note: 'feature slug' });
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/symbol:verifyToken', note: 'bare symbol' });
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/file:src/shared.ts', note: 'two claimants' });

    const { out } = read();
    const projectName = find(out, 'feature slug')?.far.projectName;
    expect(typeof projectName).toBe('string');
    expect(find(out, 'feature slug')?.far).toEqual({ project: 'backend', projectName, feature: 'auth', featureId: 'feature:auth', featureName: 'Auth', local: false });
    // An endpoint claimed by a part: the feature AND the part.
    expect(find(out, 'endpoint')?.far).toEqual({
      project: 'backend',
      projectName,
      anchor: 'endpoint:POST /api/chat',
      feature: 'chat-engine',
      featureId: 'feature:chat-engine',
      featureName: 'Chat Engine',
      part: 'feature:chat-engine/chat-api',
      partName: 'Chat API',
      local: false,
    });
    // A file under a module anchor, with a symbol locator.
    expect(find(out, 'file and symbol')?.far).toMatchObject({ file: 'src/events/bus.ts', symbol: 'emit', feature: 'chat-engine' });
    expect(find(out, 'file and symbol')?.far.part).toBeUndefined();
    // Nothing claims a bare symbol: the symbol only, no feature guessed.
    const bare = find(out, 'bare symbol')?.far;
    expect(bare).toMatchObject({ symbol: 'verifyToken', anchor: 'symbol:verifyToken' });
    expect(bare?.feature).toBeUndefined();
    // Two features claim the file: neither is named.
    const shared = find(out, 'two claimants')?.far;
    expect(shared).toMatchObject({ file: 'src/shared.ts' });
    expect(shared?.feature).toBeUndefined();
  });

  it('matches the internal component by code citation, then by the claiming part, else null', () => {
    link({ kind: 'calls', from: 'frontend/file:src/stream.ts', to: 'backend/endpoint:POST /api/chat', note: 'by file' });
    link({ kind: 'calls', from: 'backend/file:src/auth.ts', to: 'frontend/file:src/list-item.tsx', note: 'by part' });
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/auth', note: 'feature end' });
    link({ kind: 'calls', from: 'frontend/file:src/chats.tsx:openChat', to: 'backend/auth', note: 'with locator' });

    const ports = read();
    expect(find(ports.out, 'by file')?.internalNode).toBe('stream');
    expect(find(ports.in, 'by part')?.internalNode).toBe('list');
    expect(find(ports.out, 'feature end')?.internalNode).toBeNull();
    expect(find(ports.out, 'with locator')?.internalNode).toBe('screen');
    // An in-project edge's `via` that a component cites.
    expect(find(ports.linked, 'opens settings from the chat screen')?.internalNode).toBe('screen');
  });

  it('falls back to null when the feature has no curated view', () => {
    rmSync(join(projectFolder('frontend'), 'brain', '.structure', 'feature-views', 'chats.json'));
    link({ kind: 'calls', from: 'frontend/file:src/stream.ts', to: 'backend/auth', note: 'no view' });
    expect(find(read().out, 'no view')?.internalNode).toBeNull();
  });

  it('carries trust from the evidence', () => {
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/auth', note: 'code', source: 'learned', evidence: 'code' });
    link({ kind: 'consumes', from: 'frontend/chats', to: 'backend/auth', note: 'model', source: 'learned', evidence: 'model' });
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/chat-engine', note: 'declared' });
    const { out } = read();
    expect(out.map((port) => [port.crosses, port.trust])).toEqual([
      ['code', 'code'],
      ['declared', 'declared'],
      ['model', 'model'],
    ]);
    expect(out.every((port) => port.source === 'connection')).toBe(true);
  });

  it('dedupes two links to the same far end with the same crossing, keeping code trust', () => {
    link({ kind: 'calls', from: 'frontend/file:src/stream.ts', to: 'backend/endpoint:POST /api/chat', note: 'HTTP POST /api/chat', source: 'learned', evidence: 'code' });
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/endpoint:POST /api/chat', note: 'HTTP POST /api/chat', source: 'learned', evidence: 'model' });
    const { out } = read();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ trust: 'code', internalNode: 'stream' });
  });

  it('caps each side and counts the rest', () => {
    const total = PORTS_PER_SIDE_CAP + 4;
    for (let i = 0; i < total; i += 1) {
      link({ kind: 'calls', from: 'frontend/chats', to: `backend/endpoint:GET /api/x${String(i)}`, note: `call ${String(i)}` });
    }
    const ports = read();
    expect(ports.out).toHaveLength(PORTS_PER_SIDE_CAP);
    expect(ports.more).toEqual({ in: 0, out: 4, linked: 0 });
  });

  it('reads a part: only links its anchors claim, matched inside its own level, no relates', () => {
    link({ kind: 'calls', from: 'frontend/file:src/stream.ts', to: 'backend/endpoint:POST /api/chat', note: 'part link' });
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/auth', note: 'feature link' });
    const ports = read('feature:chats/chat-stream');
    expect(ports.part).toEqual({ id: 'feature:chats/chat-stream', name: 'Chat stream' });
    expect(ports.out.map((port) => [port.crosses, port.internalNode])).toEqual([['part link', 'sse']]);
    expect(ports.linked).toEqual([]);
  });

  it('skips a link mirror among the relates edges — the link itself is the port', () => {
    const { linked } = read();
    expect(linked.map((port) => port.crosses)).toEqual(['opens settings from the chat screen']);
    expect(linked[0].far).toMatchObject({ project: 'frontend', feature: 'settings', featureName: 'Settings', local: true });
    expect(linked[0].trust).toBe('declared');
  });

  it('reads in-project relates only, outside a Workspace', () => {
    const lone = join(sandbox, 'code', 'lone');
    mkdirSync(join(lone, 'flow', 'brain', 'features'), { recursive: true });
    git(lone, 'init', '-q', '-b', 'main');
    const write = (slug: string, name: string, relates: string): void =>
      writeFileSync(
        join(lone, 'flow', 'brain', 'features', `${slug}.md`),
        `---\nid: feature:${slug}\nname: ${name}\nkind: core\nanchors: []\n${relates}\nlastFullRead: null\npatchCount: 0\n---\n\n# ${name}\n`,
      );
    write('a', 'Alpha', 'relates: [feature:b]');
    write('b', 'Beta', 'relates: []');
    const ports = read('b', lone);
    expect(ports.project).toBeNull();
    expect(ports.workspace).toBeNull();
    expect(ports.in).toEqual([]);
    expect(ports.out).toEqual([]);
    expect(ports.linked).toEqual([
      { direction: 'linked', crosses: 'relates', far: { feature: 'a', featureId: 'feature:a', featureName: 'Alpha', local: true }, internalNode: null, trust: 'declared', source: 'connection' },
    ]);
  });

  it('refuses an unknown feature with the features it could have named', () => {
    expect(() => read('nope')).toThrow(PortsRefusal);
    const output = runFeaturePortsVerb({ flowFolder, repoRoot: repos.frontend, feature: 'nope', json: true });
    expect(output.exitCode).toBe(1);
    expect(output.stdout).toContain("features refused: unknown-feature — no feature or part named 'nope' in this project");
    expect(lastJson(output.stdout)).toEqual({ action: 'features-ports', refused: 'unknown-feature', feature: 'nope', features: ['chats', 'settings'] });
    const missing = runFeaturePortsVerb({ flowFolder, repoRoot: repos.frontend, json: true });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('features refused: arguments');
  });

  it('adds the view\'s own ports as model trust from the view, on the component they name', () => {
    view('frontend', 'chats', {
      in: [{ crosses: 'webhook', node: 'screen', far: { project: 'backend', feature: 'auth' } }],
      out: [{ crosses: 'open settings', node: 'list', far: { feature: 'settings', file: 'src/settings.tsx', symbol: 'open' } }],
    });
    const ports = read();
    expect(ports.in).toHaveLength(1);
    expect(ports.in[0]).toMatchObject({ direction: 'in', crosses: 'webhook', internalNode: 'screen', trust: 'model', source: 'view' });
    expect(ports.in[0].far).toMatchObject({ project: 'backend', feature: 'auth', featureId: 'feature:auth', featureName: 'Auth', local: false });
    expect(ports.out).toHaveLength(1);
    expect(ports.out[0]).toMatchObject({ crosses: 'open settings', internalNode: 'list', trust: 'model', source: 'view' });
    expect(ports.out[0].far).toMatchObject({ project: 'frontend', feature: 'settings', featureName: 'Settings', file: 'src/settings.tsx', symbol: 'open', local: true });
  });

  it('drops a view port a connection already covers — the connection wins and keeps the view\'s component', () => {
    link({ kind: 'calls', from: 'frontend/chats', to: 'backend/auth', note: 'session check' });
    view('frontend', 'chats', {
      out: [
        { crosses: 'verify session', node: 'stream', far: { project: 'backend', feature: 'auth' } },
        { crosses: 'charge card', node: 'list', far: { project: 'backend', feature: 'billing' } },
      ],
    });
    const { out } = read();
    expect(out.map((port) => [port.crosses, port.trust, port.source, port.internalNode])).toEqual([
      ['session check', 'declared', 'connection', 'stream'],
      ['charge card', 'model', 'view', 'list'],
    ]);
  });

  it('answers through the CLI as one JSON line', () => {
    link({ kind: 'calls', from: 'frontend/file:src/stream.ts', to: 'backend/endpoint:POST /api/chat', note: 'HTTP POST /api/chat', source: 'learned', evidence: 'code' });
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [tsxRunnerPath(PACKAGE_ROOT), join(PACKAGE_ROOT, 'src', 'cli', 'index.ts'), 'blueprint', 'features', 'ports', ...args], {
        encoding: 'utf-8',
        cwd: sandbox,
        timeout: 120_000,
        env: { ...process.env, PLANFLOW_NO_BACKGROUND_WORK: '1' },
      });
    const ok = run('--feature', 'chats', '--target', repos.frontend, '--json');
    expect(ok.status).toBe(0);
    const lines = ok.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const answer = JSON.parse(lines[0]) as Ports;
    expect(answer.out[0]).toMatchObject({ crosses: 'HTTP POST /api/chat', trust: 'code', internalNode: 'stream' });

    const refused = run('--feature', 'nope', '--target', repos.frontend, '--json');
    expect(refused.status).toBe(1);
    expect(`${refused.stdout}\n${refused.stderr}`).toContain('features refused: unknown-feature');
  });
});
