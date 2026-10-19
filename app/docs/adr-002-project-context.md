# ADR-002: Project-Scoped Context (Zed-style)

**Status:** accepted (2026-07-09) · **Supersedes:** the global-editor/global-terminal model

> **Superseded in part by multi-project threads (2026-07-28):** the
> single-active-root constraint on project surfaces is lifted where the
> ACTIVE THREAD's scope spans multiple roots (`project:getThreadScope` /
> `project:threadScopeChanged`, `src/main/project/thread-scope.ts`). The
> file tree renders one section per scope root (Phase 3) and Source Control
> renders one repo group per scope root — per-group changes, commit box, and
> gates over the existing per-root IPC (Phase 4, `src/renderer/git/git-groups.ts`).
> A single-root scope still renders exactly the ADR-002 world (no extra
> chrome), and every surface fails soft to the active-root binding when the
> scope layer is unavailable. The active-project model itself (switcher,
> persistence, thread→project resolution) remains in force.

## Decision

The app is a single window bound to **one active project at a time**. All
project surfaces — file tree, editor tabs, terminals — are **scoped to the
active project**. The threads sidebar stays **global** (all projects, grouped)
and is the primary navigator; the conversation is per-thread as today.

Switching the active project rebinds every surface and restores that project's
saved state. The project you leave stays alive in the background (terminals
keep running, editor tabs stay in memory).

### Chosen options (from the brainstorm)

- **Context scope:** project-scoped (threads are conversations within a project).
- **Terminals on switch:** keep running in the main process; UI detaches/reattaches.
- **Persistence:** full restore across app restart (tabs reopen, terminals
  re-spawn fresh in their cwd, last-active project + thread restored).
- **Window model:** single window, switch context.
- **File tree:** shows only the active project's root.
- **Project switcher:** a project dropdown in the titlebar (current project +
  switch + Open Project).

## What "switch" means

Selecting a thread → resolve its project → if different from the active project,
`setActiveProject(root)` which:
1. Saves the outgoing project's live state (open files, active file, last thread).
2. Loads the incoming project's state.
3. Emits `project:activeChanged`; the renderer rebinds:
   - file tree → the active root only
   - editor → close current tabs, open the project's saved tabs
   - terminals → filter to the project's terminals (PTYs already alive)
   - conversation → the selected thread (or the project's last-active thread)

Selecting a thread in the **same** project changes only the conversation.

## Persistence

New SQLite table `workspace_state` (migration v3; the physical name is kept for cross-build compatibility — code calls it the project-state table), one row per project root:
`open_files` (JSON), `active_file`, `open_terminals` (JSON of {title,cwd}),
`active_thread_id`, `last_active_at`. On boot: pick the max `last_active_at`
project, set it active, restore tabs + re-spawn terminals + select its thread.

## Build shape

Foundation (shared contract, built first): migration v3, `ProjectContextManager`
(main), IPC contract additions, terminal project-scoping. Then parallel surfaces:
single-root file tree, per-project editor tab persistence, terminal filtering,
titlebar project switcher, and the thread-select → project-switch + boot-restore
coordinator wiring.
