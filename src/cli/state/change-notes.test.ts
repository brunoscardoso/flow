/**
 * Change notes — the grammar, the one parser, quote resolution and the
 * one-note rewrite (plan change review, Phase 1).
 */

import {
  countNotes,
  parseChangeNotes,
  parseNoteTarget,
  resolveQuote,
  setNoteStatus,
  setNoteVerdict,
} from './change-notes.js';

const PLAN = `# Plan: Example

## Phases

### Phase 1: Wire it
**Complexity**: 4/10

- [ ] Change the hook

#### Change notes

- note: 1 · change · file:src/a.ts:useThing
    where: \`: planSelectorRequested && isTenantFull)\`
    what: the regular-chat branch uses isPlanSelectorVisible
    why: the button already shows for Lite
    status: accepted
    comments:
      - keep the coworker branch as is
      - Task 2 is a comment, not a task
- note: 2 · new · file:src/b.ts:isSlashMenuEligible
    signature: isSlashMenuEligible(tier, hasPublishedPlaybooks): boolean
    purpose: one rule shared by the button
      and the slash menu
    callers: useThing, \`SlashMenu.open\`
    status: rejected — keep it inline; one call site

### Phase 2: Elsewhere
**Complexity**: 3/10

#### Change notes

- note: 3 - file - api/file:src/routes.ts
    what: register the route
    why: the app calls it
    verdict: done — the route is registered
- note: 4 | change | file:src/c.ts:Store.save
    where: \`this.write(\`
    what: write through the lock
    why: two writers raced
`;

describe('parseChangeNotes — the grammar', () => {
  const parsed = parseChangeNotes(PLAN);

  it('reads every note with its phase, kind, target and fields', () => {
    expect(parsed.unreadable).toEqual([]);
    expect(parsed.notes.map((note) => [note.n, note.phase, note.kind])).toEqual([
      [1, 1, 'change'],
      [2, 1, 'new'],
      [3, 2, 'file'],
      [4, 2, 'change'],
    ]);
    const [first, second, third, fourth] = parsed.notes;
    expect(first).toMatchObject({
      target: { raw: 'file:src/a.ts:useThing', file: 'src/a.ts', symbol: 'useThing' },
      where: ': planSelectorRequested && isTenantFull)',
      what: 'the regular-chat branch uses isPlanSelectorVisible',
      why: 'the button already shows for Lite',
      status: 'accepted',
      comments: ['keep the coworker branch as is', 'Task 2 is a comment, not a task'],
    });
    expect(first?.reason).toBeUndefined();
    expect(second).toMatchObject({
      signature: 'isSlashMenuEligible(tier, hasPublishedPlaybooks): boolean',
      purpose: 'one rule shared by the button and the slash menu',
      callers: ['useThing', 'SlashMenu.open'],
      status: 'rejected',
      reason: 'keep it inline; one call site',
    });
    expect(third).toMatchObject({
      target: { raw: 'api/file:src/routes.ts', project: 'api', file: 'src/routes.ts' },
      status: 'proposed',
      verdict: 'done',
      verdictWhy: 'the route is registered',
    });
    expect(third?.target.symbol).toBeUndefined();
    expect(fourth?.target).toEqual({ raw: 'file:src/c.ts:Store.save', file: 'src/c.ts', symbol: 'Store.save' });
  });

  it('reports 1-based line ranges and the status / verdict lines', () => {
    const lines = PLAN.split('\n');
    const first = parsed.notes[0];
    expect(lines[(first?.startLine ?? 0) - 1]).toBe('- note: 1 · change · file:src/a.ts:useThing');
    expect(lines[(first?.endLine ?? 0) - 1]).toBe('      - Task 2 is a comment, not a task');
    expect(lines[(first?.statusLine ?? 0) - 1]).toBe('    status: accepted');
    expect(lines[(parsed.notes[2]?.verdictLine ?? 0) - 1]).toContain('verdict: done');
  });

  it('reports each block so the plan parser can keep its lines out of tasks', () => {
    expect(parsed.blocks).toHaveLength(2);
    const lines = PLAN.split('\n');
    expect(lines[(parsed.blocks[0]?.startLine ?? 0) - 1]).toBe('#### Change notes');
  });

  it('a missing status reads as proposed', () => {
    expect(parsed.notes[3]?.status).toBe('proposed');
    expect(parsed.notes[3]?.statusLine).toBeUndefined();
  });

  it('a plan with no notes has nothing to report', () => {
    expect(parseChangeNotes('# Plan\n\n### Phase 1: A\n\n- [ ] a\n')).toEqual({ notes: [], unreadable: [], blocks: [] });
  });

  it('counts accepted, rejected and unreviewed', () => {
    expect(countNotes(parsed.notes)).toEqual({ total: 4, accepted: 1, rejected: 1, unreviewed: 2 });
  });
});

