# UI Draft Skill

## Purpose

Write **UI drafts**: look-alike screens of the target app, as plain files in a
canvas folder:

```
flow/drafts/<canvas>/layout.json     screens, order, frames, titles, token sources
flow/drafts/<canvas>/tokens.css      the shared tokens stylesheet
flow/drafts/<canvas>/<screen>.html   one plain HTML file per screen
```

Flow serves the canvas in its built-in browser, stamps a stable `data-flow-id`
on every element of every screen, and opens the canvas once when it is
complete. The skill needs no Flow tools: it runs on Claude, Codex and Copilot
with ordinary file tools.

It is asked for in two ways, with the same result: the DISCOVERY card's
**Generate UI drafts** button (sends `/ui-draft @<discovery path>`), or any
request in any chat ("draft the settings screen").

This skill writes only inside `flow/drafts/<canvas>/`. It does NOT write or
change source code, configuration or the discovery document.

---

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `discovery_doc` | One of the two | Path to a discovery markdown, usually as an `@` reference |
| free text | One of the two | The screens a person asks for |

If the input is a path that does not exist, stop and say so. With no input,
ask what to draft. Do not invent a discovery.

---

## Workflow

### Step 1: Choose the canvas and the screens

**Canvas slug**: lowercase letters, digits and dashes, starting with a letter or
digit (`[a-z0-9][a-z0-9-]*`), at most 64 characters.

- From a discovery: the discovery's feature slug, which is the `<feature>` of
  `discovery_<feature>_v<N>.md` (drop the `_v<N>`; lowercase it and turn any
  other character into a dash). The DISCOVERY card finds its canvas by this
  slug, so use exactly this one.
- From free text: a short slug of the request ("settings-billing").

If `flow/drafts/<slug>/` already exists, draft into it again: keep screens that
still apply, rewrite the ones asked for.

**Screens**:

- From a discovery: one screen per step of its user flow, in the flow's order.
  Read the discovery's `## Design Context` and Codebase Analysis too.
- From free text: the screens the person asked for, and no more.

Each screen has a slug (same rule as the canvas slug) and a title for people.

### Step 2: Read the target project, within a budget

Read only what you need to match the look. **Read at most 15 files** in total,
and stop early when the look is clear. In this order of value:

1. Token sources: CSS custom properties (`:root`, theme files), Tailwind config,
   design-token files, a theme module.
2. Two to four existing screens or pages most like the ones asked for.
3. Two to four shared components the screens use (button, input, card, nav).

Note each file you read. The `tokenSources` list in `layout.json` names the
token files (repo-relative paths), and your report names what you read.

If the project has no visible UI code, use the discovery's Design Context; with
none, use neutral, restrained tokens and say so in the report.

### Step 3: Write `layout.json` FIRST

Write the layout before any screen. The card counts screens named here that
exist as files, so this file is what makes progress visible.

```json
{
  "name": "Account settings",
  "tokenSources": ["src/styles/theme.css", "tailwind.config.ts"],
  "screens": [
    {
      "id": "settings-home",
      "file": "settings-home.html",
      "title": "Settings",
      "order": 0,
      "frame": { "x": 0, "y": 0, "w": 390, "h": 844 }
    },
    {
      "id": "settings-billing",
      "file": "settings-billing.html",
      "title": "Billing",
      "order": 1,
      "frame": { "x": 470, "y": 0, "w": 390, "h": 844 }
    }
  ]
}
```

Rules the layout reader enforces:

- The top level is an object with a `screens` array (required). `name` and
  `tokenSources` are optional.
- Each screen has an `id` that is a slug (a `file`, when given, is exactly
  `<id>.html`). No `id` may appear twice.
- `title`, `order` and `frame` are optional: a missing title is the id, a
  missing order is the screen's position, a missing frame is placed in a row
  (390 by 844, 80 apart). Give frames anyway; use a width near the target
  (390 phone, 1280 desktop) and the height of one screen. Leave 80 canvas
  pixels between frames in a row.
- **No frame wider than 1440.** A screen is one window of the app, not a
  poster. Eight options side by side are not one 2,700-pixel screen: split them
  over several screens (four per screen), or let one screen wrap them into rows
  (see Step 5).
- Order the `screens` array in the flow's order. Write the screen files in
  that same order.

