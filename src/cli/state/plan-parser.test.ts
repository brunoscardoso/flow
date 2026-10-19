/**
 * Tests for plan markdown parser
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_COMPLEXITY,
  PHASE_HEADER_SHAPE,
  parsePlan,
  parsePlanContent,
  parsePlanDetailed,
  whyNoPhases,
} from './plan-parser.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'plan-flow-plan-parser-test-'));
}

describe('parsePlanContent', () => {
  it('should parse a standard plan with phases, complexity, and dependencies', () => {
    const content = `# Plan: Feature X

### Phase 1: Setup
**Complexity**: 3/10
**Dependencies**: None

- [ ] Create project structure
- [ ] Add configuration files

### Phase 2: Implementation
**Complexity**: 7/10
**Dependencies**: Phase 1

- [ ] Implement core logic
  <verify>npx tsc --noEmit src/core.ts</verify>
- [ ] Add error handling

### Phase 3: Tests
**Complexity**: 4/10
**Dependencies**: Phase 1, Phase 2

- [ ] Write unit tests
  <verify>npx jest src/core.test.ts --no-coverage</verify>
`;

    const phases = parsePlanContent(content);
    expect(phases).toHaveLength(3);

    expect(phases[0]).toEqual({
      number: 1,
      name: 'Setup',
      complexity: 3,
      dependencies: [],
      tasks: [
        { index: 1, name: 'Create project structure', verify_command: null },
        { index: 2, name: 'Add configuration files', verify_command: null },
      ],
    });

    expect(phases[1]).toEqual({
      number: 2,
      name: 'Implementation',
      complexity: 7,
      dependencies: [1],
      tasks: [
        { index: 1, name: 'Implement core logic', verify_command: 'npx tsc --noEmit src/core.ts' },
        { index: 2, name: 'Add error handling', verify_command: null },
      ],
    });

    expect(phases[2]).toEqual({
      number: 3,
      name: 'Tests',
      complexity: 4,
      dependencies: [1, 2],
      tasks: [
        { index: 1, name: 'Write unit tests', verify_command: 'npx jest src/core.test.ts --no-coverage' },
      ],
    });
  });

  it('should handle Dependencies: None', () => {
    const content = `### Phase 1: Init
**Complexity**: 2/10
**Dependencies**: None

- [ ] Do something
`;

    const phases = parsePlanContent(content);
    expect(phases[0].dependencies).toEqual([]);
  });

  it('should apply sequential fallback when dependencies are missing', () => {
    const content = `### Phase 1: First
**Complexity**: 3/10

- [ ] Task A

### Phase 2: Second
**Complexity**: 5/10

- [ ] Task B

### Phase 3: Third
**Complexity**: 4/10

- [ ] Task C
`;

    const phases = parsePlanContent(content);
    expect(phases[0].dependencies).toEqual([]);      // Phase 1 has no deps
    expect(phases[1].dependencies).toEqual([1]);      // Phase 2 depends on 1
    expect(phases[2].dependencies).toEqual([2]);      // Phase 3 depends on 2
  });

  it('should default complexity to 5 when not specified', () => {
    const content = `### Phase 1: No Complexity
**Dependencies**: None

- [ ] Task A
`;

    const phases = parsePlanContent(content);
    expect(phases[0].complexity).toBe(5);
  });

  it('should return empty array for empty content', () => {
    const phases = parsePlanContent('');
    expect(phases).toEqual([]);
  });

  it('should return empty array for content with no phases', () => {
    const content = `# Plan: Something
## Overview
This is a plan description with no phase headers.
`;

    const phases = parsePlanContent(content);
    expect(phases).toEqual([]);
  });

  it('should parse verify tags on task lines', () => {
    const content = `### Phase 1: Build
**Complexity**: 6/10
**Dependencies**: None

- [ ] Create module
  <verify>npx tsc --noEmit</verify>
- [ ] Add exports
- [ ] Write tests
  <verify>npx jest --no-coverage</verify>
`;

    const phases = parsePlanContent(content);
    expect(phases[0].tasks).toHaveLength(3);
    expect(phases[0].tasks[0]).toEqual({ index: 1, name: 'Create module', verify_command: 'npx tsc --noEmit' });
    expect(phases[0].tasks[1]).toEqual({ index: 2, name: 'Add exports', verify_command: null });
    expect(phases[0].tasks[2]).toEqual({ index: 3, name: 'Write tests', verify_command: 'npx jest --no-coverage' });
  });

  it('should handle completed task checkboxes', () => {
    const content = `### Phase 1: Done
**Complexity**: 2/10
**Dependencies**: None

- [x] Already completed task
- [ ] Pending task
`;

    const phases = parsePlanContent(content);
    expect(phases[0].tasks).toHaveLength(2);
    expect(phases[0].tasks[0]).toEqual({ index: 1, name: 'Already completed task', verify_command: null });
    expect(phases[0].tasks[1]).toEqual({ index: 2, name: 'Pending task', verify_command: null });
  });

  it('should parse multiple dependency references', () => {
    const content = `### Phase 1: A
**Dependencies**: None
- [ ] Task

### Phase 2: B
**Dependencies**: None
- [ ] Task

### Phase 3: C
**Dependencies**: Phase 1, Phase 2
- [ ] Task
`;

    const phases = parsePlanContent(content);
    expect(phases[2].dependencies).toEqual([1, 2]);
  });
});

  it('should assign 1-indexed task numbers that reset per phase', () => {
    const content = `### Phase 1: First
**Complexity**: 3/10
**Dependencies**: None

- [ ] Task A
- [ ] Task B
- [ ] Task C

### Phase 2: Second
**Complexity**: 4/10
**Dependencies**: Phase 1

- [ ] Task D
- [ ] Task E
`;

    const phases = parsePlanContent(content);
    expect(phases[0].tasks[0].index).toBe(1);
    expect(phases[0].tasks[1].index).toBe(2);
    expect(phases[0].tasks[2].index).toBe(3);
    // Task numbering resets for Phase 2
    expect(phases[1].tasks[0].index).toBe(1);
    expect(phases[1].tasks[1].index).toBe(2);
  });

  it('should assign index to single-task phases', () => {
    const content = `### Phase 1: Solo
**Complexity**: 2/10
**Dependencies**: None

- [ ] Only task
`;

    const phases = parsePlanContent(content);
    expect(phases[0].tasks).toHaveLength(1);
    expect(phases[0].tasks[0].index).toBe(1);
  });
});

describe('parsePlan (file-based)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should read and parse a plan file', () => {
    const planPath = join(tempDir, 'plan_test_v1.md');
    writeFileSync(
      planPath,
      `### Phase 1: Setup
**Complexity**: 3/10
**Dependencies**: None

- [ ] Initialize project
`,
    );

    const phases = parsePlan(planPath);
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('Setup');
  });
});

/**
 * #1809 — a plan with visible phases is never told its phases do not exist.
 *
 * `plan compile` refused with "no phases parsed", which reports the symptom and
 * withholds the one fact that fixes it. 51 phase headings in this repo's own
 * archive are `##`, and the plans that use them use them exclusively — six
 * visible headings, and the tool saying there are none.
 *
 * THE HEADING LEVEL IS NOT WIDENED, and that is the deliberate half. Every one
 * of those `##` plans writes its tasks as numbered prose under `**Tasks**:`
 * rather than as `- [ ]` checkboxes, so accepting `##` would compile them to
 * phases with ZERO tasks — and zero-task phases already compile without
 * complaint (eleven `###` plans have none), so nothing downstream would catch
 * it. The plan would enter the pipeline as `/execute-plan`'s orchestration
 * source of truth and run nothing. A refusal that names its reason beats a
 * success that does nothing.
 */
