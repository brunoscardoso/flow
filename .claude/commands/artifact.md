---
description: Write a discovery's artifact — the self-contained walkthrough page of what users will see — beside the discovery document
---

# Artifact: User Walkthrough Page for a Discovery

## Command Description

This command writes a discovery's **artifact**: one self-contained HTML page
beside the discovery document, with the same basename and `.walkthrough.html`
in place of `.md`, walking through what people will see when the feature ships.
The discovery document says what the **code** will become; the artifact
shows what **users** will see.

Discoveries no longer write this page by themselves. It is written on request:
the DISCOVERY card's **Generate artifact** button sends this command into its
thread, or a person types it.

**Output**: `flow/discovery/discovery_<feature>_v<N>.walkthrough.html`, which the
DISCOVERY card then offers as **Open artifact**.

---

## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/artifact - Write a Discovery's Artifact

DESCRIPTION:
  Writes the user walkthrough page for a discovery: a self-contained HTML
  page beside the discovery document, showing what people will see — a
  workflow diagram, capabilities, a step-by-step user flow with mockups of
  the real screens, and the full app picture.

USAGE:
  /artifact <discovery doc>
  /artifact -help

ARGUMENTS:
  discovery doc   The discovery markdown, e.g. @flow/discovery/discovery_x_v1.md
                  (defaults to the most recent discovery when omitted)

EXAMPLES:
  /artifact @flow/discovery/discovery_user-auth_v1.md

OUTPUT:
  - <discovery basename>.walkthrough.html beside the discovery

RELATED COMMANDS:
  /discovery-plan   Writes the discovery this page illustrates
  /create-plan      Treats the page as illustration, never as requirements
```

---

## Critical Rules

| Rule | Description |
|------|-------------|
| **One file** | Write only the page beside the discovery. Never edit the discovery document, source code or configuration. |
| **Copy, then fill** | `cp` the template first, then fill its `SLOT`s with targeted edits — never retype the chrome. |
| **Verify yourself** | Run the checks in Step 4 yourself; never accept a sub-agent's report as proof. |
| **No path in the summary** | The DISCOVERY card offers the page as **Open artifact** — do not print its path. |
| **Complete and Stop** | After reporting, STOP and wait for the user. |

---

## Instructions

Follow `.claude/resources/skills/artifact-skill.md`. In short:

### Step 1: Copy the template at once

```bash
cp .claude/resources/patterns/walkthrough-template.html <discovery-basename>.walkthrough.html
```

Do this first, in the session, before delegating: the card shows its
**Writing artifact…** loader while any `SLOT:` is left, instead of opening an
empty template.

### Step 2: Delegate to a cheaper model

Read `walkthrough_model` from `flow/.flowconfig` (`sonnet`, `opus` or `haiku`;
absent or anything else → `sonnet`). **On Claude Code**, launch ONE Agent
sub-agent with `model: <walkthrough_model>`; its prompt names the discovery
path, the page path and the template path, and tells it to follow Step 3 of
`.claude/resources/skills/artifact-skill.md` (structure, rules, no emoji), read
the discovery's Design Context and Codebase Analysis, and fill the copy's slots.
It returns the page path only. **On any other runtime** (Copilot, Codex), write
the page yourself the same way.

### Step 3: The page

- **A workflow diagram first** — one node per user-flow step (same order and
  titles, each linking to its step), who acts (person / app / system), arrows
  between them, and the nodes this feature adds marked NEW.
- **Then the hero, capability cards, a 3–6 step user flow** (each step: checklist,
  a "Built on: existing X" note naming real code from the discovery's Codebase
  Analysis, and a mockup of the real screen), **the full-app picture**, optional
  later-phase sections — the template's components, repeated as needed.
- **Flow chrome stays exactly as it is** — logo header, dark/light theme,
  section nav, the "Made with Flow IDE" footer.
- **Self-contained**: no external URLs, fonts, images or network calls — the
  sandbox loads none of them. Under ~300 KB.
- **Mockups in the target app's look** — from its code, or the discovery's
  `## Design Context`, in the template's APP THEME slot scoped under `.mock`.
  Plausible sample content.
- **No emoji decoration.** Emoji appear in a mockup only where the target app
  itself would show one; never as an icon, button label, section marker or badge.

### Step 4: Verify (MANDATORY before reporting completion)

```bash
ls <discovery-basename>.walkthrough.html                                   # must exist
grep -nE "(src|href)=\"https?://" <discovery-basename>.walkthrough.html  # must print nothing
grep -c "Made with Flow IDE" <discovery-basename>.walkthrough.html         # must be >= 1 (chrome intact)
grep -c "SLOT:" <discovery-basename>.walkthrough.html                      # must be 0 (every slot filled)
```

And no emoji decoration in the page's visible text. Fix the page directly when
a check fails and re-run until all hold.

### Step 5: Report

One or two sentences naming the discovery and saying its artifact is ready.
**Do not mention the page in the chat summary** — no path, no verification line.
The DISCOVERY card already offers it as **Open artifact**; a file reference in
the transcript repeats the card and hands the reader a path instead of a door.

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once; do not repeat a finished result.
