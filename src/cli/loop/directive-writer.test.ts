/**
 * Tests for the directive writer — the only thing that may rewrite `paused:`,
 * or the pair that says where a loop's work comes from.
 *
 * THE CONTRACT UNDER TEST IS BYTE PRESERVATION. A directive is a person's file:
 * frontmatter in the order they wrote it, comments explaining their decisions,
 * and prose a run is handed verbatim. So most of this file is one shape of
 * assertion — write the field, and compare the result against the input with
 * exactly one substitution applied. Anything a re-serializing writer would have
 * silently normalized (a comment, a legacy key spelling, an absent default, the
 * `## Direction` body, CRLF endings, a missing final newline) has a case here.
 *
 * THE QUEUE PAIR ADDS ONE MORE CONTRACT: the parser must accept everything the
 * writer produces. Its two fields are coupled — `github` requires a `repo:` and
 * refuses a `path:`, `ledger` the reverse — so a stale companion left behind on
 * a switch is not a cosmetic leftover: the parser refuses the whole file and the
 * loop stops running. Every queue case below re-parses what it wrote.
 *
 * The store-level tests use throwaway temp projects, so nothing reads or writes
 * this repository's own `loops/`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { setDirectivePaused, setDirectiveQueue, withPausedField, withQueueFields, queueTargetProblem } =
  await import('./directive-writer.js');
const { parseLoopDirective } = await import('./directive-parser.js');
const { DEFAULT_LEDGER_PATH } = await import('./types.js');

/** A realistic directive: comments, prose, and keys in the author's order. */
const DIRECTIVE = `---
loop: find
engine: producer
paused: true    # 2026-08-13: queue is at its cap — resume once the list is short
mission: Put work in the list
scope: [src/, app/src/]
queue: ledger
max_open_issues: 20
---

## Direction

This is the ONE producer. The instruction says what to look at; this file says
what a good task looks like when you find one.

## Rules

Never file what you did not reproduce.

    an indented block, --- fenced-looking, that must survive
`;

const projects: string[] = [];

/** A throwaway project with one directive in the tracked home. */
function makeProject(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-directive-'));
  projects.push(dir);
  mkdirSync(join(dir, 'loops'), { recursive: true });
  writeFileSync(join(dir, 'loops', `${name}.md`), content, 'utf-8');
  mkdirSync(join(dir, 'flow', 'loops'), { recursive: true });
  return dir;
}

/** The `flowDir` every loop module takes — the project's `flow/`. */
function flowDirOf(project: string): string {
  return join(project, 'flow');
}

