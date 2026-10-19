# Project anti-patterns

Project-specific rules follow. Existing numbers are stable references; examples
#1–5 live in the [pattern authoring guide](../../resources/core/pattern-authoring-guide.md).
Read that guide only when authoring or updating patterns; ordinary implementation
uses the rules below.

## Project Anti-Patterns

### 6. DON'T Execute ORM/Database Migration Commands Directly

**Problem**: Running ORM tools (Prisma, Drizzle, TypeORM, Sequelize, Knex, Django ORM, Alembic, etc.) directly can cause irreversible data loss, schema corruption, or unintended migrations in production environments.

```bash
# BAD - Never run these directly
npx prisma migrate dev
npx prisma db push
npx prisma db seed
npx drizzle-kit push
npx drizzle-kit migrate
npx typeorm migration:run
python manage.py migrate
alembic upgrade head
npx knex migrate:latest
```

**Why This is Wrong**:

- Database migrations can be destructive and irreversible (dropping columns, tables, data)
- ORM commands may connect to production databases if environment is misconfigured
- Schema changes need human review before execution
- Seed commands can overwrite existing data
- The AI agent has no way to verify which database environment it's targeting

**Fix**: Always present the command to the user and ask them to execute it manually.

```markdown
<!-- GOOD - Ask the user to run it -->
"Please run the following command to apply the migration:"

`npx prisma migrate dev --name add_users_table`

"Review the generated migration SQL before confirming."
```

**Scope**: This applies to ALL ORM and database tools — Prisma, Drizzle, TypeORM, Sequelize, Knex, Django ORM, Alembic, SQLAlchemy, ActiveRecord, and any other database migration or seeding tool.

---

### 7. DON'T: Trust the Worker's Success Summary

**Problem**: When an agent or sub-agent reports its work as done, accepting that claim at face value treats completion as user acceptance. Workers routinely report success while the actual behavior is broken, partial, or untested.

```markdown
<!-- BAD - Accepting the worker's own claims as verification -->
Sub-agent returns: {"status": "success", "summary": "All tasks completed,
tests passing"}

Coordinator: "Phase 2 complete and verified." → marks phase done, moves on
without running anything itself
```

**Why This is Wrong**:

- Completion is not user acceptance — "I finished" says nothing about whether the result actually works
- Workers grade their own homework; their summaries are optimistic by construction
- Failures compound silently: later phases build on unverified claims and inherit the breakage
- By the time the user discovers the gap, the causing change is buried under subsequent work

**Fix**: Verification must be independent. After a worker reports done, run the verify command yourself, reproduce the behavior end-to-end, or inspect concrete evidence (diffs, test output, build logs) — never accept the worker's own claims as proof.

```markdown
<!-- GOOD - Independent verification of the worker's claim -->
Sub-agent returns: {"status": "success", ...}

Coordinator:
1. Runs `npx tsc --noEmit` and the phase's <verify> commands itself
2. Inspects the actual diff to confirm the claimed files were modified
3. Only then marks the phase complete
```

<!-- auto-captured anti-patterns below this line -->

---

### 8. DON'T Use Generic Electron-Rebuild Walkers in npm Workspaces with Duplicate Native Deps

**Problem**: `@electron/rebuild` and `electron-builder install-app-deps` walk node resolution to the workspace root and rebuild EVERY module matching a name — including sibling packages' copies with incompatible gyp configs.

```bash
# BAD - rebuilds root's better-sqlite3 v9 (C++17 gyp) against Electron's C++20 headers → build failure
npx @electron/rebuild

# GOOD - scope node-gyp to the exact module that needs the Electron ABI
cd app/node_modules/better-sqlite3 && npx node-gyp rebuild --target=<electron-version> --dist-url=https://electronjs.org/headers
```

**Why This is Wrong**:

