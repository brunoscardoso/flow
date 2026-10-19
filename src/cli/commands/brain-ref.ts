/**
 * `planflow-ai brain ref` — expand a catalogued section by its code.
 *
 *   list:   planflow-ai brain ref --list [--prefix COR]
 *   expand: planflow-ai brain ref COR-CS-1
 *   check:  planflow-ai brain ref --check
 *
 * The curated half of retrieval (see `state/brain-catalog.ts` for why it is
 * back and why it is anchored to headings). `brain search` ranks; this one does
 * not rank at all — a code names one section and prints it, or refuses and says
 * which of five things went wrong.
 *
 * NO FALLBACK TO SEARCH, deliberately. The whole value of a curated answer is
 * that the reader can tell it from a guessed one, and a verb that quietly
 * degrades into the ranker destroys exactly that.
 *
 * Refusals follow the family contract (allowed-pattern #21): a JSON payload
 * line on stdout carrying what the caller needs, then
 * `brain ref refused: <reason> — <sentence>`, exit 1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CATALOG_CORPUS_PATH,
  CATALOG_REFUSAL_SENTENCES,
  CATALOG_RELPATH,
  checkCatalog,
  isResolved,
  parseCatalog,
  resolveCode,
  type CatalogDeps,
  type CatalogEntry,
  type CatalogRefusal,
  type ParsedCatalog,
} from '../state/brain-catalog.js';
import { corpusResolver } from '../state/brain-file-search.js';

export interface BrainRefOptions {
  target: string;
  list?: boolean;
  check?: boolean;
  prefix?: string;
  json?: boolean;
}

/** Everything the command can refuse over, including before a code is read. */
type Reason = CatalogRefusal | 'no-catalog' | 'no-code';

const EXTRA_SENTENCES: Record<'no-catalog' | 'no-code', string> = {
  'no-catalog': 'this project has no catalog yet',
  'no-code': 'name the code to expand, or ask for the list',
};

function sentenceFor(reason: Reason): string {
  return reason === 'no-catalog' || reason === 'no-code'
    ? EXTRA_SENTENCES[reason]
    : CATALOG_REFUSAL_SENTENCES[reason];
}

/** The ONE refusal path, so every exit reads the same way and carries payload. */
function refuse(reason: Reason, payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ refused: reason, ...payload }));
  console.log(`brain ref refused: ${reason} — ${sentenceFor(reason)}`);
  process.exitCode = 1;
}

function readCatalog(target: string): { raw: string; path: string } | null {
  const path = join(target, 'flow', CATALOG_RELPATH);
  if (!existsSync(path)) return null;
  try {
    return { raw: readFileSync(path, 'utf-8'), path };
  } catch {
    return null;
  }
}

function depsFor(target: string): CatalogDeps {
  const at = corpusResolver(target);
  return {
    readCorpusFile: (relPath) => {
      try {
        const resolved = at(relPath);
        return existsSync(resolved) ? readFileSync(resolved, 'utf-8') : null;
      } catch {
        return null;
      }
    },
  };
}

/** `--list`: the table of contents, which is what an agent actually loads. */
function runList(catalog: ParsedCatalog, options: BrainRefOptions): void {
  const prefix = options.prefix?.toUpperCase();
  const entries = prefix === undefined
    ? catalog.entries
    : catalog.entries.filter((entry) => entry.code.startsWith(prefix));

  if (options.json === true) {
    console.log(JSON.stringify({ catalog: CATALOG_CORPUS_PATH, count: entries.length, entries }, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log(prefix === undefined ? 'The catalog is empty.' : `No codes start with ${prefix}.`);
    return;
  }

  const width = Math.max(...entries.map((entry) => entry.code.length));
  let group: string | null = null;
  for (const entry of entries) {
    if (entry.group !== group) {
      group = entry.group;
      console.log(`\n${group}`);
    }
    console.log(`  ${entry.code.padEnd(width)}  ${entry.description}`);
  }
  console.log(`\n${entries.length} entries · expand one: planflow-ai brain ref <code>`);
}

/** `--check`: resolve every entry and report what no longer points anywhere. */
function runCheck(catalog: ParsedCatalog, deps: CatalogDeps, options: BrainRefOptions): void {
  const checked = checkCatalog(catalog, deps);
  const broken = checked
    .filter((row) => !isResolved(row.result))
    .map((row) => ({
      code: row.entry.code,
      line: row.entry.line,
      file: row.entry.file,
      heading: row.entry.heading,
      reason: (row.result as { refusal: CatalogRefusal }).refusal,
    }));
  const failures = [
    ...catalog.problems.map((problem) => ({
      code: problem.code,
      line: problem.line,
      file: null,
      heading: null,
      reason: problem.reason,
      detail: problem.detail,
    })),
    ...broken,
  ];

  if (options.json === true) {
    console.log(JSON.stringify({ checked: catalog.entries.length, failures }, null, 2));
  } else if (failures.length === 0) {
    console.log(`brain ref: ${catalog.entries.length} entries, all resolve.`);
  } else {
    console.log(`brain ref: ${failures.length} of ${catalog.entries.length + catalog.problems.length} entries need attention.\n`);
    for (const failure of failures) {
      const where = failure.file === null ? '' : ` — ${failure.file} › ${failure.heading}`;
      console.log(`  line ${failure.line}  ${failure.code ?? '(no code)'}  ${failure.reason}${where}`);
      const sentence = 'detail' in failure && typeof failure.detail === 'string'
        ? failure.detail
        : sentenceFor(failure.reason as Reason);
      console.log(`      ${sentence}`);
    }
  }
  if (failures.length > 0) process.exitCode = 1;
}

/** Expanding one code — the everyday path. */
function runExpand(catalog: ParsedCatalog, code: string, deps: CatalogDeps, options: BrainRefOptions): void {
  const result = resolveCode(catalog, code, deps);
  if (!isResolved(result)) {
    refuse(result.refusal, {
      code,
      file: result.entry?.file ?? null,
      heading: result.entry?.heading ?? null,
      matches: result.matches ?? null,
    });
    return;
  }

  if (options.json === true) {
    console.log(JSON.stringify({
      code: result.entry.code,
      description: result.entry.description,
      file: result.entry.file,
      heading: result.entry.heading,
      line: result.line,
      content: result.text,
    }, null, 2));
    return;
  }

  console.log(`${result.entry.code} · ${result.entry.file}:${result.line} › ${result.entry.heading}\n`);
  console.log(result.text);
}

export function runBrainRef(args: string[], options: BrainRefOptions): void {
  const catalogFile = readCatalog(options.target);
  if (catalogFile === null) {
    refuse('no-catalog', { catalog: CATALOG_CORPUS_PATH });
    return;
  }
  const catalog = parseCatalog(catalogFile.raw);
  const deps = depsFor(options.target);

  if (options.check === true) {
    runCheck(catalog, deps, options);
    return;
  }
  if (options.list === true || args.length === 0) {
    if (args.length === 0 && options.list !== true) {
      refuse('no-code', { catalog: CATALOG_CORPUS_PATH, entries: catalog.entries.length });
      return;
    }
    runList(catalog, options);
    return;
  }
  runExpand(catalog, args[0].toUpperCase(), deps, options);
}

export type { CatalogEntry };
