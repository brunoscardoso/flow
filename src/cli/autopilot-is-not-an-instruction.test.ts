/**
 * Autopilot is a runtime now — and the prose must not quietly become a second
 * one (#1915, Phase 6 / Task 6.4).
 *
 * For most of this feature's life the chain WAS the prose: an
 * `AUTOPILOT MODE CHECK` block pasted into four command files, asking the agent
 * to please run the next thing. Phase 5 took those blocks out because the code
 * now issues the stages. The risk that creates is specific and cheap to guard:
 * somebody adds "if autopilot is ON, auto-proceed to /create-plan" back into one
 * command file, and from then on a chained run has TWO things sequencing it —
 * the harness and a sentence — which is exactly the disagreement the feature was
 * built to end.
 *
 * WHY A TEST OVER SHIPPED MARKDOWN AT ALL. These files are always-loaded agent
 * instructions in every provisioned project, so a sentence in them is as
 * executable as a function — and nothing else in the suite reads them. This is
 * the same guard `config-default-drift.test.ts` puts on stated defaults, applied
 * to stated behaviour.
 *
 * WHAT IT DOES NOT CLAIM. It cannot prove a model obeys a document; it proves
 * the document does not carve out the off-path. The behaviour with autopilot off
 * is asserted in code by `flow-stage.test.ts` (no `--chain` refuses nothing),
 * `flow-risk.test.ts` (the same) and
 * `app/src/main/drive/board-loop-chaining.test.ts` (an ordinary thread in an
 * autopilot-off project is never chained and nothing is sent).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file's location (src/cli/ → ../../). */
const REPO_ROOT = resolve(__dirname, '..', '..');

const COMMANDS_DIR = join(REPO_ROOT, '.claude', 'commands');

function readRepoFile(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

/** Every shipped slash command, so a NEW one is checked without being listed. */
const ALL_COMMANDS: string[] = readdirSync(COMMANDS_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort();

/** The four rungs of the ladder, as command files. */
const STAGE_COMMANDS = [
  'discovery-plan.md',
  'create-plan.md',
  'execute-plan.md',
  'review-code.md',
] as const;

/**
 * Sentences that only get written by an author who believes a COMMAND decides
 * whether the flow continues.
 *
 * Deliberately narrow: these docs legitimately describe what autopilot does and
 * legitimately say "BEHAVIOR WHEN AUTOPILOT IS ON". What must never come back is
 * a rule whose subject is the command and whose condition is the config key.
 */
const SECOND_SPECIFICATION = [
  /AUTOPILOT MODE CHECK/,
  /auto-proceed/i,
  /unless autopilot/i,
  /commands auto-chain/i,
  /if autopilot (?:mode )?is on/i,
] as const;

describe('no command file sequences the flow itself', () => {
  it('there are commands to check — an empty sweep must not read as a pass', () => {
    expect(ALL_COMMANDS.length).toBeGreaterThan(5);
    for (const stage of STAGE_COMMANDS) expect(ALL_COMMANDS).toContain(stage);
  });

  it.each(ALL_COMMANDS)('%s carries no autopilot-conditional continue rule', (name) => {
    const text = readRepoFile(join('.claude', 'commands', name));
    const offenders = SECOND_SPECIFICATION.filter((pattern) => pattern.test(text));
    expect(offenders.map(String)).toEqual([]);
  });
});

describe('each rung of the ladder says who issues the next one', () => {
  it.each(STAGE_COMMANDS)('%s hands the sequencing to the harness', (name) => {
    const text = readRepoFile(join('.claude', 'commands', name));
    // The note replaced the block: it describes what is done AROUND the command
    // rather than asking the command to do it.
    expect(text).toContain('the harness issues the next stage');
    // …and it is explicit that nothing changes when no chain is driving, which
    // is the whole of "off is unchanged" as a document can state it.
    expect(text).toContain('Outside a chain the standard rules below apply');
    // The stop rule itself survives, unqualified.
    expect(text).toMatch(/STOP/);
  });
});

describe('the four quality stops are pushed through by an ENFORCED run only', () => {
  // With autopilot off there is no enforced run, so nothing may tell an agent
  // to go past a wave conflict, a withheld repair or a failing lint gate. Both
  // documents that describe the push-through must say which runs it applies to.
  it.each([
    '.claude/resources/core/autopilot-mode.md',
    '.claude/resources/skills/execute-plan-skill.md',
  ])('%s scopes the push-through to an enforced run', (surface) => {
    const text = readRepoFile(surface);
    // Paragraphs, not lines: the scope and the stop it scopes are one thought,
    // and a line-by-line read splits the sentence that carries it.
    const paragraphs = text
      .split(/\n\s*\n/)
      .filter((block) => block.includes('pushed_through') || block.includes('quality stops'));
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const block of paragraphs) expect(block).toMatch(/enforced/i);
  });
});

describe('the No Auto-Chaining rule has no autopilot exception left', () => {
  it.each(['CLAUDE.md', 'templates/shared/CLAUDE.md.template'])('%s', (surface) => {
    const text = readRepoFile(surface);
    expect(text).toContain('**No Auto-Chaining**');
    expect(text).toContain('not even under autopilot');
    // The exception that used to follow it, verbatim.
    expect(text).not.toMatch(/commands auto-chain per/);
  });
});

describe('the README promises the pauses the runtime actually honours', () => {
  const readme = readRepoFile('README.md');

  it('no longer promises checkpoints nothing holds', () => {
    // Discovery Q&A and plan approval were listed as mandatory; neither is a
    // pause the chain honours, so promising them is telling a user their work
    // will wait for them when it will not.
    expect(readme).not.toMatch(/Mandatory checkpoints/i);
  });

  it('names the three that are honoured', () => {
    expect(readme).toContain('Three pauses are honoured');
    for (const pause of ['risk before publishing', 'guard classifier', 'unbound branch']) {
      expect(readme.toLowerCase()).toContain(pause.toLowerCase());
    }
  });
});
