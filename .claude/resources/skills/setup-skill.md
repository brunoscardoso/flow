
# Setup Skill

## Purpose

Perform deep analysis of the current repository to index languages, frameworks, architecture patterns, and coding conventions. Generate comprehensive, actionable pattern files based on real code samples and industry best practices.

This skill produces:
- Project analysis document in `flow/references/`
- Framework pattern files with real examples in `.claude/resources/frameworks/`
- Library pattern files with usage examples in `.claude/resources/libraries/`
- Project-specific patterns in `.claude/resources/project/`
- Updated core pattern files

---

## Critical Approach

**This is NOT a surface-level scan.** The setup skill must:

1. **Sample Real Code** - Read actual files to understand how patterns are implemented
2. **Extract Real Examples** - Use code snippets from the project as pattern examples
3. **Research Best Practices** - Use web search to get current best practices for the stack
4. **Detect Conventions** - Identify naming, file structure, and coding conventions
5. **Create Actionable Patterns** - Generate patterns that can be directly followed

---

## Workflow

### Step 1: Scan Project Structure

Analyze the repository root to identify project type and structure.

**Files to Check**:

| File                    | Indicates                                    |
| ----------------------- | -------------------------------------------- |
| `package.json`          | JavaScript/TypeScript project                |
| `requirements.txt`      | Python project                               |
| `pyproject.toml`        | Python project (modern)                      |
| `Cargo.toml`            | Rust project                                 |
| `go.mod`                | Go project                                   |
| `pom.xml`               | Java/Maven project                           |
| `build.gradle`          | Java/Kotlin Gradle project                   |
| `Gemfile`               | Ruby project                                 |
| `*.csproj`              | C#/.NET project                              |

**Actions**:

1. List root directory files
2. Identify primary language from dependency files
3. Read dependency files completely to extract ALL libraries
4. Map directory structure (up to 3 levels deep)

---

### Step 2: Deep Dependency Analysis

Read and parse dependency files to build complete stack profile.

#### For JavaScript/TypeScript (package.json)

**Core Framework Detection**:

| Dependency             | Framework              | Pattern File to Create           |
| ---------------------- | ---------------------- | -------------------------------- |
| `next`                 | Next.js                | `nextjs-patterns.md`             |
| `react`                | React                  | `react-patterns.md`              |
| `vue`                  | Vue.js                 | `vue-patterns.md`                |
| `@angular/core`        | Angular                | `angular-patterns.md`            |
| `express`              | Express.js             | `express-patterns.md`            |
| `fastify`              | Fastify                | `fastify-patterns.md`            |
| `hono`                 | Hono                   | `hono-patterns.md`               |
| `@nestjs/core`         | NestJS                 | `nestjs-patterns.md`             |

**Library Detection** (create individual pattern files):

| Category               | Libraries              | Pattern File                     |
| ---------------------- | ---------------------- | -------------------------------- |
| Validation             | `zod`, `yup`, `joi`    | `<lib>-patterns.md`              |
| State Management       | `zustand`, `redux`, `jotai`, `recoil` | `<lib>-patterns.md` |
| Data Fetching          | `@tanstack/react-query`, `swr`, `axios` | `<lib>-patterns.md` |
| ORM/Database           | `prisma`, `drizzle-orm`, `typeorm` | `<lib>-patterns.md`  |
| Authentication         | `next-auth`, `clerk`, `lucia` | `<lib>-patterns.md`       |
| Styling                | `tailwindcss`, `styled-components` | `<lib>-patterns.md`  |
| Testing                | `jest`, `vitest`, `playwright` | `<lib>-patterns.md`      |
| Forms                  | `react-hook-form`, `formik` | `<lib>-patterns.md`        |
| UI Components          | `shadcn/ui`, `radix-ui`, `mantine` | `<lib>-patterns.md`  |

#### For Python (requirements.txt / pyproject.toml)

