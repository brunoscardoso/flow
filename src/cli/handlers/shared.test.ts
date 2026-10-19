/**
 * Tests for shared handler
 */

import { jest } from '@jest/globals';
import {
  mkdirSync,
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Mock askBusinessContext to avoid interactive prompts during tests
jest.unstable_mockModule('../utils/prompts.js', () => ({
  askBusinessContext: jest.fn<() => Promise<{ whatItDoes: string; targetAudience: string; problemItSolves: string }>>().mockResolvedValue({
    whatItDoes: 'Test project description',
    targetAudience: 'Developers',
    problemItSolves: 'Testing automation',
  }),
  askLegacyFilesAction: jest.fn(),
  selectPlatforms: jest.fn(),
}));

const {
  initShared,
  generateTechFoundation,
  generateBusinessContext,
  generateTasklist,
  generateLog,
  generateMemory,
  generateHeartbeat,
  mitigateTailwindSources,
  buildGitignoreBlock,
  sharedGitignoreEntries,
  readShareMode,
  persistShareMode,
  resolveShareMode,
  applyShareMode,
  updateGitattributes,
  buildGitattributesBlock,
  updateWorkingSetIgnore,
  DEFAULT_SHARE_MODE,
} = await import('./shared.js');
const { askBusinessContext } = await import('../utils/prompts.js') as { askBusinessContext: jest.Mock };
const { repoFromRemote, seedLoopDirectives } = await import('../loop/directive-templates.js');
// The directives init seeds are proved by the thing that would REFUSE them.
const { parseLoopDirective, readLoopDirective } = await import('../loop/directive-parser.js');

function createTempDir(): string {
  const dir = join(tmpdir(), `plan-flow-shared-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const EXPECTED_SUBDIRS = [
  'archive',
  'brain',
  'brain/features',
  'brain/errors',
  'brain/learning',
  'brainstorms',
  'contracts',
  'discovery',
  'plans',
  'references',
  'resources',
  'reviewed-code',
  'reviewed-pr',
];

describe('initShared', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-init-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('should create full flow/ directory structure with .gitkeep files', async () => {
    const result = await initShared(tempDir, { force: false }, ['claude']);

    for (const subdir of EXPECTED_SUBDIRS) {
      const dir = join(tempDir, 'flow', subdir);
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(join(dir, '.gitkeep'))).toBe(true);
    }

    expect(result.created.length).toBeGreaterThan(0);

    // Should also create .gitignore
    expect(existsSync(join(tempDir, '.gitignore'))).toBe(true);
  });

  it('should skip existing directories on second install', async () => {
    // First install
    await initShared(tempDir, { force: false }, ['claude']);

    // Second install
    const result = await initShared(tempDir, { force: false }, ['claude']);

    // Skipped items include: flow subdirs + .gitignore + vault symlink
    expect(result.skipped.length).toBeGreaterThanOrEqual(EXPECTED_SUBDIRS.length + 1);
    expect(result.created).toHaveLength(0);
  });
});

describe('gitignore management', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-gi-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('should create .gitignore with plan-flow entries when none exists', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const lines = gitignore.split('\n');
    expect(gitignore).toContain('# >>> plan-flow');
    expect(gitignore).toContain('# <<< plan-flow');
    expect(lines).toContain('/flow');
    expect(gitignore).toContain('.claude/');
    expect(gitignore).toContain('CLAUDE.md');
  });

  it('reconciles a STALE plan-flow block missing a newer entry without --force (#581)', async () => {
    // A project provisioned before `graphify-out` was added to the entry list:
    // an old marker block that lacks it. A plain (force:false) re-provision must
    // add the missing entry, not skip because the marker is present.
    const stalePath = join(tempDir, '.gitignore');
    writeFileSync(stalePath, '# >>> plan-flow\nflow/\n.claude/\n# <<< plan-flow\n', 'utf-8');
    expect(readFileSync(stalePath, 'utf-8')).not.toContain('graphify-out');

    await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(stalePath, 'utf-8');
    expect(gitignore).toContain('graphify-out');
    // The marker block stays single (reconciled in place, not duplicated).
    expect(gitignore.match(/# >>> plan-flow/g)?.length).toBe(1);
  });

  it('should include the claude platform entries', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.claude/');
    expect(gitignore).toContain('CLAUDE.md');
    // No other-IDE entries (multi-IDE support removed 2026-07-22).
    expect(gitignore).not.toContain('.cursor/');
    expect(gitignore).not.toContain('skills/plan-flow/');
    expect(gitignore).not.toContain('.agents/');
    expect(gitignore).not.toContain('AGENTS.md');
  });

  it('should always include shared entries', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const lines = gitignore.split('\n');
    expect(lines).toContain('/flow');
    expect(lines).toContain('.plan-flow.yml');
    expect(lines).toContain('.plan.flow.env');
  });

  it('should keep the recursive /flow entry that covers review runtime artifacts by inheritance', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const lines = gitignore.split('\n').map((line) => line.trim());

    // The exact standalone `/flow` entry must exist — it recursively ignores
    // everything under flow/, including flow/.evidence/ and flow/.rounds.jsonl.
    // A substring check is not enough (e.g. `skills/plan-flow/` also contains "flow/").
    // Root-anchored and slash-less on purpose: `flow/` misses the top-level
    // SYMLINK (git sees a symlink as a file) and `flow` would swallow nested
    // source dirs — the exact pair of bugs the hand-tuned fix kept correcting.
    expect(lines).toContain('/flow');

    // No negation entry may re-include flow/ contents, which would break
    // the inheritance guarantee for runtime artifacts.
    expect(lines.some((line) => line.startsWith('!flow'))).toBe(false);
  });

  it('should write the graphify-out entry to the managed gitignore block', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const lines = gitignore.split('\n').map((line) => line.trim());

    // graphify-out lives at the repo root, so it is NOT covered by the
    // recursive `flow/` entry — it needs its own exact standalone line. No
    // trailing slash so it matches the local dir AND any transient symlink (#142).
    expect(lines).toContain('graphify-out');

    // The entry must live inside the managed plan-flow block.
    const startIndex = lines.findIndex((line) => line.startsWith('# >>> plan-flow'));
    const endIndex = lines.findIndex((line) => line.startsWith('# <<< plan-flow'));
    const entryIndex = lines.indexOf('graphify-out');
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(startIndex);
    expect(entryIndex).toBeGreaterThan(startIndex);
    expect(entryIndex).toBeLessThan(endIndex);
  });

  it('should append to existing .gitignore without overwriting', async () => {
    const existingContent = 'node_modules/\ndist/\n';
    writeFileSync(join(tempDir, '.gitignore'), existingContent, 'utf-8');

    await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('dist/');
    expect(gitignore).toContain('# >>> plan-flow');
    expect(gitignore).toContain('flow/');
  });

  it('should not duplicate entries on second install', async () => {
    await initShared(tempDir, { force: false }, ['claude']);
    const result = await initShared(tempDir, { force: false }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const markerCount = (gitignore.match(/# >>> plan-flow/g) || []).length;
    expect(markerCount).toBe(1);
    expect(result.skipped).toContain(join(tempDir, '.gitignore'));
  });

  it('should update entries with --force when markers exist', async () => {
    // First install
    await initShared(tempDir, { force: false }, ['claude']);

    // Second install using force — block reconciled in place, not duplicated
    await initShared(tempDir, { force: true }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const markerCount = (gitignore.match(/# >>> plan-flow/g) || []).length;
    expect(markerCount).toBe(1);
    expect(gitignore).toContain('.claude/');
  });
});

// ── Knowledge sharing drives the ignore block ────────────────────────────────
//
// `SHARED_GITIGNORE_ENTRIES` used to be a constant, and every "the provisioner
// clobbered my .gitignore" report was that constant being regenerated over a
// hand-tuned block with no way to know what the user wanted. The entries are a
// function of the share setting now, so regeneration is the fix rather than the
// bug — which only holds if regeneration is deterministic and never publishes
// by default. These tests pin exactly that.

/** Only the plan-flow marker block, extracted from a .gitignore. */
function extractBlock(gitignore: string): string {
  const match = gitignore.match(/# >>> plan-flow[\s\S]*?# <<< plan-flow/);
  return match ? match[0] : '';
}

/** Entry lines of a block (comments and markers dropped). */
function entryLines(block: string): string[] {
  return block
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#'));
}

describe('share mode — the ignore block is a function of the setting', () => {
  const DERIVED = [
    'flow/brain/.raw/',
    // Whole-directory: `.derived/` holds ONLY regenerable bytes (the generated
    // INDEX.md and anything added beside it), unlike `.structure/`, which has
    // to be named file by file because it mixes disposable output with
    // append-only stores nothing can rebuild.
    'flow/brain/.derived/',
    'flow/brain/.structure/graph.json',
    'flow/brain/.structure/graph.prev.json',
    'flow/brain/.structure/symbols.jsonl',
    'flow/brain/.structure/file-stamps.json',
    'flow/brain/.structure/file-tiers.json',
    'flow/brain/code/',
  ];

  // Per-run / per-machine artifacts under flow/ that are not knowledge. The
  // credential-carrying .flowconfig is here on purpose: a bot token must not
  // become trackable because someone flipped a sharing switch.
  const PERSONAL = [
    'flow/.flowconfig',
    'flow/.evidence/',
    'flow/.rounds.jsonl',
    'flow/.wave-context.jsonl',
    'flow/.heartbeat-events.jsonl',
    'flow/.heartbeat-state.json',
    'flow/.heartbeat-prompt.md',
    'flow/.heartbeat.log',
    'flow/.telegram-poll-state.json',
    'flow/.scratchpad.md',
    'flow/.lavish/',
  ];

  it('local ignores the knowledge layer wholesale, root-anchored', () => {
    const entries = sharedGitignoreEntries('local');

    expect(entries).toEqual([
      '/flow',
      '.plan-flow.yml',
      '.plan.flow.env',
      '.brain.sqlite',
      'graphify-out',
    ]);
    // No derived or per-run entries: `/flow` already covers every one of them.
    for (const covered of [...DERIVED, ...PERSONAL]) {
      expect(entries).not.toContain(covered);
    }
  });

  it('shared ignores ONLY the derived and per-run layer — the precious markdown is tracked', () => {
    const entries = sharedGitignoreEntries('shared');

    expect(entries).toEqual([
      ...DERIVED,
      ...PERSONAL,
      '.plan-flow.yml',
      '.plan.flow.env',
      '.brain.sqlite',
      'graphify-out',
    ]);
    // Nothing may ignore flow/ wholesale, in any of its spellings — that is
    // precisely what "shared" is not.
    expect(entries).not.toContain('/flow');
    expect(entries).not.toContain('flow/');
    expect(entries).not.toContain('flow');
    // The precious layer is conspicuously absent — including every path inside
    // flow/brain/features/, which the nested self-ignoring list owns instead.
    expect(entries.some((e) => e.startsWith('flow/brain/features'))).toBe(false);
    expect(entries.some((e) => e.startsWith('flow/plans'))).toBe(false);
  });

  it('.raw/ stays ignored in BOTH modes (auto-captured drafts are never shared)', () => {
    // local covers it by inheritance from /flow; shared names it explicitly.
    expect(sharedGitignoreEntries('local')).toContain('/flow');
    expect(sharedGitignoreEntries('shared')).toContain('flow/brain/.raw/');
  });

  it('graphify-out is ignored in both modes (derived, not knowledge)', () => {
    for (const mode of ['local', 'shared'] as const) {
      expect(sharedGitignoreEntries(mode)).toContain('graphify-out');
    }
  });

  // THE RETIRED INDEX, STILL IGNORED ON PURPOSE. Nothing writes `.brain.sqlite`
  // any more, but every project provisioned before the retirement still has one
  // at its root — tens of megabytes of derived database. Deleting it is the
  // user's call; letting it become trackable is not, so the ignore stays until
  // no such leftover survives.
  it('a leftover .brain.sqlite stays ignored in both modes (legacy tolerance)', () => {
    for (const mode of ['local', 'shared'] as const) {
      expect(sharedGitignoreEntries(mode)).toContain('.brain.sqlite');
    }
  });

  it('the block keeps its markers and carries its own explanation', () => {
    for (const mode of ['local', 'shared'] as const) {
      const block = buildGitignoreBlock(['claude'], mode);
      expect(block.startsWith('# >>> plan-flow')).toBe(true);
      expect(block.endsWith('# <<< plan-flow')).toBe(true);
      // The "why" travels INSIDE the generated block, so regeneration can never
      // lose it again.
      expect(block).toContain(`# Knowledge sharing: ${mode}`);
    }
  });

  it('platform entries are identical across modes — only the knowledge layer differs', () => {
    const local = entryLines(buildGitignoreBlock(['claude'], 'local'));
    const shared = entryLines(buildGitignoreBlock(['claude'], 'shared'));

    const platformEntries = ['.claude/*', '!.claude/rules/', 'CLAUDE.md'];
    for (const entry of platformEntries) {
      expect(local).toContain(entry);
      expect(shared).toContain(entry);
    }
  });
});

