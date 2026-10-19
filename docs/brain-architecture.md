# The Brain: Saving, Indexing and Searching Project Knowledge

A portable account of the knowledge store plan-flow calls the **brain** — what it
is, why it is shaped this way, and which parts travel to another project.

This is a concept document, not an API reference. Every number in it is measured
on a live corpus, and the one place the design loses to its predecessor is
recorded rather than argued away.

---

## 1. The problem

An agent working in a codebase re-derives the same knowledge every session. It
greps for a symbol somebody already documented, reads a file whose purpose was
settled three weeks ago, re-answers a question a previous run closed. The cost is
not just tokens — it is that each re-derivation is a fresh chance to get it wrong.

So: keep what was learned, and make looking it up cheaper than working it out again.

Three separable problems hide in that sentence, and most systems answer only the
third:

| | The question | Gets wrong when |
|---|---|---|
| **Saving** | What is worth keeping, written by whom, trusted how far? | Everything is kept, or the store fills with claims nobody can check |
| **Indexing** | What derived structure makes retrieval possible? | The index becomes a second source of truth that drifts |
| **Searching** | Given a question, which fragments answer it? | Ranking is a guess dressed as a score |

The rest of this document takes them in that order, because that is the order in
which getting it wrong is expensive.

---

## 2. The central bet: the store *is* the markdown

Plan-flow originally shipped a real index: SQLite with FTS5 and 384-dimension
vector embeddings. It was deleted. The replacement is ripgrep and a scorer over
the markdown files themselves.

What the index cost, per project:

- **41.7 MB** of derived database
- **~250 MB** of runtime dependencies (`@xenova/transformers`, `onnxruntime-node`,
  `sqlite-vec`)
- a native-module version conflict that broke the desktop build
- a rebuild step that could be missing, stale, half-written or mid-migration

What the corpus actually is, measured on this repo today:

- **303 markdown files**, about **5–8 MB** of prose
- searched end to end in **milliseconds**

The bet is simple arithmetic: a corpus that fits comfortably in memory does not
need an index to be searched well; it needs a *ranker*. And a store with nothing
derived in the retrieval path has no sync problem, no rebuild step, no
"did you run the indexer?", and no state that can be wrong.

> **Port this first.** Before building an index, measure the corpus. Under roughly
> 50 MB of text, a scan-and-rank beats an index on every axis except one — and
> §5.7 is honest about which one.

---

## 3. Saving — what gets written, and how far it is trusted

### 3.1 Four tiers, by trust and lifecycle

The store is split by **kind**, not by subsystem. Every file belongs to exactly
one tier, and the tier decides who may write it, who may read it, and what
happens when it is lost.

| Tier | Trust | Lifecycle | Example |
|---|---|---|---|
| **Semantic** — hand- or agent-authored prose | precious | never rebuilt; losing it loses knowledge | `brain/features/`, `brain/errors/`, `brain/decisions/` |
| **Raw** — auto-captured working sets | **untrusted** | transient; never read by any query | `brain/.raw/` |
| **Structural** — extracted from code | disposable | rebuilt in full on every derive | `brain/.structure/` |
| **Derived index** — generated from the semantic tier | disposable | regenerated; hand edits are overwritten | `brain/.derived/INDEX.md` |

Two rules fall straight out of the table and are worth more than the table:

- **Disposable and precious never share a file.** A generated index that someone
  can hand-edit is a file that is both, and the next rebuild silently destroys
  the edit. Keep the generator's output whole and separate.
- **Precious files are append-only or single-writer.** Anything a gate or another
  machine reads is written through exactly one verb that validates it.

### 3.2 The untrusted tier, and why it needs a wall

Auto-capture is cheap and therefore tempting: aggregate the files a session
touched, write them down, done. The problem is that cheap capture is *low
signal* — it records that a file was opened, not what was learned — and if it
lands in the same pool as authored knowledge, the pool's average quality falls
until nobody trusts any of it.

So raw captures go to `.raw/`, and **no read path names that directory**.

The important detail is *how* that is enforced. The first implementation
documented a predicate (`isTrustedBrainPath`) as the guarantee. Nothing ever
called it. The boundary was prose.

The working version enforces it by **enumeration**: the reader walks a fixed
allowlist of tier directories. `.raw/` is simply not on the list, so it cannot be
reached — rather than being reached and then filtered out.

