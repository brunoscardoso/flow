/**
 * Injection-surface presence lock (trust-tiers Phase 2).
 *
 * ONE canonical Trust Tiers contract lives at
 * `.claude/resources/core/trust-tiers.md`; every spawned-agent surface must
 * REFERENCE it (never copy it — allowed-pattern #14). This test greps the
 * real repo files so contract drift — a surface losing its reference during
 * an unrelated edit — fails CI instead of silently de-arming an agent class.
 *
 * Surfaces (from plan_trust-tiers_v1.md, Phase 2):
 *  - phase-isolation.md          (phase sub-agent context template)
 *  - review-multi-agent.md       (all four review sub-agent prompt templates)
 *  - discovery-skill.md          (inline discovery sub-agent prompts)
 *  - templates/shared/CLAUDE.md.template (provisioned projects)
 *  - CLAUDE.md                   (this repo's own summary)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root, resolved from this file's location (src/cli/ → ../../). */
const REPO_ROOT = resolve(__dirname, '..', '..');

const CANONICAL_CONTRACT = '.claude/resources/core/trust-tiers.md';

/** Every surface that must carry a `trust-tiers` path reference. */
const INJECTION_SURFACES = [
  '.claude/resources/core/phase-isolation.md',
  '.claude/resources/core/review-multi-agent.md',
  '.claude/resources/skills/discovery-skill.md',
  'templates/shared/CLAUDE.md.template',
  'CLAUDE.md',
] as const;

/** The four review sub-agent prompt templates each restate the contract line. */
const REVIEW_SURFACE = '.claude/resources/core/review-multi-agent.md';
const REVIEW_CONTRACT_PHRASE = 'Trust Tiers contract';
const REVIEW_SUB_AGENT_COUNT = 4;

function readRepoFile(relPath: string): string {
  const absPath = join(REPO_ROOT, relPath);
  expect({ relPath, exists: existsSync(absPath) }).toEqual({ relPath, exists: true });
  return readFileSync(absPath, 'utf-8');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('trust-tiers contract surfaces', () => {
  it('the canonical contract file exists and defines the tier block', () => {
    const contract = readRepoFile(CANONICAL_CONTRACT);
    expect(contract).toContain('Trust Tiers');
  });

  it.each(INJECTION_SURFACES)('%s references the trust-tiers contract', (surface) => {
    const content = readRepoFile(surface);
    expect(content).toContain('trust-tiers');
  });

  it(`all ${REVIEW_SUB_AGENT_COUNT} review sub-agent prompts restate the Trust Tiers contract line`, () => {
    const content = readRepoFile(REVIEW_SURFACE);
    expect(countOccurrences(content, REVIEW_CONTRACT_PHRASE)).toBeGreaterThanOrEqual(
      REVIEW_SUB_AGENT_COUNT,
    );
  });
});
