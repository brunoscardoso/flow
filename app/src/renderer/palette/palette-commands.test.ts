import type { SlashCommand } from '../../shared/ipc-contract'
import {
  buildStaticCommands,
  foldSlashCommands,
  loadPaletteCommands,
  PALETTE_COMMAND_SPECS,
  type PaletteEmit,
} from './palette-commands'

describe('palette command registry', () => {
  it('every static spec has a unique id, a label, and a flow: event', () => {
    const ids = new Set<string>()
    for (const spec of PALETTE_COMMAND_SPECS) {
      expect(spec.label.length).toBeGreaterThan(0)
      expect(spec.event.startsWith('flow:')).toBe(true)
      expect(ids.has(spec.id)).toBe(false)
      ids.add(spec.id)
    }
  })

  it('buildStaticCommands binds each spec run to its event via the injected emitter', () => {
    const calls: Array<[string, unknown]> = []
    const emit: PaletteEmit = (type, detail) => calls.push([type, detail])
    const commands = buildStaticCommands(emit)

    expect(commands).toHaveLength(PALETTE_COMMAND_SPECS.length)
    // "New thread" creates a THREAD (flow:new-thread), distinct from "New task"
    // (flow:new-task) — they were previously conflated.
    const newThread = commands.find((c) => c.label === 'New thread')
    expect(newThread).toBeDefined()
    newThread!.run()
    expect(calls).toContainEqual(['flow:new-thread', undefined])

    const newTask = commands.find((c) => c.label === 'New task')
    expect(newTask).toBeDefined()
    newTask!.run()
    expect(calls).toContainEqual(['flow:new-task', undefined])

    // "Toggle Chat" is the discoverable recovery for a ⌘⌥C-hidden Chat panel
    // (#967/#1071) — it must fire the shell's flow:toggle-chat listener.
    const toggleChat = commands.find((c) => c.label === 'Toggle Chat')
    expect(toggleChat).toBeDefined()
    toggleChat!.run()
    expect(calls).toContainEqual(['flow:toggle-chat', undefined])
  })

  it('carries a per-command icon (not a blanket command glyph)', () => {
    const byId = new Map(buildStaticCommands(() => undefined).map((c) => [c.id, c.icon]))
    expect(byId.get('cmd:new-file')).toBe('file')
    expect(byId.get('cmd:new-task')).toBe('checklist')
    expect(byId.get('cmd:open-blueprint')).toBe('map')
  })

  it('folds slash commands into /name commands that prefill the composer', () => {
    const calls: Array<[string, unknown]> = []
    const emit: PaletteEmit = (type, detail) => calls.push([type, detail])
    const discovered: SlashCommand[] = [{ name: 'review-pr', description: 'Review a PR' }]

    const folded = foldSlashCommands(discovered, emit)
    expect(folded).toEqual([
      expect.objectContaining({ id: 'slash:review-pr', label: '/review-pr', hint: 'Review a PR' }),
    ])
    folded[0].run()
    // compose-prompt so a chat is created when none is open (not prefill-composer).
    expect(calls).toEqual([['flow:compose-prompt', { text: '/review-pr ' }]])
  })

  it('loadPaletteCommands appends folded slash commands after the static registry', async () => {
    const emit: PaletteEmit = () => undefined
    const listCommands = async (): Promise<SlashCommand[]> => [
      { name: 'note', description: 'Capture a note' },
    ]
    const all = await loadPaletteCommands(emit, listCommands)
    expect(all).toHaveLength(PALETTE_COMMAND_SPECS.length + 1)
    expect(all[all.length - 1].label).toBe('/note')
  })

  it('loadPaletteCommands is fail-soft — a rejecting loader yields only static commands', async () => {
    const emit: PaletteEmit = () => undefined
    const listCommands = async (): Promise<SlashCommand[]> => {
      throw new Error('IPC down')
    }
    const all = await loadPaletteCommands(emit, listCommands)
    expect(all).toHaveLength(PALETTE_COMMAND_SPECS.length)
  })
})
