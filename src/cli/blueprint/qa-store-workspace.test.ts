/**
 * Ask the Blueprint at Workspace level — the ONE writer of `<workspace>/qa.jsonl`
 * (`appendWorkspaceQaEntry`), the pointers it leaves in each cited project's
 * own log (the checkout's, or the shared folder of a project not on this computer), the Workspace readers and per-project staleness, plus the
 * verb (`blueprint qa … --workspace`) run as a subprocess from source.
 *
 * In process, a REAL git, a throwaway sandbox: every Flow folder and code repo
 * lives under one mkdtemp directory and PLAN_FLOW_HOME points into it. Every
 * refusal asserts the reason AND that nothing was written (allowed-pattern
 * #24); every absence follows the positive that makes it evidence (#28).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createWorkspace, linkRepo } = await import('../handlers/workspace-model.js');
const { classifyKnowledgePathDetailed } = await import('../handlers/knowledge-classes.js');
const {
  appendQaEntry,
  qaStaleness,
  appendWorkspaceQaEntry,
  listQaForFeature,
  listWorkspaceQa,
  QaRefusal,
  readQaEntries,
  readQaThreads,
  readWorkspaceQaEntries,
  resolveWorkspaceQaScope,
  workspaceQaPath,
  workspaceQaPointedProjects,
  workspaceQaStaleness,
} = await import('./qa-store.js');
const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const PACKAGE_ROOT = getPackageRoot();

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf-8' }).status === 0;
const describeWithGit = GIT_AVAILABLE ? describe : describe.skip;
const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PLAN_FLOW_HOME', 'PLAN_FLOW_VAULT_DIR', 'HOME'] as const;
const T1 = new Date('2026-11-15T12:00:00.000Z');

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

describeWithGit('Workspace Q&A store', () => {
  let sandbox: string;
  let flowFolder: string;
  const repos: Record<string, string> = {};
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  function git(cwd: string, ...args: string[]): void {
    const result = spawnSync('git', args, { cwd, encoding: 'utf-8', env: process.env });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }

  function makeRepo(name: string, files: Record<string, string>): string {
    const path = join(sandbox, 'code', name);
    mkdirSync(path, { recursive: true });
    git(path, 'init', '-q', '-b', 'main');
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(join(path, file, '..'), { recursive: true });
      writeFileSync(join(path, file), body);
    }
    git(path, 'add', '-A');
    git(path, 'commit', '-q', '-m', 'init');
    git(path, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
    return path;
  }

  const projectFolder = (slug: string): string => join(flowFolder, 'workspaces', 'team', 'projects', slug);
  const workspaceRoot = (): string => join(flowFolder, 'workspaces', 'team');

  function feature(project: string, slug: string, name: string): void {
    const dir = join(projectFolder(project), 'brain', 'features');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${slug}.md`),
      `---\nid: feature:${slug}\nname: ${name}\nkind: core\nanchors: []\nrelates: []\nlastFullRead: null\npatchCount: 0\n---\n\n# ${name}\n\nWhat ${name} does.\n`,
    );
  }

  const scope = (target = repos.frontend) => resolveWorkspaceQaScope({ flowFolder, target });
  const projectLog = (name: string): string => join(repos[name], 'flow', 'brain', '.structure', 'qa.jsonl');
  const linesOf = (path: string): number => (existsSync(path) ? readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '').length : 0);

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'pf-qa-workspace-')));
    flowFolder = join(sandbox, 'plan-flow');
    mkdirSync(join(sandbox, 'home'), { recursive: true });
    writeFileSync(join(sandbox, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
    process.env.HOME = join(sandbox, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(sandbox, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    process.env.PLAN_FLOW_HOME = flowFolder;
    process.env.PLAN_FLOW_VAULT_DIR = join(sandbox, 'vault');

    createWorkspace({ flowFolder, name: 'Team' });
    repos.backend = makeRepo('backend', { 'src/engine.ts': 'export const engine = 1\n' });
    repos.frontend = makeRepo('frontend', { 'src/chats.tsx': 'export const chats = 1\n' });
    repos.mobile = makeRepo('mobile', { 'src/login.tsx': 'export const login = 1\n' });
    for (const name of ['backend', 'frontend', 'mobile']) linkRepo({ flowFolder, target: repos[name] });
    feature('backend', 'chat-engine', 'Chat Engine');
    feature('frontend', 'chats', 'Chats');
    feature('mobile', 'login', 'Login');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  const input = {
    author: 'Test Person',
    question: 'How do chats reach the engine?',
    answer: 'Chats calls the engine over HTTP.',
    tags: ['feature:frontend::chats', 'link:frontend::backend'],
    sources: [
      { label: 'Engine', project: 'backend', file: 'src/engine.ts', featureId: 'feature:backend::chat-engine' },
      { label: 'Chats screen', featureId: 'feature:frontend::chats' },
    ],
    projectsRead: ['backend', 'frontend'],
    knowledgeOnly: ['mobile'],
  };

  it('writes the Workspace record and one pointer per cited local project, and project readers list the pointer', () => {
    const s = scope();
    expect(Object.keys(s.projects)).toEqual(expect.arrayContaining(['backend', 'frontend', 'mobile']));
    const entry = appendWorkspaceQaEntry(s.workspace.path, s.projects, input, T1);
    expect(entry.id).toMatch(/^wqa-/);
    expect(entry.workspace).toBe('team');
    expect(entry.tags).toEqual(['feature:frontend::chats', 'link:backend::frontend']);
    expect(entry.cited.sort()).toEqual(['backend', 'frontend']);
    expect(entry.sources[0]).toMatchObject({ project: 'backend', file: 'src/engine.ts', hashStamp: { ref: 'src/engine.ts' } });

    expect(readWorkspaceQaEntries(workspaceRoot()).map((e) => e.id)).toEqual([entry.id]);
    expect(linesOf(projectLog('backend'))).toBe(1);
    expect(linesOf(projectLog('frontend'))).toBe(1);
    expect(linesOf(projectLog('mobile'))).toBe(0); // not cited

    const [thread] = readQaThreads(repos.frontend);
    expect(thread).toMatchObject({ id: entry.id, question: input.question, answer: '', workspaceAnswer: { workspace: 'team', entryId: entry.id } });
    expect(listQaForFeature(repos.frontend, 'chats').map((t) => t.id)).toEqual([entry.id]);
    expect(listQaForFeature(repos.backend, 'chat-engine').map((t) => t.id)).toEqual([entry.id]);
  });

  it('an entry written before Workspace answers existed still reads, folds and checks staleness beside a pointer', () => {
    // The old shape first: a plain project answer, no workspace field at all.
    const old = appendQaEntry(repos.frontend, {
      author: 'Test Person',
      question: 'What renders the chat list?',
      answer: 'The Chats screen.',
      tags: ['feature:chats'],
      sources: [{ label: 'Chats screen', file: 'src/chats.tsx', featureId: 'feature:chats' }],
    }, new Date('2026-11-01T09:00:00.000Z'));
    expect(old).not.toHaveProperty('workspace');

    const s = scope();
    const entry = appendWorkspaceQaEntry(s.workspace.path, s.projects, input, T1);
    const threads = readQaThreads(repos.frontend);
    expect(threads.map((t) => t.id).sort()).toEqual([old.id, entry.id].sort());
    expect(threads.find((t) => t.id === old.id)).toMatchObject({ answer: 'The Chats screen.' });
    expect(threads.find((t) => t.id === old.id)).not.toHaveProperty('workspaceAnswer');
    expect(listQaForFeature(repos.frontend, 'chats').map((t) => t.id).sort()).toEqual([old.id, entry.id].sort());
    // Project staleness keeps working for the old entry.
    expect(qaStaleness(repos.frontend, readQaEntries(repos.frontend).filter((e) => e.id === old.id)).get(old.id)?.stale).toBe(false);
  });

  it('a follow-up folds under its parent in the Workspace and in the project', () => {
    const s = scope();
    const root = appendWorkspaceQaEntry(s.workspace.path, s.projects, input, T1);
    const follow = appendWorkspaceQaEntry(
      s.workspace.path,
      s.projects,
      { author: 'Test Person', question: 'And back?', answer: 'Over a socket.', tags: ['feature:frontend::chats'], parentId: root.id },
      new Date('2026-11-15T12:05:00.000Z'),
    );
    const [thread] = listWorkspaceQa(workspaceRoot(), { projects: ['frontend'] });
    expect(thread.followUps.map((e) => e.id)).toEqual([follow.id]);
    expect(readQaThreads(repos.frontend)[0].followUps.map((e) => e.id)).toEqual([follow.id]);
  });

  it('lists by qualified feature, project and connection; the same slug in another project does not match', () => {
    const s = scope();
    const entry = appendWorkspaceQaEntry(s.workspace.path, s.projects, input, T1);
    expect(listWorkspaceQa(workspaceRoot(), { features: ['feature:backend::chat-engine'] }).map((t) => t.id)).toEqual([entry.id]);
    expect(listWorkspaceQa(workspaceRoot(), { links: ['link:backend::frontend'] }).map((t) => t.id)).toEqual([entry.id]);
    expect(listWorkspaceQa(workspaceRoot(), { projects: ['mobile'] }).map((t) => t.id)).toEqual([entry.id]); // knowledge-only names it
    expect(listWorkspaceQa(workspaceRoot()).length).toBe(1);
    expect(listWorkspaceQa(workspaceRoot(), { features: ['feature:mobile::chats'] })).toEqual([]);
  });

  it('staleness is per project; a project not on this computer is reported not checked, never fresh', () => {
    const s = scope();
    const entry = appendWorkspaceQaEntry(s.workspace.path, s.projects, input, T1);
    const fresh = workspaceQaStaleness(s.projects, [entry]).get(entry.id);
    expect(fresh).toEqual({ stale: false, changedFiles: [], missingFiles: [], notChecked: [] });

    writeFileSync(join(repos.backend, 'src', 'engine.ts'), 'export const engine = 2\n');
    expect(workspaceQaStaleness(s.projects, [entry]).get(entry.id)).toMatchObject({ stale: true, changedFiles: ['backend/src/engine.ts'] });

    rmSync(repos.backend, { recursive: true, force: true });
    const later = scope();
    expect(later.projects.backend.localPath).toBeNull();
    expect(workspaceQaStaleness(later.projects, [entry]).get(entry.id)).toEqual({
      stale: false,
      changedFiles: [],
      missingFiles: [],
      notChecked: ['backend'],
    });
  });

  it.each([
    ['unqualified-tag', { ...input, tags: ['feature:chats'] }],
    ['unknown-project', { ...input, tags: ['project:nowhere'] }],
    ['unknown-tag', { ...input, tags: ['feature:backend::chats'] }],
    ['bad-source', { ...input, sources: [{ label: 'x', project: 'backend', file: 'src/missing.ts' }] }],
    ['bad-source', { ...input, sources: [{ label: 'x', file: 'src/engine.ts' }] }],
    ['remote-read', { ...input, projectsRead: ['backend', 'frontend', 'mobile'], knowledgeOnly: [] }],
    ['unknown-field', { ...input, workspace: 'team' }],
  ])('refuses %s and writes nothing', (reason, bad) => {
    rmSync(repos.mobile, { recursive: true, force: true }); // mobile not on this computer
    const s = scope();
    let caught: unknown;
    try {
      appendWorkspaceQaEntry(s.workspace.path, s.projects, bad as typeof input, T1);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(QaRefusal);
    expect((caught as InstanceType<typeof QaRefusal>).reason).toBe(reason);
    expect(existsSync(workspaceQaPath(workspaceRoot()))).toBe(false);
    expect(readQaEntries(repos.backend)).toEqual([]);
    expect(readQaEntries(repos.frontend)).toEqual([]);
  });

  it('a file in a project not on this computer is refused; its feature is kept', () => {
    rmSync(repos.mobile, { recursive: true, force: true });
    const s = scope();
    expect(() =>
      appendWorkspaceQaEntry(s.workspace.path, s.projects, { ...input, sources: [{ label: 'Login', project: 'mobile', file: 'src/login.tsx' }] }, T1),
    ).toThrow(expect.objectContaining({ reason: 'remote-file' }));
    expect(existsSync(workspaceQaPath(workspaceRoot()))).toBe(false);
    const ok = appendWorkspaceQaEntry(
      s.workspace.path,
      s.projects,
      { ...input, sources: [{ label: 'Login', featureId: 'feature:mobile::login' }], projectsRead: [], knowledgeOnly: ['mobile'] },
      T1,
    );
    expect(ok.sources[0]).toEqual({ label: 'Login', featureId: 'feature:mobile::login', project: 'mobile' });
  });

  it('a cited project not on this computer gets its pointer in its shared folder, where its own checkout will find it', () => {
    rmSync(repos.mobile, { recursive: true, force: true });
    const s = scope();
    expect(s.projects.mobile.localPath).toBeNull();
    const sharedLog = join(projectFolder('mobile'), 'brain', '.structure', 'qa.jsonl');
    expect(linesOf(sharedLog)).toBe(0);
    const entry = appendWorkspaceQaEntry(
      s.workspace.path,
      s.projects,
      { ...input, sources: [...input.sources, { label: 'Login', featureId: 'feature:mobile::login' }] },
      T1,
    );
    expect(entry.cited.sort()).toEqual(['backend', 'frontend', 'mobile']);
    expect(linesOf(projectLog('backend'))).toBe(1);
    expect(linesOf(sharedLog)).toBe(1);
    const pointer = JSON.parse(readFileSync(sharedLog, 'utf-8').trim()) as Record<string, unknown>;
    expect(pointer).toMatchObject({ kind: 'workspace-pointer', id: entry.id, sources: [{ label: 'Login', featureId: 'feature:mobile::login', project: 'mobile' }] });
    expect(workspaceQaPointedProjects(entry, s.projects).sort()).toEqual(['backend', 'frontend', 'mobile']);

    // A refusal still writes nothing — not even into the shared folder.
    expect(() =>
      appendWorkspaceQaEntry(s.workspace.path, s.projects, { ...input, tags: ['feature:chats'], sources: [{ label: 'Login', featureId: 'feature:mobile::login' }] }, T1),
    ).toThrow(expect.objectContaining({ reason: 'unqualified-tag' }));
    expect(linesOf(sharedLog)).toBe(1);
    expect(readWorkspaceQaEntries(workspaceRoot())).toHaveLength(1);
  });

  it('the Workspace root file is a personal member of the closed root — questions never sync', () => {
    // Named by its own row — not merely caught by the generic `*.jsonl` rule.
    // Personal since 2026-11-16: the knowledge an answer produced is shared,
    // the person's questions are not.
    const detailed = classifyKnowledgePathDetailed('qa.jsonl', { root: 'workspace' });
    expect(detailed.class).toBe('personal');
    expect(detailed.row?.pattern).toBe('/qa.jsonl');
  });

  it('the verb records, lists and checks staleness through --workspace, and refuses with payload then line', () => {
    const run = (args: string[], stdin?: string) =>
      spawnSync(process.execPath, [tsxRunnerPath(PACKAGE_ROOT), join(PACKAGE_ROOT, 'src', 'cli', 'index.ts'), 'blueprint', 'qa', ...args], {
        encoding: 'utf-8',
        cwd: repos.frontend,
        timeout: 120_000,
        input: stdin,
        env: { ...process.env, PLANFLOW_NO_BACKGROUND_WORK: '1' },
      });
    const recorded = run(['record', '--workspace', '--input', '-', '--json'], JSON.stringify(input));
    expect(recorded.status).toBe(0);
    const out = lastJson(recorded.stdout);
    expect(out).toMatchObject({ action: 'qa-record', scope: 'workspace', workspace: { slug: 'team' } });
    expect((out?.pointers as string[]).sort()).toEqual(['backend', 'frontend']);

    const listed = lastJson(run(['list', '--workspace', '--tag', 'project:backend', '--json']).stdout);
    expect((listed?.threads as unknown[]).length).toBe(1);
    const stale = lastJson(run(['stale', '--workspace', '--json']).stdout);
    expect(stale).toMatchObject({ action: 'qa-stale', checked: 1, staleCount: 0 });

    const refused = run(['record', '--workspace', '--input', '-', '--json'], JSON.stringify({ ...input, tags: ['feature:chats'] }));
    expect(refused.status).toBe(1);
    const transcript = `${refused.stdout}\n${refused.stderr}`;
    expect(lastJson(refused.stdout)).toMatchObject({ action: 'qa-record', scope: 'workspace', refused: 'unqualified-tag' });
    expect(transcript).toContain('qa refused: unqualified-tag — ');
    expect(readWorkspaceQaEntries(workspaceRoot())).toHaveLength(1);
  });
});
