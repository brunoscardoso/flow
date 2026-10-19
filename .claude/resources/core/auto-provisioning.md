
# IDE Auto-Provisioning

## Purpose

Every managed project in the Flow IDE remains scaffolded with the plan-flow assets (commands, resources, hooks) that match the app's bundled CLI version, with **zero terminal interaction**. The provisioner automatically detects when a root's assets are missing or stale and refreshes them silently. This ensures all IDE-managed projects stay consistent with the bundled CLI without requiring users to run `planflow-ai init` manually.

Provisioning is **silent and automatic**:
- No consent dialogs or interactive prompts
- Failures emit ONE toast and leave the root re-runnable
- Unavailable roots (e.g., unreachable symlinks) are skipped without blocking other roots

---

## Provisioning Model

The provisioner decides **action** based on three inputs:

1. **Root availability** — is the root reachable on disk?
2. **Bundled CLI version** — what version is the app shipping?
3. **Provision stamp** — what version (if any) last provisioned this root?

Given these inputs, the decision is **pure and exhaustively unit-tested** (see `decideProvisioning` in `app/src/main/project/provisioner.ts`):

| Condition | Action | Reason |
|-----------|--------|--------|
| Root unavailable | `skip` | Cannot provision an unreachable path |
| Run already in flight | `skip` | Serialize per-root; wait for the in-flight run |
| No bundled CLI version | `skip` | Nothing to run; the app bundle is incomplete |
| Never provisioned (no stamp) | `provision` | Fresh project; run full init |
| Stamp differs from bundle | `refresh` | Version drift; update owned assets only |
| Stamp matches bundle | `skip` | Already current; nothing to do |

---

## Provisioning Triggers

Auto-provisioning runs at these points:

1. **Project add** — when a user adds a new project root to the app
2. **Project activation** — when a user switches to or opens a different project
3. **App startup** — sweep over all known roots, provisioning any that need it
4. **Explicit user action** — "Re-provision now" button in Settings (Phase 5)

All triggers use the same `maybeProvision()` method, which is safe to call repeatedly — it self-serializes per root via an in-flight guard and returns immediately for anything that should skip.

---

## Provisioning Readiness States

Each project root progresses through provisioning states, displayed in the sidebar and reflected in the app's `readiness` channel:

| State | Meaning | Sidebar Tag | Board Pane |
|-------|---------|-------------|-----------|
| `idle` | Root is known and no provisioning is in flight | — | — |
| `provisioning` | Provisioning/refresh is currently running | "Setting up plan-flow…" | "Setting up plan-flow…" pane appears |
| `ready` | Provisioning succeeded; plan-flow assets are current | ✓ (no tag) | — |
| `failed` | Provisioning failed; assets may be stale | ✗ (error tag) | Error details in sidebar |

