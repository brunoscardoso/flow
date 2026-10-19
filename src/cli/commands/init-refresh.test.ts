/**
 * ## Refresh Safety Audit
 *
 * Feature: ide-auto-provisioning — the IDE auto-refreshes a stale project's
 * plan-flow assets on open. BINDING constraint (NFR3): a refresh may rewrite
 * plan-flow-OWNED assets only. It must NEVER rewrite:
 *   - `.claude/rules/core/*`  (user pattern data accumulates there)
 *   - `flow/` content          (vault-linked user knowledge)
 *   - existing `.flowconfig` KEYS (additive keys only; existing values frozen)
 *
 * This file is BOTH the characterization of current `init` behavior (task 1)
 * and — after the guarded refresh lands (task 2/3) — the regression suite for
 * the safe boundary. The boundary lives in CODE (allowed-pattern #14), not
 * prompt convention.
 *
 * ### Audit verdict (task 1 — characterized below against the live handlers)
 *
 * `init --claude --force --yes` runs `initClaude` (src/cli/handlers/claude.ts).
 * Its Step 2 copies the packaged `.claude/rules/` into the target via
 * `copyDir(rulesSrc, rulesDest, options)`, forwarding `options.force`. Under
 * `--force`, `copyFile` (src/cli/utils/files.ts) calls `copyFileSync`
 * UNCONDITIONALLY when the destination exists. Therefore:
 *
 *   ⚠️  UNSAFE (current): `init --force` OVERWRITES existing
 *       `.claude/rules/core/allowed-patterns.md` and `forbidden-patterns.md`
 *       with the stock shipped copies — destroying accumulated user pattern
 *       data. This is the NFR3 violation the refresh work must eliminate, and
 *       task 2 additionally guards the `--force` path itself.
 *
 *   ✅  `.flowconfig`: the claude handler NEVER writes `flow/.flowconfig`
 *       (only graphify-rails / the /flow skill touch it). Pre-existing config
 *       is left byte-identical by the claude handler.
 *
 *   ✅  `flow/` content: the claude handler NEVER touches `flow/`. (The shared
 *       handler only creates missing subdirs / migrates to the vault symlink;
 *       existing content is preserved.)
 *
 * The `it(...)` cases below EXECUTE these findings against a temp fixture so the
 * audit is verifiable, not asserted on faith. Cases marked
 * "CHARACTERIZATION (unsafe)" pin the current bug and are inverted into safety
 * guards in task 2.
 */

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';

const { initClaude } = await import('../handlers/claude');
const { initShared, readShareMode } = await import('../handlers/shared');
const { runRefreshOwned, OWNED_ASSET_PATHS, hasExistingInstall } = await import(
  './init-refresh'
);

