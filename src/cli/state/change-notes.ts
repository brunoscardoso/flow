/**
 * Change notes — the per-function review grammar inside a plan's phases, read
 * by ONE parser (NFR-2) and rewritten one note at a time (NFR-3).
 *
 * A phase may carry a `#### Change notes` block:
 *
 *   #### Change notes
 *
 *   - note: 1 · change · file:src/a.ts:useThing
 *       where: `: planSelectorRequested && isTenantFull)`
 *       what: the regular-chat branch uses isPlanSelectorVisible
 *       why: the button already shows for Lite with a published playbook
 *       status: accepted
 *       comments:
 *         - keep the coworker branch as is
 *   - note: 2 · new · file:src/b.ts:isSlashMenuEligible
 *       signature: isSlashMenuEligible(tier, hasPublishedPlaybooks): boolean
 *       purpose: one rule shared by the button and the slash menu
 *       callers: useThing
 *       status: rejected — keep it inline; one call site
 *   - note: 3 · file · api/file:src/routes.ts
 *       where: `export const routes = [`
 *       what: register the route
 *       why: the app calls it
 *
 * A file note's `where:` is optional: when the change has a place in the file
 * it quotes it, and the quote is looked for in the whole file (a change
 * note's only inside its function).
 *
 * The header's separators are read leniently (` · `, ` - `, `|`, an en or em
 * dash) and the writer only ever touches `status:` / `verdict:` lines. The
 * target may carry a `<project-slug>/` prefix naming a sibling Workspace
 * project; `<function>` may be `Class.method`.
 *
 * UNREADABLE IS REPORTED, NEVER DROPPED: an unknown kind, a bad target, an
 * unknown status or verdict, a missing required field, an unknown field, a
 * duplicated note number, and a note outside any phase each come back in
 * `unreadable` with the line and a sentence — the same stance the plan parser
 * takes on complexity and dependency lines it cannot read (#1810, #1823).
 *
 * LINES ARE 1-BASED AND INCLUSIVE everywhere in this module (`startLine`,
 * `endLine`, `UnreadableNote.line`, `resolveQuote`'s range) — the same numbering
 * the storyline's pieces use, so a note's quote range and a piece's range are
 * directly comparable.
 */

import { HEADING_SHAPED_RE, PHASE_HEADER_RE } from './plan-headings.js';

export type ChangeNoteKind = 'change' | 'new' | 'file';
export type NoteStatus = 'proposed' | 'accepted' | 'rejected';
export type NoteVerdict = 'done' | 'differs' | 'not-built';

export const NOTE_KINDS: readonly ChangeNoteKind[] = ['change', 'new', 'file'];
export const NOTE_STATUSES: readonly NoteStatus[] = ['proposed', 'accepted', 'rejected'];
export const NOTE_VERDICTS: readonly NoteVerdict[] = ['done', 'differs', 'not-built'];

/** Where a note points: a file (and function) here or in a sibling project. */
export interface ChangeNoteTarget {
  /** The target as written, e.g. `api/file:src/a.ts:run`. */
  raw: string;
  /** A sibling Workspace project's slug, when the target names one. */
  project?: string;
  /** Project-relative path. */
  file: string;
  /** `fn` or `Class.method`; absent on a file note. */
  symbol?: string;
}

export interface ChangeNote {
  /** The phase the note sits in. */
  phase: number;
  /** The note's number — unique across the plan. */
  n: number;
  kind: ChangeNoteKind;
  target: ChangeNoteTarget;
  /** change (required) / file (optional): today's code, backticks stripped. */
  where?: string;
  /** change / file. */
  what?: string;
  why?: string;
  /** new. */
  signature?: string;
  purpose?: string;
  callers?: string[];
  /** Absent line reads as `proposed`. */
  status: NoteStatus;
  reason?: string;
  comments: string[];
  verdict?: NoteVerdict;
  verdictWhy?: string;
  /** The `- note:` line (1-based). */
  startLine: number;
  /** The note's last non-blank line (1-based, inclusive). */
  endLine: number;
  /** The `status:` line, when the note has one (1-based). */
  statusLine?: number;
  /** The `verdict:` line, when the note has one (1-based). */
  verdictLine?: number;
}

