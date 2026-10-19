/**
 * An enforced run RECORDS the three prose-only quality stops instead of pausing
 * on them (#1915 — closing the mid-execute seam).
 *
 * The chain enforces ORDER and the PUBLISH seam in code, but three quality stops
 * — a wave file conflict, a wave contract conflict, and a failing lint gate —
 * live in `/execute-plan` SKILL prose (`src/cli/state/quality-stops.ts` says so).
 * Under a chain the model must push them through and record the fact via the one
 * writer (`flow pushed-through`), never stop to ask — otherwise the thread goes
 * `needs-decision` and the chain holds, which is the "keep executing the entire
 * flow" promise broken one level down inside the execute stage.
 *
 * This is the same guard shape as `autopilot-is-not-an-instruction.test.ts`:
 * these files are always-loaded agent instructions, so a sentence in them is as
 * executable as code, and nothing else in the suite reads them. It cannot prove
 * a model obeys a document; it proves the document TELLS the model to record the
 * stop, and does not smuggle a prose sequencing rule back in while doing so.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root, resolved from this file's location (src/cli/ → ../../). */
const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

/** The three stops that live in `/execute-plan` prose. Withheld-repair is observable. */
const PROSE_ONLY_STOPS = ['wave-file-conflict', 'wave-contract-conflict', 'lint-gate'] as const;

/** The two surfaces the coordinator actually reads. */
const SKILL = '.claude/resources/skills/execute-plan-skill.md';
const COMMAND = '.claude/commands/execute-plan.md';

/**
 * The sequencing phrases that only get written by an author who believes a
 * COMMAND decides whether the flow continues — the exact set
 * `autopilot-is-not-an-instruction.test.ts` bans. Recording a push-through must
 * not re-introduce one.
 */
const SECOND_SPECIFICATION = [
  /AUTOPILOT MODE CHECK/,
  /auto-proceed/i,
  /unless autopilot/i,
  /commands auto-chain/i,
  /if autopilot (?:mode )?is on/i,
] as const;

describe('the execute-plan surfaces tell an enforced run to record each prose-only stop', () => {
  it('the skill is there to read, and names the one writer — an empty sweep is not a pass', () => {
    const skill = readRepoFile(SKILL);
    // The positive, first (allowed-pattern #28): the canonical instruction exists.
    expect(skill).toContain('flow pushed-through');
    expect(skill).toContain('Enforced-run quality stops');
  });

  it.each(PROSE_ONLY_STOPS)('the skill instructs recording %s', (stop) => {
    const skill = readRepoFile(SKILL);
    expect(skill).toContain(stop);
    // The stop name and the writer both appear — the instruction is to record it.
    expect(skill).toContain('flow pushed-through');
  });

  it('the command mirrors the rule and scopes it to an enforced run', () => {
    const command = readRepoFile(COMMAND);
    expect(command).toContain('flow pushed-through');
    expect(command).toMatch(/enforced run/i);
  });

  it.each([SKILL, COMMAND])('%s smuggles in no autopilot-conditional sequencing rule', (surface) => {
    const text = readRepoFile(surface);
    const offenders = SECOND_SPECIFICATION.filter((pattern) => pattern.test(text));
    expect(offenders.map(String)).toEqual([]);
  });

  it('the skill scopes the push-through to an ENFORCED run, never to a config key', () => {
    const skill = readRepoFile(SKILL);
    // Paragraphs, not lines: the scope and the stop it scopes are one thought.
    const paragraphs = skill
      .split(/\n\s*\n/)
      .filter((block) => block.includes('pushed through') || block.includes('quality stops'));
    expect(paragraphs.length).toBeGreaterThan(0);
    // At least one paragraph ties the push-through to the word "enforced".
    expect(paragraphs.some((block) => /enforced/i.test(block))).toBe(true);
  });
});
