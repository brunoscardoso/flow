#!/usr/bin/env node
/**
 * Release preflight + build + publish (#auto-update) — macOS ONLY.
 *
 * `npm run release` — builds the signed + notarized macOS artifacts (dmg for
 * first-install download, zip + latest-mac.yml + blockmap for electron-updater)
 * and publishes them to the GitHub repo configured in electron-builder.yml.
 *
 * WINDOWS IS NOT PART OF THIS PIPELINE. The Windows build is unsigned, has no
 * update feed (electron-builder.yml sets win.publish: null), and no CI — so
 * `release`/`ship` never produce or upload a .exe, and a successful run must
 * not be read as "Windows shipped". To ship Windows: run `npm run package:win`
 * on a Windows x64 machine and attach app/dist/Flow-<version>-x64-setup.exe
 * (and the portable .exe) to the same GitHub release by hand.
 *
 * Preflight is fail-fast: every missing prerequisite is reported before the
 * (slow) build starts, so a 10-minute build never dies at the publish step.
 *
 * Required environment (see electron-builder.yml "SIGNING" comment):
 *   - a "Developer ID Application" cert in the Keychain (auto-discovered)
 *   - APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID  (notarization)
 *   - GH_TOKEN (falls back to `gh auth token` when absent)
 */
import { execSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { LOCAL_SECRETS_FILE, distributableBuildConfig, resolveReleaseTarget } from './build-config.mjs'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { version } = require(join(appDir, 'package.json'))

// 0. Platform — everything below (Keychain identities, notarytool, the
//    latest-mac.yml feed) is macOS machinery. Refuse by name instead of
//    reporting a confusing "could not query the Keychain".
if (process.platform !== 'darwin') {
  console.error('release refused:')
  console.error(
    `  - macOS only (running on ${process.platform}) — this pipeline signs, notarizes and publishes the mac dmg/zip + latest-mac.yml feed`,
  )
  console.error(
    `  - Windows artifacts are built separately and unsigned: npm run package:win (on Windows x64), then attach the .exe files to the release manually`,
  )
  process.exit(1)
}

const problems = []

// 1. Signing identity — without it the build silently degrades to unsigned,
//    which Gatekeeper blocks and Squirrel.Mac refuses to update.
let identities = ''
try {
  identities = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' })
} catch {
  problems.push('could not query the Keychain for signing identities')
}
if (!identities.includes('Developer ID Application')) {
  problems.push(
    'no "Developer ID Application" certificate in the Keychain — create one at ' +
      'https://developer.apple.com/account/resources/certificates (requires the paid Developer Program)',
  )
}

// 2. Notarization credentials — electron-builder only *warns* when these are
//    missing, so enforce them here (an un-notarized DMG shows "damaged" to users).
//    Two supported shapes, in preference order:
//      a) APPLE_KEYCHAIN_PROFILE — creds stored once in the macOS Keychain via
//         `xcrun notarytool store-credentials <profile> --apple-id … --team-id … --password <app-specific>`
//      b) APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID env vars
if (!process.env.APPLE_KEYCHAIN_PROFILE) {
  const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter((name) => !process.env[name])
  if (missing.length > 0) {
    problems.push(
      `notarization credentials missing: set APPLE_KEYCHAIN_PROFILE (recommended — see script header) ` +
        `or the env vars ${missing.join(', ')}`,
    )
  }
}

// 3. Publish token — electron-builder reads GH_TOKEN; reuse the gh CLI's token
//    when the env var isn't set so a logged-in machine "just works".
let ghToken = process.env.GH_TOKEN
if (!ghToken) {
  const result = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' })
  if (result.status === 0 && result.stdout.trim()) {
    ghToken = result.stdout.trim()
    console.log('release: GH_TOKEN not set — using `gh auth token`')
  } else {
    problems.push('GH_TOKEN is not set and `gh auth token` returned nothing')
  }
}

// 4. Version must not already be published (bump app/package.json first).
//
//    THE TARGET IS THIS MACHINE'S, NOT THE REPO'S. electron-builder.yml is
//    committed and public, and it carries a placeholder owner on purpose: a
//    fork that builds the app must not get an update feed pointing at this
//    project's official releases. So the real owner/repo come from the
//    git-ignored app/.flow-build.local.json (or the environment), and are
//    passed to electron-builder on the command line below. `ship` resolves it
//    through the same function, so the two cannot drift apart.
const { owner, repo, slug: releaseRepo, refusal } = resolveReleaseTarget(appDir)
if (refusal !== null) {
  console.error(`release refused:\n  - ${refusal}`)
  process.exit(1)
}
if (ghToken) {
  const view = spawnSync('gh', ['release', 'view', `v${version}`, '--repo', releaseRepo], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: ghToken },
  })
  if (view.status === 0) {
    problems.push(
      `v${version} already exists on ${releaseRepo} — bump "version" in app/package.json first`,
    )
  }
}

