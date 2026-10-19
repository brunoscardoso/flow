/**
 * The shipped loop assets, checked against the CLI they drive (Phase 6).
 *
 * Three things can rot here, and none of them fails anywhere else:
 *
 *   1. THE ASSETS GO MISSING or move out of the directories provisioning
 *      copies. A run prompt that is not shipped is a loop that runs on
 *      whatever the model remembers.
 *   2. THE PROMPTS DRIFT INTO RESTATING INVARIANTS. Pause, dedup, the cap,
 *      claim eligibility, the locks, the breaker, the approval gate, the push
 *      carve-out and the close-evidence rule all live in ONE code path
 *      (allowed-pattern #14). A prompt that repeats one of them is a second
 *      copy that can disagree with the enforced one — and the enforced one is
 *      the only one that actually holds. So the check is a VOCABULARY BAN: the
 *      prompts may act on a verdict, but may not name the machinery behind it,
 *      and may not reach a guarded seam (`git push`, `gh pr create`) with a raw
 *      command instead of the verb that guards it.
 *   3. THE PROMPTS REFERENCE VERBS OR FLAGS THAT DO NOT EXIST. This is the
 *      check that will catch the next rename: every `planflow-ai loop <verb>`
 *      in an asset is matched against `LOOP_VERBS`, and every `--flag` on those
 *      command lines against the options really registered in `src/cli/index.ts`.
 *
 * Assets only — nothing here reads `flow/`, which is gitignored in this repo
 * and absent in a fresh clone.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { LOOP_VERBS } = await import('../commands/loop.js');
const { isRunLogKind } = await import('./run-log.js');
const { isLoopStopCondition } = await import('./types.js');
const { DIRECTIVE_KEYS } = await import('./directive-parser.js');

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location (src/cli/loop/ → ../../../). */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** The consumer run prompt. */
const CONSUMER_PROMPT = '.claude/resources/loops/consumer-run.md';

/** The producer run prompt. */
const PRODUCER_PROMPT = '.claude/resources/loops/producer-run.md';

/** The way in from a session. */
const LOOP_COMMAND = '.claude/commands/agent-loop.md';

/** The loops resource file — the one place the grammar is documented. */
const LOOPS_RESOURCE = '.claude/resources/core/loops.md';

/** Every asset this phase ships. */
const LOOP_ASSETS = [CONSUMER_PROMPT, PRODUCER_PROMPT, LOOP_COMMAND, LOOPS_RESOURCE] as const;

/** The assets that are agent instructions, and must therefore stay rule-free. */
const INSTRUCTION_ASSETS = [CONSUMER_PROMPT, PRODUCER_PROMPT, LOOP_COMMAND] as const;

/**
 * Vocabulary an instruction asset may not use, and why.
 *
 * Each entry names machinery the CLI owns. Mentioning it in a prompt means the
 * prompt is either restating the rule or routing around the verb that enforces
 * it — both are the drift allowed-pattern #14 exists to prevent.
 */
const BANNED_VOCABULARY: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /max_open_issues/i, why: 'the open-item cap is enforced by `loop file`' },
  { pattern: /needs[_-]approval/i, why: 'the approval gate is enforced by `loop claim`' },
  { pattern: /\bnot-now\b/i, why: 'parked-item eligibility is enforced by `loop claim`' },
  { pattern: /\bin-progress\b/i, why: 'claiming is `loop claim`, not a label protocol' },
  { pattern: /\bdedup/i, why: 'dedup is computed and applied by `loop file`' },
  { pattern: /\bbreaker\b/i, why: 'the breaker is folded in by `loop log --record`' },
  { pattern: /consecutive failure/i, why: 'the breaker is folded in by `loop log --record`' },
  { pattern: /pipeline lock/i, why: 'the pipeline lock is taken by `loop next` / `loop classify`' },
  { pattern: /state\.json/i, why: 'loop state is written only through the verbs' },
  { pattern: /\bgit push\b/i, why: 'the push carve-out is enforced by `loop push`' },
  { pattern: /\bgh pr create\b/i, why: 'pull requests are opened by `loop push --pr`' },
  { pattern: /\bgh pr merge\b/i, why: 'the merge gate is enforced by `loop merge`' },
  { pattern: /\bgh issue\b/i, why: 'the queue is reached through `loop file` / `loop claim` / `loop close`' },
  { pattern: /\bgit worktree\b/i, why: "a loop's checkout is resolved by `loop worktree`" },
  {
    pattern: /\bunclaim\b/i,
    why: 'how a claim may end is refused by `loop log --record`, which names the endings itself',
  },
  {
    pattern: /abandoned claim/i,
    why: 'abandoned claims are computed and reported by `loop status`',
  },
  {
    pattern: /\badopt/i,
    why: 'adoption is a person\'s act the CLI refuses while a run runs — a prompt that names it is teaching a run to reach for it',
  },
  {
    pattern: /loop marker/i,
    why: 'provenance is read from the item by `loop claim`, which refuses and says how a person adopts it',
  },
];

/**
 * Every field name `NextResult` actually declares, read out of the SOURCE.
 *
 * Derived rather than listed on purpose. A hand-written roster is the same
 * weakness as the banned-phrase list it backs up: it records what somebody knew
 * on the day they wrote it, and a field deleted afterwards leaves both the type
 * and the roster agreeing about a world that no longer exists. Parsing the
 * interface means the guard cannot be more out of date than the code it guards.
 */
const NEXT_RESULT_FIELDS: ReadonlySet<string> = (() => {
  const source = readAsset('src/cli/loop/next.ts');
  const start = source.indexOf('export interface NextResult');
  if (start < 0) throw new Error('NextResult is gone — this guard needs rewriting, not deleting');
  const body = source.slice(start, source.indexOf('\n}', start));
  return new Set([...body.matchAll(/^\s{2}(?:readonly\s+)?([a-zA-Z][a-zA-Z0-9_]*)\??:/gm)].map((m) => m[1]));
})();

function readAsset(relPath: string): string {
  const absPath = join(REPO_ROOT, relPath);
  expect({ relPath, exists: existsSync(absPath) }).toEqual({ relPath, exists: true });
  return readFileSync(absPath, 'utf-8');
}

