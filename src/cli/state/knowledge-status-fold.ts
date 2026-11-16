/**
 * THE PURE HALF OF KNOWLEDGE STATUS — one fold, one resolver, one record parser.
 *
 * `knowledge-status-log.ts` (the writer and the CLI's reader) and the app's
 * main process (`app/src/shared/knowledge-status.ts`, which re-exports this
 * file) must answer "is this item draft or solid?" identically. Two copies of
 * the fold would drift, so the rule lives here once — the precedent
 * `understood.ts` and `feature-role.ts` set (allowed-pattern #14).
 *
 * Pure, NO imports, no I/O: the app's CommonJS jest and the CLI's ESM build
 * both compile it as-is. Hashing is the one thing it cannot do without an
 * import, so the provenance parser takes the digest as an argument.
 *
 * The rules themselves are documented in `knowledge-status-log.ts` (the order-
 * free fold, the timestamp rule, item ids) and `knowledge-provenance.ts` (the
 * content-addressed record store).
 */

/** A provenance reference: the first 16 hex characters of the record digest. */
export const LEARNED_AT_RE = /^[0-9a-f]{16}$/;

export const KNOWLEDGE_STATUSES = ['solid', 'draft', 'stale', 'abandoned'] as const;
export type KnowledgeStatusValue = (typeof KNOWLEDGE_STATUSES)[number];

export const KNOWLEDGE_ITEM_KINDS = ['learning', 'part-learning', 'note', 'view'] as const;
export type KnowledgeItemKind = (typeof KNOWLEDGE_ITEM_KINDS)[number];

const ITEM_ID_RE = /^[0-9a-f]{16}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REASON_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** One cited file and its content digest at stamping time. */
export interface ProvenanceHash {
  /** Repo-relative, `/`-separated. */
  path: string;
  /** `hashFileContent` of the working-tree bytes. */
  contentHash: string;
}

/** Where a piece of knowledge was learned. */
export interface KnowledgeProvenance {
  /** The checked-out branch, or null when HEAD is detached / not a checkout. */
  branch: string | null;
  /** HEAD's commit, or null when not a checkout / unborn branch. */
  commit: string | null;
  /**
   * HEAD is the default branch's tip or an ancestor of it. Null when that
   * cannot be answered (no default branch found, git refused).
   */
  onDefault: boolean | null;
  /** Cited files that hashed, sorted by path. Directories and missing files are skipped. */
  hashes: ProvenanceHash[];
}

/** One line of the status log. */
export interface KnowledgeStatusEntry {
  /** `knowledgeItemId` of the item. */
  item: string;
  status: KnowledgeStatusValue;
  /** The branch the item was learned on, when known. */
  branch: string | null;
  /** The commit that is the evidence (the default-branch commit for a promotion). */
  commit: string | null;
  /** Short code for why — `ancestor`, `hashes-match`, `pr-merged`, `branch-gone`, … */
  reason: string;
  /** ISO-8601 time of the evidence — never the writer's clock. */
  ts: string;
}

/** What the fold says about one item. */
export interface FoldedKnowledgeStatus {
  status: 'solid' | 'draft' | 'abandoned';
  /** Promoted, but the default branch changed the cited files since (FR-5). */
  stale: boolean;
  /** The winning line. */
  entry: KnowledgeStatusEntry;
}

/** The answer readers use. */
export interface ResolvedItemStatus {
  status: 'solid' | 'draft' | 'abandoned';
  stale: boolean;
  /** The branch the item was learned on, when known — what a draft tag names. */
  branch: string | null;
}

/** Thrown by the writer for an entry outside the vocabulary. Nothing is written. */
export class KnowledgeStatusRefusal extends Error {
  constructor(readonly reason: string) {
    super(`knowledge status refused: ${reason}`);
    this.name = 'KnowledgeStatusRefusal';
  }
}

/** The text `knowledgeItemId` digests: `kind \0 scope \0 text \0 learnedAt`. */
export function knowledgeItemIdInput(input: {
  kind: KnowledgeItemKind;
  scope: string;
  text: string;
  learnedAt?: string | null;
}): string {
  return [input.kind, input.scope, input.text, input.learnedAt ?? ''].join('\u0000');
}

