/**
 * FastAPI convention pack — Python REGISTRATION-STYLE endpoints, grounded on
 * the live orbit-core layout (the federation driving pair's provider half:
 * without this pack a Python provider publishes a BLIND surface and
 * cross-project matching can never fire automatically).
 *
 * FastAPI declares endpoints as decorators on router objects, and the FULL
 * URL is assembled by a chain of `include_router` mounts across files:
 *
 *   app = FastAPI()                              # application.py
 *   app.include_router(api_router, prefix="/api")
 *   api_router.include_router(v1_router, prefix="/v1")   # router.py
 *   v1_router.include_router(agents.router, prefix="/agents")
 *   @router.get("/stream")                       # agents/views.py
 *   → GET /api/v1/agents/stream
 *
 * So the pack resolves three layers, all heuristic and fail-soft:
 *  1. Router defs: `NAME = APIRouter(...)` (own `prefix=` honored) and
 *     `NAME = FastAPI(...)` (a mount root).
 *  2. Routes: `@NAME.<verb>("path")` decorators (multi-line tolerant).
 *  3. Mounts: `PARENT.include_router(CHILD, prefix=...)`, where CHILD
 *     resolves through per-file import maps (`from x.y import agents`,
 *     `... import router as audit_router`) including `__init__.py`
 *     re-export chains (`from pkg.views import router`).
 *
 * Routers never reached from a root still emit their routes at whatever
 * prefix chain WAS resolvable (partial paths only under-match the federation
 * matcher — the suffix rule can't overmatch on them) and are counted in a
 * coverage note. Python test files (`test_*.py`, `conftest.py`, `tests/`
 * dirs) are skipped (#538). Deterministic: sorted walk, stable output.
 */

import { join } from 'node:path';
import type { BlueprintNode } from '../../types.js';
import { readFileSafe, sortNodes, toPosixPath, walkRepo, type ExtractorFragment, type RepoScan } from '../scan.js';
import { pathGroupOf } from './nextjs.js';

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

