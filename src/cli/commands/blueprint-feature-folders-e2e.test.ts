/**
 * Live E2E for WHERE a feature lives (plan `feature-home-folders`, phase 5) —
 * the REAL built CLI (`dist/cli/index.js`) as a subprocess against a seeded
 * temp git repo (forbidden-pattern #7: in-process seams are not the shipped
 * path). The module suites (`feature-folders.test.ts`, `feature-home.test.ts`,
 * `feature-graph.test.ts`) cover every branch in-process; this file proves the
 * shipped `blueprint features graph --json` carries the rows and the shipped
 * `blueprint features home` writes, clears and refuses through the real argv
 * parser, with the real exit codes.
 *
 * The fixture is a small Next-style app shaped like orbit-app:
 *   - Automations: anchored at its route folder (`src/app/automations`), with
 *     its real code in a name-matched folder (`src/components/automations`,
 *     which no anchor names) and one helper reached only by an import
 *     (`src/lib/schedule.ts`). It has a part, Builder.
 *   - Coworkers and Inbox: anchored the same way.
 *   - A hub (`src/lib/http.ts`) every one of those three route pages imports —
 *     shared code, so nobody's home — and a file only the hub imports
 *     (`src/lib/retry.ts`), which must not be reached THROUGH it.
 *   - Settings: anchored on three files in three folders with equal lines —
 *     spread.
 *
 * Assertions run against stdout+stderr COMBINED (allowed-pattern #15); every
 * refusal also asserts the note is byte-identical afterwards (allowed-pattern
 * #24 — a loud refusal that writes anyway is the failure). Every subprocess
 * runs with an explicit `cwd` inside the sandbox and an explicit `--target`.
 * No test here runs `init`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

const E2E_TIMEOUT_MS = 120_000;

/** `n` lines of filler code, so each file's weight is chosen, not incidental. */
function body(n: number, tag: string): string {
  return Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n');
}

const SOURCE: Record<string, string> = {
  // Automations — route page imports its components, a helper, and the hub.
  'src/app/automations/page.tsx': [
    "import { AutomationList } from '../../components/automations/AutomationList';",
    "import { nextRun } from '../../lib/schedule';",
    "import { request } from '../../lib/http';",
    'export default function Page() { return [AutomationList, nextRun, request]; }',
    '',
  ].join('\n'),
  'src/components/automations/AutomationList.tsx': `${body(40, 'list')}\nexport const AutomationList = 1;\n`,
  'src/components/automations/AutomationCard.tsx': `${body(30, 'card')}\n`,
  'src/components/automations/builder/Canvas.tsx': `${body(12, 'canvas')}\n`,
  // A test beside the code never counts.
  'src/components/automations/AutomationList.test.tsx': `${body(200, 'spec')}\n`,
  'src/lib/schedule.ts': `${body(6, 'sched')}\nexport const nextRun = 1;\n`,
  // The hub, and what only the hub reaches.
  'src/lib/http.ts': "import { retry } from './retry';\nexport const request = retry;\n",
  'src/lib/retry.ts': `${body(5, 'retry')}\nexport const retry = 1;\n`,
  // Coworkers and Inbox — each route page imports the hub.
  'src/app/coworkers/page.tsx': [
    "import { request } from '../../lib/http';",
    "import { CoworkerGrid } from '../../components/coworkers/CoworkerGrid';",
    'export default function Page() { return [request, CoworkerGrid]; }',
    '',
  ].join('\n'),
  'src/components/coworkers/CoworkerGrid.tsx': `${body(25, 'grid')}\nexport const CoworkerGrid = 1;\n`,
  'src/app/inbox/page.tsx': [
    "import { request } from '../../lib/http';",
    'export default function Page() { return request; }',
    '',
  ].join('\n'),
  'src/stores/inbox/inboxStore.ts': `${body(20, 'store')}\n`,
  // Settings — three equal files in three folders: no folder holds 40%.
  'src/services/billing/plan.ts': `${body(10, 'plan')}\n`,
  'src/stores/profile/profile.ts': `${body(10, 'profile')}\n`,
  'src/hooks/theme/useTheme.ts': `${body(10, 'theme')}\n`,
  // A file, for the not-a-folder refusal.
  'README.md': '# Fixture\n',
};

