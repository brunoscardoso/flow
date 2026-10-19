# Plan-Flow

Structured AI-assisted development workflows for discovery, planning, execution, code reviews, and testing.

Built for **Claude Code** and the **Flow IDE**. (Multi-IDE support — Cursor, OpenClaw, Codex CLI — was removed 2026-07-22; additional models may return later via a model router.)

## Quick Start

```bash
npx planflow-ai init
```

Installs slash commands (`.claude/commands/`), core rules (`.claude/rules/`), and reference docs (`.claude/resources/`) into your project. Creates or updates your `CLAUDE.md` with plan-flow instructions.

### Flow IDE (macOS, Apple Silicon)

Download the latest `.dmg` from [Releases](../../releases/latest), open it, and drag Flow to Applications. After the first install the app updates itself in place — it reads this repository's release feed, so there is nothing further to download by hand.

Windows builds (installer and portable) are attached to the same releases. They are unsigned and have no update feed, so a Windows update is a manual re-download.

### Options

| Flag | Description |
|------|-------------|
| `--force` | Overwrite existing files |
| `--target <dir>` | Target directory (defaults to current) |
| `-y, --yes` | Non-interactive — take the default for every question |

## Commands

| Command | Description |
|---------|-------------|
| `/setup` | Analyze project and generate pattern files |
| `/discovery-plan` | Create discovery document for requirements |
| `/create-plan` | Create implementation plan with phases |
| `/execute-plan` | Execute plan phases with verification |
| `/create-contract` | Create integration contract from API docs |
| `/review-code` | Review local uncommitted changes (adaptive depth + multi-agent) |
| `/review-pr` | Review a Pull Request (adaptive depth + multi-agent) |
| `/write-tests` | Generate tests for coverage target |
| `/brainstorm` | Free-form idea exploration with interactive questions |
| `/flow` | Configure plan-flow settings (autopilot, git control, runtime options) |
| `/note` | Capture meeting notes, ideas, brainstorms |
| `/artifact` | Write a discovery's artifact — the walkthrough page of what users will see |
| `/learn` | Extract reusable patterns or learn a topic step-by-step |
| `/heartbeat` | Manage scheduled automated tasks |
| `/resume-work` | Resume interrupted work from STATE.md |
| `state-query` | Search the project's markdown knowledge for relevant documentation (CLI: `planflow-ai state-query "topic"`) |

## Workflow

### Manual (default)

```
1. /setup           -> Index project patterns (run once)
2. /brainstorm      -> (Optional) Explore and crystallize a vague idea
3. /discovery-plan  -> Gather requirements for a feature
4. /create-plan     -> Create structured implementation plan
5. /execute-plan    -> Execute the plan phase by phase
6. /review-code     -> Review changes before committing
```

### Autopilot Mode

Enable autopilot with `/flow autopilot=true` and the harness runs the workflow
itself — discovery, plan, execute, review, then the git tail:

```
You: "Add dark mode support"

  -> Discovery
  -> Create plan     (refused if discovery left no document)
  -> Execute plan    (refused if the plan does not parse)
  -> Review code     (refused if no phase ever ran)
  -> Publish         (only past the three pauses below)
```

The chain is **code, not an instruction**: each stage is issued from observable
state, and a stage whose predecessor left no proof is refused rather than run.

**Three pauses are honoured, and no others** — each is a seam where a wrong
action leaves your machine:
- **`high` risk before publishing**: the changeset's post-execution rating (or
  the absence of one) withholds the push/PR until you say so
- **The guard classifier's `ask`**: an irreversible action pauses when
  `guarded_autopilot` is on
- **An unbound branch**: nothing is published to a remote branch nobody chose

## Core Features

### Engine Registry & Visual Plan Review

Plan-flow can delegate specific steps to optional external engines, always with a native fallback -- if an engine is unavailable or declined, the step runs natively with a one-line notice. Consent is asked once per project and recorded in `flow/.flowconfig` as `engines.<name>: enabled|declined`; declined engines are never re-asked.

Engine #1: **lavish** -- during `/create-plan`, it renders an interactive visual plan review at `flow/.lavish/<plan-name>.html`. Your review decisions fold back into the plan and are recorded as `plan_decision` entries in the rounds record.

Engine #2: **graphify** -- a Python code-graph tool you install yourself (`uv tool install graphifyy` or `pipx install graphifyy`; detected via `which graphify`; consent key `engines.graphify`). When enabled, it builds a code graph at `graphify-out/graph.json` (repo root, auto-gitignored in your project) and powers structural blast-radius context in code reviews plus advisory phase-dependency suggestions during planning. See `.claude/resources/core/graphify-engine.md`.

### Wave-Based Parallel Execution

