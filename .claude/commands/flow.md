---
description: Configure plan-flow settings — autopilot mode, git control, PR creation, and other runtime options. Use key=value syntax.
---

# Flow: Plan-Flow Configuration

## Command Description

This command is the **central configuration hub** for plan-flow runtime settings. All settings use `key=value` syntax and are persisted in `flow/.flowconfig` (YAML format).

Settings include:
- **Autopilot mode** — auto-chain commands for feature requests
- **Git control** — auto-commit per phase, auto-push after completion
- **Branch targeting** — specify which branch to commit/push to

---

## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/flow - Plan-Flow Configuration

DESCRIPTION:
  Central configuration command for plan-flow runtime settings.
  All settings use key=value syntax and persist across sessions.

USAGE:
  /flow <key>=<value> [key=value ...]   Set one or more settings
  /flow <prompt>                         Enable autopilot and start flow with prompt
  /flow cost [--today|--week|--month]   Show token usage and cost report
  /flow -unset <key> [key ...]           Clear settings so their defaults apply again
  /flow -status                          Show all current settings
  /flow -reset                           Reset all settings to defaults
  /flow -help                            Show this help

SETTINGS:
  autopilot=true|false   Enable/disable autopilot mode (default: false)
  commit=true|false      Auto-commit after each completed phase (default: false)
  push=true|false        Auto-push after all phases + build/test pass (default: false)
  branch=<name>          Default BASE branch — what a worktree is cut from and what a PR opens against (default: current branch)
  remote=<name>          Default git remote for a thread's push/PR binding (default: origin)
  remote_branch_pattern=<pattern>  Naming convention suggested for a thread's remote branch, e.g. feature/{ticket} (default: unset)
  thread_worktrees=true|false  Give each thread its own worktree (default: true)
  worktree_start=here|trunk|branch:<name>  Where a thread's worktree starts when nobody names a start (default: here)
  base_refresh=true|false  Bring the base up to date before cutting a worktree (default: true)
  base_refresh_timeout_ms=1000-30000  How long that refresh may take (default: 8000)
  model_routing=true|false  Auto-select model per phase based on complexity (default: true)
  phase_isolation=true|false  Run each phase in isolated sub-agent with clean context (default: true)
  wave_execution=true|false  Run independent phases in parallel waves (default: true)
  max_verify_retries=1-5     Max repair attempts per task verification failure (default: 2)
  walkthrough_model=sonnet|opus|haiku  Which model writes a discovery's artifact page (/artifact) (default: sonnet)
  learn_auto=true|false      Re-learn a module automatically when its code drifts (default: true)
  learn_ignore=<globs>       Extra modules left out of learning, comma-separated (default: unset)
  pr=true|false         Auto-create PR via gh after execution (default: false)
  pr_draft=true|false   Open auto-PRs as GitHub drafts; /review-pr flips to ready (default: false)
  guarded_autopilot=true|false  Per-action classifier gate for autonomous execute-plan seams; pause+ask on irreversible actions (default: false)
  commands.lint=<cmd>    Project lint command used by pipeline gates (default: unset)
  share=local|shared     Share this project's knowledge with the team, or keep it local (default: local)

COST REPORTING:
  /flow cost                             Last 7 days summary (default)
  /flow cost --today                     Today's usage only
  /flow cost --week                      Last 7 days
  /flow cost --month                     Last 30 days
  /flow cost --project <name>            Filter by project name
  /flow cost --session <id>              Show single session detail
  /flow cost --detail                    Include model breakdown

