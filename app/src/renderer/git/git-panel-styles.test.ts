/**
 * Layout invariant for Source Control rows (#1489).
 *
 * Row content is rendered by <fl-list>, which absolutely positions each row at
 * `index * rowHeight` and clips it to exactly that height. Anything inside a row
 * that produces a second line is therefore not "wrapped" but SLICED — both lines
 * lose half their glyphs, which is what #1489 reported for the commit log after
 * #1137 added `flex-wrap: wrap` to `.gp-row` for narrow-panel conflict buttons.
 *
 * The E2E probe (e2e/ux/git-commit-row-layout.spec.ts) measures the rendered
 * result; this guards the rule itself, because the failure is invisible in code
 * review — `flex-wrap: wrap` looks like exactly the right responsive answer
 * until you know these rows cannot grow.
 */
import {
  CONFLICT_ROW_HEIGHT,
  GP_NARROW_PANEL_PX,
  GP_STYLES,
  ROW_HEIGHT,
} from './git-panel-styles'

/** The declaration block for an exact selector (not its `-suffix` siblings). */
function ruleBody(selector: string): string {
  const match = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(GP_STYLES)
  if (match === null) throw new Error(`no rule found for ${selector}`)
  return match[1] ?? ''
}

/** Selectors whose elements are rendered INSIDE an fl-list row. */
const ROW_CONTENT_SELECTORS = ['.gp-row', '.gp-row-actions', '.gp-conflict-choice']

/** Selectors outside the list, where wrapping is free to reflow (#1137). */
const FREE_HEIGHT_SELECTORS = ['.gp-section-head', '.gp-bulk-actions']

