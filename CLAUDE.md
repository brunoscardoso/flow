# Plan-Flow: Structured AI-Assisted Development

This project provides a structured workflow system for AI-assisted development with 12+ skills for discovery, planning, execution, brainstorming, contracts, code reviews, and testing. It also includes the **Project Ledger**, **Pattern Capture**, **Model Routing**, and **Design Awareness** — building institutional memory and optimizing execution across sessions.

## Quick Start

Use slash commands to invoke skills:

| Command | Purpose |
|---------|---------|
| `/setup` | Analyze project and generate pattern files |
| `/discovery-plan` | Create discovery document for requirements gathering |
| `/create-plan` | Create implementation plan with phases and complexity scores |
| `/execute-plan` | Execute plan phases with verification |
| `/create-contract` | Create integration contract from API docs |
| `/review-code` | Review local uncommitted changes |
| `/review-pr` | Review a Pull Request |
| `/write-tests` | Write tests to achieve coverage target |
| `/brainstorm` | Free-form idea exploration with collaborative dialogue |
| `/note` | Manual brain entry (capture meeting notes, ideas, brainstorms) |
| `/artifact` | Write a discovery's artifact — the walkthrough page of what users will see (on request) |
| `/learn` | Extract reusable patterns from current session |
| `/heartbeat` | Manage scheduled automated tasks via the heartbeat daemon |
| `/resume-work` | Resume interrupted work using saved execution state |
| `/flow` | Configure plan-flow settings — autopilot, git control, model routing, PR creation, runtime options (`key=value` syntax) |

## Workflow

The recommended workflow is:

1. `/setup` - Run once to index project patterns
2. `/brainstorm` - (Optional) Explore and crystallize a vague idea
3. `/discovery-plan` - Gather requirements for a new feature
4. `/create-plan` - Create structured implementation plan (with per-function change notes reviewed in the code story as Today / Proposal / Verify, and advisory structural dependency suggestions when graphify is installed)
5. `/execute-plan` - Execute the plan phase by phase
6. `/review-code` or `/review-pr` - Review changes before merging

## Core Features

### Model Routing

By default, `/execute-plan` routes each phase to the most cost-effective model for its complexity score. Disable with `/flow model_routing=false` to run every phase on the **most capable/recent model** from the active provider (e.g., opus for Anthropic, o3 for OpenAI):

| Complexity | Tier | Model |
|-----------|------|-------|
| 0-3 | Fast | haiku |
| 4-5 | Standard | sonnet |
| 6-10 | Powerful | opus |

See `.claude/resources/core/model-routing.md` for full rules.

### Design Awareness

Discovery always asks whether a feature involves UI work. If confirmed, it captures structured design tokens (colors, typography, spacing, component patterns) into a `## Design Context` section. During execution, these tokens are auto-injected into UI phase prompts.

Features:
- 6 built-in design personalities (Stark, Aura, Neo, Zen, Flux, Terra)
- Screenshot analysis for token extraction
- Optional `interface-design` plugin integration (works without it)

See `.claude/resources/core/design-awareness.md` for full rules.

### Feature View

Every discovery has **two perspectives**: the technical one — what the **code** would become, which the discovery document, its `## Story` and its change brief carry — and the **feature view**, called the **artifact** everywhere in the app since 2026-10-08. The artifact is what **users** will see: a self-contained HTML page written beside the discovery as `flow/discovery/discovery_<slug>_v<N>.walkthrough.html`, styled as the **target app** and never as Flow, and reviewed, versioned and archived with its discovery.

**It is written on request, never by discovery itself** — the DISCOVERY card's **Generate artifact**, or `/artifact @<discovery path>` typed by hand — and it is cheap: a sub-agent on `walkthrough_model` (`sonnet` by default) copies the template and fills only its slots, and the session verifies the page itself. **No emoji decoration**: a mockup shows an emoji only where the target app itself would. `/create-plan` treats the page as illustration, not requirements, and never lifts its HTML into a plan.

An author can publish one as a private page on **planflow.sh**. The board's own **discovery view** was retired on 2026-10-08.

See `.claude/resources/skills/artifact-skill.md` for the page's reference shape, how it is served (a privileged `flow-page` scheme, sandboxed so the page never runs in Flow's origin), the three checks that guard sharing, and what the retirement removed.
### Plan Change Review

