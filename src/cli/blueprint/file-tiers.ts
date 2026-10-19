/**
 * Trust-tier SIDECAR for the blueprint (trust-tiers Phase 1).
 *
 * Every repo file classifies into a tier — `code` (ground truth), `own`
 * (flow/**, .claude/** — plan-flow's verified store), `claim` (foreign
 * docs/images — unverified statements ABOUT the code), `other`. The map
 * materializes at derive time into `file-tiers.json`. Unlike the drift
 * baseline (`file-stamps.ts`, established once), the tier map is
 * derived/disposable and RECOMPUTED on every derive — classification carries
 * no history worth preserving. What IS precious rides along: claim files can
 * carry an adjudication VERDICT (corroborated/contradicted/unverifiable)
 * recorded by learn passes, and verdicts merge FORWARD across recomputes as
 * long as the doc's content hash still matches the hash it was adjudicated at
 * — a changed doc voids its verdict.
 *
 * Content hash is the ONLY truth (forbidden-pattern #10): a verdict ages with
 * the code it was verified against, and `verdictIsStale` re-hashes both the
 * doc and its verified-against files through the SAME `hashRepoFile` helper
 * every other store uses (allowed-pattern #14 — one file-hashing code path).
 * `recordVerdict` is the ONE verdict write path. Corrupt or missing stores
 * never throw — readers return null, the writer fails soft.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLUEPRINT_DIRNAME, ensureBlueprintDir, hashRepoFile, hashRepoFileWithHint, type RepoFileHashHint } from './store.js';
import { classifyTier, walkRepo } from './extractors/scan.js';
import type { FileTier, RepoScan } from './extractors/scan.js';
import type { BlueprintGraph } from './types.js';

/** The three adjudication outcomes a learn pass can record for a claim file. */
export type TierVerdictKind = 'corroborated' | 'contradicted' | 'unverifiable';

/** One code file a verdict was verified against, hash-stamped at verdict time. */
export interface VerifiedAgainstStamp {
  /** Repo-relative path of the code file consulted. */
  path: string;
  /** SHA-256 hex digest of that file's content at verdict time. */
  contentHash: string;
}

/** Who/what produced a verdict — explicit on every surface (NFR4). */
export type VerdictProvenance = 'user' | 'learn-pass' | 'verify-agent' | 'auto';

/** One extracted, individually-verified claim (doc-verification Phase 1). */
export interface VerdictClaim {
  /** The checkable assertion, verbatim-ish from the doc. */
  claim: string;
  /** This claim's own outcome. */
  outcome: TierVerdictKind;
  /** Code files THIS claim was checked against (subset of the stamps). */
  witnesses: string[];
  /** One-line evidence note for this claim. */
  note?: string;
}

/** An adjudication verdict recorded for a claim file. */
export interface TierVerdict {
  /** The adjudication outcome (with claims[]: the enforced rollup). */
  verdict: TierVerdictKind;
  /** SHA-256 hex digest of the DOC's content at verdict time — a changed doc voids its verdict. */
  docHash: string;
  /** The code files the claim was checked against, hash-stamped at verdict time. */
  verifiedAgainst: VerifiedAgainstStamp[];
  /** ISO 8601 timestamp of when the verdict was recorded. */
  ts: string;
  /** Optional one-line evidence note explaining the verdict. */
  evidence?: string;
  /** Per-claim breakdown (verify-agent runs) — absent on legacy/manual verdicts. */
  claims?: VerdictClaim[];
  /** Verdict origin — absent on legacy records (treated as 'user'). */
  provenance?: VerdictProvenance;
}

/** The rollup rule: any contradicted → contradicted; else any unverifiable →
 *  unverifiable; else corroborated. ONE place (#14). */
export function rollupClaims(claims: readonly VerdictClaim[]): TierVerdictKind {
  if (claims.some((claim) => claim.outcome === 'contradicted')) return 'contradicted';
  if (claims.some((claim) => claim.outcome === 'unverifiable')) return 'unverifiable';
  return 'corroborated';
}

/** One classified repo file: its path, tier, and any adjudication verdict. */
export interface FileTierEntry {
  /** Repo-relative posix path of the file. */
  path: string;
  /** The file's trust tier. */
  tier: FileTier;
  /** Adjudication verdict — claim-tier files only. */
  verdict?: TierVerdict;
}

/** The full tier map written at derive time. */
export interface FileTierStore {
  /** ISO 8601 timestamp of the derive run that produced the map. */
  derivedAt: string;
  /** One entry per repo file the walk found, sorted by `path`. */
  entries: FileTierEntry[];
}

