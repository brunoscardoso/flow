---
description: This command takes a minimum coverage percentage as input and orchestrates the test writing process 
---

# Write Tests - Coverage Improvement Command

## Command Description

This command takes a minimum coverage percentage as input and orchestrates the test writing process by invoking the `write-tests` skill to achieve the target coverage across all files.

**Output**: Creates/updates test files to achieve the specified coverage percentage.

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/write-tests - Write Tests for Coverage Target

DESCRIPTION:
  Analyzes current test coverage and iteratively writes or improves tests
  until the target coverage percentage is achieved across all files.

USAGE:
  /write-tests <coverage_percentage>
  /write-tests -help

ARGUMENTS:
  coverage_percentage   Target minimum coverage (e.g., 80, 90, 100)

EXAMPLES:
  /write-tests 80                    # Achieve 80% coverage
  /write-tests 95                    # Achieve 95% coverage
  /write-tests 100                   # Achieve 100% coverage

OUTPUT:
  - Creates/updates test files
  - Achieves target coverage across all metrics

WORKFLOW:
  1. Runs initial coverage analysis
  2. Creates work queue (lowest coverage first)
  3. For each file below target:
     - Analyzes source code
     - Identifies untested paths
     - Writes/improves tests
     - Verifies coverage improved
  4. Final verification of all metrics

COVERAGE METRICS (all must meet target):
  - Lines       Most important metric
  - Branches    All conditional paths
  - Functions   All exported functions
  - Statements  Usually follows lines

SUPPORTED FRAMEWORKS:
  - Jest (JavaScript/TypeScript)
  - Pytest (Python)

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /execute-plan   Tests are the last phase of plan execution
```

---

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Complete and Stop**    | After presenting results, STOP and wait for user         |

---

## Instructions

### Step 1: Validate Inputs

| Input                 | Required | Description                                     |
| --------------------- | -------- | ----------------------------------------------- |
| `coverage_percentage` | Yes      | Target minimum coverage (e.g., 80, 90, 100)     |

**Validation**:
- Must be a number between 1 and 100
- If invalid, ask for valid coverage percentage

---

### Step 2: Detect Testing Framework

Identify the testing framework:

| Framework | Detection                                     |
| --------- | --------------------------------------------- |
| Jest      | `jest.config.js`, `package.json` with jest    |
| Pytest    | `pytest.ini`, `pyproject.toml`, `conftest.py` |

If unable to detect, ask user which framework to use.

---

### Step 3: Invoke Write Tests Skill

The skill will:

1. Run initial coverage analysis
2. Create work queue (lowest coverage first)
3. For each file below target:
   - Analyze source code
   - Identify untested paths
   - Write/improve tests
   - Verify coverage improved
4. Run final verification

See: `.claude/resources/skills/write-tests-skill.md`

---

### Step 4: Present Results

After the skill completes, present summary:

```markdown
Coverage target met.

- Target: X%
- Coverage: Y% (lines, branches, functions, statements)
- Files updated: N
- Test files added: N
- Tests added: N
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

**CRITICAL**: This command is now complete. STOP and wait for the user.

---

## Flow Diagram

```
+------------------------------------------+
|         /write-tests COMMAND             |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate Inputs                  |
| - Check coverage percentage is valid     |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: Detect Testing Framework         |
| - Jest or Pytest                         |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Invoke Write Tests Skill         |
| - Skill handles all test writing logic   |
| - See write-tests-skill.md              |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Present Results                  |
| - Show coverage summary                  |
| - Confirm all metrics met                |
+------------------------------------------+
```

---

## Coverage Priorities

1. **Lines**: Most important
2. **Branches**: Cover all conditional paths
3. **Functions**: Ensure all exported functions are tested
4. **Statements**: Usually follows lines coverage

---

## Example Usage

**User**: `/write-tests 80`

**Execution**:

1. Validate input: 80% is valid
2. Detect framework: Jest (found jest.config.js)
3. Invoke write-tests skill
4. Present final coverage summary

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "test writing" --scope resources`
- `planflow-ai state-query "jest patterns" --scope resources`
- `planflow-ai state-query "pytest patterns" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                  | Purpose                         |
| ------------------------- | ------------------------------- |
| `write-tests-skill.md`   | Skill that writes the tests     |
| `jest-patterns.md`       | Jest testing patterns           |
| `pytest-patterns.md`     | Pytest testing patterns         |
| `jest-testing-tool.md`   | Jest commands and utilities     |
| `pytest-testing-tool.md` | Pytest commands and utilities   |
| `/execute-plan` command   | Tests are last phase of plans   |

---

## Tasklist Updates

Update `flow/tasklist.md` at these points. See `.claude/resources/core/project-tasklist.md` for full rules.

1. **On start**: Add "Tests: {scope} ({target}%)" to **In Progress** (or move it from To Do if it already exists)
2. **On complete**: Move "Tests: {scope}" to **Done** with today's date

---

## Learn Recommendations

After test writing completes, check for learning opportunities. See `.claude/resources/core/learn-recommendations.md` for the full system.

**Test-specific checks**:
- Was a **new testing framework** or library introduced (e.g., switching from Jest to Vitest)?
- Were **non-trivial test failures** resolved after 3+ attempts?
- Were **new mocking patterns** or testing utilities added?

Present recommendations at the end of the test writing summary.

---

## Brain Capture

After test writing completes, append a brain-capture block. See `.claude/resources/core/brain-capture.md` for processing rules.

**Capture the following**:

```
<!-- brain-capture
skill: write-tests
feature: [feature or scope tested]
status: completed
data:
  test_framework: [jest/pytest/vitest]
  coverage_before: [percentage]
  coverage_after: [percentage]
  coverage_target: [target percentage]
  tests_written: [count of new test files/cases]
  failures_encountered: [list of test failures during writing, if any]
-->
```

Update `flow/brain/features/[feature-name].md` if testing a known feature. Log to `flow/brain/sessions/YYYY-MM-DD.md` otherwise.

The file MUST carry `capture: brain` in its frontmatter — that key is how the store tells a captured note from a capability, and a note without it is drawn on the Blueprint board as a feature of the product.

---

## Resource Capture

During this skill's execution, watch for valuable reference materials worth preserving. See `.claude/resources/core/resource-capture.md` for capture rules, file format, and naming conventions.

At natural break points, if you encounter information that could be useful for future development (API specs, architecture notes, config references, domain knowledge, etc.), ask the user: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"

Only save if the user approves. Do not re-ask if declined.

