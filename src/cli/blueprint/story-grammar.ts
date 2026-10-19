/**
 * Parser for the `## Story` section grammar in plan/discovery docs.
 *
 * GRAMMAR
 * =======
 * A doc opts in by containing a `## Story` section (everything from the
 * `## Story` heading to the next level-2 heading or EOF). Inside it, each
 * narrated step is a block opened by a step heading:
 *
 *   ### Step: <title>
 *
 * followed by optional `- key:` metadata lines and free markdown body:
 *
 *   - kicker: <short label above the title>
 *   - anchors: <comma list of anchor items — see ANCHOR ITEMS>
 *   - flow: <ordered comma list of graph/predicted node ids, incl. feature parts
 *            `feature:<slug>/<part>`>
 *   - flow_before: <ordered node ids — the pre-change path>
 *   - flow_after:  <ordered node ids — the post-change path>
 *   - phases: <comma list of plan phase numbers>
 *   - source: <free-text source reference>
 *   - unchanged: <what explicitly does NOT change — authored>
 *   - decisions: <inline comma list>  OR followed by indented `  - <text>` items
 *   - rejected:  (same shapes as decisions)
 *   - questions: (same shapes as decisions)
 *   - fails:     (same shapes as decisions — how it fails, user-side)
 *
 * CHIP LISTS AND COMMAS — the inline form SPLITS ON COMMAS, so prose written
 * inline shatters into fragments ("A fails, because B" becomes two chips).
 * Any entry that is a sentence must use the indented form:
 *
 *   - fails:
 *     - Authoritative-write with dual-write off loses the row, silently.
 *     - The engine read can fail, and the fallback hides it.
 *
 * This bites `fails:` hardest because failure modes are naturally prose. Found
 * while dogfooding the change brief on this repo's own plan (three entries
 * became eight chips).
 *
 * BEFORE / AFTER FLOWS
 *   `flow` is the ORIGINAL key and means the AFTER state; a doc authored
 *   before the change brief describes one world, and that world is what the
 *   plan leaves behind. `flow_after` is its explicit spelling, `flow_before`
 *   adds the pre-change path. The compile pass resolves them ASYMMETRICALLY:
 *   `flow_before` against the derived graph only (it is a claim about today,
 *   so a ghost id there is a lie), `flow_after` against graph + proposals.
 *   That asymmetry is what makes a REMOVAL derivable — a node in before and
 *   in no after is gone — which `simulation-model.ts` otherwise cannot know.
 *
 * Everything in a step block that is not a recognized `- key:` line (or an
 * indented item consumed by a chip-list key) is the step's free markdown
 * body, preserved verbatim (trimmed). Unrecognized `- foo:` lines are body —
 * they are ordinary markdown list items, not grammar.
 *
 * ANCHOR ITEMS — each comma-separated item is one of:
 *   - an explicit anchor envelope `<kind>:<ref>` with kind one of
 *     symbol | file | table | endpoint | module (the `Anchor` kinds), or
 *   - a bare graph/predicted node id whose kind prefix maps onto an anchor
 *     kind, validated against the extractor id grammar
 *     (`isValidPredictedNodeId`):
 *       integration:<name>   → symbol   (integrations are symbol-level nodes)
 *       endpoint:<M> </path> → endpoint
 *       datastore:<name>     → table
 *       module:<dir>         → module
 *     The prefix is stripped: `module:src/cli` → `{kind:'module', ref:'src/cli'}`,
 *     matching how `resolveAnchor` reconstructs node ids from anchor refs.
 *
 * FORGIVING vs STRICT
 *   - Docs without a `## Story` section parse to zero steps, zero warnings.
 *   - Missing optional fields are fine; a title-only step is valid.
 *   - Malformed ids/kinds/phases are warnings — the offending item is
 *     dropped, the step survives.
 *   - Malformed step blocks (empty title) are skipped AND counted in
 *     warnings — never silently swallowed.
 *
 * Step ids derive deterministically from titles: kebab slug, with `-2`,
 * `-3`… suffixes on collision. Pure module: no I/O, no clock — the same
 * input always yields deep-equal output.
 *
 * The parser fills `unresolvedAnchors: []` and `draft: false` on every step;
 * the compile pass (`blueprint narrate`) populates them after resolving
 * anchors against the derived graph and the effective proposal set.
 */

