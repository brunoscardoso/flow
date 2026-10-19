// Vercel "Ignored Build Step" for the ingest project: build only when something
// that ships in the deployment changed.
//
// WHY IT ASKS GITHUB INSTEAD OF GIT. The repo's root .vercelignore starts with
// `*`, and Vercel applies it to git-triggered builds before this step runs, so
// there is no .git to diff against. The previous step (`git diff --quiet HEAD^
// HEAD -- ingest/`) therefore failed with "Not a git repository" and every
// deployment errored for six days (fixed 2026-09-30). This asks GitHub's compare
// API which files changed since the last successful deployment instead.
//
// FAIL OPEN. Vercel reads the exit code: 0 skips the build, 1 builds. A skip is
// only allowed when GitHub positively says nothing relevant changed. No token,
// no previous deployment, a network error, a history rewrite, a comparison too
// large to list — every one of those builds. A needless build costs ~15 s; a
// wrongly skipped one ships stale code to production.
//
// Configure: Vercel project → Settings → Git → Ignored Build Step:
//   node scripts/should-build.mjs
// with FLOW_DEPLOY_GITHUB_TOKEN set (fine-grained, this repo, Contents: read).

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Paths whose change must deploy: everything the project builds, plus the
 *  file that decides what gets uploaded at all. */
export const DEPLOY_PATHS = ['ingest/', '.vercelignore']

/** GitHub lists at most this many files in one compare response; a response
 *  at the cap may be truncated, so it cannot prove "nothing relevant". */
export const COMPARE_FILE_CAP = 300

const TIMEOUT_MS = 10_000

/** Does this changed path ship in the deployment? */
export function affectsDeploy(path) {
  return DEPLOY_PATHS.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix))
}

/**
 * The decision, from what Vercel and GitHub said. Pure: every input is passed
 * in, so each fail-open path is testable without a network.
 *
 * @param {{ previousSha?: string, commitSha?: string, token?: string }} env
 * @param {{ ok: boolean, status?: string, files?: Array<{ filename: string, previous_filename?: string }>, error?: string } | null} compare
 * @returns {{ build: boolean, reason: string }}
 */
export function decide(env, compare) {
  if (!env.commitSha) return { build: true, reason: 'no commit SHA from Vercel' }
  if (!env.previousSha) return { build: true, reason: 'no previous successful deployment on this branch' }
  if (env.previousSha === env.commitSha) return { build: true, reason: 'redeploy of the same commit' }
  if (!env.token) return { build: true, reason: 'FLOW_DEPLOY_GITHUB_TOKEN is not set, so changes cannot be checked' }
  if (compare === null || !compare.ok) {
    return { build: true, reason: `GitHub compare failed${compare?.error ? `: ${compare.error}` : ''}` }
  }
  // "ahead" is the only shape where the file list is exactly "what this push
  // added". Behind or diverged means history moved (rollback, force-push).
  if (compare.status !== 'ahead') return { build: true, reason: `history is ${compare.status ?? 'unknown'}, not ahead` }
  const files = compare.files ?? []
  if (files.length >= COMPARE_FILE_CAP) return { build: true, reason: `${files.length} files changed — list may be truncated` }
  const hit = files.find((file) => affectsDeploy(file.filename) || (file.previous_filename && affectsDeploy(file.previous_filename)))
  if (hit) return { build: true, reason: `${hit.filename} changed` }
  return { build: false, reason: `${files.length} file(s) changed, none under ${DEPLOY_PATHS.join(' or ')}` }
}

/** Ask GitHub which files changed between two commits. Never throws. */
export async function fetchCompare({ owner, repo, base, head, token, fetchFn = fetch }) {
  try {
    const response = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'flow-telemetry-ingest-deploy-check',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
    const body = await response.json()
    return { ok: true, status: body.status, files: body.files }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  const env = {
    previousSha: process.env.VERCEL_GIT_PREVIOUS_SHA,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA,
    token: process.env.FLOW_DEPLOY_GITHUB_TOKEN,
  }
  const owner = process.env.VERCEL_GIT_REPO_OWNER
  const repo = process.env.VERCEL_GIT_REPO_SLUG
  let compare = null
  if (env.previousSha && env.commitSha && env.previousSha !== env.commitSha && env.token && owner && repo) {
    compare = await fetchCompare({ owner, repo, base: env.previousSha, head: env.commitSha, token: env.token })
  }
  const verdict = decide(env, compare)
  console.log(`${verdict.build ? 'Building' : 'Skipping build'}: ${verdict.reason}`)
  process.exit(verdict.build ? 1 : 0)
}

// Only a direct `node scripts/should-build.mjs` decides; importing (tests) doesn't.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
