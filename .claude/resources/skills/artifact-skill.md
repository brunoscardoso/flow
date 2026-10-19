# Artifact Skill

## Purpose

Write a discovery's **artifact** — its user walkthrough page: one
self-contained HTML file beside the discovery document, with the same basename
and `.walkthrough.html` in place of `.md`:

```
flow/discovery/discovery_<feature_name>_v<version>.md
flow/discovery/discovery_<feature_name>_v<version>.walkthrough.html
```

"Artifact" is what the app calls the page; the file name, its location and its
address inside the app are unchanged, so every page written before the name
changed still opens.

**Why it exists — two perspectives on one discovery.** The discovery document
is the *technical* perspective: what the code will become. The person who
decides whether a feature is right also needs to see what *users* will see.
The artifact is that user perspective: the DISCOVERY card offers it as
**Open artifact**, and Flow shows it in an editor tab, the page running in a
sandbox under a slim header. It sits beside the discovery, so it is reviewed,
versioned and archived with it.

**On request, never automatically.** Discoveries do not write the page. A person
asks for it — the DISCOVERY card's **Generate artifact** button (which sends
`/artifact @<discovery path>` into its thread) or `/artifact` typed by hand.

This skill writes exactly one file: the page. It does NOT:

- Write or modify source code, configuration, or the discovery document itself
- Create files anywhere but beside the discovery

---

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `discovery_doc` | Yes | Path to the discovery markdown (`flow/discovery/discovery_<feature>_v<N>.md`), usually as an `@` reference |

If no path is given, use the most recent `flow/discovery/discovery_*_v*.md` and
say which one you chose. If the file does not exist or is not a discovery
document, stop and say so — do not invent one.

**Any discovery, any UI.** There is no UI gate. For a backend-only feature the
"user" is whoever notices the change — an operator watching a dashboard, an API
consumer reading a response, a developer running a command — and the page walks
through what *they* see before and after.

---

## Workflow

### Step 1: Copy the template at once

**Copy the template to the page's path right away**, in the session, before
anything else:

```bash
cp .claude/resources/patterns/walkthrough-template.html <discovery-basename>.walkthrough.html
```

With the copy in place the DISCOVERY card's artifact door shows its loader
(**Writing artifact…**) until the placeholders are filled, instead of opening an
empty template. The card reads a page that still has any `SLOT:` marker as being
written — which is also why no marker may be left.

If a page already exists beside the discovery, it is replaced: the person asked
for it to be written again.

### Step 2: Pick the writer — a cheaper model, by default

The page is large (35–45 KB, roughly 10–12K output tokens) and none of it is
reasoning: the requirements, questions and Story are already decided in the
discovery. So the session does not write it.

1. Read `walkthrough_model` from `flow/.flowconfig` — `sonnet`, `opus` or
   `haiku`; absent or anything else means `sonnet`.