EXAMPLES:
  /flow autopilot=true                    # Enable autopilot
  /flow commit=true push=true             # Enable git control (works without autopilot)
  /flow autopilot=true commit=true        # Enable both
  /flow branch=development                # Set target branch
  /flow commit=false push=false           # Disable git control
  /flow thread_worktrees=false            # Threads work in the project itself, no worktree per thread
  /flow worktree_start=trunk              # New worktrees start from the default branch by default
  /flow base_refresh=false                # Never fetch before cutting a worktree
  /flow base_refresh_timeout_ms=15000     # Allow that fetch 15 seconds
  /flow model_routing=false               # Disable model routing (use session model for all phases)
  /flow phase_isolation=false             # Disable phase isolation (inline execution, for debugging)
  /flow max_verify_retries=3             # Set max repair attempts per task verification to 3
  /flow pr=true                           # Enable auto-PR creation after execute-plan
  /flow commit=true push=true pr=true     # Full git control with auto-PR
  /flow pr=true pr_draft=true             # Auto-PRs open as drafts until reviewed
  /flow guarded_autopilot=true            # Gate each dangerous seam of autonomous execute-plan runs
  /flow commands.lint="npm run lint"      # Set the project lint command for pipeline gates
  /flow share=shared                      # Commit flow/ knowledge markdown with the code
  /flow share=local                       # Keep flow/ out of git (default; never deletes anything)
  /flow cost                              # Show cost report (last 7 days)
  /flow cost --today --detail             # Today's costs with model breakdown
  /flow -status                           # Show current config
  /flow -reset                            # Reset everything

  # Shorthand: text without key=value enables autopilot and starts flow
  /flow add dark mode support             # autopilot=true + start discovery
  /flow commit=true add user auth         # autopilot=true + git + start discovery

BEHAVIOR WHEN AUTOPILOT IS ON:
  - The harness chains the flow (discovery → plan → execute → review → the
    git tail) and issues each stage itself; a stage whose predecessor left no
    proof is refused
  - Nothing else changes: questions are answered, trivial tasks are done
    directly, other slash commands run as normal

GIT CONTROL (when commit=true):
  - After each phase completes: auto-commit
    "Phase N: <phase name> — <feature>"
  - After all phases + build/test pass: auto-push if push=true
  - If build/test fails: commit is made but push is skipped
  - push=true without commit=true: auto-enables commit=true
  - If pr=true: after push, create feature branch and open PR via gh pr create

HONOURED PAUSES (three, and no others):
  - high risk before anything is published (planflow-ai flow risk --check)
  - the guard classifier's ask (guarded_autopilot=true)
  - a branch nobody has bound, at publish time

CONFIG FILE:
  All settings stored in flow/.flowconfig (YAML)
  Backward compatible: also reads flow/.autopilot and flow/.gitcontrol
