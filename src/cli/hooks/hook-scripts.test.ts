/**
 * The hook-script manifest is ONE list — this is what keeps it that way.
 *
 * `installHooks` (handlers/claude.ts) and the `.claude/hooks` group of
 * `OWNED_ASSET_PATHS` (commands/init-refresh.ts) each carried their own
 * hard-coded copy of the same five filenames. Byte-identical, which is what
 * made it dangerous: a hook added to the install path would have been silently
 * missing from every refresh, with neither list looking wrong.
 *
 * Two directions of drift are guarded here, because de-forking only removes
 * one of them:
 *
 *   1. THE CONSUMERS. The refresh manifest must hold the shared constant
 *      ITSELF, not an equal-looking array — an `toEqual` would pass against a
 *      re-pasted copy, which is precisely the state being fixed.
 *   2. THE SHIPPED FILES. `scripts/hooks/` and the manifest must describe each
 *      other exactly. A `.cjs` shipped but unlisted reaches no project; a name
 *      listed but not shipped is a copy that silently does nothing (both paths
 *      skip a missing source without a word).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_SCRIPTS } from './hook-scripts.js';
import { OWNED_ASSET_PATHS } from '../commands/init-refresh.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('HOOK_SCRIPTS is the single hook manifest', () => {
  it('is the exact list the refresh manifest copies — the same object, not a twin', () => {
    const hooks = OWNED_ASSET_PATHS.find((group) => group.dest === '.claude/hooks');
    expect(hooks).toBeDefined();
    // Identity, deliberately. Equality would be satisfied by a second copy.
    expect(hooks?.files).toBe(HOOK_SCRIPTS);
  });

  it('describes scripts/hooks/ exactly, in both directions', () => {
    const shipped = readdirSync(join(repoRoot, 'scripts', 'hooks'))
      .filter((name) => name.endsWith('.cjs'))
      .sort();
    expect([...HOOK_SCRIPTS].sort()).toEqual(shipped);
  });

  it('is frozen — a consumer cannot mutate the list the other one reads', () => {
    expect(Object.isFrozen(HOOK_SCRIPTS)).toBe(true);
  });

  /**
   * THIS REPO IS ALSO A CONSUMER, and its installed copy went stale.
   *
   * `.claude/hooks/` here is what actually runs in this project's sessions,
   * provisioned from `scripts/hooks/`. When #1947 added the 5.5/5.1 pricing
   * rows it edited the source only, so for every session afterwards this
   * repo's own cost tracker priced an opus-5-5 call at opus-5 rates and a
   * haiku-5-5 call at haiku-4-5 rates — silently, because the stale copy is
   * valid JavaScript that runs perfectly well.
   *
   * The manifest guard above cannot see this: it compares NAMES. Two files
   * can both be listed, both be present, and disagree about what they do.
   */
  it('matches the copy installed in this repo, byte for byte', () => {
    const drifted = HOOK_SCRIPTS.filter((name) => {
      const source = join(repoRoot, 'scripts', 'hooks', name);
      const installed = join(repoRoot, '.claude', 'hooks', name);
      if (!existsSync(installed)) return true;
      return readFileSync(source, 'utf-8') !== readFileSync(installed, 'utf-8');
    });
    // Named, not counted: the fix is `cp scripts/hooks/<name> .claude/hooks/`.
    expect(drifted).toEqual([]);
  });
});