function createTempDir(): string {
  const dir = join(
    tmpdir(),
    `plan-flow-refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

const USER_PATTERN_MARKER = '### 99. MY ACCUMULATED USER PATTERN — MUST SURVIVE';

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Refresh Safety Audit — characterization of current init behavior', () => {
  let target: string;

  beforeEach(() => {
    target = createTempDir();
    writeFileSync(join(target, 'package.json'), '{}');
  });

  afterEach(() => {
    cleanup(target);
  });

  it('fresh `init --claude` creates the owned .claude asset tree', async () => {
    await initClaude(target, { force: false, nonInteractive: true });

    expect(existsSync(join(target, '.claude', 'commands'))).toBe(true);
    expect(existsSync(join(target, '.claude', 'resources'))).toBe(true);
    expect(
      existsSync(join(target, '.claude', 'rules', 'core', 'allowed-patterns.md'))
    ).toBe(true);
    expect(existsSync(join(target, 'CLAUDE.md'))).toBe(true);
  });

  it('GUARD (task 2 fix): `init --force` PRESERVES user data in .claude/rules/core', async () => {
    // Seed a project that already has an install, with user-accumulated pattern data.
    await initClaude(target, { force: false, nonInteractive: true });

    const allowedPath = join(
      target,
      '.claude',
      'rules',
      'core',
      'allowed-patterns.md'
    );
    const userContent =
      readFileSync(allowedPath, 'utf-8') + `\n\n${USER_PATTERN_MARKER}\n`;
    writeFileSync(allowedPath, userContent, 'utf-8');

    // Re-run with --force (what `init --claude --force --yes` does). The audit
    // found this used to clobber the file; the claude-handler guard now makes
    // the rules copy create-if-missing only, so the user's marker survives.
    await initClaude(target, { force: true, nonInteractive: true });

    expect(readFileSync(allowedPath, 'utf-8')).toContain(USER_PATTERN_MARKER);
  });

  it('the claude handler never writes flow/.flowconfig (existing config untouched)', async () => {
    const flowconfigPath = join(target, 'flow', '.flowconfig');
    mkdirSync(join(target, 'flow'), { recursive: true });
    const original = 'autopilot: true\ncustom_key: keep-me\n';
    writeFileSync(flowconfigPath, original, 'utf-8');

    await initClaude(target, { force: true, nonInteractive: true });

    expect(readFileSync(flowconfigPath, 'utf-8')).toBe(original);
  });

  it('the claude handler never touches flow/ content', async () => {
    const planPath = join(target, 'flow', 'plans', 'plan_mine_v1.md');
    mkdirSync(join(target, 'flow', 'plans'), { recursive: true });
    const original = '# My plan\n\nUser knowledge that must survive.\n';
    writeFileSync(planPath, original, 'utf-8');

    await initClaude(target, { force: true, nonInteractive: true });

    expect(readFileSync(planPath, 'utf-8')).toBe(original);
  });
});

describe('runRefreshOwned — guarded owned-asset refresh', () => {
  let target: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    target = createTempDir();
    writeFileSync(join(target, 'package.json'), '{}');
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    cleanup(target);
  });

  it('OWNED_ASSET_PATHS is frozen and excludes .claude/rules entirely', () => {
    expect(Object.isFrozen(OWNED_ASSET_PATHS)).toBe(true);
    for (const group of OWNED_ASSET_PATHS) {
      expect(Object.isFrozen(group)).toBe(true);
      expect(group.dest.startsWith('.claude/rules')).toBe(false);
      expect(group.dest === 'flow' || group.dest.startsWith('flow/')).toBe(false);
    }
    // The commands + resources owned groups must be present.
    const dests = OWNED_ASSET_PATHS.map((g) => g.dest);
    expect(dests).toContain('.claude/commands');
    expect(dests).toContain('.claude/resources');
  });

  it('refuses (exit 1, nothing written) when there is no existing install', () => {
    expect(hasExistingInstall(target)).toBe(false);

    const result = runRefreshOwned({ target });

    expect(result.refused).toBe(true);
    expect(result.reason).toBe('no existing plan-flow install to refresh');
    expect(result.groupsUpdated).toBe(0);
    expect(process.exitCode).toBe(1);
    // Nothing written.
    expect(existsSync(join(target, '.claude', 'commands'))).toBe(false);
    expect(existsSync(join(target, '.claude', 'resources'))).toBe(false);
  });

  it('rewrites an outdated owned resources file back to the shipped copy', async () => {
    await initClaude(target, { force: false, nonInteractive: true });

    // Find a shipped resources/skills file and corrupt it (simulate staleness).
    const skillFile = join(
      target,
      '.claude',
      'resources',
      'skills',
      'execute-plan-skill.md'
    );
    expect(existsSync(skillFile)).toBe(true);
    writeFileSync(skillFile, 'STALE OUTDATED CONTENT\n', 'utf-8');

    const result = runRefreshOwned({ target });

    expect(result.refused).toBe(false);
    expect(result.groupsUpdated).toBeGreaterThan(0);
    // The stale file was refreshed from the CLI's co-located assets.
    expect(readFileSync(skillFile, 'utf-8')).not.toContain('STALE OUTDATED CONTENT');
  });
});

describe('runRefreshOwned — canary matrix, idempotency, determinism', () => {
  let target: string;
  let savedExitCode: typeof process.exitCode;

  const allowedRel = ['.claude', 'rules', 'core', 'allowed-patterns.md'];
  const forbiddenRel = ['.claude', 'rules', 'core', 'forbidden-patterns.md'];
  const flowconfigRel = ['flow', '.flowconfig'];
  const userPlanRel = ['flow', 'plans', 'plan_mine_v1.md'];
  const staleSkillRel = ['.claude', 'resources', 'skills', 'execute-plan-skill.md'];

  beforeEach(() => {
    target = createTempDir();
    writeFileSync(join(target, 'package.json'), '{}');
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    cleanup(target);
  });

  /** Seed an installed project with user data + one stale owned file. */
  function seedCanaryProject(): {
    allowed: string;
    forbidden: string;
    flowconfig: string;
    userPlan: string;
  } {
    const allowedPath = join(target, ...allowedRel);
    const forbiddenPath = join(target, ...forbiddenRel);
    const flowconfigPath = join(target, ...flowconfigRel);
    const userPlanPath = join(target, ...userPlanRel);
    const staleSkillPath = join(target, ...staleSkillRel);

    // User-modified rule files (accumulated pattern data).
    const allowed = readFileSync(allowedPath, 'utf-8') + `\n\n${USER_PATTERN_MARKER}\n`;
    const forbidden =
      readFileSync(forbiddenPath, 'utf-8') + `\n\n### 99. MY FORBIDDEN PATTERN\n`;
    writeFileSync(allowedPath, allowed, 'utf-8');
    writeFileSync(forbiddenPath, forbidden, 'utf-8');

    // Custom .flowconfig key (existing values must be frozen).
    const flowconfig = 'autopilot: true\ncustom_key: keep-me-verbatim\n';
    mkdirSync(join(target, 'flow'), { recursive: true });
    writeFileSync(flowconfigPath, flowconfig, 'utf-8');

    // User knowledge under flow/.
    const userPlan = '# My plan\n\nUser knowledge that must survive.\n';
    mkdirSync(join(target, 'flow', 'plans'), { recursive: true });
    writeFileSync(userPlanPath, userPlan, 'utf-8');

    // An outdated owned resources file that SHOULD be refreshed.
    writeFileSync(staleSkillPath, 'STALE OUTDATED CONTENT\n', 'utf-8');

    return { allowed, forbidden, flowconfig, userPlan };
  }

  it('canary matrix: user data survives byte-identical while stale owned assets update', async () => {
    await initClaude(target, { force: false, nonInteractive: true });
    const seeded = seedCanaryProject();

    const result = runRefreshOwned({ target });
    expect(result.refused).toBe(false);
    expect(result.groupsUpdated).toBeGreaterThan(0);

    // Protected user data — byte-identical.
    expect(readFileSync(join(target, ...allowedRel), 'utf-8')).toBe(seeded.allowed);
    expect(readFileSync(join(target, ...forbiddenRel), 'utf-8')).toBe(seeded.forbidden);
    expect(readFileSync(join(target, ...flowconfigRel), 'utf-8')).toBe(seeded.flowconfig);
    expect(readFileSync(join(target, ...userPlanRel), 'utf-8')).toBe(seeded.userPlan);

    // Stale owned asset — refreshed.
    expect(readFileSync(join(target, ...staleSkillRel), 'utf-8')).not.toContain(
      'STALE OUTDATED CONTENT'
    );
  });

  describe('the generated half of CLAUDE.md (#1850)', () => {
    // `CLAUDE.md` is excluded from OWNED_ASSET_PATHS, correctly — a blind
    // rewrite would eat the user's own instructions. But the exclusion was
    // all-or-nothing, so a doc fix in the template reached only projects
    // provisioned AFTER it, while its sibling half in `.claude/commands/`
    // reached everyone. #1849 was exactly that: a two-file doc fix that
    // half-landed, and the half that did not is the one spliced into
    // always-loaded instructions.

    const ABOVE = '# My Project\n\nMy own instructions, above.\n\n';
    const BELOW = '\n\nMore of my own prose, below.\n';

    function seedClaudeMd(body: string): void {
      writeFileSync(join(target, 'CLAUDE.md'), body, 'utf-8');
    }

    it('refreshes the marker section and leaves the user’s prose byte-identical', async () => {
      await initClaude(target, { force: false, nonInteractive: true });
      seedClaudeMd(
        `${ABOVE}<!-- plan-flow-start -->\nSTALE CONTENT FROM AN OLD VERSION.\n<!-- plan-flow-end -->${BELOW}`,
      );

      runRefreshOwned({ target });
      const after = readFileSync(join(target, 'CLAUDE.md'), 'utf-8');

      expect(after.startsWith(ABOVE)).toBe(true);
      expect(after.endsWith(BELOW)).toBe(true);
      expect(after).not.toContain('STALE CONTENT FROM AN OLD VERSION');
      expect(after).toContain('<!-- plan-flow-start -->');
      expect(after).toContain('<!-- plan-flow-end -->');
    });

    it('leaves a CLAUDE.md with NO markers completely alone', async () => {
      // Never provisioned, or the user removed them deliberately. Either way it
      // is not ours, and this is the case the blanket exclusion was protecting.
      await initClaude(target, { force: false, nonInteractive: true });
      const mine = '# Just mine\n\nNothing generated here.\n';
      seedClaudeMd(mine);

      runRefreshOwned({ target });

      expect(readFileSync(join(target, 'CLAUDE.md'), 'utf-8')).toBe(mine);
    });

    it('is idempotent — a second refresh changes nothing', async () => {
      await initClaude(target, { force: false, nonInteractive: true });
      seedClaudeMd(
        `${ABOVE}<!-- plan-flow-start -->\nSTALE\n<!-- plan-flow-end -->${BELOW}`,
      );

      runRefreshOwned({ target });
      const first = readFileSync(join(target, 'CLAUDE.md'), 'utf-8');
      runRefreshOwned({ target });

      expect(readFileSync(join(target, 'CLAUDE.md'), 'utf-8')).toBe(first);
    });

    it('does not create a CLAUDE.md that was not there', async () => {
      // A refresh refreshes; it does not provision.
      await initClaude(target, { force: false, nonInteractive: true });
      rmSync(join(target, 'CLAUDE.md'), { force: true });

      runRefreshOwned({ target });

      expect(existsSync(join(target, 'CLAUDE.md'))).toBe(false);
    });
  });

  it('idempotent: a second refresh reports the same group count and re-writes byte-identically', async () => {
    await initClaude(target, { force: false, nonInteractive: true });
    seedCanaryProject();

    const first = runRefreshOwned({ target });
    const skillAfterFirst = readFileSync(join(target, ...staleSkillRel), 'utf-8');
    const allowedAfterFirst = readFileSync(join(target, ...allowedRel), 'utf-8');

    const second = runRefreshOwned({ target });
    const skillAfterSecond = readFileSync(join(target, ...staleSkillRel), 'utf-8');
    const allowedAfterSecond = readFileSync(join(target, ...allowedRel), 'utf-8');

    expect(second.groupsUpdated).toBe(first.groupsUpdated);
    expect(skillAfterSecond).toBe(skillAfterFirst);
    // User data still preserved on the repeat run.
    expect(allowedAfterSecond).toBe(allowedAfterFirst);
    expect(allowedAfterSecond).toContain(USER_PATTERN_MARKER);
  });

  it('deterministic: two identical installs refresh to identical owned bytes and group count', async () => {
    const targetB = createTempDir();
    writeFileSync(join(targetB, 'package.json'), '{}');
    try {
      await initClaude(target, { force: false, nonInteractive: true });
      await initClaude(targetB, { force: false, nonInteractive: true });

      const a = runRefreshOwned({ target });
      const b = runRefreshOwned({ target: targetB });

      expect(a.groupsUpdated).toBe(b.groupsUpdated);

      // A sampled owned file is byte-identical across the two projects.
      const cmdA = readFileSync(
        join(target, '.claude', 'commands', 'execute-plan.md'),
        'utf-8'
      );
      const cmdB = readFileSync(
        join(targetB, '.claude', 'commands', 'execute-plan.md'),
        'utf-8'
      );
      expect(cmdA).toBe(cmdB);

      // Manifest itself is a stable, deterministic list.
      expect(OWNED_ASSET_PATHS.map((g) => g.dest)).toEqual([
        '.claude/commands',
        '.claude/resources',
        '.claude/hooks',
      ]);
    } finally {
      cleanup(targetB);
    }
  });
});