// 5. Build-time configuration — the telemetry endpoint and the sign-in
//    provider. THESE FAIL SILENTLY, which is why they are checked here.
//
//    An unset variable compiles to the empty string. That is the correct
//    behaviour for a build from a clone — it collects nothing and offers no
//    sign-in — and it is a disaster for a RELEASE: the app installs, runs,
//    looks perfect, and quietly reports nothing. Nobody finds out by using it.
//    You find out weeks later when a dashboard is empty.
//
//    So a release refuses without them rather than shipping a dead one. If a
//    release deliberately should NOT report (a fork, a private build), say so
//    out loud: FLOW_RELEASE_WITHOUT_TELEMETRY=1.
//    The values are NOT taken from the shell any more: scripts/build-config.mjs
//    reads app/build-config.json (committed, public) and the per-machine
//    app/.flow-build.local.json (git-ignored, the ingest key). An environment
//    variable still overrides either, for a one-off build.
const buildConfig = distributableBuildConfig(appDir)
const RELEASE_CONFIG = buildConfig.missing.length === 0 ? Object.keys(buildConfig.values).map((name) => [name]) : []
if (process.env.FLOW_RELEASE_WITHOUT_TELEMETRY !== '1') {
  if (buildConfig.missing.length > 0) {
    problems.push(
      `build-time configuration missing — this release would collect nothing and offer no sign-in or sharing, silently:\n` +
        buildConfig.missing.map(([name, what]) => `      ${name} (${what})`).join('\n') +
        `\n    public values belong in app/build-config.json; the ingest key in app/${LOCAL_SECRETS_FILE}` +
        `\n    ({ "FLOW_TELEMETRY_KEY": "..." }), or say FLOW_RELEASE_WITHOUT_TELEMETRY=1 on purpose`,
    )
  }
}
problems.push(...buildConfig.problems)

// THE CLIENT SECRET MUST NEVER BE HERE. It belongs to the server and the
// exchange happens there; a secret reaching a build is the one mistake in this
// area that cannot be taken back once the binary is published.
for (const name of ['GITHUB_CLIENT_SECRET', 'SESSION_SECRET', 'POSTGRES_URL']) {
  if ((process.env[name] ?? '').trim() !== '') {
    problems.push(
      `${name} is set in this shell — it is a SERVER secret and must not be present for a client build; unset it and run again`,
    )
  }
}

