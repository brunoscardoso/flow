/**
 * Injection-surface presence lock (brain-first-retrieval Phase 3).
 *
 * ONE canonical Brain-First contract lives at
 * `.claude/resources/core/brain-first.md`; every spawned-agent surface must
 * REFERENCE it (never copy it — allowed-pattern #14). This test greps the
 * real repo files so contract drift — a surface losing its reference during
 * an unrelated edit — fails CI instead of silently de-routing an agent class
 * back to grep-first spelunking.
 *
 * Surfaces (from plan_brain-first-retrieval_v1.md, Phase 3):
 *  - phase-isolation.md          (phase sub-agent context template)
 *  - review-multi-agent.md       (all four review sub-agent prompt templates)
 *  - discovery-skill.md          (inline discovery sub-agent prompts)
 *  - progressive-learning.md     (learn-session prompt documentation)
 *  - templates/shared/CLAUDE.md.template (provisioned projects)
 *
 * App-side compact-variant surfaces (agent-manager seed, buildLearnPrompt)
 * are locked by the app suite, not here.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Repo root, resolved from this file's location (src/cli/ → ../../). */
const REPO_ROOT = resolve(__dirname, '..', '..');

const CANONICAL_CONTRACT = '.claude/resources/core/brain-first.md';

/** Every surface that must carry a `brain-first` path reference. */
const INJECTION_SURFACES = [
  '.claude/resources/core/phase-isolation.md',
  '.claude/resources/core/review-multi-agent.md',
  '.claude/resources/skills/discovery-skill.md',
  '.claude/resources/core/progressive-learning.md',
  'templates/shared/CLAUDE.md.template',
] as const;

/** The four review sub-agent prompt templates each restate the contract line. */
const REVIEW_SURFACE = '.claude/resources/core/review-multi-agent.md';
const REVIEW_CONTRACT_PHRASE = 'Brain-First contract';
const REVIEW_SUB_AGENT_COUNT = 4;

function readRepoFile(relPath: string): string {
  const absPath = join(REPO_ROOT, relPath);
  expect({ relPath, exists: existsSync(absPath) }).toEqual({ relPath, exists: true });
  return readFileSync(absPath, 'utf-8');
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('brain-first contract surfaces', () => {
  it('the canonical contract file exists, names the verb, and defines the rule', () => {
    const contract = readRepoFile(CANONICAL_CONTRACT);
    expect(contract).toContain('brain search');
    expect(contract).toContain('Search the brain FIRST');
    expect(contract).toContain('--full');
  });

  it.each(INJECTION_SURFACES)('%s references the brain-first contract', (surface) => {
    const content = readRepoFile(surface);
    expect(content).toContain('brain-first');
  });

  it(`all ${REVIEW_SUB_AGENT_COUNT} review sub-agent prompts restate the Brain-First contract line`, () => {
    const content = readRepoFile(REVIEW_SURFACE);
    expect(countOccurrences(content, REVIEW_CONTRACT_PHRASE)).toBeGreaterThanOrEqual(
      REVIEW_SUB_AGENT_COUNT,
    );
  });
});