/** A note the parser could not read, and why. */
export interface UnreadableNote {
  /** 1-based. */
  line: number;
  reason: string;
  /** The note's number, when the header got that far. */
  n?: number;
}

export interface ParsedChangeNotes {
  notes: ChangeNote[];
  unreadable: UnreadableNote[];
  /**
   * Every `#### Change notes` block, heading included (1-based, inclusive), so
   * the plan parser can keep note lines out of its task reader.
   */
  blocks: Array<{ startLine: number; endLine: number }>;
}

// ── Grammar ──────────────────────────────────────────────

const BLOCK_HEADING_RE = /^#{3,6}[ \t]+Change notes[ \t]*$/i;
/** Any markdown heading. */
const HEADING_RE = /^#{1,6}[ \t]/;
/** A note header — `- note: …` (the word in any case). */
const NOTE_HEADER_RE = /^- note:[ \t]*(.*)$/i;
/** A note-shaped line wherever it appears — what outside a block is reported. */
const NOTE_SHAPED_RE = /^-[ \t]+note:[ \t]*\d+/i;
/** What ends a block besides a heading: a rule, a task, a `**Field**` line. */
const BLOCK_BREAK_RE = /^(?:---\s*$|- \[[ x]\]|\*\*[A-Za-z])/;
/**
 * An indented field: `<indent><key>:<value>`. `[ \t]*` after the colon, never
 * `\s*` — a blank value must not swallow the next line (forbidden-pattern #16).
 */
const FIELD_RE = /^([ \t]+)([A-Za-z][A-Za-z-]*):[ \t]*(.*)$/;
const LIST_ITEM_RE = /^([ \t]+)-[ \t]+(.*)$/;
/** The header's separators: ` · `, ` - `, ` — `, ` – `, and `|` with or without spaces. */
const HEADER_SEPARATOR_RE = /[ \t]+[·\-—–][ \t]+|[ \t]*[|·][ \t]*/;
/** ` — reason`, ` - reason`, ` – reason`. */
const DASH_TAIL_RE = /^(\S+)(?:[ \t]+[—–-][ \t]+(.*))?$/;
const TARGET_RE = /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)\/)?file:(.+)$/;
// A segment may be a private name (`ConversationPane.#onStream`) — the code
// story names private methods that way, and a plan for a class that keeps its
// work in them could not otherwise point at any of it.
const SYMBOL_RE = /^#?[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*$/;

/** Fields each kind may carry, and the ones it must. */
const KIND_FIELDS: Record<ChangeNoteKind, { allowed: readonly string[]; required: readonly string[] }> = {
  change: { allowed: ['where', 'what', 'why'], required: ['where', 'what', 'why'] },
  new: { allowed: ['signature', 'purpose', 'callers', 'why'], required: ['signature', 'purpose'] },
  file: { allowed: ['where', 'what', 'why'], required: ['what', 'why'] },
};
const COMMON_FIELDS = ['status', 'comments', 'verdict'];
/** Fields a wrapped line may continue. */
const CONTINUABLE = new Set(['what', 'why', 'purpose', 'signature']);

export function isNoteKind(value: string): value is ChangeNoteKind {
  return (NOTE_KINDS as readonly string[]).includes(value);
}
export function isNoteStatus(value: string): value is NoteStatus {
  return (NOTE_STATUSES as readonly string[]).includes(value);
}
export function isNoteVerdict(value: string): value is NoteVerdict {
  return (NOTE_VERDICTS as readonly string[]).includes(value);
}

