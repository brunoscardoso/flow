import { interactionIdentity } from './interaction-identity'

describe('interactionIdentity — names the control, never its contents', () => {
  it('prefers what an author deliberately wrote', () => {
    expect(interactionIdentity({ tagName: 'BUTTON', ariaLabel: 'Save invoice' })).toBe(
      'button Save invoice',
    )
    expect(interactionIdentity({ tagName: 'DIV', testId: 'submit-order' })).toBe(
      'div submit-order',
    )
    expect(interactionIdentity({ tagName: 'IMG', alt: 'Company logo' })).toBe('img Company logo')
  })

  it('uses the ROLE over the tag when the author set one', () => {
    expect(interactionIdentity({ tagName: 'DIV', role: 'button', ariaLabel: 'Close' })).toBe(
      'button Close',
    )
  })

  it('falls back to a KIND of control, which can carry nothing private', () => {
    expect(interactionIdentity({ tagName: 'INPUT', type: 'checkbox' })).toBe('input checkbox')
    expect(interactionIdentity({ tagName: 'SPAN' })).toBe('span')
  })

  it('takes a form field’s NAME — which is the field, never its value', () => {
    expect(interactionIdentity({ tagName: 'INPUT', name: 'customerEmail' })).toBe(
      'input customerEmail',
    )
  })

  it('ignores a generated id and keeps an authored one', () => {
    // React's useId produces `:r0:`; uuids and long hex are machine-made. None
    // of them tells a reader anything, and printing them is noise.
    expect(interactionIdentity({ tagName: 'DIV', id: ':r7:' })).toBe('div')
    expect(interactionIdentity({ tagName: 'DIV', id: '3f9a2c1e8b7d4f60a1b2' })).toBe('div')
    expect(interactionIdentity({ tagName: 'DIV', id: 'invoice-total' })).toBe('div #invoice-total')
  })

  it('is bounded — a label, not a paragraph', () => {
    const long = 'x'.repeat(300)
    const out = interactionIdentity({ tagName: 'BUTTON', ariaLabel: long })
    expect(out.length).toBeLessThanOrEqual(80)
    expect(out.endsWith('…')).toBe(true)
  })

  it('collapses whitespace so a label cannot smuggle a layout in', () => {
    expect(interactionIdentity({ tagName: 'BUTTON', ariaLabel: '  Save   \n  now ' })).toBe(
      'button Save now',
    )
  })

  it('takes a CONTROL’s own label, which is its accessible name', () => {
    // "clicked button #go" is a record a reader cannot follow; "clicked Save
    // template" is the thing they pressed. A button's text is what a screen
    // reader announces — authored UI chrome, not the user's data.
    expect(interactionIdentity({ tagName: 'BUTTON', controlText: 'Save template' })).toBe(
      'button Save template',
    )
  })

  it('puts a control’s label ahead of its form name', () => {
    // "Save template" is what was pressed; `templateName` is what the field is
    // called.
    expect(
      interactionIdentity({ tagName: 'BUTTON', controlText: 'Save', name: 'submitBtn' }),
    ).toBe('button Save')
  })

  it('still has NO WAY to receive arbitrary element text', () => {
    // `controlText` is filled by the recorder only for elements that behave
    // like controls. A table cell's text, an input's value and a page's copy
    // have no field to arrive in at all.
    const subject = { tagName: 'TD', ariaLabel: 'Amount due' }
    expect(interactionIdentity(subject)).toBe('td Amount due')
    expect(Object.keys(subject)).not.toContain('textContent')
    expect(Object.keys(subject)).not.toContain('value')
  })
})
