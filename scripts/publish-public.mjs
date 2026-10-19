/**
 * PUBLISH THE PRIVATE TREE TO THE PUBLIC REPOSITORY.
 *
 *   npm run publish:public            # gate, then publish
 *   npm run publish:public -- --dry   # gate and show what would go, write nothing
 *
 * Day to day, work lands on the private development repository. This is the
 * deliberate act that moves it to the PUBLIC one, run by a person who has
 * decided to publish — never on a schedule, and never from CI.
 *
 * ── WHY NOT FROM CI ────────────────────────────────────────────────────────
 *
 * The publish gate has two legs and the important one is `flow/publish-scan.py`,
 * which is UNTRACKED on purpose: its seed list names every string the scrub
 * removes, so committing it would publish exactly what the scrub exists to
 * delete. A runner clones tracked files only, so that leg would be absent — and
 * a gate running on half its legs is worse than no gate, because it reports
 * success. `npm run publish:scan` refuses when the family leg is missing, and
 * this script treats that refusal as fatal rather than routing around it.
 *
 * ── WHAT IS PUBLISHED ──────────────────────────────────────────────────────
 *
 * The tracked tree, verbatim. Verified the day this was written: the public
 * repository's 2748 files were a strict subset of the private 2754, differing
 * only by files committed after it was cut. There is no content transformation
 * and none should be invented here — the scrub edits live in the private
 * repository, so the thing being published is already the thing that was
 * reviewed.
 *
 * `git archive` and never `cp -r`. The working tree holds `.env.local` and
 * `ingest/.env.local` with a VERCEL_OIDC_TOKEN in them; archive takes what git
 * tracks, so an untracked secret cannot ride along even by mistake.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 *
 * Force-push. The public history is append-only: each publish adds one commit
 * on top of what is there, so a bad publish is revertible rather than
 * rewritten, and anyone who cloned keeps a history that still makes sense.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/* The public repository is read from package.json's own `repository` field —
   the slug already lives there, and the publish gate reads that file's URLs as
   the project naming itself. Writing it out again would be a second place to
   keep in step AND a fresh literal for the gate to object to. */
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'))
const PUBLIC_SLUG = (PKG.repository?.url ?? '').replace(/^.*github\.com[/:]/, '').replace(/\.git$/, '')
if (!/^[\w.-]+\/[\w.-]+$/.test(PUBLIC_SLUG)) {
  console.error("publish refused: package.json's repository.url does not name a github owner/repo")
  process.exit(1)
}
const PUBLIC_REMOTE = `https://github.com/${PUBLIC_SLUG}.git`
const DRY = process.argv.includes('--dry')

