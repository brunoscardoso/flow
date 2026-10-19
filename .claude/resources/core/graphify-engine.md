
# Graphify Engine

## Purpose

Single-source spec for the **graphify** engine — a local AST knowledge graph (tree-sitter extraction, ~40 languages, $0 LLM, offline) that gives plan-flow structural code understanding. Consumers use it for **review blast radius** (`/review-code`, `/review-pr`) and **phase dependency suggestions** (`/create-plan`).

**Graphify is ALWAYS-ON (#142)** — it does NOT follow the registry's consent lifecycle (no opt-in, no decline, no re-prompt). It is a required backbone dependency, installed under the hood and used on every project whenever available, with a native-only fallback when it isn't. This file defines graphify-specific mechanics; skills reference it and never restate it.

**Gate signal**: `graphifyAvailable()` — `which graphify` on PATH (package `graphifyy`, binary `graphify`). Legacy `engines.graphify: enabled|declined|pending` values may still sit in `flow/.flowconfig` but are **ignored by gating** (kept only for backward-compatible parsing).
**Graph state**: relocated into the gitignored `flow/` vault — repo-root `graphify-out/` is a symlink to `flow/brain/.structure/graphify-out/` (so graphify's output is never committable). Read via `graphify-out/graph.json` through the symlink.

---

## Required Posture & Install Rails

Graphify is a **required backbone dependency** of the blueprint system map (see Dual-Source Backbone in `.claude/resources/core/blueprint.md`). The install rails are **owned by `planflow-ai init`** (`ensureGraphify`, `src/cli/commands/graphify-rails.ts`) — plan-flow never vendors graphify; the rails invoke the user's own package managers and degrade fail-soft, with **no consent prompt**:

1. If the `graphify` binary already resolves on PATH, record `engines.graphify: enabled` (informational — gating no longer reads it) and set up the output relocation symlink.
2. Otherwise try `uv tool install graphifyy` (when `uv` exists), then `pipx install graphifyy` (when `pipx` exists). A successful install fires a detached first graph build (`graphify update .`) in the background.
3. When neither package manager is available or an install fails, print the manual instructions (`uv tool install graphifyy` / `pipx install graphifyy`) and record **`engines.graphify: pending`** (informational only).

**Availability gate (no pending gate)**: every `blueprint derive` runs backbone merge + enrichment; when `graphifyAvailable()` is false the derive falls back to **native-only** with the notice `graphify unavailable (tool not installed — install with \`uv tool install graphifyy\`) — continuing with native structure.` There is no separate consented-but-not-installed state that changes behavior — availability alone decides, so a legacy `pending`/`declined` value never suppresses enrichment once the binary is present.

**Legacy consent values**: projects from before always-on may carry `engines.graphify: declined|pending` (and a `engines.graphify_migration_asked` marker). These are silently ignored by gating — no migration, no re-prompt. `planflow-ai init` simply (re)installs and records `enabled`.

---

## Invocation Patterns

| Command | Use for | Notes |
|---------|---------|-------|
| `graphify affected "<file-or-node>" --depth N --relation calls --relation imports` | **Blast radius** — everything structurally reachable from a changed file or node. Reviews use `--depth 1`; phase dependency prediction uses `--depth 2` | Output is **uncapped upstream** — apply the Output Token Guard |
| `graphify query "<question>" --budget 1500` | Bounded structural exploration ("what calls X?", "where is Y defined?") | `--budget` caps output at the tool level; keep it at 1500 |
| `graphify explain "<node>"` | Drill-down on a single node — definition + top neighbors | Output is **uncapped upstream** — apply the Output Token Guard |

Ambiguous node names resolve to the first match — prefer exact node IDs (as returned by prior `affected`/`query` output) when precision matters.

---

## Output Token Guard

Any graphify output injected into a prompt is **hard-capped at ~1,500 tokens (≈ 4,500 characters)**. `affected` and `explain` have NO cap upstream — a god node can return ~5K tokens.

When output exceeds the cap, truncate at the cap boundary and append:

> … and N more — run `graphify explain <node>` for detail

The drill-down hint is mandatory: the user (or a sub-agent with an explicit budget) can always go deeper; the injected context never does.

---

## Staleness Check

Before **every** engine use, staleness is **content-based** (`isGraphifyGraphStale`, `src/cli/blueprint/graphify-enrich.ts`) — not mtime-vs-last-commit alone:

1. The graph is stale when the working tree has uncommitted SOURCE-file changes (`git status --porcelain`, counting only source-extension files per `isSourceFile` — touching e.g. markdown or the graphify output itself never marks it stale) **OR** the last commit time (`git log -1 --format=%ct`) is newer than the graph file's mtime
2. Staleness is **null (undeterminable)** when git is unavailable for both signals, or the graph file cannot be stat'ed — proceed with the graph as-is
3. If stale, refresh it: `graphify update .` (AST-only, incremental, 2–5s)
4. **Last-known-good on failed refresh**: a failed stale refresh means STALE, NOT ABSENT — keep using the last-known-good graph, loudly: `graphify refresh failed (<reason>) — using last-known-good graph from <ISO-8601 mtime>`. Only a **never-initialized** graph (no file at all, one build attempt failed) falls back native

**Documented limitation**: incremental updates re-extract changed files only — renamed symbols may linger in the graph until the user manually forces a full rebuild. This is accepted; plan-flow never forces a rebuild automatically.

**Validated against graphify 0.9.9** (2026-07-07, evidence archived with the plan's rounds record): the `--relation` flag is REPEATABLE (`--relation calls --relation imports`) — comma-joined values are treated as one unknown relation and silently return "No affected nodes found" with exit 0. The AST-only, no-LLM build/refresh command is `graphify update <path>` (`graphify extract` may trigger LLM calls when API keys are configured). The ~1,500-token output guard is load-bearing: `query --budget 1500` was measured emitting 4,812 chars, over the ~4,500-char cap.

---

## Universal Fallback Rule

Any of the following → **native behavior + one-line notice** (registry lifecycle step 5 — never an error, never blocks, registry entry unchanged):

- `engines.graphify: pending` — native-only with the persistent pending notice (see Required Posture & Install Rails)
- `which graphify` fails (tool not installed) — the notice includes the install command: `uv tool install graphifyy`
- `graphify-out/graph.json` does not exist (never initialized) — after ONE build attempt (`graphify update .`); only when that fails does the fallback fire, with the manual instruction in the reason: `no graph at graphify-out/graph.json — run: graphify update .`
- Any graphify invocation exits non-zero (except a failed STALE refresh, which uses the last-known-good graph instead — see Staleness Check step 4)
- Output is unparsable for the consuming step

Example notice:

> graphify unavailable (no graph at graphify-out/graph.json — run: graphify update .) — continuing with native dependency analysis.

---

## Consent-Time Build

On **Enable** (registry lifecycle steps 2–3), immediately after recording `engines.graphify: enabled`:

1. Run the headless AST-only build: `graphify update .` — no semantic/LLM pass, no viz; seconds, $0, offline
2. Report node and edge counts to the user (e.g. "graph built: 1,842 nodes, 6,310 edges")
3. Ask a **second yes/no question**: offer `graphify hook install` — a post-commit hook that auto-rebuilds the graph incrementally ($0, keeps the staleness check a no-op). Declining the hook is fine; the staleness check covers manual refresh.

Semantic/LLM enrichment is never run by plan-flow — users who want it run it themselves.
