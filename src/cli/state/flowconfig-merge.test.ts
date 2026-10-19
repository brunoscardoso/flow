/**
 * flowconfig-merge — THE ONE algorithm that turns `.flowconfig` text plus a set
 * of key changes into new text (allowed-pattern #14).
 *
 * The golden cases below are the ones that decide whether a co-owned,
 * hand-edited file survives being written by a program: a person's comments,
 * their blank lines, and the ORDER they put things in are all part of the file,
 * and a merge that only gets the keys right has still damaged it. Everything
 * here is text in / text out — no filesystem, because the algorithm has none.
 */

import { mergeFlowconfig, parseFlowconfigKeys } from './flowconfig-merge.js';

describe('mergeFlowconfig — upsert', () => {
  it('replaces a key IN PLACE, keeping its position in the file', () => {
    const before = ['autopilot: true', 'remote: origin', 'push: false'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { remote: 'upstream' })).toBe(
      ['autopilot: true', 'remote: upstream', 'push: false'].join('\n') + '\n',
    );
  });

  it('appends a key the file has never held', () => {
    expect(mergeFlowconfig('autopilot: true\n', { base_refresh: 'false' })).toBe(
      'autopilot: true\nbase_refresh: false\n',
    );
  });

  it('appends under the last real line, not after the gap below it', () => {
    // Otherwise every append grows the gap by one and the file drifts apart.
    const before = 'autopilot: true\n\n\n';
    expect(mergeFlowconfig(before, { remote: 'origin' })).toBe('autopilot: true\nremote: origin\n');
  });

  it('writes into an empty file', () => {
    expect(mergeFlowconfig('', { remote: 'origin' })).toBe('remote: origin\n');
  });

  it('applies several keys at once, in-place ones in place and new ones appended', () => {
    const before = ['# top', 'remote: origin', 'push: false'].join('\n') + '\n';
    const after = mergeFlowconfig(before, { remote: 'upstream', branch: 'main' });
    expect(after).toBe(['# top', 'remote: upstream', 'push: false', 'branch: main'].join('\n') + '\n');
  });

  it('handles a dotted key like any other', () => {
    const before = 'engines.lavish: declined\n';
    expect(mergeFlowconfig(before, { 'engines.lavish': 'enabled' })).toBe('engines.lavish: enabled\n');
    expect(mergeFlowconfig('autopilot: true\n', { 'engines.graphify': 'enabled' })).toBe(
      'autopilot: true\nengines.graphify: enabled\n',
    );
  });

  it('writes an empty value as an empty value, not as a deletion', () => {
    // `null` deletes; `''` is a key present and blank, which every reader in
    // this repo treats as "no opinion" — a different statement from absence,
    // and not this function's business to conflate.
    expect(mergeFlowconfig('branch: main\n', { branch: '' })).toBe('branch: \n');
  });
});

describe('mergeFlowconfig — delete', () => {
  it('removes the key line and nothing else', () => {
    const before = ['autopilot: true', 'branch: main', 'push: false'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { branch: null })).toBe('autopilot: true\npush: false\n');
  });

  it('is a no-op for a key the file does not hold', () => {
    expect(mergeFlowconfig('autopilot: true\n', { branch: null })).toBe('autopilot: true\n');
  });

  it('leaves an empty string when the last key is removed', () => {
    expect(mergeFlowconfig('branch: main\n', { branch: null })).toBe('');
  });
});

describe('mergeFlowconfig — what it must never touch', () => {
  it('preserves comments, blank lines and order byte-for-byte', () => {
    const before = [
      '# Plan-flow settings',
      '# edited by hand, and that has to keep working',
      '',
      'autopilot: true',
      '',
      '# git',
      'remote: origin',
      'push: false',
      '',
    ].join('\n');
    const after = mergeFlowconfig(before, { push: 'true' });
    expect(after).toBe(before.replace('push: false', 'push: true').replace(/\n*$/, '\n'));
    expect(after).toContain('# Plan-flow settings');
    expect(after).toContain('# git');
  });

  it('does not treat an indented line as a key', () => {
    // The parser anchors every extractor at `^key:`, so a line it cannot see
    // must not be a line the writer rewrites — otherwise a write reports
    // success over a value nothing ever reads.
    const before = 'commands:\n  lint: npm run lint\n';
    const after = mergeFlowconfig(before, { lint: 'nope' });
    expect(after).toBe('commands:\n  lint: npm run lint\nlint: nope\n');
  });

  it('never mistakes a key for a PREFIX of a longer one', () => {
    // `remote` must not match `remote_branch_pattern:` — the same care
    // forbidden-pattern #16 took on the read side.
    const before = ['remote_branch_pattern: feature/{ticket}', 'remote: origin'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { remote: 'upstream' })).toBe(
      ['remote_branch_pattern: feature/{ticket}', 'remote: upstream'].join('\n') + '\n',
    );
    expect(mergeFlowconfig(before, { remote: null })).toBe('remote_branch_pattern: feature/{ticket}\n');
  });

  it('leaves a comment that merely mentions the key alone', () => {
    const before = ['# remote: upstream was tried once', 'remote: origin'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { remote: 'fork' })).toBe(
      ['# remote: upstream was tried once', 'remote: fork'].join('\n') + '\n',
    );
  });

  it('returns the text UNCHANGED when there is nothing to apply', () => {
    const before = '# just a comment\n\nautopilot: true\n\n\n';
    // Not even the trailing-newline normalisation: no updates is no write.
    expect(mergeFlowconfig(before, {})).toBe(before);
  });
});

