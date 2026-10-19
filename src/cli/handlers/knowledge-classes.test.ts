/**
 * The four knowledge sync classes — the one table, its emitters, and the
 * pre-push guard. The `.gitignore` / `.gitattributes` are proven against a REAL
 * git in a throwaway sandbox (git's own `check-ignore` / `check-attr` verdicts),
 * because a pattern list that only agrees with our own matcher proves nothing.
 * The real ~/plan-flow is never named: every Workspace here lives under mkdtemp.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const classes = await import('./knowledge-classes.js');
const shared = await import('./shared.js');
const model = await import('./workspace-model.js');
const locate = await import('./workspace-locate.js');

const {
  KNOWLEDGE_CLASS_TABLE,
  PersonalFilesRefusal,
  assertNoPersonalFiles,
  classifyKnowledgePath,
  findPersonalFiles,
  knowledgeRepoLocalEntries,
  matchesKnowledgePattern,
  upsertWorkspaceBlock,
  workspaceGitattributes,
  workspaceGitignore,
  workspaceReadme,
  upsertReadmeBlock,
} = classes;

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;

/** Every path a project's flow/ commonly holds, with the class it must get. */
const PROJECT_PATHS: readonly [string, string][] = [
  // authored
  ['discovery/discovery_orders_v1.md', 'authored'],
  ['plans/plan_orders_v1.md', 'authored'],
  ['brainstorms/brainstorm_orders_v1.md', 'authored'],
  ['brain/decisions/why-postgres.md', 'authored'],
  ['brain/features/orders.md', 'authored'],
  ['brain/errors/timeout.md', 'authored'],
  ['brain/modules/src-api.md', 'authored'],
  ['brain/.links.json', 'authored'],
  ['archive/plan_old_v1.md', 'authored'],
  ['contracts/stripe_contract.md', 'authored'],
  ['ledger.md', 'authored'],
  ['rules/core/allowed-patterns.md', 'authored'],
  // append-only
  ['brain/.structure/annotations.jsonl', 'append-only'],
  ['brain/.structure/investigations.jsonl', 'append-only'],
  ['brain/.structure/proposals.jsonl', 'append-only'],
  ['brain/.structure/status-events.jsonl', 'append-only'],
  ['brain/.structure/feature-candidates.jsonl', 'append-only'],
  ['archive/rounds_plan_old_v1.jsonl', 'append-only'],
  // generated
  ['references/tech-foundation.md', 'generated'],
  ['brain/index.md', 'generated'],
  ['brain/.derived/INDEX.md', 'generated'],
  ['brain/.structure/graph.json', 'generated'],
  ['brain/.structure/graph.prev.json', 'generated'],
  ['brain/.structure/symbols.jsonl', 'generated'],
  ['brain/.structure/story.json', 'generated'],
  ['brain/.structure/blueprint.html', 'generated'],
  ['brain/.structure/file-tiers.prev.json', 'generated'],
  ['brain/.structure/surface.json', 'generated'],
  ['brain/.structure/something-new.json', 'generated'],
  ['brain/.structure/feature-views/chats.json', 'generated'],
  ['brain/.structure/storyline/0a1b2c.json', 'generated'],
  ['brain/.structure/storyline/imports.json', 'generated'],
  ['brain/blueprint-report.md', 'generated'],
  ['brain/code/src-api.md', 'generated'],
  ['plans/orders.run.json', 'generated'],
  ['archive/orders.run.prev.json', 'generated'],
  // personal
  ['STATE.md', 'personal'],
  ['.scratchpad.md', 'personal'],
  ['.flowconfig', 'personal'],
  ['.rounds.jsonl', 'personal'],
  ['.wave-context.jsonl', 'personal'],
  ['.heartbeat-events.jsonl', 'personal'],
  ['.heartbeat-prompt.md', 'personal'],
  ['.heartbeat.pid', 'personal'],
  ['.evidence/run-1/phase-1-task-1/tsc.txt', 'personal'],
  ['brain/.raw/thread-1.md', 'personal'],
  ['heartbeat.md', 'personal'],
  ['memory.md', 'personal'],
  ['log.md', 'personal'],
  ['tasklist.md', 'personal'],
  ['brain/.structure/learning-state.jsonl', 'personal'],
  ['brain/.structure/brain-usage.json', 'personal'],
  ['brain/.structure/feature-learning-state.json', 'personal'],
  ['brain/.structure/features.lock', 'personal'],
];

