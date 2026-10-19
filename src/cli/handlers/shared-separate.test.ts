/**
 * Tests for the `separate` share mode (team-knowledge-sharing Phase 1): flow/ is a
 * nested brain repo, the parent ignores it + the materialized .claude/rules, and
 * the brain-repo pointer rides in the committed .gitignore header.
 */

import { jest } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  lstatSync,
  statSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

// shared.ts imports the interactive prompts module; mock it so importing the
// module never risks a prompt (matches shared.test.ts).
jest.unstable_mockModule('../utils/prompts.js', () => ({
  // Resolves like a real answer would, so a run that wrongly reaches the
  // business-context step writes a file the assertions below would see.
  askBusinessContext: jest.fn<() => Promise<{ whatItDoes: string; targetAudience: string; problemItSolves: string }>>()
    .mockResolvedValue({ whatItDoes: 'x', targetAudience: 'y', problemItSolves: 'z' }),
  askLegacyFilesAction: jest.fn(),
  selectPlatforms: jest.fn(),
}));

const {
  buildGitignoreBlock,
  sharedGitignoreEntries,
  readShareModeFromGitignore,
  readShareMode,
  readBrainPointer,
  buildBrainRepoGitignore,
  buildBrainRepoGitattributes,
  buildGitattributesBlock,
  knowledgeRepoLocalEntries,
  keepsOwnKnowledgeRepo,
  initShared,
  materializeRules,
} = await import('./shared.js');

const POINTER = { url: 'git@github.com:team/brain.git', branch: 'main' };

describe('separate share mode — gitignore block', () => {
  it('carries the mode header and the brain-repo pointer', () => {
    const block = buildGitignoreBlock(['claude'], 'separate', POINTER);
    expect(block).toContain('# Knowledge sharing: separate');
    expect(block).toContain('# Brain repo: git@github.com:team/brain.git main');
    expect(block).toContain('/flow');
    expect(block).toContain('/.claude/rules');
  });

  it('suppresses the platform .claude/rules un-ignores (rules are materialized + ignored)', () => {
    const block = buildGitignoreBlock(['claude'], 'separate', POINTER);
    expect(block).not.toContain('!.claude/rules');
  });

  it('omits the Brain repo line when no pointer is given, but stays separate', () => {
    const block = buildGitignoreBlock(['claude'], 'separate');
    expect(block).toContain('# Knowledge sharing: separate');
    expect(block).not.toContain('# Brain repo:');
  });

  it('is deterministic for the same inputs', () => {
    expect(buildGitignoreBlock(['claude'], 'separate', POINTER)).toBe(
      buildGitignoreBlock(['claude'], 'separate', POINTER)
    );
  });

  it('sharedGitignoreEntries(separate) ignores flow and .claude/rules', () => {
    expect(sharedGitignoreEntries('separate')).toEqual(
      expect.arrayContaining(['/flow', '/.claude/rules'])
    );
  });
});

describe('separate share mode — reading it back from the committed block', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-sep-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readShareModeFromGitignore returns separate', () => {
    writeFileSync(join(dir, '.gitignore'), buildGitignoreBlock(['claude'], 'separate', POINTER) + '\n');
    expect(readShareModeFromGitignore(dir)).toBe('separate');
  });

  it('readShareMode resolves separate from the committed block (flow/.flowconfig is gitignored in separate mode)', () => {
    writeFileSync(join(dir, '.gitignore'), buildGitignoreBlock(['claude'], 'separate', POINTER) + '\n');
    expect(readShareMode(dir)).toBe('separate');
  });

  it('readBrainPointer round-trips url + branch', () => {
    writeFileSync(join(dir, '.gitignore'), buildGitignoreBlock(['claude'], 'separate', POINTER) + '\n');
    expect(readBrainPointer(dir)).toEqual({ url: 'git@github.com:team/brain.git', branch: 'main' });
  });

  it('readBrainPointer round-trips url-only (no branch)', () => {
    writeFileSync(
      join(dir, '.gitignore'),
      buildGitignoreBlock(['claude'], 'separate', { url: 'https://example.com/y.git' }) + '\n'
    );
    expect(readBrainPointer(dir)).toEqual({ url: 'https://example.com/y.git' });
  });

  it('readBrainPointer is null when there is no brain line', () => {
    writeFileSync(join(dir, '.gitignore'), buildGitignoreBlock(['claude'], 'local') + '\n');
    expect(readBrainPointer(dir)).toBeNull();
  });
});

