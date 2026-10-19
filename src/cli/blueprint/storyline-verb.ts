/**
 * CODE STORYLINE — the `blueprint storyline` verb (plan `code-storyline`
 * phase 3).
 *
 *   planflow-ai blueprint storyline --target <repo> (--file <path> | --part <ref>) --json
 *
 * The one door the app reads a story through (allowed-pattern #14): it reads
 * the file(s), asks the pure extractor (`storyline.ts`) for the pieces, ranks
 * the ways in by how many OTHER files import them, and prints ONE JSON line —
 * a `StorylineAnswer`. Nothing it computes enters `graph.json`.
 *
 * Exit codes follow the family: a refusal that carries an answer (not found,
 * too large, no compiler, not TypeScript, does not parse) is printed as the
 * JSON line and exits 0 — the reader still has something to show. Only a bad
 * QUESTION exits 1, with one `storyline refused: <reason> — <sentence>` line:
 * neither or both of --file/--part, a path that leaves the project, a part
 * nobody recorded.
 *
 * CACHED BY CONTENT. A file's extraction is stored at
 * `flow/brain/.structure/storyline/<key>.json`, key = sha256 of the extractor
 * version, the path and the file's content hash (`hashFileContent`, the same
 * algorithm as `hashRepoFile` over the bytes already read — one hash, one read).
 * The RANKING is never cached with it: it depends on every other file, so it is
 * recomputed from the import index (`storyline-imports.ts`) on each run. A repo
 * with no `flow/` folder is read and never written into.
 *
 * RANKING — what "used from" counts, per exported piece of the story:
 *   • a named import `{ a, b as c }` or a re-export `export { a } from` counts
 *     its file once for `a`; a default import counts for the default export;
 *   • a namespace import `* as x` counts its file for each `x.name` the file
 *     mentions — never once for everything, which would tie every piece;
 *   • a public method of an exported class counts each file that imports the
 *     class AND mentions `.method` — the syntax cannot prove which object it is
 *     called on, but a rank is an ordering, not a drawn arrow;
 *   • test files are not counted: a suite imports everything it tests, and the
 *     story should open where the PRODUCT starts;
 *   • in part mode only importers OUTSIDE the part count — the part's own files
 *     calling each other are its inside, already drawn as arrows;
 *   • `export * from` names nothing and counts nothing; a barrel that
 *     re-exports the file is one importer, its own importers are not followed.
 * Ties (and zero) keep file order.
 *
 * IN A PLAN'S CONTEXT (`--plan <name> [--base <rev>]`, plan
 * `story-today-after`) the answer also carries `compare` — the plan's Today ⇄
 * After for this story, computed by `storyline-compare.ts`. A plan that is not
 * active is not a bad question: the story is answered without `compare` and
 * with a `compareNote` sentence saying why. A plan carrying CHANGE NOTES
 * widens the story to every note's file and each new note's callers' files —
 * a `<project>/` target read in that sibling project's checkout (found through
 * `workspace status --target`), spelled `<project>/<path>` on the story — and
 * the answer gains `bands`, the story's files grouped by project, this one first.
 *
 * ANY LANGUAGE (plan `story-any-language` phase 3). Every file goes to the
 * reader its extension names (`storyline-reader.ts`): TS/JS to the TypeScript
 * compiler, exactly as before; a language with a tree-sitter table to the
 * WebAssembly engine, started once per run with only the grammars the request
 * needs; anything else is the refusal naming the language. A part may mix
 * languages — each file is read by its own reader, calls between the part's
 * files become arrows within a language's own import rules, and the part's
 * `language` is the one language all its files share (TS and JS count as one,
 * `typescript`), else `mixed`. Ranking follows each language's imports.
 */

import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type * as TS from 'typescript';
import { readFileBytesSafe, readFileSafe, toPosixPath } from './extractors/scan.js';
import { addressableParts, normalizeAnchorRef } from './feature-graph.js';
import { featuresDir, findFeatureByRef, readFeatures, readParts } from './feature-store.js';
import type { TsModule } from './storyline-compiler.js';
import { readProjectImportIndex, storylineCacheDir, type ProjectImportIndex } from './storyline-imports.js';
import { MIXED_STORYLINE_LANGUAGE } from './storyline-language-labels.js';
import { resolveRelativeImport, storylineLanguageOf, unsupportedLanguageRefusal } from './storyline.js';
import { directoryTarget, isDirectoryTarget, storylineTableFor, type StorylineProject } from './storyline-languages.js';
import {
  hasStorylineReader,
  isStoryTestFile,
  storylineProjectOf,
  storylineReaderOf,
  StorylineReaders,
  type StorylineReadersDeps,
} from './storyline-reader.js';
import {
  STORYLINE_VERSION,
  type StorylineAnswer,
  type StorylineBand,
  type StorylineLanguageId,
  type StorylineCall,
  type StorylineEntry,
  type StorylinePiece,
  type StorylineRefusal,
  type StorylineResult,
} from './storyline-types.js';
import { hashFileContent } from './store.js';
import {
  compareStoryline,
  findActivePlan,
  makeBaseTextReader,
  parseCaller,
  readPlanIntent,
  resolveStoryBase,
  type NoteLocation,
} from './storyline-compare.js';
import { readEffectiveProposals } from './proposal-store.js';
import type { ChangeNote } from '../state/change-notes.js';
import { workspaceContextOf, workspaceStatus } from '../handlers/workspace-model.js';
import { functionPiecesOf, noteProjectsFrom, pieceHolding, quoteInFile } from './storyline-notes.js';

// ── Caps ─────────────────────────────────────────────────

/** A single file longer than this is shown as plain code, not a story. */
export const MAX_STORY_FILE_LINES = 5_000;
/** A part spanning more files than this is too big to read as one story. */
export const MAX_PART_FILES = 40;
/** …or more lines, summed over its files. */
export const MAX_PART_LINES = 8_000;

// The storyline cache's folder lives with the import index it holds, so the
// features graph's folder rows read the same cache (`storyline-imports.ts`).
export { STORYLINE_CACHE_DIRNAME } from './storyline-imports.js';

const DEFAULT_EXPORT = 'default';

// ── The verb ─────────────────────────────────────────────

export interface StorylineVerbInput {
  /** The project's checkout. */
  repoRoot: string;
  file?: string;
  part?: string;
  /** The plan whose Today ⇄ After to add (`--plan`). */
  plan?: string;
  /** The plan's starting point, when the caller names it (`--base`). */
  base?: string;
  /** What a given base is — a thread worktree's base when the app passes one. */
  baseSource?: 'given' | 'worktree';
}

/** Injected in tests (`loadTs`, `loadTreeSitter`); the real loaders everywhere else. */
export type StorylineVerbDeps = StorylineReadersDeps;

export interface StorylineVerbOutput {
  exitCode: number;
  /** Exactly what the command prints on stdout (one line, newline-terminated). */
  stdout: string;
}

export async function runStorylineVerb(input: StorylineVerbInput, deps: StorylineVerbDeps = {}): Promise<StorylineVerbOutput> {
  const file = typeof input.file === 'string' ? input.file.trim() : '';
  const part = typeof input.part === 'string' ? input.part.trim() : '';
  const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
  // `--plan` ALONE is a story of its own: the plan's change notes, in the code
  // they change (`readPlanStory`).
  const planOnly = file === '' && part === '' && plan !== '';
  if (!planOnly && (file === '') === (part === '')) {
    return refuse('arguments', 'pass exactly one of --file <path> or --part <feature-ref> (or --plan <name> alone)');
  }
  const repoRoot = resolve(input.repoRoot);
  if (!isDirectory(repoRoot)) return refuse('no-target', `'${input.repoRoot}' is not a folder`);
  const readers = new StorylineReaders(deps);
  const request: ComparisonRequest = { plan, base: input.base, baseSource: input.baseSource };
  if (planOnly) return readPlanStory(repoRoot, request, readers);
  const finish: Finish =
    plan === ''
      ? (result) => result
      : (result, seed) => withComparison(repoRoot, result, readers, request, seed);
  return file !== '' ? readFileStory(repoRoot, file, readers, finish) : readPartStory(repoRoot, part, readers, finish);
}

/**
 * Story files that are not this checkout's (a sibling project's, spelled
 * `<slug>/<path>`): their texts, read in the sibling's checkout.
 */