/**
 * Every `planflow-ai loop …` invocation in an asset, as one logical line.
 * Shell continuations are folded first, so a wrapped command's flags are read
 * with the verb they belong to rather than dropped.
 */
function loopInvocations(content: string): string[] {
  return content
    // CRLF-TOLERANT. A shell continuation is `\` + newline, and on Windows that
    // newline is `\r\n`: with core.autocrlf=true every checkout writes CRLF, so
    // the join silently failed and four assertions about what a logged beat
    // carries went looking on the line before the one holding it. The assets
    // were never wrong — this parser was, on one platform only.
    .replace(/\\\r?\n\s*/g, ' ')
    .split(/\r?\n/)
    .filter((line) => line.includes('planflow-ai loop '));
}

/** The verb of one invocation. */
function verbOf(invocation: string): string {
  const match = invocation.match(/planflow-ai loop ([a-z][a-z-]*)/);
  return match === null ? '' : match[1];
}

/** Every long flag written on one invocation. */
function flagsOf(invocation: string): string[] {
  return invocation.match(/(?<![\w-])--[a-z][a-z-]*/g) ?? [];
}

/** Every option the `loop` command really registers, read from the CLI entry point. */
function registeredLoopFlags(): Set<string> {
  const index = readAsset('src/cli/index.ts');
  const start = index.indexOf(".command('loop <verb>')");
  expect(start).toBeGreaterThan(-1);
  const end = index.indexOf('.action(', start);
  expect(end).toBeGreaterThan(start);
  const block = index.slice(start, end);
  return new Set(
    [...block.matchAll(/\.option\(\s*'(--[a-z][a-z-]*)/g)].map((match) => match[1]),
  );
}

/**
 * THE RENAME LEFT NOTHING BEHIND.
 *
 * `beat` became `run`, and the first pass of that rename was reported complete
 * while 204 occurrences of the word were still sitting in the shipped prose —
 * because identifiers typecheck and prose does not. Nothing else in this repo
 * fails when an asset describes a vocabulary the CLI no longer has.
 *
 * The check is deliberately about the SHIPPED assets, not the source: a comment
 * that still says "beat" is stale, but an instruction file that does is a run
 * being told to do something that no longer exists.
 */
/**
 * THE PROMPT'S PAYLOAD MUST BE ONE THE CLI ACCEPTS.
 *
 * Both run prompts end by telling the run to record itself with a literal JSON
 * payload. Nothing typechecks a JSON string inside a markdown file, so when the
 * `beat` → `run` rename rewrote the prose it rewrote that payload too — and the
 * CLI's `RunLogKind` still said `beat`. Every run then failed at the single most
 * important write it makes: the one that ends it.
 *
 * It surfaced live, on a real run, as `loop refused: unknown record kind 'run'`.
 * This is the check that makes the two agree by construction.
 */
describe("the record payload the prompts hand out is one the CLI takes", () => {
  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])('%s records a kind the CLI knows', (prompt) => {
    const kinds = [...readAsset(prompt).matchAll(/"kind"\s*:\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect({ prompt, kind, known: isRunLogKind(kind) }).toEqual({ prompt, kind, known: true });
    }
  });

  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])('%s names a stop condition the CLI knows', (prompt) => {
    // The same failure shape, one field over: a closed vocabulary in code and a
    // literal in prose that nothing compares to it.
    const raw = readAsset(prompt).match(/"stopCondition"\s*:\s*"<([^>]+)>"/)?.[1] ?? '';
    for (const word of raw.split('|').filter(Boolean)) {
      expect({ prompt, word, known: isLoopStopCondition(word) }).toEqual({ prompt, word, known: true });
    }
  });
});

/**
 * THE COMMAND AND THE PROMPT MUST NOT DISAGREE ABOUT WHEN A RUN ENDS.
 *
 * They did, and it cost a live run. The prompts were rewritten to drain ("A run
 * is not one item — go back and claim again"), and `.claude/commands/agent-loop.md`
 * kept the pre-drain rule: "a run does one unit of work … then stops". The
 * command file is what a session reads FIRST, so it won: the run fixed one item,
 * halted with twenty minutes of budget left, and reported `budget` as the reason.
 *
 * Two documents describing the same behaviour is the drift allowed-pattern #14
 * is about; the enforced one here is the prompt, because it is what the run
 * follows once it starts.
 */
/**
 * THE BUNDLE IS A COPY, AND A COPY CAN GO STALE.
 *
 * The Flow IDE resolves its CLI and its `.claude` assets from `app/resources/cli`
 * (main/index.ts), which `build:cli` generates from the repo root. It is a build
 * artifact and gitignored — so `git pull` never updates it, and nothing noticed
 * when it fell behind.
 *
 * Live consequence: after `/beat` was renamed to `/agent-loop`, the bundle still
 * carried `beat.md` for a day. Every project the IDE provisioned got a command
 * that no longer existed, and the one that did was missing — reported as
 * "agent-loop is not available".
 *
 * Skipped when the bundle is absent (a fresh clone has not built it), because
 * this checks staleness, not presence.
 */