/** Validate and normalise an entry, or say why not. */
export function normalizeKnowledgeStatusEntry(entry: unknown): KnowledgeStatusEntry | string {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 'an entry must be an object';
  const raw = entry as Record<string, unknown>;
  if (typeof raw.item !== 'string' || !ITEM_ID_RE.test(raw.item)) return 'item must be a 16-hex item id';
  if (!KNOWLEDGE_STATUSES.includes(raw.status as KnowledgeStatusValue)) {
    return `status must be one of ${KNOWLEDGE_STATUSES.join('|')}`;
  }
  if (raw.branch !== null && (typeof raw.branch !== 'string' || raw.branch.trim() === '' || /[\n\r]/.test(raw.branch))) {
    return 'branch must be a branch name or null';
  }
  if (raw.commit !== null && (typeof raw.commit !== 'string' || !COMMIT_RE.test(raw.commit))) {
    return 'commit must be a full commit id or null';
  }
  if (typeof raw.reason !== 'string' || !REASON_RE.test(raw.reason)) return 'reason must be a short lowercase code';
  if (typeof raw.ts !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(raw.ts) || Number.isNaN(Date.parse(raw.ts))) {
    return 'ts must be an ISO-8601 time';
  }
  return {
    item: raw.item,
    status: raw.status as KnowledgeStatusValue,
    branch: raw.branch === null ? null : (raw.branch as string),
    commit: raw.commit === null ? null : (raw.commit as string),
    reason: raw.reason,
    ts: new Date(raw.ts).toISOString(),
  };
}

/** The one line an entry is written as: fixed key order, normalised ts. */
export function knowledgeStatusLine(entry: KnowledgeStatusEntry): string {
  const normalized = normalizeKnowledgeStatusEntry(entry);
  if (typeof normalized === 'string') throw new KnowledgeStatusRefusal(normalized);
  return JSON.stringify({
    item: normalized.item,
    status: normalized.status,
    branch: normalized.branch,
    commit: normalized.commit,
    reason: normalized.reason,
    ts: normalized.ts,
  });
}

const OUTRANKS_DRAFT: ReadonlySet<KnowledgeStatusValue> = new Set(['solid', 'stale', 'abandoned']);

/** Total order: newer ts wins, then the larger canonical line. */
function newer(a: { entry: KnowledgeStatusEntry; line: string }, b: { entry: KnowledgeStatusEntry; line: string }): boolean {
  if (a.entry.ts !== b.entry.ts) return a.entry.ts > b.entry.ts;
  return a.line > b.line;
}

/**
 * Fold raw log lines into one answer per item. Invalid lines are skipped.
 * Deterministic for any order of the same lines (see `knowledge-status-log.ts`).
 */
export function foldKnowledgeStatus(lines: readonly string[]): Map<string, FoldedKnowledgeStatus> {
  const best = new Map<string, { entry: KnowledgeStatusEntry; line: string }>();
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const entry = normalizeKnowledgeStatusEntry(parsed);
    if (typeof entry === 'string') continue;
    const candidate = { entry, line: knowledgeStatusLine(entry) };
    const current = best.get(entry.item);
    if (current === undefined) {
      best.set(entry.item, candidate);
      continue;
    }
    const candidateRank = OUTRANKS_DRAFT.has(entry.status) ? 1 : 0;
    const currentRank = OUTRANKS_DRAFT.has(current.entry.status) ? 1 : 0;
    if (candidateRank > currentRank || (candidateRank === currentRank && newer(candidate, current))) {
      best.set(entry.item, candidate);
    }
  }
  const out = new Map<string, FoldedKnowledgeStatus>();
  for (const [item, { entry }] of best) {
    out.set(item, {
      status: entry.status === 'stale' ? 'solid' : entry.status,
      stale: entry.status === 'stale',
      entry,
    });
  }
  return out;
}

/**
 * What an item's provenance says about it:
 * - `unstamped` — no `learnedAt` (written before stamping existed, or outside
 *   a checkout);
 * - `stamped` — a `learnedAt` and its record, or `provenance: null` when the
 *   record has not reached this machine.
 */
export type ItemStamp = { kind: 'unstamped' } | { kind: 'stamped'; provenance: KnowledgeProvenance | null };

/** Build an `ItemStamp` from an item's `learnedAt` and the record store. */
export function itemStampOf(
  learnedAt: string | null | undefined,
  records: ReadonlyMap<string, KnowledgeProvenance>,
): ItemStamp {
  if (typeof learnedAt !== 'string' || !LEARNED_AT_RE.test(learnedAt)) return { kind: 'unstamped' };
  return { kind: 'stamped', provenance: records.get(learnedAt) ?? null };
}

/**
 * THE status resolver — the one place an item's status is decided:
 *
 * 1. no provenance → solid (FR-13: existing knowledge starts solid; the
 *    staleness check re-hashes it as before);
 * 2. the log has an outranking line (solid / stale / abandoned) → that;
 * 3. stamped on the default branch → solid;
 * 4. anything else stamped — another branch, an unanswerable default branch,
 *    or a record not here yet → draft. Nothing is promoted on a guess.
 */
export function resolveItemStatus(stamp: ItemStamp, folded: FoldedKnowledgeStatus | undefined): ResolvedItemStatus {
  if (stamp.kind === 'unstamped') return { status: 'solid', stale: false, branch: null };
  const branch = stamp.provenance?.branch ?? folded?.entry.branch ?? null;
  if (folded !== undefined && folded.status !== 'draft') {
    return { status: folded.status, stale: folded.stale, branch };
  }
  if (stamp.provenance?.onDefault === true) return { status: 'solid', stale: false, branch };
  return { status: 'draft', stale: false, branch };
}