```

---

## Instructions

### Step 1: Parse Input

Parse the user input to determine what action to take:

1. **Check for `cost` subcommand**: If input starts with `cost`, route to cost reporting (see Step 6)
2. **Scan for `key=value` pairs**: Extract all `key=value` tokens from the input
3. **Check for flags**: `-status`, `-reset`, `-help`
4. **Remaining text**: Anything left after extracting keys and flags is a prompt

**Valid keys**:

| Key | Values | Default | Description |
|-----|--------|---------|-------------|
| `autopilot` | `true`, `false` | `false` | Enable/disable autopilot mode |
| `commit` | `true`, `false` | `false` | Auto-commit after each phase |
| `push` | `true`, `false` | `false` | Auto-push after completion |
| `branch` | any string | current branch | The project's default **base** — the branch a worktree is cut from and the branch a PR opens against |
| `remote` | any string | `origin` | Default git **remote** for a thread's push/PR binding. A remote name, never a URL; the binding a person confirms may name another |
| `remote_branch_pattern` | any string | unset | Naming convention **suggested** (never applied) for a thread's remote branch — placeholders `{ticket}`, `{slug}`, `{local}`, `{user}`, e.g. `feature/{ticket}`. A pattern whose `{ticket}` cannot be filled falls through to the next suggestion |
| `thread_worktrees` | `true`, `false` | `true` | Whether each thread gets its own worktree. Off means new threads work in the project itself — threads that already have a worktree keep it until it is released |
| `worktree_start` | `here`, `trunk`, `branch:<name>` | `here` | Where a thread's worktree starts when nobody names a start. A **default the start dialog pre-selects**, never a bypass of the ask (formerly `workspace_start` — the old name is still read, and accepted as input; a set writes both names with the same value and an unset removes both, while older builds still read the old one) |
| `base_refresh` | `true`, `false` | `true` | Whether the base is brought up to date before a worktree is cut. Off means no fetch, and therefore no may-be-behind flag either |
| `base_refresh_timeout_ms` | `1000`-`30000` | `8000` | How long that refresh may take. Clamped to the range wherever it is read, so no value can reopen an unbounded wait |
| `model_routing` | `true`, `false` | `true` | Auto-select model per phase based on complexity |
| `phase_isolation` | `true`, `false` | `true` | Run each phase in isolated sub-agent with clean context |
| `wave_execution` | `true`, `false` | `true` | Run independent phases in parallel waves |
| `max_verify_retries` | `1`-`5` | `2` | Max repair attempts per task verification failure |
| `walkthrough_model` | `sonnet`, `opus`, `haiku` | `sonnet` | Which model writes a discovery's artifact — its user walkthrough page — when `/artifact` runs. Claude runtime only — Copilot and Codex write it on the thread's own model |
| `learn_auto` | `true`, `false` | `true` | Re-learn a module automatically when its code drifts |
| `learn_ignore` | comma-separated globs | unset | Extra modules left out of learning |
| `pr` | `true`, `false` | `false` | Auto-create PR after execution completes (requires push: true) |
| `pr_draft` | `true`, `false` | `false` | Open auto-PRs as GitHub drafts — flipped to ready only by a clean `/review-pr` or explicit user approval (requires pr: true) (#655) |
| `guarded_autopilot` | `true`, `false` | `false` | Per-action classifier gate for autonomous execute-plan seams (push/PR/deletes/mutating bash) — pause+ask on irreversible actions; independent of the high-risk pause (#653) |
| `wave_execution` | `true`, `false` | `true` | Group independent phases into waves and run each wave's phases in parallel. The off-switch three other docs already point at |
| `worktree_links` | comma-separated paths | unset | Extra untracked entries a thread's worktree links in from the main checkout, beyond the built-in set — e.g. `.turbo, .next/cache` |
| `provider` | `claude`, `codex`, `copilot` | unset (global default) | The agent runtime for this project — a per-project override of the global default |
| `commands.lint` | any string | unset | Project lint command used by pipeline gates (e.g. `npm run lint`) |
| `share` | `local`, `shared` | `local` | Whether this project's plan-flow knowledge travels with the code. Drives the generated `.gitignore` block — **apply it with `planflow-ai share <mode>`, never by hand** (see Step 4b) |

> **Old key names still work.** The thread-worktree keys were once called `workspace_*`: `workspace_start`, `workspace_cap`, `workspace_setup` and `workspace_setup_timeout_ms` are read forever as aliases of `worktree_start`, `worktree_cap`, `worktree_setup` and `worktree_setup_timeout_ms` (while both are written, the old name wins when both are present — a build older than the rename writes only the old one). Nobody's file is rewritten behind their back — only a set touches a renamed key, and for now it writes BOTH names with the same value (an unset removes both), so older Flow builds that read only the old name stay in step. This dual-write is transitional, until those builds are retired.

---

### Step 2: Load Existing Config

1. Run `planflow-ai flow show --json`. It returns `config` (the fully-defaulted
   settings every consumer reads, legacy `flow/.autopilot` and `flow/.gitcontrol`
   fallbacks already applied) and `raw` (the keys this project actually sets).
   Read it to report what changed — the MERGE itself is the verb's job in Step 4,
   never a rewrite composed here.

---

### Step 3: Validate Settings

1. If `push=true` but `commit` is not `true`, auto-enable `commit=true` and warn:
   > `push=true` requires `commit=true`. Enabling auto-commit as well.
2. If `pr=true` but `push` is not `true`, auto-enable `push=true` and `commit=true` and warn:
   > `pr=true` requires `push=true` and `commit=true`. Enabling both.
2b. If `pr_draft=true` but `pr` is not `true`, auto-enable `pr=true` (which cascades push/commit per rule 2) and warn:
   > `pr_draft=true` requires `pr=true`. Enabling auto-PR as well.
2c. `guarded_autopilot` is independent — it does **not** cascade to or from `autopilot`, `pr`, `push`, or `commit`. It has effect **only during autonomous `/execute-plan` runs**, where it gates each dangerous seam (push, PR create, deletes outside the worktree, mutating bash); it is inert otherwise.
3. Cascades are applied at READ time by the config parser — `pr: true` already
   implies push and commit for every run that reads the file. Warn about them as
   above, but do not write the implied keys: a second place that has to agree
   with the parser is a second place that can disagree with it.
4. Everything else is validated by the verb, which knows every key's shape:
   an out-of-range `max_verify_retries`, a `base_refresh_timeout_ms` outside
   1000-30000, a `worktree_start` that is not `here` / `trunk` / `branch:<name>`,
   a `remote_branch_pattern` carrying a placeholder that cannot be filled, and a
   malformed remote or branch name are all REFUSED, never quietly clamped or
   rewritten — the setting a person is told about has to be the setting that gets
   written. Relay the `flow refused:` line as-is.
5. **Retired keys.** `webhook_url`, `telegram_bot_token` and `telegram_chat_id` are accepted so an old command does not error, but nothing reads them — the external notification channels were removed in `0d997af5` (2026-03-19) and the config parser has no extractor for any of the three (#1806). Do not write them to `.flowconfig`; say so instead:
   > Notifications are local only — the heartbeat log, the event stream and a desktop notification. Webhook and Telegram delivery were removed in March 2026, so `<key>` would not be read by anything. Nothing was written.

   Setting one silently would be worse than refusing it: the user would configure a channel, be told nothing is wrong, and never receive anything.

---

### Step 4: Save Config (run the verb — never edit the file)

`flow/.flowconfig` is hand-editable and co-owned: a person edits it in a terminal,
this skill writes keys into it, the heartbeat daemon reads it. Editing it line by
line from here is how a comment gets eaten, a duplicate key gets left behind, or a
value nobody would accept gets written. **Run the verb**, which validates every
key and value before it writes anything and touches only the lines it was asked
about:

```bash
planflow-ai flow set autopilot=true commit=true branch=development
planflow-ai flow unset branch                 # back to the default (absent = inherit)
planflow-ai flow show                         # what this project sets
planflow-ai flow show --json                  # the parsed config plus which keys are actually set
```

Rules:

| Rule | Description |
| --- | --- |
| **One call per batch** | Pass every pair to one `flow set`. The batch is validated whole — a bad value in it changes nothing. |
| **Refusals are the answer** | On an unknown key or an invalid value the verb prints one `flow refused: <reason>` line and exits 1. **Relay that line to the user; do not write the file yourself to get around it.** |
| **Unset, don't blank** | A setting goes back to its default by being REMOVED, not by being set to the default's current value — a parked value freezes the day the default moves. `/flow -unset <key>` runs `planflow-ai flow unset <key>`. |
| **`share` has its own applier** | See Step 4b. `planflow-ai flow set share=<mode>` routes to the same applier, so either invocation regenerates the `.gitignore` block. |

**Legacy marker files**: `flow/.autopilot` and `flow/.gitcontrol` are read as a
FALLBACK when `.flowconfig` does not carry a key, and are never written. After
setting `autopilot`, delete `flow/.autopilot` if it exists, so the two can never
disagree about a setting the key now owns.

---

### Step 4b: Applying `share=` (NEVER hand-edit .gitignore)

`share` is the one key that also regenerates the marker-delimited plan-flow block in `.gitignore`, so it is **not** written by editing the config file yourself. Run:

```bash
planflow-ai share <local|shared>     # applies the setting AND regenerates the block
planflow-ai share                    # reports the current setting
```

The command persists `share:` to `flow/.flowconfig`, regenerates the block from it, and reports which existing files became trackable (or were re-ignored). Relay that report to the user — switching to `shared` means the project's knowledge markdown starts being committed, which publishes it.

Rules:

| Rule | Description |
| --- | --- |
| **Generated, never hand-tuned** | The block is regenerated from `share` on every provision. A hand edit is undone by the next `init` — if the block is wrong, the fix belongs in the generator, not the file. |
| **Default is local** | A project that never answered stays local. Provisioning never flips it. |
| **Switching back never deletes** | `share=local` re-ignores paths; it removes no file. Already-committed knowledge stays in git history until the user removes it deliberately. |
| **`local`** | `/flow` ignored wholesale (root-anchored, no trailing slash — the top-level `flow` is a symlink, which git sees as a file). |
| **`shared`** | Only the derived layer is ignored: `flow/brain/.raw/`, `flow/brain/.structure/{graph.json,graph.prev.json,symbols.jsonl,file-stamps.json,file-tiers.json}`, `flow/brain/code/`, plus `graphify-out`, `.plan-flow.yml`, `.plan.flow.env`, and `.brain.sqlite` (the retired index — kept ignored so a leftover from an older provision can never be committed). |

---

### Step 5: Handle Action

#### If `-status` or no arguments and no key=value pairs

Show current config:

```markdown
**Plan-Flow Configuration**