import { isValidPredictedNodeId, PREDICTED_ID_GRAMMAR } from './proposal-store.js';
import type { Anchor, AnchorKind, BlueprintNodeKind, StoryStep } from './types.js';

/** Result of parsing one doc's `## Story` section. */
export interface ParsedStorySection {
  /** Parsed steps, in document order. */
  steps: StoryStep[];
  /** Human-readable parse warnings — malformed items/blocks, never silent. */
  warnings: string[];
}

/** The `## Story` section heading (level 2, exact word). */
const STORY_HEADING_PATTERN = /^##\s+Story\s*$/;
/** Any level-2 heading — ends the story section (`###` does not match). */
const LEVEL_2_HEADING_PATTERN = /^##\s/;
/** A step heading inside the section; capture group 1 is the raw title. */
/**
 * A step heading inside the section; capture group 1 is the raw title.
 *
 * NUMBERED STEPS ARE STEPS (2026-10-08). Writers number them — `### Step 1:
 * …`, `### Step 2 — …`, `### Step 3. …` — and the strict `### Step:` form
 * read those as nothing at all: a real discovery compiled to 0 steps while
 * narrate printed success. The number is dropped (ids come from the title);
 * `### Step-by-step` is still not a step.
 */
const STEP_HEADING_PATTERN = /^###\s+Step(?:\s+\d+)?(?::|\s*[\u2014\u2013]|\s+-|\.)\s*(.*)$/;
/**
 * A top-level `- key: value` metadata line; groups: key, value.
 * Underscores are part of the key charset so `flow_before`/`flow_after` are
 * grammar rather than body — without them the change brief's before/after
 * flows would silently fall through to free markdown.
 */
const METADATA_LINE_PATTERN = /^-\s+([a-z_]+):\s*(.*)$/;
/** An indented `  - <text>` chip item under a chip-list key; group 1 is the text. */
const INDENTED_ITEM_PATTERN = /^\s+-\s+(.+)$/;
/** A plan phase number — non-negative integer, digits only. */
const PHASE_NUMBER_PATTERN = /^\d+$/;
/** First numeric suffix appended to a colliding step-id slug (`-2`, `-3`, …). */
const FIRST_COLLISION_SUFFIX = 2;

/** Metadata keys carrying a single free-text value. */
const SCALAR_KEYS = ['kicker', 'source', 'unchanged'] as const;
/** Metadata keys carrying chip lists (inline comma list OR indented items). */
const CHIP_LIST_KEYS = ['decisions', 'rejected', 'questions', 'fails'] as const;
/**
 * Metadata keys carrying an ordered node-id flow. `flow` is the ORIGINAL key
 * and remains the after-state — a doc written before the change brief keeps
 * parsing byte-identically (see `flowAfter` aliasing in `parseStepBlock`).
 */
const FLOW_KEYS = ['flow', 'flow_before', 'flow_after'] as const;

type ScalarKey = (typeof SCALAR_KEYS)[number];
type ChipListKey = (typeof CHIP_LIST_KEYS)[number];
type FlowKey = (typeof FLOW_KEYS)[number];

/**
 * Node-id prefix → anchor kind mapping for bare node-id anchor items.
 * Integrations map to `symbol` because integration nodes are symbol-level
 * (they carry a `symbol` field); the other three map to their namesake or
 * content kind. `endpoint`/`module` prefixes coincide with the explicit
 * anchor kinds of the same name — the two spellings are one grammar.
 */
const NODE_PREFIX_TO_ANCHOR_KIND: Record<BlueprintNodeKind, AnchorKind> = {
  integration: 'symbol',
  endpoint: 'endpoint',
  datastore: 'table',
  module: 'module',
};

/** The id prefix of a feature PART (`feature:<slug>/<part>`) — valid in a flow, not an anchor. */
const FEATURE_PART_PREFIX = 'feature';

/** Explicit anchor-envelope kinds that are NOT also node-id prefixes. */
const ENVELOPE_ONLY_KINDS: readonly AnchorKind[] = ['symbol', 'file', 'table'];

