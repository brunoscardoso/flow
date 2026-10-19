---
description: This command performs deep analysis of the current repository to index languages, frameworks, archit
---

# Setup Project

## Command Description

This command performs deep analysis of the current repository to index languages, frameworks, architecture patterns, and coding conventions. It samples real code, extracts actual patterns, and generates comprehensive pattern files that enable the agent to work effectively with the project's specific stack and conventions.

**Output**: 
- Project analysis document at `flow/references/project_analysis.md`
- Framework pattern files in `.claude/rules/frameworks/`
- Library pattern files in `.claude/rules/libraries/`
- Project conventions in `.claude/rules/project/`
- Updated core pattern files

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/setup - Deep Project Analysis and Pattern Indexing

DESCRIPTION:
  Performs deep analysis of the repository to understand the project's
  stack, patterns, and conventions. Samples real code to extract actual
  patterns and generates comprehensive pattern files with real examples.

USAGE:
  /setup
  /setup -help

EXAMPLES:
  /setup                    # Analyze project and generate pattern files

OUTPUT:
  - Creates: flow/ folder structure (if not exists)
  - Creates: flow/references/project_analysis.md
  - Creates: .claude/rules/frameworks/<framework>-patterns.md
  - Creates: .claude/rules/libraries/<library>-patterns.md
  - Creates: .claude/rules/project/project-patterns.md
  - Updates: .claude/rules/core/allowed-patterns.md
  - Updates: .claude/rules/core/forbidden-patterns.md

WORKFLOW:
  1. Scans project structure and dependency files
  2. Deep dependency analysis (all libraries, versions, purposes)
  3. Deep code analysis (samples files, extracts real patterns)
  4. Researches best practices for detected stack
  5. Checks for existing project rules
  6. Presents analysis summary
  7. Asks confirming questions via Plan mode Questions UI
  8. Generates pattern files based on confirmed patterns
  9. Creates flow/ folder structure for plan-flow artifacts
  10. Presents setup summary

WHAT IT INDEXES:
  - Import patterns and styles
  - File organization and naming conventions
  - Component/function structure patterns
  - Error handling approaches
  - API call patterns
  - State management patterns
  - Validation patterns
  - Testing patterns

DETECTS:
  Languages:    JavaScript, TypeScript, Python, Go, Rust, Java, Ruby, C#
  Frameworks:   Next.js, React, Vue, Angular, FastAPI, Django, Express, NestJS
  Libraries:    Zod, Prisma, Zustand, Redux, TailwindCSS, React Query, and 50+

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /discovery-plan    Start discovery after setup
  /create-plan       Create implementation plans
  /review-code       Review local changes
```

---

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **Deep Analysis**        | Sample real code - don't just detect dependencies        |
| **Real Examples**        | Pattern files must include actual code from the project  |
| **Research Best Practices** | Use web search to get current best practices         |
| **Interactive Questions** | Use Plan mode Questions UI to confirm patterns          |
| **User Confirmation**    | Always confirm detected patterns before generating files |
| **Complete and Stop**    | After presenting results, STOP and wait for user         |

---

## Required Tools

This command uses the Interactive Questions Tool for user confirmation.

See: `.claude/resources/tools/interactive-questions-tool.md`

---

## Instructions

### Step 1: Validate Context

Verify we're in a valid project directory:

1. Check for presence of dependency files (package.json, requirements.txt, etc.)
2. Check for source code directories (src/, app/, lib/, etc.)
3. If no project detected, inform user and ask for guidance

**If valid project found**, report initial findings:

```markdown
Found: [package.json/requirements.txt/etc.]
Source directories: [src/, app/, etc.]
Proceeding with deep analysis...
```

---

### Step 2: Initial Dependency Scan

Read dependency files completely:

1. Parse all dependencies with versions
2. Categorize: frameworks, libraries, dev tools
3. Identify the complete stack

**Report findings**:

```markdown
## Detected Stack

**Language**: [TypeScript/JavaScript/Python/etc.]
**Framework**: [Next.js/FastAPI/etc.]
**Key Libraries**:
- Validation: [Zod/Pydantic/etc.]
- State: [Zustand/Redux/etc.]
- ORM: [Prisma/SQLAlchemy/etc.]
- Testing: [Jest/Vitest/Pytest/etc.]
```

---

### Step 3: Deep Code Analysis

**CRITICAL**: This is where the real indexing happens.

For each detected library/framework:

1. **Find relevant files** using glob patterns
2. **Read 2-5 sample files** to understand usage
3. **Extract patterns**:
   - Import style
   - File organization
   - Naming conventions
   - Code structure
   - Usage patterns

**Document findings as you go**:

```markdown
## Analyzing [Library]...

**Files found**: X files matching pattern
**Sample files read**: [file1.ts], [file2.ts]

