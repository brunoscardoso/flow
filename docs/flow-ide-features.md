# Flow — the IDE where AI output becomes legible

> Source document for the new product website (planflow.sh currently describes the CLI — this covers the **Flow IDE**, the product built on top of it). Every claim below is shipped and verifiable in the codebase.

---

## What Flow is

Flow is a macOS desktop IDE built around one conviction: **the hard part of AI-assisted development is no longer generating code — it's understanding, verifying, and steering what the AI did.** Every feature exists to answer one of three questions:

1. *What is the AI about to change?* (before)
2. *What is it changing right now?* (during)
3. *What did it actually change, and can I trust it?* (after)

Flow ships as a signed, notarized DMG with in-app auto-updates. Under the hood it embeds the plan-flow engine — a structured workflow system (discovery → plan → execute → review) with its own CLI — but the IDE is the product surface.

---

## The Blueprint — a living map of your system, and of what the AI does to it

The flagship. The Blueprint is a **derived graph of your codebase** — modules, endpoints, external integrations, datastores — rendered as an interactive board. It is rebuilt from code on every derive (never hand-maintained, never stale-by-design), while human/agent knowledge attaches to it through append-only, provenance-carrying layers.

### Making AI output visible on the graph

This is the core idea the website should lead with: **AI work is projected onto the system map at every stage of its lifecycle.**

- **Before — proposals ("ghost" nodes).** During discovery and planning, components the plan *predicts* it will create are registered as ghost nodes on the board. You see the planned shape of the system before a line is written. Confirmation is mechanical, never narrated: when a later derive finds a real node matching the predicted id, the ghost becomes real; when the plan is archived, unconfirmed ghosts are swept. The AI cannot claim it built something — the extractors have to find it.

- **Before — change simulation (Preview changes).** A plan compiles into a phase-by-phase walkthrough you can scrub: each phase highlights the modules it touches with **MODIFIED / ADDED** badges on the board, so you review blast radius phase by phase — before approving execution.

- **During — the Story layer.** A plan carries a narrated concept arc (problem → shape → data flow → decisions → risks, max 5 steps) compiled against the graph with strict anchor resolution — a story step cannot reference a component that doesn't exist or isn't legitimately predicted. It renders as an interactive card in the chat, pinned at the moment the plan was created, with two-way sync: stepping the story decorates the board; clicking a board node reveals its step.

- **After — drift detection.** Flow keeps a content-hash baseline of every code file. When reality moves — a teammate's merge, an agent's edits, your own changes — the board shows exactly which modules drifted from the indexed understanding, and the knowledge layer flags what needs re-learning. Baselines advance only when you acknowledge a review, never silently.

- **Always — provenance, never self-narration.** Annotations on the graph enter only by *promotion of anchored run records* — a decision recorded during an actual execution run, carrying its run id. An agent cannot write "I refactored the auth module" onto the map as fact. Contradicting notes are refused unless they corroborate or explicitly supersede with a reason. The map's trust model is enforced in code, not in prompts.

### Trust tiers — what the AI is allowed to believe

Knowledge provenance is explicit and injected into every agent context:

- **Tier 0 — code**: ground truth. Source, configs, migrations.
- **Tier 1 — Flow's own store**: verified project knowledge (plans, decisions, learned docs).
- **Tier 2 — foreign documentation**: READMEs, wiki pages, images found in the repo are treated as **unverified claims**. The agent may read them freely, but acting on them or asserting them requires corroborating against the code first. Docs found to contradict the code are recorded as observations — a built-in **doc-rot radar** instead of silent poisoning.

### Progressive learning — institutional knowledge that knows when it's stale

Flow learns your modules in escalating tiers: automatic structure discovery (free, always on) → a one-time onboarding sweep that starts from the *meaningful* modules, not root folders → manual per-module deep-learning → guarded automatic re-learning when code drifts. Every learned document is stamped with the source-file hashes it was verified against, so staleness is detected by content, not by time. Ignore lists (defaults: mocks, tests, fixtures, dot-dirs — plus your own) keep learning spend focused on code that matters. The board shows learning state per module; a Learning panel gives queue controls (pause / stop / reset) and per-module ignore.

---

## The structured workflow — discovery first, verification always

Flow's engine turns "chat with an AI" into an auditable pipeline:

1. **Brainstorm** — structured idea exploration with decision capture (settled / open / rejected — rejected options are never re-proposed downstream).
2. **Discovery** — requirements gathering with three parallel codebase-exploration sub-agents (similar features, API patterns, schemas). Produces a document, not vibes.
3. **Plan** — phases with complexity scores (0–10), explicit dependencies, per-task verification commands, and an Intent block (Goal / Constraints / Ruled-out) that follows the work everywhere.
4. **Execute** — phase by phase, with independent verification (see below).
5. **Review** — multi-agent code review with finding classification (`auto-fix` / `ask-user` / `no-op`); intent-touching findings are relayed verbatim, never silently resolved. Re-review memory means dismissed findings don't nag again unless the code materially changed.

### Verification is independent — completion is not acceptance

A worker's own "done" is never trusted. After each task, its `<verify>` command runs immediately; failures get a debug sub-agent diagnosis and a bounded repair loop. UI-affecting tasks capture visual evidence. Each task commits atomically (`feat(phase-N.task-M): …`) so history aligns with the plan and any change reverts independently. After all phases: a lint gate, a risk assessment (low/medium/high — high pauses autonomous runs before push/PR), and a PR whose five-section body is regenerated deterministically from the execution record — the same record, the same body, every time.

