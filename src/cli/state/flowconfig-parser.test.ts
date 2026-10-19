/**
 * Tests for flowconfig parser
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFlowConfig } from './flowconfig-parser.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'plan-flow-flowconfig-test-'));
}

describe('parseFlowConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return all defaults when no .flowconfig exists', () => {
    const config = parseFlowConfig(tempDir);
    expect(config).toEqual({
      autopilot: false,
      commit: false,
      push: false,
      pr: false,
      pr_draft: false,
      guarded_autopilot: false,
      branch: '',
      remote: 'origin',
      base_refresh: true,
      wave_execution: true,
      phase_isolation: true,
      model_routing: true,
      max_verify_retries: 2,
      walkthrough_model: 'sonnet',
    });
  });

  it('should parse a complete .flowconfig with all keys', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      [
        'autopilot: true',
        'commit: true',
        'push: true',
        'pr: false',
        'pr_draft: true',
        'guarded_autopilot: true',
        'branch: feature/test',
        'wave_execution: false',
        'phase_isolation: false',
        'model_routing: true',
        'max_verify_retries: 4',
        'walkthrough_model: opus',
      ].join('\n'),
    );

    const config = parseFlowConfig(tempDir);
    expect(config).toEqual({
      autopilot: true,
      commit: true,
      push: true,
      pr: false,
      pr_draft: true,
      guarded_autopilot: true,
      branch: 'feature/test',
      remote: 'origin',
      base_refresh: true,
      wave_execution: false,
      phase_isolation: false,
      model_routing: true,
      max_verify_retries: 4,
      walkthrough_model: 'opus',
    });
  });

  it('reads an unknown walkthrough model as the default rather than passing it on', () => {
    // The value becomes a sub-agent's model; a typo must not name one nobody offers.
    writeFileSync(join(tempDir, '.flowconfig'), 'walkthrough_model: gpt-9\n');
    expect(parseFlowConfig(tempDir).walkthrough_model).toBe('sonnet');
    writeFileSync(join(tempDir, '.flowconfig'), 'walkthrough_model: haiku   # cheapest\n');
    expect(parseFlowConfig(tempDir).walkthrough_model).toBe('haiku');
  });

  it('parses the provider key (multi_runtime_support) as a per-project override', () => {
    writeFileSync(join(tempDir, '.flowconfig'), 'provider: codex\n');
    expect(parseFlowConfig(tempDir).provider).toBe('codex');
  });

  it('leaves provider undefined when the key is absent (falls back to the global default)', () => {
    writeFileSync(join(tempDir, '.flowconfig'), 'autopilot: true\n');
    expect(parseFlowConfig(tempDir).provider).toBeUndefined();
  });

  it('should apply defaults for missing keys in partial .flowconfig', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'autopilot: true\ncommit: true\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.autopilot).toBe(true);
    expect(config.commit).toBe(true);
    expect(config.push).toBe(false);
    expect(config.branch).toBe('');
    expect(config.wave_execution).toBe(true);
    expect(config.phase_isolation).toBe(true);
    expect(config.model_routing).toBe(true);
    expect(config.max_verify_retries).toBe(2);
  });

  it('should use legacy .autopilot file when .flowconfig is absent', () => {
    writeFileSync(join(tempDir, '.autopilot'), '');

    const config = parseFlowConfig(tempDir);
    expect(config.autopilot).toBe(true);
  });

  it('should use legacy .autopilot file when autopilot key is absent from .flowconfig', () => {
    writeFileSync(join(tempDir, '.flowconfig'), 'commit: true\n');
    writeFileSync(join(tempDir, '.autopilot'), '');

    const config = parseFlowConfig(tempDir);
    expect(config.autopilot).toBe(true);
    expect(config.commit).toBe(true);
  });

  it('should use legacy .gitcontrol for git settings when .flowconfig is absent', () => {
    writeFileSync(
      join(tempDir, '.gitcontrol'),
      'commit: true\npush: true\nbranch: legacy-branch\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.commit).toBe(true);
    expect(config.push).toBe(true);
    expect(config.branch).toBe('legacy-branch');
  });

  it('should use legacy .gitcontrol fallback for missing git keys in .flowconfig', () => {
    writeFileSync(join(tempDir, '.flowconfig'), 'autopilot: false\n');
    writeFileSync(
      join(tempDir, '.gitcontrol'),
      'commit: true\npush: true\nbranch: from-gitcontrol\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.autopilot).toBe(false);
    expect(config.commit).toBe(true);
    expect(config.push).toBe(true);
    expect(config.branch).toBe('from-gitcontrol');
  });

  it('should handle corrupt .flowconfig content gracefully', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      '!!@#$%^&*()_corrupt_content_here\n\x00\x01\x02',
    );

    const config = parseFlowConfig(tempDir);
    // Should fall back to defaults for all unrecognized content
    expect(config.autopilot).toBe(false);
    expect(config.wave_execution).toBe(true);
  });

  it('should clamp max_verify_retries below minimum to 1', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'max_verify_retries: 0\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.max_verify_retries).toBe(1);
  });

  it('should clamp max_verify_retries above maximum to 5', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'max_verify_retries: 10\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.max_verify_retries).toBe(5);
  });

  it('should prefer .flowconfig values over legacy files', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'autopilot: false\ncommit: false\n',
    );
    writeFileSync(join(tempDir, '.autopilot'), '');
    writeFileSync(join(tempDir, '.gitcontrol'), 'commit: true\n');

    const config = parseFlowConfig(tempDir);
    expect(config.autopilot).toBe(false);
    expect(config.commit).toBe(false);
  });

  it('should handle empty .flowconfig file', () => {
    writeFileSync(join(tempDir, '.flowconfig'), '');

    const config = parseFlowConfig(tempDir);
    // All defaults
    expect(config.autopilot).toBe(false);
    expect(config.wave_execution).toBe(true);
    expect(config.phase_isolation).toBe(true);
  });

  it('should return pr_draft: false by default and read pr_draft: true (#655)', () => {
    writeFileSync(join(tempDir, '.flowconfig'), 'pr: true\n');
    expect(parseFlowConfig(tempDir).pr_draft).toBe(false);

    writeFileSync(join(tempDir, '.flowconfig'), 'pr: true\npr_draft: true\n');
    expect(parseFlowConfig(tempDir).pr_draft).toBe(true);
  });

  it('should return guarded_autopilot false by default and read true (#653)', () => {
    writeFileSync(join(tempDir, '.flowconfig'), 'autopilot: true\n');
    expect(parseFlowConfig(tempDir).guarded_autopilot).toBe(false);

    writeFileSync(join(tempDir, '.flowconfig'), 'guarded_autopilot: true\n');
    expect(parseFlowConfig(tempDir).guarded_autopilot).toBe(true);
  });

  it('should return pr: false by default when key is missing', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'autopilot: false\ncommit: false\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.pr).toBe(false);
  });

  it('should read pr: true from .flowconfig', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'commit: true\npush: true\npr: true\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.pr).toBe(true);
  });

  it('should auto-enable push and commit when pr is true', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'pr: true\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.pr).toBe(true);
    expect(config.push).toBe(true);
    expect(config.commit).toBe(true);
  });

  it('should not affect push/commit when pr is false', () => {
    writeFileSync(
      join(tempDir, '.flowconfig'),
      'pr: false\ncommit: false\npush: false\n',
    );

    const config = parseFlowConfig(tempDir);
    expect(config.pr).toBe(false);
    expect(config.push).toBe(false);
    expect(config.commit).toBe(false);
  });

  describe('engines dotted keys', () => {
    it('should parse engines.<name> keys into config.engines', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'engines.lavish: enabled\nengines.gnhf: declined\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toEqual({ lavish: 'enabled', gnhf: 'declined' });
    });

    it('should ignore invalid engine values', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'engines.bad: banana\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toBeUndefined();
    });

    it('should ignore invalid engine values while keeping valid ones', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'engines.lavish: enabled\nengines.bad: banana\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toEqual({ lavish: 'enabled' });
    });

    it('should not leak a value from the next line into an empty engines key', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'engines.a:\ndeclined\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toBeUndefined();
    });

    it('should parse the pending engine value', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'engines.graphify: pending\nengines.lavish: enabled\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toEqual({ graphify: 'pending', lavish: 'enabled' });
    });

    it('should parse engines.graphify_migration_asked as a boolean', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'engines.graphify: declined\nengines.graphify_migration_asked: true\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toEqual({ graphify: 'declined' });
      expect(config.graphify_migration_asked).toBe(true);
    });

    it('should leave graphify_migration_asked undefined when not recorded', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'engines.graphify: enabled\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.graphify_migration_asked).toBeUndefined();
    });
  });

  describe('commands dotted keys', () => {
    it('should parse commands.lint into config.commands.lint', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'commands.lint: npm run lint\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.commands).toEqual({ lint: 'npm run lint' });
    });

    it('should leave commands undefined for empty commands.lint and still parse the next key', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'commands.lint:\nautopilot: true\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.commands).toBeUndefined();
      expect(config.autopilot).toBe(true);
    });

    it('should leave commands undefined for empty commands.lint at end of file', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'commands.lint:',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.commands).toBeUndefined();
    });

    it('should parse a colon-containing commands.lint value fully', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'commands.lint: docker run img:tag lint\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.commands).toEqual({ lint: 'docker run img:tag lint' });
    });
  });

  describe('dotted keys — backward compatibility', () => {
    it('should ignore unknown dotted prefixes', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'other.thing: x\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toBeUndefined();
      expect(config.commands).toBeUndefined();
    });

    it('should leave engines and commands undefined when no dotted keys exist', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        'autopilot: true\ncommit: true\n',
      );

      const config = parseFlowConfig(tempDir);
      expect(config.engines).toBeUndefined();
      expect(config.commands).toBeUndefined();
    });

    it('should parse flat keys alongside dotted keys', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        [
          'autopilot: true',
          'commit: true',
          'model_routing: true',
          'engines.lavish: enabled',
          'commands.lint: npm run lint',
        ].join('\n'),
      );

      const config = parseFlowConfig(tempDir);
      expect(config.autopilot).toBe(true);
      expect(config.commit).toBe(true);
      expect(config.model_routing).toBe(true);
      expect(config.engines).toEqual({ lavish: 'enabled' });
      expect(config.commands).toEqual({ lint: 'npm run lint' });
    });
  });

  /**
   * The two keys thread_remote_binding added — and the newline leak that
   * reading them exposed in every string key the file already had.
   */
  /**
   * #1804 — a trailing comment is not part of the value, on ANY key type.
   *
   * `extractString` captured `(.+)` to end of line, so `branch: main   # note`
   * parsed as `"main   # note"`. Its boolean and number siblings never had the
   * problem, because `(true|false)` and `(\d+)` stop at the value — so the same
   * file tolerated comments on some keys and corrupted others, with nothing
   * telling the user which. Trailing comments are an established convention
   * here: the shipped `loops/fix.md` carries them and the directive parser has
   * stripped them since it was written.
   *
   * The consequence was not cosmetic. `branch` is the project's default base
   * for both the worktree cut and the PR; it reaches the `unbound` refusal
   * payload, which is the object the execute-plan skill turns into the human's
   * question and then passes to `gh pr create --base`. No branch named
   * `main   # note` exists.
   */
  describe('trailing comments (#1804)', () => {
    function write(...lines: string[]): void {
      writeFileSync(join(tempDir, '.flowconfig'), `${lines.join('\n')}\n`);
    }

    it('strips a trailing comment from a STRING value', () => {
      write('branch: main   # the default base');
      expect(parseFlowConfig(tempDir).branch).toBe('main');
    });

    it('strips it from every key type in one file, not just some', () => {
      // The asymmetry IS the bug: a user annotating four keys got two values
      // and two corruptions, with nothing saying which was which.
      write(
        'autopilot: true    # a boolean',
        'max_verify_retries: 3   # a number',
        'branch: main   # a string',
        'remote: upstream   # another string',
        'commands.lint: npm run lint   # a dotted key',
      );
      const config = parseFlowConfig(tempDir);
      expect({
        autopilot: config.autopilot,
        retries: config.max_verify_retries,
        branch: config.branch,
        remote: config.remote,
        lint: config.commands?.lint,
      }).toEqual({
        autopilot: true,
        retries: 3,
        branch: 'main',
        remote: 'upstream',
        lint: 'npm run lint',
      });
    });

    it('keeps a `#` the value legitimately contains', () => {
      // Only a comment introduced by WHITESPACE is one — a pattern, a URL
      // fragment and a colour all carry a `#` that is part of the value.
      write('remote_branch_pattern: feature/{ticket}#{slug}');
      expect(parseFlowConfig(tempDir).remote_branch_pattern).toBe('feature/{ticket}#{slug}');
    });

    it('reads a key left blank but ANNOTATED as not configured', () => {
      // The nastiest shape, and the one this extractor was already narrowed
      // once to prevent (forbidden-pattern #16): a key somebody deliberately
      // left undecided, with a note saying so, silently naming a destination
      // nobody wrote. `branch` falls back to its default rather than becoming
      // a base branch called "# not decided yet".
      write('branch:   # not decided yet');
      expect(parseFlowConfig(tempDir).branch).toBe('');

      write('remote:   # ask first');
      expect(parseFlowConfig(tempDir).remote).toBe('origin');

      write('commands.lint:   # nothing configured yet');
      expect(parseFlowConfig(tempDir).commands?.lint).toBeUndefined();
    });

    it('still refuses to swallow the NEXT LINE, comment or not', () => {
      // The earlier half of the same defect must stay fixed: this bounds where
      // the capture ENDS, and that one bounded where it STARTS.
      write('remote:   # undecided', 'branch: develop');
      const config = parseFlowConfig(tempDir);
      expect(config.remote).toBe('origin');
      expect(config.branch).toBe('develop');
    });
  });

  describe('remote binding keys (thread_remote_binding)', () => {
    it('defaults the remote to origin when nothing says otherwise', () => {
      expect(parseFlowConfig(tempDir).remote).toBe('origin');
      writeFileSync(join(tempDir, '.flowconfig'), 'branch: main\n');
      expect(parseFlowConfig(tempDir).remote).toBe('origin');
    });

    it('reads an overridden remote', () => {
      writeFileSync(join(tempDir, '.flowconfig'), 'remote: upstream\n');
      expect(parseFlowConfig(tempDir).remote).toBe('upstream');
    });

    it('reads a blank remote as NOT CONFIGURED, not as the empty remote', () => {
      // A remote named `''` reaches `git push` as a missing argument; the
      // default is the only safe reading of a key somebody left blank.
      writeFileSync(join(tempDir, '.flowconfig'), 'remote:\n');
      expect(parseFlowConfig(tempDir).remote).toBe('origin');
    });

    it('leaves remote_branch_pattern unset when it is absent or blank', () => {
      // Unset matters: the suggestion ladder skips its first rung on an absent
      // pattern, and would otherwise try to fill an empty string and propose
      // a branch with no name.
      expect(parseFlowConfig(tempDir).remote_branch_pattern).toBeUndefined();
      writeFileSync(join(tempDir, '.flowconfig'), 'remote_branch_pattern:\n');
      expect(parseFlowConfig(tempDir).remote_branch_pattern).toBeUndefined();
    });

    it('reads a configured remote_branch_pattern verbatim, placeholders and all', () => {
      writeFileSync(join(tempDir, '.flowconfig'), 'remote_branch_pattern: feature/{ticket}\n');
      expect(parseFlowConfig(tempDir).remote_branch_pattern).toBe('feature/{ticket}');
    });

    it('reads both keys together', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        ['remote: upstream', 'remote_branch_pattern: {user}/{slug}'].join('\n'),
      );
      const config = parseFlowConfig(tempDir);
      expect(config.remote).toBe('upstream');
      expect(config.remote_branch_pattern).toBe('{user}/{slug}');
    });

    it('does not let a blank remote swallow the NEXT LINE as its value', () => {
      // The regression: with `\s*` after the colon, a key left blank matched
      // across the newline and read `remote_branch_pattern:` as the remote's
      // name. A config key that silently names a destination nobody wrote is
      // the same class of bug as an unbound push.
      writeFileSync(
        join(tempDir, '.flowconfig'),
        ['remote:', 'remote_branch_pattern: feature/{ticket}'].join('\n'),
      );
      const config = parseFlowConfig(tempDir);
      expect(config.remote).toBe('origin');
      expect(config.remote).not.toContain('remote_branch_pattern');
      // …and the key that WAS written still reads.
      expect(config.remote_branch_pattern).toBe('feature/{ticket}');
    });

    it('does not let a blank branch swallow the next line as the project base', () => {
      // The same leak, one key over, and the more dangerous of the two: a base
      // branch nobody wrote is the branch a pull request opens against.
      writeFileSync(
        join(tempDir, '.flowconfig'),
        ['branch:', 'remote: upstream'].join('\n'),
      );
      const config = parseFlowConfig(tempDir);
      expect(config.branch).toBe('');
      expect(config.remote).toBe('upstream');
    });

    it('does not read `remote_branch_pattern` as if it were `remote`', () => {
      // `extractString` anchors at the line start and requires the colon
      // immediately after the key, so the longer key cannot be matched by the
      // shorter one's pattern.
      writeFileSync(join(tempDir, '.flowconfig'), 'remote_branch_pattern: feature/{ticket}\n');
      expect(parseFlowConfig(tempDir).remote).toBe('origin');
    });
  });
  describe('the worktree defaults (worktree_settings_ui)', () => {
    // Three OPTIONAL layers. Absent means the project has no opinion and the
    // IDE's resolver falls through to the person's default and then to the
    // built-in — which is today's behaviour, so absence must never read as a
    // value and a value must never be silently rewritten here.

    it('leaves worktree_start unset when the project has never named one', () => {
      expect(parseFlowConfig(tempDir).worktree_start).toBeUndefined();
      writeFileSync(join(tempDir, '.flowconfig'), 'worktree_start:\n');
      expect(parseFlowConfig(tempDir).worktree_start).toBeUndefined();
    });

    it('reads a worktree_start verbatim, including the one that names a branch', () => {
      writeFileSync(join(tempDir, '.flowconfig'), 'worktree_start: here\n');
      expect(parseFlowConfig(tempDir).worktree_start).toBe('here');
      writeFileSync(join(tempDir, '.flowconfig'), 'worktree_start: trunk\n');
      expect(parseFlowConfig(tempDir).worktree_start).toBe('trunk');
      writeFileSync(join(tempDir, '.flowconfig'), 'worktree_start: branch:release/2.0\n');
      expect(parseFlowConfig(tempDir).worktree_start).toBe('branch:release/2.0');
    });

    it('does not enum-check a worktree_start it does not recognise', () => {
      // The resolver reports what it cannot use; a parser that dropped it here
      // would take away the layer that can say so (allowed-pattern #22).
      writeFileSync(join(tempDir, '.flowconfig'), 'worktree_start: sideways\n');
      expect(parseFlowConfig(tempDir).worktree_start).toBe('sideways');
    });

    it('defaults base_refresh ON, absent or blank', () => {
      expect(parseFlowConfig(tempDir).base_refresh).toBe(true);
      writeFileSync(join(tempDir, '.flowconfig'), 'base_refresh:\n');
      expect(parseFlowConfig(tempDir).base_refresh).toBe(true);
    });

    it('turns base_refresh off for the literal false and nothing else', () => {
      // The failure mode of guessing "off" is a safeguard that quietly stops
      // running, so only the word turns it off.
      writeFileSync(join(tempDir, '.flowconfig'), 'base_refresh: false\n');
      expect(parseFlowConfig(tempDir).base_refresh).toBe(false);
      writeFileSync(join(tempDir, '.flowconfig'), 'base_refresh: true\n');
      expect(parseFlowConfig(tempDir).base_refresh).toBe(true);
      for (const raw of ['no', 'off', '0', 'False']) {
        writeFileSync(join(tempDir, '.flowconfig'), `base_refresh: ${raw}\n`);
        expect(parseFlowConfig(tempDir).base_refresh).toBe(true);
      }
    });

    it('reads base_refresh_timeout_ms UNCLAMPED — the resolver owns the bounds', () => {
      writeFileSync(join(tempDir, '.flowconfig'), 'base_refresh_timeout_ms: 12000\n');
      expect(parseFlowConfig(tempDir).base_refresh_timeout_ms).toBe(12000);
      // A hand-edited 600000 reaches the layer that clamps it, rather than
      // being quietly rewritten by the one that only reads the file.
      writeFileSync(join(tempDir, '.flowconfig'), 'base_refresh_timeout_ms: 600000\n');
      expect(parseFlowConfig(tempDir).base_refresh_timeout_ms).toBe(600000);
      writeFileSync(join(tempDir, '.flowconfig'), 'base_refresh_timeout_ms: 0\n');
      expect(parseFlowConfig(tempDir).base_refresh_timeout_ms).toBe(0);
    });

    it('leaves a wait that is not a number unset', () => {
      for (const raw of ['', 'soon', '8s', '-1', '2.5']) {
        writeFileSync(join(tempDir, '.flowconfig'), `base_refresh_timeout_ms: ${raw}\n`);
        const parsed = parseFlowConfig(tempDir).base_refresh_timeout_ms;
        // `2.5` reads as the digits before the dot or as nothing; either way it
        // is never the fractional value, which no timer could take.
        expect(parsed === undefined || Number.isInteger(parsed)).toBe(true);
        expect(parsed).not.toBe(2.5);
      }
    });

    it('reads all three together, beside the keys that were already there', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        [
          'remote: upstream',
          'branch: develop',
          'worktree_start: trunk',
          'base_refresh: false',
          'base_refresh_timeout_ms: 3000',
        ].join('\n'),
      );
      const config = parseFlowConfig(tempDir);
      expect(config.remote).toBe('upstream');
      expect(config.branch).toBe('develop');
      expect(config.worktree_start).toBe('trunk');
      expect(config.base_refresh).toBe(false);
      expect(config.base_refresh_timeout_ms).toBe(3000);
    });

    it('does not let a blank worktree_start swallow the next line', () => {
      // Forbidden-pattern #16, one key further along: with `\s*` after the
      // colon a key left blank reads its neighbour's value as its own.
      writeFileSync(
        join(tempDir, '.flowconfig'),
        ['worktree_start:', 'branch: develop'].join('\n'),
      );
      const config = parseFlowConfig(tempDir);
      expect(config.worktree_start).toBeUndefined();
      expect(config.branch).toBe('develop');
    });

    it('does not let a blank base_refresh take the next line as its answer', () => {
      writeFileSync(join(tempDir, '.flowconfig'), ['base_refresh:', 'push: false'].join('\n'));
      const config = parseFlowConfig(tempDir);
      expect(config.base_refresh).toBe(true); // the default, not `false`
      expect(config.push).toBe(false);
    });

    it('does not let a blank wait become the next key\u2019s number', () => {
      writeFileSync(
        join(tempDir, '.flowconfig'),
        ['base_refresh_timeout_ms:', 'max_verify_retries: 2'].join('\n'),
      );
      const config = parseFlowConfig(tempDir);
      expect(config.base_refresh_timeout_ms).toBeUndefined();
      expect(config.max_verify_retries).toBe(2);
    });

    it('does not read `base_refresh_timeout_ms` as if it were `base_refresh`', () => {
      writeFileSync(join(tempDir, '.flowconfig'), 'base_refresh_timeout_ms: 3000\n');
      const config = parseFlowConfig(tempDir);
      expect(config.base_refresh).toBe(true);
      expect(config.base_refresh_timeout_ms).toBe(3000);
    });
  });
});
