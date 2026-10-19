/**
 * Tests for the run-script store — real fs via mkdtemp, like the sibling
 * store tests.
 *
 * Covers: rotation of the previous artifact on rewrite (byte-preserving),
 * fail-soft reads (missing / corrupt / wrong version), overrides
 * round-tripping, clearing, and archiving (including the absent no-op).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileRunScript, serializeRunScript } from './run-compiler.js';
import {
  archiveRunScript,
  clearRunScript,
  readRunScript,
  runScriptPath,
  runScriptPrevPath,
  writeRunScript,
} from './run-script-store.js';
import type { RunOverrides, RunScript } from './types.js';

const PLAN_NAME = 'store-test';

const PLAN_V1 = `# Plan: Store Test

### Phase 1: One
**Complexity**: 3/10
**Dependencies**: none

- [ ] Task one
`;

const PLAN_V2 = `${PLAN_V1}
### Phase 2: Two
**Complexity**: 5/10
**Dependencies**: Phase 1

- [ ] Task two
`;

function compileFixture(content: string, overrides: RunOverrides = {}): RunScript {
  return compileRunScript(content, PLAN_NAME, overrides);
}

describe('run-script store', () => {
  let tempDir: string;
  let flowDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-flow-run-script-store-test-'));
    flowDir = join(tempDir, 'flow');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('writeRunScript', () => {
    it('writes the serialized artifact under flow/plans/', () => {
      const script = compileFixture(PLAN_V1);
      writeRunScript(flowDir, PLAN_NAME, script);

      const filePath = runScriptPath(flowDir, PLAN_NAME);
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, 'utf-8')).toBe(serializeRunScript(script));
      // No previous artifact on first write
      expect(existsSync(runScriptPrevPath(flowDir, PLAN_NAME))).toBe(false);
    });

    it('rotates the previous artifact to .run.prev.json with the first version\'s bytes', () => {
      const first = compileFixture(PLAN_V1);
      writeRunScript(flowDir, PLAN_NAME, first);
      const firstBytes = readFileSync(runScriptPath(flowDir, PLAN_NAME), 'utf-8');

      const second = compileFixture(PLAN_V2);
      writeRunScript(flowDir, PLAN_NAME, second);

      expect(readFileSync(runScriptPrevPath(flowDir, PLAN_NAME), 'utf-8')).toBe(firstBytes);
      expect(readFileSync(runScriptPath(flowDir, PLAN_NAME), 'utf-8')).toBe(
        serializeRunScript(second),
      );
    });
  });

  describe('readRunScript', () => {
    it('returns null when no artifact exists', () => {
      expect(readRunScript(flowDir, PLAN_NAME)).toBeNull();
    });

    it('returns null on corrupt JSON', () => {
      mkdirSync(join(flowDir, 'plans'), { recursive: true });
      writeFileSync(runScriptPath(flowDir, PLAN_NAME), 'not json {{{', 'utf-8');

      expect(readRunScript(flowDir, PLAN_NAME)).toBeNull();
    });

    it('returns null on a version mismatch', () => {
      const script = compileFixture(PLAN_V1);
      mkdirSync(join(flowDir, 'plans'), { recursive: true });
      writeFileSync(
        runScriptPath(flowDir, PLAN_NAME),
        JSON.stringify({ ...script, version: 2 }),
        'utf-8',
      );

      expect(readRunScript(flowDir, PLAN_NAME)).toBeNull();
    });

    it('round-trips the overrides block', () => {
      const overrides: RunOverrides = {
        phases: { '1': { model: 'opus' }, '9': { skip: true } },
        tasks: { '1.1': { verify: 'echo custom' } },
      };
      writeRunScript(flowDir, PLAN_NAME, compileFixture(PLAN_V1, overrides));

      const readBack = readRunScript(flowDir, PLAN_NAME);
      expect(readBack).not.toBeNull();
      expect(readBack!.overrides).toEqual(overrides);
      expect(readBack!.plan).toBe(PLAN_NAME);
    });
  });

  describe('clearRunScript', () => {
    it('removes both the artifact and its rotated previous version', () => {
      writeRunScript(flowDir, PLAN_NAME, compileFixture(PLAN_V1));
      writeRunScript(flowDir, PLAN_NAME, compileFixture(PLAN_V2));
      expect(existsSync(runScriptPath(flowDir, PLAN_NAME))).toBe(true);
      expect(existsSync(runScriptPrevPath(flowDir, PLAN_NAME))).toBe(true);

      clearRunScript(flowDir, PLAN_NAME);

      expect(existsSync(runScriptPath(flowDir, PLAN_NAME))).toBe(false);
      expect(existsSync(runScriptPrevPath(flowDir, PLAN_NAME))).toBe(false);
    });

    it('is a silent no-op when nothing exists', () => {
      expect(() => clearRunScript(flowDir, PLAN_NAME)).not.toThrow();
    });
  });

  describe('archiveRunScript', () => {
    it('moves the artifact and its previous version into flow/archive/ with unchanged names', () => {
      writeRunScript(flowDir, PLAN_NAME, compileFixture(PLAN_V1));
      const firstBytes = readFileSync(runScriptPath(flowDir, PLAN_NAME), 'utf-8');
      writeRunScript(flowDir, PLAN_NAME, compileFixture(PLAN_V2));
      const secondBytes = readFileSync(runScriptPath(flowDir, PLAN_NAME), 'utf-8');

      archiveRunScript(flowDir, PLAN_NAME);

      expect(existsSync(runScriptPath(flowDir, PLAN_NAME))).toBe(false);
      expect(existsSync(runScriptPrevPath(flowDir, PLAN_NAME))).toBe(false);
      expect(readFileSync(join(flowDir, 'archive', `${PLAN_NAME}.run.json`), 'utf-8')).toBe(
        secondBytes,
      );
      expect(readFileSync(join(flowDir, 'archive', `${PLAN_NAME}.run.prev.json`), 'utf-8')).toBe(
        firstBytes,
      );
    });

    it('is a no-op when no artifact exists — does not even create the archive directory', () => {
      expect(() => archiveRunScript(flowDir, PLAN_NAME)).not.toThrow();
      expect(existsSync(join(flowDir, 'archive'))).toBe(false);
    });
  });
});
