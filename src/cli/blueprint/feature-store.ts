/**
 * Feature store (feature-blueprint) — the blueprint's primary node type.
 *
 * `flow/brain/features/<slug>.md` is PRECIOUS: Obsidian-readable markdown whose
 * prose belongs to the user. This module is the ONE code path allowed to write
 * it (allowed-pattern #14), and the invariant it enforces is narrow and
 * absolute:
 *
 *   MACHINE-OWNED : anchors, relates, lastFullRead, patchCount
 *   HUMAN-OWNED   : name, kind, parent, home, and the entire body
 *
 * A write may only ever touch the machine-owned fields. Discovery re-runs,
 * re-learns and plan confirmations all funnel through here, so a boundary the
 * user corrected by hand can never be silently reverted by a later sweep —
 * which matters because the design deliberately has NO confirmation gate
 * (discovery decision #1). Editing the file IS the correction mechanism.
 *
 * FRONTMATTER, NOT YAML
 * =====================
 * The schema is scalars, string arrays and ONE structured list (`relates`), so
 * this parses/serializes its own frontmatter rather than pulling a YAML
 * dependency into the CLI. The codec is deliberately strict and lossless for
 * the fields it owns, and
 * PRESERVES any key it does not recognise — a future field (or a human's own)
 * survives a round trip instead of being dropped.
 *
 * Serialization is deterministic: fixed key order, stable array order, no
 * clock. Same node → byte-identical output (mirrors the blueprint render rule).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { knowledgeAuthor } from '../handlers/knowledge-authorship.js';
import { locateWorkspaceProject } from '../handlers/workspace-locate.js';
import { withFileLock, type FileLockLimits } from '../loop/file-lock.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { FEATURE_ROLES, isFeatureRole, type FeatureRole } from './feature-role.js';
import { BLUEPRINT_DIRNAME } from './store.js';

/** Directory holding the feature store, relative to `flow/`. */
export const FEATURES_DIRNAME = join('brain', 'features');

// ── The lock this store shares with the Flow app ───────────────────────────
//
// Every writer below is a read-modify-write of a whole file, so two of them
// overlapping means the second one's rewrite is composed from a view taken
// before the first one landed — and the first one's work is gone, silently and
// without an error to notice. The app's compaction pass (which promotes a
// thread's working set into these same `features/*.md`) has taken an advisory
// lock for exactly that reason since Phase 1.
//
// It was taking it against nobody. The app defended itself from the CLI while
// the CLI walked straight in, so the interlock only worked in whichever order
// happened to put the app second. This is the other half: the SAME file, the
// same stale-takeover rule, from the process that never checked.
//
// Nothing crosses this boundary but the file. The app cannot import CLI source
// and its lock is async where these verbs are synchronous, so the two hold
// separate implementations of one protocol — the reason `withFileLock` was
// extracted in the first place (allowed-pattern #14 applied across a process
// boundary rather than inside one).

/** Filename of the feature store's advisory lock. Must match the app's. */
const FEATURE_STORE_LOCK_FILENAME = 'features.lock';

/**
 * Limits for the feature-store lock — the same numbers the app uses, and
 * roomier than the loop state's: one compaction pass promotes every raw
 * working set a root accumulated, so a legitimate holder can be inside for a
 * while, and thirty seconds of waiting means a wedged holder rather than a
 * busy one.
 */
const FEATURE_STORE_LOCK_LIMITS: FileLockLimits = {
  staleMs: 30_000,
  waitMs: 30_000,
  retryMs: 50,
};

/**
 * Where the feature store's advisory lock lives.
 *
 * Deliberately NOT beside its target: `features/` is precious and
 * Obsidian-visible, and a lock file appearing and vanishing in a human's vault
 * is noise. `.structure/` is the derived, hidden tier — disposable by contract.
 *
 * The path is the whole agreement, so it is spelled to land on the same file
 * the app's `join(rootPath, 'flow/brain/.structure', 'features.lock')` lands
 * on, which for `flowDir = <root>/flow` is the same string. It stays the same
 * FILE even when the two arrive by different routes — this repo's `flow/` is a
 * symlink into the vault, and an exclusive create resolves the link before it
 * decides whether the file is already there.
 */
export function featureStoreLockPath(flowDir: string): string {
  return join(flowDir, BLUEPRINT_DIRNAME, FEATURE_STORE_LOCK_FILENAME);
}

/**
 * Run `fn` holding the feature store's advisory lock.
 *
 * Every writer in this module takes it, and the lock is re-entrant within a
 * process, so a writer that calls another one (`writeEdges` → `writeFeature`)
 * pays nothing extra. Exported so a caller doing several writes as one logical
 * change can hold it across the batch rather than letting another process in
 * between them.
 */
export function withFeatureStoreLock<T>(flowDir: string, fn: () => T): T {
  return withFileLock(featureStoreLockPath(flowDir), FEATURE_STORE_LOCK_LIMITS, fn);
}

/**
 * What a STORED feature is: a `core` — a capability — or a `child`, which is a
 * CHANGE record (a plan or an issue that touched a capability).
 *
 * A **part** is deliberately absent from this union. Parts are pieces of a
 * capability and live inside their owner's `## Parts` section, not as store
 * files of their own; the graph mints `kind: 'part'` nodes from them
 * (`FeatureGraphNode`). So the store has two kinds and the board has three —
 * and the word "part" belongs to exactly one of them.
 */
export type FeatureKind = 'core' | 'child';

/**
 * ONE RELATIONSHIP to another feature — the thing the store could never say.
 *
 * `relates` used to be a bare `string[]` of feature ids, and it was empty in
 * all 101 features across three projects, because a bare id is not worth
 * writing: it says two capabilities touch and sends the reader into both of
 * them to find out how. The mechanism and the reason are the answer, so they
 * are the schema:
 *
 *   target — the other feature's id (`feature:<slug>`), the only required part
 *   via    — the MECHANISM: the file, symbol or seam through which they connect
 *   note   — one line of WHY/HOW, readable without opening either feature
 *
 * `via` is deliberately a code reference where one exists: an edge whose `via`
 * names a source file can participate in the existing staleness stamping, so a
 * mechanism that changes marks the edge for re-verification instead of leaving
 * a confident, wrong statement behind (discovery FR4, wired in Phase 2).
 *
 * MACHINE-OWNED, like the field it replaces — the learn pass writes these, and
 * no human prose is touched to do it.
 */
export interface FeatureEdge {
  /** The other feature's id. Required; an edge without one is dropped. */
  target: string;
  /** The mechanism — a file, symbol or named seam. Absent when unknown. */
  via?: string;
  /** One line of why/how. Absent when unknown. */
  note?: string;
  /**
   * Content hash of the file `via` names, at the moment the edge was recorded.
   *
   * MACHINE-OWNED and written ONLY by the stamping helper in `file-stamps.ts`,
   * with the same `hashRepoFile` every other stamp in this system uses — an
   * edge is not a second notion of freshness, it is one more thing the existing
   * one covers. Absent means the mechanism is not a file (a symbol, a named
   * seam) or the file could not be read: such an edge is simply never claimed
   * to be fresh, which is honest, rather than assumed to be.
   */
  viaHash?: string;
}

/** One feature node. `body` is the user's prose, preserved verbatim. */
export interface FeatureNode {
  /** Stable, immutable identity. Survives renames; minted once at adoption. */
  id: string;
  /** Filename slug (without `.md`) — the human/Obsidian handle. */
  slug: string;
  /** Display name. HUMAN-OWNED. */
  name: string;
  /** HUMAN-OWNED. */
  kind: FeatureKind;
  /** Parent feature id, for `kind: 'child'`. HUMAN-OWNED. */
  parent?: string;
  /**
   * Grouping label for the board's root ring — e.g. "CLI", "Renderer".
   * HUMAN-OWNED. Seeded once by `blueprint features domains` from the
   * dominant module path of the feature's anchors, then corrected the same
   * way `name`/`kind`/`parent` are: by editing the markdown. Absent means
   * unassigned — never a synthesised default.
   */
  domain?: string;
  /** Code anchors this feature references (loose reference, never ownership). */
  anchors: string[];
  /** Relationships to other features — renders as edges at level 1. */
  relates: FeatureEdge[];
  /** ISO date of the last FULL semantic read, or null if never. */
  lastFullRead: string | null;
  /** Incremental patches applied since the last full read (drift backstop). */
  patchCount: number;
  /** The markdown body below the frontmatter. HUMAN-OWNED, byte-preserved. */
  body: string;
  /** Frontmatter keys this module does not own, preserved on write. */
  extra: Record<string, string>;
}

/**
 * NAMED keys, in serialization order — this store has dedicated parsing for
 * them. Named is not the same as machine-owned: `name`/`kind`/`parent`/`domain`
 * are named AND human-owned; only `writeFeature`'s `FeatureMachineFields` says
 * which fields a machine write may touch. Everything not in this list is
 * preserved verbatim in `extra`.
 */
const OWNED_KEYS = ['id', 'name', 'kind', 'parent', 'domain', 'anchors', 'relates', 'lastFullRead', 'patchCount'] as const;

const FRONTMATTER_FENCE = '---';

/**
 * The person-owned `home:` key — the folder a person says a feature (or, on a
 * `## Parts` entry, a part) lives in (plan `feature-home-folders`, FR-10).
 *
 * DELIBERATELY NOT A NAMED KEY. It stays in `extra`, the bucket every machine
 * write carries through verbatim, so no sweep, learn pass or re-seed can change
 * or drop it — the strongest form of "person-owned" this store has. The one
 * writer is `writeFeatureHome` (`blueprint features home`), which edits that one
 * line in place.
 */
export const HOME_KEY = 'home';

/** A raw `home:` value as a folder, or null when blank / `null`. Quotes a person typed are dropped. */
export function homeValueOf(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  let value = raw.trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    value = value.slice(1, -1).trim();
  }
  return value.length === 0 || value === 'null' ? null : value;
}

/** A feature's person-owned home folder, or null. */
export function featureHome(node: Pick<FeatureNode, 'extra'>): string | null {
  return homeValueOf(node.extra[HOME_KEY]);
}

/**
 * A feature's ROLE, under two keys with two writers (plan `feature-type-icons`,
 * FR-2). `role:` is the PERSON'S word and no machine path writes it; `learnedRole:`
 * is what a learn pass concluded, and its one writer is `writeLearnedRole`
 * (`blueprint features role`). Both stay in `extra`, like `home:`, so every
 * other machine write carries them through verbatim. The readers return the raw
 * value: the vocabulary check and the precedence live in ONE place,
 * `resolveFeatureRole` (`feature-role.ts`), where an off-list value reads as absent.
 */
