/**
 * Electron-as-node argv regression (2026-07-23 incident).
 *
 * The Flow app spawns the bundled CLI under its OWN Electron binary with
 * ELECTRON_RUN_AS_NODE=1. There, `process.versions.electron` is still set, so
 * commander auto-switched to 'electron' argv semantics and (packaged app → no
 * `process.defaultApp`) treated the SCRIPT PATH as the first user argument:
 * every verb stopped matching, the interactive default (init) ran instead,
 * hung on ignored stdin, and timed out — silently killing every app-spawned
 * `blueprint observe`/derive. The learn pipeline then looped forever
 * (learned → note missing → reconcileNoteless → stale → re-learn).
 *
 * Fix: `program.parse(process.argv, { from: 'node' })`. This suite proves the
 * verb dispatch under a REAL Electron binary run as node. Skips gracefully
 * when the built CLI or the electron binary is absent (fresh clone).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const CLI_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');
const ELECTRON_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'electron');

const available = existsSync(CLI_ENTRY) && existsSync(ELECTRON_BIN);
const maybeDescribe = available ? describe : describe.skip;

maybeDescribe('CLI verb dispatch under Electron-as-node', () => {
  it('blueprint observe writes the note (never falls into interactive init)', () => {
    const root = mkdtempSync(join(tmpdir(), 'pf-electron-argv-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: root });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1\n');
    const structureDir = join(root, 'flow', 'brain', '.structure');
    mkdirSync(structureDir, { recursive: true });
    writeFileSync(
      join(structureDir, 'graph.json'),
      JSON.stringify({
        version: 1,
        derivedAt: '2026-07-23T00:00:00.000Z',
        coverage: { filesScanned: 1, filesTotal: 1, extractorsRun: ['basic'], graphifyEnriched: false },
        nodes: [{ id: 'module:src', kind: 'module', label: 'src', sourceFile: 'src', meta: { depth: 1 } }],
        edges: [],
      }),
    );

    // stdio pipes with NO stdin — exactly the app's spawn shape. A regression
    // re-enters interactive init here and hits the 30s timeout instead.
    const output = execFileSync(
      ELECTRON_BIN,
      [CLI_ENTRY, 'blueprint', 'observe', '--note', 'electron argv probe', '--anchor', 'module:src'],
      {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).toString();

    expect(output).toContain('observed: note');
    const store = readFileSync(join(structureDir, 'investigations.jsonl'), 'utf8');
    expect(store).toContain('electron argv probe');
  }, 45_000);
});