describe('classifyKnowledgePath', () => {
  it.each(PROJECT_PATHS)('%s is %s', (path, expected) => {
    expect(classifyKnowledgePath(path)).toBe(expected);
  });

  it('reads Workspace-root paths: projects/<slug>/… by the project rules, the root files by their own', () => {
    expect(classifyKnowledgePath('projects/backend/STATE.md', { root: 'workspace' })).toBe('personal');
    expect(classifyKnowledgePath('projects/backend/plans/plan_a_v1.md', { root: 'workspace' })).toBe('authored');
    expect(classifyKnowledgePath('projects/backend/brain/index.md', { root: 'workspace' })).toBe('generated');
    expect(classifyKnowledgePath('workspace.json', { root: 'workspace' })).toBe('authored');
    expect(classifyKnowledgePath('links.jsonl', { root: 'workspace' })).toBe('append-only');
    expect(classifyKnowledgePath('merges/2026-10-06-abc.md', { root: 'workspace' })).toBe('authored');
    // A personal file dropped at the root by hand is still recognised.
    expect(classifyKnowledgePath('.scratchpad.md', { root: 'workspace' })).toBe('personal');
  });

  /**
   * LIVE INCIDENT (2026-10-16). A Workspace's first sync published eight files
   * that had been written to `flow/`'s root instead of into one of its folders:
   * four Confluence drafts, two PR drafts, a QA checklist and a test plan — plus
   * a stray .patch and a .DS_Store in a second project. Of every root-level file
   * tracked across five projects, NOT ONE was a legitimate artifact, because the
   * root is a closed set and everything real lives in a folder.
   *
   * The old default published them: no pattern matched, so they fell through to
   * `authored`. The root now defaults the other way.
   */
  it('keeps an unrecognised file at a project knowledge root OFF the team repo', () => {
    // The positive control first: the folders still share, so a `personal`
    // below is evidence of the rule and not of a broken table (#28).
    expect(classifyKnowledgePath('discovery/discovery_orders_v1.md')).toBe('authored');
    expect(classifyKnowledgePath('resources/design-guide.md')).toBe('authored');
    expect(classifyKnowledgePath('archive/plan_old_v1.md')).toBe('authored');

    for (const stray of [
      'design-guide-wiki.md',
      'pr-draft-ticket-4471.md',
      'qa-checklist-ticket-4471.md',
      'test-plan-migration.md',
      'schema-guard.patch',
      '.DS_Store',
    ]) {
      expect(classifyKnowledgePath(stray)).toBe('personal');
      expect(classifyKnowledgePath(`projects/orders-api/${stray}`, { root: 'workspace' })).toBe('personal');
    }
  });

  it('still shares the one root file that is team knowledge', () => {
    // ledger.md used to be shared only by falling through to the default the
    // test above closes, so it now has a row of its own.
    expect(classifyKnowledgePath('ledger.md')).toBe('authored');
    expect(classifyKnowledgePath('projects/orders-api/ledger.md', { root: 'workspace' })).toBe('authored');
  });

  it("does not close the WORKSPACE repo's own root, whose members are a different set", () => {
    // These sit beside projects/ and must keep syncing: closing the wrong root
    // would stop a team's shared files dead.
    expect(classifyKnowledgePath('workspace.json', { root: 'workspace' })).not.toBe('personal');
    expect(classifyKnowledgePath('links.jsonl', { root: 'workspace' })).not.toBe('personal');
    expect(classifyKnowledgePath('connections-learning.jsonl', { root: 'workspace' })).toBe('append-only');
    expect(classifyKnowledgePath('README.md', { root: 'workspace' })).toBe('authored');
  });

  it('keeps the per-project knowledge repo scope: its journals still sync (C-4)', () => {
    for (const journal of ['tasklist.md', 'memory.md', 'log.md', 'heartbeat.md']) {
      expect(classifyKnowledgePath(journal, { legacyScope: true })).toBe('authored');
      expect(classifyKnowledgePath(journal)).toBe('personal');
    }
  });

  it('matches gitignore syntax: anchored, any depth, directories, globs', () => {
    expect(matchesKnowledgePattern('/STATE.md', 'STATE.md')).toBe(true);
    expect(matchesKnowledgePattern('/STATE.md', 'archive/STATE.md')).toBe(false);
    expect(matchesKnowledgePattern('.flowconfig', 'nested/.flowconfig')).toBe(true);
    expect(matchesKnowledgePattern('.evidence/', 'x/.evidence/a/b.txt')).toBe(true);
    expect(matchesKnowledgePattern('.evidence/', '.evidence')).toBe(false);
    expect(matchesKnowledgePattern('brain/.structure/*', 'brain/.structure/feature-views/a.json')).toBe(true);
    expect(matchesKnowledgePattern('brain/.structure/*.jsonl', 'brain/.structure/views/a.jsonl')).toBe(false);
  });
});

