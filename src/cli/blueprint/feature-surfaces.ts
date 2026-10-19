/**
 * Capability surfaces (feature-blueprint) — where a repo NAMES its features.
 *
 * WHY THIS EXISTS
 * ===============
 * The first cut mined features from the plan/discovery corpus. That corpus is
 * real and human-written, but it names CHANGES, not capabilities: "Chat Engine
 * Migration", "Deprecate Workflows", "Duplicate Messages on Chat Switch". Put
 * on a board as level-1 nodes they read as a work log, because that is what
 * they are. The main features of that same product are Chat, Playbooks, Skills,
 * Spaces — and every one of them is already named, repeatedly, in the repo's
 * own conventions.
 *
 * So core features are mined from SURFACES — the places where a developer had
 * to type a capability's name for the framework or the test runner to work:
 *
 *   ui-route     a page segment      `src/app/app/(protected)/playbooks`
 *   api-route    an endpoint group   `src/app/api/knowledge-hubs`
 *   e2e-suite    a test directory    `e2e/tests/playbooks`
 *   feature-root a convention dir    `src/features/billing`, `packages/auth`
 *
 * These are not inference. Nobody writes `e2e/tests/playbooks` unless playbooks
 * are a thing the product does.
 *
 * THE TWO-PLANE RULE
 * ==================
 * A name is kept only when it appears in at least TWO DISTINCT SURFACE KINDS.
 * That single rule is what separates a capability from plumbing: `playbooks` is
 * a page AND a test suite; `telemetry`, `blob` and `pendo` are one API route
 * each and nothing more. Measured on a real Next.js product it turns ~120 raw
 * segments into ~12 names a human recognises. Raising it to three would drop
 * real features that have no test suite yet; lowering it to one readmits the
 * plumbing.
 *
 * Deterministic, free, no LLM: sorted walks, sorted output, no clock.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { slugifyFeatureName } from './feature-store.js';

/** The plane a name was found in. Distinct kinds are what the rule counts. */
export type SurfaceKind = 'ui-route' | 'api-route' | 'e2e-suite' | 'feature-root';

/** One sighting of a name. */
export interface SurfaceSignal {
  kind: SurfaceKind;
  /** Repo-relative directory that carried the name. */
  path: string;
}

/** A capability the repo names in more than one plane. */
export interface SurfaceCandidate {
  /** Canonical (singularized) grouping key — `chats` and `chat` are one thing. */
  key: string;
  /** Filename slug, from the display name. */
  slug: string;
  /** Display name — the repo's own most common spelling, title-cased. */
  name: string;
  signals: SurfaceSignal[];
  /** `module:<dir>` anchors, one per sighting. */
  anchors: string[];
}

/** How many distinct planes a name must appear in to count as a capability. */
export const MIN_DISTINCT_SURFACES = 2;

/** Route roots, in scan order. Covers Next (app + pages), Remix/SvelteKit. */
const ROUTE_ROOTS = ['src/app', 'app', 'src/pages', 'pages', 'src/routes', 'routes'] as const;

/** E2E suite roots — each immediate child directory is a suite name. */
const E2E_ROOTS = [
  'e2e/tests', 'e2e/specs', 'tests/e2e', 'test/e2e', 'cypress/e2e', 'cypress/integration',
  'playwright/tests', 'app/e2e/tests',
] as const;

/** Directories whose children are features by convention. */
const FEATURE_ROOT_NAMES = new Set(['features', 'modules', 'domains', 'packages', 'apps']);

/** How deep below a route root a named segment still counts. */
const ROUTE_DEPTH_LIMIT = 3;

/** How deep to look for a conventional feature root. */
const FEATURE_ROOT_DEPTH = 3;

/**
 * Segments that are never a capability name. Two groups, both learned from
 * real route trees: framework/infra plumbing, and CRUD verbs that appear as
 * route segments (`playbooks/new`) but name an action, not a thing.
 */