| Category               | Libraries              | Pattern File                     |
| ---------------------- | ---------------------- | -------------------------------- |
| Web Framework          | `fastapi`, `django`, `flask` | `<lib>-patterns.md`       |
| Validation             | `pydantic`             | `pydantic-patterns.md`           |
| ORM                    | `sqlalchemy`, `tortoise-orm` | `<lib>-patterns.md`       |
| Testing                | `pytest`, `unittest`   | `<lib>-patterns.md`              |
| Task Queue             | `celery`, `rq`         | `<lib>-patterns.md`              |
| HTTP Client            | `httpx`, `aiohttp`     | `<lib>-patterns.md`              |

---

### Step 3: Deep Code Analysis

**CRITICAL**: This step samples actual code to understand HOW the project uses each library.

#### 3.1 Sample Files by Type

For each detected library/framework, find and read sample files:

```
For Next.js:
- Read 2-3 files from app/ or pages/
- Read 2-3 API routes
- Read layout files
- Read middleware if exists

For React:
- Read 3-5 component files
- Read custom hooks
- Read context providers

For Zod:
- Search for .schema.ts files
- Search for files importing 'zod'
- Extract schema definition patterns

For Prisma:
- Read prisma/schema.prisma
- Search for files importing @prisma/client
- Extract query patterns

For Zustand:
- Search for store files
- Extract store structure patterns
```

#### 3.2 Extract Real Patterns

For each library, document:

1. **Import Style**
   ```typescript
   // How does the project import this library?
   import { z } from 'zod'  // Named import
   import prisma from '@/lib/prisma'  // Default import from lib
   ```

2. **File Organization**
   ```
   // Where are files for this library located?
   src/schemas/*.ts     - Zod schemas
   src/stores/*.ts      - Zustand stores
   prisma/schema.prisma - Prisma schema
   ```

3. **Naming Conventions**
   ```typescript
   // How are things named?
   userSchema, createUserSchema  // Schemas: camelCase + Schema suffix
   useUserStore, useCartStore    // Stores: use + Name + Store
   ```

4. **Usage Patterns**
   ```typescript
   // How is the library typically used?
   // Extract 2-3 real examples from the codebase
   ```

#### 3.3 Detect Project Conventions

**File Naming**:
- Analyze file names in src/ to detect: kebab-case, camelCase, PascalCase
- Check for patterns like: `*.schema.ts`, `*.store.ts`, `*.hook.ts`

**Directory Structure**:
- Map the src/ directory structure
- Identify organization: feature-based, layer-based, hybrid

**Import Patterns**:
- Check tsconfig.json for path aliases (e.g., `@/`, `~/`)
- Detect barrel exports (index.ts files)

**Component Structure**:
- Check for co-located files (Component.tsx, Component.test.tsx, Component.module.css)
- Check for separated files (components/, tests/, styles/)

**Error Handling**:
- Search for try/catch patterns
- Identify custom error classes
- Check for error boundary usage

**Logging**:
- Search for console.log, logger imports
- Identify logging library if any

---

### Step 4: Research Best Practices

**Use web search to get current best practices for detected stack.**

For each major library/framework detected:

1. Search for: `"[library] best practices 2025"` or `"[library] patterns"`
2. Search for: `"[library] common mistakes to avoid"`
3. Compare project patterns with industry standards

**Example Searches**:
- "Next.js App Router best practices 2025"
- "Zod schema validation patterns"
- "Zustand store organization patterns"
- "Prisma query optimization patterns"

**Document**:
- Best practices the project already follows
- Best practices the project should adopt
- Anti-patterns to avoid

---

### Step 5: Check Existing Rules

Look for existing rule configuration:

**Locations to Check**:

1. `.claude/rules/` - Custom rules directory

**Actions**:

1. If `.claude/rules/` exists:
   - Read all `.md` files
   - Extract patterns and conventions
   - Note which patterns are already defined
   - Identify conflicts with detected patterns

2. Create inventory of existing rules

---

### Step 6: Ask Confirming Questions

Use Plan Mode to ask targeted questions about detected patterns.

**Switch to Plan mode and present findings first:**

```markdown
## Project Analysis Results

I analyzed your codebase and detected:

**Stack**: [Language] + [Framework]
**Key Libraries**: [List]
**Architecture**: [Pattern]

**Code Patterns Detected**:
1. [Pattern with example]
2. [Pattern with example]
3. [Pattern with example]

**Conventions Detected**:
- File naming: [convention]
- Component structure: [convention]
- Import style: [convention]
```

