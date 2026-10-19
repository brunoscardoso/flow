# Resume Work

## Command Description

This command reads `flow/STATE.md` and reconstructs full session context after a context reset (compaction, new session, crash). It identifies the active work, reads the relevant plan/discovery file, and outputs a structured summary that puts the LLM back in context.

**Output**: Structured context summary displayed in chat — no files created or modified.

---

## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/resume-work - Resume Work from Saved State

DESCRIPTION:
  Reads flow/STATE.md and reconstructs session context after a context
  reset. Identifies active work, reads relevant plan files, and outputs
  a structured summary to resume where you left off.

USAGE:
  /resume-work
  /resume-work -help

ARGUMENTS:
  None — reads STATE.md automatically.

EXAMPLES:
  /resume-work

OUTPUT:
  Displays structured context summary with:
  - Active skill and plan
  - Current phase and task
  - Decisions made so far
  - Blockers encountered
  - Files modified
  - Next action to take

WORKFLOW:
  1. Validates flow/STATE.md exists
  2. Reads and parses STATE.md
  3. Checks staleness (warns if >24h old)
  4. Reads active plan file (if any)
  5. Identifies next task/phase
  6. Outputs structured context summary

RELATED COMMANDS:
  /execute-plan    Continue executing a plan
  /flow            Check flow configuration
```

---

## Critical Rules

| Rule | Description |
|------|-------------|
| **Read-Only** | This command does NOT create, modify, or delete any files |
| **No Auto-Chaining** | After presenting the summary, STOP. Under a chain, the harness decides what follows |
| **No Code Execution** | Do NOT run build, test, or any implementation commands |
| **STATE.md Required** | If STATE.md doesn't exist, inform the user — do NOT create it |
| **Plan File is Truth** | If STATE.md references a plan, read the plan file for authoritative task status |

---

## Instructions

### Step 1: Validate STATE.md Exists

Check if `flow/STATE.md` exists.

**If it does NOT exist**:
```markdown
No active session state found (`flow/STATE.md` does not exist).

This means either:
- No skill was in progress when the session ended
- The previous skill completed successfully and cleared its state

Use `/execute-plan`, `/discovery-plan`, or another command to start new work.
```
**STOP** — do not proceed.

---

### Step 2: Read and Parse STATE.md

Read `flow/STATE.md` and extract:
- **Active Skill**: The skill that was running
- **Active Plan**: Path to the plan file being executed
- **Current Phase**: Phase number and name
- **Current Task**: The specific task in progress
- **Completed Phases**: List of completed phases with outcomes
- **Decisions**: Decisions made during the session
- **Blockers**: Issues encountered and their status
- **Files Modified**: Files changed during the session
- **Next Action**: What to do immediately

---

### Step 3: Staleness Check

Parse the `**Updated**` timestamp from STATE.md.

**If the timestamp is more than 24 hours old**:
```markdown
> **Stale State Warning**: STATE.md was last updated {time_ago} ({timestamp}).
> The session state may be outdated.
>
> Options:
> 1. **Resume anyway** — continue from where STATE.md left off
> 2. **Start fresh** — delete STATE.md and begin new work
```

Wait for user response before proceeding.

**If the timestamp is within 24 hours**: Continue silently.

---

### Step 4: Read Active Plan File

If STATE.md references an active plan (`Active Plan` is not "none"):
1. Read the plan file
2. Cross-reference completed phases in STATE.md with task checkboxes in the plan
3. Identify the next uncompleted task

If the plan file doesn't exist, note this as a warning.

---

### Step 5: Output Context Summary

Present the reconstructed context:

```markdown
Session resumed.

- Skill: {skill name}
- Plan: `{plan file path}`
- Progress: phase {N} of {total} — {phase name}
- Done: {completed phases, one short line each}
- Decisions: {decisions, one short line each}
- Blockers: {blockers with status, or none}
- Files changed: {files}

Next: {next action from STATE.md}
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

---

### Step 6: Stop and Wait

After presenting the summary, **STOP**. Do not auto-invoke any commands.

---

## Flow Diagram

```
+------------------------------------------+
|         /resume-work COMMAND             |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 1: Validate STATE.md Exists         |
| - If missing: inform user and stop       |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 2: Read and Parse STATE.md          |
| - Extract all sections                   |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 3: Staleness Check                  |
| - Warn if >24h old                       |
| - Ask user: resume or start fresh        |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 4: Read Active Plan File            |
| - Cross-reference with STATE.md          |
| - Identify next task                     |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 5: Output Context Summary           |
| - Structured markdown with all state     |
+------------------------------------------+
                    |
                    v
+------------------------------------------+
| Step 6: Stop and Wait                    |
| - User decides next action               |
+------------------------------------------+
```

---

## STATE.md Updates

This command does NOT update STATE.md. It is read-only.

---

## Brain Capture

After resume completes, append a brain-capture block:

```
<!-- brain-capture
skill: resume-work
feature: [feature from active plan]
status: completed
data:
  active_skill: [skill being resumed]
  active_plan: [plan file path]
  phase_resumed: [phase number]
  staleness_hours: [hours since last update]
-->
```

---

## Tasklist Updates

This command does NOT update the tasklist. It is read-only.

---

## Related Resources

| Resource | Purpose |
|----------|---------|
| `resources/skills/resume-work-skill.md` | Skill implementation details |
| `resources/core/compaction-guide.md` | What to preserve during compaction |
| `resources/core/session-scratchpad.md` | Complementary session notes |
| `/execute-plan` command | Continue plan execution |
| `/flow` command | Check flow configuration |