### Step 4: Write `tokens.css`

One stylesheet of CSS custom properties taken from the project's real tokens:
colours, type (families and scale), spacing, radii, shadows. Use the project's
own names where they exist. Add the base rules every screen shares (body
background and text colour, font family, a reset). Do not use `@import` or
`url(...)` to a network address.

**Pick, never copy.** Take the values you need; do not paste the project's
global stylesheet. An app's globals carry its shell rules, and on a draft they
cut the screen off. `html` and `body` get only background, colour, font and
`margin: 0` — never `overflow`, `white-space: nowrap`, a fixed `height`, or a
flex/grid layout. Component rules go under classes, and the whole file stays
small (a few hundred lines, not tens of kilobytes).

### Step 5: Write the screens, in layout order

One file per screen: `flow/drafts/<canvas>/<id>.html`. Write them one after the
other in the layout's order; do not write them all at the end in one step.

Rules for every screen:

- Plain HTML. Link the shared stylesheet relatively:
  `<link rel="stylesheet" href="tokens.css">`.
- Inline `<style>` and inline `<script>` only, and a script only when the
  screen needs one (a tab switch, a toggle). No other files.
- **No network.** No `http://` or `https://` in `src`, `href`, `@import` or
  `url(...)`. No external fonts: use the project's font stack from the tokens.
  Images only as `data:` URIs or inline SVG.
- **No emoji decoration.** Show an emoji only where the target app itself would.
  Use inline SVG for icons.
- Do not write `data-flow-id`. Flow adds those after you write the file.
- Look like the target app: its components, spacing and copy style. Plausible
  sample content, not "Lorem ipsum".
- Each screen stands alone and fits its frame (`w` by `h`); let long content
  scroll inside it.
- **Nothing wider than the frame.** No fixed column count whose columns add up
  past the frame (`repeat(8, 300px)` is 2,600 pixels). A screen that compares
  options lays them out to wrap:
  `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`, or flex with
  `flex-wrap: wrap`. No `min-width` on the page wider than the frame.
- Never `overflow: hidden` on `html` or `body`. Scroll inside a pane when the
  app does, never by cutting the page off.
- Never edit the project's real code to make a draft work.

### Step 6: Check

Run these yourself. Fix a screen and re-run until each holds.

```bash
ls flow/drafts/<canvas>                                                  # layout.json, tokens.css and every screen listed
grep -nE "(src|href)=\"https?://|url\(['\"]?https?:|@import" flow/drafts/<canvas>/*.html flow/drafts/<canvas>/tokens.css   # must print nothing
grep -l "data-flow-id" flow/drafts/<canvas>/*.html                       # must print nothing
grep -nE "repeat\(([5-9]|[1-9][0-9]+), *[0-9]+px" flow/drafts/<canvas>/*.html flow/drafts/<canvas>/tokens.css   # must print nothing: wrap instead
node -e 'const fs=require("fs");for(const f of process.argv.slice(1)){const t=fs.readFileSync(f,"utf8");for(const m of t.matchAll(/(?:^|[};\s])((?:html|body)(?:\s*,\s*(?:html|body))*)\s*\{([^}]*)\}/g))if(/overflow|nowrap/.test(m[2]))console.log(f+": "+m[1].replace(/\s+/g," "))}' flow/drafts/<canvas>/*.html flow/drafts/<canvas>/tokens.css   # must print nothing
node -e 'const l=require("./flow/drafts/<canvas>/layout.json");for(const s of l.screens)if((s.frame?.w??390)>1440)console.log(s.id)'   # must print nothing
wc -c flow/drafts/<canvas>/tokens.css                                    # well under 20000
```

Check that the layout is valid JSON and that every screen it names exists.

### Step 7: Report

Two or three short sentences: the canvas has been written, how many screens,
what the look was taken from (the files you read, by name), and anything that
you had to guess. Do not print commands. Complete and stop.

---

## How Flow finds the canvas

- The DISCOVERY card shows **Generate UI drafts** until a canvas with the
  discovery's feature slug exists. While the layout exists and screens are
  missing (and a file changed in the last 10 minutes) it shows "Writing UI
  drafts… N of M screens". When every screen exists it shows **Open UI drafts**.
- When the canvas is complete, Flow opens it in the built-in browser once.
