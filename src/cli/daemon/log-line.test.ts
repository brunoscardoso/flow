/**
 * The `.heartbeat.log` line contract (#1803).
 *
 * The file is line-oriented and every reader counts physical lines. One
 * `log()` call has to be one of them, whatever it was handed.
 */

import { clipToWord, isDaemonEvent, oneLogLine, outputLogLine } from './log-line.js';

/** The shape that broke it: an agent's markdown final message. */
const AGENT_MESSAGE = [
  'Session complete — a run recorded `empty`, which ends it.',
  '',
  '## Run complete — find (producer)',
  '',
  '| # | Finding |',
  '|---|---|',
  ...Array.from(
    { length: 8 },
    (_, i) =>
      `| [#${1790 + i}](https://github.com/dev/plan-flow/issues/${1790 + i}) | a finding whose title runs on for a while |`,
  ),
].join('\n');

describe('one log call is one physical line (#1803)', () => {
  it('flattens a multi-line agent message', () => {
    // The live artifact: ONE event occupying twelve physical lines, with a
    // timestamp on only the first — which is what made `truncateLog`'s 500-line
    // window hold 126 events and "Recent log" show the middle of a table.
    expect(AGENT_MESSAGE.split('\n').length).toBeGreaterThan(1);
    expect(oneLogLine(AGENT_MESSAGE).split('\n')).toHaveLength(1);
  });

  it.each([
    ['a newline', 'a\nb'],
    ['a carriage return', 'a\r\nb'],
    ['a tab', 'a\tb'],
    ['a blank line', 'a\n\nb'],
  ])('collapses %s to a single space', (_label, input) => {
    expect(oneLogLine(input)).toBe('a b');
  });

  it('leaves an ordinary daemon event exactly as it was', () => {
    // The common case must be untouched — this runs on every event the daemon
    // writes, not only on agent output.
    const event = 'Executing "loop-find": /agent-loop find';
    expect(oneLogLine(event)).toBe(event);
  });
});

describe('truncation does not sever a token (#1803)', () => {
  it('cuts back to a word boundary and marks the cut', () => {
    // The live artifact ended at `| [#1795](https:/` — character 500 landing
    // inside a URL, which reads as corruption rather than as truncation.
    const clipped = clipToWord(oneLogLine(AGENT_MESSAGE), 500);

    expect(clipped.length).toBeLessThanOrEqual(501); // + the ellipsis
    expect(clipped.endsWith('…')).toBe(true);
    expect(clipped.slice(0, -1).endsWith(' ')).toBe(false); // trimmed, not ragged
    // Nothing is cut mid-URL: every `https://` in the output is followed by a
    // complete token.
    for (const match of clipped.matchAll(/https:\/\/\S*/g)) {
      expect(match[0].endsWith('…')).toBe(false);
    }
  });

  it('leaves text that fits completely alone', () => {
    expect(clipToWord('short enough', 500)).toBe('short enough');
  });

  it('hard-cuts a single token too long to fall back from', () => {
    // A 500-character word has no space to cut back to, and returning almost
    // nothing would be worse than a hard cut.
    const solid = 'x'.repeat(600);
    const clipped = clipToWord(solid, 100);

    expect(clipped).toBe(`${'x'.repeat(100)}…`);
  });

  it('does not cut back so far that most of the budget is thrown away', () => {
    // `a` then a 90-character token: the only space is at index 1, and honouring
    // it would return one character out of a hundred.
    const clipped = clipToWord(`a ${'y'.repeat(200)}`, 100);

    expect(clipped.length).toBeGreaterThan(90);
  });
});

describe('outputLogLine — the one call every site makes', () => {
  it('produces a single labelled line from multi-line output', () => {
    const line = outputLogLine('output', AGENT_MESSAGE, 500);

    expect(line.split('\n')).toHaveLength(1);
    expect(line.startsWith('output:')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });

  it('says nothing extra when the output is short', () => {
    expect(outputLogLine('stderr', 'boom', 500)).toBe('stderr: boom');
  });
});

describe('a daemon event is recognisable as one', () => {
  it('accepts the writer\'s own line and rejects agent prose', () => {
    expect(isDaemonEvent('[2026-08-26T13:44:39.658Z] Task "loop-fix" skipped')).toBe(true);
    expect(isDaemonEvent('| [#1795](https:/')).toBe(false);
    expect(isDaemonEvent('')).toBe(false);
    expect(isDaemonEvent('**Verdict**: proceed')).toBe(false);
    // A markdown table row starting with `[` must not pass for a timestamp.
    expect(isDaemonEvent('[#1795](https://github.com/x/y/issues/1795) | a finding')).toBe(false);
  });
});