describe('the superseded per-project list (knowledgeRepoLocalEntries)', () => {
  it('is byte-identical to what knowledge sync shipped, in the same order', () => {
    expect(knowledgeRepoLocalEntries()).toEqual([
      'brain/.raw/',
      'brain/.derived/',
      'brain/.structure/graph.json',
      'brain/.structure/graph.prev.json',
      'brain/.structure/symbols.jsonl',
      'brain/.structure/file-stamps.json',
      'brain/.structure/file-tiers.json',
      'brain/code/',
      '.flowconfig',
      '.evidence/',
      '.rounds.jsonl',
      '.wave-context.jsonl',
      '.heartbeat-events.jsonl',
      '.heartbeat-state.json',
      '.heartbeat-prompt.md',
      '.heartbeat.log',
      '.telegram-poll-state.json',
      '.scratchpad.md',
      '.lavish/',
      '/STATE.md',
      'brain/.structure/story.json',
      'brain/.structure/blueprint.html',
      'brain/.structure/file-*.json',
      'brain/.structure/brain-usage.json',
      'brain/.structure/invariant-verdicts.json',
      'brain/.structure/outbound.json',
      'brain/.structure/surface.json',
      'brain/.structure/feature-views/',
      '/brain/blueprint-report.md',
      '/.heartbeat-*',
      '/.heartbeat.*',
    ]);
  });

  it('is still exported from shared.ts, so existing callers keep their import', () => {
    expect(shared.knowledgeRepoLocalEntries()).toEqual(knowledgeRepoLocalEntries());
  });

  it('every row it names is generated or personal in the table', () => {
    for (const pattern of knowledgeRepoLocalEntries()) {
      const row = KNOWLEDGE_CLASS_TABLE.find((entry) => entry.pattern === pattern);
      expect(row).toBeDefined();
      expect(['generated', 'personal']).toContain(row?.class);
    }
  });
});