describe('whyNoPhases — the refusal says which of the three it is (#1809)', () => {
  it('names the level when the headings are the wrong one', () => {
    const content = ['# Plan', '', '## Phase 1 — Alias-aware edges', '', '## Phase 2 — Board', ''].join('\n');

    const why = whyNoPhases(content);

    expect(why).toContain('2 phase heading(s) are `##`');
    expect(why).toContain(PHASE_HEADER_SHAPE);
    expect(why).toContain('exactly three hashes');
  });

  it.each([
    ['h2', '## Phase 1: Setup'],
    ['h1', '# Phase 1: Setup'],
    ['h4', '#### Phase 1: Setup'],
  ])('catches %s, not just the h2 that was reported', (_label, heading) => {
    expect(whyNoPhases(`# Plan\n\n${heading}\n`)).toContain('exactly three hashes');
  });

  it('names the separator when the level is right and the shape is not', () => {
    const why = whyNoPhases('# Plan\n\n### Phase 1 Setup\n');

    expect(why).toContain('colon or dash');
    expect(why).not.toContain('three hashes');
  });

  it('says plainly when there is nothing phase-like at all', () => {
    // The one case the old wording was actually right about — and it must stay
    // distinguishable from the other two, which is the whole point.
    const why = whyNoPhases('# Plan\n\nJust prose.\n');

    expect(why).toContain(`no \`${PHASE_HEADER_SHAPE}\` heading in the file`);
    expect(why).not.toContain('three hashes');
    expect(why).not.toContain('colon or dash');
  });

  it('the three reasons are all different — a diagnosis that never varies is not one', () => {
    const wrongLevel = whyNoPhases('# Plan\n\n## Phase 1: A\n');
    const wrongShape = whyNoPhases('# Plan\n\n### Phase 1 A\n');
    const nothing = whyNoPhases('# Plan\n\nprose\n');

    expect(new Set([wrongLevel, wrongShape, nothing]).size).toBe(3);
  });

  it('still parses nothing from a `##` plan — the level really is unchanged', () => {
    // Guards the decision, not just its message: if someone later widens the
    // regex, this fails and sends them to the comment explaining why the 51
    // headings are not the argument they look like.
    expect(parsePlanContent('# Plan\n\n## Phase 1: Setup\n\n- [ ] a task\n')).toEqual([]);
  });
});

