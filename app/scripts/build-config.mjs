/**
 * THE BUILD'S CONFIGURATION, IN ONE PLACE.
 *
 * Every value Flow compiles in at build time — where telemetry goes, where
 * sign-in starts, GitHub's client id, where sharing publishes — used to come
 * from whatever the shell happened to export. `release` checked four of them
 * and refused without them; `install:local`, which is meant to build exactly
 * what a release ships, checked nothing and quietly produced an app with
 * sign-in and sharing switched off.
 *
 * Now there are two files and one reader:
 *
 *   app/build-config.json       COMMITTED. Public values only — endpoints and
 *                               the GitHub client ID, which every authorization
 *                               URL a browser sees already carries.
 *   app/.flow-build.local.json  GIT-IGNORED, one per machine. The telemetry
 *                               ingest key. It is compiled into every shipped
 *                               app (it is write-only by design), but it must
 *                               never sit in a tracked file — see the scrub at
 *                               the end of release.mjs.
 *
 * A non-empty environment variable overrides either file, for a one-off build.
 * `electron.vite.config.ts` reads the committed public values for EVERY build
 * (so dev has sign-in and sharing too); only `release` and `install:local` add
 * the key, and both rebuild app/out without it afterwards.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Public, committed. */
export const PUBLIC_BUILD_KEYS = [
  ['FLOW_TELEMETRY_ENDPOINT', 'where usage events are sent'],
  ['FLOW_AUTH_ENDPOINT', 'where sign-in starts'],
  ['FLOW_GITHUB_CLIENT_ID', "GitHub's public client id"],
  ['FLOW_SHARE_ENDPOINT', 'where feature views are shared'],
]

/** Per machine, never committed. */
export const SECRET_BUILD_KEYS = [['FLOW_TELEMETRY_KEY', 'the write-only ingest key']]

export const ALL_BUILD_KEYS = [...PUBLIC_BUILD_KEYS, ...SECRET_BUILD_KEYS]

export const PUBLIC_CONFIG_FILE = 'build-config.json'
export const LOCAL_SECRETS_FILE = '.flow-build.local.json'

function readJson(path) {
  if (!existsSync(path)) return {}
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must hold a JSON object`)
  }
  return parsed
}

function pick(keys, ...sources) {
  const out = {}
  for (const [name] of keys) {
    for (const source of sources) {
      const value = typeof source[name] === 'string' ? source[name].trim() : ''
      if (value !== '') {
        out[name] = value
        break
      }
    }
    if (out[name] === undefined) out[name] = ''
  }
  return out
}

/** Where `release` publishes, when this machine says. Never committed. */
export const RELEASE_TARGET_KEYS = [
  ['FLOW_RELEASE_OWNER', 'the GitHub account holding the release feed'],
  ['FLOW_RELEASE_REPO', 'the repo in that account whose releases are the feed'],
]

/**
 * The public values only: what every build — dev included — compiles in.
 *
 * THREE sources now, in order: the environment, this machine's local file, then
 * the committed one. The committed file is BLANK in the published tree, and
 * that is deliberate: a clone must not inherit the original author's sign-in,
 * sharing or telemetry target. `configuredProvider` and `configuredEndpoint`
 * already treat an absent value as the ordinary case and switch the feature
 * off, which is exactly what a build from a clone should do.
 *
 * The real values live in `.flow-build.local.json`, which is git-ignored, so
 * blanking the committed file changes nothing about this machine's builds.
 */
export function publicBuildConfig(appDir, env = process.env) {
  return pick(
    PUBLIC_BUILD_KEYS,
    env,
    readJson(join(appDir, LOCAL_SECRETS_FILE)),
    readJson(join(appDir, PUBLIC_CONFIG_FILE)),
  )
}

/**
 * The release target this machine publishes to, or nulls.
 *
 * `electron-builder.yml` carries a placeholder owner in the published tree, so
 * a fork that builds the app gets an update feed that does not resolve. That is
 * the right answer: a fork must not auto-update itself into this project's
 * official builds. The real target comes from the git-ignored local file and is
 * passed to electron-builder on the command line.
 */
export function releaseTarget(appDir, env = process.env) {
  const values = pick(RELEASE_TARGET_KEYS, env, readJson(join(appDir, LOCAL_SECRETS_FILE)))
  return {
    owner: values.FLOW_RELEASE_OWNER === '' ? null : values.FLOW_RELEASE_OWNER,
    repo: values.FLOW_RELEASE_REPO === '' ? null : values.FLOW_RELEASE_REPO,
  }
}

/**
 * The release target, or a refusal sentence — the ONE resolution both
 * `release` and `ship` use.
 *
 * THE PLACEHOLDER IN THE YML IS NOT A FALLBACK. An earlier version of this
 * read `electron-builder.yml` as a last resort, which quietly made the refusal
 * below unreachable: the committed file always parses, so `owner` was never
 * empty and a machine with no local file would have published to the
 * placeholder instead of stopping. The yml's publish block exists only to give
 * electron-builder a valid provider shape; every real value arrives on the
 * command line.
 *
 * Two scripts asking the same question two ways is how they come to disagree,
 * so neither parses anything itself.
 */
export function resolveReleaseTarget(appDir, env = process.env) {
  const { owner, repo } = releaseTarget(appDir, env)
  if (owner === null || repo === null) {
    const absent = RELEASE_TARGET_KEYS.filter(
      ([name]) => (name === 'FLOW_RELEASE_OWNER' ? owner : repo) === null,
    ).map(([name]) => name)
    return {
      owner: null,
      repo: null,
      slug: null,
      refusal:
        `no release target: set ${absent.join(' and ')} in app/${LOCAL_SECRETS_FILE}\n` +
        '  (electron-builder.yml carries a placeholder on purpose and is never used as the target)',
    }
  }
  return { owner, repo, slug: `${owner}/${repo}`, refusal: null }
}

/**
 * Everything a distributable build (release, install:local) compiles in, and
 * which values are missing. Environment first, then the local secrets file,
 * then the committed file.
 */
export function distributableBuildConfig(appDir, env = process.env) {
  const local = readJson(join(appDir, LOCAL_SECRETS_FILE))
  const values = {
    ...publicBuildConfig(appDir, env),
    ...pick(SECRET_BUILD_KEYS, env, local),
  }
  const missing = ALL_BUILD_KEYS.filter(([name]) => values[name] === '')
  const problems = []
  for (const name of ['FLOW_TELEMETRY_ENDPOINT', 'FLOW_AUTH_ENDPOINT', 'FLOW_SHARE_ENDPOINT']) {
    if (values[name] !== '' && !values[name].startsWith('https://')) problems.push(`${name} must be https://`)
  }
  if (/^[0-9a-f]{40}$/i.test(values.FLOW_GITHUB_CLIENT_ID)) {
    problems.push('FLOW_GITHUB_CLIENT_ID looks like a GitHub client SECRET (40 hex) — use the client ID, which is public')
  }
  return { values, missing, problems }
}
