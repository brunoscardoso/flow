
# Resume Work Skill

## Purpose

Reconstruct full session context from `flow/STATE.md` after a context reset (compaction, new session, crash). This skill reads the unified state file, identifies the active work, cross-references with the plan file, and outputs a structured summary that enables the LLM to resume work seamlessly.

**This skill is read-only** — it does not create, modify, or delete any files.

---

## Restrictions — READ-ONLY

| Allowed Action | Purpose |
|----------------|---------|
| Read `flow/STATE.md` | Parse execution state |
| Read plan files (`flow/plans/`) | Cross-reference progress |
| Read discovery files (`flow/discovery/`) | Context for active discovery |
| Read `flow/.scratchpad.md` | Restore ephemeral notes |
| Read `flow/tasklist.md` | Check task status |

| Forbidden Action | Reason |
|------------------|--------|
| Create/edit any files | Resume is observation-only |
| Run build or test commands | No execution during resume |
| Auto-invoke other skills | User decides next action |
| Modify STATE.md | State persists until actively changed by a skill |

---

## Workflow

### Step 1: Read STATE.md

1. Check if `flow/STATE.md` exists — if not, inform user and stop
2. Read the file and parse all sections:
   - `**Updated**` timestamp
   - `## Execution State` — active skill, plan, phase, task, completed phases
   - `## Decisions` — decisions with rationale
   - `## Blockers` — issues with status
   - `## Files Modified` — changed file paths
   - `## Next Action` — immediate next step

---

### Step 2: Staleness Check

Parse the `**Updated**` timestamp and compare to current time.

| Age | Behavior |
|-----|----------|
| < 24 hours | Continue silently |
| 24-72 hours | Warn: "State is {N} hours old. Context may be outdated." Ask: resume or start fresh? |
| > 72 hours | Strong warning: "State is {N} days old. Recommend starting fresh." Ask: resume or start fresh? |

If user chooses "start fresh":
1. Inform them to delete `flow/STATE.md` manually
2. Stop — do not proceed with resume

---

### Step 3: Read Active Plan

If `Active Plan` references a plan file:

1. Read the plan file from `flow/plans/`
2. Parse phase structure and task checkboxes
3. Cross-reference:
   - STATE.md `Completed Phases` → plan's `[x]` tasks should match
   - STATE.md `Current Phase` → identify exact task position
4. If discrepancies found, note them and trust the plan file

If `Active Plan` is "none", skip this step.

---

### Step 4: Identify Next Task

Based on STATE.md and plan cross-reference:

1. If `Next Action` is set → use it as the recommended next step
2. If `Current Task` is set → resume from that task
3. If `Current Phase` is set but no task → start at the first unchecked task in that phase
4. If no current phase → suggest continuing from the first unchecked phase

---

### Step 5: Output Context Summary

Present a structured summary:

```markdown
## Session Resumed

**Active Skill**: {skill name}
**Active Plan**: `{plan file path}`
**Progress**: Phase {current} of {total} — {phase name}
**Last Updated**: {timestamp} ({relative time})

### Completed Phases
| Phase | Name | Outcome |
|-------|------|---------|
| 1 | Types and Schemas | done |
| 2 | Backend Setup | done |

### Decisions Made
- {decision} — {choice} (reason: {reason})

### Blockers
| Issue | Status | Tried |
|-------|--------|-------|
| {issue} | {status} | {tried} |

### Files Modified ({count})
- `{file1}`
- `{file2}`

### Next Action
> {next action description}

---

Ready to continue. Suggested command: `/execute-plan @{plan-file}`
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| STATE.md missing | Inform user: "No active state found." Stop. |
| Plan file referenced but missing | Warn: "Plan file not found." Show state without plan cross-reference. |
| STATE.md malformed | Parse what's possible, warn about missing sections. |
| Active skill is unknown | Show state as-is, don't suggest a specific command. |
| Scratchpad exists | Mention: "Session scratchpad has notes — read `flow/.scratchpad.md` for context." |

---

## Rules

1. **Read-only** — never modify any files during resume
2. **No auto-chaining** — present summary and stop
3. **Plan file is truth** — if STATE.md and plan disagree, trust the plan
4. **Graceful degradation** — parse what's available, skip missing sections
5. **Staleness gate** — always check timestamp before proceeding
6. **Complement scratchpad** — mention scratchpad if it exists, but don't merge content

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/commands/resume-work.md` | Command file for /resume-work |
| `.claude/resources/core/compaction-guide.md` | What to preserve during compaction |
| `.claude/resources/core/session-scratchpad.md` | Complementary session notes |
| `src/cli/state/state-md-parser.ts` | Programmatic parser for STATE.md |
| `src/cli/state/types.ts` | ExecutionState type definition |