| Setting | Value |
|---------|-------|
| Autopilot | enabled/disabled |
| Auto-commit | true/false |
| Auto-push | true/false |
| Branch | <name> or (current) |
```

#### If `-reset`

1. Run `planflow-ai flow show --json` and read `raw` — the keys this project
   actually sets
2. Run `planflow-ai flow unset <key> [key ...]` for all of them, so every setting
   goes back to its default while the file's comments and any keys outside the
   settings table survive
3. Delete the legacy `flow/.autopilot` and `flow/.gitcontrol` if they exist
4. Confirm: "All plan-flow settings reset to defaults."

#### If `-unset <key> [key ...]`

1. Run `planflow-ai flow unset <key> [key ...]`
2. Report each key that was cleared, and each that was already at its default

#### If only key=value pairs (no prompt text)

1. Save settings by running `planflow-ai flow set` once with every pair (Steps 2-4)
2. Confirm what changed:

```markdown
Settings updated:
- commit: false → **true**
- push: false → **true**
```

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.

#### If prompt text remains (with or without key=value pairs)

This is a **feature request with autopilot**:

1. Set `autopilot: true` (if not already)
2. Save all settings (Steps 2-4)
3. Confirm settings briefly (one line)
4. **Immediately start the flow** by invoking `/discovery-plan` with the prompt

**Examples**:
- `/flow add dark mode` → `autopilot=true`, start discovery
- `/flow commit=true push=true add user auth` → `autopilot=true, commit=true, push=true`, start discovery

---

### Step 6: Cost Reporting (`/flow cost`)

If the input starts with `cost`, route to the cost reporting flow:

1. **Load the skill**: Read `.claude/resources/skills/flow-cost.md` for full implementation details
2. **Parse cost flags**: `--today`, `--week`, `--month`, `--project <name>`, `--session <id>`, `--detail`
3. **Read metrics file**: `~/.claude/metrics/costs.jsonl`
4. **Filter and aggregate**: Apply time/project/session filters, group by project
5. **Display summary table**: Format tokens (K/M), costs ($X.XX), present as markdown table
6. **STOP**: After showing the report, wait for user input

**Default behavior** (no flags): Show last 7 days summary grouped by project.

See `.claude/resources/skills/flow-cost.md` for detailed formatting rules and examples.

---

## Critical Rules

| Rule | Description |
| --- | --- |
| **Single config file** | All settings in `flow/.flowconfig`, written ONLY by `planflow-ai flow set` / `flow unset`. `.autopilot` and `.gitcontrol` are read as legacy fallbacks and never written. |
| **Key=value syntax** | All settings use `key=value`. No `-enable`/`-disable` flags needed (use `autopilot=true/false`). |
| **Settings are independent** | `commit=true` works without `autopilot=true`. Git control applies to any `/execute-plan` run. |
| **Complete and stop** | After updating settings, STOP and wait for user input (unless a prompt was provided). |
| **Backward compatible** | Still reads `flow/.autopilot` and `flow/.gitcontrol` if `.flowconfig` doesn't exist yet. |

---

## Config File Format

```yaml
# flow/.flowconfig — plan-flow runtime settings
# Managed by /flow command. Do not edit manually.

