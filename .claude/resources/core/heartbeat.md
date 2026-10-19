
# Heartbeat: Scheduled Task System

## Purpose

A file-based cron-like automation system for plan-flow. Tasks are defined in `flow/heartbeat.md` with human-readable schedules and executed by a background Node.js daemon.

**Config Location**: `flow/heartbeat.md`
**PID File**: `flow/.heartbeat.pid`

---

## File Format

The heartbeat file contains task entries in markdown format:

```markdown
# Heartbeat

**Project**: [[{project-name}]]
**Last Updated**: {YYYY-MM-DD}

## Tasks

### {task-name}
- **Schedule**: {schedule-expression}
- **Command**: {command-to-execute}
- **Enabled**: {true|false}
- **Description**: {what this task does}

### {another-task}
- **Schedule**: {schedule-expression}
- **Command**: {command-to-execute}
- **Enabled**: {true|false}
- **Description**: {what this task does}

### {scheduled-tasklist-item}
- **Schedule**: in 1 hour
- **Command**: execute tasklist item "Feature xyz"
- **Enabled**: true
- **Description**: Scheduled from tasklist — Feature xyz
- **One-Shot**: true
- **Tasklist Link**: [[tasklist.md#Feature xyz]]
```

---

## Schedule Syntax

Human-readable schedule expressions:

| Syntax | Example | Meaning |
|--------|---------|---------|
| `daily at {HH:MM AM/PM}` | `daily at 10:00 PM` | Run once daily at 10:00 PM |
| `every {N} hours` | `every 6 hours` | Run every 6 hours from daemon start |
| `every {N} minutes` | `every 30 minutes` | Run every 30 minutes from daemon start |
| `weekly on {day} at {HH:MM}` | `weekly on Monday at 9:00 AM` | Run weekly on Monday at 9 AM |
| `in {N} hours` | `in 2 hours` | Run once, N hours from now (one-shot) |
| `in {N} minutes` | `in 30 minutes` | Run once, N minutes from now (one-shot) |

### Schedule Rules

- Times use 12-hour format with AM/PM
- Day names are case-insensitive (Monday, monday, MONDAY)
- Interval-based schedules (`every N hours/minutes`) start from daemon startup time
- Daily and weekly schedules use the system's local timezone

---

## Daemon Architecture

### Overview

The heartbeat daemon is a detached Node.js process that:

1. Reads `flow/heartbeat.md` and parses task definitions
2. Schedules tasks using Node.js built-in `setTimeout`/`setInterval`
3. Watches `flow/heartbeat.md` for changes and reloads dynamically
4. Spawns Claude Code CLI to execute scheduled commands
5. Writes PID to `flow/.heartbeat.pid` for lifecycle management

### CLI Commands

| Command | Action |
|---------|--------|
| `npx plan-flow heartbeat start` | Start the daemon (detached) |
| `npx plan-flow heartbeat stop` | Stop the daemon (via PID file) |
| `npx plan-flow heartbeat status` | Show daemon status (running/stopped, PID, uptime) |

### Auto-Start on Init

The daemon starts automatically when `plan-flow init` runs, if `flow/heartbeat.md` exists. This means scheduled tasks begin working immediately after installation — no manual `heartbeat start` needed.

### Process Management

- **PID File**: `flow/.heartbeat.pid` stores the daemon PID
- **Start**: Spawns a detached child process, writes PID file
- **Auto-start**: Runs during `plan-flow init` if heartbeat.md exists
- **Stop**: Reads PID file, sends SIGTERM, removes PID file
- **Status**: Checks if PID in file is actually running
- **Stale PID**: If PID file exists but process is not running, clean up and report stopped

### Signal Handling

The daemon handles:

- **SIGTERM**: Clean shutdown — clear all timers, remove PID file, exit
- **SIGINT**: Same as SIGTERM

### File Watching

- Uses `fs.watch` on `flow/heartbeat.md`
- On change: re-parse the file, cancel existing timers, reschedule all enabled tasks
- Debounce: 1 second delay to handle rapid file saves

### Task Execution

- Each task spawns a new Claude Code CLI process
- Command is passed to Claude Code as the prompt
- Stdout/stderr are logged to `flow/.heartbeat.log`
- Tasks do not run concurrently — a task waits for the previous invocation to complete before starting again

### Retry on Active Session

