# Brain-First Retrieval — Search Before You Read

## Purpose

Agents burn tokens re-deriving knowledge the project already acquired — grepping for symbols the brain has already recorded, reading files whose contents are summarized in code cards, re-answering questions a learn pass settled. This contract makes acquired knowledge the default lookup path. It is the ONE canonical definition — every agent context references or embeds this block; none restates it (allowed-pattern #14).

## The Canonical Block

The following block is injected verbatim into agent contexts (phase implementation, discovery exploration, review sub-agents; learn sessions and the IDE session seed use the compact variant below):

> **Brain-First Retrieval — search acquired knowledge before reading code**
>
> - **The verb**: `planflow-ai brain search "<question>"` — ≤5 ranked hits (freshness flag, kind, pointer with file:line, snippet, hit id) across code cards, symbols, modules, decisions, notes, features and resources. Example: `planflow-ai brain search "who writes thread_roots"`.
> - **The rule**: Search the brain FIRST for any orientation question — where/who/what/how-does. Read or grep code only for what search did not answer, for strings seen in results, or when a hit is flagged stale — stale means verify against code before acting.
> - **Freshness**: `● fresh` hits are safe to act on without opening the source; `○ stale — verify against code` means the source drifted since it was recorded — confirm against the code first (trust tiers still apply).
> - **The catalog**: when the project has an AGREED answer on a subject, it is
>   catalogued. `planflow-ai brain ref --list` shows every code and what it
>   answers; `planflow-ai brain ref <code>` prints that whole section. Search
>   finds an answer; the catalog gives you the canonical one.
> - **Drill down**: every result list ends with a drill hint — `planflow-ai brain search "<q>" --full <id>` prints one hit in full. Drill before opening files.
> - **Word your question in the project's own vocabulary.** Search matches the words the corpus uses, not synonyms of them: "what happens when verification fails twice" will not reach a section titled *Retry Behavior*. If the first phrasing misses, re-phrase ONCE using a term you expect the document to contain, then fall back to grep.
> - **Miss etiquette**: if search returns nothing useful, proceed with grep — do not retry query variations more than once.

## The Compact Variant (app-injected surfaces)

Token-constrained surfaces (IDE session seed, learn-session prompts) inject a 3-line compact variant — verb, rule, stale-means-verify — defined as ONE exported constant in `app/src/main/agent/brain-first.ts` (`BRAIN_FIRST_COMPACT`), used by both. The seed injection is gated on the CLI shim being available (`cliShimDir` non-null) so no session is ever instructed to run a verb that is not on PATH; the constant names the Grep-over-`flow/brain/**.md` fallback for caged sessions that have no Bash tool at all.

## Injection Surfaces (all UNCONDITIONAL — no keyword gating)

| Surface | Where |
|---------|-------|
| Phase implementation sub-agents | `phase-isolation.md` context template — `## Brain-First Retrieval` section after `## Trust Tiers` |
| Review sub-agents | all four prompt templates in `review-multi-agent.md` (inline reference line, same style as trust tiers) |
| Discovery sub-agents | `discovery-skill.md` Step 1b — inline prompt line per sub-agent |
| Learn sessions | `buildLearnPrompt` (`app/src/main/agent/learn-session.ts`) — compact variant |
| IDE session seed | first-turn seed in `agent-manager.ts` — compact variant, gated on `cliShimDir` non-null |
| Provisioned projects | `templates/shared/CLAUDE.md.template` — navigation guidance names the verb |

## How It Answers (no index, no database)

The store IS the markdown. There is nothing to build, nothing to keep in sync, and nothing that can be missing:

| Layer | Source | What it answers |
|-------|--------|-----------------|
| Files | ripgrep over `flow/brain/`, `flow/plans/`, `flow/discovery/`, `flow/brainstorms/`, `.claude/resources/`, `.claude/rules/`, `CLAUDE.md` — chunked by heading, ranked by weighted term frequency × query coverage | prose: decisions, module docs, code cards, plans |
| Feature index | `flow/brain/.derived/INDEX.md` — **generated**, never hand-edited (a rebuild overwrites it) — carrying every feature's summary, parts and `relates` edges | relational questions: *how do skills impact playbooks* |
| Symbols | `flow/brain/.structure/symbols.jsonl` — exact / prefix / substring name match | *where is ThreadScopeManager* |
| Catalog | `flow/brain/catalog.md` — hand-authored code → `file › heading`, resolved through the SAME chunker, never ranked | *the canonical section on X* |

Never read, in any scope: `flow/brain/.raw/` (the untrusted tier boundary) and `flow/archive/`.

`rg` is used to narrow candidates; without it the whole 5.2 MB corpus is scanned instead, which costs milliseconds and changes no answer. A leftover `.brain.sqlite` from before the retirement is ignored, never read, and safe to delete.

## The Curated Half: the Catalog

Search ranks; the catalog does not. A **code** names the section the project has
agreed is canonical on a subject, and `brain ref <code>` prints that section in
full — no scoring, no top-5, no judgement call about which hit is the right one.

| Verb | Use when |
|------|----------|
| `brain ref --list [--prefix COR]` | orienting — the table of contents, code plus what it answers |
| `brain ref <code>` | the project HAS a settled answer and you want it verbatim |
| `brain ref --check` | maintenance — resolve every entry, name the ones that no longer point anywhere |

**It never falls back to search.** A refusal names which of five things went wrong
(`unknown-code`, `duplicate-code`, `source-missing`, `heading-not-found`,
`heading-ambiguous`). That is deliberate: the value of a curated answer is that a
reader can tell it apart from a guessed one, and a verb that quietly degraded into
the ranker would destroy exactly that.

**Entries are anchored to HEADINGS, never to line numbers.** plan-flow shipped a
reference-code index until `0135380f` removed it, and its one real defect was the
addressing: entries carried line ranges, so an edit above a section silently
re-pointed its code at neighbouring prose — a confident wrong answer, not a miss.
A heading anchor cannot drift, because no location is stored; a renamed heading is
refused by name and located by `--check`. The catalog carries the part a machine
cannot derive (which section is canonical); the machine carries the part a human
cannot maintain (where it currently is).

The catalog is **authored** — precious, shared, never generated. There is no
rebuild step. See `docs/brain-architecture.md` for the full design.

## Across a Workspace

A project may belong to a **Workspace** — a group of projects (a backend, the frontend that calls it, …) whose knowledge lives side by side. `planflow-ai workspace status --target . --json` answers which Workspace and project this repo is and lists its sibling projects (`siblings[].slug`, `localPath`, `flowPath`); `workspace: null` means it is in none and nothing below applies. Inside one, `planflow-ai brain search "<question>" --scope workspace` searches every project of the Workspace (each sibling's knowledge folder, plus its symbols and `CLAUDE.md` when it is checked out here) and namespaces each hit `<project>/…`; the default scope stays this project only, but it also surfaces the **cross-project links** this project takes part in (`link` hits — e.g. a backend endpoint and the screen that consumes it, with the note someone left). Links are written only by `planflow-ai workspace link-knowledge`, and `planflow-ai blueprint context <node>` lists the ones anchored on a node under `workspaceLinks`. Outside a Workspace, `--scope workspace` says so in one line and searches this project.

## Rationale

- **Why search-first**: the brain already holds per-file symbols, imports, one-liners, module docs, feature relationships and decisions. A capped 5-hit answer costs a fraction of a grep-and-read spelunk, and every hit points at a `file:line`.
- **Why freshness flags make it safe**: every hit is re-checked at answer time against the recorded source hash — skipping the code read is only allowed when the recorded knowledge provably matches the code (stale hits demand verification, aligning with trust tiers).
- **Why miss etiquette**: a miss is signal, not an invitation to prompt-engineer the query. One retry at most, then fall back to grep — misses feed the re-learn signal instead of burning turns.

## The Trade That Was Made (measured, not assumed)

The retired path was a 41.7 MB-per-project `.brain.sqlite` with FTS5 + 384-dim vector embeddings, costing ~250 MB of `@xenova/transformers` / `onnxruntime-node` / `sqlite-vec` and a `better-sqlite3` version conflict.

A side-by-side over 12 fixed questions (`docs/brain-search-comparison.md`) scored **5 file-path wins, 5 index wins, 2 ties**. The regression is real and is not denied here: **every question the index won was vocabulary-bridging** — "fails twice" reaching a section titled *Retry Behavior*, "know a module is stale" reaching *The Staleness Authority*. That is what the embeddings bought, and it is what was given up, deliberately, with the trade accepted.

Which is why the vocabulary rule above is part of the contract and not a footnote: phrase a question in the corpus's own words and this path answers it well; phrase it in synonyms and it may not.