interface ForeignSeed {
  texts: ReadonlyMap<string, string>;
  foreign: ReadonlySet<string>;
  /**
   * Every piece id of a story file whose story carries only some of its
   * pieces (a plan's story): what Today's pieces are matched against, so an
   * undrawn function never reads as removed.
   */
  wholeFilePieceIds?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The last step of a story that was read: identity, or the plan's comparison added. */
type Finish = (result: StorylineResult, seed?: ForeignSeed) => StorylineResult | Promise<StorylineResult>;

interface ComparisonRequest {
  plan: string;
  base?: string;
  baseSource?: 'given' | 'worktree';
}

async function withComparison(
  repoRoot: string,
  result: StorylineResult,
  readers: StorylineReaders,
  request: ComparisonRequest,
  seed?: ForeignSeed,
): Promise<StorylineResult> {
  const flowDir = join(repoRoot, 'flow');
  const found = findActivePlan(flowDir, request.plan);
  if (found === null) {
    return {
      ...result,
      compareNote: `Flow couldn't find an active plan named ${request.plan}, so this story has no Today and After — finished plans are not compared.`,
    };
  }
  const intent = readPlanIntent(found.name, found.content, readEffectiveProposals(flowDir, found.name));
  const project = storylineProjectOf(repoRoot);
  // A plan with change notes draws every note's function: its file (and its
  // callers' files, and a sibling project's files) join the story.
  const widened = intent.notes.length > 0 ? await widenForNotes(repoRoot, result, readers, intent.notes, seed) : null;
  const story = widened?.result ?? result;
  const foreign = widened?.foreign ?? new Set<string>(seed?.foreign ?? []);
  const base = resolveStoryBase({
    repoRoot,
    flowDir,
    plan: found.name,
    given: request.base,
    givenSource: request.baseSource,
    files: story.files.filter((file) => !foreign.has(file)),
  });
  const readBaseText =
    base.base === null ? () => null : makeBaseTextReader(repoRoot, base.base, storylineCacheDir(repoRoot));
  // Today is read by the reader After was read by — its grammar is loaded already.
  const extract = (file: string, text: string): StorylineAnswer => readers.extract(file, text, project);
  const compare = compareStoryline({
    result: story,
    plan: intent,
    base,
    readBaseText,
    extract,
    fileExists: project.fileExists,
    ...(seed?.wholeFilePieceIds === undefined ? {} : { afterPieceIds: (file: string) => seed.wholeFilePieceIds?.get(file) }),
    ...(widened === null
      ? {}
      : { readText: widened.readText, noteLocation: widened.noteLocation, foreignFiles: foreign }),
  });
  return { ...story, compare, ...(widened === null ? {} : { bands: widened.bands }) };
}

// ── A plan's change notes on the story ──────────────────

/** One checkout a note can be read in: this project's, or a sibling's. */
interface NoteCheckout {
  /** Null for this project. */
  project: string | null;
  root: string;
  /** What its story files are spelled with: '' here, `<slug>/` for a sibling. */
  prefix: string;
}

interface NoteWidening {
  result: StorylineResult;
  bands: StorylineBand[];
  /** Story files from a sibling checkout. */
  foreign: Set<string>;
  readText: (storyFile: string) => string | null;
  noteLocation: (note: ChangeNote) => NoteLocation;
}

/** What `workspace status --target` says about this project's siblings — nothing outside a Workspace. */
interface SiblingProjects {
  self: string | null;
  checkouts: Map<string, string | null>;
  colorIndex: Map<string, number>;
}

function siblingProjectsOf(repoRoot: string): SiblingProjects {
  const status = workspaceContextOf(repoRoot);
  // Who `self` is and where the siblings are: the one answer `plan notes` reads too.
  const projects = noteProjectsFrom(status);
  if (status === null || status.workspace === null || projects.self === null) return { self: null, checkouts: new Map(), colorIndex: new Map() };
  // WORKSPACE.JSON ORDER is a project's colour on every machine (the same
  // rule as the Workspace map, `workspace-graph.ts`).
  const colorIndex = new Map<string, number>();
  try {
    const listing = workspaceStatus({ workspace: status.workspace.slug });
    const ordered = 'workspaces' in listing ? (listing.workspaces[0]?.projects ?? []) : [];
    ordered.forEach((project, index) => colorIndex.set(project.slug, index));
  } catch {
    // An unreadable listing costs the bands their colour, never their files.
  }
  return { self: projects.self, checkouts: new Map(projects.checkouts), colorIndex };
}

/**
 * Widen a story to every change note's code: each note's file and each new
 * note's callers' files — read in this checkout, or in a sibling project's
 * checkout for a `<project>/` target. A file that cannot be read as a story
 * (missing, too long, no reader, does not parse) is left out and its note
 * says so (`pieceMissing` / `fileMissing`); a sibling with no checkout here
 * leaves its notes `codeUnavailable`. Never more than `MAX_PART_FILES` files.
 */
async function widenForNotes(
  repoRoot: string,
  result: StorylineResult,
  readers: StorylineReaders,
  notes: readonly ChangeNote[],
  seed?: ForeignSeed,
): Promise<NoteWidening> {
  const siblings = siblingProjectsOf(repoRoot);
  const here: NoteCheckout = { project: null, root: repoRoot, prefix: '' };
  const checkoutOf = (project: string | undefined): NoteCheckout | null => {
    if (project === undefined || project === siblings.self) return here;
    const root = siblings.checkouts.get(project);
    return root === undefined || root === null ? null : { project, root: resolve(root), prefix: `${project}/` };
  };

  const texts = new Map<string, string>();
  const stories: StoryFile[] = [];
  const localProject = storylineProjectOf(repoRoot);
  for (const file of result.files) {
    // A sibling's file already on the story was read in its own checkout.
    const text = seed?.foreign.has(file) === true ? (seed.texts.get(file) ?? null) : localProject.readFile(file);
    if (text !== null) texts.set(file, text);
  }
  const added: StoryFile[] = [];
  const foreign = new Set<string>(seed?.foreign ?? []);
  const tried = new Set<string>(result.files);
  const cacheDir = storylineCacheDir(repoRoot);

  const addFile = async (checkout: NoteCheckout, file: string): Promise<void> => {
    const storyFile = `${checkout.prefix}${file}`;
    if (tried.has(storyFile) || result.files.length + added.length >= MAX_PART_FILES) return;
    tried.add(storyFile);
    const read = await readNoteFile(readers, checkout.root, file, checkout.root === repoRoot ? cacheDir : null);
    if (read === null) return;
    const story = checkout.prefix === '' ? read.result : namespacedStory(read.result, checkout.prefix);
    if (checkout.prefix !== '') foreign.add(storyFile);
    texts.set(storyFile, read.text);
    added.push({ file: storyFile, text: read.text, result: story });
  };

  for (const note of notes) {
    const checkout = checkoutOf(note.target.project);
    if (checkout !== null) await addFile(checkout, note.target.file);
  }
  // New notes' callers: one named by path is read there; a bare name is
  // looked for among the story's pieces, then among the files that import the
  // note's file — kept only when exactly one of them declares it.
  let index: ProjectImportIndex | null = null;
  for (const note of notes) {
    if (note.kind !== 'new') continue;
    const checkout = checkoutOf(note.target.project);
    if (checkout === null) continue;
    for (const caller of note.callers ?? []) {
      const parsed = parseCaller(caller);
      if (parsed.file !== undefined) {
        await addFile(checkout, parsed.file);
        continue;
      }
      const pieces = [...result.pieces, ...added.flatMap((story) => story.result.pieces)];
      if (pieces.some((piece) => piece.name === parsed.symbol || `${piece.className ?? ''}.${piece.name}` === parsed.symbol)) continue;
      if (checkout.prefix !== '') continue; // A sibling's import index is its own project's to build.
      index = index ?? readProjectImportIndex(repoRoot, readers, cacheDir);
      const declaring: string[] = [];
      for (const importer of index.importersOf(note.target.file)) {
        const text = localProject.readFile(importer);
        if (text === null || !mentionsWord(text, parsed.symbol.split('.').pop() ?? '')) continue;
        const read = await readNoteFile(readers, repoRoot, importer, cacheDir);
        if (read !== null && read.result.pieces.some((piece) => piece.name === parsed.symbol || `${piece.className ?? ''}.${piece.name}` === parsed.symbol)) {
          declaring.push(importer);
        }
      }
      const [only] = declaring;
      if (declaring.length === 1 && only !== undefined) await addFile(here, only);
    }
  }

  for (const file of result.files) {
    const text = texts.get(file);
    if (text !== undefined) stories.push({ file, text, result: { ...result, files: [file], pieces: result.pieces.filter((piece) => piece.file === file) } });
  }
  const merged = added.length === 0 ? result : mergeNoteFiles(readers, result, [...stories, ...added], added);

  const projects: Array<string | null> = [null];
  for (const note of notes) {
    const project = note.target.project === undefined || note.target.project === siblings.self ? null : note.target.project;
    if (!projects.includes(project)) projects.push(project);
  }
  for (const file of foreign) {
    const project = file.slice(0, file.indexOf('/'));
    if (project !== '' && !projects.includes(project)) projects.push(project);
  }
  const bands: StorylineBand[] = projects.map((project) => {
    const slug = project ?? siblings.self;
    const colorIndex = slug === null ? undefined : siblings.colorIndex.get(slug);
    const files =
      project === null
        ? merged.files.filter((file) => !foreign.has(file))
        : merged.files.filter((file) => foreign.has(file) && file.startsWith(`${project}/`));
    return { project, ...(colorIndex === undefined ? {} : { colorIndex }), files };
  });

  return {
    result: merged,
    bands,
    foreign,
    readText: (storyFile) => texts.get(storyFile) ?? null,
    noteLocation: (note) => {
      const checkout = checkoutOf(note.target.project);
      if (checkout === null) return { codeUnavailable: true };
      return {
        storyFile: `${checkout.prefix}${note.target.file}`,
        exists: storylineProjectOf(checkout.root).fileExists(note.target.file),
      };
    },
  };
}

/** One note's file read as a story, or null when it cannot be (never a refusal: the note says so). */
async function readNoteFile(
  readers: StorylineReaders,
  root: string,
  file: string,
  cacheDir: string | null,
  maxLines: number = MAX_STORY_FILE_LINES,
): Promise<{ text: string; result: StorylineResult } | null> {
  const guarded = guardPath(root, file);
  if (guarded.kind !== 'ok' || !hasStorylineReader(guarded.rel)) return null;
  const bytes = readFileBytesSafe(guarded.abs);
  if (bytes === null) return null;
  const text = bytes.toString('utf-8');
  if (countLines(text) > maxLines) return null;
  await readers.prepare([guarded.rel]);
  if (readers.unavailable(guarded.rel, text) !== null) return null;
  const extracted = extractCached(readers, root, guarded.rel, bytes, text, cacheDir);
  return extracted.ok ? { text, result: extracted } : null;
}

/** A sibling project's story, every file, id and call spelled `<project>/<path>`. */
function namespacedStory(result: StorylineResult, prefix: string): StorylineResult {
  const spell = (value: string): string => `${prefix}${value}`;
  return {
    ...result,
    files: result.files.map(spell),
    pieces: result.pieces.map((piece) => ({ ...piece, id: spell(piece.id), file: spell(piece.file) })),
    calls: result.calls.map((call) => ({
      ...call,
      from: spell(call.from),
      to: call.to === null ? null : spell(call.to),
      ...(call.external === undefined ? {} : { external: { ...call.external, file: spell(call.external.file) } }),
    })),
    typeUses: result.typeUses.map((use) => ({ from: spell(use.from), to: spell(use.to) })),
    entries: result.entries.map((entry) => ({ ...entry, pieceId: spell(entry.pieceId) })),
    classes: result.classes.map((entry) => ({ ...entry, file: spell(entry.file) })),
  };
}

/**
 * The story with the notes' files added after its own: pieces concatenated, a
 * call into another story file turned into an arrow (as a part's are), the
 * entries unchanged — the story still opens where it opened.
 */
function mergeNoteFiles(
  readers: StorylineReaders,
  result: StorylineResult,
  stories: readonly StoryFile[],
  added: readonly StoryFile[],
): StorylineResult {
  const pieces = [...result.pieces, ...added.flatMap((story) => story.result.pieces)];
  const pieceIds = new Set(pieces.map((piece) => piece.id));
  const exportTables = new Map(stories.map((story) => [story.file, exportTableOf(readers, story)]));
  const calls = [...result.calls, ...added.flatMap((story) => story.result.calls)].map((call) =>
    internalized(call, exportTables, pieceIds),
  );
  return {
    ...result,
    files: [...result.files, ...added.map((story) => story.file)],
    language: partLanguage([result.language, ...added.map((story) => story.result.language)]),
    pieces,
    calls,
    typeUses: [...result.typeUses, ...added.flatMap((story) => story.result.typeUses)],
    classes: [...result.classes, ...added.flatMap((story) => story.result.classes)],
  };
}

function refuse(reason: string, sentence: string): StorylineVerbOutput {
  return { exitCode: 1, stdout: `storyline refused: ${reason} — ${sentence}\n` };
}

function answer(value: StorylineAnswer): StorylineVerbOutput {
  return { exitCode: 0, stdout: `${JSON.stringify(value)}\n` };
}

// ── A sibling project's file ─────────────────────────────

/**
 * `--file <slug>/<path>` naming a sibling Workspace project's file (as the
 * story spells it): read in that project's checkout, never cached there (a
 * sibling's checkout is not this project's to write into), every id spelled
 * `<slug>/<path>`. Null when the path names no sibling with a checkout here,
 * or the file cannot be read as a story — the caller answers not-found.
 * Its ways in are ranked by reach alone: the sibling's import index is that
 * project's own to build.
 */
async function readSiblingFileStory(
  repoRoot: string,
  rel: string,
  readers: StorylineReaders,
  finish: Finish,
): Promise<StorylineVerbOutput | null> {
  const slash = rel.indexOf('/');
  if (slash <= 0) return null;
  const slug = rel.slice(0, slash);
  const siblings = siblingProjectsOf(repoRoot);
  const root = slug === siblings.self ? undefined : siblings.checkouts.get(slug);
  if (root === undefined || root === null) return null;
  const read = await readNoteFile(readers, resolve(root), rel.slice(slash + 1), null);
  if (read === null) return null;
  const reach = reachOf(read.result.calls);
  const entries = [...read.result.entries]
    .map((entry) => ({ pieceId: entry.pieceId, usedFrom: 0 }))
    .sort((a, b) => (reach.get(b.pieceId) ?? 0) - (reach.get(a.pieceId) ?? 0));
  const story = namespacedStory({ ...read.result, entries }, `${slug}/`);
  return answer(await finish(story, { texts: new Map([[rel, read.text]]), foreign: new Set([rel]) }));
}

// ── A plan's story: its change notes in the code they change ──

/**
 * A plan's notes may name a file far longer than a story is read whole (a
 * 10,000-line API client): only the noted functions are drawn, so the file is
 * read up to this.
 */
export const MAX_PLAN_NOTE_FILE_LINES = 20_000;

/** One project's share of a plan's story while it is read. */
interface PlanProjectRead {
  /** Null for this project. */
  project: string | null;
  root: string;
  prefix: string;
  notes: ChangeNote[];
  /** Project-relative files to read, in note order. */
  wanted: string[];
  stories: StoryFile[];
}

/**
 * `blueprint storyline --plan <name>` with no --file / --part: the plan's
 * story, built from its change notes (plan review). Every note's file — here,
 * or in a sibling Workspace project's checkout — is read with the same
 * readers, any language. The story is read like any other code story (the
 * board draws it with the same layout), so it carries the code AROUND the
 * notes, not only the noted lines (`planProjectStory`):
 *
 *   - every noted function, the callers each new note names, and a function
 *     on a direct path between two of them;
 *   - for a file note, the piece holding its quote (`where:`), else the
 *     file's pieces the drawn code calls or is called by, else its first piece;
 *   - then their direct callees and callers in the notes' files, and the data
 *     structures they use — up to `MAX_PLAN_STORY_BOXES` pieces in all.
 *
 * Calls between the drawn pieces are resolved per project as a part's are,
 * plus one the PLAN proves: a noted function whose code calls another noted
 * function by name (`service.list_for_user(`) when that name is one drawn
 * function. A call to a piece of the notes' files that is not drawn is a
 * chip into that file. Ways in: the drawn functions nothing drawn calls, a
 * noted one first. Bands and the comparison follow, as for any story in a
 * plan's context — the comparison sees EVERY piece of a file-noted file, so
 * Verify's fact for a file note is about the whole file; the answer then
 * carries only the drawn pieces, plus an `excerpt` of a few lines for a file
 * note whose place no drawn piece holds (`withNoteExcerpts`). A plan with no
 * notes, or no active plan, answers not-found.
 */
async function readPlanStory(repoRoot: string, request: ComparisonRequest, readers: StorylineReaders): Promise<StorylineVerbOutput> {
  const flowDir = join(repoRoot, 'flow');
  const found = findActivePlan(flowDir, request.plan);
  if (found === null) {
    return answer({ ok: false, reason: 'not-found', sentence: `Flow couldn't find an active plan named ${request.plan}.` });
  }
  const intent = readPlanIntent(found.name, found.content, readEffectiveProposals(flowDir, found.name));
  if (intent.notes.length === 0) {
    return answer({ ok: false, reason: 'not-found', sentence: 'This plan has no change notes to show in the code.' });
  }

  const siblings = siblingProjectsOf(repoRoot);
  const cacheDir = storylineCacheDir(repoRoot);
  const groups = new Map<string, PlanProjectRead>();
  const groupOf = (project: string | undefined): PlanProjectRead | null => {
    const key = project === undefined || project === siblings.self ? '' : project;
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    let group: PlanProjectRead;
    if (key === '') {
      group = { project: null, root: repoRoot, prefix: '', notes: [], wanted: [], stories: [] };
    } else {
      const root = siblings.checkouts.get(key);
      if (root === undefined || root === null) return null;
      group = { project: key, root: resolve(root), prefix: `${key}/`, notes: [], wanted: [], stories: [] };
    }
    groups.set(key, group);
    return group;
  };
  let budget = MAX_PART_FILES;
  const want = (group: PlanProjectRead, file: string): void => {
    const rel = toPosixPath(file.trim()).replace(/^\.\//, '');
    if (rel === '' || group.wanted.includes(rel) || budget <= 0) return;
    budget -= 1;
    group.wanted.push(rel);
  };
  for (const note of intent.notes) {
    const group = groupOf(note.target.project);
    if (group === null) continue;
    group.notes.push(note);
    want(group, note.target.file);
    if (note.kind !== 'new') continue;
    for (const caller of note.callers ?? []) {
      const parsed = parseCaller(caller);
      if (parsed.file !== undefined) want(group, parsed.file);
    }
  }

  const texts = new Map<string, string>();
  const foreign = new Set<string>();
  const wholeFilePieceIds = new Map<string, Set<string>>();
  const results: StorylineResult[] = [];
  const drawn = new Set<string>();
  const boxes = { left: MAX_PLAN_STORY_BOXES };
  // This project first, then the siblings in the order their notes come.
  const ordered = [...groups.values()].sort((a, b) => (a.project === null ? 0 : 1) - (b.project === null ? 0 : 1));
  for (const group of ordered) {
    for (const file of group.wanted) {
      const read = await readNoteFile(readers, group.root, file, group.prefix === '' ? cacheDir : null, MAX_PLAN_NOTE_FILE_LINES);
      if (read === null) continue;
      group.stories.push({ file, text: read.text, result: read.result });
      texts.set(`${group.prefix}${file}`, read.text);
      if (group.prefix !== '') foreign.add(`${group.prefix}${file}`);
      wholeFilePieceIds.set(`${group.prefix}${file}`, new Set(read.result.pieces.map((piece) => `${group.prefix}${piece.id}`)));
    }
    if (group.stories.length === 0) continue;
    const own = planProjectStory(readers, group, boxes);
    for (const id of own.drawn) drawn.add(`${group.prefix}${id}`);
    results.push(group.prefix === '' ? own.result : namespacedStory(own.result, group.prefix));
  }

  const story: StorylineResult = {
    ok: true,
    scope: 'part',
    files: results.flatMap((result) => result.files),
    language: partLanguage(results.map((result) => result.language)),
    pieces: results.flatMap((result) => result.pieces),
    calls: results.flatMap((result) => result.calls),
    typeUses: results.flatMap((result) => result.typeUses),
    // Each project's ways in, this project's first.
    entries: results.flatMap((result) => result.entries),
    classes: results.flatMap((result) => result.classes),
  };
  const compared = await withComparison(repoRoot, story, readers, request, { texts, foreign, wholeFilePieceIds });
  return answer(withNoteExcerpts(drawnStory(compared, drawn), texts));
}

/** The most pieces a plan's story draws: every noted one always, the code around them up to this. */
export const MAX_PLAN_STORY_BOXES = 12;
/** How many lines a file note's excerpt shows: the lines around its quote, or the file's first statement on. */
export const PLAN_EXCERPT_LINES = 12;

/**
 * One project's share of a plan's story, in its own paths. `result` carries
 * the drawn pieces AND every piece of a file-noted file (the comparison's
 * fact for a file note is about the whole file); `drawn` is what the answer
 * keeps (see `readPlanStory`). `boxes` is the story's box budget, shared by
 * every project's share; the noted pieces never wait for it.
 */
function planProjectStory(
  readers: StorylineReaders,
  group: PlanProjectRead,
  boxes: { left: number },
): { result: StorylineResult; drawn: Set<string> } {
  const all = group.stories.flatMap((story) => story.result.pieces);
  const byId = new Map(all.map((piece) => [piece.id, piece]));
  const pieceIds = new Set(byId.keys());
  const exportTables = new Map(group.stories.map((story) => [story.file, exportTableOf(readers, story)]));
  const resolved = group.stories.flatMap((story) => story.result.calls.map((call) => internalized(call, exportTables, pieceIds)));

  const noted = new Set<string>();
  for (const note of group.notes) {
    const symbol = note.target.symbol;
    if (symbol !== undefined && symbol !== '') {
      for (const piece of functionPiecesOf(all, note.target.file, symbol)) noted.add(piece.id);
    }
    if (note.kind !== 'new') continue;
    for (const caller of note.callers ?? []) {
      const parsed = parseCaller(caller);
      const named = all.filter((piece) => piece.name === parsed.symbol || `${piece.className ?? ''}.${piece.name}` === parsed.symbol);
      const inFile = named.filter((piece) => piece.file === (parsed.file ?? note.target.file));
      const candidates = inFile.length > 0 || parsed.file !== undefined ? inFile : named;
      const [only] = candidates;
      if (candidates.length === 1 && only !== undefined) noted.add(only.id);
    }
  }

  const callable = (piece: StorylinePiece | undefined): boolean => piece !== undefined && (piece.kind === 'function' || piece.kind === 'method');
  const isData = (piece: StorylinePiece | undefined): boolean =>
    piece !== undefined && (piece.kind === 'interface' || piece.kind === 'type' || piece.kind === 'enum');
  const notedPieces = all.filter((piece) => noted.has(piece.id) && callable(piece));
  const nameCount = new Map<string, number>();
  for (const piece of notedPieces) nameCount.set(piece.name, (nameCount.get(piece.name) ?? 0) + 1);
  const planLinks: StorylineCall[] = [];
  for (const from of notedPieces) {
    for (const to of notedPieces) {
      if (from.id === to.id || nameCount.get(to.name) !== 1) continue;
      if (resolved.some((call) => call.from === from.id && call.to === to.id)) continue;
      const line = mentionLine(from, to.name);
      if (line !== null) planLinks.push({ from: from.id, line, to: to.id });
    }
  }
  const calls = [...resolved, ...planLinks];
  const filePosition = new Map(group.stories.map((story, index) => [story.file, index]));
  const inFileOrder = (a: StorylinePiece, b: StorylinePiece): number =>
    (filePosition.get(a.file) ?? 0) - (filePosition.get(b.file) ?? 0) || a.startLine - b.startLine;

  // ── What is drawn, in the order it earns its place ──
  const drawn = new Set<string>();
  const draw = (id: string, always: boolean): void => {
    if (drawn.has(id) || !pieceIds.has(id)) return;
    if (!always && boxes.left <= 0) return;
    drawn.add(id);
    boxes.left -= 1;
  };
  // 1. The noted functions (and a new note's named callers).
  for (const piece of [...all].sort(inFileOrder)) if (noted.has(piece.id)) draw(piece.id, true);
  // 2. A function on a direct path between two of them.
  for (const piece of [...all].sort(inFileOrder)) {
    if (drawn.has(piece.id) || !callable(piece)) continue;
    const calledByNoted = calls.some((call) => call.to === piece.id && noted.has(call.from) && call.from !== piece.id);
    const callsNoted = calls.some((call) => call.from === piece.id && call.to !== null && noted.has(call.to) && call.to !== piece.id);
    if (calledByNoted && callsNoted) draw(piece.id, true);
  }
  // 3. A file note's quoted place.
  const fileNotes = group.notes.filter((note) => note.kind === 'file');
  for (const note of fileNotes) {
    const story = group.stories.find((entry) => entry.file === note.target.file);
    if (story === undefined || note.where === undefined) continue;
    const quote = quoteInFile(story.text, note.where);
    if (quote.found !== 'once') continue;
    const holder = pieceHolding(all, note.target.file, quote.startLine);
    if (holder !== null && holder.kind !== 'class') draw(holder.id, true);
  }
  // 4. The code around the noted functions: what they call, then what calls them.
  const around = [...drawn].map((id) => byId.get(id)).filter((piece): piece is StorylinePiece => callable(piece));
  const byLine = [...calls].sort((a, b) => a.line - b.line);
  for (const piece of around) {
    for (const call of byLine) if (call.from === piece.id && call.to !== null && call.to !== piece.id && callable(byId.get(call.to))) draw(call.to, false);
  }
  for (const piece of around) {
    for (const call of byLine) if (call.to === piece.id && call.from !== piece.id && callable(byId.get(call.from))) draw(call.from, false);
  }
  // 5. A file note with no place quoted: the file's pieces the drawn code
  //    touches, else its first piece — the note sits on code, not on nothing.
  for (const note of fileNotes) {
    const file = note.target.file;
    const own = all.filter((piece) => piece.file === file && piece.kind !== 'class').sort(inFileOrder);
    if (own.some((piece) => drawn.has(piece.id))) continue;
    for (const piece of own) {
      const touches = calls.some(
        (call) => (call.from === piece.id && call.to !== null && drawn.has(call.to)) || (call.to === piece.id && drawn.has(call.from)),
      );
      if (touches) draw(piece.id, false);
    }
    const [first] = own;
    if (!own.some((piece) => drawn.has(piece.id)) && first !== undefined) draw(first.id, true);
  }
  // 6. The data structures the drawn functions use.
  for (const use of group.stories.flatMap((story) => story.result.typeUses)) {
    if (drawn.has(use.from) && isData(byId.get(use.to))) draw(use.to, false);
  }

  // The comparison reads every piece of a file-noted file; the answer keeps only `drawn`.
  const wholeFiles = new Set(fileNotes.map((note) => note.target.file));
  const kept = new Set(drawn);
  for (const piece of all) if (wholeFiles.has(piece.file)) kept.add(piece.id);
  const pieces = all.filter((piece) => kept.has(piece.id));
  const order = new Map(pieces.map((piece, position) => [piece.id, position]));
  const keptCalls = calls
    .filter((call) => kept.has(call.from))
    .map((call): StorylineCall => {
      if (call.to === null || kept.has(call.to)) return call;
      // A call to a piece of these files the story leaves out: a chip into its file.
      const target = byId.get(call.to);
      return target === undefined
        ? { from: call.from, line: call.line, to: null, unresolvedName: call.to }
        : { from: call.from, line: call.line, to: null, external: { file: target.file, name: target.name } };
    })
    .sort((a, b) => (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0) || a.line - b.line);
  const drawnPieces = pieces.filter((piece) => drawn.has(piece.id));
  const drawnCalls = keptCalls.filter((call) => drawn.has(call.from) && (call.to === null || drawn.has(call.to)));
  const classNames = new Set(drawnPieces.filter((piece) => piece.className !== undefined).map((piece) => `${piece.file}\0${piece.className ?? ''}`));

  // Files in the order the story reaches them from its ways in; the rest after, in note order.
  const entries = planEntries(drawnPieces, drawnCalls, noted);
  const files: string[] = [];
  const reachFile = (file: string): void => {
    if (!files.includes(file)) files.push(file);
  };
  const seen = new Set<string>();
  const pending = entries.map((entry) => entry.pieceId);
  while (pending.length > 0) {
    const id = pending.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const piece = byId.get(id);
    if (piece !== undefined) reachFile(piece.file);
    for (const call of drawnCalls) if (call.from === id && call.to !== null) pending.push(call.to);
  }
  for (const story of group.stories) reachFile(story.file);

  return {
    drawn,
    result: {
      ok: true,
      scope: 'part',
      files,
      language: partLanguage(group.stories.map((story) => story.result.language)),
      pieces,
      calls: keptCalls,
      typeUses: group.stories.flatMap((story) => story.result.typeUses).filter((use) => kept.has(use.from) && kept.has(use.to)),
      entries,
      classes: group.stories
        .flatMap((story) => story.result.classes)
        .filter((entry) => classNames.has(`${entry.file}\0${entry.name}`)),
    },
  };
}

/**
 * The compared story cut to what is drawn: the drawn pieces and every piece
 * a note's prediction names (a caller the comparison found, a function the
 * run already built). A call to a piece left out becomes a chip into its
 * file, so the reader can still follow it.
 */
function drawnStory(story: StorylineResult, drawn: ReadonlySet<string>): StorylineResult {
  const keep = new Set(drawn);
  for (const prediction of story.compare?.predicted ?? []) {
    if (!prediction.kind.startsWith('note-')) continue;
    if ('pieceId' in prediction && typeof prediction.pieceId === 'string') keep.add(prediction.pieceId);
    if (prediction.kind === 'note-new') for (const id of Object.values(prediction.callerPieces)) keep.add(id);
  }
  const byId = new Map(story.pieces.map((piece) => [piece.id, piece]));
  const calls = story.calls
    .filter((call) => keep.has(call.from))
    .map((call): StorylineCall => {
      if (call.to === null || keep.has(call.to)) return call;
      const target = byId.get(call.to);
      return target === undefined
        ? { from: call.from, line: call.line, to: null, unresolvedName: call.to }
        : { from: call.from, line: call.line, to: null, external: { file: target.file, name: target.name } };
    });
  const pieces = story.pieces.filter((piece) => keep.has(piece.id));
  const classNames = new Set(pieces.filter((piece) => piece.className !== undefined).map((piece) => `${piece.file}\0${piece.className ?? ''}`));
  return {
    ...story,
    pieces,
    calls,
    typeUses: story.typeUses.filter((use) => keep.has(use.from) && keep.has(use.to)),
    entries: story.entries.filter((entry) => keep.has(entry.pieceId)),
    classes: story.classes.filter((entry) => classNames.has(`${entry.file}\0${entry.name}`)),
  };
}

/**
 * A FILE NOTE SITS ON CODE: when no drawn piece holds its quote — or, with no
 * quote, when its file has no drawn piece at all (an import block and a
 * top-level call, a test file with no functions) — the story carries an
 * `excerpt` of the file: the lines around the quote, else its first statement
 * after the imports and the header comment. The note's prediction then names the excerpt as its piece.
 */
function withNoteExcerpts(story: StorylineResult, texts: ReadonlyMap<string, string>): StorylineResult {
  const compare = story.compare;
  if (compare === undefined) return story;
  const pieces = [...story.pieces];
  const ids = new Set(pieces.map((piece) => piece.id));
  const predicted = compare.predicted.map((prediction) => {
    if (prediction.kind !== 'note-file' || prediction.codeUnavailable === true || prediction.fileMissing === true) return prediction;
    const text = texts.get(prediction.file);
    if (text === undefined) return prediction;
    const quote = prediction.quoteLines;
    const held = quote !== undefined && prediction.pieceId !== undefined && ids.has(prediction.pieceId);
    if (held) return prediction;
    if (quote === undefined && pieces.some((piece) => piece.file === prediction.file)) return prediction;
    const excerpt = excerptPiece(prediction.file, text, quote);
    if (excerpt === null) return prediction;
    if (!ids.has(excerpt.id)) {
      ids.add(excerpt.id);
      pieces.push(excerpt);
    }
    return quote === undefined ? prediction : { ...prediction, pieceId: excerpt.id };
  });
  return { ...story, pieces, compare: { ...compare, predicted } };
}

/** Lines that open a file before its first statement: imports, includes, a package line. */
const PREAMBLE_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|\}\s*from\s|from\s+\S+\s+import\b|use\s|using\s|package\s|#include\b|require\b|['"]use (?:strict|client|server)['"])/;

/** A line that is only a comment, in the comment styles the readers' languages use. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|#(?!include\b|!)|--|;)/;

/** A few lines of `file` as a piece: around `quote`, else from its first statement after the imports. */
function excerptPiece(file: string, text: string, quote: { startLine: number; endLine: number } | undefined): StorylinePiece | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
  if (lines.length === 0) return null;
  let start: number;
  let end: number;
  if (quote !== undefined) {
    start = Math.max(1, quote.startLine - 3);
    end = Math.min(lines.length, Math.max(quote.endLine + 3, start + PLAN_EXCERPT_LINES - 1));
  } else {
    let last = 0;
    const scan = Math.min(lines.length, 80);
    for (let index = 0; index < scan; index += 1) if (PREAMBLE_LINE.test(lines[index] ?? '')) last = index + 1;
    start = last + 1;
    // The first STATEMENT: a file's header comment is not what its note is about.
    while (start <= lines.length && ((lines[start - 1] ?? '').trim() === '' || COMMENT_LINE.test(lines[start - 1] ?? ''))) start += 1;
    if (start > lines.length) start = 1;
    end = Math.min(lines.length, start + PLAN_EXCERPT_LINES - 1);
  }
  return {
    id: `${file}#L${String(start)}-L${String(end)}`,
    kind: 'excerpt',
    name: file.slice(file.lastIndexOf('/') + 1),
    file,
    startLine: start,
    endLine: end,
    doc: null,
    text: lines.slice(start - 1, end).join('\n'),
    exported: false,
  };
}