A plan is a review of the code change it will make (discovery `plan_change_review`, 2026-10-08). `/create-plan` writes **change notes** for the main changes only — 3–8 per plan, never more than 10, a repeated edit written once — in a `#### Change notes` block inside the phase: `- note: <n> · change|new|file · file:<path>:<function>` (a `<project-slug>/` prefix for a sibling project) with `where:` (a backticked quote of today's code, never a line number), `what:`, `why:` for a change; `signature:`, `purpose:`, `callers:` for a new function; `what:`/`why:` for a file note, plus an optional `where:` quoting its place (found once in the whole file) — prefer a function note, and quote a file note's place whenever it has one. Words only — never the code of the change. Under each note: `status: proposed|accepted|rejected — <reason>`, `comments:`, and after execution `verdict: done|differs|not-built — <why>`. Plans no longer carry a `## Story`; discovery keeps its own.

- **One parser, one writer.** `src/cli/state/change-notes.ts` parses notes for the CLI, `plan compile` (notes and counts in `run.json`) and the app. `planflow-ai plan notes <plan> [--check] --json` reads them with each quote resolved inside its function (`--check` refuses a quote found 0 or 2+ times — `/create-plan` must pass it); `planflow-ai plan note <plan> --note <n> (--status … [--reason …] | --verdict … --why …)` is the only writer of status and verdict, rewriting that note's line and nothing else.
- **The code story reads notes.** `blueprint storyline --plan` predicts from notes when a plan has them (`note-change` with `quoteLines` or `quoteMissing`, `note-new` with `callerPieces`, `note-file` with its quote's `pieceId` / `quoteLines` when it has a `where:`, each with the real-diff `fact`), widens the story to every note's file and its callers, and groups files into `bands` by project. Plans without notes predict as before. `--plan` alone answers the plan's own story with the code AROUND the notes: the noted functions, their direct callees and callers in the notes' files, a file note's quoted piece (else the file's pieces the drawn code touches, else its first piece) and the data they use — at most `MAX_PLAN_STORY_BOXES` (12) pieces, the noted ones always; a call to a piece left out is a chip into its file; a file note whose place no declaration holds gets an `excerpt` piece (a few lines around its quote, or its first statement after the imports).
- **Review in the app.** The chat card for a feature selects its plan by default and shows the note pills, **Review the change** (dispatches `flow:open-plan-review`) and **Execute the plan**; a discovery without a plan offers **Create the plan**. Both buttons send the command through the composer like Generate artifact — a person's press, never auto-chaining. Execute first names unreviewed notes (built as written) and rejected ones (left out). The review IS the code story — the same layout and render path as any file's story (entry on the left, call-ordered columns, real code with folding, numbered call arrows, Entry point, the step rail), with the review laid on it in **Today / Proposal / Verify** (`story-review-overlay.ts`): quoted lines highlighted in the proposal yellow, each note block under its function's box, a file note on its file's label, new functions as dashed boxes right of their callers with "will call" arrows, a note whose code cannot be found as a box that says why (a refusal's sentence is shown, never swallowed). Today is the same story with nothing on it; Verify is the real diff and the verdicts. Accept / Reject are written to the plan at once through `plan:setNote`; **Accept all** accepts every note not reviewed yet (never a rejected one), one write at a time; a comment is **added to context** (a per-plan draft, sent nothing), and **Send review to the agent** — enabled once every note is reviewed — sends ONE message with every decision and comment (`note-review-view.ts`, `plan-review-session.ts`, `note-review-model.ts`).
- **Execution follows the notes.** `/execute-plan` builds accepted and unreviewed notes, never rejected ones (autopilot the same, no new pause), then records a verdict per note with `plan note --verdict`; Verify shows each verdict beside the real diff, and a person can change it.

### Chat Cleanup

The chat is quiet by default (discovery `chat-cleanup`, 2026-10-08), for every request — a skill, a question, a free-form task.

- **One work row per request** (Compact, the default): everything between the person's message and the final answer folds into one row — "Worked 6 min · 25 tools · 1 failed · 2 files edited · Opus 4.8" — that opens to numbered steps (each step's first line and tool count; each step opens to its message and tools). Failures stay red on the closed row; the model shows once, on the row. While the agent works the row is live: "Working · N min · M tools" with the newest step on a second line. Balanced is the old per-message fold; Detailed folds nothing and keeps the per-message model badge. Permission and question cards are never folded. Pure models: `app/src/renderer/threads/request-summary.ts` (`planRequests`), `request-row-model.ts`; view `request-row.ts`; `feed-density.ts` maps the densities.
- **The final answer is a stored fact.** Main marks the assistant message that ended each turn (`messages.ends_turn`, migration 36, `ThreadStore.markTurnEnd`, written by `StreamBridge` and `RuntimeEventSink`). The answer is the last turn-ending message of the request; older threads without marks fall back to the last assistant message. A background wake-up's turn folds into the same request; its answer replaces the shown one only when it says something new — an answer that is exactly `No change.` is hidden, and nothing else ever is.
- **One set of writing rules for every agent** (`app/src/main/agent/writing-rules.ts`): an ASD-STE100 subset — short sentences, one topic per paragraph, lists for steps, active voice, one term per thing, say it once, and the exact `No change.` reply. Claude gets it in the session briefing (`sessionBriefing`); Copilot and Codex get it ahead of a session's first prompt (`runtimeFirstPrompt`), never in the stored message. The skills' chat outputs follow the same style.

### Pattern Capture

During execution, discovery, and code review, the LLM silently buffers coding patterns and anti-patterns. At the end of each skill, captured patterns are presented for user approval and written to `.claude/rules/core/allowed-patterns.md` or `forbidden-patterns.md`.

See `.claude/resources/core/pattern-capture.md` for full rules.

### Phase Isolation

When `phase_isolation: true` in `flow/.flowconfig` (default), each `/execute-plan` phase implementation runs in an isolated Agent sub-agent with a clean context window. The sub-agent receives only the context it needs (phase spec, file list, patterns) and returns a structured JSON summary (1-2K tokens). This eliminates context rot — phase 7 has the same quality as phase 1.

Planning/approval stays in the main session; only the implementation step is isolated. When combined with wave execution (`wave_execution: true`), multiple isolated sub-agents run in parallel within each wave. Supports per-task commits — sub-agents in sequential mode commit after each task, while the coordinator commits per-task in wave mode.

Disable with `/flow phase_isolation=false`. See `.claude/resources/core/phase-isolation.md` for full rules.

### Wave-Based Parallel Execution

When `wave_execution: true` in `flow/.flowconfig` (default), `/execute-plan` analyzes phase dependencies, groups independent phases into **waves**, and executes phases within each wave in parallel using Agent sub-agents. Waves are sequenced — Wave N+1 starts only after all Wave N phases complete. This can reduce total execution time by 40-60% for plans with independent phases.

Features:
- Explicit `Dependencies` metadata per phase (optional — omit for backward-compatible sequential)
- Topological sort into waves of independent phases
- Parallel Agent sub-agents per wave, reusing phase-isolation context template
- Shared context coordination between parallel phases via `.wave-context.jsonl`
- File conflict detection and contract conflict detection between parallel phases
- Conflict metrics — `File conflicts: N · Contract conflicts: M` reported in wave reports, the completion summary, and the PR Pipeline section (drives the treehouse adoption decision)
- Deterministic git commits (sequential in phase order after each wave)

Disable with `/flow wave_execution=false`. See `.claude/resources/core/wave-execution.md` for full rules.

### Compiled Run Scripts

`planflow-ai plan compile <plan>` compiles `flow/plans/plan_<name>_v<N>.md` into `flow/plans/<name>.run.json` — a deterministic JSON run script (`planHash` = sha256 of the plan content minus its change notes' review lines (`status:`, `verdict:`, `comments:` — recording a decision or a verdict never changes it), phases with resolved model + skip, waves, routing, commitStrategy, overrides, diagnostics). The artifact is `/execute-plan`'s orchestration source of truth: waves, per-phase models, skip flags, and verify commands are read from it, never re-derived from markdown. The preserved `overrides` block (per-phase model/skip, per-task verify) survives recompiles — stale overrides are warned, never applied or dropped — and the previous artifact rotates to `<name>.run.prev.json`. Resume marks a phase complete only from `phase_result` success entries whose run lineage carries a `planHash` matching the artifact (unhashed legacy rounds never resume); `/execute-plan <plan> --fresh` runs all phases. Failures print one `compile refused: <reason>` line, exit 1, nothing written. At archive time `planflow-ai plan archive <plan>` moves both artifacts (`<name>.run.json` and the rotated `<name>.run.prev.json`) into `flow/archive/` through one code path — a missing artifact is a silent no-op, a failure prints one `archive refused: <reason>` line. (#652)

### Guarded Autopilot

When `guarded_autopilot: true` in `flow/.flowconfig` (default `false`), autonomous `/execute-plan` runs gate each **dangerous seam** (push, PR creation, deletions outside the worktree, mutating bash) with an action-level classifier at execution time — the classifier-gated-autonomy pattern from Claude Code's auto mode: judge each action by irreversibility/blast-radius, not by a mode chosen once at session start. The verdict is one code path (allowed-pattern #14): the skill calls `planflow-ai guard classify --action '<json>'`, which returns `allow` / `ask` / `consult`. A deterministic pre-filter reuses the permissions-hygiene vocabulary — reversible/routine actions (`allow`) run silently; irreversible/other-affecting ones (`ask`) pause and ask (headless → `flow/.heartbeat-prompt.md`), recording an `escalation` rounds entry; only genuinely ambiguous bash commands (`consult`) defer to a haiku classifier that defaults to `ask` on low confidence. An action the current plan explicitly names as destructive can carry `userRequested: true`, which downgrades its `ask` to `allow`. This is an **independent opt-in layer** — it composes with, and does not replace, the Step 7b2 post-execution high-risk pause (both can fire). Scope is CLI `/execute-plan`; the IDE `canUseTool` gate reuses the same classifier core as a documented fast-follow. See execute-plan Step 7b4. (#653)

### Multi-Agent Coordination

During wave execution, parallel phases share a context file (`flow/.wave-context.jsonl`) that enables real-time coordination. Agents share API contracts, architectural decisions, and progress status via append-only JSONL entries. Before each task, sub-agents receive shared context from sibling phases, preventing broken contracts and duplicate decisions.

Entry types: `contract` (API shapes, interfaces), `decision` (architecture choices), `progress` (task status). Post-wave processing includes contract conflict detection — same API name with different signatures triggers user intervention.

Activates automatically during multi-phase waves. No configuration needed. See `.claude/resources/core/shared-context.md` for full rules.

### Brain (Unified Knowledge Store)

**One store, one name: `brain`** (#52). All project knowledge lives under `flow/brain/`, split **by kind** rather than by system:

| Layer | Location | Trust | Lifecycle |
|-------|----------|-------|-----------|
| Semantic (canonical) | `flow/brain/{features,errors,decisions}/*.md` | precious | Obsidian-readable markdown; never rebuilt |
| Auto-captured (transient) | `flow/brain/.raw/` | untrusted | working-set drafts per thread; excluded from queries until compacted |
| Structural (derived) | `flow/brain/.structure/` | disposable | rebuilt every `blueprint derive`; the board renders it |
| Feature index (derived) | `flow/brain/.derived/INDEX.md` | disposable | generated, never hand-edited; every feature's summary, parts and `relates` edges |

The agent reads/writes ONE name via the `brain:query` and `brain:capture` IPC channels. **Auto-capture** aggregates each thread's file-touching `tool_calls` into a `.raw/` working set on turn complete (`makeBrainCaptureOnTurnComplete`); a **compaction** pass promotes survivors into `features/*.md`. The tier boundary — `.raw/` is never indexed or surfaced — is enforced in one code path (allowed-pattern #14).

**Search**: there is **no index and no database** — the markdown IS the store. `brain search` runs ripgrep over the corpus (heading-aware chunks, ranked by weighted term frequency × query coverage), plus the generated `INDEX.md` for relational questions and `symbols.jsonl` for name lookups. Nothing to build, nothing to keep in sync, nothing that can be missing or stale-as-a-whole. The retired `.brain.sqlite` (FTS5 + 384-dim vector embeddings, ~250 MB of embedding runtime) is never read; a leftover one is ignored and safe to delete.

**Searched**: `flow/brain/` (excluding `.raw/`), `flow/plans/`, `flow/discovery/`, `flow/brainstorms/`, `.claude/resources/`, `.claude/rules/`, `CLAUDE.md`. Never: `flow/brain/.raw/`, `flow/archive/`.

**Query**: `planflow-ai state-query "topic" --scope resources --limit 5` (also reached via `brain:query`) returns top-k relevant chunks as JSON.

**The catalog** (`flow/brain/catalog.md`): search finds an answer; the catalog gives the **canonical** one. A hand-authored code maps to `file › heading` — never a line number — and `planflow-ai brain ref <code>` prints that whole section through the same chunker the ranker uses, with no scoring and **no fallback to search**. `brain ref --list` is the table of contents, `brain ref --check` resolves every entry and names the ones that no longer point anywhere. It is authored and precious: there is no generator and nothing to rebuild. A renamed heading fails loudly and locatably instead of silently returning the neighbouring section — the defect that killed the reference-code index this replaces. Full design: `docs/brain-architecture.md`.

**The trade**: a 12-question side-by-side (`docs/brain-search-comparison.md`) scored 5 file-path / 5 index / 2 ties. Every question the index won was **vocabulary-bridging** — "fails twice" → a section titled *Retry Behavior*. That is what the embeddings bought and what was given up; ask in the corpus's own words.

### Blueprint (Living System Map)

**Blueprint = brain's structure layer + the board that renders it (#52).** A derived map of the project's system surface (integrations, endpoints, datastores, modules) plus an anchored annotation layer, all under `flow/brain/.structure/`. `graph.json` is **disposable** — rebuilt in full by every `planflow-ai blueprint derive`; `annotations.jsonl`, `status-events.jsonl`, `investigations.jsonl` and `proposals.jsonl` are **precious** — append-only, never rewritten, each written ONLY through its own verb (`observe`, `propose`), because invariants live in one code path and not in prompt convention.

Structure comes only from extractors and the graphify backbone; narrated annotations enter only by promotion of **anchored** run records, carrying provenance — never self-narration. Every derive is gated by a frozen canonical contract validator: any violation hard-errors and writes nothing.

The IDE **board** is the interactive view of this layer, and its default sheet is the **Territory** — a treemap where a cell's area is the lines of code its anchors stand on. Plans, discovery docs and brainstorms can carry a `## Story` section narrating a concept arc, compiled by `planflow-ai blueprint narrate` — the only writer.

See `.claude/resources/core/blueprint.md` for the CLI surface, the canonical contract, the anchor envelope, promotion and stale rules, the story grammar, and how the board behaves.
### Feature Blueprint

The board's default view is **what this project does**, not what its files are. Features live in `flow/brain/features/<slug>.md` (precious, Obsidian-readable; `feature-store.ts` is the only writer, and machine writes never touch `name`, `kind`, `parent` or the prose).

**Three words, one meaning each** — a **feature** (`kind: core`) is a capability, a **part** (`kind: part`) is a piece of it, a **change** (`kind: child`) is a plan or an issue that touched it. Two of those used to share the word "part", so every change record was drawn as a structural piece while the real parts were invisible. Kinds are now read explicitly everywhere, and no count is derived by subtracting one kind from a total.

Depth follows the data: **features** at the root level, **parts** on drill-down, and a part is a leaf. A change gets no rectangle at any depth — it is carried for its parent link and surfaces as a count. Correction is conversational: editing or deleting the markdown file **is** the correction mechanism, which is why no sweep may overwrite a human-owned field.

See `.claude/resources/core/blueprint.md` for where each kind is mined from, the three populations the features directory holds and how each is identified, the Territory's layout rules, the Workspace level, and the `blueprint features` verbs.
# → { action, workspace{name,slug}, current, projects[{ id, slug, name, description, colorIndex, current,
#     local, state: local|remote|unreadable, error, size{source: measured|last-known|none, measuredAt},
#     graph{nodes,edges} (exactly as `features graph`, no limitations), totals{features,parts,changes,lines,files,understood},
#     connections }], totals{projects,features,lines,understood,connections}, links[{kind,note?,from,to}] | null,
#     linksError, linksUnreadable }
```

Each link end carries `features` — the core feature ids it touches (a feature end by slug, an anchor end by the features or parts that claim it); an end nothing claims keeps its address and is drawn to its project's country. A project not on this computer is read from `projects/<p>/brain/features`, sized by the last known measurement (`brain/.structure/sizes.jsonl`, appended by whichever machine measured it — append-only, so it syncs); one project that cannot be read is `unreadable` and the others still draw; links that cannot be read are `links: null` and the Connections button is disabled with the reason. "% understood" is one function (`src/cli/blueprint/understood.ts`, re-exported to the app via `app/src/shared/understood.ts`). Pure models: `app/src/renderer/blueprint/workspace-sheet.ts` (countries, gutters, colours, roll-up) and `workspace-links.ts` (facing edge points, ribbons, selected-feature and off-edge routing).

### Progressive Learning

**Progressive Learning** builds institutional module knowledge through four escalating tiers: automatic structure discovery (T0), one-time onboarding sweep (T1), manual per-module learning (T2), and guarded automatic re-learning when code drifts (T3). A persistent learning-state store tracks module status (learning / learned / stale) and stamps investigation notes with source-file hashes so the system detects when documentation becomes outdated.

Features:
- T0 structure — automatic, rebuild-only, free
- T1 onboarding (basic discovery) — automatic for every Workspace project (decision 2026-10-06): queued one sweep at a time on joining a Workspace and re-checked on launch; a thread's first message waits ("Learning <project> first…") until its project has it, and an attached project still being learned joins the session on the next send after its sweep. "Has basic discovery" = a line in `flow/brain/.structure/basic-discovery.jsonl` (append-only, syncs with the Workspace) or, for older projects, any `learned` module. One code path: `app/src/main/learn/basic-discovery.ts`. Only a project outside every Workspace still gets the one-time consent ask
- T2 manual learn — `/learn <module>` command or board popover Learn button
- T3 auto re-learn — staleness-triggered, subject to gates (meaningful diff, previously-learned, toggle, budget)
- Board integration — the learn dot on every cell (none/pulsing/filled/amber), the Learning lens and percentage dial on the feature map, plus the popover Understanding section
- Run-aware — `module_completed` and `archive_sweep` rounds entries trigger deliberate re-learn
- Staleness authority — `planflow-ai blueprint stale-check` re-hashes stamped files (read-only, always-on, free)

See `.claude/resources/core/progressive-learning.md` for full rules.

### Trust Tiers

Knowledge provenance is explicit and unconditionally injected into agent contexts: **Tier 0 — code** (source, configs, migrations) is ground truth; **Tier 1 — plan-flow's own store** (`flow/**`, `.claude/**`) is verified project knowledge; **Tier 2 — foreign documentation** (README/docs outside `flow/`, images, external wiki links) is treated as an **unverified claim** — read freely, but acting on it or asserting it to the user requires corroborating it against the code first, and a doc found to contradict the code is recorded as a blueprint observation rather than silently trusted. Tiers are materialized per derive into `flow/brain/.structure/file-tiers.json`. See `.claude/resources/core/trust-tiers.md` for the canonical contract block and all injection surfaces (phase implementation, learn sessions, discovery sub-agents, review sub-agents).

### Per-Task Verification

Tasks in plan phases can include optional `<verify>` sections with targeted verification commands (e.g., `npx tsc --noEmit <file>`, `npx jest <test-file>`). After completing each task, the verification command runs immediately. If verification fails, a debug sub-agent (haiku) diagnoses the failure and a repair loop applies fixes with up to N retries before escalating to the user.

Features:
- Automatic — tasks with `<verify>` tags are verified; tasks without them skip verification (backward compatible)
- Debug sub-agents use haiku for cost-effective diagnosis
- `/create-plan` auto-generates `<verify>` sections based on task type heuristics
- Configurable retries via `max_verify_retries` in `flow/.flowconfig` (default: 2, range: 1-5)
- Evidence capture — verification results may include `tested`, `testing_summary`, and `artifacts` (each artifact exactly one of `path` | `url` | `content`), written to the gitignored `flow/.evidence/<run-id>/<phase>-<task>/` directory
- Visual-evidence rule — UI-affecting tasks request screenshot/video/rendered-HTML evidence when browser tooling is configured; otherwise `testing_summary` must state why no visual evidence exists

See `.claude/resources/core/per-task-verification.md` for full rules.

### Atomic Commits Per Task

When `commit: true` in `flow/.flowconfig`, `/execute-plan` creates a **git commit after each individual task** completes, rather than one commit per phase. This enables fine-grained git bisect operations, independent reverts of specific changes, and clearer history alignment with task completion.

Features:
- Per-task commits with format: `feat(phase-N.task-M): <description> — <feature>`
- Sequential mode: sub-agents commit directly after each task
- Wave mode: coordinator commits per-task after wave completes in deterministic phase/task order
- Verification runs before task commit; failed tasks still commit after max retries
- Backward compatible — `commit: false` disables commits entirely

See `.claude/resources/core/atomic-commits.md` for full rules.

### Lint Gate

After all phases, `/execute-plan` runs a lint gate (Step 7b3). Command resolution: `commands.lint` in `flow/.flowconfig` → `lint` script in `package.json` → skip silently. The completion summary reports one line: `Lint: passed | N repairs | forced | not configured`.

### Auto-PR on Push Completion

When `pr: true` in `flow/.flowconfig` (requires `push: true` and `commit: true`), `/execute-plan` automatically creates a Pull Request after successfully publishing. The **local** feature branch is created from the current branch with the naming pattern `feat/<feature-name>`; the **remote** branch it publishes to is a separate, bound name (see Thread Remote Binding below). Both the publish and the PR go through `planflow-ai worktree push` / `worktree pr` — the one code path the IDE's landing flow also uses (allowed-pattern #14) — and the PR URL is captured for reference.

Features:
- Auto-enables `push: true` and `commit: true` if not already set
- Creates the LOCAL feature branch: `feat/<feature>`
- Publishes via `worktree push` and opens the PR via `worktree pr` (head = the bound remote branch, base = the `branch` key)
- An unbound branch is refused, not guessed: `/execute-plan` asks once (headless: `flow/.heartbeat-prompt.md`), records an `escalation` rounds entry, binds and retries
- Captures PR URL for completion summary
- Backward compatible — `pr: false` disables auto-PR creation
- Draft pipeline (#655) — `pr_draft: true` (requires `pr: true`) opens the PR as a GitHub **draft**; `/review-pr` flips it to ready (`gh pr ready`) only when no blocking (Critical/High or unanswered `ask-user`) findings remain, otherwise it stays draft with a one-line notice. Explicit user approval can always flip it manually.
- PR body: five sections (Intent / What Changed / Risk Assessment / Testing / Pipeline) regenerated deterministically from `flow/.rounds.jsonl` + the plan file — same rounds file + plan → same body

### Thread Remote Binding

A branch has **two identities**: the **local** name (ours — `feat/<feature>`, a thread's automatic branch) and the **remote binding** it publishes to — `{ remote, remoteBranch, prBase }`. The second belongs to the project's conventions, so it is **never guessed**. It is decided lazily by a person at the first push, stored in git's own upstream configuration (`branch.<local>.remote` / `.merge`; `prBase` lives in the thread store, which mirrors the rest — git wins on disagreement), and enforced by three verbs every writer calls: `planflow-ai worktree bind | push | pr`.

An unbound branch is **refused** at push/PR with a suggestion in the JSON payload, produced by a precedence ladder — `remote_branch_pattern` → a ticket id read from the thread title or plan name → the shape of the last binding made in this repo → the local name — each labelled with its `source` so the person deciding knows what they are looking at. Interactive surfaces ask; headless runs write the question to `flow/.heartbeat-prompt.md` and wait. Nothing falls back to the local name.

The verbs work outside threads too: `--here` operates on the checkout at `--target`, on the branch it is currently on (`--thread <slug>` and `--here` are mutually exclusive; exactly one is required). Config keys: `remote` (default `origin`) and `remote_branch_pattern` (optional; `{ticket}`, `{slug}`, `{local}`, `{user}`) — both shape the *suggestion* only. The existing `branch` key is the project's **default base**, for both the worktree cut and the PR. A rename after a push re-points the upstream, leaves the old remote branch in place and says so (`previouslyPushedAs`). **Loops are unchanged** — they keep their own `loop/*` carve-out, and `push-guard.ts` is untouched.

**Configuring it.** Nobody has to hand-edit a file for any of this. The **Conversation files** section of a project's Flow settings in the IDE holds all seven settings — whether threads get their own worktree, the remote, the branch naming pattern, the base branch (`branch`, relabelled "Base branch": what a worktree is cut from and what a PR opens against, no longer gated on auto-push), where new worktrees start, and whether the base is refreshed first with how long that may take. Above it sits an app-wide **Conversation file defaults** section: every project inherits a default until it sets its own key, so a value set once reaches projects that already exist. Each field resolves `project ?? global ?? built-in` through **one resolver** (`app/src/main/flow/worktree-settings.ts`), and the panel shows which layer answered plus a switch to take a value over or hand it back — provenance comes from key *presence*, never from comparing values, so "this project chose `origin`" and "nobody has been asked" never render alike. Terminals and skills use `planflow-ai flow set | unset | show`, which shares the IDE's merge module, so comments and key order in the file survive either writer. Three keys are new: `worktree_start` (formerly `workspace_start`, still read as an alias; `here | trunk | branch:<name>` — a default the start dialog **pre-selects**, never a bypass of the ask), `base_refresh`, and `base_refresh_timeout_ms` (clamped to 1000–30000 ms where it is read, so no configured value can reopen an unbounded wait). Built-in defaults equal the behaviour that shipped before any of this existed, and `flow/.flowconfig` stays hand-editable and remains the project layer's source of truth.

See `flow/brain/decisions/thread-remote-binding.md`.

### Workspaces

A **Workspace** groups projects and owns their knowledge: discoveries, plans, brainstorms, the brain and the archive live in ONE git repository per Workspace, and in the app the board, the thread list and the knowledge sync are per Workspace. `<repo>/flow` stays the interface every agent, skill and command uses — it becomes a link into the Workspace's project folder, and no reader or writer of `flow/` changes. Every project belongs to one; there is no switch and no classic sidebar.

`planflow-ai workspace <action>` is the source of truth for the structure — the app, the terminal and the heartbeat daemon all call it, and nothing else derives a Workspace path (allowed-pattern #14). Refusals follow the family contract: a JSON payload line on stdout carrying what the asker needs, then `workspace refused: <reason> — <sentence>`, exit 1.

**Three rules for skills**, which is all most sessions need: ask first with `planflow-ai workspace status --target . --json` (`workspace: null` → skip every Workspace step); search siblings with `planflow-ai brain search "<q>" --scope workspace`; record each cross-project touchpoint with `planflow-ai workspace link-knowledge`. Never hand-edit `workspace.json`, `links.jsonl`, `merges/` or the generated `flow/brain/index.md`.

Sync classifies every path as **generated**, **append-only**, **personal** or **authored**, settles only safe merges, and never force-pushes; a personal file staged or unpushed refuses the whole sync.

See `.claude/resources/core/workspaces.md` for the full verb list, the sync and merge rules, the on-disk layout, the app side (the first-prompt context gate, connections learning, project colours, connecting a shared repository) and how Workspaces became the only mode.
### Risk Assessment & Execution Rounds

Every `/execute-plan` run writes an append-only execution record to `flow/.rounds.jsonl` (verification results, phase results, risk, escalations — coordinator-only writer), archived with the plan as `flow/archive/rounds_<plan-name>.jsonl`. After all phases, a post-execution risk assessment rates the full changeset `low`/`medium`/`high` with a one-sentence rationale; when review findings exist, final risk = max(severity floor, judgment) — risk is never lower than its severity floor. In autopilot mode, `high` risk pauses before push/PR for explicit user approval. Complexity is the planning estimate; risk is the post-execution judgment.

### Review Finding Actions

`/review-code` and `/review-pr` classify every finding with an `action`: `auto-fix` (non-functional, safely fixable without discussing intent), `ask-user` (touches product behavior or deliberate intent — relayed verbatim, never silently resolved), or `no-op` (informational). When in doubt, default to `ask-user`. Review auto-fix stays off by default — the taxonomy is classification-only for now. See `.claude/resources/core/review-multi-agent.md` for the canonical rules.

Re-runs use **re-review memory**: each verdict is recorded as a `review_verdict` rounds entry (fingerprint: `<file>+<title>+<category>`), and previously dismissed findings are not re-reported unless the code materially changed — `ask-user` findings are never suppressed. When a review runs without a plan context, `/review-code` asks one ad-hoc intent question to anchor findings against intended behavior; `/review-pr` falls back to the PR description. See `.claude/resources/core/review-verification.md` and `.claude/resources/skills/review-code-skill.md`.

When the graphify engine is enabled, review sub-agent prompts include a `## Structural Context` block and review docs gain a `### Verify These Dependents` section (omitted when the engine is off); graphify risk signals (e.g., "touches god node X (N edges)", "spans M communities") are raise-only — they never lower the severity floor. See `.claude/resources/core/graphify-engine.md`.

### Engine Registry

Plan-flow can delegate specific steps to **optional external engines**. Today there is exactly one, and it takes no consent: **graphify** — a Python code-graph tool the user installs (`uv tool install graphifyy` or `pipx install graphifyy`; detected via `which graphify`) that provides structural blast-radius context for code reviews and advisory phase-dependency suggestions for planning; the graph lives at `graphify-out/graph.json` in the repo root (auto-gitignored in user projects). It has been **always-on since #142** — gated purely on availability, with any legacy `engines.graphify` value ignored. Nothing writes an `engines.*` key any more (#1808); the only engine-ish key plan-flow still reads is `engines.graphify_migration_asked`, a one-time re-prompt marker.

**lavish is retired (#1807).** `/create-plan`'s plan review is native — the plan's change notes, reviewed in the code story (Plan Change Review). Nothing reads `engines.lavish`, nothing writes `flow/.lavish/`, and no surface offers it as a setting. See `.claude/resources/core/engine-registry.md` for full rules and `.claude/resources/core/graphify-engine.md` for graphify.

### IDE Auto-Provisioning

Every managed project in the Flow IDE stays scaffolded with plan-flow assets matching the app's bundled CLI version, with zero terminal interaction. On project add, open, and app startup, the provisioner silently decides whether to provision (fresh project), refresh (version drift), or skip (already current). Refresh updates only owned assets (`.claude/commands`, `.claude/resources`, `.claude/hooks`) — never user data (`.claude/rules/**`, `flow/` content, `.flowconfig` keys). Failures emit one toast and leave roots re-runnable. Agent sessions get a `planflow-ai` wrapper on PATH pinned to the bundle version, enabling skills to invoke the CLI in any project. See `.claude/resources/core/auto-provisioning.md` for full rules.

### Status Contract

All status reporting shares five signals: `working`, `needs-decision`, `blocked`, `done`, `failed`. This is a signal layer only — domain-specific enums are unchanged. See `.claude/resources/core/status-contract.md`.

### Notifications

The heartbeat daemon routes every notification event to three channels, and to
nothing else:

| Event | Channels |
|-------|----------|
| all events | `flow/log.md` (the heartbeat log) + `flow/.heartbeat-events.jsonl` (the machine-readable stream) |
| `error`, `blocked`, `task_complete` | also a desktop notification |

**All of it is local.** There is no HTTP client anywhere in `src/cli/`, and
nothing plan-flow runs sends a notification off the machine.

> **Removed 2026-03-19.** Webhook delivery (Telegram / Discord / Slack) and
> two-way Telegram polling were deleted in `0d997af5`, along with the
> `webhook_url`, `telegram_bot_token` and `telegram_chat_id` config keys. That
> commit touched no documentation, so this section described them as working
> for five months (#1806). The keys are not read by the config parser and
> setting them does nothing — a blocked headless run is unblocked by editing
> `flow/.heartbeat-prompt.md`, never by replying anywhere else.

### Discovery Sub-Agents

During `/discovery-plan`, three parallel sonnet sub-agents explore the codebase simultaneously: Similar Features, API/Data Patterns, and Schema/Types. Each returns condensed JSON findings merged into a Codebase Analysis section in the discovery document. Always-on, no configuration needed.

See `.claude/resources/core/discovery-sub-agents.md` for full rules.

### Brainstorm with Interactive Questions

`/brainstorm` uses batched `AskUserQuestion` with 3-4 structured questions per round, each with recommended options. Commentary between rounds connects dots and challenges assumptions. Produces optional markdown files for `/discovery-plan`.

### Complexity Scoring

Every plan phase has a complexity score (0-10):

| Score | Level | Description |
|-------|-------|-------------|
| 0-2 | Trivial | Simple, mechanical changes |
| 3-4 | Low | Straightforward implementation |
| 5-6 | Medium | Moderate complexity, some decisions |
| 7-8 | High | Complex, multiple considerations |
| 9-10 | Very High | Significant complexity/risk |

### Flow Directory Structure

All plan-flow artifacts are stored in `flow/`:

```
flow/
├── archive/           # Completed/abandoned plans
│   └── heartbeat-prompts/  # Archived resolved heartbeat prompt files
├── brain/             # Unified knowledge store (#52) — Obsidian-compatible
│   ├── index.md       # Brain index (loaded at session start)
│   ├── features/      # Feature memory / working sets (semantic, precious)
│   ├── errors/        # Reusable error patterns (semantic, precious)
│   ├── decisions/     # Rationale, ruled-out, contracts (semantic, precious)
│   ├── .raw/          # Auto-captured working-set drafts (transient, un-indexed)
│   └── .structure/    # Derived structure layer — the blueprint board's source
├── brainstorms/       # Brainstorm exploration documents
├── contracts/         # Integration contracts
├── discovery/         # Discovery documents
├── plans/             # Active implementation plans
├── references/        # Auto-generated reference materials
├── resources/         # Valuable artifacts captured during skill execution
├── reviewed-code/     # Code review documents
├── reviewed-pr/       # PR review documents
├── tasklist.md        # Project todo list (updated in real-time during execution)
├── memory.md          # Persistent artifact tracker (completed skill executions)
├── heartbeat.md       # Scheduled task definitions for the heartbeat daemon
├── log.md             # Heartbeat log of important events
├── ledger.md          # Persistent project learning journal
├── .scratchpad.md     # Ephemeral per-session notes (cleared each session)
├── .flowconfig        # Central config file (autopilot, git control, settings)
├── .heartbeat-events.jsonl  # Machine-readable notification event stream
├── .heartbeat-state.json    # Session read position for unread event detection
├── .heartbeat-prompt.md     # Pending user input from blocked task (temporary)
├── .gitcontrol        # Git control settings — backward compat (prefer .flowconfig)
├── .telegram-poll-state.json  # Telegram polling state (update offset, mode)
├── .wave-context.jsonl        # Shared context between parallel phases (temporary, per-wave)
├── .rounds.jsonl              # Append-only execution record (verification, phase results, risk, escalations) — archived with the plan
├── .evidence/                 # Per-task verification evidence by run-id (local-only, gitignored)
├── brain/.structure/          # Blueprint structure layer (local/derived — see brain/ above)
│   ├── graph.json             # Derived system graph — rebuilt on every derive (disposable)
│   ├── graph.prev.json        # Previous derive, rotated on write (delta baseline)
│   ├── annotations.jsonl      # Append-only anchored annotations (precious, never rewritten)
│   ├── status-events.jsonl    # Append-only status transitions (active ↔ stale)
│   ├── investigations.jsonl   # Investigation notes + heat (via `blueprint observe`)
│   ├── proposals.jsonl        # Predicted "ghost" nodes (via `blueprint propose`)
│   └── blueprint.html         # Deterministic rendered title sheet (derived)
└── STATE.md           # Execution state snapshot for session resumability
```

## Session Start Behaviors

- **Project Ledger**: If `flow/ledger.md` exists, read it silently and internalize learnings. Update it when you learn project-specific lessons. See `.claude/resources/core/project-ledger.md` for full rules.
- **Project Brain**: If `flow/brain/index.md` exists, read it silently and internalize active features and recent errors. See `.claude/resources/core/brain-capture.md` for full rules.
- **Project Tasklist**: If `flow/tasklist.md` exists, read its **open sections only** — the lines above `## Done`, which is a completed-work archive that grows without bound — and present a brief summary of active tasks. See `.claude/resources/core/project-tasklist.md` for full rules.
- **Project Memory**: If `flow/memory.md` exists, read it silently and internalize the last 7 days of completed work. See `.claude/resources/core/project-memory.md` for full rules.
- **Session Scratchpad**: If `flow/.scratchpad.md` exists and has content, read it silently. Promote stale entries to ledger/brain, then clear. During work, write noteworthy observations to the scratchpad. See `.claude/resources/core/session-scratchpad.md` for full rules.
- **Autopilot Mode**: When autopilot is on for a project, the harness chains the workflow itself — there is nothing to follow at session start. `.claude/resources/core/autopilot-mode.md` describes what it does, including the three pauses it honours.
- **Heartbeat Log**: If `flow/.heartbeat-events.jsonl` exists, read it and compare against `lastReadTimestamp` in `flow/.heartbeat-state.json`. Summarize unread events (group by task, show counts and any failures/blocks). Update `lastReadTimestamp` to now. If `.heartbeat-state.json` doesn't exist or is corrupted, treat all events as unread and create the state file.
- **Heartbeat Prompt**: If `flow/.heartbeat-prompt.md` exists, read it and present the pending question to the user immediately. This means a background task is waiting for input. After the user responds, archive the prompt file to `flow/archive/heartbeat-prompts/` and the daemon will resume the task.
- **Execution State**: If `flow/STATE.md` exists, read it silently. If active work is detected (status is not `idle`), present a brief summary and suggest `/resume-work`.

## Rules

Always-loaded rules are in `.claude/rules/core/`:
- `allowed-patterns.md` - Coding standards to follow
- `forbidden-patterns.md` - Anti-patterns to avoid

On-demand reference files are in `.claude/resources/` and are part of the **searched markdown corpus**. Commands use `planflow-ai state-query "<topic>" --scope resources` to retrieve relevant context instead of loading full files by reference code. The brain returns ranked chunks for: core rules, skill details, patterns, language-specific guidance, and tool documentation.

## Critical Rules

1. **No Auto-Chaining**: Never auto-invoke the next command — not even under autopilot. Wait for the user. When a chain is driving, the next stage is issued by the harness from observable state, never by a command deciding it is time (`.claude/resources/core/autopilot-mode.md`).
2. **Complete and Stop**: After completing a skill, stop and wait for user input.
3. **Discovery First**: `/discovery-plan` is **required** before `/create-plan`. Plans cannot be created without a discovery document. No exceptions.
4. **Tests Last**: Tests are always the last phase of any implementation plan.
5. **Build at End Only**: Run `npm run build` only after ALL phases complete.
6. **No Direct DB Commands**: Never run database migrations directly - ask user to execute.
7. **Tasklist is a file, not memory**: When adding, moving, or completing tasks, you MUST use the Edit tool to write changes to `flow/tasklist.md`. NEVER keep tasks only in conversation memory. If the user says "add to tasklist", read `flow/tasklist.md`, then Edit it. See `.claude/resources/core/project-tasklist.md` for full rules.

## File Naming Conventions

| Document Type | Pattern |
|--------------|---------|
| Discovery | `discovery_<feature>_v<version>.md` |
| Plan | `plan_<feature>_v<version>.md` |
| Contract | `<service>_contract.md` |
| Code Review | `review_<scope>.md` |
| PR Review | `pr_<number>.md` |

## Architecture

### CLI Entry Point

`src/cli/index.ts` is the main bin entry point. Running `npx plan-flow` or `npx plan-flow init` launches the interactive installation flow.

### Init Command

`src/cli/commands/init.ts` orchestrates installation (Claude Code is the only platform — multi-IDE support removed 2026-07-22):
- Handlers in `src/cli/handlers/` (claude, shared)
- File utilities in `src/cli/utils/files.ts`
- Interactive prompts in `src/cli/utils/prompts.ts`

**Note**: IDE-managed projects are auto-provisioned silently by the Flow IDE (see IDE Auto-Provisioning). Manual init is required only for projects set up in non-IDE terminal environments.

### Distributable Assets

| Directory | Target Platform | Description |
|-----------|----------------|-------------|
| `.claude/commands/` | Claude Code | Slash command definitions |
| `.claude/rules/` | Claude Code | Core rules (.md, always loaded) |
| `.claude/resources/` | Claude Code | Reference files (.md, on-demand) |
| `templates/` | Claude Code | CLAUDE.md template |

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
