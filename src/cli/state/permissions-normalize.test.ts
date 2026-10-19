/**
 * Unit tests for the permissions-suggest command-family normalizer.
 *
 * Pure string logic — no fs, no mocks. Covers the two-token family rule for
 * every subcommand CLI, the first-token default, env-prefix stripping, every
 * shell-chain marker (all → null, "when in doubt, leave it out"), the
 * flag-shaped/missing subcommand refusals, and all three renderAllowRule
 * shapes (Bash, WebFetch domain, generic fallback).
 */

const { normalizeBashFamily, renderAllowRule } = await import('./permissions-normalize.js');

describe('normalizeBashFamily', () => {
  describe('two-token families for subcommand CLIs', () => {
    const cases: Array<[string, string]> = [
      ['git status -sb', 'git status'],
      ['gh pr view 42', 'gh pr'],
      ['npm run build', 'npm run'],
      ['yarn test --watch', 'yarn test'],
      ['pnpm run lint', 'pnpm run'],
      ['cargo build --release', 'cargo build'],
      ['docker ps -a', 'docker ps'],
      ['kubectl get pods', 'kubectl get'],
    ];

    it.each(cases)('%s → %s', (command, family) => {
      expect(normalizeBashFamily(command)).toBe(family);
    });
  });

  describe('first-token default for everything else', () => {
    it('collapses a plain command with flags to its first token', () => {
      expect(normalizeBashFamily('ls -la')).toBe('ls');
    });

    it('collapses a non-subcommand CLI with arguments to its first token', () => {
      expect(normalizeBashFamily('tsc --noEmit src/index.ts')).toBe('tsc');
    });

    it('handles a bare single-token command', () => {
      expect(normalizeBashFamily('pwd')).toBe('pwd');
    });
  });

  describe('leading env assignment stripping', () => {
    it('strips a single env assignment', () => {
      expect(normalizeBashFamily('FOO=bar git status')).toBe('git status');
    });

    it('strips multiple env assignments', () => {
      expect(normalizeBashFamily('A=1 B_2=two ls -la')).toBe('ls');
    });

    it('returns null when the input is ONLY env assignments', () => {
      expect(normalizeBashFamily('FOO=bar BAZ=qux')).toBeNull();
    });
  });

  describe('shell chain / dynamic markers — every marker → null', () => {
    const chained: Array<[string, string]> = [
      ['&&', 'git status && git push'],
      ['||', 'ls || echo fail'],
      [';', 'ls; rm -rf /'],
      ['|', 'cat file | grep x'],
      ['$(', 'echo $(whoami)'],
      ['backtick', 'echo `whoami`'],
      ['newline', 'ls\nrm -rf /'],
    ];

    it.each(chained)('%s marker → null', (_name, command) => {
      expect(normalizeBashFamily(command)).toBeNull();
    });
  });

  describe('unparseable / unsafe input → null', () => {
    it('returns null for empty input', () => {
      expect(normalizeBashFamily('')).toBeNull();
    });

    it('returns null for whitespace-only input', () => {
      expect(normalizeBashFamily('   ')).toBeNull();
    });

    it('returns null for an unsafe first token', () => {
      expect(normalizeBashFamily('"quoted command"')).toBeNull();
    });

    it('returns null for a subcommand CLI with a flag-shaped subcommand', () => {
      expect(normalizeBashFamily('git -C /x status')).toBeNull();
    });

    it('returns null for a subcommand CLI with no subcommand at all', () => {
      expect(normalizeBashFamily('git')).toBeNull();
    });

    it('returns null for a subcommand CLI whose subcommand is unsafe', () => {
      expect(normalizeBashFamily('npm "run"')).toBeNull();
    });
  });
});

describe('renderAllowRule', () => {
  it('renders Bash families with a trailing wildcard', () => {
    expect(renderAllowRule('Bash', 'git status')).toBe('Bash(git status *)');
  });

  it('renders WebFetch domain families in the host-scoped native shape', () => {
    expect(renderAllowRule('WebFetch', 'domain:example.com')).toBe(
      'WebFetch(domain:example.com)'
    );
  });

  it('falls back to the generic shape for a WebFetch family without domain:', () => {
    expect(renderAllowRule('WebFetch', 'example.com')).toBe('WebFetch(example.com)');
  });

  it('falls back to the generic <Tool>(<family>) shape for other tools', () => {
    expect(renderAllowRule('Read', 'src/**')).toBe('Read(src/**)');
  });
});
