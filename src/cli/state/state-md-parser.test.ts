/**
 * Tests for STATE.md parser
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseStateMd, parseStateMdContent } from './state-md-parser.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'plan-flow-state-md-test-'));
}

const FULL_STATE_MD = `# Session State

**Updated**: 2026-03-18T14:30:00.000Z

## Execution State
- **Active Skill**: execute-plan
- **Active Plan**: flow/plans/plan_user_auth_v1.md
- **Current Phase**: 3 — API Integration
- **Current Task**: Create API route handler
- **Completed Phases**:
  - Phase 1: Types and Schemas — done
  - Phase 2: Backend Setup — done with warnings

## Decisions
- Chose JWT over sessions (reason: discovery DR-4 specified stateless auth)
- Used Zod for validation (reason: consistent with existing codebase pattern)

## Blockers
- Missing @auth/core dependency (status: resolved, tried: installed via npm)
- CI pipeline timeout (status: open, tried: increased timeout to 10m)

## Files Modified
- src/types/auth.ts
- src/api/routes.ts
- src/utils/helpers.ts

## Next Action
Continue with Phase 3, Task 2: Add rate limiting to API routes
`;

describe('parseStateMd', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return null when STATE.md does not exist', () => {
    const result = parseStateMd(tempDir);
    expect(result).toBeNull();
  });

  it('should parse a valid STATE.md file', () => {
    writeFileSync(join(tempDir, 'STATE.md'), FULL_STATE_MD);
    const result = parseStateMd(tempDir);
    expect(result).not.toBeNull();
    expect(result!.active_skill).toBe('execute-plan');
  });
});

describe('parseStateMdContent', () => {
  it('should parse all sections from a full STATE.md', () => {
    const result = parseStateMdContent(FULL_STATE_MD);

    expect(result.updated_at).toBe('2026-03-18T14:30:00.000Z');
    expect(result.active_skill).toBe('execute-plan');
    expect(result.active_plan).toBe('flow/plans/plan_user_auth_v1.md');
    expect(result.current_phase).toEqual({ number: 3, name: 'API Integration' });
    expect(result.current_task).toBe('Create API route handler');
    expect(result.next_action).toBe('Continue with Phase 3, Task 2: Add rate limiting to API routes');
  });

  it('should parse completed phases', () => {
    const result = parseStateMdContent(FULL_STATE_MD);

    expect(result.completed_phases).toHaveLength(2);
    expect(result.completed_phases[0]).toEqual({
      number: 1,
      name: 'Types and Schemas',
      outcome: 'done',
    });
    expect(result.completed_phases[1]).toEqual({
      number: 2,
      name: 'Backend Setup',
      outcome: 'done with warnings',
    });
  });

  it('should parse decisions with reason', () => {
    const result = parseStateMdContent(FULL_STATE_MD);

    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0].decision).toBe('Chose JWT over sessions');
    expect(result.decisions[0].reason).toBe('discovery DR-4 specified stateless auth');
    expect(result.decisions[1].decision).toBe('Used Zod for validation');
    expect(result.decisions[1].reason).toBe('consistent with existing codebase pattern');
  });

  it('should parse blockers with status and tried', () => {
    const result = parseStateMdContent(FULL_STATE_MD);

    expect(result.blockers).toHaveLength(2);
    expect(result.blockers[0]).toEqual({
      issue: 'Missing @auth/core dependency',
      status: 'resolved',
      tried: 'installed via npm',
    });
    expect(result.blockers[1]).toEqual({
      issue: 'CI pipeline timeout',
      status: 'open',
      tried: 'increased timeout to 10m',
    });
  });

  it('should parse files modified', () => {
    const result = parseStateMdContent(FULL_STATE_MD);

    expect(result.files_modified).toEqual([
      'src/types/auth.ts',
      'src/api/routes.ts',
      'src/utils/helpers.ts',
    ]);
  });

  it('should handle empty STATE.md content', () => {
    const result = parseStateMdContent('');

    expect(result.active_skill).toBeNull();
    expect(result.active_plan).toBeNull();
    expect(result.current_phase).toBeNull();
    expect(result.current_task).toBeNull();
    expect(result.completed_phases).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.files_modified).toEqual([]);
    expect(result.next_action).toBeNull();
    expect(result.updated_at).toBeNull();
  });

  it('should handle STATE.md with only header and timestamp', () => {
    const content = `# Session State

**Updated**: 2026-03-18T10:00:00.000Z

## Execution State
- **Active Skill**: discovery-plan
`;
    const result = parseStateMdContent(content);

    expect(result.updated_at).toBe('2026-03-18T10:00:00.000Z');
    expect(result.active_skill).toBe('discovery-plan');
    expect(result.active_plan).toBeNull();
    expect(result.completed_phases).toEqual([]);
    expect(result.decisions).toEqual([]);
  });

  it('should handle decisions without reason format', () => {
    const content = `# Session State

## Decisions
- Simple decision without reason format
`;
    const result = parseStateMdContent(content);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].decision).toBe('Simple decision without reason format');
    expect(result.decisions[0].reason).toBe('');
  });

  // #1590: every real STATE.md bullet wraps. A per-line parser matched only the
  // first physical line, so the decision was truncated mid-parenthetical and the
  // reason — the substantive half — appeared in no field at all.
  it('should parse a wrapped decision bullet as one bullet, keeping its reason', () => {
    const content = `# Session State

## Decisions
- Rename was identifier-targeted, not a substring pass (reason: \`heartbeat\`
  contains \`beat\` 238 times; a blind replace produces \`hearrun\`).
`;
    const result = parseStateMdContent(content);

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].decision).toBe(
      'Rename was identifier-targeted, not a substring pass',
    );
    expect(result.decisions[0].reason).toBe(
      '`heartbeat` contains `beat` 238 times; a blind replace produces `hearrun`',
    );
  });

  it('should keep prose that follows the reason, and a reason containing parentheses', () => {
    const content = `# Session State

## Decisions
- Push carve-out assumed UNCHANGED (reason: discovery never affirmed it (see
  DR-4); the conservative reading holds). **Still needs confirmation.**
- **Phase 3 shrank** (7 → 5). Reading the queue code first showed the label IS
  already written on claim.
`;
    const result = parseStateMdContent(content);

    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0].decision).toBe(
      'Push carve-out assumed UNCHANGED **Still needs confirmation.**',
    );
    expect(result.decisions[0].reason).toBe(
      'discovery never affirmed it (see DR-4); the conservative reading holds',
    );
    // No reason marker at all: the whole (wrapped) bullet is the decision.
    expect(result.decisions[1].decision).toBe(
      '**Phase 3 shrank** (7 → 5). Reading the queue code first showed the label IS already written on claim.',
    );
    expect(result.decisions[1].reason).toBe('');
  });

  it('should keep a wrapped blocker whole and leave the Completed Phases sub-list intact', () => {
    const content = `# Session State

## Execution State
- **Active Skill**: execute-plan
- **Completed Phases**:
  - Phase 1: Types and Schemas — done
  - Phase 2: Backend Setup — done with warnings

## Blockers
- Migrating the 17 open items. Deliberately NOT run: it mutates live GitHub
  issues in a shared repo.
`;
    const result = parseStateMdContent(content);

    expect(result.completed_phases).toEqual([
      { number: 1, name: 'Types and Schemas', outcome: 'done' },
      { number: 2, name: 'Backend Setup', outcome: 'done with warnings' },
    ]);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].issue).toBe(
      'Migrating the 17 open items. Deliberately NOT run: it mutates live GitHub issues in a shared repo.',
    );
  });

  it('should handle blockers without status/tried format', () => {
    const content = `# Session State

## Blockers
- Some issue without structured format
`;
    const result = parseStateMdContent(content);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].issue).toBe('Some issue without structured format');
    expect(result.blockers[0].status).toBe('unknown');
    expect(result.blockers[0].tried).toBe('');
  });

  it('should handle missing sections gracefully', () => {
    const content = `# Session State

**Updated**: 2026-03-18T10:00:00.000Z

## Execution State
- **Active Skill**: review-code

## Next Action
Review the auth module changes
`;
    const result = parseStateMdContent(content);

    expect(result.active_skill).toBe('review-code');
    expect(result.decisions).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(result.files_modified).toEqual([]);
    expect(result.next_action).toBe('Review the auth module changes');
  });

  it('should handle STATE.md with no completed phases', () => {
    const content = `# Session State

## Execution State
- **Active Skill**: execute-plan
- **Active Plan**: flow/plans/plan_feature_v1.md
- **Current Phase**: 1 — Setup Types
- **Current Task**: Create type definitions
- **Completed Phases**:

## Next Action
Implement type definitions in src/types/
`;
    const result = parseStateMdContent(content);

    expect(result.active_skill).toBe('execute-plan');
    expect(result.current_phase).toEqual({ number: 1, name: 'Setup Types' });
    expect(result.completed_phases).toEqual([]);
  });
});

// ── the writer/reader binding (#1599, Phase 4) ────────────
//
// STATE.md's writer is a language model (the skills in `.claude/commands/`)
// and its reader is a strict regex (`state-md-parser.ts`). When the two
// diverged, nothing failed loudly: the parser's fail-soft returned nulls and
// every consumer downstream reported "nothing in flight". This suite is the
// one code path that binds them (allowed-pattern #14) — every STATE.md
// example shipped in `.claude/**` is fed to the real reader, so an example
// that drifts from the grammar breaks the build instead of a pipeline.

const __filename = fileURLToPath(import.meta.url);
/** Repo root, resolved from this file's location (src/cli/state/ → ../../../). */
const REPO_ROOT = resolve(dirname(__filename), '..', '..', '..');

