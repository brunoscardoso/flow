/**
 * Next.js convention pack (#901) — FILE-CONVENTION endpoints.
 *
 * Next.js declares HTTP endpoints by file placement, not registration calls:
 *
 * 1. App Router: `app/**\/route.{ts,js,tsx,jsx}` (incl. `src/app`) exports
 *    one handler per HTTP verb — `export async function GET(…)` or
 *    `export const GET = …`. The route path is the file's directory path:
 *    route groups `(group)` are stripped (they never appear in the URL),
 *    dynamic segments `[id]` / `[...slug]` are kept literally, and parallel
 *    (`@slot`) / intercepting (`(.)`) segments are skipped as non-endpoint
 *    files. One endpoint node per exported verb.
 * 2. Pages Router: `pages/api/**` (incl. `src/pages`) — one endpoint per
 *    file; the method is `*` (a single default-exported handler receives all
 *    verbs), the path is `/api/<file path>` with `[param]` kept and
 *    `/index` collapsed.
 *
 * Node ids follow the existing grammar: `endpoint:<METHOD> <path>`. Every
 * node carries `meta.pathGroup` — the first two path segments (e.g.
 * `/api/coworkers`) — which the board uses to roll concrete routes into
 * group cards, and `meta.detectedVia` for provenance. Test files are
 * skipped (#538). Output is deterministic (sorted walk, stable sort).
 */

import { join } from 'node:path';
import type { BlueprintNode } from '../../types.js';
import { isTestFile, readFileSafe, sortNodes, walkRepo, type ExtractorFragment, type RepoScan } from '../scan.js';

/** HTTP verbs the App Router recognizes as route-handler exports. */
const APP_ROUTER_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/** An `app/**\/route.*` file (route groups allowed anywhere above it). */
const APP_ROUTE_FILE_PATTERN = /(?:^|\/)app\/(.*)route\.(?:ts|js|tsx|jsx|mts|mjs)$/;

/** A `pages/api/**` file. */
const PAGES_API_FILE_PATTERN = /(?:^|\/)pages\/api\/(.+)\.(?:ts|js|tsx|jsx|mts|mjs)$/;

/**
 * Handler exports:  `export async function GET(` / `export function GET(` /
 * `export const GET =` — the verb list keeps ordinary exports out.
 */
const HANDLER_EXPORT_PATTERN =
  /export\s+(?:async\s+)?(?:function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(|const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=)/g;

/**
 * Derive the URL path for an App Router route file's captured directory part
 * (`<dirs>/` before `route.ts`, '' at the app root). Returns null when the
 * path contains parallel/intercepting segments (not plain endpoints).
 */
export function appRoutePathOf(dirPart: string): string | null {
  const segments = dirPart.split('/').filter((segment) => segment.length > 0);
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith('@') || segment.startsWith('(.')) {
      return null; // parallel slot / intercepting route — not a plain endpoint
    }
    if (segment.startsWith('(') && segment.endsWith(')')) {
      continue; // route group — stripped from the URL
    }
    kept.push(segment);
  }
  return `/${kept.join('/')}`.replace(/\/+$/, '') || '/';
}

/** Derive the URL path for a `pages/api/**` file's captured path part. */
export function pagesApiPathOf(filePart: string): string {
  const withoutIndex = filePart.replace(/(?:^|\/)index$/, '');
  return `/api/${withoutIndex}`.replace(/\/+$/, '') || '/api';
}

/** The rollup group for a route path: its first two segments (`/api/coworkers`). */
export function pathGroupOf(routePath: string): string {
  const segments = routePath.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return '/';
  }
  return `/${segments.slice(0, 2).join('/')}`;
}

/**
 * Detect Next.js file-convention endpoints for a repository. Fail-soft:
 * unreadable files are skipped and counted, never thrown on.
 */
export function extractNextJsEndpoints(repoRoot: string, repoScan?: RepoScan): ExtractorFragment {
  const nodesById = new Map<string, BlueprintNode>();
  const scan = repoScan ?? walkRepo(repoRoot);
  let appRouteCount = 0;
  let pagesApiCount = 0;
  let unreadableFiles = 0;

  for (const relPath of scan.files) {
    if (isTestFile(relPath)) {
      continue; // #538 — fixture routes must not become endpoints
    }

    const appMatch = APP_ROUTE_FILE_PATTERN.exec(relPath);
    if (appMatch !== null) {
      const routePath = appRoutePathOf(appMatch[1]);
      if (routePath === null) {
        continue;
      }
      const content = readFileSafe(join(repoRoot, relPath));
      if (content === null) {
        unreadableFiles += 1;
        continue;
      }
      const verbs = new Set<string>();
      for (const handlerMatch of content.matchAll(HANDLER_EXPORT_PATTERN)) {
        verbs.add(handlerMatch[1] ?? handlerMatch[2]);
      }
      for (const method of APP_ROUTER_VERBS) {
        if (!verbs.has(method)) {
          continue;
        }
        const id = `endpoint:${method} ${routePath}`;
        if (!nodesById.has(id)) {
          nodesById.set(id, {
            id,
            kind: 'endpoint',
            label: `${method} ${routePath}`,
            sourceFile: relPath,
            symbol: method,
            meta: {
              method,
              route: routePath,
              pathGroup: pathGroupOf(routePath),
              detectedVia: 'nextjs-app-router',
            },
          });
          appRouteCount += 1;
        }
      }
      continue;
    }

    const pagesMatch = PAGES_API_FILE_PATTERN.exec(relPath);
    if (pagesMatch !== null) {
      const routePath = pagesApiPathOf(pagesMatch[1]);
      const id = `endpoint:* ${routePath}`;
      if (!nodesById.has(id)) {
        nodesById.set(id, {
          id,
          kind: 'endpoint',
          label: `* ${routePath}`,
          sourceFile: relPath,
          meta: {
            method: '*',
            route: routePath,
            pathGroup: pathGroupOf(routePath),
            detectedVia: 'nextjs-pages-api',
          },
        });
        pagesApiCount += 1;
      }
    }
  }

  const coverageNotes = [
    `nextjs: ${appRouteCount} App Router endpoint(s) (app/**/route.* handler exports)`,
    `nextjs: ${pagesApiCount} Pages Router endpoint(s) (pages/api/**)`,
  ];
  if (unreadableFiles > 0) {
    coverageNotes.push(`nextjs: ${unreadableFiles} unreadable route file(s) skipped`);
  }

  return { nodes: sortNodes([...nodesById.values()]), edges: [], coverageNotes };
}
