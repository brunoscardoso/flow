/**
 * Tests for the loop directive parser.
 *
 * Content parsing is pure; `readLoopDirective` uses real fs via mkdtemp, like
 * the sibling store tests. Covers the full grammar round trip, every documented
 * default, and — the load-bearing half — that each malformed field REFUSES with
 * a message naming the file and the field, rather than parsing to a default.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const {
  DIRECTIVE_KEYS,
  extractSection,
  loopDirectivePath,
  parseLoopDirective,
  readLoopDirective,
} = await import('./directive-parser.js');
const { RESERVED_LABELS, TOPIC_MAX_LENGTH } = await import('./queue-backend.js');
const { bindDirectiveQueue, loopTemplateFiles, loopTemplatesDir } = await import(
  './directive-templates.js'
);

/** The checkout root — `templates/loops/` lives directly under it. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FULL_DIRECTIVE = `---
loop: find
engine: producer          # producer | consumer
paused: false
mission: Find cleanup targets in the repo
scope: [src/, app/src/]
slice: changed            # changed | rotate | full  (default: changed)
queue: github             # github | ledger
repo: owner/name          # required when queue: github
label: qa-heartbeat
topic: codemap            # the area this loop is pointed at
max_open_issues: 8
max_run_minutes: 25      # default 25
needs_approval: false
---

## Direction

Sweep the scope slice for dead code and duplicated helpers.

## Rules

Reproduce before filing. One finding per item.
`;

/** The minimum a directive can say and still be valid. */
const MINIMAL_DIRECTIVE = `---
loop: fix
engine: consumer
mission: Drain the queue
queue: ledger
---
`;

function directiveWith(lines: string): string {
  return `---\n${lines}\n---\n`;
}

describe('parseLoopDirective', () => {
  it('parses the full documented grammar', () => {
    const directive = parseLoopDirective(FULL_DIRECTIVE, 'flow/loops/find.md');

    expect(directive).toMatchObject({
      loop: 'find',
      engine: 'producer',
      paused: false,
      mission: 'Find cleanup targets in the repo',
      scope: ['src/', 'app/src/'],
      slice: 'changed',
      queue: 'github',
      repo: 'owner/name',
      label: 'qa-heartbeat',
      topic: 'codemap',
      maxOpenIssues: 8,
      maxRunMinutes: 25,
      needsApproval: false,
    });
    expect(directive.direction).toBe('Sweep the scope slice for dead code and duplicated helpers.');
    expect(directive.rules).toBe('Reproduce before filing. One finding per item.');
    // `path` belongs to the ledger backend and must not be invented for github.
    expect(directive.path).toBeUndefined();
  });

  it('strips trailing comments from values, not the values themselves', () => {
    const directive = parseLoopDirective(
      directiveWith(
        'loop: improve\nengine: producer\nmission: Improve things # not a comment marker in prose\nqueue: ledger',
      ),
    );
    expect(directive.mission).toBe('Improve things');
  });

  it('applies every documented default when a directive says the minimum', () => {
    const directive = parseLoopDirective(MINIMAL_DIRECTIVE);
    expect(directive).toMatchObject({
      loop: 'fix',
      engine: 'consumer',
      paused: false,
      mission: 'Drain the queue',
      scope: [],
      slice: 'changed',
      queue: 'ledger',
      path: 'flow/loops/queue.jsonl',
      maxOpenIssues: 8,
      maxRunMinutes: 25,
      needsApproval: false,
      direction: '',
      rules: '',
    });
    // A directive that names no topic behaves exactly as it did before the
    // field existed — absence, not an empty string.
    expect(directive.topic).toBeUndefined();
    expect(Object.hasOwn(directive, 'topic')).toBe(false);
  });

  it('keeps an explicit ledger path and an explicit slice', () => {
    const directive = parseLoopDirective(
      directiveWith(
        'loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\npath: flow/loops/other.jsonl\nslice: full',
      ),
    );
    expect(directive.path).toBe('flow/loops/other.jsonl');
    expect(directive.slice).toBe('full');
  });

  it('parses booleans strictly in both directions', () => {
    const directive = parseLoopDirective(
      directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\npaused: true\nneeds_approval: true'),
    );
    expect(directive.paused).toBe(true);
    expect(directive.needsApproval).toBe(true);
  });

  it('parses a single-element scope written without brackets', () => {
    const directive = parseLoopDirective(
      directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\nscope: src/cli'),
    );
    expect(directive.scope).toEqual(['src/cli']);
  });

  it('is deterministic — the same content parses to a deep-equal directive', () => {
    expect(parseLoopDirective(FULL_DIRECTIVE)).toEqual(parseLoopDirective(FULL_DIRECTIVE));
  });
});