/** `@router.get(` … `"path"` — the path literal may sit on the next line. */
const ROUTE_DECORATOR_PATTERN =
  /@([A-Za-z_]\w*)\.(get|post|put|patch|delete|head|options)\s*\(\s*(?:\r?\n\s*)?["']([^"']*)["']/g;

/** `name = APIRouter(` / `name = FastAPI(` (assignment may be indented). */
const ROUTER_DEF_PATTERN = /(?:^|\n)\s*([A-Za-z_]\w*)\s*=\s*(APIRouter|FastAPI)\s*\(/g;

/** `parent.include_router(` — arguments read from a balanced-paren slice. */
const INCLUDE_CALL_PATTERN = /([A-Za-z_]\w*)\.include_router\s*\(/g;

/** `from x.y import a, b as c` (single-line or parenthesized multi-line). */
const FROM_IMPORT_PATTERN = /(?:^|\n)from\s+([\w.]+)\s+import\s+(\(([\s\S]*?)\)|[^\n]+)/g;

/** Python test conventions the TS-oriented isTestFile misses. */
function isPythonTestFile(posixPath: string): boolean {
  const base = posixPath.split('/').pop() ?? '';
  return (
    /(?:^|\/)(?:tests?|__tests__|conftest|fixtures)\//.test(posixPath) ||
    base.startsWith('test_') ||
    base.endsWith('_test.py') ||
    base === 'conftest.py'
  );
}

/** The balanced-paren argument slice starting at `openIndex` (the '('). */
function argSlice(content: string, openIndex: number): string {
  let depth = 0;
  for (let index = openIndex; index < content.length && index < openIndex + 4000; index += 1) {
    const char = content[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return content.slice(openIndex + 1, index);
    }
  }
  return content.slice(openIndex + 1, openIndex + 4000);
}

/** The `prefix="..."` kwarg inside an argument slice, or ''. */
function prefixOf(args: string): string {
  const match = /prefix\s*=\s*["']([^"']*)["']/.exec(args);
  return match?.[1] ?? '';
}

/** Python module id of a repo file: posix path minus `.py`, `/__init__` folded. */
function moduleIdOf(relPath: string): string {
  return toPosixPath(relPath).replace(/\.py$/, '').replace(/\/__init__$/, '');
}

interface RouterDef {
  /** `<moduleId>:<varName>` */
  key: string;
  moduleId: string;
  varName: string;
  ownPrefix: string;
  isRoot: boolean;
  file: string;
}

interface RouteDecl {
  routerKey: string;
  method: string;
  path: string;
  file: string;
}

interface IncludeDecl {
  /** Parent var name in the declaring file (resolved late — may be a root). */
  parentVar: string;
  moduleId: string;
  /** Child expression text: `router`, `agents.router`, `audit_router`… */
  childExpr: string;
  prefix: string;
}

type ImportBinding = { kind: 'module'; module: string } | { kind: 'attr'; module: string; attr: string };

interface FileFacts {
  moduleId: string;
  imports: Map<string, ImportBinding>;
}

export function extractFastapiEndpoints(repoRoot: string, repoScan?: RepoScan): ExtractorFragment {
  const scan = repoScan ?? walkRepo(repoRoot);
  const pythonFiles = scan.files.filter(
    (relPath) => relPath.endsWith('.py') && !isPythonTestFile(toPosixPath(relPath)),
  );
  const moduleIds = new Set(pythonFiles.map((relPath) => moduleIdOf(relPath)));

  const routersByKey = new Map<string, RouterDef>();
  const routes: RouteDecl[] = [];
  const includes: IncludeDecl[] = [];
  const factsByModule = new Map<string, FileFacts>();
  let unreadableFiles = 0;

  for (const relPath of pythonFiles) {
    const content = readFileSafe(join(repoRoot, relPath));
    if (content === null) {
      unreadableFiles += 1;
      continue;
    }
    const moduleId = moduleIdOf(relPath);

    const imports = new Map<string, ImportBinding>();
    for (const importMatch of content.matchAll(FROM_IMPORT_PATTERN)) {
      const fromModule = importMatch[1].replace(/\./g, '/');
      const namesText = importMatch[3] ?? importMatch[2];
      for (const piece of namesText.split(',')) {
        const nameMatch = /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(piece);
        if (nameMatch === null) continue;
        const target = `${fromModule}/${nameMatch[1]}`;
        const alias = nameMatch[2] ?? nameMatch[1];
        imports.set(
          alias,
          moduleIds.has(target)
            ? { kind: 'module', module: target }
            : { kind: 'attr', module: fromModule, attr: nameMatch[1] },
        );
      }
    }
    factsByModule.set(moduleId, { moduleId, imports });

    for (const defMatch of content.matchAll(ROUTER_DEF_PATTERN)) {
      const openIndex = defMatch.index + defMatch[0].length - 1;
      const key = `${moduleId}:${defMatch[1]}`;
      routersByKey.set(key, {
        key,
        moduleId,
        varName: defMatch[1],
        ownPrefix: defMatch[2] === 'APIRouter' ? prefixOf(argSlice(content, openIndex)) : '',
        isRoot: defMatch[2] === 'FastAPI',
        file: toPosixPath(relPath),
      });
    }

    for (const routeMatch of content.matchAll(ROUTE_DECORATOR_PATTERN)) {
      routes.push({
        routerKey: `${moduleId}:${routeMatch[1]}`,
        method: routeMatch[2].toUpperCase(),
        path: routeMatch[3],
        file: toPosixPath(relPath),
      });
    }

    for (const includeMatch of content.matchAll(INCLUDE_CALL_PATTERN)) {
      const args = argSlice(content, includeMatch.index + includeMatch[0].length - 1);
      const childMatch = /^\s*(?:router\s*=\s*)?([A-Za-z_][\w.]*)/.exec(args);
      if (childMatch === null) continue;
      includes.push({ parentVar: includeMatch[1], moduleId, childExpr: childMatch[1], prefix: prefixOf(args) });
    }
  }

  /** Resolve `attr` of `moduleId` to a RouterDef key, following `__init__`
   *  re-export chains (`from pkg.views import router`). */
  const resolveAttr = (moduleId: string, attr: string, depth: number): string | null => {
    if (depth > 6) return null;
    const direct = `${moduleId}:${attr}`;
    if (routersByKey.has(direct)) return direct;
    const binding = factsByModule.get(moduleId)?.imports.get(attr);
    if (binding === undefined) return null;
    if (binding.kind === 'attr') return resolveAttr(binding.module, binding.attr, depth + 1);
    return null; // an alias bound to a whole module is not a router value
  };

  /** Resolve a child expression in a declaring module to a RouterDef key. */
  const resolveChild = (moduleId: string, expr: string): string | null => {
    const [head, ...rest] = expr.split('.');
    if (rest.length === 0) return resolveAttr(moduleId, head, 0);
    const binding = factsByModule.get(moduleId)?.imports.get(head);
    if (binding?.kind === 'module' && rest.length === 1) {
      return resolveAttr(binding.module, rest[0], 0);
    }
    if (binding?.kind === 'attr' && rest.length === 1) {
      // `from pkg import agents` where pkg/agents wasn't scanned as a module
      return resolveAttr(`${binding.module}/${binding.attr}`, rest[0], 0);
    }
    return null;
  };

  // Mount graph: child key → [{ parent key | null (root), include prefix }].
  const mounts = new Map<string, Array<{ parentKey: string | null; prefix: string }>>();
  let unresolvedIncludes = 0;
  for (const include of includes) {
    const childKey = resolveChild(include.moduleId, include.childExpr);
    if (childKey === null) {
      unresolvedIncludes += 1;
      continue;
    }
    const parentKey = resolveAttr(include.moduleId, include.parentVar, 0);
    const parentIsRoot = parentKey !== null && routersByKey.get(parentKey)?.isRoot === true;
    // An unresolvable parent (typically a `FastAPI` instance passed as a
    // function parameter — orbit's `register_routes(app)`) mounts at root.
    const entry = { parentKey: parentIsRoot || parentKey === null ? null : parentKey, prefix: include.prefix };
    const existing = mounts.get(childKey) ?? [];
    existing.push(entry);
    mounts.set(childKey, existing);
  }

  /** Every absolute prefix a router's routes live under (mount chain +
   *  each router's own APIRouter prefix). Cycle-capped. */
  const prefixCache = new Map<string, string[]>();
  const routerPrefixes = (key: string, depth: number): string[] => {
    const cached = prefixCache.get(key);
    if (cached !== undefined) return cached;
    if (depth > 8) return [];
    const router = routersByKey.get(key);
    if (router === undefined) return [];
    const mountEntries = mounts.get(key);
    const bases =
      mountEntries === undefined || mountEntries.length === 0
        ? [''] // unmounted or root-mounted-nowhere: partial chain, still emit
        : mountEntries.flatMap((mount) =>
            mount.parentKey === null
              ? [mount.prefix]
              : routerPrefixes(mount.parentKey, depth + 1).map((base) => base + mount.prefix),
          );
    const result = [...new Set(bases.map((base) => base + router.ownPrefix))].sort();
    prefixCache.set(key, result);
    return result;
  };

  const nodesById = new Map<string, BlueprintNode>();
  let orphanRoutes = 0;
  for (const route of routes) {
    const router = routersByKey.get(route.routerKey);
    if (router === undefined) {
      orphanRoutes += 1;
      continue;
    }
    // Unmounted-router routes carry PARTIAL paths (`/activate`, `/{task_id}`…)
    // whose first segments are all distinct — each would mint its own rollup
    // card and flood the board's band. They group under one honest umbrella.
    const partial = !router.isRoot && !mounts.has(route.routerKey);
    for (const prefix of routerPrefixes(route.routerKey, 0)) {
      const routePath = (`${prefix}${route.path}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/');
      const id = `endpoint:${route.method} ${routePath}`;
      if (nodesById.has(id)) continue;
      nodesById.set(id, {
        id,
        kind: 'endpoint',
        label: `${route.method} ${routePath}`,
        sourceFile: route.file,
        meta: {
          method: route.method,
          route: routePath,
          pathGroup: partial ? '(partial)' : pathGroupOf(routePath),
          detectedVia: 'fastapi',
        },
      });
    }
  }

  const unmountedRouters = [...routersByKey.values()].filter(
    (router) => !router.isRoot && !mounts.has(router.key) && routes.some((route) => route.routerKey === router.key),
  ).length;

  const coverageNotes = [
    `fastapi: ${nodesById.size} endpoint(s) from ${routes.length} route decorator(s) across ${routersByKey.size} router(s)`,
  ];
  if (unmountedRouters > 0) {
    coverageNotes.push(`fastapi: ${unmountedRouters} unmounted router(s) — their paths may lack app prefixes`);
  }
  if (unresolvedIncludes > 0) {
    coverageNotes.push(`fastapi: ${unresolvedIncludes} include_router call(s) with unresolvable children skipped`);
  }
  if (orphanRoutes > 0) {
    coverageNotes.push(`fastapi: ${orphanRoutes} route decorator(s) on undefined routers skipped`);
  }
  if (unreadableFiles > 0) {
    coverageNotes.push(`fastapi: ${unreadableFiles} unreadable python file(s) skipped`);
  }

  return { nodes: sortNodes([...nodesById.values()]), edges: [], coverageNotes };
}

/** Verb list export for tests. */
export const FASTAPI_HTTP_VERBS = HTTP_VERBS;