/**
 * An authored per-hop label rides on the SOURCE item of a flow list:
 *
 *   - flow_after: module:src/a -mints the id->, endpoint:POST /stream
 *
 * The arrow points at the next item. Group 1 is the node id, group 2 the label.
 */
// WHITESPACE BEFORE THE DASH IS REQUIRED. With `\s*` the lazy id stopped at
// the FIRST hyphen, so `feature:demo/memory-store -reads->` parsed as the id
// `feature:demo/memory` labelled "store -reads" — every hyphenated id that
// carried a label was cut in two, and the wire pointed at a node that does
// not exist. The grammar's own example is `module:src/a -mints the id->`.
const FLOW_LABEL_PATTERN = /^(.*?)\s+-([^>]*)->\s*$/;

/**
 * Split one flow item into its node id and optional authored hop label.
 *
 * THE single parser for flow items (allowed-pattern #14): the grammar
 * validates `id` alone, `story-compile` resolves `id` alone, and
 * `brief-model` reads the label. Three consumers, one definition — a second
 * copy would drift and silently reject valid overrides.
 */
export function parseFlowItem(item: string): { id: string; label?: string } {
  const match = FLOW_LABEL_PATTERN.exec(item);
  if (match === null) return { id: item.trim() };
  const id = match[1].trim();
  const label = match[2].trim();
  return label === '' ? { id } : { id, label };
}

/** Kebab-slug of a step title (fallback `step` when nothing survives). */
function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'step';
}

/**
 * Deterministic collision handling: the first occupant keeps the bare slug;
 * later collisions take `-2`, `-3`, … (skipping suffixes already occupied by
 * naturally-suffixed titles).
 */
function uniqueStepId(slug: string, usedIds: Set<string>): string {
  if (!usedIds.has(slug)) {
    return slug;
  }
  let suffix = FIRST_COLLISION_SUFFIX;
  while (usedIds.has(`${slug}-${suffix}`)) {
    suffix += 1;
  }
  return `${slug}-${suffix}`;
}

/** Split a comma-list metadata value into trimmed, non-empty items. */
function splitCommaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Parse one anchor item into an `Anchor`, or return null with a warning
 * pushed by the caller. Bare node ids are validated against the extractor id
 * grammar; explicit envelopes only require a non-empty ref.
 */
function parseAnchorItem(item: string): Anchor | null {
  const colonIndex = item.indexOf(':');
  if (colonIndex <= 0) {
    // BARE PATH tolerance (live bug 2026-07-27: a plan authored
    // `- anchors: src/commands/streamTurn.ts, …` and every anchor was
    // silently DROPPED, so the preview lit nothing). A prefix-less token that
    // looks like a path parses as a file anchor — the common authoring
    // mistake becomes the obvious meaning instead of invisible data loss.
    const bare = item.trim();
    if (/^[\w@.-]+(?:\/[\w@.\-[\]]+)+$/.test(bare) || /^[\w-]+\.[a-z]{1,6}$/i.test(bare)) {
      return { kind: 'file', ref: bare };
    }
    return null;
  }
  const head = item.slice(0, colonIndex);
  const ref = item.slice(colonIndex + 1).trim();
  if (ref.length === 0) {
    return null;
  }

  if (head in NODE_PREFIX_TO_ANCHOR_KIND) {
    const nodeKind = head as BlueprintNodeKind;
    if (!isValidPredictedNodeId(nodeKind, item)) {
      return null;
    }
    return { kind: NODE_PREFIX_TO_ANCHOR_KIND[nodeKind], ref };
  }
  if (ENVELOPE_ONLY_KINDS.includes(head as AnchorKind)) {
    return { kind: head as AnchorKind, ref };
  }
  return null;
}

/** One raw step block: the title plus its lines (heading excluded). */
interface StepBlock {
  title: string;
  lines: string[];
}

/**
 * Extract the `## Story` section's lines from a doc. Returns null when the
 * doc has no story section. Also reports (via the warnings array) any
 * additional `## Story` sections, which are ignored — only the first parses.
 */
