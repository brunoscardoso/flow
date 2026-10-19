# Allowed project patterns

Project-specific rules follow. Existing numbers are stable references; examples
#1–5 live in the [pattern authoring guide](../../resources/core/pattern-authoring-guide.md).
Read that guide only when authoring or updating patterns; ordinary implementation
uses the rules below.

## Project Patterns

### 6. Don't Overweight Development Cost

When making technical decisions, don't give much weight to development cost. AI models trained on human data estimate work in human days/weeks and implicitly assume options are expensive to build — this biases decisions toward cheap, low-quality, unscalable solutions. You implement far faster than human-derived estimates suggest.

```markdown
<!-- GOOD - Pick the right design; implementation speed is not the constraint -->
"The properly-normalized schema (3 tables + join logic) is the correct model
for this data. Implementing it."

<!-- BAD - Trading quality for imagined time savings -->
"A normalized schema would take days to build, so let's just add a JSON blob
column to the existing table to save time."
```

**Why**: Decisions biased by phantom human-scale effort estimates produce technical debt that is genuinely expensive to unwind later — while the "expensive" option usually costs only minutes more to implement.

**Guidelines**:

- Choose the robust abstraction or correct schema over the quick hack, even when it looks like "more work"
- Weigh decisions on quality, scalability, and maintainability — not estimated build time
- Development cost is still relevant for genuinely large scope changes; it just shouldn't dominate the decision

---

### 7. E2E-First Bug Fixing

Always start a bug fix by reproducing the bug end-to-end, as closely aligned with how an end user experiences it as possible. Unit tests alone don't guard product behavior.

```markdown
<!-- GOOD - Example workflow -->
1. Reproduce: run the app / CLI / request exactly as the user reported it
   and confirm the failure is observed
2. Diagnose: trace from the observed failure to the root cause
3. Fix: apply the change
4. Verify: repeat step 1 and confirm the user-visible behavior is now correct
5. Guard: add a regression test that captures the end-to-end scenario

<!-- BAD -->
Read the code, guess the cause, patch it, add a unit test on the patched
function, and declare the bug fixed without ever observing it.
```

**Why**: A fix validated only by unit tests can pass while the user-facing bug persists — the real failure often lives in wiring, configuration, or integration layers that unit tests never touch.

**Guidelines**:

- If the bug can't be reproduced, that's the first problem to solve — don't fix blind
- Verify the fix through the same end-to-end path used to reproduce the bug
- Add unit tests as a complement to, never a substitute for, end-to-end confirmation

<!-- auto-captured patterns below this line -->

---

### 8. Test Electron-ABI Native Modules Under Electron-as-Node

When native modules (better-sqlite3, node-pty) are compiled for Electron's ABI, run the test suite under Electron's Node runtime instead of rebuilding.

```bash
# GOOD - test the REAL binary the app ships with
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron node_modules/.bin/jest ...

# BAD - ABI-flipping around tests
npm rebuild better-sqlite3 && jest && npm rebuild better-sqlite3 --runtime=electron
```

**Why**: Plain-Node Jest fails with ERR_DLOPEN_FAILED on Electron-ABI binaries; rebuild-flipping breaks the packaged app on any interrupted run and never tests what actually ships.

---

### 9. Verify Native-Module Postinstall Side Effects Under allow-scripts

