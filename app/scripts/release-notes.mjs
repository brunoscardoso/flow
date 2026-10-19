#!/usr/bin/env node
/**
 * Generate user-facing release notes for a Flow release.
 *
 *   node scripts/release-notes.mjs <version> [--no-llm]
 *
 * Markdown goes to STDOUT (so callers can pipe/capture it); all diagnostics go
 * to stderr. `npm run ship` calls this and attaches the output to the GitHub
 * release via --notes-file.
 *
 * Commit range — first anchor that resolves wins:
 *   1. everything since the last `release: Flow vX.Y.Z` commit (ship's bump)
 *   2. everything since the latest published release's date on the release repo
 *      (covers v0.1.0, which was shipped before ship.mjs existed)
 *   3. the last 100 commits
 *
 * Writing — engine with native fallback (project pattern): if the `claude` CLI
 * is available it writes the prose; on any failure (missing binary, timeout,
 * empty output) we fall back to deterministic conventional-commit grouping so
 * the release is never blocked on an LLM.
 */
import { execSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveReleaseTarget } from './build-config.mjs'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = join(appDir, '..')
const version = process.argv[2]
const noLlm = process.argv.includes('--no-llm')
/** `--hint=<text>` — extra guidance for the LLM writer (ship's regenerate flow). */
const hint = process.argv.find((a) => a.startsWith('--hint='))?.slice('--hint='.length) ?? ''
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/release-notes.mjs <x.y.z> [--no-llm] [--hint=<guidance>]')
  process.exit(1)
}

const sh = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: repoDir }).trim()

// --- collect commit subjects ------------------------------------------------
// Both anchors must exclude the release being shipped: ship.mjs commits the
// `release: Flow v<version>` bump BEFORE notes run, so "the most recent
// release commit / published release" is this release itself — anchoring on it
// yields zero commits (shipped as empty "Maintenance release" notes on
// v0.1.1). Anchor on the last release that is NOT v<version>.
let range = null
let anchorNote = ''
const bumpCommits = sh(`git log --grep='^release: Flow v' --format='%H %s' -n 10`)
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => ({ hash: line.slice(0, line.indexOf(' ')), subject: line.slice(line.indexOf(' ') + 1) }))
// The range ends at this version's own bump commit when it exists (so notes
// can be regenerated for an already-shipped version), else at HEAD (normal
// in-flight ship: notes run right after the bump). It starts at the first
// bump commit OLDER than the end — newer releases' commits never leak in.
const ownIndex = bumpCommits.findIndex((c) => c.subject === `release: Flow v${version}`)
const rangeEnd = ownIndex >= 0 ? bumpCommits[ownIndex].hash : 'HEAD'
const previousBump = (ownIndex >= 0 ? bumpCommits.slice(ownIndex + 1) : bumpCommits).find(
  (c) => c.subject !== `release: Flow v${version}`,
)
if (previousBump !== undefined) {
  range = `${previousBump.hash}..${rangeEnd}`
  anchorNote = `since ${previousBump.subject}`
} else {
  // The target comes from the shared resolver, not from electron-builder.yml.
  // Parsing the committed yml here asked GitHub about a placeholder repo that
  // does not exist, so this anchor ALWAYS failed and the range silently fell
  // through to "the last 100 commits" — a wrong answer that still produced
  // notes, which is why it went unnoticed.
  const { slug } = resolveReleaseTarget(appDir)
  // drafts are excluded: electron-builder's racing publishers leave stray
  // drafts whose null publishedAt renders as year 0001 — anchoring there
  // sweeps in the entire history. "Previous" means chronologically BEFORE this
  // version's own release when it exists (regeneration), else the newest
  // published release (in-flight ship — ours isn't published yet).
  const list = spawnSync(
    'gh',
    ['release', 'list', '--repo', slug ?? '', '--json', 'tagName,publishedAt,isDraft'],
    { encoding: 'utf8' },
  )
  let publishedAt = ''
  if (list.status === 0) {
    try {
      const releases = JSON.parse(list.stdout)
        .filter((r) => r.isDraft === false)
        .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
      const own = releases.find((r) => r.tagName === `v${version}`)
      const previous = releases.find((r) =>
        own !== undefined ? r.publishedAt < own.publishedAt : r.tagName !== `v${version}`,
      )
      publishedAt = previous?.publishedAt ?? ''
    } catch {
      publishedAt = ''
    }
  }
  if (publishedAt !== '' && publishedAt !== 'null' && !publishedAt.startsWith('0001-')) {
    // rangeEnd bounds the walk at this version's own bump — --since alone
    // defaults to HEAD and sweeps in commits from NEWER releases when
    // regenerating notes for an old version.
    range = `--since=${publishedAt} ${rangeEnd}`
    anchorNote = `since previous release published at ${publishedAt}`
  } else {
    range = `-n 100 ${rangeEnd}`
    anchorNote = 'last 100 commits (no prior release found)'
  }
}
const logCmd = range.startsWith('--') || range.startsWith('-n') ? `git log ${range} --format=%s` : `git log ${range} --format=%s`
const subjects = sh(logCmd)
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s !== '')
  .filter((s) => !/^release: Flow v/.test(s))
  .filter((s) => !/^Merge /.test(s))
