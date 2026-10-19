/**
 * CODE STORYLINE — the one dispatcher between a file and the reader that tells
 * its story (plan `story-any-language` phase 3).
 *
 * Two readers stand behind the same `StorylineAnswer`:
 *   • TypeScript and JavaScript — the TypeScript compiler (`storyline.ts`),
 *     exactly as before (NFR-3);
 *   • every language with a tree-sitter table (`storyline-languages.ts`) — the
 *     WebAssembly engine, started once per run, its grammars loaded only for
 *     the languages a request touches.
 * Anything else is the honest refusal naming the language
 * (`unsupportedLanguageRefusal`).
 *
 * The verb, the import index and Today ⇄ After all read through this class, so
 * a language is read by the same rules wherever a story needs it (allowed-
 * pattern #14). Loading is lazy on both sides: a Python-only story never loads
 * the compiler unless the import index asks for it, and a TypeScript story
 * never starts the engine.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isTestFile, readFileSafe, toPosixPath } from './extractors/scan.js';
import { extractStoryline, storylineLanguageOf, unsupportedLanguageRefusal } from './storyline.js';
import { loadTypeScript, type TsModule } from './storyline-compiler.js';
import {
  extractWithTreeSitter,
  noTreeSitterReader,
  prepareStorylineLanguages,
  readTreeSitterImports,
  storylineTableFor,
  type StorylineLanguage,
  type StorylineProject,
  type TreeSitterImport,
} from './storyline-languages.js';
import {
  loadTreeSitter,
  openTreeSitter,
  treeSitterVersion,
  type TreeSitterEngine,
  type TreeSitterRuntime,
} from './storyline-treesitter.js';
import type { StorylineAnswer, StorylineRefusal } from './storyline-types.js';

/** Which reader a file goes to. */
export type StorylineReaderChoice =
  | { kind: 'compiler' }
  | { kind: 'tree-sitter'; table: StorylineLanguage }
  | null;

export function storylineReaderOf(file: string): StorylineReaderChoice {
  if (storylineLanguageOf(file) !== null) return { kind: 'compiler' };
  const table = storylineTableFor(file);
  return table === null ? null : { kind: 'tree-sitter', table };
}

/** Whether any reader covers this file. */
export function hasStorylineReader(file: string): boolean {
  return storylineReaderOf(file) !== null;
}

/**
 * The language family a file is ranked and merged within: `typescript` for
 * TS and JS (one import graph), else its table's id. Null when unreadable.
 */
export function storylineFamilyOf(file: string): string | null {
  const choice = storylineReaderOf(file);
  if (choice === null) return null;
  return choice.kind === 'compiler' ? 'typescript' : choice.table.id;
}

/**
 * Test files of the languages tree-sitter reads, by each one's own convention
 * (`test_x.py`, `x_test.py`, `x_test.go`, `x_spec.rb`, `XTest.java`,
 * `XTests.cs`, `XTest.php`) — on top of the shared TS/JS rule (`isTestFile`).
 */
const OTHER_LANGUAGE_TEST_FILE =
  /(?:^|\/)(?:test_[^/]+\.pyi?|[^/]+_test\.(?:py|go|rs|cc|cpp|c)|[^/]+_spec\.rb|[^/]+Tests?\.(?:java|cs|php))$/;

/**
 * Whether a file is a test, in any language a story is read in — a story is
 * the PRODUCT's, and a suite imports everything it tests.
 */
export function isStoryTestFile(relPath: string): boolean {
  return isTestFile(relPath) || OTHER_LANGUAGE_TEST_FILE.test(toPosixPath(relPath));
}

export interface StorylineReadersDeps {
  /** Injected in tests; the real loader everywhere else. */
  loadTs?: () => TsModule | null;
  /** Injected in tests; the real loader (FLOW_TREESITTER_PATH → own install) everywhere else. */
  loadTreeSitter?: () => TreeSitterRuntime | null;
}

const COMPILER_SENTENCE = "Flow couldn't load its code reader, so this file is shown as plain code.";

export class StorylineReaders {
  readonly #loadTs: () => TsModule | null;
  readonly #loadTreeSitter: () => TreeSitterRuntime | null;
  #ts: TsModule | null | undefined;
  #runtime: TreeSitterRuntime | null | undefined;
  #engine: TreeSitterEngine | null | undefined;
  #engineVersion: string | null = null;

  constructor(deps: StorylineReadersDeps = {}) {
    this.#loadTs = deps.loadTs ?? (() => loadTypeScript());
    this.#loadTreeSitter = deps.loadTreeSitter ?? (() => loadTreeSitter());
  }

