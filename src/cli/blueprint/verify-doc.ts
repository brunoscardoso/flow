/**
 * verify-doc promotion (doc-verification Phase 2, CLI half).
 *
 * The agent RUNNER lives app-side (learn-session pattern — the CLI cannot
 * spawn an LLM); this module is the deterministic aftermath of a recorded
 * per-claim verdict:
 *
 *  - `promoteDoc` regenerates `flow/brain/decisions/doc-<slug>.md` from the
 *    verdict's CORROBORATED claims — provenance, hash-stamped witnesses,
 *    verified-at. The file is derived-from-verdict (regenerate-in-full) and
 *    carries a managed banner; contradicted claims are NEVER promoted — they
 *    become anchored investigation observations instead (doc-rot radar,
 *    trust-tiers decision #5).
 *
 * Everything refuses loudly (`promote refused: <reason>` from the verb) and
 * writes nothing on failure.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorshipFrontmatter } from '../handlers/knowledge-authorship.js';
import { readFileTiers } from './file-tiers.js';
import { appendInvestigationNote } from './investigation-store.js';
import type { InvestigationEntry } from './types.js';

/** Managed-file banner: the promotion is derived — edits do not survive. */
const MANAGED_BANNER = '> managed by `blueprint verify-doc` — regenerated on every verification; edits will be overwritten.';

/** Deterministic brain filename for a doc's promoted claims. */
export function docSlug(docPath: string): string {
  return docPath
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface PromoteResult {
  ok: boolean;
  reason?: string;
  /** Brain file written (or removed when nothing is promotable). */
  brainFile?: string;
  promotedClaims?: number;
  contradictedObservations?: number;
}

/**
 * Regenerate the promoted brain file for one doc from its recorded verdict.
 * Requires a per-claim verdict (the runner's shape); corroborated claims
 * promote, contradicted ones append observations, none → the brain file is
 * removed (nothing verified = nothing promoted, never an empty shell).
 */
export function promoteDoc(repoRoot: string, docPath: string, now: Date = new Date()): PromoteResult {
  const flowDir = join(repoRoot, 'flow');
  const store = readFileTiers(flowDir);
  if (store === null) {
    return { ok: false, reason: 'no tier store — run `planflow-ai blueprint derive` first' };
  }
  const entry = store.entries.find((candidate) => candidate.path === docPath);
  if (entry === undefined) {
    return { ok: false, reason: `unknown doc: ${docPath} — not in the tier store` };
  }
  const verdict = entry.verdict;
  if (verdict === undefined) {
    return { ok: false, reason: `no verdict recorded for ${docPath} — verify it first` };
  }
  if (verdict.claims === undefined || verdict.claims.length === 0) {
    return { ok: false, reason: `verdict for ${docPath} has no per-claim breakdown — re-verify with the agent runner` };
  }

  const decisionsDir = join(flowDir, 'brain', 'decisions');
  mkdirSync(decisionsDir, { recursive: true });
  const brainFile = join(decisionsDir, `doc-${docSlug(docPath)}.md`);

  const corroborated = verdict.claims.filter((claim) => claim.outcome === 'corroborated');
  const contradicted = verdict.claims.filter((claim) => claim.outcome === 'contradicted');

  // Contradictions → anchored observations (append-only store, doc-rot radar).
  let observations = 0;
  for (const claim of contradicted) {
    const entryNote: InvestigationEntry = {
      ts: now.toISOString(),
      runId: null,
      anchors: [{ kind: 'file', ref: docPath }],
      text: `doc contradicted by code: "${claim.claim}"${claim.note !== undefined ? ` — ${claim.note}` : ''} (witnesses: ${claim.witnesses.join(', ') || 'none named'})`,
      provenance: 'verify-doc',
      status: 'contradicted',
      hashStamps: [],
    };
    try {
      appendInvestigationNote(flowDir, entryNote);
      observations += 1;
    } catch {
      // observation append is best-effort — promotion still proceeds
    }
  }

  if (corroborated.length === 0) {
    // Nothing verified true — remove any prior promotion (revocation-clean).
    if (existsSync(brainFile)) unlinkSync(brainFile);
    return { ok: true, brainFile, promotedClaims: 0, contradictedObservations: observations };
  }

  const stampByPath = new Map(verdict.verifiedAgainst.map((stamp) => [stamp.path, stamp.contentHash]));
  const lines: string[] = [
    // In a Workspace a decision says who decided it (FR-19); elsewhere nothing changes.
    ...authorshipFrontmatter(flowDir, 'decided_by'),
    `# Verified claims — ${docPath}`,
    '',
    MANAGED_BANNER,
    '',
    `- **source doc**: ${docPath}`,
    `- **verified**: ${verdict.ts} (${verdict.provenance ?? 'user'})`,
    `- **doc hash**: ${verdict.docHash.slice(0, 12)}`,
    '',
  ];
  for (const claim of corroborated) {
    lines.push(`## ${claim.claim}`);
    lines.push('');
    if (claim.note !== undefined && claim.note.length > 0) {
      lines.push(claim.note);
      lines.push('');
    }
    if (claim.witnesses.length > 0) {
      lines.push('Witnesses:');
      for (const witness of claim.witnesses) {
        const hash = stampByPath.get(witness);
        lines.push(`- \`${witness}\`${hash !== undefined ? ` (${hash.slice(0, 12)})` : ''}`);
      }
      lines.push('');
    }
  }
  writeFileSync(brainFile, `${lines.join('\n')}\n`, 'utf-8');
  return { ok: true, brainFile, promotedClaims: corroborated.length, contradictedObservations: observations };
}