describe('parseLoopDirective refusals', () => {
  it('refuses content with no frontmatter fence', () => {
    expect(() => parseLoopDirective('# Just a note\n', 'flow/loops/x.md')).toThrow(
      /flow\/loops\/x\.md: missing frontmatter/,
    );
  });

  it('refuses an unterminated frontmatter fence', () => {
    expect(() => parseLoopDirective('---\nloop: fix\n', 'flow/loops/x.md')).toThrow(/missing frontmatter/);
  });

  it('refuses an unknown queue, naming the valid ones', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: gitlab')),
    ).toThrow(/unknown queue 'gitlab' — expected github\|ledger/);
  });

  it('refuses a missing mission', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nqueue: ledger')),
    ).toThrow(/missing 'mission'/);
  });

  it('refuses an empty mission rather than treating it as absent-but-fine', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nmission:\nqueue: ledger')),
    ).toThrow(/missing 'mission'/);
  });

  it.each([
    ['max_open_issues: eight', /malformed max_open_issues 'eight'/],
    ['max_open_issues: 0', /malformed max_open_issues '0'/],
    ['max_open_issues: -3', /malformed max_open_issues '-3'/],
    ['max_open_issues: 2.5', /malformed max_open_issues '2\.5'/],
    ['max_run_minutes: soon', /malformed max_run_minutes 'soon'/],
  ])('refuses a malformed cap (%s)', (line, expected) => {
    expect(() =>
      parseLoopDirective(directiveWith(`loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\n${line}`)),
    ).toThrow(expected);
  });

  it('refuses a missing or unknown engine', () => {
    expect(() => parseLoopDirective(directiveWith('loop: fix\nmission: Drain\nqueue: ledger'))).toThrow(
      /missing 'engine'/,
    );
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine: worker\nmission: Drain\nqueue: ledger')),
    ).toThrow(/unknown engine 'worker'/);
  });

  it('refuses a missing queue', () => {
    expect(() => parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nmission: Drain'))).toThrow(
      /missing 'queue'/,
    );
  });

  it('refuses an unknown slice', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\nslice: sometimes')),
    ).toThrow(/unknown slice 'sometimes'/);
  });

  it('refuses a non-boolean paused', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\npaused: yes')),
    ).toThrow(/malformed paused 'yes' — expected true or false/);
  });

  it('refuses a missing or malformed repo under the github queue', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: find\nengine: producer\nmission: Find\nqueue: github')),
    ).toThrow(/queue 'github' requires 'repo: owner\/name'/);
    expect(() =>
      parseLoopDirective(directiveWith('loop: find\nengine: producer\nmission: Find\nqueue: github\nrepo: justname')),
    ).toThrow(/malformed repo 'justname'/);
  });

  it('refuses a field belonging to the other backend', () => {
    expect(() =>
      parseLoopDirective(
        directiveWith('loop: find\nengine: producer\nmission: Find\nqueue: github\nrepo: o/n\npath: flow/loops/q.jsonl'),
      ),
    ).toThrow(/'path' applies to queue 'ledger' only/);
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\nrepo: o/n')),
    ).toThrow(/'repo' applies to queue 'github' only/);
  });

  it('refuses an unknown key rather than running with it silently dropped', () => {
    expect(() =>
      parseLoopDirective(
        directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\nmax_open_issue: 3'),
      ),
    ).toThrow(/unknown frontmatter key 'max_open_issue'/);
  });

  it('refuses a duplicate key rather than picking one of two missions', () => {
    expect(() =>
      parseLoopDirective(
        directiveWith('loop: fix\nengine: consumer\nmission: Drain\nmission: Something else\nqueue: ledger'),
      ),
    ).toThrow(/duplicate frontmatter key 'mission'/);
  });

  it('refuses a malformed loop name', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: Fix Loop\nengine: consumer\nmission: Drain\nqueue: ledger')),
    ).toThrow(/malformed loop name 'Fix Loop'/);
  });

  it('refuses a frontmatter line that is not key: value', () => {
    expect(() =>
      parseLoopDirective(directiveWith('loop: fix\nengine consumer\nmission: Drain\nqueue: ledger')),
    ).toThrow(/malformed frontmatter line 'engine consumer'/);
  });

  it('lists every valid key in the unknown-key refusal', () => {
    try {
      parseLoopDirective(directiveWith('loop: fix\nengine: consumer\nmission: Drain\nqueue: ledger\nbogus: 1'));
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      for (const key of DIRECTIVE_KEYS) {
        expect(message).toContain(key);
      }
    }
  });
});

/**
 * The topic is the one directive field that becomes REPO CONFIGURATION — the
 * GitHub backend creates a missing topic label — so the grammar is proven in
 * both directions here: what it accepts, and that everything else REFUSES with
 * the offending value visible rather than being quietly rewritten.
 */
