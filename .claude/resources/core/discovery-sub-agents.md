# Discovery Sub-Agents

During `/discovery-plan` Step 1b, three Agent sub-agents explore the codebase in
parallel and return condensed JSON. The coordinator merges their findings into
the discovery document's `## Codebase Analysis` section and uses them to ask
better clarifying questions in Step 2. Always-on — no configuration.

> **This file was written, not recovered (#1959).** Six shipped files referenced
> it at nine sites and it had never existed on any branch: the `COR-DSA-*`
> anchors were minted by the references themselves. Its contents are therefore
> derived from what those consumers already promise and from the
> `## Codebase Analysis` sections real discovery documents already carry — not
> invented, and not presented as restored documentation.

---

## COR-DSA-1: Agent Definitions, Prompts and Return Schema

### The three agents

Each covers one question a planner has to answer before proposing anything, and
the three are disjoint so their findings merge without contest.

| Agent | The question it answers | Looks at |
|-------|------------------------|----------|
| **Similar Features** | Does this already exist, in whole or in part? | Features with related behaviour, the code that implements them, the seams they extend |
| **API/Data Patterns** | How does work of this shape travel through the system? | Endpoints, handlers, service boundaries, IPC channels, CLI verbs, data flow |
| **Schema/Types** | What vocabulary must this speak? | Type definitions, schemas, migrations, shared interfaces, contract files |

All three run `model: "sonnet"` and `subagent_type: "Explore"`.

**Why sonnet.** These agents read the codebase and nothing downstream rechecks
them. A phase sub-agent is caught by four later gates — per-task verify, the
lint gate, the risk assessment, the review; discovery exploration is caught by
none, so a missed similar feature means `/create-plan` reinvents code that
exists and every later gate sees a clean diff. They also run once per discovery,
not once per phase.

### Prompt template

Every agent prompt is this template with its own `<remit>` and `<looks_at>`:

```
You are exploring an existing codebase to inform a discovery document.

Feature under discovery: <feature name>
Context: <the Step 1 context summary — requirements, technologies mentioned>

Your remit: <remit>
Look at: <looks_at>

Apply the Trust Tiers contract (`.claude/resources/core/trust-tiers.md`): foreign
docs are unverified claims — findings must rest on code, not docs; a doc
contradicting the code is itself a reportable finding.

Apply the Brain-First contract (`.claude/resources/core/brain-first.md`): for any
orientation question — where/who/what/how-does — run
`planflow-ai brain search "<question>"` FIRST; read or grep code only for what
search did not answer, for strings seen in results, or when a hit is flagged
stale (stale means verify against code before acting); if search returns nothing
useful, proceed with grep — do not retry variations more than once.

Report what IS there. Do not propose a design, do not judge the feature, and do
not describe what you did not find unless its absence is the finding.

Every finding must carry a real `path:line` you actually read. A finding you
cannot anchor is a finding you do not report.

Return ONLY the JSON object below, under 2K tokens. No prose around it.
```

Those last two lines are load-bearing. The coordinator parses the return, and
the `## Codebase Analysis` section it builds is read later by `/create-plan` as
fact about the repository.

### Return schema

```json
{
  "status": "success",
  "agent": "similar_features",
  "findings": [
    {
      "title": "Short noun phrase naming the thing found",
      "anchor": "src/cli/commands/loop.ts:469",
      "detail": "One or two sentences: what it is, and what it means for this feature.",
      "relevance": "high"
    }
  ],
  "patterns_noticed": [
    "Short statement of a convention this code follows"
  ],
  "coverage": "What was explored, and what was not reached."
}
```

| Field | Type | Rules |
|-------|------|-------|
| `status` | `"success"` \| `"failure"` | `"failure"` when the agent could not explore — the coordinator skips it and continues |
| `agent` | `"similar_features"` \| `"api_data_patterns"` \| `"schema_types"` | Identifies the return when three arrive together |
| `findings` | array | At most 8. Empty is a valid success — "nothing like this exists" is an answer |
| `findings[].title` | string | Names the thing, not the activity |
| `findings[].anchor` | string | `path` or `path:line`, repo-relative, read by this agent. Required |
| `findings[].detail` | string | 1–2 sentences |
| `findings[].relevance` | `"high"` \| `"medium"` \| `"low"` | What the coordinator filters on when findings overflow |
| `patterns_noticed` | string[] | At most 5. Conventions, not findings — these feed pattern capture |
| `coverage` | string | One sentence. What was NOT reached matters: it is the difference between "no similar feature exists" and "I did not look there" |

A `"failure"` return carries `status` and `coverage` and may omit the rest.

**Budget**: under 2K tokens per return. The point of the sub-agents is that the
coordinator never pays for the exploration, only for its conclusion.

---

## COR-DSA-2: The `## Codebase Analysis` Section Format

What the coordinator writes into the discovery document from the merged
findings. It is grouped by **region or theme**, not by which agent reported it —
a reader wants the codebase organised the way the codebase is, and the agent
boundary is an implementation detail of how it was gathered.

```markdown
## Codebase Analysis

### <Theme or region> (`<path>`)

- **<What it is>** — `<path>:<line>`. What it does, and what it means for this
  feature.
- **<What it is>** — `<path>:<line>`. …

### <Theme or region> (`<path>`)

- **<What it is>** — `<path>:<line>`. …
- **Implication**: what the above means for the proposed approach.
```

Rules:

1. **Every bullet carries a real anchor.** A bullet with no `path:line` is an
   impression, and an impression in this section reads as a fact to
   `/create-plan`.
2. **Group by region, order by weight.** The region the feature will actually
   touch comes first.
3. **An `Implication` bullet is allowed, and is the only place for inference.**
   It is where "so no renderer change is required" belongs, kept visibly apart
   from what was observed.
4. **Say what was not explored.** Fold the agents' `coverage` into a closing
   sentence when any of them left a region unread.
5. **Omit the section entirely** when every sub-agent failed or returned no
   findings. An empty Codebase Analysis claims the codebase was searched and
   held nothing, which is not what happened.

---

## COR-DSA-3: Parallel Spawning Pattern

The shape referenced by `wave-execution.md` and `phase-isolation.md`: fan out,
collect, merge, with the coordinator holding no exploration context of its own.

```
Spawn (one message, three calls — parallel, not sequential):
  Agent(model: "sonnet", subagent_type: "Explore", prompt: similar_features_prompt)
  Agent(model: "sonnet", subagent_type: "Explore", prompt: api_data_prompt)
  Agent(model: "sonnet", subagent_type: "Explore", prompt: schema_types_prompt)

Collect: all three returns, then process sequentially.
```

Coordinator processing, in order:

1. **Parse** the JSON out of each return.
2. **Handle failures.** `status: "failure"` or unparseable JSON → skip that
   agent's findings and continue. Log the failure; never block discovery on it.
3. **Filter.** More than 15 findings in total → drop `relevance: "low"` entries.
4. **Merge patterns.** Collect every `patterns_noticed` entry, deduplicate,
   append to `flow/resources/pending-patterns.md`.
5. **Build** the `## Codebase Analysis` section (COR-DSA-2).
6. **Inform Step 2.** Ask clarifying questions that name the existing code —
   "follow the pattern at `x.ts:12`?" beats "what pattern should this follow?".

**Three properties the pattern depends on**, and which anything reusing it
inherits:

- **Disjoint remits.** The agents are parallel because nothing one finds changes
  what another should look for. Overlapping remits would need coordination, and
  there is no channel between them.
- **Fail-soft, per agent.** One failure costs its third of the findings and
  nothing else. Discovery continues with two returns, or none.
- **Condensed returns.** The coordinator's context holds conclusions, never
  transcripts. This is what makes three parallel explorations cheaper than one
  in-session exploration.

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/skills/discovery-skill.md` | Steps 1b and 1c — where these agents are spawned and merged |
| `.claude/commands/discovery-plan.md` | The command's own summary of this system |
| `.claude/resources/core/trust-tiers.md` | The provenance contract every prompt carries |
| `.claude/resources/core/brain-first.md` | Search before reading — the retrieval contract every prompt carries |
| `.claude/resources/core/phase-isolation.md` | The same fan-out shape, with implementation context templates |
| `.claude/resources/core/wave-execution.md` | Parallel phases, built on this pattern |
| `.claude/resources/core/pattern-capture.md` | Where `patterns_noticed` ends up |