**Patterns detected**:
- Import: `import { x } from 'lib'`
- Location: `src/schemas/`
- Naming: `entitySchema`
```

---

### Step 4: Detect Project Conventions

Analyze the codebase for conventions:

1. **File Naming**: kebab-case, camelCase, PascalCase
2. **Directory Structure**: feature-based, layer-based, hybrid
3. **Import Patterns**: path aliases, barrel exports
4. **Component Structure**: co-located vs separated
5. **Error Handling**: patterns used
6. **Logging**: library or console

---

### Step 5: Research Best Practices

Use web search to get current best practices:

1. Search for `"[framework] best practices 2025"`
2. Search for `"[library] patterns"`
3. Compare with project patterns
4. Note recommendations

---

### Step 6: Check Existing Project Rules

Check for existing rules:

1. `.claude/rules/` directory
2. Note conflicts and overlaps

---

### Step 7: Ask Confirming Questions (Interactive)

**Use the Interactive Questions Tool to confirm detected patterns with the user.**

See: `.claude/resources/tools/interactive-questions-tool.md`

#### 7.1: Present Analysis Summary First

Before asking questions, present what was detected:

```markdown
## Project Analysis Complete

I analyzed your codebase and detected:

**Stack**: [Language] + [Framework]
**Key Libraries**: [Lib1], [Lib2], [Lib3]
**Architecture**: [Feature-based/Layer-based/etc.]

**Patterns Detected**:
1. [Pattern 1 with brief example]
2. [Pattern 2 with brief example]
3. [Pattern 3 with brief example]

**Conventions Detected**:
- File naming: [convention]
- Import style: [convention]
- Component structure: [convention]

Now I'll ask a few questions to confirm these patterns.
```

#### 7.2: Switch to Plan Mode

**MANDATORY**: Use `SwitchMode` tool to switch to Plan mode:

```
Use Claude Code native conversation flow for questions
```

#### 7.3: Ask Setup Questions

Use `Ask the user directly in conversation` tool for each question:

**Question 1: Stack Confirmation**

```
Ask the user directly in conversation({
  question: "I detected the following stack. Is this accurate?

[Framework]: [Detected framework]
[Language]: [Detected language]
[Key Libraries]: [List]",
  options: [
    "A. Yes, this is correct",
    "B. Partially correct - I'll clarify what's different",
    "C. No, let me describe the correct stack"
  ],
  explanation: "Confirming the detected technology stack"
})
```

**Question 2: Architecture Confirmation**

```
Ask the user directly in conversation({
  question: "I detected this architecture pattern:

[Detected pattern description]

Is this how your project is organized?",
  options: [
    "A. Yes, this is our architecture",
    "B. No, we use a different approach",
    "C. We're transitioning to a new architecture"
  ],
  explanation: "Understanding the project's architectural approach"
})
```

**Question 3: Pattern Enforcement**

```
Ask the user directly in conversation({
  question: "I found these coding patterns in your codebase. Which should I enforce?

1. [Pattern 1]
2. [Pattern 2]
3. [Pattern 3]",
  options: [
    "A. All detected patterns - they represent our standards",
    "B. Let me review and select which to keep",
    "C. These are legacy patterns - I'll describe preferred patterns"
  ],
  explanation: "Determining which patterns to document and enforce"
})
```

**Question 4: Strictness Level**

```
Ask the user directly in conversation({
  question: "How strictly should I enforce these patterns when generating code?",
  options: [
    "A. Strict - Always follow these patterns exactly",
    "B. Moderate - Follow patterns but allow exceptions with justification",
    "C. Loose - Use as guidelines, not requirements"
  ],
  explanation: "Setting the enforcement level for detected patterns"
})
```

**Question 5: Best Practices** (if recommendations found)

```
Ask the user directly in conversation({
  question: "I found some industry best practices your codebase could adopt:

1. [Recommendation 1]
2. [Recommendation 2]

Should I include these in the pattern files?",
  options: [
    "A. Yes, include them as recommendations",
    "B. No, only document current patterns",
    "C. Show me the full list first"
  ],
  explanation: "Deciding whether to include best practice recommendations"
})
```

**Question 6: Existing Rules** (only if existing project rules found)

```
Ask the user directly in conversation({
  question: "I found existing project rules in your project. How should I handle them?",
  options: [
    "A. Merge with new patterns (combine both)",
    "B. Replace with new patterns",
    "C. Keep existing rules, add new patterns separately",
    "D. Let me review the conflicts first"
  ],
  explanation: "Handling existing cursor rule files"
})
```

#### 7.4: Process Responses

After all questions are answered:

1. Extract selected options from each question
2. Map to corresponding answers
3. Document the confirmed patterns
4. Adjust pattern generation based on responses

#### 7.5: Switch Back to Agent Mode

**MANDATORY**: Use `SwitchMode` tool to return to Agent mode:

```
Use Claude Code native conversation flow for questions
```

---

### Step 8: Invoke Setup Skill

With confirmed patterns, the skill will:

1. Compile analysis into structured patterns based on user responses
2. Generate comprehensive pattern files with real examples
3. Create project analysis document
4. Update core pattern files

See: `.claude/resources/skills/setup-skill.md`

---

### Step 9: Create Flow Folder Structure

**Create the `flow/` directory structure for plan-flow artifacts.**

If the `flow/` folder doesn't exist, create it:

```bash
mkdir -p flow/archive flow/brain/features flow/brain/errors flow/contracts flow/discovery flow/plans flow/references flow/reviewed-code flow/reviewed-pr
```

**Add `.gitkeep` files**:

```bash
touch flow/archive/.gitkeep flow/brain/.gitkeep flow/contracts/.gitkeep flow/discovery/.gitkeep flow/plans/.gitkeep flow/references/.gitkeep flow/reviewed-code/.gitkeep flow/reviewed-pr/.gitkeep
```

**Directory Structure Created**:

```
flow/
├── archive/           # Completed/abandoned plans
├── brain/             # Automatic knowledge capture (Obsidian-compatible)
│   ├── features/      # Feature history and context
│   ├── errors/        # Reusable error patterns
│   └── sessions/      # Daily activity logs
├── contracts/         # Integration contracts
├── discovery/         # Discovery documents
├── plans/             # Active implementation plans
├── references/        # Reference materials + project_analysis.md
├── reviewed-code/     # Local code review documents
└── reviewed-pr/       # PR review documents
```

**Note**: Skip if directories already exist.

---

### Step 9b: First Blueprint Derive

After the flow structure exists, run the first Blueprint derive so the project starts with a populated system map:

```bash
planflow-ai blueprint derive
```

Fail-soft: if the CLI is unavailable or derive fails, print a one-line notice and continue — setup must never block on Blueprint. (`planflow-ai init` also runs a fire-and-forget derive, so this is a no-op safety net on init-created projects.) See `.claude/resources/core/blueprint.md` for full rules.

---

### Step 10: Present Results

After the skill completes:

```markdown
Setup done.