describe('the bundled assets match the ones they were copied from', () => {
  const BUNDLE = join(REPO_ROOT, 'app', 'resources', 'cli', '.claude');

  const commandsOf = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];

  it('ships the same command set as the repo root', () => {
    if (!existsSync(BUNDLE)) return; // not built here
    expect(commandsOf(join(BUNDLE, 'commands'))).toEqual(
      commandsOf(join(REPO_ROOT, '.claude', 'commands')),
    );
  });

  it('ships the same run prompts', () => {
    if (!existsSync(BUNDLE)) return;
    expect(commandsOf(join(BUNDLE, 'resources', 'loops'))).toEqual(
      commandsOf(join(REPO_ROOT, '.claude', 'resources', 'loops')),
    );
  });

  /**
   * Names, then CONTENTS. The checks above compare two directory listings, so
   * they catch a rename or a deletion — the instance that prompted them — and
   * are blind to the staleness that actually happens: an asset whose body was
   * edited and whose bundle was never rebuilt (#1579).
   *
   * That blindness had teeth here. `.claude/commands/agent-loop.md` was edited
   * three times after the filename settled, one of those being the fix that
   * stopped a run halting after a single item. A bundle rebuilt once at rename
   * time passes every listing check while the IDE provisions projects with the
   * pre-fix text — the identical filename is exactly what makes it invisible.
   */
  const driftedFiles = (relative: string[]): string[] => {
    const rootDir = join(REPO_ROOT, '.claude', ...relative);
    const bundleDir = join(BUNDLE, ...relative);
    if (!existsSync(bundleDir)) return [];
    return commandsOf(rootDir).filter((name) => {
      const bundled = join(bundleDir, name);
      if (!existsSync(bundled)) return true;
      return readFileSync(bundled, 'utf-8') !== readFileSync(join(rootDir, name), 'utf-8');
    });
  };

  it.each([[['commands']], [['resources', 'loops']]])(
    'ships the CONTENT the repo root has, not just the filenames (%s)',
    (relative) => {
      if (!existsSync(BUNDLE)) return;
      // Named, because "the bundle is stale" in a tree of assets is not
      // something a reader can act on.
      expect({ drifted: driftedFiles(relative), fix: 'npm run build:cli' }).toEqual({
        drifted: [],
        fix: 'npm run build:cli',
      });
    },
  );

  it('never ships a command the repo root has deleted', () => {
    // The specific failure: a rename leaves the OLD file in the bundle, so the
    // IDE offers a command the CLI no longer answers to.
    if (!existsSync(BUNDLE)) return;
    const root = new Set(commandsOf(join(REPO_ROOT, '.claude', 'commands')));
    const orphans = commandsOf(join(BUNDLE, 'commands')).filter((f) => !root.has(f));
    expect(orphans).toEqual([]);
  });
});

describe('the command agrees with the prompt about draining', () => {
  it('the command never tells a run to stop after one unit of work', () => {
    const command = readAsset(LOOP_COMMAND);
    const offences = [
      /does one unit of work[^.]*then stops/i,
      /one item, or one pipeline stage — then stops/i,
    ].filter((pattern) => pattern.test(command));
    expect(offences.map((pattern) => pattern.source)).toEqual([]);
  });

  it('the command says a run drains, in the same terms the prompt does', () => {
    expect(readAsset(LOOP_COMMAND)).toMatch(/is NOT one item|drains/i);
    expect(readAsset(CONSUMER_PROMPT)).toMatch(/A run is not one item/);
  });

  it('both name the stop conditions from the closed vocabulary', () => {
    // The reason a run stops is counted, so it cannot be prose. A run that
    // stops early and claims `budget` makes the digest lie about how much work
    // there was.
    for (const asset of [LOOP_COMMAND, CONSUMER_PROMPT]) {
      const words = [...readAsset(asset).matchAll(/`(empty|budget|cap|none)`/g)].map((m) => m[1]);
      expect({ asset, named: words.length > 0 }).toEqual({ asset, named: true });
      for (const word of words) {
        expect({ asset, word, known: isLoopStopCondition(word) }).toEqual({ asset, word, known: true });
      }
    }
  });
});

describe('the shipped assets speak the current vocabulary', () => {
  it.each(LOOP_ASSETS)('%s says run, never beat', (asset) => {
    // `heartbeat` is a different word that contains this one — the daemon is
    // still the heartbeat, and a check anchored on \bbeat\b alone would not
    // save it, because the `beat` inside `heartbeat` has a word boundary on its
    // right.
    const offences = [...readAsset(asset).matchAll(/(?<!heart)\bbeats?\b/gi)].map(
      (match) => match[0],
    );
    expect({ asset, offences }).toEqual({ asset, offences: [] });
  });

  it("the CLI's own --help says run, never beat", () => {
    // THE HALF THE .md GUARD CANNOT SEE, and the reason this class shipped
    // twice. `a814f748` renamed beat→run and fixed `--focus` and `--no-pull`;
    // `--owner` and `--record` kept theirs, because the identifier rename could
    // not reach prose inside a string and this guard only ever read shipped
    // markdown (#1569). Option descriptions are user-facing text exactly like
    // the assets beside them, so they get the same bar.
    const source = readFileSync(join(REPO_ROOT, 'src', 'cli', 'index.ts'), 'utf-8');
    const offences = [...source.matchAll(/\.option\([^)]*?['"]([^'"]*?(?<!heart)\bbeats?\b[^'"]*?)['"]\s*\)/gis)].map(
      (match) => match[1],
    );
    expect(offences).toEqual([]);
  });

  it('the /agent-loop help block agrees with the command it documents', () => {
    // The help block is the part a user reads FIRST and the part no code path
    // touches, so it drifts silently: it went on saying "anything typed after
    // the name is refused" for the whole life of the focus feature, and listed
    // `/agent-loop find dead code` as a refusal while that exact invocation ran
    // (#1570). Three checks, each pinned to something the command really does.
    const command = readAsset('.claude/commands/agent-loop.md');
    const help = command.slice(command.indexOf('ARGUMENTS:'), command.indexOf('WHAT A RUN DOES:'));

    // 1. A focus is supported, so the help must not call it a refusal.
    expect(help).not.toMatch(/after the name is refused/i);

    // 2. Every loop the EXAMPLES name must actually ship a directive.
    const shipped = new Set(
      readdirSync(join(REPO_ROOT, 'templates', 'loops'))
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.replace(/\.md$/, '')),
    );
    // EXAMPLES only — REFUSALS deliberately names things that are NOT loops
    // (`nosuchloop`, and the bare form whose next word is prose).
    const examples = help.slice(help.indexOf('EXAMPLES:'), help.indexOf('REFUSALS:'));
    const exampled = [...examples.matchAll(/^\s*\/agent-loop\s+([a-z][a-z0-9-]*)/gm)]
      .map((match) => match[1])
      .filter((name) => !name.startsWith('-'));
    for (const name of new Set(exampled)) {
      expect({ name, ships: shipped.has(name) }).toEqual({ name, ships: true });
    }

    // 3. The rule table and the help block must not disagree about the aim.
    expect(command).toContain('A Name, Then Optionally An Aim');
    expect(help).toMatch(/aim|focus/i);
  });

  it('NEVER ships a command called /loop — Claude Code owns that name', () => {
    // Got wrong twice. A project command named `/loop` SHADOWS Claude Code's
    // own `/loop` (run a prompt on a recurring interval) for everyone working
    // in this repo, silently taking a built-in away. It was renamed off `/loop`
    // once for this reason and then renamed back by someone reading "revert the
    // rename" in a plan without asking why the rename existed.
    expect(existsSync(join(REPO_ROOT, '.claude/commands/loop.md'))).toBe(false);

    const command = readAsset(LOOP_COMMAND);
    expect(command).toMatch(/\/agent-loop <name>/);
    // `/run` is not a command either — the mechanical rename invented it.
    expect(command).not.toMatch(/(?<![\w./-])\/(?:loop|run)\b/);
  });

  it('the runtime that dispatches a run names the same command the asset documents', () => {
    // One name, two places that must agree: the shipped command file and the
    // code that names the command a run is started with. They drifted before —
    // the asset said `/loop` while the code matched `/beat`, so every scheduled
    // loop task stopped being recognised as one.
    //
    // That code used to be the heartbeat daemon's loop-task predicate
    // (`src/cli/daemon/loop-task.ts`). The daemon no longer dispatches loop runs
    // — a run is a Claude Code background agent now — so the same guard points
    // at the dispatcher that builds the prompt instead. The pairing is what
    // matters here, not which file holds it.
    const dispatcher = readAsset('app/src/main/loops/background-agent.ts');
    expect(dispatcher).toContain('/agent-loop');
    expect(dispatcher).not.toMatch(/\\\/beat/);
  });

  it('the log the assets name is the log the CLI writes', () => {
    // One place these can disagree without anything failing: an asset telling a
    // reader to look in a file nothing writes any more.
    const runLog = readAsset('src/cli/loop/run-log.ts');
    const filename = /RUN_LOG_FILENAME = '([^']+)'/.exec(runLog)?.[1];
    expect(filename).toBe('runs.jsonl');
    for (const asset of LOOP_ASSETS) {
      const content = readAsset(asset);
      expect({ asset, stale: content.includes('beats.jsonl') }).toEqual({ asset, stale: false });
    }
  });
});