/**
 * A plan story's ways in: the functions nothing else on the story calls —
 * one that reaches a noted function first (a caller drawn around a note
 * opens the story, so it reads left to right INTO the note), then the one
 * whose calls reach the most — then every other function.
 */
function planEntries(pieces: readonly StorylinePiece[], calls: readonly StorylineCall[], noted: ReadonlySet<string>): StorylineEntry[] {
  const callable = pieces.filter((piece) => piece.kind === 'function' || piece.kind === 'method');
  const called = new Set(calls.filter((call) => call.to !== null && call.to !== call.from).map((call) => call.to as string));
  const reach = reachOf(calls);
  const next = new Map<string, string[]>();
  for (const call of calls) if (call.to !== null && call.to !== call.from) next.set(call.from, [...(next.get(call.from) ?? []), call.to]);
  const reachesNoted = (start: string): boolean => {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (noted.has(id)) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(next.get(id) ?? []));
    }
    return false;
  };
  const byReach = (list: readonly StorylinePiece[]): StorylinePiece[] =>
    [...list].sort(
      (a, b) => Number(reachesNoted(b.id)) - Number(reachesNoted(a.id)) || (reach.get(b.id) ?? 0) - (reach.get(a.id) ?? 0),
    );
  const roots = byReach(callable.filter((piece) => !called.has(piece.id)));
  const rest = byReach(callable.filter((piece) => called.has(piece.id)));
  return [...roots, ...rest].map((piece) => ({ pieceId: piece.id, usedFrom: 0 }));
}

