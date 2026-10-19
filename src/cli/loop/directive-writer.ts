/**
 * The directive fields a person may change without opening an editor: `paused:`,
 * and the pair that says where a loop's work comes from (`queue:` plus its
 * `repo:` or `path:`).
 *
 * A directive is VERSIONED INTENT — frontmatter plus the `## Direction` and
 * `## Rules` prose a run is handed verbatim. Steering a loop is a commit, and
 * what it was pointed at last month is `git log`. So this writer is deliberately
 * the narrowest thing that could work: it edits the `paused:` line IN PLACE and
 * touches nothing else in the file.
 *
 * ONE WRITE PER CHANGE, and the queue pair is why that matters more here than
 * it did for `paused:`. The grammar COUPLES the two fields — `queue: github`
 * requires a `repo:` and refuses a `path:`, `queue: ledger` the other way round
 * — so a writer that set the kind in one pass and its companion in another
 * would leave a file on disk, however briefly, that the parser refuses to read.
 * A loop whose directive stops parsing does not run at all, so both fields move
 * in a single rewrite of a single string, and the result is parsed before it is
 * written: the writer never produces a file its own reader would turn away.
 *
 * ROUND-TRIP, NEVER RE-SERIALIZE. The obvious implementation — parse the
 * directive, set a field, write the object back out — is lossy in this grammar
 * and provably so: `parseLoopDirective` drops trailing `# …` comments (the note
 * saying WHY a loop was parked), normalizes the legacy `max_beat_minutes`
 * spelling, defaults every absent key into an explicit one, and returns the two
 * prose sections trimmed and heading-less. Writing that object back would
 * rewrite a person's file into the parser's idea of it — a diff of thirty lines
 * for a one-word change, with the reasoning deleted. The parser is still run
 * first, for its refusals; what gets written is the ORIGINAL BYTES with one
 * value token substituted.
 *
 * WHAT IT DOES NOT TOUCH: runtime state. A directive pause and the `state.json`
 * pause `loop pause` writes are different facts about different lifetimes — the
 * directive one is committed and survives a lost state file, the runtime one is
 * local and expires. Lifting either must never silently lift the other, so
 * nothing in this module opens the state store.
 *
 * AND NO LOG LINE. `loop pause` records itself in the run log because nothing
 * else would remember it; a directive edit is a tracked file, so the audit trail
 * is `git log -p loops/<name>.md` — already better than a JSONL line, and one
 * that cannot disagree with the file it describes.
 */

import { existsSync, readFileSync } from 'node:fs';

import { atomicWriteFile } from '../utils/atomic-write.js';
import {
  REPO_PATTERN,
  loopDirectiveCandidates,
  parseLoopDirective,
  readLoopDirective,
} from './directive-parser.js';
import { LOOP_QUEUE_KINDS, isLoopQueueKind } from './types.js';
import type { LoopDirective, LoopQueueKind } from './types.js';

/** Fence delimiting the frontmatter block — the parser's own spelling. */
const FRONTMATTER_FENCE = '---';

/** What one `paused:` write did. */
export interface DirectivePausedWrite {
  /** The directive file, in the home it was actually found in. */
  path: string;
  /** What `paused:` read before — an absent key reads as `false`. */
  wasPaused: boolean;
  /** What it reads now. */
  paused: boolean;
  /** False when the file already said this and nothing was written. */
  changed: boolean;
}

/**
 * Where a loop should read its work from, as a caller states it.
 *
 * `queue` is a bare `string` ON PURPOSE — it arrives from a `--queue` flag or an
 * IPC request, and the whole point of `queueTargetProblem` is to be the thing
 * that turns an unchecked word into a refusal naming it. A caller that already
 * holds a `LoopQueueKind` loses nothing by passing it here.
 */
export interface DirectiveQueueTarget {
  /** `github` or `ledger` — validated, never assumed. */
  queue: string;
  /** `owner/name`. Required by `github`, refused by `ledger`. */
  repo?: string;
  /** Ledger file. Optional under `ledger` (absent keeps the default), refused by `github`. */
  path?: string;
}