describe('share mode — regeneration is idempotent and provable', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-share-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('two generations from one setting are byte-identical', () => {
    for (const mode of ['local', 'shared'] as const) {
      expect(buildGitignoreBlock(['claude'], mode)).toBe(buildGitignoreBlock(['claude'], mode));
    }
  });

  it('the two modes generate DIFFERENT blocks (the setting actually does something)', () => {
    expect(buildGitignoreBlock(['claude'], 'local')).not.toBe(
      buildGitignoreBlock(['claude'], 'shared')
    );
  });

  it('a second provision rewrites nothing — the file is byte-identical and reported skipped', async () => {
    await initShared(tempDir, { force: false, share: 'shared' }, ['claude']);
    const first = readFileSync(join(tempDir, '.gitignore'), 'utf-8');

    const result = await initShared(tempDir, { force: false }, ['claude']);
    const second = readFileSync(join(tempDir, '.gitignore'), 'utf-8');

    expect(second).toBe(first);
    expect(result.skipped).toContain(join(tempDir, '.gitignore'));
  });

  it('switching modes rewrites the block cleanly — one block, no leftovers', async () => {
    await initShared(tempDir, { force: false, share: 'local' }, ['claude']);
    const localFile = readFileSync(join(tempDir, '.gitignore'), 'utf-8');

    await initShared(tempDir, { force: false, share: 'shared' }, ['claude']);
    const sharedFile = readFileSync(join(tempDir, '.gitignore'), 'utf-8');

    expect(sharedFile.match(/# >>> plan-flow/g)?.length).toBe(1);
    expect(extractBlock(sharedFile)).toBe(buildGitignoreBlock(['claude'], 'shared'));
    // No stale line from the previous mode survives anywhere in the file.
    expect(sharedFile.split('\n')).not.toContain('/flow');

    // ...and switching back restores the local block byte-for-byte.
    await initShared(tempDir, { force: false, share: 'local' }, ['claude']);
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8')).toBe(localFile);
  });

  it('user content outside the markers survives every switch untouched', async () => {
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules/\n*.local.env\n', 'utf-8');

    await initShared(tempDir, { force: false, share: 'local' }, ['claude']);
    await initShared(tempDir, { force: false, share: 'shared' }, ['claude']);
    await initShared(tempDir, { force: false, share: 'local' }, ['claude']);

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('*.local.env');
    expect(gitignore.match(/# >>> plan-flow/g)?.length).toBe(1);
  });
});

describe('share mode — persistence and the silent-publish guard', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-share2-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('the default is local', () => {
    expect(DEFAULT_SHARE_MODE).toBe('local');
    expect(resolveShareMode(tempDir)).toBe('local');
  });

  it('readShareMode distinguishes UNANSWERED (null) from answered local', () => {
    expect(readShareMode(tempDir)).toBeNull();

    mkdirSync(join(tempDir, 'flow'), { recursive: true });
    writeFileSync(join(tempDir, 'flow', '.flowconfig'), 'autopilot: false\nshare: local\n', 'utf-8');

    expect(readShareMode(tempDir)).toBe('local');
  });

  it('persistShareMode writes beside the existing keys without disturbing them', () => {
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
    writeFileSync(
      join(tempDir, 'flow', '.flowconfig'),
      'autopilot: true\ncommit: true\npush: false\npr: false\nengines.graphify: enabled\n',
      'utf-8'
    );

    expect(persistShareMode(tempDir, 'shared')).toBe(true);

    const config = readFileSync(join(tempDir, 'flow', '.flowconfig'), 'utf-8');
    for (const line of ['autopilot: true', 'commit: true', 'push: false', 'pr: false', 'engines.graphify: enabled']) {
      expect(config.split('\n')).toContain(line);
    }
    expect(config.split('\n')).toContain('share: shared');
    // Writing the same value again is a no-op.
    expect(persistShareMode(tempDir, 'shared')).toBe(false);
  });

  it('an unreadable/garbage setting reads as unanswered, never as shared', () => {
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
    writeFileSync(join(tempDir, 'flow', '.flowconfig'), 'share: yes-please\n', 'utf-8');

    expect(readShareMode(tempDir)).toBeNull();
    expect(resolveShareMode(tempDir)).toBe('local');
  });

  it('a provision with no answer and no setting stays LOCAL', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    expect(readShareMode(tempDir)).toBe('local');
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8').split('\n')).toContain('/flow');
  });

  it('a provision with no answer PRESERVES an existing shared setting', async () => {
    await initShared(tempDir, { force: false, share: 'shared' }, ['claude']);

    await initShared(tempDir, { force: true }, ['claude']);

    expect(readShareMode(tempDir)).toBe('shared');
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8').split('\n')).not.toContain('/flow');
  });
});

describe('applyShareMode — the two-way switch behind /flow share=', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-share3-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  /** Seed a project with knowledge files so the report has something to say. */
  async function seedProject(share: 'local' | 'shared'): Promise<void> {
    await initShared(tempDir, { force: false, share }, ['claude']);
    const brain = join(tempDir, 'flow', 'brain');
    mkdirSync(join(brain, 'features'), { recursive: true });
    mkdirSync(join(brain, '.structure'), { recursive: true });
    mkdirSync(join(brain, '.raw'), { recursive: true });
    writeFileSync(join(brain, 'features', 'checkout.md'), '# Checkout\n', 'utf-8');
    writeFileSync(join(brain, '.structure', 'graph.json'), '{}', 'utf-8');
    writeFileSync(join(brain, '.raw', 'thread-1.md'), 'draft\n', 'utf-8');
  }

  it('local → shared: persists, regenerates, and reports what became trackable', async () => {
    await seedProject('local');

    const report = applyShareMode(tempDir, 'shared');

    expect(report.previous).toBe('local');
    expect(report.mode).toBe('shared');
    expect(report.changed).toBe(true);
    expect(readShareMode(tempDir)).toBe('shared');
    expect(extractBlock(readFileSync(join(tempDir, '.gitignore'), 'utf-8'))).toBe(
      buildGitignoreBlock(['claude'], 'shared')
    );

    // The precious markdown is what became trackable...
    expect(report.nowTrackable).toContain('flow/brain/features/checkout.md');
    // ...and the derived layer did NOT.
    expect(report.nowTrackable).not.toContain('flow/brain/.structure/graph.json');
    expect(report.nowTrackable).not.toContain('flow/brain/.raw/thread-1.md');
    expect(report.nowIgnored).toEqual([]);
  });

  it('shared → local: re-ignores, reports it, and DELETES NOTHING', async () => {
    await seedProject('shared');
    const featureFile = join(tempDir, 'flow', 'brain', 'features', 'checkout.md');

    const report = applyShareMode(tempDir, 'local');

    expect(report.previous).toBe('shared');
    expect(report.mode).toBe('local');
    expect(report.nowIgnored).toContain('flow/brain/features/checkout.md');
    expect(report.nowTrackable).toEqual([]);

    // The switch is about tracking, never about content.
    expect(existsSync(featureFile)).toBe(true);
    expect(readFileSync(featureFile, 'utf-8')).toBe('# Checkout\n');
  });

  it('re-applying the same mode is a reported no-op, byte-identical', async () => {
    await seedProject('shared');
    const before = readFileSync(join(tempDir, '.gitignore'), 'utf-8');

    const report = applyShareMode(tempDir, 'shared');

    expect(report.changed).toBe(false);
    expect(report.nowTrackable).toEqual([]);
    expect(report.nowIgnored).toEqual([]);
    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8')).toBe(before);
  });

  it('a full round trip returns the .gitignore to its exact starting bytes', async () => {
    await seedProject('local');
    const start = readFileSync(join(tempDir, '.gitignore'), 'utf-8');

    applyShareMode(tempDir, 'shared');
    applyShareMode(tempDir, 'local');

    expect(readFileSync(join(tempDir, '.gitignore'), 'utf-8')).toBe(start);
  });
});

describe('vault registration', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('should create vault directory structure', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    expect(existsSync(vaultDir)).toBe(true);
    expect(existsSync(join(vaultDir, 'patterns'))).toBe(true);
    expect(existsSync(join(vaultDir, 'projects'))).toBe(true);
  });

  it('should create Obsidian config with path-based color groups', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const graphPath = join(vaultDir, '.obsidian', 'graph.json');
    expect(existsSync(graphPath)).toBe(true);

    const config = JSON.parse(readFileSync(graphPath, 'utf-8'));
    expect(config.colorGroups).toHaveLength(13);
    const queries = config.colorGroups.map((g: { query: string }) => g.query);
    expect(queries).toContain('path:patterns');
    expect(queries).toContain('path:features');
    expect(queries).toContain('path:errors');
    expect(queries).toContain('path:notes');
    expect(queries).toContain('path:discovery');
    expect(queries).toContain('path:plans');
    expect(queries).toContain('path:contracts');
    expect(queries).toContain('path:archive');
    expect(queries).toContain('path:reviewed-code');
    expect(queries).toContain('path:reviewed-pr');
    expect(queries).toContain('path:references');
    expect(queries).toContain('path:resources');
    expect(queries).toContain('path:learns');
    expect(config['collapse-color']).toBe(false);
    expect(config['collapse-filter']).toBe(true);
  });

  it('should create project flow/ in brain with single symlink from project', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const projectName = tempDir.split('/').pop() || '';
    const projectDir = join(vaultDir, 'projects', projectName);

    // Project dir should exist in brain
    expect(existsSync(projectDir)).toBe(true);

    // Brain should have flow/ as a real directory
    const brainFlowDir = join(projectDir, 'flow');
    expect(existsSync(brainFlowDir)).toBe(true);
    expect(lstatSync(brainFlowDir).isDirectory()).toBe(true);

    // Project flow/ should be a symlink pointing to brain
    const localFlowPath = join(tempDir, 'flow');
    expect(lstatSync(localFlowPath).isSymbolicLink()).toBe(true);
    const symlinkTarget = readlinkSync(localFlowPath, 'utf-8');
    expect(symlinkTarget).toBe(brainFlowDir);

    // Subdirectories should exist in brain flow/
    const expectedDirs = ['discovery', 'plans', 'brainstorms', 'archive', 'contracts'];
    for (const dir of expectedDirs) {
      expect(existsSync(join(brainFlowDir, dir))).toBe(true);
    }
  });

  it('should create project index file', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const projectName = tempDir.split('/').pop() || '';
    const projectDir = join(vaultDir, 'projects', projectName);

    const projectIndexPath = join(projectDir, `${projectName}.md`);
    expect(existsSync(projectIndexPath)).toBe(true);
    const content = readFileSync(projectIndexPath, 'utf-8');
    expect(content).toContain(`# [[${projectName}]]`);
  });

  it('should create vault index with project entry', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const indexPath = join(vaultDir, 'index.md');
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, 'utf-8');
    const projectName = tempDir.split('/').pop() || '';
    expect(content).toContain(`[[${projectName}]]`);
  });

  it('should skip migration on second install when flow/ is already a symlink', async () => {
    await initShared(tempDir, { force: false }, ['claude']);
    const result = await initShared(tempDir, { force: false }, ['claude']);

    // flow/ should still be a symlink (not recreated)
    const flowPath = join(tempDir, 'flow');
    expect(lstatSync(flowPath).isSymbolicLink()).toBe(true);
  });

  it('should clean old-format single symlinks during registration', async () => {
    // Create an old-format single symlink
    const projectsDir = join(vaultDir, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    const oldTarget = join(tempDir, 'flow');
    mkdirSync(oldTarget, { recursive: true });
    symlinkSync(oldTarget, join(projectsDir, 'old-project'));

    // Also create a broken symlink
    symlinkSync('/nonexistent/path', join(projectsDir, 'broken-project'));

    await initShared(tempDir, { force: false }, ['claude']);

    // Old-format symlinks should be cleaned
    expect(existsSync(join(projectsDir, 'old-project'))).toBe(false);
    expect(existsSync(join(projectsDir, 'broken-project'))).toBe(false);
  });
});

