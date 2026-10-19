/**
 * File-based brain search — the replacement for the `.brain.sqlite` index.
 *
 * THE WHOLE STORE IS 5.2 MB OF MARKDOWN. Answering a question over it does not
 * need 137 MB of embedding runtime, a 41.7 MB derived database per project, or
 * a native-module version conflict; it needs ripgrep and a scorer. This module
 * is that: a candidate pass (ripgrep, with a pure-JS fallback so a machine
 * without `rg` degrades in speed and never in answers), a heading-aware
 * chunker, and a deterministic ranker.
 *
 * Two legs, fused by the SAME `mergeLayers` the index path uses:
 *
 * 1. **content** — token frequency over the chunk body, weighted by how many
 *    DISTINCT query terms the chunk covers. Coverage is what separates "the
 *    chunk that mentions playbooks forty times" from "the chunk that mentions
 *    playbooks AND skills", and the second is the answer.
 * 2. **titles** — the same scoring over the heading and the file path only.
 *    A chunk that is strong in both legs is a chunk whose SUBJECT is the
 *    question rather than a chunk that merely says the words, which is exactly
 *    the agreement signal RRF exists to reward.
 *
 * The symbols leg is untouched and keeps working: it reads
 * `flow/brain/.structure/symbols.jsonl`, which was never in the index.
 *
 * DETERMINISM: same corpus + same query → same ranking, always. Every sort has
 * an explicit tiebreak on (file, heading), no map iteration order reaches a
 * result, and no clock is read. A search that reorders its own answers between
 * runs cannot be compared against anything, including its predecessor.
 *
 * FAIL-SOFT, like every layer it replaces: a missing directory, an unreadable
 * file, or an absent ripgrep collapses that contribution to nothing and never
 * raises.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ChunkHit } from './brain-search-core.js';

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/**
 * The markdown the brain answers from, in scan order.
 *
 * This is the same set the sqlite index ingested (`.claude/resources`,
 * `.claude/rules`, `flow/brain`, `flow/plans`, `flow/discovery`, `CLAUDE.md`)
 * plus `flow/brainstorms`, which the index quietly omitted even though every
 * discovery in this repo starts life as one.
 */
export const CORPUS_ROOTS: readonly string[] = [
  'flow/brain',
  'flow/plans',
  'flow/discovery',
  'flow/brainstorms',
  '.claude/resources',
  '.claude/rules',
  'CLAUDE.md',
];

/**
 * Never scanned, in any scope.
 *
 * `.raw/` is the tier boundary: auto-captured working-set drafts are untrusted
 * and un-indexed, and a grep that reads them would smuggle them into answers
 * through the back door the index closed at the front. `.structure/` and
 * `.derived/graph`-shaped output are machine JSON, not prose — except INDEX.md,
 * which is added back explicitly below because it is the relational layer.
 * `archive/` is historical noise for every caller (the index excluded it too).
 */
export const CORPUS_EXCLUDED_DIRS: readonly string[] = [
  'flow/brain/.raw',
  'flow/brain/.structure',
  'flow/archive',
  'node_modules',
];

/** Where the generated feature index lives, repo-relative. */
export const FEATURE_INDEX_PATH = 'flow/brain/.derived/INDEX.md';

/** Cap on files read per search — sorted first, so the cut is deterministic. */
const MAX_CANDIDATE_FILES = 400;
/** Cap on chunks returned per leg, before the merge. */
const LEG_CAP = 40;
/** Below this length a token is noise in a prose corpus. */
const MIN_TOKEN_LENGTH = 3;