describe('a run is unattended, and the assets say so', () => {
  // REPORTED LIVE (2026-09-02). A producer run swept the Loops UI, produced a
  // correct analysis naming files and lines — everything its own "reproduce
  // before you believe it" bar asks for — filed 0/20, and ended with "Want me
  // to turn this into a /discovery-plan …?". Nothing on the list, nothing
  // recorded, and a question addressed to somebody who is by definition not
  // there: a loop runs BETWEEN sessions.
  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])('%s tells the run it is alone', (prompt) => {
    const content = readAsset(prompt);
    expect(content).toMatch(/unattended/i);
  });

  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])(
    '%s forbids ending on a question rather than a record',
    (prompt) => {
      const content = readAsset(prompt);
      // The section that ends the run says so in its own heading, so a reader
      // skimming the steps cannot miss it.
      expect(content).toMatch(/## 7\. Close the run — and never with a question/);
    },
  );

  it('the rule itself lives in the resource file, not only in the prompts', () => {
    // Same split every other loop rule follows: the prompts carry procedure,
    // loops.md carries the rule and the reason.
    const rules = readAsset('.claude/resources/core/loops.md');
    expect(rules).toMatch(/## A run is unattended/);
    expect(rules).toMatch(/discovery-plan/);
    expect(rules).toMatch(/cap/);
    expect(rules).toMatch(/budget/);
    expect(rules).toMatch(/empty/);
  });
});

describe('loop assets are shipped where provisioning looks', () => {
  it.each(LOOP_ASSETS)('%s exists and carries real content', (asset) => {
    expect(readAsset(asset).trim().length).toBeGreaterThan(500);
  });

  it('every asset lives under a directory the package publishes', () => {
    const pkg = JSON.parse(readAsset('package.json')) as { files: string[] };
    for (const asset of LOOP_ASSETS) {
      const covered = pkg.files.some((entry) => asset.startsWith(entry));
      expect({ asset, covered }).toEqual({ asset, covered: true });
    }
  });

  it('the bundled CLI copies .claude verbatim, so new subdirectories ship for free', () => {
    const bundler = readAsset('scripts/build-cli-bundle.mjs');
    expect(bundler).toMatch(/ASSET_DIRS = \[[^\]]*'\.claude'/);
  });

  it('the /loop command declares itself and routes to both run prompts', () => {
    const command = readAsset(LOOP_COMMAND);
    expect(command.startsWith('---\ndescription:')).toBe(true);
    expect(command).toContain('.claude/resources/loops/consumer-run.md');
    expect(command).toContain('.claude/resources/loops/producer-run.md');
  });
});