export const ROLE_KEY = 'role';
export const LEARNED_ROLE_KEY = 'learnedRole';

/** A raw role value with person-typed quotes dropped, or null when blank / `null`. Not validated. */
export function roleValueOf(raw: string | undefined): string | null {
  return homeValueOf(raw);
}

/** A feature's person-owned `role:` as written, or null. */
export function featureRole(node: Pick<FeatureNode, 'extra'>): string | null {
  return roleValueOf(node.extra[ROLE_KEY]);
}

/** A feature's learn-owned `learnedRole:` as written, or null. */
export function featureLearnedRole(node: Pick<FeatureNode, 'extra'>): string | null {
  return roleValueOf(node.extra[LEARNED_ROLE_KEY]);
}

/** Kebab-slug of a feature name (fallback `feature`). Mirrors the story slug rule. */
export function slugifyFeatureName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'feature';
}

/**
 * Mint a stable id from a slug. Deterministic and content-free ON PURPOSE:
 * the id must not change when the feature's anchors or prose change, only the
 * slug at adoption time. Prefixed so a feature id is never mistaken for a
 * graph node id.
 */
export function mintFeatureId(slug: string, namespace?: string | null): string {
  return namespace === undefined || namespace === null || namespace.length === 0
    ? `${FEATURE_ID_PREFIX}${slug}`
    : `${FEATURE_ID_PREFIX}${namespace}${FEATURE_NAMESPACE_SEPARATOR}${slug}`;
}

/** Every feature id starts with this. */
export const FEATURE_ID_PREFIX = 'feature:';

/**
 * Between a Workspace project and its feature slug: `feature:<project>::<slug>`.
 *
 * NOT `/`. A slash already means something in this grammar — a PART is
 * `feature:<slug>/<part>` (`partNodeId`) — so `feature:chats/sse` could not say
 * whether it is project `chats`'s feature `sse` or feature `chats`'s part `sse`,
 * and the first cut read it as the former: an ordinary project's edge to a part
 * re-pointed at a same-named feature. `::` appears in no slug (both halves are
 * `[a-z0-9-]`), so a namespaced id parses exactly and a namespaced part is
 * simply `feature:<project>::<slug>/<part>`.
 */
export const FEATURE_NAMESPACE_SEPARATOR = '::';

// ── Namespaced ids (workspaces-knowledge-hub FR-20) ─────────────────────────
//
// In a Workspace many projects' knowledge lives in ONE repository, so a feature
// id has to say whose feature it is: `feature:<project>::<slug>`, where
// `<project>` is the project's folder name in the Workspace. Outside a
// Workspace ids stay `feature:<slug>`, byte-identical to before (FR-5).
//
// READERS ACCEPT BOTH: a hand-written `parent: feature:orders`, an edge a model
// wrote the short way, or a note copied in from before the project joined all
// still name the same feature as `feature:backend::orders` inside project
// `backend`. `sameFeatureId` / `resolveFeatureRef` are that one rule.
//
// PARSING IS EXACT: only `::` makes an id namespaced. An id without it is
// never read as namespaced, whatever slashes it carries.

/**
 * `feature:<ns>::<rest>` → { namespace, slug: rest }; `feature:<rest>` →
 * namespace null. `rest` is a feature slug, or `<slug>/<part>` for a part id.
 * Null for a non-feature id or an empty half.
 */
export function parseFeatureId(id: string): { namespace: string | null; slug: string } | null {
  if (!id.startsWith(FEATURE_ID_PREFIX)) return null;
  const rest = id.slice(FEATURE_ID_PREFIX.length);
  const separator = rest.indexOf(FEATURE_NAMESPACE_SEPARATOR);
  if (separator === -1) return rest.length > 0 ? { namespace: null, slug: rest } : null;
  const namespace = rest.slice(0, separator);
  const slug = rest.slice(separator + FEATURE_NAMESPACE_SEPARATOR.length);
  if (namespace.length === 0 || slug.length === 0 || namespace.includes('/')) return null;
  return { namespace, slug };
}

/** A feature id as a Workspace address: `<project>/<slug>`, or `<slug>` when un-namespaced. */
export function featureAddress(id: string): string {
  const parsed = parseFeatureId(id);
  if (parsed === null) return id;
  return parsed.namespace === null ? parsed.slug : `${parsed.namespace}/${parsed.slug}`;
}

/**
 * Do two ids name the same feature? Exact match, or the same slug where at
 * most one side carries a namespace (the short form is read as "this
 * project's"). Two DIFFERENT namespaces are two different features.
 */
export function sameFeatureId(a: string, b: string): boolean {
  if (a === b) return true;
  const left = parseFeatureId(a);
  const right = parseFeatureId(b);
  if (left === null || right === null || left.slug !== right.slug) return false;
  return left.namespace === null || right.namespace === null || left.namespace === right.namespace;
}

/** `<project>/<slug>` — a Workspace ADDRESS of a feature (no colon, exactly one slash). */
const FEATURE_ADDRESS_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/**
 * Resolve a reference against the ids that exist: exact first, then (with
 * `allowBareSlug`) `feature:<ref>` and the address form `<project>/<slug>` →
 * `feature:<project>::<slug>`, then the one known id naming the same feature
 * across the namespaced/short forms. Null when nothing — or more than one
 * thing — matches: a guess between two features is not a resolution.
 */
export function resolveFeatureRef(
  ref: string,
  knownIds: Iterable<string>,
  options: { allowBareSlug?: boolean } = {},
): string | null {
  const known = knownIds instanceof Set ? (knownIds as Set<string>) : new Set(knownIds);
  if (known.has(ref)) return ref;
  const candidates = [ref];
  if (options.allowBareSlug === true && !ref.startsWith(FEATURE_ID_PREFIX)) {
    const bare = `${FEATURE_ID_PREFIX}${ref}`;
    if (known.has(bare)) return bare;
    const address = FEATURE_ADDRESS_PATTERN.exec(ref);
    if (address !== null) {
      // An address names its project, so it resolves EXACTLY or not at all.
      const namespaced = mintFeatureId(address[2], address[1]);
      return known.has(namespaced) ? namespaced : null;
    }
    candidates.push(bare);
  }
  for (const candidate of candidates) {
    if (parseFeatureId(candidate) === null) continue;
    const matches = [...known].filter((id) => sameFeatureId(id, candidate));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

/**
 * The one feature a `--feature <ref>` names: its file slug, its id, the short
 * form of a namespaced id or a `<project>/<slug>` address — or undefined.
 * Every blueprint verb that takes a feature reference resolves through here,
 * so both id forms reach the same note.
 */
export function findFeatureByRef<T extends { id: string; slug: string }>(features: readonly T[], ref: string): T | undefined {
  const bySlug = features.find((feature) => feature.id === ref) ?? features.find((feature) => feature.slug === ref);
  if (bySlug !== undefined) return bySlug;
  const id = resolveFeatureRef(ref, features.map((feature) => feature.id), { allowBareSlug: true });
  return id === null ? undefined : features.find((feature) => feature.id === id);
}

/**
 * The namespace a `flow/` dir's features carry: the project's folder name in
 * its Workspace, or null outside one.
 */
export function featureNamespace(flowDir: string): string | null {
  return locateWorkspaceProject(flowDir)?.project ?? null;
}

/**
 * `flow/brain/features/` holds TWO different things — CLAUDE.md calls it
 * "Feature memory / working sets". Auto-capture writes one file per CHAT
 * THREAD (`makeBrainCaptureOnTurnComplete`), so a real project's directory is
 * dominated by tickets, PR titles and "New thread" rather than features.
 *
 * Treating every file as a feature put "ACME-2204: Error endpoint when spaces
 * is not enabled" and "Chat screenshots with random questions" on the board as
 * product features. They are sessions, not features.
 *
 * Two markers identify an auto-captured working set, either sufficient:
 *   - a `thread_id` in frontmatter (the machine's own key)
 *   - a body that opens "Working set for …"
 * Measured on a real project: 14 of 21 files matched; on plan-flow, 0 of 28.
 */
export function isWorkingSetCapture(raw: string): boolean {
  const { fm, body } = splitFrontmatter(raw);
  if (fm.some((line) => line.trimStart().startsWith('thread_id:'))) return true;
  return /^\s*Working set for\b/m.test(body);
}

/**
 * The frontmatter key a BRAIN-CAPTURE NOTE stamps on itself.
 *
 * `flow/brain/features/` has three populations, not two: features, auto-captured
 * working sets, and the per-feature memory the skills write (`/note`, the
 * discovery and execute brain-capture blocks). Only the first two were ever
 * named, so the third was admitted — and with `kind:` absent it was admitted as
 * a CAPABILITY. Two of them were cells on a real project's board.
 */
export const CAPTURE_KEY = 'capture';

/**
 * WHY A FILE IS NOT A FEATURE — or `null` when it is one.
 *
 * ONE function, so admission cannot disagree with the report of what was
 * excluded (allowed-pattern #14). The reasons, in the order they are tested:
 *
 *   `working-set`  — a thread's own scratch file (`thread_id`, or a body that
 *                    opens "Working set for …").
 *   `capture-note` — a brain-capture note, identified by the key it CARRIES.
 *
 * EVERY MARKER HERE IS POSITIVE — a thing the file HAS. Nothing is excluded for
 * what it lacks, and that is the whole safety property: a real capability
 * someone wrote by hand, with no frontmatter at all, carries no marker and can
 * therefore never be swallowed by this rule. The alternative was tried and
 * caught by `readFeatures`' own suite one commit later: keying on a missing
 * `kind:` dropped a legitimate hand-written feature, which is exactly the
 * failure a reader cannot diagnose — the board simply would not show it.
 *
 * A missing kind is a real problem, but it is a REPORTABLE one, not grounds for
 * silence. See `featureAdvisory`.
 */
export type FeatureExclusion = 'working-set' | 'capture-note';

export function featureExclusion(raw: string): FeatureExclusion | null {
  if (isWorkingSetCapture(raw)) return 'working-set';
  const { fm } = splitFrontmatter(raw);
  if (fm.some((line) => line.trimStart().startsWith(`${CAPTURE_KEY}:`))) return 'capture-note';
  return null;
}

/**
 * A file that IS admitted but could not say what it is.
 *
 * `parseFeatureFile` narrows an unreadable kind to `core`, so such a file draws
 * as a capability — which is how a ticket became a province. The narrowing is
 * kept (dropping the file would be the swallow described above) and the guess
 * is DECLARED instead, so a reader can see the board made one and correct the
 * file, which is the documented correction mechanism.
 *
 * The VALUE is checked, not just the key: `kind: cor` is as unreadable as no
 * kind at all, and rounding it to `core` is the same defect one typo later.
 */
export type FeatureAdvisory = 'no-kind';

export function featureAdvisory(raw: string): FeatureAdvisory | null {
  if (featureExclusion(raw) !== null) return null;
  const { fm } = splitFrontmatter(raw);
  const kindLine = fm.find((line) => line.trimStart().startsWith('kind:'));
  const kindValue = kindLine?.slice(kindLine.indexOf(':') + 1).trim();
  return kindValue === 'core' || kindValue === 'child' ? null : 'no-kind';
}

/** What a reader is told about a file the board did not draw, or drew on a
 *  guess. One sentence each, no path, no key — reasons a person can act on, in
 *  their own terms (forbidden-pattern #12). */
export const EXCLUSION_REASON: Record<FeatureExclusion | FeatureAdvisory, string> = {
  'working-set': 'a chat thread\u2019s working notes, not a capability',
  'capture-note': 'a note the assistant captured about a feature, not the feature itself',
  'no-kind': 'this file does not say whether it is a capability or a change, so it is shown as a capability',
};

/** Split a doc into (frontmatter lines, body). No fence → no frontmatter. */
function splitFrontmatter(raw: string): { fm: string[]; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    return { fm: [], body: normalized };
  }
  const end = normalized.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (end === -1) {
    // Unterminated fence — treat the whole file as body rather than guessing.
    return { fm: [], body: normalized };
  }
  const fm = normalized.slice(FRONTMATTER_FENCE.length + 1, end).split('\n');
  const body = normalized.slice(end + FRONTMATTER_FENCE.length + 2);
  return { fm, body };
}

/** `key: value` → [key, value]; inline `[a, b]` arrays are split by the caller. */
function parseLine(line: string): [string, string] | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}

