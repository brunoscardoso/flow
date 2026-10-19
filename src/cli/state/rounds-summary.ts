/**
 * The SYNCED form of an execution record (workspaces-knowledge-hub FR-17):
 * no code in shared knowledge.
 *
 * `flow/.rounds.jsonl` is the live, append-only record a run writes — personal
 * and never synced. When a plan is archived its record moves to
 * `flow/archive/rounds_<plan>.jsonl`, which IS synced; in a Workspace that
 * repository is read by a whole team and may be hosted anywhere, so the
 * archived copy must be a summary that POINTS at code (`file:line`) rather
 * than quoting it. Review verdicts and phase results routinely quote source —
 * `reason: "touches: import { x } from './y' — …"`, a fenced block, a diff
 * hunk — and this module strips exactly that, keeping every reference.
 *
 * What is removed (each replaced by one marker, consecutive lines collapsed):
 *   - fenced code blocks (```…```), terminated or not;
 *   - unified-diff material: `diff --git`, `index …`, `---`/`+++` file headers,
 *     `@@ … @@` hunk headers and every `+`/`-`/context line inside a hunk;
 *   - lines that read as source statements (imports, declarations, a line
 *     ending in `;` or `{`, a lone closing brace);
 *   - inline `import … from '…'` statements inside prose;
 *   - inline backtick spans that hold a statement rather than a name;
 *   - values under keys that by name carry raw text (`diff`, `patch`,
 *     `snippet`, `code`, `excerpt`, `stdout`, `stderr`, `output`, `content`).
 * What is kept: everything else, including `path/to/file.ts:42` references,
 * short identifiers in backticks, ids, statuses, anchors and timestamps.
 *
 * Idempotent (a summary summarizes to itself) and pure; the I/O helpers at
 * the bottom are the only writers. The live `.rounds.jsonl` is never rewritten.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { atomicWriteFile } from '../utils/atomic-write.js';
import { moveFileSync } from './run-script-store.js';
import type { RoundsEntry } from './rounds-reader.js';

/** What stands where quoted source was. No characters any rule below matches. */
export const SOURCE_OMITTED = '[source omitted - see the file:line reference]';

const RAW_TEXT_KEYS = new Set(['diff', 'patch', 'hunk', 'snippet', 'code', 'excerpt', 'stdout', 'stderr', 'output', 'content']);

