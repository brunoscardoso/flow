# DeepSeek Harness vs plan-flow — what's worth stealing

> Evaluated 2026-08-26 against [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
> (`master`, developer preview). Sources: README, `docs/architecture.md`, `agent-lifecycle.md`,
> `tool-execution-pipeline.md`, `capability-seams.md`, `defensive-patterns.md`, `testing.md`,
> `persistence-catalog.md`, `config-catalog.md`, `tool-catalog.md`, postmortems 0001/0002/0004,
> and the READMEs of ~20 packages (plan, goal, guard, compaction, subagent, workflow, session,
> skill, todo, spill, session-query, jobs, schedule, hooks, interaction, sandbox, workspace).

## The two systems are different in kind

DeepSeek Harness (`dsh`) is an **agent runtime**: a Cordis plugin tree where the model adapter,
tool registry, session log, and the agent loop itself are all swappable plugins. It owns the
conversation loop, tool pipeline, sandboxing, and persistence. plan-flow is a **workflow layer
on top of someone else's runtime** (Claude Code): it owns plans, waves, verification, knowledge,
and git ceremony, and delegates the loop, tools, and permissions to the host.

So most of `dsh` is not something plan-flow should build. The comparison is still valuable
because the harness is unusually disciplined about the three things plan-flow *does* own:
**durable journals, autonomy gating, and derived/generated artifacts** — and its docs record,
postmortem-style, exactly how those things fail.

### Where plan-flow is already ahead (for calibration)

- **Deterministic plan compilation** — `run.json` with `planHash`, waves, overrides surviving
  recompile, resume lineage. The harness's `workflow` engine explicitly lists "no journaling,
  no resume, no token budget, foreground only" as known limitations.
- **Independent verification** — per-task `<verify>` + repair loops + forbidden-pattern #7.
  The harness repeatedly concedes the opposite: Ralph-loop and goal completions are "worker
  self-declaration, not certification."
- **Curated knowledge** — brain + blueprint. The harness has `session-query` (FTS over raw
  transcripts) and no curated/semantic store at all.
- **Cross-session scheduling** — the heartbeat daemon. Harness `schedule` is deliberately
  session-local; cold sessions catch up on resume.
- **Git/worktree machinery** — thread remote binding, push/pr verbs, loop carve-outs. Harness
  `workspace` is a directory registry with no git awareness.

Nothing below proposes abandoning any of that.

---

## Improvements, ranked

### 1. Harden `.rounds.jsonl` (and every append-only journal) with the harness's log contract

The harness treats its session log as the single durable authority, and its envelope encodes
reliability policy plan-flow's journals currently lack:

- **`ignorable` marker + format refusal.** A reader hitting an *unrecognized* entry type must
  **refuse to reconstruct** unless the writer marked that entry `ignorable: true`. A forgotten
  marker over-refuses rather than silently resuming from a gutted journal. Today,
  `rounds-reader` (and the resume evaluator) skim for known types — an unknown required entry
  from a newer writer is silently invisible, which is exactly the "resume marks a phase
  complete from a record it half-understood" failure the planHash lineage was built to stop.
- **Version metadata beside the log, not in it.** A small header/sidecar with format version
  lets a reader distinguish "newer writer — refuse and say upgrade" from "corrupt."
- **Crash recovery closes, never truncates.** A run that dies mid-phase should get a synthetic
  `interrupted` boundary entry on next read (the harness synthesizes risk-classified closers so
  the log stays a valid transcript). Today an aborted `/execute-plan` just leaves a dangling
  `run_intent` with no closing `phase_result`; resume infers, rather than reads, that it died.
- **Flush before side effects.** The harness's checkpoint policy flushes the log *before* any
  externally-visible side effect (push, PR, delete), fail-closed — so a crash can never leave
  an effect the journal doesn't mention. plan-flow's coordinator writes rounds entries around
  actions; the ordering guarantee ("the escalation entry is durable before the push happens")
  should be explicit and tested, not incidental.

Applies to: `flow/.rounds.jsonl`, `.wave-context.jsonl`, `annotations.jsonl`,
`investigations.jsonl`, `proposals.jsonl`, `status-events.jsonl`.

### 2. Autonomy is process-local — never persisted (the `goal` package's best idea)

Harness invariant: a durable goal survives restart, but **activation** — permission to
auto-continue — is deliberately absent from durable state. Every resume/fork requires a fresh
human authorization before automatic work continues. Persistence never smuggles autonomy
across a restart.

plan-flow persists autonomy: `autopilot: true` in `.flowconfig` is durable, and `/resume-work`
+ `STATE.md` will pick up an interrupted autonomous run and keep going. Proposal:

- Keep `autopilot` as the durable *objective* setting, but make the **arming** of a resumed
  run explicit: `/resume-work` on a run that was mid-autopilot asks once ("this run was
  autonomous — continue autonomously?") instead of inheriting the mode silently. Headless →
  `flow/.heartbeat-prompt.md`, same as every other ask.
- Same rule for guarded autopilot: a `userRequested: true` downgrade (ask→allow) should never
  survive into a resumed run it wasn't uttered in — it's an utterance-scoped fact, not config.

This is cheap (one check in the resume evaluator + one prompt) and closes a real gap: today a
crash-loop under autopilot re-arms itself forever.

### 3. Generate the catalogs that are currently "one table in two places"

The harness generates its config catalog, tool catalog, and persistence catalog from source,
with CI freshness gates (`verify-*`), and its tool catalog *boots the real plugins* to read
live schemas rather than parsing source. Three direct applications:

- **`FLOW_KEYS` → `.claude/commands/flow.md`.** `src/cli/commands/flow.ts` literally comments
  that the validation table and the command doc are "one table in two places." Generate the
  doc's key table from `FLOW_KEYS` (kind, range, help text) and add a `verify-flow-doc` check.
  This is the harness's config-catalog cross-check: every schema-validated key must be
  locatable in the doc, and vice versa.
- **Rounds-entry catalog.** A generated `docs/rounds-catalog.md`: every entry type the
  coordinator may append (`run_intent`, `phase_result`, `escalation`, `review_verdict`,
  `plan_decision`, …) with its payload type pasted verbatim and a badge for who reads it
  (resume / PR body / archive / nobody). The completeness guard: the generator walks the
  union type; a new entry type cannot ship undocumented.
- **CLI verb catalog.** `--help` trees exist, but a generated one-page verb inventory (the
  harness pattern: glob the command modules, fail if one is missing from the manifest) would
  have surfaced things the survey found by hand — e.g. that `loop.ts` alone carries 24 verbs.

And adopt their **maintenance-mode label** on every derived artifact: `generated` / `hybrid` /
`curated` stamped in a header comment. plan-flow already has the precious/disposable split for
*stores*; extending it to rendered docs (`blueprint-report.md`, `INDEX.md`, `blueprint.html`,
PR bodies) makes "may a human edit this?" mechanical.

### 4. Adopt the postmortem as a distinct brain document type

The harness's bar: a postmortem is written only when a bug is **subtle + systemic + costly to
rediscover**, and it records *why the process let it through* — with mandatory links to the
guardrails it motivated. Their 0001 is a perfect specimen: 178 green unit tests and 100%
coverage missed a loader bug because every test mounted the plugin by hand instead of through
the real loader.

plan-flow's `flow/brain/errors/` captures error *patterns* (what went wrong, how to fix), and
`forbidden-patterns.md` captures the rules — but nothing captures the middle layer: which
verification layer should have caught it and didn't. The forbidden-patterns file actually
contains these stories already (#12's "four review agents and 5,000 passing tests all passed
over it") — they're just buried inside pattern prose. Proposal: `flow/brain/errors/` gains a
`postmortem` kind with the 30-second-summary / root-cause / **guardrails-linked** structure,
and `/learn` offers it when a session just closed a bug that pattern-matched "subtle +
systemic." Each postmortem must link the pattern/test/gate it produced — an unguarded
postmortem is a story, not a control.

### 5. Testing doctrine: three rules worth importing verbatim

plan-flow's rules already cover "verify the world, not the self-report" (forbidden #7) and
combined-transcript assertions (allowed #15, #24). The harness adds three that are missing:

- **Test the real entry path.** Their postmortem 0001 lesson: full coverage of a component
  proves nothing about how it *loads*. plan-flow analog: tests import `src/cli/**` modules
  directly; almost nothing executes the **published artifact** (`dist/cli/index.js` under
  plain node, with the Electron `ELECTRON_RUN_AS_NODE` argv quirk that `index.ts` carries a
  special case for). One keyless smoke suite that runs the built bundle for each top-level
  verb (`init --help`, `state`, `guard classify`, `loop next` on a fixture) would catch the
  class of bug no unit test can: bundling, lazy `import()` resolution, argv parsing.
- **A snapshot refresh is fixture production, not correctness review.** Their postmortem 0002:
  a refresh committed transcripts full of `UNKNOWN_TOOL` errors as expected outputs. plan-flow
  has the same exposure everywhere output is deterministic-by-design: compiled `run.json`,
  rendered `blueprint.html`, PR bodies, prose reports. Rule: any regeneration of expected
  output must pass **semantic impossibility assertions** that are independent of the expected
  file (e.g. "a run.json never has zero phases", "a PR body never contains `undefined`",
  "a blueprint report never has an empty must-review section when the graph has nodes").
- **A guard only guards if the regression actually fails it.** Introduce the regression,
  watch red, revert. Worth adding as a line in the review/write-tests skills for any test
  whose purpose is to pin a fixed bug.

### 6. Make allowed-pattern #18 (bound the payload) infrastructure, not convention

The harness's `spill` package is pattern #18 built once: any tool result over `maxInlineBytes`
is saved whole to a session-scoped store and replaced with head/tail preview + locator +
"read/grep this path" hint — with the notice's own bytes reserved out of the budget, `read`
excluded to avoid read→spill→read loops, and failures never turning a success into an error.

plan-flow applies the pattern point-by-point (IPC `outputLimit`, `blueprint context` ~1,500
tokens, capped brain hits). The convention-vs-code-path rule (#14) says this should be one
helper: a shared `boundPayload(text, budget) → { inline, spilledPath?, withheld }` used by
every CLI verb that prints potentially-large JSON for an agent to consume (`state`,
`blueprint context`, `brain search --full`, loop transcripts), spilling to
`flow/.evidence/`-style local files. Today each surface re-derives its own cap and its own
"what was left out" phrasing — the exact drift #14 warns about.

### 7. Guard architecture: two refinements from the tool pipeline

The classify verb is already ahead of the harness's guard package (theirs is loop hygiene;
permission lives in their approval/sandbox seams). Two of their pipeline invariants transfer:

- **Fail closed on unanswerable asks.** Harness approvals: absence of an answerer resolves to
  deny. plan-flow's `ask` path writes `flow/.heartbeat-prompt.md` and waits — but what happens
  when nothing will ever answer (daemon down, webhook dead)? The contract should state a
  deadline after which `ask` hardens to a recorded refusal, not an indefinite hang or a
  fall-through.
- **Sub-dispatch inherits the pipeline.** Their Code Mode routes every tool call made *from
  inside model-written code* through the same pre/guard/post pipeline, carrying the parent
  token — policy can't be bypassed by wrapping calls. plan-flow analog: wave sub-agents and
  phase-isolation sub-agents execute bash/push actions of their own. The guarded-autopilot
  contract gates the *coordinator's* seams; the skill prompt is what makes sub-agents defer
  dangerous actions upward. That's an invariant living in prompt convention (#14 violation by
  the project's own standard). Worth documenting the gap explicitly, and long-term giving
  sub-agents the same `guard classify` call at their own seams — the harness's delegation
  model (child approval policy pinned to `never`, escalate to parent) is the shape to copy.

Also worth copying into the classifier docs: their monotonic-guard rule — a guard may only
**deny or abstain, never widen**. The `userRequested` downgrade already respects this in
spirit (it's applied last, by the caller's assertion, not by a guard); stating the rule makes
the next contributor keep it true.

### 8. Loop hygiene: the repeat-tool reminder

Small and directly portable to agent loops: the harness counts consecutive identical tool
calls (canonically serialized args; denied calls still count; bookkeeping tools are
*transparent* so a `todo_write` between retries can't launder the streak) and injects
escalating advisory reminders at 3/5/8 repeats. Never blocks — purely advisory. For plan-flow
this belongs in the loop/heartbeat layer: a consumer stuck re-running the same failing verify
command or re-claiming the same item is currently caught only by the run budget and the
circuit breaker, both of which trigger late. A streak detector over the run log is the cheap
early tier — and it composes with the existing `run-budget` clock rather than replacing it.

### 9. Defensive patterns worth adding to `forbidden-patterns.md`

Each of these shipped (or nearly shipped) a bug at DeepSeek; none is currently covered by
plan-flow's rule files:

- **Report orthogonal outcomes independently.** A child process can time out AND exit 0 —
  surface `timedOut` / `signal` / `exitCode` as separate facts, never nest one flag's report
  inside another's branch. Directly relevant to `task-runner.ts` and every `runCli` wrapper.
- **Process attribution requires a conjunction of independent evidence** (their postmortem
  0004): classifying a child failure by stderr-substring + any nonzero exit blamed ripgrep's
  normal "no matches" exit 1 on the sandbox. plan-flow parses tool output in several places
  (graphify, gh, git); exclusions must be exact, unknown fatal lines fail closed, and an
  adapter must **preserve structured failures from the layer below** rather than wrapping
  them into a generic error.
- **Scrub secrets from spawned environments.** The harness scrubs `*KEY*/*SECRET*/*TOKEN*/
  *PASSWORD*` env vars before handing an environment to anything running untrusted output.
  The heartbeat daemon and loop runner spawn full agent processes with inherited env.
- **Dispose must reach quiescence, not just request it** — await children's exits and close
  listener registries *before* killing, so late completions stay silent. Relevant to daemon
  stop and worktree pruning while a run is live.

### 10. Config provenance: finish generalizing the resolver

The harness's config layering (bundle → profile patch → home patch → CLI overlay, targeting
rows **by id**, with `--dump-config` printing the effective tree) is a heavier machine than a
flat file needs. But plan-flow just built the right small version of it for workspace keys:
`project ?? global ?? built-in` through one resolver, with provenance from key *presence* and
a UI that shows which layer answered. Two follow-ons the harness comparison suggests:

- **Extend the layered resolver to all `FLOW_KEYS`**, not only the seven workspace settings —
  `model_routing`, `max_verify_retries`, `webhook_url` are exactly the keys a person wants to
  set once app-wide.
- **A `flow show --resolved` dump** — the `--dump-config` idea: print every key with its
  effective value *and the layer that answered*, so "why is autopilot on?" is one command.

---

## Deliberately not adopted

- **The plugin runtime itself** (Cordis, seams, waterfalls, scoped shadowing). plan-flow's
  extension surfaces are markdown assets, the engine registry, and one abstract queue-backend
  base — proportionate to a system whose runtime is Claude Code. Building a plugin tree under
  a host that is itself a plugin host would be architecture cosplay. The transferable residue
  is the *discipline*, already captured above (#14's "one code path" ≈ their "seam owns the
  invariant").
- **Event-sourcing all state.** The harness derives model history from its log because it
  owns the model loop. plan-flow's constellation of files (`.flowconfig`, journals, STATE.md,
  markdown stores) matches its Obsidian-visible, hand-editable, git-diffable goals. Adopt the
  log *contract* (§1), not the log *architecture*.
- **Session-local scheduling.** Their `schedule` package's "no daemon, cold sessions catch up"
  stance is elegant but answers a different requirement — plan-flow's heartbeat exists
  precisely to act while no session is open, and to reach Telegram/webhooks.
- **KV-cache contracts per package.** They document prefix-cache impact of every feature
  because they pay for and control the provider calls. plan-flow rides Claude Code's caching;
  the only echo worth keeping is prompt-stability awareness in skill files (avoid churning
  the early bytes of large injected contexts between turns).
- **Sandbox seam.** Real confinement (bwrap/Landlock/Seatbelt, fail-closed
  `SANDBOX_UNAVAILABLE`) is the host runtime's job; plan-flow correctly delegates it to
  Claude Code's permission system and shapes behavior above it with `guard classify`.

## Summary table

| # | Improvement | Size | Where |
|---|---|---|---|
| 1 | Journal contract: `ignorable`, version sidecar, synthetic closers, flush-before-effect | M | `state/rounds-reader`, journal writers |
| 2 | Autonomy never persisted — resume re-asks before continuing autonomous work | S | resume evaluator, execute-plan skill |
| 3 | Generated catalogs + drift gates (FLOW_KEYS→flow.md, rounds catalog, verb catalog) + maintenance-mode labels | M | scripts + CI |
| 4 | Postmortem doc kind in `flow/brain/errors/` with mandatory guardrail links | S | brain templates, /learn skill |
| 5 | Published-artifact smoke suite; snapshot-refresh semantic guards; prove-the-guard rule | M | e2e suite, skills |
| 6 | One `boundPayload` helper — spill-with-locator for every large CLI output | M | `utils/`, CLI verbs |
| 7 | Guard: fail-closed ask deadline; document (then close) the sub-agent seam gap | M | guard contract, skills |
| 8 | Repeat-streak advisory reminders in loop runs | S | loop/run-log |
| 9 | Four defensive patterns → `forbidden-patterns.md` | S | rules |
| 10 | Layered resolver for all keys + `flow show --resolved` | S/M | flow command, workspace-settings |

The through-line: the harness's genuinely superior ideas are all about **making implicit
contracts explicit and mechanically checked** — on logs, on autonomy, on generated artifacts,
on failure classification. Those compose with what plan-flow already does well instead of
replacing it.