/** What one queue-source write did. */
export interface DirectiveQueueWrite {
  /** The directive file, in the home it was actually found in. */
  path: string;
  /** The kind the file named before. */
  wasQueue: LoopQueueKind;
  /** Where it pointed before — `owner/name`, or the ledger file it resolved to. */
  wasLocation: string | null;
  /** The kind it names now. */
  queue: LoopQueueKind;
  /** Where it points now, read back off the rewritten file rather than assumed. */
  location: string | null;
  /** False when the file already said this and nothing was written. */
  changed: boolean;
}

/**
 * Whether a raw line opens or closes the frontmatter block.
 *
 * `trimEnd` only, never `trim`: `splitFrontmatter` matches the fence at column
 * zero, so an indented `  ---` is body text to the parser and must stay body
 * text here. The trailing trim is for a CRLF file, whose fence line carries a
 * `\r` this splitting leaves attached.
 */
function isFence(line: string): boolean {
  return line.trimEnd() === FRONTMATTER_FENCE;
}

/** The key a raw frontmatter line sets, or null for a blank or comment line. */
function keyOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;
  const colon = trimmed.indexOf(':');
  if (colon <= 0) return null;
  return trimmed.slice(0, colon).trim();
}

/**
 * Rewrite one frontmatter line's value, keeping its indentation, the spacing
 * around the colon, and any trailing `# …` comment exactly as they were.
 *
 * THE COMMENT SURVIVES ON PURPOSE. `paused: true  # queue is at its cap` is a
 * person's note about their own project; a writer that dropped it would be
 * deleting reasoning to make its own diff tidier. It may read as dated after a
 * flip — a dated note is a smaller lie than a deleted one, and the file is
 * tracked, so the note's own history is one command away.
 */
