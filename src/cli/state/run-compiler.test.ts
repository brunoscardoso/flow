/**
 * Tests for the run-script compiler — pure compile core.
 *
 * Covers: byte-identical determinism, override application (phase model,
 * phase skip, task verify replacement), stale-override diagnostics (never
 * applied, never dropped), cycle refusal, parser defaults (sequential waves,
 * default complexity), and planHash sensitivity to content changes.
 */

import { setNoteStatus, setNoteVerdict } from './change-notes.js';
import { compileRunScript, serializeRunScript } from './run-compiler.js';
import type { RunOverrides } from './types.js';

/** A three-phase plan: complexity 3 / 7 / 5 → haiku / opus / sonnet. */
const PLAN_CONTENT = `# Plan: Test Feature

### Phase 1: Types
**Complexity**: 3/10
**Dependencies**: none

- [ ] Define types
  <verify>npx tsc --noEmit src/types.ts</verify>
- [ ] Export types

### Phase 2: Implementation
**Complexity**: 7/10
**Dependencies**: Phase 1

- [ ] Implement feature
  <verify>npm run test -- impl</verify>

### Phase 3: Tests
**Complexity**: 5/10
**Dependencies**: Phase 2

- [ ] Write tests
`;

const PLAN_NAME = 'test-feature';
const NO_OVERRIDES: RunOverrides = {};
/** Most tests opt routing ON to exercise tier derivation; the dedicated
 *  `model routing` describe covers the default-off path (#670). */
const ROUTED = { modelRouting: true };