describe('the pre-push guard', () => {
  it('refuses personal files with the list of offending paths', () => {
    const staged = [
      'workspace.json',
      'projects/backend/plans/plan_a_v1.md',
      'projects/backend/STATE.md',
      'projects/frontend/tasklist.md',
      'projects/frontend/brain/.structure/annotations.jsonl',
    ];
    let refusal: unknown;
    try {
      assertNoPersonalFiles(staged);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(PersonalFilesRefusal);
    const typed = refusal as InstanceType<typeof PersonalFilesRefusal>;
    expect(typed.reason).toBe('personal-files');
    expect(typed.paths).toEqual(['projects/backend/STATE.md', 'projects/frontend/tasklist.md']);
    expect(typed.sentence).toContain('projects/backend/STATE.md');
    expect(typed.hits.map((hit) => hit.pattern)).toEqual(['/STATE.md', '/tasklist.md']);
  });

  it('matches the personal class case-insensitively — a case-insensitive disk holds them as one file (review fix 4)', () => {
    expect(classifyKnowledgePath('TaskList.md')).toBe('personal');
    expect(classifyKnowledgePath('projects/backend/MEMORY.md', { root: 'workspace' })).toBe('personal');
    expect(findPersonalFiles(['projects/backend/.Flowconfig', 'projects/backend/Brain/.RAW/x.md']).map((hit) => hit.path)).toEqual([
      'projects/backend/.Flowconfig',
      'projects/backend/Brain/.RAW/x.md',
    ]);
  });

  it('lets authored, append-only and generated paths through', () => {
    const staged = ['workspace.json', 'links.jsonl', 'projects/a/brain/features/x.md', 'projects/a/brain/.structure/proposals.jsonl'];
    expect(findPersonalFiles(staged)).toEqual([]);
    expect(() => assertNoPersonalFiles(staged)).not.toThrow();
    expect(() => assertNoPersonalFiles([])).not.toThrow();
  });
});

describe('upsertWorkspaceBlock', () => {
  it('writes the block into an empty file and replaces only the block in an edited one', () => {
    const block = workspaceGitignore();
    const first = upsertWorkspaceBlock(null, block);
    expect(first).toBe(`${block}\n`);
    const edited = `# mine\nnotes/\n\n${first}\nscratch/\n`;
    const next = upsertWorkspaceBlock(edited, block);
    expect(next).toBe(edited);
    const stale = edited.replace('/projects/*/STATE.md', '/projects/*/OLD.md');
    expect(upsertWorkspaceBlock(stale, block)).toBe(edited);
  });
});

describe('the workspace-locate names restate the model’s', () => {
  it('pins the two constant pairs equal', () => {
    expect(locate.LOCATE_WORKSPACE_FILENAME).toBe(model.WORKSPACE_FILENAME);
    expect(locate.LOCATE_PROJECTS_DIRNAME).toBe(model.WORKSPACE_PROJECTS_DIRNAME);
  });
});

describeWithGit('the Workspace .gitignore and .gitattributes, judged by git itself', () => {
  let sandbox: string;
  const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'HOME', 'FLOW_E2E', 'FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS'] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    return { status: result.status, stdout: result.stdout };
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-knowledge-classes-')));
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(
      join(sandbox, 'gitconfig'),
      `[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[url "file://${sandbox}/remotes/"]\n\tinsteadOf = https://git.example.test/\n`
    );
    process.env.FLOW_E2E = '1';
    process.env.FLOW_E2E_KNOWLEDGE_GIT_PROTOCOLS = 'file';
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('ignores exactly the generated and personal files of every project, and merges jsonl by union', () => {
    const repo = join(sandbox, 'ws');
    mkdirSync(repo, { recursive: true });
    expect(git(repo, 'init', '-q', '-b', 'main').status).toBe(0);
    writeFileSync(join(repo, '.gitignore'), `${workspaceGitignore()}\n`);
    writeFileSync(join(repo, '.gitattributes'), `${workspaceGitattributes()}\n`);
    for (const project of ['backend', 'frontend']) {
      for (const [path] of PROJECT_PATHS) {
        const full = join(repo, 'projects', project, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, 'x\n');
      }
    }
    for (const project of ['backend', 'frontend']) {
      for (const [path, expected] of PROJECT_PATHS) {
        const rel = `projects/${project}/${path}`;
        const ignored = git(repo, 'check-ignore', '-q', '--', rel).status === 0;
        expect([rel, ignored]).toEqual([rel, expected === 'generated' || expected === 'personal']);
      }
    }
    const attr = git(repo, 'check-attr', 'merge', '--', 'projects/backend/brain/.structure/annotations.jsonl', 'links.jsonl');
    expect(attr.stdout).toContain('projects/backend/brain/.structure/annotations.jsonl: merge: union');
    expect(attr.stdout).toContain('links.jsonl: merge: union');

    // And git's verdict agrees with the guard: nothing staged by `add -A` is personal.
    expect(git(repo, 'add', '-A').status).toBe(0);
    const staged = git(repo, 'diff', '--cached', '--name-only').stdout.split('\n').filter((line) => line !== '');
    expect(staged.length).toBeGreaterThan(0);
    expect(findPersonalFiles(staged)).toEqual([]);
    for (const path of staged) expect(classifyKnowledgePath(path, { root: 'workspace' })).not.toBe('generated');
  });

  it('workspace create writes both files and makes one local commit of them with workspace.json', () => {
    const flowFolder = join(sandbox, 'flow');
    const created = model.createWorkspace({ flowFolder, name: 'Team' });
    const path = join(flowFolder, 'workspaces', 'team');
    expect(readFileSync(join(path, '.gitignore'), 'utf-8')).toBe(`${workspaceGitignore()}\n`);
    expect(readFileSync(join(path, '.gitattributes'), 'utf-8')).toBe(`${workspaceGitattributes()}\n`);
    expect(created.initialCommit).toMatch(/^[0-9a-f]{40}$/);
    const files = git(path, 'show', '--name-only', '--format=', 'HEAD').stdout.split('\n').filter((line) => line !== '').sort();
    // README.md joins them: a Workspace that explains itself from its first
    // commit, rather than once somebody remembers to write one.
    expect(files).toEqual(['.gitattributes', '.gitignore', 'README.md', 'workspace.json']);
    expect(git(path, 'status', '--porcelain').stdout).toBe('');
    // A person's own lines outside the block survive a rewrite.
    writeFileSync(join(path, '.gitignore'), `notes/\n${readFileSync(join(path, '.gitignore'), 'utf-8')}`);
    expect(model.writeWorkspaceRepoFiles(path)).toEqual([]);
    expect(readFileSync(join(path, '.gitignore'), 'utf-8').startsWith('notes/\n')).toBe(true);
    expect(existsSync(join(path, 'projects'))).toBe(true);
  });

  it('workspace join keeps the clone\u2019s ignore files current and builds each project\u2019s brain index', () => {
    const flowA = join(sandbox, 'flow-a');
    const flowB = join(sandbox, 'flow-b');
    model.createWorkspace({ flowFolder: flowA, name: 'Team', remote: 'https://git.example.test/team/ws.git' });
    const wsA = join(flowA, 'workspaces', 'team');
    const workspaceFile = JSON.parse(readFileSync(join(wsA, 'workspace.json'), 'utf-8'));
    workspaceFile.projects = [{ id: 'github.com/acme/backend', name: 'backend', slug: 'backend', remotes: [] }];
    writeFileSync(join(wsA, 'workspace.json'), `${JSON.stringify(workspaceFile, null, 2)}\n`);
    mkdirSync(join(wsA, 'projects', 'backend', 'brain', 'features'), { recursive: true });
    writeFileSync(join(wsA, 'projects', 'backend', 'brain', 'features', 'orders.md'), '---\nstatus: active\n---\n# orders\n\nIdempotent orders.\n');
    // An older Flow's ignore file: the joiner brings it up to date.
    writeFileSync(join(wsA, '.gitignore'), 'notes/\n');
    mkdirSync(join(sandbox, 'remotes', 'team'), { recursive: true });
    expect(git(join(sandbox, 'remotes', 'team'), 'init', '-q', '--bare', 'ws.git').status).toBe(0);
    expect(git(wsA, 'add', '-A').status).toBe(0);
    expect(git(wsA, 'commit', '-q', '-m', 'knowledge').status).toBe(0);
    expect(git(wsA, 'push', '-q', 'origin', 'main').status).toBe(0);

    mkdirSync(flowB, { recursive: true });
    model.joinWorkspace({ flowFolder: flowB, remote: 'https://git.example.test/team/ws.git' });
    const wsB = join(flowB, 'workspaces', 'team');
    expect(readFileSync(join(wsB, '.gitignore'), 'utf-8')).toBe(`notes/\n\n${workspaceGitignore()}\n`);
    expect(readFileSync(join(wsB, 'projects', 'backend', 'brain', 'index.md'), 'utf-8')).toContain('- orders [active] - Idempotent orders.');
    // The index is generated, so it is not something the next sync would commit.
    expect(git(wsB, 'check-ignore', '-q', '--', 'projects/backend/brain/index.md').status).toBe(0);
  });
});