describe('legacy artifact scanning', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('should create brain entries from existing plans', async () => {
    // Create a legacy plan
    const plansDir = join(tempDir, 'flow', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, 'plan_user_auth_v1.md'),
      '# Plan: User Authentication\n\nSome content here.\n',
      'utf-8'
    );

    await initShared(tempDir, { force: false }, ['claude']);

    const brainFeature = join(tempDir, 'flow', 'brain', 'features', 'user-auth.md');
    expect(existsSync(brainFeature)).toBe(true);

    const content = readFileSync(brainFeature, 'utf-8');
    expect(content).toContain('status: active');
    expect(content).toContain('[[user-auth]]');
    expect(content).toContain('[[plan_user_auth_v1]]');
    // Should link back to project
    const projectName = tempDir.split('/').pop() || '';
    expect(content).toContain(`**Project**: [[${projectName}]]`);

    // The original plan file should also get the project tag injected
    const planContent = readFileSync(join(tempDir, 'flow', 'plans', 'plan_user_auth_v1.md'), 'utf-8');
    expect(planContent).toContain(`**Project**: [[${projectName}]]`);
  });

  it('should create brain entries from existing discovery docs', async () => {
    const discoveryDir = join(tempDir, 'flow', 'discovery');
    mkdirSync(discoveryDir, { recursive: true });
    writeFileSync(
      join(discoveryDir, 'discovery_dark_mode_v1.md'),
      '# Discovery: Dark Mode\n\nRequirements for dark mode.\n',
      'utf-8'
    );

    await initShared(tempDir, { force: false }, ['claude']);

    const brainFeature = join(tempDir, 'flow', 'brain', 'features', 'dark-mode.md');
    expect(existsSync(brainFeature)).toBe(true);

    const content = readFileSync(brainFeature, 'utf-8');
    expect(content).toContain('[[dark-mode]]');
    expect(content).toContain('[[discovery_dark_mode_v1]]');
  });

  it('should mark archived artifacts as archived', async () => {
    const archiveDir = join(tempDir, 'flow', 'archive');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, 'plan_old_feature_v1.md'),
      '# Plan: Old Feature\n\nCompleted.\n',
      'utf-8'
    );

    await initShared(tempDir, { force: false }, ['claude']);

    const brainFeature = join(tempDir, 'flow', 'brain', 'features', 'old-feature.md');
    expect(existsSync(brainFeature)).toBe(true);

    const content = readFileSync(brainFeature, 'utf-8');
    expect(content).toContain('**Status**: archived');
  });

  it('should update brain index with discovered features', async () => {
    const plansDir = join(tempDir, 'flow', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, 'plan_api_v1.md'),
      '# Plan: API Integration\n\nContent.\n',
      'utf-8'
    );

    await initShared(tempDir, { force: false }, ['claude']);

    const indexPath = join(tempDir, 'flow', 'brain', 'index.md');
    expect(existsSync(indexPath)).toBe(true);

    const content = readFileSync(indexPath, 'utf-8');
    expect(content).toContain('api');
  });

  it('should skip existing brain entries without --force', async () => {
    const plansDir = join(tempDir, 'flow', 'plans');
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(
      join(plansDir, 'plan_my_feature_v1.md'),
      '# Plan: My Feature\n',
      'utf-8'
    );

    // First init
    await initShared(tempDir, { force: false }, ['claude']);

    // Second init
    const result = await initShared(tempDir, { force: false }, ['claude']);

    const brainFeature = join(tempDir, 'flow', 'brain', 'features', 'my-feature.md');
    expect(result.skipped).toContain(brainFeature);
  });

  it('should handle empty directories gracefully', async () => {
    // No plans, discovery, or archive — just the flow structure
    await initShared(tempDir, { force: false }, ['claude']);

    // Should still work without errors
    const brainFeaturesDir = join(tempDir, 'flow', 'brain', 'features');
    expect(existsSync(brainFeaturesDir)).toBe(true);
  });
});

describe('generateTechFoundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    // Ensure flow/references exists
    mkdirSync(join(tempDir, 'flow', 'references'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create tech-foundation.md from a package.json', () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        dependencies: {
          react: '^18.2.0',
          next: '^14.0.0',
        },
        devDependencies: {
          jest: '^29.0.0',
          typescript: '^5.0.0',
        },
      }),
      'utf-8'
    );
    writeFileSync(
      join(tempDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022' } }),
      'utf-8'
    );

    const result = generateTechFoundation(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'references', 'tech-foundation.md');
    expect(existsSync(filePath)).toBe(true);
    expect(result.created).toContain(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Tech Foundation');
    expect(content).toContain('**Project**:');
    expect(content).toContain('| Language | TypeScript |');
    expect(content).toContain('Next.js');
    expect(content).toContain('| Jest |');
    expect(content).toContain('| react |');
    expect(content).toContain('| next |');
    expect(content).toContain('Strict mode');
  });

  it('should detect Python projects from pyproject.toml', () => {
    writeFileSync(
      join(tempDir, 'pyproject.toml'),
      '[tool.poetry]\nname = "my-app"\n\n[tool.poetry.dependencies]\nfastapi = ">=0.100"\n\n[tool.pytest]\n',
      'utf-8'
    );

    const result = generateTechFoundation(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'references', 'tech-foundation.md');
    expect(existsSync(filePath)).toBe(true);
    expect(result.created).toContain(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('| Language | Python |');
    expect(content).toContain('| Test Framework | Pytest |');
  });

  it('should skip if file exists and no force', () => {
    const filePath = join(tempDir, 'flow', 'references', 'tech-foundation.md');
    writeFileSync(filePath, 'existing content', 'utf-8');

    const result = generateTechFoundation(tempDir, { force: false });

    expect(result.skipped).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing content');
  });

  it('should overwrite with --force', () => {
    const filePath = join(tempDir, 'flow', 'references', 'tech-foundation.md');
    writeFileSync(filePath, 'old content', 'utf-8');

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: {} }),
      'utf-8'
    );

    const result = generateTechFoundation(tempDir, { force: true });

    expect(result.updated).toContain(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Tech Foundation');
    expect(content).not.toBe('old content');
  });

  it('should detect Rust projects from Cargo.toml', () => {
    writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "my-app"\n', 'utf-8');

    const result = generateTechFoundation(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'references', 'tech-foundation.md');
    expect(result.created).toContain(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('| Language | Rust |');
  });

  it('should handle projects with no dependency files', () => {
    const result = generateTechFoundation(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'references', 'tech-foundation.md');
    expect(result.created).toContain(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('| Language | Unknown |');
  });
});

describe('generateBusinessContext', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, 'flow', 'references'), { recursive: true });
    (askBusinessContext as jest.Mock).mockClear();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create business-context.md from provided answers', async () => {
    (askBusinessContext as jest.Mock).mockResolvedValue({
      whatItDoes: 'A CLI tool for AI workflows',
      targetAudience: 'Software developers',
      problemItSolves: 'Structured AI-assisted development',
    });

    const result = await generateBusinessContext(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'references', 'business-context.md');
    expect(existsSync(filePath)).toBe(true);
    expect(result.created).toContain(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Business Context');
    expect(content).toContain('**Project**:');
    expect(content).toContain('A CLI tool for AI workflows');
    expect(content).toContain('Software developers');
    expect(content).toContain('Structured AI-assisted development');
  });

  it('should extract README hint and pass to askBusinessContext', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# My Project\n\nThis is a great tool.\n', 'utf-8');

    await generateBusinessContext(tempDir, { force: false });

    expect(askBusinessContext).toHaveBeenCalledWith('This is a great tool.');
  });

  it('should skip the prompt (and file) in non-interactive mode', async () => {
    const result = await generateBusinessContext(tempDir, { force: false, nonInteractive: true });

    expect(askBusinessContext).not.toHaveBeenCalled();
    const filePath = join(tempDir, 'flow', 'references', 'business-context.md');
    expect(existsSync(filePath)).toBe(false);
    expect(result.skipped).toContain(filePath);
  });

  it('should include README summary in output', async () => {
    writeFileSync(join(tempDir, 'README.md'), '# My Project\n\nThis is the summary line.\n', 'utf-8');

    await generateBusinessContext(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'references', 'business-context.md');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('## README Summary');
    expect(content).toContain('This is the summary line.');
  });

  it('should show "No README found." when no README exists', async () => {
    await generateBusinessContext(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'references', 'business-context.md');
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('No README found.');
  });

  it('should skip if file exists and no force', async () => {
    const filePath = join(tempDir, 'flow', 'references', 'business-context.md');
    writeFileSync(filePath, 'existing content', 'utf-8');

    const result = await generateBusinessContext(tempDir, { force: false });

    expect(result.skipped).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing content');
    expect(askBusinessContext).not.toHaveBeenCalled();
  });

  it('should overwrite with --force', async () => {
    const filePath = join(tempDir, 'flow', 'references', 'business-context.md');
    writeFileSync(filePath, 'old content', 'utf-8');

    const result = await generateBusinessContext(tempDir, { force: true });

    expect(result.updated).toContain(filePath);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Business Context');
  });
});

describe('initShared calls generators', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-gen-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
    (askBusinessContext as jest.Mock).mockClear();
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('should generate all init files during init', async () => {
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', dependencies: { express: '^4.0.0' } }),
      'utf-8'
    );

    await initShared(tempDir, { force: false }, ['claude']);

    const techPath = join(tempDir, 'flow', 'references', 'tech-foundation.md');
    const bizPath = join(tempDir, 'flow', 'references', 'business-context.md');
    const tasklistPath = join(tempDir, 'flow', 'tasklist.md');
    const logPath = join(tempDir, 'flow', 'log.md');

    expect(existsSync(techPath)).toBe(true);
    expect(existsSync(bizPath)).toBe(true);
    expect(existsSync(tasklistPath)).toBe(true);
    expect(existsSync(logPath)).toBe(true);

    const techContent = readFileSync(techPath, 'utf-8');
    expect(techContent).toContain('Express');

    expect(askBusinessContext).toHaveBeenCalled();
  });
});

describe('generateTasklist', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create tasklist.md with project template', () => {
    const result = generateTasklist(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'tasklist.md');
    expect(existsSync(filePath)).toBe(true);
    expect(result.created).toContain(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Tasklist');
    expect(content).toContain('**Project**:');
    expect(content).toContain('## In Progress');
    expect(content).toContain('## To Do');
    expect(content).toContain('## Done');
  });

  it('should skip if file exists and no force', () => {
    const filePath = join(tempDir, 'flow', 'tasklist.md');
    writeFileSync(filePath, 'existing tasklist', 'utf-8');

    const result = generateTasklist(tempDir, { force: false });

    expect(result.skipped).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing tasklist');
  });

  it('preserves accumulated user data even with --force (re-provision safety)', () => {
    // Regression: the IDE re-provisions with `init --claude --force --yes`, so a
    // force-overwrite here would reset the user's tasklist on every re-provision.
    const filePath = join(tempDir, 'flow', 'tasklist.md');
    writeFileSync(filePath, 'existing user tasks', 'utf-8');

    const result = generateTasklist(tempDir, { force: true });

    expect(result.skipped).toContain(filePath);
    expect(result.updated).not.toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing user tasks');
  });
});

describe('generateLog', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create log.md with initial entry', () => {
    const result = generateLog(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'log.md');
    expect(existsSync(filePath)).toBe(true);
    expect(result.created).toContain(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Project Log');
    expect(content).toContain('**Project**:');
    expect(content).toContain('plan-flow initialized');
  });

  it('should skip if file exists and no force', () => {
    const filePath = join(tempDir, 'flow', 'log.md');
    writeFileSync(filePath, 'existing log', 'utf-8');

    const result = generateLog(tempDir, { force: false });

    expect(result.skipped).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing log');
  });

  it('preserves the existing log even with --force (re-provision safety)', () => {
    const filePath = join(tempDir, 'flow', 'log.md');
    writeFileSync(filePath, 'existing log entries', 'utf-8');

    const result = generateLog(tempDir, { force: true });

    expect(result.skipped).toContain(filePath);
    expect(result.updated).not.toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing log entries');
  });
});

describe('generateMemory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create memory.md with table template', () => {
    const result = generateMemory(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'memory.md');
    expect(existsSync(filePath)).toBe(true);
    expect(result.created).toContain(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Project Memory');
    expect(content).toContain('**Project**:');
    expect(content).toContain('| Date | Skill | Feature | Artifact | Summary |');
    expect(content).toContain('|------|-------|---------|----------|---------|');
  });

  it('should skip if file exists and no force', () => {
    const filePath = join(tempDir, 'flow', 'memory.md');
    writeFileSync(filePath, 'existing memory', 'utf-8');

    const result = generateMemory(tempDir, { force: false });

    expect(result.skipped).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing memory');
  });

  it('preserves accumulated memory even with --force (re-provision safety)', () => {
    const filePath = join(tempDir, 'flow', 'memory.md');
    writeFileSync(filePath, 'existing memory rows', 'utf-8');

    const result = generateMemory(tempDir, { force: true });

    expect(result.skipped).toContain(filePath);
    expect(result.updated).not.toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing memory rows');
  });
});