afterAll(() => {
  for (const dir of projects) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('withPausedField — one token, and nothing else', () => {
  it('flips the value and leaves every other byte alone', () => {
    const after = withPausedField(DIRECTIVE, false);
    expect(after).toBe(DIRECTIVE.replace('paused: true ', 'paused: false '));
  });

  it('keeps the prose below the frontmatter untouched', () => {
    const after = withPausedField(DIRECTIVE, false);
    const body = (text: string): string => text.slice(text.indexOf('\n---\n') + 5);
    expect(body(after)).toBe(body(DIRECTIVE));
  });

  it("keeps the author's comment on the line it rewrites", () => {
    const after = withPausedField(DIRECTIVE, false);
    expect(after).toContain('# 2026-08-13: queue is at its cap — resume once the list is short');
  });

  it('preserves unknown-to-this-writer spacing and key order', () => {
    const odd = ['---', 'loop:   find', 'engine: producer', '  paused:\ttrue', 'mission: m', 'queue: ledger', '---', ''].join('\n');
    expect(withPausedField(odd, false)).toBe(
      ['---', 'loop:   find', 'engine: producer', '  paused:\tfalse', 'mission: m', 'queue: ledger', '---', ''].join('\n'),
    );
  });

  it('inserts the key after `engine:` when the directive never named it', () => {
    const lean = ['---', 'loop: find', 'engine: producer', 'mission: m', 'queue: ledger', '---', '', '## Rules', '', 'Reproduce.', ''].join('\n');
    expect(withPausedField(lean, true)).toBe(
      ['---', 'loop: find', 'engine: producer', 'paused: true', 'mission: m', 'queue: ledger', '---', '', '## Rules', '', 'Reproduce.', ''].join('\n'),
    );
  });

  it('fills in an empty value without running into its comment', () => {
    const empty = ['---', 'loop: find', 'engine: producer', 'paused:   # not sure yet', 'mission: m', 'queue: ledger', '---', ''].join('\n');
    expect(withPausedField(empty, true)).toBe(
      ['---', 'loop: find', 'engine: producer', 'paused:   true # not sure yet', 'mission: m', 'queue: ledger', '---', ''].join('\n'),
    );
  });

  it('leaves CRLF endings and a missing final newline exactly as they were', () => {
    const crlf = ['---', 'loop: find', 'engine: producer', 'paused: false', 'mission: m', 'queue: ledger', '---', '', '## Rules', '', 'Reproduce.'].join('\r\n');
    const after = withPausedField(crlf, true);
    expect(after).toBe(crlf.replace('paused: false', 'paused: true'));
    expect(after.endsWith('Reproduce.')).toBe(true);
    expect(after.includes('\n\n')).toBe(false);
  });

  it('never touches a `paused` that is prose or a commented-out line', () => {
    const decoy = [
      '---',
      'loop: find',
      'engine: producer',
      '# paused: true',
      'mission: m',
      'queue: ledger',
      '---',
      '',
      'paused: true',
      '',
    ].join('\n');
    const after = withPausedField(decoy, true);
    // The comment survives, the body line survives, and the real key is added
    // where the grammar puts it — not on either decoy.
    expect(after.split('\n')).toEqual([
      '---',
      'loop: find',
      'engine: producer',
      'paused: true',
      '# paused: true',
      'mission: m',
      'queue: ledger',
      '---',
      '',
      'paused: true',
      '',
    ]);
  });

  it('refuses a file with no frontmatter rather than inventing one', () => {
    expect(() => withPausedField('## Direction\n\nno fence here\n', true)).toThrow(/missing frontmatter/);
    expect(() => withPausedField('---\nloop: find\n', true)).toThrow(/unterminated frontmatter/);
  });

  it('round-trips through the parser: only `paused` changed', () => {
    const before = parseLoopDirective(DIRECTIVE, 'fixture');
    const after = parseLoopDirective(withPausedField(DIRECTIVE, false), 'fixture');
    expect({ ...after, paused: true }).toEqual(before);
  });
});

describe('setDirectivePaused — the store', () => {
  it('writes the flip and reports what changed', () => {
    const project = makeProject('find', DIRECTIVE);
    const result = setDirectivePaused(flowDirOf(project), 'find', false);
    expect({ ...result, path: result.path.endsWith(join('loops', 'find.md')) }).toEqual({
      path: true,
      wasPaused: true,
      paused: false,
      changed: true,
    });
    expect(readFileSync(join(project, 'loops', 'find.md'), 'utf-8')).toBe(
      DIRECTIVE.replace('paused: true ', 'paused: false '),
    );
  });

  it('setting the value it already has is a SUCCESS that wrote nothing', () => {
    const project = makeProject('find', DIRECTIVE);
    const result = setDirectivePaused(flowDirOf(project), 'find', true);
    expect({ wasPaused: result.wasPaused, paused: result.paused, changed: result.changed }).toEqual({
      wasPaused: true,
      paused: true,
      changed: false,
    });
    expect(readFileSync(join(project, 'loops', 'find.md'), 'utf-8')).toBe(DIRECTIVE);
  });

  it('an absent `paused` counts as false, so enabling it writes nothing', () => {
    const lean = ['---', 'loop: find', 'engine: producer', 'mission: m', 'queue: ledger', '---', ''].join('\n');
    const project = makeProject('find', lean);
    const result = setDirectivePaused(flowDirOf(project), 'find', false);
    expect(result.changed).toBe(false);
    expect(readFileSync(join(project, 'loops', 'find.md'), 'utf-8')).toBe(lean);
  });

  it('refuses a malformed directive and writes NOTHING', () => {
    const broken = ['---', 'loop: find', 'engine: producer', 'paused: yes', 'mission: m', 'queue: ledger', '---', ''].join('\n');
    const project = makeProject('find', broken);
    expect(() => setDirectivePaused(flowDirOf(project), 'find', false)).toThrow(/malformed paused 'yes'/);
    expect(readFileSync(join(project, 'loops', 'find.md'), 'utf-8')).toBe(broken);
    // Not even a temp sibling: an atomic write that never started leaves no trace.
    expect(readdirSync(join(project, 'loops'))).toEqual(['find.md']);
  });

  it('refuses an unknown key, a duplicate key and a filename mismatch by name', () => {
    const cases: [string, string, RegExp][] = [
      ['a', ['---', 'loop: a', 'engine: producer', 'max_open_issue: 3', 'mission: m', 'queue: ledger', '---', ''].join('\n'), /unknown frontmatter key 'max_open_issue'/],
      ['b', ['---', 'loop: b', 'engine: producer', 'mission: m', 'mission: n', 'queue: ledger', '---', ''].join('\n'), /duplicate frontmatter key 'mission'/],
      ['c', ['---', 'loop: other', 'engine: producer', 'mission: m', 'queue: ledger', '---', ''].join('\n'), /does not match its filename 'c.md'/],
    ];
    for (const [name, content, pattern] of cases) {
      const project = makeProject(name, content);
      expect(() => setDirectivePaused(flowDirOf(project), name, true)).toThrow(pattern);
      expect(readFileSync(join(project, 'loops', `${name}.md`), 'utf-8')).toBe(content);
    }
  });

  it('refuses a loop that has no directive, naming both homes', () => {
    const project = makeProject('find', DIRECTIVE);
    expect(() => setDirectivePaused(flowDirOf(project), 'ghost', true)).toThrow(
      /no directive for loop 'ghost' at .*loops.*ghost\.md or .*flow.*loops.*ghost\.md/,
    );
  });

  it('writes the legacy `flow/loops/` home when that is where the directive lives', () => {
    const project = makeProject('find', DIRECTIVE);
    rmSync(join(project, 'loops', 'find.md'));
    writeFileSync(join(project, 'flow', 'loops', 'find.md'), DIRECTIVE, 'utf-8');
    const result = setDirectivePaused(flowDirOf(project), 'find', false);
    expect(result.path).toBe(join(project, 'flow', 'loops', 'find.md'));
    expect(readFileSync(result.path, 'utf-8')).toContain('paused: false');
  });

  it('touches no runtime state — the store it never opens', () => {
    const project = makeProject('find', DIRECTIVE);
    const statePath = join(project, 'flow', 'loops', 'state.json');
    setDirectivePaused(flowDirOf(project), 'find', false);
    // No state file was created by a verb that has no business creating one…
    expect(existsSync(statePath)).toBe(false);
    // …and an existing one is left byte-identical, pause records and all.
    const state = JSON.stringify({ version: 1, loops: { find: { pause: { reason: 'by hand', at: 1 } } } });
    writeFileSync(statePath, state, 'utf-8');
    setDirectivePaused(flowDirOf(project), 'find', true);
    expect(readFileSync(statePath, 'utf-8')).toBe(state);
  });
});

// ── where the work comes from ────────────────────────────

/** A GitHub-queued directive, with a comment on the field that must go. */
const GITHUB_DIRECTIVE = `---
loop: fix
engine: consumer
paused: true    # 2026-08-14: waiting on the release
mission: Drain the queue one item at a time
queue: github
repo: acme/widgets    # the fork, not upstream
label: from-fix
---

## Direction

Take the oldest item that is ready and finish it.

## Rules

Reproduce before you close.
`;

/** A ledger-queued directive that names its own file. */
const LEDGER_DIRECTIVE = `---
loop: fix
engine: consumer
mission: Drain the queue one item at a time
queue: ledger
path: flow/loops/backlog.jsonl
---

## Rules

Reproduce before you close.
`;

describe('queueTargetProblem — the parser\'s coupling, on the write side', () => {
  it('accepts exactly what the parser accepts', () => {
    expect(queueTargetProblem({ queue: 'github', repo: 'acme/widgets' })).toBeNull();
    expect(queueTargetProblem({ queue: 'ledger' })).toBeNull();
    expect(queueTargetProblem({ queue: 'ledger', path: 'flow/loops/queue.jsonl' })).toBeNull();
  });

  it('refuses a github queue with no repo, and one whose repo is not owner/name', () => {
    expect(queueTargetProblem({ queue: 'github' })).toBe("queue 'github' requires 'repo: owner/name'");
    expect(queueTargetProblem({ queue: 'github', repo: 'widgets' })).toBe(
      "malformed repo 'widgets' — expected owner/name",
    );
    expect(queueTargetProblem({ queue: 'github', repo: 'a/b/c' })).toContain('expected owner/name');
  });

  it('refuses each field under the queue that forbids it', () => {
    expect(queueTargetProblem({ queue: 'github', repo: 'a/b', path: 'x.jsonl' })).toBe(
      "'path' applies to queue 'ledger' only",
    );
    expect(queueTargetProblem({ queue: 'ledger', repo: 'a/b' })).toBe(
      "'repo' applies to queue 'github' only",
    );
  });

  it('refuses an unknown store rather than writing a word the parser will reject', () => {
    expect(queueTargetProblem({ queue: 'jira' })).toBe("unknown queue 'jira' — expected github|ledger");
  });

  it("refuses a path the parser would read back truncated", () => {
    // `path: notes # 2.jsonl` parses as `notes`, because the grammar strips a
    // ` # …` comment off every value. A loop silently pointed at a file nobody
    // named is the failure this refusal exists to prevent.
    expect(queueTargetProblem({ queue: 'ledger', path: 'notes # 2.jsonl' })).toContain('malformed path');
  });
});

describe('withQueueFields — both fields, one rewrite', () => {
  it('switching github → ledger leaves NO stale repo behind', () => {
    const after = withQueueFields(GITHUB_DIRECTIVE, { queue: 'ledger' });
    expect(after).not.toContain('repo:');
    expect(after).not.toContain('acme/widgets');
    expect(after).toContain('queue: ledger');
    // The file the parser refuses is the file the loop cannot run — so the
    // proof of this case is the round trip, not the absence of a substring.
    const parsed = parseLoopDirective(after, 'fixture');
    expect({ queue: parsed.queue, repo: parsed.repo, path: parsed.path }).toEqual({
      queue: 'ledger',
      repo: undefined,
      path: DEFAULT_LEDGER_PATH,
    });
  });

  it('switching ledger → github writes the repo where the key order puts it', () => {
    const after = withQueueFields(LEDGER_DIRECTIVE, { queue: 'github', repo: 'acme/widgets' });
    expect(after).not.toContain('path:');
    expect(after.split('\n').slice(0, 7)).toEqual([
      '---',
      'loop: fix',
      'engine: consumer',
      'mission: Drain the queue one item at a time',
      'queue: github',
      'repo: acme/widgets',
      '---',
    ]);
    expect(parseLoopDirective(after, 'fixture').repo).toBe('acme/widgets');
  });

  it('keeps every other line, comment and byte of prose', () => {
    const after = withQueueFields(GITHUB_DIRECTIVE, { queue: 'ledger' });
    // Exactly two lines differ: the kind, and the repo that had to go with it.
    const before = GITHUB_DIRECTIVE.split('\n').filter((line) => !line.startsWith('repo:'));
    const changed = after
      .split('\n')
      .map((line, index) => [before[index], line])
      .filter(([was, now]) => was !== now);
    expect(changed).toEqual([['queue: github', 'queue: ledger']]);
    expect(after).toContain('paused: true    # 2026-08-14: waiting on the release');
    expect(after).toContain('Take the oldest item that is ready and finish it.');
    expect(after).toContain('label: from-fix');
  });

  it('leaves `paused:` exactly as it was, in both directions', () => {
    const off = withQueueFields(GITHUB_DIRECTIVE, { queue: 'ledger' });
    expect(parseLoopDirective(off, 'fixture').paused).toBe(true);
    const on = withQueueFields(LEDGER_DIRECTIVE, { queue: 'github', repo: 'acme/widgets' });
    expect(parseLoopDirective(on, 'fixture').paused).toBe(false);
    expect(on).not.toContain('paused:');
  });

  it('re-pointing a ledger without naming a file keeps the file it reads', () => {
    const after = withQueueFields(LEDGER_DIRECTIVE, { queue: 'ledger' });
    expect(after).toBe(LEDGER_DIRECTIVE);
    expect(parseLoopDirective(after, 'fixture').path).toBe('flow/loops/backlog.jsonl');
  });

  it('naming a ledger file replaces the one that was there', () => {
    const after = withQueueFields(LEDGER_DIRECTIVE, { queue: 'ledger', path: 'flow/loops/queue.jsonl' });
    expect(after).toBe(LEDGER_DIRECTIVE.replace('backlog.jsonl', 'queue.jsonl'));
  });

  it('moving one repo to another changes one token', () => {
    const after = withQueueFields(GITHUB_DIRECTIVE, { queue: 'github', repo: 'acme/gadgets' });
    expect(after).toBe(GITHUB_DIRECTIVE.replace('repo: acme/widgets ', 'repo: acme/gadgets '));
    // The author's note about WHICH repo survives the move, dated but not deleted.
    expect(after).toContain('# the fork, not upstream');
  });

  it('preserves indentation, colon spacing, CRLF and a missing final newline', () => {
    const crlf = [
      '---',
      'loop: fix',
      'engine: consumer',
      'mission: m',
      '  queue:\tgithub',
      '  repo:\tacme/widgets',
      '---',
      '',
      '## Rules',
      '',
      'Reproduce.',
    ].join('\r\n');
    const after = withQueueFields(crlf, { queue: 'ledger' });
    expect(after).toBe(
      ['---', 'loop: fix', 'engine: consumer', 'mission: m', '  queue:\tledger', '---', '', '## Rules', '', 'Reproduce.'].join(
        '\r\n',
      ),
    );
    expect(after.endsWith('Reproduce.')).toBe(true);
    expect(parseLoopDirective(after, 'fixture').queue).toBe('ledger');
  });

  it('an inserted ledger path copies the anchor line\'s indentation and ending', () => {
    const crlf = ['---', '  loop: fix', '  engine: consumer', '  mission: m', '  queue: ledger', '---', ''].join('\r\n');
    const after = withQueueFields(crlf, { queue: 'ledger', path: 'flow/loops/backlog.jsonl' });
    expect(after.split('\r\n')[5]).toBe('  path: flow/loops/backlog.jsonl');
    expect(parseLoopDirective(after, 'fixture').path).toBe('flow/loops/backlog.jsonl');
  });

  it('never touches a `repo` that is prose or a commented-out line', () => {
    const decoy = [
      '---',
      'loop: fix',
      'engine: consumer',
      'mission: m',
      'queue: github',
      '# repo: acme/old',
      'repo: acme/widgets',
      '---',
      '',
      'repo: acme/mentioned-in-prose',
      '',
    ].join('\n');
    const after = withQueueFields(decoy, { queue: 'ledger' });
    expect(after.split('\n')).toEqual([
      '---',
      'loop: fix',
      'engine: consumer',
      'mission: m',
      'queue: ledger',
      '# repo: acme/old',
      '---',
      '',
      'repo: acme/mentioned-in-prose',
      '',
    ]);
  });

  it('refuses a file with no frontmatter, and a target the grammar forbids', () => {
    expect(() => withQueueFields('## Direction\n\nno fence\n', { queue: 'ledger' })).toThrow(
      /missing frontmatter/,
    );
    expect(() => withQueueFields(GITHUB_DIRECTIVE, { queue: 'github' })).toThrow(
      /requires 'repo: owner\/name'/,
    );
    expect(() => withQueueFields(GITHUB_DIRECTIVE, { queue: 'gitlab' })).toThrow(/unknown queue 'gitlab'/);
  });

  it('round-trips through the parser: only the queue fields changed', () => {
    const before = parseLoopDirective(GITHUB_DIRECTIVE, 'fixture');
    const after = parseLoopDirective(withQueueFields(GITHUB_DIRECTIVE, { queue: 'ledger' }), 'fixture');
    const { repo: _wasRepo, ...wasRest } = before;
    const { path: _isPath, ...isRest } = after;
    expect(isRest).toEqual({ ...wasRest, queue: 'ledger' });
  });
});

describe('setDirectiveQueue — the store', () => {
  it('writes a github → ledger switch and reports both sides of it', () => {
    const project = makeProject('fix', GITHUB_DIRECTIVE);
    const result = setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'ledger' });
    expect({ ...result, path: result.path.endsWith(join('loops', 'fix.md')) }).toEqual({
      path: true,
      wasQueue: 'github',
      wasLocation: 'acme/widgets',
      queue: 'ledger',
      location: DEFAULT_LEDGER_PATH,
      changed: true,
    });
    const written = readFileSync(join(project, 'loops', 'fix.md'), 'utf-8');
    expect(written).not.toContain('repo:');
    expect(() => parseLoopDirective(written, 'written')).not.toThrow();
  });

  it('writes a ledger → github switch, requiring the repo first', () => {
    const project = makeProject('fix', LEDGER_DIRECTIVE);
    expect(() => setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'github' })).toThrow(
      /requires 'repo: owner\/name'/,
    );
    // NOTHING WRITTEN by the refusal — not even a temp sibling.
    expect(readFileSync(join(project, 'loops', 'fix.md'), 'utf-8')).toBe(LEDGER_DIRECTIVE);
    expect(readdirSync(join(project, 'loops'))).toEqual(['fix.md']);

    const result = setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'github', repo: 'acme/widgets' });
    expect({ queue: result.queue, location: result.location, changed: result.changed }).toEqual({
      queue: 'github',
      location: 'acme/widgets',
      changed: true,
    });
    expect(readFileSync(join(project, 'loops', 'fix.md'), 'utf-8')).not.toContain('path:');
  });

  it('a round trip out and back leaves a parseable directive both ways', () => {
    const project = makeProject('fix', GITHUB_DIRECTIVE);
    const file = join(project, 'loops', 'fix.md');
    setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'ledger' });
    expect(parseLoopDirective(readFileSync(file, 'utf-8'), file).queue).toBe('ledger');
    setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'github', repo: 'acme/widgets' });
    const back = readFileSync(file, 'utf-8');
    expect(parseLoopDirective(back, file).repo).toBe('acme/widgets');
    // The prose, the comment on `paused:` and the label all came through both
    // rewrites; only the repo's own trailing note went with the repo line.
    expect(back).toContain('# 2026-08-14: waiting on the release');
    expect(back).toContain('Reproduce before you close.');
    expect(back).toContain('label: from-fix');
  });

  it('leaves `paused:` untouched — a source is not a switch', () => {
    const project = makeProject('fix', GITHUB_DIRECTIVE);
    setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'ledger' });
    expect(parseLoopDirective(readFileSync(join(project, 'loops', 'fix.md'), 'utf-8')).paused).toBe(true);
  });

  it('pointing where it already points is a SUCCESS that wrote nothing', () => {
    const project = makeProject('fix', GITHUB_DIRECTIVE);
    const result = setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'github', repo: 'acme/widgets' });
    expect({ changed: result.changed, wasQueue: result.wasQueue, queue: result.queue }).toEqual({
      changed: false,
      wasQueue: 'github',
      queue: 'github',
    });
    expect(readFileSync(join(project, 'loops', 'fix.md'), 'utf-8')).toBe(GITHUB_DIRECTIVE);
  });

  it('refuses a malformed directive and writes NOTHING', () => {
    const broken = ['---', 'loop: fix', 'engine: consumer', 'mission: m', 'quee: ledger', '---', ''].join('\n');
    const project = makeProject('fix', broken);
    expect(() => setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'ledger' })).toThrow(
      /unknown frontmatter key 'quee'/,
    );
    expect(readFileSync(join(project, 'loops', 'fix.md'), 'utf-8')).toBe(broken);
    expect(readdirSync(join(project, 'loops'))).toEqual(['fix.md']);
  });

  it('refuses a loop that has no directive, naming both homes', () => {
    const project = makeProject('fix', GITHUB_DIRECTIVE);
    expect(() => setDirectiveQueue(flowDirOf(project), 'ghost', { queue: 'ledger' })).toThrow(
      /no directive for loop 'ghost' at .*loops.*ghost\.md or .*flow.*loops.*ghost\.md/,
    );
  });

  it('touches no runtime state — the store it never opens', () => {
    const project = makeProject('fix', GITHUB_DIRECTIVE);
    const statePath = join(project, 'flow', 'loops', 'state.json');
    const state = JSON.stringify({ version: 1, loops: { fix: { pause: { reason: 'by hand', at: 1 } } } });
    writeFileSync(statePath, state, 'utf-8');
    setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'ledger' });
    expect(readFileSync(statePath, 'utf-8')).toBe(state);
  });

  it('writes the legacy `flow/loops/` home when that is where the directive lives', () => {
    const project = makeProject('fix', GITHUB_DIRECTIVE);
    rmSync(join(project, 'loops', 'fix.md'));
    writeFileSync(join(project, 'flow', 'loops', 'fix.md'), GITHUB_DIRECTIVE, 'utf-8');
    const result = setDirectiveQueue(flowDirOf(project), 'fix', { queue: 'ledger' });
    expect(result.path).toBe(join(project, 'flow', 'loops', 'fix.md'));
    expect(readFileSync(result.path, 'utf-8')).toContain('queue: ledger');
  });
});