/**
 * The file line where `piece`'s body calls `name` — `x.name(`, `x->name(`,
 * `X::name(` or a bare `name(` — or null. The declaration's own line is not
 * a call.
 */
function mentionLine(piece: StorylinePiece, name: string): number | null {
  const pattern = new RegExp(`(?:(?:\\.|->|::)\\s*|(?<![\\w$.]))${escapeRegExp(name)}\\s*\\(`);
  const lines = piece.text.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? '')) return piece.startLine + index;
  }
  return null;
}

// ── One file ─────────────────────────────────────────────

async function readFileStory(
  repoRoot: string,
  requested: string,
  readers: StorylineReaders,
  finish: Finish,
): Promise<StorylineVerbOutput> {
  const guarded = guardPath(repoRoot, requested);
  if (guarded.kind === 'outside') {
    return refuse('outside-project', `'${requested}' is not inside the project`);
  }
  const rel = guarded.rel;
  const bytes = guarded.kind === 'ok' ? readFileBytesSafe(guarded.abs) : null;
  if (bytes === null) {
    // `<slug>/<path>` — a sibling Workspace project's file, as the story spells it.
    const sibling = await readSiblingFileStory(repoRoot, rel, readers, finish);
    if (sibling !== null) return sibling;
    return answer({
      ok: false,
      reason: 'not-found',
      sentence: `Flow couldn't find ${basename(rel)} in this project.`,
      file: rel,
    });
  }
  const text = bytes.toString('utf-8');
  const lines = countLines(text);
  if (lines > MAX_STORY_FILE_LINES) {
    return answer({
      ok: false,
      reason: 'too-large',
      sentence: `${basename(rel)} is ${formatCount(lines)} lines — longer than Flow reads as a story (${formatCount(MAX_STORY_FILE_LINES)}), so it is shown as plain code.`,
      text,
      file: rel,
    });
  }
  if (!hasStorylineReader(rel)) return answer(unsupportedLanguageRefusal(rel, text));

  await readers.prepare([rel]);
  const unavailable = readers.unavailable(rel, text);
  if (unavailable !== null) return answer(unavailable);
  const cacheDir = storylineCacheDir(repoRoot);
  const extracted = extractCached(readers, repoRoot, rel, bytes, text, cacheDir);
  if (!extracted.ok) return answer(extracted);

  const index = readProjectImportIndex(repoRoot, readers, cacheDir);
  const entries = rankEntries(readers, repoRoot, [{ file: rel, text, result: extracted }], index);
  return answer(await finish({ ...extracted, entries }));
}