/**
 * #1810 — the `/10` suffix is the UNIT, not the value.
 *
 * `**Complexity**: 8` matched nothing, so the phase silently took the default
 * of 5. Complexity is not decorative — it picks the model (0-3 haiku, 4-5
 * sonnet, 6-10 opus) — so two missing characters downgraded the phase, and the
 * compiled artifact recorded 5 as though the author had written it.
 *
 * 59 of the 167 complexity lines in this repo's archived plans lack the suffix
 * (35%), including ten written `7` and four written `8`, every one of which
 * should have routed to opus. This is the same widening the phase-header
 * SEPARATOR got, for the same reason: plans are authored by an LLM following a
 * prose template, and a grammar narrower than the documents it is fed keeps
 * collecting near-misses.
 */
describe('complexity is read with or without the /10 suffix (#1810)', () => {
  function phaseWith(complexityLine: string) {
    return parsePlanDetailed(
      ['# Plan', '', '### Phase 1: A', complexityLine, '', '- [ ] a task', ''].join('\n'),
    );
  }

  it.each([
    ['bare', '**Complexity**: 8', 8],
    ['with the unit', '**Complexity**: 8/10', 8],
    ['with a trailing gloss', '**Complexity**: 6/10 (Medium-high)', 6],
    ['bare with a gloss', '**Complexity**: 6 (Medium-high)', 6],
    ['zero', '**Complexity**: 0', 0],
    ['ten', '**Complexity**: 10/10', 10],
  ])('reads %s', (_label, line, expected) => {
    const { phases, unreadableComplexity } = phaseWith(line);

    expect(phases[0]?.complexity).toBe(expected);
    expect(unreadableComplexity).toEqual([]);
  });

  it('gives the same answer with and without the suffix — the regression, stated', () => {
    // Two phases an author described as equally hard must not get different
    // models because one of them omitted the unit.
    expect(phaseWith('**Complexity**: 8').phases[0]?.complexity).toBe(
      phaseWith('**Complexity**: 8/10').phases[0]?.complexity,
    );
  });

  it('reports a line it cannot read instead of silently calling it 5', () => {
    // A default indistinguishable from a deliberate "5" is what made 59
    // unreadable lines invisible.
    const { phases, unreadableComplexity } = phaseWith('**Complexity**: quite hard really');

    expect(phases[0]?.complexity).toBe(DEFAULT_COMPLEXITY);
    expect(unreadableComplexity).toEqual([
      { phase: 1, line: '**Complexity**: quite hard really' },
    ]);
  });

  it('treats an out-of-range number as unreadable, not as a score', () => {
    // 0-10 is the documented range. Accepting 42 would be a NEW silent wrong
    // answer introduced by the widening itself.
    const { phases, unreadableComplexity } = phaseWith('**Complexity**: 42');

    expect(phases[0]?.complexity).toBe(DEFAULT_COMPLEXITY);
    expect(unreadableComplexity).toHaveLength(1);
  });

  it('says nothing when the phase simply has no complexity line', () => {
    // Absent is not unreadable — only a `**Complexity**` line that failed to
    // parse is worth a note.
    const { phases, unreadableComplexity } = parsePlanDetailed(
      ['# Plan', '', '### Phase 1: A', '', '- [ ] a task', ''].join('\n'),
    );

    expect(phases[0]?.complexity).toBe(DEFAULT_COMPLEXITY);
    expect(unreadableComplexity).toEqual([]);
  });

  it('does not read a complexity out of a phase\'s prose', () => {
    // Anchored at the line start, so a sentence mentioning the field cannot
    // become the score — the widening must not buy accuracy with precision.
    const { phases } = parsePlanDetailed(
      ['# Plan', '', '### Phase 1: A', '', 'We debated whether **Complexity**: 9 was fair.', '', '- [ ] a', ''].join('\n'),
    );

    expect(phases[0]?.complexity).toBe(DEFAULT_COMPLEXITY);
  });

  it('parsePlanContent still returns just the phases', () => {
    // Every existing caller keeps its signature.
    expect(parsePlanContent('# Plan\n\n### Phase 1: A\n**Complexity**: 8\n\n- [ ] a\n')[0]?.complexity).toBe(8);
  });
});