const NOISE_SEGMENTS = new Set([
  // framework + infra
  'api', 'app', 'src', 'lib', 'utils', 'shared', 'common', 'components', 'hooks',
  'types', 'config', 'constants', 'context', 'stores', 'styles', 'assets', 'public',
  'static', 'images', 'fonts', 'svg', 'test', 'tests', 'e2e', 'mocks', '__mocks__',
  'fixtures', 'node_modules', 'dist', 'build', 'out', 'coverage', 'scripts', 'docs',
  'middleware', 'instrumentation', 'internal', 'debug', 'sandbox', 'health', 'healthz',
  'well-known', 'auth-callback', 'callback', 'cron', 'webhook', 'webhooks', 'proxy',
  'telemetry', 'metrics', 'logs', 'logging', 'trpc', 'graphql', 'rest', 'v1', 'v2',
  'sdk', 'token', 'tokens', 'oauth', 'session', 'sessions', 'blob', 'upload', 'uploads',
  // CRUD verbs / route leaves
  'new', 'create', 'edit', 'update', 'delete', 'list', 'view', 'detail', 'details',
  'index', 'page', 'layout', 'loading', 'error', 'not-found', 'template', 'default',
  'sitemap', 'robots', 'favicon', 'manifest', 'opengraph-image', 'icon',
]);

/** Skip a route segment entirely: groups, dynamic params, private, dotfiles. */
function isStructuralSegment(name: string): boolean {
  return (
    name.startsWith('(') || name.startsWith('[') || name.startsWith('_') || name.startsWith('.') ||
    name.startsWith('@')
  );
}

/** Directories never walked, at any depth. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next']);

/** Naive singularization — enough to fuse `chats`/`chat`, never a linguist. */
function singularize(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && (word.endsWith('ches') || word.endsWith('shes') || word.endsWith('sses'))) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us')) {
    return word.slice(0, -1);
  }
  return word;
}

/** Canonical grouping key for a segment: per-word singular, hyphen-joined. */
export function canonicalKey(segment: string): string {
  return slugifyFeatureName(segment).split('-').map(singularize).join('-');
}