describe('generateHeartbeat', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it('should create heartbeat.md with template', () => {
    const result = generateHeartbeat(tempDir, { force: false });

    const filePath = join(tempDir, 'flow', 'heartbeat.md');
    expect(existsSync(filePath)).toBe(true);
    expect(result.created).toContain(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Heartbeat');
    expect(content).toContain('**Project**:');
    expect(content).toContain('## Tasks');
  });

  it('should skip if file exists and no force', () => {
    const filePath = join(tempDir, 'flow', 'heartbeat.md');
    writeFileSync(filePath, 'existing heartbeat', 'utf-8');

    const result = generateHeartbeat(tempDir, { force: false });

    expect(result.skipped).toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing heartbeat');
  });

  it('preserves user-authored task defs even with --force (re-provision safety)', () => {
    const filePath = join(tempDir, 'flow', 'heartbeat.md');
    writeFileSync(filePath, 'existing scheduled tasks', 'utf-8');

    const result = generateHeartbeat(tempDir, { force: true });

    expect(result.skipped).toContain(filePath);
    expect(result.updated).not.toContain(filePath);
    expect(readFileSync(filePath, 'utf-8')).toBe('existing scheduled tasks');
  });
});

describe('mitigateTailwindSources (#644)', () => {
  let dir: string;
  const opts = { force: false, dryRun: false } as never;

  beforeEach(() => {
    dir = createTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeCss(rel: string, content: string): string {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('appends @source not exclusions to a Tailwind v4 entry stylesheet', () => {
    const css = writeCss('src/app/globals.css', "@import 'tailwindcss';\n\nbody { color: red; }\n");
    const result = mitigateTailwindSources(dir, opts);
    expect(result.created).toContain(css);
    const out = readFileSync(css, 'utf-8');
    // Paths are relative to the CSS file (src/app → repo root = ../../).
    expect(out).toContain("@source not '../../flow';");
    expect(out).toContain("@source not '../../graphify-out';");
    // The user's own CSS is preserved.
    expect(out).toContain('body { color: red; }');
  });

  it('computes the relative path from the CSS file depth (app/globals.css → ../)', () => {
    const css = writeCss('app/globals.css', '@import "tailwindcss";\n');
    mitigateTailwindSources(dir, opts);
    const out = readFileSync(css, 'utf-8');
    expect(out).toContain("@source not '../flow';");
    expect(out).toContain("@source not '../graphify-out';");
  });

  it('is idempotent — a second run skips (no duplicate block)', () => {
    const css = writeCss('src/app/globals.css', "@import 'tailwindcss';\n");
    mitigateTailwindSources(dir, opts);
    const first = readFileSync(css, 'utf-8');
    const result = mitigateTailwindSources(dir, opts);
    expect(result.skipped).toContain(css);
    expect(result.created).not.toContain(css);
    expect(readFileSync(css, 'utf-8')).toBe(first);
    // Exactly one marker block.
    expect((readFileSync(css, 'utf-8').match(/plan-flow: exclude/g) ?? []).length).toBe(1);
  });

  it('ignores a stylesheet that does NOT import tailwindcss', () => {
    const css = writeCss('src/app/globals.css', 'body { margin: 0; }\n');
    const result = mitigateTailwindSources(dir, opts);
    expect(result.created).not.toContain(css);
    expect(readFileSync(css, 'utf-8')).toBe('body { margin: 0; }\n');
  });

  it('is a no-op for a project with no known entry stylesheet', () => {
    const result = mitigateTailwindSources(dir, opts);
    expect(result.created).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('initShared applies the Tailwind mitigation (#644)', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-tw-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });
  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('excludes flow/ + graphify-out/ from a Tailwind v4 entry stylesheet during init', async () => {
    mkdirSync(join(tempDir, 'src', 'app'), { recursive: true });
    const css = join(tempDir, 'src', 'app', 'globals.css');
    writeFileSync(css, "@import 'tailwindcss';\n\nhtml { height: 100%; }\n", 'utf-8');

    await initShared(tempDir, { force: false }, ['claude']);

    const out = readFileSync(css, 'utf-8');
    expect(out).toContain("@source not '../../flow';");
    expect(out).toContain("@source not '../../graphify-out';");
    expect(out).toContain('html { height: 100%; }'); // user CSS preserved
  });
});

// ── Knowledge migration: vault → repo (Phase 4) ─────────────────────────────
// The safety property under test is the ORDER: copy, verify, commit, repoint.
// Nothing is deleted at any point, and a failed verification must leave the
// vault exactly as it was.

const {
  migrateKnowledgeIntoRepo,
  copyTreeVerbatim,
  verifyCopy,
  isPreciousPath,
  countJsonlEntries,
  MIGRATION_STAGING_DIRNAME,
  VAULT_BACKUP_PREFIX,
} = await import('./knowledge-migration.js');

/** The store's own reader — used to prove the migrated knowledge still LOADS. */
const { readFeatures } = await import('../blueprint/feature-store.js');

/** Repo-relative POSIX paths of every file under `dir` (symlinks not followed). */
function listTree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      out.push(`${prefix}${entry}@`);
    } else if (info.isDirectory()) {
      out.push(...listTree(full, `${prefix}${entry}/`));
    } else {
      out.push(`${prefix}${entry}`);
    }
  }
  return out;
}

/** A vault project holding real knowledge, with the repo symlinked into it. */
function seedVaultProject(repoDir: string, vaultDir: string): { vaultFlow: string; repoFlow: string } {
  const projectName = repoDir.split('/').pop() ?? '';
  const vaultFlow = join(vaultDir, 'projects', projectName, 'flow');

  mkdirSync(join(vaultFlow, 'brain', 'features'), { recursive: true });
  mkdirSync(join(vaultFlow, 'brain', '.structure'), { recursive: true });
  mkdirSync(join(vaultFlow, 'brain', '.raw'), { recursive: true });
  mkdirSync(join(vaultFlow, 'plans'), { recursive: true });
  mkdirSync(join(vaultFlow, 'discovery'), { recursive: true });

  writeFileSync(join(vaultFlow, 'brain', 'features', 'playbooks.md'), '# Playbooks\n\nA real feature.\n', 'utf-8');
  writeFileSync(join(vaultFlow, 'brain', 'features', 'skills.md'), '# Skills\n\nAnother real feature.\n', 'utf-8');
  writeFileSync(
    join(vaultFlow, 'brain', 'features', 'acme-1234-login-bug.md'),
    '---\nthread_id: thread-abc\n---\n\nWorking set for "ACME-1234" — 4 file(s): 1 edited, 3 read.\n',
    'utf-8'
  );
  writeFileSync(
    join(vaultFlow, 'brain', '.structure', 'annotations.jsonl'),
    '{"ts":"2026-08-01T00:00:00Z","text":"one","type":"decision","anchors":[]}\n' +
      '{"ts":"2026-08-02T00:00:00Z","text":"two","type":"rule","anchors":[]}\n',
    'utf-8'
  );
  writeFileSync(
    join(vaultFlow, 'brain', '.structure', 'investigations.jsonl'),
    '{"kind":"note","ts":"2026-08-01T00:00:00Z","runId":null,"anchors":[{"kind":"symbol","ref":"Foo"}],"text":"a","provenance":"p","status":"observed","hashStamps":[]}\n' +
      '{"kind":"heat","anchorRef":"Foo","ts":"2026-08-01T00:00:01Z","visitor":"agent"}\n',
    'utf-8'
  );
  writeFileSync(join(vaultFlow, 'brain', '.structure', 'graph.json'), '{"version":1,"nodes":[]}\n', 'utf-8');
  writeFileSync(join(vaultFlow, 'brain', '.raw', 'thread-abc.json'), '{"threadId":"thread-abc"}\n', 'utf-8');
  writeFileSync(join(vaultFlow, 'plans', 'plan_login_v1.md'), '# Login plan\n', 'utf-8');
  writeFileSync(join(vaultFlow, 'discovery', 'discovery_login_v1.md'), '# Login discovery\n', 'utf-8');
  writeFileSync(join(vaultFlow, 'tasklist.md'), '# Tasklist\n', 'utf-8');
  writeFileSync(join(vaultFlow, '.flowconfig'), 'share: shared\ntelegram_bot_token: secret-123\n', 'utf-8');

  const repoFlow = join(repoDir, 'flow');
  symlinkSync(vaultFlow, repoFlow, 'dir');
  return { vaultFlow, repoFlow };
}

describe('knowledge migration — the copy step (task 4.1)', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-mig-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('copies the whole tree verbatim — same files, same bytes', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const dest = join(tempDir, 'copy');

    const stats = copyTreeVerbatim(vaultFlow, dest);

    expect(listTree(dest)).toEqual(listTree(vaultFlow));
    expect(stats.files).toBe(listTree(vaultFlow).length);
    expect(readFileSync(join(dest, 'brain', 'features', 'playbooks.md'), 'utf-8')).toBe(
      readFileSync(join(vaultFlow, 'brain', 'features', 'playbooks.md'), 'utf-8')
    );
  });

  it('recreates nested symlinks instead of following them', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const outside = join(vaultDir, 'outside-tree');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'foreign.txt'), 'not knowledge\n', 'utf-8');
    symlinkSync(outside, join(vaultFlow, 'brain', '.structure', 'graphify-out'), 'dir');

    const dest = join(tempDir, 'copy');
    const stats = copyTreeVerbatim(vaultFlow, dest);

    const link = join(dest, 'brain', '.structure', 'graphify-out');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link, 'utf-8')).toBe(outside);
    expect(stats.symlinks).toBe(1);
  });

  it('dry run copies, verifies and discards — the repo symlink is untouched', () => {
    const { vaultFlow, repoFlow } = seedVaultProject(tempDir, vaultDir);
    const before = listTree(vaultFlow);

    const report = migrateKnowledgeIntoRepo(tempDir, { dryRun: true });

    expect(report.status).toBe('verified-only');
    expect(report.copied?.files).toBe(before.length);
    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(true);
    expect(existsSync(join(tempDir, MIGRATION_STAGING_DIRNAME))).toBe(false);
    expect(listTree(vaultFlow)).toEqual(before);
  });

  it('refuses when there is no flow/ at all, changing nothing', () => {
    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.status).toBe('refused');
    expect(report.refusal).toContain('no flow/');
  });

  it('refuses when the flow/ symlink points at a missing vault directory', () => {
    symlinkSync(join(vaultDir, 'projects', 'gone', 'flow'), join(tempDir, 'flow'), 'dir');

    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.status).toBe('refused');
    expect(report.refusal).toContain('missing directory');
  });

  it('refuses when an earlier run left a staging directory behind', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    mkdirSync(join(tempDir, MIGRATION_STAGING_DIRNAME), { recursive: true });

    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.status).toBe('refused');
    expect(report.refusal).toContain(MIGRATION_STAGING_DIRNAME);
    expect(existsSync(join(vaultFlow, 'brain', 'features', 'playbooks.md'))).toBe(true);
  });

  it('reports already-migrated for a repo that owns its flow/ (idempotent)', () => {
    mkdirSync(join(tempDir, 'flow', 'brain'), { recursive: true });

    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.status).toBe('already-migrated');
    expect(existsSync(join(tempDir, 'flow', 'brain'))).toBe(true);
  });

  it('classifies the precious layer apart from the derived and transient one', () => {
    expect(isPreciousPath('brain/features/playbooks.md')).toBe(true);
    expect(isPreciousPath('brain/.structure/annotations.jsonl')).toBe(true);
    expect(isPreciousPath('plans/plan_login_v1.md')).toBe(true);
    expect(isPreciousPath('tasklist.md')).toBe(true);
    expect(isPreciousPath('brain/.structure/graph.json')).toBe(false);
    expect(isPreciousPath('brain/.raw/thread-abc.json')).toBe(false);
    expect(isPreciousPath('.evidence/run-1/phase-1-task-1/out.txt')).toBe(false);
  });

  it('counts JSONL entries by non-empty line, ignoring a trailing newline', () => {
    const file = join(tempDir, 'store.jsonl');
    writeFileSync(file, '{"a":1}\n{"a":2}\n', 'utf-8');
    expect(countJsonlEntries(file)).toBe(2);
    writeFileSync(file, '{"a":1}\n{"a":2}', 'utf-8');
    expect(countJsonlEntries(file)).toBe(2);
  });

  it('names the vault backup with a stable, sortable prefix', () => {
    expect(VAULT_BACKUP_PREFIX).toBe('flow.pre-migration-');
    expect(typeof verifyCopy).toBe('function');
  });
});