function replaceValue(line: string, value: string): string {
  const match = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_]*\s*:)([ \t]*)([^\s#]*)([\s\S]*)$/);
  if (match === null) return line;
  const [, head, gap, token, tail] = match;
  const spacer = gap.length > 0 ? gap : ' ';
  // An EMPTY value (`paused:` or `paused:   # note`) has no token for the gap to
  // sit before, so the gap was consumed ahead of the comment. Put one space back
  // between the new value and whatever followed, or the two would run together.
  const separator = token.length === 0 && tail.length > 0 && !/^\s/.test(tail) ? ' ' : '';
  return `${head}${spacer}${value}${separator}${tail}`;
}

/**
 * Index of the closing fence, refusing a file that has no frontmatter to edit.
 *
 * Every field write goes through this first, so "a file this could not read is a
 * file it will not touch" holds for the raw-byte layer too — not only for the
 * parser the store-level functions run.
 */
function frontmatterEnd(lines: readonly string[]): number {
  if (lines.length === 0 || !isFence(lines[0])) {
    throw new Error(`missing frontmatter — expected a '${FRONTMATTER_FENCE}' fenced block at the top`);
  }
  const end = lines.findIndex((line, index) => index > 0 && isFence(line));
  if (end === -1) {
    throw new Error(`unterminated frontmatter — no closing '${FRONTMATTER_FENCE}'`);
  }
  return end;
}

/**
 * Set one frontmatter key, in place when it is already there and inserted where
 * the documented key order puts it when it is not.
 *
 * `anchors` are the keys the new line may follow, nearest-first; the first one
 * present wins and lends the inserted line its indentation and line ending, so
 * the addition looks like it was always there. A directive naming none of them
 * gets the line at the top of the block, which is the only position that is
 * certainly inside the fence.
 *
 * Mutates `lines`, because the callers below make several of these edits to one
 * array and a copy per field would make the fence index a moving target.
 */
function upsertField(lines: string[], key: string, value: string, anchors: readonly string[]): void {
  const end = frontmatterEnd(lines);
  for (let index = 1; index < end; index += 1) {
    if (keyOf(lines[index]) === key) {
      lines[index] = replaceValue(lines[index], value);
      return;
    }
  }
  let at = 1;
  let reference = lines[1] ?? '';
  for (const anchor of anchors) {
    const found = lines.findIndex(
      (line, index) => index > 0 && index < end && keyOf(line) === anchor,
    );
    if (found !== -1) {
      at = found + 1;
      reference = lines[found];
      break;
    }
  }
  const indent = reference.match(/^[ \t]*/)?.[0] ?? '';
  const carriage = reference.endsWith('\r') ? '\r' : '';
  lines.splice(at, 0, `${indent}${key}: ${value}${carriage}`);
}

/**
 * Delete every line in the frontmatter that sets `key`.
 *
 * THE ONE EDIT THAT LOSES A COMMENT, and it is the honest one: a trailing note
 * on `repo: acme/widgets  # the fork, not upstream` is about the repo, and a
 * loop that no longer reads a repo should not carry a comment explaining which
 * one it reads. The rest of the file — and any comment about anything else —
 * is untouched, and the line's own history stays in `git log -p`.
 *
 * Bottom-up, so a directive that somehow carries the key twice (the parser
 * refuses one, but this function is also called on raw content in tests) has
 * both removed without the second splice shifting past the first.
 */
function removeField(lines: string[], key: string): void {
  const end = frontmatterEnd(lines);
  for (let index = end - 1; index >= 1; index -= 1) {
    if (keyOf(lines[index]) === key) lines.splice(index, 1);
  }
}

/**
 * Return `content` with `paused:` set to `value`, and everything else — key
 * order, spacing, comments, unknown-to-this-function keys, the prose below the
 * fence, the file's line endings and its final newline — byte-identical.
 *
 * A directive with no `paused:` key gets one inserted directly after `engine:`,
 * which is where the documented key order puts it. Insertion is the only case
 * that adds a line; every other case changes one token on one line.
 *
 * Exported for its own tests: the round-trip is the whole contract of this
 * module, and it is provable without a filesystem.
 */
export function withPausedField(content: string, value: boolean): string {
  // Splitting on '\n' alone keeps a CRLF file's '\r' attached to each line, so
  // rejoining restores the original bytes without normalizing anything.
  const lines = content.split('\n');
  upsertField(lines, 'paused', value ? 'true' : 'false', ['engine']);
  return lines.join('\n');
}

/**
/**
 * The content with `max_open_issues:` set — a loop's one default stop.
 *
 * NOT THE SAME NUMBER AS A HUNT'S CAP, and the distinction is the reason this
 * needed its own writer. `--cap` (`DEFAULT_INSTRUCTION_CAP`, 20) bounds ONE
 * hunt: how many findings a single instruction may file before it stops for a
 * person. This bounds the LOOP: how many open items of its own it may have
 * before the gate refuses it more work at all. A run can hit either, they mean
 * different things, and nothing should quietly resolve them into one.
 *
 * Placed after `mission` when absent, where the caps sit in the grammar's own
 * table, rather than at the end of the frontmatter.
 */
export function withCapField(content: string, value: number): string {
  const lines = content.split('\n');
  upsertField(lines, 'max_open_issues', String(value), ['mission', 'engine']);
  return lines.join('\n');
}

/**
 * Why this queue target cannot be written, or null.
 *
 * THE PARSER'S OWN COUPLING, STATED ONCE MORE ON THE WRITE SIDE and in the
 * parser's own words: `queue: github` requires `repo: owner/name` and refuses
 * `path:`; `queue: ledger` refuses `repo:` and takes an optional `path:`. The
 * rule cannot simply be borrowed from `parseLoopDirective`, because that one
 * judges a whole file and this one has to judge a request BEFORE a file exists
 * to judge — but the wording is deliberately identical, so a refusal from a
 * write and a refusal from a read are recognisably the same rule.
 *
 * A LOCATION WITH WHITESPACE OR A `#` IS REFUSED, which the parser never has to
 * say: it strips a ` # …` comment off a value, so a path containing one would
 * be written whole and read back truncated — a loop quietly pointed at a file
 * nobody named. Refusing is the only reading that cannot surprise anyone.
 */
export function queueTargetProblem(target: DirectiveQueueTarget): string | null {
  if (!isLoopQueueKind(target.queue)) {
    return `unknown queue '${target.queue}' — expected ${LOOP_QUEUE_KINDS.join('|')}`;
  }
  const repo = (target.repo ?? '').trim();
  const path = (target.path ?? '').trim();
  if (target.queue === 'github') {
    if (repo.length === 0) return "queue 'github' requires 'repo: owner/name'";
    if (!REPO_PATTERN.test(repo)) return `malformed repo '${repo}' — expected owner/name`;
    if (path.length > 0) return "'path' applies to queue 'ledger' only";
    return null;
  }
  if (repo.length > 0) return "'repo' applies to queue 'github' only";
  if (path.length > 0 && /[\s#]/.test(path)) {
    return `malformed path '${path}' — expected a path with no spaces or '#'`;
  }
  return null;
}

/**
 * Return `content` with the queue fields set to `target` — the kind and its
 * companion, in ONE rewrite — and every other byte as it was.
 *
 * THREE EDITS, ONE STRING. The kind is substituted in place; the companion the
 * new kind FORBIDS is deleted (a `repo:` left behind under `queue: ledger` is
 * not a harmless leftover — the parser refuses the whole file over it, and the
 * loop stops running); the companion it requires is written after `queue:`,
 * where the documented key order puts it.
 *
 * A STILL-LEGAL COMPANION THE CALLER DID NOT NAME IS LEFT ALONE. Re-pointing a
 * ledger loop at the ledger without naming a file keeps the file it already
 * reads, because "I did not mention it" is not "throw it away". The only field
 * this function ever deletes is the one the new kind makes illegal.
 *
 * Exported for its own tests, like `withPausedField`: byte preservation is the
 * contract, and it is provable without a filesystem.
 */
export function withQueueFields(content: string, target: DirectiveQueueTarget): string {
  const problem = queueTargetProblem(target);
  if (problem !== null) throw new Error(problem);
  const github = target.queue === 'github';
  const lines = content.split('\n');
  // The kind first: `queue:` is required by the grammar, so on any parseable
  // directive this is a substitution. The anchors matter only for a file that
  // never named one — nearest-preceding key first, in the documented order.
  upsertField(lines, 'queue', target.queue, ['slice', 'scope', 'mission', 'paused', 'engine', 'loop']);
  removeField(lines, github ? 'path' : 'repo');
  const named = (github ? target.repo : target.path)?.trim() ?? '';
  if (named.length > 0) {
    upsertField(lines, github ? 'repo' : 'path', named, ['queue']);
  }
  return lines.join('\n');
}

/**
 * Write a file atomically — THE one implementation, in utils/atomic-write.ts.
 *
 * It also explains why the plain rename this used to do could not write here at
 * all while the Flow IDE was open: on Windows, renaming over a path another
 * process holds open fails with EPERM.
 */
const atomicWrite = atomicWriteFile;

/**
 * Set a loop directive's `paused:` field.
 *
 * The directive is READ AND FULLY PARSED FIRST, through the same
 * `readLoopDirective` every other verb uses: a missing loop, an unreadable
 * file, a malformed boolean, an unknown key or a `loop:` that disagrees with its
 * filename all refuse HERE, before a byte is written. Nothing half-valid is
 * ever rewritten — a file this could not read is a file it will not touch.
 *
 * Setting the value it already has is a SUCCESS that wrote nothing
 * (`changed: false`), mirroring `unclaim`'s `wasClaimed: false`: the caller
 * asked for a state, the state is the one on disk, and turning that into a
 * refusal would make the board's own button fail for doing its job.
 */
/** What `setDirectiveCap` did. */
export interface DirectiveCapWrite {
  path: string;
  /** The cap the file had — the parser's resolved value, default included. */
  wasCap: number;
  cap: number;
  /** False when the file already said this: a success that wrote nothing. */
  changed: boolean;
}

/** What `setDirectiveProse` did. */
export interface DirectiveProseWrite {
  /** The directive that was read (and written, when `changed`). */
  path: string;
  section: 'Direction' | 'Rules';
  /** The section as the re-parse read it back — never as the caller spelled it. */
  text: string;
  /** False when the file already said this: a success that wrote nothing. */
  changed: boolean;
}

/**
 * Replace one of a directive's prose sections — `## Direction` or `## Rules`.
 *
 * THESE ARE THE LOOP'S OWN STANDING JUDGMENTS. The grammar calls them "prose
 * handed to the run verbatim": Direction is what to look at and what a good
 * finding looks like; Rules are what this loop has decided, as opposed to the
 * invariants the CLI enforces. Until now nothing could write them — the writer
 * knew `paused:` and the queue fields and nothing else — so the only way to
 * steer a loop was to open the file, and the IDE (which may not author a
 * directive itself) could not offer it at all.
 *
 * REPLACES THE SECTION, KEEPS THE REST. The body is rebuilt around the one
 * heading: everything before it and everything after the next `##` survives
 * byte for byte, so a directive carrying both sections plus its own trailing
 * prose keeps all of it. An absent section is APPENDED, in the grammar's own
 * order — Direction before Rules — rather than wherever the caller happened to
 * ask.
 *
 * Empty text REMOVES the section, because "no direction" is a real state and a
 * heading with nothing under it reads as one the author forgot to fill in.
 *
 * Verified by re-parsing before the write, the rule `setDirectiveQueue`
 * states: the writer's whole risk is producing a directive its own reader
 * refuses, and bytes that cannot be read back are not written at all.
 */
/**
 * Set a loop's cap — how many open items of its own it may have before the gate
 * refuses it more.
 *
 * The ONE stop this design keeps by default. Time is not enforced (the grammar
 * says so of `max_run_minutes`: "nothing measures a run's elapsed time and no
 * verb refuses on it"), and `empty` is not a limit but an outcome — so the count
 * is the whole of the default leash, and everything else a loop should respect
 * belongs in `## Rules`, opted into rather than imposed.
 *
 * Parsed back before writing, like every other write here.
 */
export function setDirectiveCap(flowDir: string, loop: string, cap: number): DirectiveCapWrite {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new Error(`max_open_issues must be a positive whole number — got '${String(cap)}'`);
  }
  const { path, directive, content } = openDirective(flowDir, loop);
  const wasCap = directive.maxOpenIssues;
  const rewritten = withCapField(content, cap);

  let verified: LoopDirective;
  try {
    verified = parseLoopDirective(rewritten, path);
  } catch (error) {
    throw new Error(`${path}: the edit would not parse (${(error as Error).message})`);
  }
  if (rewritten === content) {
    return { path, wasCap, cap: verified.maxOpenIssues, changed: false };
  }
  write(path, rewritten);
  return { path, wasCap, cap: verified.maxOpenIssues, changed: true };
}

export function setDirectiveProse(
  flowDir: string,
  loop: string,
  section: 'Direction' | 'Rules',
  text: string,
): DirectiveProseWrite {
  const { path, content } = openDirective(flowDir, loop);
  const rewritten = withProseSection(content, section, text);

  let verified: LoopDirective;
  try {
    verified = parseLoopDirective(rewritten, path);
  } catch (error) {
    throw new Error(`${path}: the edit would not parse (${(error as Error).message})`);
  }

  if (rewritten === content) {
    return { path, section, text: sectionOf(verified, section), changed: false };
  }
  write(path, rewritten);
  return { path, section, text: sectionOf(verified, section), changed: true };
}

/** What the re-parse read back for the section just written. */
function sectionOf(directive: LoopDirective, section: 'Direction' | 'Rules'): string {
  return section === 'Direction' ? directive.direction : directive.rules;
}

/**
 * The body with `## <section>` replaced, appended or removed.
 *
 * Pure and exported so the rewrite is testable without a directive on disk —
 * the same split `withPausedField` and `withQueueFields` follow.
 */
export function withProseSection(
  content: string,
  section: 'Direction' | 'Rules',
  text: string,
): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  // Find the heading and the extent of its section: up to the next `##`.
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[i] ?? '');
    if (heading === null) continue;
    if (start === -1 && heading[1]?.trim().toLowerCase() === section.toLowerCase()) {
      start = i;
      continue;
    }
    if (start !== -1) {
      end = i;
      break;
    }
  }

  const body = text.trim();
  const block = body.length === 0 ? [] : [`## ${section}`, '', ...body.split('\n'), ''];

  if (start !== -1) {
    lines.splice(start, end - start, ...block);
    return trimTrailingBlanks(lines).join(eol);
  }
  if (block.length === 0) return content;

  // Absent: append in the grammar's order — Direction before Rules.
  if (section === 'Direction') {
    const rulesAt = lines.findIndex((line) => /^##\s+rules\s*$/i.test(line));
    if (rulesAt !== -1) {
      lines.splice(rulesAt, 0, ...block);
      return trimTrailingBlanks(lines).join(eol);
    }
  }
  return trimTrailingBlanks([...lines, '', ...block]).join(eol);
}