describe('task shapes (#1821)', () => {
  // The checkbox was the only shape recognised. 134 tasks and 58 `<verify>`
  // commands across this repo's 44 plans were written in the other three, and
  // a dropped task takes its verification with it — silently, exit 0,
  // `diagnostics: []`.

  it('reads a checkbox task, as it always did', () => {
    const { phases } = parsePlanDetailed(
      ['### Phase 1: A', '', '- [ ] do the thing', '  <verify>npm test</verify>', ''].join('\n'),
    );
    expect(phases[0]?.tasks).toEqual([
      { index: 1, name: 'do the thing', verify_command: 'npm test' },
    ]);
  });

  it('reads a bold task bullet, with the verify on the following line', () => {
    const { phases } = parsePlanDetailed(
      ['### Phase 1: A', '', '- **Task 1.1** — do the thing', '  <verify>npm test</verify>', ''].join('\n'),
    );
    expect(phases[0]?.tasks).toEqual([
      { index: 1, name: 'do the thing', verify_command: 'npm test' },
    ]);
  });

  it('reads an unbolded task bullet — the fourth shape, found by the diagnostic', () => {
    const { phases } = parsePlanDetailed(
      ['### Phase 1: A', '', '- Task 1.1: do the thing', '  <verify>npm test</verify>', ''].join('\n'),
    );
    expect(phases[0]?.tasks).toEqual([
      { index: 1, name: 'do the thing', verify_command: 'npm test' },
    ]);
  });

  it('reads numbered items under a **Tasks**: header, with an INLINE verify', () => {
    // The numbered lists put `<verify>` on the task line itself, which is why
    // reading only the following line left them with no command at all.
    const { phases } = parsePlanDetailed(
      [
        '### Phase 1: A',
        '',
        '**Tasks**:',
        '1. first thing <verify>npm test a</verify>',
        '2. second thing <verify>npm test b</verify>',
        '',
        '**Files**: `src/a.ts`',
        '',
      ].join('\n'),
    );
    expect(phases[0]?.tasks).toEqual([
      { index: 1, name: 'first thing', verify_command: 'npm test a' },
      { index: 2, name: 'second thing', verify_command: 'npm test b' },
    ]);
  });

  it('accepts the Tasks header however the asterisks fall around the colon', () => {
    for (const header of ['**Tasks**:', '**Tasks:**', 'Tasks:']) {
      const { phases } = parsePlanDetailed(
        ['### Phase 1: A', '', header, '1. a thing', ''].join('\n'),
      );
      expect(phases[0]?.tasks.map((t) => t.name)).toEqual(['a thing']);
    }
  });

  it('does NOT read numbered prose outside a Tasks list as tasks', () => {
    // The precision half. A numbered line is ordinary narrative everywhere
    // else in a phase, so the shape is only recognised inside the list its
    // header opened — otherwise the widening invents work out of prose.
    const { phases, tasklessPhases } = parsePlanDetailed(
      [
        '### Phase 1: A',
        '',
        'The rollout has three steps:',
        '1. tell everyone',
        '2. wait a week',
        '3. flip the flag',
        '',
      ].join('\n'),
    );
    expect(phases[0]?.tasks).toEqual([]);
    expect(tasklessPhases).toEqual([{ phase: 1, name: 'A' }]);
  });

  it('closes the Tasks list at the next field, so later prose is not swept in', () => {
    const { phases } = parsePlanDetailed(
      [
        '### Phase 1: A',
        '',
        '**Tasks**:',
        '1. a real task',
        '',
        '**Notes**: we considered alternatives',
        '1. this is prose, not a task',
        '',
      ].join('\n'),
    );
    expect(phases[0]?.tasks.map((t) => t.name)).toEqual(['a real task']);
  });

  it('does not treat a bullet that merely says "Task" as one', () => {
    // The NUMBER is what makes it a task.
    const { phases } = parsePlanDetailed(
      ['### Phase 1: A', '', '- Task ordering is discussed below', ''].join('\n'),
    );
    expect(phases[0]?.tasks).toEqual([]);
  });

  it('lets an inline verify win over a following line', () => {
    const { phases } = parsePlanDetailed(
      [
        '### Phase 1: A',
        '',
        '**Tasks**:',
        '1. a thing <verify>the inline one</verify>',
        '   <verify>the following one</verify>',
        '',
      ].join('\n'),
    );
    expect(phases[0]?.tasks[0]?.verify_command).toBe('the inline one');
  });

  it('reports every phase that parsed no tasks, with its name', () => {
    // The backstop for the shape nobody has written yet. `whyNoPhases` declines
    // to widen the heading level precisely because zero-task phases "compile
    // without complaint" — this is the complaint.
    const { tasklessPhases } = parsePlanDetailed(
      [
        '### Phase 1: Has work',
        '- [ ] a task',
        '',
        '### Phase 2: Has none',
        'Just prose.',
        '',
        '### Phase 3: Also none',
        '',
      ].join('\n'),
    );
    expect(tasklessPhases).toEqual([
      { phase: 2, name: 'Has none' },
      { phase: 3, name: 'Also none' },
    ]);
  });

  it('says nothing when every phase has tasks', () => {
    const { tasklessPhases } = parsePlanDetailed(
      ['### Phase 1: A', '- [ ] a', '', '### Phase 2: B', '- **Task 2.1** — b', ''].join('\n'),
    );
    expect(tasklessPhases).toEqual([]);
  });
});

