// settings-fields — the shared row renderer, driven against a hand-rolled DOM.
//
// jsdom-free on purpose: the app's jest runs node-env and its tsconfig omits the
// DOM lib, which is exactly why these builders are typed against the minimal
// structural interfaces they are. The stand-in below implements only what they
// touch — the same idiom as input-carry.test.ts.

import { fieldForSetting, ownedEditingSource, type FieldDef } from './flow-settings-model'
import {
  renderFieldRow,
  renderWarnings,
  type FieldDocument,
  type FieldNode,
} from './settings-fields'

class FakeNode implements FieldNode {
  className = ''
  textContent: string | null = ''
  hidden = false
  disabled = false
  type = ''
  value = ''
  placeholder = ''
  min = ''
  max = ''
  dataset: Record<string, string | undefined> = {}
  attributes: Record<string, string> = {}
  children: FakeNode[] = []
  listeners = new Map<string, Array<() => void>>()
  constructor(readonly tag: string) {}
  appendChild(child: FieldNode): void {
    this.children.push(child as FakeNode)
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value
  }
  addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
  /** Depth-first search for the first node matching a class. */
  find(className: string): FakeNode | null {
    for (const child of this.children) {
      if (child.className.split(' ').includes(className)) return child
      const nested = child.find(className)
      if (nested !== null) return nested
    }
    return null
  }
  all(tag: string): FakeNode[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.all(tag),
    ])
  }
}

const doc: FieldDocument = { createElement: (tag: string) => new FakeNode(tag) }

// THE SHAPES, NOT THE SETTINGS. This file is about `renderFieldRow`, which
// renders four kinds of control; the fields below are the real ones that still
// carry each kind, so the row is exercised against something the app actually
// ships rather than against a fixture that can drift from it.
const toggle = fieldForSetting('threadWorktrees') as FieldDef
const text = fieldForSetting('worktreeSetup') as FieldDef
const count = fieldForSetting('worktreeCap') as FieldDef

// EXCEPT THE SELECT, which no shipped field is any more: the one that was
// (where a new checkout starts from) went with the surfaces that read it
// (worktree-ui-removal Phase 5, task 5.4). The renderer still supports the
// shape — a choice that carries a name is a real control with real rules — so
// the tests below keep exercising it against a declaration of exactly that
// shape. If a select field comes back to the panel, this goes and the real one
// takes its place.
const choice: FieldDef = {
  key: 'a_choice',
  label: 'A choice that carries a name',
  type: 'select',
  setting: 'threadWorktrees',
  options: [
    { value: 'here', label: 'Here' },
    { value: 'trunk', label: 'The default' },
    { value: 'branch', label: 'A branch I name', companion: { placeholder: 'branch name' } },
  ],
}

describe('a plain row', () => {
  it('draws the label, the help and the control', () => {
    const changes: unknown[] = []
    const row = renderFieldRow(doc, toggle, { value: true }, { onChange: (v) => changes.push(v) })
    const node = row.row as FakeNode
    expect(node.find('fl-fs-name')?.textContent).toBe(toggle.label)
    expect(node.find('fl-fs-help')?.textContent).toBe(toggle.help)
    expect((row.control as FakeNode).attributes.role).toBe('switch')
    expect((row.control as FakeNode).className).toContain('on')
  })

  it('reports a flipped switch as the opposite of what it shows', () => {
    const changes: unknown[] = []
    const row = renderFieldRow(doc, toggle, { value: true }, { onChange: (v) => changes.push(v) })
    ;(row.control as FakeNode).fire('click')
    expect(changes).toEqual([false])
    row.update({ value: false })
    ;(row.control as FakeNode).fire('click')
    expect(changes).toEqual([false, true])
  })

  it('shows nothing about provenance for a field that has only one layer', () => {
    const row = renderFieldRow(doc, toggle, { value: true }, { onChange: () => undefined })
    const node = row.row as FakeNode
    expect(node.find('fl-fs-chip')?.hidden).toBe(true)
    expect(node.all('button').some((b) => b.className === 'fl-fs-inherit')).toBe(false)
  })

  // The patch path passes `keepControlValue: true` when the changed control is
  // the active element — meant to protect a half-typed text field. A toggle has
  // no half-typed state: clicking it makes it `document.activeElement`, so this
  // flag was set on its very own patch and left the switch showing the OLD state
  // even though the new value was already written ("can't check Auto-create PR").
  it('repaints a toggle even when the patch says keep the control value', () => {
    const row = renderFieldRow(doc, toggle, { value: false }, { onChange: () => undefined })
    expect((row.control as FakeNode).className).not.toContain('on')
    row.update({ value: true }, { keepControlValue: true })
    expect((row.control as FakeNode).className).toContain('on')
    expect((row.control as FakeNode).attributes['aria-checked']).toBe('true')
  })
})