/** The canonical grammar — the doc every writer skill points at. */
const FORMAT_DOC = '.claude/resources/core/state-md.md';
const COMMANDS_DIR = '.claude/commands';

/** How a command doc says it writes the file — the writer set, derived not listed. */
const WRITER_MARKER = 'Create `flow/STATE.md`';
/** The reference every writer must carry back to the grammar. */
const FORMAT_DOC_REFERENCE = 'core/state-md.md';

/** A fenced block is a STATE.md example when it names both of these. */
const EXAMPLE_MARKERS = ['Active Skill', 'Execution State'] as const;

interface ShippedExample {
  source: string;
  content: string;
}

/** Every fenced code block in a markdown document, fence markers stripped. */
function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;

  for (const line of markdown.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current.join('\n'));
        current = null;
      }
      continue;
    }
    current?.push(line);
  }
  return blocks;
}

/**
 * Every STATE.md example shipped in `.claude/**`.
 *
 * Detection is deliberately LOOSE — a block naming both `Active Skill` and
 * `Execution State` is an example — while the assertion on it is strict. A
 * drifted example (`* **Active Skill**`, a hyphen where the em dash belongs)
 * is still detected, and then fails, which is the whole point: a detector
 * keyed on the exact grammar would skip precisely the blocks that broke it.
 */