describe('the closed root, as git actually reads the emitted ignore file', () => {
  // Gitignore precedence is easy to get wrong on paper (last match wins, and a
  // file under an excluded DIRECTORY cannot be re-included at all), so this
  // asks git rather than reasoning about it.
  const GIT_OK = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
  const maybe = GIT_OK ? it : it.skip;

  maybe('ignores a loose file beside the folders, and nothing inside them', () => {
    const repo = mkdtempSync(join(tmpdir(), 'pf-ignore-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: repo });
      mkdirSync(join(repo, 'projects/orders-api'), { recursive: true });
      writeFileSync(join(repo, '.gitignore'), `${workspaceGitignore()}\n`);

      const ignored = (path: string): boolean =>
        spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: repo }).status === 0;

      // The positive control: the folders still publish, so an `ignored` below
      // is evidence of the rule and not of an ignore file that swallows all.
      for (const kept of [
        'projects/orders-api/discovery/discovery_orders_v1.md',
        'projects/orders-api/plans/plan_orders_v1.md',
        'projects/orders-api/resources/design-guide.md',
        'projects/orders-api/brain/features/orders.md',
        'projects/orders-api/ledger.md',
      ]) {
        expect({ path: kept, ignored: ignored(kept) }).toEqual({ path: kept, ignored: false });
      }

      for (const stray of [
        'projects/orders-api/pr-draft-ticket-4471.md',
        'projects/orders-api/test-plan-migration.md',
        'projects/billing-api/.DS_Store',
        'projects/billing-api/schema-guard.patch',
      ]) {
        expect({ path: stray, ignored: ignored(stray) }).toEqual({ path: stray, ignored: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the Workspace README', () => {
  it('is titled after the Workspace and states what the class table actually does', () => {
    const readme = workspaceReadme('Default');
    expect(readme).toContain('# Default — a Flow Workspace');
    // The sections a teammate opening this in a browser needs.
    for (const heading of ['## What is in it', '## How the index works', '## What syncs', '## Drafts stay out', '## Editing it', '## Joining it']) {
      expect(readme).toContain(heading);
    }
    // It must not promise the opposite of the gate that exists.
    expect(readme).toContain('status: draft');
    expect(readme).toContain('landed_by');
  });

  it('is wrapped in HTML comments, so no marker renders as a heading', () => {
    const readme = workspaceReadme('Default');
    expect(readme.startsWith('<!--')).toBe(true);
    expect(readme.trimEnd().endsWith('-->')).toBe(true);
    // The gitignore's `#` markers would be an <h1> in every markdown renderer.
    expect(readme).not.toContain('# >>> plan-flow');
  });

  it('keeps a person’s own prose and replaces only its own block', () => {
    const mine = '# Our team\n\nRead the onboarding doc first.\n';
    const first = upsertReadmeBlock(mine, workspaceReadme('Default'));
    expect(first).toContain('Read the onboarding doc first.');
    expect(first).toContain('# Default — a Flow Workspace');

    // Re-emitting replaces the block in place, never appends a second copy.
    const again = upsertReadmeBlock(first, workspaceReadme('Default'));
    expect(again).toBe(first);
    expect(again.match(/a Flow Workspace/g)).toHaveLength(1);
    expect(again).toContain('Read the onboarding doc first.');
  });

  it('replaces scaffolding outright when there is no prose to keep', () => {
    // What Azure DevOps puts in a new repository: four TODOs and no content.
    const boilerplate = '# Introduction \nTODO: Give a short introduction of your project.\n';
    const out = upsertReadmeBlock(boilerplate, workspaceReadme('Default'));
    expect(out).toContain('# Default — a Flow Workspace');
    // The TODO survives, because it is prose nobody asked us to delete — the
    // block is additive, and a person removes what they no longer want.
    expect(out).toContain('TODO');
  });
});