describe('an inheritable row', () => {
  function build(source: 'project' | 'global' | 'default') {
    const inherits: boolean[] = []
    const row = renderFieldRow(
      doc,
      text,
      { value: 'origin', source },
      { onChange: () => undefined, onInherit: (useProject) => inherits.push(useProject) },
    )
    return { row, node: row.row as FakeNode, inherits }
  }

  it('names where an inherited value came from and locks the control', () => {
    const { row, node } = build('global')
    expect(node.find('fl-fs-chip')?.textContent).toBe('Inherited from your defaults')
    expect(node.find('fl-fs-chip')?.hidden).toBe(false)
    expect((row.control as FakeNode).disabled).toBe(true)
    expect(node.find('fl-fs-inherit')?.textContent).toBe('Use a project value')
    expect(node.className).toContain('inherited')
  })

  it('badges a project value not at all, and offers to hand it back', () => {
    const { row, node } = build('project')
    expect(node.find('fl-fs-chip')?.hidden).toBe(true)
    expect((row.control as FakeNode).disabled).toBe(false)
    expect(node.find('fl-fs-inherit')?.textContent).toBe('Inherit')
  })

  it('presses in the direction the row is currently showing', () => {
    const { node, inherits, row } = build('default')
    node.find('fl-fs-inherit')?.fire('click')
    expect(inherits).toEqual([true]) // take it over
    row.update({ value: 'origin', source: 'project' })
    node.find('fl-fs-inherit')?.fire('click')
    expect(inherits).toEqual([true, false]) // …and hand it back
  })

  it('follows a change of provenance without being rebuilt', () => {
    const { row, node } = build('default')
    const control = row.control
    row.update({ value: 'upstream', source: 'project' })
    expect(row.control).toBe(control) // same node — no rebuild (#1032)
    expect((control as FakeNode).value).toBe('upstream')
    expect(node.find('fl-fs-chip')?.hidden).toBe(true)
  })

  it('leaves a field alone while it is being typed in', () => {
    const { row } = build('project')
    const control = row.control as FakeNode
    control.value = 'half-typed'
    row.update({ value: 'origin', source: 'project' }, { keepControlValue: true })
    expect(control.value).toBe('half-typed')
    row.update({ value: 'origin', source: 'project' })
    expect(control.value).toBe('origin')
  })
})

describe('a choice that carries a name', () => {
  it('hides the name box until the choice needs one', () => {
    const row = renderFieldRow(doc, choice, { value: 'here' }, { onChange: () => undefined })
    expect(row.companion?.hidden).toBe(true)
    row.update({ value: 'branch:dev' })
    expect(row.companion?.hidden).toBe(false)
    expect(row.companion?.value).toBe('dev')
    expect((row.control as FakeNode).value).toBe('branch')
  })

  it('writes the choice and the name as one value', () => {
    const changes: unknown[] = []
    const row = renderFieldRow(doc, choice, { value: 'here' }, { onChange: (v) => changes.push(v) })
    const select = row.control as FakeNode
    const companion = row.companion as FakeNode
    select.value = 'branch'
    select.fire('change')
    expect(changes).toEqual(['branch:'])
    companion.value = 'release/2.0'
    companion.fire('change')
    expect(changes[1]).toBe('branch:release/2.0')
  })

  it('offers every choice the field declares, in order', () => {
    const row = renderFieldRow(doc, choice, { value: 'here' }, { onChange: () => undefined })
    expect((row.control as FakeNode).children.map((option) => option.value)).toEqual([
      'here',
      'trunk',
      'branch',
    ])
  })
})

describe('a number a person types', () => {
  it('clamps an out-of-range entry and writes the corrected value back (#369)', () => {
    const changes: unknown[] = []
    const row = renderFieldRow(doc, count, { value: 8 }, { onChange: (v) => changes.push(v) })
    const input = row.control as FakeNode
    input.value = '999'
    input.fire('change')
    expect(input.value).toBe('100')
    expect(changes).toEqual([100])
  })

  it('reverts a cleared entry to what was in effect', () => {
    const changes: unknown[] = []
    const row = renderFieldRow(doc, count, { value: 12 }, { onChange: (v) => changes.push(v) })
    const input = row.control as FakeNode
    input.value = ''
    input.fire('change')
    expect(changes).toEqual([12])
  })
})

