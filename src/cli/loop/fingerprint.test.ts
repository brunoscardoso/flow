/**
 * Tests for loop fingerprints.
 *
 * Pure module, so no fs, no clock and no mocks — the whole surface is inputs to
 * outputs. The load-bearing assertions are the two directions of the dedup
 * question: two cosmetically-different reports of ONE finding must collide, and
 * two genuinely different findings must not.
 */

import {
  FINGERPRINT_LENGTH,
  FINGERPRINT_MARKER_PATTERN,
  bodyHasFingerprint,
  extractFingerprint,
  fingerprintMarker,
  isFingerprint,
  loopFingerprint,
  normalizeFingerprintInput,
  normalizePrimaryFile,
  normalizeTitle,
  stripFingerprintMarker,
} from './fingerprint.js';

describe('normalizeTitle', () => {
  it('folds case', () => {
    expect(normalizeTitle('Unhandled Promise Rejection')).toBe('unhandled promise rejection');
  });

  it('turns punctuation into word boundaries', () => {
    expect(normalizeTitle('queue.ts: leaks a handle!')).toBe('queue ts leaks a handle');
  });

  it('collapses digit runs to a single placeholder', () => {
    expect(normalizeTitle('leak at line 42')).toBe('leak at line #');
    expect(normalizeTitle('leak at line 118')).toBe('leak at line #');
  });

  it('keeps a digit placeholder rather than deleting it', () => {
    // "fix 2 leaks" and "fix leaks" are different reports and must stay so.
    expect(normalizeTitle('fix 2 leaks')).not.toBe(normalizeTitle('fix leaks'));
  });

  it('keeps words in non-Latin scripts instead of erasing them', () => {
    expect(normalizeTitle('Fuite mémoire dans le cache')).toBe('fuite mémoire dans le cache');
    expect(normalizeTitle('缓存泄漏 (line 9)')).toBe('缓存泄漏 line #');
  });

  it('collapses runs of whitespace and trims', () => {
    expect(normalizeTitle('  too   many    spaces  ')).toBe('too many spaces');
  });

  it('normalizes an all-punctuation title to the empty string', () => {
    expect(normalizeTitle('--- !!! ---')).toBe('');
  });
});

describe('normalizePrimaryFile', () => {
  it('normalizes separators and redundant prefixes', () => {
    expect(normalizePrimaryFile('./src/cli/loop/queue.ts')).toBe('src/cli/loop/queue.ts');
    expect(normalizePrimaryFile('src\\cli\\loop\\queue.ts')).toBe('src/cli/loop/queue.ts');
    expect(normalizePrimaryFile('/src//cli/loop/queue.ts')).toBe('src/cli/loop/queue.ts');
    expect(normalizePrimaryFile('  src/cli/  ')).toBe('src/cli');
  });

  it('folds case, so one file reported two ways dedups', () => {
    expect(normalizePrimaryFile('src/CLI/Loop/Queue.ts')).toBe('src/cli/loop/queue.ts');
  });

  it('does NOT collapse digits — v1 and v2 are different files', () => {
    expect(normalizePrimaryFile('flow/plans/plan_x_v1.md')).not.toBe(
      normalizePrimaryFile('flow/plans/plan_x_v2.md'),
    );
  });
});

