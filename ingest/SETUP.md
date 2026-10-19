# Running it

What is configured, and what a person has to do to build a Flow that signs in.

## Deployed

`https://flow-telemetry-ingest.vercel.app` — region `iad1`, co-located with the
Neon database (`us-east-1`). Four tables: `events`, `ingest_counters`,
`identities`, `auth_states`.

| Env var | What it is |
|---|---|
| `POSTGRES_URL` | Set by the Neon integration |
| `INGEST_KEY` | Write-only telemetry key; also compiled into the app |
| `SESSION_SECRET` | Signs Flow's own session tokens. Server only |
| `GITHUB_CLIENT_ID` | Public — appears in every authorization URL |
| `GITHUB_CLIENT_SECRET` | **Server only.** Never ships in the app |
| `FLOW_DEPLOY_GITHUB_TOKEN` | Deploy-time only. Fine-grained GitHub token, this repo, **Contents: read**. Lets the build check skip pushes that change nothing here |

### Which pushes deploy

The Ignored Build Step is `node scripts/should-build.mjs`. It asks GitHub's
compare API which files changed since the last successful deployment and skips
the build unless something under `ingest/` (or the root `.vercelignore`) did.
It **fails open**: no token, a GitHub error, a force-push or a huge diff all
build. It cannot use `git diff` — the root `.vercelignore` strips `.git` from the
build before the step runs, which is what broke every deploy until 2026-09-30.

The GitHub OAuth App's callback must be
`https://flow-telemetry-ingest.vercel.app/api/auth/callback`. If that ever stops
matching, sign-in fails *after* the person has authorized — the worst moment.

## Building a Flow that signs in and reports

Nothing to export. The build-time values live in two files, read by every build
through `app/scripts/build-config.mjs`:

| File | Holds | In git? |
|---|---|---|
| `app/build-config.json` | `FLOW_TELEMETRY_ENDPOINT`, `FLOW_AUTH_ENDPOINT`, `FLOW_GITHUB_CLIENT_ID`, `FLOW_SHARE_ENDPOINT` — all public | committed |
| `app/.flow-build.local.json` | `{ "FLOW_TELEMETRY_KEY": "<the ingest key>" }` | git-ignored; create it once per machine that builds releases |

`npm run release` and `npm run install:local` read both, refuse to build when a
value is missing, check that every value landed in the bundle, and rebuild
`app/out` without the key afterwards. Every other build (dev, e2e) gets the
public values and no key, so it signs in and shares but sends no telemetry.
A non-empty environment variable still overrides either file for a one-off build.

**`app/out` is NOT tracked by git** (since 2026-10-14; it is build output, and
the committed copy had drifted from every build that existed). Only `release`
and `install:local` ever compile the key in, and both scrub it out of `app/out`
when they finish, so it does not linger on disk. If a build is interrupted,
`npm run build` on its own removes it again;
`grep -c '<the key>' app/out/main/index.js` should answer 0.

The client SECRET is never one of these. It lives only in Vercel, and the app
refuses at startup to use a 40-hex string as a client id
(`flow-provider.ts`) — the one mistake that would matter.

## What an unconfigured build does

Nothing. No endpoint compiles to the empty string, `configuredEndpoint()` and
`configuredProvider()` both report "nowhere", no telemetry is sent and no
sign-in is offered. That is what every build from a clone does.

## Releasing

`npm run release` REFUSES without the four build-time values, and says why. This
is the one failure in this area that is silent: an unset variable compiles to
the empty string, so a release built without them installs, runs, looks perfect
and reports nothing. Nobody finds out by using it — you find out weeks later
looking at an empty dashboard.

It also refuses if a SERVER secret is present in the shell
(`GITHUB_CLIENT_SECRET`, `SESSION_SECRET`, `POSTGRES_URL`), or if the 40-hex
client secret has been pasted where the public client id belongs.

After the build it checks the values are actually IN `out/main/index.js` rather
than trusting that the environment was set — because the way this has already
failed once is that the variables were set, the build ran, and the code reading
them was tree-shaken out.

A release that deliberately should not report — a fork, a private build — says
so out loud:

```
FLOW_RELEASE_WITHOUT_TELEMETRY=1 npm run release
```