describe('knowledge migration — verify BEFORE repoint (task 4.2)', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-ver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('passes on a faithful copy and counts the precious layer and the stores', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const dest = join(tempDir, 'copy');
    copyTreeVerbatim(vaultFlow, dest);

    const report = verifyCopy(vaultFlow, dest);

    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.files).toBe(listTree(vaultFlow).length);
    // playbooks/skills/thread capture + annotations + investigations + plan +
    // discovery doc + tasklist — graph.json and .raw/ are NOT precious.
    expect(report.preciousFiles).toBe(8);
    expect(report.storesChecked).toBe(2);
  });

  it('fails on a MISSING file', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const dest = join(tempDir, 'copy');
    copyTreeVerbatim(vaultFlow, dest);
    rmSync(join(dest, 'brain', 'features', 'playbooks.md'));

    const report = verifyCopy(vaultFlow, dest);

    expect(report.ok).toBe(false);
    expect(report.failures).toContainEqual({
      path: 'brain/features/playbooks.md',
      reason: 'file missing in the copy',
    });
  });

  it('fails on a SHORT WRITE (byte count differs)', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const dest = join(tempDir, 'copy');
    copyTreeVerbatim(vaultFlow, dest);
    writeFileSync(join(dest, 'plans', 'plan_login_v1.md'), '# Log', 'utf-8');

    const report = verifyCopy(vaultFlow, dest);

    expect(report.ok).toBe(false);
    expect(report.failures[0].path).toBe('plans/plan_login_v1.md');
    expect(report.failures[0].reason).toContain('byte count differs');
  });

  it('fails on SAME-SIZE corruption (content hash differs)', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const dest = join(tempDir, 'copy');
    copyTreeVerbatim(vaultFlow, dest);
    writeFileSync(join(dest, 'plans', 'plan_login_v1.md'), '# Login plaN\n', 'utf-8');

    const report = verifyCopy(vaultFlow, dest);

    expect(report.ok).toBe(false);
    expect(report.failures[0].reason).toBe('content hash differs');
  });

  it('fails when an append-only store loses an entry', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const dest = join(tempDir, 'copy');
    copyTreeVerbatim(vaultFlow, dest);
    // Same byte count, one fewer entry: a newline swapped for a space.
    const source = readFileSync(join(vaultFlow, 'brain', '.structure', 'annotations.jsonl'), 'utf-8');
    writeFileSync(
      join(dest, 'brain', '.structure', 'annotations.jsonl'),
      source.replace('}\n{', '} {'),
      'utf-8'
    );

    const report = verifyCopy(vaultFlow, dest);

    expect(report.ok).toBe(false);
    // The hash check fires first; both are aborts. Assert the store is named.
    expect(report.failures[0].path).toBe('brain/.structure/annotations.jsonl');
  });

  it('fails on a missing directory and on a retargeted symlink', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    symlinkSync(join(vaultDir, 'elsewhere'), join(vaultFlow, 'brain', '.structure', 'graphify-out'), 'dir');
    const dest = join(tempDir, 'copy');
    copyTreeVerbatim(vaultFlow, dest);
    rmSync(join(dest, 'discovery'), { recursive: true, force: true });
    rmSync(join(dest, 'brain', '.structure', 'graphify-out'));
    symlinkSync(join(vaultDir, 'somewhere-else'), join(dest, 'brain', '.structure', 'graphify-out'), 'dir');

    const report = verifyCopy(vaultFlow, dest);

    expect(report.ok).toBe(false);
    const reasons = report.failures.map((f) => `${f.path}: ${f.reason}`);
    expect(reasons).toContainEqual('discovery: directory missing in the copy');
    expect(reasons.some((r) => r.startsWith('brain/.structure/graphify-out: symlink missing or retargeted'))).toBe(true);
  });

  it('A FAILED VERIFICATION ABORTS: staging discarded, vault intact, repo still linked', () => {
    const { vaultFlow, repoFlow } = seedVaultProject(tempDir, vaultDir);
    const vaultBefore = listTree(vaultFlow);

    // A short write on one file — the copy that a disk-full or interrupted
    // write produces. Everything else copies normally.
    const report = migrateKnowledgeIntoRepo(tempDir, {
      deps: {
        copyTree: (src, dst) => {
          const stats = copyTreeVerbatim(src, dst);
          writeFileSync(join(dst, 'brain', 'features', 'playbooks.md'), '# Play', 'utf-8');
          return stats;
        },
      },
    });

    expect(report.status).toBe('refused');
    expect(report.refusal).toContain('verification failed');
    expect(report.refusal).toContain('the vault is untouched');
    expect(report.refusal).toContain('brain/features/playbooks.md');

    // Nothing repointed, nothing staged, nothing deleted.
    expect(existsSync(join(tempDir, MIGRATION_STAGING_DIRNAME))).toBe(false);
    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(true);
    expect(readlinkSync(repoFlow, 'utf-8')).toBe(vaultFlow);
    expect(listTree(vaultFlow)).toEqual(vaultBefore);
    expect(readFileSync(join(vaultFlow, 'brain', 'features', 'playbooks.md'), 'utf-8')).toBe(
      '# Playbooks\n\nA real feature.\n'
    );
    expect(readdirSync(join(vaultDir, 'projects', tempDir.split('/').pop() ?? ''))).toEqual(['flow']);
  });

  it('a copy that throws aborts with the vault intact and no staging left', () => {
    const { vaultFlow, repoFlow } = seedVaultProject(tempDir, vaultDir);
    const vaultBefore = listTree(vaultFlow);

    const report = migrateKnowledgeIntoRepo(tempDir, {
      deps: {
        copyTree: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    });

    expect(report.status).toBe('refused');
    expect(report.refusal).toContain('copy failed (vault untouched)');
    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(true);
    expect(listTree(vaultFlow)).toEqual(vaultBefore);
    expect(existsSync(join(tempDir, MIGRATION_STAGING_DIRNAME))).toBe(false);
  });
});

describe('knowledge migration — inverting the link (task 4.4)', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-inv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('the repo holds a REAL flow/ and the vault becomes a symlink into it', () => {
    const { vaultFlow, repoFlow } = seedVaultProject(tempDir, vaultDir);

    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.status).toBe('migrated');
    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(false);
    expect(lstatSync(repoFlow).isDirectory()).toBe(true);
    expect(lstatSync(vaultFlow).isSymbolicLink()).toBe(true);
    expect(readlinkSync(vaultFlow, 'utf-8')).toBe(repoFlow);
    expect(report.vaultLinked).toBe(true);
  });

  it('the vault contents are RENAMED ASIDE, never deleted', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    const before = listTree(vaultFlow);

    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.vaultBackup).not.toBeNull();
    const backup = report.vaultBackup as string;
    expect(backup.split('/').pop()?.startsWith(VAULT_BACKUP_PREFIX)).toBe(true);
    expect(existsSync(backup)).toBe(true);
    expect(listTree(backup)).toEqual(before);
    expect(readFileSync(join(backup, 'brain', 'features', 'playbooks.md'), 'utf-8')).toBe(
      '# Playbooks\n\nA real feature.\n'
    );
  });

  it('the knowledge is reachable through the vault path after the inversion', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);

    migrateKnowledgeIntoRepo(tempDir);

    // Through the vault symlink — Obsidian keeps its one-graph view.
    expect(readFileSync(join(vaultFlow, 'plans', 'plan_login_v1.md'), 'utf-8')).toBe('# Login plan\n');
    // Writing through the repo shows up through the vault: one store, two paths.
    writeFileSync(join(tempDir, 'flow', 'brain', 'features', 'new.md'), '# New\n', 'utf-8');
    expect(readFileSync(join(vaultFlow, 'brain', 'features', 'new.md'), 'utf-8')).toBe('# New\n');
  });

  it('a later provision does NOT undo the migration (it would move flow/ into a link to itself)', async () => {
    const { vaultFlow, repoFlow } = seedVaultProject(tempDir, vaultDir);
    migrateKnowledgeIntoRepo(tempDir);
    const afterMigration = listTree(repoFlow);

    await initShared(tempDir, { force: false }, ['claude']);

    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(false);
    expect(lstatSync(vaultFlow).isSymbolicLink()).toBe(true);
    expect(readlinkSync(vaultFlow, 'utf-8')).toBe(repoFlow);
    // Every migrated file is still there (provisioning only ADDS scaffolding).
    for (const file of afterMigration) {
      expect(listTree(repoFlow)).toContain(file);
    }
    expect(readFileSync(join(repoFlow, 'brain', 'features', 'playbooks.md'), 'utf-8')).toBe(
      '# Playbooks\n\nA real feature.\n'
    );
  });

  it('a provision re-links the vault when its link went missing', async () => {
    const { vaultFlow, repoFlow } = seedVaultProject(tempDir, vaultDir);
    migrateKnowledgeIntoRepo(tempDir);
    rmSync(vaultFlow, { force: true }); // the LINK only

    await initShared(tempDir, { force: false }, ['claude']);

    expect(lstatSync(vaultFlow).isSymbolicLink()).toBe(true);
    expect(readlinkSync(vaultFlow, 'utf-8')).toBe(repoFlow);
    expect(lstatSync(repoFlow).isDirectory()).toBe(true);
  });

  it('a legacy real flow/ with no share answer still migrates INTO the vault (unchanged path)', async () => {
    mkdirSync(join(tempDir, 'flow', 'plans'), { recursive: true });
    writeFileSync(join(tempDir, 'flow', 'plans', 'legacy.md'), '# Legacy\n', 'utf-8');

    await initShared(tempDir, { force: false }, ['claude']);

    const projectName = tempDir.split('/').pop() ?? '';
    const brainFlow = join(vaultDir, 'projects', projectName, 'flow');
    expect(lstatSync(join(tempDir, 'flow')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(brainFlow, 'plans', 'legacy.md'))).toBe(true);
  });
});

describe('.gitattributes — union merge for the append-only stores (task 4.5)', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-attr-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('creates the block with the union rule scoped to flow/', () => {
    expect(updateGitattributes(tempDir)).toBe('created');

    const content = readFileSync(join(tempDir, '.gitattributes'), 'utf-8');
    expect(content).toContain('flow/**/*.jsonl merge=union');
    // Scoped on purpose: a repo-wide *.jsonl rule would union-merge a user's
    // own rewritten JSONL elsewhere and silently interleave two versions.
    expect(content).not.toContain('\n*.jsonl');
  });

  it('appends to an existing .gitattributes without touching user content', () => {
    writeFileSync(join(tempDir, '.gitattributes'), '*.png binary\n', 'utf-8');

    expect(updateGitattributes(tempDir)).toBe('updated');

    const content = readFileSync(join(tempDir, '.gitattributes'), 'utf-8');
    expect(content).toContain('*.png binary');
    expect(content).toContain('flow/**/*.jsonl merge=union');
  });

  it('is idempotent — a second run reports unchanged and the bytes match', () => {
    updateGitattributes(tempDir);
    const first = readFileSync(join(tempDir, '.gitattributes'), 'utf-8');

    expect(updateGitattributes(tempDir)).toBe('unchanged');
    expect(readFileSync(join(tempDir, '.gitattributes'), 'utf-8')).toBe(first);
  });

  it('reconciles a drifted block in place', () => {
    writeFileSync(
      join(tempDir, '.gitattributes'),
      '# keep me\n# >>> plan-flow\nflow/**/*.jsonl merge=ours\n# <<< plan-flow\n',
      'utf-8'
    );

    expect(updateGitattributes(tempDir)).toBe('updated');

    const content = readFileSync(join(tempDir, '.gitattributes'), 'utf-8');
    expect(content).toContain('# keep me');
    expect(content).toContain('flow/**/*.jsonl merge=union');
    expect(content).not.toContain('merge=ours');
  });

  it('a shared project gets it; a local one does not', async () => {
    await initShared(tempDir, { force: false, share: 'local' }, ['claude']);
    expect(existsSync(join(tempDir, '.gitattributes'))).toBe(false);

    const report = applyShareMode(tempDir, 'shared');

    expect(report.gitattributes).toBe('created');
    expect(readFileSync(join(tempDir, '.gitattributes'), 'utf-8')).toContain('merge=union');
  });
});

