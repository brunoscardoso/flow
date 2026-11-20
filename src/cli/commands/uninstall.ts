/**
 * `planflow-ai uninstall --target <dir> --confirm` — remove the files plan-flow
 * added to a project. The Flow app's "Reset Flow" runs it once per managed
 * project; a person can run it in a terminal too.
 *
 * Without `--confirm` it removes nothing and says so. All decisions live in
 * `uninstallProject` (handlers/uninstall.ts).
 */
import * as log from '../utils/logger.js';
import { getPackageRoot } from '../utils/files.js';
import { UninstallRefusal, uninstallProject } from '../handlers/uninstall.js';

export interface UninstallOptions {
  target: string;
  confirm?: boolean;
  json?: boolean;
}

export function runUninstall(options: UninstallOptions): void {
  if (options.confirm !== true) {
    if (options.json === true) console.log(JSON.stringify({ refused: 'not-confirmed' }));
    log.error('uninstall refused: not-confirmed — pass --confirm to remove the files plan-flow added');
    process.exitCode = 1;
    return;
  }
  try {
    const result = uninstallProject({ target: options.target, packageRoot: getPackageRoot(), confirmed: true });
    if (options.json === true) {
      console.log(JSON.stringify({ action: 'uninstall', ...result }));
      return;
    }
    log.info(
      `Removed ${String(result.removed.length)} file(s), edited ${String(result.edited.length)}, kept ${String(result.kept.length)} a person changed.`,
    );
  } catch (error) {
    if (error instanceof UninstallRefusal) {
      if (options.json === true) console.log(JSON.stringify({ refused: error.reason }));
      log.error(`uninstall refused: ${error.reason} — ${error.message}`);
    } else {
      log.error(`uninstall refused: failed — ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = 1;
  }
}
