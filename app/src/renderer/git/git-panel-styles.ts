/**
 * The Source Control panel's stylesheet — pure, DOM-free, so the layout rules
 * that matter can be asserted without a renderer (git-panel-styles.test.ts).
 *
 * The row-content classes (.gp-row, .gp-letter, .gp-action-btn, …) style elements
 * rendered by <fl-list>, which lives in a shadow DOM — document.head rules can't
 * reach it. The same sheet is therefore also injected into each list's shadowRoot
 * (createList in git-panel.ts). Light-DOM-only rules (commit box, headers) simply
 * don't match there.
 *
 * ROW_HEIGHT lives here because it is shared by both sides of one invariant: the
 * virtual list positions rows by it, and these rules must keep row content inside
 * it (#1489).
 *
 * NO BACKTICKS IN GP_STYLES, comments included. It is a template literal, and
 * one backtick closes it — the failure surfaces as a TypeScript error about a
 * property that does not exist on a string, several lines away from the quote
 * that caused it.
 */

/** Height of a single Source Control row, in px. */
export const ROW_HEIGHT = 28

/**
 * Height of a CONFLICTED file's row — two lines: the filename, then the risk and
 * the two side buttons under it.
 *
 * Crammed onto one line, the branch pills sat against the filename and were
 * unreadable in a narrow sidebar; worse, a click aimed at the file landed on a
 * pill and resolved the conflict. The extra line is bought here, from the list,
 * because a row cannot grow itself (#1489) — CSS wrapping would slice it.
 */
export const CONFLICT_ROW_HEIGHT = 50

/**
 * The inline width below which the merge section stops trying to show a word
 * beside every glyph, in px.
 *
 * The Source Control panel is a drag-resizable sidebar, so "how wide is it" is
 * a runtime fact and not a breakpoint of the window. This is therefore a
 * CONTAINER width: `.gp-merge-section` declares itself a query container and
 * the rules below ask it, not the viewport — a panel dragged narrow inside a
 * wide window is exactly the case that produced the clipped labels.
 *
 * 360 is where the widest row still fits at rest: an 18px indent, the risk
 * badge, and two icon+word controls. Under it the words move to `title` and the
 * glyphs stand alone, which loses no information and cannot clip.
 */
export const GP_NARROW_PANEL_PX = 360