/** Every refusal reads the same way, and every one of them exits 1. */
function refuse(reason, ...lines) {
  console.error(`publish refused: ${reason}`)
  for (const line of lines) console.error(`  ${line}`)
  process.exit(1)
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function tryGit(args, cwd = ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  return result.status === 0 ? { ok: true, out: result.stdout.trim() } : { ok: false, detail: `${result.stdout}${result.stderr}` }
}

function step(name) {
  console.log(`\n── ${name}`)
}

// ─── 1. Preflight ───────────────────────────────────────────────────────────
//
// Publishing something other than what is on the private main is how a public
// repository comes to hold a commit nobody can find the source of.

step('Preflight')

const branch = git(['branch', '--show-current'])
if (branch !== 'main') refuse('not on main', `this publishes main; you are on '${branch}'`)

// MODIFIED TRACKED FILES ONLY. What gets published is `git archive HEAD`, so a
// modified tracked file would be silently left behind at its committed version
// — that is worth refusing over. An UNTRACKED file cannot be published at all,
// and refusing on one would make this unrunnable on any machine that keeps
// something beside the repo: this one permanently carries `.agents/skills/` and
// `skills-lock.json`, which must never be committed.
const dirty = git(['status', '--porcelain', '--untracked-files=no'])
if (dirty !== '') {
  refuse(
    'tracked files have uncommitted changes',
    'publish takes what is COMMITTED, so these would be left behind at their committed version:',
    ...dirty.split('\n').slice(0, 10).map((line) => `  ${line}`)
  )
}

// Said, not refused on: an untracked file might be something meant to ship.
const untracked = git(['ls-files', '--others', '--exclude-standard'])
if (untracked !== '') {
  const list = untracked.split('\n')
  console.log(`  note: ${list.length} untracked path(s) will NOT be published — ${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''}`)
}

const fetched = tryGit(['fetch', '-q', 'origin', 'main'])
if (!fetched.ok) refuse('could not reach the private remote', fetched.detail.trim().split('\n')[0] ?? '')

const ahead = git(['rev-list', '--count', 'origin/main..HEAD'])
const behind = git(['rev-list', '--count', 'HEAD..origin/main'])
if (ahead !== '0') refuse('this machine has commits the private remote does not', `push them first (${ahead} ahead)`)
if (behind !== '0') refuse('the private remote has commits this machine does not', `pull them first (${behind} behind)`)

const head = git(['rev-parse', 'HEAD'])
console.log(`  private main  ${head.slice(0, 7)}  in step with origin`)

// ─── 2. The gate ────────────────────────────────────────────────────────────
//
// Both legs, and a missing leg is a refusal rather than a warning.

step('Publish gate')

if (!existsSync(join(ROOT, 'flow', 'publish-scan.py'))) {
  refuse(
    'the publish gate is not complete on this machine',
    'flow/publish-scan.py is untracked by design — its seed list names what the scrub removes,',
    'so it exists only where the scrub was done. Without it the scan runs on one leg,',
    'and a gate that reports success on half its checks is the failure this guards against.'
  )
}

const scan = spawnSync('npm', ['run', '--silent', 'publish:scan'], { cwd: ROOT, encoding: 'utf-8' })
const scanOut = `${scan.stdout ?? ''}${scan.stderr ?? ''}`.trim()
if (scan.status !== 0) {
  refuse('the publish scan found something', ...scanOut.split('\n').slice(-20))
}
console.log(`  publish:scan  clean`)

// ─── 3. Quality ─────────────────────────────────────────────────────────────
//
// A public tree that does not typecheck is a worse advertisement than a stale
// one. Skippable, because a person who has just run the suite should not have
// to run it twice — but skipped ON PURPOSE and said out loud.

step('Typecheck')
if (process.argv.includes('--skip-checks')) {
  console.log('  skipped (--skip-checks)')
} else {
  const checks = [
    ['CLI', ['npx', ['tsc', '--noEmit', '-p', 'tsconfig.json'], ROOT]],
    ['app', ['npm', ['run', '--silent', 'typecheck'], join(ROOT, 'app')]],
  ]
  for (const [label, [cmd, args, cwd]] of checks) {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf-8' })
    if (result.status !== 0) {
      refuse(`${label} does not typecheck`, ...`${result.stdout}${result.stderr}`.trim().split('\n').slice(0, 15))
    }
    console.log(`  ${label}  clean`)
  }
}

// ─── 4. The tree ────────────────────────────────────────────────────────────

step('Building the tree to publish')

const staging = mkdtempSync(join(tmpdir(), 'flow-publish-'))
const clone = join(staging, 'public')
const treeDir = join(staging, 'tree')

try {
  // TRACKED CONTENT, NOT THE FOLDER. `.env.local` and `ingest/.env.local` hold
  // a VERCEL_OIDC_TOKEN; archive cannot carry an untracked file even by
  // accident, and `cp -r` would carry both.
  execFileSync('mkdir', ['-p', treeDir])
  execFileSync('sh', ['-c', `git -C '${ROOT}' archive --format=tar HEAD | tar -x -C '${treeDir}'`])
  const fileCount = execFileSync('sh', ['-c', `find '${treeDir}' -type f | wc -l`], { encoding: 'utf-8' }).trim()
  console.log(`  archived  ${fileCount} tracked files from ${head.slice(0, 7)}`)

  const cloned = tryGit(['clone', '-q', '--depth', '1', PUBLIC_REMOTE, clone])
  if (!cloned.ok) refuse('could not clone the public repository', cloned.detail.trim().split('\n')[0] ?? '')
  const publicHead = git(['rev-parse', 'HEAD'], clone)
  console.log(`  public main   ${publicHead.slice(0, 7)}`)

  // Replace the contents wholesale: anything the private tree no longer has
  // must leave the public one too, or a deleted file lives on for ever.
  execFileSync('sh', ['-c', `cd '${clone}' && git rm -rq --ignore-unmatch . && cp -R '${treeDir}/.' .`])

  const status = git(['status', '--porcelain'], clone)
  if (status === '') {
    console.log('\npublish: nothing to do — the public tree already matches this commit.')
    process.exit(0)
  }

  const changed = status.split('\n')
  const summary = { added: 0, modified: 0, removed: 0 }
  for (const line of changed) {
    const code = line.slice(0, 2).trim()
    if (code.startsWith('A') || code === '??') summary.added += 1
    else if (code.startsWith('D')) summary.removed += 1
    else summary.modified += 1
  }
  console.log(`  changes       ${summary.added} added · ${summary.modified} modified · ${summary.removed} removed`)

  if (DRY) {
    console.log('\n--dry: nothing was pushed. The first 25 changed paths:')
    for (const line of changed.slice(0, 25)) console.log(`  ${line}`)
    if (changed.length > 25) console.log(`  … and ${changed.length - 25} more`)
    process.exit(0)
  }

  // ─── 5. Publish ───────────────────────────────────────────────────────────

  step('Publishing')

  // The SAME identity the public history already carries, read off it rather
  // than written here, so this script cannot introduce a second author.
  const author = git(['log', '-1', '--format=%an <%ae>'], clone)
  const version = JSON.parse(readFileSync(join(ROOT, 'app', 'package.json'), 'utf-8')).version
  const message = [
    `Flow ${version}`,
    '',
    'Published from the private development repository, after the publish gate.',
    `Source commit: ${head.slice(0, 12)}`,
  ].join('\n')

  git(['add', '-A'], clone)
  execFileSync(
    'git',
    ['-c', `user.name=${author.split(' <')[0]}`, '-c', `user.email=${author.match(/<(.+)>/)?.[1] ?? ''}`, 'commit', '-q', '-m', message],
    { cwd: clone }
  )

  // NEVER --force. The public history is append-only; a rejected push means
  // somebody else published, and the answer is to look, not to overwrite.
  const pushed = tryGit(['push', 'origin', 'HEAD:main'], clone)
  if (!pushed.ok) {
    refuse(
      'the push to the public repository was rejected',
      'nothing was force-pushed and nothing was lost. Someone else may have published since this started.',
      ...pushed.detail.trim().split('\n').slice(0, 6)
    )
  }

  const newHead = git(['rev-parse', 'HEAD'], clone)
  console.log(`  pushed        ${publicHead.slice(0, 7)} → ${newHead.slice(0, 7)}  to ${PUBLIC_SLUG}`)
  console.log(`\npublished: https://github.com/${PUBLIC_SLUG}/commit/${newHead}`)
  console.log('\nTo cut a release from this, run `npm run ship -w app`.')
} finally {
  rmSync(staging, { recursive: true, force: true })
}
