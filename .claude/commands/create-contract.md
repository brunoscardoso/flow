---
description: This command creates an integration contract document by fetching information from a documentation U
---

# Create Integration Contract

## Command Description

This command creates an integration contract document by fetching information from a documentation URL or analyzing a project repository. The command validates inputs and orchestrates the contract creation process by invoking the `create-contract` skill.

**Output**: A markdown file at `flow/contracts/<service_name>_contract.md`

---


## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/create-contract - Create Integration Contract

DESCRIPTION:
  Creates an integration contract document by fetching information from a
  documentation URL or analyzing a project repository.

USAGE:
  /create-contract <source_url> <description>
  /create-contract -help

ARGUMENTS:
  source_url    Documentation URL (API docs, Swagger, OpenAPI) or repository URL
  description   What you want to integrate on the frontend

EXAMPLES:
  /create-contract https://api.example.com/docs "User authentication endpoints"
  /create-contract https://github.com/org/api-service "Payment processing integration"
  /create-contract @https://swagger.io/spec.json "Order management API"

OUTPUT:
  Creates: flow/contracts/<service_name>_contract.md

WORKFLOW:
  1. Fetches and analyzes the source URL
  2. Asks clarifying questions about scope, auth, error handling
  3. Generates contract document with endpoints, schemas, and integration notes

RECOMMENDED MODEL:
  Claude Opus 4.6 or Sonnet 4.5 for best results

RELATED COMMANDS:
  /discovery-plan    Create discovery document from contract
  /create-plan       Create implementation plan from discovery
```

---

## Critical Rules

| Rule                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| **No Auto-Chaining**     | NEVER auto-invoke /discovery-plan - user must invoke it  |
| **File Only**            | Save the `.md` file and report its path. Do NOT show full content in chat. |
| **Complete and Stop**    | After presenting results, STOP and wait for user         |

---

## Instructions

### Step 1: Validate Inputs

| Input         | Required | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| `source_url`  | Yes      | Documentation URL or repository URL                  |
| `description` | Yes      | What the user wants to integrate on the frontend     |

**Both inputs are required.** If either is missing, ask:

```markdown
To create an integration contract, I need:

1. **Source URL**: Where can I find the API documentation?
   - API docs URL (e.g., https://api.example.com/docs)
   - Swagger/OpenAPI spec URL
   - Repository URL (GitHub, GitLab, etc.)

2. **Description**: What do you want to integrate?
   - Which specific endpoints/features are needed?
   - What's the use case on the frontend?
```

---

### Step 2: Detect Source Type

Analyze the URL to determine source type:

| Source Type    | Detection                                |
| -------------- | ---------------------------------------- |
| Documentation  | Contains `/docs`, `/api`, swagger        |
| Repository     | Contains github.com, gitlab.com          |
| OpenAPI Spec   | Ends with `.json`, `.yaml`               |

---

### Step 3: Invoke Create Contract Skill

The skill will:

1. Fetch information from the source URL
2. Analyze API structure and schemas
3. Ask clarifying questions via Interactive Questions Tool
4. Generate contract document

See: `.claude/resources/skills/create-contract-skill.md`

---

### Step 4: Save File and Stop

After the skill completes:

1. **Save the contract document** to `flow/contracts/<service_name>_contract.md`
2. **Report only the file path** — do NOT display the full contract content in chat
3. **STOP** — do NOT auto-invoke `/discovery-plan`

**Output to the user** (this is the ONLY thing to show):

```markdown
Contract done.
File: `flow/contracts/<service_name>_contract.md`
Next: review the file. Then run `/discovery-plan`.
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

⚠️ **CRITICAL**: After saving the file, the command is DONE. Do NOT:
- Show the full contract content in chat
- Auto-invoke `/discovery-plan`
- Offer to start discovery or planning

The user will read the `.md` file themselves and decide when to proceed.

---

## Flow Diagram

```
+------------------------------------------+
|       /create-contract COMMAND           |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate Inputs                  |
| - Check for source URL and description   |
| - Ask for missing inputs if needed       |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: Detect Source Type               |
| - Documentation, Repository, or OpenAPI  |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Invoke Create Contract Skill     |
| - Skill handles all contract logic       |
| - See create-contract-skill.md          |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Save File and Stop               |
| - Save .md file to flow/contracts/       |
| - Report file path only                  |
| - STOP (no discovery, no plan)           |
+------------------------------------------+
```

---

## Example Usage

**User**: `/create-contract https://api.example.com/docs "User authentication endpoints"`

**Execution**:

1. Validate inputs: URL and description provided
2. Detect source type: Documentation
3. Invoke create-contract skill
4. Present contract summary
5. User reviews and proceeds to `/discovery-plan`

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "contract creation" --scope resources`
- `planflow-ai state-query "contract patterns" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource                       | Purpose                                |
| ------------------------------ | -------------------------------------- |
| `create-contract-skill.md`    | Skill that creates the contract        |
| `contract-patterns.md`        | Rules and patterns for contracts       |
| `interactive-questions-tool.md` | Interactive Questions UI workflow    |
| `/discovery-plan` command      | Create discovery from contract         |
| `/create-plan` command         | Create plan from discovery             |
