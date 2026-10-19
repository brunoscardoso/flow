
# Create Contract Skill

## Purpose

Create an **integration contract document** by fetching information from a documentation URL or analyzing a project repository. The contract captures all necessary details for frontend integration including endpoints, schemas, authentication, and usage patterns.

This skill **only produces a markdown file** in `flow/contracts/`. It does NOT:

- Write any code
- Implement any integrations
- Modify source files
- Execute any implementation

---

## Restrictions - CONTRACT CREATION ONLY

This skill is **strictly for creating contract documents**. The process:

1. **Fetches** information from the source URL
2. **Analyzes** the API structure and schemas
3. **Asks** clarifying questions via Interactive Questions Tool
4. **Generates** a contract markdown file

**No code, no implementation, no source file modifications.**

### NEVER Do These Actions

| Forbidden Action                       | Reason                              |
| -------------------------------------- | ----------------------------------- |
| Create/edit source code files          | Contract creation only              |
| Write implementation code              | Contracts describe, not implement   |
| Modify configuration files             | No codebase changes                 |
| Run build or test commands             | No execution commands               |
| Create files outside `flow/contracts/` | Only write contract documents       |

### Allowed Actions

| Allowed Action                         | Purpose                              |
| -------------------------------------- | ------------------------------------ |
| Use Web Search tool                    | Fetch documentation from URLs        |
| Read repository files                  | Analyze API structure                |
| Use Interactive Questions Tool         | Gather requirements from user        |
| Write to `flow/contracts/`             | Save contract document               |
| Read project rule files                | Understand patterns to follow        |

> **Important**: The ONLY writable location is `flow/contracts/`. No source code or other files should be modified.

---

## Inputs

| Input         | Required | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| `source_url`  | Yes      | Documentation URL or repository URL                  |
| `description` | Yes      | What the user wants to integrate on the frontend     |

---

## Workflow

### Step 1: Detect Source Type

Analyze the provided URL to determine the source type:

| Source Type      | Detection                                      |
| ---------------- | ---------------------------------------------- |
| Documentation    | Contains `/docs`, `/api`, swagger, openapi     |
| Repository       | Contains github.com, gitlab.com, bitbucket.org |
| OpenAPI Spec     | Ends with `.json`, `.yaml`, `/swagger`         |

---

### Step 2A: Handle Documentation URL

If the source is a documentation URL:

1. Use Web Search tool to fetch documentation content
2. Extract key information:
   - API endpoints
   - Request/response schemas
   - Authentication methods
   - Error formats
   - Rate limits

---

### Step 2B: Handle Repository URL

If the source is a repository URL:

1. Analyze repository structure
2. Identify relevant files:
   - API route definitions
   - Type definitions
   - Schema files
   - README/docs
3. Read and extract key information

---

### Step 3: Ask Clarifying Questions

**Use Interactive Questions Tool** to gather requirements.

Follow `.claude/resources/tools/interactive-questions-tool.md`:

1. Call `SwitchMode` tool to enter Plan mode
2. Call `AskQuestion` tool for each question about:
   - **Scope**: Which specific endpoints/features are needed?
   - **Authentication**: How will the FE authenticate?
   - **Error Handling**: How should the FE handle errors?
   - **Caching**: Any caching requirements?
3. Wait for all responses
4. Call `SwitchMode` tool to return to Agent mode
5. Document answers for use in the contract document

---

### Step 4: Generate Contract Document

Create the contract with all gathered information:

**Location**: `flow/contracts/<service_name>_contract.md`

**Required Sections**:

1. Overview
2. Authentication
3. Endpoints (with request/response schemas)
4. Error Handling
5. Integration Notes
6. Usage Examples

---

## Output Format

### Contract Template

```markdown
# Integration Contract: [Service Name]

**Project**: [[{project-name}]]

## Overview

**Source**: [URL]
**Description**: [What this integration provides]
**Version**: [API version if applicable]

## Authentication

**Method**: [Bearer token, API key, OAuth, etc.]
**Header**: [Authorization header format]
**Token Source**: [Where FE gets the token]

## Endpoints

### [Endpoint Name]

**Method**: [GET/POST/PUT/DELETE]
**URL**: [Endpoint URL]
**Description**: [What this endpoint does]

**Request**:
\`\`\`typescript
interface RequestBody {
  // Request schema
}
\`\`\`

**Response**:
\`\`\`typescript
interface Response {
  // Response schema
}
\`\`\`

**Example**:
\`\`\`bash
curl -X POST /api/endpoint \
  -H "Authorization: Bearer token" \
  -d '{"field": "value"}'
\`\`\`

## Error Handling

| Status Code | Meaning              | FE Action                 |
| ----------- | -------------------- | ------------------------- |
| 400         | Bad Request          | Show validation error     |
| 401         | Unauthorized         | Redirect to login         |
| 404         | Not Found            | Show not found message    |
| 500         | Server Error         | Show generic error        |

## Integration Notes

### Rate Limits
[Any rate limiting information]

### Caching
[Caching recommendations]

### Pagination
[Pagination format if applicable]

## Usage Examples

### [Use Case 1]
[Code example or description]
```

---

## Validation Checklist

Before completing the contract, verify:

- [ ] Contract is saved in `flow/contracts/` folder
- [ ] File uses naming: `<service_name>_contract.md`
- [ ] All requested endpoints are documented
- [ ] Authentication method is clear
- [ ] Request/response schemas are defined
- [ ] Error handling is documented
- [ ] **NO implementation code is included**
- [ ] **NO source files were created or modified**

---

## Related Files

| File                                               | Purpose                           |
| -------------------------------------------------- | --------------------------------- |
| `.claude/resources/patterns/contract-patterns.md`   | Rules and patterns for contracts  |
| `.claude/resources/tools/interactive-questions-tool.md` | Interactive Questions workflow  |
| `flow/contracts/`                                  | Output folder for contracts       |
