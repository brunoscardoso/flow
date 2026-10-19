import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The two copies of `thread/` have to agree, and nothing else can make them.
 *
 * `THREAD_BRANCH_PREFIX` is defined twice — here in the CLI and in
 * `app/src/shared/thread-branch.ts`. One definition is not reachable: the root
 * package compiles with `rootDir: ./src`, so importing the app's copy fails
 * with TS6059 (checked against tsc, not assumed), and the two are separate
 * packages with different module systems. Copying a file across, or reaching
 * over with a relative path, would be a fake unification — worse than the
 * duplication, because it would look solved.
 *
 * So this reads BOTH FILES AS TEXT. It imports neither, which is why it works
 * under any build config and cannot itself drag one package into the other.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');

function prefixIn(relativePath: string): string {
  const source = readFileSync(resolve(repo, relativePath), 'utf8');
  const match = /export const THREAD_BRANCH_PREFIX = '([^']*)'/.exec(source);
  if (match === null) {
    throw new Error(`no THREAD_BRANCH_PREFIX found in ${relativePath}`);
  }
  return match[1] as string;
}

describe('THREAD_BRANCH_PREFIX', () => {
  it('is the same string in both packages', () => {
    const cli = prefixIn('src/cli/loop/worktree.ts');
    const app = prefixIn('app/src/shared/thread-branch.ts');
    // `worktree/`, not `thread/`: the namespace says what the branch IS, and a
    // reader looking at `worktree/fix-the-parser` in git knows what made it
    // (user, 2026-09-17: "instead of thread/name can be worktree/name-branch
    // because the user will understand that better"). Branches cut under the
    // old prefix are still recognised — see LEGACY_THREAD_BRANCH_PREFIX.
    expect(cli).toBe('worktree/');
    expect(app).toBe(cli);
  });

  it('says in both places that the other one exists', () => {
    // A reader who finds only one copy will assume it is the only copy, and the
    // next person to change it will move half the system.
    for (const [path, other] of [
      ['src/cli/loop/worktree.ts', 'app/src/shared/thread-branch.ts'],
      ['app/src/shared/thread-branch.ts', 'src/cli/loop/worktree.ts'],
    ]) {
      expect(readFileSync(resolve(repo, path as string), 'utf8')).toContain(other as string);
    }
  });
});