> **The general rule.** A boundary built by *excluding* the bad path fails open
> when someone adds a new entry point. A boundary built by *enumerating* the good
> paths fails closed. Prefer the allowlist, and pin it with a test that fails if
> the list widens.

Material only crosses the wall through one deliberate step — **compaction**,
which reads raw working sets, dedupes, drops generated-file noise, merges records
for the same subject, and writes a canonical semantic document. Promotion is a
distinct operation with a name, not a side effect of cleanup.

### 3.3 Capture records paths, never content

The raw tier records only root-relative file paths pulled from a whitelist of
file tools, and never:

- tool input bodies (`content`, `old_string`, …)
- shell commands
- absolute system paths
- paths matching a secret pattern (`.env*`, `*.pem`, `id_*`, `*credentials*`, …)

A store that can accumulate secrets will accumulate secrets. Making the capture
*structurally incapable* of holding a credential value is cheaper than reviewing
what it held.

### 3.4 Two constraints that keep the store honest

These two are the most portable ideas in the whole document, and both were
learned by getting them wrong.

**Write knowledge when the code lands, not when the agent stops.**

A run finishes, writes what it built into the shared store, and the branch is
never merged. The store now describes a system that does not exist, and it is
*indistinguishable* from the knowledge that does. Nothing goes red. The document
just sits there being wrong, and the staleness checker cannot help — it re-hashes
files the document names, and those files never existed.

Description and intent are different claims and belong in different places:

1. The run writes its plan, its discovery, its review. These are **intent**, and
   live where their status is visible.
2. The code merges to the default branch.
3. *Only then* is what it does promoted to the store as **description**.

Implemented as a gate: a document may carry a run token, the merge commit carries
the same token as a message trailer (`Flow-Run: <id>`), and sync holds the
document until the token appears on the default branch. A **trailer, not a commit
SHA** — a squash merge mints a new commit, so the original is never an ancestor
of `main` and an ancestry test answers "not landed" for ever. Both squash and
rebase preserve the message body, so the trailer survives both.

The gate is three-valued, and the third value carries the weight: `true` landed,
`false` not yet, **`null` the question could not be asked** (the checkout is not
on this machine, the folder moved, git refused). `null` must *share*. A gate that
silently stops publishing when a folder moves is indistinguishable from a gate
that is broken, and nobody can tell which.

**In a closed location, an unknown file defaults to not-shared.**

The store's root holds a known set of named journals; everything else has a
folder. An unmatched file used to default to *shared*, so a stray draft synced to
the whole team.

Measured before the change: of every root-level file tracked across five projects
of a real multi-project workspace, **not one** was a legitimate artifact — four
wiki drafts, two PR drafts, a QA checklist, a test plan, a `.patch` and a
`.DS_Store`. A default that was wrong for 100% of the cases it had ever decided
was pointing the wrong way.

The two errors are not symmetrical:

- A file wrongly kept local is filed properly later. The cost is a delay.
- A file wrongly published is read by other people's agents as settled knowledge,
  steers their work, and **cannot be unsent**. Deleting it later removes neither
  the history nor what it already caused.

Closing a default means naming the legitimate members out loud. One real journal
was shared only by falling through the old default, so it needed an explicit row
before the default could flip — otherwise the fix silently stops a real file
syncing.

### 3.5 Sync classes (for a shared store)

When the store is shared across machines, every path gets exactly one class, by
first match in a single ordered table:

| Class | Travels? | Merge |
|---|---|---|
| `generated` | no — rebuilt locally | n/a (git-ignored) |
| `append-only` | yes | union of both sides' lines |
| `personal` | **never leaves the machine** | n/a (ignored, *and* refused by a pre-push guard) |
| `authored` | yes | ordinary line merge |

One table, read by the ignore-file emitter, the merge-attribute emitter, the
classifier and the push guard. Nothing else is allowed to restate which file is
personal — otherwise "personal" means four slightly different things and one of
them is wrong.

`append-only` plus union-merge is what makes a shared knowledge store survive
concurrent writers without a server: two machines appending to the same JSONL
never conflict.

---

## 4. Indexing — eager structure, tiered semantics

### 4.1 The principle

> **Index cheap structural facts fully and eagerly; tier only the expensive
> semantic work.**

