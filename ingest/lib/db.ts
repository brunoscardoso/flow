/**
 * THE DATABASE SIDE OF THE ENDPOINT — the only file here that talks to Postgres.
 *
 * Kept apart from `api/events.ts` so the handler's decisions stay testable with
 * a fake, and so there is exactly one place where SQL is written.
 *
 * Every statement is a tagged template, which is how `@vercel/postgres`
 * parameterises: the values never become part of the SQL string, so an install
 * id is data whatever it contains.
 */

import { sql } from '@vercel/postgres'

import type { Db } from '../api/events.js'

export function createDb(): Db {
  return {
    async countInWindow(installId: string, windowStartMs: number): Promise<number> {
      const result = await sql<{ event_count: number }>`
        select event_count from ingest_counters
        where install_id = ${installId}
          and window_start = to_timestamp(${windowStartMs} / 1000.0)
      `
      return result.rows[0]?.event_count ?? 0
    },

    async record(
      installId: string | null,
      windowStartMs: number,
      events: unknown[],
    ): Promise<void> {
      for (const event of events) {
        const record = event as Record<string, unknown>
        const name = typeof record['event'] === 'string' ? record['event'] : null
        const id = typeof record['installId'] === 'string' ? record['installId'] : null
        await sql`
          insert into events (install_id, event_name, body)
          values (${id}, ${name}, ${JSON.stringify(record)}::jsonb)
        `
      }

      // COUNTED ONLY WHEN ATTRIBUTABLE. An unattributable batch is stored and
      // deliberately not counted — see ingest-core's `shouldCount`.
      if (installId === null) return
      await sql`
        insert into ingest_counters (install_id, window_start, event_count)
        values (${installId}, to_timestamp(${windowStartMs} / 1000.0), ${events.length})
        on conflict (install_id, window_start)
        do update set event_count = ingest_counters.event_count + ${events.length}
      `
    },
  }
}
