/**
 * The ENTRIES AND EXITS half of the feature-view prompt (plan
 * `diagram-entry-exit` phase 2).
 *
 * A pure module with no imports, so the app's `buildFeatureViewPrompt`
 * (`app/src/main/agent/feature-view-session.ts`) and the CLI's validator share
 * ONE statement of the rules — the cap the prompt asks for is the cap
 * `validateFeatureView` refuses past (allowed-pattern #14). Same precedent as
 * `understood.ts`, which the app re-exports through `app/src/shared/`.
 */

/** Longest "what crosses" a port may carry — it is drawn beside the port, like an edge label. */
export const VIEW_PORT_CROSSES_MAX = 40;

/**
 * The prompt lines asking the pass for each level's entries and exits, in the
 * prompt's own voice. Spliced in after the RULES block; the JSON example's
 * level carries `PORTS_EXAMPLE_LINE`.
 */
export function viewPortsPromptLines(): string[] {
  return [
    'ENTRIES AND EXITS — where this feature meets the rest of the system',
    'For each level, say what reaches it from OUTSIDE and what it reaches out to.',
    '- `ports.in` — the entries: who calls it, sends it something or reads from it,',
    '  and what they send ("chat request", "webhook event").',
    '- `ports.out` — the exits: what it calls, sends or writes outside itself',
    '  ("SSE tokens", "charge card").',
    '- Each port touches ONE component of that level: `node` is that component\'s id.',
    `- \`crosses\` says what crosses in a few words — at most ${String(VIEW_PORT_CROSSES_MAX)} characters.`,
    '- `far` names the other end only as finely as you READ it: `feature` (a slug',
    '  from this project), `file` and `symbol` (this project\'s code, repo-relative),',
    '  or `project` for another project. Leave out what you did not see.',
    '- NEVER invent a file or a function. A file you did not open, or a function',
    '  that file does not contain, is refused — and takes the whole view with it.',
    '- Omit `ports` on a level where you saw no entry or exit. None is an honest answer.',
    '',
  ];
}

/** The `ports` line of the prompt's JSON example, indented for a level. */
export const PORTS_EXAMPLE_LINE =
  '      "ports": { "in": [ { "crosses": "chat request", "node": "bff", "far": { "feature": "<slug>", "file": "<repo-relative>", "symbol": "<function>" } } ], "out": [ { "crosses": "SSE tokens", "node": "bff", "far": { "project": "<other project>" } } ] },';