Structure — symbols, imports, declaration lines, folder shape, call edges — is
cheap to extract and universally needed. Extract **all** of it, hash-gated so an
unchanged file costs nothing. Partial structure creates blind spots that poison
everything downstream: a search that can only sometimes find a symbol is worse
than one that never can, because you stop checking.

Semantics — summaries, narrated notes, learned module documentation — are
expensive and uneven in value. Those are deferred, triggered, or requested.

### 4.2 What is actually derived

Two artifacts, both disposable, both rebuilt whole:

**Code cards** — one markdown section per source file, in the searched corpus:

```markdown
## app/src/browser-guest/inspect-bridge.ts

In-guest inspect bridge for the embedded browser's <webview>.

symbols:
- fiberFromNode (function) — line 65
- componentName (function) — line 76

imports: ../shared/browser-inspect-channels, ./inspect-bridge, electron

hash: c24d0e4c0902dad784e49fe685f239a03da88d82a2ac63e96f89703784ed524d
```

Note the `hash:` line. It is what makes §5.6 possible.

**A symbol sidecar** — `symbols.jsonl`, one record per declaration
(`name`, `kind`, `path`, `line`, `language`, `fileHash`). **11,590 records** on
this repo. It exists because "where is `ThreadScopeManager`" must be an *exact*
hit at the top, and no amount of semantic ranking reliably does that for a
proper noun.

**The generated relational index** — one flat `##` section per feature carrying
its summary, its parts and its relationship edges. Flat *by construction*, so
that the chunker (§5.2) delivers each feature whole: name, summary, parts and
edges in one fragment. That is not a special case in the search code; it is why
the generator was written flat.

> **Port this.** Shape generated documents to match how the retriever cuts them.
> It costs nothing at generation time and removes an entire class of special case
> at query time.

### 4.3 Derived output is never the source of truth

Everything in §4.2 is regenerated in full on every derive and is safe to delete.
The cost of a rebuild is bounded; the cost of a derived file that is quietly
authoritative is not.

Corollary: **hash-gate the derive**, don't timestamp-gate it. Comparing an
artifact's mtime against the last commit time treats a dirty working tree as
fresh — uncommitted edits never move the commit clock, so the artifact silently
drifts from reality. Key invalidation on content hashes of the inputs.

### 4.4 The approach that was retired: reference-code indexing

Before the corpus search, retrieval worked by **nomenclature**. Every reference
file was carved into numbered sections with stable codes — `COR-CG-1`,
`COR-SC-4`, `GLB-*` for shared patterns, `LRN-*` for learning curricula — and
each folder carried an `_index.md` mapping code → description → **line range**:

```markdown
| Code     | Description                           | Source                | Lines   |
|----------|---------------------------------------|-----------------------|---------|
| COR-CS-1 | Complexity scale table (0-10 levels)  | complexity-scoring.md | 12-21   |
| COR-CS-5 | Real-world scoring examples           | complexity-scoring.md | 187-236 |
```

An agent loaded the index (cheap — a curated table of contents) and expanded only
the line range behind the code it wanted.

It is a genuinely good design, and it is important to be accurate about why it is
not here any more.

**It was not removed because it failed.** It was deleted on 25 March 2026 in
commit `0135380f`, *"Phase 4: Remove reference code system"* — 1,832 deletions
across 18 files — as **Phase 4 of the `sqlite-brain-index` plan**. It was cleared
out to make room for the SQLite + embeddings index. The commit message records no
rationale, and the plan document is not in version control, so no decision record
survives.

Then the thing it made room for was itself deleted (§2).

**So the current ranker has never been compared against it.** The 12-question
side-by-side of §5.7 measured file-search against the *SQLite index*; reference
codes were already gone by then. The honest position is that this design displaced
a predecessor it never ran against.

What *can* be said against the old scheme is narrower, and it is about the
**addressing**, not the concept:

- **Line ranges drift silently.** `COR-AP-1` pointed at `allowed-patterns.md`
  lines 45–152 for *"Example patterns (Naming, SRP, Errors, Types)"*. That file is
  571 lines today, and lines 45–152 now hold the middle of a pattern about
  end-to-end bug fixing. The code would expand confidently, and return the wrong
  section — worse than a miss, which at least announces itself.
- **It needed a maintenance verb.** Indexing was a separate command, and an
  un-indexed file was declared ineligible to load at all — so knowledge could be
  on disk, readable, and contractually invisible pending a chore.
- **It cannot answer a cold question.** Retrieval by code requires knowing the
  code. That is a table of contents, not a search.

