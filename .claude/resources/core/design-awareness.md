
# Design Awareness

## Purpose

Makes plan-flow design-aware by capturing design context during `/discovery-plan` and injecting it into UI phases during `/execute-plan`. When a feature involves UI work, the discovery document is extended with a **Design Context** section containing structured design tokens (colors, typography, spacing, component patterns). During execution, those tokens are automatically prepended to UI phase prompts so implementations are consistent with the project's visual design.

**Scope**: `/discovery-plan` (capture), `/artifact` (the artifact page's mockups) and `/execute-plan` (injection). Other skills are not affected.

**Plugin integration**: If `.interface-design/system.md` exists in the project root, offer to use the plugin's design system as the token source. If absent, use the built-in personality picker and token extraction described here — do NOT suggest installing the plugin.

---

## Design Context Section Template

When UI work is detected during discovery, append the following section to the discovery document after all other sections:

```markdown
## Design Context

### Design Personality
{personality name} — {brief description}

### Color Palette
| Token | Value | Usage |
|-------|-------|-------|
| Primary | #XXXXXX | Main actions, CTAs |
| Secondary | #XXXXXX | Supporting elements |
| Background | #XXXXXX | Page/card backgrounds |
| Surface | #XXXXXX | Elevated surfaces |
| Text Primary | #XXXXXX | Main body text |
| Text Secondary | #XXXXXX | Secondary/muted text |
| Error | #XXXXXX | Error states |
| Success | #XXXXXX | Success states |

### Typography
| Element | Font | Size | Weight |
|---------|------|------|--------|
| Heading 1 | {font} | {size} | {weight} |
| Heading 2 | {font} | {size} | {weight} |
| Body | {font} | {size} | {weight} |
| Caption | {font} | {size} | {weight} |

### Spacing Scale
| Token | Value |
|-------|-------|
| xs | {value} |
| sm | {value} |
| md | {value} |
| lg | {value} |
| xl | {value} |

### Component Patterns
- {Pattern 1}: {description}
- {Pattern 2}: {description}

### Design Source
- **Source**: {screenshots / Figma export / design personality / existing system.md}
- **Files**: {list of provided design files, if any}
```

**Filling in the template**: Use the Token Extraction Rules (Section 4) when the source is screenshots. Use the Design Personalities (Section 3) when no existing design is provided. Use the plugin's `system.md` when the Interface Design plugin is detected.

---

## Design Personalities

Six built-in personalities cover the most common UI directions. Each provides default token values to seed the Design Context template when no existing design is available.

---

### 1. Stark

**Character**: Clean, minimal, high-contrast. Think Apple / Stripe. Monochrome palette with a single accent color. Generous whitespace, sharp edges (0–4px radius), system fonts.

| Token | Default Value |
|-------|--------------|
| Primary | #0066FF |
| Secondary | #666666 |
| Background | #FFFFFF |
| Surface | #F5F5F5 |
| Text Primary | #111111 |
| Text Secondary | #666666 |
| Error | #FF3B30 |
| Success | #34C759 |

**Typography**: System UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI"`) — Heading 1: 32px/700, Heading 2: 24px/600, Body: 16px/400, Caption: 12px/400.

**Spacing**: xs=4px, sm=8px, md=16px, lg=32px, xl=64px.

---

### 2. Aura

**Character**: Warm, organic, approachable. Think Notion / Linear. Soft shadows, rounded corners (8–12px), warm neutrals, friendly sans-serif fonts.

| Token | Default Value |
|-------|--------------|
| Primary | #5B6AF0 |
| Secondary | #B8BAC8 |
| Background | #FAFAF8 |
| Surface | #FFFFFF |
| Text Primary | #1A1A2E |
| Text Secondary | #6B7280 |
| Error | #EF4444 |
| Success | #10B981 |

**Typography**: Inter — Heading 1: 30px/700, Heading 2: 22px/600, Body: 15px/400, Caption: 13px/400. Line-height 1.6 on body.

**Spacing**: xs=4px, sm=8px, md=16px, lg=24px, xl=48px.

---

### 3. Neo

**Character**: Bold, vibrant, modern. Think Vercel / Figma. Dark backgrounds, saturated accent colors, geometric shapes, tight spacing.

| Token | Default Value |
|-------|--------------|
| Primary | #7C3AED |
| Secondary | #06B6D4 |
| Background | #0A0A0A |
| Surface | #18181B |
| Text Primary | #FAFAFA |
| Text Secondary | #A1A1AA |
| Error | #F87171 |
| Success | #4ADE80 |

**Typography**: Inter or Geist — Heading 1: 36px/800, Heading 2: 24px/700, Body: 14px/400, Caption: 12px/400. Tight tracking on headings (−0.02em).

**Spacing**: xs=2px, sm=6px, md=12px, lg=24px, xl=48px.

---

### 4. Zen

**Character**: Calm, balanced, content-first. Think Medium / iA Writer. Neutral palette, serif for headings, generous line-height, minimal decoration.

| Token | Default Value |
|-------|--------------|
| Primary | #2563EB |
| Secondary | #9CA3AF |
| Background | #FFFFFF |
| Surface | #F9FAFB |
| Text Primary | #111827 |
| Text Secondary | #6B7280 |
| Error | #DC2626 |
| Success | #16A34A |

**Typography**: Headings in Georgia or Lora (serif), body in `ui-sans-serif` — Heading 1: 34px/700, Heading 2: 26px/600, Body: 18px/400, Caption: 14px/400. Line-height 1.75 on body.

**Spacing**: xs=4px, sm=8px, md=20px, lg=40px, xl=80px.

---

### 5. Flux

**Character**: Dynamic, playful, expressive. Think Spotify / Discord. Gradients, bold typography, dark mode by default, vibrant accent pops.

| Token | Default Value |
|-------|--------------|
| Primary | #FF6B6B |
| Secondary | #4ECDC4 |
| Background | #1A1A2E |
| Surface | #16213E |
| Text Primary | #EAEAEA |
| Text Secondary | #A8A8B3 |
| Error | #FF6B6B |
| Success | #4ECDC4 |

**Typography**: Plus Jakarta Sans or Nunito — Heading 1: 40px/800, Heading 2: 28px/700, Body: 16px/400, Caption: 13px/400. Tracking: 0.01em on headings.

**Spacing**: xs=4px, sm=8px, md=16px, lg=32px, xl=64px.

---

### 6. Terra

**Character**: Grounded, professional, trustworthy. Think GitHub / Basecamp. Muted earth tones, clear hierarchy, functional over decorative.

| Token | Default Value |
|-------|--------------|
| Primary | #347D39 |
| Secondary | #6E7781 |
| Background | #FFFFFF |
| Surface | #F6F8FA |
| Text Primary | #24292F |
| Text Secondary | #57606A |
| Error | #CF222E |
| Success | #2DA44E |

**Typography**: `-apple-system` or Roboto — Heading 1: 28px/600, Heading 2: 20px/600, Body: 14px/400, Caption: 12px/400. Line-height 1.5 on body.

**Spacing**: xs=4px, sm=8px, md=16px, lg=24px, xl=40px.

---

## Token Extraction Rules

When the user provides screenshots, Figma exports, or any visual design artifact, extract structured tokens using the following process:

### Color Extraction

1. **Primary**: The most prominent interactive color — buttons, links, active states
2. **Secondary**: Supporting color — secondary buttons, tags, less prominent accents
3. **Background**: The base page/app background (typically the largest area)
4. **Surface**: Elevated elements — cards, modals, sidebars (often slightly different from Background)
5. **Text Primary**: The main body text color
6. **Text Secondary**: Muted/caption text color
7. **Error**: Red-family color used in error messages or destructive actions
8. **Success**: Green-family color used in confirmations or success states

**Confidence notes**: When a value is estimated (not pixel-sampled), append `*` to the hex value and add a note: `*estimated from screenshot`.

### Typography Extraction

1. Identify visible font families (check for recognizable typefaces — Inter, Roboto, SF Pro, etc.)
2. If the font cannot be identified with confidence, describe the style: `"clean sans-serif (likely Inter or similar)"`
3. Estimate size in px based on visual hierarchy (H1 typically 28–40px, Body 14–18px)
4. Identify weight from stroke thickness (400=regular, 600=semibold, 700=bold, 800=extrabold)

### Spacing Extraction

1. Estimate the base grid unit from gaps between elements (4px, 8px, or 12px are most common)
2. Describe density: tight (base=4px), normal (base=8px), generous (base=16px)
3. Map to scale: `xs = 1×base`, `sm = 2×base`, `md = 4×base`, `lg = 8×base`, `xl = 16×base`

### Component Pattern Extraction

Identify recurring visual patterns present in the design:
- Card style (flat, elevated, bordered, ghost)
- Button style (rounded/pill, sharp, outlined, filled)
- Input style (underline, outlined, filled)
- Navigation style (top bar, sidebar, bottom tabs)
- Data presentation (tables, list rows, tiles, kanban)

### Output Format

Always output extracted tokens using the **Design Context Section Template** (Section 2). Never output raw color lists without the table structure. Add a confidence note at the end of the Design Context block when values are estimated:

```markdown
> **Note**: Token values marked `*` are estimated from visual inspection of screenshots, not pixel-sampled. Adjust to match your exact design specs.
```

---

## UI Phase Detection Heuristics

Used by `/execute-plan` to determine whether to inject Design Context into a phase prompt.

### Phase Name Keywords

A phase involves UI work if its name contains any of:

`component`, `page`, `UI`, `layout`, `form`, `modal`, `dialog`, `sidebar`, `navigation`, `header`, `footer`, `dashboard`, `widget`, `view`, `screen`, `frontend`, `interface`, `button`, `card`, `table`, `list`, `menu`, `panel`, `toolbar`, `tooltip`, `popup`, `dropdown`, `tab`, `accordion`, `carousel`, `toast`, `notification`, `badge`, `avatar`, `icon`

### Task Description Keywords

A phase involves UI work if any task description contains any of:

`create component`, `build page`, `implement view`, `style`, `CSS`, `responsive`, `layout`, `render`, `display`, `user interface`

### Injection Rule

> If ANY keyword appears in the phase name **OR** ANY task description within the phase, inject the Design Context. If neither condition matches, skip injection — no overhead, no noise.

Matching is case-insensitive.

---

## Discovery Question Flow

Add design awareness questions to the standard discovery question sequence. Ask **Question 1** for every feature; only ask subsequent questions if the answer indicates UI work.

### Question 1 — UI Detection (always ask)

> "Does this feature involve any UI or visual interface work?"

| Option | Value |
|--------|-------|
| Yes — has UI components *(Recommended if unclear)* | → proceed to Question Batch 2 |
| No — backend/infrastructure only | → skip design questions entirely |
| Partially — minor UI changes | → proceed to Question Batch 2 |

---

### Question Batch 2 — Design Source (ask when Q1 = Yes or Partially)

Ask these questions together or in sequence as appropriate for the tool:

**Q2a — Existing design?**

> "Do you have an existing design to follow?"

| Option | Next Step |
|--------|-----------|
| Yes — I have screenshots/mockups *(Recommended)* | Ask user to share files; use Token Extraction Rules |
| Yes — existing design system in project | Read project design files (e.g., `tokens.ts`, `theme.ts`, `system.md`); extract tokens |
| No — need to establish design direction | Ask Q2b (personality picker) |

---

**Q2b — Design personality** (only when no existing design)

> "What design personality fits this feature?"

| Option | Personality |
|--------|------------|
| Stark — Clean & minimal *(Recommended)* | Section 3.1 defaults |
| Aura — Warm & approachable | Section 3.2 defaults |
| Neo — Bold & modern | Section 3.3 defaults |
| Zen — Calm & content-first | Section 3.4 defaults |
| Other (Flux / Terra / describe your own) | Section 3.5–3.6 defaults, or prompt for description |

---

**Q2c — Primary layout pattern** (always ask when Q1 = Yes or Partially)

> "What's the primary layout pattern for this feature?"

| Option | Component Patterns hint |
|--------|------------------------|
| Dashboard with cards/panels *(Recommended)* | Cards (elevated), stat widgets, grid layout |
| Content page with sidebar | Sidebar nav, content area, breadcrumbs |
| Form-heavy workflow | Input fields, validation states, multi-step |
| Data table/list view | Table rows, sort/filter controls, pagination |

---

### After Gathering Answers

1. **Screenshots provided**: Run Token Extraction (Section 4) → populate Design Context template → append to discovery doc
2. **Personality selected**: Use personality defaults (Section 3) as starting values → populate Design Context template → append to discovery doc
3. **Existing design system found**: Parse project design files → map to Design Context tokens → append to discovery doc
4. **Plugin detected** (`.interface-design/system.md` exists): Offer to use it as source; if accepted, read and map to Design Context template
5. The artifact page, when someone generates it later with `/artifact`, is styled from it — see the next section.

---

## Walkthrough Page Mockups

The Design Context has a consumer beside discovery: the **user walkthrough
page** — the discovery's **artifact** in the app — written on request beside the
document (`<discovery basename>.walkthrough.html`, `/artifact`,
`.claude/resources/skills/artifact-skill.md`). It is the
first consumer that turns the tokens into something a person looks at — before
it, the tokens only ever reached a model, as text injected into
`/execute-plan` phase prompts. The page walks through what users will see, step
by step, with a mockup of each screen, and when the discovery has a Design
Context the whole page is styled from it:

| Rule | Why |
|------|-----|
| One shared inline `<style>` block for the page, derived from the palette, typography, spacing and component patterns above, used by every mockup | Every step then looks like the same product, and a reviewer judging the feature is not distracted by drift between screens |
| The page looks like the **target app**, never like Flow | The walkthrough answers "is this what our users should see?" — a screen in Flow's colours answers a different question. Flow's own chrome (a slim header above the page) already marks the boundary |
| No external fonts, images or URLs; system font stacks and inline SVG/CSS shapes instead | The page runs in a sandbox whose policy blocks every network request — anything fetched simply does not load |
| No emoji as decoration — only where the target app itself would show one | Emoji standing in for icons, labels or badges read as generated filler, not as a product (discovery C-5 of `discovery_feature-view_v1.md`) |

A discovery with no Design Context can still have its artifact generated; its
look then comes from the target app's own code (its theme, tokens and components).

---

## Execution Injection Rules

How `/execute-plan` uses the Design Context section from a discovery document.

### Step-by-Step Injection

At each phase boundary (Step 4 of the execute-plan skill):

1. **Locate the discovery doc**: Read the plan's "Based on Discovery" field to find the discovery document path
2. **Check for Design Context**: Scan the discovery doc for a `## Design Context` section
3. **Check phase relevance**: Apply UI Phase Detection Heuristics (Section 5) to the current phase name and task list
4. **Inject if both conditions met**:
   - Prepend the full `## Design Context` section content to the phase implementation prompt
   - Add the following instruction header before the Design Context block:

     ```
     ## Design Tokens (apply to all UI in this phase)

     Follow these design tokens when implementing UI elements.
     Use the exact color values, typography, and spacing from the Design Context.
     Do not introduce colors, fonts, or spacing values outside this system.
     ```
   - Add to the phase Rules Checklist: `- [ ] Following design tokens from Design Context`

5. **Skip if phase is not UI-related**: If heuristics return no match, do not inject Design Context. No message, no overhead.
6. **Skip if no Design Context exists**: If the discovery doc has no `## Design Context` section, proceed normally without injection.

### Injection Position in Phase Prompt

```
[Design Tokens block — if UI phase]
[Phase title and objective]
[Tasks list]
[Files to create/modify]
[Rules checklist]
[Context from previous phases]
```

The Design Tokens block comes first so the model internalizes constraints before reading the task list.

---

## Plugin Detection and Fallback

| Condition | Behavior |
|-----------|----------|
| `.interface-design/system.md` **found** in project root | Offer it as a token source option during Q2a. If accepted, read the file and map its tokens to the Design Context template. |
| `.interface-design/system.md` **not found** | Use built-in design awareness (personality picker + token extraction). Do NOT suggest installing the plugin. |

The built-in fallback produces the same `## Design Context` template structure as the plugin path. The plugin adds richer tooling and persistent design files; the built-in path is sufficient for feature-level design awareness.

---

## Related Files

| File | Purpose |
|------|---------|
| `.claude/resources/skills/discovery-skill.md` | Discovery workflow where design questions are asked |
| `.claude/resources/skills/execute-plan-skill.md` | Phase execution workflow where injection happens |
| `.claude/resources/core/complexity-scoring.md` | Phase complexity model referenced by execute-plan |
| `.claude/commands/discovery-plan.md` | Discovery command definition |
| `.claude/resources/skills/artifact-skill.md` | The artifact (user walkthrough page) the mockups live in |
| `.claude/commands/execute-plan.md` | Execute-plan command definition |
