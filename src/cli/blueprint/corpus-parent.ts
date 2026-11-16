/**
 * Which capability a plan or discovery doc belongs to — the corpus parenting.
 *
 * WHY THIS EXISTS (2026-11-15)
 * ============================
 * Parenting used to be one rule: a doc's slug had to CONTAIN a core feature's
 * name (`parentKeyFor`). Docs named after the feature (`plan_chats_x`) linked;
 * docs named after a ticket (`plan_aai_2866_endless_loading`) never did. On a
 * real project, 52 of 78 docs were unparented, so a feature's "Changes &
 * discoveries" read empty while the work about it sat one click away — the
 * Secure Login Token Delivery discovery was about Auth and was not under Auth.
 *
 * Three sources, strongest first, and the first that answers wins:
 *
 *   1. DECLARED — the doc says so: a `**Feature**: <slug>` line, written by
 *      discovery and create-plan when the doc is created. `none` is an answer
 *      too (a new capability), and stops the guesses below.
 *   2. NAME     — the old rule, kept: the slug contains a core's name.
 *   3. CODE     — the files the doc names (its Story anchors, the repo paths in
 *      its prose, and the files its plan's blueprint proposals predicted), each
 *      mapped to the core whose anchors — or whose PARTS' anchors — own it. A
 *      core wins with at least two of those files, at least half of them, and
 *      a strict lead; anything weaker stays unlinked rather than guessed.
 *
 * Measured on that project before writing this: the code vote never disagreed
 * with a name link (0 of 5), and added links only where the doc's files
 * plainly sat in one capability.
 *
 * Pure — the caller reads files; this decides.
 */
import { canonicalKey, parentKeyFor } from './feature-surfaces.js';

/** How a doc got its feature. `null` source = unlinked. */
export type CorpusLinkSource = 'declared' | 'name' | 'code';

/** One core capability, with every repo path it (or one of its parts) anchors. */
export interface CorpusOwner {
  slug: string;
  /** Repo-relative paths, envelope prefixes (`module:`/`file:`) already stripped. */
  paths: readonly string[];
}

/** The decision for one doc. */
export interface CorpusLink {
  featureSlug: string | null;
  source: CorpusLinkSource | null;
}

/** A code vote needs at least this many owned files for its winner. */
export const CODE_VOTE_MIN = 2;
/** …and the winner's share of the owned files must reach this. */
export const CODE_VOTE_SHARE = 0.5;

/** `- **Feature**: auth` / `**Feature**: auth, chats` / `**Feature:** none`. */
const DECLARED_LINE = /^\s*(?:[-*]\s+)?\*\*Feature(?:\*\*:|:\*\*)\s*(.+?)\s*$/im;

/**
 * The value of a doc's declared feature line, or null when it has none.
 * Returned raw (trimmed, backticks dropped) — resolution is `resolveDeclared`.
 */