/** Parse an inline `[a, b]` list. An empty/absent value yields []. */
function parseList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === '[]') return [];
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Serialize a list inline — stable order (as given), never sorted silently. */
function serializeList(items: readonly string[]): string {
  return `[${items.join(', ')}]`;
}

// ── `relates`: the one structured field ─────────────────────────────────────
//
// TWO ON-DISK FORMS, ONE MEANING. An edge list where every edge is a bare
// target serializes inline — `relates: [feature:a, feature:b]` — which is
// exactly the legacy form, so the 101 files carrying `relates: []` today round
// trip BYTE-IDENTICALLY and the schema change costs nobody a diff. As soon as
// any edge carries a mechanism or a note, the whole list serializes as an
// indented block, because a note is a sentence and a sentence contains commas.
//
// The reader accepts both forms unconditionally: an older file (or a human's
// hand-written `relates: [feature:x]`) must never fail to load.

/** Collapse a value to one clean line, or undefined when it says nothing. */
function cleanEdgeValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Canonicalize an edge list: clean each field, drop targetless edges, drop
 * exact duplicates, and sort by target → via → note.
 *
 * SORTED, unlike `anchors`, and the difference is deliberate. An anchor list's
 * order is its caller's — a human or a pass that chose it. An edge list's order
 * is whatever order a language model happened to emit its findings in, which
 * carries no meaning and changes between runs. These files are tracked, so an
 * order that is not meaningful must be canonical instead: same edges in, same
 * bytes out, no matter how the writer sequenced them.
 */
export function normalizeEdges(edges: readonly FeatureEdge[]): FeatureEdge[] {
  const seen = new Set<string>();
  const out: FeatureEdge[] = [];
  for (const edge of edges) {
    const target = edge.target.trim();
    if (target.length === 0) continue; // an edge to nothing is not an edge
    const via = cleanEdgeValue(edge.via);
    const note = cleanEdgeValue(edge.note);
    // A hash without a mechanism to hash is not a stamp — it would claim
    // freshness about nothing.
    const viaHash = via === undefined ? undefined : cleanEdgeValue(edge.viaHash);
    // A separator that cannot appear in any of the three parts, written as an ESCAPE, never a literal NUL — a literal one in this
    // directory already makes git and BSD grep treat a source file as binary.
    const key = [target, via ?? '', note ?? ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    const next: FeatureEdge = { target };
    if (via !== undefined) next.via = via;
    if (note !== undefined) next.note = note;
    if (viaHash !== undefined) next.viaHash = viaHash;
    out.push(next);
  }
  return out.sort((a, b) =>
    a.target.localeCompare(b.target) ||
    (a.via ?? '').localeCompare(b.via ?? '') ||
    (a.note ?? '').localeCompare(b.note ?? ''),
  );
}

/** Parse the indented block form below a `relates:` key. */
function parseEdgeBlock(lines: readonly string[]): FeatureEdge[] {
  const edges: FeatureEdge[] = [];
  let current: FeatureEdge | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('- ')) {
      const item = trimmed.slice(2).trim();
      const parsed = parseLine(item);
      // `- target: feature:x` is what this writes; `- feature:x` is what a
      // human might, and losing an id to a formatting nicety is not on.
      const target = parsed !== null && parsed[0] === 'target' ? parsed[1] : item;
      current = target.length > 0 ? { target } : null;
      if (current !== null) edges.push(current);
      continue;
    }
    if (current === null) continue;
    const parsed = parseLine(trimmed);
    if (parsed === null) continue;
    const [key, value] = parsed;
    if (key === 'via' && value.length > 0) current.via = value;
    else if (key === 'note' && value.length > 0) current.note = value;
    else if (key === 'viaHash' && value.length > 0) current.viaHash = value;
  }
  return edges;
}

/**
 * Parse `relates` from its inline value plus any indented block beneath it.
 *
 * THE LEGACY FORM IS NOT A SPECIAL CASE, it is the bare case: every id in
 * `relates: [feature:x, feature:y]` becomes `{ target }` with no via and no
 * note, which is precisely what those files meant.
 */
export function parseEdges(inline: string, block: readonly string[] = []): FeatureEdge[] {
  const parsed =
    block.length > 0
      ? parseEdgeBlock(block)
      : parseList(inline).map((target) => ({ target }) satisfies FeatureEdge);
  return normalizeEdges(parsed);
}

/** Render the `relates:` key (and its block, when one is needed). */
export function serializeEdges(edges: readonly FeatureEdge[]): string {
  const canonical = normalizeEdges(edges);
  if (canonical.every((edge) => edge.via === undefined && edge.note === undefined)) {
    return `relates: ${serializeList(canonical.map((edge) => edge.target))}`;
  }
  const lines = ['relates:'];
  for (const edge of canonical) {
    lines.push(`  - target: ${edge.target}`);
    if (edge.via !== undefined) lines.push(`    via: ${edge.via}`);
    if (edge.note !== undefined) lines.push(`    note: ${edge.note}`);
    if (edge.viaHash !== undefined) lines.push(`    viaHash: ${edge.viaHash}`);
  }
  return lines.join('\n');
}

/**
 * Parse one feature file. A file with NO frontmatter is valid: it parses with
 * defaults and its whole content as the body, which is exactly the state of
 * the 27 files this store adopts.
 */
export function parseFeatureFile(slug: string, raw: string): FeatureNode {
  const { fm, body } = splitFrontmatter(raw);
  const extra: Record<string, string> = {};
  const fields = new Map<string, string>();
  const relatesBlock: string[] = [];
  for (let index = 0; index < fm.length; index += 1) {
    const parsed = parseLine(fm[index]);
    if (parsed === null) continue;
    const [key, value] = parsed;
    if (key === 'relates') {
      fields.set(key, value);
      // A structured edge list is the INDENTED block below the key. Consuming
      // it here is what keeps `via:`/`note:` out of `extra`, where they would
      // both be lost as edge data and re-emitted as bogus top-level keys.
      while (index + 1 < fm.length && /^\s+\S/.test(fm[index + 1])) {
        relatesBlock.push(fm[index + 1]);
        index += 1;
      }
      continue;
    }
    if ((OWNED_KEYS as readonly string[]).includes(key)) fields.set(key, value);
    else extra[key] = value;
  }

  const name = fields.get('name') ?? deriveNameFromBody(body, slug);
  const kindRaw = fields.get('kind');
  // A narrowing with a declared guess behind it, never a silent default: a file
  // whose kind is absent or unreadable is admitted (dropping it would swallow a
  // hand-written feature) and reported by `featureAdvisory`, so the board can
  // say it guessed rather than pretend it knew.
  const kind: FeatureKind = kindRaw === 'child' ? 'child' : 'core';
  const patchRaw = Number.parseInt(fields.get('patchCount') ?? '0', 10);
  const lastFullRead = fields.get('lastFullRead');

  const node: FeatureNode = {
    id: fields.get('id') ?? mintFeatureId(slug),
    slug,
    name,
    kind,
    anchors: parseList(fields.get('anchors') ?? ''),
    relates: parseEdges(fields.get('relates') ?? '', relatesBlock),
    lastFullRead: lastFullRead === undefined || lastFullRead === 'null' ? null : lastFullRead,
    patchCount: Number.isFinite(patchRaw) && patchRaw >= 0 ? patchRaw : 0,
    body,
    extra,
  };
  const parent = fields.get('parent');
  if (parent !== undefined && parent.length > 0 && parent !== 'null') node.parent = parent;
  const domain = fields.get('domain');
  if (domain !== undefined && domain.length > 0 && domain !== 'null') node.domain = domain;
  return node;
}

/**
 * Best-effort display name for a file with no frontmatter: the first
 * `# Feature: X` / `# X` heading, else the slug. Never invents prose.
 */
function deriveNameFromBody(body: string, slug: string): string {
  for (const line of body.split('\n')) {
    const match = /^#\s+(?:Feature:\s*)?(.+?)\s*$/.exec(line);
    if (match === null) continue;
    // Headings in this store are often Obsidian wiki-links (`# [[slug]]`).
    // Without stripping, every card title rendered as literal `[[brackets]]`.
    const inner = /^\[\[(.+?)\]\]$/.exec(match[1].trim());
    const raw = inner !== null ? inner[1] : match[1];
    // A bare slug heading is not a display name — title-case it.
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)
      ? raw.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      : raw;
  }
  return slug;
}

export interface SerializeFeatureOptions {
  /**
   * Leave `lastFullRead` / `patchCount` out of the frontmatter — they are kept
   * in this machine's local learning state instead (a Workspace project).
   */
  localCounters?: boolean;
}

/**
 * Serialize a feature back to markdown. The body is written back BYTE-FOR-BYTE
 * — this function must never reflow, trim or reformat a user's prose.
 */
