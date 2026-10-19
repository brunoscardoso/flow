# Atomic Commits Per Task

## Purpose

When `commit: true` in `flow/.flowconfig`, `/execute-plan` commits after each
individual **task**, not once per phase. A phase is a unit of planning; a task
is a unit of change, and the history is more useful when it is cut at the
smaller one: `git bisect` lands on one task, a revert takes one task with it,
and a commit message names something a person actually did.

`commit: false` disables commits entirely. Everything below is inert then.

> **Written, not recovered (#1959 / #1949 guard).** Four shipped files pointed
> here "for the full commit format spec" and this file did not exist. Its
> content is consolidated from the surfaces that already stated the rules —
> `CLAUDE.md`'s Atomic Commits section, `phase-isolation.md`'s
> `tasks_completed` schema row, and the coordinator rules in
> `wave-execution.md` and `execute-plan-skill.md` — not invented.

---

## Commit Format

```
feat(phase-<N>.task-<M>): <task description> — <feature>
```

- `<N>` is the phase number from the plan; `<M>` is the task number, 1-indexed
  **within that phase**.
- `<task description>` is the task's own name, not a summary of the diff.
- `<feature>` is the plan's feature slug, so one run's commits group together.

The prefix is `feat(...)` for implementation tasks. A task whose whole subject
is tests, docs or a fix keeps its own conventional type — `test(phase-2.task-3)`,
`docs(...)`, `fix(...)` — chosen from what the task does, not from the plan's
overall intent.

### The run trailer

Every task commit ends with a blank line and the run's token:

```
feat(phase-1.task-2): resolve the type scale — semantic-typography

Flow-Run: <run_id>
```

`<run_id>` is the run's own id, minted by the driver — never invented, and
never read off the documents being written (allowed-pattern #25).

**What it is for.** Knowledge documents written by this run carry the same
token as `landed_by:` in their frontmatter, and the Workspace sync will not
publish such a document until that token appears on the project's default
branch. It is how "has this work actually merged?" is answered without anyone
tracking branches by hand.

**Why a trailer and not a sha.** A squash merge mints a NEW commit, so the
branch's sha is never an ancestor of the default branch and an ancestry test
would answer "not landed" for ever. Both squash and rebase preserve the commit
*body*, so the trailer rides along.

**Do not edit it out of a squash message.** Collapsing a branch is fine — the
trailer only has to survive somewhere in the resulting commit's body. If it is
deleted, the documents stamped with it wait indefinitely, and the way out is a
person writing `status: shared` into the document, which outranks the token.

---

## Who Commits, and When

| Mode | Committer | When |
|------|-----------|------|
| Sequential (`wave_execution: false`) | the phase sub-agent | directly after each task completes |
| Wave (`wave_execution: true`) | the **coordinator** | after the whole wave returns |

**Why the coordinator commits in wave mode.** Parallel sub-agents finish in a
nondeterministic order, and a commit made the moment a sub-agent finishes puts
the history in whatever order the machine happened to produce. The coordinator
instead waits for every return in the wave, then walks phases in **phase-number
order** and, within each, `tasks_completed` in **`task_number` order**. The same
plan produces the same history on every run.

It also means file-conflict detection happens *before* anything is committed:
the coordinator holds all the returns at once (see `wave-execution.md`), so two
phases that touched the same file are caught while the tree can still be
examined, not after both have been written into history.

**Branch safety.** Any agent that commits verifies `git branch --show-current`
immediately before every commit, or works in a dedicated worktree
(forbidden-pattern #11). Parallel agents sharing one checkout can otherwise land
commits on whatever branch was checked out at that instant.

---

## What the Coordinator Commits From

The `tasks_completed` array in each phase's JSON return
(`phase-isolation.md`, Return Schema):

```json
"tasks_completed": [
  {
    "task_number": 1,
    "task_name": "Add the routing table",
    "files_created": ["src/cli/state/model-tiers.ts"],
    "files_modified": ["src/cli/commands/plan.ts"]
  }
]
```

| Field | Type | Meaning |
|-------|------|---------|
| `task_number` | number | 1-indexed within the phase; the commit order |
| `task_name` | string | becomes `<task description>` in the message |
| `files_created` | string[] | staged for that task's commit |
| `files_modified` | string[] | staged for that task's commit |

Only those paths are staged. A commit never stages the whole tree, because in
wave mode a sibling phase's work may be sitting in it uncommitted.

A phase that returns no `tasks_completed` (an older sub-agent, or a phase with
no tasks that changed files) falls back to one commit for the phase. That is a
degradation, not an error, and it is not reported as a failure.

---

## Verification and Failure

- **Verification runs before the task's commit.** A task with a `<verify>` tag
  is verified, and the repair loop runs, before anything is staged
  (`per-task-verification.md`).
- **A failed task still commits** once `max_verify_retries` is exhausted. The
  work exists, the history should say so, and the failure is carried in the
  rounds record and the completion summary rather than by withholding a commit.
  A missing commit would leave the change in the working tree with nothing
  naming it — the worst of both outcomes.
- **A withheld repair** (a behaviour-changing fix the loop declined to apply)
  does not block the commit either; it escalates separately.

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/core/phase-isolation.md` | The `tasks_completed` return schema this reads |
| `.claude/resources/core/wave-execution.md` | Wave ordering and the coordinator's post-wave processing |
| `.claude/resources/core/per-task-verification.md` | What runs before each task's commit |
| `.claude/resources/skills/execute-plan-skill.md` | Steps 4c and 5 — where commits are actually issued |
| `.claude/resources/core/auto-provisioning.md` | `commit`, `push` and `pr` in `flow/.flowconfig` |