const FENCED_BLOCK = /```[\s\S]*?(?:```|$)/g;
const INLINE_IMPORT = /\bimport\s+(?:type\s+)?(?:\{[^}\n]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*\{[^}\n]*\})?\s+from\s+(['"])[^'"\n]+\1;?/g;
const BACKTICK_SPAN = /`([^`\n]+)`/g;
const MAX_NAME_SPAN = 100;
/** A short identifier-like tag (`text`, `tool_result`) — kept inside a raw subtree. */
const STRUCTURAL_TAG = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
/** The keys whose short tag survives inside a raw subtree. */
const STRUCTURAL_KEYS = new Set(['type', 'kind', 'role', 'id']);

const DIFF_HEADER = /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|(?:---|\+\+\+) (?:a\/|b\/|\/dev\/null))/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const SOURCE_LINE =
  /^\s*(?:import\s.+\sfrom\s|import\s+['"]|export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\b|(?:const|let|var)\s+[\w{[][^=]*=|(?:async\s+)?function\s*\w*\s*\(|class\s+\w+|def\s+\w+\s*\(|#include\b|return\b.*;\s*$|[})\]];?\s*$|.*[;{]\s*$)/;

/** Does a backtick span hold a statement (not a name or a `file:line`)? */
function isCodeSpan(inner: string): boolean {
  if (inner.length > MAX_NAME_SPAN) return true;
  return /;|=>|\s=\s|\{.*\}|\breturn\b|\bimport\b.*\bfrom\b/.test(inner);
}

/** Strip quoted source from one string, keeping every reference. */
export function summarizeRoundsText(text: string): string {
  let out = text.replace(FENCED_BLOCK, SOURCE_OMITTED);
  out = out.replace(INLINE_IMPORT, SOURCE_OMITTED);
  out = out.replace(BACKTICK_SPAN, (span, inner: string) => (isCodeSpan(inner) ? SOURCE_OMITTED : span));

  const lines = out.split('\n');
  // A single-line string is judged like any line: `"reason": "const x = …;"` is source too.
  if (lines.length === 1) return out.trim() !== '' && out !== SOURCE_OMITTED && SOURCE_LINE.test(out) ? SOURCE_OMITTED : out;
  const kept: string[] = [];
  let inHunk = false;
  const omit = (): void => {
    if (kept[kept.length - 1] !== SOURCE_OMITTED) kept.push(SOURCE_OMITTED);
  };
  for (const line of lines) {
    if (DIFF_HEADER.test(line)) {
      inHunk = false;
      omit();
      continue;
    }
    if (HUNK_HEADER.test(line)) {
      inHunk = true;
      omit();
      continue;
    }
    if (inHunk) {
      if (/^[+\- ]/.test(line) || line === '') {
        omit();
        continue;
      }
      inHunk = false;
    }
    if (line.trim() !== '' && line !== SOURCE_OMITTED && SOURCE_LINE.test(line)) {
      omit();
      continue;
    }
    if (line === SOURCE_OMITTED) {
      omit();
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Does a key, by name, carry raw text? Case-insensitive and by SUBSTRING —
 * `Output`, `toolOutput`, `stderrTail` all do. Fail-closed on purpose: a key
 * that merely contains one of the words loses its string, which costs a
 * summary a detail; missing one ships source.
 */
function isRawTextKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const raw of RAW_TEXT_KEYS) if (lower.includes(raw)) return true;
  return false;
}

/**
 * Summarize any JSON value: strings are stripped, and EVERY string anywhere
 * under a raw-text key (`content: [{ text }]` included) is replaced.
 */
export function summarizeRoundsValue(value: unknown, key?: string, underRawKey = false): unknown {
  const ownRawKey = key !== undefined && isRawTextKey(key);
  const raw = underRawKey || ownRawKey;
  if (typeof value === 'string') {
    // Inside a raw subtree a structural tag (`type: "text"`) is no source; its
    // `text` is. A raw key's OWN string is always replaced.
    const tag = key !== undefined && STRUCTURAL_KEYS.has(key) && STRUCTURAL_TAG.test(value);
    if (raw && value.length > 0 && (ownRawKey || !tag)) return SOURCE_OMITTED;
    return summarizeRoundsText(value);
  }
  if (Array.isArray(value)) return value.map((item) => summarizeRoundsValue(item, undefined, raw));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = summarizeRoundsValue(child, childKey, raw);
    }
    return out;
  }
  return value;
}

/** One entry's synced form. */
export function summarizeRoundsEntry(entry: RoundsEntry): RoundsEntry {
  return summarizeRoundsValue(entry) as RoundsEntry;
}

/**
 * A whole JSONL file's synced form. A line that is not a JSON object is
 * DROPPED — it cannot be summarized, so it cannot be shared — and counted.
 */
export function summarizeRoundsContent(content: string): { text: string; dropped: number } {
  const out: string[] = [];
  let dropped = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        dropped += 1;
        continue;
      }
      out.push(JSON.stringify(summarizeRoundsEntry(parsed as RoundsEntry)));
    } catch {
      dropped += 1;
    }
  }
  return { text: out.length === 0 ? '' : `${out.join('\n')}\n`, dropped };
}

// ─── I/O: the archived copy only ────────────────────────────────────────────

const ARCHIVE_DIRNAME = 'archive';
const LIVE_ROUNDS_FILENAME = '.rounds.jsonl';
const EVIDENCE_DIRNAME = '.evidence';
const ARCHIVED_ROUNDS = /^rounds_.+\.jsonl$/;

/**
 * Rewrite every archived `rounds_*.jsonl` under `<flowDir>/archive/` into its
 * synced form. Returns the files that changed. Idempotent: an already
 * summarized file is left byte-identical. Never touches `.rounds.jsonl`.
 */
export function summarizeArchivedRounds(flowDir: string, options: { keepFull?: boolean } = {}): string[] {
  const dir = join(flowDir, ARCHIVE_DIRNAME);
  if (!existsSync(dir)) return [];
  const changed: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!ARCHIVED_ROUNDS.test(name)) continue;
    const filePath = join(dir, name);
    const before = readFileSync(filePath, 'utf-8');
    const { text } = summarizeRoundsContent(before);
    if (text === before) continue;
    // `keepFull`: the unsummarized text stays on THIS machine, under the
    // personal `.evidence/rounds/` — where `archiveRounds` keeps it too.
    if (options.keepFull === true) keepFullRecord(flowDir, name, before);
    atomicWriteFile(filePath, text);
    changed.push(filePath);
  }
  return changed;
}

/** Keep a full record under `.evidence/rounds/`, never over a different one already there. */
function keepFullRecord(flowDir: string, name: string, text: string): void {
  const keep = join(flowDir, EVIDENCE_DIRNAME, 'rounds');
  mkdirSync(keep, { recursive: true });
  const stem = name.replace(/\.jsonl$/, '');
  for (let n = 1; ; n += 1) {
    const candidate = join(keep, n === 1 ? name : `${stem}-${n}.jsonl`);
    if (!existsSync(candidate)) {
      atomicWriteFile(candidate, text);
      return;
    }
    if (readFileSync(candidate, 'utf-8') === text) return;
  }
}

/**
 * Archive the live record with its plan: `.rounds.jsonl` →
 * `archive/rounds_<planFile>.jsonl`, summarized when `summarize` is set (a
 * Workspace project). A missing live file is a no-op (null). The live file is
 * moved, never edited, so an unsummarized copy never lands in the archive.
 */
export function archiveRounds(flowDir: string, planFile: string, options: { summarize: boolean }): string | null {
  const live = join(flowDir, LIVE_ROUNDS_FILENAME);
  if (!existsSync(live)) return null;
  const name = `rounds_${planFile.replace(/\.md$/, '')}.jsonl`;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error(`invalid plan name: ${planFile}`);
  }
  const dir = join(flowDir, ARCHIVE_DIRNAME);
  mkdirSync(dir, { recursive: true });
  const destination = join(dir, name);
  if (options.summarize) {
    atomicWriteFile(destination, summarizeRoundsContent(readFileSync(live, 'utf-8')).text);
    // Only the archived copy is shared. The full record is kept on THIS
    // machine under `.evidence/` (personal — never synced), so summarizing
    // loses nothing locally (NFR-2).
    const keep = join(flowDir, EVIDENCE_DIRNAME, 'rounds');
    mkdirSync(keep, { recursive: true });
    moveFileSync(live, join(keep, name));
    return destination;
  }
  moveFileSync(live, destination);
  return destination;
}