export function serializeFeature(node: FeatureNode, options: SerializeFeatureOptions = {}): string {
  const lines: string[] = [FRONTMATTER_FENCE];
  lines.push(`id: ${node.id}`);
  lines.push(`name: ${node.name}`);
  lines.push(`kind: ${node.kind}`);
  if (node.parent !== undefined) lines.push(`parent: ${node.parent}`);
  if (node.domain !== undefined) lines.push(`domain: ${node.domain}`);
  lines.push(`anchors: ${serializeList(node.anchors)}`);
  lines.push(serializeEdges(node.relates));
  if (options.localCounters !== true) {
    lines.push(`lastFullRead: ${node.lastFullRead ?? 'null'}`);
    lines.push(`patchCount: ${node.patchCount}`);
  }
  // Unrecognised keys survive, sorted for determinism.
  for (const key of Object.keys(node.extra).sort()) lines.push(`${key}: ${node.extra[key]}`);
  lines.push(FRONTMATTER_FENCE);
  return `${lines.join('\n')}\n${node.body}`;
}

/** Absolute path of the feature store for a `flow/` dir. */
export function featuresDir(flowDir: string): string {
  return join(flowDir, FEATURES_DIRNAME);
}

// ── Per-machine counters (workspaces-knowledge-hub FR-20) ───────────────────
//
// `lastFullRead` and `patchCount` say what THIS machine's learner has done.
// In a shared Workspace repo they are churn — two machines learning the same
// feature would conflict on two lines nobody else needs — so in a Workspace
// project they live in a local, personal file (`knowledge-classes.ts` lists it)
// and the synced note leaves them out. Outside a Workspace nothing moves: the
// note keeps them, byte-identical to before.
//
// Readers overlay the local values onto the parsed note, so every caller still
// sees `node.lastFullRead` / `node.patchCount` as it always did.

/** The local counters file, relative to `flow/`. Personal — never synced. */
export const FEATURE_LOCAL_STATE_RELPATH = join(BLUEPRINT_DIRNAME, 'feature-learning-state.json');

interface LocalCounters {
  lastFullRead: string | null;
  patchCount: number;
}

function localStatePath(flowDir: string): string {
  return join(flowDir, FEATURE_LOCAL_STATE_RELPATH);
}

/** slug → counters, or an empty map when absent/corrupt (fail-soft read). */
export function readFeatureLocalState(flowDir: string): Map<string, LocalCounters> {
  const counters = new Map<string, LocalCounters>();
  const path = localStatePath(flowDir);
  if (!existsSync(path)) return counters;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return counters;
    for (const [slug, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as { lastFullRead?: unknown; patchCount?: unknown };
      counters.set(slug, {
        lastFullRead: typeof entry.lastFullRead === 'string' ? entry.lastFullRead : null,
        patchCount:
          typeof entry.patchCount === 'number' && Number.isFinite(entry.patchCount) && entry.patchCount >= 0
            ? entry.patchCount
            : 0,
      });
    }
  } catch {
    // A corrupt local file reads as "never learned here" — it is this
    // machine's cache of its own progress, and the next learn rewrites it.
  }
  return counters;
}

function writeFeatureLocalCounters(flowDir: string, slug: string, counters: LocalCounters): void {
  const all = readFeatureLocalState(flowDir);
  const current = all.get(slug);
  if (current !== undefined && current.lastFullRead === counters.lastFullRead && current.patchCount === counters.patchCount) return;
  all.set(slug, counters);
  const out: Record<string, LocalCounters> = {};
  for (const key of [...all.keys()].sort()) out[key] = all.get(key) as LocalCounters;
  atomicWriteFile(localStatePath(flowDir), `${JSON.stringify(out, null, 2)}\n`);
}

/** Overlay this machine's counters onto a parsed note (Workspace projects only). */
function withLocalCounters(node: FeatureNode, local: Map<string, LocalCounters> | null): FeatureNode {
  if (local === null) return node;
  const counters = local.get(node.slug);
  return counters === undefined ? node : { ...node, lastFullRead: counters.lastFullRead, patchCount: counters.patchCount };
}

/** Parse a stored feature as its readers see it — local counters included. */
function loadStoredFeature(flowDir: string, slug: string, raw: string): FeatureNode {
  const node = parseFeatureFile(slug, raw);
  const namespace = featureNamespace(flowDir);
  if (namespace === null) return node;
  return withLocalCounters(readFirstCutIds(node, namespace), readFeatureLocalState(flowDir));
}

/**
 * The first cut of FR-20 minted `feature:<project>/<slug>` — the PART grammar.
 * In a Workspace project the spelling is unambiguous for the note's OWN id
 * (its project and its file name are known), and for a `parent` naming this
 * project, so those two read as the `::` form. Nothing else is guessed.
 */
function readFirstCutIds(node: FeatureNode, namespace: string): FeatureNode {
  const legacy = `${FEATURE_ID_PREFIX}${namespace}/`;
  const upgrade = (id: string): string => {
    if (!id.startsWith(legacy)) return id;
    const slug = id.slice(legacy.length);
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? mintFeatureId(slug, namespace) : id;
  };
  const id = node.id === `${legacy}${node.slug}` ? upgrade(node.id) : node.id;
  const parent = node.parent === undefined ? undefined : upgrade(node.parent);
  if (id === node.id && parent === node.parent) return node;
  return { ...node, id, ...(parent === undefined ? {} : { parent }) };
}

/**
 * THE ONE PLACE a feature node becomes bytes on disk. Every writer in this
 * module (and `forget-learning.ts`) ends here, so the Workspace rules apply to
 * all of them at once:
 *   - the per-machine counters go to local learning state, not the note;
 *   - a note that has never recorded an id gets a NAMESPACED one
 *     (`feature:<project>::<slug>`); an id already on disk is never changed;
 *   - a NEW note records its `author` (git identity, name only).
 * Outside a Workspace this is exactly the old `serializeFeature` + rename.
 * The caller holds the feature-store lock.
 */
export function persistFeatureNode(flowDir: string, node: FeatureNode): void {
  const dir = featuresDir(flowDir);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${node.slug}.md`);
  const location = locateWorkspaceProject(flowDir);
  let target = node;
  if (location !== null) {
    const exists = existsSync(filePath);
    const recordsId = exists && splitFrontmatter(readFileSync(filePath, 'utf-8')).fm.some((line) => line.startsWith('id:'));
    target = { ...node, extra: { ...node.extra } };
    if (!recordsId) {
      const parsed = parseFeatureId(node.id);
      if (parsed !== null && parsed.namespace === null) target.id = mintFeatureId(parsed.slug, location.project);
      if (target.parent !== undefined) {
        const parent = parseFeatureId(target.parent);
        if (parent !== null && parent.namespace === null) target.parent = mintFeatureId(parent.slug, location.project);
      }
    }
    if (!exists && target.extra.author === undefined) {
      const author = knowledgeAuthor(location.workspacePath);
      if (author !== null) target.extra.author = author;
    }
    writeFeatureLocalCounters(flowDir, node.slug, { lastFullRead: node.lastFullRead, patchCount: node.patchCount });
  }
  const temp = `${filePath}.tmp`;
  writeFileSync(temp, serializeFeature(target, { localCounters: location !== null }), 'utf-8');
  renameSync(temp, filePath);
}

/** A file the store declined to read as a feature — or admitted on a guess —
 *  and why. */
export interface ExcludedFeatureFile {
  slug: string;
  reason: FeatureExclusion | FeatureAdvisory;
  /** False when the file IS drawn and the reason is a declared guess. */
  dropped: boolean;
}

/**
 * Read every feature AND everything the directory held that is not one.
 *
 * The exclusions travel with the features because a reader has to be able to
 * find out what is missing. A count alone cannot be acted on: the stated
 * failure of a rule like this is a real capability quietly not being drawn, and
 * a number does not tell anyone which one.
 */
export function readFeaturesWithExclusions(flowDir: string): {
  features: FeatureNode[];
  excluded: ExcludedFeatureFile[];
} {
  const dir = featuresDir(flowDir);
  if (!existsSync(dir)) return { features: [], excluded: [] };
  const features: FeatureNode[] = [];
  const excluded: ExcludedFeatureFile[] = [];
  const namespace = featureNamespace(flowDir);
  const local = namespace === null ? null : readFeatureLocalState(flowDir);
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md') || entry === 'index.md') continue;
    const slug = basename(entry, '.md');
    try {
      const raw = readFileSync(join(dir, entry), 'utf-8');
      const reason = featureExclusion(raw);
      if (reason !== null) {
        // A working set is the directory's normal traffic and there are dozens
        // of them; reporting each one would bury the ones that matter.
        if (reason !== 'working-set') excluded.push({ slug, reason, dropped: true });
        continue;
      }
      const advisory = featureAdvisory(raw);
      if (advisory !== null) excluded.push({ slug, reason: advisory, dropped: false });
      const parsed = parseFeatureFile(slug, raw);
      features.push(withLocalCounters(namespace === null ? parsed : readFirstCutIds(parsed, namespace), local));
    } catch {
      // Fail-soft: one unreadable file never hides the rest.
      continue;
    }
  }
  return { features, excluded };
}

/** Read every feature, sorted by slug for deterministic output. */
export function readFeatures(flowDir: string): FeatureNode[] {
  return readFeaturesWithExclusions(flowDir).features;
}

/** The machine-owned fields a write is permitted to change. */
export interface FeatureMachineFields {
  anchors?: string[];
  relates?: FeatureEdge[];
  lastFullRead?: string | null;
  patchCount?: number;
}

/**
 * Write a feature's MACHINE-OWNED fields, atomically.
 *
 * The human-owned fields and the body are re-read from disk and carried
 * through untouched, so a caller holding a stale node cannot clobber a rename
 * or an edit made since it loaded. That re-read is the whole safety property:
 * without it, "never overwrite a human edit" would depend on every caller
 * behaving, which is exactly the prompt-convention failure allowed-pattern #14
 * exists to prevent.
 *
 * Creating a NEW feature (no file on disk) writes the node as given.
 */
export function writeFeature(flowDir: string, node: FeatureNode, fields: FeatureMachineFields = {}): void {
  return withFeatureStoreLock(flowDir, () => {
    const dir = featuresDir(flowDir);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${node.slug}.md`);

    let target = node;
    if (existsSync(filePath)) {
      const onDisk = loadStoredFeature(flowDir, node.slug, readFileSync(filePath, 'utf-8'));
      target = {
        ...onDisk, // human-owned fields + body win, always
        anchors: fields.anchors ?? onDisk.anchors,
        relates: fields.relates ?? onDisk.relates,
        lastFullRead: fields.lastFullRead !== undefined ? fields.lastFullRead : onDisk.lastFullRead,
        patchCount: fields.patchCount ?? onDisk.patchCount,
      };
    } else {
      target = {
        ...node,
        anchors: fields.anchors ?? node.anchors,
        relates: fields.relates ?? node.relates,
        lastFullRead: fields.lastFullRead !== undefined ? fields.lastFullRead : node.lastFullRead,
        patchCount: fields.patchCount ?? node.patchCount,
      };
    }

    persistFeatureNode(flowDir, target);
  });
}

