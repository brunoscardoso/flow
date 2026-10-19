# ADR-001: Edit/Write Interception and Bash Bridging over the Claude Agent SDK

- **Status**: Accepted
- **Date**: 2026-07-08
- **Phase**: 4 (Agent Engine Core) — verdicts gate Phase 8 (inline diff review) and Phase 9 (agent terminal)
- **Evidence**: runtime spike harnesses executed against `@anthropic-ai/claude-agent-sdk@0.3.204` with live auth (results archived under `flow/.evidence/flow-ide-20260708-110747/phase-4-task-4/`)

## Context

Flow renders agent file edits as reviewable inline diffs (Phase 8) and mirrors/hosts agent shell activity in an app-owned terminal (Phase 9). Both need a reliable interception point inside the SDK's tool-execution path:

- (a) For Edit/Write: capture **before/after file content** and optionally **hold the write** until the user reviews it.
- (b) For Bash: capture the **command and its output**, and ideally route execution through an app-owned PTY so output can stream live into the terminal pane.

A pre-approved fallback existed for (a): if SDK interception proved fragile, Phase 8 would fall back to git-based review (diff over commits).

## Options considered

### (a) Edit/Write interception

1. **`canUseTool` as the interception gate** — the SDK's permission callback receives the full typed tool input (`FileEditInput` / `FileWriteInput`) *before* execution and parks the tool call until the callback resolves. Before-content is read from disk at approval time; after-content is computed deterministically from the input (`Write`: `content`; `Edit`: `old_string` → `new_string` replacement).
2. **`PreToolUse`/`PostToolUse` hooks only** — same input visibility, and `PostToolUse` additionally returns the authoritative result. But hook denies bypass the permission pipeline (the SDK documents that `PreToolUse` denies skip `canUseTool`), so review verdicts and permission verdicts would live in two divergent mechanisms.
3. **Git-based review (pre-approved fallback)** — let edits land, diff commits afterwards. Loses hold-before-apply, requires commit choreography, and reviews are post-hoc.

### (b) Bash bridging

1. **Mirroring via hooks** — `PreToolUse` exposes the command; `PostToolUse` exposes the full result (`{stdout, stderr, interrupted}`). Display-only, output arrives after the command finishes.
2. **Routing via `toolAliases` + in-process MCP executor** — `toolAliases: { Bash: 'mcp__flow__bash' }` redirects model-emitted `Bash` calls to an app-owned tool created with `createSdkMcpServer()`/`tool()`. Flow executes the command itself (PTY-attachable), so output can stream live and the terminal is genuinely app-owned.
3. **Parsing the message stream for live output** — not viable: `tool_progress` events carry only `tool_name`/`elapsed_time_seconds`, no incremental output text (confirmed at runtime — zero output-bearing progress events).

## Runtime findings (spike, live SDK)

- **Interception works end-to-end.** `canUseTool` fired for `Edit` and `Write` with complete typed input; predicted after-content matched the on-disk result **2/2** (`predictionMatchesDisk: true` for both). The E2E harness additionally proved park → renderer verdict → resume through the real `AgentManager` pipeline.
- **`PostToolUse` is an authoritative verifier.** The Edit `tool_response` includes `originalFile` (before-content) and `structuredPatch` (exact hunks) — Flow can cross-check its computed diff against the SDK's own record and detect drift.
- **Allow results MUST echo `updatedInput`.** The SDK Zod-validates `PermissionResult`; `{behavior:'allow'}` without `updatedInput` fails validation and the tool call errors out ("Tool permission request failed: ZodError"). Discovered at runtime; fixed in `permissions.ts` (always resolve with `updatedInput: <original input>`).
- **"Safe" Bash commands can bypass `canUseTool`.** A plain `echo` executed without a permission roundtrip (CLI-side auto-allow), while `PreToolUse` still fired. Consequence: hooks — not `canUseTool` — are the *complete* observation channel; `canUseTool` is the *approval* channel.
- **No live Bash output exists in the SDK stream.** Full output appears only in `PostToolUse`/`tool_result` after completion.
- **Routing is proven.** `toolAliases: { Bash: 'mcp__flow__bash' }` + `createSdkMcpServer` delivered the model's Bash call to an app-owned executor, and the executor's output flowed back to the model transparently (`bashRoutedToAppExecutor: true`, `outputFlowedBackToModel: true`).

## Decision

### Phase 8 — inline diff review: **SDK interception via `canUseTool` (fallback NOT needed)**

Use `canUseTool` as the single gate for `Edit`/`Write`/`NotebookEdit`: capture before-content from disk, compute proposed after-content from the tool input, present the pending diff, and resolve the callback only on user verdict (the permission pipeline built in this phase is exactly this mechanism). Use a `PostToolUse` hook as the verification channel (`originalFile`/`structuredPatch`) to confirm the applied change matches the reviewed one. The interception path proved robust at runtime — the pre-approved **git-based fallback is not adopted**; it remains documented here as a contingency if a future SDK release regresses `canUseTool` semantics.

Implementation notes for Phase 8:
- Always return `updatedInput` on allow (SDK Zod requirement — see findings).
- Compute Edit after-content with the same replace semantics as the tool (`replace_all` aware); treat a `PostToolUse` mismatch as review-invalidating.
- Multiple sequential edits to one file are safe: each `canUseTool` reads disk at its own approval time.

### Phase 9 — bash bridging: **hook mirroring as baseline, `toolAliases` PTY routing for live output**

- **Baseline (ship first)**: mirror via hooks — `PreToolUse` writes the command into the thread's agent-terminal view; `PostToolUse` appends `stdout`/`stderr`. Zero behavior change to the SDK's own Bash (sandboxing, timeouts, background tasks keep working).
- **Live routing (the Phase 9 mechanism for an app-owned PTY)**: `toolAliases: { Bash: 'mcp__flow__bash' }` routed to an in-process `createSdkMcpServer` tool that spawns the command in a Flow-owned `node-pty`, streaming output to the renderer as it happens and returning the final output to the model. Runtime-proven in this spike.
- Tradeoff to respect when enabling routing: the app-owned executor replaces the SDK's Bash implementation (its sandbox settings, `run_in_background`, and timeout handling no longer apply) — Flow's executor must reimplement timeouts and honor the permission pipeline before execution. Ship routing behind a per-project setting until parity is verified.

## Consequences

- The permission pipeline (`app/src/main/agent/permissions.ts`) is load-bearing for Phase 8: pending-diff review reuses its park/verdict machinery and its persisted rules.
- Phase 8 needs no git choreography; `flow/` observation stays read-only.
- Phase 9's terminal manager should expose a single `mcp__flow__bash`-compatible executor so the alias can be flipped on without contract changes.
- Watch item: `canUseTool` bypass for CLI-classified "safe" commands means Flow must not assume every tool execution produced a permission request — observation (hooks/stream) and approval (canUseTool) are separate channels in the data model.
