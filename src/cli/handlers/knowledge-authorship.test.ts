/**
 * Authorship of Workspace knowledge (FR-19): the git identity's NAME, never
 * the email, stamped only inside a Workspace project.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { authorshipFrontmatter, cleanAuthorName, knowledgeAuthor, workspaceAuthor } = await import('./knowledge-authorship.js');
const { recordVerdict, writeFileTiers } = await import('../blueprint/file-tiers.js');
const { promoteDoc } = await import('../blueprint/verify-doc.js');

describe('cleanAuthorName', () => {
  it('keeps one clean line and refuses nothing-at-all', () => {
    expect(cleanAuthorName('  Ada   Lovelace \n')).toBe('Ada Lovelace');
    expect(cleanAuthorName('---\nevil: yes')).toBe('evil: yes');
    expect(cleanAuthorName('')).toBeNull();
    expect(cleanAuthorName(null)).toBeNull();
    expect(cleanAuthorName('x'.repeat(500))?.length).toBe(120);
  });
});

describe('knowledgeAuthor / workspaceAuthor', () => {
  let root: string;
  let project: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pf-authorship-')));
    const workspace = join(root, 'workspaces', 'team');
    project = join(workspace, 'projects', 'backend');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(workspace, 'workspace.json'), JSON.stringify({ name: 'Team', slug: 'team', projects: [{ id: 'x', name: 'backend', slug: 'backend', remotes: [] }] }));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('asks git in the Workspace repo, and stamps nothing outside a Workspace', () => {
    const asked: string[] = [];
    const reader = (cwd: string): string => {
      asked.push(cwd);
      return 'Ada Lovelace\n';
    };
    expect(knowledgeAuthor(root, reader)).toBe('Ada Lovelace');
    expect(workspaceAuthor(project, reader)).toBe('Ada Lovelace');
    expect(asked[1]).toBe(join(root, 'workspaces', 'team'));
    expect(authorshipFrontmatter(project, 'decided_by', reader)).toEqual(['---', 'decided_by: Ada Lovelace', '---', '']);

    const plain = join(root, 'plain', 'flow');
    mkdirSync(plain, { recursive: true });
    expect(workspaceAuthor(plain, reader)).toBeNull();
    expect(authorshipFrontmatter(plain, 'author', reader)).toEqual([]);
    // No identity configured → no stamp, never an invented one.
    expect(authorshipFrontmatter(project, 'author', () => null)).toEqual([]);
  });

  it('a promoted decision in a Workspace project records who decided it — by name', () => {
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
    writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = Test Person\n\temail = person@example.com\n');
    process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      const repo = join(root, 'repo');
      mkdirSync(join(repo, 'docs'), { recursive: true });
      mkdirSync(join(repo, 'src'), { recursive: true });
      symlinkSync(project, join(repo, 'flow'));
      const flowDir = join(repo, 'flow');
      mkdirSync(join(flowDir, 'brain', '.structure'), { recursive: true });
      writeFileSync(join(repo, 'docs', 'api.md'), '# API\nRate limit is 100/min.\n');
      writeFileSync(join(repo, 'src', 'limit.ts'), 'export const limit = 100');
      writeFileTiers(flowDir, {
        derivedAt: '2026-10-06T00:00:00Z',
        entries: [
          { path: 'docs/api.md', tier: 'claim' },
          { path: 'src/limit.ts', tier: 'code' },
        ],
      });
      expect(
        recordVerdict(repo, flowDir, {
          path: 'docs/api.md',
          verdict: 'corroborated',
          against: ['src/limit.ts'],
          provenance: 'user',
          claims: [{ claim: 'Rate limit is 100/min', outcome: 'corroborated', witnesses: ['src/limit.ts'] }],
        }),
      ).toEqual({ ok: true });
      const promoted = promoteDoc(repo, 'docs/api.md');
      const text = readFileSync(promoted.brainFile as string, 'utf-8');
      expect(text.startsWith('---\ndecided_by: Test Person\n---\n\n# Verified claims')).toBe(true);
      expect(text).not.toContain('person@example.com');
    } finally {
      if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved.global;
      if (saved.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = saved.nosystem;
    }
  });
});