describe('what a row says about the value and the state', () => {
  it('shows a refusal and a warning differently', () => {
    const row = renderFieldRow(doc, text, { value: 'x' }, { onChange: () => undefined })
    const node = row.row as FakeNode
    row.update({ value: 'x', validation: { refusal: 'nope' } })
    expect(node.find('fl-fs-message')?.textContent).toBe('nope')
    expect(node.find('fl-fs-message')?.className).toContain('refusal')
    row.update({ value: 'x', validation: { warning: 'heads up' } })
    expect(node.find('fl-fs-message')?.className).toContain('warning')
    row.update({ value: 'x', validation: { ok: true } })
    expect(node.find('fl-fs-message')?.hidden).toBe(true)
  })

  it('shows a note only while there is one to show', () => {
    const row = renderFieldRow(doc, toggle, { value: true }, { onChange: () => undefined })
    const node = row.row as FakeNode
    expect(node.find('fl-fs-note')?.hidden).toBe(true)
    row.update({ value: false, note: 'they keep their files' })
    expect(node.find('fl-fs-note')?.textContent).toBe('they keep their files')
    expect(node.find('fl-fs-note')?.hidden).toBe(false)
  })
})

describe('renderWarnings', () => {
  it('draws nothing when there is nothing to say', () => {
    expect(renderWarnings(doc, [])).toBeNull()
  })

  it('renders each sentence verbatim, one per line', () => {
    const box = renderWarnings(doc, ['One thing.', 'Another thing.']) as FakeNode
    expect(box.children.map((line) => line.textContent)).toEqual(['One thing.', 'Another thing.'])
  })
})

describe('a row taken over while it was blank (Phase 6 finding)', () => {
  // The base branch inherits as NOTHING, so the take-over that used to write
  // the blank on screen wrote a key the resolver reads as absent and the row
  // snapped back to inherited. The panel now owns the row locally until a real
  // value is typed; this is what that looks like on screen.
  function build(source: 'project' | 'global' | 'default') {
    const inherits: boolean[] = []
    const changes: unknown[] = []
    const row = renderFieldRow(
      doc,
      text,
      { value: '', source },
      { onChange: (v) => changes.push(v), onInherit: (useProject) => inherits.push(useProject) },
    )
    return { row, node: row.row as FakeNode, inherits, changes }
  }

  it('starts locked, badged and offering to be taken over', () => {
    const { row, node } = build('default')
    expect((row.control as FakeNode).disabled).toBe(true)
    expect(node.find('fl-fs-chip')?.textContent).toBe("Flow's default")
    expect(node.find('fl-fs-inherit')?.textContent).toBe('Use a project value')
  })

  it('becomes editable, unbadged and blank once the panel owns it', () => {
    const { row, node, inherits } = build('default')
    node.find('fl-fs-inherit')?.fire('click')
    expect(inherits).toEqual([true])
    // What the panel patches back while nothing has been written yet.
    row.update({ value: '', source: ownedEditingSource('project') })
    expect((row.control as FakeNode).disabled).toBe(false)
    expect((row.control as FakeNode).value).toBe('')
    expect(node.find('fl-fs-chip')?.hidden).toBe(true)
    expect(node.find('fl-fs-inherit')?.textContent).toBe('Inherit')
    expect(node.className).not.toContain('inherited')
  })

  it('reports the first real value typed into it', () => {
    const { row, changes } = build('default')
    row.update({ value: '', source: ownedEditingSource('project') })
    const control = row.control as FakeNode
    control.value = 'release/2.0'
    control.fire('change')
    expect(changes).toEqual(['release/2.0'])
  })

  it('presses back in the handing-back direction while it is owned', () => {
    const { row, node, inherits } = build('global')
    node.find('fl-fs-inherit')?.fire('click')
    row.update({ value: '', source: ownedEditingSource('project') })
    node.find('fl-fs-inherit')?.fire('click')
    expect(inherits).toEqual([true, false])
  })

  it('draws the same owned state on the defaults panel, in its own words', () => {
    const row = renderFieldRow(
      doc,
      text,
      { value: '', source: ownedEditingSource('global'), layer: 'global' },
      { onChange: () => undefined, onInherit: () => undefined },
    )
    const node = row.row as FakeNode
    expect((row.control as FakeNode).disabled).toBe(false)
    expect(node.find('fl-fs-chip')?.hidden).toBe(true)
    expect(node.find('fl-fs-inherit')?.textContent).toBe("Use Flow's default")
  })
})