console.error(`release-notes: ${subjects.length} commits (${anchorNote})`)
if (subjects.length === 0) {
  console.log(`Maintenance release — no user-visible changes recorded.`)
  process.exit(0)
}

// --- deterministic fallback -------------------------------------------------
const CONVENTIONAL = /^(feat|fix|perf|refactor|docs|test|chore|ci|build|style)(\([^)]*\))?!?:\s*(.+)$/
function deterministicNotes() {
  const sections = { New: [], Fixes: [], Improvements: [] }
  for (const subject of subjects) {
    const match = CONVENTIONAL.exec(subject)
    const type = match?.[1]
    // strip the plan-flow task scaffolding: "(phase-2.task-1)" scopes and
    // trailing "— feature-name" markers read as noise in user-facing notes
    const description = (match?.[3] ?? subject).replace(/\s+—\s+[\w-]+$/, '').trim()
    if (type === 'feat') sections.New.push(description)
    else if (type === 'fix') sections.Fixes.push(description)
    else if (type === 'perf' || type === 'refactor') sections.Improvements.push(description)
    // docs/test/chore/ci/build/style + unparseable subjects are internal — skip
  }
  const parts = []
  for (const [title, items] of Object.entries(sections)) {
    if (items.length === 0) continue
    parts.push(`### ${title}\n${items.map((item) => `- ${item}`).join('\n')}`)
  }
  return parts.length > 0 ? parts.join('\n\n') : 'Maintenance release — internal changes only.'
}

// --- LLM writer with fallback -----------------------------------------------
let notes = null
if (!noLlm) {
  const prompt = [
    `Write concise, user-facing release notes in GitHub markdown for Flow v${version} — a macOS desktop IDE for AI-assisted development.`,
    `Group into "### New", "### Improvements", "### Fixes" (omit empty sections).`,
    `Merge related commits into single bullets; drop internal-only changes (tests, chores, CI, refactors with no user impact).`,
    `Plain language, no jargon from the commit subjects, no version heading (GitHub shows it), no preamble or sign-off — output ONLY the markdown notes.`,
    ...(hint !== '' ? [``, `Additional guidance from the release manager: ${hint}`] : []),
    ``,
    `Commit subjects since the last release:`,
    ...subjects.map((s) => `- ${s}`),
  ].join('\n')
  const result = spawnSync('claude', ['-p', prompt], { encoding: 'utf8', timeout: 120_000, cwd: repoDir })
  if (result.status === 0 && result.stdout.trim().length > 0) {
    notes = result.stdout.trim()
    console.error('release-notes: written by claude CLI')
  } else {
    console.error('release-notes: claude CLI unavailable or failed — using deterministic grouping')
  }
}
if (notes === null) notes = deterministicNotes()

console.log(notes)
