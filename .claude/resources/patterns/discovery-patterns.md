
## What is Discovery?

Discovery is a **pre-planning phase** where we:

1. **Gather Information**: Read referenced files, contracts, and documentation
2. **Find Code Context**: Search codebase for all related implementations and dependencies
3. **Ask Questions**: Clarify every unclear aspect with the user
4. **Explore Unknowns**: Investigate technical feasibility and constraints
5. **Document Findings**: Create a comprehensive discovery document
6. **Prepare for Planning**: Provide all context needed to create an implementation plan

**Workflow**: Discovery Output → Implementation Plan → Execution

---

## Folder Structure

```
flow/
├── archive/                    # IGNORE - Completed/abandoned documents
├── discovery/                  # Active discovery documents
│   ├── discovery_user_auth_v1.md
│   ├── discovery_realtime_notifications_v1.md
│   └── spike_streaming_performance_v1.md
├── plans/                      # Implementation plans (created after discovery)
│   └── plan_feature_v1.md
├── contracts/                  # Integration contracts
│   └── api_contract.md
└── references/                 # Reference materials (specs, designs)
    ├── api-specs.md
    └── sse-events.md
```

**Critical**: NEVER read or reference files in `flow/archive/` - these are outdated documents.

---

## Naming Conventions

| Prefix       | Purpose                   | When to Use                            |
| ------------ | ------------------------- | -------------------------------------- |
| `discovery_` | General feature discovery | Exploring a new feature or enhancement |
| `spike_`     | Technical investigation   | Testing technical feasibility          |
| `research_`  | In-depth research         | Comparing options or technologies      |

**Format**: `<prefix>_<topic>_v<version>.md`

**Examples**:

- `discovery_workflow_editor_v1.md`
- `spike_sse_performance_v1.md`
- `research_state_management_v1.md`

---

## Question Status Tracking

Track every question with a clear status:

| Status   | Meaning                                       | Action Required          |
| -------- | --------------------------------------------- | ------------------------ |
| Open     | Waiting for user response                     | Wait for answer          |
| Answered | User provided answer                          | Document in requirements |
| Assumed  | Made reasonable assumption (needs validation) | Request validation       |
| Blocked  | Cannot proceed without answer                 | Escalate to user         |

**Question Table Format**:

```markdown
| #   | Category   | Question                   | Status   | Answer            |
| --- | ---------- | -------------------------- | -------- | ----------------- |
| 1   | Functional | Max steps per workflow?    | Answered | 20 steps maximum  |
| 2   | Technical  | Use existing store or new? | Open     | -                 |
| 3   | NFR        | Required response time?    | Assumed  | <500ms (validate) |
```

---

## Requirements Categories

Categorize all gathered requirements:

| Category    | Prefix | Description                               |
| ----------- | ------ | ----------------------------------------- |
| Functional  | FR-    | What the feature must do                  |
| Non-Functional | NFR- | Performance, security, scalability        |
| Constraints | C-     | Limitations, dependencies, boundaries     |
| Acceptance  | AC-    | How we know the feature is complete       |

**Format**:

```markdown
- [FR-1]: Users can create workflow steps with title and content
- [NFR-1]: Step creation should complete within 500ms
- [C-1]: Must use existing authentication flow
```

---

## Allowed Patterns

### 1. Read All Referenced Documents First

**Always** read every referenced document before asking questions.

**Process**:

1. Identify referenced files (look for @mentions, file paths)
2. Read all referenced files using the Read tool
3. Extract relevant requirements, constraints, contracts
4. Document findings with key points
5. Then ask questions about gaps or unclear aspects

---

### 2. Find All Related Code References

**Before proceeding with discovery**, search the codebase to find **all code locations** related to the feature being discovered.

**Why**: Understanding where a feature is currently used prevents incomplete implementations and reveals hidden dependencies.

**Process**:

1. **Identify key terms** from the user's request (e.g., "user profile", "workflow editor", "authentication")
2. **Search for code references** using Grep:
   - Component names
   - Function names
   - Type definitions
   - API endpoints
   - Database models
   - Store actions/selectors