2. **On Claude Code**, launch ONE sub-agent with the Agent tool and
   `model: <walkthrough_model>`. Its prompt names the discovery path, the page
   path, the template path, and says: follow Step 3 of
   `.claude/resources/skills/artifact-skill.md` (structure, rules, no emoji),
   read the Design Context and Codebase Analysis from the discovery, and write
   the page by filling the copy's slots — the copy already exists. It returns
   the page path only. **On any other runtime** (Copilot, Codex — no way to
   pick a sub-agent's model), write the page yourself the same way.

### Step 3: Fill the page

**Copy the template; never retype it.** About 20 KB of every page is the Flow
template's chrome and styles, identical on every page. Retyping it costs that
output on every page and lets the chrome drift. Fill the copy with targeted
edits — one edit per `SLOT` or per repeated component — so the only output is
the page's own content. Never rewrite the whole file.

**Start from the Flow template.** Fill every `SLOT` of the copy. The parts
marked **FLOW CHROME** — the Flow logo header, the dark and light themes (Flow
tells the page which one it is showing; a shared page follows the reader's
system and has a toggle), the section nav and the "Made with Flow IDE" footer —
stay exactly as they are: they are what tells anyone the page is shared with
that it came from Flow IDE. Repeat the marked components (capability card,
step, later section) as many times as the discovery needs, and keep the nav
links matching the sections.

**Structure** (the template's sections; follow the shape, not any product
content):

1. **Sticky nav** — a bar at the top with one button per section below, which
   scrolls to it and marks the section in view as active.
2. **Workflow diagram — always the first section.** The whole user journey at
   a glance, before any of it is explained: one node per User-flow step, in the
   same order and with the same titles, each linking to its step, with an arrow
   between each pair. Each node says who acts (`data-actor`: `person` — the
   user; `app` — the target app's UI; `system` — a backend, job or
   integration) and what happens in a few words. A node this discovery
   introduces is marked `is-new` with the NEW tag (drawn dashed, like every
   prediction on the board); one the app already does today stays solid, so the
   reader sees what changes and what it stands on. An arrow's label is what
   moves between the two nodes (a click, an event, a message), one to three
   words, and may be empty.
   A branch is one line inside the node it leaves from, never a second diagram.
   The diagram is Flow's drawing, not a mockup — no APP THEME inside it.
3. **Hero** — the feature name, a one-line pitch saying what the user gets, and
   a row of capability pills (short text labels).
4. **What's being built** — a grid of capability cards: a name and one or two
   sentences each. Text only — no emoji icon tiles.
5. **User flow** — 3 to 6 steps. Each step has:
   - a title and a one-to-two-sentence description;
   - a checklist of what the user does or sees at this step;
   - a **Built on:** note naming the real existing code the step stands on —
     take the names from the discovery's Codebase Analysis, e.g.
     "Built on: existing `ThreadList` sidebar and `useThreads` hook";
   - a **mockup of the real screen** at that step, beside the prose.
6. **The full picture** — one larger mockup of the whole app shell with the
   feature in place, so the reader sees where it lives.
7. **Later** (optional) — one section per deferred phase or out-of-scope idea
   the discovery recorded, each clearly marked as not in this version.

**Rules** — the page runs in a sandbox whose policy allows inline script and
style and blocks every network request, so:

1. **One self-contained file.** The template's `<style>` and navigation
   `<script>`, plus the APP THEME styles you add. Any script you add is for
   navigation only (for example, switching between step tabs). Nothing else
   scripted.
2. **No external anything.** No external URLs in `src` or `href`, no web fonts,
   no remote images, no `fetch` — none of them will load. Use system font
   stacks, inline SVG or CSS shapes where an image would go, and `data:` URIs
   only when an image is truly needed.
3. **Flow around the page, the target app inside the mockups.** The page's
   chrome is Flow's (the template). Every MOCKUP is the target app's screen:
   take its theme — tokens, colours, typography and components as found in the
   code, or the discovery's `## Design Context` — and put it in the template's
   APP THEME slot, scoped under `.mock`, so each screen looks like the same
   product and never restyles Flow's chrome.
4. **Plausible sample content.** Realistic names, numbers and copy the target
   app would actually show. Lorem ipsum and "Item 1 / Item 2" make a screen
   impossible to judge.
5. **Illustration, not implementation.** A mockup shows a screen; it is not the
   component's markup and nothing downstream copies it. `/create-plan` treats
   it as illustration, never as requirements.
6. **Keep it under ~300 KB.**

**No emoji decoration** — carried verbatim from the discovery that introduced
the page (`discovery_feature-view_v1.md`, C-5):

> - **C-5 (no emoji decoration)**: The walkthrough is not decorated with emoji.
>   The reference put an emoji tile on every capability card (📁 ⚡ 👥 🔒 🤖 📋)
>   and emoji on buttons and badges; it reads as generated filler, not as a
>   product. (Source: user, 2026-09-28)
>   - **Native page**: capability cards and steps carry no icon at all by
>     default. If an icon is ever allowed, it is a name from Flow's own `fl-icon`
>     set, never a character the agent typed.
>   - **Mockups**: emoji appear only where the target app itself would show one,
>     such as a user's message or a reaction picker. They never stand in for an
>     icon, a button label, a section marker or a status badge. Use text labels,
>     or simple inline SVG/CSS shapes that match the Design Context.
>   - **Enforcement**: the discovery skill's authoring step states this rule. The
>     CLI validation path warns when the section's own fields (pitch,
>     capabilities, titles, checklists) contain emoji; it warns and does not
>     refuse, the same way parse warnings work today.

(The rule applies to the whole page — its nav, hero, cards, steps and mockups
alike.)

### Step 4: Verify it yourself

Never accept the sub-agent's report as proof (forbidden-pattern #7):

```bash
ls <discovery-basename>.walkthrough.html                                   # must exist
grep -nE "(src|href)=\"https?://" <discovery-basename>.walkthrough.html  # must print nothing
grep -c "Made with Flow IDE" <discovery-basename>.walkthrough.html         # must be >= 1 (chrome intact)
grep -c "SLOT:" <discovery-basename>.walkthrough.html                      # must be 0 (every slot filled)
```

Also read the page's visible text for emoji decoration and remove any that the
target app itself would not show. If a check fails, fix the page directly; do
not relaunch the sub-agent for a one-line repair. Re-run until all hold.

### Step 5: Report

One or two sentences: which discovery the artifact was written for, and that it
is ready. **Do not mention the page's path** — no path, no verification line.
The DISCOVERY card offers it as **Open artifact**; a file reference in the
transcript repeats the card and hands the reader a path instead of a door.

---

## How the Page Is Opened, and Why It Cannot Reach Flow