describe('colon placement and bare dependency lists (#1844)', () => {
  // Which side of the colon the asterisks fall on is a typographic accident.
  // 59 `**Complexity:**` and 59 `**Dependencies:**` lines across 9 of this
  // repo's plans fell on the unread side.

  it('reads a complexity with the colon inside the emphasis', () => {
    const { phases } = parsePlanDetailed('### Phase 1: A\n**Complexity:** 7\n- [ ] a\n');
    expect(phases[0]?.complexity).toBe(7);
  });

  it('reads it with the colon outside, as it always did', () => {
    const { phases } = parsePlanDetailed('### Phase 1: A\n**Complexity**: 7\n- [ ] a\n');
    expect(phases[0]?.complexity).toBe(7);
  });

  it('still flags an unreadable value written with the colon inside', () => {
    // The detector widens WITH the value grammar. #1810 added it so an
    // unreadable complexity would be said out loud, but it carried the same
    // colon placement — so these lines were not read AND not flagged, and the
    // silence it set out to end simply moved.
    const { phases, unreadableComplexity } = parsePlanDetailed(
      '### Phase 1: A\n**Complexity:** banana\n- [ ] a\n',
    );
    expect(phases[0]?.complexity).toBe(DEFAULT_COMPLEXITY);
    expect(unreadableComplexity).toHaveLength(1);
  });

  it('reads dependencies with the colon inside the emphasis', () => {
    const { phases } = parsePlanDetailed(
      '### Phase 1: A\n- [ ] a\n\n### Phase 5: E\n**Dependencies:** Phase 2, Phase 3\n- [ ] b\n',
    );
    expect(phases[1]?.dependencies).toEqual([2, 3]);
  });

  it('reads a BARE phase-number list — `2, 3` means `Phase 2, Phase 3`', () => {
    // The dangerous half. A bare list matched the line but yielded NO phase
    // numbers, so the phase compiled with `dependencies: []` — an explicit "no
    // prerequisites", not the sequential fallback an ABSENT line gets. 26 such
    // lines were live, and one plan had eight chained phases all scheduled into
    // a single parallel wave because of it.
    const { phases } = parsePlanDetailed(
      '### Phase 1: A\n- [ ] a\n\n### Phase 5: E\n**Dependencies**: 2, 3\n- [ ] b\n',
    );
    expect(phases[1]?.dependencies).toEqual([2, 3]);
  });

  it('reads a bare list with the colon inside too', () => {
    const { phases } = parsePlanDetailed(
      '### Phase 1: A\n- [ ] a\n\n### Phase 5: E\n**Dependencies:** 2, 3\n- [ ] b\n',
    );
    expect(phases[1]?.dependencies).toEqual([2, 3]);
  });

  it('keeps `none` meaning none, either placement', () => {
    for (const line of ['**Dependencies**: none', '**Dependencies:** none']) {
      const { phases } = parsePlanDetailed(
        `### Phase 1: A\n- [ ] a\n\n### Phase 5: E\n${line}\n- [ ] b\n`,
      );
      expect(phases[1]?.dependencies).toEqual([]);
    }
  });

  it('does not scrape stray numbers out of dependency prose', () => {
    // The precision half: the bare-list reader runs ONLY when the `Phase N`
    // reader found nothing AND the whole value is a number list. Here the v3
    // must not become a dependency.
    const { phases } = parsePlanDetailed(
      '### Phase 1: A\n- [ ] a\n\n### Phase 5: E\n**Dependencies:** Phase 2 (after the v3 cut)\n- [ ] b\n',
    );
    expect(phases[1]?.dependencies).toEqual([2]);
  });

  it('falls back to sequential only when the line is truly absent', () => {
    // An absent line and an empty one must stay distinguishable: absent means
    // "assume sequential", `none` means "nothing".
    const { phases } = parsePlanDetailed(
      '### Phase 1: A\n- [ ] a\n\n### Phase 2: B\n- [ ] b\n',
    );
    expect(phases[1]?.dependencies).toEqual([1]);
  });
});