| Attribute        | Value                       |
| ---------------- | --------------------------- |
| Language         | [Language]                  |
| Framework        | [Framework]                 |
| Key libraries    | [Lib1], [Lib2], [Lib3]      |
| Architecture     | [Architecture pattern]      |
| Strictness       | [Strict/Moderate/Loose]     |

Files written:
- `flow/references/project_analysis.md`
- `.claude/rules/frameworks/[fw]-patterns.md`
- `.claude/rules/libraries/[lib]-patterns.md`
- `.claude/rules/project/project-patterns.md`

Patterns: X component · X schema · X API · X naming · X best practice

Next: review the files in `.claude/rules/`. Then run `/discovery-plan`.
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

**CRITICAL**: This command is now complete. STOP and wait for the user to invoke the next command.

---

## Flow Diagram

```
+----------------------------------------------------+
|                  /setup COMMAND                     |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 1: Validate Context                           |
| - Check for dependency files                       |
| - Check for source directories                     |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 2: Initial Dependency Scan                    |
| - Parse package.json / requirements.txt            |
| - Categorize all dependencies                      |
| - Identify complete stack                          |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 3: Deep Code Analysis                         |
| - Sample files for each library                    |
| - Extract import patterns                          |
| - Extract usage patterns                           |
| - Document naming conventions                      |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 4: Detect Project Conventions                 |
| - File naming conventions                          |
| - Directory structure                              |
| - Import order and aliases                         |
| - Component structure                              |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 5: Research Best Practices                    |
| - Web search for stack best practices              |
| - Compare with project patterns                    |
| - Note recommendations                             |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 6: Check Existing Project Rules               |
| - .claude/rules/                                   |
| - Document conflicts                               |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 7: Ask Confirming Questions (Interactive)     |
| - Switch to Plan mode                              |
| - Present analysis summary                         |
| - Ask 4-6 confirming questions via Questions UI   |
| - Process user responses                           |
| - Switch back to Agent mode                        |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 8: Invoke Setup Skill                         |
| - Generate pattern files based on confirmations    |
| - Create analysis document                         |
| - Update core pattern files                        |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 9: Create Flow Folder Structure               |
| - Create flow/ and subdirectories                  |
| - Add .gitkeep files                               |
+----------------------------------------------------+
                        |
                        v
+----------------------------------------------------+
| Step 10: Present Results                           |
| - Show project profile                             |
| - List files created                               |
| - Show patterns indexed                            |
+----------------------------------------------------+
```

---

## What Gets Indexed

### Per Library/Framework

