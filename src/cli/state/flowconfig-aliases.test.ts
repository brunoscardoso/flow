/**
 * Renamed `.flowconfig` keys — parity with the shared alias table, and the
 * read rule: the new key, else the old one; the old one wins when both exist (dual-write);
 * and the write rule: `flow set` writes BOTH spellings with the same value and
 * `flow unset` removes both (transitional, while older builds share projects).
 *
 * The table is LOADED from `app/src/shared/worktree-config-aliases.json`, the
 * file the app reads too, so a rename added on one side only fails here. The
 * three file shapes below (old key only, new key only, both) are the fixture
 * the app's resolver is held to as well.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlowconfigKeys } from './flowconfig-merge.js';

const { FLOWCONFIG_KEY_ALIASES, canonicalFlowconfigKey, legacyKeyOf, readAliasedKey } = await import(
  './flowconfig-aliases.js'
);
const { parseFlowConfig } = await import('./flowconfig-parser.js');
const { getPackageRoot } = await import('../utils/files.js');
const { runFlow } = await import('../commands/flow.js');

interface AliasTable {
  comment: string;
  aliases: Record<string, string>;
}

const SHARED = JSON.parse(
  readFileSync(join(getPackageRoot(), 'app', 'src', 'shared', 'worktree-config-aliases.json'), 'utf-8'),
) as AliasTable;

/** One value per renamed key, distinct for its old and its new spelling. */
const VALUES: Record<string, { legacy: string; current: string }> = {
  worktree_start: { legacy: 'trunk', current: 'branch:release/2.0' },
  worktree_cap: { legacy: '4', current: '12' },
  worktree_setup: { legacy: 'uv sync', current: 'npm ci' },
  worktree_setup_timeout_ms: { legacy: '60000', current: '90000' },
};

/** Read a key from a file's text the way the parser does, through the alias rule. */
function readAliased(text: string, key: string): string | undefined {
  const raw = parseFlowconfigKeys(text);
  return readAliasedKey(key, (name) => {
    const value = raw[name];
    return value === undefined || value === '' ? undefined : value;
  });
}

describe('the alias table — parity with the shared JSON', () => {
  it('is the table the app reads, says who reads it, and is not empty', () => {
    expect(SHARED.comment).toMatch(/CLI/);
    expect(SHARED.comment).toMatch(/app/);
    expect(SHARED.comment).toMatch(/FOREVER/i);
    expect(Object.keys(SHARED.aliases).length).toBeGreaterThan(0);
  });

  it('says writes go to both spellings, transitionally', () => {
    expect(SHARED.comment).toMatch(/BOTH keys with the same value/);
    expect(SHARED.comment).toMatch(/unset removes both/);
  });

  it('holds exactly the same renames as the CLI copy', () => {
    expect({ ...FLOWCONFIG_KEY_ALIASES }).toEqual(SHARED.aliases);
  });

  it('names the four worktree settings, each new key mapped to its old one', () => {
    expect(SHARED.aliases).toEqual({
      worktree_start: 'workspace_start',
      worktree_cap: 'workspace_cap',
      worktree_setup: 'workspace_setup',
      worktree_setup_timeout_ms: 'workspace_setup_timeout_ms',
    });
  });

  it('resolves both directions from the one table', () => {
    for (const [current, legacy] of Object.entries(SHARED.aliases)) {
      expect(legacyKeyOf(current)).toBe(legacy);
      expect(canonicalFlowconfigKey(legacy)).toBe(current);
      expect(canonicalFlowconfigKey(current)).toBe(current);
    }
    expect(legacyKeyOf('commit')).toBeUndefined();
    expect(canonicalFlowconfigKey('commit')).toBe('commit');
    expect(canonicalFlowconfigKey('__proto__')).toBe('__proto__');
  });
});

describe('reading a renamed key — the three file shapes', () => {
  for (const [current, legacy] of Object.entries(SHARED.aliases)) {
    const values = VALUES[current];

    describe(current, () => {
      it('has a fixture value for this key', () => {
        expect(values).toBeDefined();
      });

      it('an old-key-only file reads the old value', () => {
        expect(readAliased(`${legacy}: ${values.legacy}\n`, current)).toBe(values.legacy);
      });

      it('a new-key-only file reads the new value', () => {
        expect(readAliased(`${current}: ${values.current}\n`, current)).toBe(values.current);
      });

      it('a file holding both reads the OLD value (a pre-rename build writes only that one), whichever line comes first', () => {
        const oldFirst = `${legacy}: ${values.legacy}\n${current}: ${values.current}\n`;
        const newFirst = `${current}: ${values.current}\n${legacy}: ${values.legacy}\n`;
        expect(readAliased(oldFirst, current)).toBe(values.legacy);
        expect(readAliased(newFirst, current)).toBe(values.legacy);
      });

      it('a blank new key falls through to the old one, as an absent key would', () => {
        expect(readAliased(`${current}:\n${legacy}: ${values.legacy}\n`, current)).toBe(values.legacy);
      });

      it('a file with neither reads nothing', () => {
        expect(readAliased('commit: true\n', current)).toBeUndefined();
      });
    });
  }
});

