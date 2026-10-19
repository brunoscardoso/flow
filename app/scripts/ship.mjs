#!/usr/bin/env node
/**
 * One-command release: `npm run ship [patch|minor|major|x.y.z] [--dry-run] [--draft] [--allow-private] [--yes]`
 *
 * macOS ONLY — this wraps scripts/release.mjs, which builds/signs/notarizes the
 * mac artifacts and verifies the latest-mac.yml feed. It NEVER builds, uploads
 * or verifies a Windows .exe, so "ship: done" means macOS shipped, nothing more.
 * Windows: `npm run package:win` on a Windows x64 box, then attach the .exe
 * files to the same GitHub release by hand (unsigned, no update feed).
 *
 * Wraps the full playbook:
 *   1. preflight — on main, ff-only pull, the release repo must be PUBLIC
 *      (a private feed 404s for every installed app — override with --allow-private
 *      when deliberately testing)
 *   2. bump "version" in app/package.json (default: patch), commit + push to main
 *   3. run scripts/release.mjs (build → sign → notarize → upload; that script
 *      preflights signing creds and verifies all assets landed)
 *   4. REVIEW GATE — show the generated release notes and wait for the release
 *      manager: publish / edit notes in $EDITOR / regenerate with guidance for
 *      the writer / keep draft / quit. NOTHING goes public without an explicit
 *      "y" (user requirement 2026-07-22). Non-interactive runs (no TTY) keep
 *      the draft; --yes restores unattended auto-publish.
 *   5. verify the public feed now serves the new version
 *
 * APPLE_KEYCHAIN_PROFILE defaults to "flow-notarize" (the profile created for
 * this machine) when no notarization env is set — override by exporting it.
 *
 * --dry-run stops after preflight and prints what would happen; mutates nothing.
 */
import { execSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'

import { resolveReleaseTarget } from './build-config.mjs'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = join(appDir, '..')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const keepDraft = args.includes('--draft')
const allowPrivate = args.includes('--allow-private')
const autoYes = args.includes('--yes') || args.includes('-y')
const bumpArg = args.find((a) => !a.startsWith('--') && a !== '-y') ?? 'patch'

const fail = (msg) => {
  console.error(`ship refused: ${msg}`)
  process.exit(1)
}
// macOS only (see header): the whole pipeline downstream is Mac-shaped, and a
// version bump committed to main from a machine that cannot finish the build
// leaves the repo claiming a release that does not exist.
if (process.platform !== 'darwin') {
  fail(
    `macOS only (running on ${process.platform}) — ship builds, signs and notarizes the macOS release.\n` +
      `  Windows is unsigned and has no update feed: run \`npm run package:win\` on Windows x64 and attach app/dist/*.exe to the release manually.`,
  )
}

// sh captures output; run streams it (execSync returns null under stdio:
// inherit, so the two must stay separate — .trim() on null crashes).
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: repoDir }).trim()
const run = (cmd) => execSync(cmd, { stdio: 'inherit', cwd: repoDir })

// --- next version -----------------------------------------------------------
const pkgPath = join(appDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.version
let next
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) {
  next = bumpArg
} else if (['patch', 'minor', 'major'].includes(bumpArg)) {
  const [major, minor, patch] = current.split('.').map(Number)
  next =
    bumpArg === 'major' ? `${major + 1}.0.0` : bumpArg === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
} else {
  fail(`unknown bump "${bumpArg}" — use patch | minor | major | x.y.z`)
}

// --- preflight --------------------------------------------------------------
// Branch discipline: parallel sessions/agents switching branches mid-run is a
// known failure mode here — verify immediately before any commit.
const branch = sh('git branch --show-current')
if (branch !== 'main') fail(`must ship from main (currently on "${branch}")`)

// The version bump is the only thing this script commits; anything else staged
// would ride along. Refuse on a dirty package.json to avoid clobbering edits.
const pkgDirty = sh('git status --porcelain -- app/package.json')
if (pkgDirty !== '') fail('app/package.json has uncommitted changes — commit or revert them first')