function shippedExamples(): ShippedExample[] {
  const docs = [
    FORMAT_DOC,
    ...readdirSync(join(REPO_ROOT, COMMANDS_DIR))
      .filter((name) => name.endsWith('.md'))
      .map((name) => `${COMMANDS_DIR}/${name}`),
  ];

  const examples: ShippedExample[] = [];
  for (const relPath of docs) {
    const absPath = join(REPO_ROOT, relPath);
    if (!existsSync(absPath)) continue;
    for (const block of fencedBlocks(readFileSync(absPath, 'utf-8'))) {
      if (EXAMPLE_MARKERS.every((marker) => block.includes(marker))) {
        examples.push({ source: relPath, content: block });
      }
    }
  }
  return examples;
}

/** Read an example through the REAL reader — file on disk, `parseStateMd`. */
function parseExample(content: string): ReturnType<typeof parseStateMd> {
  const dir = createTempDir();
  try {
    writeFileSync(join(dir, 'STATE.md'), content);
    return parseStateMd(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('shipped STATE.md examples', () => {
  const examples = shippedExamples();

  it('the canonical format doc exists and carries a full example', () => {
    expect(existsSync(join(REPO_ROOT, FORMAT_DOC))).toBe(true);
    // Never let the guard go vacuous: if no example is found, everything below
    // passes trivially.
    const canonical = examples.filter((example) => example.source === FORMAT_DOC);
    expect(canonical.length).toBeGreaterThan(0);
  });

  it('every shipped example populates active_skill and active_plan', () => {
    const failures = examples
      .map((example) => ({ example, state: parseExample(example.content) }))
      .filter(
        ({ state }) =>
          state === null ||
          (state.active_skill ?? '').trim().length === 0 ||
          (state.active_plan ?? '').trim().length === 0,
      )
      .map(({ example, state }) => ({
        source: example.source,
        active_skill: state?.active_skill ?? null,
        active_plan: state?.active_plan ?? null,
      }));

    // A non-empty list here means a doc drifted from the grammar in
    // `.claude/resources/core/state-md.md` — fix the example, not this test.
    expect(failures).toEqual([]);
  });

  it('the canonical example populates every field the parser exposes', () => {
    const canonical = examples.find((example) => example.source === FORMAT_DOC);
    const state = parseExample(canonical!.content);

    expect(state).not.toBeNull();
    expect(state!.active_skill).toBe('execute-plan');
    expect(state!.active_plan).toBe('flow/plans/plan_user_auth_v1.md');
    expect(state!.current_phase).toEqual({ number: 3, name: 'API Integration' });
    expect(state!.current_task).toBe('Create the API route handler');
    expect(state!.completed_phases).toHaveLength(2);
    expect(state!.decisions).toHaveLength(2);
    expect(state!.blockers).toHaveLength(1);
    expect(state!.files_modified).toHaveLength(2);
    expect(state!.next_action).not.toBeNull();
    expect(state!.updated_at).not.toBeNull();
  });

  // Proof the guard has teeth: the two drifts that actually happen — an
  // asterisk bullet and a hyphen where the em dash belongs — must be caught
  // by the very assertions above.
  it('fails on an example that drifts from the grammar', () => {
    const canonical = examples.find((example) => example.source === FORMAT_DOC)!.content;

    const asteriskBullets = parseExample(canonical.replace(/^- \*\*/gm, '* **'));
    expect(asteriskBullets!.active_skill).toBeNull();
    expect(asteriskBullets!.active_plan).toBeNull();

    const hyphenPhase = parseExample(canonical.replace('3 — API Integration', '3 - API Integration'));
    expect(hyphenPhase!.current_phase).toBeNull();
  });

  it('every command that writes STATE.md references the canonical format doc', () => {
    const missing = readdirSync(join(REPO_ROOT, COMMANDS_DIR))
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name, body: readFileSync(join(REPO_ROOT, COMMANDS_DIR, name), 'utf-8') }))
      .filter(({ body }) => body.includes(WRITER_MARKER) && !body.includes(FORMAT_DOC_REFERENCE))
      .map(({ name }) => name);

    expect(missing).toEqual([]);
  });
});