describe('dependency values that name phases (#1823)', () => {
  const twoPhases = (depLine: string): string =>
    `### Phase 1: A\n- [ ] a\n\n### Phase 9: Z\n${depLine}\n- [ ] b\n`;

  it('reads the keyword said ONCE for a whole list — `Phases 1, 2, 3, 4`', () => {
    // The per-reference reader sees "Phases 1" and then nothing, so the list
    // collapsed to []. Live in an active plan, on its final tests phase, which
    // therefore compiled into wave 1 beside all four of its prerequisites.
    const { phases } = parsePlanDetailed(twoPhases('**Dependencies**: Phases 1, 2, 3, 4'));
    expect(phases[1]?.dependencies).toEqual([1, 2, 3, 4]);
  });

  it('reads the keyword repeated, as it always did', () => {
    const { phases } = parsePlanDetailed(twoPhases('**Dependencies**: Phase 2, Phase 3'));
    expect(phases[1]?.dependencies).toEqual([2, 3]);
  });

  it('reads a lowercase keyword joined with "and"', () => {
    const { phases } = parsePlanDetailed(twoPhases('**Dependencies**: phases 1 and 2'));
    expect(phases[1]?.dependencies).toEqual([1, 2]);
  });

  it('still refuses to scrape numbers out of dependency prose', () => {
    // Stripping the keyword leaves "2 (after the v3 cut)", which is not a bare
    // list, so the per-reference reader keeps the answer.
    const { phases } = parsePlanDetailed(
      twoPhases('**Dependencies**: Phase 2 (after the v3 cut)'),
    );
    expect(phases[1]?.dependencies).toEqual([2]);
  });

  describe('unreadable is not "depends on nothing"', () => {
    // The headline. `[]` is the STRONGEST claim in this vocabulary — only
    // `null` gets the sequential fallback — so a value nobody could read put
    // its phase into wave 1, in parallel with whatever it had just named.

    it('falls back to sequential and reports, rather than claiming independence', () => {
      const { phases, unreadableDependencies } = parsePlanDetailed(
        twoPhases('**Dependencies**: after the redesign'),
      );
      expect(phases[1]?.dependencies).toEqual([8]);
      expect(unreadableDependencies).toEqual([
        { phase: 9, line: '**Dependencies**: after the redesign' },
      ]);
    });

    it('keeps `none` meaning genuinely independent, and says nothing', () => {
      const { phases, unreadableDependencies } = parsePlanDetailed(
        twoPhases('**Dependencies**: none'),
      );
      expect(phases[1]?.dependencies).toEqual([]);
      expect(unreadableDependencies).toEqual([]);
    });

    it('keeps an ABSENT line silent — sequential is the right answer, not a near-miss', () => {
      const { phases, unreadableDependencies } = parsePlanDetailed(
        '### Phase 1: A\n- [ ] a\n\n### Phase 2: B\n- [ ] b\n',
      );
      expect(phases[1]?.dependencies).toEqual([1]);
      expect(unreadableDependencies).toEqual([]);
    });

    it('tells the three cases apart — the whole point', () => {
      const read = (line: string | null): [unknown, number] => {
        const src = line === null
          ? '### Phase 1: A\n- [ ] a\n\n### Phase 9: Z\n- [ ] b\n'
          : twoPhases(line);
        const r = parsePlanDetailed(src);
        return [r.phases[1]?.dependencies, r.unreadableDependencies.length];
      };
      expect(read('**Dependencies**: none')).toEqual([[], 0]);
      expect(read('**Dependencies**: TBD')).toEqual([[8], 1]);
      expect(read(null)).toEqual([[8], 0]);
    });
  });
});