- Workspaces can legitimately hold two versions of the same native module (this repo's live instance was app v12 vs root v9, the root copy pulled in by planflow-brain)
- The walker fails on the copy you didn't ask about, blocking the build
- Silent cross-contamination: the wrong copy may get an Electron ABI it must not have

**Fix**: Direct, scoped `node-gyp` in the exact module directory (see `scripts/rebuild-native.mjs`).

**Status**: the duplicate that exposed this is GONE — the brain index's retirement took planflow-brain and its better-sqlite3@9 with it, and `npm ls better-sqlite3` now resolves to one version. The rule stands regardless: the walker's behaviour did not change, and the next workspace dependency to pull its own copy of a native module reintroduces the failure. Do not switch back to `@electron/rebuild` on the grounds that the conflict is resolved.

---

### 9. DON'T Let Heuristic Extractors Match Their Own Documentation

**Problem**: Regex-based code scanners (endpoint/integration/datastore extractors) match their own doc-comment examples when run against the repo that contains them, producing false-positive nodes.

```typescript
// BAD - this JSDoc example becomes a detected "integration" when the
// extractor scans its own source file
/** Detects HTTP calls like fetch('https://api.stripe.com/v1/charges') */
const HTTP_CALL_PATTERN = /fetch\(['"](https?:\/\/[^'"]+)/g
```

**Why This is Wrong**:

- The extractor reports phantom endpoints/integrations sourced from its own docs
- Silent false positives poison downstream consumers (graphs, dashboards, reviews)

**Fix**: Validate captured values structurally (hostname shape, leading-slash routes) and keep doc examples non-matching (placeholder syntax). Discovered live in blueprint extractor development (run blueprint-20260709-131816).

---

### 10. DON'T Use mtime-vs-Last-Commit for Staleness Checks

**Problem**: Comparing an artifact's mtime against `git log -1 --format=%ct` treats a dirty working tree as fresh — uncommitted edits never move the commit clock, so the artifact silently drifts from reality.

```bash
# BAD - misses every uncommitted edit
[ "$(stat -f %m graph.json)" -gt "$(git log -1 --format=%ct)" ] && echo fresh
```

**Fix**: Key invalidation on content hashes of the inputs (or at minimum include `git status --porcelain` dirtiness in the check). Known live instance: blueprint's graphify staleness check — tracked for the hardening batch (2026-07-09).

---

### 11. DON'T Run Parallel Sessions or Agents Against One Shared Git Checkout

**Problem**: When multiple sessions/agents share a working directory, any one of them running `git checkout` mid-run silently redirects every other worker's commits onto the wrong branch.

```bash
# BAD - agent A commits while session B just switched branches
git commit -m "feat(phase-8.task-1): ..."   # lands on B's branch, not A's
```

**Why This is Wrong**:

- Commits land on whichever branch happens to be checked out at that instant — a race, not a workflow
- Recovery requires cherry-pick/revert surgery across branches
- The failure is silent: the committing agent sees success

**Fix**: Any agent that commits must either verify `git branch --show-current` immediately before EVERY commit, or (better) work in a dedicated `git worktree` per run. Observed live twice in the blueprint-story run (2026-07-15); the ide-auto-provisioning run used a dedicated worktree from commit zero with zero collisions.

---

### 12. DON'T Put a Terminal Command, File Path or Config Key in UI Text

**Problem**: A control that cannot act, or a panel that needs setup, pastes the CLI invocation the reader should "just run". This hands the user the app's internals and asks them to finish the job by hand — in a GUI whose entire purpose is to do it for them.

```typescript
// BAD - the disabled control tells the user to go to a terminal
blockedReason: `run \`planflow-ai loop approve --loop ${loop} --id ${id}\` — ${reason}`

// BAD - the empty state narrates implementation instead of offering an action
SET_UP_LIST_HINT =
  'A task list comes from a loop directive — `loops/<name>.md`. Run `planflow-ai init` ' +
  "to seed one, point its `queue:` at a repo, then set `paused: false`."

// BAD - the hover text leads with the command rather than the consequence
title: `${command} — ${consequence(loop)}`
```

**Why This is Wrong**:

- The app usually **already runs that command**. The "Run `planflow-ai init`" hint above instructed users to do what the provisioner does automatically for every managed project — in an app documented as "zero terminal interaction".
- A command in a sentence is a **dead end wearing a button's clothes**. The reader cannot press it, and the panel that showed it had a real action available (`project:provisionRoot`) the whole time.
- File paths and config keys (`loops/<name>.md`, `paused: false`, `queue:`) are the same failure in a quieter form: they describe how the feature is *built*, not what the user can *do*.
- It leaks internals that change. A renamed flag silently turns UI copy into wrong instructions no test catches.

**Fix**: Offer a real action. If nothing can be done, say what is wrong in the terms of the thing on screen.

```typescript
// GOOD - a button that does the thing
button.addEventListener('click', () => void this.#setUpTaskList(button))

// GOOD - the reason names the problem, not the remedy's syntax
blockedReason: "Flow can't tell which list this item belongs to, so it can't approve it from here."

// GOOD - the hover says what pressing it does
title: consequence(loop)
```

**Relaying another tool's message**: a CLI writes for terminal users and its errors legitimately end with "…run `x` to fix it". When surfacing such a message in a GUI, keep the substance and drop the invocation at the **display boundary only** (see `withoutCommandHint` in `board-actions.ts`). Never let display formatting become a decision input — nothing that *decides* behaviour should read another tool's prose.

**Scope**: every user-visible string — labels, hints, tooltips, empty states, toasts, disabled-control reasons. Developer comments are exempt and should keep naming the real commands.

Found 2026-08-14 by the user reading the rendered panel: four review agents, a mutation-checked suite and 5,000 passing tests had all passed over it, because the code was internally consistent and only the *product claim* was wrong.

---

### 13. DON'T Ship a Whole Collection Because the View Only Renders Part of It

**Problem**: a surface windows what it MOUNTS but fetches everything, so the
transfer cost grows with the session while the visible cost stays flat.

```ts
// BAD — every tool call of the thread, with every output blob, on every open
// AND on every turn's history reconcile; then a 200-entry window is mounted
const [messages, toolCalls] = await Promise.all([
  api.messages.list({ threadId }),
  api.toolCalls.list({ threadId }),
])
```

**Why This is Wrong**:

- Measured here: 6.98 MB per read on a 600-call session, re-read on every open
  and every completed turn — the "click and wait five seconds" a user reported
- It degrades with use, so it is invisible in a fresh profile and worst for the
  people who use the app most
- The renderer pays twice: the IPC transfer, then the DOM text it writes for
  entries nobody expanded

**Fix**: bound the read at the boundary and fetch the rest on demand — see
allowed-pattern #18. `api.toolCalls.list({ threadId, outputLimit: 60 })`.

---

### 14. DON'T Answer a Hot Broadcast With a Full Refresh

**Problem**: subscribing to a batched, high-frequency event and doing the
heaviest thing available on each one.

```ts
// BAD — a thread list + a full board repaint, ~20 times a second while an
// agent streams, whether or not the board is on screen
api.threads.onUpdated(() => void board.refreshThreads())
```

**Why This is Wrong**:

- Streaming turns broadcast every 50 ms by design; the subscription turns a
  design decision into a load problem
- Most batches are pure tool-call churn that changes nothing the surface draws
- Hidden surfaces pay in full, and the reader gets nothing for it

**Fix**: filter the batch, then check visibility — allowed-pattern #17. This
repo has fixed the same bug four times (#1640, #1666, #1696, and the tasks
board); if you are adding a subscription to `threads:updated` or `tasks:updated`,
you are the fifth.


---

### 15. DON'T Let a Destructive Function Have a Working Default

**Problem**: a function that deletes something real, whose dependencies default
to the real system, is one careless call away from doing it — and the careless
call is usually a test.

```ts
// BAD — the deps are injectable, so it LOOKS test-safe. Called with none, it
// deletes a keychain item and rewrites a config file on the developer's machine.
export async function signOutRuntime(provider: string, deps: Deps = {}) {
  const forget = deps.forgetKeychainFn ?? forgetKeychainItem   // ← the real one
  ...
}

// …and one line in a suite, which read as an obvious no-op:
await expect(signOutRuntime('copilot')).resolves.toMatchObject({ ok: false })
```

**Why This is Wrong**:

- It really happened here: that assertion signed the user out of GitHub Copilot
  — keychain entry deleted, `~/.copilot/config.json` rewritten — while the
  author believed the call could not do anything.
- Injectable dependencies protect the tests that remember to inject. The one
  that forgets gets production behaviour, silently and at full strength.
- The failure is invisible in the test output. The suite went green a moment
  later; the evidence was a user asking why they were signed out.

**Fix**: make the destructive branch require something a test would have to say
on purpose — a confirmation the real caller passes explicitly.

```ts
// GOOD - the deletion happens only when the call says a person asked for it
if (deps.confirmed !== true && deps.forgetKeychainFn === undefined) {
  return { ok: false, detail: 'Signing out of Copilot needs an explicit confirmation.' }
}
```

**Guidelines**:

- Ask "what does this do with `{}`?" of anything that deletes, overwrites,
  pushes or revokes. If the answer is "the real thing", the default is wrong.
- Prefer a required flag over a mocked module: the flag protects every caller,
  including the ones written after you.
- The same rule covers writes to another program's files — see #12's cousin:
  reading another tool's state is a guest's business, writing it is a promise
  that has to be made out loud.

---

### 16. DON'T Let `\s*` Separate a Config Key From Its Value

**Problem**: a line-oriented config parser matching `^${key}:\s*(.+)` reads the
NEXT line as the value when the key is left blank, because `\s` matches a
newline.

```ts
// BAD — a blank `remote:` parsed as the literal string "remote_branch_pattern:",
// and a blank `branch:` adopted whatever line came next as the project's base branch
new RegExp(`^${key}:\\s*(.+)$`, 'm')

// GOOD — post-colon whitespace stays on the same line; an absent value reads as absent
new RegExp(`^${key}:[ \\t]*(.+)$`, 'm')
```

**Why This is Wrong**:

- A config key that silently names a destination nobody wrote is the same bug class as pushing to the wrong branch
- It only bites on the blank-value case, so no fixture with real values ever catches it

**Fix**: `[ \t]*`, plus a test that writes `key:` blank followed by another key. Found live in `src/cli/state/flowconfig-parser.ts`, whose dotted-key extractors already carried a comment warning about exactly this while the shared string helper had been left behind.

---

### 17. DON'T Let a Prompt Keep a Raw Command After a Verb Replaces It

**Problem**: rewriting a skill step to call a verb is half the job. The leftover
fallback lines — "if `gh` is missing, run `git push -u origin …`" — are exactly
the path a model takes when the happy path fails, which is when the guess is
most dangerous.

```markdown
<!-- BAD — the error branch still pushes somewhere nobody chose -->
If `gh` is not found: `git push -u origin feat/<name>` and create the PR manually.

<!-- GOOD — a remedy reports state; it never offers an alternative invocation -->
If `gh` is not found: the branch is published as `<remote>/<remoteBranch>`; the PR was not opened.
```

**Why This is Wrong**:

- The invariant now lives in one code path (allowed-pattern #14) *and* in a prose exception that can disagree with it
- Error branches are read less than main flows; the old literal hides there for months

**Fix**: after the rewrite, grep the file for the old literals — they hide in error handling, not in the main flow. And give the one code path a door for every legitimate caller (the `--here` mode let the plain-checkout skill run use the same verbs) so the invariant has no documented exception on day one.

---

### 18. DON'T Let a Record a Gate Trusts Have No Writer

**Problem**: a record that drives a refusal is documented as a JSON shape for a
model to compose by hand, so it has no schema guarantee and no identity.

```markdown
<!-- BAD — the skill doc tells the coordinator to hand-compose the gate's input -->
1. Append a `risk` entry to `flow/.rounds.jsonl`:
   {"ts": "...", "type": "risk", "risk_level": "...", "risk_rationale": "..."}
```

**Why This is Wrong**:

- Latest-append-wins plus no identity means any line — forged, duplicated, or
  belonging to another plan — silently overrides a real assessment
- The same phase of the same feature built `pushed_through` correctly
  (*"written ONLY via `flow pushed-through`, which is the one writer and
  validates the vocabulary — never hand-composed"*) and `risk` incorrectly. The
  one with a verb kept its schema and its identity; the one with a documented
  shape lost both.

**Fix**: **if a gate reads it, a verb writes it.** The verb validates the
vocabulary, refuses to mint an id it was not given, and stamps the run's
identity onto the entry (allowed-pattern #25).

---

### 19. DON'T Validate a Scoped Gate Only on Fixtures

**Problem**: a "has X happened?" check over a shared directory or an append-only
log, tested only against fixtures that contain the subject under test.

**Why This is Wrong**:

- Fixtures hold only the feature under test. **Real directories hold everyone
  else's.** Live here: a stage ladder with 24 passing tests reported a brand-new
  chain *already finished* on the real repo, because its proof patterns matched
  any feature's artifacts — eight discovery documents, a dozen reviews, and a
  rounds file from a previous plan.
- The gate was dead code that passed its own suite.

**Fix**: give the check a scope key (the feature, the run) and **run it once
against real data** before believing the suite. One command against the actual
project is worth the whole green tick.

---

### 20. DON'T Report a Run as Finished When Its Last Step Was Refused

**Problem**: a refused terminal step returns the same "done" signal as a
successful one.

```ts
// BAD — a refused publish reported the chain finished, with success = true
return { kind: 'stop', reason: CHAIN_FINISHED }   // …and onChainEnd(id, true)
```

**Why This is Wrong**:

- Downstream consumers act on the signal, not the reason. Here it moved the
  board card to done **over a publish that had just been refused**: nothing was
  pushed, but the *reporting* walked past the pause.
- A pause honoured but reported as success only stopped the machine, not the
  workflow — which is the half of a safety gate nobody checks.

**Fix**: carry the outcome (`tailPublished`), stop with a distinct reason, and
report success only when the last step actually did its work.

---

### 21. DON'T Read State Off an Object Your Own Cleanup Deletes

**Problem**: a field read from a record that teardown drops at exactly the
moment somebody would look at it.

```ts
// BAD — #forget deletes the run the instant the chain stops, so prUrl was
// ALWAYS null on a finished chain — i.e. whenever anyone would want it
get prUrl() { return this.#runs.get(threadId)?.prUrl ?? null }
```

**Why This is Wrong**:

- It fails only in the success case, which is the case nobody tests twice
- The module usually already has the right shape one field over — here a
  `#refusals` map kept deliberately outside the run's lifetime, for this exact
  reason, and the new field copied the broken one instead

**Fix**: outcomes that outlive a run live in a store that outlives it, cleared
on the next `begin` rather than on teardown.

---

### 22. DON'T Trust a Narrow Test Filter

**Problem**: verifying a change with a filter that matches the files you wrote,
and reporting green.

```bash
# BAD - matches flow-stage.test.ts, misses flow.test.ts's pinning assertion
npm run test -- flow-stage
```

**Why This is Wrong**:

- Twice in one feature here. Adding a member to an exported const tuple broke
  `expect([...FLOW_VERBS]).toEqual(['set','unset','show'])` in a file the filter
  did not match, and it was red for a whole phase. Editing `.claude/commands/*.md`
  broke `prompt-assets.test.ts`, which asserts the generated bundle matches the
  repo root — reported as "102 tests passed".
- Pinning tests live **away** from what they pin. That is their whole job.

**Fix**: grep for the symbol you touched (a tuple name, a generated path) and run
the full suite before claiming green. In this repo note also that
`npm run test -- flow` does not filter at all — the pattern matches the absolute
path, and the repo directory is `plan-flow`.

---

### 23. DON'T Document a Mitigation No Caller Performs

**Problem**: a module header explains why a hazard is safe, and the safety
depends on a caller doing something no caller does.

```ts
// BAD - true of the payload, false of the system
// "…the reading reports the feature it resolved, so the mismatch is visible
//  rather than silent."
// …while the only consumer branched on the exit code and discarded the field:
if (result.ok) return { ok: true, detail: 'This work may be published.' }
```

**Why This is Wrong**:

- It reads as a completed control to the next person, including a reviewer
- The hazard it describes is real; only the reassurance is fictional

**Fix**: make the caller consume it, or delete the claim. A mitigation that
depends on a caller reading a field must name that caller — or not be claimed.

---

### 24. DON'T Write a Deliverable to the Knowledge Folder's Root

**Problem**: a skill finishes something — a PR description, a page for the
wiki, a QA checklist — and writes it beside the folders instead of inside one.

```bash
# BAD - every one of these was written to flow/ itself
flow/pr-draft-ticket-4471.md
flow/qa-checklist-ticket-4471.md
flow/design-guide-wiki.md
flow/test-plan-migration.md

# GOOD - the folder says what the thing IS, which is how it is found again
flow/resources/design-guide-wiki.md
flow/archive/qa-checklist-ticket-4471.md
```

**Why This is Wrong**:

- **The root is a closed set.** Every artifact has a folder — `discovery/`,
  `plans/`, `resources/`, `archive/`, `reviewed-pr/` — and the root holds a
  handful of named journals. A file outside that set is unfindable by the
  thing that looks for it: nothing searches "the root" for a test plan.
- **It used to publish to the whole team.** `knowledge-classes.ts` classified
  an unmatched path as `authored`, so a stray file synced to the Workspace
  repository. Measured on a real Workspace: of EVERY root-level file tracked
  across five projects, not one was a legitimate artifact — four Confluence
  drafts, two PR drafts, a QA checklist, a test plan, a `.patch`, and a
  `.DS_Store`.
- A misfiled document still reads as knowledge. The next agent searching the
  brain finds a PR draft for a ticket that shipped weeks ago and treats it as
  current.

**Fix**: the root default is now `personal` — a stray file stays on the machine
that wrote it instead of reaching the team (the invariant lives in the
classifier, not in this rule — allowed-pattern #14). This rule is why.
Pick the folder by what the artifact **is**:

| The artifact | Where it goes |
|---|---|
| Something the user will paste elsewhere (PR text, a wiki page) | its real destination; `resources/` only if it must be kept |
| A finished, reusable document | `resources/` |
| Spent, kept for the record | `archive/` |
| A plan, discovery, brainstorm, review | its own folder, under the naming convention |

---

### 25. DON'T Record as Knowledge What the Code Does Not Do Yet

**Problem**: a run finishes, writes what it built into the shared knowledge,
and the branch is never merged. The knowledge now describes a system that does
not exist, and it is indistinguishable from the knowledge that does.

```markdown
<!-- BAD - written when the AGENT finished, not when the CODE landed -->
flow/brain/features/semantic-typography.md
  "Typography tokens are resolved through `resolveTypeScale()` …"
<!-- …on a branch that was abandoned in review. Every later session reads this
     as a description of the codebase and plans against a function nobody has. -->
```

**Why This is Wrong**:

- **Description and intent are different claims.** `brain/` says what the code
  *does*; a plan says what someone *meant to do*. Mixing them means a reader
  cannot tell a shipped feature from an abandoned one, and an agent cannot
  either.
- Trust Tiers already say code is ground truth. Knowledge written ahead of the
  code inverts that: it is a Tier 1 document asserting something Tier 0 denies.
- It is worse in a Workspace than in a checkout, because it syncs. One person's
  unmerged branch becomes every teammate's starting assumption.
- The failure is silent and durable. Nothing goes red; the document just sits
  there being wrong, and the staleness check cannot help — it re-hashes files
  the document names, and these never existed.

**Fix**: write knowledge when the work **lands**, not when the agent stops.

```markdown
<!-- GOOD - the order that keeps the two claims apart -->
1. The run writes its plan, its discovery and its review. These are INTENT and
   live in their own folders, where their status is visible.
2. The code merges to the default branch.
3. Only then is what it does promoted into `brain/` as description.
```

**Guidelines**:

- A document that names a function, a table or an endpoint is a claim about the
  code. If that thing is not on the default branch, the document is a draft.
- An abandoned plan is **archived or deleted**, never left looking current. A
  plan whose phases never ran carries `verdict: not-built` and says so.
- A draft of an artifact that lives somewhere else — a PR body, a wiki page, a
  ticket comment — is not knowledge at all. It has a destination; send it there
  (see #24).
- "The agent reported success" is not "the work landed" (see #7). The branch
  being merged is the event; nothing else is.
