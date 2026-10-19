// Composer reference chips — pure logic, no DOM (node test env).

import {
  addChip,
  chipLine,
  clearChips,
  dismissChip,
  serializeChips,
  type BlueprintChipRef,
} from './composer-chips'

const NODE: BlueprintChipRef = {
  nodeId: 'module:src/cli',
  label: 'src/cli',
  kind: 'module',
}

const STORE: BlueprintChipRef = {
  nodeId: 'datastore:brain-sqlite',
  label: 'Brain index (SQLite)',
  kind: 'datastore',
}

const GHOST: BlueprintChipRef = {
  nodeId: 'integration:telegram-webhook',
  label: 'Telegram webhook',
  kind: 'integration',
  proposal: true,
}

const STORY: BlueprintChipRef = {
  nodeId: 'story:blueprint-story/initialize-board',
  label: 'Story step',
  kind: 'story',
  story: {
    plan: 'blueprint-story',
    stepId: 'initialize-board',
    title: 'Initialize the board',
  },
}

const STORY_WITH_SPACES: BlueprintChipRef = {
  nodeId: 'story:test-plan/step-2',
  label: 'Story step with spaces',
  kind: 'story',
  story: {
    plan: 'test plan',
    stepId: 'step 2',
    title: 'Step Title With Spaces',
  },
}

// Browser capture chips (Phase 6) — a chip with a `browser` payload serializes
// as `[browser: <captureKind> — <label>]`. `nodeId` carries the stable
// component-path identity (dedup + tooltip); the SERIALIZED line uses the human
// captureKind + label, never the nodeId.
const BROWSER_ELEMENT: BlueprintChipRef = {
  nodeId: 'browser:element:App > Sidebar > NavItem',
  label: 'App > Sidebar > NavItem',
  kind: 'browser',
  browser: { captureKind: 'element' },
}

const BROWSER_CONSOLE: BlueprintChipRef = {
  nodeId: 'browser:console:con-42',
  label: 'TypeError: undefined is not a function',
  kind: 'browser',
  browser: { captureKind: 'console' },
}

const BROWSER_NETWORK: BlueprintChipRef = {
  nodeId: 'browser:network:net-7',
  label: 'POST /api/login',
  kind: 'browser',
  browser: { captureKind: 'network' },
}

describe('addChip', () => {
  it('appends a chip to an empty list', () => {
    expect(addChip([], NODE)).toEqual([NODE])
  })

  it('preserves the story payload so a story step serializes as the story form (#486)', () => {
    // Guards the model path the composer's flow:blueprint-selected handler feeds:
    // a story chip must keep `story` through addChip → chipLine, not degrade to a
    // plain, plan-less [blueprint: story:<stepId> …] reference.
    const [chip] = addChip([], STORY)
    expect(chip?.story).toEqual(STORY.story)
    expect(chipLine(chip!)).toBe(
      '[blueprint story: blueprint-story/initialize-board — Initialize the board]',
    )
  })

  it('preserves insertion order', () => {
    const chips = addChip(addChip(addChip([], NODE), STORE), GHOST)
    expect(chips.map((chip) => chip.nodeId)).toEqual([
      NODE.nodeId,
      STORE.nodeId,
      GHOST.nodeId,
    ])
  })

  it('dedupes by nodeId and returns the ORIGINAL array reference', () => {
    const chips = addChip([], NODE)
    const again = addChip(chips, { ...NODE, label: 'renamed' })
    expect(again).toBe(chips)
    expect(again).toHaveLength(1)
    expect(again[0]?.label).toBe('src/cli')
  })

  it('does not mutate the input array', () => {
    const chips = addChip([], NODE)
    addChip(chips, STORE)
    expect(chips).toEqual([NODE])
  })
})

describe('dismissChip', () => {
  it('removes the chip with the given nodeId', () => {
    const chips = addChip(addChip([], NODE), STORE)
    expect(dismissChip(chips, NODE.nodeId)).toEqual([STORE])
  })

  it('returns the original array when the nodeId is absent', () => {
    const chips = addChip([], NODE)
    expect(dismissChip(chips, 'nope')).toBe(chips)
  })

  it('keeps order of the remaining chips', () => {
    const chips = addChip(addChip(addChip([], NODE), STORE), GHOST)
    expect(dismissChip(chips, STORE.nodeId).map((chip) => chip.nodeId)).toEqual([
      NODE.nodeId,
      GHOST.nodeId,
    ])
  })
})