| Information           | How It's Captured                            |
| --------------------- | -------------------------------------------- |
| Import style          | Read sample files, extract import statements |
| File organization     | Glob search, directory analysis              |
| Naming conventions    | Analyze file names and variable names        |
| Usage patterns        | Read and document 2-3 real examples          |
| Best practices        | Web search + codebase comparison             |
| Anti-patterns         | Web search for common mistakes               |

### Project-Wide

| Information           | How It's Captured                            |
| --------------------- | -------------------------------------------- |
| Directory structure   | Full directory tree analysis                 |
| File naming           | Pattern analysis across all files            |
| Import order          | Sample files, detect consistent ordering     |
| Error handling        | Search for try/catch, error classes          |
| Logging               | Search for logger usage                      |
| Testing patterns      | Read test files, extract patterns            |

---

## Example: Next.js + Zod + Zustand Project

**Detected Stack**:
- Framework: Next.js 14 (App Router)
- Language: TypeScript (strict)
- Validation: Zod
- State: Zustand
- Styling: Tailwind CSS
- Testing: Vitest

**Files Created**:

1. `.claude/rules/frameworks/nextjs-patterns.md`
   - App Router conventions
   - Server vs Client components
   - API route patterns
   - Metadata handling

2. `.claude/rules/libraries/zod-patterns.md`
   - Schema file location (`src/schemas/`)
   - Naming convention (`entitySchema`)
   - Real examples from codebase
   - Type inference patterns

3. `.claude/rules/libraries/zustand-patterns.md`
   - Store file location (`src/stores/`)
   - Store structure pattern
   - Selector patterns
   - Real examples from codebase

4. `.claude/rules/project/project-patterns.md`
   - Directory structure map
   - File naming conventions
   - Import order
   - Component structure
   - Error handling approach

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "project setup" --scope resources`
- `planflow-ai state-query "pattern generation" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                       | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `setup-skill.md`              | Detailed execution logic               |
| `interactive-questions-tool.md` | Questions UI for confirmations       |
| `allowed-patterns.md`         | Core allowed patterns                  |
| `forbidden-patterns.md`       | Core forbidden patterns                |

---

## Global Pattern Sync

After generating pattern files in Step 8, sync **generic** patterns to the global brain at `~/plan-flow/brain/patterns/`.

### What to Sync

| Local Pattern File | Global Target | Sync? |
|---|---|---|
| `.claude/resources/frameworks/<fw>-patterns.md` | `~/plan-flow/brain/patterns/<fw>.md` | Yes — framework best practices are generic |
| `.claude/resources/libraries/<lib>-patterns.md` | `~/plan-flow/brain/patterns/<lib>.md` | Yes — library patterns are generic |
| `.claude/resources/project/project-patterns.md` | — | No — project-specific paths and structure |

### Sync Process

For each framework and library pattern file generated:

1. Check if `~/plan-flow/brain/patterns/<name>.md` already exists
2. **If it does NOT exist**:
   - Copy the pattern file, but strip project-specific file paths and code examples that reference specific project directories
   - Keep generic best practices, conventions, allowed/forbidden patterns
   - Add a `## Projects Using This` section at the bottom: `- [[project-name]]`
3. **If it ALREADY exists**:
   - Read the existing global file
   - Append any NEW sections or patterns not already present (do NOT overwrite existing content — it may contain knowledge from other projects)
   - Add `[[project-name]]` to the `## Projects Using This` section if not already listed
4. Use kebab-case for file names: `nextjs.md`, `typescript.md`, `zod.md`, `react-query.md`

### Example

If setup generates `.claude/resources/frameworks/nextjs-patterns.md`, create or update `~/plan-flow/brain/patterns/nextjs.md` with the generic patterns, linked to the project via `[[project-name]]`.

---

## Brain Capture

After setup completes successfully, append a brain-capture block to the session file. See `.claude/resources/core/brain-capture.md` for processing rules.

**Capture the following**:

```
<!-- brain-capture
skill: setup
feature: project-setup
status: completed
data:
  project_name: [detected project name]
  stack: [language + framework]
  patterns_generated: [count of pattern files created]
  patterns_synced_to_global: [list of global pattern files created/updated]
  files_created: [list of generated files]
-->
```

Write to `~/plan-flow/brain/notes/YYYY-MM-DD.md`, then rebuild `flow/brain/index.md` with `planflow-ai brain index` (the index is generated from the notes — never edit it by hand).

---

## Resource Capture

During this skill's execution, watch for valuable reference materials worth preserving. See `.claude/resources/core/resource-capture.md` for capture rules, file format, and naming conventions.

At natural break points, if you encounter information that could be useful for future development (API specs, architecture notes, config references, domain knowledge, etc.), ask the user: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"

Only save if the user approves. Do not re-ask if declined.