describe('git panel row styles', () => {
  it.each(ROW_CONTENT_SELECTORS)('%s never wraps — the row height is fixed', (selector) => {
    expect(ruleBody(selector)).not.toContain('flex-wrap: wrap')
  })

  it.each(FREE_HEIGHT_SELECTORS)('%s keeps wrapping — it is not height-capped', (selector) => {
    expect(ruleBody(selector)).toContain('flex-wrap: wrap')
  })

  // What replaces wrapping on a narrow panel: the path text yields so the action
  // cluster keeps its place, instead of being pushed past the panel edge (#1137).
  it.each(['.gp-dir', '.gp-name', '.gp-subject'])('%s can shrink below its text', (selector) => {
    const body = ruleBody(selector)
    expect(body).toContain('min-width: 0')
    expect(body).toContain('text-overflow: ellipsis')
    expect(body).not.toContain('flex: none')
  })

  // A conflicted file is the one row that carries a DECISION, so it gets a
  // second line — bought from the list's rowHeight, never by wrapping.
  describe('the two-line conflict row', () => {
    it('is tall enough for both of its lines', () => {
      expect(CONFLICT_ROW_HEIGHT).toBeGreaterThan(ROW_HEIGHT)
      // The filename line keeps the normal height; what is left is the choice.
      expect(CONFLICT_ROW_HEIGHT - ROW_HEIGHT).toBeGreaterThanOrEqual(18)
    })

    it('gives the choice a label the repository cannot lengthen', () => {
      // The label used to be a branch name, so it shrank by ellipsizing — which
      // is how "Use ACME-2446-…" rendered as "Jse ACME-2446-move-chat-persist".
      // A fixed role word is shown whole or hidden; it is never sliced.
      const body = ruleBody('.gp-side-text')
      expect(body).toContain('white-space: nowrap')
      expect(body).toContain('flex: none')
    })

    it('marks the armed side as different from the one beside it', () => {
      // Two identical pills where one is loaded and the other is not would make
      // the second press a coin flip.
      const body = ruleBody('.gp-action-side-armed')
      expect(body).toContain('border-color')
      expect(body).toContain('font-weight')
    })
  })

  // #4 of the source-control pass: "COMMITS · LATEST 100" sat directly against
  // the next project's header, so two projects read as one list. The first fix
  // (8px + a hairline on the group that STARTS) did not do it on a real
  // four-repo thread — the rule read as part of the previous group's last row.
  // A project is a BAND now, and the band's own edge is where it ends.
  describe('where one project ends', () => {
    it('encloses nothing — a project is not a box', () => {
      // This asserted the opposite until 2026-08-26: a filled surface closed
      // top and bottom. It separated correctly and turned a panel that is
      // mostly lists into a stack of boxes. The user's words on reading it:
      // "don't need all those blocks and everything, let me more clean".
      const body = ruleBody('.gp-group-boxed')
      expect(body).not.toContain('background:')
      expect(body).not.toContain('border-bottom')
    })

    it('divides with a rule on the group that STARTS, and space under the one that ends', () => {
      // The same shape the thread sidebar settled on — which is the surface the
      // user pointed at as the one that reads right.
      const between = ruleBody('.gp-group-boxed + .gp-group-boxed')
      expect(between).toContain('border-top')
      expect(ruleBody('.gp-group-boxed')).toContain('padding-bottom')
    })

    it('draws no rule above the first project', () => {
      // The adjacent-sibling selector is the whole guard: a line under the
      // panel's own top edge divides nothing from nothing. A rule on
      // `.gp-group-boxed` alone would draw one there.
      expect(ruleBody('.gp-group-boxed')).not.toContain('border-top')
    })

    it('never separates a group from one that is not there', () => {
      // The separator is keyed on the BOXED class, which the panel only adds
      // when headers render — i.e. when there is more than one repository. A
      // rule on `.gp-group` alone would paint a lone group as a band with
      // nothing to be a band against.
      expect(GP_STYLES).not.toMatch(/\.gp-group \+ \.gp-group\s*\{/)
    })

    it('does not compete with the header accent, and does not eat width', () => {
      const body = ruleBody('.gp-group-boxed')
      // No side borders: at 320px the panel is already ellipsizing branch
      // names, and a heavier horizontal would fight the head's 3px stripe.
      expect(body).not.toContain('border-left')
      expect(body).not.toContain('border-right')
      expect(body).not.toContain('border-width: 2')
    })
  })

  it('styles the load-older control instead of leaving it a raw UA button', () => {
    const body = ruleBody('.gp-load-older')
    expect(body).toContain('width: 100%')
    expect(body).toContain('border: none')
  })
  // #6 of this pass: the panel is drag-resized inside a much wider window, so
  // "narrow" is a fact about the CONTAINER. A viewport media query would have
  // answered for the window and left the sidebar clipping exactly as before.
  describe('the narrow panel', () => {
    /** The declaration block of the narrow-panel container query, or null. */
    function narrowRuleBody(): string | null {
      const open = `@container gp-merge (max-width: ${GP_NARROW_PANEL_PX}px) {`
      const at = GP_STYLES.indexOf(open)
      if (at < 0) return null
      const end = GP_STYLES.indexOf('\n    }', at)
      return end < 0 ? null : GP_STYLES.slice(at + open.length, end)
    }

    it('asks the merge section its width, not the window', () => {
      expect(ruleBody('.gp-merge-section')).toContain('container-type: inline-size')
      expect(narrowRuleBody()).not.toBeNull()
    })

    it('names its threshold instead of hard-coding one', () => {
      expect(GP_NARROW_PANEL_PX).toBeGreaterThan(ROW_HEIGHT)
      expect(GP_STYLES).toContain(`max-width: ${GP_NARROW_PANEL_PX}px`)
    })

    it('drops whole words, never half of one', () => {
      const body = narrowRuleBody() ?? ''
      expect(body).toContain('.gp-side-text { display: none; }')
      expect(body).toContain('.gp-risk-text { display: none; }')
    })
  })

  // The three bulk choices are the one place in this section where something
  // MUST give on a narrow panel: their widths are fixed by their labels.
  it('wraps the bulk choices to a second row rather than overflowing', () => {
    expect(ruleBody('.gp-merge-bulk')).toContain('flex-wrap: wrap')
  })

  it('makes a bulk choice look pressable — it rendered as bare text', () => {
    const body = ruleBody('.gp-bulk-keepall')
    expect(body).toContain('border:')
    expect(body).toContain('background:')
    expect(body).toContain('padding:')
    expect(ruleBody('.gp-bulk-keepall:hover')).toContain('background:')
    expect(ruleBody('.gp-bulk-keepall:focus-visible')).toContain('outline:')
  })

  // Red is the app's word for "something went wrong"; an offer to do the work
  // read as a report that the work had failed.
  it('paints Resolve all with AI in the accent, not the error colour', () => {
    const body = ruleBody('.gp-action-resolve')
    expect(body).toContain('var(--fl-color-accent)')
    expect(body).not.toContain('var(--fl-color-error)')
  })

  // Identity appears once, and a caption is allowed to get shorter.
  it('lets the legend branch ellipsize — it is the only string here that may', () => {
    const body = ruleBody('.gp-legend-branch')
    expect(body).toContain('min-width: 0')
    expect(body).toContain('text-overflow: ellipsis')
  })
})

describe('the branch line owns renaming', () => {
  // The landing block used to carry its own branch row, printing the name from
  // the RECORD while this line printed it from git — one line apart, and on a
  // re-pointed worktree they disagreed. There is one branch line now, the
  // panel owns the rename control on it, and it is offered for EVERY branch
  // rather than only a thread's own (which nobody could see the rule for).
  it('has no branch row left in the landing block', () => {
    expect(GP_STYLES).not.toContain('.gp-landing-branch')
    expect(GP_STYLES).not.toContain('.gp-landing-edit')
  })

  it('keeps the pencil on screen rather than hiding it until hover', () => {
    // It shipped hidden until hover and was reported as "there is no option to
    // edit the branch" — from a screenshot of the line it was sitting on.
    const idle = /opacity:\s*([0-9.]+)/.exec(ruleBody('.gp-branch-edit-btn'))?.[1]
    expect(Number(idle)).toBeGreaterThan(0)
    // …and a keyboard still reaches it, which :hover alone never did.
    expect(GP_STYLES).toContain('.gp-branch-edit-btn:focus-visible')
  })

  it('stands the label down while the field is up', () => {
    // No cross-component event: the control states its mode, and one rule reads
    // it. A label left beside the input would show the old name and the new one
    // at once.
    expect(GP_STYLES).toContain(
      ".gp-branch:has(.gp-branch-edit[data-editing='true']) .gp-branch-name",
    )
  })
})