describe('clearChips', () => {
  it('returns an empty list', () => {
    expect(clearChips()).toEqual([])
  })
})

describe('chipLine', () => {
  it('formats a node chip exactly', () => {
    expect(chipLine(NODE)).toBe('[blueprint: module:src/cli — src/cli]')
  })

  it('formats a proposal chip exactly', () => {
    expect(chipLine(GHOST)).toBe(
      '[blueprint proposal: integration:telegram-webhook — Telegram webhook]',
    )
  })

  it('formats a story chip exactly', () => {
    expect(chipLine(STORY)).toBe(
      '[blueprint story: blueprint-story/initialize-board — Initialize the board]',
    )
  })

  it('sanitizes story chip labels by collapsing whitespace', () => {
    expect(chipLine(STORY_WITH_SPACES)).toBe(
      '[blueprint story: test plan/step 2 — Step Title With Spaces]',
    )
  })

  it('sanitizes a NODE chip label so a newline cannot break the one-line contract', () => {
    const line = chipLine({ nodeId: 'module:src/x', label: 'Auth\nManager', kind: 'module' })
    expect(line).toBe('[blueprint: module:src/x — Auth Manager]')
    expect(line.split('\n')).toHaveLength(1) // exactly one line, always
  })

  it('sanitizes a PROPOSAL chip label + collapses whitespace runs', () => {
    const line = chipLine({
      nodeId: 'integration:x',
      label: 'Multi\n line   label',
      kind: 'integration',
      proposal: true,
    })
    expect(line).toBe('[blueprint proposal: integration:x — Multi line label]')
    expect(line.split('\n')).toHaveLength(1)
  })

  // An em-dash in the label is the SAME delimiter (` — `) the parser splits on,
  // so a raw "Auth — Manager" made the greedy `(.+) — (.+)` capture "<id> — Auth"
  // as the id. Downgrading the em-dash to a hyphen keeps exactly one delimiter.
  const DELIMITERS = (line: string): number => line.split(' — ').length - 1

  it('downgrades an em-dash in a NODE label so it cannot be read as the delimiter', () => {
    const line = chipLine({ nodeId: 'module:auth', label: 'Auth — Manager', kind: 'module' })
    expect(line).toBe('[blueprint: module:auth — Auth - Manager]')
    expect(DELIMITERS(line)).toBe(1) // exactly one ` — ` — the real delimiter
  })

  it('downgrades an em-dash in the nodeId too (defensive — ids are sanitized)', () => {
    const line = chipLine({ nodeId: 'module:a — b', label: 'lbl', kind: 'module' })
    expect(line).toBe('[blueprint: module:a - b — lbl]')
    expect(DELIMITERS(line)).toBe(1)
  })

  it('downgrades an em-dash in a STORY title (same delimiter contract)', () => {
    const line = chipLine({
      nodeId: 'story:p/s',
      label: 'Story step',
      kind: 'story',
      story: { plan: 'p', stepId: 's', title: 'Problem — Shape' },
    })
    expect(line).toBe('[blueprint story: p/s — Problem - Shape]')
    expect(DELIMITERS(line)).toBe(1)
  })
})

// Regression for the em-dash corruption: a chip whose label contains the
// delimiter character must survive a serialize → parse round-trip with its id
// and (sanitized) label intact — the contract agents rely on to resolve nodes.
describe('em-dash label round-trip (#delimiter-safety)', () => {
  const PARSE = /^\[blueprint( proposal)?: (.+) — (.+)\]$/
  it('parses the id and label unambiguously when the label had an em-dash', () => {
    const line = chipLine({ nodeId: 'module:auth', label: 'Auth — Manager', kind: 'module' })
    const m = PARSE.exec(line)
    expect(m?.[2]).toBe('module:auth') // id no longer swallows part of the label
    expect(m?.[3]).toBe('Auth - Manager')
  })
})

