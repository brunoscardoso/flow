/**
 * `blueprint features home --feature <ref> (--folder <path> | --clear) [--json]`
 * — the ONE writer of the person-owned `home:` key (plan `feature-home-folders`,
 * FR-10).
 *
 * A feature's folder rows are derived on every read (`feature-folders.ts`); a
 * person who knows better pins the folder that IS the feature's home, and the
 * rows then put it first with its real share. The pin lives in the feature
 * note's frontmatter, or — for a part (`feature:<f>/<part>`, the address
 * `addressableParts` mints) — on its `## Parts` entry, and this verb edits that
 * one line in place (`writeFeatureHome`): every other byte of the note stays as
 * it was. Sweeps and machine writes never touch it.
 *
 * The folder must be a folder of the project: relative, without `..`, existing,
 * a directory, and still inside the project once symlinks are followed.
 *
 * Refusals follow the family contract (allowed-pattern #21): a JSON payload
 * line on stdout carrying what the asker needs, then
 * `features refused: <reason> — <sentence>`, exit 1, nothing written.
 */
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

import { normalizePath } from './feature-map.js';
import { addressableParts } from './feature-graph.js';
import {
  featureHome,
  findFeatureByRef,
  readFeatures,
  readParts,
  writeFeatureHome,
  type FeatureNode,
  type HomeLineTarget,
} from './feature-store.js';

export interface FeatureHomeVerbInput {
  /** The project checkout (`flow/` beneath it). */
  repoRoot: string;
  /** `--feature <id|slug|address>` — a feature, or one of its parts. */
  feature?: string;
  /** `--folder <path>` — repo-relative. */
  folder?: string;
  /** `--clear` — remove the pin. */
  clear?: boolean;
  json?: boolean;
}

export interface FeatureHomeVerbOutput {
  exitCode: number;
  /** Exactly what the command prints on stdout. */
  stdout: string;
}

/** What a successful write reports. */
export interface FeatureHomeResult {
  action: 'features-home';
  /** The owning feature's slug. */
  feature: string;
  /** The part's address, or null for the feature itself. */
  part: string | null;
  /** The home now pinned, or null when cleared. */
  home: string | null;
  /** The home pinned before, or null. */
  previous: string | null;
}

class HomeRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly sentence: string,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(`${reason} — ${sentence}`);
    this.name = 'HomeRefusal';
  }
}

interface ResolvedTarget {
  feature: FeatureNode;
  part: { id: string; name: string } | null;
  current: string | null;
}