None of those is an argument against a curated index. They are arguments against
**line numbers as the anchor** and against **a human-maintained freshness
obligation**.

**The two are complementary, not competing.** They answer different questions:

| | Answers | Fails at |
|---|---|---|
| Curated index + bounded expansion | *"load me the canonical section on X"* — precise, predictable cost, no ranking | a question whose subject you cannot name |
| Corpus search + ranker | *"what happens when verification fails twice"* — orientation from cold | returning exactly one agreed-on canonical passage |

A store that has only the second has no canonical answer to anything; a store that
has only the first cannot be explored. The retrieval id of §5.5 already hashes
**(file, heading)** — so the pieces for a heading-anchored curated index are
present, and the fragile part (a maintained line number) is exactly the part that
no longer has to exist.

> **Port this as a design note, not a warning.** If you want a curated index,
> anchor entries to **headings**, which the chunker already derives, and never to
> line numbers. Then the index carries human judgment about what is canonical,
> and the machine carries the addressing — neither doing the other's job.

**One thing was lost outright.** The corpus roots are all *project-relative*. The
cross-project vault — shared patterns and learning curricula living outside any
one repository — is not in them, and no search scope reaches it. The reference-code
index was that tier's **only** retrieval path, and removing it left the tier with
none. Nothing is lost today because the directories are empty, but the hole is
real.

> **This one is a warning.** When you delete an index, check what it was the only
> reader of. A retrieval path can be the sole access route to an entire tier, and
> that dependency stays invisible until the tier goes quiet.

---

## 5. Searching — a ranker, not an index

The search runs two layers together and fuses them. There is nothing to build and
nothing that can be stale-as-a-whole.

### 5.1 Narrow, then rank

`ripgrep` produces candidate files; a pure-JS scan is the fallback when `rg` is
absent. The fallback **degrades in speed, never in answers** — scanning the whole
corpus costs milliseconds and returns the same ranking.

> That property is worth engineering for. An optional dependency whose absence
> changes the *answers* is a dependency that silently makes the tool unreliable
> on half the machines it runs on.

Candidates are capped (400 files, sorted first so the cut is deterministic).

### 5.2 Heading-aware chunking

Markdown is cut into chunks at headings of any level. Each chunk keeps its own
heading line in its text — so the ranked snippet says what the section *is* — and
carries the heading's line number, so every hit is a `file:line` pointer.

Two details that matter more than they look:

- **Fenced code is opaque.** A `#` inside a fence is not a heading. Without this,
  code samples shred the document into nonsense chunks.
- **HTML fences are dropped entirely**, fence lines included. Inline markup
  samples are dense with common words and outrank prose otherwise.

A chunk longer than 120 lines is split, so one enormous section cannot swamp a leg.

### 5.3 Query processing: truncation, not stemming

Query tokens are lowercased, deduped, and filtered: minimum length 3, and a short
stoplist of words that appear in nearly every chunk *and* nearly every question.

The stoplist is kept deliberately small. An aggressive one throws away the single
term that made a question specific — "what **enforces** the raw boundary" has to
keep "enforces". And if *every* token is a stopword, the stoplist is abandoned
rather than returning nothing: a question made entirely of common words is still
a question.

Then the part that makes an index unnecessary. Tokens are folded by
**truncating to their first 5 characters** — not by a suffix stripper:

> A suffix stripper must be applied to *both* sides to be symmetric. "boundary"
> and "boundaries" only meet if the documents are tokenized and folded too —
> which means building the index this design exists to delete. Truncate both
> sides and a raw substring scan does the same job: `boundary`/`boundaries`,
> `persist`/`persists`/`persistence`, `enforce`/`enforced`/`enforces`,
> `skill`/`skills` all collapse to one prefix, with no dictionary and no
> preprocessed corpus.

The prefix is **anchored at a word boundary** when matched. This is not a detail.
Unanchored, `raw` matches `drawer` — measured on this corpus, where "what enforces
the `.raw` boundary" returned five hits about a component drawer and none about
the tier boundary.

### 5.4 Scoring: frequency × rarity × coverage

Per stem, per chunk:

```
contribution = weight(stem) × (1 + ln(tf))
```

Saturating term frequency: the tenth mention of a word says far less than the
second.