/** Parse a target (`[<project>/]file:<path>[:<function>]`), or say why not. */
export function parseNoteTarget(raw: string): ChangeNoteTarget | string {
  const match = TARGET_RE.exec(raw.trim());
  if (match === null) return `"${raw}" is not a target — write file:<path>:<function> or file:<path>`;
  const project = match[1];
  const rest = (match[2] ?? '').trim();
  let file = rest;
  let symbol: string | undefined;
  const colon = rest.lastIndexOf(':');
  if (colon > 0) {
    const candidate = rest.slice(colon + 1).trim();
    if (SYMBOL_RE.test(candidate)) {
      file = rest.slice(0, colon).trim();
      symbol = candidate;
    } else {
      return `"${raw}" names no readable function after the path`;
    }
  }
  if (file === '' || /\s/.test(file) || file.startsWith('/') || file.split('/').includes('..')) {
    return `"${raw}" does not name a project-relative file`;
  }
  return {
    raw: raw.trim(),
    ...(project === undefined ? {} : { project }),
    file,
    ...(symbol === undefined ? {} : { symbol }),
  };
}

/** Strip a backticked quote's fence (`x`, ``x``, `` `x` ``). */
function stripBackticks(value: string): string {
  const match = /^(`+)[ ]?([\s\S]*?)[ ]?\1$/.exec(value.trim());
  return match === null ? value.trim() : (match[2] ?? '');
}

function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) width += char === '\t' ? 4 : 1;
  return width;
}

interface Draft {
  phase: number | null;
  n: number | null;
  kind: ChangeNoteKind | null;
  target: ChangeNoteTarget | null;
  fields: Map<string, string>;
  callers?: string[];
  status: NoteStatus;
  reason?: string;
  comments: string[];
  verdict?: NoteVerdict;
  verdictWhy?: string;
  startLine: number;
  endLine: number;
  statusLine?: number;
  verdictLine?: number;
  /** The first problem found; the note is unreadable when set. */
  problem: string | null;
  /** The field a wrapped line continues, and the comments list's indent. */
  lastField: string | null;
  commentsIndent: number | null;
  fieldIndent: number | null;
}

function startDraft(header: string, lineNo: number, phase: number | null): Draft {
  const draft: Draft = {
    phase,
    n: null,
    kind: null,
    target: null,
    fields: new Map(),
    status: 'proposed',
    comments: [],
    startLine: lineNo,
    endLine: lineNo,
    problem: null,
    lastField: null,
    commentsIndent: null,
    fieldIndent: null,
  };
  const parts = header.trim().split(HEADER_SEPARATOR_RE).map((part) => part.trim()).filter((part) => part !== '');
  const number = parts[0] ?? '';
  if (!/^\d+$/.test(number) || Number.parseInt(number, 10) < 1) {
    draft.problem = `"${number}" is not a note number — a note starts \`- note: <n> · change|new|file · <target>\``;
    return draft;
  }
  draft.n = Number.parseInt(number, 10);
  if (parts.length !== 3) {
    draft.problem = 'a note header is `- note: <n> · change|new|file · <target>` — three parts';
    return draft;
  }
  const kind = (parts[1] ?? '').toLowerCase();
  if (!isNoteKind(kind)) {
    draft.problem = `"${parts[1] ?? ''}" is not a note kind — it is change, new or file`;
    return draft;
  }
  draft.kind = kind;
  const target = parseNoteTarget(parts[2] ?? '');
  if (typeof target === 'string') {
    draft.problem = target;
    return draft;
  }
  if (kind === 'file' && target.symbol !== undefined) {
    draft.problem = `a file note names a file, not a function — "${target.raw}"`;
    return draft;
  }
  if (kind !== 'file' && target.symbol === undefined) {
    draft.problem = `a ${kind} note names its function — file:<path>:<function>`;
    return draft;
  }
  draft.target = target;
  if (phase === null) draft.problem = 'this note sits outside any phase — notes belong to a `### Phase N:` section';
  return draft;
}