**Then ask questions:**

#### Question 1: Stack Confirmation

```
Is this stack detection accurate?

A. Yes, this is correct
B. Partially correct - I'll specify what's different
C. No, let me describe the stack
```

#### Question 2: Pattern Confirmation

```
I detected these coding patterns. Which should I enforce?

A. All detected patterns - they represent our standards
B. Let me review and select which to keep
C. These are legacy patterns - I'll describe our preferred patterns
```

#### Question 3: Strictness Level

```
How strictly should I enforce these patterns?

A. Strict - Always follow these patterns exactly
B. Moderate - Follow patterns but allow exceptions with justification
C. Loose - Use as guidelines, not requirements
```

#### Question 4: Best Practices Integration

```
I found some industry best practices your codebase could adopt. Should I:

A. Include them in pattern files as recommendations
B. Only document current patterns, no new recommendations
C. Show me the recommendations first
```

#### Question 5: Existing Rules

(Only if existing rules found)

```
I found existing rules. How should I handle them?

A. Merge with new patterns (combine both)
B. Replace with new patterns
C. Keep existing, add new patterns separately
D. Let me review the conflicts
```

---

### Step 7: Generate Pattern Files

Create comprehensive pattern files based on confirmed patterns.

#### 7.1 Framework Pattern File

**Location**: `.claude/resources/frameworks/<framework>-patterns.md`

**Template**:

```markdown
# [Framework] Patterns

## Project Usage

This project uses [Framework] with [specific configuration].

**Detected Configuration**:
- [Config item 1]
- [Config item 2]

---

## File Organization

| Type | Location | Naming |
|------|----------|--------|
| [Type] | [Path] | [Convention] |

---

## Allowed Patterns

### [Pattern Category 1]

**Description**: [What this pattern does]

**Example from this codebase**:

\`\`\`typescript
// From: [actual file path]
[Real code example from project]
\`\`\`

**Guidelines**:
- [Guideline 1]
- [Guideline 2]

### [Pattern Category 2]

[Same structure...]

---

## Forbidden Patterns

### DON'T: [Anti-pattern name]

**Problem**: [Why this is bad]

\`\`\`typescript
// BAD
[Example of what not to do]

// GOOD
[Example of correct approach]
\`\`\`

---

## Best Practices

### [Best Practice 1]

[Description with example]

### [Best Practice 2]

[Description with example]
```

#### 7.2 Library Pattern Files

**Location**: `.claude/resources/libraries/<library>-patterns.md`

Create for each significant library with:

1. How the project imports it
2. Where related files are located
3. Naming conventions for this library
4. 2-3 real usage examples from the codebase
5. Common mistakes to avoid

**Example for Zod**:

```markdown
# Zod Patterns

## Project Usage

Schemas are located in `src/schemas/` and follow `[entity]Schema` naming.

## Import Pattern

\`\`\`typescript
import { z } from 'zod'
\`\`\`

## Schema Definition

\`\`\`typescript
// From: src/schemas/user.schema.ts
export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(100),
})

export type User = z.infer<typeof userSchema>
\`\`\`

## Allowed Patterns

### Schema Naming
- Use `[entity]Schema` for main schemas
- Use `create[Entity]Schema` for creation schemas
- Use `update[Entity]Schema` for update schemas

### Type Inference
- Always export inferred types alongside schemas
- Use `z.infer<typeof schema>` pattern

## Forbidden Patterns

### DON'T: Define schemas inline
\`\`\`typescript
// BAD - Schema defined inline
const data = z.object({ name: z.string() }).parse(input)

// GOOD - Schema defined and exported
import { userSchema } from '@/schemas/user.schema'
const data = userSchema.parse(input)
\`\`\`
```

#### 7.3 Project Patterns File

**Location**: `.claude/resources/project/project-patterns.md`

Document project-specific conventions:

```markdown
# Project Patterns

## Directory Structure

\`\`\`
src/
├── app/              # Next.js App Router pages
├── components/       # React components
│   ├── ui/          # UI primitives (buttons, inputs)
│   └── features/    # Feature-specific components
├── hooks/           # Custom React hooks
├── lib/             # Utility functions and clients
├── schemas/         # Zod validation schemas
├── stores/          # Zustand state stores
├── types/           # TypeScript type definitions
└── services/        # API service functions
\`\`\`

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| Components | PascalCase | `UserProfile.tsx` |
| Hooks | camelCase with use prefix | `useAuth.ts` |
| Schemas | camelCase with .schema suffix | `user.schema.ts` |
| Stores | camelCase with .store suffix | `cart.store.ts` |
| Utils | camelCase | `formatDate.ts` |

## Import Order

\`\`\`typescript
// 1. React/Framework imports
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

// 2. Third-party libraries
import { z } from 'zod'
import { useQuery } from '@tanstack/react-query'

// 3. Internal imports (absolute)
import { Button } from '@/components/ui/button'
import { userSchema } from '@/schemas/user.schema'

// 4. Relative imports
import { formatDate } from './utils'
import type { UserProps } from './types'
\`\`\`

## Component Structure

\`\`\`typescript
// Standard component structure in this project

// 1. Imports (ordered as above)

// 2. Types/Interfaces
interface ComponentProps {
  // Props definition
}

// 3. Component
export function Component({ prop1, prop2 }: ComponentProps) {
  // 4. Hooks first
  const [state, setState] = useState()

  // 5. Derived state
  const computed = useMemo(() => ..., [deps])

  // 6. Effects
  useEffect(() => { ... }, [deps])

  // 7. Handlers
  const handleClick = () => { ... }

  // 8. Render
  return (...)
}
\`\`\`

## Error Handling

[Detected error handling patterns]

## API Patterns

[Detected API call patterns]
```

---

### Step 8: Update Core Pattern Files

Integrate project-specific patterns into core files.

**Update `allowed-patterns.md`**:

Add a section at the end:

```markdown
---

## Project-Specific Patterns

The following patterns are specific to this project's stack:

### [Framework] Patterns
See: `.claude/resources/frameworks/[framework]-patterns.md`

### Library Patterns
See: `.claude/resources/libraries/` for individual library patterns

### Project Conventions
See: `.claude/resources/project/project-patterns.md`
```

**Update `forbidden-patterns.md`**:

Add detected anti-patterns specific to the project's stack.

---

### Step 9: Sync Generic Patterns to Global Brain

**Sync reusable patterns to `~/plan-flow/brain/patterns/` so they are available to all projects.**

For each framework and library pattern file generated in Steps 7.1 and 7.2:

#### 9.1 Determine If Pattern Is Generic

| Pattern Type | Generic? | Reason |
|---|---|---|
| Framework patterns (`.claude/resources/frameworks/`) | Yes | Best practices apply to any project using the framework |
| Library patterns (`.claude/resources/libraries/`) | Yes | Import styles, naming, anti-patterns are universal |
| Project patterns (`.claude/resources/project/`) | No | Contains project-specific paths and structure |

#### 9.2 Sync Each Generic Pattern

For each generic pattern file:

1. Derive the global file name: strip `-patterns` suffix, use kebab-case → `~/plan-flow/brain/patterns/<name>.md`
   - `nextjs-patterns.md` → `nextjs.md`
   - `zod-patterns.md` → `zod.md`
   - `react-query-patterns.md` → `react-query.md`

2. **If global file does NOT exist**:
   - Create it from the local pattern file
   - Remove project-specific file paths from code examples (e.g., `// From: src/schemas/user.schema.ts`)
   - Keep generic best practices, allowed/forbidden patterns, and guidelines
   - Add `## Projects Using This` section at the bottom with `- [[project-name]]`

3. **If global file ALREADY exists**:
   - Read the existing global file
   - Compare sections — append any NEW patterns or best practices not already present
   - Do NOT overwrite or duplicate existing content
   - Add `[[project-name]]` to `## Projects Using This` if not already listed

#### 9.3 Report Synced Patterns

```markdown
## Global Brain Patterns Synced

| Pattern | Global Path | Action |
|---------|-------------|--------|
| [Next.js] | `~/plan-flow/brain/patterns/nextjs.md` | Created |
| [Zod] | `~/plan-flow/brain/patterns/zod.md` | Updated (added project link) |
| [Zustand] | `~/plan-flow/brain/patterns/zustand.md` | Created |
```