// Feed visibility: electron-updater reads the release feed anonymously.
//
// THE TARGET COMES FROM THE SAME RESOLVER `release` USES. This block used to
// parse electron-builder.yml, which is committed and carries a placeholder
// owner — so every `gh` call below addressed a repo that does not exist and
// ship refused at this preflight with "unreachable". Resolving it the one way
// release does is what keeps a published feed and a shipped build in the same
// place.
const { slug: releaseRepo, refusal } = resolveReleaseTarget(appDir)
if (refusal !== null) fail(refusal)
const visibility = spawnSync('gh', ['repo', 'view', releaseRepo, '--json', 'visibility', '--jq', '.visibility'], {
  encoding: 'utf8',
}).stdout?.trim()
if (visibility !== 'PUBLIC' && !allowPrivate) {
  fail(
    `${releaseRepo} is ${visibility ?? 'unreachable'} — installed apps cannot read a private update feed.\n` +
      `  Make it public: gh repo edit ${releaseRepo} --visibility public --accept-visibility-change-consequences\n` +
      `  or pass --allow-private to ship anyway (testing only)`,
  )
}

console.log(`ship: Flow v${current} → v${next} on ${releaseRepo} (${visibility}${keepDraft ? ', will stay draft' : ''})`)
if (dryRun) {
  console.log('ship: --dry-run — stopping before any changes')
  process.exit(0)
}

// --- bump + commit + push ---------------------------------------------------
run('git pull --ff-only')
pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
if (sh('git branch --show-current') !== 'main') fail('branch changed mid-run — aborting before commit')
sh('git add app/package.json')
// A re-run after a failed release (`npm run ship <same version>`, which the
// failure message below asks for) finds the bump already committed: there is
// nothing to commit, and `git commit` would refuse and abort the retry.
if (sh('git diff --cached --name-only') === '') {
  console.log(`ship: v${next} is already the committed version — resuming the release`)
} else {
  sh(`git commit -m "release: Flow v${next}"`)
  run('git push origin main')
  console.log(`ship: version bump committed and pushed`)
}

// --- build / sign / notarize / upload --------------------------------------
const releaseEnv = { ...process.env }
if (!releaseEnv.APPLE_KEYCHAIN_PROFILE && !releaseEnv.APPLE_ID && !releaseEnv.APPLE_API_KEY) {
  releaseEnv.APPLE_KEYCHAIN_PROFILE = 'flow-notarize'
  console.log('ship: defaulting APPLE_KEYCHAIN_PROFILE=flow-notarize')
}
const release = spawnSync('node', ['scripts/release.mjs'], { cwd: appDir, stdio: 'inherit', env: releaseEnv })
if (release.status !== 0) {
  console.error(`ship failed during release — the v${next} bump is already on main; fix the issue and re-run: npm run ship ${next}`)
  process.exit(1)
}