### Guarded autonomy

Autopilot mode chains the workflow end-to-end, but dangerous seams — pushes, PR creation, deletions, mutating shell commands — pass an action-level classifier at execution time. Reversible actions run silently; irreversible ones pause and ask; genuinely ambiguous ones defer to a fast model that fails closed. Judgment happens per action, not per session.

---

## Token economics — why Flow stays sharp on turn 200

Most agent setups degrade as context accumulates. Flow's architecture is built to spend tokens where they buy correctness and nowhere else:

- **Phase isolation.** Every plan phase executes in a fresh sub-agent context that receives only what it needs — the phase spec, its file list, project patterns — and returns a structured 1–2K-token JSON summary. No transcript accumulation: **phase 7 runs with the same context quality as phase 1.**

- **Wave execution.** Independent phases run in parallel sub-agents. Coordination happens through a shared append-only context file carrying only *contracts, decisions, and progress* — kilobytes of structured facts instead of megabytes of sibling transcripts. Conflicts (file-level and API-contract-level) are detected mechanically after each wave.

- **Retrieval, not loading.** Project knowledge lives in a hybrid index (full-text + 384-dim vector embeddings with rank fusion). Agents query for the top-k relevant chunks; nobody pastes whole documents into context.

- **Capped, drill-down context.** Asking about a blueprint component returns ~1,500 tokens with an explicit drill-down hint — the graph is the compression: relationships are precomputed structure, not re-derived prose.

- **Eager structure, tiered semantics.** Cheap structural facts (symbols, imports, edges) are indexed fully and hash-gated — unchanged files cost nothing. Expensive semantic work (summaries, narrated notes) is deferred to background or investigation time. No structural blind spots, no speculative semantic spend.

- **Model routing.** Phases route by complexity: trivial → fast models, standard → mid, complex → the best. The main thread's model+effort is the user's persisted choice; routing owns the sub-agents.

- **Compiled run scripts.** A plan compiles to a deterministic JSON artifact (hashed against the plan content) that execution reads directly — waves, models, verify commands are never re-derived from markdown by an LLM at run time.

- **Focused learning.** Ignore lists keep test scaffolding out of the knowledge budget; doc adjudication is capped per run; re-learning triggers only on meaningful, content-hash-verified drift.

---

## The Brain — one knowledge store, four layers

All project knowledge lives in a single store with explicit trust boundaries:

- **Semantic (precious)** — features, error patterns, decisions as Obsidian-compatible markdown. Never rebuilt, human-readable, linkable into a cross-project vault graph.
- **Auto-captured (transient)** — each thread's working set, captured automatically from tool activity; excluded from queries until a compaction pass promotes survivors.
- **Structural (derived)** — the blueprint's graph and stores; disposable, rebuilt from code.
- **Index (derived)** — the search index; delete it and it rebuilds with zero data loss.

Sessions start informed: the project ledger (lessons learned), active features, recent errors, the task list, and any interrupted execution state load silently at session start. Error patterns captured once are reused forever.

---

## The IDE around it

- **Threads that span repositories.** A thread's context can include multiple projects — add any folder from disk mid-conversation. Source control shows one section per repo the thread touches; the agent's cross-repo work is committable without leaving the panel.
- **Tasks board.** Kanban with 1:1 agent threads per task, auto-generated technical briefs, and import from Jira / GitHub / Azure DevOps. Per-project draft preservation, context folders per task.
- **Phase-grouped review.** Changes grouped by the plan phase that produced them; approving a file *stages it* — review approval and git staging are one state, in both directions. Reject sends the file back to the agent with your feedback.
- **A real editor.** Monaco with TypeScript language services, working-tree diffs, merge-conflict resolution (including AI-assisted), markdown preview, multi-tab with close-ops.
- **Agent-native chat.** Streaming with honest auto-follow, tool-call cards, permission prompts, question dialogs, image/text attachments, slash commands, message history across sessions, model+effort control with live model indicator.
- **Multiple Claude accounts.** Isolated per-account auth (separate config dirs) with per-project account mapping — personal and work accounts coexist cleanly.
- **Ambient operations.** A heartbeat daemon runs scheduled tasks and notifies via Telegram / Discord / Slack webhooks; blocked runs can be answered from your phone. Projects auto-provision their workflow assets on open — zero terminal setup.
- **Distribution done right.** Signed + notarized DMG, auto-updates from a public feed with a one-click titlebar chip, release notes shown before you accept and after you update — and the release notes are written by the agent from the actual commit history, gated by a human review step before anything publishes.

---

## The honest-by-construction principle (the through-line for the website)

Every layer repeats the same design decision, and it's the product's identity:

| Claim | Enforcement |
|---|---|
| "I built component X" | Only extractors confirm ghosts — from code |
| "This doc says the system does Y" | Tier-2 claim until corroborated against code |
| "Phase done, tests pass" | Coordinator re-runs verification itself |
| "Here's what changed" | PR body regenerated from the execution record, not memory |
| "The map is current" | Content-hash drift detection, baselines advance only on ack |
| "I remember deciding Z" | Decisions are anchored run records with provenance |

**Flow doesn't ask you to trust the AI. It builds the structures that make trust unnecessary.**