describe('brain-repo .gitignore (Phase 2)', () => {
  it('ignores derived/personal (flow/ prefix stripped) and never rules/', () => {
    const gi = buildBrainRepoGitignore();
    // Derived, relative to the brain repo root (which IS flow/):
    expect(gi).toContain('brain/.raw/');
    expect(gi).toContain('brain/.structure/graph.json');
    // Personal, prefix stripped:
    expect(gi).toContain('.flowconfig');
    expect(gi).toContain('.evidence/');
    // No 'flow/' prefixes leaked (paths are relative to the brain repo root):
    expect(gi).not.toMatch(/^flow\//m);
    // Precious knowledge is NOT ignored:
    expect(gi).not.toMatch(/^rules\//m);
    expect(gi).not.toContain('brain/features/');
  });
});

describe('materializeRules (Phase 2 — resolves R-2/TC-4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-rules-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies brain flow/rules/ into <project>/.claude/rules/ (SDK project scope)', () => {
    const flowDir = join(dir, 'flow');
    mkdirSync(join(flowDir, 'rules', 'core'), { recursive: true });
    writeFileSync(join(flowDir, 'rules', 'core', 'allowed-patterns.md'), '# allowed\n');

    const written = materializeRules(flowDir, dir);
    expect(existsSync(join(dir, '.claude', 'rules', 'core', 'allowed-patterns.md'))).toBe(true);
    expect(readFileSync(join(dir, '.claude', 'rules', 'core', 'allowed-patterns.md'), 'utf8')).toContain('# allowed');
    expect(written).toEqual(expect.arrayContaining([join('.claude', 'rules', 'core', 'allowed-patterns.md')]));
  });

  it('is a no-op when the brain has no rules yet', () => {
    const flowDir = join(dir, 'flow');
    mkdirSync(flowDir, { recursive: true });
    expect(materializeRules(flowDir, dir)).toEqual([]);
    expect(existsSync(join(dir, '.claude', 'rules'))).toBe(false);
  });

  it('MIRRORS — a rule deleted in the brain disappears from .claude/rules (F2)', () => {
    const flowDir = join(dir, 'flow');
    mkdirSync(join(flowDir, 'rules', 'core'), { recursive: true });
    writeFileSync(join(flowDir, 'rules', 'core', 'allowed-patterns.md'), '# allowed\n');
    writeFileSync(join(flowDir, 'rules', 'core', 'forbidden-patterns.md'), '# forbidden\n');
    materializeRules(flowDir, dir);
    expect(existsSync(join(dir, '.claude', 'rules', 'core', 'forbidden-patterns.md'))).toBe(true);

    // The team retires the forbidden rule in the brain, then we re-materialize.
    rmSync(join(flowDir, 'rules', 'core', 'forbidden-patterns.md'));
    const written = materializeRules(flowDir, dir);

    expect(existsSync(join(dir, '.claude', 'rules', 'core', 'forbidden-patterns.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude', 'rules', 'core', 'allowed-patterns.md'))).toBe(true);
    // written lists ONLY brain-sourced files (F5).
    expect(written).toEqual([join('.claude', 'rules', 'core', 'allowed-patterns.md')]);
  });
});

describe('knowledge repo .gitignore — the decided local/synced split', () => {
  const ignoreLines = (): string[] =>
    buildBrainRepoGitignore().split('\n').filter((line) => line !== '' && !line.startsWith('#'));

  it('is built from knowledgeRepoLocalEntries, the one exported list', () => {
    expect(ignoreLines()).toEqual(knowledgeRepoLocalEntries());
  });

  it('ignores the machine-local files the split names', () => {
    const lines = ignoreLines();
    for (const entry of [
      '/STATE.md',
      'brain/.structure/story.json',
      'brain/.structure/blueprint.html',
      'brain/.structure/graph.prev.json',
      'brain/.structure/graph.json',
      'brain/.structure/symbols.jsonl',
      'brain/.structure/file-*.json',
      '.lavish/',
      'brain/.derived/',
      'brain/.raw/',
      '.evidence/',
      '.rounds.jsonl',
      '.wave-context.jsonl',
      '.scratchpad.md',
      '/.heartbeat-*',
      '/.heartbeat.*',
      '.flowconfig',
    ]) {
      expect(lines).toContain(entry);
    }
  });

  it('never ignores the synced knowledge: append-only stores, journals, rules', () => {
    const gi = buildBrainRepoGitignore();
    for (const kept of [
      'annotations.jsonl',
      'investigations.jsonl',
      'proposals.jsonl',
      'status-events.jsonl',
      'tasklist.md',
      'memory.md',
      'ledger.md',
      'log.md',
      'heartbeat.md',
    ]) {
      expect(gi).not.toContain(kept);
    }
    expect(gi).not.toMatch(/^\/?rules\/?$/m);
    // The heartbeat globs are dotfile-only: `heartbeat.md` has no leading dot.
    expect(ignoreLines().some((line) => line.includes('heartbeat') && !line.includes('.heartbeat'))).toBe(false);
  });

  it('is deterministic', () => {
    expect(buildBrainRepoGitignore()).toBe(buildBrainRepoGitignore());
  });
});

