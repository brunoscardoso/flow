/**
 * Trailing comments in this project's line-oriented config files (#1804).
 *
 * `loops/*.md` frontmatter and `flow/.flowconfig` are both `key: value` per
 * line, and both are files people annotate — the shipped `loops/fix.md` carries
 * `paused: false  # 2026-08-17: resumed at user request …`. The directive
 * parser has stripped such comments since it was written; `.flowconfig` did not,
 * and the split was invisible because it depended on the value's TYPE: booleans
 * and numbers captured `(true|false)` and `(\d+)`, which stop at the value,
 * while strings captured `(.+)` to end of line.
 *
 * So one file tolerated comments on some keys and corrupted others, with
 * nothing saying which. `branch: main   # the default base` became a PR base of
 * `"main   # the default base"` — offered to the human as the branch to open
 * against and passed to `gh pr create --base`, where no branch by that name
 * exists.
 *
 * ONE RULE, BOTH PARSERS (allowed-pattern #14). This is the same class of
 * defect the string extractor was already fixed for once: that fix bounded how
 * the capture STARTS (forbidden-pattern #16, a blank key swallowing the next
 * line); this bounds where it ENDS.
 */

/**
 * Strip a trailing `# …` comment.
 *
 * Only a comment introduced by WHITESPACE is stripped, so a value that
 * legitimately contains `#` — a URL fragment, a Slack channel, a colour —
 * survives. Every annotated example in either grammar is `value   # note`.
 */
export function stripTrailingComment(value: string): string {
  return value.replace(/\s+#.*$/, '');
}