Independent phases run in parallel within waves, with dependency-aware grouping:

```
Wave 1 (parallel): Phase 1: Types, Phase 2: Utilities
Wave 2 (sequential): Phase 3: API Integration (depends on 1+2)
Wave 3 (parallel): Phase 4: Config, Phase 5: UI Components
Wave 4 (sequential): Phase 6: Tests (always last)
```

Plans support a `**Dependencies**:` field per phase. Topological sort assigns wave numbers automatically. Phases without dependencies run in Wave 1. Tests always run in their own final wave.

When the graphify engine is enabled, `/create-plan` adds advisory structural dependency suggestions (italic annotations under `Dependencies` fields plus a "Structural conflict predictions (graphify, advisory)" note in the Execution Strategy) -- wave computation ignores annotations, and authored dependencies always win.

Enable with `/flow wave_execution=true` (default: on).

### Multi-Agent Coordination

During wave execution, parallel phases share a context file (`flow/.wave-context.jsonl`) that enables real-time coordination. Agents share:

- **API contracts** -- endpoint shapes, type interfaces, function signatures
- **Decisions** -- architecture choices, library selections
- **Progress** -- task completion status

Before each task, sub-agents receive shared context from sibling phases -- preventing broken contracts and duplicate decisions. Post-wave processing includes contract conflict detection: same API name with different signatures triggers user intervention.

Conflict metrics (`File conflicts: N · Contract conflicts: M`) are reported in wave reports, the completion summary, and the PR Pipeline section.

### Brain Index (SQLite)

All markdown files are searched directly with ripgrep and a deterministic ranker — no index, no database, no embedding runtime to install. Query with `planflow-ai state-query "topic"` to find relevant documentation instantly. Replaces the previous reference code system, and the SQLite FTS5 + vector index that briefly replaced that; word queries in the project's own vocabulary, since matching is lexical rather than semantic.

### Phase Isolation

Each phase runs in an isolated sub-agent with a clean context window. The sub-agent receives only the context it needs (phase spec, files modified so far, patterns, design context) and returns a structured JSON summary. This eliminates context rot -- phase 7 has the same quality as phase 1.

Disable with `/flow phase_isolation=false`.

### Per-Task Verification

Plan tasks can include `<verify>` tags with shell commands. After completing each task, the sub-agent runs verification automatically. On failure, a debug sub-agent (haiku) diagnoses the root cause and the implementation agent applies repairs (up to `max_verify_retries` attempts, default: 2). Only mechanical repairs are auto-applied — repairs that would change product behavior are withheld and escalated to you.

Verification results capture evidence: what was tested (`tested`, `testing_summary`) and artifacts (`path` | `url` | `content`), written to the gitignored `flow/.evidence/<run-id>/` directory. UI-affecting tasks request visual evidence (screenshot/video/rendered HTML) when browser tooling is available.

### Risk Assessment & Execution Rounds

Every execution writes an append-only rounds record (`flow/.rounds.jsonl`) — verification results, phase results, risk, and escalations — archived with the plan. After all phases, the full changeset gets a post-execution risk level (`low`/`medium`/`high` + one-sentence rationale). In autopilot mode, `high` risk pauses before push/PR for explicit approval.

### Lint Gate

After all phases, execution runs a lint gate. Command resolution: `commands.lint` in `flow/.flowconfig` → `lint` script in `package.json` → skipped silently if neither exists. The completion summary reports one line: `Lint: passed | N repairs | forced | not configured`.

### Atomic Commits Per Task

When `commit=true`, each individual task within a phase gets its own git commit (not per phase). Format: `feat(phase-N.task-M): description`. Enables `git bisect`, independent reverts, and clearer git history.

### Auto-PR Creation

When `pr=true`, after execution completes (build+test pass), plan-flow automatically creates a feature branch and opens a PR via `gh pr create`. The PR body has five sections — **Intent / What Changed / Risk Assessment / Testing / Pipeline** — regenerated deterministically from the rounds record (`flow/.rounds.jsonl`) + the plan, including inline evidence excerpts (size-capped) and a per-phase pipeline table.

### Model Routing

By default, each phase is auto-routed to the most cost-effective model for its complexity. Turn it off with `/flow model_routing=false` to run every phase on the most capable model from the active provider:

| Complexity | Tier | Model |
|-----------|------|-------|
| 0-3 | Fast | haiku |
| 4-5 | Standard | sonnet |
| 6-10 | Powerful | opus |

### Design Awareness

Discovery asks whether features involve UI work. If confirmed, captures structured design tokens (colors, typography, spacing) into a Design Context section. During execution, tokens are auto-injected into UI phase prompts. Includes 6 built-in design personalities.

