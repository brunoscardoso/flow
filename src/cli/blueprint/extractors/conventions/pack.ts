/**
 * Convention packs (#901) — pluggable framework-dialect extractors.
 *
 * The original extractors speak one dialect (express-style registrations,
 * commander CLI); modern meta-frameworks declare their API surface by FILE
 * CONVENTION (Next.js `route.ts`) or code-first schemas (Pothos GraphQL).
 * A convention pack contributes additional `ExtractorFragment`s for one such
 * dialect. Packs are ADDITIVE: they never modify or suppress what the base
 * extractors found, their nodes flow into the same module-attribution pass,
 * and each pack reports its own coverage notes (no-silent-caps rule).
 *
 * Adding a framework later (Remix, Nuxt, SvelteKit, tRPC…) means adding one
 * file here and one entry to `CONVENTION_PACKS` — nothing else changes.
 */

import type { ExtractorFragment, RepoScan } from '../scan.js';
import { extractNextJsEndpoints } from './nextjs.js';
import { extractGraphqlOperations } from './graphql.js';
import { extractFastapiEndpoints } from './fastapi.js';

export interface ConventionPack {
  /** Pack name — appears in coverage notes. */
  name: string;
  /**
   * Run the pack against a repo root. Must be deterministic and fail-soft.
   * `repoScan` (optional) reuses a pre-computed `walkRepo` result — the
   * derive pipeline walks ONCE; omitted, the pack walks itself.
   */
  extract: (repoRoot: string, repoScan?: RepoScan) => ExtractorFragment;
}

/** The packs shipped today, in run order. */
export const CONVENTION_PACKS: ConventionPack[] = [
  { name: 'nextjs', extract: extractNextJsEndpoints },
  { name: 'graphql', extract: extractGraphqlOperations },
  { name: 'fastapi', extract: extractFastapiEndpoints },
];
