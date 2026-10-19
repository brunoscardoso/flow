// The identity gate's own suite. Two jobs, deliberately in one file:
//
//  1. GUARD THE GUARD — the derivation and the matcher are tested against the
//     exact line that escaped onto `main`, so a gate that has quietly stopped
//     matching fails here rather than passing vacuously.
//  2. GATE — the tracked tree is scanned for real, every run of `npm test`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED,
  MIN_NEEDLE,
  findNeedles,
  gitIdentity,
  identityNeedles,
  isCreditLine,
  onlyOwnRepoUrl,
  ownRepoPrefixes,
  scanTracked,
} from './publish-identity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The literal that reached `main`, kept here as the gate's reference case.
// Its namespace is built by closing up a first and last name, which is why the
// matcher is substring-based and not boundary-anchored.
const THE_LEAK = 'Draft PR: https://github.com/marlowefenwick/plan-flow/pull/1948, targeting `main`';

test('derives needles from a configured identity', () => {
  const needles = identityNeedles({ userName: 'Marlowe Fenwick', userEmail: 'mar.fenwick@mail.com' });
  assert.ok(needles.includes('marlowe'), 'each word of the name');
  assert.ok(needles.includes('marlowefenwick'), 'the name with its spaces closed up — the URL form');
  assert.ok(needles.includes('mar.fenwick@mail.com'), 'the address itself');
  assert.ok(needles.includes('mar.fenwick'), 'the local part');
});

test('drops fragments too short or too generic to identify anyone', () => {
  const short = identityNeedles({ userName: 'Ana Lee', userEmail: '' });
  assert.ok(!short.includes('ana'), `a ${MIN_NEEDLE - 1}-letter fragment matches ordinary prose`);
  assert.ok(!short.includes('lee'), 'likewise');
  assert.ok(short.includes('analee'), 'the joined form is long enough to be worth searching for');

  const bot = identityNeedles({ userName: 'github-actions[bot]', userEmail: 'noreply@github.com' });
  assert.ok(!bot.includes('github'), 'a CI machine is not a person');
  assert.ok(
    !bot.includes('noreply@github.com'),
    'nor is its address — a full address whose fragments were all rejected must not ' +
      'slip past them, or the hostname matches every GitHub URL in the repo',
  );
});

test('matches a name inside a namespace that closes it up', () => {
  // THE MUTATION CHECK. A boundary-anchored matcher passes every other test in
  // this file and fails this one: in `marlowefenwick` the surname is preceded
  // by a letter, so `\bfenwick` finds nothing. That is exactly the shape the
  // leak had, so the surname is asserted on purpose.
  const needles = identityNeedles({ userName: 'Marlowe Fenwick', userEmail: 'mar@mail.com' });
  assert.deepEqual(findNeedles(THE_LEAK, needles).sort(), ['fenwick', 'marlowe', 'marlowefenwick']);
});

test('is case-insensitive', () => {
  assert.deepEqual(findNeedles('See HTTPS://GitHub.com/MarloweFenwick/x', ['marlowefenwick']), ['marlowefenwick']);
});

test('finds nothing when there is nothing to find', () => {
  assert.deepEqual(findNeedles('https://github.com/org/repo/pull/123', ['marlowefenwick']), []);
  assert.deepEqual(findNeedles('anything at all', []), []);
});

test("derives the project's own namespace from its manifest, never a literal", () => {
  const manifest = JSON.stringify({
    repository: { url: 'git+https://github.com/MarloweFenwick/flow.git' },
    homepage: 'https://github.com/marlowefenwick/flow#readme',
    bugs: { url: 'https://github.com/marlowefenwick/flow/issues' },
  });
  const prefixes = ownRepoPrefixes('/anywhere', () => Buffer.from(manifest, 'utf8'));
  assert.deepEqual(prefixes, ['github.com/marlowefenwick/flow'], 'one home, however it is spelled');
});

test('no readable manifest means no allowance', () => {
  // Refusing is the safe direction: nothing declares a home, so nothing is excused.
  assert.deepEqual(ownRepoPrefixes('/x', () => { throw new Error('gone'); }), []);
  assert.deepEqual(ownRepoPrefixes('/x', () => Buffer.from('not json', 'utf8')), []);
});