/** A feature by any reference, or one of its parts by its address. */
function resolveTarget(flowDir: string, ref: string): ResolvedTarget | null {
  const features = readFeatures(flowDir);
  const feature = findFeatureByRef(features, ref);
  if (feature !== undefined) return { feature, part: null, current: featureHome(feature) };
  const wanted = ref.includes(':') ? ref : `feature:${ref}`;
  for (const candidate of features) {
    if (!wanted.startsWith(`${candidate.id}/`)) continue;
    const match = addressableParts(candidate.id, readParts(flowDir, candidate.slug)).find((entry) => entry.id === wanted);
    if (match !== undefined) {
      return { feature: candidate, part: { id: match.id, name: match.name }, current: match.part.home ?? null };
    }
  }
  return null;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** The nearest existing folder above `rel` inside the project, or null at the root. */
function nearestExistingFolder(repoRoot: string, rel: string): string | null {
  let current = dirname(rel);
  while (current !== '.' && current !== '' && current !== '/') {
    try {
      if (statSync(join(repoRoot, current)).isDirectory()) return current.split(sep).join('/');
    } catch {
      // not there either — keep climbing
    }
    current = dirname(current);
  }
  return null;
}

/** A requested folder, validated and normalized — or a refusal naming why not. */
export function validateHomeFolder(repoRoot: string, requested: string): string {
  const raw = requested.trim().replace(/\\/g, '/');
  if (raw.length === 0) {
    throw new HomeRefusal('arguments', 'pass --folder <path> — the project folder this feature lives in', { folder: requested });
  }
  if (raw.startsWith('/') || isAbsolute(raw) || /^[A-Za-z]:\//.test(raw) || raw.split('/').includes('..')) {
    throw new HomeRefusal('outside-project', `'${requested}' is not a folder inside this project — give it relative to the project, without '..'`, {
      folder: requested,
    });
  }
  if (/[\r\n]/.test(raw)) {
    throw new HomeRefusal('outside-project', `'${requested}' is not a folder name`, { folder: requested });
  }
  const rel = normalizePath(raw);
  if (rel.length === 0) {
    throw new HomeRefusal('outside-project', 'the project itself is not a home — name one of its folders', { folder: requested });
  }
  const abs = join(repoRoot, rel);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    throw new HomeRefusal('missing-folder', `there is no folder '${rel}' in this project`, {
      folder: rel,
      nearest: nearestExistingFolder(repoRoot, rel),
    });
  }
  if (!stat.isDirectory()) {
    throw new HomeRefusal('not-a-folder', `'${rel}' is a file, not a folder`, { folder: rel, nearest: nearestExistingFolder(repoRoot, rel) });
  }
  try {
    if (!isInside(realpathSync(repoRoot), realpathSync(abs))) {
      throw new HomeRefusal('outside-project', `'${rel}' leads outside this project`, { folder: rel });
    }
  } catch (error) {
    if (error instanceof HomeRefusal) throw error;
    throw new HomeRefusal('missing-folder', `there is no folder '${rel}' in this project`, { folder: rel, nearest: null });
  }
  return rel;
}

function runHome(input: FeatureHomeVerbInput): FeatureHomeResult {
  const ref = typeof input.feature === 'string' ? input.feature.trim() : '';
  const hasFolder = typeof input.folder === 'string';
  const clear = input.clear === true;
  if (ref.length === 0) {
    throw new HomeRefusal('arguments', 'pass --feature <id|slug> — the feature or part whose home to set');
  }
  if (hasFolder === clear) {
    throw new HomeRefusal('arguments', 'pass exactly one of --folder <path> or --clear', { feature: ref });
  }
  const flowDir = join(input.repoRoot, 'flow');
  const resolved = resolveTarget(flowDir, ref);
  if (resolved === null) {
    throw new HomeRefusal('unknown-feature', `no feature or part named '${ref}' in this project`, { feature: ref });
  }
  const home = clear ? null : validateHomeFolder(input.repoRoot, input.folder ?? '');
  const target: HomeLineTarget =
    resolved.part === null ? { kind: 'feature' } : { kind: 'part', featureId: resolved.feature.id, partId: resolved.part.id };
  const { previous } = writeFeatureHome(flowDir, resolved.feature.slug, target, home);
  return { action: 'features-home', feature: resolved.feature.slug, part: resolved.part?.id ?? null, home, previous };
}

function describeChange(result: FeatureHomeResult): string {
  if (result.home !== null) return `home is ${result.home}`;
  if (result.previous === null) return 'no home was set';
  return `home cleared (was ${result.previous})`;
}

/** Run the verb: what it prints and its exit code. Never throws a refusal. */
export function runFeatureHomeVerb(input: FeatureHomeVerbInput): FeatureHomeVerbOutput {
  try {
    const result = runHome(input);
    if (input.json === true) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
    const subject = result.part === null ? result.feature : result.part;
    return { exitCode: 0, stdout: `features: ${subject} — ${describeChange(result)}\n` };
  } catch (error) {
    if (error instanceof HomeRefusal) {
      const payload = JSON.stringify({ action: 'features-home', refused: error.reason, ...error.payload });
      return { exitCode: 1, stdout: `${payload}\nfeatures refused: ${error.reason} — ${error.sentence}\n` };
    }
    throw error;
  }
}