### Pattern Capture

During skill execution, the LLM silently buffers coding patterns and anti-patterns. At the end, captured patterns are presented for approval and written to `.claude/rules/core/allowed-patterns.md` or `forbidden-patterns.md`.

### Session Resumability (STATE.md)

`flow/STATE.md` tracks decisions, blockers, current position, and active phase. If a session is interrupted, `/resume-work` rebuilds full context from stored files and continues from where you left off.

### Deterministic State Script

Config and state parsing runs as a Node.js script (`planflow-ai state`) that returns structured JSON -- deterministic logic in code, not prompts. Ensures reliable flowconfig reading, phase calculations, and file existence checks.

## Flow Configuration (`/flow`)

The `/flow` command is the central configuration hub. All settings use `key=value` syntax and persist in `flow/.flowconfig` (YAML).

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `autopilot` | `true/false` | `false` | Enable/disable autopilot mode |
| `commit` | `true/false` | `false` | Auto-commit after each completed task |
| `push` | `true/false` | `false` | Auto-push after all phases + build/test pass |
| `pr` | `true/false` | `false` | Auto-create PR after execution |
| `branch` | any string | current branch | Target branch for git operations |
| `wave_execution` | `true/false` | `true` | Dependency-aware parallel phase execution |
| `phase_isolation` | `true/false` | `true` | Isolated sub-agent per phase |
| `model_routing` | `true/false` | `true` | Cost-based model selection per phase |
| `max_verify_retries` | `1-5` | `2` | Max repair attempts per task verification |
| `engines.<name>` | `enabled/declined` | unset | Consent for an external engine (asked once on first use) |
| `engines.graphify` | `enabled/declined` | unset | Graphify code-graph engine: review blast radius + advisory planning dependencies |
| `commands.lint` | any command | unset | Lint command for the post-execution lint gate |

### Examples

```bash
/flow autopilot=true                    # Enable autopilot
/flow commit=true push=true pr=true     # Full git control with auto-PR
/flow wave_execution=false              # Disable parallel execution
/flow phase_isolation=false             # Inline execution (for debugging)
/flow model_routing=false               # Disable cost-based model routing
/flow -status                           # Show current config
/flow -reset                            # Reset everything

# Shorthand: text without key=value enables autopilot and starts flow
/flow add dark mode support             # autopilot=true + start discovery
```

### Git Control

When `commit=true`, plan-flow auto-commits after each completed task:

```
feat(phase-1.task-1): Create user types -- user-auth
feat(phase-1.task-2): Add validation schemas -- user-auth
feat(phase-2.task-1): Create login endpoint -- user-auth
...
Build + Test pass -> git push origin development (if push=true)
                  -> gh pr create (if pr=true)
```

## Heartbeat (Scheduled Automation)

The heartbeat daemon is a background process that executes scheduled tasks defined in `flow/heartbeat.md`.

### Schedule Syntax

| Syntax | Example |
|--------|---------|
| `daily at {HH:MM AM/PM}` | `daily at 10:00 PM` |
| `every {N} hours` | `every 6 hours` |
| `every {N} minutes` | `every 30 minutes` |
| `weekly on {day} at {HH:MM}` | `weekly on Monday at 9:00 AM` |
| `in {N} hours` | `in 2 hours` (one-shot) |
| `in {N} minutes` | `in 30 minutes` (one-shot) |

### Daemon Management

```bash
npx planflow-ai heartbeat start    # Start the daemon
npx planflow-ai heartbeat stop     # Stop the daemon
npx planflow-ai heartbeat status   # Show daemon status
```

The daemon **auto-starts** during `planflow-ai init` if `flow/heartbeat.md` exists.

### Notifications

The daemon sends OS desktop notifications (via node-notifier) for task completions, failures, and blocked tasks. Events are also logged to `flow/log.md` and `flow/.heartbeat-events.jsonl`.

### One-Shot Tasks

Tasks with `in {N} hours/minutes` schedules run once and auto-disable after execution.

### Retry on Active Session

If a task fails because a Claude Code session is already active, the daemon retries up to 5 times at 60-second intervals.

## Code Review

`/review-code` and `/review-pr` include three layers of intelligence:

### Adaptive Depth

| Lines Changed | Mode | Behavior |
|--------------|------|----------|
| < 50 | Lightweight | Quick-scan for security, logic bugs, and breaking changes only |
| 50-500 | Standard | Full review with pattern matching and similar implementation search |
| 500+ | Deep | Multi-pass review with file categorization, executive summary, and multi-agent analysis |

### Verification Pass

Every finding goes through a second-pass verification that re-reads surrounding context to classify findings as Confirmed, Likely, or Dismissed. False positives are filtered before output.