function extractStorySection(lines: string[], sourcePath: string, warnings: string[]): string[] | null {
  const startIndex = lines.findIndex((line) => STORY_HEADING_PATTERN.test(line));
  if (startIndex === -1) {
    return null;
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (LEVEL_2_HEADING_PATTERN.test(lines[i])) {
      endIndex = i;
      break;
    }
  }

  const remainder = lines.slice(endIndex);
  if (remainder.some((line) => STORY_HEADING_PATTERN.test(line))) {
    warnings.push(`${sourcePath}: multiple "## Story" sections — only the first was parsed`);
  }

  return lines.slice(startIndex + 1, endIndex);
}

/** Split the story section's lines into step blocks at `### Step:` headings. */
function splitStepBlocks(sectionLines: string[]): StepBlock[] {
  const blocks: StepBlock[] = [];
  let current: StepBlock | null = null;

  for (const line of sectionLines) {
    const headingMatch = STEP_HEADING_PATTERN.exec(line);
    if (headingMatch !== null) {
      if (current !== null) {
        blocks.push(current);
      }
      current = { title: headingMatch[1].trim(), lines: [] };
      continue;
    }
    if (current !== null) {
      current.lines.push(line);
    }
    // Lines before the first step heading are section preamble — not a step.
  }
  if (current !== null) {
    blocks.push(current);
  }

  return blocks;
}

/** Mutable accumulator for one step block's parsed fields. */
interface StepAccumulator {
  kicker?: string;
  source?: string;
  /** The negative-space claim: what explicitly does NOT change. Authored. */
  unchanged?: string;
  anchors: Anchor[];
  /** Pre-change flow path — a claim about what exists TODAY. */
  flow_before: string[];
  /** Post-change flow path — may include predicted (ghost) ids. */
  flow_after: string[];
  phases: number[];
  decisions: string[];
  rejected: string[];
  questions: string[];
  /** How the change fails, from the user's side. Authored. */
  fails: string[];
  bodyLines: string[];
}

/**
 * Parse one step block into a `StoryStep`. Field-level problems produce
 * warnings and drop only the offending item — the step itself survives.
 */
