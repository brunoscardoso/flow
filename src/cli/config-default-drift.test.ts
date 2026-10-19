/**
 * Config-default drift lock (#1824).
 *
 * A default is READ from one place — `DEFAULT_CONFIG` in
 * `src/cli/state/flowconfig-parser.ts` — and RESTATED by hand in seven shipped,
 * agent-loaded surfaces. Two of them had drifted to the opposite value:
 * `templates/shared/CLAUDE.md.template` (spliced into every provisioned
 * project's `CLAUDE.md`) and `.claude/commands/execute-plan.md` both announced
 * `model_routing: true … (default)` while the parser defaults it to `false`.
 *
 * That is not cosmetic. Both live in always-loaded project instructions, so an
 * agent reading them concludes a complexity-3 phase will run on haiku and
 * reasons about scope and cost accordingly — while the phase actually runs on
 * opus. This repo's own CLAUDE.md carried BOTH claims, forty lines apart, with
 * nothing to say which governed.
 *
 * The general problem the item named is that nothing stopped the next drift.
 * This test is that stop: it greps the real shipped files for a claim that
 * contradicts the resolved default, so restating a default wrongly fails CI rather
 * than shipping into user projects.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseFlowConfig } from './state/flowconfig-parser.js';

/**
 * The defaults as the CLI actually resolves them.
 *
 * Read through `parseFlowConfig` on an empty directory rather than by importing
 * the constant: what the docs must agree with is the value a project really
 * gets, so a change in how defaults are applied is caught too, not only a
 * change to the literal.
 */
const RESOLVED_DEFAULTS = parseFlowConfig(mkdtempSync(join(tmpdir(), 'flowconfig-defaults-')));

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location (src/cli/ → ../../). */
const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Every shipped surface that states a config default in prose.
 *
 * `CLAUDE.md` is here because the template is spliced INTO it, so a stale
 * generated section shows up in this repo before it reaches anyone else's.
 */
const DOC_SURFACES = [
  'templates/shared/CLAUDE.md.template',
  'CLAUDE.md',
  'README.md',
  '.claude/commands/execute-plan.md',
  '.claude/commands/flow.md',
  '.claude/resources/core/model-routing.md',
  '.claude/resources/skills/execute-plan-skill.md',
] as const;

/**
 * Boolean keys whose default is restated in prose, and the phrase that would
 * only be written if the author believed the opposite of `DEFAULT_CONFIG`.
 *
 * The claim is deliberately narrow — "<key>: <wrong value>` in `flow/.flowconfig`
 * (default)" — because these docs legitimately mention both values of a key all
 * the time. What must never appear is the WRONG one labelled as the default.
 */
const KEYS_STATED_IN_PROSE = ['model_routing', 'autopilot', 'commit', 'push', 'pr'] as const;

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

/**
 * Lines that state the WRONG value of `key` as its default.
 *
 * The first cut of this check was ONE exact sentence — the shape the two
 * surfaces in #1824 happened to use. That is why flipping `model_routing`'s
 * default in #1957 left eight shipped surfaces announcing the old value while
 * this guard stayed green: not one of them wrote that sentence. They wrote
 * "(default: `false`)", "default: false", "Routing is opt-in (default:
 * `false`…)" and a README table row.
 *
 * So the window is the LINE and the claim must be adjacent to the word
 * "default" — every surface here states a key's default on the key's own line,
 * and requiring adjacency keeps a neighbouring key's honest default from
 * reading as this key's wrong one.
 */
function offendingLines(source: string, key: string, wrong: string): string[] {
  const mentionsKey = new RegExp(`\\b${key}\\b`);
  // `default: false` · `(default: \`false\`)` · `defaults to false` · `default is false`
  const claimsWrong = new RegExp(
    `default(?:s)?(?:\\s+(?:to|is))?:?\\s*\`?${wrong}\`?\\b`,
    'i',
  );
  // A settings table whose header column is "Default": `| \`key\` | \`true/false\` | \`false\` |`
  const tableRow = new RegExp(`^\\|\\s*\`${key}\`\\s*\\|[^|]*\\|\\s*\`?${wrong}\`?\\s*\\|`);

  return source
    .split('\n')
    .filter((line) => (mentionsKey.test(line) && claimsWrong.test(line)) || tableRow.test(line));
}

