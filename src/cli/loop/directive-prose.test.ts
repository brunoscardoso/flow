/**
 * Writing a directive's prose sections.
 *
 * `## Direction` and `## Rules` are, in the grammar's words, "prose handed to
 * the run verbatim" — what to look at, and the loop's own standing judgments.
 * Nothing could write them: the directive writer knew `paused:` and the queue
 * fields and stopped there, so steering a loop meant opening the file, and the
 * IDE could not offer it at all (the app may never author a directive).
 *
 * THE RISK IS PRODUCING A DIRECTIVE THE READER REFUSES, which is why every case
 * below parses the result rather than eyeballing the text — a rewrite that
 * loses the frontmatter or orphans a heading does not degrade a loop, it stops
 * one.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { withProseSection, setDirectiveProse, withCapField, setDirectiveCap } = await import(
  './directive-writer.js'
);
const { parseLoopDirective } = await import('./directive-parser.js');
const { DEFAULT_MAX_OPEN_ISSUES } = await import('./types.js');

const DIRECTIVE = [
  '---',
  'loop: find',
  'engine: producer',
  'paused: false',
  'mission: find things',
  'queue: ledger',
  '---',
  '',
  '## Direction',
  '',
  'Look at the UI first.',
  '',
  '## Rules',
  '',
  'Never file a duplicate.',
  '',
].join('\n');

/** Parse a rewrite, so no test can pass on bytes the reader would refuse. */
function reparse(content: string) {
  return parseLoopDirective(content, 'find.md');
}