function parseStepBlock(
  block: StepBlock,
  stepId: string,
  sourcePath: string,
  warnings: string[],
): StoryStep {
  const label = `${sourcePath}: step "${block.title}"`;
  const acc: StepAccumulator = {
    anchors: [],
    flow_before: [],
    flow_after: [],
    phases: [],
    decisions: [],
    rejected: [],
    questions: [],
    fails: [],
    bodyLines: [],
  };

  const { lines } = block;
  let index = 0;
  let inHtmlComment = false;
  while (index < lines.length) {
    const line = lines[index];
    // HTML comments (brain-capture blocks etc. trailing the last step in a
    // plan doc) are AUTHORING METADATA, never step narrative — the raw
    // `<!-- brain-capture …` leaking into the preview card confused the
    // user (2026-07-27). Multi-line tolerant; comment lines drop silently.
    if (inHtmlComment) {
      if (line.includes('-->')) inHtmlComment = false;
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith('<!--')) {
      if (!line.includes('-->')) inHtmlComment = true;
      index += 1;
      continue;
    }
    const metadataMatch = METADATA_LINE_PATTERN.exec(line);
    if (metadataMatch === null) {
      acc.bodyLines.push(line);
      index += 1;
      continue;
    }

    const key = metadataMatch[1];
    const value = metadataMatch[2].trim();

    if ((SCALAR_KEYS as readonly string[]).includes(key)) {
      if (value.length > 0) {
        acc[key as ScalarKey] = value;
      }
      index += 1;
      continue;
    }

    if (key === 'anchors') {
      for (const item of splitCommaList(value)) {
        const anchor = parseAnchorItem(item);
        if (anchor === null) {
          warnings.push(
            `${label} — invalid anchor "${item}" (expected <kind>:<ref> with kind symbol|file|table|endpoint|module, or a node id: ${PREDICTED_ID_GRAMMAR.integration}; ${PREDICTED_ID_GRAMMAR.endpoint}; ${PREDICTED_ID_GRAMMAR.datastore}; ${PREDICTED_ID_GRAMMAR.module})`,
          );
          continue;
        }
        acc.anchors.push(anchor);
      }
      index += 1;
      continue;
    }

    if ((FLOW_KEYS as readonly string[]).includes(key)) {
      // `flow` is the legacy spelling of `flow_after`: docs authored before the
      // change brief describe one world, and that world is the after-state.
      const target: Exclude<FlowKey, 'flow'> = key === 'flow_before' ? 'flow_before' : 'flow_after';
      for (const item of splitCommaList(value)) {
        // Validate the NODE ID only — an authored hop label is not part of it.
        const { id } = parseFlowItem(item);
        const colonIndex = id.indexOf(':');
        const prefix = colonIndex > 0 ? id.slice(0, colonIndex) : '';
        // A FEATURE PART is a flow node too (`feature:<slug>/<part>`, the
        // proposal grammar's `part` kind): a discovery that predicts new parts
        // could otherwise never say how they connect, and its discovery view
        // drew them with no wiring at all.
        const validNode =
          prefix === FEATURE_PART_PREFIX
            ? isValidPredictedNodeId('part', id)
            : prefix in NODE_PREFIX_TO_ANCHOR_KIND &&
              isValidPredictedNodeId(prefix as BlueprintNodeKind, id);
        if (!validNode) {
          warnings.push(`${label} — invalid flow node id "${item}"`);
          continue;
        }
        // Store the RAW item so the label survives to the brief model.
        acc[target].push(item);
      }
      index += 1;
      continue;
    }

    if (key === 'phases') {
      for (const item of splitCommaList(value)) {
        if (!PHASE_NUMBER_PATTERN.test(item)) {
          warnings.push(`${label} — invalid phase "${item}" (expected an integer)`);
          continue;
        }
        acc.phases.push(Number.parseInt(item, 10));
      }
      index += 1;
      continue;
    }

    if ((CHIP_LIST_KEYS as readonly string[]).includes(key)) {
      const items = splitCommaList(value);
      index += 1;
      // Consume contiguous indented `  - <text>` items following the key line.
      while (index < lines.length) {
        const itemMatch = INDENTED_ITEM_PATTERN.exec(lines[index]);
        if (itemMatch === null) {
          break;
        }
        items.push(itemMatch[1].trim());
        index += 1;
      }
      acc[key as ChipListKey].push(...items);
      continue;
    }

    // Recognized shape but unknown key — ordinary markdown list item: body.
    acc.bodyLines.push(line);
    index += 1;
  }

  const step: StoryStep = {
    id: stepId,
    title: block.title,
    body: acc.bodyLines.join('\n').trim(),
    anchors: acc.anchors,
    // `flow` stays the after-state so every existing consumer (simulation,
    // board, story sheet) keeps reading the same field it always read.
    flow: acc.flow_after,
    flowBefore: acc.flow_before,
    flowAfter: acc.flow_after,
    phases: acc.phases,
    decisions: acc.decisions,
    rejected: acc.rejected,
    questions: acc.questions,
    fails: acc.fails,
    unresolvedAnchors: [],
    draft: false,
  };
  if (acc.kicker !== undefined) {
    step.kicker = acc.kicker;
  }
  if (acc.source !== undefined) {
    step.source = acc.source;
  }
  if (acc.unchanged !== undefined) {
    step.unchanged = acc.unchanged;
  }
  return step;
}

/**
 * Parse the `## Story` section of a plan/discovery doc into story steps.
 *
 * Pure — no I/O, no clock. `sourcePath` is used only to label warnings.
 * A doc without a `## Story` section yields `{ steps: [], warnings: [] }`.
 * Malformed step blocks (empty title) are skipped AND counted in warnings;
 * malformed field items warn and drop without losing the step.
 */
export function parseStorySection(markdown: string, sourcePath: string): ParsedStorySection {
  const warnings: string[] = [];
  const lines = markdown.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  const sectionLines = extractStorySection(lines, sourcePath, warnings);
  if (sectionLines === null) {
    return { steps: [], warnings: [] };
  }

  const steps: StoryStep[] = [];
  const usedIds = new Set<string>();

  for (const block of splitStepBlocks(sectionLines)) {
    if (block.title.length === 0) {
      warnings.push(`${sourcePath}: step block with empty title skipped`);
      continue;
    }
    const stepId = uniqueStepId(slugifyTitle(block.title), usedIds);
    usedIds.add(stepId);
    steps.push(parseStepBlock(block, stepId, sourcePath, warnings));
  }

  return { steps, warnings };
}