describe('the same row on two panels, each speaking for its own layer', () => {
  // The project panel inherits anything it did not write; the defaults panel
  // has only the built-in beneath it, so a `global` value IS its own. Reading
  // `source !== 'project'` there would grey out every default a person set.
  function build(source: 'project' | 'global' | 'default', layer: 'project' | 'global') {
    const chips: string[] = []
    const row = renderFieldRow(
      doc,
      text,
      { value: 'origin', source, layer },
      {
        onChange: () => undefined,
        onInherit: () => undefined,
        onChipAction: () => chips.push('opened'),
      },
    )
    return { row, node: row.row as FakeNode, chips }
  }

  it('reads a default as inherited on the project panel, and offers a door to it', () => {
    const { row, node, chips } = build('global', 'project')
    expect((row.control as FakeNode).disabled).toBe(true)
    expect(node.find('fl-fs-chip')?.textContent).toBe('Inherited from your defaults')
    expect(node.find('fl-fs-inherit')?.textContent).toBe('Use a project value')
    const action = node.find('fl-fs-chip-action')
    expect(action?.hidden).toBe(false)
    expect(action?.textContent).toBe('Open defaults')
    action?.fire('click')
    expect(chips).toEqual(['opened'])
  })

  it('reads the SAME default as owned on the defaults panel', () => {
    const { row, node } = build('global', 'global')
    expect((row.control as FakeNode).disabled).toBe(false)
    expect(node.find('fl-fs-chip')?.hidden).toBe(true)
    expect(node.find('fl-fs-inherit')?.textContent).toBe("Use Flow's default")
    expect(node.className).not.toContain('inherited')
  })

  it('reads the built-in as inherited on the defaults panel, in that panel’s words', () => {
    const { row, node } = build('default', 'global')
    expect((row.control as FakeNode).disabled).toBe(true)
    expect(node.find('fl-fs-chip')?.textContent).toBe("Flow's default")
    expect(node.find('fl-fs-inherit')?.textContent).toBe('Set my own default')
  })

  it('offers the chip’s door ONLY where it leads somewhere', () => {
    // "Flow's default" leads nowhere, and the defaults panel is already the
    // place the door would open.
    for (const [source, layer] of [
      ['default', 'project'],
      ['project', 'project'],
      ['global', 'global'],
      ['default', 'global'],
    ] as const) {
      expect(build(source, layer).node.find('fl-fs-chip-action')?.hidden).toBe(true)
    }
  })

  it('follows a layer change on a patch, without a rebuild', () => {
    const { row, node } = build('global', 'project')
    const control = row.control
    row.update({ value: 'origin', source: 'global', layer: 'global' })
    expect(row.control).toBe(control)
    expect((control as FakeNode).disabled).toBe(false)
    expect(node.find('fl-fs-chip')?.hidden).toBe(true)
  })
})

describe('what every rendered string may not carry (forbidden-pattern #12)', () => {
  it('never puts a command, a path or a config key on a row', () => {
    const strings: string[] = []
    for (const field of [toggle, text, count, choice]) {
      for (const [source, layer] of [
        ['default', 'project'],
        ['global', 'project'],
        ['project', 'project'],
        ['default', 'global'],
        ['global', 'global'],
      ] as const) {
        const row = renderFieldRow(
          doc,
          field,
          {
            value: field.type === 'toggle' ? false : field.type === 'number' ? 8 : '',
            source,
            layer,
            note: 'x',
          },
          { onChange: () => undefined, onInherit: () => undefined, onChipAction: () => undefined },
        )
        collect(row.row as FakeNode, strings)
      }
    }
    expect(strings.length).toBeGreaterThan(0)
    for (const text of strings) {
      expect(text).not.toContain('planflow-ai')
      expect(text).not.toContain('.flowconfig')
      expect(text).not.toContain('`')
      expect(text).not.toContain('--')
      // No key spellings: every one of these settings' keys carries an
      // underscore, so one appearing in prose is a key that leaked.
      expect(text).not.toContain('_')
    }
  })

  /** Every word a reader would see under this node, label and control alike. */
  function collect(node: FakeNode, into: string[]): void {
    if (node.textContent !== null && node.textContent !== '') into.push(node.textContent)
    if (node.placeholder !== '') into.push(node.placeholder)
    for (const child of node.children) collect(child, into)
  }
})