/** Title-case a slug for display: `knowledge-hubs` → `Knowledge Hubs`. */
function displayName(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word.length > 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Directory entries of `dir`, sorted; [] when unreadable. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** A raw sighting before grouping. */
interface Sighting {
  segment: string;
  kind: SurfaceKind;
  path: string;
}

/**
 * Walk a route root. Segments under an `api/` ancestor are API routes, the rest
 * are UI routes — that distinction is what lets `spaces` (page + endpoint) clear
 * the two-plane rule while an API-only name does not.
 */
function walkRoutes(repoRoot: string, root: string, out: Sighting[]): void {
  const walk = (relDir: string, depth: number, underApi: boolean): void => {
    if (depth > ROUTE_DEPTH_LIMIT) return;
    for (const name of subdirs(join(repoRoot, relDir))) {
      const childRel = `${relDir}/${name}`;
      if (isStructuralSegment(name)) {
        // Route groups don't consume a level — `(protected)/playbooks` is depth 1.
        walk(childRel, depth, underApi);
        continue;
      }
      const isApiDir = name === 'api';
      if (!isApiDir && !NOISE_SEGMENTS.has(name.toLowerCase())) {
        out.push({ segment: name, kind: underApi ? 'api-route' : 'ui-route', path: childRel });
      }
      walk(childRel, depth + 1, underApi || isApiDir);
    }
  };
  walk(root, 1, false);
}

/** Immediate children of each e2e root are suite names. */
function walkE2e(repoRoot: string, out: Sighting[]): void {
  for (const root of E2E_ROOTS) {
    if (!existsSync(join(repoRoot, root))) continue;
    for (const name of subdirs(join(repoRoot, root))) {
      if (isStructuralSegment(name) || NOISE_SEGMENTS.has(name.toLowerCase())) continue;
      out.push({ segment: name, kind: 'e2e-suite', path: `${root}/${name}` });
    }
  }
}

/** Find `features/`, `modules/`, … anywhere shallow, and take their children. */
function walkFeatureRoots(repoRoot: string, out: Sighting[]): void {
  const walk = (relDir: string, depth: number): void => {
    if (depth > FEATURE_ROOT_DEPTH) return;
    for (const name of subdirs(join(repoRoot, relDir))) {
      const childRel = relDir === '' ? name : `${relDir}/${name}`;
      if (FEATURE_ROOT_NAMES.has(name.toLowerCase())) {
        for (const leaf of subdirs(join(repoRoot, childRel))) {
          if (isStructuralSegment(leaf) || NOISE_SEGMENTS.has(leaf.toLowerCase())) continue;
          out.push({ segment: leaf, kind: 'feature-root', path: `${childRel}/${leaf}` });
        }
        continue;
      }
      if (isStructuralSegment(name)) continue;
      walk(childRel, depth + 1);
    }
  };
  walk('', 1);
}

/**
 * Mine capability names from the repo's surfaces. Returns only names clearing
 * `MIN_DISTINCT_SURFACES`, strongest first (distinct planes, then sightings,
 * then name) so a caller taking the top N takes the most-evidenced ones.
 */
export function mineSurfaces(repoRoot: string): SurfaceCandidate[] {
  const sightings: Sighting[] = [];
  for (const root of ROUTE_ROOTS) {
    if (existsSync(join(repoRoot, root))) walkRoutes(repoRoot, root, sightings);
  }
  walkE2e(repoRoot, sightings);
  walkFeatureRoots(repoRoot, sightings);

  const byKey = new Map<string, { signals: SurfaceSignal[]; spellings: Map<string, number> }>();
  for (const sighting of sightings) {
    const slug = slugifyFeatureName(sighting.segment);
    if (slug.length === 0 || slug === 'feature') continue;
    const key = canonicalKey(sighting.segment);
    const bucket = byKey.get(key) ?? { signals: [], spellings: new Map<string, number>() };
    // The same directory can be reached twice (nested roots like `app` and
    // `src/app`); one path contributes one signal.
    if (!bucket.signals.some((signal) => signal.path === sighting.path)) {
      bucket.signals.push({ kind: sighting.kind, path: sighting.path });
      bucket.spellings.set(slug, (bucket.spellings.get(slug) ?? 0) + 1);
    }
    byKey.set(key, bucket);
  }

  const out: SurfaceCandidate[] = [];
  for (const [key, bucket] of byKey) {
    const kinds = new Set(bucket.signals.map((signal) => signal.kind));
    if (kinds.size < MIN_DISTINCT_SURFACES) continue;
    // The repo's own most common spelling wins; ties break on the longer form
    // (`knowledge-hubs` over a stray `hub`), then alphabetically for determinism.
    const slug = [...bucket.spellings.entries()].sort((a, b) =>
      b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]),
    )[0][0];
    const signals = [...bucket.signals].sort((a, b) => a.path.localeCompare(b.path));
    out.push({
      key,
      slug,
      name: displayName(slug),
      signals,
      anchors: [...new Set(signals.map((signal) => `module:${signal.path}`))].sort(),
    });
  }
  const ranked = out.sort((a, b) => {
    const kindsA = new Set(a.signals.map((signal) => signal.kind)).size;
    const kindsB = new Set(b.signals.map((signal) => signal.kind)).size;
    return kindsB - kindsA || b.signals.length - a.signals.length || a.key.localeCompare(b.key);
  });
  return ranked.filter((candidate) => !isNestedDetail(candidate, ranked));
}

/**
 * A name whose every sighting sits INSIDE a stronger capability's directory is
 * that capability's detail, not a peer of it: `playbooks/import-summary` is
 * part of Playbooks. Structural, so it needs no denylist entry per product —
 * and it only ever demotes against a candidate ranked above, so the strong
 * name always survives.
 */
function isNestedDetail(candidate: SurfaceCandidate, ranked: readonly SurfaceCandidate[]): boolean {
  const stronger = ranked.slice(0, ranked.indexOf(candidate));
  if (stronger.length === 0) return false;
  return candidate.signals.every((signal) =>
    stronger.some((other) =>
      other.signals.some((parent) => signal.path.startsWith(`${parent.path}/`)),
    ),
  );
}

/**
 * The core feature (by canonical key) a change-shaped name belongs under, or
 * null. Longest match wins: `knowledge-hub-availability` parents to
 * `knowledge-hub`, not to a stray `hub`.
 *
 * Token-boundary matching only — `chat-session-cache-rework` matches `chat`, but
 * `chatter` would not match `chat`, because substring matching parents things
 * to features that merely share letters.
 */
export function parentKeyFor(slug: string, coreKeys: readonly string[]): string | null {
  const tokens = canonicalKey(slug).split('-');
  let best: string | null = null;
  for (const key of coreKeys) {
    const keyTokens = key.split('-');
    for (let index = 0; index + keyTokens.length <= tokens.length; index += 1) {
      if (keyTokens.every((token, offset) => tokens[index + offset] === token)) {
        if (best === null || key.length > best.length) best = key;
        break;
      }
    }
  }
  return best;
}
