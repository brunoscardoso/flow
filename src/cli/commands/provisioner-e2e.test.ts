/**
 * Live E2E for IDE auto-provisioning — exercises the REAL built CLI
 * (`dist/cli/index.js`) as a subprocess against a temp fixture project, the
 * same way the Flow IDE's provisioner invokes it (allowed-pattern #7: never
 * trust in-process seams for the shipped path).
 *
 * Scenarios (mirrors the manual E2E transcript in
 * flow/.evidence/ide-auto-provisioning-20260715-180153/7-3/):
 *   (a) `init --claude --force --yes` on a git fixture → flow/ symlink (or
 *       dir), .claude assets, CLAUDE.md — AND a pre-seeded user-modified
 *       `.claude/rules/core/allowed-patterns.md` survives byte-identical
 *       through a second `--force` run (the clobber fix, E2E level).
 *   (b) corrupt a `.claude/resources/` file + seed a custom `.flowconfig`
 *       key, run `init --refresh-owned` → the owned resource is restored to
 *       package content while the rules file and the custom flowconfig key
 *       survive byte-identical.
 *   (c) refresh twice → identical stdout and identical owned bytes
 *       (idempotent).
 *
 * Isolation: PLAN_FLOW_VAULT_DIR points at a per-test temp vault so the real
 * central vault (~/plan-flow/brain/) is never touched, and HOME at a per-test
 * temp home so init's PATH rails never write the real ~/.local/bin.
 *
 * The suite requires the built CLI. When `dist/cli/index.js` is absent (fresh
 * checkout, `npm run build` not yet run) it fails loud with a clear message
 * rather than silently skipping — the built artifact IS the subject under
 * test.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { getPackageRoot } = await import('../utils/files.js');
const { listFilesRecursive } = await import('../utils/files.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

const E2E_TIMEOUT_MS = 120_000;
const USER_PATTERN_MARKER = '### 99. MY USER PATTERN — MUST SURVIVE E2E';

interface CliRun {
  stdout: string;
  stderr: string;
  status: number | null;
}

describe('provisioner E2E — real built CLI against a temp fixture project', () => {
  let sandbox: string;
  let project: string;
  let vault: string;

  const rulesRel = ['.claude', 'rules', 'core', 'allowed-patterns.md'];
  const resourceRel = ['.claude', 'resources', 'skills', 'execute-plan-skill.md'];
  const flowconfigRel = ['flow', '.flowconfig'];

  function runCli(args: string[]): CliRun {
    const result = spawnSync('node', [CLI_PATH, ...args], {
      encoding: 'utf-8',
      // HOME too: real `init` runs the PATH rails, which repair a stale
      // `~/.local/bin/planflow-ai` — against the developer's real home, that
      // rewrote their own shim during a test run (2026-10-09).
      env: {
        ...process.env,
        PLAN_FLOW_VAULT_DIR: vault,
        HOME: join(sandbox, 'home'),
        USERPROFILE: join(sandbox, 'home'),
      },
      timeout: E2E_TIMEOUT_MS,
    });
    if (result.error) {
      throw result.error;
    }
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      status: result.status,
    };
  }

  function initClaudeForce(): CliRun {
    return runCli(['init', '--claude', '--force', '--yes', '--target', project]);
  }

  function refreshOwned(): CliRun {
    return runCli(['init', '--refresh-owned', '--target', project]);
  }

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `provisioner-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`
      );
    }
  });

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'prov-e2e-'));
    vault = join(sandbox, 'vault');
    project = join(sandbox, 'proj');
    mkdirSync(vault, { recursive: true });
    mkdirSync(project, { recursive: true });

    // A realistic fixture: a git repo with a package.json — the same shape the
    // IDE's provisioner sees when it opens a user project.
    const git = spawnSync('git', ['init', '-q'], { cwd: project, encoding: 'utf-8' });
    if (git.status !== 0) {
      throw new Error(`git init failed: ${git.stderr}`);
    }
    writeFileSync(join(project, 'package.json'), '{"name":"e2e-fixture"}\n');
  });

  afterEach(() => {
    // `init` fires a background derive, whose graphify child keeps writing into
    // `graphify-out/cache` after the CLI process has exited — it RE-CREATES the
    // directory, so retrying the delete cannot win the race, it can only lose it
    // more slowly. (The comment here used to blame the async brain-index build;
    // that build is gone and the straggler remained, which is how graphify was
    // identified as the real one.)
    //
    // Cleanup is therefore best-effort and NEVER the verdict on a test whose
    // assertions already passed. The straggler is a temp directory the OS
    // reaps; the failure it used to cause was pure noise.
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
    } catch (error) {
      console.warn(
        `[provisioner-e2e] sandbox cleanup lost the race with a background writer, leaving ${sandbox}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  it(
    '(a) init --claude --force --yes provisions the project AND a user-modified rules file survives a --force re-run byte-identical',
    () => {
      const first = initClaudeForce();
      expect(first.status).toBe(0);

      // Provisioned surface: flow/ (vault symlink or dir), .claude assets, CLAUDE.md.
      const flowPath = join(project, 'flow');
      expect(existsSync(flowPath)).toBe(true);
      const flowStat = lstatSync(flowPath);
      expect(flowStat.isSymbolicLink() || flowStat.isDirectory()).toBe(true);
      expect(existsSync(join(project, '.claude', 'commands'))).toBe(true);
      expect(existsSync(join(project, '.claude', 'resources'))).toBe(true);
      expect(existsSync(join(project, ...rulesRel))).toBe(true);
      expect(existsSync(join(project, 'CLAUDE.md'))).toBe(true);

      // Seed accumulated user pattern data, then re-run the EXACT provisioner
      // command (`--force`). The clobber fix must preserve it byte-identical.
      const rulesPath = join(project, ...rulesRel);
      const userContent =
        readFileSync(rulesPath, 'utf-8') + `\n\n${USER_PATTERN_MARKER}\n`;
      writeFileSync(rulesPath, userContent, 'utf-8');

      const second = initClaudeForce();
      expect(second.status).toBe(0);

      expect(readFileSync(rulesPath, 'utf-8')).toBe(userContent);
    },
    E2E_TIMEOUT_MS
  );

  it(
    '(b) init --refresh-owned restores a modified owned resource while the rules file and a custom .flowconfig key survive byte-identical',
    () => {
      expect(initClaudeForce().status).toBe(0);

      // User-accumulated pattern data.
      const rulesPath = join(project, ...rulesRel);
      const rulesContent =
        readFileSync(rulesPath, 'utf-8') + `\n\n${USER_PATTERN_MARKER}\n`;
      writeFileSync(rulesPath, rulesContent, 'utf-8');

      // Custom key in .flowconfig (flow/ resolves through the vault symlink).
      const flowconfigPath = join(project, ...flowconfigRel);
      const flowconfigContent = 'autopilot: true\ncustom_key: keep-me-verbatim\n';
      writeFileSync(flowconfigPath, flowconfigContent, 'utf-8');

      // Corrupt an owned resource — the refresh must restore package content.
      const resourcePath = join(project, ...resourceRel);
      const shippedResource = readFileSync(resourcePath, 'utf-8');
      writeFileSync(resourcePath, 'STALE OUTDATED CONTENT\n', 'utf-8');

      const refresh = refreshOwned();
      expect(refresh.status).toBe(0);
      expect(refresh.stdout).toContain('owned asset group(s) updated');

      // Owned resource restored to the shipped package content.
      expect(readFileSync(resourcePath, 'utf-8')).toBe(shippedResource);
      // Protected user data — byte-identical.
      expect(readFileSync(rulesPath, 'utf-8')).toBe(rulesContent);
      expect(readFileSync(flowconfigPath, 'utf-8')).toBe(flowconfigContent);
    },
    E2E_TIMEOUT_MS
  );

  it(
    '(c) running refresh twice is idempotent — identical stdout and identical owned bytes',
    () => {
      expect(initClaudeForce().status).toBe(0);

      const first = refreshOwned();
      expect(first.status).toBe(0);
      const ownedDir = join(project, '.claude', 'resources');
      const filesAfterFirst = listFilesRecursive(ownedDir).sort();
      const bytesAfterFirst = filesAfterFirst.map((f) =>
        readFileSync(join(ownedDir, f), 'utf-8')
      );

      const second = refreshOwned();
      expect(second.status).toBe(0);

      // Identical output…
      expect(second.stdout).toBe(first.stdout);
      // …and identical owned bytes across the whole resources group.
      const filesAfterSecond = listFilesRecursive(ownedDir).sort();
      expect(filesAfterSecond).toEqual(filesAfterFirst);
      filesAfterSecond.forEach((f, i) => {
        expect(readFileSync(join(ownedDir, f), 'utf-8')).toBe(bytesAfterFirst[i]);
      });
    },
    E2E_TIMEOUT_MS
  );

  it(
    'refresh refuses (exit 1) on a project with no plan-flow install, writing nothing',
    () => {
      // No init — bare git fixture.
      const refused = refreshOwned();
      expect(refused.status).toBe(1);
      // The CLI logger writes errors via console.log (stdout) — assert on the
      // combined transcript, which is what a user actually sees.
      expect(refused.stdout + refused.stderr).toContain(
        'no existing plan-flow install to refresh'
      );
      expect(existsSync(join(project, '.claude'))).toBe(false);
    },
    E2E_TIMEOUT_MS
  );
});