describe('run prompts follow the protocol', () => {
  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])('%s opens with the gate', (prompt) => {
    const invocations = loopInvocations(readAsset(prompt));
    expect(invocations.length).toBeGreaterThan(0);
    expect(verbOf(invocations[0])).toBe('next');
  });

  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])(
    '%s acts on every gate verdict, including the ones that end the beat',
    (prompt) => {
      const content = readAsset(prompt);
      for (const verdict of ['proceed', 'skip', 'paused', 'locked']) {
        expect(content).toContain(verdict);
      }
    },
  );

  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])('%s closes the beat through the log', (prompt) => {
    const invocations = loopInvocations(readAsset(prompt));
    const logging = invocations.filter((line) => verbOf(line) === 'log');
    expect(logging.length).toBeGreaterThan(0);
    expect(logging.every((line) => flagsOf(line).includes('--record'))).toBe(true);
  });

  it('the consumer records its judgment through classify and closes with captured evidence', () => {
    const invocations = loopInvocations(readAsset(CONSUMER_PROMPT));
    const classify = invocations.find((line) => verbOf(line) === 'classify');
    expect(classify).toBeDefined();
    expect(flagsOf(classify as string)).toEqual(expect.arrayContaining(['--record', '--verdict']));

    const closes = invocations.filter((line) => verbOf(line) === 'close');
    expect(closes.length).toBeGreaterThan(0);
    expect(closes.some((line) => flagsOf(line).includes('--evidence'))).toBe(true);
  });

  it('the consumer publishes through the push verb, never a raw remote command', () => {
    const invocations = loopInvocations(readAsset(CONSUMER_PROMPT));
    const push = invocations.find((line) => verbOf(line) === 'push');
    expect(push).toBeDefined();
    expect(flagsOf(push as string)).toEqual(expect.arrayContaining(['--branch', '--pr']));
  });

  it('the producer files findings and never closes them', () => {
    const invocations = loopInvocations(readAsset(PRODUCER_PROMPT));
    expect(invocations.some((line) => verbOf(line) === 'file')).toBe(true);
    expect(invocations.some((line) => verbOf(line) === 'close')).toBe(false);
    expect(invocations.some((line) => verbOf(line) === 'claim')).toBe(false);
  });
});

describe('assets reference only verbs and flags that exist', () => {
  it.each(LOOP_ASSETS)('%s uses known verbs', (asset) => {
    for (const invocation of loopInvocations(readAsset(asset))) {
      const verb = verbOf(invocation);
      expect({ verb, known: (LOOP_VERBS as readonly string[]).includes(verb) }).toEqual({
        verb,
        known: true,
      });
    }
  });

  it.each(LOOP_ASSETS)('%s uses registered flags', (asset) => {
    const registered = registeredLoopFlags();
    for (const invocation of loopInvocations(readAsset(asset))) {
      for (const flag of flagsOf(invocation)) {
        expect({ flag, registered: registered.has(flag) }).toEqual({ flag, registered: true });
      }
    }
  });
});

describe('instruction assets restate no CLI-enforced invariant', () => {
  it.each(INSTRUCTION_ASSETS)('%s stays clear of the enforced vocabulary', (asset) => {
    const content = readAsset(asset);
    const offences = BANNED_VOCABULARY.filter((entry) => entry.pattern.test(content)).map(
      (entry) => `${entry.pattern.source} — ${entry.why}`,
    );
    expect(offences).toEqual([]);
  });
});

/**
 * Phase 3, Task 3.5 — the rule the prompts must NOT learn.
 *
 * A claim ends in exactly three ways (closed / handed to the next beat /
 * released), and `loop log --record` refuses a `success` record that did none of
 * them, naming the item and the endings at the moment it matters. Teaching that
 * rule to the consumer prompt as well would be a second copy of an invariant
 * only one of which actually holds — allowed-pattern #14 — and the prompt's copy
 * is the one a model can reason its way past.
 *
 * So the check is a FROZEN SURFACE, not prose: the prompt's verb vocabulary is
 * pinned. Adding a step that unclaims, or a paragraph restating the endings,
 * fails here.
 */
describe('the honest-ending rule stays in the CLI, never in the beat prompt', () => {
  it('the consumer prompt invokes exactly the verbs it did before the rule existed', () => {
    const verbs = [...new Set(loopInvocations(readAsset(CONSUMER_PROMPT)).map(verbOf))].sort();
    // `merge` joined the list in Phase 4 — the one deliberate addition since the
    // surface was frozen, and the only reason to change this array is another
    // one of those.
    expect(verbs).toEqual([
      'claim',
      'classify',
      'close',
      'escalate',
      'log',
      'merge',
      'next',
      'push',
      'worktree',
    ]);
  });

  it('neither beat prompt states how a claim must end — the refusal does that', () => {
    for (const prompt of [CONSUMER_PROMPT, PRODUCER_PROMPT]) {
      const content = readAsset(prompt);
      for (const pattern of [/three (?:legitimate |honest )?ways/i, /still holding/i, /release the claim/i]) {
        expect({ prompt, pattern: pattern.source, present: pattern.test(content) }).toEqual({
          prompt,
          pattern: pattern.source,
          present: false,
        });
      }
    }
  });

  it('the rule IS written down where rules belong — the resource file, not an instruction', () => {
    const resource = readAsset(LOOPS_RESOURCE);
    expect(resource).toContain('`unclaim`');
    expect(resource).toMatch(/a claim ends in exactly three ways/i);
  });
});

/**
 * Phase 2 — `/beat` takes one loop name, and refuses everything else.
 *
 * The incident: `/beat find deprecated features, cleanup dead code` ran the
 * CLEANUP loop. `/beat` takes a loop name; the trailing words had no defined
 * meaning, so the words themselves were weighed against the loop list and the
 * wrong autonomous loop was started. A command that decides for itself which
 * unattended loop to run is worse than one that refuses.
 *
 * Three checks, one per failure mode of that incident:
 *
 *   1. THE ARGUMENT COUNT IS SPECIFIED. Exactly one, and all three ways an
 *      invocation can fail to name exactly one loop are written down with what
 *      each does — they are different situations and a single "invalid input"
 *      would collapse them.
 *   2. THE REFUSAL TEACHES. Every refusal path shows `loop status --human`, so
 *      the reader ends up looking at the names that exist instead of at an error.
 *      The command never carries its own copy of the loop list (that would be a
 *      second copy of what the CLI owns — allowed-pattern #14); it shows the
 *      CLI's.
 *   3. THE COMMAND NEVER DESCRIBES CHOOSING A LOOP. This is the drift check for
 *      the incident itself: any wording that has the agent weigh the user's
 *      words against the loop list, or take the nearest name, fails here.
 */
const LOOP_ARGUMENT_CASES: ReadonlyArray<{ name: string; pattern: RegExp; refuses: boolean }> = [
  { name: 'no name at all', pattern: /\*\*no name\*\*/i, refuses: true },
  { name: 'a name no loop answers to', pattern: /\*\*no loop by that name\*\*/i, refuses: true },
  // The trailing words are no longer refused — they are the instruction. What
  // must survive is the half of the old rule that the incident was actually
  // about: the loop is chosen from the FIRST argument and never from the prose
  // after it.
  { name: 'a name followed by an instruction', pattern: /\*\*a name and an aim\*\*/i, refuses: false },
];