describe('parseChangeNotes — what it cannot read is reported, never dropped', () => {
  const wrap = (body: string): string => `### Phase 1: A\n\n#### Change notes\n\n${body}\n`;

  const cases: Array<[string, string, RegExp]> = [
    ['an unknown kind', '- note: 1 · tweak · file:src/a.ts:x\n    what: a\n    why: b', /not a note kind/],
    ['a bad target', '- note: 1 · change · src/a.ts:x\n    where: `a`\n    what: a\n    why: b', /not a target/],
    ['a change note without a function', '- note: 1 · change · file:src/a.ts\n    where: `a`\n    what: a\n    why: b', /names its function/],
    ['a file note with a function', '- note: 1 · file · file:src/a.ts:x\n    what: a\n    why: b', /names a file, not a function/],
    ['an unknown status', '- note: 1 · file · file:src/a.ts\n    what: a\n    why: b\n    status: maybe', /not a status/],
    ['an unknown verdict', '- note: 1 · file · file:src/a.ts\n    what: a\n    why: b\n    verdict: kinda — eh', /not a verdict/],
    ['a change note without where', '- note: 1 · change · file:src/a.ts:x\n    what: a\n    why: b', /needs `where:`/],
    ['a new note without signature', '- note: 1 · new · file:src/a.ts:x\n    purpose: a', /needs `signature:`/],
    ['a field of another kind', '- note: 1 · file · file:src/a.ts\n    what: a\n    why: b\n    signature: x()', /not a field of a file note/],
    ['a field written twice', '- note: 1 · file · file:src/a.ts\n    what: a\n    what: b\n    why: c', /written twice/],
    ['a header with too few parts', '- note: 1 · change', /three parts/],
    ['a header with no number', '- note: one · file · file:a.ts', /not a note number/],
  ];

  it.each(cases)('%s', (_label, body, reason) => {
    const parsed = parseChangeNotes(wrap(body));
    expect(parsed.notes).toEqual([]);
    expect(parsed.unreadable).toHaveLength(1);
    expect(parsed.unreadable[0]?.line).toBe(5);
    expect(parsed.unreadable[0]?.reason).toMatch(reason);
  });

  it('a blank status value never reads the next line as the status (forbidden-pattern #16)', () => {
    const parsed = parseChangeNotes(wrap('- note: 1 · file · file:src/a.ts\n    what: a\n    status:\n    why: accepted'));
    expect(parsed.notes).toEqual([]);
    expect(parsed.unreadable[0]?.reason).toMatch(/not a status/);
  });

  it('a number two notes share is reported for both — neither silently wins', () => {
    const parsed = parseChangeNotes(
      wrap('- note: 1 · file · file:a.ts\n    what: a\n    why: b\n- note: 1 · file · file:b.ts\n    what: c\n    why: d'),
    );
    expect(parsed.notes).toEqual([]);
    expect(parsed.unreadable.map((entry) => entry.reason)).toEqual([
      'note 1 is numbered twice — every note needs its own number',
      'note 1 is numbered twice — every note needs its own number',
    ]);
  });

  it('a block outside any phase, and a note outside any block, are reported', () => {
    const parsed = parseChangeNotes(
      '# Plan\n\n#### Change notes\n\n- note: 1 · file · file:a.ts\n    what: a\n    why: b\n\n### Phase 1: A\n\n- note: 2 · file · file:b.ts\n',
    );
    expect(parsed.notes).toEqual([]);
    expect(parsed.unreadable.map((entry) => entry.line)).toEqual([3, 5, 11]);
    expect(parsed.unreadable[1]?.reason).toMatch(/outside any phase/);
    expect(parsed.unreadable[2]?.reason).toMatch(/belongs under a `#### Change notes` heading/);
  });

  it('a section after the phases ends the phase — a block there is outside any phase', () => {
    const parsed = parseChangeNotes('### Phase 1: A\n\n## Key Changes\n\n#### Change notes\n\n- note: 1 · file · file:a.ts\n    what: a\n    why: b\n');
    expect(parsed.notes).toEqual([]);
    expect(parsed.unreadable.length).toBeGreaterThan(0);
  });

  it('a header with two spaces after the dash is reported, and the block goes on', () => {
    const parsed = parseChangeNotes(wrap('-  note: 1 · file · file:a.ts\n    what: a\n    why: b\n- note: 2 · file · file:b.ts\n    what: a\n    why: b'));
    expect(parsed.notes.map((note) => note.n)).toEqual([2]);
    expect(parsed.unreadable).toEqual([expect.objectContaining({ n: 1, line: 5, reason: expect.stringMatching(/one space after the dash/) })]);
  });

  it('an indented header with no note above it is reported, never silently dropped', () => {
    const parsed = parseChangeNotes(wrap('  - note: 3 · file · file:a.ts\n    what: a\n    why: b'));
    expect(parsed.notes).toEqual([]);
    expect(parsed.unreadable).toEqual([expect.objectContaining({ n: 3, line: 5, reason: expect.stringMatching(/not indented/) })]);
  });

  it('the readable notes beside an unreadable one are still read', () => {
    const parsed = parseChangeNotes(wrap('- note: 1 · bogus · file:a.ts\n- note: 2 · file · file:b.ts\n    what: a\n    why: b'));
    expect(parsed.notes.map((note) => note.n)).toEqual([2]);
    expect(parsed.unreadable).toEqual([expect.objectContaining({ n: 1, line: 5 })]);
  });
});

