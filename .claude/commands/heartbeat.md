---
description: Manage scheduled automated tasks via the heartbeat daemon
---

# Heartbeat: Scheduled Task Automation

## Command Description

Manage the heartbeat daemon — a cron-like automation system that runs scheduled tasks defined in `flow/heartbeat.md`. Tasks can include research, feature creation, execution, and pushing to repos.

**Config**: `flow/heartbeat.md`
**Daemon**: `npx plan-flow heartbeat start|stop|status`

---

## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/heartbeat - Scheduled Task Automation

DESCRIPTION:
  Manage the heartbeat daemon for automated scheduled tasks.
  Tasks are defined in flow/heartbeat.md with human-readable schedules.

USAGE:
  /heartbeat -add         Add a new scheduled task interactively
  /heartbeat -remove      Remove an existing scheduled task
  /heartbeat -list        List all scheduled tasks with status
  /heartbeat -help        Show this help

CLI COMMANDS:
  npx plan-flow heartbeat start    Start the daemon
  npx plan-flow heartbeat stop     Stop the daemon
  npx plan-flow heartbeat status   Show daemon status

SCHEDULE SYNTAX:
  daily at {HH:MM AM/PM}           Run once daily at the specified time
  every {N} hours                  Run every N hours
  every {N} minutes                Run every N minutes
  weekly on {day} at {HH:MM}       Run weekly on a specific day

EXAMPLE TASKS:
  daily at 10:00 PM - research about topic X, create md files and add to brain
  every 6 hours - check for new issues and update tasklist
  weekly on Monday at 9:00 AM - generate weekly summary report

TASKLIST INTEGRATION:
  Tasks added to the tasklist with a schedule (e.g., "in 1 hour", "at 3 PM")
  automatically create a linked heartbeat task. Both files cross-reference
  each other with [[]] links for Obsidian navigation.

RELATED COMMANDS:
  /flow           Configure plan-flow settings
  /note           Manual brain entry
```

---

## Critical Rules

| Rule | Description |
|------|-------------|
| **File-Based Config** | All tasks are defined in `flow/heartbeat.md` |
| **No Direct Execution** | This command manages tasks, not executes them — the daemon handles execution |
| **Confirm Before Remove** | Always confirm before removing a scheduled task |
| **Complete and Stop** | After adding/removing/listing, STOP and wait for user input |

---

## Instructions

### /heartbeat -add

1. Ask the user for:
   - **Task name**: Short descriptive name (kebab-case)
   - **Schedule**: Using human-readable syntax (see help)
   - **Command**: What the daemon should execute
   - **Description**: What this task does
2. Add the task to `flow/heartbeat.md` using the task template
3. Confirm the addition

### /heartbeat -remove

1. List all tasks in `flow/heartbeat.md`
2. Ask the user which task to remove
3. Confirm before removing
4. Remove the task entry from the file

### /heartbeat -list

1. Read `flow/heartbeat.md`
2. Display all tasks with their schedule, status, and description

## Brain Capture

<!-- brain-capture
skill: heartbeat
captures:
  - task name and schedule added/removed
  - daemon start/stop events
-->

---

## Context Loading

This command uses the **project brain** for context retrieval. Before executing, query it for relevant documentation:

**Queries**:
- `planflow-ai state-query "heartbeat daemon" --scope resources`
- `planflow-ai state-query "scheduled tasks" --scope resources`

The brain returns ranked chunks from indexed markdown files. Use the top results to inform execution.

---

## Related Resources

| Resource | Purpose |
|----------|---------|
| `resources/core/heartbeat.md` | File format rules and daemon architecture |