/** Read one line that belongs to the open note. */
function readNoteLine(draft: Draft, line: string, lineNo: number): void {
  draft.endLine = lineNo;
  if (draft.problem !== null) return;

  const item = LIST_ITEM_RE.exec(line);
  if (item !== null && draft.commentsIndent !== null && indentWidth(item[1] ?? '') > draft.commentsIndent) {
    draft.comments.push((item[2] ?? '').trim());
    return;
  }

  const field = FIELD_RE.exec(line);
  if (field !== null && (draft.fieldIndent === null || indentWidth(field[1] ?? '') <= draft.fieldIndent)) {
    const key = (field[2] ?? '').toLowerCase();
    const value = (field[3] ?? '').trim();
    const indent = indentWidth(field[1] ?? '');
    const kind = draft.kind as ChangeNoteKind;
    if (!KIND_FIELDS[kind].allowed.includes(key) && !COMMON_FIELDS.includes(key)) {
      draft.problem = `"${key}" is not a field of a ${kind} note (line ${String(lineNo)})`;
      return;
    }
    if (draft.fields.has(key)) {
      draft.problem = `"${key}" is written twice (line ${String(lineNo)})`;
      return;
    }
    draft.fieldIndent = draft.fieldIndent ?? indent;
    draft.fields.set(key, value);
    draft.lastField = key;
    draft.commentsIndent = null;
    switch (key) {
      case 'where':
        draft.fields.set(key, stripBackticks(value));
        break;
      case 'callers':
        draft.callers = value
          .split(',')
          .map((caller) => stripBackticks(caller.trim()).trim())
          .filter((caller) => caller !== '');
        break;
      case 'status': {
        const tail = DASH_TAIL_RE.exec(value);
        const word = (tail?.[1] ?? '').toLowerCase();
        if (tail === null || !isNoteStatus(word)) {
          draft.problem = `"${value}" is not a status — it is proposed, accepted or rejected (line ${String(lineNo)})`;
          return;
        }
        draft.status = word;
        const reason = (tail[2] ?? '').trim();
        if (reason !== '') draft.reason = reason;
        draft.statusLine = lineNo;
        break;
      }
      case 'verdict': {
        const tail = DASH_TAIL_RE.exec(value);
        const word = (tail?.[1] ?? '').toLowerCase();
        if (tail === null || !isNoteVerdict(word)) {
          draft.problem = `"${value}" is not a verdict — it is done, differs or not-built (line ${String(lineNo)})`;
          return;
        }
        draft.verdict = word;
        const why = (tail[2] ?? '').trim();
        if (why !== '') draft.verdictWhy = why;
        draft.verdictLine = lineNo;
        break;
      }
      case 'comments':
        if (value !== '') {
          draft.problem = `comments are a list under \`comments:\`, one \`- <text>\` per line (line ${String(lineNo)})`;
          return;
        }
        draft.commentsIndent = indent;
        break;
      default:
        break;
    }
    return;
  }

  // A wrapped line continues the text field above it.
  if (draft.lastField !== null && CONTINUABLE.has(draft.lastField) && draft.commentsIndent === null) {
    const previous = draft.fields.get(draft.lastField) ?? '';
    draft.fields.set(draft.lastField, `${previous} ${line.trim()}`.trim());
    return;
  }
  draft.problem = `line ${String(lineNo)} is not a field of the note — "${line.trim()}"`;
}

function finishDraft(draft: Draft): ChangeNote | UnreadableNote {
  const unreadable = (reason: string): UnreadableNote => ({
    line: draft.startLine,
    reason,
    ...(draft.n === null ? {} : { n: draft.n }),
  });
  if (draft.problem !== null) return unreadable(draft.problem);
  const kind = draft.kind as ChangeNoteKind;
  for (const required of KIND_FIELDS[kind].required) {
    const value = draft.fields.get(required);
    if (value === undefined || value.trim() === '') {
      return unreadable(`a ${kind} note needs \`${required}:\``);
    }
  }
  const text = (key: string): string | undefined => {
    const value = draft.fields.get(key);
    return value === undefined || value === '' ? undefined : value;
  };
  const where = text('where');
  const what = text('what');
  const why = text('why');
  const signature = text('signature');
  const purpose = text('purpose');
  return {
    phase: draft.phase as number,
    n: draft.n as number,
    kind,
    target: draft.target as ChangeNoteTarget,
    ...(where === undefined ? {} : { where }),
    ...(what === undefined ? {} : { what }),
    ...(why === undefined ? {} : { why }),
    ...(signature === undefined ? {} : { signature }),
    ...(purpose === undefined ? {} : { purpose }),
    ...(draft.callers === undefined ? {} : { callers: draft.callers }),
    status: draft.status,
    ...(draft.reason === undefined ? {} : { reason: draft.reason }),
    comments: draft.comments,
    ...(draft.verdict === undefined ? {} : { verdict: draft.verdict }),
    ...(draft.verdictWhy === undefined ? {} : { verdictWhy: draft.verdictWhy }),
    startLine: draft.startLine,
    endLine: draft.endLine,
    ...(draft.statusLine === undefined ? {} : { statusLine: draft.statusLine }),
    ...(draft.verdictLine === undefined ? {} : { verdictLine: draft.verdictLine }),
  };
}