autopilot: false
commit: false
push: false
branch: ""
remote: origin
remote_branch_pattern: feature/{ticket}
thread_worktrees: true
worktree_start: here
base_refresh: true
base_refresh_timeout_ms: 8000
model_routing: false
phase_isolation: true
wave_execution: true
max_verify_retries: 2
walkthrough_model: sonnet
pr: false
pr_draft: false
guarded_autopilot: false
commands.lint: npm run lint
share: local
```

**Dotted keys**: `commands.*` are flat dotted keys — no YAML nesting or section syntax. Omit them when unset; the lint gate falls back to the package.json `lint` script, or skips silently if none exists.

`engines.*` is **not a setting** any more, and `/flow` does not offer it. No engine takes a user's consent today: graphify has been always-on since #142 (availability-gated, legacy `enabled`/`declined` values ignored) and lavish is retired — `/create-plan` never reads `engines.lavish` whatever it says (#1807). Nothing writes an `engines.*` key at all any more (#1808) — the install rails used to record `enabled`/`pending`, which read as a setting and was not one. If a user asks to set an engine key, say so rather than writing one nothing reads:

> No engine is configurable — graphify is always on when it is installed, and lavish was retired. Nothing reads `<key>`, so nothing was written.

**Location**: `flow/.flowconfig`
**Format**: YAML
**Persists**: Across sessions (file-based)