describe('serializeChips', () => {
  it('returns userText unchanged (same string) when there are no chips', () => {
    const text = 'hello there'
    expect(serializeChips([], text)).toBe(text)
  })

  it('returns userText unchanged when both are empty', () => {
    expect(serializeChips([], '')).toBe('')
  })

  it('prepends a single chip line above the text with a blank line', () => {
    expect(serializeChips([NODE], 'refactor this module')).toBe(
      '[blueprint: module:src/cli — src/cli]\n\nrefactor this module',
    )
  })

  it('serializes proposals with the proposal marker', () => {
    expect(serializeChips([GHOST], 'should we build it?')).toBe(
      '[blueprint proposal: integration:telegram-webhook — Telegram webhook]\n\nshould we build it?',
    )
  })

  it('serializes story chips', () => {
    expect(serializeChips([STORY], 'walk through the board setup')).toBe(
      '[blueprint story: blueprint-story/initialize-board — Initialize the board]\n\nwalk through the board setup',
    )
  })

  it('emits one line per chip in insertion order', () => {
    expect(serializeChips([NODE, STORE, GHOST], 'look at these')).toBe(
      '[blueprint: module:src/cli — src/cli]\n' +
        '[blueprint: datastore:brain-sqlite — Brain index (SQLite)]\n' +
        '[blueprint proposal: integration:telegram-webhook — Telegram webhook]\n' +
        '\nlook at these',
    )
  })

  it('emits mixed node + proposal + story chips in insertion order', () => {
    expect(serializeChips([NODE, GHOST, STORY], 'how do these fit?')).toBe(
      '[blueprint: module:src/cli — src/cli]\n' +
        '[blueprint proposal: integration:telegram-webhook — Telegram webhook]\n' +
        '[blueprint story: blueprint-story/initialize-board — Initialize the board]\n' +
        '\nhow do these fit?',
    )
  })

  it('emits just the chip lines (no dangling separator) for empty userText', () => {
    expect(serializeChips([NODE, GHOST], '')).toBe(
      '[blueprint: module:src/cli — src/cli]\n' +
        '[blueprint proposal: integration:telegram-webhook — Telegram webhook]',
    )
  })

  it('emits story chips without dangling separator when userText is empty', () => {
    expect(serializeChips([STORY], '')).toBe(
      '[blueprint story: blueprint-story/initialize-board — Initialize the board]',
    )
  })
})

// The serialized prefix is a parseable CONTRACT (Phase 6 documents it for
// skills/agents): every chip must survive a serialize → parse round-trip
// with its nodeId, label, and proposal flag intact, and the user text must
// come back verbatim after the blank-line separator.
describe('serialization round-trip (proposal + node mix)', () => {
  const CHIP_LINE_PATTERN = /^\[blueprint( proposal)?: (.+) — (.+)\]$/

  /** Parse a serialized message back into its chips + user text. */
  function parseSerialized(content: string): {
    chips: BlueprintChipRef[]
    userText: string
  } {
    const separatorIndex = content.indexOf('\n\n')
    const prefix = separatorIndex === -1 ? content : content.slice(0, separatorIndex)
    const userText = separatorIndex === -1 ? '' : content.slice(separatorIndex + 2)
    const chips: BlueprintChipRef[] = []
    for (const line of prefix.split('\n')) {
      const match = CHIP_LINE_PATTERN.exec(line)
      if (match === null) {
        throw new Error(`unparseable chip line: ${line}`)
      }
      const chip: BlueprintChipRef = { nodeId: match[2], label: match[3], kind: '' }
      if (match[1] !== undefined) {
        chip.proposal = true
      }
      chips.push(chip)
    }
    return { chips, userText }
  }

  it('round-trips a mixed node + proposal chip set built via addChip', () => {
    const chips = addChip(addChip(addChip([], NODE), GHOST), STORE)
    const userText = 'wire the webhook through the store'

    const { chips: parsed, userText: parsedText } = parseSerialized(
      serializeChips(chips, userText),
    )

    expect(parsedText).toBe(userText)
    expect(parsed.map((chip) => [chip.nodeId, chip.label, chip.proposal === true])).toEqual(
      chips.map((chip) => [chip.nodeId, chip.label, chip.proposal === true]),
    )
  })

  it('round-trips after dismiss + re-add, preserving the new insertion order', () => {
    let chips = addChip(addChip([], NODE), GHOST)
    chips = dismissChip(chips, NODE.nodeId)
    chips = addChip(chips, NODE) // re-added AFTER the ghost now

    const { chips: parsed } = parseSerialized(serializeChips(chips, 'x'))

    expect(parsed.map((chip) => chip.nodeId)).toEqual([GHOST.nodeId, NODE.nodeId])
    expect(parsed[0].proposal).toBe(true)
    expect(parsed[1].proposal).toBeUndefined()
  })

  it('round-trips a multi-line user text unchanged (only the FIRST blank line separates)', () => {
    const userText = 'first paragraph\n\nsecond paragraph'

    const { chips: parsed, userText: parsedText } = parseSerialized(
      serializeChips([GHOST], userText),
    )

    expect(parsed).toHaveLength(1)
    expect(parsedText).toBe(userText)
  })

  it('round-trips a chips-only message (cleared user text)', () => {
    const { chips: parsed, userText: parsedText } = parseSerialized(serializeChips([NODE, GHOST], ''))

    expect(parsedText).toBe('')
    expect(parsed.map((chip) => chip.nodeId)).toEqual([NODE.nodeId, GHOST.nodeId])
  })
})