/** The number a note-shaped line gives itself, so a refusal can name it. */
function noteNumberOf(trimmed: string): { n?: number } {
  const match = /^-[ \t]+note:[ \t]*(\d+)/i.exec(trimmed);
  return match === null ? {} : { n: Number.parseInt(match[1] ?? '', 10) };
}

/** Every change note in a plan, plus what could not be read. */
export function parseChangeNotes(content: string): ParsedChangeNotes {
  const lines = content.split('\n');
  const found: Array<ChangeNote | UnreadableNote> = [];
  const blocks: Array<{ startLine: number; endLine: number }> = [];
  let phase: number | null = null;
  let block: { startLine: number; endLine: number } | null = null;
  let draft: Draft | null = null;

  const closeNote = (): void => {
    if (draft !== null) found.push(finishDraft(draft));
    draft = null;
  };
  const closeBlock = (): void => {
    closeNote();
    if (block !== null) blocks.push(block);
    block = null;
  };

  for (let index = 0; index < lines.length; index++) {
    const lineNo = index + 1;
    const line = (lines[index] ?? '').replace(/\r$/, '');
    const trimmed = line.trim();

    if (BLOCK_HEADING_RE.test(trimmed)) {
      closeBlock();
      block = { startLine: lineNo, endLine: lineNo };
      if (phase === null) {
        found.push({ line: lineNo, reason: 'a `#### Change notes` block sits outside any phase — notes belong to a `### Phase N:` section' });
      }
      continue;
    }
    if (HEADING_RE.test(trimmed) && !line.startsWith(' ') && !line.startsWith('\t')) {
      closeBlock();
      const header = PHASE_HEADER_RE.exec(trimmed);
      if (header !== null) {
        phase = Number.parseInt(header[1] ?? '', 10);
      } else if (HEADING_SHAPED_RE.test(trimmed) || /^#{1,3}[ \t]/.test(trimmed)) {
        // An unreadable phase heading, or any section at phase level or above,
        // ends the phase — notes below it belong to no phase.
        phase = null;
      }
      continue;
    }

    if (block === null) {
      if (NOTE_SHAPED_RE.test(trimmed) && !/^[ \t]/.test(line)) {
        found.push({ line: lineNo, reason: 'a note belongs under a `#### Change notes` heading inside its phase' });
      }
      continue;
    }

    if (trimmed === '') continue;
    const indented = /^[ \t]/.test(line);
    if (!indented) {
      const header = NOTE_HEADER_RE.exec(trimmed);
      if (header !== null) {
        closeNote();
        draft = startDraft(header[1] ?? '', lineNo, phase);
        (block as { endLine: number }).endLine = lineNo;
        continue;
      }
      // A NOTE THAT LOOKS LIKE ONE IS NEVER DROPPED: `-  note: 3 …` (two
      // spaces) is not the grammar, but it is somebody's note — say so.
      if (NOTE_SHAPED_RE.test(trimmed)) {
        closeNote();
        found.push({ line: lineNo, ...noteNumberOf(trimmed), reason: 'a note header is written `- note: N · kind · target`, with one space after the dash' });
        (block as { endLine: number }).endLine = lineNo;
        continue;
      }
      if (BLOCK_BREAK_RE.test(trimmed) || trimmed.startsWith('- ')) {
        closeBlock();
        continue;
      }
      // Prose under the heading: not a note, and the block goes on.
      closeNote();
      continue;
    }
    if (draft !== null) {
      readNoteLine(draft, line, lineNo);
      (block as { endLine: number }).endLine = lineNo;
    } else if (NOTE_SHAPED_RE.test(trimmed)) {
      // An indented `  - note: N …` with no note above it to belong to.
      found.push({ line: lineNo, ...noteNumberOf(trimmed), reason: 'a note header starts at the beginning of its line — `- note: N · kind · target`, not indented' });
      (block as { endLine: number }).endLine = lineNo;
    }
  }
  closeBlock();

  // A NUMBER TWO NOTES SHARE NAMES NEITHER: the writer could not know which one
  // a decision is for, so both are reported rather than one silently winning.
  const counts = new Map<number, number>();
  for (const entry of found) {
    if ('kind' in entry) counts.set(entry.n, (counts.get(entry.n) ?? 0) + 1);
  }
  const notes: ChangeNote[] = [];
  const unreadable: UnreadableNote[] = [];
  for (const entry of found) {
    if (!('kind' in entry)) {
      unreadable.push(entry);
    } else if ((counts.get(entry.n) ?? 0) > 1) {
      unreadable.push({ line: entry.startLine, n: entry.n, reason: `note ${String(entry.n)} is numbered twice — every note needs its own number` });
    } else {
      notes.push(entry);
    }
  }
  unreadable.sort((a, b) => a.line - b.line);
  return { notes, unreadable, blocks };
}