describe('knowledge repo .gitattributes', () => {
  it('union-merges every JSONL at the knowledge repo root', () => {
    const attrs = buildBrainRepoGitattributes();
    expect(attrs.split('\n')).toContain('*.jsonl merge=union');
    expect(attrs).toMatch(/^# /m);
    expect(attrs).toBe(buildBrainRepoGitattributes());
  });

  it('is distinct from the code repo block, which scopes the rule to flow/', () => {
    expect(buildBrainRepoGitattributes()).not.toContain('flow/');
    expect(buildGitattributesBlock()).toContain('flow/**/*.jsonl merge=union');
  });
});

/** Every path under `root` (relative), with file contents — `.git` included. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (lstatSync(full).isDirectory()) {
        out[`${rel}/`] = '<dir>';
        walk(full);
      } else {
        out[rel] = readFileSync(full, 'utf-8');
      }
    }
  };
  walk(root);
  return out;
}

describe('initShared — a project that keeps its own knowledge repo', () => {
  let project: string;
  let vault: string;
  let vaultProjectDir: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'pf-own-repo-'));
    vault = mkdtempSync(join(tmpdir(), 'pf-own-repo-vault-'));
    process.env.PLAN_FLOW_VAULT_DIR = vault;
    vaultProjectDir = join(vault, 'projects', project.split('/').pop() ?? '');
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  const commitSeparateBlock = (pointer: { url: string; branch?: string } | null = POINTER): void => {
    writeFileSync(join(project, '.gitignore'), buildGitignoreBlock(['claude'], 'separate', pointer ?? undefined) + '\n');
  };

  const seedKnowledgeClone = (): string => {
    const flow = join(project, 'flow');
    mkdirSync(join(flow, '.git', 'refs'), { recursive: true });
    writeFileSync(join(flow, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(flow, 'brain', 'features'), { recursive: true });
    writeFileSync(join(flow, 'brain', 'features', 'chats.md'), '# Chats\n');
    writeFileSync(join(flow, 'ledger.md'), '# Ledger\n');
    return flow;
  };

  it('keepsOwnKnowledgeRepo needs BOTH the committed separate mode and a pointer', () => {
    expect(keepsOwnKnowledgeRepo(project)).toBe(false);
    commitSeparateBlock(null);
    expect(keepsOwnKnowledgeRepo(project)).toBe(false);
    commitSeparateBlock();
    expect(keepsOwnKnowledgeRepo(project)).toBe(true);
    writeFileSync(join(project, '.gitignore'), buildGitignoreBlock(['claude'], 'shared') + '\n');
    expect(keepsOwnKnowledgeRepo(project)).toBe(false);
  });

  it('leaves a real flow/ with .git exactly as it is, and nothing appears in the vault', async () => {
    commitSeparateBlock();
    const flow = seedKnowledgeClone();
    const inodeBefore = statSync(flow).ino;
    const before = snapshot(flow);

    await initShared(project, { force: false, nonInteractive: true }, ['claude']);

    // Positive first (allowed-pattern #28): init ran to the end — the vault
    // registered the project and the code repo's block was regenerated.
    expect(existsSync(join(vaultProjectDir, `${project.split('/').pop()}.md`))).toBe(true);
    expect(readFileSync(join(project, '.gitignore'), 'utf-8')).toContain('# Knowledge sharing: separate');

    expect(lstatSync(flow).isSymbolicLink()).toBe(false);
    expect(statSync(flow).ino).toBe(inodeBefore);
    expect(existsSync(join(flow, '.git', 'HEAD'))).toBe(true);
    expect(snapshot(flow)).toEqual(before);
    // No move into the vault, no back-link from it.
    expect(existsSync(join(vaultProjectDir, 'flow'))).toBe(false);
    expect(() => lstatSync(join(vaultProjectDir, 'flow'))).toThrow();
  });

  it('keeps the committed pointer across re-provisions, so a second run still leaves flow/ alone', async () => {
    commitSeparateBlock();
    const flow = seedKnowledgeClone();
    const before = snapshot(flow);

    await initShared(project, { force: false, nonInteractive: true }, ['claude']);
    expect(readBrainPointer(project)).toEqual(POINTER);

    await initShared(project, { force: false, nonInteractive: true }, ['claude']);
    expect(readBrainPointer(project)).toEqual(POINTER);
    expect(snapshot(flow)).toEqual(before);
    expect(() => lstatSync(join(vaultProjectDir, 'flow'))).toThrow();
  });

  it('does not create flow/ or a vault link when flow/ is absent (fresh clone)', async () => {
    commitSeparateBlock();

    await initShared(project, { force: false, nonInteractive: true }, ['claude']);

    // Positive first: the provision ran (vault registration happened).
    expect(existsSync(join(vaultProjectDir, `${project.split('/').pop()}.md`))).toBe(true);
    expect(() => lstatSync(join(project, 'flow'))).toThrow();
    expect(() => lstatSync(join(vaultProjectDir, 'flow'))).toThrow();
    expect(readBrainPointer(project)).toEqual(POINTER);
  });

  it('a vault that already holds an old copy keeps it, and is not re-pointed', async () => {
    commitSeparateBlock();
    const flow = seedKnowledgeClone();
    mkdirSync(join(vaultProjectDir, 'flow'), { recursive: true });
    writeFileSync(join(vaultProjectDir, 'flow', 'backup.md'), 'old\n');

    await initShared(project, { force: false, nonInteractive: true }, ['claude']);

    expect(lstatSync(join(vaultProjectDir, 'flow')).isDirectory()).toBe(true);
    expect(readFileSync(join(vaultProjectDir, 'flow', 'backup.md'), 'utf-8')).toBe('old\n');
    expect(existsSync(join(flow, 'backup.md'))).toBe(false);
    expect(lstatSync(flow).isSymbolicLink()).toBe(false);
  });
});

describe('initShared — projects that never enabled a knowledge repo are unchanged', () => {
  let project: string;
  let vault: string;
  let vaultFlow: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'pf-plain-'));
    vault = mkdtempSync(join(tmpdir(), 'pf-plain-vault-'));
    process.env.PLAN_FLOW_VAULT_DIR = vault;
    vaultFlow = join(vault, 'projects', project.split('/').pop() ?? '', 'flow');
  });
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(vault, { recursive: true, force: true });
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('a fresh local project still gets flow/ as a link into the vault', async () => {
    await initShared(project, { force: false, nonInteractive: true }, ['claude']);

    const flow = join(project, 'flow');
    expect(lstatSync(flow).isSymbolicLink()).toBe(true);
    expect(resolve(project, readlinkSync(flow))).toBe(resolve(vaultFlow));
    expect(existsSync(join(vaultFlow, 'tasklist.md'))).toBe(true);
  });

  it('a real flow/ in local mode is still moved into the vault', async () => {
    const flow = join(project, 'flow');
    mkdirSync(join(flow, 'plans'), { recursive: true });
    writeFileSync(join(flow, 'plans', 'plan_x_v1.md'), '# x\n');

    await initShared(project, { force: false, nonInteractive: true }, ['claude']);

    expect(lstatSync(flow).isSymbolicLink()).toBe(true);
    // (The legacy scan tags it with the project link, as it always has.)
    expect(readFileSync(join(vaultFlow, 'plans', 'plan_x_v1.md'), 'utf-8')).toMatch(/^# x\n/);
  });

  // Sync turned off but the history kept here (`knowledge disable --to keep`):
  // no pointer, local mode — and still a repository that must not be moved
  // into a folder the vault's own repository tracks.
  it('a real flow/ holding its own .git is left alone even without a pointer', async () => {
    const flow = join(project, 'flow');
    mkdirSync(join(flow, '.git'), { recursive: true });
    writeFileSync(join(flow, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(flow, 'plans'), { recursive: true });
    writeFileSync(join(flow, 'plans', 'plan_x_v1.md'), '# x\n');

    await initShared(project, { force: false, nonInteractive: true }, ['claude']);

    // State the positive first: provisioning ran (the code repo's block exists)…
    expect(readFileSync(join(project, '.gitignore'), 'utf-8')).toContain('# >>> plan-flow');
    // …and flow/ is still the same real folder with its repository inside.
    expect(lstatSync(flow).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(flow, '.git', 'HEAD'), 'utf-8')).toBe('ref: refs/heads/main\n');
    expect(readFileSync(join(flow, 'plans', 'plan_x_v1.md'), 'utf-8')).toBe('# x\n');
    expect(existsSync(join(vaultFlow, 'plans', 'plan_x_v1.md'))).toBe(false);
  });
});