describe('withProseSection', () => {
  it('replaces a section and leaves its sibling byte for byte', () => {
    const out = withProseSection(DIRECTIVE, 'Direction', 'Look at the loops panel.');
    const directive = reparse(out);
    expect(directive.direction).toBe('Look at the loops panel.');
    expect(directive.rules).toBe('Never file a duplicate.');
    expect(directive.mission).toBe('find things');
  });

  it('keeps a multi-line body, blank lines and all', () => {
    const out = withProseSection(DIRECTIVE, 'Rules', 'One.\nTwo.\n\nThree.');
    expect(reparse(out).rules).toBe('One.\nTwo.\n\nThree.');
  });

  // EMPTY IS A STATE, NOT A MISTAKE. A heading with nothing under it reads as
  // one somebody forgot to fill in, so clearing removes the section outright.
  it('removes the section when the text is empty', () => {
    const out = withProseSection(DIRECTIVE, 'Direction', '   ');
    expect(out).not.toContain('## Direction');
    const directive = reparse(out);
    expect(directive.direction).toBe('');
    expect(directive.rules).toBe('Never file a duplicate.');
  });

  it('appends a section the directive does not have', () => {
    const withoutRules = DIRECTIVE.replace(/## Rules[\s\S]*$/, '');
    const out = withProseSection(withoutRules, 'Rules', 'One finding per item.');
    const directive = reparse(out);
    expect(directive.rules).toBe('One finding per item.');
    expect(directive.direction).toBe('Look at the UI first.');
  });

  // The grammar lists Direction before Rules, so an appended Direction goes
  // where a reader expects it rather than after the section it introduces.
  it('appends Direction ABOVE an existing Rules', () => {
    const withoutDirection = DIRECTIVE.replace('## Direction\n\nLook at the UI first.\n\n', '');
    const out = withProseSection(withoutDirection, 'Direction', 'Start with the panel.');
    expect(out.indexOf('## Direction')).toBeLessThan(out.indexOf('## Rules'));
    expect(reparse(out).direction).toBe('Start with the panel.');
  });

  it('leaves the file alone when asked to remove a section it does not have', () => {
    const withoutRules = DIRECTIVE.replace(/## Rules[\s\S]*$/, '');
    expect(withProseSection(withoutRules, 'Rules', '')).toBe(withoutRules);
  });

  it('preserves CRLF, because a Windows checkout writes it', () => {
    const crlf = DIRECTIVE.replace(/\n/g, '\r\n');
    const out = withProseSection(crlf, 'Rules', 'One finding per item.');
    expect(out).toContain('\r\n');
    expect(out).not.toMatch(/[^\r]\n/);
    expect(reparse(out).rules).toBe('One finding per item.');
  });
});

describe('setDirectiveProse', () => {
  let dir: string;
  let loops: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prose-write-'));
    loops = join(dir, 'loops');
    mkdirSync(loops, { recursive: true });
    writeFileSync(join(loops, 'find.md'), DIRECTIVE, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the section and reports what the re-parse read back', () => {
    const result = setDirectiveProse(dir, 'find', 'Rules', 'Screenshots or it did not happen.');
    expect(result.changed).toBe(true);
    expect(result.text).toBe('Screenshots or it did not happen.');
    expect(reparse(readFileSync(join(loops, 'find.md'), 'utf-8')).rules).toBe(
      'Screenshots or it did not happen.',
    );
  });

  // The rule every other write verb follows: the caller asked for a state and
  // the state is the one on disk.
  it('asking for what the file already says is a success that wrote nothing', () => {
    const before = readFileSync(join(loops, 'find.md'), 'utf-8');
    const result = setDirectiveProse(dir, 'find', 'Direction', 'Look at the UI first.');
    expect(result.changed).toBe(false);
    expect(readFileSync(join(loops, 'find.md'), 'utf-8')).toBe(before);
  });

  it('refuses a loop that has no directive, writing nothing', () => {
    expect(() => setDirectiveProse(dir, 'nope', 'Rules', 'x')).toThrow();
  });
});
/**
/**
 * The cap — `max_open_issues`, the one stop a loop keeps by default.
 *
 * The directive's own leash, and until this writer existed it could only be
 * changed by opening the markdown. Time is not one: the grammar says of
 * `max_run_minutes` that nothing measures a run's elapsed time and no verb
 * refuses on it. So the count of open items is the whole of what a loop stops
 * on unless somebody writes it a rule of its own.
 *
 * Distinct from a hunt's `--cap`, which bounds one instruction's filings rather
 * than the loop's standing backlog. These tests exist so the number a person
 * picks is the number the gate reads back.
 */
describe('withCapField', () => {
  it('sets the key when the directive does not carry one', () => {
    // The fixture carries no `max_open_issues` — the state a freshly
    // seeded project is in, and the one the two defaults disagreed about.
    const out = withCapField(DIRECTIVE, 12);
    expect(reparse(out).maxOpenIssues).toBe(12);
    expect(reparse(out).mission).toBe('find things');
  });

  it('replaces an existing cap in place', () => {
    const withCap = DIRECTIVE.replace(
      'mission: find things',
      ['mission: find things', 'max_open_issues: 3'].join('\n'),
    );
    const out = withCapField(withCap, 9);
    expect(reparse(out).maxOpenIssues).toBe(9);
    expect(out.match(/max_open_issues:/g)).toHaveLength(1);
  });

  it('leaves the prose sections untouched', () => {
    const directive = reparse(withCapField(DIRECTIVE, 5));
    expect(directive.direction).toBe('Look at the UI first.');
    expect(directive.rules).toBe('Never file a duplicate.');
  });

  it('preserves CRLF, because a Windows checkout writes it', () => {
    const out = withCapField(DIRECTIVE.replace(/\n/g, '\r\n'), 6);
    expect(out).not.toMatch(/[^\r]\n/);
    expect(reparse(out).maxOpenIssues).toBe(6);
  });
});

describe('setDirectiveCap', () => {
  let dir: string;
  let loops: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cap-write-'));
    loops = join(dir, 'loops');
    mkdirSync(loops, { recursive: true });
    writeFileSync(join(loops, 'find.md'), DIRECTIVE, 'utf-8');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the cap and reports what the re-parse read back', () => {
    const result = setDirectiveCap(dir, 'find', 15);
    expect(result.changed).toBe(true);
    expect(result.cap).toBe(15);
    expect(reparse(readFileSync(join(loops, 'find.md'), 'utf-8')).maxOpenIssues).toBe(15);
  });

  // The default is a RESOLVED value, not an absent one: a directive with no key
  // already has a cap, and `wasCap` reports it rather than null.
  it('reports the resolved previous cap, default included', () => {
    expect(setDirectiveCap(dir, 'find', 15).wasCap).toBe(DEFAULT_MAX_OPEN_ISSUES);
  });

  it('asking for the cap the file already has writes nothing', () => {
    setDirectiveCap(dir, 'find', 15);
    const before = readFileSync(join(loops, 'find.md'), 'utf-8');
    const again = setDirectiveCap(dir, 'find', 15);
    expect(again.changed).toBe(false);
    expect(readFileSync(join(loops, 'find.md'), 'utf-8')).toBe(before);
  });

  // A cap of zero would stop the loop before its first finding, and a fraction
  // is a caller that never parsed its input. Both refuse rather than write.
  it.each([0, -1, 2.5, Number.NaN])('refuses %p, writing nothing', (bad) => {
    const before = readFileSync(join(loops, 'find.md'), 'utf-8');
    expect(() => setDirectiveCap(dir, 'find', bad)).toThrow();
    expect(readFileSync(join(loops, 'find.md'), 'utf-8')).toBe(before);
  });

  it('refuses a loop that has no directive', () => {
    expect(() => setDirectiveCap(dir, 'nope', 5)).toThrow();
  });
});