/** One trailing newline, however many blank lines a splice left behind. */
function trimTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] ?? '').trim().length === 0) out.pop();
  out.push('');
  return out;
}

export function setDirectivePaused(
  flowDir: string,
  loop: string,
  paused: boolean,
): DirectivePausedWrite {
  const { path, directive, content } = openDirective(flowDir, loop);

  const wasPaused = directive.paused;
  if (wasPaused === paused) {
    return { path, wasPaused, paused, changed: false };
  }

  write(path, withPausedField(content, paused));
  return { path, wasPaused, paused, changed: true };
}

/**
 * Set a loop directive's queue fields — where this loop's work comes from.
 *
 * VALIDATED TWICE, BEFORE AND AFTER, and neither check is redundant:
 *
 *   - BEFORE, the file is read and fully parsed through `readLoopDirective`,
 *     exactly as `setDirectivePaused` does, so a directive nobody could read is
 *     never rewritten; and the requested target is checked against the grammar's
 *     coupling, so a `github` with no repo refuses without touching the disk.
 *   - AFTER, the rewritten STRING is parsed before it becomes a file. The
 *     writer's whole risk is producing a directive its own reader refuses — a
 *     stale `repo:` under `queue: ledger` does not degrade a loop, it stops it
 *     — and this makes that failure impossible rather than merely unlikely. The
 *     bytes that could not be read back are not written at all.
 *
 * `location` is read off that re-parse rather than echoed from the request, so
 * a ledger left to its default reports the default the parser resolves and not
 * an empty string this function invented.
 *
 * Asking for the source the file already names is a SUCCESS that wrote nothing
 * (`changed: false`), on the same rule the pause verbs follow: the caller asked
 * for a state and the state is the one on disk. The test is byte equality, so a
 * request that spells the same fact differently still leaves the file alone.
 */