describe('a heading the parser cannot read ends the phase above it (#1847)', () => {
  const WITH_DECIMAL = [
    '### Phase 3: Persistence',
    '**Complexity**: 5/10',
    '**Dependencies**: Phase 2',
    '- [ ] the real task',
    '',
    '### Phase 3.5 — The address gate',
    '**Complexity**: 8/10',
    '**Dependencies**: Phase 3',
    '- [ ] a task that belongs to nobody',
    '',
    '### Phase 4: Next',
    '**Dependencies**: Phase 3',
    '- [ ] four',
    '',
  ].join('\n');

  it('does not hand the decimal phase’s Dependencies to the phase above', () => {
    // THE HEADLINE. `### Phase 3.5` is not a heading — `(\d+)` takes the 3 and
    // the separator cannot match the `.` — and it was not skipped either, so
    // Phase 3 absorbed `**Dependencies**: Phase 3` and depended on ITSELF. That
    // is a cycle, and `compileRunScript` refused the whole plan for a reason
    // with no visible cause in the document.
    const { phases } = parsePlanDetailed(WITH_DECIMAL);
    const three = phases.find((phase) => phase.number === 3);

    expect(three?.dependencies).toEqual([2]);
    expect(three?.dependencies).not.toContain(3);
  });

  it('does not hand it the complexity or the tasks either', () => {
    const { phases } = parsePlanDetailed(WITH_DECIMAL);
    const three = phases.find((phase) => phase.number === 3);

    expect(three?.complexity).toBe(5);
    expect(three?.tasks.map((task) => task.name)).toEqual(['the real task']);
  });

  it('reports the line, and which phase it would have joined', () => {
    const { unreadableHeadings } = parsePlanDetailed(WITH_DECIMAL);
    expect(unreadableHeadings).toEqual([
      { afterPhase: 3, line: '### Phase 3.5 — The address gate' },
    ]);
  });

  it('the next real heading still starts its phase', () => {
    // Ending the phase must not swallow what comes after the skipped section.
    const { phases } = parsePlanDetailed(WITH_DECIMAL);
    expect(phases.map((phase) => phase.number)).toEqual([3, 4]);
    expect(phases.find((phase) => phase.number === 4)?.tasks.map((t) => t.name)).toEqual(['four']);
  });

  it('catches a wrong-LEVEL heading between phases too', () => {
    // The same absorption, one hash off — found in the same real plan.
    const { phases, unreadableHeadings } = parsePlanDetailed(
      [
        '### Phase 1: One',
        '- [ ] a',
        '',
        '## Phase 9 — added at execution time',
        '**Dependencies**: Phase 1',
        '- [ ] not phase 1’s task',
        '',
      ].join('\n'),
    );

    expect(phases).toHaveLength(1);
    expect(phases[0]?.tasks.map((task) => task.name)).toEqual(['a']);
    expect(unreadableHeadings.map((heading) => heading.afterPhase)).toEqual([1]);
  });

  it('says nothing when every heading reads', () => {
    const { unreadableHeadings } = parsePlanDetailed(
      '### Phase 1: One\n- [ ] a\n\n### Phase 2: Two\n- [ ] b\n',
    );
    expect(unreadableHeadings).toEqual([]);
  });

  it('a heading before ANY phase is reported with no phase to blame', () => {
    const { unreadableHeadings } = parsePlanDetailed(
      '## Phase 0 — preamble\n\n### Phase 1: One\n- [ ] a\n',
    );
    expect(unreadableHeadings).toEqual([{ afterPhase: null, line: '## Phase 0 — preamble' }]);
  });
});

