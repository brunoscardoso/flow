/**
 * THE CATALOG — a hand-authored table of contents over the markdown corpus.
 *
 * `brain search` answers "I do not know where this is". The catalog answers the
 * other question: "give me the canonical section on X". Those are different
 * needs, and a store with only the first has no agreed answer to anything.
 *
 * ── WHY THIS EXISTS AGAIN ──────────────────────────────────────────────────
 *
 * plan-flow shipped a reference-code index until 0135380f deleted it as a phase
 * of adopting the sqlite brain index — which was itself later deleted. So the
 * curated layer went away as collateral and was never replaced. The old scheme's
 * one real defect was its ADDRESSING: entries carried hardcoded line ranges
 * (`allowed-patterns.md` 45-152), and any edit above a section silently
 * re-pointed its code at neighbouring prose. Not a miss — a confident wrong
 * answer.
 *
 * So the split here is deliberate: the catalog carries the part a machine cannot
 * derive (which section is canonical), and the machine carries the part a human
 * cannot maintain (where that section currently is). The address is a HEADING.
 * Nothing stored can drift, because no location is stored.
 *
 * ── ONE CHUNKER ────────────────────────────────────────────────────────────
 *
 * Resolution runs the SAME `chunkMarkdown` the ranker uses (allowed-pattern
 * #14), so an expansion can never disagree with the hit a search returns for the
 * same section. It never consults the ranker, never scores, and never falls back
 * to search: a catalog that silently degrades into a guess is one whose answers
 * cannot be told apart from guesses.
 *
 * ── SECTIONS, NOT CHUNKS ───────────────────────────────────────────────────
 *
 * The chunker splits a section longer than 120 lines into several chunks that
 * all KEEP the heading — a ranking detail, not a document fact. A catalog entry
 * names a section, so contiguous chunks of one section are re-joined here before
 * matching. Without that, every long section would resolve as `heading-ambiguous`.
 * A continuation chunk is identifiable exactly: its text does not begin with the
 * heading line.
 */

import { chunkMarkdown } from './brain-file-search.js';

/** Where the catalog lives, relative to a project's `flow/` directory. */
export const CATALOG_RELPATH = 'brain/catalog.md';

/** The corpus-relative spelling, for messages and JSON payloads. */
export const CATALOG_CORPUS_PATH = 'flow/brain/catalog.md';

/**
 * A code is opaque to the resolver — the grouping (`COR-`, `SKL-`) is a human
 * convention, deliberately not parsed into a hierarchy this module would then
 * have to keep agreeing with.
 */
export const CATALOG_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

/** The separator between a source file and its heading, as search also prints it. */
const ADDRESS_SEPARATOR = '›';

/** One catalogued section. */
export interface CatalogEntry {
  code: string;
  /** What this section answers — the column an agent reads when listing. */
  description: string;
  /** Corpus-relative path, as the corpus spells it (`flow/brain/…`). */
  file: string;
  /** Exact heading text, without its `#` markers. */
  heading: string;
  /** The `##` group it was listed under, for display only. */
  group: string;
  /** 1-based line in the catalog, so a problem can be located. */
  line: number;
}

/** A row that could not become an entry, or an entry that cannot be trusted. */
export interface CatalogProblem {
  line: number;
  code: string | null;
  reason: 'malformed-row' | 'bad-code' | 'bad-address' | 'duplicate-code';
  detail: string;
}

export interface ParsedCatalog {
  entries: CatalogEntry[];
  problems: CatalogProblem[];
}

/** Why a code could not be expanded. */
export type CatalogRefusal =
  | 'unknown-code'
  | 'duplicate-code'
  | 'source-missing'
  | 'heading-not-found'
  | 'heading-ambiguous';

export interface ResolvedEntry {
  entry: CatalogEntry;
  /** The section's full text, heading line included. */
  text: string;
  /** 1-based line the heading sits on, so the hit carries `file:line`. */
  line: number;
}

export interface ResolveFailure {
  entry: CatalogEntry | null;
  refusal: CatalogRefusal;
  /** How many sections carried that heading (ambiguity reports the count). */
  matches?: number;
}

export type ResolveResult = ResolvedEntry | ResolveFailure;

export function isResolved(result: ResolveResult): result is ResolvedEntry {
  return (result as ResolveFailure).refusal === undefined;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split a markdown table row into trimmed cells, or null when it is not one. */
function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return body.split('|').map((cell) => cell.trim());
}

/** True for the `|---|---|` rule under a table header. */
function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Pull `path` and `heading` out of a source cell.
 *
 * The path may be backticked or bare — a catalog is hand-edited, and refusing a
 * row over a missing pair of backticks would make the format hostile for no gain.
 * The heading is taken VERBATIM after the separator: it has to match the file's
 * heading byte for byte, so this must not normalise it.
 */
export function parseAddress(cell: string): { file: string; heading: string } | null {
  const at = cell.indexOf(ADDRESS_SEPARATOR);
  if (at === -1) return null;
  const file = cell.slice(0, at).trim().replace(/^`|`$/g, '').trim();
  const heading = cell.slice(at + ADDRESS_SEPARATOR.length).trim().replace(/^`|`$/g, '').trim();
  if (file === '' || heading === '') return null;
  return { file, heading };
}