/**
 * Wording that would reintroduce the incident, and why each is banned.
 *
 * These are all AFFIRMATIVE constructions — describing the act of choosing a
 * loop from something other than an exact argument. Refusing to do it is
 * written in the command without any of them.
 */
const LOOP_GUESSING_VOCABULARY: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bfuzz(?:y|ily)\b/i, why: 'a loop name is exact or it is refused' },
  { pattern: /\bclosest\b/i, why: 'the nearest loop is still the wrong loop' },
  { pattern: /\bbest[ -]match/i, why: 'the nearest loop is still the wrong loop' },
  { pattern: /\bmost similar\b/i, why: 'the nearest loop is still the wrong loop' },
  { pattern: /\bfree[ -]?(?:text|form)\b/i, why: 'the /beat line carries no prose to act on' },
  {
    pattern: /\bmatch(?:es|ed|ing)?\b[^.\n]{0,40}\b(?:ask|request|intent|description|wording|phrase)\b/i,
    why: "the incident: the user's words were weighed against the loop list",
  },
  {
    pattern: /\b(?:pick|choose|select|infer|guess|determine)\b[^.\n]{0,40}\bloop\b/i,
    why: 'the loop to run is named by the user, never worked out by the agent',
  },
  {
    pattern: /\bwhich loop (?:they|the user) (?:mean|meant|means|wants|wanted)\b/i,
    why: 'the loop to run is named by the user, never worked out by the agent',
  },
];