describe('parsePlanDetailed — change notes (plan change review)', () => {
  /** An older plan: a `## Story`, no change notes (NFR-5). */
  const OLD_PLAN_WITH_STORY = `# Plan: Old

## Story

### Step: The problem
- kicker: The problem
- anchors: file:src/a.ts
- phases: 1

A plan from before change notes.

## Phases

### Phase 1: Setup
**Complexity**: 3/10
**Dependencies**: None

- [ ] Create the thing
  <verify>npx tsc --noEmit</verify>

### Phase 2: Tests (Final)
**Complexity**: 4

- [ ] Test the thing
`;

  it('an old plan with a Story parses exactly as before: same phases, no notes key, nothing unreadable', () => {
    const parsed = parsePlanDetailed(OLD_PLAN_WITH_STORY);
    expect(parsed.phases).toStrictEqual([
      {
        number: 1,
        name: 'Setup',
        complexity: 3,
        dependencies: [],
        tasks: [{ index: 1, name: 'Create the thing', verify_command: 'npx tsc --noEmit' }],
      },
      {
        number: 2,
        name: 'Tests (Final)',
        complexity: 4,
        dependencies: [1],
        tasks: [{ index: 1, name: 'Test the thing', verify_command: null }],
      },
    ]);
    expect(parsed.phases.every((phase) => !('notes' in phase))).toBe(true);
    expect(parsed.notes).toEqual([]);
    expect(parsed.unreadableNotes).toEqual([]);
    expect(parsePlanContent(OLD_PLAN_WITH_STORY)).toStrictEqual(parsed.phases);
  });

  const WITH_NOTES = `# Plan: New

### Phase 1: Wire
**Complexity**: 5/10

- [ ] First task
  <verify>npm run test -- a</verify>

#### Change notes

- note: 1 · change · file:src/a.ts:run
    where: \`return run(\`
    what: pass the flag
    why: the caller needs it
    comments:
      - Task 9 sounds like a task but is a comment
      - [ ] so does this
- note: 2 · bogus · file:src/b.ts:x

- [ ] Second task

### Phase 2: More
**Dependencies**: Phase 1

#### Change notes

- note: 3 · file · file:src/c.ts
    what: an import
    why: the new helper
    status: accepted
`;

  it('each phase carries its own notes; note lines are never tasks', () => {
    const parsed = parsePlanDetailed(WITH_NOTES);
    const [one, two] = parsed.phases;
    expect(one?.tasks.map((task) => task.name)).toEqual(['First task', 'Second task']);
    expect(one?.tasks[0]?.verify_command).toBe('npm run test -- a');
    expect(one?.notes?.map((note) => note.n)).toEqual([1]);
    expect(two?.tasks).toEqual([]);
    expect(two?.notes?.map((note) => [note.n, note.status])).toEqual([[3, 'accepted']]);
    expect(parsed.notes.map((note) => note.n)).toEqual([1, 3]);
  });

  it('a malformed note is reported with its line and reason, not dropped silently', () => {
    const parsed = parsePlanDetailed(WITH_NOTES);
    expect(parsed.unreadableNotes).toEqual([
      { line: 18, n: 2, reason: '"bogus" is not a note kind — it is change, new or file' },
    ]);
    expect(WITH_NOTES.split('\n')[17]).toBe('- note: 2 · bogus · file:src/b.ts:x');
  });
});
