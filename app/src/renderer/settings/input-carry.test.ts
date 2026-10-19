// Settings input-carry (#1000): a body rebuild must not destroy typed text.
// DOM-free? No — but jsdom-free too: these tests drive a hand-rolled minimal
// DOM stand-in, matching how other renderer helpers are unit-tested under the
// app's node-env jest (project memory: renderer components can't import).

import {
  CARRY_KEY_ATTR,
  captureSettingsInput,
  restoreSettingsInput,
  type CarryHost,
} from './input-carry'

/** Minimal input stand-in with just the surface the helper touches. */
class FakeInput {
  tagName = 'INPUT'
  type = 'text'
  value = ''
  selectionStart: number | null = null
  selectionEnd: number | null = null
  focused = false
  #attrs = new Map<string, string>()
  constructor(
    key: string,
    private readonly host: FakeHost,
  ) {
    this.#attrs.set(CARRY_KEY_ATTR, key)
  }
  getAttribute(name: string): string | null {
    return this.#attrs.get(name) ?? null
  }
  focus(): void {
    this.focused = true
    this.host.activeElement = this
  }
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }
}

/** Minimal ParentNode stand-in: querySelectorAll by the carry attribute. */
class FakeHost {
  activeElement: unknown = null
  inputs: FakeInput[] = []
  ownerDocument = this
  add(key: string): FakeInput {
    const input = new FakeInput(key, this)
    this.inputs.push(input)
    return input
  }
  querySelectorAll(): unknown[] {
    return this.inputs
  }
  querySelector(selector: string): unknown {
    const match = /="([^"]+)"/.exec(selector)
    const key = match?.[1] ?? ''
    return this.inputs.find((i) => i.getAttribute(CARRY_KEY_ATTR) === key) ?? null
  }
}

const hostOf = (h: FakeHost): CarryHost => h as unknown as CarryHost

describe('captureSettingsInput / restoreSettingsInput (#1000)', () => {
  it('carries a half-typed value across a rebuild', () => {
    const before = new FakeHost()
    const typed = before.add('accounts.addLabel')
    typed.value = 'Acme C'

    const carried = captureSettingsInput(hostOf(before))
    expect(carried).toHaveLength(1)

    // The rebuild produces a FRESH, empty field with the same key.
    const after = new FakeHost()
    const rebuilt = after.add('accounts.addLabel')
    restoreSettingsInput(hostOf(after), carried)
    expect(rebuilt.value).toBe('Acme C')
  })

  it('restores focus and caret ONLY for the field that had focus', () => {
    const before = new FakeHost()
    const focused = before.add('a')
    focused.value = 'hello'
    focused.selectionStart = 2
    focused.selectionEnd = 2
    before.activeElement = focused
    const unfocused = before.add('b')
    unfocused.value = 'world'

    const carried = captureSettingsInput(hostOf(before))
    const after = new FakeHost()
    const a = after.add('a')
    const b = after.add('b')
    restoreSettingsInput(hostOf(after), carried)

    expect(a.value).toBe('hello')
    expect(a.focused).toBe(true)
    expect(a.selectionStart).toBe(2)
    expect(b.value).toBe('world')
    expect(b.focused).toBe(false) // a rebuild never STEALS focus (#1045 rule)
  })

  it('skips empty unfocused fields so a rebuild default is never clobbered', () => {
    const before = new FakeHost()
    before.add('empty')
    expect(captureSettingsInput(hostOf(before))).toEqual([])
  })

  it('carries an empty value when that field is focused (deliberate clear)', () => {
    const before = new FakeHost()
    const cleared = before.add('k')
    before.activeElement = cleared
    const carried = captureSettingsInput(hostOf(before))
    expect(carried).toHaveLength(1)

    const after = new FakeHost()
    const rebuilt = after.add('k')
    rebuilt.value = 'stale default'
    restoreSettingsInput(hostOf(after), carried)
    expect(rebuilt.value).toBe('')
  })

  it('drops carried entries whose field no longer exists', () => {
    const before = new FakeHost()
    const gone = before.add('vanishing')
    gone.value = 'text'
    const carried = captureSettingsInput(hostOf(before))
    // Rebuild without that field — must not throw.
    expect(() => restoreSettingsInput(hostOf(new FakeHost()), carried)).not.toThrow()
  })
})
