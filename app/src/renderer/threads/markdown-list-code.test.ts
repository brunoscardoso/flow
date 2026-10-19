// Guards the pure list-item helpers behind #1016: an indented fenced code
// block inside a list item must become a real code block (not inline prose
// with literal ``` and flattened newlines), a blank line inside a list must
// not split the procedure into two lists that renumber from 1, and an ordered
// list whose first marker is not 1 carries that number as its start.
import {
  LIST_ITEM_RE,
  classifyAfterBlank,
  fenceLineInfo,
  listStartNumber,
  stripFenceIndent,
} from './markdown-list-code'

describe('fenceLineInfo (#1016)', () => {
  it('parses an item-indented backtick fence with a language', () => {
    expect(fenceLineInfo('   ```bash')).toEqual({ indent: 3, marker: '```', lang: 'bash' })
    expect(fenceLineInfo('    ```')).toEqual({ indent: 4, marker: '```', lang: '' })
  })

  it('parses top-level (column-0) fences and tilde fences', () => {
    expect(fenceLineInfo('```ts')).toEqual({ indent: 0, marker: '```', lang: 'ts' })
    expect(fenceLineInfo('  ~~~python')).toEqual({ indent: 2, marker: '~~~', lang: 'python' })
  })

  it('takes the language from the first info-string word (#789 shapes)', () => {
    expect(fenceLineInfo('   ```bash title="run.sh" showLineNumbers')?.lang).toBe('bash')
  })

  it('rejects non-fence lines', () => {
    expect(fenceLineInfo('   npm install')).toBeNull()
    expect(fenceLineInfo('``two backticks``')).toBeNull()
    expect(fenceLineInfo('')).toBeNull()
  })

  it('rejects a backtick fence with a backtick in the info string (inline code)', () => {
    expect(fenceLineInfo('   ```code``` and more')).toBeNull()
  })
})

describe('stripFenceIndent (#1016)', () => {
  it('strips up to the fence indent from body lines', () => {
    expect(stripFenceIndent('   npm install', 3)).toBe('npm install')
  })

  it('keeps indentation deeper than the fence (relative code indent)', () => {
    expect(stripFenceIndent('     nested()', 3)).toBe('  nested()')
  })

  it('never eats non-space characters when a line is under-indented', () => {
    expect(stripFenceIndent(' x', 3)).toBe('x')
    expect(stripFenceIndent('x', 3)).toBe('x')
  })

  it('leaves lines untouched at indent 0 and preserves blanks', () => {
    expect(stripFenceIndent('npm install', 0)).toBe('npm install')
    expect(stripFenceIndent('', 3)).toBe('')
  })
})

describe('classifyAfterBlank (#1016 — loose lists)', () => {
  it('continues with the next item of the same list (same indent, same kind)', () => {
    expect(classifyAfterBlank('2. Then run the tests', 0, true)).toBe('item')
    expect(classifyAfterBlank('- another bullet', 0, false)).toBe('item')
  })

  it('continues with a deeper-indented item (nested list, #690)', () => {
    expect(classifyAfterBlank('   - nested', 0, true)).toBe('item')
  })

  it('treats indented non-item content as continuation of the current item', () => {
    expect(classifyAfterBlank('   ```bash', 0, true)).toBe('continuation')
    expect(classifyAfterBlank('   more prose for the step', 0, true)).toBe('continuation')
  })

  it('ends the list on column-0 prose or a shallower item', () => {
    expect(classifyAfterBlank('A closing paragraph.', 0, true)).toBe('end')
    expect(classifyAfterBlank('1. outer item', 3, true)).toBe('end')
  })

  it('ends the list when the marker kind flips at the same indent', () => {
    expect(classifyAfterBlank('- bullet after numbers', 0, true)).toBe('end')
    expect(classifyAfterBlank('1. number after bullets', 0, false)).toBe('end')
  })
})

describe('listStartNumber (#1016 — <ol start>)', () => {
  it('reads the number from ordered markers (dot and paren forms)', () => {
    expect(listStartNumber('1.')).toBe(1)
    expect(listStartNumber('2.')).toBe(2)
    expect(listStartNumber('7)')).toBe(7)
  })

  it('returns null for bullet markers', () => {
    expect(listStartNumber('-')).toBeNull()
    expect(listStartNumber('*')).toBeNull()
    expect(listStartNumber('+')).toBeNull()
  })
})

describe('LIST_ITEM_RE (shared with the renderer)', () => {
  it('matches ordered and bullet items with indent capture', () => {
    expect(LIST_ITEM_RE.exec('1. Install the deps:')?.[1]).toBe('')
    expect(LIST_ITEM_RE.exec('   - nested')?.[1]).toBe('   ')
  })

  it('does not match indented fence or prose continuation lines', () => {
    expect(LIST_ITEM_RE.test('   ```bash')).toBe(false)
    expect(LIST_ITEM_RE.test('   npm install')).toBe(false)
  })
})