export const GP_STYLES = `
    .gp-root {
      display: flex;
      flex-direction: column;
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
    }
    /*
     * PANEL RHYTHM. Everything in here used to start at the pane's own edge —
     * headers, section seams and the list's rows all put their TEXT 8px from a
     * 316px pane, which reads as a stack of full-bleed strips rather than a
     * column of content. Every block that carries text is inset 12px now.
     *
     * The blocks themselves stay full width on purpose: a row's hover highlight
     * should reach the pane's edges, the way it does in every file tree — it is
     * the TEXT that wants a margin, not the target.
     */
    .gp-root { padding-bottom: var(--fl-space-sm); }
    .gp-section { padding-bottom: var(--fl-space-sm); }
    /* A region seam between two sections of one panel — the separator token is
       darker than the ground, so it reads as a break rather than a rule drawn
       across the content. Inset from both edges so it stops where the content
       does instead of cutting the panel in half. */
    .gp-section + .gp-section {
      border-top: var(--fl-border-width) solid var(--fl-color-separator);
      margin-top: var(--fl-space-xs);
    }
    /*
     * SCROLLBARS. The panel's scrollers wore the platform default: a square,
     * full-contrast bar against a panel where nothing else has a hard edge. A
     * thin rounded track that only shows its thumb keeps the eye on the list.
     */
    .gp-root,
    .gp-root fl-list,
    .fl-sc-view {
      scrollbar-width: thin;
      scrollbar-color: var(--fl-color-surface-raised) transparent;
    }
    .gp-root::-webkit-scrollbar,
    .fl-sc-view::-webkit-scrollbar { width: 10px; height: 10px; }
    .gp-root::-webkit-scrollbar-track,
    .fl-sc-view::-webkit-scrollbar-track { background: transparent; }
    .gp-root::-webkit-scrollbar-thumb,
    .fl-sc-view::-webkit-scrollbar-thumb {
      background: var(--fl-color-surface-raised);
      border: 3px solid transparent;
      background-clip: content-box;
      border-radius: 999px;
    }
    .gp-root::-webkit-scrollbar-thumb:hover,
    .fl-sc-view::-webkit-scrollbar-thumb:hover { background: var(--fl-color-text-secondary); background-clip: content-box; }
    .gp-root::-webkit-scrollbar-corner,
    .fl-sc-view::-webkit-scrollbar-corner { background: transparent; }
    /*
     * ROWS, INSET AND ROUNDED. This sheet is injected into each list's shadow
     * root (see the module header), which is the only way to reach a .row at
     * all — fl-list's own rule pads it 8px, square-cornered. The inset lines the
     * rows up with the commit box above them, and the radius stops a hover from
     * painting a hard-edged band across the panel.
     */
    .row { padding: 0 var(--fl-space-md) !important; border-radius: var(--fl-radius-md); }
    .gp-commit-box {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-sm) var(--fl-space-md);
    }
    /* A FILLED field, like the thread search box and the composer: on this
       ground a raised fill says "you can type here" on its own, and the ring
       then has a state to express instead of just recolouring a line. */
    .gp-commit-msg,
    .gp-landing-msg {
      resize: vertical;
      min-height: 2.4em;
      padding: var(--fl-space-xs) var(--fl-space-sm);
      background: var(--fl-color-surface-raised);
      border: none;
      border-radius: var(--fl-radius-md);
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
    }
    /* A ring outside the box model, so focusing cannot resize the field. */
    .gp-commit-msg:focus,
    .gp-landing-msg:focus {
      outline: none;
      box-shadow: 0 0 0 1px var(--fl-color-focus-ring);
    }
    /* Why the Commit button is off (a disabled button's title never shows). */
    .gp-commit-hint {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      padding: 2px 0 0;
      user-select: none;
    }
    .gp-commit-hint[hidden] { display: none; }
    .gp-commit-actions { display: flex; gap: var(--fl-space-xs); }
    .gp-commit-btn {
      flex: 1;
      height: 26px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-accent);
      color: var(--fl-color-on-accent, #fff);
      font-size: var(--fl-text-ui-size);
      cursor: pointer;
    }
    .gp-commit-btn:disabled { opacity: 0.5; cursor: default; background: var(--fl-color-surface); color: var(--fl-color-text-secondary); }
    .gp-commit-generate {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 26px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      color: var(--fl-color-text-secondary);
      cursor: pointer;
    }
    .gp-commit-generate:hover:not(:disabled) { color: var(--fl-color-accent); border-color: var(--fl-color-accent); }
    .gp-commit-generate:disabled { opacity: 0.5; cursor: default; }
    /* Repo group header (multi-project threads Phase 4): 3px left accent
       border + name + branch, collapsible. Only rendered when the scope spans
       >1 root. The border color is set inline per group (project accent). */
    /* WHERE ONE PROJECT ENDS.
       Three attempts, and the third is the one on screen.
       (1) 8px of margin and a hairline on the group that STARTS. Read on a real
       four-repo thread it separated nothing: the rule sat directly under the
       previous group's last row ("COMMITS · LATEST 100") and was read as part
       of that row.
       (2) A BAND — each project its own filled surface, closed top and bottom,
       with --fl-space-lg between them. It separated, and it turned a panel
       that is mostly lists into a stack of boxes. The user's words on reading
       it: "don't need all those blocks and everything, let me more clean".
       (3) A RULE ABOVE THE HEADER THAT STARTS A PROJECT, and space under the
       one that ends it. No fill, no second edge, nothing enclosed — the same
       treatment the thread sidebar arrived at, which is the surface the user
       pointed to as the one that reads right.
       The rule is full-bleed and the header keeps its 3px accent stripe: the
       stripe says WHICH project, the rule says a new one starts here, and they
       are not competing to say the same thing.
       ONLY when headers render. A single-repo panel is chrome-free by rule and
       has no neighbour to be separated from — :first-child carries no rule
       for the same reason the sidebar's first project does not: a line under
       the panel's own top edge divides nothing from nothing. */
    .gp-group-boxed { padding-bottom: var(--fl-space-md); }
    .gp-group-boxed + .gp-group-boxed {
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      padding-top: var(--fl-space-xs);
    }
    .gp-group-head {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      height: ${ROW_HEIGHT}px;
      padding: 0 var(--fl-space-sm);
      padding-left: calc(var(--fl-space-sm) - 3px);
      border-left: 3px solid transparent;
      cursor: pointer;
      user-select: none;
    }
    /* Hover is the only fill this header carries now — at rest it sits on the
       panel's own ground like every row under it. */
    .gp-group-head:hover { background: var(--fl-color-surface-raised, var(--fl-color-surface)); }
    .gp-group-name {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .gp-group-tag {
      flex: none;
      padding: 0 5px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: 999px;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      line-height: 1.5;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .gp-group-unavailable { color: var(--fl-color-warning); border-color: var(--fl-color-warning); }
    .gp-group-branch-icon { flex: none; margin-left: auto; display: inline-flex; color: var(--fl-color-text-secondary); }
    .gp-group-branch {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .gp-branch {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      height: ${ROW_HEIGHT}px;
      padding: 0 var(--fl-space-md);
      user-select: none;
    }
    .gp-branch-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: var(--fl-text-ui-weight-medium);
    }
    /* Rename, on the line that names the branch. Idle it is a pencil; editing,
       it is the field and its Done button, and the label steps aside.

       ALWAYS ON SCREEN, not hover-only. It shipped fully transparent until the
       row was hovered — quiet, and undiscoverable: the person who asked for
       the button reported there was no way to rename a branch, from a static
       screenshot of the line the button was sitting on. A control nobody can
       find is not a control. It is dimmed instead, and brightens on hover. */
    .gp-branch-edit {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    .gp-branch-edit[data-editing='true'] { flex: 1; }
    .gp-branch:has(.gp-branch-edit[data-editing='true']) .gp-branch-name { display: none; }
    .gp-branch-edit-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px;
      border: none;
      background: none;
      border-radius: var(--fl-radius-sm);
      color: var(--fl-color-text-secondary);
      cursor: pointer;
      opacity: 0.55;
      transition: opacity 90ms ease;
    }
    .gp-branch:hover .gp-branch-edit-btn,
    .gp-branch-edit-btn:hover,
    .gp-branch-edit-btn:focus-visible { opacity: 1; }
    .gp-branch-edit-btn:hover:not(:disabled) { color: var(--fl-color-accent); }
    .gp-branch-edit-btn:disabled { opacity: 0.35; cursor: default; }
    .gp-branch-edit-input {
      flex: 1;
      min-width: 0;
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text);
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-accent);
      border-radius: var(--fl-radius-sm);
      padding: 2px 6px;
    }
    .gp-branch-edit-done {
      flex: none;
      padding: 2px 10px;
      border-radius: var(--fl-radius-sm);
      border: 1px solid var(--fl-color-accent);
      background: var(--fl-color-accent);
      color: #fff;
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .gp-ahead-behind {
      flex: none;
      color: var(--fl-color-accent);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
    }
    .gp-dirty {
      flex: none;
      margin-left: auto;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .gp-dirty-active { color: var(--fl-color-warning); }
    .gp-subheader {
      padding: var(--fl-space-sm) var(--fl-space-md) var(--fl-space-xs);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      font-weight: var(--fl-text-ui-weight-medium);
      letter-spacing: 0.06em;
      text-transform: uppercase;
      user-select: none;
    }
    /* #1359: the no-project state is a label PLUS a way out. */
    .gp-branch-detached { color: var(--fl-color-error); }
    .gp-no-project {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--fl-space-sm);
    }
    .gp-empty {
      padding: var(--fl-space-xs) var(--fl-space-sm);
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
      user-select: none;
    }
    .gp-error {
      color: var(--fl-color-error);
      /* Message over its Try-again button — the gp-no-project arrangement. */
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--fl-space-sm);
    }
    /* NEVER wrap: these rows are rendered by <fl-list>, which absolutely
       positions each one at index * rowHeight and clips it to that height. A
       second line is therefore unreachable by construction — it can only slice
       both lines through the middle (#1489, regression from #1137). Narrow
       panels stay usable by letting the row's TEXT shrink (see .gp-dir /
       .gp-name / .gp-subject below), which keeps the action cluster on the
       line instead of pushing it off the edge. */
    .gp-row {
      display: flex;
      flex-wrap: nowrap;
      align-items: center;
      gap: var(--fl-space-xs);
      flex: 1 1 auto;
      min-width: 0;
      cursor: pointer;
    }
    /* Expandable untracked-folder rows (#615): a chevron toggle + indented children. */
    .gp-chevron {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
      border-radius: var(--fl-radius-sm);
    }
    .gp-chevron:hover { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    .gp-row-child { padding-left: 18px; }
    /* Wrap so the bulk-action cluster (Keep all… / Resolve all with AI) drops below
       the title instead of overflowing a narrow panel and hiding its buttons. */
    .gp-section-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--fl-space-xs); }
    /* Collapsible section header (#693): a chevron+label the user clicks to fold. */
    .gp-section-toggle {
      flex: 1 1 auto;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: var(--fl-space-xs);
      cursor: pointer;
      border-radius: var(--fl-radius-sm);
    }
    .gp-section-toggle:hover { color: var(--fl-color-text); }
    .gp-section-chevron { flex: none; display: inline-flex; color: var(--fl-color-text-secondary); }
    /* Shrinkable + wrapping so on a narrow panel the buttons flow onto extra lines
       (all reachable) rather than clipping off the right edge. */
    .gp-bulk-actions { flex: 1 1 auto; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; }
    /* Header bulk buttons: icon + label pill. Approve all / Revert all stay
       visible (the primary section affordances) and brighten on hover. */
    .gp-bulk-btn {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 1px 6px;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
      font-size: var(--fl-text-caption-size);
      line-height: 1.4;
      opacity: 0.85;
    }
    .gp-bulk-btn:hover { opacity: 1; background: var(--fl-color-surface-raised, var(--fl-color-surface)); }
    .gp-bulk-label { white-space: nowrap; }
    .gp-bulk-approve:hover { color: var(--fl-color-success); }
    .gp-bulk-revert:hover { color: var(--fl-color-error); }
    /* Row action buttons: small square icon buttons pinned to the right edge,
       revealed on row hover. Neutral colour — the icon shape carries meaning, not
       hue (a red discard read as "weird"); tooltips convey stage/unstage/discard. */
    /* Same fixed-height constraint as .gp-row: a wrapped action cluster is clipped,
       not revealed (#1489). The conflict buttons stay reachable on a narrow panel
       because the filename ellipsizes ahead of them — the cluster itself never
       shrinks below its buttons. */
    .gp-row-actions { flex: none; margin-left: auto; display: flex; flex-wrap: nowrap; justify-content: flex-end; align-items: center; gap: 2px; padding-left: var(--fl-space-sm); }
    .gp-action-btn {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
    }
    /* #SCMS declutter: in the Changes/Staged sections the stage/discard icons rest
       HIDDEN and reveal on row hover (Cursor's minimalist look) — opacity-only, so
       the buttons keep their layout box and the row never shifts. Conflict rows are
       EXCLUDED: their "Open merge editor" icon is a bare .gp-action-btn and must
       stay visible at rest like the section's other merge controls (Resolve,
       Current/Incoming). Keyboard parity for both is preserved by :focus-visible. */
    .gp-row:not(.gp-row-conflict) .gp-action-btn { opacity: 0; }
    .gp-row-conflict .gp-action-btn { opacity: 0.6; }
    .gp-row:hover .gp-action-btn { opacity: 0.7; }
    .gp-action-btn:hover { opacity: 1; color: var(--fl-color-text); background: var(--fl-color-surface-raised, var(--fl-color-surface)); }
    /* Keyboard parity: a tabbed-to control must be as visible as a hovered
       one — the ghosted Stage/Discard buttons stayed at 45% for keyboard
       users. Keyed on the gp- classes (not a panel ancestor) because this
       sheet also lives inside each fl-list shadow root. Ring inset one pixel
       so the 28px hard-clipped rows never crop it. */
    .gp-action-btn:focus-visible, .gp-chevron:focus-visible {
      opacity: 1;
      color: var(--fl-color-text);
    }
    :where(.gp-action-btn, .gp-chevron, .gp-section-toggle, .gp-group-head):focus-visible {
      outline: 2px solid var(--fl-color-focus-ring, var(--fl-color-accent, #3794ff));
      outline-offset: -1px;
    }
    /* Discard is the row's one destructive action — its hover says so. */
    .gp-action-discard:hover { color: var(--fl-color-error); }
    /* "Resolve with AI" — a DIFFERENT KIND of action from the three deterministic
       choices below it: it delegates rather than decides, so it sits in the
       section header, apart from them, in the accent. It was painted in
       --fl-color-error, which is the app's word for "something went wrong" — a
       button offering to do the work read as a report that the work had failed. */
    .gp-action-resolve {
      width: auto;
      height: auto;
      padding: 1px 8px;
      opacity: 1;
      gap: 4px;
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-accent);
      border: var(--fl-border-width) solid color-mix(in srgb, var(--fl-color-accent) 42%, transparent);
      border-radius: var(--fl-radius-sm);
      background: color-mix(in srgb, var(--fl-color-accent) 10%, transparent);
      white-space: nowrap;
    }
    .gp-action-resolve:hover {
      color: var(--fl-color-accent);
      border-color: var(--fl-color-accent);
      background: color-mix(in srgb, var(--fl-color-accent) 20%, transparent);
      text-decoration: none;
    }
    /* #1134: running state — a spinner beside the label, and a Stop beside it.
       The busy button is inert, so no hover affordance. */
    .gp-resolve-busy { opacity: 0.85; cursor: default; }
    .gp-resolve-busy:hover { text-decoration: none; }
    .gp-resolve-spinner {
      display: inline-block;
      width: 9px;
      height: 9px;
      margin-right: 5px;
      vertical-align: -1px;
      border: 1.5px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: gp-resolve-spin 0.7s linear infinite;
    }
    @keyframes gp-resolve-spin { to { transform: rotate(360deg); } }
    /* Reduced motion: the indicator must still READ as running, so it pulses
       rather than spins — removing it entirely would restore the #1134 bug. */
    @media (prefers-reduced-motion: reduce) {
      .gp-resolve-spinner { animation: gp-resolve-pulse 1.2s ease-in-out infinite; }
      @keyframes gp-resolve-pulse { 50% { opacity: 0.25; } }
    }
    .gp-action-resolve-stop {
      width: auto;
      padding: 0 6px;
      opacity: 1;
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-error);
      border: 1px solid var(--fl-color-error);
      border-radius: 3px;
      margin-left: 4px;
    }
    .gp-action-resolve-stop:hover { background: color-mix(in srgb, var(--fl-color-error) 14%, transparent); }
    /* ── Merge section ───────────────────────────────────────────────────
       The whole conflict surface is one query CONTAINER, so every rule below
       asks the PANEL's width rather than the window's. The panel is dragged to
       any width the user likes; a viewport media query would have answered for
       a window that is usually three times wider than the sidebar in it. */
    .gp-merge-section {
      container-type: inline-size;
      container-name: gp-merge;
    }
    /* Legend + the three bulk choices, below the header and above the rows. */
    .gp-merge-toolbar {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      margin: 2px var(--fl-space-sm) var(--fl-space-xs);
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      min-width: 0;
    }
    /* THE ONLY PLACE A BRANCH NAME IS RENDERED. Two chips that share the width
       and ellipsize; the full name lives in each chip's title. */
    .gp-merge-legend {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px var(--fl-space-sm);
      min-width: 0;
    }
    /* flex-basis auto, not 0: shrinkage is weighted by base size, so "main"
       keeps all four of its letters and the 53-character branch beside it
       absorbs the entire deficit. Splitting the row evenly instead truncated
       the long name at 170px while "main" sat in 170px of empty chip. */
    .gp-legend-chip {
      flex: 0 1 auto;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: var(--fl-text-caption-size);
      line-height: 1.4;
    }
    .gp-legend-icon { flex: none; display: inline-flex; }
    .gp-legend-role {
      flex: none;
      color: var(--fl-color-text-secondary);
      letter-spacing: 0.02em;
    }
    /* The one string here that is allowed to get shorter — a legend that
       ellipsizes loses detail; a button that ellipsizes loses its verb. */
    .gp-legend-branch {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--fl-color-text);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .gp-legend-a .gp-legend-icon, .gp-legend-a .gp-legend-branch { color: var(--fl-color-conflict-side-a); }
    .gp-legend-b .gp-legend-icon, .gp-legend-b .gp-legend-branch { color: var(--fl-color-conflict-side-b); }
    /* The three choices WRAP onto a second row rather than overflow — their
       widths are fixed by their labels, so wrapping is the only thing that has
       to give on a narrow panel. */
    .gp-merge-bulk {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
      min-width: 0;
    }
    /* A bulk choice that LOOKS pressable: border, surface, padding, hover.
       Rendered before as bare text, it read as a wall of sentences with no
       control in it at all. */
    .gp-bulk-keepall {
      flex: 0 1 auto;
      min-width: 0;
      padding: 2px 8px;
      opacity: 1;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised, var(--fl-color-surface));
      color: var(--fl-color-text);
      white-space: nowrap;
    }
    .gp-bulk-keepall:hover {
      background: color-mix(in srgb, var(--fl-color-text) 8%, var(--fl-color-surface-raised, var(--fl-color-surface)));
      border-color: color-mix(in srgb, var(--fl-color-text) 30%, var(--fl-color-border));
    }
    .gp-bulk-keepall:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring, var(--fl-color-accent));
      outline-offset: 1px;
    }
    /* The glyph ties the button to its legend chip; the label never does. */
    .gp-bulk-keepall .gp-side-a { color: var(--fl-color-conflict-side-a); }
    .gp-bulk-keepall .gp-side-b { color: var(--fl-color-conflict-side-b); }
    .gp-bulk-keepall .gp-side-both { color: var(--fl-color-text-secondary); }
    /* A conflicted file is TWO lines: what it is, then what you can do about it.
       Side by side with the filename, the branch pills were unreadable in a
       narrow sidebar and were hit by clicks meant to open the diff. */
    .gp-row-stack {
      display: flex;
      flex-direction: column;
      justify-content: center;
      flex: 1 1 auto;
      min-width: 0;
      height: 100%;
    }
    .gp-row-stack .gp-row-conflict { height: ${ROW_HEIGHT}px; flex: none; }
    .gp-conflict-choice {
      display: flex;
      /* Never wrap: the line has a fixed height too. Buttons ellipsize instead
         (a long branch name shortens; it does not push the choice off-row). */
      flex-wrap: nowrap;
      align-items: center;
      gap: 4px;
      /* The fl-list row supplies the horizontal padding; this only indents the
         choice under the filename, past the status letter. */
      padding-left: 18px;
      padding-bottom: 2px;
      min-width: 0;
    }
    /* Per-side controls — a glyph, then a role word. The row must NOT restate
       the section's choice in a sentence: it said "Use <branch>" twice under
       three buttons that already said "Keep all from <branch>", so the same
       decision was written four times on one screen. */
    .gp-action-side {
      width: auto;
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      gap: 3px;
      white-space: nowrap;
      padding: 0 6px;
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-sm);
      opacity: 0.62;
      font-size: var(--fl-text-caption-size);
    }
    /* Dimmed at rest, full strength when the row is under the pointer or holds
       focus — the panel's existing reveal idiom, so the choice is discoverable
       without shouting over the filename above it. */
    .gp-row-stack:hover .gp-action-side,
    .gp-row-stack:focus-within .gp-action-side { opacity: 1; }
    .gp-action-side:hover {
      opacity: 1;
      color: var(--fl-color-text);
      border-color: var(--fl-color-border);
      background: var(--fl-color-surface-raised, var(--fl-color-surface));
    }
    .gp-action-side .gp-side-a { color: var(--fl-color-conflict-side-a); }
    .gp-action-side .gp-side-b { color: var(--fl-color-conflict-side-b); }
    /* Armed: previewed, and one press from being applied. It must not look like
       the button that was pressed a moment ago. */
    .gp-action-side-armed {
      opacity: 1;
      color: var(--fl-color-accent);
      border-color: var(--fl-color-accent);
      background: color-mix(in srgb, var(--fl-color-accent) 12%, transparent);
      font-weight: 600;
    }
    .gp-action-side-armed .gp-side-a, .gp-action-side-armed .gp-side-b { color: var(--fl-color-accent); }
    /* The role word. Bounded by design, so it is shown whole or not at all. */
    .gp-side-text { flex: none; white-space: nowrap; }
    /* Structural risk badge on a conflicted row. */
    .gp-risk-badge {
      flex: none;
      display: inline-flex;
      align-items: center;
      padding: 0 6px;
      height: 15px;
      border-radius: 999px;
      font-size: var(--fl-text-caption-size);
      line-height: 1;
      letter-spacing: 0.01em;
      border: var(--fl-border-width) solid transparent;
      white-space: nowrap;
    }
    /* On the choice line the badge yields before the buttons do: the words
       explain the choice, the buttons ARE it. It yields to its DOT, never to a
       half-word — "Separate ed" is what a text-overflow on a fact looks like. */
    .gp-conflict-choice .gp-risk-badge {
      flex: 0 1 auto;
      min-width: 0;
      gap: 4px;
      /* No pill here. Bordered, it was the loudest thing on the line — and it
         is the one element on it that cannot be pressed. */
      padding: 0 2px;
      border-color: transparent;
    }
    /* Colour is a second channel here, never the only one: the word beside it
       says the same thing, and the title says it in a sentence. */
    .gp-risk-dot {
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .gp-risk-text { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .gp-risk-safe { color: var(--fl-color-success); border-color: var(--fl-color-success); }
    .gp-risk-risky { color: var(--fl-color-warning); border-color: var(--fl-color-warning); }
    .gp-risk-pending { color: var(--fl-color-text-secondary); border-color: var(--fl-color-border); }
    /* "Auto-resolved ✓" pill — risk-badge geometry, success ink. It rendered
       as raw inline text inside the hard-clipped 28px row. */
    .gp-auto-resolved-badge {
      flex: none;
      display: inline-flex;
      align-items: center;
      padding: 0 6px;
      height: 15px;
      border-radius: 999px;
      font-size: var(--fl-text-caption-size);
      line-height: 1;
      letter-spacing: 0.04em;
      color: var(--fl-color-success);
      border: var(--fl-border-width) solid var(--fl-color-success);
    }
    /* Merge/rebase in-progress banner. */
    .gp-merge-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fl-space-xs);
      margin: var(--fl-space-xs) var(--fl-space-sm) 0;
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-warning);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
    }
    .gp-merge-banner-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      color: var(--fl-color-warning);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .gp-merge-banner-count {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    .gp-merge-banner-actions { margin-left: auto; display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); }
    .gp-merge-banner-btn {
      height: 22px;
      padding: 0 8px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .gp-merge-complete { background: var(--fl-color-accent); color: var(--fl-color-on-accent, #fff); border-color: transparent; }
    .gp-merge-complete:disabled { opacity: 0.5; cursor: default; background: var(--fl-color-surface); color: var(--fl-color-text-secondary); }
    .gp-merge-abort:hover { color: var(--fl-color-error); border-color: var(--fl-color-error); }
    /* The thread's landing (thread-worktrees Phase 7; moved into the group it
       acts on by landing-per-project).
       An INSET CARD directly under its project's header, so there is no reading
       of the screen in which it belongs to the panel or to the repository below
       it. Raised off the band it sits in, and held away from the header above
       by a margin, so the two do not merge into one block of the same colour. */
    .gp-landing {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      margin: var(--fl-space-xs) var(--fl-space-sm) var(--fl-space-sm);
      padding: var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface-raised, var(--fl-color-surface));
    }
    .gp-landing-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fl-space-xs);
    }
    .gp-landing-title {
      font-weight: var(--fl-text-ui-weight-medium);
      color: var(--fl-color-text);
    }
    .gp-landing-note {
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    /* The total is a BUTTON: the number is why somebody would want the list, so
       it is the thing they press to get it. Styled as the sentence it already
       was — underlined on hover rather than boxed, because a control that looks
       like a button in a row of buttons would read as a fourth landing action. */
    .gp-landing-total {
      align-self: flex-start;
      max-width: 100%;
      padding: 0;
      border: none;
      background: none;
      color: var(--fl-color-text-secondary);
      font-family: inherit;
      font-size: var(--fl-text-caption-size);
      text-align: left;
      cursor: pointer;
    }
    .gp-landing-total:hover { color: var(--fl-color-accent); text-decoration: underline; }
    .gp-landing-total:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring);
      outline-offset: 1px;
      border-radius: var(--fl-radius-sm);
    }
    .gp-landing-actions { display: flex; flex-wrap: wrap; gap: var(--fl-space-xs); }
    .gp-landing-btn {
      height: 22px;
      padding: 0 8px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .gp-landing-btn:hover:not(:disabled) { border-color: var(--fl-color-accent); color: var(--fl-color-accent); }
    .gp-landing-btn:disabled { opacity: 0.5; cursor: default; color: var(--fl-color-text-secondary); }
    .gp-landing-primary { background: var(--fl-color-accent); color: var(--fl-color-on-accent, #fff); border-color: transparent; }
    .gp-landing-primary:disabled { background: var(--fl-color-surface); border-color: var(--fl-color-border); }
    .gp-landing-rows { display: flex; flex-direction: column; gap: 2px; }
    .gp-landing-row {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size);
    }
    .gp-landing-repo { font-weight: var(--fl-text-ui-weight-medium); }
    .gp-landing-status { letter-spacing: 0.02em; }
    .gp-landing-ok { color: var(--fl-color-success); }
    .gp-landing-warn { color: var(--fl-color-warning); }
    .gp-landing-error { color: var(--fl-color-error); }
    .gp-landing-muted { color: var(--fl-color-text-secondary); }
    .gp-landing-detail { color: var(--fl-color-text-secondary); flex: 1 1 100%; }
    /* Where a thread publishes — the ask a refused pull request raises. */
    .gp-landing-binding {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding-top: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size);
    }
    .gp-landing-field { display: flex; align-items: center; gap: var(--fl-space-xs); min-width: 0; }
    .gp-landing-field input,
    .gp-landing-field select {
      flex: 1 1 120px;
      min-width: 0;
      padding: 3px 6px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
    }
    .gp-landing-field > span { flex: 0 0 96px; }
    /* In-app Merge branch… / Pull actions (#66, P9). */
    .gp-git-actions { padding: var(--fl-space-xs) var(--fl-space-sm) 0; }
    .gp-git-actions-row { display: flex; gap: var(--fl-space-xs); }
    .gp-git-action-btn {
      height: 22px;
      padding: 0 8px;
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      color: var(--fl-color-text);
      font-size: var(--fl-text-caption-size);
      cursor: pointer;
    }
    .gp-git-action-btn:hover { border-color: var(--fl-color-accent); color: var(--fl-color-accent); }
    .gp-branch-picker {
      margin-top: var(--fl-space-xs);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
      overflow: hidden;
    }
    /* The status letter sits at the RIGHT edge (Cursor layout, #SCMS): the flex
       order property moves it past the name + action cluster without reordering
       the DOM, so the accessible name and tooltip (set on the element) are
       untouched. The action icons keep their place just left of it via
       .gp-row-actions margin-left:auto. Right-aligned for the minimalist row. */
    .gp-letter {
      flex: none;
      order: 3;
      width: 14px;
      margin-left: var(--fl-space-xs);
      font-family: var(--fl-font-mono);
      font-size: var(--fl-text-caption-size);
      text-align: right;
    }
    .gp-state-modified { color: var(--fl-color-warning); }
    .gp-state-added { color: var(--fl-color-success); }
    .gp-state-deleted { color: var(--fl-color-error); }
    .gp-state-renamed { color: var(--fl-color-accent); }
    .gp-state-untracked { color: var(--fl-color-text-secondary); }
    .gp-state-conflicted { color: var(--fl-color-error); }
    /* The directory gives way first, then the filename — so a long path degrades
       to "…/name.ts" on a narrow panel and the hover/conflict actions keep their
       place on the row (#1489). min-width: 0 is what actually lets a flex item
       shrink below its text; without it the name shoves the buttons off the edge,
       which is the overflow #1137 was trying to solve by wrapping. */
    .gp-dir {
      flex: 0 2 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--fl-color-text-secondary);
    }
    .gp-name {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gp-subject {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gp-meta {
      flex: none;
      color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size);
    }
    /* The paging affordance under the commit log (#1335) shipped with no rule at
       all, so it rendered as a raw UA button — a grey shrink-to-fit bevel in a
       dark panel (#1489). It reads as one more full-width row instead. */
    .gp-load-older {
      display: block;
      width: 100%;
      height: ${ROW_HEIGHT}px;
      padding: 0 var(--fl-space-sm);
      border: none;
      background: transparent;
      color: var(--fl-color-text-secondary);
      font-family: inherit;
      font-size: var(--fl-text-caption-size);
      text-align: center;
      cursor: pointer;
    }
    .gp-load-older:hover:not(:disabled) {
      color: var(--fl-color-text);
      background: var(--fl-color-surface-raised, var(--fl-color-surface));
    }
    .gp-load-older:disabled { opacity: 0.6; cursor: default; }
    /* ── Narrow panel ────────────────────────────────────────────────────
       Below GP_NARROW_PANEL_PX the words move to the tooltip and the glyphs carry
       the controls alone. Nothing is truncated on the way: a control shows
       its whole label or none of it, because half a label is not a shorter
       label, it is a different word. The buttons keep their aria-label, so the
       icon-only state is silent only to the eye.

       This is a CONTAINER query against .gp-merge-section, so it answers the
       panel's dragged width. It also has to reach INTO each <fl-list>'s shadow
       root, where the row content lives — container lookup walks the flat tree,
       so the list's host being a descendant of the container is enough. */
    @container gp-merge (max-width: ${GP_NARROW_PANEL_PX}px) {
      .gp-side-text { display: none; }
      .gp-action-side { padding: 0 4px; }
      /* The badge keeps its dot; the fact itself moves to the tooltip. */
      .gp-risk-text { display: none; }
      .gp-conflict-choice .gp-risk-badge { padding: 0 4px; }
      /* Each legend chip takes a full row, so the branch name gets the whole
         panel width before it has to ellipsize at all. */
      .gp-legend-chip { flex: 1 1 100%; }
    }
  `