/**
 * Words that appear in nearly every chunk of an engineering corpus AND in
 * nearly every question asked of it. Dropped from the query only — a chunk is
 * never rewritten, so `--full` still shows exactly what the file says.
 *
 * Kept deliberately short. An aggressive stoplist throws away the one term that
 * made a question specific ("what enforces the raw boundary" has to keep
 * "enforces"), and the coverage weighting already handles common words by
 * giving them low discriminating power.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'been', 'being', 'that', 'this',
  'these', 'those', 'with', 'from', 'into', 'does', 'did', 'has', 'have', 'had',
  'how', 'what', 'where', 'which', 'who', 'whom', 'why', 'when', 'its',
  'a', 'an', 'is', 'it', 'to', 'of', 'in', 'on', 'at', 'by', 'or', 'as', 'be',
  // Auxiliaries, added after the side-by-side comparison measured the damage:
  // "where does a turn GET persisted" ranked a `GET /users` contract example
  // first, because `get` is a real word in an API corpus and pure grammar in
  // the question. These carry no subject in either half of that sentence.
  'get', 'gets', 'got', 'can', 'will', 'not', 'all', 'any', 'out', 'but', 'do',
]);

/**
 * Split a query into scoring tokens: lowercased, deduped, stopwords dropped,
 * order preserved.
 *
 * If EVERY token is a stopword the stoplist is abandoned rather than returning
 * nothing — a question made entirely of common words is still a question, and
 * answering it badly beats answering "no hits" to something the corpus covers.
 */
export function queryTokens(query: string): string[] {
  const raw = [...new Set(
    query
      .split(/[^A-Za-z0-9_]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= MIN_TOKEN_LENGTH),
  )];
  const kept = raw.filter((token) => !STOPWORDS.has(token));
  return kept.length > 0 ? kept : raw;
}

/** How many leading characters of a token survive stemming. */
const STEM_LENGTH = 5;

/**
 * Fold a token to the prefix that is matched against the corpus.
 *
 * TRUNCATION, NOT A SUFFIX STRIPPER, and the difference is the whole reason
 * this works. A stripper has to be applied to BOTH sides to be symmetric —
 * "boundary" and "boundaries" only meet if the document is tokenized and folded
 * too, which means building the index this change exists to delete. Truncating
 * both to `bounda…`-length lets a raw substring scan do the same job:
 * `boundary`, `boundaries`, `persisted`/`persists`/`persistence`,
 * `enforce`/`enforced`/`enforces` and `skill`/`skills` all collapse to one
 * prefix, and no dictionary is needed to get there.
 *
 * The prefix is anchored at a WORD BOUNDARY when it is matched, which is the
 * other half. Unanchored, `raw` matches `drawer` — measured on this repo's own
 * corpus, where "what enforces the .raw boundary" returned five hits about a
 * component drawer and not one about the tier boundary.
 */
export function stemToken(token: string): string {
  return token.length <= STEM_LENGTH ? token : token.slice(0, STEM_LENGTH);
}

/** The stems a query is matched by — deduped, order preserved. */
export function queryStems(query: string): string[] {
  return [...new Set(queryTokens(query).map(stemToken))];
}

// ---------------------------------------------------------------------------
// Candidate files
// ---------------------------------------------------------------------------

/**
 * Where a corpus-relative path lives on disk. Paths are always spelled the way
 * the corpus spells them (`flow/brain/…`); `flowDir`, when given, is where
 * `flow/` actually is — a Workspace sibling's knowledge folder, which no
 * checkout links to on this machine (workspaces-knowledge-hub Phase 5).
 */
export type CorpusResolver = (relPath: string) => string;

export function corpusResolver(projectRoot: string, flowDir?: string): CorpusResolver {
  if (flowDir === undefined) return (relPath) => join(projectRoot, relPath);
  return (relPath) => {
    if (relPath === 'flow') return flowDir;
    if (relPath.startsWith('flow/')) return join(flowDir, relPath.slice('flow/'.length));
    return join(projectRoot, relPath);
  };
}

function isExcluded(relPath: string): boolean {
  const posix = relPath.split(sep).join('/');
  return CORPUS_EXCLUDED_DIRS.some((dir) => posix === dir || posix.startsWith(`${dir}/`));
}

/**
 * Walk one root for markdown, following the top-level `flow` symlink the way
 * every other reader in this codebase does (the vault layout makes `flow` a
 * link, and a walker that refuses links would find an empty brain).
 */
