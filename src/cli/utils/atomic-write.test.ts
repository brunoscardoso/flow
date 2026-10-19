/**
 * The write that could not land while the IDE was open.
 *
 * Reported live on Windows: with Flow running (it watches
 * `flow/loops/state.json`), every `loop pause|resume|point` refused with
 * `EPERM: operation not permitted, rename '…state.json.tmp.45876.1' ->
 * '…state.json'`, so a loop could not be switched on from the app that shows
 * the switch.
 *
 * TWO WAYS THIS TEST WAS WRONG BEFORE IT WAS RIGHT, both found by checking that
 * it fails without the fix:
 *
 *   1. Holding the file open across the WHOLE call. No retry can beat a handle
 *      held forever, so it asserted something no correct implementation could
 *      do — and said nothing about the bug, which is a lock that lets go.
 *   2. Spawning the holder and writing immediately. Starting node takes tens of
 *      milliseconds and the write takes under one, so the lock was never held
 *      while it ran: the test passed with the retry deleted.
 *
 * Hence the handshake below — the holder reports that it HAS the file, and only
 * then does the write begin.
 *
 * POSIX NOTE: renaming over an open path simply succeeds there, so this proves
 * the retry only on Windows. It is still worth running everywhere: it pins the
 * contract (the write lands, no temp is left) on every platform.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { atomicWriteFile } = await import('./atomic-write.js');

/** Block without a timer — these tests are synchronous, like the subject. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Hold `target` open in ANOTHER process, and do not return until it really has
 * it. Releases `holdMs` after it took the handle.
 */
function holdOpenElsewhere(target: string, ready: string, holdMs: number): void {
  const code =
    `const fs=require('fs');` +
    `const fd=fs.openSync(${JSON.stringify(target)},'r');` +
    `fs.writeFileSync(${JSON.stringify(ready)},'1');` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${String(holdMs)});` +
    `fs.closeSync(fd);`;
  spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error('the holder process never reported ready');
    sleepSync(5);
  }
}

describe('atomicWriteFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a file that did not exist, creating its directory', () => {
    const target = join(dir, 'nested', 'state.json');
    atomicWriteFile(target, '{"v":1}');
    expect(readFileSync(target, 'utf-8')).toBe('{"v":1}');
  });

  it('replaces an existing file', () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, 'old');
    atomicWriteFile(target, 'new');
    expect(readFileSync(target, 'utf-8')).toBe('new');
  });

  // THE REGRESSION. Another process is provably holding the target — the Flow
  // IDE watching state.json — and lets go a moment later. Before the retry this
  // refused outright on Windows and a loop could not be switched on at all.
  it('lands through a lock another process is holding and then releases', () => {
    const target = join(dir, 'state.json');
    writeFileSync(target, '{"paused":true}');
    holdOpenElsewhere(target, join(dir, 'ready'), 150);
    atomicWriteFile(target, '{"paused":false}');
    expect(readFileSync(target, 'utf-8')).toBe('{"paused":false}');
    expect(readdirSync(dir).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('leaves no temp sibling behind', () => {
    const target = join(dir, 'state.json');
    atomicWriteFile(target, 'a');
    atomicWriteFile(target, 'b');
    expect(readdirSync(dir).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('still throws when no amount of waiting would help, rather than failing quietly', () => {
    // A directory where the file should be: not a lock, so it must surface
    // immediately rather than burn the retry budget first.
    const target = join(dir, 'state.json');
    mkdirSync(target);
    expect(() => atomicWriteFile(target, 'x')).toThrow();
    expect(existsSync(target)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });
});