**Weight is inverse document frequency**, computed over the *candidate set*, not
the corpus — the candidates are what is being ranked, it costs one pass already
being made, and no persisted statistic means nothing to keep in sync:

```
weight = min(2.5, ln(1 + N/df))
```

IDF is the difference between a ranking and a guess, and it is the one thing a
plain grep cannot do. "What enforces the `.raw` boundary" carries `raw` (rare, and
the actual subject) alongside `bound` (which stems from *boundary*, *bound* and
*boundaries*, and appears in a third of the corpus). Weighted equally, the common
word wins on frequency alone and the answer never surfaces.

**The cap at 2.5 was measured, not chosen.** Uncapped, `ln(1 + N/df)` reaches ~7.6
for a stem appearing in one chunk of two thousand, letting a single rare word
decide the answer alone. The side-by-side caught this live: *"what happens when
verification fails twice"* ranked five documents containing the word "twice" and
none describing the retry loop — the target document does not use the word at
all, and "twice" was incidental to the question rather than its subject. Capped,
a rare term still outranks a common one (a term in a third of the corpus is worth
~1.4) but can no longer outvote covering the rest of the question.

Then **coverage**, which matters most for the questions this kind of corpus gets:

```
score = Σ contributions × (0.25 + 0.75 × coverage²)
```

where `coverage` is the fraction of distinct query stems the chunk matched at all.
A chunk covering three of three query terms beats a chunk repeating one of them
forty times. A relational question — *"how do skills affect playbooks"* — is
answered by the document naming **both** sides of the relation, never by the one
that says "playbooks" most often. Squaring coverage makes that preference sharp
rather than polite.

### 5.5 Two legs, fused

The same scorer runs twice:

1. **content** — over the chunk body.
2. **titles** — over the heading and file path only, weighted 1.5×.

A chunk strong in both is one whose *subject* is the question, not one that merely
contains the words. That is exactly the agreement signal reciprocal rank fusion
exists to reward, and the legs are RRF-fused (`k = 60`) and normalized to 0..1.

The symbol layer scores on absolute, fixed bands — **0.9 exact name, 0.75 prefix,
0.6 case-insensitive substring** (substring only for tokens of 4+ characters;
below that it is noise). No ranking subtlety: an exact name match *is* the answer.

Finally, a hit whose underlying **source file appears in two or more distinct
layers** gets a +0.15 agreement boost. Independent evidence pointing at the same
file is the strongest signal the system has.

Results are deduped by (file, heading/name), sorted, and capped at the caller's
limit — 5 by default.

### 5.6 Freshness is what makes skipping the code read safe

Every hit carries `fresh` / `stale` / `unknown`.

A code or symbol hit carries the recorded content hash of the file it describes.
At answer time the file is re-hashed through a single hashing code path; a
mtime+size stamp cache acts as a cheap pre-filter but is **hints only, never the
truth** — any mismatch falls through to the real hash.

- `● fresh` — the recorded knowledge provably matches the code. Act on it without
  opening the file.
- `○ stale — verify against code` — the source drifted. Confirm before acting.
- plain — no machine check exists for this hit kind.

This is the clause that makes the whole thing safe to rely on. A knowledge store
without it is asking you to trust prose of unknown age against code you can read
right now, and the rational response is to always read the code — at which point
the store has bought nothing.

### 5.7 The trade, recorded rather than denied

A side-by-side over 12 fixed questions, file-path search versus the retired
embedding index: **5 file-path wins, 5 index wins, 2 ties.**

The regression is real. **Every question the index won was vocabulary-bridging:**

- *"what happens when verification fails twice"* → a section titled **Retry Behavior**
- *"how do I know a module is stale"* → a section titled **The Staleness Authority**

That is precisely what the embeddings bought, and precisely what was given up.
In exchange: no database, no 250 MB runtime, no native-module conflict, no
rebuild, nothing that can be stale as a whole, and `file:line` pointers the
chunk-based index could never produce.

Because the trade is known, the *contract* compensates for it. The usage rule
shipped alongside the search is part of the design, not a footnote:

> **Word your question in the project's own vocabulary.** Search matches the
> words the corpus uses, not synonyms of them. If the first phrasing misses,
> rephrase **once** with a term you expect the document to contain, then fall
> back to grep. A miss is signal, not an invitation to prompt-engineer.

Capping retries at one is deliberate: an agent that tries eight phrasings burns
more than the grep it was avoiding, and the miss is more useful as a signal that
something needs documenting.