  /** The TypeScript compiler, loaded on first ask (null when none can be). */
  typescript(): TsModule | null {
    if (this.#ts === undefined) this.#ts = this.#loadTs();
    return this.#ts;
  }

  /** The started engine — null until `prepare` started one, or when none can be. */
  get engine(): TreeSitterEngine | null {
    return this.#engine ?? null;
  }

  /**
   * Start the engine (once) and load the grammars `files` need. The one
   * asynchronous step; a request with no tree-sitter file never starts it.
   */
  async prepare(files: readonly string[]): Promise<void> {
    if (!files.some((file) => storylineTableFor(file) !== null)) return;
    const engine = await this.#openEngine();
    if (engine !== null) await prepareStorylineLanguages(engine, files);
  }

  async #openEngine(): Promise<TreeSitterEngine | null> {
    if (this.#engine !== undefined) return this.#engine;
    if (this.#runtime === undefined) this.#runtime = this.#loadTreeSitter();
    const runtime = this.#runtime;
    this.#engine = runtime === null ? null : await openTreeSitter(runtime);
    if (runtime !== null) this.#engineVersion = treeSitterVersion(runtime);
    return this.#engine;
  }

  /**
   * Why `file` cannot be read right now (no compiler, no engine, no grammar,
   * no reader at all), or null when it can. Asked BEFORE the cache, so a cached
   * story is never served by a reader this machine no longer has.
   */
  unavailable(file: string, text: string): StorylineRefusal | null {
    const choice = storylineReaderOf(file);
    if (choice === null) return unsupportedLanguageRefusal(file, text);
    if (choice.kind === 'compiler') {
      return this.typescript() === null ? { ok: false, reason: 'no-compiler', sentence: COMPILER_SENTENCE, text, file } : null;
    }
    const engine = this.engine;
    if (engine === null || engine.loadedGrammar(choice.table.grammar) === null) {
      return noTreeSitterReader(choice.table, file, text);
    }
    return null;
  }

  /**
   * What reads `file`, for the cache key: a story cached under one engine is
   * never served by another (a new grammar can read a file differently).
   */
  readerTag(file: string): string {
    const choice = storylineReaderOf(file);
    if (choice === null) return 'none';
    if (choice.kind === 'compiler') return 'typescript';
    return `tree-sitter@${this.#engineVersion ?? 'unknown'}/${choice.table.id}`;
  }

  /** Read `file` as a story with the reader its extension names (after `prepare`). */
  extract(file: string, text: string, project: StorylineProject): StorylineAnswer {
    const refusal = this.unavailable(file, text);
    if (refusal !== null) return refusal;
    const choice = storylineReaderOf(file);
    if (choice?.kind === 'compiler') {
      return extractStoryline({ ts: this.typescript() as TsModule, file, text, fileExists: project.fileExists });
    }
    return extractWithTreeSitter({
      engine: this.engine as TreeSitterEngine,
      file,
      text,
      fileExists: project.fileExists,
      ...(project.readFile === undefined ? {} : { readFile: project.readFile }),
      ...(project.listDirectory === undefined ? {} : { listDirectory: project.listDirectory }),
    });
  }

  /** A tree-sitter file's imports — null when its grammar is not loaded (or it has no table). */
  treeSitterImports(file: string, text: string): TreeSitterImport[] | null {
    const engine = this.engine;
    return engine === null ? null : readTreeSitterImports(engine, file, text);
  }
}

// ── The project, as the readers see it ──────────────────

/**
 * The project on disk, confined to `repoRoot`: which files exist, a file's
 * text, a directory's files. Every path is project-relative; one that leaves
 * the project (lexically, or through a symlink) exists for nobody.
 */
export function storylineProjectOf(repoRoot: string): Required<StorylineProject> {
  const root = resolve(repoRoot);
  const realRoot = realpathOr(root);
  const inside = (relPath: string): string | null => {
    if (isAbsolute(relPath)) return null;
    const abs = resolve(root, relPath);
    if (!isInsidePath(root, abs)) return null;
    if (!isInsidePath(realRoot, realpathOr(abs))) return null;
    return abs;
  };
  return {
    fileExists: (relPath) => {
      const abs = inside(relPath);
      return abs !== null && isFilePath(abs);
    },
    readFile: (relPath) => {
      const abs = inside(relPath);
      return abs === null || !isFilePath(abs) ? null : readFileSafe(abs);
    },
    listDirectory: (relDir) => {
      const abs = relDir === '.' || relDir === '' ? root : inside(relDir);
      if (abs === null) return [];
      try {
        return readdirSync(abs, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => toPosixPath(relative(root, join(abs, entry.name))))
          .sort();
      } catch {
        // Missing or unreadable — a directory with no files to search.
        return [];
      }
    },
  };
}

function isInsidePath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Not there (yet): the lexical path is the best statement left.
    return path;
  }
}

function isFilePath(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // Missing or unreadable — not a file a reader can use.
    return false;
  }
}