describe('runRefreshOwned — NFR3 boundary gap cases', () => {
  let target: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    target = createTempDir();
    writeFileSync(join(target, 'package.json'), '{}');
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    cleanup(target);
  });

  it('preserves a NESTED user file under .claude/rules/ (not just core/) byte-identical through refresh', async () => {
    await initClaude(target, { force: false, nonInteractive: true });

    // A user file in a non-`core` rules subdir — the whole `.claude/rules/`
    // tree is excluded from OWNED_ASSET_PATHS, so a nested one is just as
    // protected as `core/allowed-patterns.md`.
    const nestedRel = ['.claude', 'rules', 'my-team', 'conventions.md'];
    const nestedPath = join(target, ...nestedRel);
    mkdirSync(join(target, '.claude', 'rules', 'my-team'), { recursive: true });
    const nestedContent = '# Team conventions\n\nDeeply nested user knowledge.\n';
    writeFileSync(nestedPath, nestedContent, 'utf-8');

    const result = runRefreshOwned({ target });
    expect(result.refused).toBe(false);
    expect(result.groupsUpdated).toBeGreaterThan(0);

    // Byte-identical: refresh never descends into `.claude/rules/`.
    expect(readFileSync(nestedPath, 'utf-8')).toBe(nestedContent);
  });

  it('CONTRACT: a user file placed INSIDE an owned dir is PRESERVED — owned-group rewrite copies over, it never prunes', async () => {
    await initClaude(target, { force: false, nonInteractive: true });

    // A user drops their own file directly inside an owned group directory
    // (`.claude/resources/`). This pins the semantic of the owned-group
    // rewrite: `copyDir` iterates the SOURCE tree and overwrites matching
    // destinations, but it does NOT delete destination files that are absent
    // from the source. So unknown files inside an owned dir SURVIVE — the
    // refresh is additive/overwriting, never a prune-to-match-source.
    const userInOwnedRel = ['.claude', 'resources', 'my-custom-note.md'];
    const userInOwnedPath = join(target, ...userInOwnedRel);
    const userContent = '# My note\n\nUser-authored, living inside an owned dir.\n';
    writeFileSync(userInOwnedPath, userContent, 'utf-8');

    // Also corrupt a genuinely-owned file so we prove the rewrite still runs.
    const staleSkillPath = join(
      target,
      '.claude',
      'resources',
      'skills',
      'execute-plan-skill.md'
    );
    writeFileSync(staleSkillPath, 'STALE OUTDATED CONTENT\n', 'utf-8');

    const result = runRefreshOwned({ target });
    expect(result.refused).toBe(false);

    // The owned file was refreshed…
    expect(readFileSync(staleSkillPath, 'utf-8')).not.toContain(
      'STALE OUTDATED CONTENT'
    );
    // …AND the user's unknown file inside the owned dir was left byte-identical
    // (NOT pruned). This is the contractual behavior asserted explicitly.
    expect(existsSync(userInOwnedPath)).toBe(true);
    expect(readFileSync(userInOwnedPath, 'utf-8')).toBe(userContent);
  });
});

