/**
 * The feature store inside a Workspace project (workspaces-knowledge-hub FR-19,
 * FR-20): namespaced ids, authorship, and per-machine counters kept out of the
 * synced note — and every reader accepting both id forms. Outside a Workspace
 * nothing changes (the rest of the store's suite pins that byte for byte).
 *
 * A Workspace here is only its shape on disk under mkdtemp: `workspace.json`
 * listing the project, `projects/<slug>/`, and a code repo whose `flow` links
 * there. Git identity comes from a private GIT_CONFIG_GLOBAL.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = await import('./feature-store.js');
const { buildFeatureGraph } = await import('./feature-graph.js');
const { forgetLearning } = await import('./forget-learning.js');
const { locateWorkspaceProject } = await import('../handlers/workspace-locate.js');

const {
  FEATURE_LOCAL_STATE_RELPATH,
  featureAddress,
  featureNamespace,
  featuresDir,
  mintFeatureId,
  parseFeatureId,
  readFeatures,
  resolveFeatureRef,
  sameFeatureId,
  writeEdges,
  writeFeature,
  writeLearned,
} = store;

const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;

let sandbox: string;
let flowDir: string;
let projectDir: string;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function node(slug: string, extra: Partial<ReturnType<typeof store.parseFeatureFile>> = {}): ReturnType<typeof store.parseFeatureFile> {
  return {
    id: mintFeatureId(slug),
    slug,
    name: slug,
    kind: 'core',
    anchors: [],
    relates: [],
    lastFullRead: null,
    patchCount: 0,
    body: `# ${slug}\n`,
    extra: {},
    ...extra,
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-feature-ws-')));
  writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = person@example.com\n');
  process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const workspace = join(sandbox, 'flow-folder', 'workspaces', 'team');
  projectDir = join(workspace, 'projects', 'backend');
  mkdirSync(join(projectDir, 'brain', 'features'), { recursive: true });
  writeFileSync(
    join(workspace, 'workspace.json'),
    JSON.stringify({ name: 'Team', slug: 'team', projects: [{ id: 'github.com/acme/backend', name: 'backend', slug: 'backend', remotes: [] }] }),
  );
  const repo = join(sandbox, 'code', 'backend');
  mkdirSync(repo, { recursive: true });
  symlinkSync(projectDir, join(repo, 'flow'));
  flowDir = join(repo, 'flow');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe('locating the Workspace project of a flow/ dir', () => {
  it('follows the flow link to projects/<slug>/ of a Workspace that lists it', () => {
    expect(locateWorkspaceProject(flowDir)).toEqual({
      workspacePath: join(sandbox, 'flow-folder', 'workspaces', 'team'),
      workspace: 'team',
      project: 'backend',
      projectId: 'github.com/acme/backend',
    });
    expect(featureNamespace(flowDir)).toBe('backend');
  });

  it('is null for a plain flow/, an unlisted folder, or an unreadable workspace.json', () => {
    const plain = join(sandbox, 'plain', 'flow');
    mkdirSync(plain, { recursive: true });
    expect(locateWorkspaceProject(plain)).toBeNull();
    const stray = join(sandbox, 'flow-folder', 'workspaces', 'team', 'projects', 'stray');
    mkdirSync(stray, { recursive: true });
    expect(locateWorkspaceProject(stray)).toBeNull();
    writeFileSync(join(sandbox, 'flow-folder', 'workspaces', 'team', 'workspace.json'), '{not json');
    expect(locateWorkspaceProject(flowDir)).toBeNull();
  });
});

describe('ids: namespaced in a Workspace, both forms accepted', () => {
  it('mints, parses and addresses both forms', () => {
    expect(mintFeatureId('orders')).toBe('feature:orders');
    expect(mintFeatureId('orders', 'backend')).toBe('feature:backend::orders');
    expect(parseFeatureId('feature:backend::orders')).toEqual({ namespace: 'backend', slug: 'orders' });
    expect(parseFeatureId('feature:orders')).toEqual({ namespace: null, slug: 'orders' });
    expect(parseFeatureId('module:src')).toBeNull();
    expect(featureAddress('feature:backend::orders')).toBe('backend/orders');
    expect(featureAddress('feature:orders')).toBe('orders');
  });

  it('reads the short form as this project’s feature, and two namespaces as two features', () => {
    expect(sameFeatureId('feature:orders', 'feature:backend::orders')).toBe(true);
    expect(sameFeatureId('feature:backend::orders', 'feature:frontend::orders')).toBe(false);
    const known = new Set(['feature:backend::orders', 'feature:backend::billing']);
    expect(resolveFeatureRef('feature:orders', known)).toBe('feature:backend::orders');
    expect(resolveFeatureRef('orders', known)).toBeNull();
    expect(resolveFeatureRef('orders', known, { allowBareSlug: true })).toBe('feature:backend::orders');
    expect(resolveFeatureRef('backend/orders', known, { allowBareSlug: true })).toBe('feature:backend::orders');
    // Ambiguity is not a resolution.
    expect(resolveFeatureRef('feature:orders', new Set(['feature:a::orders', 'feature:b::orders']))).toBeNull();
  });
});

describe('writing a feature into a Workspace project', () => {
  it('records a namespaced id, the author (name only) and no per-machine counters', () => {
    writeFeature(flowDir, node('orders', { anchors: ['module:src/orders'], parent: 'feature:commerce' }), { lastFullRead: '2026-10-06', patchCount: 2 });
    const raw = readFileSync(join(featuresDir(flowDir), 'orders.md'), 'utf-8');
    expect(raw).toContain('id: feature:backend::orders\n');
    expect(raw).toContain('parent: feature:backend::commerce\n');
    expect(raw).toContain('anchors: [module:src/orders]\n');
    expect(raw).toContain('author: Test Person\n');
    expect(raw).not.toContain('person@example.com');
    expect(raw).not.toMatch(/lastFullRead|patchCount/);
    const local = JSON.parse(readFileSync(join(flowDir, FEATURE_LOCAL_STATE_RELPATH), 'utf-8'));
    expect(local).toEqual({ orders: { lastFullRead: '2026-10-06', patchCount: 2 } });
    // Readers still see the counters.
    expect(readFeatures(flowDir)[0]).toMatchObject({ id: 'feature:backend::orders', lastFullRead: '2026-10-06', patchCount: 2 });
  });

  it('a counters-only write leaves the synced note byte-identical', () => {
    writeFeature(flowDir, node('orders'));
    const path = join(featuresDir(flowDir), 'orders.md');
    const before = readFileSync(path, 'utf-8');
    writeFeature(flowDir, readFeatures(flowDir)[0], { patchCount: 5, lastFullRead: '2026-10-07' });
    expect(readFileSync(path, 'utf-8')).toBe(before);
    expect(readFeatures(flowDir)[0]).toMatchObject({ patchCount: 5, lastFullRead: '2026-10-07' });
    // A learned section keeps the local counters too.
    writeLearned(flowDir, 'orders', [{ date: '2026-10-07', text: 'Orders are idempotent.', provenance: 'plan:x' }]);
    expect(readFeatures(flowDir)[0]).toMatchObject({ patchCount: 5, lastFullRead: '2026-10-07' });
    expect(readFileSync(path, 'utf-8')).not.toMatch(/patchCount/);
  });

  it('never renames an id already recorded on disk, and accepts it with the namespaced form', () => {
    const path = join(featuresDir(flowDir), 'legacy.md');
    writeFileSync(path, '---\nid: feature:legacy\nname: Legacy\nkind: core\nanchors: []\nrelates: []\nlastFullRead: 2026-01-01\npatchCount: 3\n---\n# Legacy\n');
    expect(readFeatures(flowDir)[0]).toMatchObject({ id: 'feature:legacy', patchCount: 3 });
    writeFeature(flowDir, readFeatures(flowDir)[0], { anchors: ['module:src/legacy'] });
    const raw = readFileSync(path, 'utf-8');
    expect(raw).toContain('id: feature:legacy\n');
    expect(raw).not.toContain('author:'); // not a new note
    expect(readFeatures(flowDir)[0]).toMatchObject({ patchCount: 3, lastFullRead: '2026-01-01' });
  });

  it('edges and the board resolve the short form to the namespaced feature', () => {
    writeFeature(flowDir, node('orders'));
    writeFeature(flowDir, node('billing', { kind: 'child', parent: 'feature:orders' }));
    const result = writeEdges(flowDir, 'billing', [{ target: 'orders', via: 'src/billing.ts', note: 'charges an order' }]);
    expect(result.refused).toEqual([]);
    expect(result.relates).toEqual([{ target: 'feature:backend::orders', via: 'src/billing.ts', note: 'charges an order' }]);
    // A hand-written short reference still links on the board.
    writeFileSync(
      join(featuresDir(flowDir), 'refunds.md'),
      '---\nid: feature:backend::refunds\nname: Refunds\nkind: child\nparent: feature:orders\nanchors: []\nrelates: [feature:billing]\n---\n# Refunds\n',
    );
    const graph = buildFeatureGraph(readFeatures(flowDir), new Map());
    const refunds = graph.nodes.find((entry) => entry.id === 'feature:backend::refunds');
    expect(refunds?.parent).toBe('feature:backend::orders');
    expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'feature:backend::refunds', to: 'feature:backend::billing' }));
  });

  it('forgetting resets this machine’s counters and keeps the note free of them', () => {
    writeFeature(flowDir, node('orders'), { patchCount: 4, lastFullRead: '2026-10-01' });
    writeLearned(flowDir, 'orders', [{ date: '2026-10-07', text: 'x', provenance: 'plan:x' }]);
    forgetLearning(flowDir);
    expect(readFileSync(join(featuresDir(flowDir), 'orders.md'), 'utf-8')).not.toMatch(/patchCount|## Learned/);
    expect(readFeatures(flowDir)[0]).toMatchObject({ patchCount: 0, lastFullRead: null });
  });
});

describe('outside a Workspace nothing moves', () => {
  it('keeps the bare id, the counters in the note, and writes no local state or author', () => {
    const plain = join(sandbox, 'plain', 'flow');
    mkdirSync(featuresDir(plain), { recursive: true });
    writeFeature(plain, node('orders'), { patchCount: 1 });
    const raw = readFileSync(join(featuresDir(plain), 'orders.md'), 'utf-8');
    expect(raw).toBe('---\nid: feature:orders\nname: orders\nkind: core\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 1\n---\n# orders\n');
    expect(existsSync(join(plain, FEATURE_LOCAL_STATE_RELPATH))).toBe(false);
  });
});

const { isValidPredictedNodeId } = await import('./proposal-store.js');
const { partNodeId } = await import('./feature-graph.js');
const { parseStorySection } = await import('./story-grammar.js');

describe('the namespace never collides with the part-id grammar (review fix 1)', () => {

  it('outside a Workspace an ordinary part id is never read as a namespaced feature', () => {
    expect(parseFeatureId('feature:chats/sse')?.namespace).toBeNull();
    expect(sameFeatureId('feature:chats/sse', 'feature:sse')).toBe(false);
    expect(resolveFeatureRef('feature:chats/sse', new Set(['feature:sse', 'feature:chats']))).toBeNull();
    // An edge to a part does not re-point to a same-named feature on the board.
    const plain = join(sandbox, 'plain', 'flow');
    mkdirSync(featuresDir(plain), { recursive: true });
    writeFeature(plain, node('sse'));
    writeFeature(plain, node('chats', { relates: [{ target: 'feature:chats/sse' }] }));
    const graph = buildFeatureGraph(readFeatures(plain), new Map());
    expect(graph.edges).not.toContainEqual(expect.objectContaining({ to: 'feature:sse' }));
  });

  it('inside a Workspace the namespace uses `::`, and a namespaced part id is a valid part id', () => {
    expect(mintFeatureId('orders', 'backend')).toBe('feature:backend::orders');
    expect(parseFeatureId('feature:backend::orders')).toEqual({ namespace: 'backend', slug: 'orders' });
    expect(featureAddress('feature:backend::orders')).toBe('backend/orders');
    const part = partNodeId('feature:backend::orders', 'Create order');
    expect(part).toBe('feature:backend::orders/create-order');
    expect(isValidPredictedNodeId('part', part)).toBe(true);
    expect(isValidPredictedNodeId('part', 'feature:chats/sse')).toBe(true);
    expect(isValidPredictedNodeId('part', 'feature:backend::orders')).toBe(false);
    expect(isValidPredictedNodeId('part', 'feature:Backend::orders/x')).toBe(false);
    expect(sameFeatureId(part, 'feature:create-order')).toBe(false);
    const { steps, warnings } = parseStorySection(
      ['## Story', '', '### Step: Orders', `- flow_after: ${part}, feature:backend::orders/pay`, ''].join('\n'),
      'flow/plans/plan_x_v1.md',
    );
    expect(warnings.filter((warning) => warning.includes('invalid flow node'))).toEqual([]);
    expect(steps[0].flowAfter).toEqual([part, 'feature:backend::orders/pay']);
  });

  it('reads an id minted by the first cut (`feature:<project>/<slug>` for its own file) as the namespaced id', () => {
    writeFileSync(
      join(featuresDir(flowDir), 'orders.md'),
      '---\nid: feature:backend/orders\nname: Orders\nkind: core\nparent: feature:backend/commerce\nanchors: []\nrelates: []\n---\n# Orders\n',
    );
    expect(readFeatures(flowDir)[0]).toMatchObject({ id: 'feature:backend::orders', parent: 'feature:backend::commerce' });
  });
});