// ── Quotes ───────────────────────────────────────────────

export type QuoteResolution =
  | { found: 'once'; startLine: number; endLine: number }
  | { found: 'none' }
  | { found: 'many'; count: number };

/**
 * Find `quote` in `fileText`, inside `range` only (1-based, inclusive).
 *
 * Whitespace-normalised on both sides — runs collapse to one space, ends are
 * trimmed — so a quote may span lines and survive re-indentation. Never fuzzy:
 * every other character must match exactly, and a quote found twice is `many`,
 * never the first.
 */
export function resolveQuote(
  fileText: string,
  range: { startLine: number; endLine: number },
  quote: string,
): QuoteResolution {
  const needle = quote.replace(/\s+/g, ' ').trim();
  if (needle === '') return { found: 'none' };
  const lines = fileText.split('\n');
  const first = Math.max(1, range.startLine);
  const last = Math.min(lines.length, range.endLine);
  let haystack = '';
  const lineOf: number[] = [];
  let pendingSpace = false;
  for (let lineNo = first; lineNo <= last; lineNo++) {
    const text = `${lines[lineNo - 1] ?? ''}\n`;
    for (const char of text) {
      if (/\s/.test(char)) {
        pendingSpace = haystack.length > 0;
        continue;
      }
      if (pendingSpace) {
        haystack += ' ';
        lineOf.push(lineNo);
        pendingSpace = false;
      }
      haystack += char;
      lineOf.push(lineNo);
    }
  }
  const starts: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    starts.push(at);
    at = haystack.indexOf(needle, at + 1);
  }
  if (starts.length === 0) return { found: 'none' };
  if (starts.length > 1) return { found: 'many', count: starts.length };
  const start = starts[0] as number;
  return {
    found: 'once',
    startLine: lineOf[start] as number,
    endLine: lineOf[start + needle.length - 1] as number,
  };
}

// ── The one-note rewrite ─────────────────────────────────

/** Collapse a value onto one line — a field never spans lines. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Replace (or insert) one field line of one note, leaving every other byte of
 * the plan as it was (NFR-3). Throws when the note is not a readable note.
 */
function rewriteNoteField(
  content: string,
  n: number,
  key: 'status' | 'verdict',
  value: string,
): string {
  const parsed = parseChangeNotes(content);
  const note = parsed.notes.find((candidate) => candidate.n === n);
  if (note === undefined) throw new Error(`note ${String(n)} is not a readable note in this plan`);
  const lines = content.split('\n');
  const existing = key === 'status' ? note.statusLine : note.verdictLine;
  const anchor = lines[note.endLine - 1] ?? '';
  const crlf = anchor.endsWith('\r') ? '\r' : '';

  if (existing !== undefined) {
    const original = lines[existing - 1] ?? '';
    const indent = /^[ \t]*/.exec(original)?.[0] ?? '';
    lines[existing - 1] = `${indent}${key}: ${value}${original.endsWith('\r') ? '\r' : ''}`;
    return lines.join('\n');
  }
  const indent = fieldIndentOf(lines, note);
  lines.splice(note.endLine, 0, `${indent}${key}: ${value}${crlf}`);
  return lines.join('\n');
}

