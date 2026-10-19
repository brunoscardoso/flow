/**
 * Terminal UI entry point — `initTerminals(surfaces)` is wired by the
 * coordinator after the wave (never self-mounted).
 *
 * Mounts the unified terminal panel (user shells + per-thread agent
 * terminals as tabs) into the shell's terminal surface. xterm.js itself is
 * loaded lazily inside the panel on first terminal attach.
 */
import type { ShellSurfaces } from '../shell'
import { createTerminalPanel, type TerminalPanelController } from './terminal-panel'

/**
 * A no-op controller returned when the preload bridge is missing so callers
 * can always call `setActiveProject` without null-checking.
 */
const DISABLED_CONTROLLER: TerminalPanelController = {
  setActiveProject() {
    /* terminals disabled — nothing to rebind */
  },
}

export function initTerminals(surfaces: ShellSurfaces): TerminalPanelController {
  const api = window.flow
  if (!api?.terminal || !api?.project) {
    console.warn('flow: preload bridge missing — terminals disabled')
    return DISABLED_CONTROLLER
  }
  return createTerminalPanel(surfaces.terminal, api)
}
