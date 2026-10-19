// THE RELEASE TARGET RESOLVES FROM THIS MACHINE, OR IT REFUSES.
//
// `electron-builder.yml` is committed and carries a placeholder publish target
// on purpose, so a fork that builds the app never gets an update feed pointing
// at this project's official releases. Three scripts used to parse that file
// for the owner and repo, and each one was wrong in its own way:
//
//   release.mjs       read the local file but fell back to the yml, which made
//                     its "no release target" refusal unreachable — the
//                     committed file always parses, so the guard never fired.
//   ship.mjs          read ONLY the yml, so every `gh` call addressed a repo
//                     that does not exist and ship refused at preflight.
//   release-notes.mjs read ONLY the yml, so its date anchor always failed and
//                     the commit range silently fell through to "last 100".
//
// Two of those are loud and one is silent, which is the worst mix: the silent
// one produced plausible release notes from the wrong range for every release.
//
// So there is one resolver, and these tests pin the two things that broke:
// the refusal must be REACHABLE, and no script may parse the yml again.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveReleaseTarget } from '../app/scripts/build-config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** An app dir with no local config, so nothing on this machine leaks in. */
function bareAppDir() {
  return mkdtempSync(join(tmpdir(), 'flow-release-target-'));
}

// Every value here is INVENTED. A tracked test fixture is tracked content, and
// the publish gate reads it like any other file.
test('a configured machine resolves to its own target', () => {
  const resolved = resolveReleaseTarget(bareAppDir(), {
    FLOW_RELEASE_OWNER: 'marlowe-labs',
    FLOW_RELEASE_REPO: 'widget',
  });
  assert.equal(resolved.slug, 'marlowe-labs/widget');
  assert.equal(resolved.owner, 'marlowe-labs');
  assert.equal(resolved.repo, 'widget');
  assert.equal(resolved.refusal, null);
});

test('the local file answers when the environment is silent', () => {
  const dir = bareAppDir();
  writeFileSync(
    join(dir, '.flow-build.local.json'),
    JSON.stringify({ FLOW_RELEASE_OWNER: 'marlowe-labs', FLOW_RELEASE_REPO: 'widget' }),
  );
  assert.equal(resolveReleaseTarget(dir, {}).slug, 'marlowe-labs/widget');
});

test('the environment overrides the local file', () => {
  const dir = bareAppDir();
  writeFileSync(
    join(dir, '.flow-build.local.json'),
    JSON.stringify({ FLOW_RELEASE_OWNER: 'marlowe-labs', FLOW_RELEASE_REPO: 'widget' }),
  );
  const resolved = resolveReleaseTarget(dir, { FLOW_RELEASE_REPO: 'widget-nightly' });
  assert.equal(resolved.slug, 'marlowe-labs/widget-nightly');
});

// THE REGRESSION. With the yml as a fallback this returned the placeholder and
// `refusal` was null, so a machine with no local config published to a repo
// nobody chose instead of stopping.
test('an unconfigured machine refuses instead of inheriting the placeholder', () => {
  const resolved = resolveReleaseTarget(bareAppDir(), {});
  assert.equal(resolved.slug, null, 'no slug may be invented');
  assert.equal(resolved.owner, null);
  assert.equal(resolved.repo, null);
  assert.notEqual(resolved.refusal, null, 'the refusal must be reachable');
  assert.match(resolved.refusal, /FLOW_RELEASE_OWNER and FLOW_RELEASE_REPO/);

  // And it must not be the committed placeholder, whatever that placeholder is.
  const yml = readFileSync(join(ROOT, 'app/electron-builder.yml'), 'utf8');
  const placeholder = /^\s*owner:\s*(\S+)/m.exec(yml)?.[1];
  assert.ok(placeholder, 'the yml should still carry a placeholder owner');
  assert.notEqual(resolved.owner, placeholder);
});

test('half a target is still no target, and the refusal says which half', () => {
  const ownerOnly = resolveReleaseTarget(bareAppDir(), { FLOW_RELEASE_OWNER: 'marlowe-labs' });
  assert.equal(ownerOnly.slug, null);
  assert.match(ownerOnly.refusal, /FLOW_RELEASE_REPO/);
  assert.doesNotMatch(ownerOnly.refusal, /FLOW_RELEASE_OWNER/, 'the one that IS set is not named');

  const repoOnly = resolveReleaseTarget(bareAppDir(), { FLOW_RELEASE_REPO: 'widget' });
  assert.equal(repoOnly.slug, null);
  assert.match(repoOnly.refusal, /FLOW_RELEASE_OWNER/);
  assert.doesNotMatch(repoOnly.refusal, /FLOW_RELEASE_REPO/);
});

test('a blank value is an absent value, not an empty slug', () => {
  const resolved = resolveReleaseTarget(bareAppDir(), {
    FLOW_RELEASE_OWNER: '  ',
    FLOW_RELEASE_REPO: '',
  });
  assert.equal(resolved.slug, null);
  assert.notEqual(resolved.refusal, null);
});

// THE PINNING TEST. Each of the three scripts grew its own copy of this parse,
// and a fourth would be just as quiet. The invariant is one code path, so the
// test is about the code paths, not about one script's behaviour.
test('no release script parses the yml for a publish target', () => {
  for (const name of ['release.mjs', 'ship.mjs', 'release-notes.mjs']) {
    const source = readFileSync(join(ROOT, 'app/scripts', name), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    assert.doesNotMatch(
      code,
      /exec\(\s*(yml|builderYml)\s*\)/,
      `${name} resolves owner/repo from electron-builder.yml again — use resolveReleaseTarget`,
    );
    assert.match(code, /resolveReleaseTarget/, `${name} must resolve the target the one way`);
  }
});