One more thing the measurement bought, worth more than the verdict: **the first
run scored 4 / 3 / 5, and reaching 5 / 5 / 2 took two fixes the comparison itself
caught** — the IDF cap of §5.4, and adding bare auxiliaries (`get`, `can`, `will`,
`do`) to the stoplist after *"where does a turn **get** persisted"* ranked a
`GET /users` contract example first, because `get` is a real word in an API corpus
and pure grammar in the question. Neither defect was visible by reading the code.
A fixed question set is not how you prove the ranker works; it is how you find out
it doesn't.

### 5.8 Determinism

Same corpus plus same query produces the same ranking, always. Every sort has an
explicit tiebreak on (file, heading); no map iteration order reaches a result; no
clock is read.

A search that reorders its own answers between runs cannot be compared against
anything — including its own predecessor, which is how §5.7 was measurable at all.

### 5.9 Fail-soft everywhere

A missing directory, an unreadable file, an absent sidecar or a missing `ripgrep`
collapses *that contribution* to empty. It is never an error surfaced to the
caller. A knowledge lookup that can fail hard is a knowledge lookup callers will
wrap in a try/catch and stop trusting.

---

## 6. Porting this: a staged plan

**Stage 1 — the minimum that is already useful.** Markdown files in known folders,
a heading-aware chunker, and the §5.4 scorer. No index, no capture, no derive.
This is a few hundred lines and answers most orientation questions.

**Stage 2 — exact names.** A symbol sidecar from whatever parser you have, fused
with fixed scores. Cheap, and it fixes the most frustrating class of miss.

**Stage 3 — freshness.** Record a content hash next to anything describing code,
and re-check it at answer time. This is what converts the store from "notes" to
"something you can act on without reading the file".

**Stage 4 — capture and promotion.** Only once the first three are in use. Build
the untrusted tier with an *enumerated* read allowlist from day one, and make
promotion an explicit named step.

**Stage 5 — sharing.** The class table, the closed-root default, the landed gate.
Only when more than one person's machine is involved — and do not postpone the
closed-root default past the first sync, because §3.4 is what happens if you do.

### Checks worth copying verbatim

- Measure the corpus before you choose an index.
- Enumerate the trusted read paths; never filter out the untrusted one.
- Hash-gate derives; never mtime-gate them.
- Cap IDF.
- Anchor stem matches at word boundaries.
- Make the degraded path (no `rg`) slower, never different.
- Prefer a query-time derived identifier over a hand-maintained one.
- When deleting an index, check which tier it was the only reader of.
- Keep a fixed question set and re-run it after every ranking change. Without one,
  "the search feels better" is unfalsifiable — and with one, a regression is a
  number you can decide to accept.

---

## 7. Specification: the heading-anchored catalog

This is the design that brings back §4.4's curated index without the part that
broke. It is written to be implemented, here or elsewhere.

### 7.1 What it is, and what it is not

A **catalog** is a hand-authored table of contents over the corpus: a stable code,
a one-line description of what that section answers, and an address. Resolving a
code prints exactly one chunk, in full, with no ranking involved.

It is **not** a search index, and it must never degrade into one. A catalog that
silently falls back to search on a miss is a catalog whose answers you cannot
trust, because you can no longer tell a curated answer from a guessed one.

The division of labour with §5 is strict:

- The **catalog** carries human judgment: *which section is the canonical answer
  to this.* That is the part a machine cannot derive.
- The **machine** carries the addressing: locating that section in a file that has
  since been edited. That is the part a human cannot maintain.

§4.4's version inverted this — it asked a human to maintain line numbers, which is
exactly backwards.

### 7.2 Where it lives

`flow/brain/catalog.md` — one per project.

Not under `.claude/resources/`, because auto-provisioning owns that directory and
refreshes it from the bundle; a curated, project-specific file there would be
overwritten on the next version bump. `flow/brain/` is authored content that
provisioning never touches.

Sync class: **`authored`** (§3.5). It is precious, it is shared, it merges by
line like any other prose.

### 7.3 Format

Plain markdown tables, grouped under `##` headings. Human-editable by design —
there is no generator and no rebuild step.

