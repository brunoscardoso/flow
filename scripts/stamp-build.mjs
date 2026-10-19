// Stamp dist/ with the source commit it was built from (#1651).
//
// The operative CLI is a build artifact, and nothing recorded WHICH source it
// was built from — so a dogfood checkout could land loop fixes on main, keep
// beating through a stale dist, and never hear about it (measured live: the
// installed binary still made pre-fix remote reads thirty minutes after the
// fix merged). The stamp is the missing fact; `loop next`/`loop status` read
// it back and warn when the running build is behind origin/main.
//
// CONTENT, NOT MTIME (forbidden-pattern #10): the stamp carries the commit and
// whether the tree had tracked modifications at build time — never timestamps
// compared against the commit clock.
//
// FAIL-SOFT: no git, no repo (an npm-installed package builds nowhere) — the
// stamp is written with commit null and the staleness check stays silent.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const commit = git(['rev-parse', 'HEAD']);
const dirty = commit === null ? false : (git(['status', '--porcelain', '--untracked-files=no']) ?? '') !== '';

const stamp = {
  commit,
  dirty,
  builtAt: new Date().toISOString(),
};

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'build-info.json'), `${JSON.stringify(stamp, null, 2)}\n`, 'utf-8');
console.log(
  commit === null
    ? 'build stamped: no git context (npm package build)'
    : `build stamped: ${commit.slice(0, 8)}${dirty ? ' (dirty tree)' : ''}`,
);
