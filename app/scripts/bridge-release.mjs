#!/usr/bin/env node
/**
 * Copy a published release's assets into a second repo.
 *
 *   node scripts/bridge-release.mjs <x.y.z> --to <owner/repo> [--from <owner/repo>] [--dry-run]
 *
 * WHY THIS EXISTS. The update feed moved from a separate artifacts-only repo
 * into the source repo. electron-updater does not read the feed from a setting
 * the app can change — it reads the `app-update.yml` that electron-builder
 * BAKED IN at build time. So every copy of Flow already installed keeps asking
 * the old repo, for ever, and a feed that stops being published is
 * indistinguishable from "you are up to date".
 *
 * The way across is one release published in both places:
 *
 *   1. build and publish the new version to the NEW repo as usual (`ship`),
 *      so the binary everyone is about to download has the new feed baked in;
 *   2. copy that same release here, into the OLD repo;
 *   3. an installed app asks the old repo, finds the new version, updates —
 *      and the build it just installed asks the new repo from then on.
 *
 * After that the old repo can be archived: nothing still points at it. Run this
 * once per migration, not on every release.
 *
 * It also runs backwards (`--from` the old repo, `--to` the new one), which is
 * how an existing release's artifacts get a home in the new repo.
 *
 * Re-runnable: assets upload with --clobber and the release is only created
 * when it is absent, so a half-finished run is fixed by running it again.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveReleaseTarget } from './build-config.mjs'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a))
const flag = (name) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const fail = (msg) => {
  console.error(`bridge refused: ${msg}`)
  process.exit(1)
}

if (!version) fail('usage: bridge-release.mjs <x.y.z> --to <owner/repo> [--from <owner/repo>] [--dry-run]')

const to = flag('to')
if (!to || !/^[\w.-]+\/[\w.-]+$/.test(to)) fail('--to <owner/repo> is required')

// The source defaults to wherever this machine publishes — the same resolver
// release and ship use, so the three cannot disagree about where a release is.
let from = flag('from')
if (from === undefined) {
  const resolved = resolveReleaseTarget(appDir)
  if (resolved.refusal !== null) fail(resolved.refusal)
  from = resolved.slug
}
if (!/^[\w.-]+\/[\w.-]+$/.test(from)) fail('--from must be <owner/repo>')
if (from === to) fail(`--from and --to are the same repo (${from}) — nothing to bridge`)

const tag = `v${version}`
const gh = (argv, opts = {}) => spawnSync('gh', argv, { encoding: 'utf8', ...opts })

// --- the source release must exist and be public ----------------------------
// A draft has no assets a feed can reach, so bridging one would publish an
// empty release into the old repo and tell every installed app it is current.
const source = gh(['release', 'view', tag, '--repo', from, '--json', 'isDraft,assets,name'])
if (source.status !== 0) fail(`${from} has no release ${tag}\n  ${source.stderr?.trim() ?? ''}`)
const info = JSON.parse(source.stdout)
if (info.isDraft === true) fail(`${from} ${tag} is still a draft — publish it before bridging`)

const names = info.assets.map((a) => a.name)
const feed = 'latest-mac.yml'
if (!names.includes(feed)) {
  fail(`${from} ${tag} has no ${feed} — without the feed file an installed app sees nothing`)
}
console.log(`bridge: ${from} ${tag} → ${to}`)
console.log(`bridge: ${names.length} assets — ${names.join(', ')}`)

if (dryRun) {
  console.log('bridge: --dry-run — stopping before any change')
  process.exit(0)
}

// --- download, then upload --------------------------------------------------
const staging = mkdtempSync(join(tmpdir(), `flow-bridge-${version}-`))
try {
  const down = gh(['release', 'download', tag, '--repo', from, '--dir', staging, '--clobber'], {
    stdio: 'inherit',
  })
  if (down.status !== 0) fail(`could not download ${from} ${tag}`)

  const got = readdirSync(staging)
  const missing = names.filter((name) => !got.includes(name))
  if (missing.length > 0) fail(`download incomplete — missing ${missing.join(', ')}`)
  const bytes = got.reduce((sum, name) => sum + statSync(join(staging, name)).size, 0)
  console.log(`bridge: downloaded ${got.length} files, ${(bytes / 1024 ** 3).toFixed(2)} GiB`)

  // Create the destination release only if it is absent; an existing one keeps
  // its notes and just gets the assets replaced.
  const exists = gh(['release', 'view', tag, '--repo', to, '--json', 'tagName']).status === 0
  if (!exists) {
    const notes =
      `Flow ${tag}.\n\n` +
      `This release is a copy of [${from} ${tag}](https://github.com/${from}/releases/tag/${tag}), ` +
      `published here so that already-installed builds pointing at this repo can update themselves. ` +
      `Releases now live in ${to}.`
    const created = gh(
      ['release', 'create', tag, '--repo', to, '--title', info.name ?? `Flow ${version}`, '--notes', notes],
      { stdio: 'inherit' },
    )
    if (created.status !== 0) fail(`could not create ${to} ${tag}`)
  } else {
    console.log(`bridge: ${to} ${tag} already exists — replacing its assets`)
  }

  const up = gh(
    ['release', 'upload', tag, '--repo', to, '--clobber', ...got.map((name) => join(staging, name))],
    { stdio: 'inherit' },
  )
  if (up.status !== 0) fail(`could not upload assets to ${to} ${tag}`)

  // electron-updater reads the LATEST release of the repo, so a bridged
  // release that is not marked latest is a file nobody will ever fetch.
  const latest = gh(['release', 'edit', tag, '--repo', to, '--draft=false', '--latest'])
  if (latest.status !== 0) fail(`could not mark ${to} ${tag} as latest`)

  // --- verify, from outside ---------------------------------------------------
  const landed = gh(['release', 'view', tag, '--repo', to, '--json', 'assets', '--jq', '.assets[].name'])
  const there = (landed.stdout ?? '').split('\n').filter(Boolean)
  const absent = names.filter((name) => !there.includes(name))
  if (absent.length > 0) fail(`these assets did not land in ${to}: ${absent.join(', ')}`)

  const served = await fetch(`https://github.com/${to}/releases/latest/download/${feed}`, {
    redirect: 'follow',
  })
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '')
  if (!served.includes(version)) {
    console.error(
      `bridge: assets landed, but ${to}'s public feed does not serve ${version} yet.\n` +
        `  Check https://github.com/${to}/releases/tag/${tag} — a private repo's feed never resolves.`,
    )
    process.exit(1)
  }

  console.log(`bridge: done — ${to} now serves ${version} to apps still pointing at it`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