/** One `## `/`### ` section of a markdown asset, heading included. */
function sectionOf(content: string, heading: string): string {
  const start = content.indexOf(heading);
  expect({ heading, found: start > -1 }).toEqual({ heading, found: true });
  const rest = content.slice(start + heading.length);
  const end = rest.search(/\n#{2,3} /);
  return heading + (end === -1 ? rest : rest.slice(0, end));
}

describe('/loop takes its loop name from the first argument', () => {
  it('specifies exactly one argument and names all three ways that can fail', () => {
    const command = readAsset(LOOP_COMMAND);
    expect(command).toMatch(/exactly one argument/i);

    const step1 = sectionOf(command, '### Step 1');
    for (const { name, pattern } of LOOP_ARGUMENT_CASES) {
      expect({ name, covered: pattern.test(step1) }).toEqual({ name, covered: true });
    }
  });

  it('takes the loop from the FIRST argument, never from the words after it', () => {
    // THE HALF OF THE OLD RULE THAT STILL MATTERS. The incident was not that
    // trailing words existed — it was that they were weighed to pick a loop, and
    // an unattended `cleanup` ran. Trailing words are now the instruction, so the
    // guard moves from "refuse them" to "never let them choose the loop".
    const step1 = sectionOf(readAsset(LOOP_COMMAND), '### Step 1');
    expect(step1).toMatch(/first argument/i);
    const aim = step1
      .split('\n')
      .filter((line) => /\*\*a name and an aim\*\*/i.test(line))
      .join('\n');
    expect(aim).toMatch(/focus/i);
    // ...and it must say what an aim cannot do, or "instruction" quietly becomes
    // "mission" and the directive stops being the thing that bounds a loop.
    expect(step1).toMatch(/cannot (?:change|widen)/i);
  });

  it('teaches on refusal: every path shows the loops that really exist', () => {
    const command = readAsset(LOOP_COMMAND);
    const step1 = sectionOf(command, '### Step 1');

    const status = loopInvocations(step1).filter((line) => verbOf(line) === 'status');
    expect(status.length).toBeGreaterThan(0);
    expect(status.every((line) => flagsOf(line).includes('--human'))).toBe(true);
    expect(step1).toMatch(/show (?:that|its) output/i);

    // Each REFUSAL sends the reader to that command, not to a list the command
    // keeps for itself. A case that succeeds has nothing to teach — it runs.
    for (const { name, pattern } of LOOP_ARGUMENT_CASES.filter((entry) => entry.refuses)) {
      const row = step1.split('\n').filter((line) => pattern.test(line)).join('\n');
      expect({ name, teaches: /status command above/i.test(row) }).toEqual({ name, teaches: true });
    }
  });

  it('never describes choosing a loop from anything but the argument', () => {
    const command = readAsset(LOOP_COMMAND);
    const offences = LOOP_GUESSING_VOCABULARY.filter((entry) => entry.pattern.test(command)).map(
      (entry) => `${entry.pattern.source} — ${entry.why}`,
    );
    expect(offences).toEqual([]);
  });
});

/**
 * #1788 — the gate is re-entrant BY OWNER, and the command must say so.
 *
 * Step 3 sends the reader back to `loop next` for the JSON fields the `--human`
 * rendering leaves out, and it used to say the bare command would do: "it is the
 * same result object, rendered differently, and re-entering the gate as the same
 * owner is expected". It is not the same owner. `resolveOwner` mints a UNIQUE id
 * for every ownerless call, deliberately — two runs sharing a constant owner
 * would both pass `acquireLoopLock`'s re-entrancy check and work one checkout at
 * once. So a bare re-run is a DIFFERENT run asking to start:
 *
 *   - single-slot loop  -> `locked` by the lock Step 2 just minted, and `owner`
 *     comes back empty — the one field the re-run was for;
 *   - multi-slot loop   -> nothing refuses. It takes a second slot and a second
 *     worktree for one run and holds them until they expire. Reproduced live on
 *     `fix` (max_concurrent_runs: 2): one invocation, two owners, two locks.
 *
 * The guard is on the promise, not the prose: Step 3 must name `--owner`, and it
 * must not claim an ownerless re-entry works.
 */
describe('the command re-enters the gate as the owner it was given', () => {
  it('tells the reader to pass --owner when re-running the gate for the JSON', () => {
    const step3 = sectionOf(readAsset(LOOP_COMMAND), '### Step 3');
    expect(step3).toContain('--owner');
  });

  it('never promises that a re-run WITHOUT the owner returns the same result', () => {
    const step3 = sectionOf(readAsset(LOOP_COMMAND), '### Step 3');
    const offences = [
      // The exact shape of the #1788 regression: a re-run described by what is
      // dropped, with no mention of what must be added.
      { pattern: /without `--human`[^.]*same result object/i, why: 'a bare re-run is a new run, not a re-entry' },
      { pattern: /re-entering the gate as the same owner is expected/i, why: 'an ownerless call is never the same owner' },
    ]
      .filter((entry) => entry.pattern.test(step3))
      .map((entry) => `${entry.pattern.source} — ${entry.why}`);
    expect(offences).toEqual([]);
  });

  it('says what an ownerless re-run costs on BOTH slot counts', () => {
    // The refusal is the visible half. The silent second slot is the expensive
    // one, and it is the half a reader would otherwise never be warned about.
    const step3 = sectionOf(readAsset(LOOP_COMMAND), '### Step 3');
    expect(step3).toMatch(/locked/i);
    expect(step3).toMatch(/second slot/i);
  });
});

/**
 * Phase 1, Task 1.5 — a beat continues until a stop condition, and says which.
 *
 * A producer filed three findings and halted; a consumer fixed one issue and
 * halted. Nothing had stopped either of them: they simply decided one item was a
 * beat. So the prompts now say the opposite — take the next one — and report
 * which condition finally ended them.
 *
 * The rule they must NOT learn is the budget itself. `max_run_minutes` is
 * enforced at the seams that take new work (`loop claim`, `loop file`), and a
 * prompt that also told the beat to "wrap up when the budget is spent" would be
 * a second copy of an invariant only one of which actually holds — the one in
 * code (allowed-pattern #14). Acting on a refusal is allowed; policing the clock
 * is not.
 */
describe('runs continue until a stop condition, and report which one ended them', () => {
  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])(
    '%s tells the run to take the next one rather than halt after the first',
    (prompt) => {
      expect(readAsset(prompt)).toMatch(/\*\*A run is not one (item|finding)\.\*\*/);
    },
  );

  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])(
    '%s names the conditions it can be ended by, from the closed vocabulary',
    (prompt) => {
      const content = readAsset(prompt);
      for (const condition of ['`budget`', '`empty`']) {
        expect({ prompt, condition, named: content.includes(condition) }).toEqual({
          prompt,
          condition,
          named: true,
        });
      }
    },
  );

  it('each engine names the condition only it can hit', () => {
    // a producer runs out of room to file; a consumer runs out of items to claim
    expect(readAsset(PRODUCER_PROMPT)).toContain('`cap`');
    expect(readAsset(CONSUMER_PROMPT)).toContain('`empty`');
  });

  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])(
    '%s reports the condition on the beat line it records',
    (prompt) => {
      const logging = loopInvocations(readAsset(prompt)).filter((line) => verbOf(line) === 'log');
      expect(logging.length).toBeGreaterThan(0);
      expect(logging.every((line) => line.includes('"stopCondition"'))).toBe(true);
    },
  );

  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])('%s polices no clock of its own', (prompt) => {
    const content = readAsset(prompt);
    const offences = [
      /your budget/i,
      /wrap up at the next/i,
      /when it is spent/i,
      /max_run_minutes/i,
    ].filter((pattern) => pattern.test(content));
    expect(offences.map((pattern) => pattern.source)).toEqual([]);
  });

  /**
   * A PROMPT MAY NOT TELL A RUN TO READ A FIELD THAT DOES NOT EXIST.
   *
   * THE GUARD ABOVE IS THE WEAK FORM AND IT FAILED. It bans four phrasings, and
   * the drift that actually happened used none of them: `next` stopped
   * returning `budget` and `stall`, while both prompts went on instructing a run
   * to read "`budget` — how much of this run's time is left" and "`stall.reason`
   * says whether you are resuming a stage". Every test stayed green, because a
   * banned-phrase list only catches the sentences somebody thought of.
   *
   * So this asks the CODE instead of a list: every backticked token the prompt
   * presents as a field of `loop next`'s answer must be a real key of
   * `NextResult`. A field deleted from the type now fails here on the next run,
   * whatever prose surrounds it.
   */
  it.each([CONSUMER_PROMPT, PRODUCER_PROMPT])(
    '%s only names fields `loop next` actually returns',
    (prompt) => {
      const content = readAsset(prompt);
      // ONLY the block that describes the gate's answer. The file has other
      // backticked bullet lists — verdict values, log-payload keys — and those
      // are not fields of `next`. Anchored on the sentence that introduces it,
      // and stopping at the first blank line that is not followed by an indent,
      // so the guard reads one list rather than every list.
      const anchor = content.indexOf('From a `proceed` verdict, carry forward:');
      expect(anchor).toBeGreaterThan(-1);
      const block = content.slice(anchor).split(/\n(?=\S)(?!- )/)[0];
      const described = [...block.matchAll(/^- `([a-zA-Z][a-zA-Z0-9_]*)`/gm)].map(
        (match) => match[1],
      );
      expect(described.length).toBeGreaterThan(0);
      const dead = described.filter((field) => !NEXT_RESULT_FIELDS.has(field));
      expect({ prompt, dead }).toEqual({ prompt, dead: [] });
    },
  );
});

describe('the loops resource file documents the grammar the parser enforces', () => {
  it('names every frontmatter key the parser accepts', () => {
    const resource = readAsset(LOOPS_RESOURCE);
    for (const key of DIRECTIVE_KEYS) {
      expect({ key, documented: resource.includes(key) }).toEqual({ key, documented: true });
    }
  });

  it('names every verb the CLI answers to', () => {
    const resource = readAsset(LOOPS_RESOURCE);
    for (const verb of LOOP_VERBS) {
      expect({ verb, documented: resource.includes(`\`${verb}\``) }).toEqual({
        verb,
        documented: true,
      });
    }
  });

  it('is the file the beat prompts and the command point at for the grammar', () => {
    expect(readAsset(LOOP_COMMAND)).toContain('core/loops.md');
  });
});

