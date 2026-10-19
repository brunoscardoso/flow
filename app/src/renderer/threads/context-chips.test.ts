import {
  addContextChip,
  contextChipId,
  contextChipPreview,
  dismissContextChip,
  serializeContextChips,
  type ContextChipRef,
} from './context-chips'

const chip = (source: 'terminal' | 'file', text: string, label = 'Terminal'): ContextChipRef => ({
  id: contextChipId(source, text),
  source,
  label,
  text,
})

describe('contextChipId (#152)', () => {
  it('is stable for identical source+text and differs otherwise', () => {
    expect(contextChipId('terminal', 'npm run build')).toBe(contextChipId('terminal', 'npm run build'))
    expect(contextChipId('terminal', 'a')).not.toBe(contextChipId('terminal', 'b'))
    expect(contextChipId('terminal', 'a')).not.toBe(contextChipId('file', 'a'))
  })
})

describe('addContextChip / dismissContextChip (#152)', () => {
  it('appends a chip and dedups the identical selection (stable reference)', () => {
    const first = addContextChip([], chip('terminal', 'error: boom'))
    expect(first).toHaveLength(1)
    const again = addContextChip(first, chip('terminal', 'error: boom'))
    expect(again).toBe(first) // no-op → same array
  })

  it('removes a chip by id', () => {
    const c = chip('terminal', 'x')
    expect(dismissContextChip([c], c.id)).toEqual([])
    expect(dismissContextChip([c], 'nope')).toEqual([c])
  })
})

describe('contextChipPreview (#152)', () => {
  it('shows the first line, ellipsized when multi-line', () => {
    expect(contextChipPreview(chip('terminal', 'first line\nsecond'))).toBe('first line…')
  })

  it('does not ellipsize a short single-line selection', () => {
    expect(contextChipPreview(chip('terminal', 'ok'))).toBe('ok')
  })

  it('truncates a long first line', () => {
    const long = 'x'.repeat(50)
    expect(contextChipPreview(chip('terminal', long), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('serializeContextChips (#152)', () => {
  it('folds a selection into a labeled fenced block above the user text', () => {
    const out = serializeContextChips([chip('terminal', 'npm test\nFAILED')], 'why did this fail?')
    expect(out).toBe('Context from Terminal:\n```\nnpm test\nFAILED\n```\n\nwhy did this fail?')
  })

  it('with no user text emits just the block (no dangling separator)', () => {
    expect(serializeContextChips([chip('terminal', 'boom')], '')).toBe(
      'Context from Terminal:\n```\nboom\n```',
    )
  })

  it('leaves the text untouched when there are no chips', () => {
    expect(serializeContextChips([], 'hello')).toBe('hello')
  })

  it('emits one block per chip in insertion order', () => {
    const out = serializeContextChips([chip('terminal', 'A'), chip('file', 'B', 'src/x.ts')], 'go')
    expect(out).toBe('Context from Terminal:\n```\nA\n```\n\nContext from src/x.ts:\n```\nB\n```\n\ngo')
  })

  it('widens the fence when the selected text itself contains a ``` fence (no early close)', () => {
    // A markdown file / code sample with its own ``` fence must stay INSIDE one
    // block — a fixed ``` wrapper would be closed early by the inner fence.
    const text = 'before\n```js\ncode\n```\nafter'
    const out = serializeContextChips([chip('file', text, 'readme.md')], 'explain')
    expect(out).toBe('Context from readme.md:\n````\n' + text + '\n````\n\nexplain')
  })

  it('escalates the fence past the LONGEST backtick run in the text', () => {
    const text = '````\nfour backticks inside\n````'
    const out = serializeContextChips([chip('terminal', text)], '')
    expect(out).toBe('Context from Terminal:\n`````\n' + text + '\n`````')
  })
})