// ── Provenance records ──────────────────────────────────────────────────────

/** Canonical bytes of a record (without its id): fixed key order, sorted hashes. */
export function canonicalProvenanceBody(provenance: KnowledgeProvenance): string {
  return JSON.stringify({
    branch: provenance.branch,
    commit: provenance.commit,
    onDefault: provenance.onDefault,
    hashes: [...provenance.hashes]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((hash) => ({ path: hash.path, contentHash: hash.contentHash })),
  });
}

/**
 * Parse one record line, or null. `sha256Hex` is the digest the id is minted
 * with (the CLI's `hashFileContent`); a line whose id does not match its body
 * was not written by the record writer and is skipped.
 */
export function parseProvenanceRecordLine(
  line: string,
  sha256Hex: (text: string) => string,
): [string, KnowledgeProvenance] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || !LEARNED_AT_RE.test(record.id)) return null;
  const nullableString = (value: unknown): string | null | undefined =>
    value === null ? null : typeof value === 'string' ? value : undefined;
  const branch = nullableString(record.branch);
  const commit = nullableString(record.commit);
  if (branch === undefined || commit === undefined) return null;
  const onDefault = record.onDefault === true ? true : record.onDefault === false ? false : null;
  const hashes = Array.isArray(record.hashes)
    ? record.hashes.flatMap((entry): ProvenanceHash[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const item = entry as Record<string, unknown>;
        return typeof item.path === 'string' && typeof item.contentHash === 'string'
          ? [{ path: item.path, contentHash: item.contentHash }]
          : [];
      })
    : [];
  const provenance: KnowledgeProvenance = { branch, commit, onDefault, hashes };
  if (sha256Hex(canonicalProvenanceBody(provenance)).slice(0, 16) !== record.id) return null;
  return [record.id, provenance];
}

/** Every record in a store's text, by id; the first line for an id wins. */
export function parseProvenanceRecords(
  text: string,
  sha256Hex: (text: string) => string,
): Map<string, KnowledgeProvenance> {
  const out = new Map<string, KnowledgeProvenance>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseProvenanceRecordLine(line, sha256Hex);
    if (parsed !== null && !out.has(parsed[0])) out.set(parsed[0], parsed[1]);
  }
  return out;
}

// ── Readers ─────────────────────────────────────────────────────────────────

/** An item as a reader names it. */
export interface KnowledgeItemRef {
  kind: KnowledgeItemKind;
  scope: string;
  text: string;
  learnedAt?: string | null;
}

/**
 * What every reader asks: the status of one item. Built ONCE per read from the
 * folded log and the records, so a graph of a hundred features reads the two
 * files once. `itemId` is the digest `knowledgeItemId` uses, injected for the
 * same reason the provenance parser takes one.
 */
export interface KnowledgeStatusReader {
  of(item: KnowledgeItemRef): ResolvedItemStatus;
}

export function knowledgeStatusReaderFrom(
  folded: ReadonlyMap<string, FoldedKnowledgeStatus>,
  records: ReadonlyMap<string, KnowledgeProvenance>,
  itemId: (item: KnowledgeItemRef) => string,
): KnowledgeStatusReader {
  return {
    of(item) {
      const stamp = itemStampOf(item.learnedAt, records);
      // Unstamped is solid whatever the log says — skip the digest.
      if (stamp.kind === 'unstamped') return resolveItemStatus(stamp, undefined);
      return resolveItemStatus(stamp, folded.get(itemId(item)));
    },
  };
}

/**
 * The status of a NODE from its items' statuses — what the board tags:
 * `solid` when any item is solid or there is nothing stamped at all; `draft`
 * when every live item is a draft, carrying the newest-listed draft's branch.
 * Abandoned items count for nothing.
 */
export function nodeKnowledgeStatus(
  items: ReadonlyArray<Pick<ResolvedItemStatus, 'status' | 'branch'>>,
): { status: 'solid' | 'draft'; draftBranch: string | null } {
  const live = items.filter((item) => item.status !== 'abandoned');
  if (live.length === 0 || live.some((item) => item.status === 'solid')) return { status: 'solid', draftBranch: null };
  const branch = [...live].reverse().find((item) => item.branch !== null)?.branch ?? null;
  return { status: 'draft', draftBranch: branch };
}

/** A default-branch ref (`refs/remotes/origin/main`) as a person names it (`main`). */
export function branchDisplayName(ref: string): string {
  return ref.replace(/^refs\/remotes\/[^/]+\//, '').replace(/^refs\/heads\//, '');
}