// --- release notes ----------------------------------------------------------
// Written by the claude CLI when available, deterministic commit grouping
// otherwise (see release-notes.mjs) — either way the release gets a body.
const notesFile = join(tmpdir(), `flow-release-notes-${next}.md`)
const generateNotes = (hint) => {
  const notesRun = spawnSync('node', ['scripts/release-notes.mjs', next, ...(hint ? [`--hint=${hint}`] : [])], {
    cwd: appDir,
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (notesRun.status === 0 && notesRun.stdout.trim().length > 0) {
    writeFileSync(notesFile, notesRun.stdout.trim() + '\n')
    return true
  }
  return false
}
let hasNotes = generateNotes()
if (!hasNotes) console.warn('ship: release-notes generation failed — release will have no notes body')

const showNotes = () => {
  const divider = '─'.repeat(60)
  console.log(`\nship: release notes for Flow v${next} —\n${divider}`)
  console.log(hasNotes ? readFileSync(notesFile, 'utf8').trim() : '(no notes — generation failed)')
  console.log(`${divider}`)
}
const notesArgs = () => (hasNotes ? ['--notes-file', notesFile] : [])
const attachToDraft = () => {
  spawnSync('gh', ['release', 'edit', `v${next}`, '--repo', releaseRepo, '--title', `Flow v${next}`, ...notesArgs()], {
    encoding: 'utf8',
  })
}

// --- review gate -------------------------------------------------------------
// Nothing goes public without an explicit confirmation from whoever runs the
// script (user requirement 2026-07-22). --yes restores unattended publishing;
// a non-TTY run (CI/background) can never confirm, so it keeps the draft.
if (keepDraft) {
  attachToDraft()
  console.log(`ship: done — draft kept (notes attached).`)
  console.log(
    `ship: the publish-drafts workflow flips it public at the next neutral slot (weekdays 12:00 UTC) — timestamps never reveal working hours. Manual: https://github.com/${releaseRepo}/releases`,
  )
  process.exit(0)
}
let confirmed = autoYes
if (!confirmed) {
  if (!process.stdin.isTTY) {
    attachToDraft()
    console.log(
      `ship: non-interactive run — draft kept (notes attached). Publish at https://github.com/${releaseRepo}/releases or re-run with --yes.`,
    )
    process.exit(0)
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const editor = process.env.EDITOR || process.env.VISUAL || 'vi'
  while (!confirmed) {
    showNotes()
    const answer = (
      await rl.question(`Publish Flow v${next} to ${releaseRepo}? [y]es · [e]dit notes · [r]egenerate · [d]raft only · [q]uit: `)
    )
      .trim()
      .toLowerCase()
    if (answer === 'y' || answer === 'yes') {
      confirmed = true
    } else if (answer === 'e' || answer === 'edit') {
      if (!hasNotes) writeFileSync(notesFile, '')
      const edit = spawnSync(editor, [notesFile], { stdio: 'inherit' })
      if (edit.status !== 0) console.log(`ship: ${editor} exited with ${edit.status} — notes unchanged`)
      hasNotes = readFileSync(notesFile, 'utf8').trim().length > 0
    } else if (answer === 'r' || answer === 'regenerate') {
      const hint = (await rl.question('Guidance for the writer (empty = none): ')).trim()
      console.log('ship: regenerating notes…')
      if (!generateNotes(hint === '' ? undefined : hint)) console.warn('ship: regeneration failed — keeping current notes')
    } else if (answer === 'd' || answer === 'draft') {
      rl.close()
      attachToDraft()
      console.log(`ship: draft kept (notes attached) — publish manually at https://github.com/${releaseRepo}/releases`)
      process.exit(0)
    } else if (answer === 'q' || answer === 'quit') {
      rl.close()
      attachToDraft()
      console.log(`ship: aborted — v${next} stays a DRAFT (notes attached), nothing published`)
      process.exit(1)
    } else {
      console.log(`ship: unrecognized "${answer}" — y / e / r / d / q`)
    }
  }
  rl.close()
}

// --- publish ----------------------------------------------------------------
const publish = spawnSync(
  'gh',
  ['release', 'edit', `v${next}`, '--repo', releaseRepo, '--draft=false', '--latest', '--title', `Flow v${next}`, ...notesArgs()],
  { encoding: 'utf8' },
)
if (publish.status !== 0) {
  console.error(`ship failed publishing the release: ${publish.stderr}`)
  console.error(`  publish manually: gh release edit v${next} --repo ${releaseRepo} --draft=false --latest`)
  process.exit(1)
}

// --- clean up racing-publisher drafts ----------------------------------------
// electron-builder runs one GitHub publisher per target (dmg + zip); they race
// creating the release and leave a stray DRAFT sharing our tag (observed on
// v0.1.0–v0.1.2 — the "missing" assets live there). Ours is published now, so
// any remaining draft on this tag is the race leftover. Drafts share tags with
// real releases, so deletion must go by release id, never by tag.
const draftIds = spawnSync(
  'gh',
  ['api', `repos/${releaseRepo}/releases`, '--jq', `.[] | select(.draft == true and .tag_name == "v${next}") | .id`],
  { encoding: 'utf8' },
)
const strayIds = draftIds.stdout?.split('\n').filter(Boolean) ?? []
for (const id of strayIds) {
  spawnSync('gh', ['api', '-X', 'DELETE', `repos/${releaseRepo}/releases/${id}`], { encoding: 'utf8' })
}
if (strayIds.length > 0) console.log(`ship: removed ${strayIds.length} stray draft(s) left by electron-builder's publisher race`)

// --- verify the live feed ---------------------------------------------------
let feedVersion = null
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    const res = await fetch(`https://github.com/${releaseRepo}/releases/latest/download/latest-mac.yml`, {
      redirect: 'follow',
    })
    if (res.ok) {
      feedVersion = /^version:\s*(\S+)/m.exec(await res.text())?.[1] ?? null
      if (feedVersion === next) break
    }
  } catch {
    // transient — retry
  }
  await new Promise((resolve) => setTimeout(resolve, 3000))
}
if (feedVersion === next) {
  console.log(`ship: done — v${next} is live on macOS. Feed verified; installed MAC apps will offer the update on next launch/6h check.`)
  console.log(`ship: Windows was NOT shipped — build it with \`npm run package:win\` on Windows x64 and attach app/dist/*.exe to the v${next} release (unsigned, no auto-update).`)
} else {
  console.error(
    `ship: v${next} published, but the live feed still reports ${feedVersion ?? 'nothing'} — ` +
      `check https://github.com/${releaseRepo}/releases (private repo feeds always fail this check)`,
  )
  process.exit(1)
}