```markdown
# Catalog

## Core rules

| Code | What it answers | Source |
|------|-----------------|--------|
| COR-CS-1 | The 0-10 complexity scale and what each level means | `.claude/resources/core/complexity-scoring.md` › Complexity Scale |
| COR-FP-24 | Why a deliverable must not be written to the knowledge root | `.claude/rules/core/forbidden-patterns.md` › 24. DON'T Write a Deliverable to the Knowledge Folder's Root |
```

- **Code** — `^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$`. Opaque to the resolver; the grouping
  is a human convention, not a parsed hierarchy.
- **What it answers** — free text. This is the column an agent reads when it loads
  the catalog, so it is phrased as the question the section settles.
- **Source** — `` `<corpus-relative path>` › <exact heading text> ``. The ` › `
  separator is the one search output already uses for `file › heading`, so the two
  surfaces read alike.

The address holds **no line number, no offset, no id and no hash.** That absence is
the entire design.

### 7.4 Resolution

One algorithm, sharing the search's chunker so the two can never disagree
(allowed-pattern #14):

1. Parse `catalog.md`; find the row whose code matches. Not found → refuse
   `unknown-code`.
2. Read the source file. Missing → refuse `source-missing`.
3. Run the **same `chunkMarkdown`** §5.2 uses.
4. Keep chunks whose `heading`, trimmed, equals the catalog's heading exactly.
5. Exactly one → print it whole. Zero → refuse `heading-not-found`. Two or more →
   refuse `heading-ambiguous`.

Resolution never consults the ranker, never scores, and never reads a stored
location. Same corpus plus same code yields the same bytes.

**Exact match, and refusal on ambiguity, is measured rather than assumed.** Across
the live corpus — 303 files, 4,687 distinct headings — only **6 files (1%)** carry
any duplicate heading at all, and only **11 heading names (0%)** repeat. Exact
addressing covers essentially the whole corpus, and the rare collision is refused
loudly instead of resolved by a tiebreak nobody can predict. The same contract
already governs change-note quotes in this repo, which refuse a quote found zero
or 2+ times.

If ambiguity ever becomes common, the documented extension is a heading **path**
(`… › Parent › Child`), not a line number and not a "first match wins" rule.

### 7.5 Verbs

| Verb | Does |
|---|---|
| `brain ref <CODE>` | Print that one section in full |
| `brain ref --list [--prefix <P>]` | The table of contents — code, description, source. What an agent loads |
| `brain ref --check` | Resolve **every** entry; report each failure with its reason |

All three take `--json`. Refusals follow the house contract: a JSON payload line on
stdout carrying what the caller needs, then `brain ref refused: <reason> — <sentence>`,
exit 1.

`--check` is the whole maintenance story. It is cheap, it is CI-able, and it turns
the one failure mode §4.4 could not survive — an address that quietly stops
pointing at the right thing — into a named, located, fixable error.

### 7.6 Why it cannot go stale

There is nothing stored that can drift:

| Edit | §4.4 line ranges | Heading anchor |
|---|---|---|
| Insert text above the section | **silently wrong** — expands neighbouring content | unaffected |
| Edit inside the section | silently wrong (range truncates) | unaffected |
| Move the section in the file | **silently wrong** | unaffected |
| Rename the heading | **silently wrong** | refused by name, caught by `--check` |
| Delete the section | silently wrong | refused by name, caught by `--check` |

Every row that was silent becomes loud, and most become non-events.

### 7.7 Out of scope for v1

Named so they are decisions rather than omissions: no generator (the catalog is
authored, and anything generated would be a second source of truth); no fallback
to search; no cross-project catalog (the §4.4 vault hole is a separate decision);
no automatic code minting; and search output does not yet mention that a hit is
catalogued.

---

## 8. Where the real thing lives

| Concern | Implementation |
|---|---|
| Chunk, stem, score, rank | `src/cli/state/brain-file-search.ts` |
| Layer fusion, hit shape, scopes | `src/cli/state/brain-search-core.ts` |
| Freshness resolution | `src/cli/state/hit-freshness.ts` |
| Generated relational index | `src/cli/state/brain-index.ts` |
| Raw capture (paths only) | `app/src/main/brain/capture.ts` |
| Promotion across the tier wall | `app/src/main/brain/compaction.ts` |
| Sync classes | `src/cli/handlers/knowledge-classes.ts` |
| Landed gate | `src/cli/state/knowledge-status.ts`, `src/cli/handlers/knowledge-landing.ts` |
| The 12-question measurement | `docs/brain-search-comparison.md` |
