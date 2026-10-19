/**
 * CODE STORYLINE — finding and starting tree-sitter (plan `story-any-language`
 * phase 1).
 *
 * Every language that is not TypeScript or JavaScript is read with tree-sitter
 * compiled to WebAssembly (`@vscode/tree-sitter-wasm`: the runtime plus
 * prebuilt grammars). Like the TypeScript compiler (`storyline-compiler.ts`),
 * it is NOT bundled into the CLI — the grammars are ~20 MB and the app ships
 * them once. So the order is:
 *
 *   1. `FLOW_TREESITTER_PATH` — an absolute path the app passes, naming the
 *      package directory it ships;
 *   2. the CLI's own `@vscode/tree-sitter-wasm`, when one resolves next to it
 *      (a dev checkout, a terminal install that brought it along);
 *   3. nothing — the caller turns `null` into a `no-compiler` refusal.
 *
 * Two steps, because WebAssembly starts asynchronously: `loadTreeSitter` finds
 * the runtime (synchronous, like `loadTypeScript`), and `openTreeSitter`
 * starts it once and hands back an engine whose grammars load lazily — one
 * per language, the first time a file of that language is read — and stay
 * cached. Once a grammar is loaded everything else is synchronous, so the
 * extractor (`storyline-languages.ts`) stays a pure text-in, answer-out read.
 *
 * Never throws: a runtime or grammar that cannot be loaded is an answer
 * (`null`), not a crash.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import type * as WebTreeSitter from '@vscode/tree-sitter-wasm';

/** The runtime module (`Parser`, `Language`, `Query`, …). Type-only import. */
export type TreeSitterModule = typeof WebTreeSitter;
export type TreeSitterLanguage = WebTreeSitter.Language;
export type TreeSitterNode = WebTreeSitter.Node;
export type TreeSitterQuery = WebTreeSitter.Query;
export type TreeSitterTree = WebTreeSitter.Tree;

/** The environment variable naming the app's shipped package directory. */
export const TREESITTER_PATH_ENV = 'FLOW_TREESITTER_PATH';

/** The package the runtime and grammars come from. */
export const TREESITTER_PACKAGE = '@vscode/tree-sitter-wasm';

/** Inside the package, where `tree-sitter.js`, its `.wasm` and the grammars live. */
const WASM_DIRECTORY = 'wasm';
const RUNTIME_SCRIPT = 'tree-sitter.js';

/** A found, not yet started runtime. */
export interface TreeSitterRuntime {
  module: TreeSitterModule;
  /** Absolute directory holding `tree-sitter.wasm` and the `tree-sitter-<grammar>.wasm` files. */
  wasmDir: string;
}

export interface LoadTreeSitterDeps {
  env?: NodeJS.ProcessEnv;
  requireFn?: NodeRequireLike;
}

/** The two halves of `require` the loader uses — injectable for tests. */
export interface NodeRequireLike {
  (id: string): unknown;
  resolve: (id: string) => string;
}

/** A loaded value is usable only when it carries the API we call. */
function asTreeSitterModule(value: unknown): TreeSitterModule | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<TreeSitterModule>;
  if (typeof candidate.Parser?.init !== 'function') return null;
  if (typeof candidate.Language?.load !== 'function') return null;
  if (typeof candidate.Query !== 'function') return null;
  return candidate as TreeSitterModule;
}

function tryRuntime(requireFn: NodeRequireLike, wasmDir: string): TreeSitterRuntime | null {
  try {
    const module = asTreeSitterModule(requireFn(join(wasmDir, RUNTIME_SCRIPT)));
    return module === null ? null : { module, wasmDir };
  } catch {
    // A missing or broken runtime at this rung is expected (the env path may
    // be stale, the package may not be installed): fall through to the next.
    return null;
  }
}

function ownWasmDir(requireFn: NodeRequireLike): string | null {
  try {
    // The package's `main` is `wasm/tree-sitter.js`.
    return dirname(requireFn.resolve(TREESITTER_PACKAGE));
  } catch {
    // Not installed next to the CLI — the caller says so as a refusal.
    return null;
  }
}

function defaultRequire(): NodeRequireLike | null {
  try {
    return createRequire(import.meta.url);
  } catch {
    // Only reachable in an environment without a module URL; no runtime then.
    return null;
  }
}

