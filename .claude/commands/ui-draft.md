---
description: Draft a feature's screens as look-alike HTML on a canvas, from a discovery or from a request
---

# UI Draft: Look-alike Screens on a Canvas

## Command Description

This command writes **UI drafts**: one plain HTML file per screen, a shared
`tokens.css` and a `layout.json`, in a canvas folder under `flow/drafts/`. The
screens look like the target app, because they are written from its real tokens
and screens. Flow shows the canvas in its built-in browser and opens it when it
is complete.

It works from a discovery (`@flow/discovery/discovery_<feature>_v<N>.md`: one
screen per step of its user flow) or from free text ("draft the settings
screen"). It runs on every agent runtime with normal file tools.

The DISCOVERY card's **Generate UI drafts** button sends this command into its
thread, or a person types it.

---

## Help

**If the user invokes this command with `-help`, display only this section and stop:**

```
/ui-draft - Draft Screens on a Canvas

DESCRIPTION:
  Writes look-alike screens of the target app as plain HTML files in a canvas
  folder, from a discovery's user flow or from a request.

USAGE:
  /ui-draft @<discovery doc>
  /ui-draft <what to draft, in words>
  /ui-draft -help

EXAMPLES:
  /ui-draft @flow/discovery/discovery_user-auth_v1.md
  /ui-draft the settings screen with a billing tab

OUTPUT:
  - flow/drafts/<canvas>/layout.json, tokens.css and one <screen>.html per screen

RELATED COMMANDS:
  /artifact   Writes the walkthrough page of what users will see
```

---

## Critical Rules

| Rule | Description |
|------|-------------|
| **Drafts only** | Write only inside `flow/drafts/<canvas>/`. Never touch the project's real code, configuration or the discovery. |
| **Layout first** | Write `layout.json` before any screen, and write screens in the layout's order, so progress can be counted. |
| **Fits the window** | No frame wider than 1440. Options side by side wrap into rows; nothing sets `overflow: hidden` on `html` or `body`. |
| **Self-contained** | No network URLs, no external fonts. Images only as `data:` URIs or inline SVG. |
| **No emoji decoration** | An emoji appears only where the target app itself shows one. |
| **No ids by hand** | Never write `data-flow-id`; Flow adds them. |
| **Complete and Stop** | After the short report, STOP and wait for the user. |

---

## Instructions

Follow `.claude/resources/skills/ui-draft-skill.md`. In short:

1. Read the input: a discovery (`@path`) or free text.
2. Read the target project's tokens and a few existing screens, within the
   skill's file budget.
3. Choose the canvas slug, write `layout.json`, then `tokens.css`, then each
   screen in layout order.
4. Check the screens, then report in two or three short sentences.

Write the chat summary in short, clear sentences (ASD-STE100 style); say it once.
Do not print file paths or commands in the summary: the card and the browser are
the door to the canvas.