describe('gap decisions — what a SHARED project must not commit', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-gap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  // ── Gap 1: auto-captured working sets, interleaved with real features ──────

  it('lists ONLY the content-identified working sets, never a real feature', () => {
    const features = join(tempDir, 'flow', 'brain', 'features');
    mkdirSync(features, { recursive: true });
    writeFileSync(join(features, 'playbooks.md'), '# Playbooks\n\nA real feature.\n', 'utf-8');
    writeFileSync(join(features, 'skills.md'), '---\nname: Skills\n---\n\n# Skills\n', 'utf-8');
    writeFileSync(join(features, 'new-thread.md'), '---\nthread_id: t-9\n---\n\nWhatever.\n', 'utf-8');
    writeFileSync(join(features, 'acme-1234.md'), '# ACME-1234\n\nWorking set for "ACME-1234" — 4 file(s).\n', 'utf-8');

    const captures = updateWorkingSetIgnore(tempDir);

    expect(captures).toEqual(['acme-1234.md', 'new-thread.md']);
    const list = readFileSync(join(features, '.gitignore'), 'utf-8');
    expect(list).toContain('new-thread.md');
    expect(list).toContain('acme-1234.md');
    expect(list).not.toContain('playbooks.md');
    expect(list).not.toContain('skills.md');
    // Self-ignoring: the per-machine list never becomes a tracked file itself.
    expect(list.split('\n')).toContain('.gitignore');
  });

  it('moves and renames NOTHING — the captures stay queryable where they are', () => {
    const features = join(tempDir, 'flow', 'brain', 'features');
    mkdirSync(features, { recursive: true });
    const capture = join(features, 'new-thread.md');
    writeFileSync(capture, '---\nthread_id: t-9\n---\n\nBody.\n', 'utf-8');

    updateWorkingSetIgnore(tempDir);

    expect(existsSync(capture)).toBe(true);
    expect(readFileSync(capture, 'utf-8')).toBe('---\nthread_id: t-9\n---\n\nBody.\n');
    expect(readdirSync(features).sort()).toEqual(['.gitignore', 'new-thread.md']);
  });

  it('writes no list at all when there is nothing personal, and removes a stale one', () => {
    const features = join(tempDir, 'flow', 'brain', 'features');
    mkdirSync(features, { recursive: true });
    writeFileSync(join(features, 'thread.md'), '---\nthread_id: t-1\n---\n\nx\n', 'utf-8');
    updateWorkingSetIgnore(tempDir);
    expect(existsSync(join(features, '.gitignore'))).toBe(true);

    rmSync(join(features, 'thread.md'));
    expect(updateWorkingSetIgnore(tempDir)).toEqual([]);
    expect(existsSync(join(features, '.gitignore'))).toBe(false);
  });

  it('a share switch regenerates the list and never reports a capture as now trackable', async () => {
    await initShared(tempDir, { force: false, share: 'local' }, ['claude']);
    const features = join(tempDir, 'flow', 'brain', 'features');
    writeFileSync(join(features, 'playbooks.md'), '# Playbooks\n', 'utf-8');
    writeFileSync(join(features, 'thread.md'), '---\nthread_id: t-1\n---\n\nx\n', 'utf-8');

    const report = applyShareMode(tempDir, 'shared');

    expect(report.workingSetsIgnored).toEqual(['thread.md']);
    expect(report.nowTrackable).toContain('flow/brain/features/playbooks.md');
    expect(report.nowTrackable).not.toContain('flow/brain/features/thread.md');
  });

  // ── Gap 2: .flowconfig carries credentials; the mode travels elsewhere ─────

  it('ignores flow/.flowconfig in shared mode — a token never becomes trackable', () => {
    expect(sharedGitignoreEntries('shared')).toContain('flow/.flowconfig');
  });

  it('the share mode travels in the COMMITTED block when the config is absent', () => {
    const block = buildGitignoreBlock(['claude'], 'shared');
    writeFileSync(join(tempDir, '.gitignore'), block + '\n', 'utf-8');

    // No flow/.flowconfig at all — a fresh clone of a shared repo.
    expect(existsSync(join(tempDir, 'flow', '.flowconfig'))).toBe(false);
    expect(readShareMode(tempDir)).toBe('shared');
    expect(resolveShareMode(tempDir)).toBe('shared');
  });

  it('the config still WINS when present — the block is only a fallback', () => {
    writeFileSync(join(tempDir, '.gitignore'), buildGitignoreBlock(['claude'], 'shared') + '\n', 'utf-8');
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
    writeFileSync(join(tempDir, 'flow', '.flowconfig'), 'share: local\n', 'utf-8');

    expect(readShareMode(tempDir)).toBe('local');
  });

  it('a repo with neither is still UNANSWERED — the silent-publish guard holds', () => {
    expect(readShareMode(tempDir)).toBeNull();
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules\n', 'utf-8');
    expect(readShareMode(tempDir)).toBeNull();
    expect(resolveShareMode(tempDir)).toBe('local');
  });

  // ── Gap 3: per-run execution artifacts ────────────────────────────────────

  it('ignores the per-run execution artifacts, keeping the archived copy tracked', () => {
    const entries = sharedGitignoreEntries('shared');

    expect(entries).toContain('flow/.evidence/');
    expect(entries).toContain('flow/.rounds.jsonl');
    expect(entries).toContain('flow/.wave-context.jsonl');
    // The durable record of a run lives in the archive, and that stays tracked.
    expect(entries.some((e) => e.startsWith('flow/archive'))).toBe(false);
  });

  it('the switch report classifies a real end-to-end flow/ tree correctly', async () => {
    await initShared(tempDir, { force: false, share: 'local' }, ['claude']);
    const flow = join(tempDir, 'flow');
    writeFileSync(join(flow, 'brain', 'features', 'playbooks.md'), '# Playbooks\n', 'utf-8');
    writeFileSync(join(flow, 'plans', 'plan_a_v1.md'), '# Plan\n', 'utf-8');
    writeFileSync(join(flow, '.rounds.jsonl'), '{"kind":"phase_result"}\n', 'utf-8');
    writeFileSync(join(flow, '.wave-context.jsonl'), '{"kind":"contract"}\n', 'utf-8');
    mkdirSync(join(flow, '.evidence', 'run-1'), { recursive: true });
    writeFileSync(join(flow, '.evidence', 'run-1', 'out.txt'), 'ok\n', 'utf-8');
    mkdirSync(join(flow, 'brain', '.structure'), { recursive: true });
    writeFileSync(join(flow, 'brain', '.structure', 'graph.json'), '{}\n', 'utf-8');
    writeFileSync(join(flow, 'brain', '.structure', 'annotations.jsonl'), '{"text":"a"}\n', 'utf-8');

    const report = applyShareMode(tempDir, 'shared');

    expect(report.nowTrackable).toContain('flow/brain/features/playbooks.md');
    expect(report.nowTrackable).toContain('flow/plans/plan_a_v1.md');
    expect(report.nowTrackable).toContain('flow/brain/.structure/annotations.jsonl');
    for (const stillIgnored of [
      'flow/.rounds.jsonl',
      'flow/.wave-context.jsonl',
      'flow/.evidence/run-1/out.txt',
      'flow/brain/.structure/graph.json',
      'flow/.flowconfig',
    ]) {
      expect(report.nowTrackable).not.toContain(stillIgnored);
    }
  });
});

describe('knowledge migration — end to end on a seeded pair (task 4.6)', () => {
  let tempDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('the repo holds the knowledge, the vault points at it, and NOTHING was deleted', () => {
    const { vaultFlow, repoFlow } = seedVaultProject(tempDir, vaultDir);
    // A shared project, so the hygiene steps run too.
    writeFileSync(join(tempDir, '.gitignore'), buildGitignoreBlock(['claude'], 'shared') + '\n', 'utf-8');
    const vaultBefore = listTree(vaultFlow);
    const contentBefore = new Map(
      vaultBefore.map((rel) => [rel, readFileSync(join(vaultFlow, rel), 'utf-8')] as const)
    );

    const report = migrateKnowledgeIntoRepo(tempDir);

    // 1. The repo holds the knowledge — a real directory, every file present.
    expect(report.status).toBe('migrated');
    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(false);
    for (const [rel, content] of contentBefore) {
      expect(readFileSync(join(repoFlow, rel), 'utf-8')).toBe(content);
    }

    // 2. The vault points at it.
    expect(lstatSync(vaultFlow).isSymbolicLink()).toBe(true);
    expect(readlinkSync(vaultFlow, 'utf-8')).toBe(repoFlow);
    expect(readFileSync(join(vaultFlow, 'brain', 'features', 'skills.md'), 'utf-8')).toBe(
      '# Skills\n\nAnother real feature.\n'
    );

    // 3. NOTHING was deleted — the pre-migration vault tree is still on disk.
    const backup = report.vaultBackup as string;
    expect(existsSync(backup)).toBe(true);
    expect(listTree(backup)).toEqual(vaultBefore);
    for (const [rel, content] of contentBefore) {
      expect(readFileSync(join(backup, rel), 'utf-8')).toBe(content);
    }
    expect(existsSync(join(tempDir, MIGRATION_STAGING_DIRNAME))).toBe(false);
  });

  it('leaves the migrated repo hygienic: portable paths, union merge, personal captures ignored', () => {
    const { vaultFlow } = seedVaultProject(tempDir, vaultDir);
    writeFileSync(join(tempDir, '.gitignore'), buildGitignoreBlock(['claude'], 'shared') + '\n', 'utf-8');
    // One leaking investigation entry, anchored at the OLD vault path.
    const store = join(vaultFlow, 'brain', '.structure', 'investigations.jsonl');
    const portable = readFileSync(store, 'utf-8');
    writeFileSync(
      store,
      portable +
        JSON.stringify({
          kind: 'note',
          ts: '2026-08-03T00:00:00.000Z',
          runId: null,
          anchors: [{ kind: 'file', ref: `${vaultFlow}/plans/plan_login_v1.md` }],
          text: `see ${tempDir}/src/login.ts`,
          provenance: 'observe-cli',
          status: 'observed',
          hashStamps: [],
        }) +
        '\n',
      'utf-8'
    );

    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.status).toBe('migrated');
    // Paths normalised, and the two portable lines untouched.
    expect(report.normalizedInvestigations).toEqual({ scanned: 3, rewritten: 1, unchanged: 2 });
    const migrated = readFileSync(join(tempDir, 'flow', 'brain', '.structure', 'investigations.jsonl'), 'utf-8');
    expect(migrated.startsWith(portable)).toBe(true);
    expect(migrated).toContain('"ref":"flow/plans/plan_login_v1.md"');
    expect(migrated).toContain('see src/login.ts');
    expect(migrated).not.toContain(tempDir);

    // Union merge for the append-only stores.
    expect(report.gitattributes).toBe('created');
    expect(readFileSync(join(tempDir, '.gitattributes'), 'utf-8')).toContain('flow/**/*.jsonl merge=union');

    // The thread capture is ignored; the two real features are not.
    expect(report.workingSetsIgnored).toEqual(['acme-1234-login-bug.md']);
    const nested = readFileSync(join(tempDir, 'flow', 'brain', 'features', '.gitignore'), 'utf-8');
    expect(nested).toContain('acme-1234-login-bug.md');
    expect(nested).not.toContain('playbooks.md');
    // And it is still ON DISK, queryable, unmoved.
    expect(existsSync(join(tempDir, 'flow', 'brain', 'features', 'acme-1234-login-bug.md'))).toBe(true);
  });

  it('a local project migrates too, without the shared-only hygiene', () => {
    seedVaultProject(tempDir, vaultDir);
    writeFileSync(join(tempDir, '.gitignore'), buildGitignoreBlock(['claude'], 'local') + '\n', 'utf-8');
    // The seeded flowconfig says shared; the .gitignore block is only a fallback,
    // so make the answered mode local to exercise the local path.
    writeFileSync(join(tempDir, 'flow', '.flowconfig'), 'share: local\n', 'utf-8');

    const report = migrateKnowledgeIntoRepo(tempDir);

    expect(report.status).toBe('migrated');
    expect(report.gitattributes).toBeNull();
    expect(report.workingSetsIgnored).toEqual([]);
    expect(existsSync(join(tempDir, '.gitattributes'))).toBe(false);
    // The knowledge still moved.
    expect(readFileSync(join(tempDir, 'flow', 'brain', 'features', 'playbooks.md'), 'utf-8')).toBe(
      '# Playbooks\n\nA real feature.\n'
    );
  });

  it('re-running the migration is a safe no-op', () => {
    seedVaultProject(tempDir, vaultDir);
    migrateKnowledgeIntoRepo(tempDir);
    const after = listTree(join(tempDir, 'flow'));

    const second = migrateKnowledgeIntoRepo(tempDir);

    expect(second.status).toBe('already-migrated');
    expect(listTree(join(tempDir, 'flow'))).toEqual(after);
  });
});