describe('mergeFlowconfig — duplicates', () => {
  it('collapses duplicates of a key it was asked about', () => {
    // The parser reads the FIRST line for a key, so a leftover duplicate could
    // pin the value that was just changed. After the merge there is exactly one
    // canonical line per touched key.
    const before = ['remote: origin', 'push: false', 'remote: fork'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { remote: 'upstream' })).toBe(
      ['remote: upstream', 'push: false'].join('\n') + '\n',
    );
  });

  it('collapses them on a delete too', () => {
    const before = ['remote: origin', 'push: false', 'remote: fork'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { remote: null })).toBe('push: false\n');
  });

  it('leaves duplicates of a key NOBODY named exactly where they are', () => {
    const before = ['remote: origin', 'remote: fork', 'push: false'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { push: 'true' })).toBe(
      ['remote: origin', 'remote: fork', 'push: true'].join('\n') + '\n',
    );
  });
});

describe('mergeFlowconfig — the trailing newline', () => {
  it('adds the one a file was missing', () => {
    expect(mergeFlowconfig('autopilot: true', { push: 'true' })).toBe('autopilot: true\npush: true\n');
  });

  it('collapses several into one', () => {
    expect(mergeFlowconfig('autopilot: true\n\n\n\n', { autopilot: 'false' })).toBe('autopilot: false\n');
  });

  it('ends with nothing at all when the file is emptied', () => {
    const before = ['autopilot: true', 'push: false'].join('\n') + '\n';
    expect(mergeFlowconfig(before, { autopilot: null, push: null })).toBe('');
  });
});

describe('parseFlowconfigKeys — presence, never value', () => {
  it('reports every key the text literally contains, with its raw value', () => {
    const text = ['# a comment', 'autopilot: true', 'remote:  upstream  ', ''].join('\n');
    expect(parseFlowconfigKeys(text)).toEqual({ autopilot: 'true', remote: 'upstream' });
  });

  it('reports a blank key as present with an empty value', () => {
    // This is the whole basis of provenance: a key written blank IS present in
    // the file, and it is the resolver's job — not this reader's — to decide
    // that a blank says nothing.
    expect(parseFlowconfigKeys('branch:\n')).toEqual({ branch: '' });
    expect(parseFlowconfigKeys('branch:   \n')).toEqual({ branch: '' });
  });

  it('lets the FIRST duplicate win, matching the parser', () => {
    expect(parseFlowconfigKeys('remote: origin\nremote: fork\n').remote).toBe('origin');
  });

  it('reads a dotted key as one flat key', () => {
    expect(parseFlowconfigKeys('engines.lavish: enabled\n')).toEqual({ 'engines.lavish': 'enabled' });
  });

  it('sees no key in a comment, an indented line, or a blank line', () => {
    const text = ['# remote: origin', '  remote: origin', '', 'push: true'].join('\n');
    expect(parseFlowconfigKeys(text)).toEqual({ push: 'true' });
  });

  it('finds nothing in an empty file', () => {
    expect(parseFlowconfigKeys('')).toEqual({});
  });

  it('keeps a key literally named __proto__ as a plain entry', () => {
    const keys = parseFlowconfigKeys('__proto__: nope\n');
    expect(keys.__proto__).toBe('nope');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('agrees with the merge about what a key line IS', () => {
    // One grammar, two directions: a key this reader reports is exactly a key
    // the writer would rewrite (allowed-pattern #14).
    const text = ['# remote: x', '  indented: y', 'remote: origin'].join('\n') + '\n';
    const keys = Object.keys(parseFlowconfigKeys(text));
    expect(keys).toEqual(['remote']);
    // Nothing but that key moves when every reported key is rewritten.
    expect(mergeFlowconfig(text, { remote: 'origin' })).toBe(text);
    expect(mergeFlowconfig(text, { indented: 'z' })).toBe(text.replace(/\n$/, '\nindented: z\n'));
  });
});