interface ParityFixture {
  cases: Array<{ name: string; text: string; expected: Record<string, string> }>;
}

const PARITY = JSON.parse(
  readFileSync(
    join(getPackageRoot(), 'app', 'src', 'shared', 'worktree-config-aliases.fixture.json'),
    'utf-8',
  ),
) as ParityFixture;

describe('the shared parity fixture — the app asserts the same values', () => {
  it('covers old-only, new-only and both-present files for every renamed key', () => {
    expect(PARITY.cases.map((c) => c.name)).toEqual([
      'old keys only',
      'new keys only',
      'both present, old lines first',
      'both present, new lines first',
    ]);
    for (const c of PARITY.cases) {
      expect(Object.keys(c.expected).sort()).toEqual(Object.keys(SHARED.aliases).sort());
    }
  });

  for (const c of PARITY.cases) {
    it(`${c.name}: every renamed key reads its expected value`, () => {
      for (const [key, value] of Object.entries(c.expected)) {
        expect(readAliased(c.text, key)).toBe(value);
      }
      const flowDir = mkdtempSync(join(tmpdir(), 'plan-flow-parity-'));
      try {
        writeFileSync(join(flowDir, '.flowconfig'), c.text);
        expect(parseFlowConfig(flowDir).worktree_start).toBe(c.expected.worktree_start);
      } finally {
        rmSync(flowDir, { recursive: true, force: true });
      }
    });
  }
});

describe('parseFlowConfig reads worktree_start through the alias', () => {
  let flowDir: string;

  beforeEach(() => {
    flowDir = mkdtempSync(join(tmpdir(), 'plan-flow-aliases-'));
  });

  afterEach(() => {
    rmSync(flowDir, { recursive: true, force: true });
  });

  function parseText(text: string): ReturnType<typeof parseFlowConfig> {
    writeFileSync(join(flowDir, '.flowconfig'), text);
    return parseFlowConfig(flowDir);
  }

  it('old key only', () => {
    expect(parseText('workspace_start: trunk\n').worktree_start).toBe('trunk');
  });

  it('new key only', () => {
    expect(parseText('worktree_start: here\n').worktree_start).toBe('here');
  });

  it('both present — the old key wins while both are written (a pre-rename build writes only it)', () => {
    expect(parseText('workspace_start: trunk\nworktree_start: here\n').worktree_start).toBe('trunk');
    expect(parseText('worktree_start: here\nworkspace_start: trunk\n').worktree_start).toBe('trunk');
  });

  it('a blank old key does not swallow the next line (forbidden-pattern #16)', () => {
    expect(parseText('workspace_start:\nbranch: develop\n').worktree_start).toBeUndefined();
  });

  it('never exposes the old field name', () => {
    const config = parseText('workspace_start: trunk\n') as unknown as Record<string, unknown>;
    expect(config).not.toHaveProperty('workspace_start');
  });
});

describe('flow set / unset dual-write every renamed key', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'plan-flow-aliases-write-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  /** Run a verb in-process with stdout silenced; returns the exit code. */
  function flow(verb: string, args: string[]): number {
    const stdout = process.stdout as unknown as { write: (chunk: unknown) => boolean };
    const realWrite = stdout.write;
    const realLog = console.log;
    stdout.write = (): boolean => true;
    console.log = (): void => undefined;
    const previousExit = process.exitCode;
    process.exitCode = 0;
    try {
      runFlow(verb, args, { target: project, json: true });
    } finally {
      stdout.write = realWrite;
      console.log = realLog;
    }
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = previousExit;
    return exitCode;
  }

  const fileKeys = (): Record<string, string> =>
    parseFlowconfigKeys(readFileSync(join(project, 'flow', '.flowconfig'), 'utf-8'));

  for (const [current, legacy] of Object.entries(SHARED.aliases)) {
    it(`${current}: set writes ${current} AND ${legacy} with the same value; unset removes both`, () => {
      const value = VALUES[current].current;
      expect(flow('set', [`${current}=${value}`])).toBe(0);
      expect(fileKeys()).toEqual({ [current]: value, [legacy]: value });

      // Naming the OLD key writes both spellings just the same.
      const other = VALUES[current].legacy;
      expect(flow('set', [`${legacy}=${other}`])).toBe(0);
      expect(fileKeys()).toEqual({ [current]: other, [legacy]: other });

      expect(flow('unset', [current])).toBe(0);
      expect(fileKeys()).toEqual({});
    });
  }
});