---

### Step 10: Create Project Analysis Document

**Location**: `flow/references/project_analysis.md`

Create comprehensive analysis:

```markdown
# Project Analysis

Generated: [Date]

## Stack Overview

| Attribute          | Value                                        |
| ------------------ | -------------------------------------------- |
| Primary Language   | [Language]                                   |
| Framework          | [Framework + Version]                        |
| Package Manager    | [npm/yarn/pnpm/pip/poetry]                   |
| Testing Framework  | [Jest/Vitest/Pytest]                         |
| Architecture       | [Feature-based/Layer-based/etc.]             |
| TypeScript         | [Yes/No + strict mode?]                      |

## Dependencies

### Core Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| [pkg] | [ver] | [purpose] |

### Dev Dependencies
| Package | Version | Purpose |
|---------|---------|---------|
| [pkg] | [ver] | [purpose] |

## Architecture Analysis

### Directory Structure
[Full directory tree with annotations]

### Code Organization
- [Pattern 1]: [Description]
- [Pattern 2]: [Description]

## Detected Patterns

### Framework Patterns
[List with examples]

### Library Patterns
[List with examples]

### Coding Conventions
[List with examples]

## Generated Pattern Files

| File | Purpose |
|------|---------|
| [path] | [description] |

## Recommendations

### Already Following Best Practices
- [Practice 1]
- [Practice 2]

### Suggested Improvements
- [Improvement 1]
- [Improvement 2]
```

---

### Step 11: Index Documentation Files

**Automatically index markdown documentation files in the project.**

This step scans for documentation folders and creates `_index.md` files with USR- reference codes for on-demand access.

#### 10.1 Detect Documentation Folders

Search for common documentation folder names in the project root:

| Folder Name      | Priority |
| ---------------- | -------- |
| `docs/`          | Primary  |
| `documentation/` | Primary  |

**Actions**:

1. Check if `docs/` or `documentation/` folder exists at project root
2. If neither exists, skip this step silently (no error)
3. If found, proceed to scan for markdown files

#### 10.2 Scan Markdown Files

For each detected documentation folder:

1. List all `.md` files in the folder (non-recursive, top-level only)
2. Limit to first 50 files (warn if more exist)
3. For each file, extract a brief description:
   - Read first 10 lines of the file
   - Use the first heading (`# Title`) as description
   - If no heading, use the first non-empty paragraph
   - If neither, use the filename as fallback

#### 10.3 Generate Index File

Create `_index.md` in each documentation folder.

**Location**: `docs/_index.md` or `documentation/_index.md`

**Template**:

```markdown
# Documentation Index

## Overview

Project documentation files. Use reference codes to access specific documents.

**Total Files**: X files

---

## Reference Codes

| Code  | File            | Description                          |
| ----- | --------------- | ------------------------------------ |
| USR-1 | README.md       | [Extracted description]              |
| USR-2 | api-guide.md    | [Extracted description]              |
| USR-3 | contributing.md | [Extracted description]              |

---

## When to Expand

| Code  | Expand When                              |
| ----- | ---------------------------------------- |
| USR-1 | Need project overview or getting started |
| USR-2 | Working with API integration             |
```

**Reference Code Convention**:

