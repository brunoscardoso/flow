# Telemetry ingest

The endpoint the Flow desktop app posts install facts and usage events to.
Separate deployable: point a Vercel project's **root directory** at this folder.

Nothing is deployed yet, and until it is, **no build of Flow sends anything** —
`FLOW_TELEMETRY_ENDPOINT` is unset, so the client compiles the empty string in
and drops every event at the point of sending.

## The one decision to make before the first real event arrives

**`vercel.json` pins the region to `iad1` (Washington, US East).**

DECIDED 2026-09-22: the users are in the United States. It also happens to be
where the Neon database landed — `us-east-1` — so the function and its database
are in the same region and a query does not cross an ocean to reach its own
store.

THE TWO REGIONS MUST AGREE. The function's region is this file; the database's
is fixed when the Neon store is created. They were briefly different here (a
`gru1` function against a `us-east-1` database) and nothing complains about it —
it just makes every query slow, which is the kind of thing nobody notices until
there is enough traffic to feel it.

If that ever needs revisiting, moving a region once rows exist means moving the
rows:

| If your clients are… | Region | Why |
|---|---|---|
| Brazil / LATAM | `gru1` | Lowest latency, and the answer to "where does our data live" is local |
| United States | `iad1` | Vercel's default; closest to most US traffic |
| Europe | `fra1` or `arn1` | Keeps personal data in the EU, which is the question a European company will ask first |

The client sends install facts and — once sign-in exists — an identity id, so
"where does the data live" is a question a customer is entitled to ask. Pick the
answer you want to give before you have to give it.

## Setting it up

1. Create the Vercel project with this directory as its root.
2. Add a Marketplace Postgres store (Neon) and connect it to the project.
3. Run `schema.sql` against it once.
4. Generate a **write-only ingest key** — a random opaque string — and set it as
   `INGEST_KEY` on the project.
5. Build Flow with the same values:

   ```
   FLOW_TELEMETRY_ENDPOINT=https://<project>.vercel.app/api/events \
   FLOW_TELEMETRY_KEY=<the same key> \
   npm run build
   ```

### The key is public, and that is the design

Whatever key is built into Flow is readable by anyone who unzips the app. There
is no way around that for a desktop binary, so the key must be one that can only
write. The client refuses at startup to use a key shaped like a database URL, a
service-role key or a personal access token (`telemetry-endpoint.ts`), and this
endpoint has no read path at all — no GET, no selecting parameter, and an empty
response body.

**Never put the Postgres connection string in `FLOW_TELEMETRY_KEY`.** It is the
mistake this whole arrangement exists to make impossible, and the client will
refuse to start telemetry if you do.

## What it accepts

`POST /api/events` with `Authorization: Bearer <INGEST_KEY>` and a body of
`{"events": [...]}`.

Every bound is enforced server-side rather than trusted from the client
(`lib/ingest-core.ts`): 100 events per request, 256 KB per body, 8 KB per event,
40 fields per event, 512 characters per value, scalars only. Unknown fields are
**kept** — a shipped binary keeps posting the shape it was built with for
months, and no migration reaches a copy installed in March.

Rate limited to 500 events per installation per hour. A batch whose events name
two different installations is stored but not counted: refusing it would reject
a legitimate first batch, and counting it under one bucket would let anonymous
posters exhaust each other's budget. That is a stated acceptance, not an
oversight — it is still bounded by the per-request limits above.

## Questions it can answer

`schema.sql` ends with worked examples — installs per version, median session
length by platform, which installs belong to a signed-in person. The event body
is stored as `jsonb` and projected in SQL, so a new question is a new query
rather than a migration.

## Removing a person's data

`lib/erase.ts`. A privacy notice that says "you can ask us to delete your data"
and has no operation behind it is a sentence, not a capability.

**The join runs backwards here, and that is what makes it more than one line.**
Events carry an `installId` always and an `identityId` only *after* somebody
signs in — and the whole point of the join is that the events an installation
sent *before* the sign-in belong to that person too. So deleting
`where identityId = X` leaves behind exactly the anonymous history the join
exists to claim for them.

Erasing a person is two steps, in order: find every installation that has ever
carried their identity, then delete everything those installations ever sent.

The second step is deliberately broader than the first, and it can over-delete —
a shared machine where two people signed into the same installation loses both
histories. That is the right way to be wrong. The alternative is telling
somebody their data is gone while their first month of it sits there under a
null identity.

**It cannot run by accident.** The confirmation is not a boolean — a boolean is
what a test passes by accident and what a refactor flips. The caller has to name
the same subject a second time, so an erase can neither be triggered by a truthy
variable nor land on a different subject from the one somebody typed.