describe('a new note may say why', () => {
  it('reads why on a new note, as the review shows it', () => {
    const plan = [
      '### Phase 1: One',
      '',
      '#### Change notes',
      '',
      '- note: 1 · new · file:src/b.ts:isEligible',
      '  signature: isEligible(tier): boolean',
      '  purpose: one rule',
      '  why: the button and the menu must agree',
      '',
    ].join('\n');
    const { notes, unreadable } = parseChangeNotes(plan);
    expect(unreadable).toEqual([]);
    expect(notes[0]).toMatchObject({ kind: 'new', why: 'the button and the menu must agree' });
  });
});

describe('a file note may quote its place', () => {
  it('reads an optional where on a file note, backticks stripped; without one it is still a file note', () => {
    const plan = [
      '### Phase 1: One',
      '',
      '#### Change notes',
      '',
      '- note: 1 · file · file:src/routes.ts',
      '  where: `export const routes = [`',
      '  what: register the route',
      '  why: the app calls it',
      '- note: 2 · file · file:src/other.ts',
      '  what: export it',
      '  why: shared',
      '',
    ].join('\n');
    const { notes, unreadable } = parseChangeNotes(plan);
    expect(unreadable).toEqual([]);
    expect(notes[0]).toMatchObject({ kind: 'file', where: 'export const routes = [', what: 'register the route' });
    expect(notes[1]).toMatchObject({ kind: 'file', what: 'export it' });
    expect(notes[1]?.where).toBeUndefined();
  });
});

describe('parseNoteTarget', () => {
  it('reads a private method, as the code story names it', () => {
    expect(parseNoteTarget('file:src/pane.ts:ConversationPane.#onStream')).toEqual({
      raw: 'file:src/pane.ts:ConversationPane.#onStream',
      file: 'src/pane.ts',
      symbol: 'ConversationPane.#onStream',
    });
    expect(typeof parseNoteTarget('file:src/pane.ts:Pane.##x')).toBe('string');
  });

  it('reads a sibling project prefix and a Class.method', () => {
    expect(parseNoteTarget('web/file:src/x.tsx:Panel.render')).toEqual({
      raw: 'web/file:src/x.tsx:Panel.render',
      project: 'web',
      file: 'src/x.tsx',
      symbol: 'Panel.render',
    });
  });

  it('refuses a path that leaves the project', () => {
    expect(typeof parseNoteTarget('file:../x.ts:a')).toBe('string');
    expect(typeof parseNoteTarget('file:/abs/x.ts:a')).toBe('string');
  });
});