When an npm allow-scripts policy is active, dependency install/postinstall scripts are silently skipped. After installing native deps (electron, node-pty, better-sqlite3), explicitly verify downloaded binaries exist and helper executables have their exec bits (e.g. node-pty's spawn-helper chmod happens in its blocked postinstall), running the skipped scripts manually if needed.

**Why**: Skipped postinstalls fail silently — the breakage surfaces later as cryptic runtime errors far from the cause.

---

### 10. Claude Agent SDK: Permission and Hook Channel Facts

- `PermissionResult` with `behavior: 'allow'` MUST include `updatedInput` (a record) — the SDK Zod-validates the result; a missing `updatedInput` fails the union and errors the tool call.
- `canUseTool` is the **approval** channel; hooks (PreToolUse/PostToolUse) are the **complete observation** channel. CLI-classified safe commands (e.g. `echo`) can execute without a `canUseTool` roundtrip while hooks still fire — never assume every tool execution produced a permission request. Intercept for approval at `canUseTool`; observe/mirror at hooks.

**Why**: Both discovered via live-SDK E2E in the flow-ide build; violating either produces silent gaps or hard tool-call failures.

---

### 11. Validate External Tool Output Against the Live Tool, Not Just Its Docs

When integrating an external tool's file output, verify the real format from an actual invocation before coding the reader — and accept documented variants defensively.

```typescript
// GOOD - graphify 0.9.9 actually emits NetworkX node_link JSON:
// edges under `links`, community under `community` — docs implied
// `edges`/`community_id`. Reader accepts both variants.
const edges = raw.links ?? raw.edges ?? []
```

**Why**: Docs drift from implementations; a reader validated only against documentation silently parses nothing. Discovered in blueprint graphify enrichment (validated against the live 1,992-node graph).

---

### 12. Mock node:child_process Under ESM Jest — Never PATH Stubs

When tests must control external-tool detection (`which <tool>`, `execSync`), mock the module, not the environment.

```typescript
// GOOD
jest.unstable_mockModule('node:child_process', () => ({ execSync: jest.fn(...) }))

// BAD - child processes inherit the REAL process env under jest;
// test-side process.env.PATH changes never reach execSync children
process.env.PATH = '/tmp/stubs'
```

**Why**: PATH manipulation is non-deterministic — results depend on what's really installed on the machine. Discovered in blueprint enrichment tests (run blueprint-20260709-131816).

---

### 13. Eager Structure, Tiered Semantics

When indexing a codebase, index cheap structural facts (symbols, imports, folder trees, call edges) fully and eagerly — hash-gated so unchanged files cost nothing. Tier only the expensive semantic work (summaries, embeddings, narrated notes) behind background/deferred/investigation-time stages.

**Why**: Structure is cheap and universally needed; partial structure creates blind spots that poison everything downstream. Validated at scale by noto-assistant's shipped indexer and adopted as blueprint v2's framing (2026-07-09).

---

### 14. Invariants Live in One Code Path, Not Prompt Convention

When N agents plus an app process share a mutable store, all writes go through a single mediating API that enforces the store's invariants (supersede rules, aggregation, anchor validation) in code.

```markdown
GOOD: agents and the IDE both call `planflow-ai blueprint observe` — the CLI validates and enforces
BAD:  every agent prompt restates "remember to check for existing notes before appending"
```

**Why**: Convention enforced across many prompts and processes drifts; one code path cannot. Mirrors promotion/relink/validation, which are all code, not prompt discipline.

---

### 15. Assert CLI Error Text on the Combined Transcript

When E2E-testing this repo's CLI as a subprocess, assert error messages against stdout+stderr combined, not stderr alone.

```typescript
// GOOD - the CLI's logger routes error() through console.log (stdout)
const out = `${result.stdout}\n${result.stderr}`
expect(out).toContain('init refused:')

// BAD - silently misses errors emitted via console.log
expect(result.stderr).toContain('init refused:')
```

**Why**: This CLI's logger emits `error()` via `console.log`; stderr-only assertions pass vacuously or fail mysteriously. The combined transcript is also what the user actually sees. Discovered in the ide-auto-provisioning live E2E (run ide-auto-provisioning-20260715-180153).

---

### 16. Measure the Payload Before You Optimize the Code

A performance complaint is a claim about a number nobody has read yet. Write the
probe first — a throwaway test that builds a realistic worst case and prints
sizes and times — then change what the number points at.

```ts
// GOOD — a synthetic 600-call thread, printed before anything was changed:
//   messages    600 rows   0.11 MB
//   tool calls  600 rows   4.96 MB   ← on every open AND every turn's reconcile
//   threads:list 201 threads + 201 N+1 root reads … 1 ms
// The N+1 everyone would have "fixed" first was 1 ms. The payload was seconds.
```

**Why**: intuition ranks causes by how ugly the code looks, and measurement
ranks them by cost. In this repo the two disagreed completely — the obvious
N+1 was free and the invisible `JSON` payload was the whole problem.

**Guidelines**:

- Build the worst case a real user reaches (a long session, a big repo), not a
  tidy fixture.
- Print bytes AND milliseconds; a 5 ms read that serializes 5 MB is a payload
  problem wearing a database problem's clothes.
- Keep the probe out of the suite (a temp file), but keep its NUMBERS in the
  commit message and the code comment — the next reader needs the evidence, not
  the harness.
- Re-run it after the change and record both figures. "6.98 MB → 0.86 MB" is a
  fact; "should be faster now" is a hope.

---

### 17. Pay Only for What Someone Can See

Every recurring cost — a poll, a subscription, a repaint — asks two questions
before it spends anything: *is this surface on screen*, and *does this event
change anything it draws*.

```ts
// GOOD — both gates, on every subscription to a hot broadcast
api.threads.onUpdated((events) => {
  if (!threadEventsAffectSidebar(events)) return   // pure tool-call churn draws nothing
  void board.refreshThreads()                      // …which itself returns if off-screen
})

// BAD — a full re-read and repaint per 50 ms batch, tab open or not
api.threads.onUpdated(() => void board.refreshThreads())
```

**Why**: a streaming agent turn broadcasts a batch every 50 ms. A subscription
that answers all of them with an IPC round trip and a full repaint is ~20 of
each per second, forever, including for tabs nobody has open. This exact bug has
been found and fixed four times here (#1640 loops panel, #1666 blueprint board,
#1696 thread sidebar, and the tasks board).

**Guidelines**:

- Put the visibility test in ONE pure helper (`shouldPollLoops`) and call it —
  a `document.visibilityState` check copied into five files is five rules.
- An off-screen surface re-reads on the way back in; it does not queue work.
- Filter the batch by what the surface actually renders, not by whether it is a
  batch.

---

### 18. Bound the Payload at the Boundary, and Say What Was Left Out

When a stored blob is large, send what the reader will actually look at and
fetch the rest on demand — from the side that OWNS the store, never by trimming
in the consumer.

```ts
// GOOD — main decides what crosses IPC; the card fetches its own on expand
handle('toolCalls:list', ({ threadId, outputLimit }) =>
  boundedToolCalls(threadStore.listToolCalls(threadId), outputLimit))

// …and the record says which it is
{ outputJson: null, outputWithheld: true }   // not sent
{ outputJson: null }                          // there is no output
```

**Why**: the consumer cannot un-send five megabytes. Bounding in the renderer
saves the DOM and pays the transfer anyway.

**Guidelines**:

- **Withheld is not empty.** Carry a flag and render it as "open to load",
  never as "nothing here" — presenting the second as the first is the app lying
  about what it stored.
- Keep the parts a COLLAPSED view prints (a path, a command) even when you drop
  the bulk, or every summary line silently empties.
- Copy the record; never mutate the store's own row to trim it.
- Leave an escape hatch (`limit` omitted = everything) for exporters and
  imports, and default it OFF for them.

---

### 19. Never Block the Process Everything Else Waits On

The Electron main process answers every IPC call. Anything synchronous there —
a child process, a big read, a hash over a tree — stalls every window, every
click, every keystroke, not just the caller.

```ts
// GOOD — async spawn, a timeout, and the result narrowed
const result = await runCli(bundledCli, rootPath, args, { timeoutMs: 30_000 })

// BAD — the whole app freezes for as long as this takes
const out = execSync(`${cli} loop status`, { cwd: rootPath })
```

**Why**: a renderer showing a wait cursor is usually a main process that has
stopped answering. Verified here: the codebase has exactly zero `execSync` in
main, and the one mention is a comment saying not to add one.

**Guidelines**:

- Spawning a CLI is not free even when async: each one is a fresh runtime.
  Gate it behind visibility and a sensible interval, and never once per item in
  a loop.
- Broadcasts from a hot source are debounced ONCE at the source
  (`BROADCAST_DEBOUNCE_MS`), not by every listener.
- Point-read one row instead of listing a thread's worth and filtering
  (`getToolCall`, not `listToolCalls().find`).

---

### 20. Cache What a Keystroke Recomputes

A surface driven by typing — a palette, an autocomplete, a filter — runs its
source once per character. Anything that touches the filesystem or the database
there is multiplied by the length of the word.

```ts
// GOOD — one walk per root per few seconds, whatever the typist does
const cached = listAllCache.get(root)
if (cached !== undefined && cached.limit >= wanted && now() - cached.at < TTL) return cached.result

// BAD — a recursive readdir of the whole repo, on main, per keystroke
handle('project:listAllFiles', ({ rootPath }) => collectFiles(rootPath))
```

**Why**: measured here at 2,693 files, 45 ms cold and 10–12 ms warm, plus
~100 KB of paths across IPC — per character typed into ⌘P, on the main process,
where every other window waits behind it.

**Guidelines**:

- A short TTL beats a subscription for a list that is allowed to be seconds
  stale. Invalidation you can forget to fire is worse than staleness you chose.
- Key the cache on everything that changes the ANSWER — the root and the limit,
  not the root alone, or a truncated walk gets served to a caller that asked for
  more.
- Drop it when its subject leaves (a removed project's walk is a snapshot
  nothing will ever invalidate).
- Inject the clock so the window is testable without sleeping.

---

### 21. A Refusal That Asks a Question Carries Its Own Answer

When a verb refuses because a *human decision* is missing — not because a
computation failed — put the decision's inputs in the refusal payload, on the
stream the caller already reads, and label a suggestion with where it came from.

```ts
// GOOD — `worktree push` on an unbound thread: stdout carries the ask, then the line
{ "refused": "unbound", "suggestion": "feature/PF-42", "source": "ticket",
  "remote": "origin", "remotes": ["origin", "upstream"], "base": "develop" }
// worktree refused: unbound — nobody has said where 'feat/x' publishes to   (exit 1)

// BAD — the caller now needs a second round of git calls to build the same question
throw new Error('unbound')
```

**Why**: the IDE form, the headless heartbeat prompt and the skill all turn the
refusal into the ask with zero extra round trips — and `source` tells the person
deciding whether they are looking at their project's convention or just their
local branch name again. The same string means opposite things depending on
the rung that produced it. Found building the thread remote binding
(run thread_remote_binding-20260825-160302).

**Guidelines**:

- Exit code and the `<cmd> refused: <reason>` line stay exactly as the family's contract says; the payload is additional.
- Consumers scan stdout for the JSON object — the refusal prose may follow it on the same stream (allowed-pattern #15).
- A rung may *decline* when it adds nothing over the fallback; that is only expressible when `source` is a value.

---

### 22. Sanitize What You Propose, Validate What You Were Told

Two input paths into the same field want opposite handling.

```ts
// GOOD — a value DERIVED for a suggestion is sanitized: an empty picker helps nobody
const suggestion = sanitizeRefName(`feature/${ticket}-${slugOf(title)}`)

// GOOD — a value a person TYPED is validated and refused: the name shown must be the name written
if (!isValidRefName(options.branch)) throw new Error(`'${options.branch}' is not a valid branch name`)

// BAD — silently rewriting what someone typed
writeBinding(exec, path, local, { remoteBranch: sanitizeRefName(options.branch) })
```

**Why**: refusing a derived value leaves the person with nothing to choose from
at the moment they are being asked to decide; rewriting a typed one means the
branch they were told about is not the branch that gets written. Corollary:
once a feature exists to stop a silent guess, **no layer beneath the ask may fill
the blank in** — an empty remote is refused with a sentence, never completed
from the project default, or the guess just moves to where nobody looks for it.

---

### 23. An Optional Field Is How a Single Writer Stays Single

When one column can only be answered by one of a writer's several callers, make
it optional on the writer's argument and leave the stored value alone when
omitted — and say on the type which side of a mirror wins.

```ts
// GOOD — only the cut can answer it; a rename passes nothing and clears nothing
setThreadWorktree(id, { path, branch, base, baseMayBeBehind?: boolean })
setThreadBinding(id, { remote, remoteBranch, prBase, previouslyPushedAs?: string | null })
//   omitted → stored value kept · explicit null → cleared

/** Mirror of git's branch.<local>.remote/.merge — git wins on disagreement. */
```

**Why**: a second setter splits the invariant across two code paths
(allowed-pattern #14); a required field makes every unrelated caller invent an
answer, and a rename silently clears a warning that is still true. A mirror
whose docs do not name a winner becomes two sources of truth on the first drift.

---

### 24. A Refusal Test Asserts the Transcript AND the Absence of the Side Effect

For any verb whose whole purpose is to *not* do something — push, delete,
publish — assert the refusal line on the combined transcript **and** that the
recorded argv contains no `git push` / `gh` call.

```ts
// GOOD
expect(`${out.stdout}\n${out.stderr}`).toContain('worktree refused: unbound')
expect(calls.filter(([verb]) => verb === 'push')).toEqual([])
expect(refsOn(bareRemote)).toEqual(['refs/heads/main'])     // nothing left the machine

// BAD — passes for a verb that refuses loudly and pushes anyway
expect(out.stderr).toContain('refused')
```

**Why**: a loud refusal that still pushes is precisely the wrong-but-valid push
the feature exists to stop. Two related habits from the same run: parse a CLI's
JSON result by scanning for the last parseable `{` line (the refusal prose can
follow the payload on stdout), and fake an external tool as a table keyed by its
argv that *throws* on anything absent — so the test asserts the question the
code asked, not just the answer it got.

---

### 25. A Gate's Answer Belongs to One Run

When a verb refuses on the strength of a record, both halves of its question —
*which run is this* and *what is it about* — come from the driver that minted
the run, never from the artifacts being judged.

```ts
// GOOD — the chain mints both, and the gate admits only what carries its stamp
const admitted = entries.filter((entry) => entryStampedBy(entry, chain))
const feature = featureOfEntry(newestRiskIn(admitted))   // read OFF the winner

// BAD — the subject is resolved from the same file the verdict lives in
const feature = lastFeatureNamed(entries)   // newest line naming anything
```

**Why**: anything a gate resolves from the artifacts it is judging can nominate
itself as the answer. Live here: one appended line to `flow/.rounds.jsonl`,
naming a feature that did not exist and carrying `risk_level: low`, was **both
the question and the answer** — it made itself the subject and then cleared
itself. The high-risk publish gate went from exit 1 to exit 0 with no knowledge
of the real plan slug required.

**Guidelines**:

- The identity is minted by the driver (a chain id); so is the subject (a
  sanitized slug). A file can forge neither without guessing.
- No stamped record → refuse, under its **own** reason code. "Nobody said" is
  not "they said yes", and it is not "they said no" either (see #21's cousin).
- It does not take an attacker. Two runs in one project, writing to one
  append-only file, will answer for each other on exactly the same mechanism.

---

### 26. A Required Dependency Is the Cheapest Fail-Closed Device

When an optional dependency's absence means *skip the safety check*, make it
required, so a construction site that would skip it does not compile.

```ts
// GOOD — a chain built without a gate is a type error, not a silent bypass
interface AutopilotChainDeps { checkStage: (input: StageGateInput) => Promise<StageGateStep> }

// BAD — every future caller may forget, and the forgetting is invisible
interface AutopilotChainDeps { checkStage?: (input: StageGateInput) => Promise<StageGateStep> }
```

**Why**: the optional form pushes the decision to every call site for ever, and
the one that forgets gets the unchecked path silently. Making it required here
turned "advance unchecked" from a runtime possibility into a compile error, and
the cost was editing eight existing test harnesses — once.

---

### 27. When One Runner Hands Work to Another, the Claim Moves With the Work

A registry that guarantees "only one driver drives this thread" must be handed
the claim along with the work — the handing runner keeps the item in flight,
takes **no** claim, and is woken by the other runner's *ending*, not its steps.

```ts
// GOOD — the chain owns the conversation, the loop owns the card
if (chained) return { threadId, detail: ensured.id, drivenElsewhere: true }
// …and the card advances on onChainEnd, never on a stage completing
```

**Why**: the obvious wiring — the loop claims the thread, then starts a chain on
it — is self-refusing: the registry denies the chain the very thread it was
handed. Getting this right made the invariant stronger, not weaker: the loop now
holds fewer claims than it did before.

**Guidelines**:

- A driver's hold on a conversation and the turn running in it are **different
  facts**. Releasing the claim when a turn ends strands any run that pauses —
  the bug reads as "it stopped listening", and no unit test of either half shows it.
- A claim keyed by driver+key cannot distinguish a run's restart from the run
  itself. Anything needing "a turn is still live here" must track the turn.

---

### 28. State the Positive Before You Assert the Absence

A test that asserts something did *not* happen must first assert that the thing
which would have caused it actually ran.

```ts
// GOOD
expect(chain.status(thread).running).toBe(true)      // the chain IS driving
expect(sent).toEqual(['/discovery-plan', '/create-plan'])
expect(sent).not.toContain('/execute-plan')          // …and did not go further

// BAD — passes just as well when neither driver ever started
expect(sent).not.toContain('/execute-plan')
```

**Why**: found live in a two-driver harness, by mutation-testing the test: the
absence assertion passed because **neither** driver ran. The same family as
"E2E absence assertions lie" — an absence is only evidence when the alternative
was reachable.

---

### 29. An Unrecognised File in a Closed Location Defaults to Not Shared

When a location holds a known set of things, decide what an UNKNOWN member is
by which mistake is recoverable — and publishing is not.

```ts
// GOOD - the knowledge root is a closed set, so a stray file stays local
if (closedRoot && !legacyScope && !relPath.includes('/')) {
  return { class: 'personal', row: null }
}

// BAD - the old default, which published anything nobody had named
return { class: 'authored', row: null }
```

**Why**: the two errors are not symmetrical. A file wrongly kept local is
filed later and syncs then — the cost is a delay. A file wrongly published to
a team repository is read by other people's agents as settled knowledge,
steers their work, and cannot be unsent; removing it later does not remove it
from the history or from what it already caused.

Measured here before the change: of every root-level file tracked across five
projects of a real Workspace, **none** was a legitimate artifact — four
Confluence drafts, two PR drafts, a QA checklist, a test plan, a `.patch` and a
`.DS_Store`. A default that was wrong for 100% of the cases it had ever decided
was pointing the wrong way.

**Guidelines**:

- Closing a default means **naming the legitimate members out loud**. `ledger.md`
  was shared only by falling through the old default, so it needed a row of its
  own before the default could change — otherwise the fix silently stops a real
  file syncing.
- Close one location, not every location that looks like it. A project's
  knowledge root and the Workspace repository's own root have different members;
  the same rule applied to both would have stopped a team's shared files dead.
- Leave historical modes alone. The per-project knowledge repo that predates
  Workspaces shares its root journals by contract, so the closed-root rule
  exempts it rather than quietly rewriting what an existing repository syncs.
- Assert the positive before the absence (#28): a test that shows `discovery/`
  still shares is what makes the `personal` beside it evidence of the rule
  rather than of a broken table.
