/**
 * CHANGE NOTES MEET THE CODE — the one place a note is matched to its function
 * and its quote is looked for (plan `plan_change_review`, NFR-2; allowed-
 * pattern #14). `plan notes` (`commands/plan.ts`) and the storyline's
 * Proposal / Verify (`storyline-compare.ts`) both read through here, so a quote
 * `plan notes --check` accepts is the quote the story highlights.
 *
 * A note's function is the piece whose id is `<file>#<symbol>`, else every
 * top-level piece named `<symbol>` (overloads share a name: the function is
 * every line any of them covers), else the method of that name when exactly
 * one class of the file declares one. The quote is looked for inside those lines
 * only — never fuzzy, never the first of two (`resolveQuote`). A FILE note's
 * optional quote is looked for in the whole file (`quoteInFile`), and marks
 * whichever piece holds it (`pieceHolding`).
 */

import { resolve } from 'node:path';
import { workspaceContextOf, type StatusTargetResult } from '../handlers/workspace-model.js';
import { resolveQuote, type ChangeNote, type QuoteResolution } from '../state/change-notes.js';
import { storylineProjectOf, type StorylineReaders } from './storyline-reader.js';
import type { NoteQuote, StorylineNote, StorylinePiece } from './storyline-types.js';

/** The note's own fields, in the order the JSON promises. */
export function noteReportOf(note: ChangeNote): StorylineNote {
  return {
    n: note.n,
    phase: note.phase,
    kind: note.kind,
    target: note.target.raw,
    ...(note.target.project === undefined ? {} : { project: note.target.project }),
    file: note.target.file,
    ...(note.target.symbol === undefined ? {} : { symbol: note.target.symbol }),
    ...(note.where === undefined ? {} : { where: note.where }),
    ...(note.what === undefined ? {} : { what: note.what }),
    ...(note.why === undefined ? {} : { why: note.why }),
    ...(note.signature === undefined ? {} : { signature: note.signature }),
    ...(note.purpose === undefined ? {} : { purpose: note.purpose }),
    ...(note.callers === undefined ? {} : { callers: note.callers }),
    status: note.status,
    ...(note.reason === undefined ? {} : { reason: note.reason }),
    comments: note.comments,
    ...(note.verdict === undefined ? {} : { verdict: note.verdict }),
    ...(note.verdictWhy === undefined ? {} : { verdictWhy: note.verdictWhy }),
  };
}

export function quoteOf(resolution: QuoteResolution): NoteQuote {
  switch (resolution.found) {
    case 'once':
      return { found: 'once', startLine: resolution.startLine, endLine: resolution.endLine };
    case 'many':
      return { found: 'many', count: resolution.count };
    default:
      return { found: 'none' };
  }
}

/** The pieces that ARE a note's function in `file` (empty when it has none). */
export function functionPiecesOf<P extends Pick<StorylinePiece, 'id' | 'file' | 'name' | 'className'>>(
  pieces: readonly P[],
  file: string,
  symbol: string,
): P[] {
  const exact = pieces.filter((piece) => piece.id === `${file}#${symbol}`);
  if (exact.length > 0) return exact;
  const topLevel = pieces.filter((piece) => piece.file === file && piece.name === symbol && piece.className === undefined);
  if (topLevel.length > 0) return topLevel;
  // A BARE NAME NAMES A METHOD when exactly one class of the file declares it
  // (`list_for_user` in a service class) — two classes with it is a guess.
  const methods = pieces.filter((piece) => piece.file === file && piece.name === symbol && piece.className !== undefined);
  return new Set(methods.map((piece) => piece.className)).size === 1 ? methods : [];
}

/** Look for a quote inside a function's lines (all of its overloads). */
export function quoteInFunction(
  fileText: string,
  pieces: readonly Pick<StorylinePiece, 'startLine' | 'endLine'>[],
  quote: string,
): QuoteResolution {
  const range = {
    startLine: Math.min(...pieces.map((piece) => piece.startLine)),
    endLine: Math.max(...pieces.map((piece) => piece.endLine)),
  };
  return resolveQuote(fileText, range, quote);
}

/** Look for a file note's quote in the whole file. */
export function quoteInFile(fileText: string, quote: string): QuoteResolution {
  return resolveQuote(fileText, { startLine: 1, endLine: fileText.split('\n').length }, quote);
}