// ── The `## Learned` section ────────────────────────────────────────────────
//
// The body is HUMAN-OWNED and byte-preserved, and learn needs to write it.
// Rather than break that rule, it MOVES: the body splits into a human region
// that is never touched and a machine-owned `## Learned` section that learn
// rewrites freely. The invariant is unchanged in force — only its boundary
// moves from "the body" to "this section".
//
// The parser is the entire risk. A mis-detected boundary overwrites prose
// nobody can recover, so ambiguity means REFUSE, never write-anyway.

/** The one heading that opens the machine-owned region. Exact match, level 2. */
export const LEARNED_HEADING = '## Learned';

/** Where a learning came from. `plan:<name>` records which plan taught it. */
export type LearningProvenance = string;

/** One thing we know about a feature. */
export interface Learning {
  /** The learning itself, one line of prose. */
  text: string;
  /** `code`, `human`, or `plan:<plan-name>`. */
  provenance: LearningProvenance;
  /** ISO date (YYYY-MM-DD) the learning was recorded. */
  date: string;
  /** Kept at the top of the section regardless of age. */
  pinned?: boolean;
  /** Why this learning was replaced. Present ⇒ superseded, retained, demoted. */
  supersededReason?: string;
}

/** A body cut into its human region and its machine-owned section. */
export interface SplitBody {
  /** Everything above `## Learned`, byte-for-byte. Never rewritten. */
  human: string;
  /** The section's raw content, or null when the file has no section. */
  learned: string | null;
}

/** Thrown when the section boundary cannot be determined with certainty. */
export class AmbiguousLearnedSectionError extends Error {
  constructor(reason: string) {
    super(`ambiguous \`${LEARNED_HEADING}\` boundary — ${reason}`);
    this.name = 'AmbiguousLearnedSectionError';
  }
}