describe('browser capture chips (Phase 6)', () => {
  it('formats an element chip as [browser: element — <componentPath>]', () => {
    expect(chipLine(BROWSER_ELEMENT)).toBe('[browser: element — App > Sidebar > NavItem]')
  })

  it('formats a console chip', () => {
    expect(chipLine(BROWSER_CONSOLE)).toBe(
      '[browser: console — TypeError: undefined is not a function]',
    )
  })

  it('formats a network chip', () => {
    expect(chipLine(BROWSER_NETWORK)).toBe('[browser: network — POST /api/login]')
  })

  it('sanitizes an em-dash in the label so it cannot be read as the delimiter', () => {
    const line = chipLine({
      nodeId: 'browser:console:con-1',
      label: 'render — crashed',
      kind: 'browser',
      browser: { captureKind: 'console' },
    })
    expect(line).toBe('[browser: console — render - crashed]')
    expect(line.split(' — ')).toHaveLength(2) // exactly one delimiter
  })

  it('collapses whitespace/newlines in the label to keep the one-line contract', () => {
    const line = chipLine({
      nodeId: 'browser:element:x',
      label: 'App >\n  Nested   Node',
      kind: 'browser',
      browser: { captureKind: 'element' },
    })
    expect(line).toBe('[browser: element — App > Nested Node]')
    expect(line.split('\n')).toHaveLength(1)
  })

  it('dedupes by the component-path identity (nodeId), keeping the first', () => {
    const chips = addChip(addChip([], BROWSER_ELEMENT), {
      ...BROWSER_ELEMENT,
      label: 'renamed same node',
    })
    expect(chips).toHaveLength(1)
    expect(chips[0]?.label).toBe('App > Sidebar > NavItem')
  })

  it('serializes browser chips prepended above the user text', () => {
    expect(serializeChips([BROWSER_NETWORK], 'why did this 500?')).toBe(
      '[browser: network — POST /api/login]\n\nwhy did this 500?',
    )
  })

  it('serializes a mix of blueprint and browser chips in insertion order', () => {
    expect(serializeChips([NODE, BROWSER_ELEMENT, GHOST], 'look')).toBe(
      '[blueprint: module:src/cli — src/cli]\n' +
        '[browser: element — App > Sidebar > NavItem]\n' +
        '[blueprint proposal: integration:telegram-webhook — Telegram webhook]\n' +
        '\nlook',
    )
  })
})

// Browser chips are a parseable contract too: [browser: <captureKind> — <label>]
// must survive serialize → parse with the captureKind and label intact, matching
// the round-trip discipline the blueprint chips already hold.
describe('browser chip serialization round-trip', () => {
  const BROWSER_LINE = /^\[browser: (.+) — (.+)\]$/

  function parseBrowserLines(content: string): { captureKind: string; label: string }[] {
    const separatorIndex = content.indexOf('\n\n')
    const prefix = separatorIndex === -1 ? content : content.slice(0, separatorIndex)
    return prefix.split('\n').map((line) => {
      const match = BROWSER_LINE.exec(line)
      if (match === null) throw new Error(`unparseable browser line: ${line}`)
      return { captureKind: match[1], label: match[2] }
    })
  }

  it('round-trips element/console/network capture kinds and labels', () => {
    const chips = [BROWSER_ELEMENT, BROWSER_CONSOLE, BROWSER_NETWORK]
    const parsed = parseBrowserLines(serializeChips(chips, ''))
    expect(parsed).toEqual([
      { captureKind: 'element', label: 'App > Sidebar > NavItem' },
      { captureKind: 'console', label: 'TypeError: undefined is not a function' },
      { captureKind: 'network', label: 'POST /api/login' },
    ])
  })
})
