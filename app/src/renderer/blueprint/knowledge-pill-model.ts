// IS THE KNOWLEDGE FRESH — the Knowledge pill (mockup J3, user pick 2026-11-15).
//
// One small pill at the map's bottom right answers "can this map be trusted":
// a ring dial of the share understood, "N% understood", and ONE short second
// line with the most useful thing to know now. It absorbs the learn chip (and
// its out-of-sync dot), the Learn tile and the connections learning line.
// Pressing it opens the Learning panel, which stays the one place for Re-check
// all and per-module progress; this model also says what the panel's
// Connections section offers (Learn / progress / Update connections).
//
// The pill never changes what the map is coloured by — that is Layers' job.
//
// DOM-free so it runs under the CJS node jest.

import { understoodPercent } from '../../shared/understood'

export type ConnectionsState =
  | { mode: 'unreadable' }
  | { mode: 'learning'; percent: number | null; title: string }
  | { mode: 'learn'; title: string }
  | { mode: 'none'; title: string }
  | { mode: 'toggle'; count: number; pending: number; updateTitle: string | null; lastCheckedAt: string | null }

export interface KnowledgePillInput {
  /** The view's understood fraction (features, or a level's parts). */
  understood: { done: number; total: number } | null
  /** The project's modules, when a project's learning is known. */
  modules: { learned: number; total: number; stale: number } | null
  /** A module learning pass: running/queued counts and the module being read. */
  run: { active: number; queued: number; current: string | null } | null
  /** The Workspace's connections, where they exist on this view. */
  connections: ConnectionsState | null
  /** Anything out of sync (stale notes, stale modules, a graph build failing). */
  outOfSync: boolean
  now: number
}

export interface KnowledgeConnectionsSection {
  /** What the section's button does, or null when it only reports. */
  action: 'learn' | 'update' | null
  /** The button's words, or the line's when there is no button. */
  label: string
  title: string
  busy: boolean
  /** 0–100 while learning with a known total. */
  percent: number | null
}

export interface KnowledgePillView {
  percent: number | null
  /** The ring's filled share, 0–1. */
  ring: number
  line1: string
  line2: string | null
  busy: boolean
  warn: boolean
  /** The out-of-sync dot. */
  dot: boolean
  /** The drift segment ("31 drifted"), or null when nothing drifted. */
  drift: KnowledgeDriftNote | null
  /** Drift is the only thing worth saying: pressing the pill opens the Drifted group. */
  driftOnly: boolean
  title: string
  connections: KnowledgeConnectionsSection | null
}

/**
 * KEEPING KNOWLEDGE FRESH (2026-11-16): drifted modules get their own amber
 * segment on the pill's sub-line, beside "Learning · X of Y" when both apply.
 * On a narrow pane the other text gives way first; the drift stays.
 */
export interface KnowledgeDriftNote {
  count: number
  /** "31 drifted". */
  label: string
  /** The segment's hover. */
  title: string
}

/** The drift segment for a count of drifted modules, or null for none. */
export function driftNote(stale: number | null | undefined): KnowledgeDriftNote | null {
  if (stale === null || stale === undefined || stale <= 0) return null
  const modules = `${String(stale)} module${stale === 1 ? '' : 's'}`
  return {
    count: stale,
    label: `${String(stale)} drifted`,
    title: `${modules} changed since Flow last read ${stale === 1 ? 'it' : 'them'} — open to update`,
  }
}

/** "just now", "5 minutes ago", "yesterday", "3 days ago" — plain words. */
export function relativeAge(iso: string | null, now: number): string | null {
  if (iso === null) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 45) return `${String(days)} days ago`
  const months = Math.round(days / 30)
  return `${String(months)} month${months === 1 ? '' : 's'} ago`
}

function connectionsSection(state: ConnectionsState | null, now: number): KnowledgeConnectionsSection | null {
  if (state === null) return null
  switch (state.mode) {
    case 'unreadable':
      return { action: null, label: "Connections couldn't be read", title: "The connections between these projects couldn't be read.", busy: false, percent: null }
    case 'learning':
      return {
        action: null,
        label: state.percent === null ? 'Learning connections…' : `Learning connections · ${String(state.percent)}%`,
        title: state.title,
        busy: true,
        percent: state.percent,
      }
    case 'learn':
      return { action: 'learn', label: 'Learn connections', title: state.title, busy: false, percent: null }
    case 'none':
      return { action: null, label: 'No connections found', title: state.title, busy: false, percent: null }
    case 'toggle': {
      if (state.pending > 0) {
        return { action: 'update', label: 'Update connections', title: state.updateTitle ?? 'Some pairs changed since they were checked', busy: false, percent: null }
      }
      const age = relativeAge(state.lastCheckedAt, now)
      const count = `${String(state.count)} connection${state.count === 1 ? '' : 's'}`
      return { action: null, label: age === null ? count : `${count} · updated ${age}`, title: count, busy: false, percent: null }
    }
  }
}

export function knowledgePillView(input: KnowledgePillInput): KnowledgePillView {
  const percent = understoodPercent(input.understood)
  const ring = input.understood === null || input.understood.total === 0 ? 0 : Math.min(1, input.understood.done / input.understood.total)
  const line1 = percent === null ? 'Nothing learned yet' : `${String(percent)}% understood`
  const connections = connectionsSection(input.connections, input.now)
  const modules = input.modules
  let line2: string | null = null
  let busy = false
  // Drift has its own amber segment now; the sub-line is never painted as a warning.
  const warn = false
  const run = input.run
  if (run !== null && run.active + run.queued > 0) {
    busy = true
    line2 =
      modules !== null && modules.total > 0
        ? `Learning · ${String(modules.learned)} of ${String(modules.total)} modules`
        : run.queued > 0
          ? `Learning · ${String(run.queued)} queued`
          : 'Learning…'
  } else if (input.connections?.mode === 'learning') {
    busy = true
    line2 = connections?.label ?? 'Learning connections…'
  } else if (modules !== null && modules.stale > 0) {
    // The drift segment says it; nothing else competes for the line.
    line2 = null
  } else if (input.connections?.mode === 'learn') {
    line2 = 'Connections not learned yet'
  } else if (input.connections?.mode === 'toggle' && input.connections.pending > 0) {
    line2 = 'Connections need an update'
  } else if (input.connections?.mode === 'toggle') {
    const age = relativeAge(input.connections.lastCheckedAt, input.now)
    line2 = age === null ? null : `Connections updated ${age}`
  }
  const drift = driftNote(modules?.stale)
  if (line2 === null && drift === null && modules !== null && modules.total > 0) {
    line2 = `${String(modules.learned)} of ${String(modules.total)} modules read`
  }
  const titleParts = [
    input.understood === null ? null : `${String(input.understood.done)} of ${String(input.understood.total)} understood`,
    run !== null && run.current !== null ? `Reading ${run.current}` : null,
    drift === null ? null : drift.title,
    input.outOfSync ? 'Something is out of sync — open for details' : null,
    'Open the Learning panel',
  ].filter((part): part is string => part !== null)
  return {
    percent,
    ring,
    line1,
    line2,
    busy,
    warn,
    dot: input.outOfSync,
    drift,
    driftOnly: drift !== null && line2 === null,
    title: titleParts.join('\n'),
    connections,
  }
}