describe('compileRunScript', () => {
  describe('determinism', () => {
    it('produces deep-equal scripts and byte-identical serializations for the same inputs', () => {
      const first = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);
      const second = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);

      expect(second).toEqual(first);
      expect(serializeRunScript(second)).toBe(serializeRunScript(first));
    });

    it('serializes with a trailing newline', () => {
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);
      expect(serializeRunScript(script).endsWith('\n')).toBe(true);
    });
  });

  describe('override application', () => {
    it('applies a phase model override and reflects it in phases[].model', () => {
      const overrides: RunOverrides = { phases: { '2': { model: 'haiku' } } };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides, ROUTED);

      const phase2 = script.phases.find((p) => p.number === 2)!;
      expect(phase2.model).toBe('haiku');
      // Non-overridden phases keep their routed models
      expect(script.phases.find((p) => p.number === 1)!.model).toBe('haiku');
      expect(script.phases.find((p) => p.number === 3)!.model).toBe('sonnet');
      expect(script.diagnostics).toEqual([]);
    });

    it('applies a phase skip override', () => {
      const overrides: RunOverrides = { phases: { '3': { skip: true } } };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides);

      expect(script.phases.find((p) => p.number === 3)!.skip).toBe(true);
      expect(script.phases.find((p) => p.number === 1)!.skip).toBe(false);
      expect(script.phases.find((p) => p.number === 2)!.skip).toBe(false);
    });

    it('applies a task verify replacement, leaving sibling tasks untouched', () => {
      const overrides: RunOverrides = { tasks: { '1.1': { verify: 'echo replaced' } } };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides);

      const phase1 = script.phases.find((p) => p.number === 1)!;
      expect(phase1.tasks[0].verify).toBe('echo replaced');
      // Second task had no verify tag and no override — stays null
      expect(phase1.tasks[1].verify).toBeNull();
      // Other phases keep their parsed verify commands
      const phase2 = script.phases.find((p) => p.number === 2)!;
      expect(phase2.tasks[0].verify).toBe('npm run test -- impl');
    });
  });

  describe('stale overrides', () => {
    it('diagnoses a nonexistent phase key with a precise message and does not apply it', () => {
      const overrides: RunOverrides = { phases: { '9': { model: 'opus' } } };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides, ROUTED);

      expect(script.diagnostics).toEqual([
        { severity: 'stale-override', message: 'override for phase 9 is stale: no such phase' },
      ]);
      // Not applied: every phase keeps its routed model
      expect(script.phases.map((p) => p.model)).toEqual(['haiku', 'opus', 'sonnet']);
      // Still carried on the artifact, never dropped
      expect(script.overrides).toEqual(overrides);
    });

    it('diagnoses a task key whose task does not exist', () => {
      const overrides: RunOverrides = { tasks: { '1.9': { verify: 'echo x' } } };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides);

      expect(script.diagnostics).toEqual([
        { severity: 'stale-override', message: 'override for task 1.9 is stale: no such task' },
      ]);
      const phase1 = script.phases.find((p) => p.number === 1)!;
      expect(phase1.tasks.map((t) => t.verify)).toEqual(['npx tsc --noEmit src/types.ts', null]);
      expect(script.overrides).toEqual(overrides);
    });

    it('diagnoses a task key whose phase does not exist', () => {
      const overrides: RunOverrides = { tasks: { '9.1': { verify: 'echo x' } } };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides);

      expect(script.diagnostics).toEqual([
        { severity: 'stale-override', message: 'override for task 9.1 is stale: no such phase' },
      ]);
    });

    it('diagnoses malformed phase and task keys', () => {
      const overrides: RunOverrides = {
        phases: { abc: { skip: true } },
        tasks: { 'bad-key': { verify: 'echo x' } },
      };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides);

      expect(script.diagnostics).toEqual([
        {
          severity: 'stale-override',
          message: 'override for phase "abc" is stale: malformed key (expected "<phase>")',
        },
        {
          severity: 'stale-override',
          message:
            'override for task "bad-key" is stale: malformed key (expected "<phase>.<task-index>")',
        },
      ]);
      expect(script.overrides).toEqual(overrides);
    });

    it('applies valid overrides while diagnosing stale ones in the same compile', () => {
      const overrides: RunOverrides = {
        phases: { '1': { model: 'opus' }, '9': { skip: true } },
      };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides);

      expect(script.phases.find((p) => p.number === 1)!.model).toBe('opus');
      expect(script.diagnostics).toEqual([
        { severity: 'stale-override', message: 'override for phase 9 is stale: no such phase' },
      ]);
      expect(script.overrides).toEqual(overrides);
    });
  });

  describe('cycle refusal', () => {
    it('throws a message starting "compile refused: dependency cycle" on a cyclic plan', () => {
      const cyclicPlan = `# Plan: Cyclic

### Phase 1: A
**Complexity**: 3/10
**Dependencies**: Phase 3

- [ ] Task a

### Phase 2: B
**Complexity**: 3/10
**Dependencies**: Phase 1

- [ ] Task b

### Phase 3: C
**Complexity**: 3/10
**Dependencies**: Phase 2

- [ ] Task c
`;

      expect(() => compileRunScript(cyclicPlan, 'cyclic', NO_OVERRIDES)).toThrow(
        /^compile refused: dependency cycle/,
      );
    });
  });

  describe('defaults', () => {
    it('falls back to sequential waves when Dependencies are omitted and complexity 5 when Complexity is omitted', () => {
      const bareplan = `# Plan: Bare

### Phase 1: First

- [ ] Task one

### Phase 2: Second

- [ ] Task two

### Phase 3: Third

- [ ] Task three
`;
      const script = compileRunScript(bareplan, 'bare', NO_OVERRIDES, ROUTED);

      expect(script.waves).toEqual([
        { wave_number: 1, phase_numbers: [1] },
        { wave_number: 2, phase_numbers: [2] },
        { wave_number: 3, phase_numbers: [3] },
      ]);
      expect(script.phases.map((p) => p.complexity)).toEqual([5, 5, 5]);
      // Default complexity 5 routes to the standard tier
      expect(script.phases.map((p) => p.model)).toEqual(['sonnet', 'sonnet', 'sonnet']);
    });
  });

  describe('model routing (#670)', () => {
    it('defaults routing OFF: empty routing table, every phase on the most capable model', () => {
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);

      expect(script.routing).toEqual([]);
      expect(script.phases.map((p) => p.model)).toEqual(['opus', 'opus', 'opus']);
    });

    it('treats an explicit modelRouting: false the same as the default', () => {
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES, {
        modelRouting: false,
      });

      expect(script.routing).toEqual([]);
      expect(script.phases.map((p) => p.model)).toEqual(['opus', 'opus', 'opus']);
    });

    it('routes by complexity only when modelRouting is true', () => {
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES, ROUTED);

      expect(script.routing.map((r) => r.model)).toEqual(['haiku', 'opus', 'sonnet']);
      expect(script.phases.map((p) => p.model)).toEqual(['haiku', 'opus', 'sonnet']);
    });

    it('applies a phase model override even with routing off', () => {
      const overrides: RunOverrides = { phases: { '2': { model: 'sonnet' } } };
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, overrides);

      expect(script.phases.map((p) => p.model)).toEqual(['opus', 'sonnet', 'opus']);
      expect(script.diagnostics).toEqual([]);
    });
  });

  describe('planHash', () => {
    it('changes when the plan content changes and stays stable otherwise', () => {
      const original = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);
      const same = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);
      const changed = compileRunScript(`${PLAN_CONTENT}\n<!-- edited -->\n`, PLAN_NAME, NO_OVERRIDES);

      expect(same.planHash).toBe(original.planHash);
      expect(changed.planHash).not.toBe(original.planHash);
      expect(original.planHash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('taskless phases (#1821)', () => {
    const PLAN_WITH_AN_EMPTY_PHASE = `# Plan: Half Written

### Phase 1: Has work
**Complexity**: 3/10
**Dependencies**: none

- [ ] Define types

### Phase 2: Prose only
**Complexity**: 5/10
**Dependencies**: Phase 1

We will figure this one out later.
`;

    it('diagnoses a phase that compiled with no tasks, naming it', () => {
      // The quietest failure this compiler had: the artifact is documented as
      // /execute-plan's orchestration source of truth, so tasks: [] means the
      // phase enters the pipeline with nothing to do and nothing to verify,
      // while the compile prints success. Eleven of this repo's 44 plans were
      // in that state and nothing said so.
      const script = compileRunScript(PLAN_WITH_AN_EMPTY_PHASE, 'half-written', NO_OVERRIDES);
      const taskless = script.diagnostics.filter((d) => d.message.includes('no tasks'));

      expect(taskless).toHaveLength(1);
      expect(taskless[0]?.severity).toBe('info');
      expect(taskless[0]?.message).toContain('phase 2 ("Prose only")');
      expect(taskless[0]?.message).toContain('nothing will run or be verified');
    });

    it('does not refuse the compile — an empty phase is legal, just loud', () => {
      const script = compileRunScript(PLAN_WITH_AN_EMPTY_PHASE, 'half-written', NO_OVERRIDES);
      expect(script.phases).toHaveLength(2);
      expect(script.phases[1]?.tasks).toEqual([]);
    });

    it('says nothing when every phase carries tasks', () => {
      const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);
      expect(script.diagnostics.filter((d) => d.message.includes('no tasks'))).toEqual([]);
    });

    it('compiles the three non-checkbox task shapes into real tasks and verifies', () => {
      const mixed = `# Plan: Shapes

### Phase 1: Bold bullets
**Complexity**: 5/10
**Dependencies**: none

- **Task 1.1** — bold and numbered
  <verify>npm test a</verify>
- Task 1.2: unbolded and numbered
  <verify>npm test b</verify>

### Phase 2: Numbered list
**Complexity**: 5/10
**Dependencies**: none

**Tasks**:
1. numbered, inline verify <verify>npm test c</verify>

**Files**: \`src/a.ts\`
`;
      const script = compileRunScript(mixed, 'shapes', NO_OVERRIDES);

      expect(script.phases[0]?.tasks).toEqual([
        { index: 1, name: 'bold and numbered', verify: 'npm test a' },
        { index: 2, name: 'unbolded and numbered', verify: 'npm test b' },
      ]);
      expect(script.phases[1]?.tasks).toEqual([
        { index: 1, name: 'numbered, inline verify', verify: 'npm test c' },
      ]);
      expect(script.diagnostics.filter((d) => d.message.includes('no tasks'))).toEqual([]);
    });
  });
});