function note(slug: string, name: string, anchors: string[], extra: string[] = []): string {
  return [
    '---',
    `id: feature:${slug}`,
    `name: ${name}`,
    'kind: core',
    `anchors: [${anchors.join(', ')}]`,
    'relates: []',
    'lastFullRead: null',
    'patchCount: 0',
    '---',
    `# ${name}`,
    '',
    `${name} does its job.`,
    '',
    ...extra,
  ].join('\n');
}

const NOTES: Record<string, string> = {
  automations: note(
    'automations',
    'Automations',
    ['module:src/app/automations'],
    ['## Parts', '', '### Builder', 'The canvas people build an automation on.', 'anchors: src/components/automations/builder', ''],
  ),
  coworkers: note('coworkers', 'Coworkers', ['module:src/app/coworkers']),
  inbox: note('inbox', 'Inbox', ['module:src/app/inbox']),
  settings: note('settings', 'Settings', [
    'file:src/services/billing/plan.ts',
    'file:src/stores/profile/profile.ts',
    'file:src/hooks/theme/useTheme.ts',
  ]),
};

interface CliRun {
  stdout: string;
  /** stdout + stderr combined — what the user actually sees (pattern #15). */
  transcript: string;
  status: number | null;
}

interface FolderRow {
  path: string;
  lines: number;
  files: number;
  share: number;
  pinned?: true;
}

interface GraphNode {
  id: string;
  kind: string;
  folders?: {
    rows: FolderRow[];
    folderCount: number;
    spread: boolean;
    pinned: boolean;
    pinMissing: string | null;
    files: number;
    lines: number;
  };
}

interface Graph {
  nodes: GraphNode[];
}