- Use `USR-` prefix for all user documentation
- Number sequentially: USR-1, USR-2, USR-3, etc.
- Keep codes stable (don't renumber on updates)

#### 10.4 Handle Edge Cases

| Scenario                    | Action                                      |
| --------------------------- | ------------------------------------------- |
| No docs folder exists       | Skip silently, no error                     |
| Empty docs folder           | Skip silently, no error                     |
| More than 50 files          | Index first 50, add warning in index file   |
| File without clear heading  | Use filename as description                 |
| Existing `_index.md`        | Overwrite with fresh index                  |
| Nested folders              | Only index top-level files (not recursive)  |

---

### Step 12: Create Flow Folder Structure

**Create the `flow/` directory structure for plan-flow artifacts.**

If the `flow/` folder doesn't exist, create it with all subdirectories:

```bash
mkdir -p flow/archive
mkdir -p flow/contracts
mkdir -p flow/discovery
mkdir -p flow/plans
mkdir -p flow/references
mkdir -p flow/reviewed-code
mkdir -p flow/reviewed-pr
```

**Add `.gitkeep` files to preserve empty directories**:

```bash
touch flow/archive/.gitkeep
touch flow/contracts/.gitkeep
touch flow/discovery/.gitkeep
touch flow/plans/.gitkeep
touch flow/references/.gitkeep
touch flow/reviewed-code/.gitkeep
touch flow/reviewed-pr/.gitkeep
```

**Directory Purposes**:

| Directory          | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `flow/archive/`    | Completed/abandoned plans and documents              |
| `flow/contracts/`  | Integration contract documents                       |
| `flow/discovery/`  | Discovery and research documents                     |
| `flow/plans/`      | Active implementation plans                          |
| `flow/references/` | Reference materials (including project_analysis.md)  |
| `flow/reviewed-code/` | Local code review documents                       |
| `flow/reviewed-pr/`   | Pull request review documents                     |

**Note**: If the directories already exist, skip creation silently.

---

### Step 13: Present Setup Summary

```markdown
Setup Complete!

## Project Profile

| Attribute          | Value                                        |
| ------------------ | -------------------------------------------- |
| Primary Language   | [Language]                                   |
| Framework          | [Framework]                                  |
| Key Libraries      | [Lib1], [Lib2], [Lib3]                       |
| Architecture       | [Architecture pattern]                       |
| Strictness         | [Strict/Moderate/Loose]                      |

## Folder Structure Created

\`\`\`
flow/
├── archive/           # Completed/abandoned plans
├── contracts/         # Integration contracts
├── discovery/         # Discovery documents
├── plans/             # Active implementation plans
├── references/        # Reference materials
├── reviewed-code/     # Local code review documents
└── reviewed-pr/       # PR review documents
\`\`\`

## Pattern Files Created

| File                                           | Patterns Documented |
| ---------------------------------------------- | ------------------- |
| `flow/references/project_analysis.md`          | Project analysis    |
| `.claude/resources/frameworks/[fw]-patterns.md` | X patterns          |
| `.claude/resources/libraries/[lib]-patterns.md` | X patterns each     |
| `.claude/resources/project/project-patterns.md` | X conventions       |

## Code Samples Indexed

- X component patterns extracted
- X schema patterns documented
- X API patterns captured
- X naming conventions identified

## Global Brain Patterns Synced

| Pattern | Action |
|---------|--------|
| `~/plan-flow/brain/patterns/[fw].md` | Created/Updated |
| `~/plan-flow/brain/patterns/[lib].md` | Created/Updated |

*Generic patterns are shared across all projects via the central vault.*

## Documentation Indexed

| Folder | Files | Index Created |
| ------ | ----- | ------------- |
| `docs/` | X files | `docs/_index.md` |

*Use USR-1, USR-2, etc. reference codes to access documentation on-demand.*

## Next Steps (user must invoke manually)

1. Review generated pattern files in `.claude/resources/`
2. Adjust any patterns that don't match your preferences
3. Start using plan-flow commands:
   - `/discovery-plan` - Explore a new feature
   - `/create-plan` - Create implementation plans
   - `/review-code` - Review local changes
```

---

## Pattern Quality Checklist

Before completing setup, verify each pattern file:

- [ ] Contains real code examples from the project
- [ ] Includes file paths where patterns are used
- [ ] Documents naming conventions with examples
- [ ] Lists what to do AND what not to do
- [ ] Uses consistent formatting
- [ ] Globs correctly match relevant files
- [ ] Description enables agent to know when to include

---

## Related Files

| File                                           | Purpose                           |
| ---------------------------------------------- | --------------------------------- |
| `.claude/rules/core/allowed-patterns.md`       | Core allowed patterns             |
| `.claude/rules/core/forbidden-patterns.md`     | Core forbidden patterns           |
| `.claude/resources/tools/interactive-questions-tool.md` | Questions UI                |
| `flow/references/project_analysis.md`          | Analysis output                   |