describe('resolveQuote', () => {
  const FILE = [
    'export function a() {', // 1
    '  const x = compute(', // 2
    '    one,', // 3
    '    two);', // 4
    '  return x;', // 5
    '}', // 6
    'export function b() {', // 7
    '  return x;', // 8
    '}', // 9
  ].join('\n');

  it('finds a quote once, inside the range, across lines and whitespace', () => {
    expect(resolveQuote(FILE, { startLine: 1, endLine: 6 }, 'compute( one,   two);')).toEqual({
      found: 'once',
      startLine: 2,
      endLine: 4,
    });
  });

  it('a quote also present outside the range is found once — never looked for outside', () => {
    expect(resolveQuote(FILE, { startLine: 7, endLine: 9 }, 'return x;')).toEqual({ found: 'once', startLine: 8, endLine: 8 });
  });

  it('a quote found twice is many, never the first', () => {
    expect(resolveQuote(FILE, { startLine: 1, endLine: 9 }, 'return x;')).toEqual({ found: 'many', count: 2 });
  });

  it('never fuzzy: a near miss is none', () => {
    expect(resolveQuote(FILE, { startLine: 1, endLine: 6 }, 'compute(one, two)')).toEqual({ found: 'none' });
    expect(resolveQuote(FILE, { startLine: 1, endLine: 6 }, '   ')).toEqual({ found: 'none' });
  });
});

describe('the one-note rewrite', () => {
  it('rewrites only that note’s status line — every other byte unchanged', () => {
    const next = setNoteStatus(PLAN, 1, 'rejected', 'not\nnow');
    const before = PLAN.split('\n');
    const after = next.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((line, index) => (line === before[index] ? [] : [index]));
    expect(changed).toHaveLength(1);
    expect(after[changed[0] as number]).toBe('    status: rejected — not now');
    expect(parseChangeNotes(next).notes[0]).toMatchObject({ status: 'rejected', reason: 'not now' });
  });

  it('inserts a status after the note’s last line when it has none, at the note’s field indent', () => {
    const next = setNoteStatus(PLAN, 4, 'accepted');
    const before = PLAN.split('\n');
    const note = parseChangeNotes(PLAN).notes[3];
    const after = next.split('\n');
    expect(after).toHaveLength(before.length + 1);
    expect(after[note?.endLine ?? 0]).toBe('    status: accepted');
    expect([...after.slice(0, note?.endLine), ...after.slice((note?.endLine ?? 0) + 1)]).toEqual(before);
    expect(parseChangeNotes(next).notes[3]?.status).toBe('accepted');
  });

  it('proposed on a note without a status line changes nothing', () => {
    expect(setNoteStatus(PLAN, 4, 'proposed')).toBe(PLAN);
  });

  it('a verdict is written beside the comments, and replaced in place later', () => {
    const once = setNoteVerdict(PLAN, 1, 'differs', 'the branch moved');
    expect(parseChangeNotes(once).notes[0]).toMatchObject({ verdict: 'differs', verdictWhy: 'the branch moved', comments: expect.any(Array) });
    const twice = setNoteVerdict(once, 1, 'done', 'fixed');
    expect(twice.split('\n')).toHaveLength(once.split('\n').length);
    expect(parseChangeNotes(twice).notes[0]).toMatchObject({ verdict: 'done', verdictWhy: 'fixed' });
    expect(parseChangeNotes(twice).notes[0]?.comments).toHaveLength(2);
  });

  it('keeps CRLF line endings', () => {
    const crlf = PLAN.replace(/\n/g, '\r\n');
    const next = setNoteStatus(crlf, 4, 'rejected', 'no');
    expect(next.split('\n').every((line, index, all) => index === all.length - 1 || line.endsWith('\r'))).toBe(true);
    expect(parseChangeNotes(next).notes[3]).toMatchObject({ status: 'rejected', reason: 'no' });
  });

  it('refuses a note that is not a readable note', () => {
    expect(() => setNoteStatus(PLAN, 99, 'accepted')).toThrow(/not a readable note/);
  });
});
