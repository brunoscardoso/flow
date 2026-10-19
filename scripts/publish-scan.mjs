// THE PUBLISH GATE — run before publishing the tracked tree anywhere public.
//
//   npm run publish:scan
//
// Two legs, because the thing being guarded cannot all live in one place:
//
//  1. THE IDENTITY LEG is tracked and always runs. It derives what to look for
//     from this machine's git identity, so it carries no literals and works in
//     any clone. `scripts/publish-identity.test.mjs` also runs it on every
//     `npm test`, which is what catches the recurring case: work landing after
//     a one-time scrub.
//
//  2. THE FAMILY LEG is `flow/publish-scan.py`, which is UNTRACKED on purpose
//     — its seed list names every string the scrub removes, so tracking it
//     would publish exactly what the scrub exists to remove. It therefore
//     exists only on a machine that has done the scrub.
//
// When the family leg is missing this command REFUSES. It does not pass with a
// warning: a publish gate whose main leg quietly skipped is indistinguishable
// from a clean tree, and the difference is the whole point.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ALLOWED, gitIdentity, identityNeedles, scanTracked } from './publish-identity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAMILY = 'flow/publish-scan.py';
const refusals = [];

// ---- leg 1: identity -------------------------------------------------------
const identity = gitIdentity(ROOT);
const needles = identityNeedles(identity);
if (needles.length === 0) {
  refusals.push(
    'git has no user.name or user.email here, so the identity leg had nothing ' +
      'to search for — that is not a clean result',
  );
} else {
  const { hits, excused, skipped, scanned } = scanTracked({ root: ROOT, needles });
  console.log(
    `identity: ${scanned} tracked text files, ${needles.length} fragments, ` +
      `${skipped.binary} binary skipped`,
  );
  // Every allowance prints, used or not: a declared excuse that covers no line
  // any more is dead weight a reader should see and delete, and an allowance
  // nobody can see is how a gate stops gating.
  for (const [path, allowance] of Object.entries(ALLOWED)) {
    const used = excused.filter((entry) => entry.file === path).length;
    console.log(`identity: allowance ${path} [${allowance.shape}] — ${allowance.why} (${used} lines excused)`);
  }
  for (const entry of excused) {
    console.log(`identity: excused ${entry.file}:${entry.line} ${entry.text}`);
  }
  for (const [path, reason] of skipped.unreadable) {
    console.log(`identity: UNREADABLE ${path} — ${reason}`);
    refusals.push(`${path} could not be read, so it was not cleared`);
  }
  for (const hit of hits) {
    console.log(`identity: HIT ${hit.file}:${hit.line} [${hit.needle}] ${hit.text}`);
  }
  if (hits.length > 0) refusals.push(`${hits.length} identity hits in tracked files`);
}

// ---- leg 2: the scrub family ----------------------------------------------
if (!existsSync(new URL(`../${FAMILY}`, import.meta.url))) {
  refusals.push(
    `${FAMILY} is not on this machine. It is untracked by design (its seed list ` +
      'names every string being removed), so only a machine that ran the scrub ' +
      'has it — and without it nothing checked for the employer, the products, ' +
      'the internal hosts or the ticket keys',
  );
} else {
  console.log(`\nfamily: running ${FAMILY}\n`);
  const python = spawnSync('python3', [FAMILY], { cwd: ROOT, stdio: 'inherit' });
  if (python.error) refusals.push(`${FAMILY} could not run: ${python.error.message}`);
  else if (python.status !== 0) refusals.push(`${FAMILY} refused (exit ${python.status})`);
}

// ---- leg 3: what a publish would actually copy -----------------------------
// The publish is a squash of TRACKED content. Both legs scan exactly that set,
// so state the count the gate cleared — a reader can then check it against the
// archive they ship.
try {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n')
    .filter(Boolean).length;
  console.log(`\ncleared ${tracked} tracked files. Publish with \`git archive\` or a ` +
    'fresh clone; copying the folder would carry untracked files these legs never read.');
} catch (error) {
  refusals.push(`could not list tracked files: ${error.message}`);
}

if (refusals.length > 0) {
  console.log('');
  for (const reason of refusals) console.log(`publish scan refused: ${reason}`);
  process.exit(1);
}
console.log('\npublish scan clean.');