When a task fails because a Claude Code session is already active (error: "cannot be launched inside another Claude Code session"), the daemon does **not** mark the task as permanently failed. Instead:

1. **Deferred retry**: The task is rescheduled to retry after 60 seconds
2. **Max retries**: Up to 5 retry attempts per task. After 5 failures, the task is logged as failed and retries stop
3. **Mutex respected**: Retries still honor the `taskRunning` mutex — if another task is running when the retry fires, it is skipped (not counted as a retry attempt)
4. **One-shot tasks**: Retry logic applies to one-shot tasks as well. The task is only disabled after successful execution, not after a session-active deferral
5. **Retry reset**: The retry counter resets to zero after a successful execution
6. **Logging**: Each deferral logs `Task "{name}" deferred — Claude Code session active. Will retry in 60s (attempt N/5)`

---

## One-Shot Tasks

One-shot tasks run once and auto-disable. They are used for scheduled tasklist items.

### Behavior

1. **Detection**: If a task has `One-Shot: true` in its definition, it is a one-shot task
2. **Execution**: After the task executes successfully, set `Enabled: false` in `flow/heartbeat.md`
3. **Tasklist update**: If the task has a `Tasklist Link`, update the linked item in `flow/tasklist.md` — move from **To Do** to **Done** with today's date
4. **Relative schedules**: `in {N} hours/minutes` schedules are calculated from the time the task was added, not from daemon start

### Tasklist Integration

Tasks created from the tasklist have a `Tasklist Link` field that points back to the tasklist item. This enables:
- Bidirectional navigation in Obsidian via `[[]]` links
- Automatic status sync between heartbeat and tasklist
- Clean up after one-shot execution

---

## Vault Sync

The project heartbeat is linked into the central Obsidian vault at `~/plan-flow/brain/projects/{project}/heartbeat.md` (symlink). A **global heartbeat** at `~/plan-flow/brain/heartbeat.md` aggregates all projects, showing all scheduled tasks for a cross-project automation view.

### When Global Updates Happen

The global heartbeat MUST be synced **every time** `flow/heartbeat.md` is modified. This is not optional.

#### Sync Trigger

After **every** Edit or Write to `flow/heartbeat.md`, you MUST also update the global heartbeat at `~/plan-flow/brain/heartbeat.md`:

