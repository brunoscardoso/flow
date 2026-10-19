# TODO

## Task 1 - Intelligent Learn Skill

Make the `/learn` skill more intelligent and important.

**Idea:** When the user calls for example `/learn about mcp`, we create a solid plan to teach them about MCP. But not only in one shot — really teach step by step. Keep it in the brain as a `.md` file with the whole teaching process. The user should confirm each step, and when they confirm, that becomes a learned pattern.

**Key points:**
- Create a structured teaching plan when `/learn <topic>` is invoked
- Store the full teaching process as a brain `.md` file
- Step-by-step progression — user confirms each step before moving on
- Each confirmed step becomes a learned pattern in the brain

---

## Task 2 - Project Tasklist

Have a `tasklist.md` file inside each project. Every time we load that project, we should load the tasklist and ask the user if they want to take any task from it.

**Key points:**
- `tasklist.md` lives inside each project (e.g., `flow/tasklist.md`)
- On session start, load and display the tasklist
- Ask the user if they want to pick a task
- When a task is picked, remove it from the tasklist and add it to the brain as a pattern

---

## Task 3 - Project Memory

Similar to the tasklist, have a `memory.md` file that tracks everything we finish. Every time we complete something, we tag it in the project memory.

**Format example:**
```
2026-03-06 [[plan-flow]] created [[discovery]] finished
  - File: flow/discovery/discovery_feature_v1.md
  - Resume: Short description of max 6 lines about what was discovered
```

**Key points:**
- Timestamp + project link + artifact type + status
- File path reference
- Short resume (max 6 lines)
- Use the index mechanism so we can load memory efficiently
- Load at least the previous 7 days of memory on session start
- Core idea: plan-flow never loses knowledge across sessions

---

## Task 4 - Heartbeat (Cron-like Automation)

A `heartbeat.md` file that works as a cronjob. When enabled, it runs scripts/tasks that the user defined in the heartbeat file.

**Example heartbeat.md content:**
```
do
  daily at 10:00 PM - research about topic X, create md files with that research and add to brain
  daily at 11:00 AM - using flow --enabled, create feature Y, execute, and push to repo
```

**Key points:**
- User interacts with the `heartbeat.md` file to define scheduled tasks
- A script monitors the heartbeat file and triggers tasks at the specified times
- Tasks can include research, feature creation, execution, and pushing to repos
- Essentially brings autonomous scheduled workflows to plan-flow
