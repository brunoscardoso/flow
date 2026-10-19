/**
 * Endpoint extractor — detects route registrations from two signals:
 *
 * 1. HTTP framework routes (express/fastify/koa-router style) registered on
 *    common receiver names (app, router, server, api, fastify) via HTTP-verb
 *    methods. Only literal paths starting with a slash are considered routes.
 * 2. Commander CLI subcommands: `program.command('name')` in files that
 *    import commander — treated as CLI endpoints.
 *
 * Node id conventions: `endpoint:<METHOD> <path>` for HTTP routes and
 * `endpoint:cli <command>` for CLI commands. Method/route land in meta and
 * the registering symbol is captured where derivable (nearest preceding
 * top-level function/const declaration). Output is deterministic.
 */

import { join } from 'node:path';
import type { BlueprintNode } from '../types.js';
import { isSourceFile, isTestFile, readFileSafe, sortNodes, walkRepo, type ExtractorFragment, type RepoScan } from './scan.js';

/**
 * HTTP route registrations: an HTTP-verb method called on a common receiver
 * name (app, router, server, api, fastify) with a literal first argument.
 */
const HTTP_ROUTE_PATTERN =
  /\b(?:app|router|server|api|fastify)\s*\.\s*(get|post|put|delete|patch|head|options|all)\s*\(\s*[`'"]([^`'"]+)[`'"]/g;

/** Commander subcommand registrations: `.command('name')`. */
const COMMANDER_COMMAND_PATTERN = /\.\s*command\s*\(\s*[`'"]([^`'"]+)[`'"]/g;

/** Whether a file imports or requires commander. */
const COMMANDER_IMPORT_PATTERN = /(?:from\s+|require\s*\(\s*)[`'"]commander[`'"]/;

/** Top-level declarations used to derive the registering symbol. */
const TOP_LEVEL_FUNCTION_PATTERN = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/;
const TOP_LEVEL_CONST_PATTERN = /^(?:export\s+)?const\s+(\w+)\s*=/;

/**
 * Find the registering symbol for a match: the last top-level function or
 * const declaration that appears before the match offset. Returns undefined
 * when the registration is not inside a derivable top-level declaration.
 */
function findEnclosingSymbol(content: string, matchIndex: number): string | undefined {
  const precedingLines = content.slice(0, matchIndex).split('\n');
  for (let i = precedingLines.length - 1; i >= 0; i -= 1) {
    const line = precedingLines[i];
    const functionMatch = TOP_LEVEL_FUNCTION_PATTERN.exec(line);
    if (functionMatch !== null) {
      return functionMatch[1];
    }
    const constMatch = TOP_LEVEL_CONST_PATTERN.exec(line);
    if (constMatch !== null) {
      return constMatch[1];
    }
  }
  return undefined;
}

/**
 * Detect endpoint registrations for a repository.
 * Returns endpoint nodes (no edges) plus coverage notes; unreadable files
 * are skipped and counted, never thrown on. `repoScan` (optional) reuses a
 * pre-computed `walkRepo` result; omitted, this walks itself.
 */
export function extractEndpoints(repoRoot: string, repoScan?: RepoScan): ExtractorFragment {
  const coverageNotes: string[] = [];
  const nodesById = new Map<string, BlueprintNode>();
  const scan = repoScan ?? walkRepo(repoRoot);
  const sourceFiles = scan.files.filter((relPath) => isSourceFile(relPath) && !isTestFile(relPath)); // #538: skip test/fixture files

  let httpRouteCount = 0;
  let cliCommandCount = 0;
  let unreadableFiles = 0;

  for (const relPath of sourceFiles) {
    const content = readFileSafe(join(repoRoot, relPath));
    if (content === null) {
      unreadableFiles += 1;
      continue;
    }

    // Signal 1 — HTTP framework routes with literal paths
    for (const match of content.matchAll(HTTP_ROUTE_PATTERN)) {
      const method = match[1].toUpperCase();
      const route = match[2];
      if (!route.startsWith('/')) {
        continue; // Not a route literal — likely a settings getter call
      }
      const id = `endpoint:${method} ${route}`;
      if (!nodesById.has(id)) {
        nodesById.set(id, {
          id,
          kind: 'endpoint',
          label: `${method} ${route}`,
          sourceFile: relPath,
          symbol: findEnclosingSymbol(content, match.index),
          meta: { method, route },
        });
        httpRouteCount += 1;
      }
    }

    // Signal 2 — commander CLI subcommands (only in files importing commander)
    if (COMMANDER_IMPORT_PATTERN.test(content)) {
      for (const match of content.matchAll(COMMANDER_COMMAND_PATTERN)) {
        // Command literals may carry argument syntax ('init [dir]') — the
        // command name is the first whitespace-delimited token.
        const commandName = match[1].split(/\s+/)[0];
        if (commandName.length === 0) {
          continue;
        }
        const id = `endpoint:cli ${commandName}`;
        if (!nodesById.has(id)) {
          nodesById.set(id, {
            id,
            kind: 'endpoint',
            label: `cli ${commandName}`,
            sourceFile: relPath,
            symbol: findEnclosingSymbol(content, match.index),
            meta: { route: commandName, detectedVia: 'commander' },
          });
          cliCommandCount += 1;
        }
      }
    }
  }

  coverageNotes.push(
    `endpoints: ${httpRouteCount} HTTP route registration(s) (express/fastify/koa-router patterns)`,
    `endpoints: ${cliCommandCount} commander CLI command(s)`,
  );
  if (unreadableFiles > 0) {
    coverageNotes.push(`endpoints: ${unreadableFiles} unreadable source file(s) skipped`);
  }

  return { nodes: sortNodes([...nodesById.values()]), edges: [], coverageNotes };
}