type GuardedPath = { kind: 'outside' } | { kind: 'missing'; rel: string } | { kind: 'ok'; rel: string; abs: string };

/**
 * The path guard: lexically inside the project, and — once it exists — still
 * inside after symlinks are followed. The relative path keeps the LEXICAL form,
 * so piece ids name the file the way the project does.
 */
function guardPath(repoRoot: string, requested: string): GuardedPath {
  const abs = isAbsolute(requested) ? resolve(requested) : resolve(repoRoot, requested);
  if (!isInside(repoRoot, abs)) return { kind: 'outside' };
  const rel = toPosixPath(relative(repoRoot, abs));
  if (rel === '') return { kind: 'outside' };
  if (!isFile(abs)) return { kind: 'missing', rel };
  if (!isInside(realpath(repoRoot), realpath(abs))) return { kind: 'outside' };
  return { kind: 'ok', rel, abs };
}

// ── One part ─────────────────────────────────────────────

interface StoryFile {
  file: string;
  text: string;
  result: StorylineResult;
}

async function readPartStory(
  repoRoot: string,
  ref: string,
  readers: StorylineReaders,
  finish: Finish,
): Promise<StorylineVerbOutput> {
  const flowDir = join(repoRoot, 'flow');
  // No features directory is "nothing could be read", not "this part is gone":
  // `readFeatures` answers both with an empty list, and a `flow/` link mid-swap
  // must not be reported to a person as their part having been deleted.
  if (!existsSync(featuresDir(flowDir))) {
    return refuse('knowledge-unreadable', `no features could be read for '${ref}'`);
  }
  const anchors = resolvePartAnchors(flowDir, ref);
  if (anchors === null) return refuse('unknown-part', `no feature or part named '${ref}'`);

  const cacheDir = storylineCacheDir(repoRoot);
  const index = readProjectImportIndex(repoRoot, readers, cacheDir);
  const files = filesOfAnchors(repoRoot, anchors, index);
  if (files.length === 0) {
    // A part that IS one file with no reader answers as that file does — the
    // sentence names its language and the text opens as plain code (FR-6).
    // A part is the only door the board has to such a file.
    const single = singleUnreadableFile(repoRoot, anchors);
    if (single !== null) return readFileStory(repoRoot, single, readers, finish);
    return answer({
      ok: false,
      reason: 'unsupported-language',
      sentence: "Flow can't read any of this part's files as a story yet.",
    });
  }
  if (files.length > MAX_PART_FILES) return answer(partTooLarge(files.length, null));

  const read: Array<{ file: string; bytes: Buffer; text: string }> = [];
  let totalLines = 0;
  for (const file of files) {
    // Every part file passes the path guard before it is read — a walked
    // module file that is a symlink out of the repo is skipped like a stale one.
    const guarded = guardPath(repoRoot, file);
    const bytes = guarded.kind === 'ok' ? readFileBytesSafe(guarded.abs) : null;
    // A file the anchors name but the disk no longer holds is a stale anchor,
    // not part of the story — the board's drift marks say so elsewhere.
    if (bytes === null) continue;
    const text = bytes.toString('utf-8');
    const lines = countLines(text);
    totalLines += lines;
    if (lines > MAX_STORY_FILE_LINES || totalLines > MAX_PART_LINES) {
      return answer(partTooLarge(files.length, totalLines));
    }
    read.push({ file, bytes, text });
  }

  await readers.prepare(read.map((entry) => entry.file));
  for (const entry of read) {
    const unavailable = readers.unavailable(entry.file, entry.text);
    if (unavailable === null) continue;
    // The part has no single text to fall back to; name the reader that is missing.
    const choice = storylineReaderOf(entry.file);
    const reader = choice?.kind === 'tree-sitter' ? `its ${choice.table.displayName} reader` : 'its code reader';
    return answer({ ok: false, reason: unavailable.reason, sentence: `Flow couldn't load ${reader}, so this part can't be read as a story.` });
  }

  const stories: StoryFile[] = [];
  for (const entry of read) {
    const extracted = extractCached(readers, repoRoot, entry.file, entry.bytes, entry.text, cacheDir);
    if (!extracted.ok) {
      // The part has no single text to fall back to; name the file that stops it.
      return answer({
        ok: false,
        reason: extracted.reason,
        sentence: extracted.sentence.replace(/^This file/, basename(entry.file)),
        file: entry.file,
      });
    }
    stories.push({ file: entry.file, text: entry.text, result: extracted });
  }
  if (stories.length === 0) {
    return answer({
      ok: false,
      reason: 'not-found',
      sentence: "Flow couldn't find this part's files in the project.",
    });
  }
  return answer(await finish(mergePart(readers, repoRoot, stories, index)));
}