/**
 * The consumer works whatever the queue hands it — and reaches for none of the
 * machinery that decides what that is.
 *
 * TWO INCIDENTS, ONE PROMPT. The first: a beat met a hand-filed issue, made it
 * fit — a label created in the user's repo, the markers appended to a person's
 * body — and worked it. The second, caused by the fix for the first: provenance
 * was made to gate consumer WORK too, so `fix` could not see a hand-filed issue
 * at all and the loop went inert on a full backlog.
 *
 * What the prompt learns from both is judgment, not rules. It takes what it is
 * given; it does not reshape an item it did not write; a refusal is an answer.
 * Which items it may take, and which single write is permitted on someone else's
 * issue, are enforced in the CLI and named nowhere here — `adopt` and `rework`
 * are a person's verbs, and a prompt that named either would be teaching a beat
 * the exact command the CLI exists to keep out of its hands.
 *
 * And the surface stays FROZEN: the consumer's verb list is pinned by the
 * honest-ending suite, so a later edit that reaches for one of those verbs fails
 * there as well as here.
 */
/** One asset with its line wrapping collapsed, so prose reads as one string. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

describe('the consumer works what it is given, and never reaches for a person\'s verbs', () => {
  it('says who filed an item does not decide whether it is worked', () => {
    const step = flat(sectionOf(readAsset(CONSUMER_PROMPT), '## 4.'));
    expect(step).toMatch(/who wrote it makes no difference/i);
    // the rule that survived: someone else's item is a report, not a draft
    expect(step).toMatch(/take it exactly as it stands/i);
  });

  it('treats a refusal as the answer, and leaving the item alone as a good outcome', () => {
    const step = flat(sectionOf(readAsset(CONSUMER_PROMPT), '## 4.'));
    expect(step).toMatch(/a refusal is an answer, never an obstacle/i);
    expect(step).toMatch(/leaving the item exactly as you found it/i);
  });

  it('never names the adopt or rework verbs — in any instruction asset', () => {
    for (const asset of INSTRUCTION_ASSETS) {
      const content = readAsset(asset);
      expect({ asset, names: /\badopt/i.test(content) }).toEqual({ asset, names: false });
      for (const verb of ['adopt', 'rework']) {
        expect({ asset, verb, invokes: loopInvocations(content).some((line) => verbOf(line) === verb) })
          .toEqual({ asset, verb, invokes: false });
      }
    }
  });

  it('restates none of the machinery that decides what it may take or write', () => {
    const content = readAsset(CONSUMER_PROMPT);
    const offences = [
      /<!--\s*loop:/,
      /provenance/i,
      /filed by (?:a|this) loop/i,
      /a person filed/i,
      /handled record/i,
      /closes #/i,
    ].filter((pattern) => pattern.test(content));
    expect(offences.map((pattern) => pattern.source)).toEqual([]);
  });

  it('the rules ARE written down where rules belong — the resource file', () => {
    const resource = flat(readAsset(LOOPS_RESOURCE));
    expect(resource).toContain('`adopt`');
    expect(resource).toContain('`rework`');
    expect(resource).toMatch(/only your own work/i);
    expect(resource).toMatch(/refused .{0,40}while a run holds the loop/i);
    expect(resource).toMatch(/planflow-ai loop adopt --loop <name> --id <id> --detail/);
    // the split the defect came from, and the mechanism that replaced the close
    expect(resource).toMatch(/taking work is the engine's question/i);
    expect(resource).toMatch(/closed \*\*by GitHub, not by the loop\*\*/i);
    expect(resource).toMatch(/Closes #<id>/);
  });
});

/**
 * Phase 4, Task 4.5 — the consumer finishes the job, and is told none of the
 * rules that let it.
 *
 * Merging is the largest autonomy increase in the feature, so it is also the
 * place where a prompt restating a rule would do the most damage: a beat that
 * has read "only your own `loop/*` branch, only on passing typecheck, build and
 * tests" has been handed the shape of an argument for why THIS case is close
 * enough. The rules live in `push-guard.ts` and refuse at the seam; what the
 * prompt learns is that landing the work is part of the job, which verb does it,
 * and that a refusal is not something to work around.
 */
describe('the consumer lands what it produced, and restates no rule that lets it', () => {
  it('merges through the verb, naming its own branch and the captured evidence', () => {
    const invocations = loopInvocations(readAsset(CONSUMER_PROMPT));
    const merge = invocations.find((line) => verbOf(line) === 'merge');
    expect(merge).toBeDefined();
    expect(flagsOf(merge as string)).toEqual(
      expect.arrayContaining(['--loop', '--id', '--owner', '--branch', '--evidence']),
    );
  });

  it('lands AFTER it has published and verified — the order the pipeline reads in', () => {
    const invocations = loopInvocations(readAsset(CONSUMER_PROMPT)).map(verbOf);
    expect(invocations.indexOf('merge')).toBeGreaterThan(invocations.indexOf('push'));
  });

  it('treats a refusal as the answer, not an obstacle', () => {
    const content = flat(readAsset(CONSUMER_PROMPT));
    expect(content).toMatch(/if it refuses/i);
    expect(content).toMatch(/never something to work around/i);
  });

  it('states none of the merge gate — not the namespace, not the bar', () => {
    const content = readAsset(CONSUMER_PROMPT);
    const offences = [
      /own namespace/i,
      /loop\/\*/,
      /exit(?:ed)? 0\b/i,
      /every .{0,30}command .{0,20}exit/i,
      /only .{0,30}your own branch/i,
      /squash/i,
    ].filter((pattern) => pattern.test(content));
    expect(offences.map((pattern) => pattern.source)).toEqual([]);
  });

  it('the rule IS written down where rules belong — the resource file', () => {
    const resource = flat(readAsset(LOOPS_RESOURCE));
    expect(resource).toContain('`merge`');
    expect(resource).toMatch(/this loop's own.{0,20}namespace/i);
    expect(resource).toMatch(/before any `gh` call/i);
    expect(resource).toMatch(/merging does \*\*not\*\* close the item/i);
  });
});