function walkMarkdown(at: CorpusResolver, root: string, out: string[]): void {
  const absolute = at(root);
  let stat;
  try {
    stat = statSync(absolute); // statSync follows symlinks — deliberate
  } catch {
    return; // a root this project does not have is not an error
  }
  if (stat.isFile()) {
    if (absolute.endsWith('.md')) out.push(root);
    return;
  }
  if (!stat.isDirectory()) return;

  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const child = `${root}/${entry.name}`;
    if (isExcluded(child)) continue;
    // `withFileTypes` reports a symlink as a link, not as what it points at, so
    // recurse on anything that is not plainly a file and let statSync decide.
    if (entry.isFile()) {
      if (entry.name.endsWith('.md')) out.push(child);
    } else {
      walkMarkdown(at, child, out);
    }
  }
}

/** Every markdown file in the corpus, repo-relative and sorted. */
export function listCorpusFiles(
  projectRoot: string,
  roots: readonly string[] = CORPUS_ROOTS,
  flowDir?: string,
): string[] {
  const at = corpusResolver(projectRoot, flowDir);
  const out: string[] = [];
  for (const root of roots) walkMarkdown(at, root, out);
  // The generated index is inside an excluded-by-default derived directory, so
  // it is added back by name: it IS corpus, it is just not hand-written.
  if (!out.includes(FEATURE_INDEX_PATH) && existsSync(at(FEATURE_INDEX_PATH))) {
    out.push(FEATURE_INDEX_PATH);
  }
  return [...new Set(out)].sort();
}

/**
 * Narrow the corpus to files containing at least one query token, using
 * ripgrep.
 *
 * Returns `null` — NOT an empty list — when ripgrep is unavailable or fails,
 * because "rg is not installed" and "nothing matched" are opposite facts and
 * conflating them is how a search silently returns nothing forever. The caller
 * falls back to reading the whole corpus, which on 5.2 MB costs milliseconds.
 */