function partTooLarge(fileCount: number, lines: number | null): StorylineRefusal {
  const size = lines === null ? `${fileCount} files` : `${fileCount} files and more than ${formatCount(MAX_PART_LINES)} lines`;
  return {
    ok: false,
    reason: 'too-large',
    sentence: `This part spans ${size} — more than Flow reads as one story (${MAX_PART_FILES} files, ${formatCount(MAX_PART_LINES)} lines, ${formatCount(MAX_STORY_FILE_LINES)} in any one file).`,
  };
}

/**
 * The anchors a `--part` reference names: a feature (by slug, id or address —
 * `findFeatureByRef`, the one resolver every verb uses) or one of its parts (by
 * the id `addressableParts` mints for the board). Null when nothing matches.
 */
function resolvePartAnchors(flowDir: string, ref: string): string[] | null {
  const features = readFeatures(flowDir);
  const feature = findFeatureByRef(features, ref);
  if (feature !== undefined) return feature.anchors;
  const wanted = ref.includes(':') ? ref : `feature:${ref}`;
  for (const candidate of features) {
    if (!wanted.startsWith(`${candidate.id}/`)) continue;
    const match = addressableParts(candidate.id, readParts(flowDir, candidate.slug)).find((entry) => entry.id === wanted);
    if (match !== undefined) return match.part.anchors;
  }
  return null;
}

/**
 * Readable files under the anchors (any language with a reader), in anchor
 * order, each once. `file:` anchors name a file; `module:` anchors (and a
 * part's bare directory anchors) expand to the walked readable files beneath,
 * tests left out — a part's story is its product code. Other anchor kinds name
 * no file and add nothing.
 */
function filesOfAnchors(repoRoot: string, anchors: readonly string[], index: ProjectImportIndex): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const add = (file: string): void => {
    if (seen.has(file) || !hasStorylineReader(file)) return;
    seen.add(file);
    files.push(file);
  };
  for (const raw of anchors) {
    const target = anchorTarget(raw);
    if (target === null) continue;
    if (target.kind === 'file') {
      // THE SAME GUARD --file gets: lexically inside, and still inside once
      // symlinks are followed — a link out of the repo is not the part's code.
      const guarded = guardPath(repoRoot, target.path);
      if (guarded.kind === 'ok') add(guarded.rel);
      continue;
    }
    const prefix = `${target.path.replace(/\/+$/, '')}/`;
    for (const file of index.sourceFiles) {
      if (file.startsWith(prefix) && !isStoryTestFile(file)) add(file);
    }
  }
  return files;
}

/**
 * The one file a part names when that is all it names and Flow has no story
 * reader for it — or null (several files, a folder, or nothing on disk).
 */
function singleUnreadableFile(repoRoot: string, anchors: readonly string[]): string | null {
  const named = new Set<string>();
  for (const raw of anchors) {
    const target = anchorTarget(raw);
    if (target === null) continue;
    if (target.kind !== 'file') return null;
    const guarded = guardPath(repoRoot, target.path);
    if (guarded.kind !== 'ok' || !existsSync(guarded.abs)) continue;
    named.add(guarded.rel);
  }
  const [only] = named;
  return named.size === 1 && only !== undefined && !hasStorylineReader(only) ? only : null;
}

