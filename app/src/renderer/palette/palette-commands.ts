// Command registry for the palette (⌘P command mode + blended content mode).
// DOM-free: the registry maps labels to the app's existing decoupled
// CustomEvents as DATA, and the `run` closures fire through an INJECTED emitter
// rather than touching `document` directly. That keeps this module importable
// under node-env jest (no DOM lib) so the registry shape and slash-command
// folding can be unit-tested by passing a fake emitter.
//
// The VIEW (command-palette.ts) supplies the live emitter — a thin wrapper over
// document.dispatchEvent — when it builds the command list.

import type { SlashCommand } from '../../shared/ipc-contract'

/** One actionable command row. `run` fires the command's effect; `hint` is the
 *  optional secondary text (a slash command's description). */
export interface PaletteCommand {
  id: string
  label: string
  hint?: string
  /** fl-icon name for the row (defaults applied by the view when absent). */
  icon?: string
  run: () => void
}

/** Emits an app CustomEvent by name with an optional detail payload. The view
 *  binds this to document.dispatchEvent; tests pass a spy. */
export type PaletteEmit = (type: string, detail?: unknown) => void

/** A static command as data — resolved into a {@link PaletteCommand} by binding
 *  the emitter. Keeping the event/detail as data is what makes this DOM-free. */
interface CommandSpec {
  id: string
  label: string
  /** fl-icon name matching what the command does (not a blanket command glyph). */
  icon: string
  event: string
  detail?: unknown
}

/**
 * The curated static registry: labels → the decoupled events the app already
 * listens for. One typed list so it can't silently drift from the real surfaces.
 */
export const PALETTE_COMMAND_SPECS: readonly CommandSpec[] = [
  // Primary create / navigation actions, in the intended order (the ranker
  // preserves this registry order for the empty command list — see palette-rank).
  { id: 'cmd:new-thread', label: 'New thread', icon: 'message', event: 'flow:new-thread' },
  { id: 'cmd:new-file', label: 'New file', icon: 'file', event: 'flow:new-file' },
  { id: 'cmd:open-blueprint', label: 'Open Blueprint', icon: 'map', event: 'flow:open-blueprint' },
  { id: 'cmd:open-board', label: 'Open Tasks', icon: 'checklist', event: 'flow:open-board' },
  { id: 'cmd:open-changes', label: 'Open Changes', icon: 'pencil', event: 'flow:open-change-review' },
  // New terminal REVEALS the terminal panel (flow:show-terminal), not just
  // flow:terminal-new — otherwise the shell starts but stays hidden.
  { id: 'cmd:new-terminal', label: 'New terminal', icon: 'terminal', event: 'flow:show-terminal' },
  // #1133: side-by-side terminals. #1313: the handler REVEALS the panel first
  // — the claim that once stood here (that the panel is always open when there
  // is something to split) was false, because ⌃`/⌘J removes the panel while
  // every PTY stays alive, and the split then happened off screen.
  {
    id: 'cmd:split-terminal',
    label: 'Split terminal',
    icon: 'split-horizontal',
    event: 'flow:terminal-split',
  },
  // The debug button lives in the BROWSER toolbar, so this is how a session is
  // started from anywhere else — the tab you happen to be on should not decide
  // whether you can record what you are about to do.
  {
    id: 'cmd:debug-session',
    label: 'Start or finish a debug session',
    icon: 'record',
    event: 'flow:debug-toggle',
  },
  // Secondary actions.
  { id: 'cmd:new-task', label: 'New task', icon: 'checklist', event: 'flow:new-task' },
  { id: 'cmd:reveal-sidebar', label: 'Reveal Sidebar', icon: 'folder', event: 'flow:reveal-sidebar' },
  // A hidden Chat panel must never be recoverable by shortcut (⌘⌥C) only —
  // this is the discoverable way back (#967/#1071).
  { id: 'cmd:toggle-chat', label: 'Toggle Chat', icon: 'message', event: 'flow:toggle-chat' },
  { id: 'cmd:show-git', label: 'Show Git', icon: 'refresh', event: 'flow:show-git' },
  { id: 'cmd:show-review', label: 'Show Review', icon: 'check', event: 'flow:show-review' },
  { id: 'cmd:open-integrations', label: 'Open Integrations', icon: 'plus', event: 'flow:open-integrations' },
  { id: 'cmd:open-learning', label: 'Open Learning', icon: 'sparkles', event: 'flow:open-learning-panel' },
  // Blueprint actions that had handlers but no discoverable entry point — the
  // board's own chrome shows them only in specific states (Fit appears once
  // the camera is off rest; the wires toggle only on the code-map stage).
  { id: 'cmd:blueprint-fit', label: 'Blueprint: Fit to View', icon: 'map', event: 'flow:blueprint-fit' },
  {
    id: 'cmd:blueprint-wires',
    label: 'Blueprint: Toggle Connection Wires',
    icon: 'split-horizontal',
    event: 'flow:blueprint-toggle-wires',
  },
  { id: 'cmd:blueprint-drift', label: 'Blueprint: Show Drift', icon: 'refresh', event: 'flow:blueprint-drift' },
  { id: 'cmd:open-settings', label: 'Open Settings', icon: 'settings', event: 'flow:open-settings' },
  { id: 'cmd:open-flow-settings', label: 'Open Flow Settings', icon: 'settings', event: 'flow:open-flow-settings' },
]

/** Resolve the static specs into runnable commands bound to `emit`. */
export function buildStaticCommands(emit: PaletteEmit): PaletteCommand[] {
  return PALETTE_COMMAND_SPECS.map((spec) => ({
    id: spec.id,
    label: spec.label,
    icon: spec.icon,
    run: () => emit(spec.event, spec.detail),
  }))
}

/**
 * Fold discovered slash commands into palette commands whose `run` prefills the
 * composer with the command text (`/name `) via flow:prefill-composer — the same
 * event the composer already listens on.
 */
export function foldSlashCommands(
  discovered: readonly SlashCommand[],
  emit: PaletteEmit,
): PaletteCommand[] {
  return discovered.map((command) => ({
    id: `slash:${command.name}`,
    label: `/${command.name}`,
    hint: command.description,
    icon: 'sparkles',
    // flow:compose-prompt (not prefill-composer directly) so the thread system
    // creates a chat first when none is open — otherwise a slash command only
    // worked with a chat already open.
    run: () => emit('flow:compose-prompt', { text: `/${command.name} ` }),
  }))
}

/**
 * Build the full command list: the static registry plus discovered slash
 * commands. `listCommands` is injected (the view binds it to
 * window.flow.project.listCommands) and is fail-soft — a rejection yields just
 * the static commands rather than an empty palette.
 */
export async function loadPaletteCommands(
  emit: PaletteEmit,
  listCommands: () => Promise<SlashCommand[]>,
): Promise<PaletteCommand[]> {
  let discovered: SlashCommand[] = []
  try {
    discovered = await listCommands()
  } catch {
    discovered = []
  }
  return [...buildStaticCommands(emit), ...foldSlashCommands(discovered, emit)]
}