describe('compileRunScript — change notes (plan change review)', () => {
  const NOTED_PLAN = `# Plan: Noted

### Phase 1: Wire
**Complexity**: 4/10

- [ ] Wire it

#### Change notes

- note: 1 · change · file:src/a.ts:run
    where: \`run(\`
    what: pass the flag
    why: it is needed
    status: accepted
- note: 2 · new · web/file:src/b.ts:helper
    signature: helper(): void
    purpose: shared rule
    status: rejected — inline it
- note: 5 · tweak · file:src/x.ts:y

### Phase 2: Tests
**Complexity**: 3/10

- [ ] Test it

#### Change notes

- note: 3 · file · file:src/c.test.ts
    what: a case
    why: coverage
`;

  it('each phase carries its notes (n, kind, target, status) and the script carries the counts', () => {
    const script = compileRunScript(NOTED_PLAN, 'noted', NO_OVERRIDES);
    expect(script.phases.map((phase) => phase.notes)).toEqual([
      [
        { n: 1, kind: 'change', target: 'file:src/a.ts:run', status: 'accepted' },
        { n: 2, kind: 'new', target: 'web/file:src/b.ts:helper', status: 'rejected' },
      ],
      [{ n: 3, kind: 'file', target: 'file:src/c.test.ts', status: 'proposed' }],
    ]);
    expect(script.notes).toEqual({ total: 3, accepted: 1, rejected: 1, unreviewed: 1 });
    // Note lines never become tasks.
    expect(script.phases.map((phase) => phase.tasks.map((task) => task.name))).toEqual([['Wire it'], ['Test it']]);
  });

  it('an unreadable note is said on the artifact, not silently left out', () => {
    const script = compileRunScript(NOTED_PLAN, 'noted', NO_OVERRIDES);
    expect(script.diagnostics).toContainEqual({
      severity: 'info',
      message: 'change note 5 at line 19 could not be read — "tweak" is not a note kind — it is change, new or file',
    });
  });

  it('serializes notes per phase and the counts, deterministically', () => {
    const script = compileRunScript(NOTED_PLAN, 'noted', NO_OVERRIDES);
    const json = JSON.parse(serializeRunScript(script)) as Record<string, unknown> & {
      phases: Array<Record<string, unknown>>;
    };
    expect(json.phases[0]?.notes).toEqual(script.phases[0]?.notes);
    expect(json.notes).toEqual({ total: 3, accepted: 1, rejected: 1, unreviewed: 1 });
    expect(serializeRunScript(compileRunScript(NOTED_PLAN, 'noted', NO_OVERRIDES))).toBe(serializeRunScript(script));
  });

  it('recording a status, a verdict or comments keeps the planHash — resume survives a review written after the run', () => {
    const hashOf = (content: string): string => compileRunScript(content, 'noted', NO_OVERRIDES).planHash;
    const original = hashOf(NOTED_PLAN);
    const accepted = setNoteStatus(NOTED_PLAN, 3, 'accepted');
    const rejected = setNoteStatus(NOTED_PLAN, 1, 'rejected', 'not now');
    const verdict = setNoteVerdict(NOTED_PLAN, 1, 'done', 'the flag is passed');
    const commented = NOTED_PLAN.replace('    why: coverage\n', '    why: coverage\n    comments:\n      - is this enough?\n');
    // The positive first: each one really changed the file.
    for (const edited of [accepted, rejected, verdict, commented]) expect(edited).not.toBe(NOTED_PLAN);
    expect(hashOf(accepted)).toBe(original);
    expect(hashOf(rejected)).toBe(original);
    expect(hashOf(verdict)).toBe(original);
    expect(hashOf(setNoteVerdict(accepted, 3, 'differs', 'one case short'))).toBe(original);
    expect(hashOf(commented)).toBe(original);
  });

  it('an edit to what a note says to build is a new planHash', () => {
    const hashOf = (content: string): string => compileRunScript(content, 'noted', NO_OVERRIDES).planHash;
    expect(hashOf(NOTED_PLAN.replace('what: pass the flag', 'what: pass both flags'))).not.toBe(hashOf(NOTED_PLAN));
    expect(hashOf(NOTED_PLAN.replace('why: coverage', 'why: the bug came back'))).not.toBe(hashOf(NOTED_PLAN));
    expect(hashOf(NOTED_PLAN.replace('where: `run(`', 'where: `run(flag`'))).not.toBe(hashOf(NOTED_PLAN));
  });

  it('a plan without notes compiles empty notes and zero counts', () => {
    const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);
    expect(script.phases.every((phase) => Array.isArray(phase.notes) && phase.notes.length === 0)).toBe(true);
    expect(script.notes).toEqual({ total: 0, accepted: 0, rejected: 0, unreviewed: 0 });
  });

  it('re-serializing an artifact compiled before notes existed invents no notes', () => {
    const script = compileRunScript(PLAN_CONTENT, PLAN_NAME, NO_OVERRIDES);
    const legacy = {
      ...script,
      phases: script.phases.map(({ notes: _notes, ...rest }) => rest),
      notes: undefined,
    };
    const json = JSON.parse(serializeRunScript(legacy)) as Record<string, unknown> & {
      phases: Array<Record<string, unknown>>;
    };
    expect('notes' in json).toBe(false);
    expect(json.phases.some((phase) => 'notes' in phase)).toBe(false);
  });
});