if (problems.length > 0) {
  console.error('release refused:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`release: building Flow v${version} → publishing to ${releaseRepo}`)
const buildEnv = { ...process.env, ...buildConfig.values, GH_TOKEN: ghToken }
const run = (cmd) => execSync(cmd, { cwd: appDir, stdio: 'inherit', env: buildEnv })
// Agent-binary guard (2026-07-23 incident): v0.1.7 shipped with the SDK's
// native `claude` binary MISSING from node_modules — every session in the
// installed app failed. Never let a build start (or a bundle publish) without it.
run('node scripts/verify-agent-binary.mjs')
run('npm run build:cli')
run('npx electron-vite build')

// THE VALUES ACTUALLY LANDED. Checked against the built bundle rather than
// trusted from the environment, because that is the gap this whole area keeps
// falling into: the variables were set, the build ran, and the code that reads
// them was tree-shaken out — every test passing against a bundle that would
// never have shipped them. An assertion about `process.env` would have missed
// exactly that.
if (process.env.FLOW_RELEASE_WITHOUT_TELEMETRY !== '1') {
  const bundle = readFileSync(join(appDir, 'out/main/index.js'), 'utf8')
  const absent = RELEASE_CONFIG.map(([name]) => name).filter(
    (name) => !bundle.includes(buildConfig.values[name] || '\u0000'),
  )
  if (absent.length > 0) {
    console.error('release refused:')
    console.error(
      `  - the build did not compile in: ${absent.join(', ')} — the values were set but are not in out/main/index.js`,
    )
    process.exit(1)
  }
  console.log(`release: build-time configuration verified in the bundle (${RELEASE_CONFIG.length} values)`)
}
// --publish always uploads dmg + zip + latest-mac.yml + blockmap to a DRAFT
// GitHub release (electron-builder drafts by default); publish the release on
// GitHub to make it visible to users and to the updater feed.
run(
  'npx electron-builder --mac --publish always' +
    ` --config.publish.owner=${owner} --config.publish.repo=${repo}`,
)

// THE DRAFT IS NOT A SAFE PLACE TO LEAVE A BAD BUILD. This repo runs a
// scheduled workflow (.github/workflows/publish-drafts.yml, weekdays 12:00 UTC)
// that publishes the oldest draft automatically — so a draft left behind by a failed check would
// reach users at the next slot unless someone remembered to delete it. Every
// check after the upload therefore DELETES the draft itself when it fails.
//
// What is checked: the agent binary is present, and the app holds nothing but
// the compiled bundle (v0.1.10 shipped the whole app/ folder — src/, e2e/,
// scripts/, a dev script with the ingest key — because electron-builder.yml's
// platform `files` blocks held only exclusions).
for (const check of [
  'node scripts/verify-agent-binary.mjs "dist/mac-arm64/Flow.app"',
  'node scripts/verify-package-contents.mjs "dist/mac-arm64/Flow.app"',
]) {
  try {
    run(check)
  } catch {
    console.error(`release refused: \`${check}\` failed — deleting the draft v${version} on ${releaseRepo} so it can never be published`)
    const removed = spawnSync('gh', ['release', 'delete', `v${version}`, '--repo', releaseRepo, '--cleanup-tag', '--yes'], { stdio: 'inherit', env: { ...process.env, GH_TOKEN: ghToken } })
    if (removed.status !== 0) {
      console.error(`release: COULD NOT delete the draft — delete v${version} on ${releaseRepo} NOW, before the scheduled publisher runs (weekdays 12:00 UTC)`)
    }
    process.exit(1)
  }
}

// electron-builder's GitHub uploader has silently dropped large assets while
// still exiting 0 (observed live on v0.1.0: only one blockmap of five files
// landed — its dmg and zip publishers even raced creating the release twice).
// Never trust the worker's success: verify every expected asset against the
// draft release and re-upload whatever is missing via gh, which is reliable.
// macOS artifacts only — no .exe is expected here, and none is built above.
const expected = [
  `Flow-${version}-arm64.dmg`,
  `Flow-${version}-arm64.dmg.blockmap`,
  `Flow-${version}-arm64-mac.zip`,
  `Flow-${version}-arm64-mac.zip.blockmap`,
  'latest-mac.yml',
]
const ghEnv = { encoding: 'utf8', env: { ...process.env, GH_TOKEN: ghToken } }
const assetsOut = spawnSync('gh', ['release', 'view', `v${version}`, '--repo', releaseRepo, '--json', 'assets', '--jq', '.assets[].name'], ghEnv)
const uploaded = new Set(assetsOut.stdout?.split('\n').filter(Boolean) ?? [])
const missing = expected.filter((name) => !uploaded.has(name))
if (missing.length > 0) {
  console.log(`release: ${missing.length} asset(s) missing from the GitHub release — re-uploading via gh: ${missing.join(', ')}`)
  const upload = spawnSync('gh', ['release', 'upload', `v${version}`, '--repo', releaseRepo, '--clobber', ...missing.map((name) => join(appDir, 'dist', name))], { stdio: 'inherit', env: { ...process.env, GH_TOKEN: ghToken } })
  if (upload.status !== 0) {
    console.error(`release failed: could not upload missing assets — fix manually with:\n  cd app/dist && gh release upload v${version} --repo ${releaseRepo} ${missing.join(' ')}`)
    process.exit(1)
  }
}
// THE BUILD LEFT CREDENTIALS IN THE WORKING TREE.
//
// A release build compiles the ingest key and the GitHub client id into
// `app/out`. While that directory was TRACKED this was acute: every release
// ended with secrets in a file git was watching, one `git add -A` away from
// being published for ever. It was a KNOWN hazard — documented in
// ingest/SETUP.md — and it happened anyway on the first real release, exactly
// as described, which is why the guard below exists.
//
// `app/out` is no longer tracked (2026-10-14), so the one-command accident is
// gone. The guard stays: the key should not linger on disk either, and this is
// the only step that proves what the build actually left behind.
try {
  execSync('npx electron-vite build', {
    cwd: appDir,
    stdio: 'ignore',
    // Public values stay (they come from the committed build-config.json and
    // are meant to be in every build); only the per-machine KEY is withheld.
    env: { ...process.env, FLOW_TELEMETRY_KEY: '' },
  })
  const after = readFileSync(join(appDir, 'out/main/index.js'), 'utf8')
  const key = buildConfig.values.FLOW_TELEMETRY_KEY ?? ''
  const leaked = key.length > 8 && after.includes(key) ? ['FLOW_TELEMETRY_KEY'] : []
  if (leaked.length > 0) {
    console.error(`release: WARNING — ${leaked.join(', ')} still present in app/out; do NOT commit it`)
  } else {
    console.log('release: app/out rebuilt without credentials — safe to commit')
  }
} catch {
  console.error('release: WARNING — could not rebuild app/out; it still holds the release credentials, do NOT commit it')
}

console.log(`release: done, all ${expected.length} macOS assets verified — review and publish the draft at https://github.com/${releaseRepo}/releases`)
console.log(`release: Windows NOT included — build it separately with \`npm run package:win\` on Windows x64 and attach the .exe files to the draft`)