/** Find the tree-sitter runtime, or `null` when none can be found. */
export function loadTreeSitter(deps: LoadTreeSitterDeps = {}): TreeSitterRuntime | null {
  const env = deps.env ?? process.env;
  const requireFn = deps.requireFn ?? defaultRequire();
  if (requireFn === null) return null;

  const configured = env[TREESITTER_PATH_ENV];
  if (typeof configured === 'string' && configured.trim() !== '' && isAbsolute(configured.trim())) {
    const loaded = tryRuntime(requireFn, join(configured.trim(), WASM_DIRECTORY));
    if (loaded !== null) return loaded;
  }
  const own = ownWasmDir(requireFn);
  return own === null ? null : tryRuntime(requireFn, own);
}

// ── The started engine ───────────────────────────────────

/** A started runtime: grammars load lazily, then parsing and querying are synchronous. */
export class TreeSitterEngine {
  readonly #grammars = new Map<string, Promise<TreeSitterLanguage | null>>();
  readonly #loaded = new Map<string, TreeSitterLanguage>();
  readonly #queries = new Map<string, TreeSitterQuery | null>();

  constructor(readonly runtime: TreeSitterRuntime) {}

  get module(): TreeSitterModule {
    return this.runtime.module;
  }

  /** Load a grammar (`python` → `tree-sitter-python.wasm`) once; null when it cannot be. */
  grammar(name: string): Promise<TreeSitterLanguage | null> {
    const cached = this.#grammars.get(name);
    if (cached !== undefined) return cached;
    const loading = this.#loadGrammar(name);
    this.#grammars.set(name, loading);
    return loading;
  }

  /** A grammar already loaded by `grammar()`, or null — the synchronous read path. */
  loadedGrammar(name: string): TreeSitterLanguage | null {
    return this.#loaded.get(name) ?? null;
  }

  /**
   * A compiled query, cached by `key` — null when the query does not compile
   * against the grammar (a table bug, reported by the caller as a refusal
   * rather than thrown at the reader).
   */
  query(key: string, language: TreeSitterLanguage, source: string): TreeSitterQuery | null {
    if (this.#queries.has(key)) return this.#queries.get(key) ?? null;
    let compiled: TreeSitterQuery | null;
    try {
      compiled = new this.module.Query(language, source);
    } catch {
      // A query that does not compile is a table bug; the caller refuses with a sentence.
      compiled = null;
    }
    this.#queries.set(key, compiled);
    return compiled;
  }

  /** Parse `text` with a loaded grammar; null when the runtime gives no tree. */
  parse(language: TreeSitterLanguage, text: string): TreeSitterTree | null {
    const parser = new this.module.Parser();
    try {
      parser.setLanguage(language);
      return parser.parse(text);
    } catch {
      // A grammar the runtime rejects (an ABI mismatch) — no tree, no crash.
      return null;
    } finally {
      parser.delete();
    }
  }

  async #loadGrammar(name: string): Promise<TreeSitterLanguage | null> {
    try {
      const language = await this.module.Language.load(join(this.runtime.wasmDir, `tree-sitter-${name}.wasm`));
      this.#loaded.set(name, language);
      return language;
    } catch {
      // The package does not ship this grammar, or it is unreadable.
      return null;
    }
  }
}

/** One start per runtime: `Parser.init` instantiates the WebAssembly module once. */
const started = new WeakMap<TreeSitterRuntime, Promise<TreeSitterEngine | null>>();

/** Start a found runtime (once) and return its engine, or null when it will not start. */
export function openTreeSitter(runtime: TreeSitterRuntime): Promise<TreeSitterEngine | null> {
  const cached = started.get(runtime);
  if (cached !== undefined) return cached;
  const starting = startEngine(runtime);
  started.set(runtime, starting);
  return starting;
}

async function startEngine(runtime: TreeSitterRuntime): Promise<TreeSitterEngine | null> {
  try {
    await runtime.module.Parser.init({ locateFile: (file: string) => join(runtime.wasmDir, file) });
    return new TreeSitterEngine(runtime);
  } catch {
    // The WebAssembly runtime would not start — an answer (no engine), not a crash.
    return null;
  }
}

/**
 * The package version a runtime came from (`0.3.1`), or `unknown` — part of
 * the storyline cache key, so a new engine (new grammars) re-reads every file.
 */
export function treeSitterVersion(runtime: TreeSitterRuntime): string {
  try {
    const raw = readFileSync(join(runtime.wasmDir, '..', 'package.json'), 'utf-8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version !== '' ? version : 'unknown';
  } catch {
    // An unreadable manifest only costs the cache its version component.
    return 'unknown';
  }
}