export function ripgrepCandidates(
  projectRoot: string,
  stems: readonly string[],
  files: readonly string[],
  flowDir?: string,
): string[] | null {
  if (stems.length === 0 || files.length === 0) return null;
  // A relocated `flow/` is searched by absolute path and mapped back, so the
  // answer is spelled in corpus paths whichever folder it was read from.
  const at = flowDir === undefined ? null : corpusResolver(projectRoot, flowDir);
  const back = at === null ? null : new Map(files.map((file) => [at(file), file]));
  // `\b<stem>` — the SAME word-anchored prefix the scorer uses. A narrowing
  // pass that matched more loosely than the scorer would only waste reads; one
  // that matched more tightly would hide chunks the scorer would have ranked,
  // which is a silent recall loss and exactly the failure mode being measured.
  // Stems are `[a-z0-9_]` by construction, so nothing here needs escaping.
  const patterns = stems.flatMap((stem) => ['-e', `\\b${stem}`]);
  try {
    const stdout = execFileSync(
      'rg',
      ['--files-with-matches', '--ignore-case', '--no-messages', ...patterns, '--', ...(back === null ? files : [...back.keys()])],
      { cwd: projectRoot, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    if (back === null) return lines.sort();
    return lines.map((line) => back.get(line)).filter((file): file is string => file !== undefined).sort();
  } catch (error: unknown) {
    // rg exits 1 on "no matches" — a real answer, and an empty list is correct.
    const status = (error as { status?: number }).status;
    if (status === 1) return [];
    return null; // missing binary, bad args, oversized output: fall back
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** One markdown section: everything from a heading to the next one. */
export interface MarkdownChunk {
  file: string;
  heading: string | undefined;
  /** 1-based line of the heading (or 1 for a preamble chunk). */
  line: number;
  text: string;
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*\S)\s*$/;
/**
 * A fenced-code opener (CommonMark): up to three spaces of indent, a run of
 * 3+ backticks or tildes, then an optional info string. A backtick fence's
 * info string may not itself contain a backtick.
 */
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** An open fence: its marker character, run length, and whether it is withheld. */
interface OpenFence {
  char: '`' | '~';
  length: number;
  /** An `html` fence (a walkthrough mockup) never reaches chunk text. */
  omit: boolean;
}

/** Parse a fence opener, or null when the line does not open one. */
function openFence(raw: string): OpenFence | null {
  const match = FENCE_OPEN_PATTERN.exec(raw);
  if (match === null) return null;
  const marker = match[1];
  const info = match[2].trim();
  const char = marker[0] as '`' | '~';
  if (char === '`' && info.includes('`')) return null;
  const language = info.split(/\s+/)[0]?.toLowerCase() ?? '';
  return { char, length: marker.length, omit: language === 'html' };
}

/** True when `raw` closes `fence`: same marker, at least as long, nothing after. */
function closesFence(raw: string, fence: OpenFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
  return match !== null && match[1][0] === fence.char && match[1].length >= fence.length;
}
/** A chunk longer than this is split so one huge section cannot swamp a leg. */
const MAX_CHUNK_LINES = 120;

/**
 * Cut a markdown file into heading-delimited chunks.
 *
 * Headings of ANY level open a chunk, with one exception that matters: the
 * generated INDEX.md is flat by construction (one `##` per feature, bullets
 * underneath), so its features arrive whole — name, summary, parts and edges in
 * one chunk. That is not a special case here; it is why the generator was
 * written flat.
 *
 * A chunk keeps its heading line in its text so the ranked snippet says what
 * the section is, and carries the heading's line number so every hit has a
 * `file:line` pointer — something the chunk-based index could never give.
 *
 * Fenced code is opaque: a `#` line inside a fence is never a heading. And a
 * fence whose info string starts with `html` — an inline markup sample —
 * is left out of the chunk text entirely, fence lines included, so markup
 * never outranks prose in search. Other fences are kept verbatim.
 */
export function chunkMarkdown(file: string, content: string): MarkdownChunk[] {
  const lines = content.split('\n');
  const chunks: MarkdownChunk[] = [];
  let heading: string | undefined;
  let startLine = 1;
  let buffer: string[] = [];

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text !== '') chunks.push({ file, heading, line: startLine, text });
    buffer = [];
  };

  const pushLine = (raw: string, index: number): void => {
    if (buffer.length >= MAX_CHUNK_LINES) {
      // Oversized section: cut it, keeping the heading so the continuation is
      // still attributable, and re-anchor the line number to where it resumes.
      flush();
      startLine = index + 1;
    }
    buffer.push(raw);
  };

  let fence: OpenFence | null = null;

  lines.forEach((raw, index) => {
    if (fence !== null) {
      const omit = fence.omit;
      if (closesFence(raw, fence)) fence = null;
      if (omit) return;
    } else {
      const opened = openFence(raw);
      if (opened !== null) {
        fence = opened;
        if (opened.omit) return;
      } else {
        const match = HEADING_PATTERN.exec(raw);
        if (match !== null) {
          flush();
          heading = match[2];
          startLine = index + 1;
          buffer = [raw];
          return;
        }
      }
    }
    pushLine(raw, index);
  });
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** True when the character before `at` ends a word (so `at` starts one). */
function startsWord(haystack: string, at: number): boolean {
  if (at === 0) return true;
  return !/[A-Za-z0-9_]/.test(haystack[at - 1]);
}

/**
 * Count occurrences of `stem` that BEGIN A WORD, case-insensitively.
 *
 * The anchor is not optional. Unanchored substring counting makes `raw` a hit
 * on every `drawer` in the corpus, `plan` a hit on every `explanation`, and
 * turns a precise question into a ranking of whichever document happens to be
 * longest.
 */
export function countStemMatches(haystackLower: string, stem: string): number {
  if (stem === '') return 0;
  let count = 0;
  let at = haystackLower.indexOf(stem);
  while (at !== -1) {
    if (startsWord(haystackLower, at)) count += 1;
    at = haystackLower.indexOf(stem, at + 1);
  }
  return count;
}

/**
 * How much each stem is worth, from how rare it is in the candidate set.
 *
 * INVERSE DOCUMENT FREQUENCY IS THE DIFFERENCE BETWEEN A RANKING AND A GUESS,
 * and it is the one thing an unweighted grep cannot do. "what enforces the .raw
 * boundary" carries `raw` (rare, and the actual subject) alongside `bound`
 * (which stems from `boundary`, `bound`, `boundaries` and appears in a third of
 * this corpus). Weighted equally, the common word wins on frequency alone and
 * the answer never surfaces — measured on this repo before this was added.
 *
 * `ln(1 + N/df)` over the CANDIDATE set, not the whole corpus: the candidates
 * are what the caller will rank, computing it over them costs one pass we are
 * already making, and no persisted statistics means nothing to keep in sync.
 */
/**
 * The ceiling on one stem's weight.
 *
 * MEASURED, NOT CHOSEN. Uncapped, `ln(1 + N/df)` reaches ~7.6 for a stem in one
 * chunk of two thousand, which lets a single rare word decide the answer on its
 * own. The side-by-side comparison caught this live: "what happens when
 * verification fails twice" ranked five documents that contain the word "twice"
 * and none that describe the retry loop — the target document does not use the
 * word at all, and "twice" was incidental to the question rather than its
 * subject. Capped, the rare term still outranks the common one (a term in a
 * third of the corpus is worth ~1.4) but can no longer outvote covering the
 * rest of the question.
 */
const MAX_STEM_WEIGHT = 2.5;

export function stemWeights(
  chunkTexts: readonly string[],
  stems: readonly string[],
): Map<string, number> {
  const total = Math.max(chunkTexts.length, 1);
  const lowered = chunkTexts.map((text) => text.toLowerCase());
  const weights = new Map<string, number>();
  for (const stem of stems) {
    const df = lowered.reduce(
      (count, text) => count + (countStemMatches(text, stem) > 0 ? 1 : 0),
      0,
    );
    weights.set(stem, Math.min(MAX_STEM_WEIGHT, Math.log(1 + total / Math.max(df, 1))));
  }
  return weights;
}

/**
 * Score one chunk against the query stems.
 *
 * `weight * (1 + ln(tf))` is the saturating term-frequency every text ranker
 * uses — the tenth mention of a word says far less than the second — scaled by
 * how much the term is worth. The COVERAGE factor on top is the part that
 * matters most for the questions this corpus gets asked: a chunk covering three
 * of three query terms beats a chunk that repeats one of them, because a
 * relational question is answered by the document naming BOTH sides of the
 * relation, never by the one that says "playbooks" forty times.
 *
 * Weights default to 1 so the scorer is meaningful (and testable) on its own.
 * Returns 0 for a chunk matching nothing, which the caller drops.
 */
export function scoreChunkText(
  text: string,
  stems: readonly string[],
  weights: ReadonlyMap<string, number> = new Map(),
): number {
  if (stems.length === 0) return 0;
  const lower = text.toLowerCase();
  let sum = 0;
  let covered = 0;
  for (const stem of stems) {
    const tf = countStemMatches(lower, stem);
    if (tf === 0) continue;
    covered += 1;
    sum += (weights.get(stem) ?? 1) * (1 + Math.log(tf));
  }
  if (covered === 0) return 0;
  const coverage = covered / stems.length;
  return sum * (0.25 + 0.75 * coverage * coverage);
}

/** Rank chunks by a scorer, dropping zeroes, with an explicit tiebreak. */
function rank(
  chunks: readonly MarkdownChunk[],
  score: (chunk: MarkdownChunk) => number,
  cap: number,
): ChunkHit[] {
  return chunks
    .map((chunk) => ({ chunk, score: score(chunk) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.chunk.file.localeCompare(b.chunk.file) ||
        a.chunk.line - b.chunk.line,
    )
    .slice(0, cap)
    .map(({ chunk, score: value }) => ({
      file: chunk.file,
      heading: chunk.heading,
      line: chunk.line,
      content: chunk.text,
      score: value,
      chunkType: 'markdown',
    }));
}

// ---------------------------------------------------------------------------
// The leg
// ---------------------------------------------------------------------------

/**
 * How much a match in the heading + path is worth relative to one in the body.
 *
 * A TERM, NOT A SEPARATE LEG, and that distinction cost a measured bug. The
 * first cut ranked body and title independently and RRF-fused the two, which
 * throws away score MAGNITUDE by design — RRF exists to fuse rankings that are
 * not comparable, and these two are produced by the same scorer over the same
 * query, so they are. On "what enforces the .raw boundary" the body ranking put
 * the right chunk first by a factor of four; the title ranking put a section
 * called "Arc Convention (bound decision)" first on one weak stem; fusing by
 * RANK made them near-equals and the answer lost. Added as a weighted term, the
 * title still says "this chunk is ABOUT the question" without being able to
 * outvote what the chunk actually says.
 */
const TITLE_WEIGHT = 1.5;

/** Where the corpus is, when it is not simply `<projectRoot>/<path>`. */
export interface FileSearchOptions {
  /** Where `flow/` really is (a Workspace sibling's knowledge folder). */
  flowDir?: string;
  /** Which corpus roots to walk. Defaults to `CORPUS_ROOTS`. */
  roots?: readonly string[];
}

/** The file-search result, ready for `mergeLayers`. */
export interface FileSearchLegs {
  /** Ranked chunks — one leg, body and title scored together. */
  chunks: ChunkHit[];
  /** How the candidate set was chosen, for diagnostics. */
  via: 'ripgrep' | 'scan';
  /** Files actually read. */
  filesRead: number;
}

/**
 * Run the file search.
 *
 * `scopeDirs` reuses the caller's existing scope→directory mapping verbatim;
 * an empty list means the whole corpus. A scope that names a directory the
 * project does not have yields no candidates and no error, which is the same
 * thing the index did.
 */
export function fileSearchLegs(
  projectRoot: string,
  query: string,
  scopeDirs: readonly string[] = [],
  options: FileSearchOptions = {},
): FileSearchLegs {
  const stems = queryStems(query);
  const empty: FileSearchLegs = { chunks: [], via: 'scan', filesRead: 0 };
  if (stems.length === 0) return empty;

  const at = corpusResolver(projectRoot, options.flowDir);
  const all = listCorpusFiles(projectRoot, options.roots ?? CORPUS_ROOTS, options.flowDir).filter(
    (file) => scopeDirs.length === 0 || scopeDirs.some((dir) => file.startsWith(dir)),
  );
  if (all.length === 0) return empty;

  const narrowed = ripgrepCandidates(projectRoot, stems, all, options.flowDir);
  const via: 'ripgrep' | 'scan' = narrowed === null ? 'scan' : 'ripgrep';
  const candidates = (narrowed ?? all).slice(0, MAX_CANDIDATE_FILES);

  const chunks: MarkdownChunk[] = [];
  for (const file of candidates) {
    let content: string;
    try {
      content = readFileSync(at(file), 'utf-8');
    } catch {
      continue; // unreadable file costs its own chunks, never the search
    }
    chunks.push(...chunkMarkdown(file, content));
  }

  // Path separators become spaces so `flow/brain/features/playbooks.md` offers
  // "playbooks" as a word rather than as the tail of a path.
  const titleOf = (chunk: MarkdownChunk): string =>
    `${chunk.heading ?? ''} ${chunk.file.replace(/[/_.-]/g, ' ')}`;

  // Weighted from the chunk BODIES only. Titles are short, so their document
  // frequencies are noise, and a term worth two different amounts within one
  // answer is not a weighting at all.
  const weights = stemWeights(chunks.map((chunk) => chunk.text), stems);

  return {
    chunks: rank(
      chunks,
      (chunk) =>
        scoreChunkText(chunk.text, stems, weights) +
        TITLE_WEIGHT * scoreChunkText(titleOf(chunk), stems, weights),
      LEG_CAP,
    ),
    via,
    filesRead: candidates.length,
  };
}
