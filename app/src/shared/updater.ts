// Auto-update status — the single shape the main process pushes to the renderer
// (#auto-update). Kept in `shared/` so the main updater manager, the preload
// bridge, and the renderer banner all agree on one type, and so the pure
// presentation logic (bannerFor) is unit-testable with no Electron/DOM.

/** Lifecycle phase of the in-app updater, mirrored from electron-updater events. */
export type UpdatePhase =
  | 'idle' // nothing checked yet, or checked and dismissed
  | 'checking' // a check is in flight
  | 'available' // a newer version exists, not yet downloading (autoDownload is off)
  | 'not-available' // up to date
  | 'downloading' // the update is downloading in the background
  | 'downloaded' // downloaded and staged; a restart applies it
  | 'error' // the last check/download failed

export interface UpdateStatus {
  phase: UpdatePhase
  /** The target version, when known (available / downloading / downloaded). */
  version?: string
  /** Download progress 0–100 (downloading only). */
  percent?: number
  /** Release notes text, when the feed provides a plain string (available only). */
  notes?: string | null
  /** Human-readable failure reason (error only). */
  message?: string
}

/** Clamp a raw electron-updater percent into an integer 0–100 (defensive: the
 *  feed can momentarily report <0 or >100, or NaN mid-stream). */
export function clampPercent(raw: number): number {
  if (Number.isNaN(raw)) return 0
  if (raw <= 0) return 0 // also catches -Infinity
  if (raw >= 100) return 100 // also catches +Infinity
  return Math.round(raw)
}

/** The action a banner button triggers, or null when the banner is display-only. */
export type UpdateAction = 'download' | 'install' | 'retry'

export interface UpdateBanner {
  /** The line shown to the user. */
  text: string
  /** The primary button's action, or null for a progress-only banner. */
  action: UpdateAction | null
  /** Whether the user may dismiss the banner (hide it until the next check). */
  dismissible: boolean
}

/**
 * Map an update status to what the banner should show — or `null` when there is
 * nothing to surface (idle / checking / already up to date). Pure: the renderer
 * renders whatever this returns, so the copy + affordances are tested here.
 */
export function bannerFor(status: UpdateStatus): UpdateBanner | null {
  switch (status.phase) {
    case 'available':
      return {
        text: `Flow ${status.version ?? ''}`.trim() + ' is available.',
        action: 'download',
        dismissible: true,
      }
    case 'downloading':
      return {
        text: `Downloading update… ${status.percent ?? 0}%`,
        action: null,
        dismissible: false,
      }
    case 'downloaded':
      return {
        text: `Flow ${status.version ?? ''}`.trim() + ' is ready — restart to update.',
        action: 'install',
        dismissible: false,
      }
    case 'error':
      return {
        text: `Update failed: ${status.message ?? 'unknown error'}`,
        action: 'retry',
        dismissible: true,
      }
    case 'idle':
    case 'checking':
    case 'not-available':
      return null
  }
}