3. **Search for file patterns** using Glob:
   - Related component directories
   - Test files for the feature
   - API route files
4. **Document all findings** in the "Code Context Analysis" section of the discovery document
5. **Read key files** to understand current implementation patterns

**Example Search Strategy**:

For a request like "edit user profile":

```bash
# Search for components/functions
Grep: "UserProfile|userProfile|user-profile"
      --output_mode content --type ts --type tsx

# Search for types
Grep: "interface.*User|type.*User"
      --output_mode content --type ts

# Search for API routes
Glob: "**/api/**/user*/**" or "**/api/**/profile*/**"

# Search for stores
Grep: "userStore|profileStore|useUser"
      --output_mode content --type ts

# Search for tests
Glob: "**/*user*.test.ts*" or "**/*profile*.test.ts*"
```

**Document Format in Discovery**:

```markdown
## Code Context Analysis

### Components Found
| File | Usage | Line(s) |
|------|-------|---------|
| `src/components/UserProfile.tsx` | Main profile component | - |
| `src/components/Settings/ProfileSettings.tsx` | Settings page usage | - |
| `src/components/Dashboard/UserCard.tsx` | Dashboard card | - |

### API Endpoints Found
| File | Endpoint | Method |
|------|----------|--------|
| `src/app/api/user/profile/route.ts` | `/api/user/profile` | GET, PUT |
| `src/app/api/user/avatar/route.ts` | `/api/user/avatar` | POST |

### State Management Found
| File | Purpose |
|------|---------|
| `src/stores/userStore.ts` | User profile state |
| `src/stores/authStore.ts` | Authentication state (includes profile data) |

### Type Definitions Found
| File | Types |
|------|-------|
| `src/types/user.ts` | `User`, `UserProfile`, `UpdateProfileInput` |

### Total References: 12 files across 5 categories
```

**Benefits**:

- **Complete Context**: Know all places where changes will have impact
- **Prevent Breaking Changes**: Identify all consumers before making modifications
- **Better Estimates**: Understand full scope for complexity scoring
- **Pattern Discovery**: Learn existing patterns from actual usage
- **Test Coverage**: Find existing tests that need updates

---

### 3. Ask Questions Using Interactive Questions Tool

**Use Plan mode's Questions UI** for a better user experience.

**Process**:

1. Call `SwitchMode` tool to enter Plan mode
2. Call `AskQuestion` tool for each question
3. Wait for responses
4. Call `SwitchMode` tool to return to Agent mode

See `.claude/resources/tools/interactive-questions-tool.md` for detailed instructions.

**Question Format**:

- Use 2-6 multiple-choice options per question
- Label options with A, B, C, D, E, F
- Provide context in the explanation parameter
- Ask all questions in one Plan mode session

---

### 4. Structure Discovery Documents Consistently

Every discovery document must include these sections:

| Section                  | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| Context                  | Why this discovery is needed               |
| Referenced Documents     | Documents reviewed with key findings       |
| Requirements Gathered    | FR, NFR, Constraints categorized           |
| Open Questions           | Tracked with status                        |
| Technical Considerations | Architecture, dependencies, patterns       |
| Proposed Approach        | High-level recommendation (NOT code)       |
| Risks and Unknowns       | Identified risks with mitigation           |
| Next Steps               | Follow-up actions linking to `/create-plan` |

See `.claude/resources/patterns/discovery-templates.md` for the full template.

---

### 5. Mark Assumptions Explicitly

When making assumptions, always mark them clearly:

```markdown
| 3 | NFR | Required response time? | Assumed | <500ms (needs validation) |
```

**Process**:

1. Mark with "Assumed" status
2. Note the assumption clearly
3. Request validation from user
4. Update to "Answered" once confirmed

---

### 6. Keep Discovery High-Level

Focus on "what" not "how". Discovery captures:

- **What** the feature should do
- **What** constraints exist
- **What** risks are present
- **What** approach is recommended

Implementation details belong in the plan, not discovery.

---