/**
 * Read a catalog's markdown into entries plus the rows that could not become
 * one.
 *
 * Problems are RETURNED, never thrown and never silently dropped: `--check`
 * exists to print them, and a parser that quietly skipped a malformed row would
 * hide exactly the drift this file is meant to surface.
 */
export function parseCatalog(raw: string): ParsedCatalog {
  const entries: CatalogEntry[] = [];
  const problems: CatalogProblem[] = [];
  const seen = new Map<string, number>();
  let group = '';
  let inFence = false;

  raw.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    const lineNo = index + 1;
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    const headingMatch = /^##\s+(.*\S)\s*$/.exec(line);
    if (headingMatch !== null) {
      group = headingMatch[1];
      return;
    }

    const cells = tableCells(line);
    if (cells === null || cells.length < 3 || isSeparatorRow(cells)) return;

    const [code, description, address] = cells;
    // The header row names its own columns; it is not a problem, it is a header.
    if (/^code$/i.test(code)) return;
    if (code === '') return;

    if (!CATALOG_CODE_PATTERN.test(code)) {
      problems.push({ line: lineNo, code, reason: 'bad-code', detail: `"${code}" is not a reference code` });
      return;
    }
    const parsed = parseAddress(address);
    if (parsed === null) {
      problems.push({
        line: lineNo,
        code,
        reason: 'bad-address',
        detail: `the source cell must read \`path\` ${ADDRESS_SEPARATOR} Heading`,
      });
      return;
    }
    const first = seen.get(code);
    if (first !== undefined) {
      problems.push({
        line: lineNo,
        code,
        reason: 'duplicate-code',
        detail: `already defined on line ${first}`,
      });
      return;
    }
    seen.set(code, lineNo);
    entries.push({ code, description, file: parsed.file, heading: parsed.heading, group, line: lineNo });
  });

  return { entries, problems };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** One heading's whole section, re-joined from the chunker's output. */
interface Section {
  heading: string;
  line: number;
  text: string;
}

/**
 * Re-join the chunker's output into sections.
 *
 * A chunk continues the previous section when it carries the same heading AND
 * does not begin with that heading's line — which is exactly how the chunker
 * marks an oversized split, so this reads the distinction rather than guessing
 * it from sizes.
 */
export function sectionsOf(file: string, content: string): Section[] {
  const sections: Section[] = [];
  for (const chunk of chunkMarkdown(file, content)) {
    if (chunk.heading === undefined) continue;
    const startsWithHeading = /^#{1,6}\s/.test(chunk.text);
    const previous = sections[sections.length - 1];
    if (!startsWithHeading && previous !== undefined && previous.heading === chunk.heading) {
      previous.text = `${previous.text}\n${chunk.text}`;
      continue;
    }
    sections.push({ heading: chunk.heading, line: chunk.line, text: chunk.text });
  }
  return sections;
}

export interface CatalogDeps {
  /** The source file's text, or null when it cannot be read. */
  readCorpusFile: (relPath: string) => string | null;
}

/**
 * Expand one code.
 *
 * EXACT heading match, and a refusal on 0 or 2+ — never a tiebreak. Measured on
 * this corpus (303 files, 4,687 distinct headings) only 6 files carry any
 * duplicate heading at all, so exact addressing covers effectively everything
 * and the rare collision is worth refusing loudly rather than resolving by a
 * rule no reader could predict. The same contract already governs change-note
 * quotes, which refuse a quote found zero or 2+ times.
 */
export function resolveCode(
  catalog: ParsedCatalog,
  code: string,
  deps: CatalogDeps,
): ResolveResult {
  const duplicated = catalog.problems.some(
    (problem) => problem.reason === 'duplicate-code' && problem.code === code,
  );
  const entry = catalog.entries.find((candidate) => candidate.code === code);
  if (entry === undefined) return { entry: null, refusal: 'unknown-code' };
  if (duplicated) return { entry, refusal: 'duplicate-code' };

  const content = deps.readCorpusFile(entry.file);
  if (content === null) return { entry, refusal: 'source-missing' };

  const matches = sectionsOf(entry.file, content).filter(
    (section) => section.heading.trim() === entry.heading.trim(),
  );
  if (matches.length === 0) return { entry, refusal: 'heading-not-found', matches: 0 };
  if (matches.length > 1) return { entry, refusal: 'heading-ambiguous', matches: matches.length };
  return { entry, text: matches[0].text, line: matches[0].line };
}

/** Every entry's outcome, in catalog order — what `--check` reports. */
export function checkCatalog(
  catalog: ParsedCatalog,
  deps: CatalogDeps,
): { entry: CatalogEntry; result: ResolveResult }[] {
  return catalog.entries.map((entry) => ({ entry, result: resolveCode(catalog, entry.code, deps) }));
}

/** The sentence shown for each refusal — no path, no command, no flag. */
export const CATALOG_REFUSAL_SENTENCES: Record<CatalogRefusal, string> = {
  'unknown-code': 'the catalog has no entry with that code',
  'duplicate-code': 'the catalog defines that code more than once, so it names no single section',
  'source-missing': 'the file this entry points at is not in the corpus',
  'heading-not-found': 'that heading is no longer in the file — it was renamed, moved out, or deleted',
  'heading-ambiguous': 'the file carries that heading more than once, so the entry names no single section',
};