describe('topic', () => {
  function withTopic(topic: string): string {
    return directiveWith(`loop: find\nengine: producer\nmission: Find\nqueue: ledger\ntopic: ${topic}`);
  }

  it.each(['codemap', 'src/cli', 'board.v2', 'panel_model', 'a', 'e2e-flow-1'])(
    'accepts a bounded, lowercase, label-shaped topic (%s)',
    (topic) => {
      expect(parseLoopDirective(withTopic(topic)).topic).toBe(topic);
    },
  );

  it('accepts a topic at exactly the length cap', () => {
    const topic = 'a'.repeat(TOPIC_MAX_LENGTH);
    expect(parseLoopDirective(withTopic(topic)).topic).toBe(topic);
  });

  it('is independent of the provenance label — an item can carry both', () => {
    const directive = parseLoopDirective(
      directiveWith('loop: find\nengine: producer\nmission: Find\nqueue: ledger\nlabel: qa-heartbeat\ntopic: codemap'),
    );
    expect(directive.label).toBe('qa-heartbeat');
    expect(directive.topic).toBe('codemap');
  });

  it('reads an empty topic as absence, mirroring label', () => {
    expect(parseLoopDirective(withTopic('')).topic).toBeUndefined();
  });

  it.each([
    ['Codemap', /malformed topic 'Codemap'/],
    ['-codemap', /malformed topic '-codemap'/],
    ['codemap-', /malformed topic 'codemap-'/],
    ['code map', /malformed topic 'code map'/],
    ['code;map', /malformed topic 'code;map'/],
    ['"codemap"', /malformed topic '"codemap"'/],
    ['$(whoami)', /malformed topic '\$\(whoami\)'/],
  ])('refuses a topic outside the grammar (%s), showing what was rejected', (topic, expected) => {
    expect(() => parseLoopDirective(withTopic(topic), 'flow/loops/find.md')).toThrow(expected);
    expect(() => parseLoopDirective(withTopic(topic), 'flow/loops/find.md')).toThrow(/flow\/loops\/find\.md:/);
  });

  it('refuses a topic longer than the cap', () => {
    const topic = 'a'.repeat(TOPIC_MAX_LENGTH + 1);
    expect(() => parseLoopDirective(withTopic(topic))).toThrow(
      new RegExp(`malformed topic '${topic}' — expected at most ${TOPIC_MAX_LENGTH} characters`),
    );
  });

  it.each([...RESERVED_LABELS])('refuses a topic that impersonates queue state (%s)', (label) => {
    expect(() => parseLoopDirective(withTopic(label))).toThrow(
      new RegExp(`reserved topic '${label}'`),
    );
  });

  it('never sanitizes — a rejected topic yields no directive at all', () => {
    let parsed: unknown = 'not thrown';
    try {
      parsed = parseLoopDirective(withTopic('Code Map'));
    } catch (error) {
      parsed = error;
    }
    expect(parsed).toBeInstanceOf(Error);
  });
});

describe('extractSection', () => {
  it('returns the prose under a heading and stops at the next one', () => {
    const body = '## Direction\n\nline one\nline two\n\n## Rules\n\nrule one\n';
    expect(extractSection(body, 'Direction')).toBe('line one\nline two');
    expect(extractSection(body, 'Rules')).toBe('rule one');
  });

  it('returns the empty string for an absent section', () => {
    expect(extractSection('## Rules\n\nonly rules\n', 'Direction')).toBe('');
  });
});