/** The indent the note's fields use (two spaces when it has none yet). */
function fieldIndentOf(lines: readonly string[], note: ChangeNote): string {
  for (let lineNo = note.startLine + 1; lineNo <= note.endLine; lineNo++) {
    const match = FIELD_RE.exec((lines[lineNo - 1] ?? '').replace(/\r$/, ''));
    if (match !== null) return match[1] ?? '  ';
  }
  return '  ';
}

/**
 * Set a note's status. `proposed` with no reason REMOVES nothing that is not
 * there: a note without a status line already reads as proposed, so it stays
 * byte-identical; one with a line has it rewritten to `proposed`.
 */
export function setNoteStatus(content: string, n: number, status: NoteStatus, reason?: string): string {
  const cleanReason = reason === undefined ? '' : oneLine(reason);
  const value = cleanReason === '' ? status : `${status} — ${cleanReason}`;
  const note = parseChangeNotes(content).notes.find((candidate) => candidate.n === n);
  if (note !== undefined && note.statusLine === undefined && status === 'proposed' && cleanReason === '') {
    return content;
  }
  return rewriteNoteField(content, n, 'status', value);
}

/** Set a note's verdict, with its one sentence. */
export function setNoteVerdict(content: string, n: number, verdict: NoteVerdict, why: string): string {
  return rewriteNoteField(content, n, 'verdict', `${verdict} — ${oneLine(why)}`);
}

/** Counts every surface reports the same way. */
export interface NoteCounts {
  total: number;
  accepted: number;
  rejected: number;
  unreviewed: number;
}

export function countNotes(notes: readonly { status: NoteStatus }[]): NoteCounts {
  return {
    total: notes.length,
    accepted: notes.filter((note) => note.status === 'accepted').length,
    rejected: notes.filter((note) => note.status === 'rejected').length,
    unreviewed: notes.filter((note) => note.status === 'proposed').length,
  };
}

// ── What a review writes, set aside ──────────────────────

/** The fields a review writes on a note — never part of what the plan says to build. */
const REVIEW_FIELDS = new Set(['status', 'verdict', 'comments']);

/**
 * The plan with every readable note's review lines removed — its `status:`,
 * `verdict:` and `comments:` lines (with the comment items under them). What
 * the plan says to build is everything else, so a decision recorded before or
 * after a run (`setNoteStatus`, `setNoteVerdict`) leaves this text unchanged,
 * while an edit to a note's `what:`/`why:`/`where:` changes it. The run
 * script's `planHash` is taken over this (`hashPlanContent`).
 */
export function withoutReviewLines(content: string): string {
  const parsed = parseChangeNotes(content);
  if (parsed.notes.length === 0) return content;
  const lines = content.split('\n');
  const drop = new Set<number>();
  for (const note of parsed.notes) {
    let commentsIndent: number | null = null;
    for (let lineNo = note.startLine + 1; lineNo <= note.endLine; lineNo++) {
      const line = (lines[lineNo - 1] ?? '').replace(/\r$/, '');
      const item = LIST_ITEM_RE.exec(line);
      if (commentsIndent !== null && item !== null && indentWidth(item[1] ?? '') > commentsIndent) {
        drop.add(lineNo);
        continue;
      }
      commentsIndent = null;
      const field = FIELD_RE.exec(line);
      const key = (field?.[2] ?? '').toLowerCase();
      if (field === null || !REVIEW_FIELDS.has(key)) continue;
      drop.add(lineNo);
      if (key === 'comments') commentsIndent = indentWidth(field[1] ?? '');
    }
  }
  return lines.filter((_, index) => !drop.has(index + 1)).join('\n');
}