test("the allowance covers the project's own URL and nothing else on its line", () => {
  const needles = identityNeedles({ userName: 'Marlowe Fenwick', userEmail: 'mar.fenwick@mail.com' });
  const prefixes = ['github.com/marlowefenwick/flow'];
  const own = '  "homepage": "https://github.com/marlowefenwick/flow#readme",';
  assert.equal(onlyOwnRepoUrl(own, findNeedles(own, needles), prefixes), true, 'the repo naming itself');

  // THE MUTATION CHECK FOR THE EXCUSE. ALLOWED used to skip the whole file
  // before reading it, so a file-level pass clears all three of these — and
  // ships the last two. The allowance is a line shape, not a file pass.
  const beside = `${own} — ask mar.fenwick@mail.com`;
  assert.equal(onlyOwnRepoUrl(beside, findNeedles(beside, needles), prefixes), false, 'an address beside the URL');
  const elsewhere = '  "author": "Marlowe Fenwick"';
  assert.equal(onlyOwnRepoUrl(elsewhere, findNeedles(elsewhere, needles), prefixes), false, 'a name on another line');
  assert.equal(onlyOwnRepoUrl(own, findNeedles(own, needles), []), false, 'and no home, no allowance');
});

test('a credits line is a name and nothing contactable', () => {
  assert.equal(isCreditLine('- Marlowe Fenwick'), true);
  // An INVENTED name, like every other fixture here. The first draft of this
  // line used a real contributor's, and the family leg refused the commit —
  // a test fixture is tracked content like any other.
  assert.equal(isCreditLine("- Åsa d'Eon-Marchetti"), true, 'marks, apostrophes and hyphens');

  // THE MUTATION CHECK FOR THIS SHAPE. A credits file names people on purpose,
  // so the allowance has to admit a name — which makes everything that travels
  // WITH a name the thing it must still refuse.
  assert.equal(isCreditLine('- Marlowe Fenwick <mar@mail.com>'), false, 'an address');
  assert.equal(isCreditLine('- Marlowe Fenwick (Globex)'), false, 'an employer');
  assert.equal(isCreditLine('- Marlowe Fenwick, github.com/marlowefenwick'), false, 'a namespace');
  assert.equal(isCreditLine('- /Users/marlowefenwick/plan-flow'), false, 'a home directory');
  assert.equal(isCreditLine('- Marlowe Fenwick: lead'), false, 'a colon opens the line to anything');
  assert.equal(isCreditLine('Marlowe Fenwick'), false, 'and only a list item, not any prose line');
});

test('no tracked file names the person working on this repo', () => {
  const identity = gitIdentity(ROOT);
  const needles = identityNeedles(identity);

  // An unconfigured machine cannot be gated, and must say so rather than pass
  // quietly — a silent skip is indistinguishable from a clean tree.
  if (needles.length === 0) {
    console.log(
      'publish-identity: SKIPPED — git has no user.name or user.email here, ' +
        'so there is no identity to search for. This is not a clean result.',
    );
    return;
  }

  const { hits, excused, skipped, scanned } = scanTracked({ root: ROOT, needles });

  console.log(
    `publish-identity: ${scanned} tracked text files scanned for ${needles.length} ` +
      `identity fragments; ${skipped.binary} binary skipped (the family scanner ` +
      `does the byte pass).`,
  );
  for (const [path, allowance] of Object.entries(ALLOWED)) {
    const used = excused.filter((entry) => entry.file === path).length;
    console.log(`publish-identity: allowance ${path} [${allowance.shape}] — ${allowance.why} (${used} lines excused)`);
  }
  for (const entry of excused) {
    console.log(`publish-identity: excused ${entry.file}:${entry.line} ${entry.text}`);
  }
  for (const [path, reason] of skipped.unreadable) {
    console.log(`publish-identity: UNREADABLE ${path} — ${reason}`);
  }

  // The scan has to have actually read the tree; 0 of 0 files is not a pass.
  assert.ok(scanned > 100, `expected to scan the tracked tree, scanned ${scanned}`);
  assert.deepEqual(skipped.unreadable, [], 'a file the gate cannot read is not a file it cleared');

  assert.deepEqual(
    hits.map((hit) => `${hit.file}:${hit.line} [${hit.needle}] ${hit.text}`),
    [],
    'a tracked file names the author — the publish is a squash of exactly this tree',
  );
});