/**
 * The piece of `file` that holds `line`: the innermost one (a method before
 * its class), or null when the line is outside every piece.
 */
export function pieceHolding<P extends Pick<StorylinePiece, 'id' | 'file' | 'startLine' | 'endLine'>>(
  pieces: readonly P[],
  file: string,
  line: number,
): P | null {
  let best: P | null = null;
  for (const piece of pieces) {
    if (piece.file !== file || piece.startLine > line || piece.endLine < line) continue;
    if (best === null || piece.endLine - piece.startLine < best.endLine - best.startLine) best = piece;
  }
  return best;
}

/** Where a change note's quote is in today's code, as `plan notes` reports it. */
export interface NoteQuoteReading {
  quote: NoteQuote;
  /** The target file is not in the project. */
  fileMissing?: true;
  /** The file is there but has no piece of that name. */
  symbolMissing?: true;
  /**
   * No reader could find the function's lines (an unread language, a syntax
   * error), so the quote was looked for in the whole file instead.
   */
  functionUnchecked?: true;
}

/**
 * Where a change note's quote is in the code of the checkout at `repoRoot`:
 * inside its function's lines only (the storyline's own readers find them, any
 * language). A missing file or function is `none` with the flag that says
 * which; a file no reader can read falls back to the whole file and says so.
 * A file note's quote (when it has one) is looked for in the whole file.
 */
export async function resolveNoteQuote(
  repoRoot: string,
  note: ChangeNote,
  readers: StorylineReaders,
): Promise<NoteQuoteReading> {
  const project = storylineProjectOf(repoRoot);
  const file = note.target.file;
  const text = project.readFile(file);
  if (text === null) return { quote: { found: 'none' }, fileMissing: true };
  const quote = note.where ?? '';
  const wholeFile = { startLine: 1, endLine: text.split('\n').length };
  // A file note's quote is the whole file's to find.
  if (note.kind === 'file') return { quote: quoteOf(quoteInFile(text, quote)) };

  await readers.prepare([file]);
  const answer = readers.extract(file, text, project);
  if (!answer.ok) {
    return { quote: quoteOf(resolveQuote(text, wholeFile, quote)), functionUnchecked: true };
  }
  const pieces = functionPiecesOf(answer.pieces, file, note.target.symbol ?? '');
  if (pieces.length === 0) return { quote: { found: 'none' }, symbolMissing: true };
  return { quote: quoteOf(quoteInFunction(text, pieces, quote)) };
}

// ── Which checkout a note's code is in ──────────────────

/**
 * This project's Workspace slug and its siblings' checkouts on this machine —
 * nothing outside a Workspace. The ONE answer to "whose code does a note's
 * `<project>/` prefix name" (allowed-pattern #14): `plan notes` and the
 * storyline both ask it, so a note prefixed with THIS project's own slug is
 * local to both.
 */
export interface NoteProjects {
  self: string | null;
  /** Sibling slug → its checkout here, or null when it has none on this machine. */
  checkouts: ReadonlyMap<string, string | null>;
}

export function noteProjectsOf(repoRoot: string): NoteProjects {
  return noteProjectsFrom(workspaceContextOf(repoRoot));
}

/** `noteProjectsOf` from a Workspace answer already read. */
export function noteProjectsFrom(status: StatusTargetResult | null): NoteProjects {
  if (status === null || status.workspace === null || status.project === null) return { self: null, checkouts: new Map() };
  return {
    self: status.project.slug,
    checkouts: new Map(status.siblings.map((sibling) => [sibling.slug, sibling.localPath])),
  };
}

/**
 * Where a note's code is read: `repoRoot` for a note with no project prefix or
 * this project's own slug; a sibling's checkout; null when the project named
 * has no checkout on this machine (or is no project of this Workspace).
 */
export function noteCheckoutRoot(projects: NoteProjects, repoRoot: string, project: string | undefined): { root: string; local: boolean } | null {
  if (project === undefined || project === projects.self) return { root: repoRoot, local: true };
  const root = projects.checkouts.get(project);
  return root === undefined || root === null ? null : { root: resolve(root), local: false };
}
