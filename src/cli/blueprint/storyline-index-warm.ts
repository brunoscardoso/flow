/**
 * Starting the import index's background build — the other half of a graph
 * read that answered `partial` (`feature-graph-read.ts`).
 *
 * A read that found the index cold must not build it (that is the 15–25 s the
 * app's 30 s timeout tripped on), so it asks for `blueprint index warm` in a
 * DETACHED process and returns. The build takes the project's lock
 * (`imports.lock`), so however many reads ask, one build runs; a request while
 * one is live is a no-op.
 *
 * Never in a test process: `PLANFLOW_NO_BACKGROUND_WORK` (set once in the jest
 * setup) turns it off, as it does init's other detached work — a detached
 * process outlives the temp directory its test deletes.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { backgroundWorkDisabled } from '../utils/background-work.js';
import { importIndexWarmRunning, storylineCacheDir } from './storyline-imports.js';

/** What a request did. */
export type ImportIndexWarmRequest = 'spawned' | 'running' | 'disabled' | 'unavailable';

export interface ImportIndexWarmDeps {
  /** The CLI entry to run — this process's own by default. */
  cliEntry?: string | undefined;
  /** The runtime to run it with — this process's own by default (Electron-as-Node in the app). */
  execPath?: string;
  /** Starts the detached build; injected by tests. */
  spawnDetached?: (execPath: string, args: string[], cwd: string) => void;
}

/** Libuv's file-read threads for the warm process — the default 4 caps concurrent cold opens. */
const WARM_THREADPOOL_SIZE = '16';

function spawnDetachedProcess(execPath: string, args: string[], cwd: string): void {
  const child = spawn(execPath, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? WARM_THREADPOOL_SIZE },
  });
  // A failed spawn is only a later cold read; never this read's error.
  child.on('error', () => undefined);
  child.unref();
}

/**
 * Ask for the project's import index to be built in the background. Fail-soft
 * everywhere: the worst case is that the next graph read is partial too.
 */
export function requestImportIndexWarm(repoRoot: string, deps: ImportIndexWarmDeps = {}): ImportIndexWarmRequest {
  if (deps.spawnDetached === undefined && backgroundWorkDisabled()) return 'disabled';
  const cacheDir = storylineCacheDir(repoRoot);
  if (cacheDir === null) return 'unavailable';
  if (importIndexWarmRunning(cacheDir)) return 'running';
  const cliEntry = 'cliEntry' in deps ? deps.cliEntry : process.argv[1];
  // Only a real script can be re-run (the CLI's entry: `runBlueprint` runs
  // only from it); a process with none (a REPL) asks for nothing.
  if (cliEntry === undefined || cliEntry === '' || !existsSync(cliEntry)) return 'unavailable';
  try {
    (deps.spawnDetached ?? spawnDetachedProcess)(
      deps.execPath ?? process.execPath,
      [cliEntry, 'blueprint', 'index', 'warm', '--target', repoRoot],
      repoRoot,
    );
    return 'spawned';
  } catch {
    // Spawning failed — the next read asks again.
    return 'unavailable';
  }
}