/** Per-tier and per-verdict counts over a tier store. */
export interface TierTallies {
  code: number;
  own: number;
  claim: number;
  other: number;
  verdicts: {
    corroborated: number;
    contradicted: number;
    unverifiable: number;
  };
}

const FILE_TIERS_FILENAME = 'file-tiers.json';
const FILE_TIERS_PREV_FILENAME = 'file-tiers.prev.json';
const FILE_TIERS_TEMP_FILENAME = 'file-tiers.json.tmp';
const JSON_INDENT = 2;

/** The tier values accepted when parsing stored entries. */
const FILE_TIERS: readonly FileTier[] = ['code', 'own', 'claim', 'other'];

/** The verdict kinds accepted when parsing stored verdicts. */
export const TIER_VERDICT_KINDS: readonly TierVerdictKind[] = [
  'corroborated',
  'contradicted',
  'unverifiable',
];

/**
 * Compute the tier map for the repo: ONE `walkRepo` pass classifying every
 * file (the walk's ignore rules apply — hidden and artifact directories never
 * appear). Deterministic: entries are sorted by `path`.
 *
 * Verdict MERGE-FORWARD: for each claim file, a verdict from `previous` is
 * carried only when its `docHash` still equals the file's CURRENT content
 * hash — a changed doc voids its verdict (the claim was adjudicated against
 * content that no longer exists). Only claim files that had a previous
 * verdict are hashed, so the common no-verdict derive stays cheap.
 *
 * Perf inputs (both optional, behavior-identical): `repoScan` reuses a
 * pre-computed `walkRepo` result; `stampHints` (the drift baseline's stamps
 * by path) lets a carried-verdict re-hash short-circuit through
 * `hashRepoFileWithHint` — stat match against the hint's own recorded
 * mtime+size reuses the stored hash, anything else re-hashes content
 * (forbidden-pattern #10: content stays the truth).
 */
