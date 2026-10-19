/**
 * GraphQL convention pack (#901) — operations as endpoints, queries AND
 * mutations first-class.
 *
 * Runs only when the root package.json declares a GraphQL server dependency
 * (`@apollo/server`, `graphql-yoga`, `@pothos/core`, `type-graphql`) — a
 * client-only app (`@apollo/client` alone) exposes no operations. Two
 * extraction signals:
 *
 * 1. Pothos code-first:
 *    - `queryField('name', …)` / `mutationField('name', …)` helpers
 *    - field keys inside `queryType({ fields: (t) => ({ name: t.field(…) }) })`
 *      and `mutationType({ … })` blocks (brace-matched; `t.arg.*` argument
 *      declarations are excluded so args never read as operations).
 * 2. SDL template literals: field names inside `type Query { … }` /
 *    `type Mutation { … }` blocks.
 *
 * Node ids: `endpoint:query <name>` / `endpoint:mutation <name>`, with
 * `meta.operation`, `meta.pathGroup: 'graphql'` (one board rollup card), and
 * `meta.detectedVia: 'pothos' | 'sdl'`. Doc-example guard (forbidden-pattern
 * #9): patterns require call/SDL syntax — the placeholder forms used in this
 * header do not match themselves. Test files skipped (#538); deterministic.
 */

import { join } from 'node:path';
import type { BlueprintNode } from '../../types.js';
import {
  isSourceFile,
  isTestFile,
  readFileSafe,
  readPackageJsonSafe,
  collectDependencyNames,
  sortNodes,
  walkRepo,
  type ExtractorFragment,
  type RepoScan,
} from '../scan.js';

/** Dependencies that indicate a GraphQL SERVER (not just a client). */
const GRAPHQL_SERVER_DEPS = ['@apollo/server', 'graphql-yoga', '@pothos/core', 'type-graphql'];

/** `queryField('name'` / `mutationField('name'` (Pothos helpers). */
const POTHOS_FIELD_HELPER_PATTERN = /\b(query|mutation)Field\s*\(\s*[`'"](\w+)[`'"]/g;

/** `queryType(` / `mutationType(` block openers (Pothos code-first). */
const POTHOS_TYPE_BLOCK_PATTERN = /\b(query|mutation)Type\s*\(/g;

/** A field key inside a Pothos fields object: `name: t.field(` — never `t.arg`. */
const POTHOS_FIELD_KEY_PATTERN = /(\w+)\s*:\s*t\.(?!arg\b)\w+(?:\.\w+)*\s*\(/g;

/** `type Query {` / `type Mutation {` SDL block openers. */
const SDL_TYPE_BLOCK_PATTERN = /\btype\s+(Query|Mutation)\s*\{/g;

/** An SDL field line: `name(args): Type` or `name: Type`. */
const SDL_FIELD_PATTERN = /^\s*(\w+)\s*[(:]/;

/**
 * The brace-matched span starting at the first `{` at/after `openIndex`.
 * Returns the content between the braces, or null when unbalanced.
 */
export function braceBlockAt(content: string, openIndex: number): string | null {
  const start = content.indexOf('{', openIndex);
  if (start === -1) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start + 1, i);
      }
    }
  }
  return null;
}

/**
 * Detect GraphQL operations for a repository. Fail-soft: no server dep →
 * empty fragment with no notes; unreadable files skipped and counted.
 */
export function extractGraphqlOperations(repoRoot: string, repoScan?: RepoScan): ExtractorFragment {
  const packageJson = readPackageJsonSafe(repoRoot);
  const dependencyNames = packageJson === null ? [] : collectDependencyNames(packageJson);
  const serverDep = GRAPHQL_SERVER_DEPS.find((dep) => dependencyNames.includes(dep));
  if (serverDep === undefined) {
    return { nodes: [], edges: [], coverageNotes: [] };
  }

  const nodesById = new Map<string, BlueprintNode>();
  let queryCount = 0;
  let mutationCount = 0;
  let unreadableFiles = 0;

  const addOperation = (
    operation: 'query' | 'mutation',
    name: string,
    relPath: string,
    detectedVia: 'pothos' | 'sdl',
  ): void => {
    const id = `endpoint:${operation} ${name}`;
    if (nodesById.has(id)) {
      return;
    }
    nodesById.set(id, {
      id,
      kind: 'endpoint',
      label: `${operation} ${name}`,
      sourceFile: relPath,
      symbol: name,
      meta: { operation, route: name, pathGroup: 'graphql', detectedVia },
    });
    if (operation === 'query') queryCount += 1;
    else mutationCount += 1;
  };

  const scan = repoScan ?? walkRepo(repoRoot);
  for (const relPath of scan.files) {
    if (!isSourceFile(relPath) || isTestFile(relPath)) {
      continue;
    }
    const content = readFileSafe(join(repoRoot, relPath));
    if (content === null) {
      unreadableFiles += 1;
      continue;
    }

    // Pothos helper form
    for (const match of content.matchAll(POTHOS_FIELD_HELPER_PATTERN)) {
      addOperation(match[1] as 'query' | 'mutation', match[2], relPath, 'pothos');
    }

    // Pothos block form
    for (const match of content.matchAll(POTHOS_TYPE_BLOCK_PATTERN)) {
      const operation = match[1] as 'query' | 'mutation';
      const block = braceBlockAt(content, match.index + match[0].length - 1);
      if (block === null) {
        continue;
      }
      for (const fieldMatch of block.matchAll(POTHOS_FIELD_KEY_PATTERN)) {
        addOperation(operation, fieldMatch[1], relPath, 'pothos');
      }
    }

    // SDL form
    for (const match of content.matchAll(SDL_TYPE_BLOCK_PATTERN)) {
      const operation = match[1] === 'Query' ? 'query' : 'mutation';
      const block = braceBlockAt(content, match.index);
      if (block === null) {
        continue;
      }
      for (const line of block.split('\n')) {
        const fieldMatch = SDL_FIELD_PATTERN.exec(line);
        if (fieldMatch !== null) {
          addOperation(operation, fieldMatch[1], relPath, 'sdl');
        }
      }
    }
  }

  const coverageNotes = [
    nodesById.size > 0
      ? `graphql: ${queryCount} quer${queryCount === 1 ? 'y' : 'ies'} · ${mutationCount} mutation(s) (server: ${serverDep})`
      : `graphql: server detected (${serverDep}) but 0 operations extracted`,
  ];
  if (unreadableFiles > 0) {
    coverageNotes.push(`graphql: ${unreadableFiles} unreadable source file(s) skipped`);
  }

  return { nodes: sortNodes([...nodesById.values()]), edges: [], coverageNotes };
}