function anchorTarget(raw: string): { kind: 'file' | 'dir'; path: string } | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.includes(':')) {
    const normalized = normalizeAnchorRef(trimmed);
    const colon = normalized.indexOf(':');
    const kind = normalized.slice(0, colon);
    const path = normalized.slice(colon + 1);
    if (kind === 'file') return { kind: 'file', path };
    if (kind === 'module') return { kind: 'dir', path };
    return null;
  }
  const last = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return /\.[A-Za-z0-9]+$/.test(last) ? { kind: 'file', path: trimmed } : { kind: 'dir', path: trimmed };
}

/**
 * One story out of a part's files: everything concatenated, and a call into
 * another file OF THE PART turned from an outward chip into an arrow.
 */
function mergePart(
  readers: StorylineReaders,
  repoRoot: string,
  stories: readonly StoryFile[],
  index: ProjectImportIndex,
): StorylineResult {
  const pieces: StorylinePiece[] = stories.flatMap((story) => story.result.pieces);
  const pieceIds = new Set(pieces.map((piece) => piece.id));
  const exportTables = new Map(stories.map((story) => [story.file, exportTableOf(readers, story)]));

  const calls: StorylineCall[] = stories.flatMap((story) =>
    story.result.calls.map((call) => internalized(call, exportTables, pieceIds)),
  );
  return {
    ok: true,
    scope: 'part',
    files: stories.map((story) => story.file),
    language: partLanguage(stories.map((story) => story.result.language)),
    pieces,
    calls,
    typeUses: stories.flatMap((story) => story.result.typeUses),
    entries: rankEntries(readers, repoRoot, stories, index),
    classes: stories.flatMap((story) => story.result.classes),
  };
}

/**
 * The language a part is read as: the one its files share — TypeScript and
 * JavaScript count as one (`typescript` when any file is TypeScript, as
 * before) — else `mixed`.
 */
export function partLanguage(languages: readonly StorylineLanguageId[]): StorylineLanguageId {
  const compilerFamily = (language: StorylineLanguageId): boolean => language === 'typescript' || language === 'javascript';
  const families = new Set(languages.map((language) => (compilerFamily(language) ? 'typescript' : language)));
  if (families.size !== 1) return families.size === 0 ? 'typescript' : MIXED_STORYLINE_LANGUAGE;
  if (families.has('typescript')) return languages.includes('typescript') ? 'typescript' : 'javascript';
  return languages[0] ?? MIXED_STORYLINE_LANGUAGE;
}

/**
 * A story file's exports, exported name → local name. TS/JS: the compiler's
 * reading of its export statements. Another language: its exported top-level
 * pieces under their own names — a tree-sitter call into another file already
 * carries the name the target declares.
 */
function exportTableOf(readers: StorylineReaders, story: StoryFile): Map<string, string> {
  const ts = storylineLanguageOf(story.file) === null ? null : readers.typescript();
  if (ts !== null) return exportTable(ts, story.file, story.text);
  const table = new Map<string, string>();
  for (const piece of story.result.pieces) {
    if (piece.className === undefined && piece.exported) table.set(piece.name, piece.name);
  }
  return table;
}

function internalized(
  call: StorylineCall,
  exportTables: ReadonlyMap<string, ReadonlyMap<string, string>>,
  pieceIds: ReadonlySet<string>,
): StorylineCall {
  const external = call.external;
  if (external === undefined) return call;
  const table = exportTables.get(external.file);
  if (table === undefined) return call;
  // A tree-sitter call names the target's own declaration, exported or not
  // (a Go package's lower-case function is visible to its siblings).
  const local = table.get(external.name) ?? (storylineLanguageOf(external.file) === null ? external.name : undefined);
  if (local === undefined) return call;
  const id = `${external.file}#${local}`;
  if (!pieceIds.has(id)) return call;
  return { from: call.from, line: call.line, to: id };
}

// ── Extraction, cached by content ────────────────────────


/** The cache key of one file's extraction: version, path and content. */
export function storylineCacheKey(rel: string, contentHash: string): string {
  return hashFileContent(`${STORYLINE_VERSION}\0${rel}\0${contentHash}`);
}

interface CachedExtraction {
  version: number;
  file: string;
  contentHash: string;
  /**
   * Every path the extractor asked `fileExists` about, and the answer. The
   * content hash cannot see a sibling renamed (`foo.js` → `foo.ts`), so a hit
   * re-asks each of these — a few stats — and any changed answer is a miss.
   */
  probes: Record<string, boolean>;
  /**
   * Every other file the extractor READ (a C header, a Go package sibling) →
   * the hash of what it read (null: unreadable), and every directory it
   * LISTED → the listing. Re-checked like the probes: a change is a miss.
   */
  reads?: Record<string, string | null>;
  listings?: Record<string, string[]>;
  result: StorylineResult;
}

/** The cache key of one file's extraction: version, reader, path and content. */
function extractionCacheKey(readers: StorylineReaders, rel: string, contentHash: string): string {
  const reader = readers.readerTag(rel);
  // TS/JS keep the key they always had, so an upgrade does not re-read them.
  return reader === 'typescript' ? storylineCacheKey(rel, contentHash) : storylineCacheKey(`${reader}\0${rel}`, contentHash);
}

function extractCached(
  readers: StorylineReaders,
  repoRoot: string,
  rel: string,
  bytes: Buffer,
  text: string,
  cacheDir: string | null,
): StorylineAnswer {
  const contentHash = hashFileContent(bytes);
  const project = storylineProjectOf(repoRoot);
  const cachePath = cacheDir === null ? null : join(cacheDir, `${extractionCacheKey(readers, rel, contentHash)}.json`);
  const cached = cachePath === null ? null : readCachedExtraction(cachePath, rel, contentHash, project);
  if (cached !== null) return cached;

  const probes: Record<string, boolean> = {};
  const reads: Record<string, string | null> = {};
  const listings: Record<string, string[]> = {};
  const recording: StorylineProject = {
    fileExists: (candidate) => {
      const exists = project.fileExists(candidate);
      probes[candidate] = exists;
      return exists;
    },
    readFile: (candidate) => {
      const read = project.readFile(candidate);
      reads[candidate] = read === null ? null : hashFileContent(read);
      return read;
    },
    listDirectory: (directory) => {
      const listing = project.listDirectory(directory);
      listings[directory] = [...listing];
      return listing;
    },
  };
  const extracted = readers.extract(rel, text, recording);
  if (extracted.ok && cachePath !== null) {
    const record: CachedExtraction = { version: STORYLINE_VERSION, file: rel, contentHash, probes, result: extracted };
    if (Object.keys(reads).length > 0) record.reads = reads;
    if (Object.keys(listings).length > 0) record.listings = listings;
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(record), 'utf-8');
    } catch {
      // Fail-soft: an unwritable cache costs the next read a parse, never this
      // read its answer.
    }
  }
  return extracted;
}

function readCachedExtraction(
  cachePath: string,
  rel: string,
  contentHash: string,
  project: Required<StorylineProject>,
): StorylineResult | null {
  const raw = readFileSafe(cachePath);
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as Partial<CachedExtraction>;
    if (record.version !== STORYLINE_VERSION || record.file !== rel || record.contentHash !== contentHash) return null;
    const result = record.result;
    if (result === undefined || result.ok !== true) return null;
    const arrays = [result.pieces, result.calls, result.typeUses, result.entries, result.classes, result.files];
    if (!arrays.every(Array.isArray)) return null;
    // THE IMPORTS STILL RESOLVE THE SAME WAY, or this is a miss: an entry
    // written before probes were recorded cannot say, so it is re-extracted.
    const probes = record.probes;
    if (typeof probes !== 'object' || probes === null) return null;
    for (const [candidate, existed] of Object.entries(probes)) {
      if (project.fileExists(candidate) !== existed) return null;
    }
    for (const [candidate, hash] of Object.entries(record.reads ?? {})) {
      const read = project.readFile(candidate);
      if ((read === null ? null : hashFileContent(read)) !== hash) return null;
    }
    for (const [directory, listing] of Object.entries(record.listings ?? {})) {
      if (JSON.stringify(project.listDirectory(directory)) !== JSON.stringify(listing)) return null;
    }
    return result;
  } catch {
    // A corrupt cache entry is re-extracted (and rewritten) — it is only a cache.
    return null;
  }
}

// ── Ranking ──────────────────────────────────────────────

/** What one importer file takes from one story file. */
interface ImporterUse {
  /** Exported names it imports (or reaches through a namespace). */
  names: Set<string>;
  text: string;
}

/**
 * Every story file's entries, scored and ordered: most-used first, then file
 * order (the part's file order, then line).
 */