/** Line indexes of `## Learned` headings that are NOT inside a fenced block. */
function learnedHeadingLines(lines: readonly string[]): number[] {
  const found: number[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^\s*(```+|~~~+)/.exec(line);
    if (fenceMatch !== null) {
      // A fence of the same or greater length closes; anything else opens.
      if (fence !== null && fenceMatch[1].startsWith(fence[0]) && fenceMatch[1].length >= fence.length) {
        fence = null;
      } else if (fence === null) {
        fence = fenceMatch[1];
      }
      continue;
    }
    if (fence !== null) continue; // inside a code block — prose, not a boundary
    if (line.trim() === LEARNED_HEADING) found.push(index);
  }
  if (fence !== null) {
    throw new AmbiguousLearnedSectionError('the file has an unterminated code fence');
  }
  return found;
}

/**
 * Cut a feature body at its `## Learned` heading.
 *
 * No heading ⇒ the whole body is human and `learned` is null. That is the state
 * of every feature file written before this existed, and it must stay readable
 * exactly as it is until someone learns the feature.
 *
 * REFUSES rather than guesses when: the file carries more than one such heading
 * (which region is the machine's?), or a code fence never closes (a `## Learned`
 * inside it is prose, and an unterminated fence means we cannot tell).
 */
export function splitLearned(body: string): SplitBody {
  const normalized = body.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const headings = learnedHeadingLines(lines);
  if (headings.length > 1) {
    throw new AmbiguousLearnedSectionError(`the file carries ${headings.length} of them`);
  }
  if (headings.length === 0) {
    return { human: normalized, learned: null };
  }
  const at = headings[0];
  return {
    human: lines.slice(0, at).join('\n'),
    learned: lines.slice(at + 1).join('\n'),
  };
}

/** `- text <!-- learned: <provenance> <date>[ pinned][ superseded: <why>] -->` */
const LEARNING_LINE_RE =
  /^-\s+(.*?)\s*<!--\s*learned:\s*(\S+)\s+(\d{4}-\d{2}-\d{2})(\s+pinned)?(?:\s+superseded:\s*(.*?))?\s*-->\s*$/;

/**
 * Parse a `## Learned` section back into entries.
 *
 * Anything that is not a learning line is IGNORED rather than dropped from the
 * file — the section may carry blank lines and the superseded divider, and a
 * hand-edited line that no longer parses must not be silently deleted on the
 * next write. (`writeLearned` rewrites the section from entries, so a line that
 * cannot be parsed is reported by `parseLearnings` returning fewer entries; the
 * caller decides, and the default caller refuses.)
 */
export function parseLearnings(section: string | null): Learning[] {
  if (section === null) return [];
  const out: Learning[] = [];
  for (const line of section.replace(/\r\n/g, '\n').split('\n')) {
    const match = LEARNING_LINE_RE.exec(line.trim());
    if (match === null) continue;
    const entry: Learning = { text: match[1], provenance: match[2], date: match[3] };
    if (match[4] !== undefined) entry.pinned = true;
    if (match[5] !== undefined) entry.supersededReason = match[5];
    out.push(entry);
  }
  return out;
}

/** True when a section contains content that is not a learning line. */
export function hasUnparsedContent(section: string | null): boolean {
  if (section === null) return false;
  return section
    .replace(/\r\n/g, '\n')
    .split('\n')
    .some((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (trimmed === SUPERSEDED_DIVIDER) return false;
      return LEARNING_LINE_RE.exec(trimmed) === null;
    });
}

/** Separates current learnings from retained-but-replaced ones. */
const SUPERSEDED_DIVIDER = '<!-- superseded -->';

/**
 * Render entries as the section's content: current first (pinned above the
 * rest, newest first within each), then the superseded ones below a divider.
 *
 * Superseded entries are RETAINED — history is never rewritten — but they never
 * interleave with current ones, so a reader cannot mistake a replaced claim for
 * a live one.
 */
export function serializeLearnings(entries: readonly Learning[]): string {
  const render = (entry: Learning): string => {
    const flags = [
      entry.pinned === true ? ' pinned' : '',
      entry.supersededReason !== undefined ? ` superseded: ${entry.supersededReason}` : '',
    ].join('');
    return `- ${entry.text} <!-- learned: ${entry.provenance} ${entry.date}${flags} -->`;
  };
  const byRecency = (a: Learning, b: Learning): number => b.date.localeCompare(a.date);
  const current = entries.filter((entry) => entry.supersededReason === undefined);
  const superseded = entries.filter((entry) => entry.supersededReason !== undefined);
  const ordered = [
    ...current.filter((entry) => entry.pinned === true).sort(byRecency),
    ...current.filter((entry) => entry.pinned !== true).sort(byRecency),
  ];

  const lines: string[] = ['', ...ordered.map(render)];
  if (superseded.length > 0) {
    lines.push('', SUPERSEDED_DIVIDER, ...[...superseded].sort(byRecency).map(render));
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Write a feature's `## Learned` section, leaving every human byte untouched.
 *
 * Re-reads from disk first, exactly as `writeFeature` does: the caller's view of
 * the human region may be stale, and the human region always wins. The section
 * is replaced whole or not at all — a partial write is the one outcome that
 * could corrupt a file.
 *
 * REFUSES (throws) when the boundary is ambiguous, or when an existing section
 * holds content this parser does not recognise. The second case matters: a human
 * who hand-edited the section would otherwise have their edit silently discarded
 * by the next learn, which is the very thing the HUMAN-OWNED rule exists to
 * prevent.
 */
export function writeLearned(
  flowDir: string,
  slug: string,
  entries: readonly Learning[],
): void {
  const filePath = join(featuresDir(flowDir), `${slug}.md`);
  return withFeatureStoreLock(flowDir, () => {
    // Inside the lock, like every read below it: a feature that exists when the
    // check runs and not when the write does is the same interleaving the lock
    // is here to remove.
    if (!existsSync(filePath)) {
      throw new Error(`no feature '${slug}' to write learnings to`);
    }
    const node = loadStoredFeature(flowDir, slug, readFileSync(filePath, 'utf-8'));
    const split = splitLearned(node.body); // throws on ambiguity
    if (hasUnparsedContent(split.learned)) {
      throw new AmbiguousLearnedSectionError(
        'the existing section contains hand-written content this writer would discard',
      );
    }

    const human = split.learned === null ? node.body.replace(/\s*$/, '\n') : `${split.human.replace(/\s*$/, '')}\n`;
    const body = `${human}\n${LEARNED_HEADING}\n${serializeLearnings(entries)}`;
    persistFeatureNode(flowDir, { ...node, body });
  });
}


/**
 * ONE LINE saying what a feature is — for a card, where counts do not help.
 *
 * "coworkers · 2 anchors" tells a reader the scale of a thing whose purpose
 * they still do not know. The best available sentence is, in order: a pinned
 * learning (a human chose it), the newest current learning, or the lead of the
 * human prose. Empty when the feature genuinely says nothing about itself —
 * the card then falls back to scale rather than inventing meaning.
 */
export function featureSummary(body: string): string {
  let learned: Learning[] = [];
  let human = body;
  try {
    const split = splitLearned(body);
    learned = parseLearnings(split.learned);
    human = split.human;
  } catch {
    // Ambiguous boundary — read the whole body as human, claim no learnings.
  }
  const current = learned.filter((entry) => entry.supersededReason === undefined);
  const chosen =
    current.find((entry) => entry.pinned === true) ??
    [...current].sort((a, b) => b.date.localeCompare(a.date))[0];
  if (chosen !== undefined) return chosen.text;

  // Lead prose only: everything from the first section heading on is reference
  // material (links, timelines), not a description.
  const lines: string[] = [];
  for (const line of human.split('\n')) {
    if (/^#{2,}\s/.test(line)) break;
    if (/^#\s/.test(line)) continue;
    lines.push(line);
  }
  const text = lines
    .join(' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\[\[(.+?)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^Confirmed from surface:/.test(text)) return '';
  return text;
}

// ── Writing edges: the one path, and the refusal that makes it safe ─────────
//
// An edge is written by a MACHINE reading code — a learn pass that has just
// been handed the roster and asked to name the other side. The failure mode is
// therefore not a bad note but a NAME THAT DOES NOT EXIST: a model that saw a
// skill binder and wrote `feature:skill-registry` has produced something that
// reads exactly like recorded knowledge, is shared with the team, and nobody
// ever re-derives. A missing edge costs a reader one search; a hallucinated one
// costs them their trust in every other edge.
//
// So the store — which is the only thing that actually knows which features
// exist — decides. Validation lives HERE rather than in the prompt or the
// caller (allowed-pattern #14): every edge write goes through `writeEdges`,
// which re-reads the store for the id set, and an unknown target is REFUSED
// with a reason rather than written and hoped about.

/** One edge the store would not write, and why not. */
export interface EdgeRefusal {
  /** The target exactly as proposed — never rewritten, so the reason is checkable. */
  target: string;
  /** One line saying why. Surfaced verbatim to whoever proposed the edge. */
  reason: string;
}

/** Outcome of reviewing (or writing) a batch of proposed edges. */
export interface EdgeReview {
  /** Edges the store accepts, canonicalized. */
  accepted: FeatureEdge[];
  /** Edges the store refuses, each with its reason. */
  refused: EdgeRefusal[];
}

/** Refusal reason for a target no feature in this store carries. */
export const UNKNOWN_TARGET_REASON = 'no feature with that id exists in this project';

/** Refusal reason for an edge pointing back at its own feature. */
export const SELF_TARGET_REASON = 'a feature cannot relate to itself';

/** Refusal reason for an edge with nothing on the other end. */
export const EMPTY_TARGET_REASON = 'an edge needs a target feature id';

/**
 * Judge proposed edges against the roster — the ids that actually exist.
 *
 * Pure, so the rule can be tested without a store on disk, and total: every
 * proposal comes back either accepted or refused, never silently dropped. A
 * bare slug is normalized to `feature:<slug>` ONLY when that id is in the
 * roster: recognising a real feature written the short way is not the failure
 * being guarded against, and refusing it would send a correct edge to the bin.
 * Anything else is refused with its reason.
 */
export function reviewEdges(
  proposals: readonly FeatureEdge[],
  knownIds: ReadonlySet<string>,
  selfId: string,
): EdgeReview {
  const accepted: FeatureEdge[] = [];
  const refused: EdgeRefusal[] = [];
  for (const proposal of proposals) {
    const raw = proposal.target.trim();
    if (raw.length === 0) {
      refused.push({ target: proposal.target, reason: EMPTY_TARGET_REASON });
      continue;
    }
    // Exact, then the short `slug` form, then the namespaced/short equivalence
    // of a Workspace project (`feature:x` ↔ `feature:<project>/x`).
    const target = resolveFeatureRef(raw, knownIds, { allowBareSlug: true }) ?? raw;
    if (target === selfId) {
      refused.push({ target: raw, reason: SELF_TARGET_REASON });
      continue;
    }
    if (!knownIds.has(target)) {
      refused.push({ target: raw, reason: UNKNOWN_TARGET_REASON });
      continue;
    }
    accepted.push({ ...proposal, target });
  }
  return { accepted: normalizeEdges(accepted), refused };
}

/** What a `writeEdges` call did: the review, plus the feature's edges after it. */
export interface EdgeWriteResult extends EdgeReview {
  /** The feature's full edge list on disk after the write. */
  relates: FeatureEdge[];
}

/**
 * Write a feature's `relates` edges through the store's existing writer.
 *
 * NO NEW WRITE PATH: this validates, merges and hands `writeFeature` the one
 * machine-owned field it already owns, so the human fields and the prose are
 * carried through by the same re-read that protects every other machine write.
 *
 * MERGED BY TARGET, not replaced wholesale. A pass reads the files of ONE
 * feature, so its view of that feature's relationships is partial by
 * construction; replacing the list would delete an edge recorded by an earlier
 * pass that read different code. A new edge to a target already recorded
 * REPLACES that target's edge (a re-learn refreshes its own mechanism and note
 * rather than stacking near-duplicates), and every other edge is left exactly
 * as it was.
 *
 * Refusals never abort the accepted edges: a batch of three where one names a
 * feature that does not exist writes the two that do and reports the third.
 * The alternative — refusing the batch — makes one hallucination cost two real
 * relationships.
 */
export function writeEdges(
  flowDir: string,
  slug: string,
  proposals: readonly FeatureEdge[],
): EdgeWriteResult {
  const filePath = join(featuresDir(flowDir), `${slug}.md`);
  // The roster read, the merge and the write are ONE critical section — the
  // nested `writeFeature` is re-entrant, so this costs nothing beyond keeping
  // another process out of the gap between reading `relates` and rewriting it.
  return withFeatureStoreLock(flowDir, () => {
    if (!existsSync(filePath)) {
      throw new Error(`no feature '${slug}' to write edges to`);
    }
    // The STORE is the roster — re-read here rather than trusted from a caller,
    // for the same reason `writeFeature` re-reads the human fields.
    const features = readFeatures(flowDir);
    const node = features.find((feature) => feature.slug === slug)
      ?? parseFeatureFile(slug, readFileSync(filePath, 'utf-8'));
    const knownIds = new Set(features.map((feature) => feature.id));
    knownIds.add(node.id);

    const review = reviewEdges(proposals, knownIds, node.id);
    const byTarget = new Map<string, FeatureEdge>();
    for (const edge of node.relates) byTarget.set(edge.target, edge);
    for (const edge of review.accepted) byTarget.set(edge.target, edge);
    const relates = normalizeEdges([...byTarget.values()]);

    writeFeature(flowDir, node, { relates });
    return { ...review, relates };
  });
}

/**
 * The key ONE edge is identified by wherever its freshness is looked up: the
 * feature that RECORDED it plus the feature it points at.
 *
 * Directed on purpose — the stamp belongs to the side that wrote the mechanism
 * down, and the other side may hold its own edge through a different one. Lives
 * here, with the type, so the graph and the stale-check cannot drift into two
 * spellings of the same key (which is precisely how a stale edge silently
 * renders as fresh).
 */
export function edgeKey(featureId: string, target: string): string {
  return `${featureId}::${target}`;
}

/**
 * ONE LINE answering "how do these two connect?" from the reading side.
 *
 * This is the whole point of the schema. A bare id says two capabilities touch
 * and sends the reader into both of them; the mechanism and the reason are what
 * let a reader of Playbooks answer a question about Skills without opening
 * Skills. Rendered wherever an edge is read, so the answer travels with the
 * edge rather than being re-derived per surface.
 */
export function describeEdge(edge: FeatureEdge): string {
  const via = edge.via !== undefined ? ` — via ${edge.via}` : '';
  const note = edge.note !== undefined ? `: ${edge.note}` : '';
  return `${edge.target}${via}${note}`;
}

/** One re-levelling instruction for `reclassFeatures`. */
export interface FeatureReclass {
  slug: string;
  kind: FeatureKind;
  /** Feature id of the new parent, or undefined to clear it. */
  parent?: string;
}

/**
 * Re-level existing features — the ONE writer permitted to change `kind` and
 * `parent`, which `writeFeature` deliberately treats as human-owned.
 *
 * This exists because those fields were never actually human-chosen for the
 * files already in the store: `seedFeatures` stamped `kind: core` on every
 * adopted file because the parser defaults to core when frontmatter is absent.
 * So a board full of change records marked "core" is this tool's own artifact,
 * and repairing it is not overriding anybody.
 *
 * It stays a SEPARATE, EXPLICIT verb rather than a step inside discovery: a
 * sweep that silently re-levels features would be able to undo a human's
 * correction on every run, which is exactly what the store's write rule exists
 * to prevent. Prose and every other field are untouched.
 */
export function reclassFeatures(
  flowDir: string,
  changes: readonly FeatureReclass[],
  options: { dryRun?: boolean } = {},
): string[] {
  const dir = featuresDir(flowDir);
  // One section for the WHOLE sweep: a re-level is one decision about the store,
  // and letting another writer in halfway leaves it half-applied.
  return withFeatureStoreLock(flowDir, () => {
    const applied: string[] = [];
    for (const change of changes) {
      const filePath = join(dir, `${change.slug}.md`);
      if (!existsSync(filePath)) continue;
      const node = loadStoredFeature(flowDir, change.slug, readFileSync(filePath, 'utf-8'));
      const sameParent =
        node.parent === change.parent ||
        (node.parent !== undefined && change.parent !== undefined && sameFeatureId(node.parent, change.parent));
      if (node.kind === change.kind && sameParent) continue;
      applied.push(change.slug);
      if (options.dryRun === true) continue;
      node.kind = change.kind;
      if (change.parent === undefined) delete node.parent;
      else node.parent = change.parent;
      persistFeatureNode(flowDir, node);
    }
    return applied;
  });
}

/** One `domain:` seeding instruction for `seedDomains`. */
export interface FeatureDomainSeed {
  slug: string;
  domain: string;
}

/**
 * Seed the `domain` field on existing features — the ONE writer permitted to
 * set it, mirroring `reclassFeatures` for `kind`/`parent`.
 *
 * NEVER overwrites an existing `domain`: the on-disk value decides, not the
 * caller's precomputed plan, so a feature a human already labelled (or a
 * previous seed already set) is skipped even if the caller still lists it.
 * That is what makes `blueprint features domains` idempotent — a second run
 * against files it already touched sets nothing.
 */
export function seedDomains(
  flowDir: string,
  seeds: readonly FeatureDomainSeed[],
  options: { dryRun?: boolean } = {},
): string[] {
  const dir = featuresDir(flowDir);
  // One section for the whole seed, as `reclassFeatures` does — and because the
  // "never overwrite a set domain" rule is decided by a read that must not be
  // separated from the write it guards.
  return withFeatureStoreLock(flowDir, () => {
    const applied: string[] = [];
    for (const seed of seeds) {
      const filePath = join(dir, `${seed.slug}.md`);
      if (!existsSync(filePath)) continue;
      const node = loadStoredFeature(flowDir, seed.slug, readFileSync(filePath, 'utf-8'));
      if (node.domain !== undefined) continue; // never overwrite a set domain
      applied.push(seed.slug);
      if (options.dryRun === true) continue;
      node.domain = seed.domain;
      persistFeatureNode(flowDir, node);
    }
    return applied;
  });
}

/**
 * Adopt every existing feature file in place: add frontmatter, keep prose.
 * Idempotent — a file that already carries an `id` is left byte-identical.
 * Returns the slugs actually adopted.
 */
export function seedFeatures(flowDir: string, options: { dryRun?: boolean } = {}): string[] {
  const dir = featuresDir(flowDir);
  if (!existsSync(dir)) return [];
  // One section for the whole adoption sweep — see `reclassFeatures`.
  return withFeatureStoreLock(flowDir, () => {
    const adopted: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.md') || entry === 'index.md') continue;
      const slug = basename(entry, '.md');
      const filePath = join(dir, entry);
      const raw = readFileSync(filePath, 'utf-8');
      // Positive markers only. A file with no `kind:` is precisely what this
      // sweep exists to adopt — it writes one — so excluding it here would
      // strand every legacy file forever. `readFeatures` still declines to draw
      // it until the sweep has said what it is.
      const exclusion = featureExclusion(raw);
      if (exclusion === 'working-set' || exclusion === 'capture-note') continue;
      const { fm } = splitFrontmatter(raw);
      if (fm.some((line) => line.startsWith('id:'))) {
        // Already adopted. One narrow repair: an earlier seed could write a
        // wiki-link heading (`# [[slug]]`) straight into `name`, which then
        // rendered as literal brackets on every card. A wiki-link is never a
        // display name, so normalizing it fixes THIS tool's own artifact rather
        // than overriding a human's choice.
        const nameLine = fm.find((line) => line.startsWith('name:'));
        if (nameLine === undefined || !/^name:\s*\[\[.+\]\]\s*$/.test(nameLine)) continue;
        adopted.push(slug);
        if (options.dryRun === true) continue;
        const node = loadStoredFeature(flowDir, slug, raw);
        node.name = deriveNameFromBody(node.body, slug);
        persistFeatureNode(flowDir, node);
        continue;
      }
      adopted.push(slug);
      if (options.dryRun === true) continue;
      persistFeatureNode(flowDir, loadStoredFeature(flowDir, slug, raw));
    }
    return adopted;
  });
}

// ── Parts: a feature's children, learned in their own right ────────────────
//
// A feature's anchors are DIRECTORIES, and a diagram of directories is what the
// board used to show: five boxes reading `src/app/api/chat`, `src/app/sdk/chat`,
// `e2e/tests/chats`. Nobody learns chat that way — you learn the SSE stream, the
// SDK client, the renderers, and how a message travels between them.
//
// A part is one of those: a named piece of the feature with its OWN anchors and
// its OWN learnings, investigated in its own right rather than described in
// passing by whatever pass happened to draw the picture.
//
// PARTS LIVE INSIDE THE PARENT. One file per feature holds everything known
// about it, so a part cannot drift away from the feature it belongs to and the
// board's top level does not fill up with fragments. The section is
// MACHINE-OWNED on exactly the same terms as `## Learned`: hand-written content
// inside it is refused rather than discarded.

/** Heading that opens the machine-owned parts region. */
export const PARTS_HEADING = '## Parts';

/** One child part of a feature. */
export interface FeaturePart {
  /** Human name — "Live events SSE", never a directory. */
  name: string;
  /** One clause on what it is. */
  summary: string;
  /** Repo-relative files/dirs this part is about. What a learn pass reads. */
  anchors: string[];
  /** What was learned about THIS part, in its own right. */
  learnings: Learning[];
  /**
   * The person-owned folder this part lives in (its entry's `home:` line).
   * Written only by `writeFeatureHome`; `writeParts` carries the one on disk
   * through and never takes it from its caller.
   */
  home?: string;
  /**
   * The person-owned role of this part (its entry's `role:` line). No machine
   * path writes it; `writeParts` carries the one on disk through, like `home`.
   */
  role?: string;
  /**
   * The learn-owned role of this part (its entry's `learnedRole:` line). Written
   * by `writeLearnedRole`, or by `writeParts` when its caller passes one.
   */
  learnedRole?: string;
}

/** A body cut into human prose, learnings and parts. */
export interface SplitFeatureBody {
  human: string;
  learned: string | null;
  parts: string | null;
}

const PART_HEADING_RE = /^### (.+)$/;

/**
 * Cut a body into its three regions.
 *
 * `## Parts` must come last, so `## Learned` keeps the boundary rules it
 * already has. A body with neither section is all human, which is what every
 * feature file written before parts existed looks like.
 */
export function splitParts(body: string): SplitFeatureBody {
  const lines = body.split('\n');
  const at = lines.findIndex((line) => line.trim() === PARTS_HEADING);
  if (at === -1) {
    const split = splitLearned(body);
    return { human: split.human, learned: split.learned, parts: null };
  }
  const above = lines.slice(0, at).join('\n');
  const split = splitLearned(above);
  return { human: split.human, learned: split.learned, parts: lines.slice(at + 1).join('\n') };
}

/**
 * Read the parts back.
 *
 * A part is a `### <name>` block: an optional lead clause, an `anchors:` line,
 * then learnings in the same grammar `## Learned` uses. Anything that does not
 * parse is dropped rather than guessed at — a half-read part would claim
 * knowledge nobody recorded.
 */
export function parseParts(section: string | null): FeaturePart[] {
  if (section === null) return [];
  const parts: FeaturePart[] = [];
  let current: FeaturePart | null = null;
  const learningLines: string[] = [];

  const flush = (): void => {
    if (current === null) return;
    current.learnings = parseLearnings(learningLines.join('\n'));
    parts.push(current);
    learningLines.length = 0;
  };

  for (const line of section.split('\n')) {
    const heading = PART_HEADING_RE.exec(line.trim());
    if (heading !== null) {
      flush();
      current = { name: heading[1].trim(), summary: '', anchors: [], learnings: [] };
      continue;
    }
    if (current === null) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith(`${HOME_KEY}:`)) {
      const home = homeValueOf(trimmed.slice(HOME_KEY.length + 1));
      if (home !== null) current.home = home;
      continue;
    }
    if (trimmed.startsWith(`${LEARNED_ROLE_KEY}:`)) {
      const learned = roleValueOf(trimmed.slice(LEARNED_ROLE_KEY.length + 1));
      if (learned !== null) current.learnedRole = learned;
      continue;
    }
    if (trimmed.startsWith(`${ROLE_KEY}:`)) {
      const role = roleValueOf(trimmed.slice(ROLE_KEY.length + 1));
      if (role !== null) current.role = role;
      continue;
    }
    if (trimmed.startsWith('anchors:')) {
      current.anchors = trimmed
        .slice('anchors:'.length)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      continue;
    }
    if (trimmed.startsWith('- ')) {
      learningLines.push(line);
      continue;
    }
    if (trimmed.length > 0 && current.summary.length === 0) current.summary = trimmed;
  }
  flush();
  return parts;
}

/** Render the parts region. Deterministic: same parts in, same bytes out. */
export function serializeParts(parts: readonly FeaturePart[]): string {
  return parts
    .map((part) => {
      const head = `### ${part.name}`;
      const summary = part.summary.trim().length > 0 ? `\n${part.summary.trim()}` : '';
      const anchors = part.anchors.length > 0 ? `\nanchors: ${part.anchors.join(', ')}` : '';
      const home = part.home !== undefined && part.home.length > 0 ? `\n${HOME_KEY}: ${part.home}` : '';
      const role = part.role !== undefined && part.role.length > 0 ? `\n${ROLE_KEY}: ${part.role}` : '';
      const learnedRole =
        part.learnedRole !== undefined && part.learnedRole.length > 0 ? `\n${LEARNED_ROLE_KEY}: ${part.learnedRole}` : '';
      const learned =
        part.learnings.length > 0 ? `\n\n${serializeLearnings(part.learnings)}`.replace(/\n+$/, '\n') : '\n';
      return `${head}${summary}${anchors}${home}${role}${learnedRole}\n${learned}`.replace(/\n{3,}/g, '\n\n');
    })
    .join('\n');
}

/**
 * Replace a feature's parts region, leaving human prose and `## Learned`
 * untouched.
 *
 * Re-reads from disk for the same reason `writeLearned` does: the caller's copy
 * may be minutes old, and a learn pass running against a stale body would drop
 * whatever was written in between.
 */
export function writeParts(flowDir: string, slug: string, parts: readonly FeaturePart[]): void {
  const filePath = join(featuresDir(flowDir), `${slug}.md`);
  return withFeatureStoreLock(flowDir, () => {
    if (!existsSync(filePath)) {
      throw new Error(`no feature '${slug}' to write parts to`);
    }
    const node = loadStoredFeature(flowDir, slug, readFileSync(filePath, 'utf-8'));
    const split = splitParts(node.body);
    // A part's `home:` is PERSON-OWNED: the one on disk survives this machine
    // write, matched by the part's address (its slugified name), and whatever
    // the caller passed is ignored.
    //
    // A part's `role:` is person-owned on exactly the same terms. Its
    // `learnedRole:` is the caller's to give — a learn pass that decided one
    // replaces it — but a caller that passes NONE keeps the one on disk: a
    // re-derive of parts from an old view knows nothing about roles, and
    // knowing nothing is not a reason to erase what learn concluded.
    const onDisk = new Map<string, FeaturePart>();
    for (const part of parseParts(split.parts)) {
      onDisk.set(slugifyFeatureName(part.name.trim()), part);
    }
    const written = parts.map((part) => {
      const kept: FeaturePart = { name: part.name, summary: part.summary, anchors: part.anchors, learnings: part.learnings };
      const disk = onDisk.get(slugifyFeatureName(part.name.trim()));
      const learnedRole = part.learnedRole ?? disk?.learnedRole;
      return {
        ...kept,
        ...(disk?.home === undefined ? {} : { home: disk.home }),
        ...(disk?.role === undefined ? {} : { role: disk.role }),
        ...(learnedRole === undefined ? {} : { learnedRole }),
      };
    });
    const above =
      split.learned === null
        ? split.human.replace(/\s*$/, '\n')
        : `${split.human.replace(/\s*$/, '')}\n\n${LEARNED_HEADING}\n${serializeLearnings(parseLearnings(split.learned))}`;
    const body = `${above.replace(/\s*$/, '')}\n\n${PARTS_HEADING}\n\n${serializeParts(written)}`;
    persistFeatureNode(flowDir, { ...node, body });
  });
}

/** Read a feature's parts. Empty when it has none — never an error. */
export function readParts(flowDir: string, slug: string): FeaturePart[] {
  const filePath = join(featuresDir(flowDir), `${slug}.md`);
  if (!existsSync(filePath)) return [];
  try {
    const node = parseFeatureFile(slug, readFileSync(filePath, 'utf-8'));
    return parseParts(splitParts(node.body).parts);
  } catch {
    return [];
  }
}

/**
 * Merge ONE edge whose target lives in ANOTHER project of the Workspace
 * (`<project>/<feature-or-anchor>`) — the mirror half of
 * `workspace link-knowledge` (workspaces-knowledge-hub Phase 5).
 *
 * A SEPARATE door from `writeEdges` on purpose: that one judges targets against
 * THIS store's roster and refuses anything it cannot find, which is exactly
 * right for a learn pass and exactly wrong for a sibling project's feature,
 * which this store can never know. The foreign target must name its project
 * (it carries a `/`); validating that the project is in the Workspace is the
 * caller's job (`handlers/workspace-links.ts`, the one writer). Merged by
 * target like `writeEdges`, so recording the same link twice changes nothing.
 * Returns the feature's full edge list after the write.
 */
export function writeForeignEdge(flowDir: string, slug: string, edge: FeatureEdge): FeatureEdge[] {
  if (!edge.target.includes('/')) {
    throw new Error(`a foreign edge target names its project (<project>/<ref>), got '${edge.target}'`);
  }
  const filePath = join(featuresDir(flowDir), `${slug}.md`);
  return withFeatureStoreLock(flowDir, () => {
    if (!existsSync(filePath)) {
      throw new Error(`no feature '${slug}' to write edges to`);
    }
    const node = readFeatures(flowDir).find((feature) => feature.slug === slug)
      ?? parseFeatureFile(slug, readFileSync(filePath, 'utf-8'));
    const byTarget = new Map<string, FeatureEdge>();
    for (const existing of node.relates) byTarget.set(existing.target, existing);
    byTarget.set(edge.target, edge);
    const relates = normalizeEdges([...byTarget.values()]);
    writeFeature(flowDir, node, { relates });
    return relates;
  });
}

// ── The person-owned `home:` ────────────────────────────────────────────────
//
// THE ONE WRITER of `home:` (plan `feature-home-folders`, FR-10). It edits the
// one line in place and leaves every other byte of the note as it was —
// comments, key order, CRLF line ends and all — because a home is a person's
// correction to a precious file, not a reason to re-serialize it.

/** Which `home:` line to set: the feature's frontmatter, or one part's entry. */
export type HomeLineTarget = { kind: 'feature' } | { kind: 'part'; featureId: string; partId: string };

/** The result of a home edit on a note's text. */
export interface HomeTextEdit {
  /** The note's new text (identical to the input when nothing changed). */
  text: string;
  /** The home that was there before, or null. */
  previous: string | null;
  /** False when the target part was not found — nothing changed. */
  found: boolean;
}

/**
 * Set (or, with `home` null, clear) the `home:` line of a note's text. Pure.
 *
 * A feature's home sits in the frontmatter, replaced in place or added just
 * above the closing fence (a note with no frontmatter gains one holding only
 * the home). A part's sits in its `## Parts` entry, replaced in place or added
 * below the entry's `anchors:` line — or its heading when it has none. The
 * part is found by the address `addressableParts` mints, so a reference the
 * board handed out names the same entry here.
 */
export function setHomeInText(raw: string, target: HomeLineTarget, home: string | null): HomeTextEdit {
  return setKeyLineInText(raw, HOME_KEY, target, home);
}

/**
 * The one-line, in-place edit behind `setHomeInText`, for any person- or
 * learn-owned key that lives in `extra` and on a part's entry (`home:`,
 * `learnedRole:`). Same placement rules; `key` must be a plain word.
 */
function setKeyLineInText(raw: string, key: string, target: HomeLineTarget, value: string | null): HomeTextEdit {
  const home = value;
  const keyLine = new RegExp(`^${key}:`);
  const lines = raw.split('\n');
  const eol = (index: number): string => (lines[index]?.endsWith('\r') === true ? '\r' : '');
  const bare = (index: number): string => lines[index].replace(/\r$/, '');
  const fenceOpen = lines.length > 0 && bare(0) === FRONTMATTER_FENCE;
  let fenceClose = -1;
  if (fenceOpen) {
    for (let index = 1; index < lines.length; index += 1) {
      if (bare(index) === FRONTMATTER_FENCE) {
        fenceClose = index;
        break;
      }
    }
  }
  const crlf = raw.includes('\r\n') ? '\r' : '';

  /** Replace, delete or insert one line; null `at` means insert at `insertAt`. */
  const edit = (at: number, insertAt: number): HomeTextEdit => {
    const previous = at < 0 ? null : homeValueOf(bare(at).trim().slice(key.length + 1));
    const next = [...lines];
    if (home === null) {
      if (at < 0) return { text: raw, previous: null, found: true };
      next.splice(at, 1);
    } else if (at >= 0) {
      const indent = /^\s*/.exec(lines[at])?.[0] ?? '';
      next[at] = `${indent}${key}: ${home}${eol(at)}`;
    } else {
      next.splice(insertAt, 0, `${key}: ${home}${crlf}`);
    }
    return { text: next.join('\n'), previous, found: true };
  };

  if (target.kind === 'feature') {
    if (!fenceOpen || fenceClose < 0) {
      if (home === null) return { text: raw, previous: null, found: true };
      return { text: `${FRONTMATTER_FENCE}${crlf}\n${key}: ${home}${crlf}\n${FRONTMATTER_FENCE}${crlf}\n${raw}`, previous: null, found: true };
    }
    let at = -1;
    for (let index = 1; index < fenceClose; index += 1) if (keyLine.test(bare(index))) at = index;
    return edit(at, fenceClose);
  }

  // A part: its `### ` heading inside `## Parts` (the first such heading, as `splitParts` reads it).
  const bodyStart = fenceOpen && fenceClose >= 0 ? fenceClose + 1 : 0;
  let partsAt = -1;
  for (let index = bodyStart; index < lines.length; index += 1) {
    if (bare(index).trim() === PARTS_HEADING) {
      partsAt = index;
      break;
    }
  }
  if (partsAt < 0) return { text: raw, previous: null, found: false };
  const headings: Array<{ index: number; name: string }> = [];
  for (let index = partsAt + 1; index < lines.length; index += 1) {
    const heading = PART_HEADING_RE.exec(bare(index).trim());
    if (heading !== null && heading[1].trim().length > 0) headings.push({ index, name: heading[1].trim() });
  }
  const addressed = addressPartNames(target.featureId, headings.map((heading) => heading.name));
  const which = addressed.findIndex((id) => id === target.partId);
  if (which < 0) return { text: raw, previous: null, found: false };
  const start = headings[which].index;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (PART_HEADING_RE.test(bare(index).trim())) {
      end = index;
      break;
    }
  }
  let at = -1;
  let anchorsAt = -1;
  for (let index = start + 1; index < end; index += 1) {
    const trimmed = bare(index).trim();
    if (keyLine.test(trimmed)) at = index;
    else if (trimmed.startsWith('anchors:') && anchorsAt < 0) anchorsAt = index;
  }
  return edit(at, (anchorsAt < 0 ? start : anchorsAt) + 1);
}

/**
 * The address of each part name, in order — the owner's id, `/`, the
 * slugified name (`partNodeId`); a repeat gets `-2`, `-3`. THE rule: the
 * graph's `addressableParts` mints the board's part ids through it, and the
 * home writer finds a part's entry through it, so the two cannot disagree.
 */
export function addressPartNames(featureId: string, names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const base = `${featureId}/${slugifyFeatureName(name.trim())}`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return id;
  });
}

/**
 * Write (or clear) a feature's or a part's `home:` — the store's one writer of
 * it. Holds the store lock; refuses (throws) when the note or the part is gone.
 * Returns the home that was there before.
 */
export function writeFeatureHome(
  flowDir: string,
  slug: string,
  target: HomeLineTarget,
  home: string | null,
): { previous: string | null } {
  const filePath = join(featuresDir(flowDir), `${slug}.md`);
  return withFeatureStoreLock(flowDir, () => {
    if (!existsSync(filePath)) throw new Error(`no feature '${slug}' to write a home to`);
    const raw = readFileSync(filePath, 'utf-8');
    const edited = setHomeInText(raw, target, home);
    if (!edited.found) throw new Error(`no part '${target.kind === 'part' ? target.partId : slug}' in '${slug}'`);
    if (edited.text !== raw) atomicWriteFile(filePath, edited.text);
    return { previous: edited.previous };
  });
}

// ── The learn-owned `learnedRole:` ──────────────────────────────────────────
//
// THE ONE WRITER of `learnedRole:` (plan `feature-type-icons`, FR-3), beside the
// one writer of `home:`. A learn pass decides a role and records it here; the
// vocabulary is checked in code, not in the prompt (allowed-pattern #14), and
// the person's `role:` is never read for writing, never cleared, never moved.

/**
 * Write a feature's — or, with `part`, one part's — `learnedRole:`. Holds the
 * store lock and re-reads the note from disk. Refuses (throws) a role off the
 * list, a missing note, and a part the note does not have. `part` is the part's
 * name or its slugified address segment; the first part it names is written.
 * Returns the learned role that was there before.
 */
export function writeLearnedRole(
  flowDir: string,
  slug: string,
  role: FeatureRole,
  part?: string,
): { previous: string | null } {
  if (!isFeatureRole(role)) {
    throw new Error(`'${String(role)}' is not a feature role — use one of ${FEATURE_ROLES.join(', ')}`);
  }
  const filePath = join(featuresDir(flowDir), `${slug}.md`);
  return withFeatureStoreLock(flowDir, () => {
    if (!existsSync(filePath)) throw new Error(`no feature '${slug}' to write a role to`);
    const raw = readFileSync(filePath, 'utf-8');
    let target: HomeLineTarget = { kind: 'feature' };
    if (part !== undefined) {
      // The part's entry, found by the same address rule the home writer uses;
      // the owner id is only a prefix both sides share, so the slug's own serves.
      const wanted = slugifyFeatureName(part.trim());
      const names = parseParts(splitParts(parseFeatureFile(slug, raw).body).parts)
        .map((entry) => entry.name)
        .filter((name) => name.trim().length > 0);
      const at = names.findIndex((name) => slugifyFeatureName(name.trim()) === wanted);
      if (wanted.length === 0 || at < 0) throw new Error(`no part '${part}' in '${slug}'`);
      const featureId = mintFeatureId(slug);
      target = { kind: 'part', featureId, partId: addressPartNames(featureId, names)[at] };
    }
    // ONE LINE, IN PLACE — like `home:`. Every other byte of the precious note
    // stays as it was, the person's `role:` line included.
    const edited = setKeyLineInText(raw, LEARNED_ROLE_KEY, target, role);
    if (!edited.found) throw new Error(`no part '${part ?? slug}' in '${slug}'`);
    if (edited.text !== raw) atomicWriteFile(filePath, edited.text);
    return { previous: edited.previous };
  });
}