export function computeFileTiers(
  repoRoot: string,
  graph: BlueprintGraph,
  previous: FileTierStore | null,
  options: { repoScan?: RepoScan; stampHints?: ReadonlyMap<string, RepoFileHashHint> } = {},
): FileTierStore {
  const previousVerdicts = new Map<string, TierVerdict>();
  if (previous !== null) {
    for (const entry of previous.entries) {
      if (entry.verdict !== undefined) {
        previousVerdicts.set(entry.path, entry.verdict);
      }
    }
  }

  const entries: FileTierEntry[] = [];
  for (const file of (options.repoScan ?? walkRepo(repoRoot)).files) {
    const tier = classifyTier(file);
    const entry: FileTierEntry = { path: file, tier };
    if (tier === 'claim') {
      const carried = previousVerdicts.get(file);
      if (carried !== undefined) {
        const result = hashRepoFileWithHint(repoRoot, file, options.stampHints?.get(file));
        if (result.status === 'ok' && result.contentHash === carried.docHash) {
          entry.verdict = carried;
        }
      }
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return { derivedAt: graph.derivedAt, entries };
}

/**
 * Write the tier map to `file-tiers.json`, rotating any existing map to
 * `file-tiers.prev.json` first (mirrors `writeFileStamps`). The new store
 * lands in a temp file then renamed into place, so readers never observe a
 * partial write. Fail-soft: any I/O error is swallowed — a tier failure must
 * never fail an otherwise-successful derive.
 */
export function writeFileTiers(flowDir: string, store: FileTierStore): void {
  try {
    const blueprintDir = ensureBlueprintDir(flowDir);
    const storePath = join(blueprintDir, FILE_TIERS_FILENAME);
    const prevPath = join(blueprintDir, FILE_TIERS_PREV_FILENAME);
    const tempPath = join(blueprintDir, FILE_TIERS_TEMP_FILENAME);

    writeFileSync(tempPath, `${JSON.stringify(store, null, JSON_INDENT)}\n`, 'utf-8');
    if (existsSync(storePath)) {
      renameSync(storePath, prevPath);
    }
    renameSync(tempPath, storePath);
  } catch {
    // Sanctioned fail-soft: the tier map is derived/disposable — a write
    // failure degrades `tiers` to a cold store, never fails derive.
  }
}

/** Whether a parsed verdict candidate has the full `TierVerdict` shape. */
function isValidVerdict(value: unknown): value is TierVerdict {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<TierVerdict>;
  if (typeof candidate.verdict !== 'string' || !TIER_VERDICT_KINDS.includes(candidate.verdict)) {
    return false;
  }
  if (typeof candidate.docHash !== 'string' || typeof candidate.ts !== 'string') {
    return false;
  }
  if (!Array.isArray(candidate.verifiedAgainst)) {
    return false;
  }
  for (const stamp of candidate.verifiedAgainst) {
    if (
      typeof stamp !== 'object' ||
      stamp === null ||
      typeof (stamp as VerifiedAgainstStamp).path !== 'string' ||
      typeof (stamp as VerifiedAgainstStamp).contentHash !== 'string'
    ) {
      return false;
    }
  }
  if (candidate.evidence !== undefined && typeof candidate.evidence !== 'string') {
    return false;
  }
  // claims[]/provenance are ADDITIVE (doc-verification): tolerate absence,
  // validate shape when present — a bad extension never sinks the verdict's
  // core (the whole-record reject stays for core-field corruption only).
  if (candidate.provenance !== undefined && !['user', 'learn-pass', 'verify-agent', 'auto'].includes(candidate.provenance)) {
    return false;
  }
  if (candidate.claims !== undefined) {
    if (!Array.isArray(candidate.claims)) {
      return false;
    }
    for (const claim of candidate.claims) {
      if (
        typeof claim !== 'object' ||
        claim === null ||
        typeof (claim as VerdictClaim).claim !== 'string' ||
        !TIER_VERDICT_KINDS.includes((claim as VerdictClaim).outcome) ||
        !Array.isArray((claim as VerdictClaim).witnesses)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Read the tier map from `file-tiers.json`. Returns null when the file is
 * missing, empty, corrupt, or shape-invalid — absence of a store must never
 * throw. Shape-invalid entries are dropped; an entry whose verdict is
 * shape-invalid keeps its classification and drops only the verdict (a bad
 * verdict must not sink the file's tier).
 */
export function readFileTiers(flowDir: string): FileTierStore | null {
  const filePath = join(flowDir, BLUEPRINT_DIRNAME, FILE_TIERS_FILENAME);
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (content.length === 0) {
      return null;
    }
    const parsed = JSON.parse(content) as Partial<FileTierStore>;
    if (typeof parsed.derivedAt !== 'string' || !Array.isArray(parsed.entries)) {
      return null;
    }
    const entries: FileTierEntry[] = [];
    for (const candidate of parsed.entries) {
      if (
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof (candidate as FileTierEntry).path !== 'string' ||
        !FILE_TIERS.includes((candidate as FileTierEntry).tier)
      ) {
        continue;
      }
      const raw = candidate as FileTierEntry;
      const entry: FileTierEntry = { path: raw.path, tier: raw.tier };
      if (isValidVerdict(raw.verdict)) {
        entry.verdict = raw.verdict;
      }
      entries.push(entry);
    }
    return { derivedAt: parsed.derivedAt, entries };
  } catch {
    // Corrupt JSON — treat as no store; it is rebuilt on the next derive
    return null;
  }
}

/** Input for `recordVerdict` — one adjudication for one claim file. */
export interface RecordVerdictInput {
  /** Repo-relative path of the claim file being adjudicated. */
  path: string;
  /** The adjudication outcome. */
  verdict: TierVerdictKind;
  /** Repo-relative code paths the claim was checked against. */
  against: string[];
  /** Optional one-line evidence note. */
  evidence?: string;
  /** Per-claim breakdown (verify-agent runs) — verdict must equal its rollup. */
  claims?: VerdictClaim[];
  /** Verdict origin (defaults to 'user' — the manual Docs-tab buttons). */
  provenance?: VerdictProvenance;
}

/** Outcome of a verdict write: `ok`, or a one-line refusal reason. */
export interface RecordVerdictResult {
  ok: boolean;
  reason?: string;
}

/**
 * Record an adjudication verdict for a claim file — the ONE verdict write
 * path (allowed-pattern #14). Refuses (ok:false + reason, nothing written)
 * when no tier store exists, the path is unknown to it, the path is not a
 * claim entry, or the doc itself cannot be hashed. `against` code files that
 * cannot be hashed are skipped (a vanished witness weakens but does not sink
 * the verdict). `now` is injectable for deterministic tests; the write itself
 * goes through the fail-soft `writeFileTiers`.
 */
export function recordVerdict(
  repoRoot: string,
  flowDir: string,
  input: RecordVerdictInput,
  now: Date = new Date(),
): RecordVerdictResult {
  const store = readFileTiers(flowDir);
  if (store === null) {
    return { ok: false, reason: 'no tier store — run `planflow-ai blueprint derive` first' };
  }
  const entry = store.entries.find((candidate) => candidate.path === input.path);
  if (entry === undefined) {
    return { ok: false, reason: `unknown file: ${input.path} — not in the tier store` };
  }
  if (entry.tier !== 'claim') {
    return { ok: false, reason: `not a claim file: ${input.path} (tier: ${entry.tier})` };
  }
  const docHash = hashRepoFile(repoRoot, input.path);
  if (docHash.status !== 'ok') {
    return { ok: false, reason: `cannot hash doc: ${input.path}` };
  }

  const verifiedAgainst: VerifiedAgainstStamp[] = [];
  for (const relPath of input.against) {
    const result = hashRepoFile(repoRoot, relPath);
    if (result.status === 'ok') {
      verifiedAgainst.push({ path: relPath, contentHash: result.contentHash });
    }
  }

  // With a per-claim breakdown the doc verdict IS the rollup — recording a
  // mismatching top-level outcome is refused, never silently corrected.
  if (input.claims !== undefined && input.claims.length > 0) {
    const rolled = rollupClaims(input.claims);
    if (rolled !== input.verdict) {
      return { ok: false, reason: `verdict '${input.verdict}' contradicts its claims rollup '${rolled}'` };
    }
  }
  const verdict: TierVerdict = {
    verdict: input.verdict,
    docHash: docHash.contentHash,
    verifiedAgainst,
    ts: now.toISOString(),
  };
  if (input.evidence !== undefined && input.evidence.length > 0) {
    verdict.evidence = input.evidence;
  }
  if (input.claims !== undefined && input.claims.length > 0) {
    verdict.claims = input.claims.map((claim) => ({
      claim: claim.claim,
      outcome: claim.outcome,
      witnesses: [...claim.witnesses],
      ...(claim.note !== undefined && claim.note.length > 0 ? { note: claim.note } : {}),
    }));
  }
  verdict.provenance = input.provenance ?? 'user';

  const entries = store.entries.map((candidate) =>
    candidate.path === input.path ? { ...candidate, verdict } : candidate,
  );
  writeFileTiers(flowDir, { derivedAt: store.derivedAt, entries });
  return { ok: true };
}

/**
 * Whether an entry's verdict has gone stale against the CURRENT tree: the doc
 * itself changed since adjudication (`docHash` mismatch), or any
 * verified-against code file changed or vanished. A verdict-less entry is
 * never stale. Re-hashes through `hashRepoFile` — content hash is the only
 * truth (forbidden-pattern #10).
 */
export function verdictIsStale(repoRoot: string, entry: FileTierEntry): boolean {
  const verdict = entry.verdict;
  if (verdict === undefined) {
    return false;
  }
  const doc = hashRepoFile(repoRoot, entry.path);
  if (doc.status !== 'ok' || doc.contentHash !== verdict.docHash) {
    return true;
  }
  for (const stamp of verdict.verifiedAgainst) {
    const result = hashRepoFile(repoRoot, stamp.path);
    if (result.status !== 'ok' || result.contentHash !== stamp.contentHash) {
      return true;
    }
  }
  return false;
}

/**
 * Pure per-tier and per-verdict counts over a store. Staleness is deliberately
 * NOT computed here — it re-hashes files, so the `tiers` verb computes it
 * separately and only when asked.
 */
/**
 * Tallies with REVOCATION applied (doc-verification decision #5): a verdict
 * whose doc or witnesses moved counts as unadjudicated — expired trust never
 * shows as a verdict. Re-hashes stamped files, so call it deliberately (the
 * `tiers` verb / Docs-tab read), never on hot paths.
 */
export function tierTalliesWithStaleness(
  repoRoot: string,
  store: FileTierStore,
): TierTallies & { staleVerdicts: number } {
  const base = tierTallies(store);
  let stale = 0;
  for (const entry of store.entries) {
    if (entry.verdict === undefined) continue;
    if (verdictIsStale(repoRoot, entry)) {
      stale += 1;
      base.verdicts[entry.verdict.verdict] -= 1;
    }
  }
  return { ...base, staleVerdicts: stale };
}

export function tierTallies(store: FileTierStore): TierTallies {
  const tallies: TierTallies = {
    code: 0,
    own: 0,
    claim: 0,
    other: 0,
    verdicts: { corroborated: 0, contradicted: 0, unverifiable: 0 },
  };
  for (const entry of store.entries) {
    tallies[entry.tier] += 1;
    if (entry.verdict !== undefined) {
      tallies.verdicts[entry.verdict.verdict] += 1;
    }
  }
  return tallies;
}
