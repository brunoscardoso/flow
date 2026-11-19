import type { DraftElementFacts } from '../../shared/draft-pick'
import {
  draftChipLabel,
  draftColourEdit,
  draftElementText,
  draftKindLabel,
  draftPanelFields,
  draftPanelSeed,
  draftPictureLabel,
  draftSpacingEdit,
  draftStatusText,
  draftTextEdit,
  hexOfColour,
  pxNumber,
} from './draft-edit-model'

const facts = (over: Partial<DraftElementFacts> = {}): DraftElementFacts => ({
  id: 'b7k2qx',
  tag: 'button',
  role: '',
  name: 'Pay $27',
  text: 'Pay $27',
  textEditable: true,
  styles: {
    color: 'rgb(255, 255, 255)',
    'background-color': 'rgb(43, 108, 255)',
    'border-color': 'rgba(0, 0, 0, 0)',
    'padding-top': '12px',
    'padding-right': '16px',
    'padding-bottom': '12px',
    'padding-left': '16px',
    'margin-top': '0px',
    'margin-right': '0px',
    'margin-bottom': '8.5px',
    'margin-left': '0px',
  },
  summary: '<button data-flow-id="b7k2qx"> "Pay $27"',
  ...over,
})

describe('draftKindLabel', () => {
  it('names the element by its role, else its tag', () => {
    expect(draftKindLabel({ role: '', tag: 'button' })).toBe('Button')
    expect(draftKindLabel({ role: '', tag: 'h2' })).toBe('Heading')
    expect(draftKindLabel({ role: '', tag: 'a' })).toBe('Link')
    expect(draftKindLabel({ role: 'button', tag: 'div' })).toBe('Button')
    expect(draftKindLabel({ role: 'switch', tag: 'div' })).toBe('Switch')
    expect(draftKindLabel({ role: '', tag: 'figure' })).toBe('Figure')
  })
})

describe('draftPanelFields', () => {
  it('shows Text only when the text can change in place; colours, padding and margin always', () => {
    const editable = draftPanelFields(facts())
    expect(editable.text).toBe(true)
    expect(editable.colours.map((field) => field.label)).toEqual(['Background', 'Text colour', 'Border'])
    expect(editable.padding && editable.margin).toBe(true)
    expect(draftPanelFields(facts({ textEditable: false })).text).toBe(false)
  })
})

describe('seed values', () => {
  it('reads computed colours as hex, transparent as nothing', () => {
    expect(hexOfColour('rgb(43, 108, 255)')).toBe('#2b6cff')
    expect(hexOfColour('rgba(10, 20, 30, 0.5)')).toBe('#0a141e')
    expect(hexOfColour('rgba(0, 0, 0, 0)')).toBe('')
    expect(hexOfColour('#abc')).toBe('#aabbcc')
    expect(hexOfColour('color(srgb 1 0 0)')).toBe('')
    expect(hexOfColour(undefined)).toBe('')
  })
  it('reads computed lengths as px numbers', () => {
    expect(pxNumber('12px')).toBe('12')
    expect(pxNumber('8.5px')).toBe('8.5')
    expect(pxNumber('auto')).toBe('')
    expect(pxNumber(undefined)).toBe('')
  })
  it('seeds every field from the pick', () => {
    expect(draftPanelSeed(facts())).toEqual({
      text: 'Pay $27',
      colours: { 'background-color': '#2b6cff', color: '#ffffff', 'border-color': '' },
      padding: { top: '12', right: '16', bottom: '12', left: '16' },
      margin: { top: '0', right: '0', bottom: '8.5', left: '0' },
    })
  })
})

describe('edits address the element by id', () => {
  it('a text edit', () => {
    expect(draftTextEdit('b7k2qx', 'Pay now')).toEqual({ ok: true, edit: { id: 'b7k2qx', kind: 'text', text: 'Pay now' } })
  })
  it('a colour edit: hex with or without #, named colours, and refusals', () => {
    expect(draftColourEdit('b7k2qx', 'background-color', '#ff0000')).toEqual({
      ok: true,
      edit: { id: 'b7k2qx', kind: 'colour', property: 'background-color', value: '#ff0000' },
    })
    expect(draftColourEdit('b7k2qx', 'color', 'fff')).toMatchObject({ ok: true, edit: { value: '#fff' } })
    expect(draftColourEdit('b7k2qx', 'color', 'teal')).toMatchObject({ ok: true, edit: { value: 'teal' } })
    expect(draftColourEdit('b7k2qx', 'color', 'red; display:none')).toEqual({
      ok: false,
      reason: 'That is not a colour Flow can write.',
    })
    expect(draftColourEdit('b7k2qx', 'color', '  ')).toEqual({ ok: false, reason: 'Type a colour, such as #2b6cff.' })
  })
  it('a spacing edit: a plain number is pixels', () => {
    expect(draftSpacingEdit('b7k2qx', 'padding', 'top', '20')).toEqual({
      ok: true,
      edit: { id: 'b7k2qx', kind: 'spacing', property: 'padding-top', value: '20px' },
    })
    expect(draftSpacingEdit('b7k2qx', 'margin', 'left', '0')).toMatchObject({ ok: true, edit: { property: 'margin-left', value: '0' } })
    expect(draftSpacingEdit('b7k2qx', 'margin', 'left', '1.5rem')).toMatchObject({ ok: true, edit: { value: '1.5rem' } })
    expect(draftSpacingEdit('b7k2qx', 'margin', 'left', '-4')).toEqual({ ok: false, reason: 'That is not a spacing Flow can write.' })
    expect(draftSpacingEdit('b7k2qx', 'margin', 'left', '')).toEqual({ ok: false, reason: 'Type a number of pixels, such as 12.' })
  })
  it('refuses an id that is not one', () => {
    expect(draftTextEdit('a b', 'x')).toEqual({ ok: false, reason: 'The change does not name an element.' })
  })
})

describe('status and labels', () => {
  it('says Saved, or main’s sentence word for word', () => {
    expect(draftStatusText({ ok: true })).toBe('Saved')
    const gone = 'This element is no longer on the screen, so the change was not saved.'
    expect(draftStatusText({ ok: false, reason: gone })).toBe(gone)
  })
  it('labels the chip with the screen, the short text and the kind', () => {
    expect(draftChipLabel('Payment', facts())).toBe('Payment · "Pay $27" button')
    expect(draftChipLabel('Payment', facts({ name: '' }))).toBe('Payment · button')
    expect(draftChipLabel('Home', facts({ name: 'x'.repeat(50), tag: 'p' }))).toBe(`Home · "${'x'.repeat(31)}…" text`)
    expect(draftPictureLabel('Payment')).toBe('Picture of Payment')
  })
})

describe('draftElementText (note 8)', () => {
  it('names the canvas, the screen file and the id — no selector', () => {
    const text = draftElementText('<button data-flow-id="b7k2qx"> "Pay $27"', {
      ...facts(),
      screen: 'payment',
      canvas: 'checkout',
      screenTitle: 'Payment',
      file: 'flow/drafts/checkout/payment.html',
    })
    expect(text.split('\n')).toEqual([
      'Element: data-flow-id="b7k2qx"',
      'A <button> of a UI draft: a look-alike screen, not the app itself.',
      'Canvas: checkout',
      'Screen: Payment — flow/drafts/checkout/payment.html',
      'DOM: <button data-flow-id="b7k2qx"> "Pay $27"',
      'Change this element in the screen file, keeping its data-flow-id.',
    ])
  })
})
