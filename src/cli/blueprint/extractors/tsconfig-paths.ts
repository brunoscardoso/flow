/**
 * tsconfig path-alias resolution for the module import extractor.
 *
 * The native import extractor (`modules.ts`) previously dropped every
 * non-relative import specifier, so tsconfig path-aliases — `@/lib/mailer`,
 * `@components/Button`, ubiquitous in Next.js / TS apps — produced NO
 * module→module `imports` edges. On an aliased codebase the blueprint board
 * therefore showed disconnected nodes even though the usage relationships were
 * right there in the source.
 *
 * This module resolves a specifier to a repo-relative posix path (WITHOUT a
 * file extension — `moduleOf` matches by directory prefix, so the extension is
 * irrelevant) or `null` for a true external package. It is PURE: no filesystem
 * access, fully deterministic, unit-tested in isolation. The one filesystem
 * touch — reading `<root>/tsconfig.json` — is isolated in `loadAliasConfig`
 * and is fail-soft (missing / unparseable → relative-only, the old behavior).
 *
 * External packages are filtered in two layers: this resolver returns `null`
 * for bare specifiers that cannot be local (no `baseUrl`, unmatched scoped
 * packages), and the caller's `moduleOf` existence check drops any candidate
 * that does not map to a real module directory (so `react` under `baseUrl: '.'`
 * resolves to the candidate `react`, which owns no module node → no edge).
 *
 * NOT handled in v1 (documented, fail-soft): `extends` chains (only the
 * repo-root tsconfig's own `compilerOptions` are read) and nested
 * per-package tsconfigs in a monorepo (a single root tsconfig is consulted).
 */

import { posix } from 'node:path';
import { readFileSafe } from './scan.js';

/**
 * Parsed alias configuration for a repo.
 * - `baseUrl`: repo-relative posix directory the `paths` targets and bare
 *   `baseUrl` imports resolve against. `null` = not configured (bare non-alias
 *   imports are then treated as external); `''` / `'.'` = the repo root.
 * - `paths`: the tsconfig `compilerOptions.paths` map (pattern → target list).
 */
export interface AliasConfig {
  baseUrl: string | null;
  paths: Record<string, string[]>;
}

/** An alias config that resolves nothing beyond relative imports. */
export const EMPTY_ALIAS_CONFIG: AliasConfig = { baseUrl: null, paths: {} };

/** Normalize a configured baseUrl to a repo-relative dir ('' = repo root). */
function baseDirOf(baseUrl: string | null): string {
  if (baseUrl === null || baseUrl === '' || baseUrl === '.') {
    return '';
  }
  return baseUrl.replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Strip a leading `./` from a paths target so joins stay clean. */
function cleanTarget(target: string): string {
  return target.replace(/^\.\//, '');
}

/**
 * Match a specifier against the `paths` map and return the substituted target
 * (still relative to baseUrl), or null when nothing matches. Exact (starless)
 * patterns win outright; among `*` patterns the LONGEST static prefix wins —
 * TypeScript's "most specific pattern" rule — so `@/lib/*` beats `@/*`.
 */
function matchPaths(spec: string, paths: Record<string, string[]>): string | null {
  for (const [pattern, targets] of Object.entries(paths)) {
    if (!pattern.includes('*') && pattern === spec && targets.length > 0) {
      return cleanTarget(targets[0]);
    }
  }

  let best: string | null = null;
  let bestPrefixLen = -1;
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    if (star === -1 || targets.length === 0) {
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      spec.length >= prefix.length + suffix.length &&
      spec.startsWith(prefix) &&
      spec.endsWith(suffix) &&
      prefix.length > bestPrefixLen
    ) {
      const captured = spec.slice(prefix.length, spec.length - suffix.length);
      const target = cleanTarget(targets[0]);
      best = target.includes('*') ? target.replace('*', captured) : target;
      bestPrefixLen = prefix.length;
    }
  }
  return best;
}

/**
 * Resolve an import specifier to a repo-relative posix path (no extension), or
 * null for a true external package. Pure and deterministic.
 *
 * Resolution order:
 * 1. Relative (`./`, `../`) — resolved against `fromFile`'s directory
 *    (the extractor's prior behavior); escaping the repo root → null.
 * 2. tsconfig `paths` alias — resolved against `baseUrl`.
 * 3. Scoped package (`@scope/...`) not matched by `paths` → external → null.
 * 4. Bare specifier with a configured `baseUrl` → the baseUrl-relative
 *    candidate (the caller's `moduleOf` existence check filters real packages).
 * 5. Otherwise (bare, no baseUrl) → external → null.
 */
export function resolveImportSpecifier(
  spec: string,
  fromFile: string,
  config: AliasConfig,
): string | null {
  if (spec.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fromFile), spec));
    return resolved.startsWith('..') ? null : resolved;
  }

  const baseDir = baseDirOf(config.baseUrl);

  const aliasTarget = matchPaths(spec, config.paths);
  if (aliasTarget !== null) {
    const resolved = posix.normalize(posix.join(baseDir, aliasTarget));
    return resolved.startsWith('..') ? null : resolved;
  }

  if (spec.startsWith('@')) {
    return null; // Scoped package not covered by an alias — external
  }

  if (config.baseUrl !== null) {
    const resolved = posix.normalize(posix.join(baseDir, spec));
    return resolved.startsWith('..') ? null : resolved;
  }

  return null; // Bare specifier, no baseUrl — a package import
}

/** Strip line and block comments plus trailing commas (tsconfig is JSONC, not strict JSON). */
function stripJsonc(text: string): string {
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return withoutComments.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Load the repo-root tsconfig's alias configuration (`compilerOptions.baseUrl`
 * + `paths`). Fail-soft: a missing or unparseable tsconfig yields
 * `EMPTY_ALIAS_CONFIG` (relative-only resolution, the prior behavior).
 *
 * `extends` is intentionally NOT followed in v1 — only this tsconfig's own
 * `compilerOptions` are read. tsconfig is JSONC, so comments and trailing
 * commas are tolerated before `JSON.parse`.
 */
export function loadAliasConfig(repoRoot: string): AliasConfig {
  const raw = readFileSafe(posix.join(repoRoot, 'tsconfig.json'));
  if (raw === null) {
    return EMPTY_ALIAS_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(raw));
  } catch {
    return EMPTY_ALIAS_CONFIG; // Unparseable even after JSONC cleanup
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return EMPTY_ALIAS_CONFIG;
  }
  const compilerOptions = (parsed as Record<string, unknown>).compilerOptions;
  if (typeof compilerOptions !== 'object' || compilerOptions === null) {
    return EMPTY_ALIAS_CONFIG;
  }
  const options = compilerOptions as Record<string, unknown>;

  const baseUrl = typeof options.baseUrl === 'string' ? options.baseUrl : null;

  const paths: Record<string, string[]> = {};
  if (typeof options.paths === 'object' && options.paths !== null && !Array.isArray(options.paths)) {
    for (const [pattern, value] of Object.entries(options.paths as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        const targets = value.filter((entry): entry is string => typeof entry === 'string');
        if (targets.length > 0) {
          paths[pattern] = targets;
        }
      }
    }
  }

  return { baseUrl, paths };
}