1. **Read** `~/plan-flow/brain/heartbeat.md`
2. **Parse** task blocks (### headings) and extract: name, schedule, enabled status
3. **Count** active vs disabled tasks
4. **Update** only the current project's section with the task list
5. **Update** the `**Last Updated**` date to today

#### Sync Rules

- **Always sync**: Every heartbeat edit triggers a sync — no exceptions
- **Only update your project**: Do not recalculate data for other projects
- **Show all tasks**: List every task with name, schedule, and active/disabled status
- **Preserve format**: Keep the existing global heartbeat format (wiki-links, table, see-link)
- **Create if missing**: If `~/plan-flow/brain/heartbeat.md` doesn't exist, create it with the standard format

#### Example Sync

After editing `flow/heartbeat.md` for project `parcels` with 3 tasks:

```markdown
### [[parcels]]

**Active**: 2 | **Disabled**: 1

| Task | Schedule | Status |
|------|----------|--------|
| babysit-deploy | every 30 minutes | Active |
| daily-review | daily at 10:00 PM | Active |
| one-shot-fix | in 1 hour | Disabled |

> See: [[parcels/heartbeat.md|Full Heartbeat]]
```

---

## Vault Sync: Log File

The project log (`flow/log.md`) is also linked into the vault at `~/plan-flow/brain/projects/{project}/log.md`. Unlike other files, the log does **not** have a global aggregator — it is read directly from the project symlink. This is because logs are append-heavy and project-specific; Obsidian users navigate to the project's log via `[[project/log.md]]` links.

---

## Notification System

The heartbeat daemon includes a notification system that provides visibility into background task execution.

### Notification Channels

| Channel | What Gets Written | When |
|---------|------------------|------|
| `flow/log.md` | Timestamped one-liners | All events (start, complete, fail, blocked) |
| `flow/.heartbeat-events.jsonl` | Machine-readable JSON events | All events |
| Desktop notification (node-notifier) | Pop-up alert | Failures and blocked tasks only |

### Log Format (flow/log.md)

```
[2026-03-17 14:00] ✅ task-name: Started — description
[2026-03-17 14:12] ✅ task-name: Phase 1/5 complete — description
[2026-03-17 14:35] ❌ task-name: FAILED at Phase 3 — build error
[2026-03-17 14:35] ⏸️ task-name: Paused — see .heartbeat-prompt.md
```

### Event Types

| Type | Level | Desktop Notify |
|------|-------|---------------|
| `task_started` | info | No |
| `phase_complete` | info | No |
| `task_complete` | info | No |
| `task_failed` | error | Yes |
| `task_blocked` | error | Yes |

### Status Signal Mapping

The NotificationType enum above is a domain vocabulary and never changes. In the unified signaling vocabulary (see `.claude/resources/core/status-contract.md`), event types map as:

`task_started → working` · `phase_complete → working` · `task_complete → done` · `task_failed → failed` · `task_blocked → blocked`

### Exit Code Convention

| Exit Code | Meaning | Daemon Action |
|-----------|---------|---------------|
| 0 | Success | Log ✅, continue |
| 1 | Failure | Log ❌, desktop notify |
| 2 | Needs input | Log ⏸️, write prompt file (if autopilot OFF), desktop notify |

### Prompt File System

When a task exits with code 2 and autopilot is OFF:
1. Daemon writes `flow/.heartbeat-prompt.md` with task context
2. Desktop notification alerts the user
3. Task pauses until user responds
4. On next session start, the prompt is auto-detected and presented
5. After resolution, prompt is archived to `flow/archive/heartbeat-prompts/`

When autopilot is ON: exit code 2 is logged as a warning but execution continues.

### Session Start Integration

Two behaviors activate on session start:
1. **Heartbeat Log**: Reads `.heartbeat-events.jsonl`, compares against `.heartbeat-state.json` timestamp, summarizes unread events
2. **Heartbeat Prompt**: Detects `.heartbeat-prompt.md` and presents pending questions immediately

### Runtime Files

| File | Purpose |
|------|---------|
| `flow/.heartbeat-events.jsonl` | Append-only event stream (one JSON per line) |
| `flow/.heartbeat-state.json` | Tracks last-read timestamp for session start summaries |
| `flow/.heartbeat-prompt.md` | Pending user input from blocked task (temporary) |
| `flow/archive/heartbeat-prompts/` | Archived resolved prompt files |

---

## Rules

1. **Minimal dependencies**: Daemon uses Node.js built-in modules plus `node-notifier` for desktop notifications
2. **Graceful shutdown**: Always clean up timers and PID file on exit
3. **Stale PID detection**: Verify PID is actually running before assuming daemon is alive
4. **File-based config**: All configuration lives in `flow/heartbeat.md` — no CLI flags for task config
5. **Hot reload**: Changes to `flow/heartbeat.md` are picked up automatically without restart
6. **Log rotation**: Keep `flow/.heartbeat.log` under 1000 lines by truncating oldest entries
7. **One-shot cleanup**: After a one-shot task executes, auto-disable it and update the linked tasklist item
8. **Vault sync**: Every heartbeat update MUST also update `~/plan-flow/brain/heartbeat.md` — see Vault Sync section

---

## Notifications — where an event actually goes

The daemon routes every `NotificationEvent` through `notification-router.ts`,
and that router has exactly three channels:

| Event | Channels |
|-------|----------|
| all events | `flow/log.md` + `flow/.heartbeat-events.jsonl` |
| `error`, `blocked`, `task_complete` | also a desktop notification |

Everything is local. There is no HTTP client anywhere in `src/cli/`.

### Telegram and webhooks were removed (2026-03-19)

`0d997af5` deleted `telegram-poller.ts`, `telegram-typing.ts` and
`webhook-sender.ts`, and stripped `webhook_url`, `telegram_bot_token` and
`telegram_chat_id` from the config parser and types. It touched no
documentation, so this file went on describing a polling-state format, a worked
example with a bot token, and an auto-migration rule for five months after the
code was gone (#1806).

Setting any of those three keys does nothing — the parser does not read them.
**A blocked headless run is unblocked by writing `flow/.heartbeat-prompt.md`,
and by nothing else.** Anyone waiting for a Telegram reply to be picked up is
waiting for a daemon that is not listening.

`flow/.telegram-poll-state.json` is never written any more. It stays in the
provisioned `.gitignore`, and `telegram_bot_token` stays in the share command's
secret-key list, on purpose: a project that configured either before the removal
still has that value on disk, and a stale secret is still a secret.