describe('blueprint features graph/home E2E — folder rows through the real built CLI', () => {
  let sandbox: string;
  let project: string;

  function runCli(args: string[]): CliRun {
    const result = spawnSync('node', [CLI_PATH, ...args], {
      cwd: project,
      encoding: 'utf-8',
      env: { ...process.env, PLAN_FLOW_VAULT_DIR: join(sandbox, 'vault') },
      timeout: E2E_TIMEOUT_MS,
    });
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? '',
      transcript: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      status: result.status,
    };
  }

  function git(args: string[]): void {
    const result = spawnSync('git', args, { cwd: project, encoding: 'utf-8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  function seed(files: Record<string, string>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), text, 'utf-8');
    }
  }

  function notePath(slug: string): string {
    return join(project, 'flow', 'brain', 'features', `${slug}.md`);
  }

  function graph(): Graph {
    const run = runCli(['blueprint', 'features', 'graph', '--target', project, '--json']);
    expect(run.status).toBe(0);
    const line = run.stdout.trim().split('\n').pop() ?? '';
    return JSON.parse(line) as Graph;
  }

  function nodeOf(read: Graph, id: string): GraphNode {
    const node = read.nodes.find((candidate) => candidate.id === id);
    if (node === undefined) throw new Error(`no node ${id} in ${read.nodes.map((n) => n.id).join(', ')}`);
    return node;
  }

  function paths(node: GraphNode): string[] {
    return (node.folders?.rows ?? []).map((row) => row.path);
  }

  /** The last parseable `{` line of stdout (allowed-pattern #24). */
  function payloadOf(stdout: string): Record<string, unknown> {
    const lines = stdout.trim().split('\n').reverse();
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    throw new Error(`no JSON payload in: ${stdout}`);
  }

  function home(args: string[]): CliRun {
    return runCli(['blueprint', 'features', 'home', '--target', project, ...args, '--json']);
  }

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`blueprint-feature-folders-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`);
    }
  });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'feature-folders-e2e-'));
    project = join(sandbox, 'proj');
    mkdirSync(join(project, 'flow', 'brain', 'features'), { recursive: true });
    mkdirSync(join(sandbox, 'vault'), { recursive: true });
    seed(SOURCE);
    for (const [slug, text] of Object.entries(NOTES)) writeFileSync(notePath(slug), text, 'utf-8');
    git(['init', '-q']);
    writeFileSync(join(project, '.gitignore'), 'flow/\n', 'utf-8');
    git(['add', '-A']);
    git(['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.invalid', 'commit', '-q', '-m', 'seed']);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('a feature lives where its anchors, its name and its imports put it — the name-matched folder first', () => {
    const automations = nodeOf(graph(), 'feature:automations');
    const folders = automations.folders;
    expect(folders).toBeDefined();
    // The anchors stop at the route folder; the code lives in the folder its
    // NAME matches, which no anchor mentions — and that is the first row.
    expect(paths(automations)[0]).toBe('src/components/automations');
    expect(paths(automations)).toEqual(['src/components/automations', 'src/lib', 'src/app/automations']);
    const first = folders?.rows[0];
    // AutomationList (41) + AutomationCard (30) + builder/Canvas (12) — the test file never counts.
    expect(first).toMatchObject({ files: 3, lines: 83 });
    // The helper reached ONLY by an import is counted; the hub is not.
    const lib = folders?.rows.find((row) => row.path === 'src/lib');
    expect(lib).toMatchObject({ files: 1, lines: 7 });
    expect(folders?.spread).toBe(false);
    expect(folders?.pinned).toBe(false);
    expect(folders?.pinMissing).toBeNull();
    const shareSum = (folders?.rows ?? []).reduce((sum, row) => sum + row.share, 0);
    expect(shareSum).toBeCloseTo(1, 2);
  });

  it('a hub imported by three features is nobody\'s home — nor is anything reached through it', () => {
    const read = graph();
    // The positive first (allowed-pattern #28): the three importers DO carry rows.
    for (const id of ['feature:automations', 'feature:coworkers', 'feature:inbox']) {
      expect(nodeOf(read, id).folders?.rows.length ?? 0).toBeGreaterThan(0);
    }
    // Coworkers' own code is still found by name.
    expect(paths(nodeOf(read, 'feature:coworkers'))[0]).toBe('src/components/coworkers');
    // Inbox's only lib import is the hub → no src/lib row; its store is found by name.
    expect(paths(nodeOf(read, 'feature:inbox'))).toEqual(['src/stores/inbox', 'src/app/inbox']);
    // Automations' src/lib row holds schedule.ts alone: not http.ts, not retry.ts.
    const automationsLib = nodeOf(read, 'feature:automations').folders?.rows.find((row) => row.path === 'src/lib');
    expect(automationsLib?.files).toBe(1);
    expect(paths(nodeOf(read, 'feature:coworkers'))).not.toContain('src/lib');
  });

  it('a feature with no folder holding 40% reads as spread', () => {
    const settings = nodeOf(graph(), 'feature:settings');
    expect(settings.folders?.spread).toBe(true);
    expect(settings.folders?.folderCount).toBe(3);
    expect([...paths(settings)].sort()).toEqual(['src/hooks/theme', 'src/services/billing', 'src/stores/profile']);
    for (const row of settings.folders?.rows ?? []) expect(row.share).toBeLessThan(0.4);
  });

  it('a part carries its own rows', () => {
    const builder = nodeOf(graph(), 'feature:automations/builder');
    expect(builder.kind).toBe('part');
    expect(paths(builder)).toEqual(['src/components/automations/builder']);
    expect(builder.folders?.rows[0]).toMatchObject({ files: 1, lines: 12, share: 1 });
  });

  it('`features home --folder` adds exactly one home line and pins the first row; `--clear` restores the note byte for byte', () => {
    const before = readFileSync(notePath('automations'), 'utf-8');
    // The computed first row is not the one about to be pinned.
    expect(paths(nodeOf(graph(), 'feature:automations'))[0]).toBe('src/components/automations');

    const set = home(['--feature', 'automations', '--folder', 'src/app/automations']);
    expect(set.status).toBe(0);
    expect(payloadOf(set.stdout)).toEqual({
      action: 'features-home',
      feature: 'automations',
      part: null,
      home: 'src/app/automations',
      previous: null,
    });
    const after = readFileSync(notePath('automations'), 'utf-8');
    const added = after.split('\n').filter((line) => !before.split('\n').includes(line));
    expect(added).toEqual(['home: src/app/automations']);
    expect(after.split('\n')).toHaveLength(before.split('\n').length + 1);

    const pinned = nodeOf(graph(), 'feature:automations').folders;
    expect(pinned?.pinned).toBe(true);
    expect(pinned?.rows[0]).toMatchObject({ path: 'src/app/automations', pinned: true });
    // The computed rows still follow, the pinned path not repeated.
    expect(pinned?.rows.map((row) => row.path)).toEqual(['src/app/automations', 'src/components/automations', 'src/lib']);

    const clear = home(['--feature', 'automations', '--clear']);
    expect(clear.status).toBe(0);
    expect(payloadOf(clear.stdout)).toMatchObject({ home: null, previous: 'src/app/automations' });
    expect(readFileSync(notePath('automations'), 'utf-8')).toBe(before);
    expect(nodeOf(graph(), 'feature:automations').folders?.pinned).toBe(false);
  });

  it('pins a part\'s home on its own entry', () => {
    const before = readFileSync(notePath('automations'), 'utf-8');
    const set = home(['--feature', 'feature:automations/builder', '--folder', 'src/components/automations']);
    expect(set.status).toBe(0);
    expect(payloadOf(set.stdout)).toMatchObject({ feature: 'automations', part: 'feature:automations/builder' });
    const after = readFileSync(notePath('automations'), 'utf-8');
    expect(after).toBe(
      before.replace(
        'anchors: src/components/automations/builder\n',
        'anchors: src/components/automations/builder\nhome: src/components/automations\n',
      ),
    );
    const read = graph();
    expect(nodeOf(read, 'feature:automations/builder').folders?.rows[0]).toMatchObject({
      path: 'src/components/automations',
      pinned: true,
    });
    // The feature itself is untouched.
    expect(nodeOf(read, 'feature:automations').folders?.pinned).toBe(false);
  });

  const REFUSALS: Array<{ name: string; args: string[]; reason: string; payload: Record<string, unknown> }> = [
    {
      name: 'a path leaving the project',
      args: ['--feature', 'automations', '--folder', '../x'],
      reason: 'outside-project',
      payload: { folder: '../x' },
    },
    {
      name: 'a folder that does not exist',
      args: ['--feature', 'automations', '--folder', 'src/components/nowhere'],
      reason: 'missing-folder',
      payload: { folder: 'src/components/nowhere', nearest: 'src/components' },
    },
    {
      name: 'a file, not a folder',
      args: ['--feature', 'automations', '--folder', 'README.md'],
      reason: 'not-a-folder',
      payload: { folder: 'README.md' },
    },
    {
      name: 'an unknown feature',
      args: ['--feature', 'billing', '--folder', 'src/services/billing'],
      reason: 'unknown-feature',
      payload: { feature: 'billing' },
    },
  ];

  it.each(REFUSALS)('refuses $name: a payload line, then the refusal line, exit 1, nothing written', ({ args, reason, payload }) => {
    const notes = Object.keys(NOTES).map((slug) => readFileSync(notePath(slug), 'utf-8'));
    const run = home(args);
    expect(run.status).toBe(1);
    expect(payloadOf(run.stdout)).toMatchObject({ action: 'features-home', refused: reason, ...payload });
    expect(run.transcript).toContain(`features refused: ${reason} — `);
    // The payload precedes the refusal line on stdout.
    const lines = run.stdout.trim().split('\n');
    expect(lines[0]?.startsWith('{')).toBe(true);
    expect(lines[1]?.startsWith(`features refused: ${reason}`)).toBe(true);
    expect(Object.keys(NOTES).map((slug) => readFileSync(notePath(slug), 'utf-8'))).toEqual(notes);
  });
});