describe('loopFingerprint', () => {
  const finding = { loop: 'find', title: 'Unhandled rejection in queue.ts', primaryFile: 'src/queue.ts' };

  it('produces a 40-character lowercase hex digest', () => {
    const fingerprint = loopFingerprint(finding);
    expect(fingerprint).toHaveLength(FINGERPRINT_LENGTH);
    expect(isFingerprint(fingerprint)).toBe(true);
  });

  it('is deterministic — same inputs, same hash', () => {
    expect(loopFingerprint(finding)).toBe(loopFingerprint({ ...finding }));
  });

  it('collides for two cosmetically-different reports of ONE finding', () => {
    // The load-bearing property (Task 2.1). Same problem, two beats, two agents.
    const monday = loopFingerprint({
      loop: 'find',
      title: 'Unhandled promise rejection in queue.ts (line 42)',
      primaryFile: 'src/cli/loop/queue.ts',
    });
    const friday = loopFingerprint({
      loop: 'find',
      title: 'unhandled promise rejection in queue.ts, line 118!',
      primaryFile: './src/cli/loop/Queue.ts',
    });
    expect(friday).toBe(monday);
  });

  it('separates two genuinely different findings about one file', () => {
    const a = loopFingerprint({ loop: 'find', title: 'unhandled rejection', primaryFile: 'src/q.ts' });
    const b = loopFingerprint({ loop: 'find', title: 'missing null check', primaryFile: 'src/q.ts' });
    expect(a).not.toBe(b);
  });

  it('separates the same finding reported about two different files', () => {
    const a = loopFingerprint({ loop: 'find', title: 'unhandled rejection', primaryFile: 'src/a.ts' });
    const b = loopFingerprint({ loop: 'find', title: 'unhandled rejection', primaryFile: 'src/b.ts' });
    expect(a).not.toBe(b);
  });

  it('separates the same finding reported by two loops', () => {
    const find = loopFingerprint({ loop: 'find', title: 'unhandled rejection', primaryFile: 'src/a.ts' });
    const improve = loopFingerprint({ loop: 'improve', title: 'unhandled rejection', primaryFile: 'src/a.ts' });
    expect(find).not.toBe(improve);
  });

  it('does not let a field boundary be impersonated by field content', () => {
    // Without an unambiguous separator these two would concatenate identically.
    const a = loopFingerprint({ loop: 'find', title: 'a b', primaryFile: 'c' });
    const b = loopFingerprint({ loop: 'find a', title: 'b', primaryFile: 'c' });
    expect(a).not.toBe(b);
  });

  it('treats an absent primary file as an empty field, not an invented path', () => {
    const absent = loopFingerprint({ loop: 'find', title: 'dependency is unpinned' });
    const empty = loopFingerprint({ loop: 'find', title: 'dependency is unpinned', primaryFile: '' });
    expect(absent).toBe(empty);
    expect(isFingerprint(absent)).toBe(true);
  });

  it('hashes THREE fields and no fourth — a topic can never reach the key', () => {
    // Re-pointing a loop (`topic:` in the directive) must not re-file its whole
    // backlog, so the topic is deliberately NOT a fingerprint field. Proven at
    // the surface: an input carrying one hashes exactly as the same finding
    // without it, and the normalized record still has three keys.
    const before = loopFingerprint({ loop: 'find', title: 'unhandled rejection', primaryFile: 'src/a.ts' });
    const after = loopFingerprint({
      loop: 'find',
      title: 'unhandled rejection',
      primaryFile: 'src/a.ts',
      topic: 'panel',
    } as never);
    expect(after).toBe(before);
    expect(Object.keys(normalizeFingerprintInput(finding)).sort()).toEqual([
      'loop',
      'primaryFile',
      'title',
    ]);
  });

  it('exposes the normalized fields it hashed, so a collision is explainable', () => {
    expect(
      normalizeFingerprintInput({ loop: 'Find', title: 'Leak at line 42', primaryFile: './src/A.ts' }),
    ).toEqual({ loop: 'find', title: 'leak at line #', primaryFile: 'src/a.ts' });
  });
});

describe('the body marker', () => {
  const fingerprint = loopFingerprint({ loop: 'find', title: 'a leak', primaryFile: 'src/a.ts' });

  it('writes the documented marker form', () => {
    expect(fingerprintMarker(fingerprint)).toBe(`<!-- loop-fp: ${fingerprint} -->`);
  });

  it('round-trips through a body', () => {
    const body = `Some prose.\n\n${fingerprintMarker(fingerprint)}\n`;
    expect(extractFingerprint(body)).toBe(fingerprint);
    expect(bodyHasFingerprint(body, fingerprint)).toBe(true);
  });

  it('tolerates extra whitespace inside the marker', () => {
    expect(extractFingerprint(`<!--   loop-fp:   ${fingerprint}   -->`)).toBe(fingerprint);
  });

  it('reads no fingerprint from a body that carries none', () => {
    expect(extractFingerprint('just prose')).toBeNull();
    expect(bodyHasFingerprint('just prose', fingerprint)).toBe(false);
  });

  it('does not match a hash-shaped string that is not in a marker', () => {
    expect(extractFingerprint(`the hash is ${fingerprint}`)).toBeNull();
  });

  it('rejects a marker carrying a malformed hash', () => {
    expect(extractFingerprint('<!-- loop-fp: not-a-hash -->')).toBeNull();
    expect(FINGERPRINT_MARKER_PATTERN.test('<!-- loop-fp: ABCDEF -->')).toBe(false);
  });

  it('says no when the body carries a DIFFERENT fingerprint', () => {
    const other = loopFingerprint({ loop: 'find', title: 'another leak', primaryFile: 'src/b.ts' });
    expect(bodyHasFingerprint(fingerprintMarker(other), fingerprint)).toBe(false);
  });

  it('strips every marker when re-composing a body', () => {
    const body = `prose\n\n${fingerprintMarker(fingerprint)}\n${fingerprintMarker(fingerprint)}`;
    expect(stripFingerprintMarker(body)).toBe('prose');
  });
});