// ── THE SILENT-PUBLISH GUARD ────────────────────────────────────────────────
//
// Sharing a project's knowledge publishes someone's work. So the one thing a
// provision may never do is decide that FOR them: an existing project that was
// installed before the share setting existed — and therefore has no answer —
// must come out of a provision LOCAL, every time, no matter how it is
// provisioned. This is the test that says so by name.
describe('silent-publish guard — an existing project with no setting stays LOCAL', () => {
  let target: string;
  let vaultDir: string;

  beforeEach(() => {
    target = createTempDir();
    writeFileSync(join(target, 'package.json'), '{}');
    vaultDir = join(
      tmpdir(),
      `plan-flow-vault-refresh-share-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(vaultDir, { recursive: true });
    process.env.PLAN_FLOW_VAULT_DIR = vaultDir;
  });

  afterEach(() => {
    cleanup(target);
    cleanup(vaultDir);
    delete process.env.PLAN_FLOW_VAULT_DIR;
  });

  /**
   * A pre-share-setting install: plan-flow assets present, a `.flowconfig` with
   * the keys of its day, and NO `share:` line anywhere.
   */
  async function seedLegacyProject(): Promise<void> {
    await initClaude(target, { force: false, nonInteractive: true });
    await initShared(target, { force: false, nonInteractive: true }, ['claude']);
    // Strip the key the modern provision just wrote, so the fixture is a
    // genuinely unanswered project rather than an answered one.
    const configPath = join(target, 'flow', '.flowconfig');
    const legacy = readFileSync(configPath, 'utf-8')
      .split('\n')
      .filter((line) => !line.startsWith('share:'))
      .join('\n');
    writeFileSync(configPath, `autopilot: false\ncommit: false\n${legacy}`, 'utf-8');
    // A legacy install predates the setting in BOTH places: the ignore block of
    // its day carried no "Knowledge sharing" header either, and that header is
    // the fallback channel the mode travels in for a teammate's clone.
    const gitignorePath = join(target, '.gitignore');
    writeFileSync(
      gitignorePath,
      readFileSync(gitignorePath, 'utf-8')
        .split('\n')
        .filter((line) => !line.startsWith('# Knowledge sharing:'))
        .join('\n'),
      'utf-8'
    );
    expect(readShareMode(target)).toBeNull();
  }

  it('a full provision of an unanswered project resolves to LOCAL, never shared', async () => {
    await seedLegacyProject();

    // The IDE provisions with `--claude --force --yes`; the shared handler's
    // slice of that is a forced, non-interactive run with no share answer.
    await initShared(target, { force: true, nonInteractive: true }, ['claude']);

    expect(readShareMode(target)).toBe('local');
    const gitignore = readFileSync(join(target, '.gitignore'), 'utf-8');
    expect(gitignore.split('\n')).toContain('/flow');
    expect(gitignore).toContain('# Knowledge sharing: local');
    expect(gitignore).not.toContain('# Knowledge sharing: shared');
    // The knowledge markdown is not staged for publication by anyone but the user.
    expect(gitignore).not.toContain('flow/brain/features');
  });

  it('`init --refresh-owned` does not touch the setting or the ignore block at all', async () => {
    await seedLegacyProject();
    const configBefore = readFileSync(join(target, 'flow', '.flowconfig'), 'utf-8');
    const gitignoreBefore = readFileSync(join(target, '.gitignore'), 'utf-8');

    const result = runRefreshOwned({ target });

    expect(result.refused).toBe(false);
    expect(readFileSync(join(target, 'flow', '.flowconfig'), 'utf-8')).toBe(configBefore);
    expect(readFileSync(join(target, '.gitignore'), 'utf-8')).toBe(gitignoreBefore);
    expect(readShareMode(target)).toBeNull();
  });

  it('a project that DID answer shared keeps its answer through a forced provision', async () => {
    await seedLegacyProject();
    await initShared(target, { force: false, nonInteractive: true, share: 'shared' }, ['claude']);
    expect(readShareMode(target)).toBe('shared');

    await initShared(target, { force: true, nonInteractive: true }, ['claude']);

    // Preservation cuts both ways: provisioning never publishes, and it never
    // un-publishes either.
    expect(readShareMode(target)).toBe('shared');
    expect(readFileSync(join(target, '.gitignore'), 'utf-8')).toContain('# Knowledge sharing: shared');
  });
});

describe('runRefreshOwned — a project that predates loop seeding gets its loops', () => {
  let target: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    target = createTempDir();
    writeFileSync(join(target, 'package.json'), '{}');
    // An INSTALLED project — the refresh path's precondition, and the state
    // every already-provisioned project is in.
    mkdirSync(join(target, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(target, '.claude', 'resources'), { recursive: true });
    savedExitCode = process.exitCode;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    cleanup(target);
  });

  it('seeds loops/ on refresh — the full init is never run again for these projects', () => {
    // The reported defect: the IDE runs the full `init` only for a FRESH
    // project, so a project provisioned before loop seeding existed took this
    // path forever and never got a single directive. The Loops panel said "no
    // loops yet" and offered no way to make one.
    expect(existsSync(join(target, 'loops'))).toBe(false);
    runRefreshOwned({ target });
    const loopsDir = join(target, 'loops');
    expect(existsSync(loopsDir)).toBe(true);
    expect(readdirSync(loopsDir).length).toBeGreaterThan(0);
  });

  it('seeds them PAUSED — a directive that arrives by itself never runs by itself', () => {
    runRefreshOwned({ target });
    for (const name of readdirSync(join(target, 'loops'))) {
      const body = readFileSync(join(target, 'loops', name), 'utf8');
      expect(body).toMatch(/^paused: true$/m);
    }
  });

  it('never touches a directory that already holds directives', () => {
    // The refresh runs on EVERY project open, so a seeder that could rewrite a
    // hand-edited mission would rewrite it every time.
    mkdirSync(join(target, 'loops'), { recursive: true });
    const mine = join(target, 'loops', 'mine.md');
    writeFileSync(mine, 'my own mission, hand written\n');
    runRefreshOwned({ target });
    expect(readFileSync(mine, 'utf8')).toBe('my own mission, hand written\n');
    expect(readdirSync(join(target, 'loops'))).toEqual(['mine.md']);
  });

  it('still refuses on a project with no install at all — seeding is not a bootstrap', () => {
    const bare = createTempDir();
    try {
      const result = runRefreshOwned({ target: bare });
      expect(result.refused).toBe(true);
      expect(existsSync(join(bare, 'loops'))).toBe(false);
    } finally {
      cleanup(bare);
    }
  });
});
