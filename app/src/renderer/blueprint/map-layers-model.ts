// WHAT THE MAP SHOWS — the Layers button (mockup J3, user pick 2026-11-15).
//
// Three decorations used to live on three controls, each mixed with a second
// job: the Connections tile both drew the lines and started learning them; the
// Learn tile both coloured the map and hosted the learning panel; the
// changeset chip lit the changed files from the header. They are one question
// — "what is the map coloured by" — and the answer is ONE choice at a time:
//
//   · Just the map
//   · Connections — the lines between projects, where they exist here
//   · Learning    — every cell's learned ground
//   · Changes     — the changed files, only while there is a changeset
//
// CHANGES IS AMBIENT, as the chip was (#898): while a changeset exists and was
// not dismissed it IS the layer. Choosing another layer dismisses it for THIS
// changeset (resolveChangesetMode's fingerprint); a new changeset re-arms it.
// So Changes is never stored — the stored choice is what the map goes back to.
//
// DOM-free so it runs under the CJS node jest.

export type MapLayer = 'map' | 'connections' | 'learning' | 'changes'
/** What a viewer's stored choice can be — Changes belongs to one changeset. */
export type ChosenLayer = Exclude<MapLayer, 'changes'>

/** Where the choice is remembered — this viewer's own preference. */
export const MAP_LAYER_PREF = 'flow.blueprint.mapLayer'
/** The Workspace Connections toggle's old key, still read so "on" carries over. */
export const LEGACY_CONNECTIONS_PREF = 'flow.blueprint.workspace.connections'

const CHOSEN: readonly ChosenLayer[] = ['map', 'connections', 'learning']

/**
 * The stored choice, migrating the old Connections toggle: a viewer who had
 * Connections on keeps seeing them. Anything unreadable is the plain map.
 */
export function readLayerPref(stored: string | null, legacyConnections: string | null): ChosenLayer {
  if (stored !== null && (CHOSEN as readonly string[]).includes(stored)) return stored as ChosenLayer
  if (legacyConnections === 'on') return 'connections'
  return 'map'
}

export interface MapLayersInput {
  /** Connections where they exist here; null when this view has none. `count` null = unreadable. */
  connections: { count: number | null; unreadableReason?: string } | null
  /** The view's understood share, 0–100, or null when nothing is measured. */
  understood: number | null
  /** The changeset, or null when the tree is clean (or this view cannot light it). */
  changes: { files: number; dismissed: boolean } | null
  chosen: ChosenLayer
}

export interface MapLayerOption {
  id: MapLayer
  label: string
  /** The small figure beside the label: a count, a percentage, or null. */
  figure: string | null
  disabled: boolean
  /** What choosing it does, in words. */
  title: string
}

export interface MapLayersView {
  options: MapLayerOption[]
  /** The layer the map is showing now. */
  current: MapLayer
  /** The button's own words — the current layer's name. */
  buttonLabel: string
  /** The learning key (what the colours mean) rides with the Learning layer. */
  showKey: boolean
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`
}

export function mapLayersView(input: MapLayersInput): MapLayersView {
  const options: MapLayerOption[] = [
    { id: 'map', label: 'Just the map', figure: null, disabled: false, title: 'Show the map with nothing over it' },
  ]
  if (input.connections !== null) {
    const unreadable = input.connections.count === null
    options.push({
      id: 'connections',
      label: 'Connections',
      figure: unreadable ? null : String(input.connections.count),
      disabled: unreadable,
      title: unreadable
        ? (input.connections.unreadableReason ?? "The connections couldn't be read.")
        : 'Draw how these projects connect',
    })
  }
  options.push({
    id: 'learning',
    label: 'Learning',
    figure: input.understood === null ? null : `${String(input.understood)}%`,
    disabled: false,
    title: 'Colour the map by how much of each part has been learned',
  })
  const changes = input.changes !== null && input.changes.files > 0 ? input.changes : null
  if (changes !== null) {
    options.push({
      id: 'changes',
      label: 'Changes',
      figure: plural(changes.files, 'file'),
      disabled: false,
      title: `Light the ${plural(changes.files, 'changed file')}`,
    })
  }
  const offered = (id: MapLayer): boolean => options.some((option) => option.id === id && !option.disabled)
  let current: MapLayer = 'map'
  if (changes !== null && !changes.dismissed) current = 'changes'
  else if (offered(input.chosen)) current = input.chosen
  const label = options.find((option) => option.id === current)?.label ?? 'Just the map'
  return { options, current, buttonLabel: current === 'map' ? 'Map' : label, showKey: current === 'learning' }
}

export interface LayerChoice {
  /** The choice to remember, or null to keep the stored one. */
  store: ChosenLayer | null
  /** Dismiss the current changeset (another layer was chosen over it). */
  dismissChanges: boolean
  /** Bring the changeset back (Changes was chosen). */
  restoreChanges: boolean
}

/** What picking `picked` from the menu does. */
export function chooseLayer(picked: MapLayer, view: MapLayersView): LayerChoice {
  if (picked === 'changes') return { store: null, dismissChanges: false, restoreChanges: true }
  return { store: picked, dismissChanges: view.current === 'changes', restoreChanges: false }
}