MOVED HERE FROM `CLAUDE.md` (#1949). The always-loaded file paid ~1,950 tokens
per session and per sub-agent to describe a subsystem most sessions never
touch, and then pointed here anyway.

When the watcher sees the page beside a discovery (`FlowArtifactChangedEvent.walkthrough`; a page written after the markdown re-emits the discovery's event), the DISCOVERY card's artifact button reads **Writing artifact…** while any `SLOT:` is left and **Open artifact** once the page is written; pressing the card itself opens the discovery document. Internal names (`walkthrough`, `.walkthrough.html`, `flow-page://walkthrough`, `flow:open-feature-view`) are unchanged, so every page written before the rename still opens. That opens an editor tab: a slim Flow header (the doc title) above the page in an iframe. **The page never runs in Flow's origin.** Main registers a privileged `flow-page` scheme and serves `flow-page://walkthrough/?root=<root>&path=<rel>` only for a root the renderer may already address and only for a `flow/(discovery|plans|brainstorms|archive)/<name>.walkthrough.html` path (lexical guard — no `..`, nothing absolute; `app/src/main/flow/walkthrough-page.ts`), with its own CSP: inline script and style, `data:` images and fonts, `default-src 'none'` for everything else. The iframe is `sandbox="allow-scripts"` only — never `allow-same-origin` — so the page's own navigation script runs while `parent.document` is refused and every fetch or remote image is blocked (proven in a hidden Electron probe: zero network). An open view reloads only when the page itself changed and only while it is on screen.

---

## Sharing an Artifact

**Feature View Sharing.** An author can publish an artifact ("Share this artifact") as a private page on **planflow.sh** — the walkthrough page and its discovery document, nothing else, sent only after the Share dialog has shown both by name and size (main refuses a publish whose files changed since). It spans **two repos**: Flow (`app/src/main/share/` — the endpoint, compiled in from `FLOW_SHARE_ENDPOINT` and absent by default, the client and its IPC; `app/src/renderer/threads/share-*` — the dialog and the share-state strip) and `plan-flow-lp` (`src/lib/share/`, host routing in `src/proxy.ts`). Three separate checks guard it: **(1) the author** — the bearer is Flow's existing desktop session token, verified by planflow.sh with ingest's own `SESSION_SECRET` and then refused if the identity's `identities.disabled_at` is set (a signed token cannot otherwise be ended early); **(2) the viewer** — email-code sign-in (Better Auth + Resend; the emailed link opens a Confirm page and never signs in on GET), sessions held in `__Host-` host-only cookies, 90 days; **(3) the content** — agent-written HTML is served only from `usercontent.planflow.sh` under a 2-minute HMAC token bound to share and version, with a `sandbox allow-scripts; default-src 'none'` CSP, and that host answers nothing but `/content/p/<id>` while planflow.sh never serves `/content/*`. Access is decided by **one function**, `canView` — the API, the viewer page and every content token ask it, never a copy. **Identity is still not a gate**: the share client is the one new named identity reader (`identity-is-not-a-gate.test.ts`), signed-out Flow loses nothing but publishing ("Sign in to share"), and the token never crosses IPC. Schema SQL (ingest's `disabled_at` first, then `db/schema.sql`, then `db/auth-schema.sql`, all on ingest's Postgres), the private Blob store, the content domain, Resend's domain and the env vars are applied **by hand**, per `plan-flow-lp/SETUP.md`. Contract: `flow/contracts/share-api_contract.md`.


---

## What This Replaced

This replaced a hybrid (a walkthrough section inside the discovery markdown, its parser, a native page and a validation CLI verb) — one way to do it now. **No emoji decoration**: a mockup shows an emoji only where the target app itself would. `/create-plan` treats the page as illustration, not requirements, and never lifts its HTML into a plan.

**Retired 2026-10-08 — the board's discovery view.** The Blueprint side of a discovery is gone: the document diagram a DISCOVERY / PLAN card opened (`flow:open-discovery-view`, the "No structure to draw yet" stage), its review bar (Today / After / Whole diagram / Close review), review-on-territory (planned and changed cells), a feature brief's **Open discovery view** control, the feature level's "proposed by" plan row, and every door into them — the card's own press, the artifact tab's **Open discovery view**, the chat STORY card's **Blueprint** button and its board decoration of the active step. The discovery workflow, the chat DISCOVERY / PLAN cards and the STORY card stay. The code storyline's Today ⇄ After (`blueprint storyline --plan`) stays: its plan is the plan under review when one is open, else the compiled story's (`storyPlanFor`, `app/src/renderer/blueprint/story-plan.ts`), and a comparison that does not touch the story on screen is dropped.

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/patterns/walkthrough-template.html` | The template the page is copied from |
| `.claude/resources/core/design-awareness.md` | Design Context — the tokens the mockups are styled from |
| `.claude/resources/skills/discovery-skill.md` | The discovery the page illustrates |