### 7. Link Discovery to Plan

When discovery is complete:

1. Reference the discovery document in the plan's Overview
2. Move discovery to `flow/archive/` after plan execution — with its `.walkthrough.html` page beside it, when present

```markdown
## Overview

This plan implements the feature described in the discovery document:
`flow/discovery/discovery_workflow_editor_v1.md`
```

---

## Forbidden Patterns

### 1. DON'T Skip Reading Referenced Documents

**Problem**: Making assumptions without reviewing available context leads to incorrect implementations.

**Fix**: Always read referenced files before asking questions.

---

### 2. DON'T Make Assumptions Without Marking Them

**Problem**: Assumptions presented as facts cause incorrect implementations.

**Fix**: Mark assumptions with "Assumed" status and request validation.

---

### 3. DON'T Create Plans Without Discovery for Complex Features

**Problem**: Jumping to planning without understanding leads to rework.

**Fix**: For features with unknowns, always do discovery first.

---

### 4. DON'T Proceed with Blocked Questions

**Problem**: Moving forward with unresolved blockers creates problems later.

**Fix**: Resolve blocked questions before proposing approach.

---

### 5. DON'T Mix Discovery Documents with Plans

**Problem**: Confusion about document purpose.

**Fix**: Keep discovery in `flow/discovery/`, plans in `flow/plans/`.

---

### 6. DON'T Write Implementation Details in Discovery

**Problem**: Discovery should focus on "what", not "how".

**Fix**: Keep discovery at the conceptual level. Implementation belongs in the plan.

---

### 7. DON'T Write Code During Discovery

**Problem**: Discovery is for gathering information, not implementing.

**Forbidden Actions**:

- Creating or editing source files (`.ts`, `.tsx`, `.js`, etc.)
- Modifying configuration files
- Running code generation commands
- Making any changes to the codebase
- Writing implementation code in responses

**Allowed Actions**:

- Reading files to understand current implementation
- Searching codebase for context
- Asking questions
- Creating the discovery markdown document

---

### 8. DON'T Create Discovery for Trivial Features

**Problem**: Overhead without value for simple changes.

**When to Skip Discovery**:

- Single-file changes
- Clear, well-defined requirements
- No unknowns or ambiguity
- Similar to existing implementations

**Fix**: Use discovery only when there's genuine uncertainty to resolve.

---

## When to Ask vs. When to Document

### ASK When:

- Requirements are vague or ambiguous
- Technical approach is unclear
- Multiple valid interpretations exist
- Dependencies or constraints are unknown
- Acceptance criteria are not defined
- Edge cases are not specified

### DOCUMENT When:

- Information is clear in referenced documents
- User has provided explicit answer
- Standard pattern applies (per project rules)
- Similar feature exists in codebase
- Assumption has been validated

---

## Discovery Document Output

The discovery document is the **ONLY** deliverable. It must be:

1. **Saved** in `flow/discovery/` folder
2. **Named** using convention: `discovery_<feature>_v<version>.md`
3. **Complete** with all required sections
4. **Reviewed** by user before plan creation
5. **Linked** to the implementation plan

---

## Related Resources

- **Command**: `/discovery-plan` - Orchestrates the discovery workflow
- **Templates**: `.claude/resources/patterns/discovery-templates.md`
- **Interactive Questions**: `.claude/resources/tools/interactive-questions-tool.md`
- **Plan Command**: `/create-plan` - Creates plan from discovery

---

## Summary

| Pattern                        | Description                                    |
| ------------------------------ | ---------------------------------------------- |
| Read documents first           | Always review referenced files before asking   |
| Find all code references       | Search codebase for all related implementations|
| Use interactive questions      | Plan mode Questions UI for better UX           |
| Structure consistently         | Follow the standard discovery template         |
| Mark assumptions               | Always label and validate assumptions          |
| Stay high-level                | Focus on "what" not "how"                      |
| Link to plan                   | Reference discovery in plan overview           |
| No code                        | Only create the discovery markdown file        |
| Skip for trivial features      | Don't over-engineer simple changes             |
