import {
  DRAFT_FRAME_PICK,
  draftFramePickerSource,
  parseDraftCanvasPick,
  parseDraftElementFacts,
  readDraftElement,
  type DraftPickElement,
  type DraftPickNode,
} from './draft-pick'

/** A tiny structural element tree — enough for the reader. */
function el(
  tag: string,
  attributes: Record<string, string>,
  children: Array<DraftPickElement | string> = [],
): DraftPickElement {
  const nodes: DraftPickNode[] = []
  const elements: DraftPickElement[] = []
  const node: DraftPickElement = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
    parentElement: null,
    childNodes: nodes,
    children: elements,
    get textContent() {
      return nodes.map((child) => child.textContent ?? '').join('')
    },
  }
  for (const child of children) {
    if (typeof child === 'string') nodes.push({ nodeType: 3, textContent: child })
    else {
      child.parentElement = node
      nodes.push(child)
      elements.push(child)
    }
  }
  return node
}

const styles = (values: Record<string, string>) => () => ({ getPropertyValue: (name: string) => values[name] ?? '' })

describe('readDraftElement', () => {
  it('reads the stamped element: id, tag, own text, name, computed styles and a summary', () => {
    const button = el('button', { 'data-flow-id': 'b7k2qx' }, ['  Pay $27 '])
    el('div', { 'data-flow-id': 'card' }, [button])
    const facts = readDraftElement(button, styles({ color: 'rgb(255, 255, 255)', 'padding-top': '12px' }), 'data-flow-id')
    expect(facts).toEqual({
      id: 'b7k2qx',
      tag: 'button',
      role: '',
      name: 'Pay $27',
      text: 'Pay $27',
      textEditable: true,
      styles: { color: 'rgb(255, 255, 255)', 'padding-top': '12px' },
      summary: '<button data-flow-id="b7k2qx"> "Pay $27"',
    })
  })

  it('walks up to the nearest ancestor with an id', () => {
    const icon = el('svg', {})
    const link = el('a', { 'data-flow-id': 'lnk', 'aria-label': 'Back', role: 'link' }, [icon, 'Back'])
    const facts = readDraftElement(icon, styles({}), 'data-flow-id')
    expect(facts?.id).toBe('lnk')
    expect(facts?.name).toBe('Back')
    expect(facts?.role).toBe('link')
    // One text run beside an element: still editable in place, like main's patch.
    expect(facts?.textEditable).toBe(true)
    expect(facts?.text).toBe('Back')
    expect(link.children.length).toBe(1)
  })

  it('text spread over children, or a void element, is not editable in place', () => {
    const card = el('div', { 'data-flow-id': 'card' }, [el('h2', { 'data-flow-id': 'h' }, ['Title']), el('p', { 'data-flow-id': 'p' }, ['Body'])])
    expect(readDraftElement(card, styles({}), 'data-flow-id')).toMatchObject({ textEditable: false, text: '', name: 'TitleBody' })
    const input = el('input', { 'data-flow-id': 'in', placeholder: 'Card number' })
    expect(readDraftElement(input, styles({}), 'data-flow-id')).toMatchObject({ textEditable: false, name: 'Card number' })
  })

  it('answers null on a page with no stamped element', () => {
    const plain = el('button', {}, ['Save'])
    el('body', {}, [plain])
    expect(readDraftElement(plain, styles({}), 'data-flow-id')).toBeNull()
  })
})

describe('parseDraftCanvasPick', () => {
  const facts = { id: 'b7k2qx', tag: 'button', role: '', name: 'Pay', text: 'Pay', textEditable: true, styles: { color: 'red', bogus: 'x' }, summary: '<button>' }
  it('keeps a well-formed pick and drops unknown style keys', () => {
    expect(parseDraftCanvasPick({ type: 'x', screen: 'payment', rect: { x: 1, y: 2, width: 3, height: 4 }, facts })).toEqual({
      screen: 'payment',
      rect: { x: 1, y: 2, width: 3, height: 4 },
      facts: { ...facts, styles: { color: 'red' } },
    })
  })
  it('refuses a screen or id that is not one, and a bad rect becomes null', () => {
    expect(parseDraftCanvasPick({ screen: '../x', facts })).toBeNull()
    expect(parseDraftCanvasPick({ screen: 'payment', facts: { ...facts, id: 'a b' } })).toBeNull()
    expect(parseDraftCanvasPick({ screen: 'payment', rect: { x: 'no' }, facts })?.rect).toBeNull()
    expect(parseDraftElementFacts(null)).toBeNull()
  })
})

describe('draftFramePickerSource', () => {
  it('is one script, with the reader inlined from its own source', () => {
    const source = draftFramePickerSource('data-flow-id')
    expect(() => new Function(source)).not.toThrow()
    expect(source).toContain('readDraftElement')
    expect(source).toContain(JSON.stringify(DRAFT_FRAME_PICK))
  })

  it('the inlined reader names nothing outside itself', () => {
    // Run the reader's own source in an empty scope: an outside reference would throw here.
    const isolated = new Function(`return (${readDraftElement.toString()})`)() as typeof readDraftElement
    const button = el('button', { 'data-flow-id': 'x1' }, ['Go'])
    expect(isolated(button, styles({}), 'data-flow-id')?.id).toBe('x1')
  })
})