describe('readLoopDirective', () => {
  let tempDir: string;
  let flowDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-flow-loop-directive-test-'));
    flowDir = join(tempDir, 'flow');
    // Both homes exist: the tracked <root>/loops/ that directives live in, and
    // the legacy flow/loops/ that still holds runtime state.
    mkdirSync(join(flowDir, 'loops'), { recursive: true });
    mkdirSync(join(tempDir, 'loops'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // The bug this guards: directives once lived under flow/, which is a symlink
  // into the vault that git refuses to track — so "edit the mission, commit,
  // and the next beat pulls it" could never work across machines.
  it('resolves a directive from the TRACKED loops/ dir, which git can carry', () => {
    writeFileSync(join(tempDir, 'loops', 'find.md'), FULL_DIRECTIVE, 'utf-8');
    expect(readLoopDirective(flowDir, 'find').loop).toBe('find');
  });

  it('still reads a legacy flow/loops/ directive, so a mid-migration machine keeps working', () => {
    writeFileSync(join(flowDir, 'loops', 'find.md'), FULL_DIRECTIVE, 'utf-8');
    expect(readLoopDirective(flowDir, 'find').loop).toBe('find');
  });

  it('prefers the tracked copy — a committed directive is never shadowed by a stale local one', () => {
    writeFileSync(join(tempDir, 'loops', 'find.md'), FULL_DIRECTIVE, 'utf-8');
    writeFileSync(
      join(flowDir, 'loops', 'find.md'),
      FULL_DIRECTIVE.replace('Find cleanup targets in the repo', 'STALE LOCAL MISSION'),
      'utf-8',
    );
    expect(readLoopDirective(flowDir, 'find').mission).toBe('Find cleanup targets in the repo');
  });

  it('names BOTH homes when nothing resolves, so the reader is not sent back where they looked', () => {
    let message = '';
    try {
      readLoopDirective(flowDir, 'missing');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(join(tempDir, 'loops', 'missing.md'));
    expect(message).toContain(join(flowDir, 'loops', 'missing.md'));
  });

  it('reads and parses the tracked loops/<name>.md', () => {
    writeFileSync(loopDirectivePath(flowDir, 'find'), FULL_DIRECTIVE, 'utf-8');
    const directive = readLoopDirective(flowDir, 'find');
    expect(directive.loop).toBe('find');
    expect(directive.mission).toBe('Find cleanup targets in the repo');
  });

  it('refuses when the directive file does not exist', () => {
    expect(() => readLoopDirective(flowDir, 'ghost')).toThrow(/no directive for loop 'ghost'/);
  });

  it('refuses when the loop field disagrees with the filename', () => {
    writeFileSync(loopDirectivePath(flowDir, 'find'), MINIMAL_DIRECTIVE, 'utf-8');
    expect(() => readLoopDirective(flowDir, 'find')).toThrow(
      /loop 'fix' does not match its filename 'find\.md'/,
    );
  });

  it('names the file path in a parse refusal', () => {
    writeFileSync(
      loopDirectivePath(flowDir, 'find'),
      directiveWith('loop: find\nengine: producer\nqueue: ledger'),
      'utf-8',
    );
    expect(() => readLoopDirective(flowDir, 'find')).toThrow(
      new RegExp(`${loopDirectivePath(flowDir, 'find').replace(/[/\\]/g, '.')}: missing 'mission'`),
    );
  });
});

// ── the shipped seed templates (Tasks 3.1 / 3.5) ────────────────────────────
// A template that refuses at boot is worse than no template at all: the user
// would have run `init`, been told loops were seeded, and then hit a refusal on
// their first beat. So the parser — the thing that would refuse — is what
// proves them, in BOTH the forms `init` can write: the shipped ledger form when
// no remote resolves, and the github form when one does.
describe('shipped loop directive templates', () => {
  const templates = loopTemplateFiles(PACKAGE_ROOT);

  function templateContent(file: string): string {
    return readFileSync(join(loopTemplatesDir(PACKAGE_ROOT), file), 'utf-8');
  }

  it('ships TWO seed directives from templates/, not from this repo’s own loops/', () => {
    // Two, not three. `improve` was a third loop that differed from `find` only
    // in its prose — what it looked for is an instruction now, not an identity,
    // and its taste bar moved into the producer's own direction.
    expect(templates).toEqual(['find.md', 'fix.md']);
    // This repo's `loops/` are its OWN directives — its repo, its missions, its
    // verification commands — and must never be what a user's project gets.
    expect(loopTemplatesDir(PACKAGE_ROOT)).toBe(join(PACKAGE_ROOT, 'templates', 'loops'));
  });

  it.each(templates)('%s parses as shipped, with no remote to bind', (file) => {
    const directive = parseLoopDirective(templateContent(file), `templates/loops/${file}`);

    expect(directive.loop).toBe(file.replace(/\.md$/, ''));
    expect(directive.mission.length).toBeGreaterThan(0);
    // The whole point of the ledger form: it needs no `repo:`, so a project with
    // no GitHub remote still gets a directive that parses.
    expect(directive.queue).toBe('ledger');
    expect(directive.repo).toBeUndefined();
  });

  it.each(templates)('%s is seeded PAUSED — resuming it is the user’s deliberate act', (file) => {
    expect(parseLoopDirective(templateContent(file), file).paused).toBe(true);
  });

  it.each(templates)('%s parses once bound to a resolved remote', (file) => {
    const bound = bindDirectiveQueue(templateContent(file), 'octocat/hello-world');
    const directive = parseLoopDirective(bound, `loops/${file}`);

    expect(directive.queue).toBe('github');
    expect(directive.repo).toBe('octocat/hello-world');
    expect(directive.paused).toBe(true);
  });

  it.each(templates)('%s carries prose a reader can act on cold', (file) => {
    const directive = parseLoopDirective(templateContent(file), file);
    expect(directive.direction.length).toBeGreaterThan(0);
    expect(directive.rules.length).toBeGreaterThan(0);
  });

  it('binds nothing when no remote resolved — the shipped bytes are written as-is', () => {
    const raw = templateContent('fix.md');
    expect(bindDirectiveQueue(raw, null)).toBe(raw);
  });
});
