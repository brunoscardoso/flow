/**
 * THE DATABASE SIDE OF SIGN-IN — the only file here that writes identities.
 *
 * Apart from `lib/db.ts` for events, this is the one place SQL is written for
 * auth. Every statement is a tagged template, which is how `@vercel/postgres`
 * parameterises: a subject is data whatever it contains.
 */

import { sql } from '@vercel/postgres'

export interface AuthDb {
  /** Record an authorization this server started. */
  rememberState(state: string, redirectUri: string): Promise<void>
  /** What we know about a state, or null when we never issued it. */
  readState(state: string): Promise<{ createdAt: number; usedAt: number | null } | null>
  /** Retire a state so a second callback with the same one is refused. */
  retireState(state: string): Promise<void>
  /** The loopback this authorization started from, so the browser can go back. */
  readRedirect(state: string): Promise<string | null>
  /** Park the issued session against the state until the app collects it. */
  parkSession(
    state: string,
    session: { token: string; subject: string; displayName: string | null; expiresAt: number },
  ): Promise<void>
  /** Everything the app needs to collect, plus the two gates. */
  readClaim(state: string): Promise<{
    createdAt: number
    usedAt: number | null
    claimedAt: number | null
    token: string | null
    subject: string | null
    displayName: string | null
    expiresAt: number | null
  } | null>
  /** Mark it collected, so a second claim is a replay. */
  markClaimed(state: string): Promise<void>
  /** Record who signed in. Returning people update their name and last seen. */
  rememberIdentity(subject: string, provider: string, displayName: string | null): Promise<void>
}

export function createAuthDb(): AuthDb {
  return {
    async rememberState(state, redirectUri) {
      await sql`insert into auth_states (state, redirect_uri) values (${state}, ${redirectUri})`
    },

    async readState(state) {
      const result = await sql<{ created_at: string; used_at: string | null }>`
        select created_at, used_at from auth_states where state = ${state}
      `
      const row = result.rows[0]
      if (row === undefined) return null
      return {
        createdAt: new Date(row.created_at).getTime(),
        usedAt: row.used_at === null ? null : new Date(row.used_at).getTime(),
      }
    },

    async retireState(state) {
      // CONDITIONAL ON STILL BEING UNUSED, so two callbacks racing with the same
      // state cannot both find it unredeemed and both proceed. The read above
      // is the ordinary path; this is what makes it safe under a race.
      await sql`update auth_states set used_at = now() where state = ${state} and used_at is null`
    },

    async readRedirect(state) {
      const result = await sql<{ redirect_uri: string }>`
        select redirect_uri from auth_states where state = ${state}
      `
      return result.rows[0]?.redirect_uri ?? null
    },

    async parkSession(state, session) {
      await sql`
        update auth_states
           set session_token = ${session.token},
               subject       = ${session.subject},
               display_name  = ${session.displayName},
               expires_at    = ${session.expiresAt}
         where state = ${state}
      `
    },

    async readClaim(state) {
      const result = await sql<{
        created_at: string
        used_at: string | null
        claimed_at: string | null
        session_token: string | null
        subject: string | null
        display_name: string | null
        expires_at: string | null
      }>`
        select created_at, used_at, claimed_at, session_token, subject, display_name, expires_at
          from auth_states where state = ${state}
      `
      const row = result.rows[0]
      if (row === undefined) return null
      return {
        createdAt: new Date(row.created_at).getTime(),
        usedAt: row.used_at === null ? null : new Date(row.used_at).getTime(),
        claimedAt: row.claimed_at === null ? null : new Date(row.claimed_at).getTime(),
        token: row.session_token,
        subject: row.subject,
        displayName: row.display_name,
        expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      }
    },

    async markClaimed(state) {
      // CONDITIONAL, so two claims racing cannot both collect.
      await sql`update auth_states set claimed_at = now() where state = ${state} and claimed_at is null`
    },

    async rememberIdentity(subject, provider, displayName) {
      await sql`
        insert into identities (subject, provider, display_name)
        values (${subject}, ${provider}, ${displayName})
        on conflict (subject) do update
          set display_name = excluded.display_name, last_seen_at = now()
      `
    },
  }
}