**Onboarding Ask (#513)**: When a root reaches `ready` state for the first time in its lifecycle, the provisioning gate checks the `basic_discovery_answer` persisted consent. If absent (consent not yet given), the app fires a one-time question: "Would you like to generate basic documentation for each module in this project?" Answer is persisted and never re-asked unless reset via Settings (Phase 5). When YES, the provisioning gate enqueues the T1 onboarding sweep (progressive-learning module learning). See `.claude/resources/core/progressive-learning.md` for learning tiers.

---

## Provisioning Actions

### `provision` — Full Initialization

**When**: A root has never been provisioned (no stamp in the database).

**Command**: `planflow-ai init --claude --force --yes`

**Effect**:
- Creates all plan-flow assets from scratch (`.claude/commands`, `.claude/resources`, `.claude/rules`, `.claude/hooks`, `flow/` directory structure)
- Runs non-interactively (no terminal interaction, all defaults accepted)
- Sets the initial stamp to the bundled CLI version

**Error handling**: On failure, emits ONE toast with the error reason and leaves the root unstamped so the next trigger re-attempts the provision.

### `refresh` — Owned Assets Update

**When**: A root's provision stamp differs from the bundled CLI version (version drift detected).

**Command**: `planflow-ai init --refresh-owned`

**Effect**:
- Rewrites **only plan-flow-OWNED assets**: `.claude/commands`, `.claude/resources`, `.claude/hooks`
- Updates these assets byte-for-byte to match the bundled CLI's version
- **Never touches**: `.claude/rules/**` (user pattern data), `flow/` content (linked knowledge — into the vault, or into the project's Workspace folder for a Workspace project), or existing `.flowconfig` keys
- Idempotent — a second run rewrites byte-identical bytes

**Boundary enforcement**: The boundary between owned and protected paths lives in code, not convention (allowed-pattern #14). `OWNED_ASSET_PATHS` in `src/cli/commands/init-refresh.ts` is the single source of truth; `assertOwnedBoundary()` hard-refuses any manifest entry that targets `.claude/rules/**` or `flow/**`.

**Error handling**: Same as provision — ONE toast, leaves the root re-runnable.

**Refusing refresh**: `init --refresh-owned` refuses to run (exit 1, nothing written) when there is no existing plan-flow install — refresh only ever UPDATES, never bootstraps.

---

## Version-Stamp Semantics

The **provision stamp** lives in the `projects` database table as `provisioned_version`:

- **Null/absent** — root has never been provisioned
- **Version string** — the bundled CLI version that last provisioned this root (e.g., `"1.2.3"`)

On every successful provision or refresh, the stamp is updated to the bundled CLI's current version via `ProjectRegistry.stampProvisioned(rootId, version, timestamp)`.

The version string is read from the bundled CLI's co-located `package.json` (placed there by `scripts/build-cli-bundle.mjs`). If the read fails, provisioning is skipped (the app's bundle is incomplete).

---

## OWNED_ASSET_PATHS Boundary

The manifest of plan-flow-owned asset groups that `init --refresh-owned` may rewrite:

| Group | Source | Destination | Files |
|-------|--------|-------------|-------|
| `.claude/commands` | `.claude/commands` | `.claude/commands` | (all) |
| `.claude/resources` | `.claude/resources` | `.claude/resources` | (all) |
| `.claude/hooks` | `scripts/hooks` | `.claude/hooks` | `cost-tracker.cjs`, `cost-display.cjs`, `suggest-compact.cjs`, `pre-compact-save.cjs`, `session-summary.cjs` |

**Protected paths (never rewritten by refresh)**:
- `.claude/rules/**` — accumulated user pattern data (allowed-patterns.md, forbidden-patterns.md)
- `flow/**` — all linked knowledge (features, errors, decisions, brain structure), whether `flow` links into the vault or into a Workspace. Provisioning never moves or re-links an existing Workspace link; a repo that is a project of exactly one Workspace gets `flow` linked there, never into the vault (`.claude/resources/core/workspaces.md`)
- `.claude/settings.json` — user-specific settings (merge-aware, not rewritten)
- `CLAUDE.md` — project instructions (additively merged, never clobbered)
- `.flowconfig` — existing config keys (additive only; refresh never removes or overwrites keys)

---

## The --force Rules-Clobber Bug Fix

**Prior behavior**: `init --force` on an existing project would rewrite `.claude/rules/core/*`, potentially corrupting user-accumulated pattern data.

**Fixed behavior**: The rules copy is now **create-if-missing only**. When refreshing an existing project, `.claude/rules/` is never touched. User pattern files (allowed-patterns.md, forbidden-patterns.md) survive re-init byte-identical.

**Verification**: The fix is live in the provisioner's provision action (`init --claude --force --yes` via `runBundledCli`), which runs the corrected CLI code. Existing rules are preserved; only the owned assets are rewritten.

---

## CLI Shim (Agent Sessions)

Agent sessions launched by the Flow IDE receive a `planflow-ai` wrapper script on their PATH, pinned to the app bundle version.

**Location**: `<userData>/bin/planflow-ai`

**Content**:
```bash
#!/bin/sh
# Generated by Flow — do not edit by hand. version=<bundleVersion>
ELECTRON_RUN_AS_NODE=1 exec "<electronExecPath>" "<bundleCliPath>" "$@"
```

**Generation**:
- Built once per app bootstrap by `ensureCliShim()` in `app/src/main/agent/cli-shim.ts`
- Content-gated — only rewrites when execPath / bundlePath / version actually changed
- Idempotent — restores exec bit (0755) on every bootstrap to survive backup restores

**Purpose**: Allows skills and agents to shell out to `planflow-ai <verb>` in any project, including those with no local npm install of the CLI. The shim execs the bundled CLI through the same Electron binary the app runs, in `ELECTRON_RUN_AS_NODE` mode — no system Node, no npm PATH dependency.

**Failure mode**: If shim generation fails (read-only userData, permission denied), it logs once and resolves to null — sessions fall back to whatever PATH they'd have otherwise. The app bootstrap is never blocked.

---

## Failure Modes

### Provision/Refresh Failure

When a CLI run exits non-zero:

1. The provisioner captures the last stderr line (up to 2000 chars) as the failure reason
2. Emits ONE toast with the error message
3. **Does NOT stamp the root** — leaves it in the same state so the next trigger re-attempts
4. The root remains re-runnable; no permanent failure state

**Toast format**:
- `provision`: "Could not set up plan-flow — <error>"
- `refresh`: "Could not update plan-flow — <error>"

### Unavailable Root

When a root's path is unreachable:

1. The decision core skips the root with reason `unavailable`
2. No toast emitted (this is normal for symlinks to deleted projects)
3. The root is not stamped; re-queued for the next trigger if it becomes reachable

### CLI Timeout

The bundled CLI has a hard cap of **120 seconds** per run. If it doesn't exit by then:

1. The provisioner kills the process (SIGKILL)
2. Records error: `"timed out"`
3. Emits a toast and leaves the root re-runnable

---

## Non-IDE Terminal Setups

Manual init remains available for projects not managed by the Flow IDE:

```bash
npx planflow-ai init
```

Users can still run `init` manually to set up plan-flow in any project, with full interactive prompts and customization. IDE-managed projects get auto-provisioning for free; other projects use the CLI directly.

---

## Rules

1. **Silent always** — no consent dialogs or terminal interaction during provisioning
2. **Auto-refresh on version drift** — every time an IDE-managed project opens, check if the stamp differs from the bundle version
3. **Fail soft** — any failure emits ONE toast and leaves the root re-runnable; failures never block other roots
4. **Owned-assets-only refresh** — `init --refresh-owned` rewrites ONLY the assets in `OWNED_ASSET_PATHS`; `.claude/rules/**`, `flow/`, and `.flowconfig` keys are never touched
5. **No self-narration** — provisioning decisions are pure logic, never LLM-narrated; the code decides (allowed-pattern #14)
6. **Per-root serialization** — runs are serialized per root via an in-flight guard; only one provision/refresh per root at a time
7. **Idempotent** — provisioning the same version twice rewrites byte-identical bytes; subsequent runs report the same action

---

## See Also

- `app/src/main/project/provisioner.ts` — provisioning decision core + effect runner
- `src/cli/commands/init-refresh.ts` — owned-asset refresh implementation
- `app/src/main/agent/cli-shim.ts` — CLI shim generation for agent sessions
- `.claude/resources/core/engine-registry.md` — optional external engines (different from auto-provisioning, which is mandatory)
