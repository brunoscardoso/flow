
# Resource Capture

## Purpose

During any skill execution, the LLM watches for information that could be valuable for future development and prompts the user before saving it to `flow/resources/`. Resources are reference materials discovered during work — not artifacts of the workflow itself.

**Location**: `flow/resources/`

---

## Behavior

### During Any Skill Execution

While executing any plan-flow skill (`/setup`, `/discovery-plan`, `/create-plan`, `/execute-plan`, `/review-code`, `/review-pr`, `/write-tests`, `/create-contract`, `/note`), watch for information that meets the capture criteria below.

When you identify something worth preserving:

1. **Pause** before moving on
2. **Ask the user**: "I found something that could be useful for future reference: _{brief description}_. Should I save it to `flow/resources/`?"
3. **If the user approves**: Write the file to `flow/resources/{name}.md`
4. **If the user declines**: Continue without saving — do not ask again for the same item

### What to Capture

| Category | Examples | Priority |
|----------|----------|----------|
| API documentation excerpts | Endpoint specs, auth flows, rate limits discovered during contract creation | High |
| Architecture diagrams/notes | System boundaries, data flows, service maps uncovered during discovery | High |
| Configuration references | Complex config patterns, environment variable maps, feature flags | Medium |
| Migration guides | Step-by-step procedures for DB migrations, API version upgrades | Medium |
| Third-party integration notes | SDK quirks, undocumented behavior, workarounds for external services | High |
| Performance benchmarks | Baseline measurements, optimization results, before/after comparisons | Medium |
| Security considerations | Auth flows, permission models, vulnerability notes from code reviews | High |
| Domain knowledge | Business rules, data models, terminology glossaries from discovery | Medium |

### What NOT to Capture

- **Artifacts that belong elsewhere**: Plans go in `flow/plans/`, discoveries in `flow/discovery/`, etc.
- **Generic knowledge**: Standard library docs, common patterns, things easily searchable
- **Temporary debugging info**: Stack traces, one-off error logs, transient state
- **Duplicate information**: Content already in brain entries, ledger, or other flow files
- **Code snippets without context**: Raw code belongs in the codebase, not in resources

---

## File Format

```markdown
# {Resource Title}

**Project**: [[{project-name}]]
**Captured**: {YYYY-MM-DD}
**Source**: {skill that discovered it, e.g., "discovery-plan", "execute-plan phase 3"}
**Category**: {api-docs|architecture|config|migration|integration|performance|security|domain}

## Summary

{One paragraph explaining what this resource is and why it's useful}

## Content

{The actual reference material — formatted for quick scanning}

## Related

- [[{feature-name}]] — {how it relates}
- [[{other-resource}]] — {cross-reference if applicable}
```

### File Naming

- **Format**: `{kebab-case-descriptive-name}.md`
- **Examples**:
  - `stripe-webhook-verification.md`
  - `postgres-jsonb-indexing-strategy.md`
  - `oauth2-pkce-flow-reference.md`
  - `user-permissions-model.md`

---

## Rules

1. **Always ask first**: Never save a resource without user confirmation
2. **One prompt per resource**: Don't batch multiple resources into a single question — ask individually
3. **Don't interrupt flow**: Ask at natural break points (between phases, after a section completes), not mid-thought
4. **Brief ask**: Keep the prompt to one sentence describing what you found and why it matters
5. **No duplicates**: Before suggesting a save, check if `flow/resources/` already has a file covering the same topic
6. **Wiki-link everything**: Include `[[wiki-links]]` to related features, decisions, and other resources for Obsidian graph connectivity
7. **Silent on decline**: If the user says no, move on — don't justify or re-ask