### Finding Actions

Every finding carries an `action` classification: `auto-fix` (non-functional, safely fixable), `ask-user` (touches product behavior or deliberate intent — relayed verbatim, never silently resolved), or `no-op` (informational). Default is `ask-user`. Review auto-fix stays off by default — the taxonomy is classification-only for now.

### Re-Review Memory

Review verdicts are recorded as `review_verdict` entries in the rounds record (fingerprint: file + title + category). On re-review, previously dismissed findings are not re-reported unless the code materially changed; `ask-user` findings are never suppressed. Outside a plan context, `/review-code` asks one ad-hoc intent question to anchor findings against intended behavior; `/review-pr` falls back to the PR description.

### Structural Context (graphify)

When the graphify engine is enabled, review sub-agent prompts include a `## Structural Context` block and review documents gain a `### Verify These Dependents` section (omitted when the engine is off). Graphify risk signals (e.g., "touches god node X (N edges)", "spans M communities") are raise-only -- they can raise but never lower a finding's severity floor.

### Multi-Agent Parallel Review

In Deep mode (500+ lines), 4 specialized subagents run in parallel:

| Agent | Focus | Model |
|-------|-------|-------|
| Security | Vulnerabilities, secrets, injection, auth bypass | sonnet |
| Logic & Bugs | Edge cases, null handling, race conditions | sonnet |
| Performance | N+1 queries, memory leaks, blocking I/O | sonnet |
| Pattern Compliance | Forbidden/allowed patterns, naming consistency | haiku |

## Complexity Scoring

Every plan phase has a complexity score (0-10):

| Score | Level | Description |
|-------|-------|-------------|
| 0-2 | Trivial | Simple, mechanical changes |
| 3-4 | Low | Straightforward implementation |
| 5-6 | Medium | Moderate complexity |
| 7-8 | High | Complex, multiple considerations |
| 9-10 | Very High | Significant complexity/risk |

## Discovery Sub-Agents

During `/discovery-plan`, three parallel sonnet sub-agents explore the codebase simultaneously (similar features, API/data patterns, schema/types). Returns condensed findings merged into a Codebase Analysis section.

## Project Brain and Knowledge Graph

All projects are linked into a central Obsidian vault at `~/plan-flow/brain/`. Each `planflow-ai init` creates a project directory in the vault with symlinks for brain subdirectories.

Features:
- `flow/brain/features/` -- Feature history and context with `[[wiki-links]]`
- `flow/brain/errors/` -- Reusable error patterns
- `flow/ledger.md` -- Persistent project learning journal
- `flow/memory.md` -- Last 7 days of completed work
- `flow/.scratchpad.md` -- Ephemeral per-session notes

Open `~/plan-flow/brain/` as an Obsidian vault to browse all projects in one graph.

## Directory Structure

```
flow/
├── archive/              # Completed/abandoned plans
├── brain/                # Automatic knowledge capture (Obsidian-compatible)
│   ├── index.md          # Brain index
│   ├── features/         # Feature history and context
│   └── errors/           # Reusable error patterns
├── brainstorms/          # Brainstorm exploration documents
├── contracts/            # Integration contracts
├── discovery/            # Discovery documents
├── plans/                # Active implementation plans
├── references/           # Reference materials
├── resources/            # Valuable artifacts from skill execution
├── reviewed-code/        # Code review documents
├── reviewed-pr/          # PR review documents
├── tasklist.md           # Project task list
├── memory.md             # Persistent artifact tracker
├── heartbeat.md          # Scheduled task definitions
├── log.md                # Heartbeat event log
├── ledger.md             # Project learning journal
├── STATE.md              # Execution state for session resumability
├── .flowconfig           # Central config file
├── .wave-context.jsonl   # Shared context for multi-agent coordination
├── .rounds.jsonl         # Append-only execution record (archived with the plan)
├── .evidence/            # Per-task verification evidence (local-only, gitignored)
├── .lavish/              # Visual plan review artifacts (<plan-name>.html)
├── .heartbeat-events.jsonl  # Notification event stream
├── .heartbeat-state.json    # Session read position tracking
└── .gitcontrol        # Git control settings (backward compat)
```

### Brain Index Database

There is no brain index. The markdown under `flow/brain/` **is** the store, so nothing needs building or rebuilding. Projects created before this still have a `.brain.sqlite` at their root; it is gitignored, never read, and safe to delete.
```

## Requirements

- Node.js 18+
- `git` -- For version control
- `gh` -- GitHub CLI (for PR reviews and auto-PR)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run init CLI
node dist/cli/index.js init --all

# Development mode
npm run dev

# Run tests
npm run test
```

## License

MIT