export function declaredFeatureOf(markdown: string): string | null {
  const match = DECLARED_LINE.exec(markdown);
  if (match === null) return null;
  const value = match[1].replace(/`/g, '').trim();
  return value.length === 0 ? null : value;
}

/**
 * Resolve a declared value against the cores. `none` (or `new`) → an explicit
 * "no existing capability". A list resolves to its first known core. An id
 * (`feature:<project>::auth`) and a plain slug both work. Unknown → undefined,
 * so the weaker sources still get their turn.
 */
export function resolveDeclared(
  value: string,
  coreSlugByKey: ReadonlyMap<string, string>,
): { featureSlug: string | null } | undefined {
  const items = value.split(/[,;]/).map((item) => item.trim()).filter((item) => item.length > 0);
  for (const raw of items) {
    const lowered = raw.toLowerCase();
    if (/^(none|new|n\/a)\b/.test(lowered)) return { featureSlug: null };
    const bare = lowered.replace(/^feature:/, '').replace(/^.*::/, '').replace(/\s+—.*$/, '').trim();
    const slug = coreSlugByKey.get(canonicalKey(bare));
    if (slug !== undefined) return { featureSlug: slug };
  }
  return undefined;
}

/** A repo path as written in prose: drop quotes, `./`, line suffixes, trailing punctuation. */
export function normalizeDocPath(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:module|file):/, '')
    .replace(/^\.\//, '')
    .replace(/:\d[\d,\-]*$/, '')
    .replace(/[.,;:)]+$/, '')
    .replace(/\/+$/, '');
}

/** Repo-relative path tokens in prose: something with a slash, no spaces, no scheme. */
const PATH_TOKEN = /(?<![\w./:-])((?:\.\/)?[\w@\-[\]()]+(?:\/[\w@.\-[\]()]+)+)/g;

/** Every path-looking token in a doc. Noise is harmless: only owned paths vote. */
export function docPaths(markdown: string): string[] {
  const found = new Set<string>();
  for (const match of markdown.matchAll(PATH_TOKEN)) {
    const path = normalizeDocPath(match[1]);
    if (path.includes('/') && !path.startsWith('http')) found.add(path);
  }
  return [...found].sort();
}

/**
 * The core owning one path: the longest owned prefix wins (a part's file
 * beats its core's module). Ties on length break on slug for determinism.
 */
export function ownerOf(path: string, owners: readonly CorpusOwner[]): string | null {
  let best: { slug: string; length: number } | null = null;
  for (const owner of owners) {
    for (const owned of owner.paths) {
      const prefix = owned.replace(/\/+$/, '');
      if (prefix.length === 0) continue;
      if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
      if (
        best === null ||
        prefix.length > best.length ||
        (prefix.length === best.length && owner.slug < best.slug)
      ) {
        best = { slug: owner.slug, length: prefix.length };
      }
    }
  }
  return best?.slug ?? null;
}

/** The code vote over a doc's files. Null when no core clearly wins. */
export function codeVote(paths: readonly string[], owners: readonly CorpusOwner[]): string | null {
  const votes = new Map<string, number>();
  for (const path of new Set(paths)) {
    const owner = ownerOf(path, owners);
    if (owner !== null) votes.set(owner, (votes.get(owner) ?? 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) return null;
  const total = ranked.reduce((sum, [, count]) => sum + count, 0);
  const [winner, count] = ranked[0];
  if (count < CODE_VOTE_MIN) return null;
  if (count / total < CODE_VOTE_SHARE) return null;
  if (ranked.length > 1 && ranked[1][1] === count) return null;
  return winner;
}

/** Decide one doc's feature from the three sources, strongest first. */
export function linkCorpusDoc(input: {
  slug: string;
  markdown: string;
  /** Files this doc's plan predicted through blueprint proposals. */
  proposalPaths: readonly string[];
  /** The doc's Story anchors, envelope form. */
  anchors: readonly string[];
  coreKeys: readonly string[];
  coreSlugByKey: ReadonlyMap<string, string>;
  owners: readonly CorpusOwner[];
}): CorpusLink {
  const declared = declaredFeatureOf(input.markdown);
  if (declared !== null) {
    const resolved = resolveDeclared(declared, input.coreSlugByKey);
    if (resolved !== undefined) return { featureSlug: resolved.featureSlug, source: 'declared' };
  }
  const nameKey = parentKeyFor(input.slug, input.coreKeys);
  const byName = nameKey === null ? undefined : input.coreSlugByKey.get(nameKey);
  if (byName !== undefined) return { featureSlug: byName, source: 'name' };

  const paths = [
    ...docPaths(input.markdown),
    ...input.anchors.map(normalizeDocPath),
    ...input.proposalPaths.map(normalizeDocPath),
  ];
  const byCode = codeVote(paths, input.owners);
  if (byCode !== null) return { featureSlug: byCode, source: 'code' };
  return { featureSlug: null, source: null };
}

/** Totals for the derive line: how many docs linked, and how. */
export interface CorpusLinkStats {
  docs: number;
  declared: number;
  name: number;
  code: number;
  unlinked: number;
}

export function corpusLinkStats(links: readonly CorpusLink[]): CorpusLinkStats {
  const stats: CorpusLinkStats = { docs: links.length, declared: 0, name: 0, code: 0, unlinked: 0 };
  for (const link of links) {
    if (link.featureSlug === null) stats.unlinked += 1;
    else if (link.source !== null) stats[link.source] += 1;
  }
  return stats;
}
