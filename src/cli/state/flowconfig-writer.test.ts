/**
 * Tests for the one flowconfig writer (allowed-pattern #14).
 *
 * THESE MOVED HERE, they were not written from scratch. Every assertion below
 * used to reach `upsertFlowconfigKey` through the graphify install rails,
 * because those rails were its first caller. #1808 stopped the rails writing
 * anything — the key they wrote had five writers and no readers — which would
 * have taken the writer's only regression coverage with it while `share` still
 * calls it. So the coverage follows the helper rather than the caller that
 * happened to exercise it.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertFlowconfigKey } from './flowconfig-writer.js';
import { parseFlowConfig } from './flowconfig-parser.js';

describe('upsertFlowconfigKey', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = join(mkdtempSync(join(tmpdir(), 'flowconfig-writer-')), 'flow');
  });

  afterEach(() => {
    rmSync(join(flowDir, '..'), { recursive: true, force: true });
  });

  function seed(...lines: string[]): void {
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, '.flowconfig'), `${lines.join('\n')}\n`, 'utf-8');
  }

  function read(): string {
    return readFileSync(join(flowDir, '.flowconfig'), 'utf-8');
  }

  it('creates flow/ and .flowconfig when neither exists', () => {
    upsertFlowconfigKey(flowDir, 'share', 'shared');

    expect(read()).toBe('share: shared\n');
  });

  it('preserves every other line when replacing one', () => {
    seed('autopilot: true', 'commit: false', 'branch: main');
    upsertFlowconfigKey(flowDir, 'commit', 'true');

    expect(read()).toBe('autopilot: true\ncommit: true\nbranch: main\n');
  });

  it('appends a key the file does not have yet', () => {
    seed('autopilot: true');
    upsertFlowconfigKey(flowDir, 'share', 'local');

    expect(read()).toBe('autopilot: true\nshare: local\n');
  });

  it('replaces in place rather than appending a duplicate', () => {
    seed('autopilot: true', 'share: local', 'commit: false');
    upsertFlowconfigKey(flowDir, 'share', 'shared');

    const shareLines = read().split('\n').filter((line) => line.startsWith('share:'));
    expect(shareLines).toEqual(['share: shared']);
  });

  it('collapses pre-existing duplicates so the writer and the parser agree', () => {
    // THE ONE THAT IS NOT COSMETIC. The parser is last-line-wins for a repeated
    // key, so a first-line-only replace would leave a stale duplicate pinning
    // the parsed value — the file would say one thing and read as another.
    seed('branch: old', 'autopilot: true', 'branch: older');
    upsertFlowconfigKey(flowDir, 'branch', 'main');

    const branchLines = read().split('\n').filter((line) => line.startsWith('branch:'));
    expect(branchLines).toEqual(['branch: main']);
    // Read back through the parser, which is the half that would have been
    // pinned by a surviving duplicate.
    expect(parseFlowConfig(flowDir).branch).toBe('main');
  });

  it('leaves a file with no trailing newline exactly one newline long', () => {
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, '.flowconfig'), 'autopilot: true', 'utf-8');
    upsertFlowconfigKey(flowDir, 'share', 'local');

    expect(read()).toBe('autopilot: true\nshare: local\n');
  });
});
