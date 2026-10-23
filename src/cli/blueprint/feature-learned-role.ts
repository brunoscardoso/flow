/**
 * `blueprint features role --feature <ref> [--part <name>] --learned <role> [--json]`
 * — the ONE writer of the learn-owned `learnedRole:` key (plan
 * `feature-type-icons`, FR-3).
 *
 * A learn pass decides what kind of thing a feature (or one of its parts) is
 * and records it here. The value is checked against the vocabulary in code
 * (`feature-role.ts`), not by the prompt that asked for it (allowed-pattern
 * #14). The person's `role:` is never written by this verb or by anything else
 * a machine runs — a person's word outranks a learn pass on the board, and no
 * sweep may take it back.
 *
 * `--feature` takes any feature reference, or a part's address
 * (`feature:<f>/<part>`, the one `addressableParts` mints); `--part <name>`
 * names a part of the feature by its name instead.
 *
 * Refusals follow the family contract (allowed-pattern #21): a JSON payload
 * line on stdout carrying what the asker needs, then
 * `features refused: <reason> — <sentence>`, exit 1, nothing written. A role off
 * the list refuses with reason `role`.
 */
import { join } from 'node:path';

import { addressableParts } from './feature-graph.js';
import { FEATURE_ROLES, isFeatureRole } from './feature-role.js';
import { findFeatureByRef, readFeatures, readParts, slugifyFeatureName, writeLearnedRole, type FeatureNode } from './feature-store.js';

export interface FeatureRoleVerbInput {
  /** The project checkout (`flow/` beneath it). */
  repoRoot: string;
  /** `--feature <id|slug|address>` — a feature, or one of its parts. */
  feature?: string;
  /** `--part <name>` — one part of the feature, by name. */
  part?: string;
  /** `--learned <role>` — the role a learn pass decided. */
  learned?: string;
  json?: boolean;
}

export interface FeatureRoleVerbOutput {
  exitCode: number;
  /** Exactly what the command prints on stdout. */
  stdout: string;
}

/** What a successful write reports. */
export interface FeatureRoleResult {
  action: 'features-role';
  /** The owning feature's slug. */
  feature: string;
  /** The part's address, or null for the feature itself. */
  part: string | null;
  /** The learned role now written. */
  learnedRole: string;
  /** The learned role written before, or null. */
  previous: string | null;
}

class RoleRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly sentence: string,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(`${reason} — ${sentence}`);
    this.name = 'RoleRefusal';
  }
}

interface ResolvedTarget {
  feature: FeatureNode;
  part: { id: string; name: string } | null;
}

/** A feature by any reference, or one of its parts by its address. */
function resolveFeatureOrPart(flowDir: string, ref: string): ResolvedTarget | null {
  const features = readFeatures(flowDir);
  const feature = findFeatureByRef(features, ref);
  if (feature !== undefined) return { feature, part: null };
  const wanted = ref.includes(':') ? ref : `feature:${ref}`;
  for (const candidate of features) {
    if (!wanted.startsWith(`${candidate.id}/`)) continue;
    const match = addressableParts(candidate.id, readParts(flowDir, candidate.slug)).find((entry) => entry.id === wanted);
    if (match !== undefined) return { feature: candidate, part: { id: match.id, name: match.name } };
  }
  return null;
}

function runRole(input: FeatureRoleVerbInput): FeatureRoleResult {
  const ref = typeof input.feature === 'string' ? input.feature.trim() : '';
  const partName = typeof input.part === 'string' ? input.part.trim() : '';
  const learned = typeof input.learned === 'string' ? input.learned.trim().toLowerCase() : '';
  if (ref.length === 0) {
    throw new RoleRefusal('arguments', 'pass --feature <id|slug> — the feature or part whose role to record');
  }
  if (learned.length === 0) {
    throw new RoleRefusal('arguments', 'pass --learned <role> — the role the learn pass decided', { feature: ref, roles: FEATURE_ROLES });
  }
  if (!isFeatureRole(learned)) {
    throw new RoleRefusal('role', `'${input.learned ?? ''}' is not a feature role — use one of ${FEATURE_ROLES.join(', ')}`, {
      feature: ref,
      learned: input.learned ?? '',
      roles: FEATURE_ROLES,
    });
  }
  const flowDir = join(input.repoRoot, 'flow');
  const resolved = resolveFeatureOrPart(flowDir, ref);
  if (resolved === null) {
    throw new RoleRefusal('unknown-feature', `no feature or part named '${ref}' in this project`, { feature: ref });
  }
  let part = resolved.part;
  if (partName.length > 0) {
    if (part !== null) {
      throw new RoleRefusal('arguments', `'${ref}' already names a part — drop --part, or name its feature`, { feature: ref, part: partName });
    }
    const wanted = slugifyFeatureName(partName);
    const match = addressableParts(resolved.feature.id, readParts(flowDir, resolved.feature.slug)).find(
      (entry) => slugifyFeatureName(entry.name) === wanted,
    );
    if (wanted.length === 0 || match === undefined) {
      throw new RoleRefusal('unknown-part', `'${resolved.feature.slug}' has no part named '${partName}'`, {
        feature: resolved.feature.slug,
        part: partName,
      });
    }
    part = { id: match.id, name: match.name };
  }
  const { previous } = writeLearnedRole(flowDir, resolved.feature.slug, learned, part?.name);
  return { action: 'features-role', feature: resolved.feature.slug, part: part?.id ?? null, learnedRole: learned, previous };
}

/** Run the verb: what it prints and its exit code. Never throws a refusal. */
export function runFeatureRoleVerb(input: FeatureRoleVerbInput): FeatureRoleVerbOutput {
  try {
    const result = runRole(input);
    if (input.json === true) return { exitCode: 0, stdout: `${JSON.stringify(result)}\n` };
    const subject = result.part === null ? result.feature : result.part;
    const was = result.previous === null || result.previous === result.learnedRole ? '' : ` (was ${result.previous})`;
    return { exitCode: 0, stdout: `features: ${subject} — learned role is ${result.learnedRole}${was}\n` };
  } catch (error) {
    if (error instanceof RoleRefusal) {
      const payload = JSON.stringify({ action: 'features-role', refused: error.reason, ...error.payload });
      return { exitCode: 1, stdout: `${payload}\nfeatures refused: ${error.reason} — ${error.sentence}\n` };
    }
    throw error;
  }
}