function rankEntries(
  readers: StorylineReaders,
  repoRoot: string,
  stories: readonly StoryFile[],
  index: ProjectImportIndex,
): StorylineEntry[] {
  const project = storylineProjectOf(repoRoot);
  const inside = new Set(stories.map((story) => story.file));
  const pieceById = new Map(stories.flatMap((story) => story.result.pieces).map((piece) => [piece.id, piece]));
  const fileOrder = new Map(stories.map((story, position) => [story.file, position]));
  const has = (relPath: string): boolean => index.has(relPath) || inside.has(relPath);

  const scored: StorylineEntry[] = [];
  for (const story of stories) {
    const exported = exportTableOf(readers, story);
    const namesOf = invert(exported);
    const ts = storylineLanguageOf(story.file) === null ? null : readers.typescript();
    const uses: ImporterUse[] = [];
    for (const importer of index.importersOf(story.file)) {
      if (inside.has(importer) || isStoryTestFile(importer)) continue;
      const use =
        ts === null
          ? readTreeSitterImporterUse(readers, project, repoRoot, importer, story.file, [...exported.keys()])
          : readImporterUse(ts, repoRoot, importer, story.file, has);
      if (use !== null && use.names.size > 0) uses.push(use);
    }
    for (const entry of story.result.entries) {
      const piece = pieceById.get(entry.pieceId);
      // A CLASS IS NOT A WAY IN. Its exported methods already are, and a story
      // starting at the class itself would have nothing to follow.
      if (piece === undefined || piece.kind === 'class') continue;
      scored.push({ pieceId: entry.pieceId, usedFrom: usedFromOf(piece, namesOf, uses) });
    }
  }
  const reach = reachOf(stories.flatMap((story) => story.result.calls));
  const position = (entry: StorylineEntry): [number, number] => {
    const piece = pieceById.get(entry.pieceId);
    return [fileOrder.get(piece?.file ?? '') ?? 0, piece?.startLine ?? 0];
  };
  // TIES ARE THE COMMON CASE — most files are imported by one or two others —
  // and file order alone opened learn-orchestrator.ts on a helper. The piece
  // whose calls reach the most of the file tells the longest story, so it
  // goes first; file order settles what is still tied.
  return scored.sort((a, b) => {
    if (a.usedFrom !== b.usedFrom) return b.usedFrom - a.usedFrom;
    const reachA = reach.get(a.pieceId) ?? 0;
    const reachB = reach.get(b.pieceId) ?? 0;
    if (reachA !== reachB) return reachB - reachA;
    const [fileA, lineA] = position(a);
    const [fileB, lineB] = position(b);
    return fileA !== fileB ? fileA - fileB : lineA - lineB;
  });
}

/** How many other pieces each piece reaches by following resolved calls. */
function reachOf(calls: readonly StorylineCall[]): Map<string, number> {
  const next = new Map<string, Set<string>>();
  for (const call of calls) {
    if (call.to === null || call.to === call.from) continue;
    const targets = next.get(call.from) ?? new Set<string>();
    targets.add(call.to);
    next.set(call.from, targets);
  }
  const reach = new Map<string, number>();
  for (const start of next.keys()) {
    const seen = new Set<string>([start]);
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const target of next.get(current) ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        pending.push(target);
      }
    }
    reach.set(start, seen.size - 1);
  }
  return reach;
}

function usedFromOf(piece: StorylinePiece, namesOf: ReadonlyMap<string, string[]>, uses: readonly ImporterUse[]): number {
  if (piece.kind === 'method') {
    const classNames = namesOf.get(piece.className ?? '') ?? [];
    // `.m` — or `::m` / `->m`, how Rust, C++ and PHP reach a member.
    const mention = new RegExp(`(?:\\.|::|->)\\s*${escapeRegExp(piece.name)}(?![\\w$])`);
    return uses.filter((use) => classNames.some((name) => use.names.has(name)) && mention.test(use.text)).length;
  }
  const names = namesOf.get(piece.name) ?? [];
  return uses.filter((use) => names.some((name) => use.names.has(name))).length;
}

/** Read one importer's import and re-export declarations that name `target`. */
function readImporterUse(
  ts: TsModule,
  repoRoot: string,
  importer: string,
  target: string,
  has: (relPath: string) => boolean,
): ImporterUse | null {
  const text = readFileSafe(join(repoRoot, importer));
  if (text === null) return null;
  const sourceFile = ts.createSourceFile(importer, text, ts.ScriptTarget.Latest, false);
  const names = new Set<string>();
  const pointsAtTarget = (specifier: TS.Expression | undefined): boolean =>
    specifier !== undefined &&
    ts.isStringLiteral(specifier) &&
    resolveRelativeImport(importer, specifier.text, has) === target;

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && pointsAtTarget(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (clause.name !== undefined) names.add(DEFAULT_EXPORT);
      const bindings = clause.namedBindings;
      if (bindings === undefined) continue;
      if (ts.isNamespaceImport(bindings)) {
        for (const member of namespaceMembers(text, bindings.name.text)) names.add(member);
        continue;
      }
      for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
      continue;
    }
    if (ts.isExportDeclaration(statement) && pointsAtTarget(statement.moduleSpecifier)) {
      const clause = statement.exportClause;
      if (clause === undefined || !ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) names.add((element.propertyName ?? element.name).text);
    }
  }
  return { names, text };
}

/**
 * What one importer in a tree-sitter language takes from `target`, read with
 * its table's imports query and resolved by its table's resolver — the same
 * rules the story's arrows follow:
 *   • `from x import name` counts `name`;
 *   • a module binding (`import x`, Go's package, `use a\B`) counts the
 *     module's own name (a Java/PHP class IS the module) and each `x.member` /
 *     `x::member` / `x->member` the importer mentions;
 *   • a star import (`#include`, `require_relative`) counts each exported name
 *     the importer mentions as a word — never everything at once.
 * A Go package import names a directory: it reaches each of the package's files.
 */
function readTreeSitterImporterUse(
  readers: StorylineReaders,
  project: StorylineProject,
  repoRoot: string,
  importer: string,
  target: string,
  exportedNames: readonly string[],
): ImporterUse | null {
  const table = storylineTableFor(importer);
  const text = readFileSafe(join(repoRoot, importer));
  if (table === null || text === null) return null;
  const imports = readers.treeSitterImports(importer, text);
  if (imports === null) return null;
  const targetPackage = directoryTarget(posix.dirname(target));
  const pointsAtTarget = (specifier: string): boolean => {
    const resolved = table.resolveImport(importer, specifier, project);
    return resolved === target || (resolved !== null && isDirectoryTarget(resolved) && resolved === targetPackage);
  };
  const names = new Set<string>();
  const addModule = (binding: string, moduleName: string): void => {
    names.add(moduleName);
    for (const member of namespaceMembers(text, binding)) names.add(member);
  };
  for (const entry of imports) {
    if (entry.all) {
      if (!pointsAtTarget(entry.source)) continue;
      for (const name of exportedNames) if (mentionsWord(text, name)) names.add(name);
      continue;
    }
    if (entry.name !== null) {
      const submodule = table.submoduleSpecifier?.(entry.source, entry.name);
      if (submodule !== undefined && pointsAtTarget(submodule)) {
        addModule(entry.alias ?? entry.name, entry.name);
        continue;
      }
      if (pointsAtTarget(entry.source)) names.add(entry.name);
      continue;
    }
    if (!pointsAtTarget(entry.source)) continue;
    const moduleName = table.moduleBindingName?.(entry.source) ?? entry.source;
    addModule(entry.alias ?? moduleName, moduleName);
  }
  return { names, text };
}

function mentionsWord(text: string, word: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegExp(word)}(?![\\w$])`).test(text);
}

/** Every `ns.member` (or `ns::member`, `ns->member`, `ns\\member`) the file mentions. */
function namespaceMembers(text: string, namespace: string): string[] {
  const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(namespace)}\\s*(?:\\.|::|->|\\\\)\\s*([A-Za-z_$][\\w$]*)`, 'g');
  return [...text.matchAll(pattern)].map((match) => match[1] ?? '').filter((name) => name !== '');
}

/**
 * A file's exports: exported name → the local declaration it names.
 * `export { a as b }` maps `b → a`; `export default function f` and
 * `export default f` map `default → f`.
 */
export function exportTable(ts: TsModule, file: string, text: string): Map<string, string> {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const table = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined) {
      const clause = statement.exportClause;
      if (clause === undefined || !ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) table.set(element.name.text, (element.propertyName ?? element.name).text);
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      if (ts.isIdentifier(statement.expression)) table.set(DEFAULT_EXPORT, statement.expression.text);
      continue;
    }
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    for (const local of declaredNames(ts, statement)) table.set(isDefault ? DEFAULT_EXPORT : local, local);
  }
  return table;
}

function declaredNames(ts: TsModule, statement: TS.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter(ts.isIdentifier)
      .map((name) => name.text);
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  ) {
    // An anonymous default export is the piece the extractor names `default`.
    return [statement.name?.text ?? DEFAULT_EXPORT];
  }
  return [];
}

/** local name → every exported name it goes by. */
function invert(table: ReadonlyMap<string, string>): Map<string, string[]> {
  const inverted = new Map<string, string[]>();
  for (const [exported, local] of table) inverted.set(local, [...(inverted.get(local) ?? []), exported]);
  return inverted;
}

// ── Helpers ──────────────────────────────────────────────

function countLines(text: string): number {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Unresolvable (raced away): the lexical path is the best statement left.
    return path;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing or unreadable — not a file this verb can read.
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // Missing or unreadable — not a project this verb can read.
    return false;
  }
}