describe('config defaults stated in shipped docs match DEFAULT_CONFIG (#1824)', () => {
  it.each(KEYS_STATED_IN_PROSE)(
    'no surface labels the wrong value of `%s` as the default',
    (key) => {
      const actual = RESOLVED_DEFAULTS[key];
      // Only boolean keys are checked; a non-boolean default means this list
      // and the config shape have diverged, which is itself worth failing on.
      expect(typeof actual).toBe('boolean');

      const wrong = String(!(actual as boolean));

      const offenders = DOC_SURFACES.flatMap((surface) =>
        offendingLines(readRepoFile(surface), key, wrong).map(
          (line) => `${surface}: ${line.trim()}`,
        ),
      );

      expect(offenders).toEqual([]);
    },
  );

  it('model_routing routes by default — the value every prose surface must state', () => {
    // Pinned explicitly: the whole point of #1824 is that eight prose
    // restatements are only as good as the one value they describe.
    //
    // FLIPPED from false (#1957). It was opt-in, so a project with no
    // .flowconfig paid the most capable model for a complexity-2 "setup types"
    // phase. Measured over 257 real phases in this repo's own plans: 10% score
    // 0-3, 38% score 4-5, 52% score 6-10 — routing leaves the hard half where
    // it was and stops overpaying for the mechanical half. Changing this value
    // means changing every surface in DOC_SURFACES in the same commit; that is
    // what the check above is for.
    expect(RESOLVED_DEFAULTS.model_routing).toBe(true);
  });

  it('every listed surface exists — a renamed doc must not silently stop being checked', () => {
    for (const surface of DOC_SURFACES) {
      expect(() => readRepoFile(surface)).not.toThrow();
    }
  });
});

/**
 * Every key `/flow` may write, as its own reference states them.
 *
 * `.claude/commands/flow.md` heads this table "Valid keys" and it is the only
 * list the command has. Three keys the parser really reads were missing from
 * it — `wave_execution`, `worktree_links` and `provider` — while three other
 * documents told users to set `wave_execution` through exactly this command
 * (#1835). Since `/flow` is instructed to refuse a key the table does not list,
 * the shipped docs named an off-switch the command had grounds to refuse.
 *
 * The table is compared against the PARSER's own extractor calls, not against a
 * second hand-written list — a guard that restates what it checks is the drift
 * it is checking for.
 */
const FLOW_COMMAND_DOC = '.claude/commands/flow.md';
const FLOWCONFIG_PARSER = 'src/cli/state/flowconfig-parser.ts';

/**
 * The keys the parser reads with a simple `extract*(content, '<key>')` call, or
 * through `readAliasedKey('<key>', …)` for a key that was renamed.
 */
function parserKeys(): string[] {
  const source = readRepoFile(FLOWCONFIG_PARSER);
  const found = [
    ...source.matchAll(/(?:extract(?:Boolean|String|Number)\(content, |readAliasedKey\()'([a-z_.]+)'/g),
  ];
  return [...new Set(found.map((match) => match[1] as string))].sort();
}

/** The keys the `/flow` reference lists in its Valid keys table. */
function documentedKeys(): string[] {
  const source = readRepoFile(FLOW_COMMAND_DOC);
  const found = [...source.matchAll(/^\| `([a-z_.]+)`/gm)];
  return [...new Set(found.map((match) => match[1] as string))].sort();
}

describe('/flow documents every key the parser reads (#1835)', () => {
  it('lists every key `flowconfig-parser` extracts', () => {
    const missing = parserKeys().filter((key) => !documentedKeys().includes(key));
    expect(missing).toEqual([]);
  });

  it('the keys it lists beyond those are ones a person really can set', () => {
    // The other direction, deliberately NOT asserted as empty: `commands.lint`
    // is read by the dotted-key collector rather than a simple extractor, and
    // `share` is applied by its own verb (the table says so in its own row).
    // `thread_worktrees`, `learn_auto` and `learn_ignore` are read by the IDE
    // (app/src/main/flow/worktree-settings.ts, app/src/main/learn/learn-triggers.ts)
    // and validated by `flow set`, not extracted by this parser — the CLI has
    // no consumer for them. All are real; pinning them by name is what keeps
    // this half honest instead of vacuous.
    const extra = documentedKeys().filter((key) => !parserKeys().includes(key));
    expect(extra).toEqual(['commands.lint', 'learn_auto', 'learn_ignore', 'share', 'thread_worktrees']);
  });
});