export function setDirectiveQueue(
  flowDir: string,
  loop: string,
  target: DirectiveQueueTarget,
): DirectiveQueueWrite {
  const problem = queueTargetProblem(target);
  if (problem !== null) throw new Error(problem);
  const { path, directive, content } = openDirective(flowDir, loop);
  const wasQueue = directive.queue;
  const wasLocation = locationOf(directive);

  const rewritten = withQueueFields(content, target);
  let verified: LoopDirective;
  try {
    verified = parseLoopDirective(rewritten, path);
  } catch (error) {
    // Unreachable while the coupling above matches the parser's, which is the
    // point of keeping it: the day the two drift, this refuses instead of
    // writing a directive that stops the loop.
    throw new Error(`${path}: the edit would not parse (${(error as Error).message})`);
  }
  const location = locationOf(verified);

  if (rewritten === content) {
    return { path, wasQueue, wasLocation, queue: verified.queue, location, changed: false };
  }
  write(path, rewritten);
  return { path, wasQueue, wasLocation, queue: verified.queue, location, changed: true };
}

/**
 * Where a parsed directive points — `owner/name` under GitHub, the ledger file
 * under a ledger. The same fact `loop status` reports as `queueLocation`, from
 * the same two fields, so no surface has to work it out a second way.
 */
function locationOf(directive: LoopDirective): string | null {
  return directive.repo ?? directive.path ?? null;
}

/** Resolve, read and fully parse a loop's directive, refusing before any write. */
function openDirective(
  flowDir: string,
  loop: string,
): { path: string; directive: LoopDirective; content: string } {
  const directive = readLoopDirective(flowDir, loop);
  const path = loopDirectiveCandidates(flowDir, loop).find((candidate) => existsSync(candidate));
  if (path === undefined) {
    // Unreachable in practice — the read above just resolved it. Kept because
    // the alternative is a non-null assertion on a file another process could
    // have removed between the two calls.
    throw new Error(`no directive for loop '${loop}' at ${loopDirectiveCandidates(flowDir, loop).join(' or ')}`);
  }
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new Error(`${path}: unreadable (${(error as Error).message})`);
  }
  return { path, directive, content };
}

/** Write the rewritten directive, naming the file in any failure. */
function write(path: string, content: string): void {
  try {
    atomicWrite(path, content);
  } catch (error) {
    throw new Error(`${path}: could not be written (${(error as Error).message})`);
  }
}