describe('the generated index is ignored, never tracked (#file-based-brain)', () => {
  it('shared ignores the whole derived directory with ONE entry', () => {
    const entries = sharedGitignoreEntries('shared');

    expect(entries).toContain('flow/brain/.derived/');
    // A directory rule, not a per-file one: the point of a wholly-disposable
    // directory is that whatever lands in it next is covered without anyone
    // having to remember to add a line.
    expect(entries).not.toContain('flow/brain/.derived/INDEX.md');
    // And it is NOT in the precious layer, where a rebuild overwriting it
    // would eat somebody's edit.
    expect(entries).not.toContain('flow/brain/INDEX.md');
  });

  it('local ignores it by inheritance, like everything else under flow/', () => {
    const entries = sharedGitignoreEntries('local');
    expect(entries).toContain('/flow');
    expect(entries).not.toContain('flow/brain/.derived/');
  });
});

// ── Task 7.1: the generated block, judged by REAL GIT ───────────────────────
//
// Every other test in this file asks the generator what it produced. These ask
// GIT what it does with it, on a real repository holding a realistic tree —
// because the failure being guarded is not "the constant changed", it is "the
// rule does not mean what we think it means", and only git can say that. The
// two directions cost differently and both are silent: a derived path that
// becomes trackable churns megabytes into every teammate's diff on every
// derive, and a precious path that stays ignored is a brain nobody notices is
// missing until someone clones the repo and finds it empty.
//
// The two lists below are DECLARED INTENT — hand-written, one line per file,
// naming the side each belongs on. Git decides which side each actually lands
// on. A rule wrong in either direction moves a file across and fails here.

/** Everything a SHARED project must commit. Precious: no rebuild reproduces it. */
const PRECIOUS_TREE: readonly string[] = [
  'flow/STATE.md',
  'flow/archive/plan_old_v1.md',
  'flow/archive/rounds_old.jsonl',
  'flow/brain/.structure/annotations.jsonl',
  'flow/brain/.structure/investigations.jsonl',
  'flow/brain/.structure/learning-state.jsonl',
  'flow/brain/.structure/proposals.jsonl',
  'flow/brain/.structure/status-events.jsonl',
  'flow/brain/decisions/why-files.md',
  'flow/brain/errors/timeout.md',
  'flow/brain/features/playbooks.md',
  'flow/brain/features/skills.md',
  'flow/brain/index.md',
  'flow/brainstorms/brainstorm_a_v1.md',
  'flow/contracts/stripe_contract.md',
  'flow/discovery/discovery_a_v1.md',
  'flow/heartbeat.md',
  'flow/ledger.md',
  'flow/log.md',
  'flow/memory.md',
  'flow/plans/plan_a_v1.md',
  'flow/references/ref.md',
  'flow/resources/res.md',
  'flow/reviewed-code/review_a.md',
  'flow/reviewed-pr/pr_1.md',
  'flow/tasklist.md',
];

/**
 * Everything a SHARED project must NOT commit, in three classes:
 * derived (a rebuild reproduces it), per-run/per-machine, and the one personal
 * capture that lives INSIDE the precious directory and is excluded by content.
 */
const NON_TRACKED_TREE: readonly string[] = [
  // Derived — rebuilt by a derive / capture / index pass.
  'flow/brain/.derived/INDEX.md',
  'flow/brain/.raw/thread-1.md',
  'flow/brain/.structure/file-stamps.json',
  'flow/brain/.structure/file-tiers.json',
  'flow/brain/.structure/graph.json',
  'flow/brain/.structure/graph.prev.json',
  'flow/brain/.structure/symbols.jsonl',
  'flow/brain/code/card-1.md',
  // Per-run and per-machine.
  'flow/.evidence/run-1/out.txt',
  'flow/.flowconfig',
  'flow/.heartbeat-events.jsonl',
  'flow/.heartbeat-prompt.md',
  'flow/.heartbeat-state.json',
  'flow/.heartbeat.log',
  'flow/.lavish/plan_a.html',
  'flow/.rounds.jsonl',
  'flow/.scratchpad.md',
  'flow/.telegram-poll-state.json',
  'flow/.wave-context.jsonl',
  // An auto-captured working set, interleaved with the real features and told
  // apart only by its content — excluded by the nested self-ignoring list.
  'flow/brain/features/acme-1234.md',
];

/** Outside flow/ entirely, and ignored in BOTH modes. */
const NON_TRACKED_ROOT: readonly string[] = ['.brain.sqlite', 'graphify-out/graph.json'];

