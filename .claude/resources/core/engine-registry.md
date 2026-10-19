
# Engine Registry

## Purpose

Let plan-flow commands use battle-tested external tools as **optional, consent-based engines** with guaranteed native fallback. An engine is never a dependency: its absence, decline, or failure degrades to plan-flow's built-in behavior — it never blocks a command.

> **Exception — graphify is always-on (#142).** Graphify does NOT use this consent model: it is a required backbone dependency, installed under the hood with no opt-in/decline/re-prompt, gated purely on availability (`which graphify`). Legacy `engines.graphify` values are ignored. See `.claude/resources/core/graphify-engine.md`. The consent lifecycle below applies to the remaining engines.

> **Deprecation — lavish is retired.** `/create-plan`'s visual plan review no longer uses lavish; plan review is native: the plan's change notes, reviewed in the code story (see Plan Change Review in `CLAUDE.md`). There is no `blueprint render --story` flag any more. Any existing `engines.lavish` key in `flow/.flowconfig` is **ignored** — ​`/create-plan` never checks it and never invokes lavish, regardless of `enabled`/`declined`. There is no re-prompt: the key is simply dead. A command that would have consulted it instead prints the one-line notice `lavish is retired — plan review now uses the blueprint story walkthrough` (shown at most once, on first `/create-plan` run after upgrade) and proceeds with the story review.

**Config Location**: `flow/.flowconfig` — flat dotted keys `engines.<name>: enabled|declined`
**Consumers**: Any command with an engine-backed step (currently: graphify structural analysis in `/create-plan`, `/review-code`, `/review-pr`)

---

## Engine Lifecycle

Every engine follows the same five-step lifecycle. Commands implement these steps at the point where the engine would be used — never at init time.

### 1. Detect

Before offering an engine, check whether the tool is invocable on this machine:

- npm-distributed tools: `npx -y <pkg> --version` (short timeout; treat non-zero exit as absent)
- Binaries: `which <tool>`

If detection fails, skip consent entirely and use native behavior with a one-line notice. Do not record anything — detection may succeed later.

### 2. Consent (once per project)

If the tool is invocable and `engines.<name>` is **not present** in `flow/.flowconfig`, ask for consent at the moment of first use — in-context, not at init:

1. Explain in 3-4 lines: what the tool is, that it will be fetched via `npx` (nothing permanently installed), and what it will do in this workflow
2. Ask via `AskUserQuestion` with two options: **Enable** (use the engine in this project from now on) and **Decline** (always use native behavior)

Example consent framing for graphify:

> Reviews and planning can use **graphify** — a local AST knowledge graph (MIT, offline, no LLM cost) — for structural blast radius and phase dependency suggestions. On enable, it builds the graph now (AST-only, seconds, $0). It's already installed on this machine. Enable it for this project?

### 3. Record

Write the answer to `flow/.flowconfig` immediately (direct edit, same style as `/flow`):

```yaml
engines.gnhf: enabled
```

or

```yaml
engines.gnhf: declined
```

**Declined engines are NEVER re-asked.** A `declined` entry is a permanent answer that only the user can change, via `/flow engines.<name>=enabled`. Re-prompting after a decline is a hard rule violation.

### 4. Use

Commands check the registry **before** invoking an engine:

| Registry state | Behavior |
|----------------|----------|
| `engines.<name>: enabled` | Invoke the engine |
| `engines.<name>: declined` | Native behavior, silently (no notice, no re-ask) |
| Key absent | Run detect → consent → record, then act on the answer |

Only `enabled` ever triggers an invocation.

### 5. Fallback

Absent tool, declined consent, or invocation failure (crash, timeout, bad output) → **native behavior with a one-line notice**, e.g.:

> graphify unavailable (exit 1) — continuing with native structural analysis.

Fallback is never an error and never blocks the command. A failed invocation does not change the registry entry — `enabled` stays `enabled`; the engine is simply retried next time.

---

## Engine Catalog

| Engine | Purpose | Integration point | Status |
|--------|---------|-------------------|--------|
| `lavish` | ~~Visual plan review — renders the draft plan + open decisions as an interactive HTML artifact~~ | ~~`/create-plan` (visual review step)~~ | **Deprecated** — retired; superseded by the native blueprint story walkthrough (see deprecation note above and `.claude/resources/core/blueprint.md`, Story Layer). `engines.lavish` keys are ignored, never re-asked, never invoked |
| `graphify` | Structural blast radius for reviews + phase dependency suggestions for planning | `/review-code`, `/review-pr`, `/create-plan` | Active (Cycle 2) |
| `gnhf` | Objective loops — goal-driven iterate-until-done execution | `/execute-plan` | Placeholder (Cycle 2) |
| `treehouse` | Worktree waves — isolated git worktrees per parallel phase | `/execute-plan` wave coordinator | Placeholder (trigger-based: adopted when wave conflict metrics justify it) |

Placeholder engines have no integration yet — they are listed so their names are reserved and their eventual adoption requires no registry changes.

**graphify note**: unlike npm-fetched engines, graphify is a Python tool installed via the user's package managers — `uv tool install graphifyy` or `pipx install graphifyy`. Detection is `which graphify`; when detection fails, the one-line notice shows that install command so the user can opt in later. Engine mechanics (invocation patterns, output token guard, staleness check, consent-time build) live in `.claude/resources/core/graphify-engine.md`.

**graphify consent carve-out**: graphify's consent lifecycle deviates from the general rules in exactly two ways (all other registry rules stay intact). First, its registry key has a **third recorded state** — `engines.graphify: pending` — meaning consented via the `planflow-ai init` install rails but not yet installed; while `pending`, blueprint derive runs native-only with a persistent install notice. Second, projects that declined graphify when it was optional get a **one-time migration re-prompt** at init (graphify is now a required backbone dependency of the blueprint); the answer is recorded as `engines.graphify_migration_asked: true` so it is never asked again. See `.claude/resources/core/graphify-engine.md` (Required Posture & Install Rails).

---

## Adding a New Engine

The registry is engine-agnostic: adding an engine requires **zero changes** to the config parser or this lifecycle. Checklist:

1. **Pick a name**: lowercase, `[a-z0-9_-]+` (this is what the parser accepts in `engines.<name>`)
2. **Add a catalog row** to the table above: purpose, integration point, status
3. **Document the detect command** (e.g. `npx -y <pkg> --version`) in the consuming command's docs
4. **Write the 3-4 line consent explanation** into the consuming command at the point of first use
5. **Implement the fallback path first** — the native behavior must exist and work before the engine is wired in
6. **Reference this file** from the consuming command instead of restating the lifecycle
7. Optionally create `flow/references/tool-<name>.md` with a deep study of the tool

No TypeScript changes are needed: `flowconfig-parser.ts` already collects any `engines.<name>: enabled|declined` key into `FlowConfig.engines`.

---

## Rules

1. **Optional forever**: an engine is never required; native behavior must always exist and work
2. **Consent before first invocation**: never invoke an engine that isn't recorded as `enabled`
3. **Ask once per project**: consent happens at first use, and `declined` is never re-asked — only `/flow engines.<name>=enabled` reverses it
4. **Record immediately**: write the consent answer to `flow/.flowconfig` before proceeding
5. **Fail soft**: any engine failure degrades to native behavior with a one-line notice — never an error, never a block
6. **Flat dotted keys only**: `engines.<name>: enabled|declined` — no YAML nesting or section syntax in `.flowconfig`
7. **Registry is generic**: new engines plug in via the catalog + consuming command docs, with zero parser or lifecycle changes
