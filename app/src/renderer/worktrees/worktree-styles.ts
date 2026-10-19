/**
 * THE WORKTREE SWITCH'S STYLESHEET — its own module, imported by both surfaces.
 *
 * The panel in the explorer and the new-thread chip's menu draw the SAME switch
 * (user, 2026-09-17: "the exact same experience that we added on the
 * explorer"), so the rules live in one place — a second copy is a second switch
 * that drifts from this one (allowed-pattern #14).
 *
 * IT IMPORTS NOTHING, deliberately. Having the chip reach into the panel's
 * module for these rules put a cycle between two large files
 * (chip → panel → branch-name → …), and a cycle in this bundle resolves as an
 * `undefined` binding at call time: the new-thread page threw while building
 * and simply never appeared. A leaf module cannot do that to anybody.
 */

let stylesInjected = false

export function injectWorktreeStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    /* SIZED FOR A POPOVER, NOT A PANE. This was height 100%, which filled the
       rail pane it used to live in — and inside a popover, whose height comes
       from its own content, 100% of nothing is nothing.
       (No backticks in here: this is a template literal, and one ends it.) */
    .fl-wt { display: flex; flex-direction: column; width: 268px; max-height: 70vh;
      overflow-y: auto; }
    /* NO TITLE ROW. It said WORKTREE across the top of the file explorer, which
       labels the whole pane as something it is not — the pane is the project's
       files (user, 2026-09-17: "seems that everything is a worktree in that tab,
       but is not, is a file repo"). The switch names itself. */
    .fl-wt-body { flex: none; padding: 12px 14px; }
    .fl-wt-empty { padding: 16px 14px; font-size: 12px; opacity: 0.7; }

    .fl-wt-switch { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .fl-wt-label { min-width: 0; }
    .fl-wt-name { font-size: 13px; }
    .fl-wt-state { font-size: 11.5px; opacity: 0.55; }
    /* WHICH copy. Third line, muted, its own row so a long name never squeezes
       the switch. It was the headline once and dominated the panel; down here it
       answers the one question the abstraction left open. */
    .fl-wt-others { margin-top: 10px; padding-top: 9px;
      border-top: 1px solid var(--fl-border-subtle, #232529); display: grid; gap: 5px; }
    .fl-wt-other { display: flex; align-items: baseline; gap: 6px; font-size: 11.5px; }
    .fl-wt-other-name { opacity: 0.8; }
    .fl-wt-other-branch { opacity: 0.45; min-width: 0;
      font-family: var(--fl-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-wt-other-none { opacity: 0.55; color: #d9a441; }
    .fl-wt-branch {
      margin-top: 9px; display: flex; align-items: baseline; gap: 6px;
      font-size: 11.5px; min-width: 0;
    }
    .fl-wt-branch-label { flex: none; opacity: 0.5; }
    .fl-wt-branch-name {
      min-width: 0; opacity: 0.75;
      font-family: var(--fl-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    .fl-wt-track {
      width: 34px; height: 19px; border-radius: 999px; flex: none; position: relative;
      background: var(--fl-surface-sunken, #24272c); border: 1px solid var(--fl-border, #2a2d33);
      padding: 0; cursor: pointer;
    }
    .fl-wt-track[data-on='true'] { background: #2b4272; border-color: #33507f; }
    .fl-wt-track[data-armed='true'] { background: transparent; border-style: dashed; border-color: #33507f; }
    .fl-wt-track[disabled] { opacity: 0.4; cursor: default; }
    .fl-wt-knob {
      position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
      border-radius: 50%; background: #8b9199;
    }
    .fl-wt-track[data-on='true'] .fl-wt-knob { left: auto; right: 2px; background: #cfe0ff; }
    .fl-wt-track[data-armed='true'] .fl-wt-knob {
      background: transparent; box-shadow: inset 0 0 0 2px #7aa2f7;
    }
    .fl-wt-track[data-armed='true'][data-on='false'] .fl-wt-knob { left: auto; right: 2px; }
    .fl-wt-track[data-armed='true'][data-on='true'] .fl-wt-knob { left: 2px; right: auto; }

    .fl-wt-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .fl-wt-pill {
      font-size: 11px; line-height: 1; padding: 5px 8px; border-radius: 999px;
      border: 1px solid var(--fl-border, #2a2d33); opacity: 0.75;
    }
    .fl-wt-pill[data-tone='good'] { color: #7fc08a; border-color: #26402a; opacity: 1; }
    .fl-wt-pill[data-tone='holding'] { color: #d9a441; border-color: #4a3c22; opacity: 1; }
    .fl-wt-pill[data-tone='busy'] { color: #7aa2f7; border-color: #2b3b55; opacity: 1; }

    /* ── naming the worktree ───────────────────────────────────────────
       THE PREFIX IS PART OF THE FIELD, fixed and dimmed — the way a URL field
       shows its scheme. It replaced a heading, a label, a checkbox and a line
       explaining the naming rule: four rows describing a prefix that can simply
       be shown (user, 2026-09-17: "this is definitely not clear"). */
    .fl-wt-namelabel { font-size: 11.5px; opacity: 0.6; margin-top: 2px; }
    /* ONE FIELD, NOT TWO BOXES. The prefix and the input were each drawn with
       their own background and border, so they read as two controls with a seam
       down the middle (user, 2026-09-17: "that input component is not good
       enough"). The BOX belongs to the wrapper; the input inside it is
       transparent and borderless, and the focus ring is the wrapper's too — so
       it behaves like the single field it is. */
    .fl-wt-prefixed {
      display: flex; align-items: center; margin-top: 5px; min-width: 0;
      background: var(--fl-surface-sunken, #24272c);
      border: 1px solid var(--fl-color-border, #2b2b2b);
      border-radius: var(--fl-radius-sm, 4px);
      padding: 0 8px;
    }
    .fl-wt-prefixed:focus-within { border-color: var(--fl-color-accent, #3794ff); }
    .fl-wt-fixed {
      flex: none; padding: 0; border: 0; background: none;
      font-family: var(--fl-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 12.5px; opacity: 0.4; user-select: none;
    }
    .fl-wt-prefixed input {
      flex: 1 1 auto; min-width: 0; margin: 0;
      padding: 5px 0; border: 0; border-radius: 0; background: none; box-shadow: none;
      color: inherit; font: inherit; font-size: 12.5px;
      font-family: var(--fl-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    }
    .fl-wt-prefixed input:focus { outline: none; }

    /* A way out for the few who want the two names different — a sentence, not
       a control that costs a row on every panel. Specific enough to beat the
       shell's own button rule, which was painting it as a grey pill. */
    .fl-wt-ask button.fl-wt-link {
      display: inline-block; margin-top: 9px; padding: 0;
      border: 0; background: none; box-shadow: none;
      color: var(--fl-color-accent, #3794ff); font: inherit; font-size: 11.5px;
      cursor: pointer; text-align: left;
    }
    .fl-wt-ask button.fl-wt-link:hover { text-decoration: underline; background: none; }
    .fl-wt-ask button.fl-wt-link:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring, rgba(55,148,255,0.6)); outline-offset: 2px;
    }
    /* Advice, not a refusal: the create goes ahead, and this says what it will
       do differently. */
    .fl-wt-sub[data-tone='note'] { color: #7aa2f7; opacity: 0.9; }
    /* The one sentence in this panel that describes work being destroyed. */
    .fl-wt-sub[data-tone='bad'] { color: #d96b6b; opacity: 1; }

    .fl-wt-ask { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--fl-color-separator, #232529); }

    /* THE IDE'S OWN CHOICE ROW, not a browser button.
       These had a class and no CSS behind it, so they rendered as the platform's
       default grey slabs — the one thing in this panel that looked like it came
       from a different program (user, 2026-09-17: "those buttons are not good …
       this seems not similar to the current UI"). Same shape the app's anchored
       menus use for exactly this kind of choice: a bordered card on the raised
       surface, the accent on hover, the label above its detail. */
    .fl-wt-carry {
      display: flex; flex-direction: column; gap: 3px;
      width: 100%; min-width: 0; margin-top: 6px;
      padding: var(--fl-space-xs, 6px) var(--fl-space-sm, 9px);
      text-align: left;
      border: var(--fl-border-width, 1px) solid var(--fl-color-border, #2b2b2b);
      border-radius: var(--fl-radius-sm, 4px);
      background: var(--fl-color-surface-raised, #2a2a2b);
      color: inherit; font: inherit; font-size: 12.5px; cursor: pointer;
    }
    .fl-wt-carry:hover { border-color: var(--fl-color-accent, #3794ff); }
    .fl-wt-carry:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring, rgba(55,148,255,0.6)); outline-offset: 1px;
    }
    .fl-wt-carry .fl-wt-sub { margin: 0; }
    .fl-wt-q { font-size: 12.5px; }
    .fl-wt-q[data-danger='true'] { color: #d96b6b; }
    .fl-wt-sub { font-size: 11.5px; opacity: 0.65; margin-top: 6px; }
    .fl-wt-field { display: flex; margin-top: 9px; }
    .fl-wt-field input { flex: 1 1 auto; min-width: 0; }
    .fl-wt-acts { display: flex; gap: 6px; margin-top: 10px; }
    .fl-wt-acts button {
      flex: 1 1 auto;
      padding: 5px 10px;
      border: var(--fl-border-width, 1px) solid var(--fl-color-border, #2b2b2b);
      border-radius: var(--fl-radius-sm, 4px);
      background: var(--fl-color-surface-raised, #2a2a2b);
      color: inherit; font: inherit; font-size: 12px; cursor: pointer;
    }
    .fl-wt-acts button:hover:not([disabled]) { border-color: var(--fl-color-accent, #3794ff); }
    .fl-wt-acts button:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring, rgba(55,148,255,0.6)); outline-offset: 1px;
    }
    .fl-wt-acts button[disabled] { opacity: 0.45; cursor: default; }
    /* WORKING IS NOT DISABLED. A greyed-out button says "you may not"; this one
       says "it is happening" — full contrast, a slow breath, and no pointer. */
    .fl-wt-acts button[data-working='true'],
    .fl-wt-fix[data-working='true'] {
      opacity: 1;
      cursor: progress;
      border-color: var(--fl-color-accent, #3794ff);
      animation: fl-wt-breathe 1.4s ease-in-out infinite;
    }
    @keyframes fl-wt-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
    @media (prefers-reduced-motion: reduce) {
      .fl-wt-acts button[data-working='true'],
      .fl-wt-fix[data-working='true'] { animation: none; }
    }
    /* THE DESTRUCTIVE ONE IS THE ONLY COLOURED THING HERE, and it is coloured in
       the edge rather than filled: a solid red button in a sidebar reads as an
       alarm going off, when what it is is one of two ordinary choices. */
    .fl-wt-acts button[data-tone='danger'] {
      color: var(--fl-color-danger, #d9534f);
      border-color: color-mix(in srgb, var(--fl-color-danger, #d9534f) 45%, transparent);
    }
    .fl-wt-acts button[data-tone='danger']:hover:not([disabled]) {
      border-color: var(--fl-color-danger, #d9534f);
      background: color-mix(in srgb, var(--fl-color-danger, #d9534f) 12%, transparent);
    }

    .fl-wt-fix {
      margin-top: 9px; padding: 5px 9px; border-radius: var(--fl-radius-sm, 5px);
      border: 1px solid var(--fl-border, #2a2d33); background: none; color: inherit;
      font: inherit; font-size: 11.5px; cursor: pointer;
    }
    .fl-wt-fix:hover:not([disabled]) { border-color: #7aa2f7; }
    .fl-wt-fix[disabled] { opacity: 0.45; cursor: default; }

    /* A QUIET WAY OUT. Walking away from a question is not one of the answers,
       so it does not look like one: no card, no border, just a word. */
    .fl-wt-open {
      display: block; margin-top: 8px; padding: 4px 0;
      border: 0; background: none; color: inherit; opacity: 0.6;
      font: inherit; font-size: 12px; cursor: pointer;
    }
    .fl-wt-open:hover { opacity: 1; }
    .fl-wt-open:focus-visible {
      outline: 2px solid var(--fl-color-focus-ring, rgba(55,148,255,0.6)); outline-offset: 2px;
    }

    .fl-wt-note { font-size: 11.5px; margin-top: 10px; padding-top: 9px;
      border-top: 1px solid var(--fl-border-subtle, #232529); opacity: 0.6; }
    .fl-wt-note[data-tone='warn'] { color: #d9a441; opacity: 1; }
    .fl-wt-note[data-tone='bad'] { color: #d96b6b; opacity: 1; }

    .fl-wt-skel {
      height: 9px; border-radius: 4px; margin-top: 10px; width: 55%;
      background: linear-gradient(90deg, #22252a 25%, #2c3037 50%, #22252a 75%);
      background-size: 300% 100%; animation: fl-wt-sweep 1.6s linear infinite;
    }
    @keyframes fl-wt-sweep { from { background-position: 150% 0; } to { background-position: -50% 0; } }
    @media (prefers-reduced-motion: reduce) { .fl-wt-skel { animation: none; } }
  `
  document.head.appendChild(style)
}