describe('the ignore block against REAL git — the exact sets, both directions (task 7.1)', () => {
  let repoDir: string;
  let vaultDir: string;

  /** git, with the user's global/system config out of the way. */
  function git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: repoDir,
      encoding: 'utf-8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
  }

  function lines(out: string): string[] {
    return out.split('\n').filter((line) => line.length > 0).sort();
  }

  /** Untracked files git WOULD add — i.e. everything not ignored. */
  function trackable(): string[] {
    return lines(git(['ls-files', '--others', '--exclude-standard']));
  }

  /** Untracked files git IGNORES, file by file (no --directory collapsing). */
  function ignored(): string[] {
    return lines(git(['ls-files', '--others', '--ignored', '--exclude-standard']));
  }

  function write(relPath: string, content: string): void {
    const full = join(repoDir, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  }

  /** A realistic post-migration project: flow/ is a REAL directory in the repo. */
  function seedTree(): void {
    for (const rel of [...PRECIOUS_TREE, ...NON_TRACKED_ROOT]) {
      write(rel, `content of ${rel}\n`);
    }
    for (const rel of NON_TRACKED_TREE) {
      // The one file whose exclusion is decided by CONTENT, not by path: it has
      // to actually look like a working-set capture or the nested list is being
      // handed the answer instead of finding it.
      write(
        rel,
        rel.endsWith('acme-1234.md')
          ? '---\nthread_id: thread-abc\n---\n\nWorking set for "ACME-1234" — 4 file(s).\n'
          : `content of ${rel}\n`,
      );
    }
  }

  beforeEach(() => {
    repoDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-gitreal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
    execFileSync('git', ['init', '-q', '.'], {
      cwd: repoDir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    });
    seedTree();
  });

  afterEach(() => {
    cleanup(repoDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('SHARED: git tracks EXACTLY the precious layer and ignores EXACTLY the derived one', () => {
    applyShareMode(repoDir, 'shared');

    // The generated files themselves are trackable — the block states the mode
    // for a teammate's clone, and the union-merge rule has to travel with it.
    expect(trackable()).toEqual([...PRECIOUS_TREE, '.gitattributes', '.gitignore'].sort());

    // …and the other side, just as exactly. `flow/brain/features/.gitignore` is
    // the nested per-machine list, which ignores itself by construction.
    expect(ignored()).toEqual(
      [...NON_TRACKED_TREE, ...NON_TRACKED_ROOT, 'flow/brain/features/.gitignore'].sort(),
    );

    // Stated once more as the property, so a failure above reads as the risk it
    // is rather than as a diff of two long lists.
    expect(trackable().filter((f) => f.startsWith('flow/'))).toEqual([...PRECIOUS_TREE].sort());
    for (const derived of NON_TRACKED_TREE) {
      expect(trackable()).not.toContain(derived);
    }
    for (const precious of PRECIOUS_TREE) {
      expect(ignored()).not.toContain(precious);
    }
  });

  it('LOCAL: git ignores EVERYTHING under flow/, and nothing under it is trackable', () => {
    applyShareMode(repoDir, 'local');

    expect(trackable()).toEqual(['.gitignore']);
    expect(ignored()).toEqual(
      [...PRECIOUS_TREE, ...NON_TRACKED_TREE, ...NON_TRACKED_ROOT].sort(),
    );
    expect(trackable().some((file) => file.startsWith('flow/'))).toBe(false);
  });

  it('LOCAL still ignores flow/ when it is the pre-migration SYMLINK (git sees a file)', () => {
    // The whole reason `/flow` carries no trailing slash: a symlink is a FILE to
    // git, and `flow/` would not match it — the project would silently offer to
    // commit a link pointing outside the repo.
    rmSync(join(repoDir, 'flow'), { recursive: true, force: true });
    const vaultFlow = join(vaultDir, 'projects', 'p', 'flow');
    mkdirSync(join(vaultFlow, 'brain', 'features'), { recursive: true });
    writeFileSync(join(vaultFlow, 'brain', 'features', 'playbooks.md'), '# P\n', 'utf-8');
    symlinkSync(vaultFlow, join(repoDir, 'flow'), 'dir');

    writeFileSync(join(repoDir, '.gitignore'), buildGitignoreBlock(['claude'], 'local') + '\n', 'utf-8');

    expect(trackable()).toEqual(['.gitignore']);
    expect(ignored()).toContain('flow');
  });

  it('a mode round trip returns git to EXACTLY the sets it started with', () => {
    applyShareMode(repoDir, 'shared');
    const sharedTrackable = trackable();
    const sharedIgnored = ignored();

    applyShareMode(repoDir, 'local');
    expect(trackable().some((file) => file.startsWith('flow/'))).toBe(false);

    applyShareMode(repoDir, 'shared');
    expect(trackable()).toEqual(sharedTrackable);
    expect(ignored()).toEqual(sharedIgnored);
  });

  it('every file survives both switches — sharing changes tracking, never the tree', () => {
    const before = listTree(join(repoDir, 'flow')).sort();

    applyShareMode(repoDir, 'shared');
    applyShareMode(repoDir, 'local');
    applyShareMode(repoDir, 'shared');

    // The nested list is the ONE file a switch adds; nothing is ever removed.
    expect(listTree(join(repoDir, 'flow')).sort()).toEqual(
      [...before, 'brain/features/.gitignore'].sort(),
    );
    for (const rel of [...PRECIOUS_TREE, ...NON_TRACKED_TREE]) {
      expect(existsSync(join(repoDir, rel))).toBe(true);
    }
  });
});

// ── Task 7.3: migration on a seeded pair, and the thing it must never do ─────
//
// Task 4.6 proves the migration's shape. This proves its SAFETY PROPERTY as a
// conservation law, on the only terms that matter after the fact: every byte
// that existed anywhere before the migration is still readable somewhere after
// it. The order (copy → verify → commit → repoint) exists so that no window
// leaves the knowledge in neither place; a test that only checks the end state
// of the repo would pass even if the vault had been emptied to get there.

describe('migration end to end — knowledge in the repo, vault linked, NOTHING deleted (task 7.3)', () => {
  let repoDir: string;
  let vaultDir: string;

  /** Every file under `dir` (symlinks NOT followed) → sha256 of its bytes. */
  function inventory(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    if (!existsSync(dir)) return out;
    for (const rel of listTree(dir)) {
      if (rel.endsWith('@')) {
        out.set(rel, `symlink→${readlinkSync(join(dir, rel.slice(0, -1)), 'utf-8')}`);
        continue;
      }
      out.set(rel, createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex'));
    }
    return out;
  }

  beforeEach(() => {
    repoDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-73-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(repoDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  it('CONSERVATION: every byte that existed before is still readable after', () => {
    const { vaultFlow, repoFlow } = seedVaultProject(repoDir, vaultDir);
    writeFileSync(join(repoDir, '.gitignore'), buildGitignoreBlock(['claude'], 'shared') + '\n', 'utf-8');
    const before = inventory(vaultFlow);
    expect(before.size).toBeGreaterThan(0);

    const report = migrateKnowledgeIntoRepo(repoDir);
    expect(report.status).toBe('migrated');

    // 1. THE REPO HOLDS IT — a real directory, every file with the same bytes.
    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(false);
    const after = inventory(repoFlow);
    for (const [rel, hash] of before) {
      expect(after.get(rel)).toBe(hash);
    }

    // 2. THE VAULT POINTS AT IT — Obsidian keeps its one-graph view, and the
    //    repo is the source of truth (write there, see it here).
    expect(lstatSync(vaultFlow).isSymbolicLink()).toBe(true);
    expect(resolve(readlinkSync(vaultFlow, 'utf-8'))).toBe(resolve(repoFlow));
    writeFileSync(join(repoFlow, 'brain', 'features', 'written-after.md'), '# After\n', 'utf-8');
    expect(readFileSync(join(vaultFlow, 'brain', 'features', 'written-after.md'), 'utf-8')).toBe('# After\n');

    // 3. NOTHING WAS DELETED. Not "the repo copy is fine" — the pre-migration
    //    tree itself is still on disk, byte for byte, at the renamed-aside path.
    const backup = report.vaultBackup as string;
    expect(backup).toContain(VAULT_BACKUP_PREFIX);
    expect(inventory(backup)).toEqual(before);
    // Nothing was left in the staging area either — no third copy to go stale.
    expect(existsSync(join(repoDir, MIGRATION_STAGING_DIRNAME))).toBe(false);
  });

  it('the migrated knowledge is USABLE — the store reads back from the repo', () => {
    const { vaultFlow } = seedVaultProject(repoDir, vaultDir);

    migrateKnowledgeIntoRepo(repoDir);

    // The two real features are readable from the repo path; the interleaved
    // working-set capture is still excluded by content, exactly as before.
    const features = readFeatures(join(repoDir, 'flow'));
    expect(features.map((node) => node.slug).sort()).toEqual(['playbooks', 'skills']);
    // …and the same read through the VAULT path resolves to the same store.
    expect(readFeatures(vaultFlow).map((node) => node.slug).sort()).toEqual(['playbooks', 'skills']);
  });

  it('a FAILED verification deletes nothing and repoints nothing (the order is the safety)', () => {
    const { vaultFlow, repoFlow } = seedVaultProject(repoDir, vaultDir);
    const before = inventory(vaultFlow);

    const report = migrateKnowledgeIntoRepo(repoDir, {
      deps: {
        // A copy that silently loses a file — the failure the verify step is
        // there to catch, and the one that would be unrecoverable if the vault
        // had been touched first.
        copyTree: (src, dest) => {
          const stats = copyTreeVerbatim(src, dest);
          rmSync(join(dest, 'brain', 'features', 'playbooks.md'));
          return stats;
        },
      },
    });

    expect(report.status).toBe('refused');
    expect(report.refusal).toContain('verification failed');
    // The vault is EXACTLY as it was, and the repo still resolves to it.
    expect(inventory(vaultFlow)).toEqual(before);
    expect(lstatSync(repoFlow).isSymbolicLink()).toBe(true);
    expect(existsSync(join(repoDir, MIGRATION_STAGING_DIRNAME))).toBe(false);
  });

  it('after migrating, REAL git tracks the precious layer of a shared project', () => {
    seedVaultProject(repoDir, vaultDir);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q', '.'], { cwd: repoDir, env });
    writeFileSync(join(repoDir, 'flow', '.flowconfig'), 'share: shared\n', 'utf-8');
    writeFileSync(join(repoDir, '.gitignore'), buildGitignoreBlock(['claude'], 'shared') + '\n', 'utf-8');

    expect(migrateKnowledgeIntoRepo(repoDir).status).toBe('migrated');

    const trackable = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: repoDir,
      encoding: 'utf-8',
      env,
    })
      .split('\n')
      .filter((line) => line.length > 0)
      .sort();

    // The knowledge a teammate cloning this repo would actually receive.
    expect(trackable).toEqual([
      '.gitattributes',
      '.gitignore',
      'flow/brain/.structure/annotations.jsonl',
      'flow/brain/.structure/investigations.jsonl',
      'flow/brain/features/playbooks.md',
      'flow/brain/features/skills.md',
      'flow/discovery/discovery_login_v1.md',
      'flow/plans/plan_login_v1.md',
      'flow/tasklist.md',
    ]);
    // The derived graph, the raw drafts, the credential-carrying config and the
    // personal working set are all on the other side of the line.
    for (const excluded of [
      'flow/brain/.structure/graph.json',
      'flow/brain/.raw/thread-abc.json',
      'flow/.flowconfig',
      'flow/brain/features/acme-1234-login-bug.md',
    ]) {
      expect(trackable).not.toContain(excluded);
      expect(existsSync(join(repoDir, excluded))).toBe(true);
    }
  });
});

// ── seeded loop directives (Tasks 3.2 / 3.3) ────────────────────────────────
// The incident: `init` provisioned `.claude/**` and `flow/**` and nothing
// created `loops/`, so a freshly-provisioned checkout answered `/beat fix` with
// `no directive for loop 'fix'`. A project starts with loops now — paused, and
// bound to a remote only when one actually resolves.
describe('initShared seeds loops/', () => {
  let tempDir: string;
  let vaultDir: string;

  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

  beforeEach(() => {
    tempDir = createTempDir();
    vaultDir = join(tmpdir(), `plan-flow-vault-loops-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(tempDir);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  function directiveText(name: string): string {
    return readFileSync(join(tempDir, 'loops', `${name}.md`), 'utf-8');
  }

  it('writes both directives into the TRACKED loops/, not under the flow/ symlink', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    for (const name of ['find', 'fix']) {
      expect(existsSync(join(tempDir, 'loops', `${name}.md`))).toBe(true);
    }
    // `flow/` is a symlink into the vault, which git refuses to track — a
    // directive written there could never travel to the second machine.
    expect(existsSync(join(tempDir, 'flow', 'loops'))).toBe(false);
  });

  // The incident itself, reproduced through the exact call that failed:
  // `/beat fix` on a freshly-provisioned checkout resolved no directive at all.
  it('makes readLoopDirective resolve every seeded loop — the call /beat failed on', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    for (const name of ['find', 'fix']) {
      expect(readLoopDirective(join(tempDir, 'flow'), name).loop).toBe(name);
    }
  });

  it('seeds every directive PAUSED — reading and resuming is the user’s act', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    for (const name of ['find', 'fix']) {
      expect(parseLoopDirective(directiveText(name), name)).toMatchObject({
        loop: name,
        paused: true,
      });
    }
  });

  it('leaves repo: OUT ENTIRELY when no remote resolves, and still parses', async () => {
    await initShared(tempDir, { force: false }, ['claude']);

    const text = directiveText('fix');
    // Not a placeholder value, not an empty key — the field is simply absent,
    // and the ledger queue is what makes that a valid directive.
    expect(text).not.toMatch(/^repo:/m);
    const directive = parseLoopDirective(text, 'fix');
    expect(directive.queue).toBe('ledger');
    expect(Object.hasOwn(directive, 'repo')).toBe(false);
  });

  // A REMOTE IS NOT A CHOICE OF LIST. This asserted the opposite until
  // 2026-09-02: a github.com origin bound both seeded directives to
  // `queue: github` + that repo. Reported by someone who had never picked
  // GitHub — their Loops panel read "This project · queue" while every run
  // demanded `gh auth login`, because init had read their remote at install
  // time. "The git should be checked only if the user select the git."
  //
  // Where code is pushed says nothing about where work is listed. Pointing a
  // loop at GitHub is a person's act now — the panel's "Change", or
  // `loop point --queue github --repo owner/name`.
  it('keeps the local list even when a github.com remote resolves', async () => {
    execFileSync('git', ['init', '-q', '.'], { cwd: tempDir, env: GIT_ENV });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd: tempDir,
      env: GIT_ENV,
    });

    await initShared(tempDir, { force: false }, ['claude']);

    for (const name of ['find', 'fix']) {
      const text = directiveText(name);
      // `repo:` under `queue: ledger` refuses to parse, so it stays a comment.
      expect(text).not.toMatch(/^repo:/m);
      const directive = parseLoopDirective(text, name);
      expect(directive).toMatchObject({ queue: 'ledger', paused: true });
      expect(Object.hasOwn(directive, 'repo')).toBe(false);
    }
  });

  it('reports the seeded files as created, so the init summary counts them', async () => {
    const result = await initShared(tempDir, { force: false }, ['claude']);

    for (const name of ['find', 'fix']) {
      expect(result.created).toContain(join(tempDir, 'loops', `${name}.md`));
    }
  });

  // The idempotence that matters: `init` runs on EVERY IDE project-open.
  it('never overwrites — an edited mission survives re-provisioning', async () => {
    await initShared(tempDir, { force: false }, ['claude']);
    const edited = directiveText('fix').replace(/^mission: .*$/m, 'mission: Drain only the release blockers');
    writeFileSync(join(tempDir, 'loops', 'fix.md'), edited, 'utf-8');

    await initShared(tempDir, { force: false }, ['claude']);
    await initShared(tempDir, { force: true }, ['claude']);

    expect(directiveText('fix')).toBe(edited);
    expect(parseLoopDirective(directiveText('fix'), 'fix').mission).toBe(
      'Drain only the release blockers',
    );
  });

  it('leaves a loops/ holding ANYTHING completely alone — nothing is added beside it', async () => {
    mkdirSync(join(tempDir, 'loops'), { recursive: true });
    writeFileSync(join(tempDir, 'loops', 'notes.txt'), 'my own file\n', 'utf-8');

    await initShared(tempDir, { force: false }, ['claude']);

    expect(readdirSync(join(tempDir, 'loops'))).toEqual(['notes.txt']);
  });
});

describe('seedLoopDirectives', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  /** An injected git: tests never shell out, and never see this machine's remotes. */
  function execReturning(stdout: string): (c: string, a: readonly string[], cwd: string) => string {
    return () => stdout;
  }

  it.each([
    ['git@github.com:acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets.git', 'acme/widgets'],
    ['https://github.com/acme/widgets', 'acme/widgets'],
    ['ssh://git@github.com/acme/widgets.git', 'acme/widgets'],
    ['https://user@github.com/acme/widgets.git', 'acme/widgets'],
  ])('normalises %s to %s', (remote, expected) => {
    expect(repoFromRemote(remote)).toBe(expected);
  });

  it.each([
    // `gh` resolves a bare owner/name against github.com — binding a GitLab
    // remote would point the loop at a DIFFERENT repository, plausibly someone
    // else's. Null costs a local ledger queue; a wrong guess costs more.
    ['https://gitlab.com/acme/widgets.git'],
    ['git@bitbucket.org:acme/widgets.git'],
    // A nested group is not `owner/name`, so there is nothing certain to state.
    ['https://github.com/acme/team/widgets.git'],
    ['/srv/git/widgets.git'],
    [''],
  ])('refuses to guess a repo from %s', (remote) => {
    expect(repoFromRemote(remote)).toBeNull();
  });

  // WHERE CODE IS PUSHED SAYS NOTHING ABOUT WHERE WORK IS LISTED (18c5ea3b).
  //
  // Seeding used to read `git remote get-url origin` and, if it pointed at
  // github.com, rewrite the shipped `queue: ledger` into a GitHub-backed list
  // that nobody had asked for. This pins the rule that replaced it: a remote is
  // not a choice, and seeding leaves the local list alone whatever git says.
  //
  // These two tests asserted the OLD rule and were missed when it changed —
  // they sit in a different describe block from the one that commit updated
  // (forbidden-pattern #22: a narrow filter verified "8 seeding tests" and
  // these were not among them).
  it('keeps the local list even when a github.com remote resolves', () => {
    const seeded = seedLoopDirectives(tempDir, {
      exec: execReturning('https://github.com/acme/widgets.git\n'),
    });

    expect(seeded.repo).toBeNull();
    const text = readFileSync(join(tempDir, 'loops', 'find.md'), 'utf-8');
    expect(text).toMatch(/^queue: ledger$/m);
    // The placeholder stays a COMMENT — pointing a loop at GitHub is a person's
    // act, performed later by the panel or `loop point`.
    expect(text).toMatch(/^#\s*repo:/m);
    expect(text).not.toMatch(/^repo: /m);
  });

  it('degrades to the ledger form when git itself fails — never throws', () => {
    const seeded = seedLoopDirectives(tempDir, {
      exec: () => {
        throw new Error('git: command not found');
      },
    });

    expect(seeded.repo).toBeNull();
    expect(seeded.created.length).toBe(2);
    expect(readFileSync(join(tempDir, 'loops', 'fix.md'), 'utf-8')).toMatch(/^queue: ledger$/m);
  });

  it('degrades to a notice when the templates are missing, and creates nothing', () => {
    const seeded = seedLoopDirectives(tempDir, {
      exec: execReturning(''),
      packageRoot: join(tempDir, 'no-such-package'),
    });

    expect(seeded.created).toEqual([]);
    expect(seeded.notice).toContain('no directive templates found');
    expect(existsSync(join(tempDir, 'loops'))).toBe(false);
  });

  it('says in one line what list it seeded, without mentioning git at all', () => {
    const notice = seedLoopDirectives(tempDir, { exec: execReturning('') }).notice;
    expect(notice).toContain('queue: ledger');
    // Not "no GitHub remote resolved", which was the old rule apologising for
    // something it was never going to do.
    expect(notice).not.toMatch(/remote/i);
  });
});
