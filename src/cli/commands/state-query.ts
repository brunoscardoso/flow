/**
 * State Query CLI command
 *
 * Searches the project's markdown knowledge and outputs matching results as
 * JSON. The `{ results: [...] }` shape is parsed by every `.claude/commands/**`
 * skill that calls it, and is unchanged by the index's retirement.
 */

import { queryProjectBrain, QUERY_SCOPES } from '../state/brain-query.js';
import type { QueryOptions, QueryScope } from '../state/brain-query.js';

/**
 * The scope asked for, or a refusal naming the ones that exist.
 *
 * A CAST IS NOT A CHECK. This was `options.scope as QueryOptions['scope']` — a
 * compile-time assertion over a string a person typed, so any value reached the
 * search, matched no scope branch, and fell through to unfiltered. An
 * unrecognized scope behaved exactly like `--scope all`.
 *
 * That is the worst shape a failure can take here, because the caller still
 * gets results and they look right — they are simply drawn from the whole
 * corpus instead of the one that was asked for. `--scope resource`, one letter
 * short, silently swapped the reference docs for every plan, brainstorm and
 * brain file in the repo (#1801). This is the project's OWN context-loading
 * call: CLAUDE.md and the loop commands both invoke `--scope resources` by
 * name, so the slip lands in agent context, where wrong-corpus material is
 * indistinguishable from correct material.
 *
 * Silently widening a filter the caller explicitly narrowed is the one
 * behaviour that cannot be right. The sibling flags already agree —
 * `brain search --scope` and `loop list --state` both refuse and name their
 * valid values; this flag was the outlier, not a missing capability.
 */
function parseScope(raw: string | undefined): QueryScope {
  const scope = raw ?? 'all';
  if (!(QUERY_SCOPES as string[]).includes(scope)) {
    throw new Error(`unknown scope "${scope}" — expected ${QUERY_SCOPES.join('|')}`);
  }
  return scope as QueryScope;
}

export async function runStateQuery(options: {
  query: string;
  scope?: string;
  type?: string;
  limit?: number;
  target: string;
}): Promise<void> {
  try {
    const queryOpts: QueryOptions = {
      scope: parseScope(options.scope),
      // `--type` IS LEFT AS IT IS, deliberately, and it is not the same defect.
      // Its help says "Filter by chunk type" rather than naming a set, and the
      // corpus produces exactly one value (`markdown`) — so an unrecognized
      // type returns ZERO results, which is visibly empty. Unknown-is-empty is
      // the honest failure; unknown-is-everything was not.
      type: options.type,
      limit: options.limit ?? 10,
    };

    const results = queryProjectBrain(options.target, options.query, queryOpts);

    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n');
    process.exitCode = 1;
  }
}
