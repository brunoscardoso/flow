/**
 * The single gate signal for always-on graphify (#142).
 *
 * Replaces the old `engines.graphify === 'enabled'` consent gate: graphify now
 * enriches the blueprint on EVERY project whenever the binary is available, with
 * a native-only fallback (and one-line notice) when it isn't. No opt-in, no
 * decline. The exec is injectable so tests mock the child process rather than
 * PATH (allowed-pattern #12 — PATH stubs are non-deterministic under jest).
 */
import { execSync } from 'node:child_process';

/** Timeout for the cheap `which graphify` detection. */
const DETECTION_TIMEOUT_MS = 5_000;

/** Minimal exec surface: throws iff the command exits non-zero. */
export type DetectExec = (command: string) => void;

const defaultExec: DetectExec = (command) => {
  execSync(command, { encoding: 'utf-8', timeout: DETECTION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
};

/** Whether the graphify CLI resolves on PATH. Injectable exec for tests. */
export function graphifyAvailable(exec: DetectExec = defaultExec): boolean {
  try {
    exec('which graphify');
    return true;
  } catch {
    // `which` exiting non-zero → not installed: the sanctioned native-only path.
    return false;
  }
}
