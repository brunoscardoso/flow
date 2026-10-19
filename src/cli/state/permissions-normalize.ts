/**
 * Command-family normalizer for the permissions-suggest verb.
 *
 * Pure, fs-free string logic: collapses a raw approved Bash invocation into
 * the conservative "family" it belongs to, so distinct approvals of
 * `git status -sb` and `git status` count toward the same allow rule.
 *
 * The guiding rule is "when in doubt, leave it out": any input whose family
 * cannot be determined safely (shell chaining, substitution, unparseable
 * tokens) normalizes to `null` and is simply never suggested — a false
 * negative costs one extra prompt, a false positive widens the allowlist.
 */

/**
 * CLIs whose first argument is a subcommand that materially changes what the
 * command does (`git status` vs `git push`). For these, the family is two
 * tokens; a one-token family like `Bash(git *)` would be far too broad.
 */
const SUBCOMMAND_CLIS = new Set([
  'git',
  'gh',
  'npm',
  'yarn',
  'pnpm',
  'cargo',
  'docker',
  'kubectl',
]);

/**
 * Shell constructs that make a command compound or dynamic: chaining
 * (`&&`, `||`, `;`), pipes (`|`), command substitution (`$(`, backticks),
 * and multi-line input. `|` subsumes `||`. A family mined from only the
 * first segment would silently also allow everything after the operator.
 */
const SHELL_CHAIN_MARKERS = ['&&', '||', ';', '|', '$(', '`', '\n'];

/** Leading environment assignment token, e.g. `FOO=bar` in `FOO=bar cmd`. */
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/** A token safe to serve as a command or subcommand inside an allow rule. */
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_@.:+/-]+$/;

/**
 * Normalize a raw Bash command into its conservative family.
 *
 * - Strips leading env assignments (`FOO=bar cmd` -> `cmd`).
 * - Returns a two-token family when the first token is a subcommand CLI
 *   (`git status -sb` -> `git status`), the first token alone otherwise
 *   (`ls -la` -> `ls`).
 * - Returns `null` for empty/unparseable input, shell-chained/dynamic input
 *   (see `SHELL_CHAIN_MARKERS`), or a subcommand CLI whose subcommand is
 *   missing or flag-shaped (`git -C /x status` is not safely `git -C`).
 */
export function normalizeBashFamily(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === '') {
    return null;
  }

  if (SHELL_CHAIN_MARKERS.some((marker) => trimmed.includes(marker))) {
    return null;
  }

  const tokens = trimmed.split(/\s+/);

  let index = 0;
  while (index < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[index])) {
    index += 1;
  }

  const first = tokens[index];
  if (first === undefined || !SAFE_TOKEN_PATTERN.test(first)) {
    return null;
  }

  if (!SUBCOMMAND_CLIS.has(first)) {
    return first;
  }

  const second = tokens[index + 1];
  if (second === undefined || second.startsWith('-') || !SAFE_TOKEN_PATTERN.test(second)) {
    return null;
  }

  return `${first} ${second}`;
}

/**
 * Render a normalized family as a `.claude/settings.json` allow rule.
 *
 * - Bash families get a trailing ` *` so the rule covers the family's
 *   arguments (`Bash(git status *)`).
 * - WebFetch families shaped `domain:<host>` map to the host-scoped rule
 *   Claude Code natively understands (`WebFetch(domain:example.com)`).
 * - Anything else falls back to the generic `<Tool>(<family>)` shape.
 */
export function renderAllowRule(tool: string, family: string): string {
  if (tool === 'Bash') {
    return `Bash(${family} *)`;
  }
  if (tool === 'WebFetch' && family.startsWith('domain:')) {
    return `WebFetch(${family})`;
  }
  return `${tool}(${family})`;
}
